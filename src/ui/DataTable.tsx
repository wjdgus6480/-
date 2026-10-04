import { useRef, useState, type ReactNode } from 'react';
import { displayValue } from '../views/engine';
import { getField, MAX_WIDTH, MIN_WIDTH, type FieldContext } from '../views/fields';
import type { ColumnConfig, SortRule, ViewDomain } from '../views/types';

const LEAD_WIDTH = 44;

interface Props {
  domain: ViewDomain;
  columns: ColumnConfig[];
  rows: any[];
  ctx: FieldContext;
  tz: string;
  density: 'comfortable' | 'compact';
  sort: SortRule[];
  isMobile: boolean;
  onHeaderSort: (field: string) => void;
  onReorder: (field: string, beforeField: string) => void;
  onResize: (field: string, width: number) => void;
  onRowClick: (row: any) => void;
  lead?: (row: any) => ReactNode;
  emptyText: string;
}

/** 표시 순서: 고정 컬럼 → 나머지 (각각 position 순). 숨김 설정은 그대로 따른다. */
export function orderedVisible(columns: ColumnConfig[]): ColumnConfig[] {
  const vis = columns.filter((c) => c.visible).sort((a, b) => a.position - b.position);
  return [...vis.filter((c) => c.pinned), ...vis.filter((c) => !c.pinned)];
}

