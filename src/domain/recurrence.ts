// 반복 일정 규칙과 발생 회차 계산.
// RFC 5545 RRULE 의 부분집합만 지원한다:
//   FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL=n, COUNT=n 또는 UNTIL=YYYYMMDD(일정 시간대 기준, 포함), BYDAY=MO,TU..(WEEKLY 만)
// 회차는 일정 시간대의 "벽시계 시각"을 유지한다 (서머타임이 바뀌어도 매일 9시는 9시).
// MONTHLY 는 시작일의 '일'을 따르며 그 날이 없는 달(예: 31일)은 건너뛴다 (RFC 5545 동작).
// 예외 회차는 별도 일정 행(recurrence_parent_id + original_start_at)으로 저장한다.

import { addDays, isoToZonedLocal, zonedLocalToIso } from '../lib/util';
import type { CalendarEvent } from './types';

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Rule {
  freq: Freq;
  interval: number;
  count?: number;
  /** YYYY-MM-DD, 일정 시간대 기준 마지막 날(포함) */
  until?: string;
  byday?: Weekday[];
}

export type ParseResult = { ok: true; rule: Rule } | { ok: false; error: string };

export const MAX_INTERVAL = 999;
export const MAX_COUNT = 9999;

export function parseRule(text: string): ParseResult {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '빈 규칙' };
  const parts = text.trim().toUpperCase().split(';');
  const kv = new Map<string, string>();
  for (const p of parts) {
    const [k, v, ...rest] = p.split('=');
    if (!k || v === undefined || rest.length) return { ok: false, error: `형식 오류: ${p}` };
    if (kv.has(k)) return { ok: false, error: `중복 항목: ${k}` };
    kv.set(k, v);
  }
  for (const k of kv.keys()) if (!['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY'].includes(k)) return { ok: false, error: `지원하지 않는 항목: ${k}` };
  const freq = kv.get('FREQ') as Freq;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return { ok: false, error: `지원하지 않는 반복 단위: ${String(freq)}` };
  const rule: Rule = { freq, interval: 1 };
  if (kv.has('INTERVAL')) {
    const n = Number(kv.get('INTERVAL'));
    if (!Number.isInteger(n) || n < 1 || n > MAX_INTERVAL) return { ok: false, error: '간격은 1~999' };
    rule.interval = n;
  }
  if (kv.has('COUNT') && kv.has('UNTIL')) return { ok: false, error: 'COUNT 와 UNTIL 은 함께 쓸 수 없습니다.' };
  if (kv.has('COUNT')) {
    const n = Number(kv.get('COUNT'));
    if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) return { ok: false, error: '반복 횟수는 1~9999' };
    rule.count = n;
  }
  if (kv.has('UNTIL')) {
    const u = kv.get('UNTIL')!;
    if (!/^\d{8}$/.test(u)) return { ok: false, error: 'UNTIL 은 YYYYMMDD' };
    const d = `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
    if (new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) !== d) return { ok: false, error: `잘못된 날짜: ${u}` };
    rule.until = d;
  }
  if (kv.has('BYDAY')) {
    if (freq !== 'WEEKLY') return { ok: false, error: 'BYDAY 는 매주 반복에서만 지원합니다.' };
    const days = kv.get('BYDAY')!.split(',');
    if (!days.length || days.some((d) => !(WEEKDAYS as readonly string[]).includes(d))) return { ok: false, error: '요일은 MO,TU,WE,TH,FR,SA,SU' };
    rule.byday = WEEKDAYS.filter((w) => days.includes(w));
  }
  return { ok: true, rule };
}

export function formatRule(rule: Rule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byday?.length) parts.push(`BYDAY=${rule.byday.join(',')}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  if (rule.until) parts.push(`UNTIL=${rule.until.replace(/-/g, '')}`);
  return parts.join(';');
}

export function describeRule(text: string | null): string {
  if (!text) return '';
  const p = parseRule(text);
  if (!p.ok) return '알 수 없는 반복';
  const r = p.rule;
  const unit = { DAILY: '일', WEEKLY: '주', MONTHLY: '개월', YEARLY: '년' }[r.freq];
  let s = r.interval === 1 ? { DAILY: '매일', WEEKLY: '매주', MONTHLY: '매월', YEARLY: '매년' }[r.freq] : `${r.interval}${unit}마다`;
  if (r.byday?.length) s += ' ' + r.byday.map((d) => '월화수목금토일'[WEEKDAYS.indexOf(d)]).join('·');
  if (r.count) s += `, ${r.count}회`;
  if (r.until) s += `, ${r.until}까지`;
  return s;
}

// ---------------- 회차 계산 ----------------

