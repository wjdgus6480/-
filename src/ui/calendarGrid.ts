import { expandEvents, type Occurrence } from '../domain/recurrence';
import type { CalendarEvent, Task } from '../domain/types';
import { addDays, instantToLocalDate, zonedLocalToIso } from '../lib/util';

/** 이 기기 기준 오늘 (YYYY-MM-DD) */
export const todayStr = () => new Date().toLocaleDateString('en-CA');

/** 'YYYY-MM' 를 n 달 옮긴다 */
export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** 월요일 시작 달력 칸: 그 달 1일이 든 주의 월요일 ~ 말일이 든 주의 일요일 */
export function monthCells(ym: string): string[] {
  const first = `${ym}-01`;
  const start = addDays(first, -((new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const last = addDays(`${shiftMonth(ym, 1)}-01`, -1);
  const end = addDays(last, 6 - ((new Date(last + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export const WEEK_LABELS = ['월', '화', '수', '목', '금', '토', '일'];

export interface DayItems {
  occ: Occurrence[];
  tasks: Task[];
}

/** 날짜별 일정 회차·마감 투두. 종일 일정은 일정 시간대, 나머지는 이 기기 시간대의 날짜로 놓는다 */
export function itemsByDay(events: CalendarEvent[], tasks: Task[], from: string, to: string, tz: string): Map<string, DayItems> {
  const map = new Map<string, DayItems>();
  const at = (d: string) => {
    let v = map.get(d);
    if (!v) map.set(d, (v = { occ: [], tasks: [] }));
    return v;
  };
  for (const o of expandEvents(events, zonedLocalToIso(`${from}T00:00`, tz), zonedLocalToIso(`${addDays(to, 1)}T00:00`, tz))) {
    const d = instantToLocalDate(o.start_at, o.event.all_day ? o.event.timezone : tz);
    if (d >= from && d <= to) at(d).occ.push(o);
  }
  for (const t of tasks) if (t.due_date && t.due_date >= from && t.due_date <= to) at(t.due_date).tasks.push(t);
  return map;
}
