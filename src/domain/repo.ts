import type { DB, DomainBackup, DomainOp } from '../db/idb';
import { clone, deepEqual, isDateOnly, isValidTimeZone, nowIso, uuid } from '../lib/util';
import { addDays, isoToZonedLocal } from '../lib/util';
import { formatRule, overrideId, parseRule, remapExceptions, seriesStarts, type RemapPlan } from './recurrence';
import {
  ENTITY_FIELDS,
  normalizeEvent,
  recordLabel,
  type CalendarEvent,
  type Category,
  type DomainSnapshot,
  type Entity,
  type EntityRecord,
  type Project,
  type Task,
} from './types';

type Listener = () => void;
export type Change = { entity: Entity; record: EntityRecord; fields: string[] };

export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: 'VALIDATION' | 'NOT_FOUND' | 'STORAGE' | 'IMPORT_INVALID' = 'VALIDATION',
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

export const DATA_EXPORT_FORMAT = 'dotday.data';
export const DATA_EXPORT_SCHEMA = 1;
export const DOMAIN_RETENTION_DAYS = 30;

export interface DataImportSummary {
  created: Record<Entity, number>;
  skippedSame: number;
  skippedConflict: number;
  backupId: string;
}

const SCHEDULE_FIELDS = ['start_at', 'end_at', 'all_day', 'timezone', 'recurrence_rule'];
let seqCounter = 0;
const nextSeq = () => Date.now() * 1000 + (seqCounter++ % 1000);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isIso = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v);

/** 동기화 필드 중 바뀐 것 */
export function changedFields(entity: Entity, prev: EntityRecord | null, next: EntityRecord): string[] {
  if (!prev) return [...ENTITY_FIELDS[entity]];
  return ENTITY_FIELDS[entity].filter((f) => !deepEqual((prev as any)[f] ?? null, (next as any)[f] ?? null));
}

/**
 * 업무 데이터 저장소 (로컬 우선).
 * - 모든 변경은 레코드와 업무 변경 큐(domain_outbox)를 한 트랜잭션으로 기록한다.
 * - 보기 설정 스토어는 건드리지 않는다.
 * - 현재 계정(owner_id) 의 데이터만 보여 같은 기기의 다른 계정 데이터와 섞이지 않는다.
 */
export class DomainRepository {
  private listeners = new Set<Listener>();
  constructor(
    readonly db: DB,
    readonly ownerId: () => string | null = () => null,
  ) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit() {
    this.listeners.forEach((fn) => fn());
  }

  async snapshot(includeDeleted = false): Promise<DomainSnapshot> {
    const tx = this.db.transaction(['tasks', 'events', 'projects', 'categories']);
    const [tasks, events, projects, categories] = await Promise.all([
      tx.objectStore('tasks').getAll(),
      tx.objectStore('events').getAll(),
      tx.objectStore('projects').getAll(),
      tx.objectStore('categories').getAll(),
    ]);
    await tx.done;
    const owner = this.ownerId();
    const keep = <T extends { deleted_at: string | null; owner_id: string | null }>(rows: T[]) =>
      rows.filter((r) => (r.owner_id ?? null) === owner && (includeDeleted || !r.deleted_at));
    return { tasks: keep(tasks), events: keep(events).map(normalizeEvent), projects: keep(projects), categories: keep(categories) };
  }

  async get<T extends EntityRecord>(entity: Entity, id: string): Promise<T | undefined> {
    const r = (await this.db.get(entity, id)) as T | undefined;
    if (!r || (r.owner_id ?? null) !== this.ownerId()) return undefined;
    return (entity === 'events' ? normalizeEvent(r as CalendarEvent) : r) as T;
  }

  // ---------- 원자적 기록 ----------

  /** 레코드들과 각 레코드의 변경 큐 항목을 한 트랜잭션으로 저장한다. 실패하면 아무것도 저장되지 않는다. */
  async commit(changes: Change[]): Promise<void> {
    if (!changes.length) return;
    const tx = this.db.transaction(['tasks', 'events', 'projects', 'categories', 'domain_outbox'], 'readwrite');
    try {
      const outbox = tx.objectStore('domain_outbox');
      for (const { entity, record, fields } of changes) {
        await tx.objectStore(entity).put(record as never);
        if (!fields.length) continue;
        const key = `${entity}:${record.id}`;
        const ops = await outbox.index('by_key').getAll(key);
        const pending = ops.find((o) => o.status === 'pending');
        if (pending) {
          pending.fields = [...new Set([...pending.fields, ...fields])];
          await outbox.put(pending);
        } else {
          const op: DomainOp = { op_id: uuid(), entity, record_id: record.id, key, fields: [...fields], status: 'pending', seq: nextSeq(), created_at: nowIso(), attempts: 0 };
          await outbox.put(op);
        }
      }
      await tx.done;
    } catch (e) {
      try {
        tx.abort();
      } catch {
        /* 이미 중단됨 */
      }
      await tx.done.catch(() => undefined);
      throw new DomainError(`저장 실패: ${(e as Error).message}`, 'STORAGE');
    }
    this.emit();
  }

