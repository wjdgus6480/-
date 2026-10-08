import { useState } from 'react';
import { useServices } from '../app/context';
import { followingRule } from '../domain/repo';
import type { CalendarEvent, DomainSnapshot, Project, Task } from '../domain/types';
import { describeRule, formatRule, MAX_COUNT, MAX_INTERVAL, parseRule, WEEKDAYS, type Freq, type Rule } from '../domain/recurrence';
import { addDays, isoToZonedLocal, localTimeZone, zonedLocalToIso } from '../lib/util';
import { PROJECT_STATUS, TASK_PRIORITY, TASK_STATUS } from '../views/fields';
import type { ViewDomain } from '../views/types';
import { Panel } from './ViewMenus';
import { setTaskDone, taskXp } from './xp';

const TIMEZONES = Array.from(new Set([localTimeZone(), 'Asia/Seoul', 'UTC', 'Asia/Tokyo', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris']));

export function RecordEditor({
  domain,
  record,
  data,
  onClose,
  occurrence,
}: {
  domain: ViewDomain;
  record: any | null;
  data: DomainSnapshot;
  onClose: () => void;
  occurrence?: OccurrenceTarget;
}) {
  const { domain: repo } = useServices();
  const [err, setErr] = useState<string | null>(null);
  const isNew = !record;
  const title = `${domain === 'tasks' ? '작업' : domain === 'events' ? '일정' : '프로젝트'} ${isNew ? '추가' : '편집'}`;

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const remove = () => {
    const id = occurrence ? occurrence.seriesId : record?.id;
    if (!id || !window.confirm('이 항목을 삭제할까요? (보기 설정이 아니라 실제 데이터가 삭제되며, 설정 > 휴지통에서 30일간 복구할 수 있습니다)')) return;
    void run(() => repo.softDelete(domain, id));
  };

  return (
    <Panel title={title} onClose={onClose}>
      {domain === 'tasks' && <TaskForm task={record} data={data} onSubmit={(v) => run(() => (record ? repo.updateTask(record.id, v) : repo.createTask(v as Task)))} />}
      {domain === 'events' && <EventEditor ev={record} occurrence={occurrence} data={data} onDone={(fn) => void run(fn)} />}
      {domain === 'projects' && <ProjectForm project={record} onSubmit={(v) => run(() => (record ? repo.updateProject(record.id, v) : repo.createProject(v as Project)))} />}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      {domain === 'tasks' && record && (
        <button type="button" className={`btn ${record.status === 'done' ? '' : 'quest-done'}`} onClick={() => void run(() => setTaskDone(repo, record, record.status !== 'done'))}>
          {record.status === 'done' ? '다시 열기' : `완료하기 (+${taskXp(record)} EXP)`}
        </button>
      )}
      {record && (
        <button type="button" className="btn danger" onClick={remove}>
          {domain === 'events' && occurrence ? '반복 일정 전체 삭제' : '삭제'}
        </button>
      )}
    </Panel>
  );
}

function RefSelect({ label, value, items, onChange }: { label: string; value: string | null; items: { id: string; name: string }[]; onChange: (v: string | null) => void }) {
  return (
    <label>
      {label}
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">(없음)</option>
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function TaskForm({ task, data, onSubmit }: { task: Task | null; data: DomainSnapshot; onSubmit: (v: Partial<Task>) => void }) {
  const [v, setV] = useState<Partial<Task>>(
    task ?? { title: '', description: '', status: 'todo', priority: 'medium', due_date: null, project_id: null, category_id: null },
  );
  const up = (p: Partial<Task>) => setV((x) => ({ ...x, ...p }));
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ title: v.title, description: v.description, status: v.status, priority: v.priority, due_date: v.due_date, project_id: v.project_id, category_id: v.category_id });
      }}
    >
      <label>
        제목
        <input required autoFocus value={v.title ?? ''} onChange={(e) => up({ title: e.target.value })} />
      </label>
      <label>
        설명
        <textarea rows={3} value={v.description ?? ''} onChange={(e) => up({ description: e.target.value })} />
      </label>
      <div className="form-row">
        <label>
          상태
          <select value={v.status} onChange={(e) => up({ status: e.target.value as Task['status'] })}>
            {TASK_STATUS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          우선순위
          <select value={v.priority} onChange={(e) => up({ priority: e.target.value as Task['priority'] })}>
            {TASK_PRIORITY.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          마감일
          <input type="date" value={v.due_date ?? ''} onChange={(e) => up({ due_date: e.target.value || null })} />
        </label>
      </div>
      <div className="form-row">
        <RefSelect label="프로젝트" value={v.project_id ?? null} items={data.projects} onChange={(x) => up({ project_id: x })} />
        <RefSelect label="분류" value={v.category_id ?? null} items={data.categories} onChange={(x) => up({ category_id: x })} />
      </div>
      <button className="btn primary" type="submit">
        저장
      </button>
    </form>
  );
}

function RecurrenceFields({ value, onChange, startDate }: { value: string; onChange: (v: string) => void; startDate: string }) {
  const parsed = value ? parseRule(value) : null;
  const rule: Rule | null = parsed?.ok ? parsed.rule : null;
  const set = (r: Rule | null) => onChange(r ? formatRule(r) : '');
  const weekdayOfStart = WEEKDAYS[(new Date(startDate + 'T00:00:00Z').getUTCDay() + 6) % 7];
  const endType = rule?.count ? 'count' : rule?.until ? 'until' : 'never';
  return (
    <fieldset className="filter-group">
      <legend>반복</legend>
      <div className="form-row">
        <label>
          단위
          <select
            aria-label="반복 단위"
            value={rule?.freq ?? ''}
            onChange={(e) => set(e.target.value ? { freq: e.target.value as Freq, interval: rule?.interval ?? 1, count: rule?.count, until: rule?.until } : null)}
          >
            <option value="">반복 안 함</option>
            <option value="DAILY">매일</option>
            <option value="WEEKLY">매주</option>
            <option value="MONTHLY">매월 (같은 날짜)</option>
            <option value="YEARLY">매년</option>
          </select>
        </label>
        {rule && (
          <label>
            간격
            <input
              type="number"
              min={1}
              max={MAX_INTERVAL}
              value={rule.interval}
              aria-label="반복 간격"
              onChange={(e) => set({ ...rule, interval: Math.min(MAX_INTERVAL, Math.max(1, Number(e.target.value) || 1)) })}
            />
          </label>
        )}
      </div>
      {rule?.freq === 'WEEKLY' && (
        <div className="chips" role="group" aria-label="반복 요일">
          {WEEKDAYS.map((w, i) => {
            const days = rule.byday ?? [weekdayOfStart];
            const on = days.includes(w);
            return (
              <label key={w} className={`chip ${on ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => {
                    const next = e.target.checked ? [...days, w] : days.filter((x) => x !== w);
                    if (!next.includes(weekdayOfStart)) next.push(weekdayOfStart); // 시작일 요일은 항상 포함 (첫 회차)
                    set({ ...rule, byday: WEEKDAYS.filter((x) => next.includes(x)) });
                  }}
                />
                {'월화수목금토일'[i]}
              </label>
            );
          })}
        </div>
      )}
      {rule && (
        <div className="form-row">
          <label>
            종료
            <select
              aria-label="반복 종료"
              value={endType}
              onChange={(e) => {
                const t = e.target.value;
                set({ ...rule, count: t === 'count' ? 10 : undefined, until: t === 'until' ? addDays(startDate, 30) : undefined });
              }}
            >
              <option value="never">계속</option>
              <option value="count">횟수</option>
              <option value="until">날짜까지</option>
            </select>
          </label>
          {endType === 'count' && (
            <label>
              횟수
              <input type="number" min={1} max={MAX_COUNT} aria-label="반복 횟수" value={rule.count} onChange={(e) => set({ ...rule, count: Math.min(MAX_COUNT, Math.max(1, Number(e.target.value) || 1)) })} />
            </label>
          )}
          {endType === 'until' && (
            <label>
              마지막 날
              <input type="date" aria-label="반복 마지막 날" min={startDate} value={rule.until} onChange={(e) => e.target.value && set({ ...rule, until: e.target.value })} />
            </label>
          )}
        </div>
      )}
      {rule && <small className="muted">{describeRule(value)}</small>}
    </fieldset>
  );
}

export interface OccurrenceTarget {
  seriesId: string;
  originalStart: string;
  start_at: string;
  end_at: string;
  is_exception: boolean;
}

type Scope = 'one' | 'following' | 'all';
const SCOPES: { key: Scope; label: string; hint: string }[] = [
  { key: 'one', label: '이 회차만', hint: '선택한 날짜 하나만 바뀝니다.' },
  { key: 'following', label: '이 회차와 이후 모두', hint: '이전 회차는 그대로 두고, 이 날짜부터 새 반복으로 나눕니다. 이후 회차별 수정은 옮겨집니다.' },
  { key: 'all', label: '전체 반복', hint: '첫 회차부터 모두 바뀝니다. 시간·규칙을 바꾸면 같은 날짜의 회차별 수정은 옮겨지고, 옮길 날짜가 없는 것은 삭제 전에 확인합니다.' },
];

/** 일정 편집. occurrence 가 있으면 반복 일정의 한 회차를 연 것: 수정 범위를 고른다. */
function EventEditor({ ev, occurrence, data, onDone }: { ev: CalendarEvent | null; occurrence?: OccurrenceTarget; data: DomainSnapshot; onDone: (fn: () => Promise<unknown>) => void }) {
  const { domain: repo } = useServices();
  const [scope, setScope] = useState<Scope>(occurrence ? 'one' : 'all');
  const series = ev && occurrence ? data.events.find((e) => e.id === occurrence.seriesId) ?? ev : ev;
  const shown: CalendarEvent | null =
    ev && occurrence && scope === 'one'
      ? { ...ev, start_at: occurrence.start_at, end_at: occurrence.end_at, recurrence_rule: null }
      : series && occurrence && scope === 'following'
        ? {
            ...series,
            start_at: occurrence.originalStart,
            end_at: new Date(Date.parse(occurrence.originalStart) + Date.parse(series.end_at) - Date.parse(series.start_at)).toISOString(),
            recurrence_rule: followingRule(series, occurrence.originalStart),
          }
        : series;
  return (
    <>
      {occurrence && (
        <fieldset className="filter-group">
          <legend>수정 범위</legend>
          <div className="chips" role="radiogroup" aria-label="수정 범위">
            {SCOPES.map((s) => (
              <label key={s.key} className={`chip ${scope === s.key ? 'on' : ''}`}>
                <input type="radio" name="scope" checked={scope === s.key} onChange={() => setScope(s.key)} />
                {s.label}
              </label>
            ))}
          </div>
          <small className="muted">{SCOPES.find((s) => s.key === scope)!.hint}</small>
        </fieldset>
      )}
      <EventForm
        key={scope}
        ev={shown}
        data={data}
        hideRecurrence={!!occurrence && scope === 'one'}
        onSubmit={async (v) => {
          if (occurrence && scope === 'one') {
            const { recurrence_rule, ...rest } = v;
            void recurrence_rule;
            onDone(() => repo.updateOccurrence(occurrence.seriesId, occurrence.originalStart, rest));
          } else if (occurrence && scope === 'following' && series) {
            onDone(() => repo.updateFollowing(series.id, occurrence.originalStart, v));
          } else if (series) {
            if (series.recurrence_rule) {
              const p = await repo.previewSeriesChange(series.id, v);
              if (p.removed > 0 && !window.confirm(`회차별 수정·취소 ${p.kept + p.removed}개 중 ${p.removed}개는 새 반복에 같은 날짜가 없어 삭제됩니다 (${p.kept}개는 옮겨 보존). 계속할까요?`)) return;
            }
            onDone(() => repo.updateEvent(series.id, v));
          } else onDone(() => repo.createEvent(v as CalendarEvent));
        }}
      />
      {occurrence && scope === 'one' && (
        <div className="row-actions">
          <button type="button" className="btn danger" onClick={() => window.confirm('이 회차만 취소할까요?') && onDone(() => repo.cancelOccurrence(occurrence.seriesId, occurrence.originalStart))}>
            이 회차 취소
          </button>
          {occurrence.is_exception && (
            <button type="button" className="btn" onClick={() => onDone(() => repo.resetOccurrence(occurrence.seriesId, occurrence.originalStart))}>
              이 회차를 원래대로
            </button>
          )}
        </div>
      )}
    </>
  );
}

function EventForm({ ev, data, onSubmit, hideRecurrence }: { ev: CalendarEvent | null; data: DomainSnapshot; onSubmit: (v: Partial<CalendarEvent>) => void; hideRecurrence?: boolean }) {
  const tz0 = ev?.timezone ?? localTimeZone();
  const now = new Date();
  now.setMinutes(0, 0, 0);
  now.setHours(now.getHours() + 1);
  const startIso = ev?.start_at ?? now.toISOString();
  const endIso = ev?.end_at ?? new Date(now.getTime() + 3600000).toISOString();
  const [title, setTitle] = useState(ev?.title ?? '');
  const [description, setDescription] = useState(ev?.description ?? '');
  const [tz, setTz] = useState(tz0);
  const [allDay, setAllDay] = useState(ev?.all_day ?? false);
  const [start, setStart] = useState(isoToZonedLocal(startIso, tz0));
  const [end, setEnd] = useState(ev?.all_day ? isoToZonedLocal(new Date(Date.parse(endIso) - 1).toISOString(), tz0) : isoToZonedLocal(endIso, tz0));
  const [rec, setRec] = useState(ev?.recurrence_rule ?? '');
  const [projectId, setProjectId] = useState<string | null>(ev?.project_id ?? null);
  const [categoryId, setCategoryId] = useState<string | null>(ev?.category_id ?? null);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        const s = allDay ? zonedLocalToIso(start.slice(0, 10) + 'T00:00', tz) : zonedLocalToIso(start, tz);
        const en = allDay ? zonedLocalToIso(addDays(end.slice(0, 10), 1) + 'T00:00', tz) : zonedLocalToIso(end, tz);
        onSubmit({ title, description, start_at: s, end_at: en, all_day: allDay, timezone: tz, recurrence_rule: rec || null, project_id: projectId, category_id: categoryId });
      }}
    >
      <label>
        제목
        <input required autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        설명
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="inline">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> 종일
      </label>
      <div className="form-row">
        <label>
          시작
          {allDay ? (
            <input type="date" value={start.slice(0, 10)} onChange={(e) => setStart(e.target.value + 'T00:00')} />
          ) : (
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          )}
        </label>
        <label>
          종료
          {allDay ? (
            <input type="date" value={end.slice(0, 10)} onChange={(e) => setEnd(e.target.value + 'T00:00')} />
          ) : (
            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          )}
        </label>
      </div>
      <div className="form-row">
        <label>
          시간대
          <select value={tz} onChange={(e) => setTz(e.target.value)}>
            {TIMEZONES.map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </label>
      </div>
      {!hideRecurrence && <RecurrenceFields value={rec} onChange={setRec} startDate={start.slice(0, 10)} />}
      <div className="form-row">
        <RefSelect label="프로젝트" value={projectId} items={data.projects} onChange={setProjectId} />
        <RefSelect label="분류" value={categoryId} items={data.categories} onChange={setCategoryId} />
      </div>
      <button className="btn primary" type="submit">
        저장
      </button>
    </form>
  );
}

function ProjectForm({ project, onSubmit }: { project: Project | null; onSubmit: (v: Partial<Project>) => void }) {
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [status, setStatus] = useState<Project['status']>(project?.status ?? 'active');
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name, description, status });
      }}
    >
      <label>
        이름
        <input required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        설명
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        상태
        <select value={status} onChange={(e) => setStatus(e.target.value as Project['status'])}>
          {PROJECT_STATUS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <button className="btn primary" type="submit">
        저장
      </button>
    </form>
  );
}
