import { useState } from 'react';
import type { DomainSnapshot, Task } from '../domain/types';
import { TASK_PRIORITY, TASK_STATUS } from '../views/fields';
import { todayStr } from './calendarGrid';

const label = (opts: { value: string; label: string }[], v: string) => opts.find((o) => o.value === v)?.label ?? v;
const md = (d: string) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일`;

/**
 * 투두 카드 보기. 표와 같은 보기(필터·정렬·검색)의 결과를 마감 기준으로 묶어 보여 준다.
 * 묶음 안의 순서는 보기의 정렬을 그대로 따른다.
 */
export function TaskCards({ rows, data, onOpen, onToggle, emptyText }: { rows: Task[]; data: DomainSnapshot; onOpen: (t: Task) => void; onToggle: (t: Task, done: boolean) => void; emptyText: string }) {
  const today = todayStr();
  const [showDone, setShowDone] = useState(false);
  const groups: { key: string; title: string; items: Task[] }[] = [
    { key: 'overdue', title: '지난 기한', items: [] },
    { key: 'today', title: '오늘', items: [] },
    { key: 'upcoming', title: '예정', items: [] },
    { key: 'none', title: '날짜 없음', items: [] },
  ];
  const done: Task[] = [];
  for (const t of rows) {
    if (t.status === 'done') done.push(t);
    else if (!t.due_date) groups[3].items.push(t);
    else groups[t.due_date < today ? 0 : t.due_date === today ? 1 : 2].items.push(t);
  }
  const project = (id: string | null) => (id ? data.projects.find((p) => p.id === id) : undefined);
  const category = (id: string | null) => (id ? data.categories.find((c) => c.id === id) : undefined);

  const card = (t: Task) => {
    const cat = category(t.category_id);
    const due = t.due_date ? (t.due_date === today ? '오늘' : md(t.due_date)) : null;
    return (
      <li key={t.id} className={`task-card${t.status === 'done' ? ' done' : ''}`} style={cat ? { borderLeftColor: cat.color } : undefined}>
        <input type="checkbox" checked={t.status === 'done'} aria-label={`${t.title} 완료`} onChange={(e) => onToggle(t, e.target.checked)} />
        <button type="button" className="task-card-body" onClick={() => onOpen(t)}>
          <span className="task-card-title">{t.title}</span>
          {t.description && <span className="task-card-desc">{t.description}</span>}
          <span className="task-card-meta">
            {due && <span className={`task-card-due${t.status !== 'done' && t.due_date! < today ? ' overdue' : ''}`}>{due}</span>}
            {t.status === 'in_progress' && <span className="badge badge-status-in_progress">{label(TASK_STATUS, t.status)}</span>}
            {cat && (
              <span className="cat">
                <i className="dot" style={{ background: cat.color }} />
                {cat.name}
              </span>
            )}
            {project(t.project_id) && <span className="muted">{project(t.project_id)!.name}</span>}
          </span>
        </button>
        <span className={`badge badge-priority-${t.priority}`}>{label(TASK_PRIORITY, t.priority)}</span>
      </li>
    );
  };

  if (!rows.length) return <p className="card empty-cards muted">{emptyText}</p>;
  return (
    <div className="task-cards">
      {groups
        .filter((g) => g.items.length)
        .map((g) => (
          <section key={g.key} className={`task-group task-group-${g.key}`}>
            <h2 className="task-group-head">
              {g.title} <span className="task-group-count">{g.items.length}</span>
            </h2>
            <ul>{g.items.map(card)}</ul>
          </section>
        ))}
      {done.length > 0 && (
        <section className="task-group task-group-done">
          <h2 className="task-group-head">
            <button type="button" className="btn ghost small" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
              {showDone ? '▾' : '▸'} 완료됨 <span className="task-group-count">{done.length}</span>
            </button>
          </h2>
          {showDone && <ul>{done.map(card)}</ul>}
        </section>
      )}
    </div>
  );
}