  private stamp<T extends EntityRecord>(entity: Entity, prev: T | null, next: T): Change | null {
    const fields = changedFields(entity, prev, next);
    if (prev && !fields.length) return null; // 실제 변경이 없으면 버전·수정일을 올리지 않는다
    if (prev) {
      next.version = prev.version + 1;
      next.updated_at = nowIso();
    }
    return { entity, record: next, fields };
  }

  private base() {
    const t = nowIso();
    return { id: uuid(), owner_id: this.ownerId(), created_at: t, updated_at: t, deleted_at: null, version: 1 };
  }

  private async mustGet<T extends EntityRecord>(entity: Entity, id: string, label: string): Promise<T> {
    const cur = await this.get<T>(entity, id);
    if (!cur) throw new DomainError(`${label}을(를) 찾을 수 없습니다.`, 'NOT_FOUND');
    return cur;
  }

  // ---------- 투두 ----------

  async createTask(input: Partial<Task> & { title: string }): Promise<Task> {
    const task: Task = {
      ...this.base(),
      description: '',
      status: 'todo',
      priority: 'medium',
      due_date: null,
      project_id: null,
      category_id: null,
      completed_at: null,
      ...stripMeta(input),
      title: input.title.trim(),
    };
    if (task.status === 'done' && !task.completed_at) task.completed_at = task.updated_at;
    validateRecord('tasks', task, true);
    await this.commit([this.stamp('tasks', null, task)!]);
    return task;
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    const cur = await this.mustGet<Task>('tasks', id, '작업');
    const next: Task = { ...clone(cur), ...stripMeta(patch), id };
    if (typeof patch.title === 'string') next.title = patch.title.trim();
    if (patch.status && patch.status !== cur.status) next.completed_at = patch.status === 'done' ? nowIso() : null;
    validateRecord('tasks', next, true);
    const ch = this.stamp('tasks', cur, next);
    if (ch) await this.commit([ch]);
    return ch ? next : cur;
  }

  // ---------- 일정 ----------

  async createEvent(input: Partial<CalendarEvent> & { title: string; start_at: string; end_at: string }): Promise<CalendarEvent> {
    const ev: CalendarEvent = {
      ...this.base(),
      description: '',
      all_day: false,
      timezone: 'Asia/Seoul',
      recurrence_rule: null,
      recurrence_parent_id: null,
      original_start_at: null,
      is_cancelled: false,
      project_id: null,
      category_id: null,
      ...stripMeta(input),
      title: input.title.trim(),
    };
    validateRecord('events', ev, true);
    await this.commit([this.stamp('events', null, ev)!]);
    return ev;
  }

