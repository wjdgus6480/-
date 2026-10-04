import { isDateOnly, isValidTimeZone, localTimeZone } from '../lib/util';
import { FIELD_REGISTRY, getField, MAX_SEARCH, MAX_SORTS, MAX_WIDTH, MIN_WIDTH } from './fields';
import {
  VIEW_DOMAINS,
  fail,
  ok,
  type ColumnConfig,
  type FilterCondition,
  type FilterConfig,
  type LayoutConfig,
  type Result,
  type SortRule,
  type ValidationIssue,
  type ViewConfig,
  type ViewDomain,
} from './types';

const DEFAULT_SORT: Record<ViewDomain, SortRule[]> = {
  tasks: [
    { field: 'due_date', dir: 'asc' },
    { field: 'priority', dir: 'desc' },
  ],
  events: [{ field: 'start_at', dir: 'asc' }],
  projects: [{ field: 'updated_at', dir: 'desc' }],
};

/** 도메인별 기본 보기 설정 (기본 보기 복원 기준) */
export function defaultViewConfig(domain: ViewDomain): ViewConfig {
  return {
    column_config: FIELD_REGISTRY[domain].map((f, i) => ({
      field: f.key,
      visible: f.defaultVisible,
      position: i,
      width: f.defaultWidth,
      pinned: !!f.identity,
    })),
    sort_config: DEFAULT_SORT[domain].map((s) => ({ ...s })),
    filter_config: { search: '', conditions: [] },
    layout_config: { density: 'comfortable' },
  };
}

export function isViewDomain(v: unknown): v is ViewDomain {
  return typeof v === 'string' && (VIEW_DOMAINS as readonly string[]).includes(v);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkKeys(obj: Record<string, unknown>, allowed: string[], path: string, issues: ValidationIssue[]) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) issues.push({ code: 'UNKNOWN_KEY', path: `${path}.${k}`, message: `허용되지 않은 속성 '${k}'` });
  }
}

export function validateName(name: unknown): ValidationIssue[] {
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 60) {
    return [{ code: 'INVALID_NAME', path: 'name', message: '보기 이름은 1~60자여야 합니다.' }];
  }
  return [];
}

/**
 * 보기 설정을 검증하고 정규화한다.
 * - 알 수 없는 도메인/필드/속성, 중복 필드·순서, 잘못된 너비, 정렬 방향, 필터 유형을 거부한다.
 * - 누락된 컬럼은 숨김 상태로 뒤에 추가하고 position 을 0..n-1 로 다시 매긴다.
 * - 시간대가 없는 시각 필드 날짜 범위에는 현재 시간대를 채운다.
 */
