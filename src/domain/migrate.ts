import { getMeta, setMeta, type DB, type DomainBackup } from '../db/idb';
import { clone, deepEqual, nowIso, uuid } from '../lib/util';
import type { DomainRemote, ServerRow } from './remote';
import { fieldEq, fromServer, pickFields } from './sync';
import { ENTITY_FIELDS, SYNC_ORDER, normalizeEvent, type CalendarEvent, type Entity, type EntityRecord } from './types';

export type EntityCounts = Record<Entity, number>;
const zero = (): EntityCounts => ({ projects: 0, categories: 0, events: 0, tasks: 0 });

export interface DataMigrationPreview {
  counts: EntityCounts;
  total: number;
  /** 다른 레코드가 참조해서 함께 올리는 삭제된 항목 수 */
  referencedDeleted: number;
}

export interface DataMigrationItem {
  entity: Entity;
  id: string;
  opId: string;
  /** create: 새로 올림, same: 서버에 같은 내용 존재, server_kept: 같은 ID 가 서버에 다른 내용으로 존재 → 서버 유지(로컬 값은 백업에 보관) */
  action: 'create' | 'same' | 'server_kept';
}

export interface DataMigrationSummary {
  preview: DataMigrationPreview;
  created: EntityCounts;
  same: number;
  serverKept: number;
  /** 서버에서 다시 읽어 핵심 필드가 일치한 건수 */
  verified: EntityCounts;
  verifiedTotal: number;
  total: number;
  backupId: string | null;
  mismatches: string[];
}

export type MigrationResult = { ok: true; value: DataMigrationSummary } | { ok: false; error: { code: 'NOT_AUTHENTICATED' | 'REMOTE_UNAVAILABLE' | 'REJECTED'; message: string } };

/** 로그인 전(owner_id=null) 데이터 중 이전할 대상: 삭제되지 않은 것 + 그것들이 참조하는 삭제된 항목 */
async function collectGuest(db: DB): Promise<{ records: Record<Entity, EntityRecord[]>; preview: DataMigrationPreview }> {
  const all: Record<Entity, EntityRecord[]> = { projects: [], categories: [], events: [], tasks: [] };
  for (const e of SYNC_ORDER) all[e] = ((await db.getAll(e)) as EntityRecord[]).filter((r) => (r.owner_id ?? null) === null).map((r) => (e === 'events' ? normalizeEvent(r as CalendarEvent) : r));
  const chosen: Record<Entity, Map<string, EntityRecord>> = { projects: new Map(), categories: new Map(), events: new Map(), tasks: new Map() };
  for (const e of SYNC_ORDER) for (const r of all[e]) if (!r.deleted_at) chosen[e].set(r.id, r);
  let referencedDeleted = 0;
  const need = (e: Entity, id: string | null | undefined) => {
    if (!id || chosen[e].has(id)) return;
    const r = all[e].find((x) => x.id === id);
    if (r) {
      chosen[e].set(id, r);
      referencedDeleted++;
    }
  };
  for (const ev of chosen.events.values()) need('events', (ev as CalendarEvent).recurrence_parent_id);
  for (const e of ['tasks', 'events'] as const)
    for (const r of [...chosen[e].values()] as any[]) {
      need('projects', r.project_id);
      need('categories', r.category_id);
    }
  const records = Object.fromEntries(SYNC_ORDER.map((e) => [e, [...chosen[e].values()]])) as Record<Entity, EntityRecord[]>;
  // 반복 원본을 예외 회차보다 먼저
  records.events.sort((a, b) => Number(!!(a as CalendarEvent).recurrence_parent_id) - Number(!!(b as CalendarEvent).recurrence_parent_id));
  const counts = zero();
  for (const e of SYNC_ORDER) counts[e] = records[e].length;
  return { records, preview: { counts, total: SYNC_ORDER.reduce((s, e) => s + counts[e], 0), referencedDeleted } };
}

export async function previewLocalDataMigration(db: DB): Promise<DataMigrationPreview> {
  return (await collectGuest(db)).preview;
}

