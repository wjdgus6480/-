import { useMemo, useState } from 'react';
import { useDomainData, useServices } from '../app/context';
import type { Occurrence } from '../domain/recurrence';
import type { Task } from '../domain/types';
import { addDays, formatInstant, localTimeZone } from '../lib/util';
import { TASK_PRIORITY } from '../views/fields';
import { itemsByDay, todayStr } from './calendarGrid';
import { RecordEditor } from './RecordEditor';
import { levelTitle, playerStats, setTaskDone, taskXp } from './xp';

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
const greeting = (h: number) => (h < 5 ? '늦은 밤이에요' : h < 12 ? '좋은 아침이에요' : h < 18 ? '좋은 오후예요' : '편안한 저녁이에요');
const md = (d: string) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일`;
const prioLabel = (p: string) => TASK_PRIORITY.find((o) => o.value === p)?.label ?? p;

/** 오늘 대시보드: 인사·진행률·레벨, 빠른 추가, 오늘의 퀘스트, 오늘 일정 타임라인, 다가오는 마감 */
export function TodayPage() {
  const s = useServices();
  const data = useDomainData();
  const tz = localTimeZone();
  const today = todayStr();
  const now = new Date();
  const [quick, setQuick] = useState('');
  const [open, setOpen] = useState<{ task?: Task; occ?: Occurrence } | null>(null);

  const stats = useMemo(() => playerStats(data.tasks), [data.tasks]);
  const { overdue, todayTasks, upcoming } = useMemo(() => {
    const open = data.tasks.filter((t) => t.status !== 'done');
    return {
      overdue: open.filter((t) => t.due_date && t.due_date < today),
      todayTasks: data.tasks.filter((t) => t.due_date === today),
      upcoming: open.filter((t) => t.due_date && t.due_date > today && t.due_date <= addDays(today, 7)).sort((a, b) => a.due_date!.localeCompare(b.due_date!)),
    };
  }, [data.tasks, today]);
  const todayOcc = useMemo(() => itemsByDay(data.events, [], today, today, tz).get(today)?.occ ?? [], [data.events, today, tz]);
  const doneToday = todayTasks.filter((t) => t.status === 'done').length;
  const pct = todayTasks.length ? Math.round((doneToday / todayTasks.length) * 100) : 0;
  // 지난 기한 → 오늘 남은 것 → 오늘 끝낸 것 순서
  const quests = [...overdue, ...todayTasks.filter((t) => t.status !== 'done'), ...todayTasks.filter((t) => t.status === 'done')];
  const remaining = quests.length - doneToday;
  const color = (id: string | null) => (id ? data.categories.find((c) => c.id === id)?.color : undefined);
  const project = (id: string | null) => (id ? data.projects.find((p) => p.id === id)?.name : undefined);

  const addQuick = async () => {
    const title = quick.trim();
    if (!title) return;
    await s.domain.createTask({ title, due_date: today });
    setQuick('');
  };

  const questRow = (t: Task) => (
    <li key={t.id} className={`quest${t.status === 'done' ? ' done' : ''}${t.due_date && t.due_date < today && t.status !== 'done' ? ' overdue' : ''}`}>
      <input type="checkbox" checked={t.status === 'done'} aria-label={`${t.title} 완료`} onChange={(e) => void setTaskDone(s.domain, t, e.target.checked)} />
      <button type="button" className="quest-body" onClick={() => setOpen({ task: t })}>
        <span className="quest-title">{t.title}</span>
        <span className="quest-meta">
          {t.due_date && t.due_date < today && <span className="task-card-due overdue">{md(t.due_date)} 지남</span>}
          {color(t.category_id) && <i className="dot" style={{ background: color(t.category_id) }} />}
          {project(t.project_id) && <span className="muted">{project(t.project_id)}</span>}
        </span>
      </button>
      <span className={`badge badge-priority-${t.priority}`}>{prioLabel(t.priority)}</span>
      <span className="xp-pill">+{taskXp(t)}</span>
    </li>
  );

  return (
    <section className="today">
      <header className="today-head">
        <div>
          <p className="today-date">
            {md(today)} {WEEKDAY[now.getDay()]}요일
          </p>
          <h2>{greeting(now.getHours())}</h2>
          <p className="muted">
            {remaining > 0 ? `남은 퀘스트 ${remaining}개, 하나씩 해치워 봐요.` : todayTasks.length ? '오늘 퀘스트를 모두 끝냈어요. 푹 쉬어요!' : '오늘 마감인 퀘스트가 없어요.'}
          </p>
        </div>
      </header>

      <div className="today-stats">
        <div className="stat card">
          <span className="stat-label">오늘 진행</span>
          <strong className="stat-value">
            {doneToday}/{todayTasks.length}
          </strong>
          <div className="bar" role="progressbar" aria-label="오늘 진행률" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="stat card">
          <span className="stat-label">
            Lv.{stats.level} {levelTitle(stats.level)}
          </span>
          <strong className="stat-value">
            {stats.into}
            <small> / {stats.need} EXP</small>
          </strong>
          <div className="bar xp" role="progressbar" aria-label="다음 레벨까지" aria-valuenow={stats.into} aria-valuemin={0} aria-valuemax={stats.need}>
            <i style={{ width: `${Math.round((stats.into / stats.need) * 100)}%` }} />
          </div>
        </div>
        <div className={`stat card${overdue.length ? ' warn-stat' : ''}`}>
          <span className="stat-label">지난 기한</span>
          <strong className="stat-value">{overdue.length}</strong>
        </div>
        <div className="stat card">
          <span className="stat-label">오늘 일정</span>
          <strong className="stat-value">{todayOcc.length}</strong>
        </div>
      </div>

      <form
        className="quick-add card"
        onSubmit={(e) => {
          e.preventDefault();
          void addQuick();
        }}
      >
        <input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="오늘 할 일을 입력하고 Enter (오늘 마감으로 추가)" aria-label="오늘 할 일 빠르게 추가" maxLength={500} />
        <button type="submit" className="btn primary" disabled={!quick.trim()}>
          추가
        </button>
      </form>

      <div className="today-cols">
        <section className="card today-quests">
          <h3>오늘의 퀘스트</h3>
          {quests.length ? <ul className="quest-list">{quests.map(questRow)}</ul> : <p className="muted small">오늘 마감인 투두가 없습니다. 위에서 바로 추가해 보세요.</p>}
        </section>
        <section className="card today-timeline">
          <h3>오늘 일정</h3>
          {todayOcc.length ? (
            <ol className="timeline">
              {todayOcc.map((o) => (
                <li key={o.key}>
                  <button type="button" className="timeline-item" style={{ borderLeftColor: color(o.event.category_id) ?? 'var(--accent)' }} onClick={() => setOpen({ occ: o })}>
                    <span className="cal-time">{o.event.all_day ? '종일' : `${formatInstant(o.start_at, tz).slice(-5)} – ${formatInstant(o.end_at, tz).slice(-5)}`}</span>
                    <span className="timeline-title">{o.event.title}</span>
                    {project(o.event.project_id) && <span className="muted small">{project(o.event.project_id)}</span>}
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">오늘은 일정이 없습니다.</p>
          )}
          {upcoming.length > 0 && (
            <>
              <h3 className="today-sub">다가오는 마감 (7일)</h3>
              <ul className="deadline-list">
                {upcoming.map((t) => (
                  <li key={t.id}>
                    <button type="button" className="occ-item" onClick={() => setOpen({ task: t })}>
                      <span className="task-card-due">{md(t.due_date!)}</span>
                      <span className="occ-title">{t.title}</span>
                      <span className={`badge badge-priority-${t.priority}`}>{prioLabel(t.priority)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      {open?.task && <RecordEditor domain="tasks" record={open.task} data={data} onClose={() => setOpen(null)} />}
      {open?.occ && (
        <RecordEditor
          domain="events"
          record={open.occ.event}
          data={data}
          occurrence={open.occ.is_recurring ? { seriesId: open.occ.series_id, originalStart: open.occ.original_start_at, start_at: open.occ.start_at, end_at: open.occ.end_at, is_exception: open.occ.is_exception } : undefined}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}