export function validateViewConfig(domain: unknown, input: unknown): Result<ViewConfig> {
  if (!isViewDomain(domain)) return fail('UNKNOWN_DOMAIN', `지원하지 않는 도메인: ${String(domain)}`);
  const issues: ValidationIssue[] = [];
  if (!isObj(input)) return fail('VALIDATION', '설정 형식이 잘못되었습니다.', [{ code: 'INVALID_TYPE', path: '', message: '객체여야 합니다.' }]);
  checkKeys(input, ['column_config', 'sort_config', 'filter_config', 'layout_config'], 'config', issues);

  // ---- columns ----
  const columns: ColumnConfig[] = [];
  const rawCols = input.column_config;
  if (!Array.isArray(rawCols)) {
    issues.push({ code: 'INVALID_TYPE', path: 'column_config', message: '배열이어야 합니다.' });
  } else {
    const seenField = new Set<string>();
    const seenPos = new Set<number>();
    rawCols.forEach((c, i) => {
      const p = `column_config[${i}]`;
      if (!isObj(c)) {
        issues.push({ code: 'INVALID_TYPE', path: p, message: '객체여야 합니다.' });
        return;
      }
      checkKeys(c, ['field', 'visible', 'position', 'width', 'pinned'], p, issues);
      const def = typeof c.field === 'string' ? getField(domain, c.field) : undefined;
      if (!def) {
        issues.push({ code: 'UNKNOWN_FIELD', path: `${p}.field`, message: `알 수 없는 필드: ${String(c.field)}` });
        return;
      }
      if (seenField.has(def.key)) issues.push({ code: 'DUPLICATE_FIELD', path: `${p}.field`, message: `중복 필드: ${def.key}` });
      seenField.add(def.key);
      if (typeof c.visible !== 'boolean') issues.push({ code: 'INVALID_TYPE', path: `${p}.visible`, message: 'boolean 이어야 합니다.' });
      else if (def.identity && !c.visible)
        issues.push({ code: 'IDENTITY_COLUMN_HIDDEN', path: `${p}.visible`, message: `'${def.label}' 컬럼은 레코드 식별에 필요해 숨길 수 없습니다.` });
      if (typeof c.position !== 'number' || !Number.isInteger(c.position) || c.position < 0 || c.position > 999)
        issues.push({ code: 'INVALID_POSITION', path: `${p}.position`, message: 'position 은 0 이상의 정수여야 합니다.' });
      else if (seenPos.has(c.position)) issues.push({ code: 'DUPLICATE_POSITION', path: `${p}.position`, message: `중복 순서: ${c.position}` });
      else seenPos.add(c.position);
      if (typeof c.width !== 'number' || !Number.isFinite(c.width) || c.width < MIN_WIDTH || c.width > MAX_WIDTH)
        issues.push({ code: 'INVALID_WIDTH', path: `${p}.width`, message: `너비는 ${MIN_WIDTH}~${MAX_WIDTH} 사이여야 합니다.` });
      if (c.pinned !== undefined && typeof c.pinned !== 'boolean')
        issues.push({ code: 'INVALID_TYPE', path: `${p}.pinned`, message: 'boolean 이어야 합니다.' });
      columns.push({
        field: def.key,
        visible: c.visible === true,
        position: typeof c.position === 'number' ? c.position : 0,
        width: typeof c.width === 'number' ? Math.round(c.width) : def.defaultWidth,
        pinned: c.pinned === true,
      });
    });
  }

  // ---- sort ----
  const sorts: SortRule[] = [];
  const rawSort = input.sort_config ?? [];
  if (!Array.isArray(rawSort)) {
    issues.push({ code: 'INVALID_TYPE', path: 'sort_config', message: '배열이어야 합니다.' });
  } else {
    if (rawSort.length > MAX_SORTS) issues.push({ code: 'TOO_MANY_SORTS', path: 'sort_config', message: `정렬은 최대 ${MAX_SORTS}개입니다.` });
    const seen = new Set<string>();
    rawSort.forEach((s, i) => {
      const p = `sort_config[${i}]`;
      if (!isObj(s)) {
        issues.push({ code: 'INVALID_TYPE', path: p, message: '객체여야 합니다.' });
        return;
      }
      checkKeys(s, ['field', 'dir'], p, issues);
      const def = typeof s.field === 'string' ? getField(domain, s.field) : undefined;
      if (!def) issues.push({ code: 'UNKNOWN_FIELD', path: `${p}.field`, message: `알 수 없는 필드: ${String(s.field)}` });
      else if (!def.sortable) issues.push({ code: 'FIELD_NOT_SORTABLE', path: `${p}.field`, message: `'${def.label}'은(는) 정렬할 수 없습니다.` });
      else if (seen.has(def.key)) issues.push({ code: 'DUPLICATE_FIELD', path: `${p}.field`, message: `중복 정렬 필드: ${def.key}` });
      if (s.dir !== 'asc' && s.dir !== 'desc') issues.push({ code: 'INVALID_SORT_DIRECTION', path: `${p}.dir`, message: `정렬 방향은 asc 또는 desc 입니다.` });
      if (def) {
        seen.add(def.key);
        sorts.push({ field: def.key, dir: s.dir === 'desc' ? 'desc' : 'asc' });
      }
    });
  }

  // ---- filter ----
  const filter: FilterConfig = { search: '', conditions: [] };
  const rawFilter = input.filter_config ?? { search: '', conditions: [] };
  if (!isObj(rawFilter)) {
    issues.push({ code: 'INVALID_TYPE', path: 'filter_config', message: '객체여야 합니다.' });
  } else {
    checkKeys(rawFilter, ['search', 'conditions'], 'filter_config', issues);
    const search = rawFilter.search ?? '';
    if (typeof search !== 'string' || search.length > MAX_SEARCH)
      issues.push({ code: 'INVALID_FILTER_VALUE', path: 'filter_config.search', message: `검색어는 ${MAX_SEARCH}자 이하 문자열이어야 합니다.` });
    else filter.search = search;
    const conds = rawFilter.conditions ?? [];
    if (!Array.isArray(conds)) issues.push({ code: 'INVALID_TYPE', path: 'filter_config.conditions', message: '배열이어야 합니다.' });
    else {
      const seen = new Set<string>();
      conds.forEach((c, i) => {
        const cond = validateCondition(domain, c, `filter_config.conditions[${i}]`, issues);
        if (!cond) return;
        if (seen.has(cond.field)) {
          issues.push({ code: 'DUPLICATE_FIELD', path: `filter_config.conditions[${i}].field`, message: `같은 필드의 필터가 중복되었습니다: ${cond.field}` });
          return;
        }
        seen.add(cond.field);
        filter.conditions.push(cond);
      });
    }
  }

  // ---- layout ----
  const layout: LayoutConfig = { density: 'comfortable' };
  const rawLayout = input.layout_config ?? {};
  if (!isObj(rawLayout)) issues.push({ code: 'INVALID_TYPE', path: 'layout_config', message: '객체여야 합니다.' });
  else {
    checkKeys(rawLayout, ['density', 'timezone'], 'layout_config', issues);
    if (rawLayout.density !== undefined && rawLayout.density !== 'comfortable' && rawLayout.density !== 'compact')
      issues.push({ code: 'INVALID_TYPE', path: 'layout_config.density', message: 'comfortable 또는 compact' });
    else if (rawLayout.density) layout.density = rawLayout.density;
    if (rawLayout.timezone !== undefined) {
      if (!isValidTimeZone(rawLayout.timezone)) issues.push({ code: 'INVALID_TIMEZONE', path: 'layout_config.timezone', message: '잘못된 시간대' });
      else layout.timezone = rawLayout.timezone;
    }
  }

  if (issues.length) return fail('VALIDATION', '보기 설정이 올바르지 않습니다.', issues);

  // 정규화: 누락 컬럼 추가, position 재정렬
  const present = new Set(columns.map((c) => c.field));
  let next = Math.max(-1, ...columns.map((c) => c.position)) + 1;
  for (const f of FIELD_REGISTRY[domain]) {
    if (!present.has(f.key)) columns.push({ field: f.key, visible: !!f.identity, position: next++, width: f.defaultWidth, pinned: false });
  }
  columns.sort((a, b) => a.position - b.position).forEach((c, i) => (c.position = i));

  return ok({ column_config: columns, sort_config: sorts, filter_config: filter, layout_config: layout });
}