async function pullAllRows(remote: DomainRemote, entity: Entity): Promise<ServerRow[]> {
  const rows: ServerRow[] = [];
  let cursor = 0;
  for (;;) {
    const page = await remote.pullSince(entity, cursor, 500);
    rows.push(...page);
    if (page.length < 500) break;
    cursor = Number(page[page.length - 1].server_seq);
  }
  return rows;
}

/**
 * 로그인 전 업무 데이터를 계정으로 이전한다 (보기 설정 이전과 별개).
 * 규칙
 * - 같은 UUID 를 유지한다 (보기 필터의 프로젝트·분류 참조가 깨지지 않도록).
 * - 서버에 같은 ID 가 같은 내용으로 있으면 'same'(건너뜀), 다른 내용이면 'server_kept'(서버 유지, 로컬 값은 백업).
 * - 실패하면 로컬 원본은 그대로 남고, 다시 시도하면 같은 op_id 로 이어서 진행한다(중복 없음).
 * - 모두 성공했을 때만 로컬 레코드를 계정 소유로 바꾸고, 서버에서 다시 읽어 검증한다.
 */
const running = new WeakMap<DB, Promise<MigrationResult>>();

/** 같은 DB 에 대해 이전이 이미 진행 중이면 그 결과를 함께 기다린다 (중복 실행 방지) */
export function migrateLocalDataToAccount(db: DB, remote: DomainRemote): Promise<MigrationResult> {
  const cur = running.get(db);
  if (cur) return cur;
  const p = migrateOnce(db, remote).finally(() => running.delete(db));
  running.set(db, p);
  return p;
}

