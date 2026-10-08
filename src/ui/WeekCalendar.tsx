import { useMemo, useState } from 'react';
import type { Occurrence } from '../domain/recurrence';
import type { CalendarEvent, DomainSnapshot, Task } from '../domain/types';
import { addDays, formatInstant, localTimeZone } from '../lib/util';
import { itemsByDay, todayStr, WEEK_LABELS } from './calendarGrid';
import { RecordEditor } from './RecordEditor';

const weekStart = (d: string) => addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
const md = (d: string) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일`;

/**
 * 주간 캘린더 보기 (월요일 시작 7일). 데스크톱은 7열, 모바일은 날짜별로 쌓는다.
 * 하루 안에서는 종일 일정 → 시간순 일정 → 마감 투두 순서.
 */
export function WeekCalendar({ events, data }: { events: CalendarEvent[]; data: DomainSnapshot }) {
  const tz = localTimeZone();
  const today = todayStr();
  const [start, setStart] = useState(weekStart(today));
  const [open, setOpen] = useState<{ occ?: Occurrence; task?: Task } | null>(null);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);
  const byDay = useMemo(() => itemsByDay(events, data.tasks, days[0], days[6], tz), [events, data.tasks, days, tz]);
  const color = (id: string | null) => (id ? data.categories.find((c) => c.id === id)?.color : undefined);

  return (
    <section className="week-cal card" aria-label="주간 캘린더">
      <div className="month-cal-head">
        <h2>
          {md(days[0])} – {md(days[6])}
        </h2>
        <div className="row-actions">
          <button type="button" className="btn small" onClick={() => setStart(addDays(start, -7))} aria-label="이전 주">
            ‹
          </button>
          <button type="button" className="btn small" onClick={() => setStart(weekStart(today))}>
            이번 주
          </button>
          <button type="button" className="btn small" onClick={() => setStart(addDays(start, 7))} aria-label="다음 주">
            ›
          </button>
        </div>
      </div>
      <div className="week-grid">
        {days.map((d, i) => {
          const it = byDay.get(d);
          const occ = [...(it?.occ ?? [])].sort((a, b) => Number(b.event.all_day) - Number(a.event.all_day) || a.start_at.localeCompare(b.start_at));
          return (
            <div key={d} className={`week-day${d === today ? ' today' : ''}`}>
              <div className="week-day-head">
                <span className={i >= 5 ? 'weekend' : ''}>{WEEK_LABELS[i]}</span>
                <strong>{Number(d.slice(8))}</strong>
              </div>
              <div className="week-items">
                {occ.map((o) => (
                  <button key={o.key} type="button" className="week-item" style={{ borderLeftColor: color(o.event.category_id) ?? 'var(--accent)' }} onClick={() => setOpen({ occ: o })}>
                    <span className="cal-time">{o.event.all_day ? '종일' : formatInstant(o.start_at, tz).slice(-5)}</span>
                    <span className="week-title">{o.event.title}</span>
                  </button>
                ))}
                {it?.tasks.map((t) => (
                  <button key={t.id} type="button" className={`week-item cal-task${t.status === 'done' ? ' done' : ''}`} onClick={() => setOpen({ task: t })}>
                    <span className="cal-time">{t.status === 'done' ? '✓ 완료' : '할 일'}</span>
                    <span className="week-title">{t.title}</span>
                  </button>
                ))}
                {!it && <span className="week-empty">—</span>}
              </div>
            </div>
          );
        })}
      </div>
      {open?.occ && (
        <RecordEditor
          domain="events"
          record={open.occ.event}
          data={data}
          occurrence={open.occ.is_recurring ? { seriesId: open.occ.series_id, originalStart: open.occ.original_start_at, start_at: open.occ.start_at, end_at: open.occ.end_at, is_exception: open.occ.is_exception } : undefined}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.task && <RecordEditor domain="tasks" record={open.task} data={data} onClose={() => setOpen(null)} />}
    </section>
  );
}
