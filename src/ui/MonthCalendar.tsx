import { useEffect, useMemo, useState } from 'react';
import type { Occurrence } from '../domain/recurrence';
import type { CalendarEvent, DomainSnapshot, Task } from '../domain/types';
import { formatInstant, localTimeZone } from '../lib/util';
import { itemsByDay, monthCells, shiftMonth, todayStr, WEEK_LABELS } from './calendarGrid';
import { RecordEditor } from './RecordEditor';

const MAX_CHIPS = 3;

/**
 * 월간 캘린더 보기. 일정 보기의 필터·검색을 거친 일정(events)을 회차로 펼쳐 날짜 칸에 놓고, 마감 투두도 함께 보여 준다.
 * 데스크톱은 칸 안에 제목 칩, 모바일은 점만 찍고 고른 날의 목록을 아래에 보여 준다.
 */
export function MonthCalendar({ events, data, focusDate }: { events: CalendarEvent[]; data: DomainSnapshot; focusDate?: string | null }) {
  const tz = localTimeZone();
  const today = todayStr();
  const [ym, setYm] = useState((focusDate ?? today).slice(0, 7));
  const [picked, setPicked] = useState(focusDate ?? today);
  const [open, setOpen] = useState<{ occ?: Occurrence; task?: Task } | null>(null);
  useEffect(() => {
    if (!focusDate) return;
    setYm(focusDate.slice(0, 7));
    setPicked(focusDate);
  }, [focusDate]);

  const cells = useMemo(() => monthCells(ym), [ym]);
  const byDay = useMemo(() => itemsByDay(events, data.tasks, cells[0], cells[cells.length - 1], tz), [events, data.tasks, cells, tz]);
  const color = (id: string | null) => (id ? data.categories.find((c) => c.id === id)?.color : undefined);
  const time = (o: Occurrence) => (o.event.all_day ? '종일' : formatInstant(o.start_at, tz).slice(-5));
  const [y, m] = ym.split('-').map(Number);
  const pickedItems = byDay.get(picked);

  const occChip = (o: Occurrence, cls: string) => (
    <button key={o.key} type="button" className={cls} style={{ borderLeftColor: color(o.event.category_id) ?? 'var(--accent)' }} onClick={() => setOpen({ occ: o })}>
      <span className="cal-time">{time(o)}</span>
      <span className="cal-title">{o.event.title}</span>
    </button>
  );
  const taskChip = (t: Task, cls: string) => (
    <button key={t.id} type="button" className={`${cls} cal-task${t.status === 'done' ? ' done' : ''}`} onClick={() => setOpen({ task: t })}>
      <span className="cal-time">{t.status === 'done' ? '✓' : '할 일'}</span>
      <span className="cal-title">{t.title}</span>
    </button>
  );

  return (
    <section className="month-cal card" aria-label="월간 캘린더">
      <div className="month-cal-head">
        <h2>
          {y}년 {m}월
        </h2>
        <div className="row-actions">
          <button type="button" className="btn small" onClick={() => setYm(shiftMonth(ym, -1))} aria-label="이전 달">
            ‹
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setYm(today.slice(0, 7));
              setPicked(today);
            }}
          >
            오늘
          </button>
          <button type="button" className="btn small" onClick={() => setYm(shiftMonth(ym, 1))} aria-label="다음 달">
            ›
          </button>
        </div>
      </div>
      <div className="month-grid">
        {WEEK_LABELS.map((w, i) => (
          <div key={w} className={`month-wd${i >= 5 ? ' weekend' : ''}`}>
            {w}
          </div>
        ))}
        {cells.map((d) => {
          const it = byDay.get(d);
          const all = [...(it?.occ.map((o) => occChip(o, 'cal-chip')) ?? []), ...(it?.tasks.map((t) => taskChip(t, 'cal-chip')) ?? [])];
          return (
            <div
              key={d}
              className={`month-cell${d.slice(0, 7) !== ym ? ' out' : ''}${d === today ? ' today' : ''}${d === picked ? ' picked' : ''}`}
              onClick={() => setPicked(d)}
            >
              <button type="button" className="month-day" onClick={() => setPicked(d)} aria-label={`${d} ${all.length}건`} aria-pressed={d === picked}>
                {Number(d.slice(8))}
              </button>
              <div className="month-chips" onClick={(e) => e.stopPropagation()}>
                {all.slice(0, MAX_CHIPS)}
                {all.length > MAX_CHIPS && (
                  <button type="button" className="cal-more" onClick={() => setPicked(d)}>
                    +{all.length - MAX_CHIPS}
                  </button>
                )}
              </div>
              {all.length > 0 && <i className="month-dot" aria-hidden />}
            </div>
          );
        })}
      </div>
      <div className="month-day-list">
        <h3>
          {Number(picked.slice(5, 7))}월 {Number(picked.slice(8))}일{picked === today ? ' (오늘)' : ''}
        </h3>
        {!pickedItems ? (
          <p className="muted small">이 날에는 일정이나 마감 투두가 없습니다.</p>
        ) : (
          <div className="month-day-items">
            {pickedItems.occ.map((o) => occChip(o, 'occ-item'))}
            {pickedItems.tasks.map((t) => taskChip(t, 'occ-item'))}
          </div>
        )}
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