export interface Occurrence {
  /** `${seriesId}@${originalStartIso}` (반복이 아니면 일정 ID) */
  key: string;
  series_id: string;
  /** 표시할 레코드 (예외 회차면 예외 행, 아니면 원본) */
  event: CalendarEvent;
  original_start_at: string;
  start_at: string;
  end_at: string;
  is_exception: boolean;
  is_recurring: boolean;
}

const dayOfWeek = (date: string) => (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7; // 월=0
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1-12
const pad = (n: number) => String(n).padStart(2, '0');
const wallMs = (local: string) => Date.parse(local + ':00Z'); // 'YYYY-MM-DDTHH:mm' 를 UTC 처럼 계산

/** 원래 회차 시작 시각들을 순서대로 생성 (벽시계 'YYYY-MM-DD') */
function* candidateDates(rule: Rule, startDate: string): Generator<string> {
  const iv = rule.interval;
  if (rule.freq === 'DAILY') {
    for (let k = 0; ; k++) yield addDays(startDate, k * iv);
  }
  if (rule.freq === 'WEEKLY') {
    const days = (rule.byday?.length ? rule.byday : [WEEKDAYS[dayOfWeek(startDate)]]).map((d) => WEEKDAYS.indexOf(d));
    const monday = addDays(startDate, -dayOfWeek(startDate));
    for (let w = 0; ; w++) {
      const wk = addDays(monday, w * 7 * iv);
      for (const d of days) {
        const date = addDays(wk, d);
        if (date >= startDate) yield date;
      }
    }
  }
  const [y0, m0, d0] = startDate.split('-').map(Number);
  if (rule.freq === 'MONTHLY') {
    for (let k = 0; ; k++) {
      const total = m0 - 1 + k * iv;
      const y = y0 + Math.floor(total / 12);
      const m = (total % 12) + 1;
      if (d0 <= daysInMonth(y, m)) yield `${y}-${pad(m)}-${pad(d0)}`;
    }
  }
  if (rule.freq === 'YEARLY') {
    for (let k = 0; ; k++) {
      const y = y0 + k * iv;
      if (d0 <= daysInMonth(y, m0)) yield `${y}-${pad(m0)}-${pad(d0)}`;
    }
  }
}

function seriesShape(ev: CalendarEvent) {
  const tz = ev.timezone;
  const ls = isoToZonedLocal(ev.start_at, tz);
  const le = isoToZonedLocal(ev.end_at, tz);
  return { tz, startDate: ls.slice(0, 10), time: ls.slice(11, 16), wallDuration: wallMs(le) - wallMs(ls), allDayDays: Math.max(1, Math.round((wallMs(le.slice(0, 10) + 'T00:00') - wallMs(ls.slice(0, 10) + 'T00:00')) / 86400000)) };
}

function occurrenceTimes(ev: CalendarEvent, date: string, shape: ReturnType<typeof seriesShape>) {
  if (ev.all_day) {
    return { start: zonedLocalToIso(`${date}T00:00`, shape.tz), end: zonedLocalToIso(`${addDays(date, shape.allDayDays)}T00:00`, shape.tz) };
  }
  const localStart = `${date}T${shape.time}`;
  const endWall = new Date(wallMs(localStart) + shape.wallDuration).toISOString().slice(0, 16);
  return { start: zonedLocalToIso(localStart, shape.tz), end: zonedLocalToIso(endWall, shape.tz) };
}

/** 원래 회차 시작 시각을 계산한다. 규칙이 잘못되었으면 첫 회차만 돌려준다. */
export function seriesStarts(master: CalendarEvent, rangeEndIso: string, maxIterations = 200000): Array<{ start: string; end: string }> {
  const parsed = master.recurrence_rule ? parseRule(master.recurrence_rule) : null;
  if (!parsed?.ok) return [{ start: master.start_at, end: master.end_at }];
  const rule = parsed.rule;
  const shape = seriesShape(master);
  const out: Array<{ start: string; end: string }> = [];
  const rangeEnd = Date.parse(rangeEndIso);
  let n = 0;
  let iter = 0;
  for (const date of candidateDates(rule, shape.startDate)) {
    if (++iter > maxIterations) break;
    if (rule.until && date > rule.until) break;
    if (rule.count && n >= rule.count) break;
    n++;
    const t = occurrenceTimes(master, date, shape);
    if (Date.parse(t.start) >= rangeEnd) break;
    out.push(t);
  }
  return out;
}

/**
 * [rangeStart, rangeEnd) 와 겹치는 회차를 시작 시각 순으로 반환한다.
 * 삭제된 일정·취소된 회차는 제외하고, 단일 회차 변경은 변경된 값으로 보여준다.
 */
export function expandEvents(events: CalendarEvent[], rangeStartIso: string, rangeEndIso: string): Occurrence[] {
  const rs = Date.parse(rangeStartIso);
  const re = Date.parse(rangeEndIso);
  const overlaps = (s: string, e: string) => Date.parse(s) < re && Math.max(Date.parse(e), Date.parse(s) + 1) > rs;
  const live = events.filter((e) => !e.deleted_at);
  const masters = new Map(live.filter((e) => !e.recurrence_parent_id).map((e) => [e.id, e]));
  const overridesBySeries = new Map<string, Map<number, CalendarEvent>>();
  for (const o of live) {
    if (!o.recurrence_parent_id || !o.original_start_at) continue;
    const m = overridesBySeries.get(o.recurrence_parent_id) ?? new Map();
    m.set(Date.parse(o.original_start_at), o);
    overridesBySeries.set(o.recurrence_parent_id, m);
  }
  const out: Occurrence[] = [];
  for (const master of masters.values()) {
    if (!master.recurrence_rule) {
      if (overlaps(master.start_at, master.end_at))
        out.push({ key: master.id, series_id: master.id, event: master, original_start_at: master.start_at, start_at: master.start_at, end_at: master.end_at, is_exception: false, is_recurring: false });
      continue;
    }
    const overrides = overridesBySeries.get(master.id) ?? new Map<number, CalendarEvent>();
    const used = new Set<number>();
    // 회차를 다른 날로 옮긴 경우(범위 밖 원래 회차 → 범위 안으로)를 위해 예외의 원래 시각까지 계산한다.
    const extendTo = Math.max(re, ...[...overrides.keys()].map((k) => k + 1));
    const starts = seriesStarts(master, new Date(extendTo).toISOString());
    for (const t of starts) {
      const ms = Date.parse(t.start);
      const ov = overrides.get(ms);
      if (ov) {
        used.add(ms);
        if (ov.is_cancelled) continue;
        if (overlaps(ov.start_at, ov.end_at))
          out.push({ key: `${master.id}@${t.start}`, series_id: master.id, event: ov, original_start_at: t.start, start_at: ov.start_at, end_at: ov.end_at, is_exception: true, is_recurring: true });
        continue;
      }
      if (overlaps(t.start, t.end))
        out.push({ key: `${master.id}@${t.start}`, series_id: master.id, event: master, original_start_at: t.start, start_at: t.start, end_at: t.end, is_exception: false, is_recurring: true });
    }
    // 원래 회차와 맞지 않는 예외(규칙 변경 등)는 표시하지 않는다.
  }
  return out.sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at) || a.key.localeCompare(b.key));
}

