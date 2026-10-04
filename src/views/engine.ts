import type { DomainSnapshot } from '../domain/types';
import { formatInstant, instantToLocalDate, localTimeZone } from '../lib/util';
import { buildContext, domainRecords, getField, NONE_VALUE, FIELD_REGISTRY, type FieldContext, type FieldDef } from './fields';
import type { FilterCondition, FilterConfig, SortRule, ViewDomain } from './types';

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

function refName(def: FieldDef, id: unknown, ctx: FieldContext): string | null {
  if (typeof id !== 'string') return null;
  const target = def.refTarget === 'projects' ? ctx.projects : ctx.categories;
  return target.get(id)?.name ?? null;
}

/** 정렬용 값. null = 값 없음(항상 마지막) */
function sortValue(def: FieldDef, record: any, ctx: FieldContext): string | number | null {
  const v = def.get(record, ctx);
  if (v === null || v === undefined || v === '') return null;
  switch (def.kind) {
    case 'enum':
      return def.options!.findIndex((o) => o.value === v);
    case 'instant':
      return Date.parse(v as string);
    case 'boolean':
      return v ? 1 : 0;
    case 'ref':
      return refName(def, v, ctx);
    default:
      return v as string | number;
  }
}

function compare(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

function matchCondition(domain: ViewDomain, cond: FilterCondition, record: any, ctx: FieldContext): boolean {
  const def = getField(domain, cond.field);
  if (!def) return true; // 검증된 설정에서는 발생하지 않음
  const v = def.get(record, ctx);
  if (cond.type === 'in') {
    if (cond.values.length === 0) return true;
    if (v === null || v === undefined) return cond.values.includes(NONE_VALUE);
    return cond.values.includes(String(v));
  }
  if (cond.type === 'bool') return v === cond.value;
  // dateRange
  if (cond.from === null && cond.to === null) return true;
  if (typeof v !== 'string') return false;
  let day: string;
  if (def.kind === 'date') day = v;
  else {
    // 종일 일정은 일정 자체의 시간대 기준 날짜를 사용하고, 종료 시각(다음날 0시, 배타적)은 마지막 날로 본다.
    const allDay = domain === 'events' && record.all_day;
    const tz = allDay ? record.timezone : cond.tz ?? localTimeZone();
    day = instantToLocalDate(allDay && def.key === 'end_at' ? new Date(Date.parse(v) - 1).toISOString() : v, tz);
  }
  if (cond.from && day < cond.from) return false;
  if (cond.to && day > cond.to) return false;
  return true;
}

function matchSearch(domain: ViewDomain, q: string, record: any, ctx: FieldContext): boolean {
  if (!q) return true;
  const needle = q.normalize('NFC').toLocaleLowerCase('ko').trim();
  if (!needle) return true;
  return FIELD_REGISTRY[domain].some((f) => {
    if (!f.searchable) return false;
    const v = f.get(record, ctx);
    return typeof v === 'string' && v.normalize('NFC').toLocaleLowerCase('ko').includes(needle);
  });
}

export interface ApplyInput {
  sort_config: SortRule[];
  filter_config: FilterConfig;
}

/**
 * 원본을 변경하지 않고 필터·검색·정렬된 새 배열을 반환한다.
 * 필터에 걸러진 레코드는 삭제된 것이 아니다. 단지 이 보기에서 표시되지 않을 뿐이다.
 */
export function applySortAndFilterPure<R = any>(domain: ViewDomain, data: DomainSnapshot, config: ApplyInput, ctx = buildContext(data)): R[] {
  const records = domainRecords(domain, data).filter((r) => !r.deleted_at);
  const filtered = records.filter(
    (r) => matchSearch(domain, config.filter_config.search, r, ctx) && config.filter_config.conditions.every((c) => matchCondition(domain, c, r, ctx)),
  );
  const rules = config.sort_config.map((s) => ({ def: getField(domain, s.field)!, dir: s.dir })).filter((s) => s.def?.sortable);
  if (!rules.length) return filtered as R[];
  const keyed = filtered.map((r, i) => ({ r, i, keys: rules.map((s) => sortValue(s.def, r, ctx)) }));
  keyed.sort((a, b) => {
    for (let k = 0; k < rules.length; k++) {
      const av = a.keys[k];
      const bv = b.keys[k];
      if (av === null || bv === null) {
        const c = compare(av, bv); // null 은 방향과 관계없이 마지막
        if (c) return c;
        continue;
      }
      const c = compare(av, bv);
      if (c) return rules[k].dir === 'desc' ? -c : c;
    }
    return a.i - b.i;
  });
  return keyed.map((k) => k.r as R);
}

export interface StaleReference {
  conditionIndex: number;
  field: string;
  value: string;
}

/** 삭제되었거나 존재하지 않는 프로젝트·분류를 참조하는 필터 값을 찾는다. (이름 변경은 ID 참조라 영향 없음) */
export function findStaleReferences(domain: ViewDomain, filter: FilterConfig, data: DomainSnapshot): StaleReference[] {
  const ctx = buildContext(data);
  const out: StaleReference[] = [];
  filter.conditions.forEach((c, i) => {
    if (c.type !== 'in') return;
    const def = getField(domain, c.field);
    if (def?.kind !== 'ref') return;
    const target = def.refTarget === 'projects' ? ctx.projects : ctx.categories;
    for (const v of c.values) if (v !== NONE_VALUE && !target.has(v)) out.push({ conditionIndex: i, field: c.field, value: v });
  });
  return out;
}

/** 오래된 참조 값을 제거한 필터를 반환한다. 비게 된 조건은 제거한다. */
export function removeStaleReferences(domain: ViewDomain, filter: FilterConfig, data: DomainSnapshot): FilterConfig {
  const stale = findStaleReferences(domain, filter, data);
  if (!stale.length) return filter;
  const conditions = filter.conditions
    .map((c, i) => (c.type === 'in' ? { ...c, values: c.values.filter((v) => !stale.some((s) => s.conditionIndex === i && s.value === v)) } : c))
    .filter((c) => c.type !== 'in' || c.values.length > 0);
  return { ...filter, conditions };
}

export function displayValue(domain: ViewDomain, def: FieldDef, record: any, ctx: FieldContext, tz: string): string {
  const v = def.get(record, ctx);
  if (v === null || v === undefined) return '';
  switch (def.kind) {
    case 'enum':
      return def.options!.find((o) => o.value === v)?.label ?? String(v);
    case 'boolean':
      return v ? '예' : '';
    case 'ref':
      return refName(def, v, ctx) ?? '(삭제됨)';
    case 'instant': {
      const allDay = domain === 'events' && record.all_day;
      if (allDay && def.key === 'end_at') return formatInstant(new Date(Date.parse(v as string) - 1).toISOString(), record.timezone, false);
      return formatInstant(v as string, allDay ? record.timezone : tz, !allDay);
    }
    default:
      return String(v);
  }
}