function validateCondition(domain: ViewDomain, c: unknown, p: string, issues: ValidationIssue[]): FilterCondition | null {
  if (!isObj(c)) {
    issues.push({ code: 'INVALID_TYPE', path: p, message: '객체여야 합니다.' });
    return null;
  }
  const def = typeof c.field === 'string' ? getField(domain, c.field) : undefined;
  if (!def) {
    issues.push({ code: 'UNKNOWN_FIELD', path: `${p}.field`, message: `알 수 없는 필드: ${String(c.field)}` });
    return null;
  }
  if (c.type !== 'in' && c.type !== 'dateRange' && c.type !== 'bool') {
    issues.push({ code: 'INVALID_FILTER_TYPE', path: `${p}.type`, message: `지원하지 않는 필터 유형: ${String(c.type)}` });
    return null;
  }
  if (def.filter !== c.type) {
    issues.push({ code: 'FIELD_NOT_FILTERABLE', path: `${p}.field`, message: `'${def.label}'에는 '${c.type}' 필터를 쓸 수 없습니다.` });
    return null;
  }
  if (c.type === 'in') {
    checkKeys(c, ['type', 'field', 'values'], p, issues);
    const values = c.values;
    if (!Array.isArray(values) || values.length > 200 || values.some((v) => typeof v !== 'string' || v.length > 100)) {
      issues.push({ code: 'INVALID_FILTER_VALUE', path: `${p}.values`, message: '값 목록이 올바르지 않습니다.' });
      return null;
    }
    if (def.options) {
      const allowed = new Set(def.options.map((o) => o.value));
      const bad = values.filter((v) => !allowed.has(v as string));
      if (bad.length) {
        issues.push({ code: 'INVALID_FILTER_VALUE', path: `${p}.values`, message: `허용되지 않은 값: ${bad.join(', ')}` });
        return null;
      }
    }
    return { type: 'in', field: def.key, values: [...new Set(values as string[])] };
  }
  if (c.type === 'bool') {
    checkKeys(c, ['type', 'field', 'value'], p, issues);
    if (typeof c.value !== 'boolean') {
      issues.push({ code: 'INVALID_FILTER_VALUE', path: `${p}.value`, message: 'boolean 이어야 합니다.' });
      return null;
    }
    return { type: 'bool', field: def.key, value: c.value };
  }
  checkKeys(c, ['type', 'field', 'from', 'to', 'tz'], p, issues);
  const from = c.from ?? null;
  const to = c.to ?? null;
  let okDates = true;
  for (const [k, v] of [['from', from], ['to', to]] as const) {
    if (v !== null && !isDateOnly(v)) {
      issues.push({ code: 'INVALID_DATE', path: `${p}.${k}`, message: `날짜는 YYYY-MM-DD 형식이어야 합니다: ${String(v)}` });
      okDates = false;
    }
  }
  if (okDates && from && to && (from as string) > (to as string)) {
    issues.push({ code: 'INVALID_DATE', path: p, message: '시작 날짜가 종료 날짜보다 늦습니다.' });
    okDates = false;
  }
  if (c.tz !== undefined && !isValidTimeZone(c.tz)) {
    issues.push({ code: 'INVALID_TIMEZONE', path: `${p}.tz`, message: `잘못된 시간대: ${String(c.tz)}` });
    return null;
  }
  if (!okDates) return null;
  const cond: FilterCondition = { type: 'dateRange', field: def.key, from: from as string | null, to: to as string | null };
  // 날짜 전용 필드에는 시간대가 의미 없으므로 저장하지 않는다.
  if (def.kind === 'instant') cond.tz = (c.tz as string | undefined) ?? localTimeZone();
  return cond;
}
