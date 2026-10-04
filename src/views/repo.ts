import type { DB } from '../db/idb';
import type { DomainRepository } from '../domain/repo';
import { clone, deepEqual, nowIso, uuid } from '../lib/util';
import { applySortAndFilterPure } from './engine';
import { defaultViewConfig, isViewDomain, validateName, validateViewConfig } from './validate';
import {
  SYNC_FIELDS,
  fail,
  ok,
  type LocalViewRecord,
  type OutboxOp,
  type Result,
  type SyncField,
  type ValidationIssue,
  type ViewBackup,
  type ViewConfig,
  type ViewDomain,
  type ViewPreference,
} from './types';

export interface Session {
  /** 로그인한 사용자 ID. 로그인 전에는 null */
  ownerId(): string | null;
  localProfileId: string;
}

export interface CreateViewInput {
  domain: ViewDomain;
  name: string;
  /** 생략하면 도메인 기본 설정 */
  config?: unknown;
  is_default?: boolean;
}

export type ViewPatch = Partial<Pick<ViewPreference, 'name' | 'column_config' | 'sort_config' | 'filter_config' | 'layout_config'>>;

export const EXPORT_FORMAT = 'dotday.view-preferences';
export const EXPORT_SCHEMA_VERSION = 1;
export const DELETED_RETENTION_DAYS = 30;

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  schema_version: number;
  exported_at: string;
  views: Array<Pick<ViewPreference, 'view_key' | 'name' | 'is_default'> & ViewConfig>;
}

export interface ImportSummary {
  imported: number;
  backupId: string;
  names: string[];
}

type ChangeListener = (viewIds: string[]) => void;

let seqCounter = 0;
const nextSeq = () => Date.now() * 1000 + (seqCounter++ % 1000);

export function toPublic(r: LocalViewRecord): ViewPreference {
  const { _sync, ...rest } = r;
  void _sync;
  return clone(rest);
}

export function pickSynced(v: ViewPreference) {
  return Object.fromEntries(SYNC_FIELDS.map((f) => [f, clone(v[f])])) as Pick<ViewPreference, SyncField>;
}

/**
 * 보기 설정 저장소.
 * - 모든 메서드는 Result<T> 를 반환하며 예외 대신 {code, message, issues} 오류 계약을 따른다.
 * - 레코드 변경과 변경 큐(view_outbox) 등록은 하나의 IndexedDB 트랜잭션으로 처리된다.
 * - 업무 데이터 스토어(tasks/events/projects/categories)는 읽기만 한다.
 */
export class ViewRepository {
  private listeners = new Set<ChangeListener>();

  constructor(
    readonly db: DB,
    readonly session: Session,
    private domainRepo: DomainRepository,
  ) {}

  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(ids: string[]) {
    this.listeners.forEach((fn) => fn(ids));
  }

  // ---------- 내부: 원자적 커밋 ----------

  /** 여러 보기 레코드와 각 레코드의 변경 큐 항목을 한 트랜잭션으로 저장한다. */
  async commit(changes: Array<{ record: LocalViewRecord; fields: SyncField[] }>): Promise<Result<void>> {
    const tx = this.db.transaction(['view_preferences', 'view_outbox'], 'readwrite');
    try {
      const views = tx.objectStore('view_preferences');
      const outbox = tx.objectStore('view_outbox');
      for (const { record, fields } of changes) {
        await views.put(record);
        if (!fields.length) continue;
        const ops = await outbox.index('by_view').getAll(record.id);
        const pending = ops.find((o) => o.status === 'pending');
        if (pending) {
          pending.fields = [...new Set([...pending.fields, ...fields])];
          await outbox.put(pending);
        } else {
          const op: OutboxOp = { op_id: uuid(), view_id: record.id, fields: [...fields], status: 'pending', seq: nextSeq(), created_at: nowIso(), attempts: 0 };
          await outbox.put(op);
        }
      }
      await tx.done;
    } catch (e) {
      // 레코드만 저장되고 큐 등록이 빠지는 일이 없도록 트랜잭션 전체를 되돌린다.
      try {
        tx.abort();
      } catch {
        /* 이미 중단됨 */
      }
      await tx.done.catch(() => undefined);
      return fail('STORAGE', `보기 설정 저장 실패: ${(e as Error).message}`);
    }
    this.emit(changes.map((c) => c.record.id));
    return ok(undefined);
  }