export interface RemapPlan {
  moved: Array<{ ov: CalendarEvent; original: string; start: string; end: string }>;
  orphaned: CalendarEvent[];
}

/**
 * 반복 일정의 시간·규칙이 바뀔 때 회차 예외를 새 회차로 옮긴다.
 * 기준: 예전 일정 시간대의 '달력 날짜'가 같은 새 회차. 그런 회차가 없으면 orphaned.
 * 시간을 직접 바꾸지 않은 예외(원래 시각 그대로)는 새 회차 시간을 따르고, 직접 옮긴 시간은 유지한다.
 */
export function remapExceptions(oldMaster: CalendarEvent, newMaster: CalendarEvent, overrides: CalendarEvent[]): RemapPlan {
  const plan: RemapPlan = { moved: [], orphaned: [] };
  if (!overrides.length) return plan;
  const latest = Math.max(...overrides.map((o) => Date.parse(o.original_start_at!)));
  const byDate = new Map<string, { start: string; end: string }>();
  for (const s of seriesStarts(newMaster, new Date(latest + 3 * 86400000).toISOString())) byDate.set(isoToZonedLocal(s.start, newMaster.timezone).slice(0, 10), s);
  const oldDuration = Date.parse(oldMaster.end_at) - Date.parse(oldMaster.start_at);
  for (const ov of overrides) {
    const date = isoToZonedLocal(ov.original_start_at!, oldMaster.timezone).slice(0, 10);
    const target = byDate.get(date);
    if (!target) {
      plan.orphaned.push(ov);
      continue;
    }
    const untouchedTime = ov.start_at === ov.original_start_at && Date.parse(ov.end_at) - Date.parse(ov.start_at) === oldDuration;
    plan.moved.push({ ov, original: target.start, start: untouchedTime ? target.start : ov.start_at, end: untouchedTime ? target.end : ov.end_at });
  }
  return plan;
}

/** 예외 회차 행의 안정적인 ID: 같은 회차를 두 기기에서 따로 바꿔도 같은 ID 가 되어 충돌로 처리된다. */
export async function overrideId(seriesId: string, originalStartIso: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`dotday-override:${seriesId}:${new Date(originalStartIso).toISOString()}`)));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