export function DataTable(p: Props) {
  const [drag, setDrag] = useState<string | null>(null);
  const [overField, setOverField] = useState<string | null>(null);
  const [liveWidth, setLiveWidth] = useState<Record<string, number>>({});
  const resizing = useRef<{ field: string; startX: number; startW: number } | null>(null);

  const cols = orderedVisible(p.columns);
  // 모바일에서는 화면 폭을 아끼기 위해 첫 고정 컬럼만 고정한다.
  const stickyFields = new Set(cols.filter((c) => c.pinned).slice(0, p.isMobile ? 1 : undefined).map((c) => c.field));
  const widthOf = (c: ColumnConfig) => liveWidth[c.field] ?? c.width;
  const leftOf: Record<string, number> = {};
  let acc = LEAD_WIDTH;
  for (const c of cols) {
    if (!stickyFields.has(c.field)) continue;
    leftOf[c.field] = acc;
    acc += widthOf(c);
  }
  const totalWidth = LEAD_WIDTH + cols.reduce((s, c) => s + widthOf(c), 0);

  // 컬럼 순서 변경: 포인터 이벤트로 구현 (마우스·펜 공용). 모바일은 터치 스크롤과 충돌하므로 컬럼 메뉴의 ▲▼ 를 사용한다.
  const reorderRef = useRef<{ field: string; startX: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);
  const fieldAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest('th[data-field]') as HTMLElement | null)?.dataset.field ?? null;
  const startReorder = (e: React.PointerEvent, field: string) => {
    if (p.isMobile || e.button !== 0 || (e.target as HTMLElement).closest('.resize-handle')) return;
    reorderRef.current = { field, startX: e.clientX, active: false };
  };
  const moveReorder = (e: React.PointerEvent) => {
    const r = reorderRef.current;
    if (!r) return;
    if (!r.active && Math.abs(e.clientX - r.startX) > 6) {
      r.active = true;
      setDrag(r.field);
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }
    if (r.active) setOverField(fieldAt(e.clientX, e.clientY));
  };
  const endReorder = (e: React.PointerEvent) => {
    const r = reorderRef.current;
    reorderRef.current = null;
    if (r?.active) {
      suppressClick.current = true;
      const target = fieldAt(e.clientX, e.clientY);
      if (target && target !== r.field) p.onReorder(r.field, target);
    }
    setDrag(null);
    setOverField(null);
  };
  const cancelReorder = () => {
    reorderRef.current = null;
    setDrag(null);
    setOverField(null);
  };

  const startResize =(e: React.PointerEvent, c: ColumnConfig) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    resizing.current = { field: c.field, startX: e.clientX, startW: c.width };
  };
  const moveResize = (e: React.PointerEvent) => {
    const r = resizing.current;
    if (!r) return;
    const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(r.startW + e.clientX - r.startX)));
    setLiveWidth((m) => ({ ...m, [r.field]: w }));
  };
  const endResize = () => {
    const r = resizing.current;
    resizing.current = null;
    if (!r) return;
    const w = liveWidth[r.field];
    if (w && w !== r.startW) p.onResize(r.field, w);
    setLiveWidth((m) => {
      const { [r.field]: _, ...rest } = m;
      void _;
      return rest;
    });
  };

  return (
    <div className={`table-scroll density-${p.density}`} role="region" aria-label="테이블" tabIndex={0}>
      <table className="data-table" style={{ width: totalWidth }}>
        <colgroup>
          <col style={{ width: LEAD_WIDTH }} />
          {cols.map((c) => (
            <col key={c.field} style={{ width: widthOf(c) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="lead sticky" style={{ left: 0 }} aria-label="동작" />
            {cols.map((c) => {
              const def = getField(p.domain, c.field)!;
              const si = p.sort.findIndex((s) => s.field === c.field);
              const sticky = stickyFields.has(c.field);
              return (
                <th
                  key={c.field}
                  data-field={c.field}
                  className={`${sticky ? 'sticky' : ''} ${overField === c.field && drag && drag !== c.field ? 'drop-target' : ''}`}
                  style={sticky ? { left: leftOf[c.field] } : undefined}
                  data-reorderable={!p.isMobile}
                  onPointerDown={(e) => startReorder(e, c.field)}
                  onPointerMove={moveReorder}
                  onPointerUp={endReorder}
                  onPointerCancel={cancelReorder}
                  onClickCapture={(e) => {
                    // 끌어서 옮긴 직후의 클릭은 정렬로 처리하지 않는다.
                    if (suppressClick.current) {
                      e.stopPropagation();
                      suppressClick.current = false;
                    }
                  }}
                  aria-sort={si === 0 ? (p.sort[0].dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  <button
                    type="button"
                    className="th-btn"
                    disabled={!def.sortable}
                    onClick={() => def.sortable && p.onHeaderSort(c.field)}
                    aria-label={def.sortable ? `${def.label} 기준 정렬` : def.label}
                  >
                    <span className="th-label">{def.label}</span>
                    {si >= 0 && (
                      <span className="sort-ind">
                        {p.sort[si].dir === 'asc' ? '▲' : '▼'}
                        {p.sort.length > 1 ? si + 1 : ''}
                      </span>
                    )}
                  </button>
                  <span
                    className="resize-handle"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`${def.label} 너비 조절`}
                    onPointerDown={(e) => startResize(e, c)}
                    onPointerMove={moveResize}
                    onPointerUp={endResize}
                    onPointerCancel={endResize}
                    onDragStart={(e) => e.preventDefault()}
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {p.rows.length === 0 && (
            <tr>
              <td className="empty" colSpan={cols.length + 1}>
                <div className="empty-msg">{p.emptyText}</div>
              </td>
            </tr>
          )}
          {p.rows.map((r) => (
            <tr key={r.id} onClick={() => p.onRowClick(r)} className="row">
              <td className="lead sticky" style={{ left: 0 }} onClick={(e) => e.stopPropagation()}>
                {p.lead?.(r)}
              </td>
              {cols.map((c) => {
                const def = getField(p.domain, c.field)!;
                const sticky = stickyFields.has(c.field);
                return (
                  <td key={c.field} className={`${sticky ? 'sticky' : ''} kind-${def.kind}`} style={sticky ? { left: leftOf[c.field] } : undefined} data-field={c.field}>
                    <Cell def={def} text={displayValue(p.domain, def, r, p.ctx, p.tz)} raw={def.get(r, p.ctx)} ctx={p.ctx} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ def, text, raw, ctx }: { def: ReturnType<typeof getField> & {}; text: string; raw: unknown; ctx: FieldContext }) {
  if (def.kind === 'enum' && text) return <span className={`badge badge-${def.key}-${String(raw)}`}>{text}</span>;
  if (def.kind === 'ref' && def.refTarget === 'categories' && typeof raw === 'string') {
    const color = ctx.categories.get(raw)?.color;
    return (
      <span className="cat">
        {color && <i className="dot" style={{ background: color }} />}
        {text}
      </span>
    );
  }
  return <>{text}</>;
}
