import { useMemo, useState } from 'react';
import type { DomainSnapshot } from '../domain/types';
import { localTimeZone } from '../lib/util';
import { itemsByDay, monthCells, shiftMonth, todayStr, WEEK_LABELS } from './calendarGrid';

/** 데스크톱 사이드바의 미니 달력. 일정·마감 투두가 있는 날에 점을 찍고, 날짜를 누르면 월간 캘린더로 간다 */
export function MiniCalendar({ data, onPick }: { data: DomainSnapshot; onPick: (date: string) => void }) {
  const today = todayStr();
  const [ym, setYm] = useState(today.slice(0, 7));
  const cells = useMemo(() => monthCells(ym), [ym]);
  const busy = useMemo(() => {
    const open = data.tasks.filter((t) => t.status !== 'done');
    return itemsByDay(data.events, open, cells[0], cells[cells.length - 1], localTimeZone());
  }, [data, cells]);
  const [y, m] = ym.split('-').map(Number);
  return (
    <section className="mini-cal" aria-label="미니 달력">
      <div className="mini-cal-head">
        <strong>
          {y}년 {m}월
        </strong>
        <span>
          <button type="button" className="icon-btn" onClick={() => setYm(shiftMonth(ym, -1))} aria-label="이전 달">
            ‹
          </button>
          <button type="button" className="icon-btn" onClick={() => setYm(shiftMonth(ym, 1))} aria-label="다음 달">
            ›
          </button>
        </span>
      </div>
      <div className="mini-cal-grid">
        {WEEK_LABELS.map((w) => (
          <span key={w} className="mini-cal-wd">
            {w}
          </span>
        ))}
        {cells.map((d) => {
          const has = busy.get(d);
          return (
            <button
              type="button"
              key={d}
              className={`mini-cal-day${d.slice(0, 7) !== ym ? ' out' : ''}${d === today ? ' today' : ''}`}
              onClick={() => onPick(d)}
              aria-label={`${d}${has ? ` 일정·할 일 ${has.occ.length + has.tasks.length}건` : ''}`}
            >
              {Number(d.slice(8))}
              {has && <i className="mini-cal-dot" />}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** 분류별 미완료 투두 개수 */
export function CategoryList({ data }: { data: DomainSnapshot }) {
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const t of data.tasks) if (t.status !== 'done' && t.category_id) c.set(t.category_id, (c.get(t.category_id) ?? 0) + 1);
    return c;
  }, [data.tasks]);
  if (!data.categories.length) return null;
  return (
    <section className="side-cats" aria-label="분류별 미완료 투두">
      <h2 className="side-label">분류</h2>
      <ul>
        {data.categories.map((c) => (
          <li key={c.id}>
            <span className="cat">
              <i className="dot" style={{ background: c.color }} />
              {c.name}
            </span>
            <span className="side-count">{counts.get(c.id) ?? 0}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
