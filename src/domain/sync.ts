import { getMeta, setMeta, type DB, type DomainConflict, type DomainConflictGroup, type DomainOp } from '../db/idb';
import { clone, deepEqual, nowIso, uuid } from '../lib/util';
import { Backoff, classifyFailure, type SyncStatusKind } from '../lib/syncPolicy';
import type { DomainRemote, DomainPushRequest, ServerRow } from './remote';
import type { DomainRepository } from './repo';
import { ENTITY_FIELDS, MERGE_GROUPS, SYNC_ORDER, normalizeEvent, recordLabel, type Entity, type EntityRecord } from './types';

export type DomainSyncStatus = SyncStatusKind;

export interface DomainSyncState {
  status: DomainSyncStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  /** 실패 후 다음 자동 재시도 시각 */
  nextRetryAt: string | null;
  pending: number;
  conflicts: number;
  rejected: number;
}

export interface DomainSyncReport {
  pushed: number;
  pulled: number;
  merged: number;
  conflicts: number;
  rejected: number;
  retry: number;
  skipped?: 'local-only';
}

export type DomainSyncResult = { ok: true; value: DomainSyncReport } | { ok: false; error: { code: 'REMOTE_UNAVAILABLE'; message: string } };

const MAX_MERGE_RETRIES = 3;

/** 비교 규칙: 삭제 여부는 시각이 아니라 삭제됨/아님으로 비교한다 */
export function fieldEq(f: string, a: unknown, b: unknown): boolean {
  if (f === 'deleted_at') return !!a === !!b;
  return deepEqual(a ?? null, b ?? null);
}

export function pickFields(entity: Entity, r: Record<string, any>): Record<string, unknown> {
  return Object.fromEntries(ENTITY_FIELDS[entity].map((f) => [f, clone(r[f] ?? null)]));
}

/** 서버 행 → 로컬 레코드 */
export function fromServer(entity: Entity, row: ServerRow): EntityRecord {
  const rec: any = {
    id: row.id,
    owner_id: row.owner_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: Number(row.version),
    ...pickFields(entity, row),
  };
  rec._sync = { server_version: Number(row.version), base: pickFields(entity, row) };
  return entity === 'events' ? normalizeEvent(rec) : rec;
}

const keyOf = (entity: Entity, id: string) => `${entity}:${id}`;

/**
 * 업무 데이터 동기화 엔진 (보기 설정 동기화와 별개).
 * - 로컬 우선: 변경은 이미 IndexedDB 에 저장되어 있고, 이 엔진은 domain_outbox 를 서버로 보낸다.
 * - op_id 멱등성, 버전 비교, 병합 단위(MERGE_GROUPS) 3-way 병합, 같은 단위 충돌·삭제 충돌은 사용자 확인.
 * - 실패해도 로컬 데이터와 큐는 그대로 남는다.
 */
export class DomainSyncEngine {
  state: DomainSyncState = { status: 'local-only', lastSyncAt: null, lastError: null, nextRetryAt: null, pending: 0, conflicts: 0, rejected: 0 };
  readonly backoff = new Backoff();
  private listeners = new Set<(s: DomainSyncState) => void>();
  private running: Promise<DomainSyncResult> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopFns: Array<() => void> = [];

  constructor(
    private db: DB,
    private repo: DomainRepository,
    private getRemote: () => DomainRemote | null,
    private isOnline: () => boolean = () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  ) {}