async function migrateOnce(db: DB, remote: DomainRemote): Promise<MigrationResult> {
  const userId = remote.userId();
  if (!userId) return { ok: false, error: { code: 'NOT_AUTHENTICATED', message: '로그인이 필요합니다.' } };
  const { records, preview } = await collectGuest(db);
  const emptySummary = (): DataMigrationSummary => ({ preview, created: zero(), same: 0, serverKept: 0, verified: zero(), verifiedTotal: 0, total: 0, backupId: null, mismatches: [] });
  if (!preview.total) return { ok: true, value: emptySummary() };

  let cloud: Record<Entity, Map<string, ServerRow>>;
  try {
    cloud = Object.fromEntries(await Promise.all(SYNC_ORDER.map(async (e) => [e, new Map((await pullAllRows(remote, e)).map((r) => [r.id, r]))]))) as never;
  } catch (e) {
    return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: `클라우드 데이터를 읽지 못했습니다. 로컬 데이터는 유지됩니다. (${(e as Error).message})` } };
  }

  const planKey = `domain_migration_plan:${userId}`;
  const wanted = SYNC_ORDER.flatMap((e) => records[e].map((r) => `${e}:${r.id}`)).sort();
  let plan = await getMeta<{ backupId: string; items: DataMigrationItem[] }>(db, planKey);
  if (!plan || !deepEqual(plan.items.map((i) => `${i.entity}:${i.id}`).sort(), wanted)) {
    const guestAll: any = { projects: [], categories: [], events: [], tasks: [] };
    for (const e of SYNC_ORDER) guestAll[e] = ((await db.getAll(e)) as EntityRecord[]).filter((r) => (r.owner_id ?? null) === null).map((r) => clone(r));
    const backup: DomainBackup = { id: uuid(), reason: 'migration', created_at: nowIso(), owner_id: null, data: guestAll };
    await db.put('domain_backups', backup);
    const items: DataMigrationItem[] = SYNC_ORDER.flatMap((e) =>
      records[e].map((r) => {
        const srv = cloud[e].get(r.id);
        const action: DataMigrationItem['action'] = !srv ? 'create' : ENTITY_FIELDS[e].every((f) => fieldEq(f, (srv as any)[f], (r as any)[f])) ? 'same' : 'server_kept';
        return { entity: e, id: r.id, opId: uuid(), action };
      }),
    );
    plan = { backupId: backup.id, items };
    await setMeta(db, planKey, plan);
  }

  const results = new Map<string, ServerRow>();
  for (const item of plan.items) {
    const k = `${item.entity}:${item.id}`;
    if (item.action !== 'create') continue;
    const r = records[item.entity].find((x) => x.id === item.id)!;
    const patch: Record<string, unknown> = { ...pickFields(item.entity, r), created_at: r.created_at };
    try {
      const res = await remote.push({ op_id: item.opId, entity: item.entity, id: item.id, base_version: 0, patch });
      if (res.status === 'applied') results.set(k, res.row);
      else if (res.status === 'conflict') results.set(k, res.row); // 사이에 다른 기기가 같은 ID 를 올림 → 서버 유지
      else
        return {
          ok: false,
          error: { code: 'REJECTED', message: `'${(r as any).title ?? (r as any).name}' 이전 실패 (${res.status}${'reason' in res ? `: ${res.reason}` : ''}). 로컬 데이터는 유지됩니다.` },
        };
    } catch (e) {
      return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: `이전 중 연결 오류: ${(e as Error).message}. 로컬 데이터는 유지되며 다시 시도하면 이어서 진행합니다.` } };
    }
  }

  // 모두 성공: 로컬 레코드를 계정 소유 레코드로 교체 (한 트랜잭션)
  // 업로드 이후 사용자가 고친 필드는 덮어쓰지 않고, 서버 값 위에 얹어 대기 op 로 남긴다.
  const tx = db.transaction(['projects', 'categories', 'events', 'tasks', 'domain_outbox'], 'readwrite');
  for (const item of plan.items) {
    const key = `${item.entity}:${item.id}`;
    const outbox = tx.objectStore('domain_outbox');
    for (const op of await outbox.index('by_key').getAll(key)) await outbox.delete(op.op_id);
    const row = results.get(key) ?? cloud[item.entity].get(item.id);
    if (!row) continue;
    const next: any = fromServer(item.entity, row);
    const current = (await tx.objectStore(item.entity).get(item.id)) as any;
    const uploaded = records[item.entity].find((x) => x.id === item.id) as any;
    const editedLater = current ? ENTITY_FIELDS[item.entity].filter((f) => !fieldEq(f, current[f], uploaded[f])) : [];
    for (const f of editedLater) next[f] = clone(current[f] ?? null);
    await tx.objectStore(item.entity).put(next);
    if (editedLater.length)
      await outbox.put({ op_id: uuid(), entity: item.entity, record_id: item.id, key, fields: editedLater, status: 'pending', seq: Date.now() * 1000, created_at: nowIso(), attempts: 0 });
  }
  await tx.done;
  await db.delete('meta', planKey);

  // 검증: 서버에서 다시 읽어 건수와 핵심 필드 확인
  const summary = emptySummary();
  summary.backupId = plan.backupId;
  summary.total = plan.items.length;
  for (const item of plan.items) {
    if (item.action === 'create') summary.created[item.entity]++;
    else if (item.action === 'same') summary.same++;
    else summary.serverKept++;
  }
  try {
    for (const e of SYNC_ORDER) {
      const after = new Map((await pullAllRows(remote, e)).map((r) => [r.id, r]));
      for (const item of plan.items.filter((i) => i.entity === e)) {
        const row = after.get(item.id);
        const local = records[e].find((x) => x.id === item.id)!;
        const okRow = row && row.owner_id === userId && (item.action === 'server_kept' || ENTITY_FIELDS[e].every((f) => fieldEq(f, row[f], (local as any)[f])));
        if (okRow) summary.verified[e]++;
        else summary.mismatches.push(`${e}:${item.id}`);
      }
    }
  } catch (e) {
    summary.mismatches.push(`검증 중 연결 오류: ${(e as Error).message}`);
  }
  summary.verifiedTotal = SYNC_ORDER.reduce((s, e) => s + summary.verified[e], 0);
  return { ok: true, value: summary };
}
