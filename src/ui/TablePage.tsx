import { useEffect, useMemo, useState } from 'react';
import { prefs, useDomainData, useIsMobile, useServices, useViews } from '../app/context';
import type { Task } from '../domain/types';
import { localTimeZone } from '../lib/util';
import { applySortAndFilterPure, removeStaleReferences } from '../views/engine';
import { buildContext, DOMAIN_LABEL } from '../views/fields';
import type { ColumnConfig, FilterConfig, SortRule, ViewDomain, ViewPreference } from '../views/types';
import { DataTable } from './DataTable';
import { OccurrenceList } from './OccurrenceList';
import { RecordEditor } from './RecordEditor';
import { ColumnMenu, countFilters, FilterMenu, Panel, SortMenu } from './ViewMenus';

type PanelKind = 'columns' | 'sort' | 'filter' | 'view' | null;

export function TablePage({ domain }: { domain: ViewDomain }) {
  const s = useServices();
  const data = useDomainData();
  const { list, error } = useViews(domain);
  const isMobile = useIsMobile();
  const prefKey = `dotday.lastView.${domain}`;
  const [viewId, setViewId] = useState<string | null>(() => prefs.get(prefKey));
  const [panel, setPanel] = useState<PanelKind>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<any | null | undefined>(undefined); // undefined=닫힘, null=새로 만들기

  const view: ViewPreference | undefined = list.find((v) => v.id === viewId) ?? list[0];
  const [search, setSearch] = useState('');
  useEffect(() => setSearch(view?.filter_config.search ?? ''), [view?.id, view?.filter_config.search]);

  const ctx = useMemo(() => buildContext(data), [data]);
  const rows = useMemo(() => (view ? applySortAndFilterPure(domain, data, { sort_config: view.sort_config, filter_config: { ...view.filter_config, search } }, ctx) : []), [domain, data, view, search, ctx]);
  const total = domain === 'tasks' ? data.tasks.length : domain === 'events' ? data.events.length : data.projects.length;

  const save = async (patch: Parameters<typeof s.views.updateView>[1]) => {
    if (!view) return;
    const r = await s.views.updateView(view.id, patch);
    setMsg(r.ok ? null : `${r.error.message}${r.error.issues ? ' — ' + r.error.issues.map((i) => i.message).join(', ') : ''}`);
  };

  // 검색어는 입력 즉시 반영하고 저장은 잠시 뒤에 한다.
  useEffect(() => {
    if (!view || search === view.filter_config.search) return;
    const t = setTimeout(() => void save({ filter_config: { ...view.filter_config, search } }), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  if (error) return <p className="error">{error}</p>;
  if (!view) return <p className="muted">불러오는 중…</p>;

  const selectView = (id: string) => {
    setViewId(id);
    prefs.set(prefKey, id);
  };
  const setColumns = (c: ColumnConfig[]) => save({ column_config: c });
  const setSort = (x: SortRule[]) => save({ sort_config: x });
  const setFilter = (f: FilterConfig) => save({ filter_config: { ...f, search } });

  const headerSort = (field: string) => {
    const cur = view.sort_config[0];
    if (cur?.field === field) setSort(cur.dir === 'asc' ? [{ field, dir: 'desc' }] : []);
    else setSort([{ field, dir: 'asc' }]);
  };
  const reorder = (field: string, before: string) => {
    const sorted = [...view.column_config].sort((a, b) => a.position - b.position);
    const moving = sorted.find((c) => c.field === field)!;
    const rest = sorted.filter((c) => c.field !== field);
    const idx = rest.findIndex((c) => c.field === before);
    rest.splice(idx, 0, moving);
    setColumns(rest.map((c, i) => ({ ...c, position: i })));
  };
  const resize = (field: string, width: number) => setColumns(view.column_config.map((c) => (c.field === field ? { ...c, width } : c)));

  const viewAction = async (kind: 'new' | 'duplicate' | 'rename' | 'default' | 'reset' | 'delete') => {
    let r;
    if (kind === 'new') {
      const name = window.prompt('새 보기 이름', '새 보기');
      if (!name) return;
      r = await s.views.createView({ domain, name });
    } else if (kind === 'duplicate') r = await s.views.duplicateView(view.id);
    else if (kind === 'rename') {
      const name = window.prompt('보기 이름', view.name);
      if (!name || name === view.name) return;
      r = await s.views.updateView(view.id, { name });
    } else if (kind === 'default') r = await s.views.setDefaultView(view.id);
    else if (kind === 'reset') {
      if (!window.confirm(`'${view.name}'의 컬럼·정렬·필터를 기본값으로 되돌릴까요?\n업무 데이터는 바뀌지 않습니다.`)) return;
      r = await s.views.resetView(view.id);
    } else {
      if (!window.confirm(`'${view.name}' 보기를 삭제할까요?\n설정 화면에서 30일 동안 복구할 수 있으며, 업무 데이터는 삭제되지 않습니다.`)) return;
      r = await s.views.deleteView(view.id);
    }
    if (!r.ok) setMsg(r.error.message);
    else {
      setMsg(null);
      if (kind === 'new' || kind === 'duplicate') selectView(r.value.id);
      if (kind === 'delete') selectView('');
      setPanel(null);
    }
  };

  const nFilters = countFilters(view.filter_config);
  const hiddenCount = view.column_config.filter((c) => !c.visible).length;

  return (
    <section className="table-page">
      {domain === 'events' && <OccurrenceList data={data} />}
      <div className="toolbar">
        <div className="view-switch">
          <select value={view.id} onChange={(e) => selectView(e.target.value)} aria-label="보기 선택">
            {list.map((v) => (
              <option key={v.id} value={v.id}>
                {v.is_default ? '★ ' : ''}
                {v.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn" onClick={() => setPanel('view')} aria-label="보기 관리">
            ⋯
          </button>
        </div>
        <input className="search" type="search" placeholder="검색 (제목·설명)" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="검색" maxLength={200} />
        <div className="tool-buttons">
          <button type="button" className={`btn ${view.sort_config.length ? 'active' : ''}`} onClick={() => setPanel('sort')}>
            정렬{view.sort_config.length ? ` ${view.sort_config.length}` : ''}
          </button>
          <button type="button" className={`btn ${nFilters ? 'active' : ''}`} onClick={() => setPanel('filter')}>
            필터{nFilters ? ` ${nFilters}` : ''}
          </button>
          <button type="button" className="btn" onClick={() => setPanel('columns')}>
            컬럼{hiddenCount ? ` (${hiddenCount} 숨김)` : ''}
          </button>
          <button type="button" className="btn primary" onClick={() => setEditing(null)}>
            + 추가
          </button>
        </div>
      </div>
      {msg && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
      <p className="count muted">
        {DOMAIN_LABEL[domain]} {rows.length} / {total}건{rows.length < total ? ' (나머지는 이 보기의 필터로 숨겨짐)' : ''}
      </p>

      <DataTable
        domain={domain}
        columns={view.column_config}
        rows={rows}
        ctx={ctx}
        tz={view.layout_config.timezone ?? localTimeZone()}
        density={view.layout_config.density}
        sort={view.sort_config}
        isMobile={isMobile}
        onHeaderSort={headerSort}
        onReorder={reorder}
        onResize={resize}
        onRowClick={(r) => setEditing(r)}
        emptyText={total === 0 ? '아직 항목이 없습니다. + 추가 를 눌러 시작하세요.' : '조건에 맞는 항목이 없습니다.'}
        lead={
          domain === 'tasks'
            ? (r: Task) => (
                <input
                  type="checkbox"
                  checked={r.status === 'done'}
                  aria-label={`${r.title} 완료`}
                  onChange={(e) => void s.domain.updateTask(r.id, { status: e.target.checked ? 'done' : 'todo' })}
                />
              )
            : undefined
        }
      />

      {panel === 'columns' && (
        <Panel title="컬럼 설정" onClose={() => setPanel(null)}>
          <p className="muted small">체크로 표시/숨김, ▲▼로 순서, 📌로 왼쪽 고정, 숫자로 너비(px). 데스크톱에서는 머리글을 끌어 순서를, 오른쪽 끝을 끌어 너비를 바꿀 수 있습니다.</p>
          <ColumnMenu domain={domain} columns={view.column_config} onChange={setColumns} />
        </Panel>
      )}
      {panel === 'sort' && (
        <Panel title="정렬" onClose={() => setPanel(null)}>
          <SortMenu domain={domain} sort={view.sort_config} onChange={setSort} />
        </Panel>
      )}
      {panel === 'filter' && (
        <Panel title="필터" onClose={() => setPanel(null)}>
          <FilterMenu
            domain={domain}
            filter={view.filter_config}
            data={data}
            onChange={setFilter}
            onCleanStale={() => setFilter(removeStaleReferences(domain, view.filter_config, data))}
          />
        </Panel>
      )}
      {panel === 'view' && (
        <Panel title={`보기: ${view.name}`} onClose={() => setPanel(null)}>
          <div className="menu-list">
            <button type="button" className="btn" onClick={() => viewAction('new')}>
              새 보기
            </button>
            <button type="button" className="btn" onClick={() => viewAction('duplicate')}>
              복제
            </button>
            <button type="button" className="btn" onClick={() => viewAction('rename')}>
              이름 변경
            </button>
            <button type="button" className="btn" disabled={view.is_default} onClick={() => viewAction('default')}>
              {view.is_default ? '기본 보기입니다' : '기본 보기로 지정'}
            </button>
            <button type="button" className="btn" onClick={() => viewAction('reset')}>
              기본 설정으로 복원
            </button>
            <label className="inline">
              <input
                type="checkbox"
                checked={view.layout_config.density === 'compact'}
                onChange={(e) => save({ layout_config: { ...view.layout_config, density: e.target.checked ? 'compact' : 'comfortable' } })}
              />
              촘촘하게 보기
            </label>
            <button type="button" className="btn danger" onClick={() => viewAction('delete')}>
              보기 삭제
            </button>
          </div>
          <p className="muted small">보기 설정은 자동 저장됩니다. 업무 데이터와 별도로 보관됩니다.</p>
        </Panel>
      )}
      {editing !== undefined && <RecordEditor domain={domain} record={editing} data={data} onClose={() => setEditing(undefined)} />}
    </section>
  );
}
