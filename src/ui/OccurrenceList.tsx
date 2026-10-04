import { useMemo, useState } from 'react';
import { prefs } from '../app/context';
import { describeRule, expandEvents, type Occurrence } from '../domain/recurrence';
import type { DomainSnapshot } from '../domain/types';
import { addDays, formatInstant, localTimeZone, zonedLocalToIso } from '../lib/util';
import { RecordEditor } from './RecordEditor';

type Preset = 'past30' | 'week' | 'next30' | 'custom';
const PRESETS: { key: Preset; label: string }[] = [
  { key: 'past30', label: '지난 30일' },
  { key: 'week', label: '이번 주' },
  { key: 'next30', label: '앞으로 30일' },
  { key: 'custom', label: '직접 지정' },
];

/** 반복 일정을 실제 회차로 펼쳐 보여 주는 목록 (일정 테이블은 반복 일정을 1행으로 보여 줌) */
export function OccurrenceList({ data }: { data: DomainSnapshot }) {
  const tz = localTimeZone();
  const today = new Date().toLocaleDateString('en-CA');
  const [preset, setPreset] = useState<Preset>(() => (prefs.get('dotday.occ.preset') as Preset) ?? 'next30');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDays(today, 30));
  const [open, setOpen] = useState<Occurrence | null>(null);
  const [collapsed, setCollapsed] = useState(() => prefs.get('dotday.occ.collapsed') === '1');

  const range = useMemo(() => {
    const weekStart = addDays(today, -((new Date().getDay() + 6) % 7));
    const [a, b] =
      preset === 'past30' ? [addDays(today, -30), today] : preset === 'week' ? [weekStart, addDays(weekStart, 6)] : preset === 'next30' ? [today, addDays(today, 30)] : [from, to <= from ? from : to];
    return { a, b, start: zonedLocalToIso(`${a}T00:00`, tz), end: zonedLocalToIso(`${addDays(b, 1)}T00:00`, tz) };
  }, [preset, from, to, today, tz]);

  const occ = useMemo(() => expandEvents(data.events, range.start, range.end), [data.events, range]);
  const projectName = (id: string | null) => (id ? data.projects.find((p) => p.id === id)?.name : undefined);

  let lastDay = '';
  return (
    <section className="card occ">
      <div className="occ-head">
        <button
          type="button"
          className="btn ghost"
          aria-expanded={!collapsed}
          onClick={() => {
            setCollapsed(!collapsed);
            prefs.set('dotday.occ.collapsed', collapsed ? '0' : '1');
          }}
        >
          {collapsed ? '▸' : '▾'} 회차 보기 <span className="muted">({occ.length}개)</span>
        </button>
        {!collapsed && (
          <div className="chips" role="radiogroup" aria-label="기간">
            {PRESETS.map((p) => (
              <label key={p.key} className={`chip ${preset === p.key ? 'on' : ''}`}>
                <input
                  type="radio"
                  name="occ-preset"
                  checked={preset === p.key}
                  onChange={() => {
                    setPreset(p.key);
                    prefs.set('dotday.occ.preset', p.key);
                  }}
                />
                {p.label}
              </label>
            ))}
          </div>
        )}
      </div>
      {!collapsed && preset === 'custom' && (
        <div className="date-range">
          <input type="date" aria-label="회차 기간 시작" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          <span>~</span>
          <input type="date" aria-label="회차 기간 끝" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </div>
      )}
      {!collapsed && (
        <ul className="occ-list" aria-label="회차 목록">
          {occ.length === 0 && <li className="muted">이 기간에 일정이 없습니다.</li>}
          {occ.map((o) => {
            const day = formatInstant(o.start_at, o.event.all_day ? o.event.timezone : tz, false);
            const head = day !== lastDay ? day : null;
            lastDay = day;
            return (
              <li key={o.key}>
                {head && <div className="occ-day">{head}</div>}
                <button
                  type="button"
                  className="occ-item"
                  onClick={() => setOpen(o)}
                  aria-label={`${day} ${o.event.all_day ? '종일' : formatInstant(o.start_at, tz).slice(-5)} ${o.event.title}${o.is_exception ? ' (이 회차 변경됨)' : ''}`}
                >
                  <span className="occ-time">{o.event.all_day ? '종일' : formatInstant(o.start_at, tz).slice(-5)}</span>
                  <span className="occ-title">{o.event.title}</span>
                  {o.is_recurring && <span className="badge" title={describeRule(data.events.find((e) => e.id === o.series_id)?.recurrence_rule ?? null)}>반복</span>}
                  {o.is_exception && <span className="badge badge-status-in_progress">이 회차 변경됨</span>}
                  {projectName(o.event.project_id) && <span className="muted small">{projectName(o.event.project_id)}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {open && (
        <RecordEditor
          domain="events"
          record={open.event}
          data={data}
          occurrence={open.is_recurring ? { seriesId: open.series_id, originalStart: open.original_start_at, start_at: open.start_at, end_at: open.end_at, is_exception: open.is_exception } : undefined}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}
