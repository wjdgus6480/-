import { useEffect, useRef, type ReactNode } from 'react';
import type { DomainSnapshot } from '../domain/types';
import { addDays, localTimeZone } from '../lib/util';
import { findStaleReferences } from '../views/engine';
import { FIELD_REGISTRY, getField, MAX_SORTS, MAX_WIDTH, MIN_WIDTH, NONE_VALUE } from '../views/fields';
import type { ColumnConfig, FilterCondition, FilterConfig, SortRule, ViewDomain } from '../views/types';

export function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // 열 때 패널로 포커스, 닫을 때 원래 위치로 돌려준다. Tab 은 패널 안에서만 순환.
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return closeRef.current();
      if (e.key !== 'Tab' || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
      if (!items.length) return;
      const [first, last] = [items[0], items[items.length - 1]];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    // iOS: 키보드가 열려도 레이아웃 높이는 그대로라 바텀시트가 가려진다 → 키보드 높이만큼 올리고 입력칸을 보이게
    const vv = window.visualViewport;
    const onViewport = () => {
      if (!vv || !ref.current) return;
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      ref.current.style.setProperty('--kb', `${kb}px`);
      const el = document.activeElement as HTMLElement | null;
      if (kb > 0 && el && ref.current.contains(el) && el.matches('input, select, textarea')) el.scrollIntoView({ block: 'nearest' });
    };
    vv?.addEventListener('resize', onViewport);
    vv?.addEventListener('scroll', onViewport);
    return () => {
      vv?.removeEventListener('resize', onViewport);
      vv?.removeEventListener('scroll', onViewport);
      window.removeEventListener('keydown', onKey);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);
  return (
    <>
      <div className="panel-backdrop" onClick={onClose} />
      <div className="panel" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <div className="panel-head">
          <strong>{title}</strong>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        <div className="panel-body">{children}</div>
      </div>
    </>
  );
}

// ---------------- 컬럼 ----------------