  subscribe(fn: (s: DomainSyncState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }
  private set(p: Partial<DomainSyncState>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((fn) => fn(this.state));
  }

  start() {
    const schedule = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.autoSync(), 1500);
    };
    let internal = false;
    this.stopFns.push(
      this.repo.subscribe(() => {
        if (internal) return;
        void this.refreshCounts();
        schedule();
      }),
    );
    this.emitQuietly = (fn) => {
      internal = true;
      try {
        fn();
      } finally {
        internal = false;
      }
    };
    const onOnline = () => void this.sync();
    window.addEventListener('online', onOnline);
    // 앱 재진입(iPhone 홈 화면에서 Safari 로 복귀 등): 새로고침 없이 돌아와도 서버 최신 데이터를 받는다
    const onVisible = () => document.visibilityState === 'visible' && void this.sync();
    document.addEventListener('visibilitychange', onVisible);
    const iv = setInterval(() => void this.autoSync(), 30000);
    this.stopFns.push(() => window.removeEventListener('online', onOnline), () => document.removeEventListener('visibilitychange', onVisible), () => clearInterval(iv));
    void this.sync();
  }

  stop() {
    this.stopFns.forEach((f) => f());
    this.stopFns = [];
    if (this.timer) clearTimeout(this.timer);
  }

  /** 동기화로 바뀐 데이터를 화면에 알리되, 그 알림이 다시 동기화를 예약하지 않도록 한다 */
  private emitQuietly: (fn: () => void) => void = (fn) => fn();

  async refreshCounts() {
    const owner = this.repo.ownerId();
    const ops = await this.ownedOps(owner);
    const conflicts = await this.listConflicts();
    this.set({
      pending: ops.filter((o) => o.status === 'pending' || o.status === 'inflight').length,
      conflicts: conflicts.length,
      rejected: ops.filter((o) => o.status === 'rejected').length,
    });
  }

  private async ownedOps(owner: string | null): Promise<DomainOp[]> {
    const out: DomainOp[] = [];
    for (const op of await this.db.getAll('domain_outbox')) {
      const r = await this.db.get(op.entity, op.record_id);
      if (r && (r.owner_id ?? null) === owner) out.push(op);
    }
    return out;
  }

  /** 명시적 동기화 ('지금 동기화', 온라인 복귀, 로그인 변경): 대기 시간과 관계없이 바로 시도한다. */
  sync(): Promise<DomainSyncResult> {
    if (!this.running) this.running = this.run().finally(() => (this.running = null));
    return this.running;
  }

  /** 자동 동기화 (30초 주기·변경 직후): 실패 후 대기 중이거나 로그인이 만료되었으면 건너뛴다. */
  autoSync(): Promise<DomainSyncResult> | null {
    if (this.state.status === 'auth' || !this.backoff.ready()) return null;
    return this.sync();
  }

  private async run(): Promise<DomainSyncResult> {
    const remote = this.getRemote();
    const userId = remote?.userId() ?? null;
    if (!remote || !userId) {
      this.set({ status: 'local-only' });
      await this.refreshCounts();
      return { ok: true, value: { pushed: 0, pulled: 0, merged: 0, conflicts: 0, rejected: 0, retry: 0, skipped: 'local-only' } };
    }
    if (!this.isOnline()) {
      this.set({ status: 'offline' });
      await this.refreshCounts();
      return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '오프라인 상태입니다. 변경 사항은 기기에 저장되어 있으며 연결되면 전송됩니다.' } };
    }
    this.set({ status: 'syncing' });
    const report: DomainSyncReport = { pushed: 0, pulled: 0, merged: 0, conflicts: 0, rejected: 0, retry: 0 };
    try {
      await this.pushAll(remote, userId, report);
      report.pulled = await this.pullAll(remote, userId);
      this.backoff.reset();
      this.set({ status: 'idle', lastSyncAt: nowIso(), lastError: null, nextRetryAt: null });
      return { ok: true, value: report };
    } catch (e) {
      const msg = (e as Error).message;
      const kind = classifyFailure(e);
      // 인증 오류는 다시 로그인할 때까지 자동 재시도하지 않는다. 그 외에는 점점 긴 간격으로 재시도.
      if (kind === 'auth') this.set({ status: 'auth', lastError: msg, nextRetryAt: null });
      else {
        this.backoff.fail();
        this.set({ status: kind === 'network' ? 'offline' : 'error', lastError: msg, nextRetryAt: new Date(this.backoff.nextAt).toISOString() });
      }
      return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: `동기화 실패: ${msg}` } };
    } finally {
      await this.refreshCounts();
      if (report.pulled || report.merged || report.pushed) this.emitQuietly(() => this.repo.emit());
    }
  }

  private async pushAll(remote: DomainRemote, userId: string, report: DomainSyncReport) {
    const order = (e: Entity) => SYNC_ORDER.indexOf(e);
    const ops = (await this.db.getAll('domain_outbox')).sort((a, b) => order(a.entity) - order(b.entity) || a.seq - b.seq);
    const blocked = new Set(ops.filter((o) => o.status === 'conflict' || o.status === 'rejected').map((o) => o.key));
    // 참조 대상이 같은 실행 안에서 나중에 올라가는 경우(예: 회차 예외가 원본보다 먼저 큐에 있음)를 위해
    // 'retry' 된 항목은 진전이 있는 동안 다시 시도한다.
    let queue = ops.filter((o) => (o.status === 'pending' || o.status === 'inflight') && !blocked.has(o.key));
    for (let pass = 0; pass < 4 && queue.length; pass++) {
      const deferred: DomainOp[] = [];
      let progressed = false;
      for (const op of queue) {
        if (blocked.has(op.key)) continue;
        const current = await this.db.get('domain_outbox', op.op_id);
        if (!current || (current.status !== 'pending' && current.status !== 'inflight')) continue;
        const rec = await this.db.get(op.entity, op.record_id);
        if (!rec) {
          await this.db.delete('domain_outbox', op.op_id);
          continue;
        }
        if (rec.owner_id !== userId) continue; // 아직 계정으로 이전되지 않은 로컬 데이터
        const retryBefore = report.retry;
        const outcome = await this.pushOne(remote, current, report);
        if (outcome === 'done') progressed = true;
        else if (report.retry > retryBefore) deferred.push(current);
        else blocked.add(op.key);
      }
      if (!progressed) break;
      report.retry -= deferred.length; // 다음 패스에서 다시 시도하므로 최종 집계에서 제외
      queue = deferred;
    }
  }

  private buildRequest(op: DomainOp, rec: EntityRecord): DomainPushRequest {
    const isCreate = !rec._sync;
    const fields = isCreate ? [...ENTITY_FIELDS[op.entity]] : op.fields;
    const patch: Record<string, unknown> = Object.fromEntries(fields.map((f) => [f, (rec as any)[f] ?? null]));
    if (isCreate) patch.created_at = rec.created_at;
    return { op_id: op.op_id, entity: op.entity, id: rec.id, base_version: rec._sync?.server_version ?? 0, patch };
  }

  private async pushOne(remote: DomainRemote, op: DomainOp, report: DomainSyncReport): Promise<'done' | 'blocked'> {
    for (let attempt = 0; attempt <= MAX_MERGE_RETRIES; attempt++) {
      const rec = await this.db.get(op.entity, op.record_id);
      if (!rec) return 'done';
      op = { ...op, status: 'inflight', attempts: op.attempts + 1 };
      await this.db.put('domain_outbox', op);
      let res;
      try {
        res = await remote.push(this.buildRequest(op, op.entity === 'events' ? normalizeEvent(rec as never) : rec));
      } catch (e) {
        await this.db.put('domain_outbox', { ...op, status: 'pending', last_error: (e as Error).message });
        throw e;
      }
      if (res.status === 'applied') {
        await this.ack(op, res.row);
        report.pushed++;
        return 'done';
      }
      if (res.status === 'retry') {
        await this.db.put('domain_outbox', { ...op, status: 'pending', last_error: res.reason });
        report.retry++;
        return 'blocked';
      }
      if (res.status === 'not_found') {
        // 서버에 없는 레코드: 로컬 상태로 다시 생성한다.
        const next = { ...clone(rec) } as EntityRecord;
        delete next._sync;
        await this.rebase(op, next, [...ENTITY_FIELDS[op.entity]]);
        op = (await this.db.get('domain_outbox', op.op_id)) ?? op;
        continue;
      }
      if (res.status === 'rejected') {
        await this.db.put('domain_outbox', { ...op, status: 'rejected', last_error: res.reason });
        report.rejected++;
        return 'blocked';
      }
      const merged = await this.merge(op, rec, res.row);
      if (merged === 'conflict') {
        report.conflicts++;
        return 'blocked';
      }
      report.merged++;
      const rebased = await this.db.get('domain_outbox', op.op_id);
      if (!rebased) return 'done';
      op = rebased;
    }
    await this.db.put('domain_outbox', { ...op, status: 'pending', last_error: '병합 재시도 한도 초과' });
    return 'blocked';
  }

  private async rebase(op: DomainOp, rec: EntityRecord, fields: string[]) {
    const tx = this.db.transaction([op.entity, 'domain_outbox'], 'readwrite');
    await tx.objectStore(op.entity).put(rec as never);
    await tx.objectStore('domain_outbox').put({ ...op, fields, status: 'pending' });
    await tx.done;
  }

  private async ack(op: DomainOp, row: ServerRow) {
    const tx = this.db.transaction([op.entity, 'domain_outbox'], 'readwrite');
    const outbox = tx.objectStore('domain_outbox');
    await outbox.delete(op.op_id);
    const others = await outbox.index('by_key').getAll(op.key);
    const rec = (await tx.objectStore(op.entity).get(op.record_id)) as EntityRecord | undefined;
    if (rec) {
      const next: EntityRecord = others.length
        ? { ...rec, _sync: { server_version: Number(row.version), base: pickFields(op.entity, row) } }
        : fromServer(op.entity, row);
      await tx.objectStore(op.entity).put(next as never);
    }
    await tx.done;
  }

  /** 3-way 병합 (base=마지막 동기화 값, local=로컬, remote=서버). 병합 단위로 비교한다. */
  private async merge(op: DomainOp, rec: EntityRecord, row: ServerRow): Promise<'merged' | 'conflict'> {
    const entity = op.entity;
    const base = rec._sync?.base ?? null;
    const local = rec as any;
    const allOps = await this.db.getAllFromIndex('domain_outbox', 'by_key', op.key);
    const opFields = !rec._sync ? [...ENTITY_FIELDS[entity]] : op.fields;
    const groups = MERGE_GROUPS[entity];
    const touched = groups.filter((g) => g.some((f) => opFields.includes(f)));
    const localKeep = new Set(groups.filter((g) => g.some((f) => allOps.some((o) => o.fields.includes(f)))).flat());

    const remoteChanged = (g: readonly string[]) => (base ? g.some((f) => !fieldEq(f, row[f], base[f])) : true);
    // 양쪽 모두 '완료'로 바꿨다면 완료 시각만 다른 것은 충돌이 아니다 → 서버(먼저 반영된) 완료 시각 사용
    const bothDone = (g: readonly string[]) => entity === 'tasks' && g.includes('completed_at') && row.status === 'done' && local.status === 'done';
    const sameAsRemote = (g: readonly string[]) => bothDone(g) || g.every((f) => fieldEq(f, row[f], local[f]));
    const conflicting = touched.filter((g) => remoteChanged(g) && !sameAsRemote(g));

    // 삭제 충돌: 한쪽은 삭제, 다른 쪽은 내용 수정
    const others = ENTITY_FIELDS[entity].filter((f) => f !== 'deleted_at');
    const localDeleted = !!local.deleted_at && opFields.includes('deleted_at') && (!base || !base.deleted_at);
    const remoteDeleted = !!row.deleted_at && !!base && !base.deleted_at;
    const remoteEditedOther = !!base && others.some((f) => !fieldEq(f, row[f], base[f]));
    const localEditedOther = opFields.some((f) => f !== 'deleted_at') && (!base || others.some((f) => !fieldEq(f, local[f], base[f])));
    const deleteConflict = (localDeleted && !row.deleted_at && remoteEditedOther) || (remoteDeleted && !local.deleted_at && localEditedOther);
    if (deleteConflict && !conflicting.some((g) => g.includes('deleted_at'))) conflicting.push(['deleted_at']);

    if (!conflicting.length) {
      const next: any = { ...clone(rec), version: Number(row.version), _sync: { server_version: Number(row.version), base: pickFields(entity, row) } };
      for (const f of ENTITY_FIELDS[entity]) if (!localKeep.has(f)) next[f] = clone(row[f] ?? null);
      for (const g of touched) if (sameAsRemote(g)) for (const f of g) next[f] = clone(row[f] ?? null);
      const remaining = touched.filter((g) => !sameAsRemote(g)).flat();
      if (!remaining.length) {
        const tx = this.db.transaction([entity, 'domain_outbox'], 'readwrite');
        await tx.objectStore('domain_outbox').delete(op.op_id);
        await tx.objectStore(entity).put(next);
        await tx.done;
        return 'merged';
      }
      await this.rebase(op, next, remaining);
      return 'merged';
    }

    const conflictFields = new Set(conflicting.flat());
    const sub = (src: Record<string, any> | null, g: readonly string[]) => (src ? Object.fromEntries(g.map((f) => [f, clone(src[f] ?? null)])) : null);
    const conflict: DomainConflict = {
      id: uuid(),
      entity,
      record_id: rec.id,
      op_id: op.op_id,
      label: recordLabel(entity, local) || recordLabel(entity, row),
      kind: deleteConflict ? 'delete' : 'field',
      groups: conflicting.map((g): DomainConflictGroup => ({ fields: [...g], base: sub(base, g), local: sub(local, g)!, remote: sub(row, g)! })),
      merged_fields: touched.filter((g) => !g.some((f) => conflictFields.has(f)) && !sameAsRemote(g)).flat(),
      remote_row: clone(row),
      created_at: nowIso(),
    };
    const tx = this.db.transaction(['domain_outbox', 'domain_conflicts'], 'readwrite');
    await tx.objectStore('domain_outbox').put({ ...op, status: 'conflict' });
    await tx.objectStore('domain_conflicts').put(conflict);
    await tx.done;
    return 'conflict';
  }

  private async pullAll(remote: DomainRemote, userId: string): Promise<number> {
    let count = 0;
    for (const entity of SYNC_ORDER) {
      const key = `domain_sync_cursor:${userId}:${entity}`;
      let cursor = (await getMeta<number>(this.db, key)) ?? 0;
      for (;;) {
        const rows = await remote.pullSince(entity, cursor, 500);
        for (const row of rows) {
          cursor = Math.max(cursor, Number(row.server_seq));
          if (row.owner_id !== userId) continue;
          const tx = this.db.transaction([entity, 'domain_outbox'], 'readwrite');
          const ops = await tx.objectStore('domain_outbox').index('by_key').getAll(keyOf(entity, row.id));
          const local = (await tx.objectStore(entity).get(row.id)) as EntityRecord | undefined;
          const foreign = local && (local.owner_id ?? null) !== userId; // 다른 계정/로그인 전 데이터는 덮어쓰지 않음
          if (!ops.length && !foreign && (!local || !local._sync || local._sync.server_version < Number(row.version))) {
            await tx.objectStore(entity).put(fromServer(entity, row) as never);
            count++;
          }
          await tx.done;
        }
        if (rows.length < 500) break;
      }
      await setMeta(this.db, key, cursor);
    }
    return count;
  }

  async listConflicts(): Promise<DomainConflict[]> {
    const owner = this.repo.ownerId();
    const out: DomainConflict[] = [];
    for (const c of await this.db.getAll('domain_conflicts')) {
      const r = await this.db.get(c.entity, c.record_id);
      if (r && (r.owner_id ?? null) === owner) out.push(c);
    }
    return out;
  }

  /**
   * 충돌 해결. choices 의 키는 충돌 묶음의 필드를 ','로 이은 문자열 (예: 'start_at,end_at,all_day,timezone,recurrence_rule'),
   * 값은 'local'(이 기기) 또는 'remote'(서버). 모든 묶음을 지정해야 한다.
   */
  async resolveConflict(conflictId: string, choices: Record<string, 'local' | 'remote'>): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
    const c = await this.db.get('domain_conflicts', conflictId);
    if (!c) return { ok: false, error: { code: 'CONFLICT_NOT_FOUND', message: '충돌 항목을 찾을 수 없습니다.' } };
    const gk = (g: DomainConflictGroup) => g.fields.join(',');
    const missing = c.groups.filter((g) => choices[gk(g)] !== 'local' && choices[gk(g)] !== 'remote');
    if (missing.length) return { ok: false, error: { code: 'INVALID_RESOLUTION', message: `선택하지 않은 항목: ${missing.map(gk).join(' / ')}` } };
    const rec = (await this.db.get(c.entity, c.record_id)) as EntityRecord | undefined;
    const op = await this.db.get('domain_outbox', c.op_id);
    const row = c.remote_row as ServerRow;
    const chosenLocal = c.groups.filter((g) => choices[gk(g)] === 'local').flatMap((g) => g.fields);
    const tx = this.db.transaction([c.entity, 'domain_outbox', 'domain_conflicts'], 'readwrite');
    if (rec) {
      const otherOps = (await tx.objectStore('domain_outbox').index('by_key').getAll(keyOf(c.entity, c.record_id))).filter((o) => o.op_id !== c.op_id);
      const keep = new Set([...c.merged_fields, ...chosenLocal, ...otherOps.flatMap((o) => o.fields)]);
      const next: any = { ...clone(rec), version: Number(row.version), updated_at: nowIso(), _sync: { server_version: Number(row.version), base: pickFields(c.entity, row) } };
      for (const f of ENTITY_FIELDS[c.entity]) if (!keep.has(f)) next[f] = clone(row[f] ?? null);
      await tx.objectStore(c.entity).put(next);
      const fields = [...new Set([...c.merged_fields, ...chosenLocal])];
      if (op && fields.length) await tx.objectStore('domain_outbox').put({ ...op, fields, status: 'pending' });
      else if (op) await tx.objectStore('domain_outbox').delete(op.op_id);
    } else if (op) await tx.objectStore('domain_outbox').delete(op.op_id);
    await tx.objectStore('domain_conflicts').delete(conflictId);
    await tx.done;
    this.emitQuietly(() => this.repo.emit());
    await this.refreshCounts();
    return { ok: true };
  }

  async listRejected(): Promise<DomainOp[]> {
    return (await this.ownedOps(this.repo.ownerId())).filter((o) => o.status === 'rejected');
  }

  /** 서버가 거부한 변경을 버린다. 서버 값(기준값)으로 되돌리고, 서버에 없던 레코드면 로컬에서 삭제 표시한다. */
  async discardRejected(opId: string): Promise<void> {
    const op = await this.db.get('domain_outbox', opId);
    if (!op || op.status !== 'rejected') return;
    const tx = this.db.transaction([op.entity, 'domain_outbox'], 'readwrite');
    await tx.objectStore('domain_outbox').delete(opId);
    const rec = (await tx.objectStore(op.entity).get(op.record_id)) as EntityRecord | undefined;
    if (rec?._sync) await tx.objectStore(op.entity).put({ ...rec, ...clone(rec._sync.base) } as never);
    else if (rec) await tx.objectStore(op.entity).put({ ...rec, deleted_at: rec.deleted_at ?? nowIso() } as never);
    await tx.done;
    this.emitQuietly(() => this.repo.emit());
    await this.refreshCounts();
  }
}