  private async loadAll(): Promise<LocalViewRecord[]> {
    const owner = this.session.ownerId();
    return (await this.db.getAll('view_preferences')).filter((v) => v.owner_id === owner);
  }

  private async load(viewId: string): Promise<LocalViewRecord | undefined> {
    const v = await this.db.get('view_preferences', viewId);
    return v && v.owner_id === this.session.ownerId() ? v : undefined;
  }

  private newRecord(domain: ViewDomain, name: string, config: ViewConfig, isDefault: boolean): LocalViewRecord {
    const t = nowIso();
    return {
      id: uuid(),
      owner_id: this.session.ownerId(),
      local_profile_id: this.session.localProfileId,
      view_key: domain,
      name: name.trim(),
      ...clone(config),
      is_default: isDefault,
      created_at: t,
      updated_at: t,
      deleted_at: null,
      version: 0,
      _sync: { base: null },
    };
  }

  private changed(prev: LocalViewRecord, next: LocalViewRecord): SyncField[] {
    return SYNC_FIELDS.filter((f) => !deepEqual(prev[f], next[f]));
  }

  private async save(prev: LocalViewRecord, next: LocalViewRecord, extra: Array<{ record: LocalViewRecord; fields: SyncField[] }> = []): Promise<Result<ViewPreference>> {
    const fields = this.changed(prev, next);
    if (!fields.length && !extra.length) return ok(toPublic(prev));
    next.updated_at = nowIso();
    const r = await this.commit([{ record: next, fields }, ...extra]);
    return r.ok ? ok(toPublic(next)) : (r as Result<never>);
  }

  // ---------- 공개 API ----------

  validateViewConfig(domain: unknown, config: unknown): Result<ViewConfig> {
    return validateViewConfig(domain, config);
  }

  /** 보기 목록. 해당 도메인에 보기가 하나도 없으면 기본 보기를 만든다. 기본 보기가 맨 앞. */
  async listViews(domain: ViewDomain): Promise<Result<ViewPreference[]>> {
    if (!isViewDomain(domain)) return fail('UNKNOWN_DOMAIN', `지원하지 않는 도메인: ${String(domain)}`);
    let views = (await this.loadAll()).filter((v) => v.view_key === domain && !v.deleted_at);
    if (!views.length) {
      const created = await this.ensureDefaultView(domain);
      if (!created.ok) return created as Result<never>;
      views = created.value;
    }
    const def = pickDefault(views);
    views.sort((a, b) => (a.id === def.id ? -1 : b.id === def.id ? 1 : a.created_at.localeCompare(b.created_at)));
    return ok(views.map((v) => ({ ...toPublic(v), is_default: v.id === def.id })));
  }

  /**
   * 보기가 없을 때 기본 보기를 만든다. 확인과 생성을 한 readwrite 트랜잭션에서 하므로
   * 여러 화면이 동시에 호출해도(IndexedDB 가 트랜잭션을 직렬화) 기본 보기가 중복 생성되지 않는다.
   */
  private async ensureDefaultView(domain: ViewDomain): Promise<Result<LocalViewRecord[]>> {
    const owner = this.session.ownerId();
    const tx = this.db.transaction(['view_preferences', 'view_outbox'], 'readwrite');
    try {
      const existing = (await tx.objectStore('view_preferences').index('by_view_key').getAll(domain)).filter((v) => v.owner_id === owner && !v.deleted_at);
      if (existing.length) {
        await tx.done;
        return ok(existing);
      }
      const rec = this.newRecord(domain, '기본 보기', defaultViewConfig(domain), true);
      await tx.objectStore('view_preferences').put(rec);
      await tx.objectStore('view_outbox').put({ op_id: uuid(), view_id: rec.id, fields: [...SYNC_FIELDS], status: 'pending', seq: nextSeq(), created_at: nowIso(), attempts: 0 });
      await tx.done;
      this.emit([rec.id]);
      return ok([rec]);
    } catch (e) {
      try {
        tx.abort();
      } catch {
        /* 이미 중단됨 */
      }
      return fail('STORAGE', `기본 보기 생성 실패: ${(e as Error).message}`);
    }
  }

  async getView(viewId: string): Promise<Result<ViewPreference>> {
    const v = await this.load(viewId);
    return v ? ok(toPublic(v)) : fail('NOT_FOUND', '보기를 찾을 수 없습니다.');
  }