export function ColumnMenu({ domain, columns, onChange }: { domain: ViewDomain; columns: ColumnConfig[]; onChange: (c: ColumnConfig[]) => void }) {
  const sorted = [...columns].sort((a, b) => a.position - b.position);
  const update = (field: string, patch: Partial<ColumnConfig>) => onChange(columns.map((c) => (c.field === field ? { ...c, ...patch } : c)));
  const move = (idx: number, delta: number) => {
    const j = idx + delta;
    if (j < 0 || j >= sorted.length) return;
    const next = [...sorted];
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next.map((c, i) => ({ ...c, position: i })));
  };
  return (
    <ul className="col-list">
      {sorted.map((c, i) => {
        const def = getField(domain, c.field)!;
        return (
          <li key={c.field} className="col-item">
            <label className="col-vis">
              <input
                type="checkbox"
                checked={c.visible}
                disabled={def.identity}
                onChange={(e) => update(c.field, { visible: e.target.checked })}
                aria-label={`${def.label} 표시`}
              />
              <span>{def.label}</span>
              {def.identity && <small className="muted"> (필수)</small>}
            </label>
            <span className="col-actions">
              <button type="button" className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`${def.label} 위로`}>
                ▲
              </button>
              <button type="button" className="icon-btn" onClick={() => move(i, 1)} disabled={i === sorted.length - 1} aria-label={`${def.label} 아래로`}>
                ▼
              </button>
              <button
                type="button"
                className={`icon-btn ${c.pinned ? 'on' : ''}`}
                onClick={() => update(c.field, { pinned: !c.pinned })}
                aria-pressed={c.pinned}
                aria-label={`${def.label} 고정`}
                title="왼쪽 고정"
              >
                📌
              </button>
              <input
                type="number"
                className="width-input"
                min={MIN_WIDTH}
                max={MAX_WIDTH}
                step={10}
                defaultValue={c.width}
                key={c.width}
                aria-label={`${def.label} 너비`}
                onBlur={(e) => {
                  const w = Number(e.target.value);
                  if (Number.isFinite(w) && w >= MIN_WIDTH && w <= MAX_WIDTH && w !== c.width) update(c.field, { width: Math.round(w) });
                  else e.target.value = String(c.width);
                }}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------- 정렬 ----------------

export function SortMenu({ domain, sort, onChange }: { domain: ViewDomain; sort: SortRule[]; onChange: (s: SortRule[]) => void }) {
  const sortable = FIELD_REGISTRY[domain].filter((f) => f.sortable);
  const unused = sortable.filter((f) => !sort.some((s) => s.field === f.key));
  return (
    <div className="sort-menu">
      {sort.length === 0 && <p className="muted">정렬 없음 (입력 순서)</p>}
      {sort.map((s, i) => (
        <div className="sort-row" key={s.field}>
          <span className="muted">{i + 1}</span>
          <select
            value={s.field}
            aria-label={`정렬 ${i + 1} 필드`}
            onChange={(e) => onChange(sort.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}
          >
            {sortable
              .filter((f) => f.key === s.field || !sort.some((x) => x.field === f.key))
              .map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
          </select>
          <select value={s.dir} aria-label={`정렬 ${i + 1} 방향`} onChange={(e) => onChange(sort.map((x, j) => (j === i ? { ...x, dir: e.target.value as 'asc' | 'desc' } : x)))}>
            <option value="asc">오름차순</option>
            <option value="desc">내림차순</option>
          </select>
          <button type="button" className="icon-btn" aria-label={`정렬 ${i + 1} 위로`} disabled={i === 0} onClick={() => {
            const n = [...sort];
            [n[i - 1], n[i]] = [n[i], n[i - 1]];
            onChange(n);
          }}>
            ▲
          </button>
          <button type="button" className="icon-btn" aria-label={`정렬 ${i + 1} 삭제`} onClick={() => onChange(sort.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      {sort.length < MAX_SORTS && unused.length > 0 && (
        <button type="button" className="btn" onClick={() => onChange([...sort, { field: unused[0].key, dir: 'asc' }])}>
          + 정렬 추가
        </button>
      )}
    </div>
  );
}

// ---------------- 필터 ----------------

export function countFilters(f: FilterConfig): number {
  return f.conditions.filter((c) => (c.type === 'in' ? c.values.length > 0 : c.type === 'dateRange' ? c.from || c.to : true)).length;
}

export function FilterMenu({
  domain,
  filter,
  data,
  onChange,
  onCleanStale,
}: {
  domain: ViewDomain;
  filter: FilterConfig;
  data: DomainSnapshot;
  onChange: (f: FilterConfig) => void;
  onCleanStale: () => void;
}) {
  const fields = FIELD_REGISTRY[domain].filter((f) => f.filter);
  const stale = findStaleReferences(domain, filter, data);
  const get = (field: string) => filter.conditions.find((c) => c.field === field);
  const set = (field: string, cond: FilterCondition | null) => {
    const rest = filter.conditions.filter((c) => c.field !== field);
    onChange({ ...filter, conditions: cond ? [...rest, cond] : rest });
  };
  const today = new Date().toLocaleDateString('en-CA');
  const weekStart = addDays(today, -((new Date().getDay() + 6) % 7));

  return (
    <div className="filter-menu">
      {stale.length > 0 && (
        <div className="warn" role="alert">
          삭제된 프로젝트·분류를 참조하는 조건이 {stale.length}개 있습니다.{' '}
          <button type="button" className="btn small" onClick={onCleanStale}>
            조건 정리
          </button>
        </div>
      )}
      {fields.map((def) => {
        const cond = get(def.key);
        if (def.filter === 'in') {
          const options =
            def.options ??
            [
              ...(def.refTarget === 'projects' ? data.projects : data.categories).map((x) => ({ value: x.id, label: x.name })),
              { value: NONE_VALUE, label: '(없음)' },
            ];
          const values = cond?.type === 'in' ? cond.values : [];
          const staleVals = values.filter((v) => !options.some((o) => o.value === v));
          return (
            <fieldset key={def.key} className="filter-group">
              <legend>{def.label}</legend>
              <div className="chips">
                {options.map((o) => (
                  <label key={o.value} className={`chip ${values.includes(o.value) ? 'on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={values.includes(o.value)}
                      onChange={(e) => {
                        const next = e.target.checked ? [...values, o.value] : values.filter((v) => v !== o.value);
                        set(def.key, next.length ? { type: 'in', field: def.key, values: next } : null);
                      }}
                    />
                    {o.label}
                  </label>
                ))}
                {staleVals.map((v) => (
                  <span key={v} className="chip stale" title="삭제된 항목">
                    (삭제됨)
                  </span>
                ))}
              </div>
            </fieldset>
          );
        }
        if (def.filter === 'bool') {
          const v = cond?.type === 'bool' ? String(cond.value) : '';
          return (
            <fieldset key={def.key} className="filter-group">
              <legend>{def.label}</legend>
              <select value={v} aria-label={`${def.label} 필터`} onChange={(e) => set(def.key, e.target.value ? { type: 'bool', field: def.key, value: e.target.value === 'true' } : null)}>
                <option value="">전체</option>
                <option value="true">예</option>
                <option value="false">아니오</option>
              </select>
            </fieldset>
          );
        }
        const dr = cond?.type === 'dateRange' ? cond : null;
        const tz = def.kind === 'instant' ? dr?.tz ?? localTimeZone() : undefined;
        const setRange = (from: string | null, to: string | null) =>
          set(def.key, from || to ? { type: 'dateRange', field: def.key, from, to, ...(tz ? { tz } : {}) } : null);
        return (
          <fieldset key={def.key} className="filter-group">
            <legend>
              {def.label}
              {tz && <small className="muted"> · {tz} 기준 날짜</small>}
            </legend>
            <div className="date-range">
              <input type="date" value={dr?.from ?? ''} aria-label={`${def.label} 시작`} onChange={(e) => setRange(e.target.value || null, dr?.to ?? null)} />
              <span>~</span>
              <input type="date" value={dr?.to ?? ''} aria-label={`${def.label} 끝`} onChange={(e) => setRange(dr?.from ?? null, e.target.value || null)} />
            </div>
            <div className="quick">
              <button type="button" className="btn small" onClick={() => setRange(today, today)}>
                오늘
              </button>
              <button type="button" className="btn small" onClick={() => setRange(weekStart, addDays(weekStart, 6))}>
                이번 주
              </button>
              <button type="button" className="btn small" onClick={() => setRange(today, addDays(today, 30))}>
                30일 이내
              </button>
              {dr && (
                <button type="button" className="btn small ghost" onClick={() => setRange(null, null)}>
                  지우기
                </button>
              )}
            </div>
          </fieldset>
        );
      })}
      {countFilters(filter) > 0 && (
        <button type="button" className="btn ghost" onClick={() => onChange({ ...filter, conditions: [] })}>
          필터 모두 지우기
        </button>
      )}
    </div>
  );
}