  /**
   * 일정(또는 반복 일정 전체) 수정.
   * 반복 시간·규칙이 바뀌면 회차 예외를 같은 날짜의 새 회차로 옮기고, 옮길 곳이 없는 것만 삭제한다.
   * (UI 는 previewSeriesChange 로 삭제될 개수를 먼저 보여 주고 확인을 받는다)
   */
  async updateEvent(id: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent> {
    const cur = await this.mustGet<CalendarEvent>('events', id, '일정');
    const next: CalendarEvent = { ...clone(cur), ...stripMeta(patch), id };
    if (typeof patch.title === 'string') next.title = patch.title.trim();
    validateRecord('events', next, true);
    const ch = this.stamp('events', cur, next);
    if (!ch) return cur;
    const changes: Change[] = [ch];
    const scheduleChanged = SCHEDULE_FIELDS.some((f) => ch.fields.includes(f));
    if (cur.recurrence_rule && scheduleChanged) {
      const kids = await this.children(id);
      changes.push(...(await this.applyRemap(next, next.recurrence_rule ? remapExceptions(cur, next, kids) : { moved: [], orphaned: kids })));
    }
    await this.commit(changes);
    return next;
  }

  /** 반복 일정 전체 변경 시 회차 예외가 몇 개 보존되고 몇 개 삭제되는지 미리 계산한다 */
  async previewSeriesChange(id: string, patch: Partial<CalendarEvent>): Promise<{ kept: number; removed: number }> {
    const cur = await this.mustGet<CalendarEvent>('events', id, '일정');
    const next: CalendarEvent = { ...clone(cur), ...stripMeta(patch), id };
    const kids = await this.children(id);
    if (!next.recurrence_rule) return { kept: 0, removed: kids.length };
    const plan = remapExceptions(cur, next, kids);
    return { kept: plan.moved.length, removed: plan.orphaned.length };
  }

  /**
   * '이 회차와 이후 모두' 수정: 원래 반복은 이 회차 전까지로 끝내고, 이 회차부터 새 반복을 만든다.
   * 이 회차 이후의 회차 예외는 새 반복으로 옮긴다(같은 날짜 기준).
   */
  async updateFollowing(seriesId: string, originalStart: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent> {
    const master = await this.mustGet<CalendarEvent>('events', seriesId, '반복 일정');
    const parsed = master.recurrence_rule ? parseRule(master.recurrence_rule) : null;
    if (!parsed?.ok) throw new DomainError('반복 일정이 아닙니다.');
    const splitMs = Date.parse(originalStart);
    if (splitMs <= Date.parse(master.start_at)) return this.updateEvent(seriesId, patch); // 첫 회차부터면 전체 수정과 같음
    const before = seriesStarts(master, originalStart).length; // 이 회차 전 회차 수
    const rule = parsed.rule;
    const splitDate = isoToZonedLocal(originalStart, master.timezone).slice(0, 10);
    const oldRule = formatRule(rule.count ? { ...rule, count: before } : { ...rule, until: addDays(splitDate, -1) });
    // 원래 규칙을 그대로 보낸 경우(폼 기본값)는 '규칙 변경 없음'으로 보고 남은 횟수로 이어간다.
    const ruleChanged = patch.recurrence_rule !== undefined && patch.recurrence_rule !== master.recurrence_rule && patch.recurrence_rule !== followingRule(master, originalStart);
    const newRule = ruleChanged ? patch.recurrence_rule! : formatRule(rule.count ? { ...rule, count: Math.max(1, rule.count - before) } : rule);
    const duration = Date.parse(master.end_at) - Date.parse(master.start_at);
    const fresh: CalendarEvent = {
      ...clone(master),
      ...this.base(),
      start_at: new Date(splitMs).toISOString(),
      end_at: new Date(splitMs + duration).toISOString(),
      ...stripMeta(patch),
      recurrence_rule: newRule,
      recurrence_parent_id: null,
      original_start_at: null,
      is_cancelled: false,
    };
    fresh.title = fresh.title.trim();
    delete fresh._sync;
    validateRecord('events', fresh, true);
    const oldNext: CalendarEvent = { ...clone(master), recurrence_rule: oldRule };
    validateRecord('events', oldNext, true);
    const kids = (await this.children(seriesId)).filter((k) => Date.parse(k.original_start_at!) >= splitMs);
    // 옮길 기준: 원래 반복을 '분할 지점부터 시작'하는 것으로 본 모습 → 새 반복
    const shiftedOld: CalendarEvent = { ...master, start_at: new Date(splitMs).toISOString(), end_at: new Date(splitMs + duration).toISOString() };
    const changes: Change[] = [this.stamp('events', master, oldNext)!, this.stamp('events', null, fresh)!, ...(await this.applyRemap(fresh, remapExceptions(shiftedOld, fresh, kids)))];
    await this.commit(changes.filter(Boolean));
    return fresh;
  }

  private async children(seriesId: string): Promise<CalendarEvent[]> {
    return (await this.snapshot()).events.filter((e) => e.recurrence_parent_id === seriesId);
  }

  /** 재배치 계획을 변경 목록으로: 옮긴 예외는 새 회차 ID 로 다시 만들고(ID 는 회차 시각으로 결정되므로) 이전 행은 삭제 */
  private async applyRemap(newMaster: CalendarEvent, plan: RemapPlan): Promise<Change[]> {
    const t = nowIso();
    const out: Change[] = [];
    for (const { ov, original, start, end } of plan.moved) {
      const newId = await overrideId(newMaster.id, original);
      if (newId === ov.id) {
        const ch = this.stamp('events', ov, { ...clone(ov), start_at: start, end_at: end, all_day: newMaster.all_day, timezone: newMaster.timezone });
        if (ch) out.push(ch);
        continue;
      }
      const existing = await this.db.get('events', newId);
      const rec: CalendarEvent = { ...clone(ov), ...this.base(), id: newId, recurrence_parent_id: newMaster.id, original_start_at: original, start_at: start, end_at: end, all_day: newMaster.all_day, timezone: newMaster.timezone, deleted_at: null };
      delete rec._sync;
      const prev = existing && (existing.owner_id ?? null) === this.ownerId() ? normalizeEvent(existing) : null;
      const ch = this.stamp('events', prev, prev ? { ...clone(prev), ...rec, _sync: prev._sync, version: prev.version, created_at: prev.created_at } : rec);
      if (ch) out.push(ch);
      out.push(this.stamp('events', ov, { ...clone(ov), deleted_at: t })!);
    }
    for (const ov of plan.orphaned) out.push(this.stamp('events', ov, { ...clone(ov), deleted_at: t })!);
    return out;
  }

  private async deleteChildren(seriesId: string, t: string): Promise<Change[]> {
    const kids = await this.children(seriesId);
    return kids.map((k) => this.stamp('events', k, { ...clone(k), deleted_at: t })!).filter(Boolean);
  }

  /** 반복 일정의 한 회차만 변경한다. originalStart 는 원래 회차 시작 시각. */
  async updateOccurrence(seriesId: string, originalStart: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent> {
    return this.upsertOverride(seriesId, originalStart, patch);
  }

  /** 반복 일정의 한 회차만 취소한다. */
  async cancelOccurrence(seriesId: string, originalStart: string): Promise<CalendarEvent> {
    return this.upsertOverride(seriesId, originalStart, { is_cancelled: true });
  }

  /** 회차별 변경·취소를 되돌린다 (원래 반복 값으로 표시). */
  async resetOccurrence(seriesId: string, originalStart: string): Promise<void> {
    const id = await overrideId(seriesId, originalStart);
    const cur = await this.get<CalendarEvent>('events', id);
    if (cur && !cur.deleted_at) await this.softDelete('events', id);
  }

  private async upsertOverride(seriesId: string, originalStart: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent> {
    const master = await this.mustGet<CalendarEvent>('events', seriesId, '반복 일정');
    if (!master.recurrence_rule) throw new DomainError('반복 일정이 아닙니다.');
    const id = await overrideId(seriesId, originalStart);
    const existing = await this.db.get('events', id);
    const duration = Date.parse(master.end_at) - Date.parse(master.start_at);
    const fresh: CalendarEvent = {
      ...this.base(),
      id,
      title: master.title,
      description: master.description,
      start_at: new Date(originalStart).toISOString(),
      end_at: new Date(Date.parse(originalStart) + duration).toISOString(),
      all_day: master.all_day,
      timezone: master.timezone,
      recurrence_rule: null,
      recurrence_parent_id: seriesId,
      original_start_at: new Date(originalStart).toISOString(),
      is_cancelled: false,
      project_id: master.project_id,
      category_id: master.category_id,
    };
    const prev = existing && (existing.owner_id ?? null) === this.ownerId() ? normalizeEvent(existing) : null;
    const next: CalendarEvent = { ...(prev ? clone(prev) : fresh), ...stripMeta(patch), id, recurrence_parent_id: seriesId, original_start_at: fresh.original_start_at, recurrence_rule: null, deleted_at: null };
    if (!patch.is_cancelled && prev?.is_cancelled && patch.is_cancelled === undefined) next.is_cancelled = false;
    validateRecord('events', next, true);
    const ch = this.stamp('events', prev, next);
    if (ch) await this.commit([ch]);
    return next;
  }

  // ---------- 프로젝트·분류 ----------

  async createProject(input: Partial<Project> & { name: string }): Promise<Project> {
    const p: Project = { ...this.base(), description: '', status: 'active', ...stripMeta(input), name: input.name.trim() };
    validateRecord('projects', p, true);
    await this.commit([this.stamp('projects', null, p)!]);
    return p;
  }

  async updateProject(id: string, patch: Partial<Project>): Promise<Project> {
    const cur = await this.mustGet<Project>('projects', id, '프로젝트');
    const next: Project = { ...clone(cur), ...stripMeta(patch), id };
    if (typeof patch.name === 'string') next.name = patch.name.trim();
    validateRecord('projects', next, true);
    const ch = this.stamp('projects', cur, next);
    if (ch) await this.commit([ch]);
    return ch ? next : cur;
  }

  async createCategory(input: Partial<Category> & { name: string }): Promise<Category> {
    const c: Category = { ...this.base(), color: '#6b7280', ...stripMeta(input), name: input.name.trim() };
    validateRecord('categories', c, true);
    await this.commit([this.stamp('categories', null, c)!]);
    return c;
  }

  async updateCategory(id: string, patch: Partial<Category>): Promise<Category> {
    const cur = await this.mustGet<Category>('categories', id, '분류');
    const next: Category = { ...clone(cur), ...stripMeta(patch), id };
    if (typeof patch.name === 'string') next.name = patch.name.trim();
    validateRecord('categories', next, true);
    const ch = this.stamp('categories', cur, next);
    if (ch) await this.commit([ch]);
    return ch ? next : cur;
  }

  // ---------- 삭제·복구 ----------

  /** 소프트 삭제(tombstone). 반복 일정을 지우면 회차별 변경도 함께 지운다. 30일간 restore 가능. */
  async softDelete(entity: Entity, id: string): Promise<void> {
    const cur = await this.get(entity, id);
    if (!cur || cur.deleted_at) return;
    const t = nowIso(); // 반복 일정과 그 예외는 같은 삭제 시각을 써서 복구 때 함께 되살린다
    const changes: Change[] = [this.stamp(entity, cur, { ...clone(cur), deleted_at: t } as EntityRecord)!];
    if (entity === 'events' && (cur as CalendarEvent).recurrence_rule) changes.push(...(await this.deleteChildren(id, t)));
    await this.commit(changes);
  }

  /**
   * 휴지통에서 복구. 반복 일정이면 같은 시각에 함께 삭제된 회차 예외도 복구한다.
   * 반환값은 복구했지만 참조 대상(프로젝트·분류)이 삭제 상태인 경우의 안내 문구 목록.
   */
  async restore(entity: Entity, id: string): Promise<string[]> {
    const cur = await this.get(entity, id);
    if (!cur || !cur.deleted_at) throw new DomainError('복구할 항목이 없습니다.', 'NOT_FOUND');
    const changes: Change[] = [this.stamp(entity, cur, { ...clone(cur), deleted_at: null } as EntityRecord)!];
    if (entity === 'events') {
      const kids = (await this.snapshot(true)).events.filter((e) => e.recurrence_parent_id === id && e.deleted_at === cur.deleted_at);
      for (const k of kids) changes.push(this.stamp('events', k, { ...clone(k), deleted_at: null })!);
    }
    await this.commit(changes);
    const warn: string[] = [];
    for (const [f, store, label] of [['project_id', 'projects', '프로젝트'], ['category_id', 'categories', '분류']] as const) {
      const refId = (cur as any)[f];
      if (!refId) continue;
      const ref = await this.get(store, refId);
      if (ref?.deleted_at) warn.push(`연결된 ${label} '${recordLabel(store, ref)}'이(가) 휴지통에 있습니다.`);
    }
    return warn;
  }

  async listDeleted(): Promise<Array<{ entity: Entity; record: EntityRecord }>> {
    const all = await this.snapshot(true);
    const out: Array<{ entity: Entity; record: EntityRecord }> = [];
    for (const entity of ['tasks', 'events', 'projects', 'categories'] as Entity[]) {
      for (const r of all[entity] as EntityRecord[]) {
        // 회차별 변경 행은 휴지통에 따로 보이지 않는다 (반복 일정과 함께 복구)
        if (r.deleted_at && !(entity === 'events' && (r as CalendarEvent).recurrence_parent_id)) out.push({ entity, record: r });
      }
    }
    return out.sort((a, b) => (b.record.deleted_at ?? '').localeCompare(a.record.deleted_at ?? ''));
  }

  // ---------- 내보내기 / 가져오기 / 백업 ----------

  async exportData() {
    const s = await this.snapshot(true);
    const strip = (rows: EntityRecord[]) => rows.map((r) => stripMeta(clone(r)) as unknown as Record<string, unknown>);
    return {
      format: DATA_EXPORT_FORMAT,
      schema_version: DATA_EXPORT_SCHEMA,
      exported_at: nowIso(),
      data: { projects: strip(s.projects), categories: strip(s.categories), events: strip(s.events), tasks: strip(s.tasks) },
    };
  }

  async createBackup(reason: DomainBackup['reason'], ownerOverride?: string | null): Promise<DomainBackup> {
    const owner = ownerOverride === undefined ? this.ownerId() : ownerOverride;
    const all = await this.snapshotFor(owner);
    const b: DomainBackup = { id: uuid(), reason, created_at: nowIso(), owner_id: owner, data: clone(all) };
    await this.db.put('domain_backups', b);
    return b;
  }

  async snapshotFor(owner: string | null): Promise<DomainSnapshot> {
    const pick = async <T extends EntityRecord>(e: Entity) => ((await this.db.getAll(e)) as T[]).filter((r) => (r.owner_id ?? null) === owner);
    return { tasks: await pick<Task>('tasks'), events: (await pick<CalendarEvent>('events')).map(normalizeEvent), projects: await pick<Project>('projects'), categories: await pick<Category>('categories') };
  }

  async listBackups(): Promise<DomainBackup[]> {
    const owner = this.ownerId();
    return (await this.db.getAll('domain_backups')).filter((b) => b.owner_id === owner).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /**
   * 가져오기. 모든 레코드를 먼저 검증하고 하나라도 잘못되면 아무것도 바꾸지 않는다.
   * 같은 ID 가 이미 있으면 덮어쓰지 않는다 (내용이 같으면 '동일', 다르면 '충돌'로 건너뜀 → 기존 데이터 유지).
   */
  async importData(text: string): Promise<DataImportSummary> {
    let file: any;
    try {
      file = JSON.parse(text);
    } catch {
      throw new DomainError('JSON 형식이 아닙니다.', 'IMPORT_INVALID');
    }
    if (!file || file.format !== DATA_EXPORT_FORMAT) throw new DomainError('DOTDAY 데이터 파일이 아닙니다.', 'IMPORT_INVALID');
    if (file.schema_version !== DATA_EXPORT_SCHEMA) throw new DomainError(`지원하지 않는 버전: ${String(file.schema_version)}`, 'IMPORT_INVALID');
    const entities: Entity[] = ['projects', 'categories', 'events', 'tasks'];
    const issues: string[] = [];
    const incoming: Record<Entity, EntityRecord[]> = { projects: [], categories: [], events: [], tasks: [] };
    let total = 0;
    for (const e of entities) {
      const rows = file.data?.[e] ?? [];
      if (!Array.isArray(rows)) {
        issues.push(`${e}: 배열이 아닙니다.`);
        continue;
      }
      total += rows.length;
      rows.forEach((r: any, i: number) => {
        try {
          const rec = { ...r, owner_id: this.ownerId() } as EntityRecord;
          if (e === 'events') Object.assign(rec, normalizeEvent(rec as CalendarEvent));
          validateRecord(e, rec, false);
          incoming[e].push(rec);
        } catch (err) {
          issues.push(`${e}[${i}]: ${(err as Error).message}`);
        }
      });
    }
    if (total > 20000) issues.push('레코드가 너무 많습니다 (최대 20000).');
    // 참조 검사: 가져오는 데이터 또는 기존 데이터에 있어야 한다
    const local = await this.snapshot(true);
    const ids = (e: 'projects' | 'categories' | 'events') => new Set([...local[e], ...incoming[e]].map((x) => x.id));
    const pIds = ids('projects');
    const cIds = ids('categories');
    const eIds = ids('events');
    for (const e of ['tasks', 'events'] as const) {
      incoming[e].forEach((r: any) => {
        if (r.project_id && !pIds.has(r.project_id)) issues.push(`${e} ${r.id}: 없는 프로젝트 참조`);
        if (r.category_id && !cIds.has(r.category_id)) issues.push(`${e} ${r.id}: 없는 분류 참조`);
        if (e === 'events' && r.recurrence_parent_id && !eIds.has(r.recurrence_parent_id)) issues.push(`events ${r.id}: 없는 반복 일정 참조`);
      });
    }
    if (issues.length) throw new DomainError(`잘못된 데이터가 있어 가져오지 않았습니다 (${issues.length}건). 기존 데이터는 그대로입니다.`, 'IMPORT_INVALID', issues);

    const backup = await this.createBackup('import');
    const summary: DataImportSummary = { created: { projects: 0, categories: 0, events: 0, tasks: 0 }, skippedSame: 0, skippedConflict: 0, backupId: backup.id };
    const changes: Change[] = [];
    // 반복 원본을 회차 예외보다 먼저 큐에 넣어 동기화 시 참조 순서를 지킨다.
    incoming.events.sort((a, b) => Number(!!(a as CalendarEvent).recurrence_parent_id) - Number(!!(b as CalendarEvent).recurrence_parent_id));
    for (const e of entities) {
      for (const r of incoming[e]) {
        const existing = await this.db.get(e, r.id);
        if (existing) {
          const same = ENTITY_FIELDS[e].every((f) => deepEqual((existing as any)[f] ?? null, (r as any)[f] ?? null));
          if (same) summary.skippedSame++;
          else summary.skippedConflict++;
          continue;
        }
        const rec = { ...stripMeta(r), owner_id: this.ownerId(), version: 1 } as EntityRecord;
        changes.push({ entity: e, record: rec, fields: [...ENTITY_FIELDS[e]] });
        summary.created[e]++;
      }
    }
    await this.commit(changes);
    return summary;
  }

  /** 백업 시점으로 되돌린다. 백업 이후 생긴 레코드는 삭제(복구 가능) 처리한다. */
  async restoreBackup(backupId: string): Promise<number> {
    const b = await this.db.get('domain_backups', backupId);
    if (!b || b.owner_id !== this.ownerId()) throw new DomainError('백업을 찾을 수 없습니다.', 'NOT_FOUND');
    const now = await this.snapshotFor(this.ownerId());
    const changes: Change[] = [];
    const t = nowIso();
    for (const e of ['projects', 'categories', 'events', 'tasks'] as Entity[]) {
      const cur = new Map((now[e] as EntityRecord[]).map((r) => [r.id, r]));
      for (const r of b.data[e] as EntityRecord[]) {
        const c = cur.get(r.id);
        const target = { ...(c ? clone(c) : { ...clone(r), _sync: undefined }) } as any;
        for (const f of ENTITY_FIELDS[e]) target[f] = clone((r as any)[f] ?? null);
        const ch = this.stamp(e, c ?? null, target);
        if (ch) changes.push(ch);
        cur.delete(r.id);
      }
      for (const c of cur.values()) {
        if (!c.deleted_at) changes.push(this.stamp(e, c, { ...clone(c), deleted_at: t } as EntityRecord)!);
      }
    }
    await this.commit(changes);
    return changes.length;
  }

  /** 보존 기간이 지난 삭제 레코드를 정리한다. 전송 대기 중이거나 서버와 동기화가 필요한 것은 남긴다. */
  async purgeDeleted(now = Date.now()): Promise<number> {
    const cutoff = now - DOMAIN_RETENTION_DAYS * 86400000;
    const owner = this.ownerId();
    let n = 0;
    for (const e of ['tasks', 'events', 'projects', 'categories'] as Entity[]) {
      const tx = this.db.transaction([e, 'domain_outbox'], 'readwrite');
      for (const r of (await tx.objectStore(e).getAll()) as EntityRecord[]) {
        if ((r.owner_id ?? null) !== owner || !r.deleted_at || Date.parse(r.deleted_at) > cutoff) continue;
        const ops = await tx.objectStore('domain_outbox').index('by_key').getAll(`${e}:${r.id}`);
        if (owner && ops.length) continue;
        for (const op of ops) await tx.objectStore('domain_outbox').delete(op.op_id);
        await tx.objectStore(e).delete(r.id);
        n++;
      }
      await tx.done;
    }
    return n;
  }

  async seedSample(): Promise<void> {
    const p1 = await this.createProject({ name: '웹사이트 개편', description: '랜딩 페이지 리뉴얼' });
    const p2 = await this.createProject({ name: '개인 공부', status: 'on_hold' });
    const c1 = await this.createCategory({ name: '업무', color: '#2563eb' });
    const c2 = await this.createCategory({ name: '개인', color: '#16a34a' });
    const today = new Date();
    const d = (offset: number) => new Date(today.getTime() + offset * 86400000).toLocaleDateString('en-CA');
    await this.createTask({ title: '디자인 시안 검토', priority: 'high', due_date: d(1), project_id: p1.id, category_id: c1.id });
    await this.createTask({ title: '카피 작성', priority: 'medium', due_date: d(3), project_id: p1.id, category_id: c1.id, status: 'in_progress' });
    await this.createTask({ title: '배포 체크리스트', priority: 'urgent', due_date: d(0), project_id: p1.id, category_id: c1.id });
    await this.createTask({ title: 'TypeScript 책 3장', priority: 'low', due_date: d(7), project_id: p2.id, category_id: c2.id });
    await this.createTask({ title: '장보기', priority: 'medium', category_id: c2.id, status: 'done' });
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';
    const at = (dayOffset: number, hour: number) => {
      const x = new Date(today);
      x.setDate(x.getDate() + dayOffset);
      x.setHours(hour, 0, 0, 0);
      return x.toISOString();
    };
    await this.createEvent({ title: '주간 회의', start_at: at(1, 10), end_at: at(1, 11), timezone: tz, project_id: p1.id, category_id: c1.id, recurrence_rule: 'FREQ=WEEKLY' });
    await this.createEvent({ title: '디자인 리뷰', start_at: at(2, 14), end_at: at(2, 15), timezone: tz, project_id: p1.id, category_id: c1.id });
    await this.createEvent({ title: '휴가', start_at: at(5, 0), end_at: at(6, 0), all_day: true, timezone: tz, category_id: c2.id });
  }
}

/** '이 회차와 이후' 로 나눌 때 새 반복에 쓰일 규칙 (COUNT 는 남은 횟수) */
export function followingRule(master: CalendarEvent, originalStart: string): string | null {
  const p = master.recurrence_rule ? parseRule(master.recurrence_rule) : null;
  if (!p?.ok) return master.recurrence_rule;
  if (!p.rule.count) return master.recurrence_rule;
  const before = seriesStarts(master, originalStart).length;
  return formatRule({ ...p.rule, count: Math.max(1, p.rule.count - before) });
}

/** 클라이언트가 지정하면 안 되는 메타 필드를 제거한다 */
function stripMeta<T extends object>(r: T): T {
  const { _sync, owner_id, ...rest } = r as any;
  void _sync;
  void owner_id;
  return rest as T;
}

const ENUMS = {
  tasks: { status: ['todo', 'in_progress', 'done'], priority: ['low', 'medium', 'high', 'urgent'] },
  projects: { status: ['active', 'on_hold', 'done', 'archived'] },
} as const;

/** 업무 레코드 검증. 잘못되면 DomainError. (서버 제약과 같은 규칙) */
export function validateRecord(entity: Entity, r: any, trusted: boolean): void {
  const bad = (m: string) => {
    throw new DomainError(m);
  };
  if (!r || typeof r !== 'object') bad('객체가 아닙니다.');
  if (typeof r.id !== 'string' || !UUID_RE.test(r.id)) bad('ID 형식이 잘못되었습니다.');
  if (!trusted) {
    for (const f of ['created_at', 'updated_at']) if (!isIso(r[f])) bad(`${f} 형식 오류`);
    if (r.deleted_at !== null && r.deleted_at !== undefined && !isIso(r.deleted_at)) bad('deleted_at 형식 오류');
    if (!Number.isInteger(r.version) || r.version < 1) bad('version 형식 오류');
    const allowed = new Set([...ENTITY_FIELDS[entity], 'id', 'owner_id', 'created_at', 'updated_at', 'version']);
    for (const k of Object.keys(r)) if (!allowed.has(k)) bad(`허용되지 않은 속성: ${k}`);
  }
  const str = (f: string, min: number, max: number) => {
    if (typeof r[f] !== 'string' || r[f].trim().length < min || r[f].length > max) bad(`${f}: ${min}~${max}자 문자열이어야 합니다.`);
  };
  const ref = (f: string) => {
    if (r[f] !== null && r[f] !== undefined && (typeof r[f] !== 'string' || !UUID_RE.test(r[f]))) bad(`${f} 형식 오류`);
  };
  if (entity === 'tasks') {
    str('title', 1, 300);
    if (typeof r.description !== 'string' || r.description.length > 10000) bad('설명이 너무 깁니다.');
    if (!(ENUMS.tasks.status as readonly string[]).includes(r.status)) bad(`상태 값 오류: ${r.status}`);
    if (!(ENUMS.tasks.priority as readonly string[]).includes(r.priority)) bad(`우선순위 값 오류: ${r.priority}`);
    if (r.due_date !== null && !isDateOnly(r.due_date)) bad(`마감일 형식 오류: ${r.due_date}`);
    if (r.completed_at !== null && !isIso(r.completed_at)) bad('완료 시각 형식 오류');
    ref('project_id');
    ref('category_id');
  } else if (entity === 'events') {
    str('title', 1, 300);
    if (typeof r.description !== 'string' || r.description.length > 10000) bad('설명이 너무 깁니다.');
    if (!isIso(r.start_at) || !isIso(r.end_at)) bad('시작·종료 시각 형식 오류');
    if (Date.parse(r.end_at) < Date.parse(r.start_at)) bad('종료 시각이 시작 시각보다 빠릅니다.');
    if (typeof r.all_day !== 'boolean') bad('종일 여부 오류');
    if (!isValidTimeZone(r.timezone)) bad(`시간대 오류: ${r.timezone}`);
    if (r.recurrence_rule !== null) {
      const p = parseRule(r.recurrence_rule);
      if (!p.ok) bad(`반복 규칙 오류: ${p.error}`);
    }
    if ((r.recurrence_parent_id === null) !== (r.original_start_at === null)) bad('회차 예외 정보가 불완전합니다.');
    if (r.recurrence_parent_id !== null && r.recurrence_rule !== null) bad('회차 예외에는 반복 규칙을 둘 수 없습니다.');
    if (r.original_start_at !== null && !isIso(r.original_start_at)) bad('원래 회차 시각 형식 오류');
    if (typeof r.is_cancelled !== 'boolean') bad('취소 여부 오류');
    ref('recurrence_parent_id');
    ref('project_id');
    ref('category_id');
  } else if (entity === 'projects') {
    str('name', 1, 120);
    if (typeof r.description !== 'string' || r.description.length > 10000) bad('설명이 너무 깁니다.');
    if (!(ENUMS.projects.status as readonly string[]).includes(r.status)) bad(`상태 값 오류: ${r.status}`);
  } else {
    str('name', 1, 60);
    if (typeof r.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(r.color)) bad(`색상 형식 오류: ${r.color}`);
  }
}
