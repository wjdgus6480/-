import { getMeta, setMeta, type DB } from '../db/idb';
import { clone, deepEqual, nowIso, uuid } from '../lib/util';
import { Backoff, classifyFailure, type SyncStatusKind } from '../lib/syncPolicy';
import type { PushRequest, ViewRemote } from './remote';
import { pickSynced, type ViewRepository } from './repo';
import { SYNC_FIELDS, fail, ok, type LocalViewRecord, type OutboxOp, type RemoteViewRow, type Result, type SyncField, type ViewConflict } from './types';

export type SyncStatus = SyncStatusKind;

export interface SyncState {
  status: SyncStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  nextRetryAt: string | null;
  pending: number;
  conflicts: number;
  rejected: number;
}

export interface SyncReport {
  pushed: number;
  pulled: number;
  merged: number;
  conflicts: number;
  rejected: number;
  skipped?: 'local-only';
}

export type ConflictChoice = 'local' | 'remote';

const MAX_MERGE_RETRIES = 3;

export function fromRemote(row: RemoteViewRow): LocalViewRecord {
  const { server_seq, ...rest } = row;
  void server_seq;
  return { ...clone(rest), local_profile_id: row.local_profile_id ?? '', _sync: { base: pickSynced(row as never) } };
}

/**
 * 보기 설정 동기화 엔진.
 * - 업무 데이터 저장과 완전히 분리되어 있어 실패해도 투두·일정 저장을 막지 않는다.
 * - 각 변경은 op_id 로 식별되며 서버가 op_id 로 중복 적용을 막는다.
 * - 버전이 다르면 필드 단위 3-way 비교로 독립 변경은 자동 병합, 같은 필드 변경은 충돌로 기록한다.
 */
export class ViewSyncEngine {
  state: SyncState = { status: 'local-only', lastSyncAt: null, lastError: null, nextRetryAt: null, pending: 0, conflicts: 0, rejected: 0 };
  readonly backoff = new Backoff();
  private listeners = new Set<(s: SyncState) => void>();
  private running: Promise<Result<SyncReport>> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopFns: Array<() => void> = [];

  constructor(
    private db: DB,
    private repo: ViewRepository,
    private getRemote: () => ViewRemote | null,
    private isOnline: () => boolean = () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  ) {}