  async getDefaultView(domain: ViewDomain): Promise<Result<ViewPreference>> {
    const list = await this.listViews(domain);
    return list.ok ? ok(list.value[0]) : (list as Result<never>);
  }

  async createView(input: CreateViewInput): Promise<Result<ViewPreference>> {
    if (!isViewDomain(input.domain)) return fail('UNKNOWN_DOMAIN', `지원하지 않는 도메인: ${String(input.domain)}`);
    const nameIssues = validateName(input.name);
    if (nameIssues.length) return fail('VALIDATION', nameIssues[0].message, nameIssues);
    const cfg = validateViewConfig(input.domain, input.config ?? defaultViewConfig(input.domain));
    if (!cfg.ok) return cfg as Result<never>;
    const rec = this.newRecord(input.domain, input.name, cfg.value, false);
    const extra = input.is_default ? await this.unsetDefaults(input.domain, rec.id) : [];
    rec.is_default = !!input.is_default;
    const r = await this.commit([{ record: rec, fields: [...SYNC_FIELDS] }, ...extra]);
    return r.ok ? ok(toPublic(rec)) : (r as Result<never>);
  }

  async updateView(viewId: string, patch: ViewPatch): Promise<Result<ViewPreference>> {
    const prev = await this.load(viewId);
    if (!prev || prev.deleted_at) return fail('NOT_FOUND', '보기를 찾을 수 없습니다.');
    const allowed = ['name', 'column_config', 'sort_config', 'filter_config', 'layout_config'];
    const unknownKeys = Object.keys(patch).filter((k) => !allowed.includes(k));
    if (unknownKeys.length)
      return fail('VALIDATION', '변경할 수 없는 속성입니다.', unknownKeys.map((k) => ({ code: 'UNKNOWN_KEY', path: k, message: `허용되지 않은 속성 '${k}'` })));
    const issues: ValidationIssue[] = patch.name !== undefined ? validateName(patch.name) : [];
    if (issues.length) return fail('VALIDATION', issues[0].message, issues);
    const merged = {
      column_config: patch.column_config ?? prev.column_config,
      sort_config: patch.sort_config ?? prev.sort_config,
      filter_config: patch.filter_config ?? prev.filter_config,
      layout_config: patch.layout_config ?? prev.layout_config,
    };
    const cfg = validateViewConfig(prev.view_key, merged);
    if (!cfg.ok) return cfg as Result<never>;
    const next: LocalViewRecord = { ...clone(prev), ...cfg.value, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}) };
    return this.save(prev, next);
  }

  async duplicateView(viewId: string): Promise<Result<ViewPreference>> {
    const src = await this.load(viewId);
    if (!src || src.deleted_at) return fail('NOT_FOUND', '보기를 찾을 수 없습니다.');
    const name = `${src.name} 사본`.slice(0, 60);
    return this.createView({ domain: src.view_key, name, config: pickConfig(src) });
  }

  private async unsetDefaults(domain: ViewDomain, exceptId: string) {
    const others = (await this.loadAll()).filter((v) => v.view_key === domain && v.id !== exceptId && v.is_default);
    return others.map((o) => ({ record: { ...clone(o), is_default: false, updated_at: nowIso() }, fields: ['is_default'] as SyncField[] }));
  }

  async setDefaultView(viewId: string): Promise<Result<ViewPreference>> {
    const prev = await this.load(viewId);
    if (!prev || prev.deleted_at) return fail('NOT_FOUND', '보기를 찾을 수 없습니다.');
    const extra = await this.unsetDefaults(prev.view_key, viewId);
    return this.save(prev, { ...clone(prev), is_default: true }, extra);
  }

  /** 소프트 삭제. 30일 동안 restoreView 로 복구할 수 있다. 도메인의 마지막 보기는 삭제할 수 없다. */
  async deleteView(viewId: string): Promise<Result<ViewPreference>> {
    const prev = await this.load(viewId);
    if (!prev || prev.deleted_at) return fail('NOT_FOUND', '보기를 찾을 수 없습니다.');
    const remaining = (await this.loadAll()).filter((v) => v.view_key === prev.view_key && !v.deleted_at && v.id !== viewId);
    if (!remaining.length) return fail('LAST_VIEW', '마지막 보기는 삭제할 수 없습니다. 대신 기본값으로 복원하세요.');
    const extra: Array<{ record: LocalViewRecord; fields: SyncField[] }> = [];
    if (prev.is_default && !remaining.some((v) => v.is_default)) {
      const heir = remaining.sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
      extra.push({ record: { ...clone(heir), is_default: true, updated_at: nowIso() }, fields: ['is_default'] });
    }
    return this.save(prev, { ...clone(prev), deleted_at: nowIso(), is_default: false }, extra);
  }

  async restoreView(viewId: string): Promise<Result<ViewPreference>> {
    const prev = await this.load(viewId);
    if (!prev || !prev.deleted_at) return fail('NOT_FOUND', '복구할 보기를 찾을 수 없습니다.');
    return this.save(prev, { ...clone(prev), deleted_at: null });
  }

  async listDeletedViews(domain: ViewDomain): Promise<Result<ViewPreference[]>> {
    if (!isViewDomain(domain)) return fail('UNKNOWN_DOMAIN', `지원하지 않는 도메인: ${String(domain)}`);
    return ok((await this.loadAll()).filter((v) => v.view_key === domain && v.deleted_at).map(toPublic));
  }

  /** 선택한 보기의 설정만 도메인 기본값으로 되돌린다. 이름·ID·업무 데이터는 그대로 둔다. */
  async resetView(viewId: string): Promise<Result<ViewPreference>> {
    const prev = await this.load(viewId);
    if (!prev || prev.deleted_at) return fail('NOT_FOUND', '보기를 찾을 수 없습니다.');
    return this.save(prev, { ...clone(prev), ...defaultViewConfig(prev.view_key) });
  }

  /** 보기 설정에 따라 업무 데이터를 필터·정렬한다. 원본은 변경하지 않는다. */
  async applySortAndFilter<R = unknown>(domain: ViewDomain, config: unknown): Promise<Result<R[]>> {
    const cfg = validateViewConfig(domain, config);
    if (!cfg.ok) return cfg as Result<never>;
    const data = await this.domainRepo.snapshot();
    return ok(applySortAndFilterPure<R>(domain, data, cfg.value));
  }

  /** 보존 기간이 지난 삭제 보기를 로컬에서 정리한다. 전송 대기 중인 변경이 있으면 건드리지 않는다. */
  async purgeDeletedViews(now = Date.now()): Promise<number> {
    const cutoff = now - DELETED_RETENTION_DAYS * 86400000;
    const tx = this.db.transaction(['view_preferences', 'view_outbox'], 'readwrite');
    let n = 0;
    for (const v of await tx.objectStore('view_preferences').getAll()) {
      if (!v.deleted_at || Date.parse(v.deleted_at) > cutoff) continue;
      const ops = await tx.objectStore('view_outbox').index('by_view').getAll(v.id);
      if (v.owner_id && ops.length) continue;
      for (const op of ops) await tx.objectStore('view_outbox').delete(op.op_id);
      await tx.objectStore('view_preferences').delete(v.id);
      n++;
    }
    await tx.done;
    return n;
  }

  // ---------- 내보내기 / 가져오기 / 백업 ----------

  async exportViews(): Promise<ExportFile> {
    const views = (await this.loadAll()).filter((v) => !v.deleted_at);
    return {
      format: EXPORT_FORMAT,
      schema_version: EXPORT_SCHEMA_VERSION,
      exported_at: nowIso(),
      views: views.map((v) => ({ view_key: v.view_key, name: v.name, is_default: v.is_default, ...pickConfig(v) })),
    };
  }

  async createBackup(reason: ViewBackup['reason']): Promise<ViewBackup> {
    const backup: ViewBackup = { id: uuid(), reason, created_at: nowIso(), owner_id: this.session.ownerId(), views: (await this.loadAll()).map(toPublic) };
    await this.db.put('view_backups', backup);
    return backup;
  }

  async listBackups(): Promise<ViewBackup[]> {
    const owner = this.session.ownerId();
    return (await this.db.getAll('view_backups')).filter((b) => b.owner_id === owner).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /**
   * 가져오기. 모든 항목을 먼저 검증하고 하나라도 잘못되면 아무것도 바꾸지 않는다.
   * 유효하면 현재 설정을 백업한 뒤 새 보기로 추가한다 (기존 보기를 덮어쓰지 않음).
   */
  async importViews(text: string): Promise<Result<ImportSummary>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail('IMPORT_INVALID', 'JSON 형식이 아닙니다.');
    }
    const file = parsed as Partial<ExportFile>;
    if (!file || typeof file !== 'object' || file.format !== EXPORT_FORMAT) return fail('IMPORT_INVALID', 'DOTDAY 보기 설정 파일이 아닙니다.');
    if (file.schema_version !== EXPORT_SCHEMA_VERSION) return fail('IMPORT_INVALID', `지원하지 않는 버전: ${String(file.schema_version)}`);
    if (!Array.isArray(file.views) || file.views.length === 0 || file.views.length > 200) return fail('IMPORT_INVALID', '보기 목록이 비었거나 너무 많습니다.');

    const issues: ValidationIssue[] = [];
    const ready: Array<{ domain: ViewDomain; name: string; config: ViewConfig }> = [];
    file.views.forEach((v, i) => {
      const raw = v as unknown as Record<string, unknown>;
      if (!raw || typeof raw !== 'object') {
        issues.push({ code: 'INVALID_TYPE', path: `views[${i}]`, message: '객체여야 합니다.' });
        return;
      }
      if (!isViewDomain(raw.view_key)) {
        issues.push({ code: 'INVALID_TYPE', path: `views[${i}].view_key`, message: `알 수 없는 도메인: ${String(raw.view_key)}` });
        return;
      }
      issues.push(...validateName(raw.name).map((x) => ({ ...x, path: `views[${i}].${x.path}` })));
      const cfg = validateViewConfig(raw.view_key, pickConfig(raw as never));
      if (!cfg.ok) issues.push(...(cfg.error.issues ?? []).map((x) => ({ ...x, path: `views[${i}].${x.path}` })));
      else if (typeof raw.name === 'string') ready.push({ domain: raw.view_key, name: raw.name.trim(), config: cfg.value });
    });
    if (issues.length) return fail('IMPORT_INVALID', `잘못된 설정이 있어 가져오지 않았습니다 (${issues.length}건). 기존 설정은 그대로입니다.`, issues);

    const backup = await this.createBackup('import');
    const existing = new Set((await this.loadAll()).filter((v) => !v.deleted_at).map((v) => `${v.view_key}:${v.name}`));
    const changes = ready.map(({ domain, name, config }) => {
      let n = name;
      while (existing.has(`${domain}:${n}`)) n = `${n} (가져옴)`.slice(0, 60);
      existing.add(`${domain}:${n}`);
      return { record: this.newRecord(domain, n, config, false), fields: [...SYNC_FIELDS] };
    });
    const r = await this.commit(changes);
    if (!r.ok) return r as Result<never>;
    return ok({ imported: changes.length, backupId: backup.id, names: changes.map((c) => c.record.name) });
  }

  /** 백업 시점의 보기 설정으로 되돌린다. 백업 이후 생긴 보기는 삭제(복구 가능) 처리한다. */
  async restoreBackup(backupId: string): Promise<Result<number>> {
    const backup = await this.db.get('view_backups', backupId);
    if (!backup || backup.owner_id !== this.session.ownerId()) return fail('NOT_FOUND', '백업을 찾을 수 없습니다.');
    const current = new Map((await this.loadAll()).map((v) => [v.id, v]));
    const changes: Array<{ record: LocalViewRecord; fields: SyncField[] }> = [];
    const t = nowIso();
    for (const b of backup.views) {
      const cur = current.get(b.id);
      if (cur) {
        const next: LocalViewRecord = { ...clone(cur), ...pickSynced(b), updated_at: t };
        const fields = this.changed(cur, next);
        if (fields.length) changes.push({ record: next, fields });
        current.delete(b.id);
      } else {
        changes.push({ record: { ...clone(b), version: 0, updated_at: t, _sync: { base: null } }, fields: [...SYNC_FIELDS] });
      }
    }
    for (const cur of current.values()) {
      if (!cur.deleted_at) changes.push({ record: { ...clone(cur), deleted_at: t, is_default: false, updated_at: t }, fields: ['deleted_at', 'is_default'] });
    }
    const r = await this.commit(changes);
    return r.ok ? ok(changes.length) : (r as Result<never>);
  }
}

export function pickConfig(v: ViewConfig): ViewConfig {
  return clone({ column_config: v.column_config, sort_config: v.sort_config, filter_config: v.filter_config, layout_config: v.layout_config });
}

/** 기본 보기가 여러 개면 가장 최근 수정된 것을, 없으면 가장 먼저 만든 것을 기본으로 본다. */
export function pickDefault<T extends ViewPreference>(views: T[]): T {
  const defaults = views.filter((v) => v.is_default);
  if (defaults.length) return defaults.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))[0];
  return [...views].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
}
