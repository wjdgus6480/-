import { getMeta, setMeta, type DB } from '../db/idb';
import { clone, deepEqual, nowIso, uuid } from '../lib/util';
import type { ViewRemote } from './remote';
import { pickConfig, pickSynced, toPublic } from './repo';
import { fromRemote } from './sync';
import { SYNC_FIELDS, fail, ok, type LocalViewRecord, type RemoteViewRow, type Result, type ViewBackup } from './types';

export interface MigrationItem {
  localId: string;
  cloudId: string;
  opId: string;
  name: string;
  view_key: string;
  action: 'create' | 'rename' | 'duplicate';
  is_default: boolean;
}

export interface MigrationSummary {
  total: number;
  created: number;
  renamed: number;
  duplicates: number;
  verified: number;
  backupId: string | null;
  items: MigrationItem[];
  /** 업무 데이터(투두·일정·프로젝트) 이전은 이 버전에서 구현되지 않았다. 보기 설정과 별도로 보고한다. */
  domainData: 'NOT_IMPLEMENTED';
}

async function pullAll(remote: ViewRemote): Promise<RemoteViewRow[]> {
  const rows: RemoteViewRow[] = [];
  let cursor = 0;
  for (;;) {
    const page = await remote.pullSince(cursor, 500);
    rows.push(...page);
    if (page.length < 500) break;
    cursor = Number(page[page.length - 1].server_seq);
  }
  return rows;
}

/**
 * 로그인 전(owner_id=null) 로컬 보기 설정을 계정으로 이전한다.
 * 1. 로컬 설정 백업  2. 클라우드 설정과 중복·충돌 확인  3. 서버에 생성(op_id 고정 → 재시도 멱등)
 * 4. 모두 성공했을 때만 로컬 레코드를 계정 소유로 교체  5. 서버에서 다시 읽어 검증
 * 실패하면 로컬 설정은 그대로 남는다.
 */
export async function migrateLocalViewsToAccount(db: DB, remote: ViewRemote): Promise<Result<MigrationSummary>> {
  const userId = remote.userId();
  if (!userId) return fail('NOT_AUTHENTICATED', '로그인이 필요합니다.');
  const guest = (await db.getAll('view_preferences')).filter((v) => v.owner_id === null && !v.deleted_at);
  const empty: MigrationSummary = { total: 0, created: 0, renamed: 0, duplicates: 0, verified: 0, backupId: null, items: [], domainData: 'NOT_IMPLEMENTED' };
  if (!guest.length) return ok(empty);

  const planKey = `view_migration_plan:${userId}`;
  let plan = await getMeta<{ backupId: string; items: MigrationItem[] }>(db, planKey);

  let cloud: RemoteViewRow[];
  try {
    cloud = (await pullAll(remote)).filter((r) => !r.deleted_at);
  } catch (e) {
    return fail('REMOTE_UNAVAILABLE', `클라우드 설정을 읽지 못했습니다. 로컬 설정은 유지됩니다. (${(e as Error).message})`);
  }

  if (!plan || plan.items.some((i) => !guest.find((g) => g.id === i.localId)) || plan.items.length !== guest.length) {
    const backup: ViewBackup = { id: uuid(), reason: 'migration', created_at: nowIso(), owner_id: null, views: guest.map(toPublic) };
    await db.put('view_backups', backup);
    const cloudHasDefault = new Set(cloud.filter((r) => r.is_default).map((r) => r.view_key));
    const items: MigrationItem[] = guest.map((g) => {
      const same = cloud.find((r) => r.view_key === g.view_key && r.name === g.name);
      const action: MigrationItem['action'] = !same ? 'create' : deepEqual(pickConfig(same), pickConfig(g)) ? 'duplicate' : 'rename';
      return {
        localId: g.id,
        cloudId: action === 'duplicate' ? same!.id : uuid(),
        opId: uuid(),
        name: action === 'rename' ? `${g.name} (이 기기)`.slice(0, 60) : g.name,
        view_key: g.view_key,
        action,
        // 클라우드에 이미 기본 보기가 있으면 클라우드 선택을 존중한다.
        is_default: g.is_default && !cloudHasDefault.has(g.view_key),
      };
    });
    plan = { backupId: backup.id, items };
    await setMeta(db, planKey, plan);
  }

  const results = new Map<string, RemoteViewRow>();
  for (const item of plan.items) {
    if (item.action === 'duplicate') continue;
    const g = guest.find((x) => x.id === item.localId)!;
    const patch: Record<string, unknown> = Object.fromEntries(SYNC_FIELDS.map((f) => [f, clone(g[f])]));
    Object.assign(patch, { name: item.name, is_default: item.is_default, view_key: g.view_key, local_profile_id: g.local_profile_id, created_at: g.created_at });
    try {
      const res = await remote.push({ op_id: item.opId, view_id: item.cloudId, base_version: 0, patch });
      if (res.status !== 'applied') {
        return fail('REMOTE_UNAVAILABLE', `'${g.name}' 이전이 거부되었습니다 (${res.status}${'reason' in res ? `: ${res.reason}` : ''}). 로컬 설정은 유지됩니다.`);
      }
      results.set(item.cloudId, res.row);
    } catch (e) {
      return fail('REMOTE_UNAVAILABLE', `이전 중 연결 오류: ${(e as Error).message}. 로컬 설정은 유지되며 다시 시도하면 이어서 진행합니다.`);
    }
  }

  // 모두 성공: 로컬 레코드를 계정 소유 레코드로 교체 (한 트랜잭션)
  const tx = db.transaction(['view_preferences', 'view_outbox'], 'readwrite');
  for (const item of plan.items) {
    const ops = await tx.objectStore('view_outbox').index('by_view').getAll(item.localId);
    for (const op of ops) await tx.objectStore('view_outbox').delete(op.op_id);
    await tx.objectStore('view_preferences').delete(item.localId);
    const row = results.get(item.cloudId) ?? cloud.find((r) => r.id === item.cloudId);
    if (row) {
      const rec: LocalViewRecord = fromRemote(row);
      await tx.objectStore('view_preferences').put(rec);
    }
  }
  await tx.done;
  await db.delete('meta', planKey);

  // 검증: 서버에서 다시 읽어 설정이 일치하는지 확인
  let verified = 0;
  try {
    const after = await pullAll(remote);
    for (const item of plan.items) {
      const row = after.find((r) => r.id === item.cloudId);
      const g = guest.find((x) => x.id === item.localId)!;
      if (row && deepEqual(pickConfig(row), pickConfig(g)) && (item.action === 'duplicate' || deepEqual(pickSynced(row as never).name, item.name))) verified++;
    }
  } catch {
    /* 검증 실패는 요약에 반영된다 (verified < total) */
  }

  return ok({
    total: plan.items.length,
    created: plan.items.filter((i) => i.action === 'create').length,
    renamed: plan.items.filter((i) => i.action === 'rename').length,
    duplicates: plan.items.filter((i) => i.action === 'duplicate').length,
    verified,
    backupId: plan.backupId,
    items: plan.items,
    domainData: 'NOT_IMPLEMENTED',
  });
}