  subscribe(fn: (s: SyncState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }
  private set(p: Partial<SyncState>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((fn) => fn(this.state));
  }

  /** 자동 동기화: 변경 후 1.5초, 온라인 복귀 시, 30초마다 */
  start() {
    const schedule = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.autoSync(), 1500);
    };
    this.stopFns.push(this.repo.onChange(() => {
      void this.refreshCounts();
      schedule();
    }));
    const onOnline = () => void this.syncViewPreferences();
    window.addEventListener('online', onOnline);
    const onVisible = () => document.visibilityState === 'visible' && void this.syncViewPreferences();
    document.addEventListener('visibilitychange', onVisible);
    const iv = setInterval(() => void this.autoSync(), 30000);
    this.stopFns.push(() => window.removeEventListener('online', onOnline), () => document.removeEventListener('visibilitychange', onVisible), () => clearInterval(iv));
    void this.syncViewPreferences();
  }

  stop() {
    this.stopFns.forEach((f) => f());
    this.stopFns = [];
    if (this.timer) clearTimeout(this.timer);
  }

  async refreshCounts() {
    const owner = this.repo.session.ownerId();
    const views = new Map((await this.db.getAll('view_preferences')).map((v) => [v.id, v]));
    const ops = (await this.db.getAll('view_outbox')).filter((o) => views.get(o.view_id)?.owner_id === owner);
    const conflicts = (await this.db.getAll('view_conflicts')).filter((c) => views.get(c.view_id)?.owner_id === owner);
    this.set({
      pending: ops.filter((o) => o.status === 'pending' || o.status === 'inflight').length,
      conflicts: conflicts.length,
      rejected: ops.filter((o) => o.status === 'rejected').length,
    });
  }

  /** 명시적 동기화: 대기 시간과 관계없이 바로 시도 */
  syncViewPreferences(): Promise<Result<SyncReport>> {
    if (!this.running) this.running = this.run().finally(() => (this.running = null));
    return this.running;
  }

  /** 자동 동기화: 실패 후 대기 중이거나 로그인 만료면 건너뜀 */
  autoSync(): Promise<Result<SyncReport>> | null {
    if (this.state.status === 'auth' || !this.backoff.ready()) return null;
    // 화면이 숨겨진 동안(백그라운드 탭·휴대폰 화면 꺼짐)은 주기 요청을 쉬고, 다시 보일 때 visibilitychange 로 즉시 동기화한다.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return null;
    return this.syncViewPreferences();
  }

  private async run(): Promise<Result<SyncReport>> {
    const remote = this.getRemote();
    const userId = remote?.userId() ?? null;
    if (!remote || !userId) {
      this.set({ status: 'local-only' });
      await this.refreshCounts();
      return ok({ pushed: 0, pulled: 0, merged: 0, conflicts: 0, rejected: 0, skipped: 'local-only' });
    }
    if (!this.isOnline()) {
      this.set({ status: 'offline' });
      await this.refreshCounts();
      return fail('REMOTE_UNAVAILABLE', '오프라인 상태입니다. 변경 사항은 기기에 저장되어 있으며 연결되면 전송됩니다.');
    }
    this.set({ status: 'syncing' });
    const report: SyncReport = { pushed: 0, pulled: 0, merged: 0, conflicts: 0, rejected: 0 };
    try {
      await this.pushAll(remote, userId, report);
      report.pulled = await this.pullAll(remote, userId);
      this.backoff.reset();
      this.set({ status: 'idle', lastSyncAt: nowIso(), lastError: null, nextRetryAt: null });
      return ok(report);
    } catch (e) {
      const msg = (e as Error).message;
      const kind = classifyFailure(e);
      if (kind === 'auth') this.set({ status: 'auth', lastError: msg, nextRetryAt: null });
      else {
        this.backoff.fail();
        this.set({ status: kind === 'network' ? 'offline' : 'error', lastError: msg, nextRetryAt: new Date(this.backoff.nextAt).toISOString() });
      }
      return fail('REMOTE_UNAVAILABLE', `동기화 실패: ${msg}`);
    } finally {
      await this.refreshCounts();
      if (report.pulled || report.merged || report.pushed) this.repo.emit([]);
    }
  }

  private async pushAll(remote: ViewRemote, userId: string, report: SyncReport) {
    const ops = (await this.db.getAll('view_outbox')).sort((a, b) => a.seq - b.seq);
    const blocked = new Set(ops.filter((o) => o.status === 'conflict' || o.status === 'rejected').map((o) => o.view_id));
    for (const op of ops) {
      if (op.status !== 'pending' && op.status !== 'inflight') continue;
      if (blocked.has(op.view_id)) continue;
      const rec = await this.db.get('view_preferences', op.view_id);
      if (!rec) {
        await this.db.delete('view_outbox', op.op_id);
        continue;
      }
      if (rec.owner_id !== userId) continue; // 아직 이전되지 않은 로컬 보기
      const outcome = await this.pushOne(remote, op, report);
      if (outcome !== 'done') blocked.add(op.view_id);
    }
  }

  private buildRequest(op: OutboxOp, rec: LocalViewRecord): PushRequest {
    const isCreate = rec._sync.base === null;
    const fields: SyncField[] = isCreate ? [...SYNC_FIELDS] : op.fields;
    const patch: Record<string, unknown> = Object.fromEntries(fields.map((f) => [f, rec[f]]));
    if (isCreate) Object.assign(patch, { view_key: rec.view_key, local_profile_id: rec.local_profile_id, created_at: rec.created_at });
    return { op_id: op.op_id, view_id: rec.id, base_version: isCreate ? 0 : rec.version, patch };
  }

  private async pushOne(remote: ViewRemote, op: OutboxOp, report: SyncReport): Promise<'done' | 'blocked'> {
    for (let attempt = 0; attempt <= MAX_MERGE_RETRIES; attempt++) {
      const rec = await this.db.get('view_preferences', op.view_id);
      if (!rec) return 'done';
      op = { ...op, status: 'inflight', attempts: op.attempts + 1 };
      await this.db.put('view_outbox', op);
      let res;
      try {
        res = await remote.push(this.buildRequest(op, rec));
      } catch (e) {
        await this.db.put('view_outbox', { ...op, status: 'pending', last_error: (e as Error).message });
        throw e;
      }
      if (res.status === 'applied') {
        await this.ack(op, res.row);
        report.pushed++;
        return 'done';
      }
      if (res.status === 'not_found') {
        // 서버에서 사라진 보기: 로컬 상태로 다시 생성한다.
        await this.rebase(op, { ...rec, version: 0, _sync: { base: null } }, [...SYNC_FIELDS]);
        continue;
      }
      if (res.status === 'rejected') {
        await this.db.put('view_outbox', { ...op, status: 'rejected', last_error: res.reason });
        report.rejected++;
        return 'blocked';
      }
      const merged = await this.merge(op, rec, res.row);
      if (merged === 'conflict') {
        report.conflicts++;
        return 'blocked';
      }
      report.merged++;
      const rebased = await this.db.get('view_outbox', op.op_id);
      if (!rebased) return 'done'; // 로컬 변경이 이미 서버 값과 같아 보낼 것이 없음
      op = rebased;
    }
    await this.db.put('view_outbox', { ...op, status: 'pending', last_error: '병합 재시도 한도 초과' });
    return 'blocked';
  }

  private async rebase(op: OutboxOp, rec: LocalViewRecord, fields: SyncField[]) {
    const tx = this.db.transaction(['view_preferences', 'view_outbox'], 'readwrite');
    await tx.objectStore('view_preferences').put(rec);
    await tx.objectStore('view_outbox').put({ ...op, fields, status: 'pending' });
    await tx.done;
  }

  /** 서버 적용 확인: op 제거, 기준값 갱신. 뒤에 대기 중인 로컬 변경이 없으면 서버 값으로 맞춘다. */
  private async ack(op: OutboxOp, row: RemoteViewRow) {
    const tx = this.db.transaction(['view_preferences', 'view_outbox'], 'readwrite');
    const outbox = tx.objectStore('view_outbox');
    await outbox.delete(op.op_id);
    const others = await outbox.index('by_view').getAll(op.view_id);
    const rec = await tx.objectStore('view_preferences').get(op.view_id);
    if (rec) {
      const base = pickSynced(row as never);
      const next: LocalViewRecord = others.length
        ? { ...rec, version: row.version, _sync: { base } }
        : { ...fromRemote(row), owner_id: rec.owner_id, local_profile_id: rec.local_profile_id };
      await tx.objectStore('view_preferences').put(next);
    }
    await tx.done;
  }

  /** 3-way 병합. base=마지막 동기화 값, local=로컬 레코드, remote=서버 행 */
  private async merge(op: OutboxOp, rec: LocalViewRecord, row: RemoteViewRow): Promise<'merged' | 'conflict'> {
    const base = rec._sync.base;
    const allOps = await this.db.getAllFromIndex('view_outbox', 'by_view', op.view_id);
    const localFields = new Set<SyncField>(allOps.flatMap((o) => o.fields));
    const isCreate = base === null;
    const opFields = isCreate ? [...SYNC_FIELDS] : op.fields;
    const remoteChanged = (f: SyncField) => (base ? !deepEqual(row[f], base[f]) : true);
    const conflicting = opFields.filter((f) => remoteChanged(f) && !deepEqual(row[f], rec[f]));
    const sameAsRemote = opFields.filter((f) => deepEqual(row[f], rec[f]));

    if (!conflicting.length) {
      const next: LocalViewRecord = { ...clone(rec), version: row.version, _sync: { base: pickSynced(row as never) } };
      for (const f of SYNC_FIELDS) if (!localFields.has(f)) (next as any)[f] = clone(row[f]);
      const remaining = opFields.filter((f) => !sameAsRemote.includes(f));
      if (!remaining.length) {
        await this.ackWithoutPush(op, next);
        return 'merged';
      }
      await this.rebase(op, next, remaining);
      return 'merged';
    }

    const conflict: ViewConflict = {
      id: uuid(),
      view_id: rec.id,
      op_id: op.op_id,
      view_name: rec.name,
      fields: conflicting.map((f) => ({ field: f, base: base ? clone(base[f]) : null, local: clone(rec[f]), remote: clone(row[f]) })),
      merged_fields: opFields.filter((f) => !conflicting.includes(f) && !sameAsRemote.includes(f)),
      remote_row: clone(row),
      created_at: nowIso(),
    };
    const tx = this.db.transaction(['view_outbox', 'view_conflicts'], 'readwrite');
    await tx.objectStore('view_outbox').put({ ...op, status: 'conflict' });
    await tx.objectStore('view_conflicts').put(conflict);
    await tx.done;
    return 'conflict';
  }

  private async ackWithoutPush(op: OutboxOp, next: LocalViewRecord) {
    const tx = this.db.transaction(['view_preferences', 'view_outbox'], 'readwrite');
    await tx.objectStore('view_outbox').delete(op.op_id);
    await tx.objectStore('view_preferences').put(next);
    await tx.done;
  }

  private async pullAll(remote: ViewRemote, userId: string): Promise<number> {
    const key = `view_sync_cursor:${userId}`;
    let cursor = (await getMeta<number>(this.db, key)) ?? 0;
    let count = 0;
    for (;;) {
      const rows = await remote.pullSince(cursor, 500);
      for (const row of rows) {
        cursor = Math.max(cursor, Number(row.server_seq));
        if (row.owner_id !== userId) continue;
        const tx = this.db.transaction(['view_preferences', 'view_outbox'], 'readwrite');
        const ops = await tx.objectStore('view_outbox').index('by_view').getAll(row.id);
        const local = await tx.objectStore('view_preferences').get(row.id);
        // 로컬에 보내지 않은 변경이 있으면 덮어쓰지 않는다 (전송 시 버전 비교로 처리).
        if (!ops.length && (!local || local.version < row.version || local.version === 0)) {
          await tx.objectStore('view_preferences').put(fromRemote(row));
          count++;
        }
        await tx.done;
      }
      if (rows.length < 500) break;
    }
    await setMeta(this.db, key, cursor);
    return count;
  }

  async listConflicts(): Promise<ViewConflict[]> {
    const owner = this.repo.session.ownerId();
    const views = new Map((await this.db.getAll('view_preferences')).map((v) => [v.id, v]));
    return (await this.db.getAll('view_conflicts')).filter((c) => views.get(c.view_id)?.owner_id === owner);
  }

  /** 충돌 해결. choices 는 충돌한 모든 필드에 대해 'local' 또는 'remote' 를 지정해야 한다. */
  async resolveViewConflict(conflictId: string, choices: Record<string, ConflictChoice>): Promise<Result<void>> {
    const conflict = await this.db.get('view_conflicts', conflictId);
    if (!conflict) return fail('CONFLICT_NOT_FOUND', '충돌 항목을 찾을 수 없습니다.');
    const missing = conflict.fields.filter((f) => choices[f.field] !== 'local' && choices[f.field] !== 'remote');
    if (missing.length) return fail('INVALID_RESOLUTION', `선택하지 않은 항목: ${missing.map((m) => m.field).join(', ')}`);
    const rec = await this.db.get('view_preferences', conflict.view_id);
    const op = await this.db.get('view_outbox', conflict.op_id);
    const row = conflict.remote_row;
    const tx = this.db.transaction(['view_preferences', 'view_outbox', 'view_conflicts'], 'readwrite');
    if (rec) {
      const otherOps = (await tx.objectStore('view_outbox').index('by_view').getAll(rec.id)).filter((o) => o.op_id !== conflict.op_id);
      const keepLocal = new Set<SyncField>([
        ...conflict.merged_fields,
        ...conflict.fields.filter((f) => choices[f.field] === 'local').map((f) => f.field),
        ...otherOps.flatMap((o) => o.fields),
      ]);
      const next: LocalViewRecord = { ...clone(rec), version: row.version, updated_at: nowIso(), _sync: { base: pickSynced(row as never) } };
      for (const f of SYNC_FIELDS) if (!keepLocal.has(f)) (next as any)[f] = clone(row[f]);
      await tx.objectStore('view_preferences').put(next);
      const fields = [...conflict.merged_fields, ...conflict.fields.filter((f) => choices[f.field] === 'local').map((f) => f.field)];
      if (op && fields.length) await tx.objectStore('view_outbox').put({ ...op, fields, status: 'pending' });
      else if (op) await tx.objectStore('view_outbox').delete(op.op_id);
    } else if (op) {
      await tx.objectStore('view_outbox').delete(op.op_id);
    }
    await tx.objectStore('view_conflicts').delete(conflictId);
    await tx.done;
    this.repo.emit([conflict.view_id]);
    await this.refreshCounts();
    return ok(undefined);
  }

  /** 서버가 거부한 변경을 버리고 다음 동기화 때 서버 값을 다시 받는다. */
  async discardRejected(opId: string): Promise<void> {
    const op = await this.db.get('view_outbox', opId);
    if (!op || op.status !== 'rejected') return;
    const tx = this.db.transaction(['view_preferences', 'view_outbox'], 'readwrite');
    await tx.objectStore('view_outbox').delete(opId);
    const rec = await tx.objectStore('view_preferences').get(op.view_id);
    if (rec?._sync.base) await tx.objectStore('view_preferences').put({ ...rec, ...clone(rec._sync.base) });
    else if (rec) await tx.objectStore('view_preferences').delete(rec.id);
    await tx.done;
    this.repo.emit([op.view_id]);
    await this.refreshCounts();
  }
}
