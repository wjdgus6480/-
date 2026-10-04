import { beforeEach, describe, expect, it } from 'vitest';
import { applySortAndFilterPure, findStaleReferences, removeStaleReferences } from '../src/views/engine';
import { FIELD_REGISTRY } from '../src/views/fields';
import { defaultViewConfig, validateViewConfig } from '../src/views/validate';
import type { ViewPreference } from '../src/views/types';
import { domainDump, makeDevice, type Device } from './helpers';

let d: Device;
beforeEach(async () => {
  d = await makeDevice();
});

async function defaultView(domain: 'tasks' | 'events' | 'projects' = 'tasks'): Promise<ViewPreference> {
  const r = await d.views.listViews(domain);
  if (!r.ok) throw new Error(r.error.message);
  return r.value[0];
}

async function seedTasks() {
  const p1 = await d.domain.createProject({ name: '알파' });
  const p2 = await d.domain.createProject({ name: '베타' });
  const c1 = await d.domain.createCategory({ name: '업무' });
  await d.domain.createTask({ title: '보고서', priority: 'high', due_date: '2026-10-05', project_id: p1.id, category_id: c1.id });
  await d.domain.createTask({ title: '회의 준비', priority: 'urgent', due_date: '2026-10-03', project_id: p2.id });
  await d.domain.createTask({ title: '메일 정리', priority: 'low', due_date: null });
  await d.domain.createTask({ title: '디자인 보고', priority: 'high', due_date: '2026-10-03', project_id: p1.id, status: 'done' });
  await d.domain.createTask({ title: '코드 리뷰', priority: 'medium', due_date: '2026-10-10', status: 'in_progress', description: '보고서 관련' });
  return { p1, p2, c1 };
}

describe('VIEW-001 기본 보기 로드', () => {
  it('도메인별 기본 보기를 생성하고 다시 불러와도 같은 ID 를 유지한다', async () => {
    for (const domain of ['tasks', 'events', 'projects'] as const) {
      const v = await defaultView(domain);
      expect(v.name).toBe('기본 보기');
      expect(v.is_default).toBe(true);
      expect(v.view_key).toBe(domain);
      expect(v.owner_id).toBeNull();
      expect(v.column_config.map((c) => c.field)).toEqual(FIELD_REGISTRY[domain].map((f) => f.key));
      const again = await defaultView(domain);
      expect(again.id).toBe(v.id);
    }
    expect((await d.db.getAll('view_preferences')).length).toBe(3);
  });

  it('동시에 여러 번 불러와도 기본 보기를 하나만 만든다 (브라우저 검증 중 발견한 회귀)', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => d.views.listViews('tasks')));
    const ids = new Set(results.map((r) => (r.ok ? r.value[0].id : 'err')));
    expect(ids.size).toBe(1);
    expect((await d.db.getAll('view_preferences')).filter((v) => v.view_key === 'tasks')).toHaveLength(1);
    expect(await d.db.getAll('view_outbox')).toHaveLength(1);
  });

  it('허용되지 않은 도메인을 거부한다', async () => {
    const r = await d.views.listViews('notes' as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNKNOWN_DOMAIN');
  });
});

describe('VIEW-002 컬럼 표시 및 숨기기', () => {
  it('컬럼을 숨기고 표시한 상태가 저장된다', async () => {
    const v = await defaultView();
    const cols = v.column_config.map((c) => (c.field === 'priority' ? { ...c, visible: false } : c.field === 'description' ? { ...c, visible: true } : c));
    const r = await d.views.updateView(v.id, { column_config: cols });
    expect(r.ok).toBe(true);
    const loaded = await d.views.getView(v.id);
    expect(loaded.ok && loaded.value.column_config.find((c) => c.field === 'priority')!.visible).toBe(false);
    expect(loaded.ok && loaded.value.column_config.find((c) => c.field === 'description')!.visible).toBe(true);
  });

  it('식별 컬럼(제목)은 숨길 수 없다', async () => {
    const v = await defaultView();
    const r = await d.views.updateView(v.id, { column_config: v.column_config.map((c) => (c.field === 'title' ? { ...c, visible: false } : c)) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues![0].code).toBe('IDENTITY_COLUMN_HIDDEN');
  });
});

describe('VIEW-003 컬럼 순서 저장 및 복원', () => {
  it('순서를 변경하면 재실행(새 저장소 인스턴스) 후에도 유지된다', async () => {
    const v = await defaultView();
    const order = ['priority', 'title', 'due_date'];
    const cols = v.column_config.map((c) => {
      const i = order.indexOf(c.field);
      return { ...c, position: i >= 0 ? i : c.position + 10 };
    });
    expect((await d.views.updateView(v.id, { column_config: cols })).ok).toBe(true);
    // 재실행: 같은 DB 로 저장소를 새로 만든다
    const { ViewRepository } = await import('../src/views/repo');
    const repo2 = new ViewRepository(d.db, d.session, d.domain);
    const r = await repo2.getView(v.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sorted = [...r.value.column_config].sort((a, b) => a.position - b.position).map((c) => c.field);
    expect(sorted.slice(0, 3)).toEqual(order);
    expect(r.value.column_config.map((c) => c.position).sort((a, b) => a - b)).toEqual(r.value.column_config.map((_, i) => i));
  });
});

describe('VIEW-004 컬럼 너비 저장 및 복원', () => {
  it('너비가 저장되고 다시 읽힌다', async () => {
    const v = await defaultView();
    const cols = v.column_config.map((c) => (c.field === 'title' ? { ...c, width: 420 } : c));
    await d.views.updateView(v.id, { column_config: cols });
    const r = await d.views.getView(v.id);
    expect(r.ok && r.value.column_config.find((c) => c.field === 'title')!.width).toBe(420);
  });
});

describe('VIEW-005 단일 및 다중 정렬', () => {
  it('단일 정렬: 마감일 오름차순, 값 없음은 마지막', async () => {
    await seedTasks();
    const r = await d.views.applySortAndFilter<any>('tasks', { ...defaultViewConfig('tasks'), sort_config: [{ field: 'due_date', dir: 'asc' }] });
    expect(r.ok && r.value.map((t) => t.due_date)).toEqual(['2026-10-03', '2026-10-03', '2026-10-05', '2026-10-10', null]);
    const desc = await d.views.applySortAndFilter<any>('tasks', { ...defaultViewConfig('tasks'), sort_config: [{ field: 'due_date', dir: 'desc' }] });
    expect(desc.ok && desc.value.map((t) => t.due_date)).toEqual(['2026-10-10', '2026-10-05', '2026-10-03', '2026-10-03', null]);
  });

  it('다중 정렬: 마감일 오름차순 → 우선순위 내림차순(긴급>높음)', async () => {
    await seedTasks();
    const r = await d.views.applySortAndFilter<any>('tasks', {
      ...defaultViewConfig('tasks'),
      sort_config: [
        { field: 'due_date', dir: 'asc' },
        { field: 'priority', dir: 'desc' },
      ],
    });
    expect(r.ok && r.value.map((t) => t.title)).toEqual(['회의 준비', '디자인 보고', '보고서', '코드 리뷰', '메일 정리']);
  });

  it('프로젝트(참조) 정렬은 ID 가 아닌 이름 기준', async () => {
    await seedTasks();
    const r = await d.views.applySortAndFilter<any>('tasks', { ...defaultViewConfig('tasks'), sort_config: [{ field: 'project', dir: 'asc' }, { field: 'title', dir: 'asc' }] });
    // 한글 자모 순: 베타(ㅂ) < 알파(ㅇ), 프로젝트 없음은 마지막
    expect(r.ok && r.value.map((t) => t.title)).toEqual(['회의 준비', '디자인 보고', '보고서', '메일 정리', '코드 리뷰']);
  });

  it('잘못된 정렬 방향과 정렬 불가 필드를 거부한다', () => {
    const bad = validateViewConfig('tasks', { ...defaultViewConfig('tasks'), sort_config: [{ field: 'title', dir: 'up' }, { field: 'description', dir: 'asc' }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.issues!.map((i) => i.code).sort()).toEqual(['FIELD_NOT_SORTABLE', 'INVALID_SORT_DIRECTION']);
  });
});

describe('VIEW-006 상태 및 날짜 필터', () => {
  it('상태 필터', async () => {
    await seedTasks();
    const r = await d.views.applySortAndFilter<any>('tasks', {
      ...defaultViewConfig('tasks'),
      filter_config: { search: '', conditions: [{ type: 'in', field: 'status', values: ['todo', 'in_progress'] }] },
    });
    expect(r.ok && r.value.length).toBe(4);
    expect(r.ok && r.value.every((t) => t.status !== 'done')).toBe(true);
  });

  it('날짜 전용 필터는 양 끝을 포함한다', async () => {
    await seedTasks();
    const r = await d.views.applySortAndFilter<any>('tasks', {
      ...defaultViewConfig('tasks'),
      filter_config: { search: '', conditions: [{ type: 'dateRange', field: 'due_date', from: '2026-10-03', to: '2026-10-05' }] },
    });
    expect(r.ok && r.value.map((t) => t.title).sort()).toEqual(['디자인 보고', '보고서', '회의 준비']);
  });

  it('시각 필드는 지정 시간대의 날짜로 비교한다 (UTC 15:30 = 서울 다음날 00:30)', async () => {
    await d.domain.createEvent({ title: '심야', start_at: '2026-10-02T15:30:00.000Z', end_at: '2026-10-02T16:00:00.000Z', timezone: 'Asia/Seoul' });
    await d.domain.createEvent({ title: '낮', start_at: '2026-10-02T03:00:00.000Z', end_at: '2026-10-02T04:00:00.000Z', timezone: 'Asia/Seoul' });
    const seoul = await d.views.applySortAndFilter<any>('events', {
      ...defaultViewConfig('events'),
      filter_config: { search: '', conditions: [{ type: 'dateRange', field: 'start_at', from: '2026-10-03', to: '2026-10-03', tz: 'Asia/Seoul' }] },
    });
    expect(seoul.ok && seoul.value.map((e) => e.title)).toEqual(['심야']);
    const utc = await d.views.applySortAndFilter<any>('events', {
      ...defaultViewConfig('events'),
      filter_config: { search: '', conditions: [{ type: 'dateRange', field: 'start_at', from: '2026-10-02', to: '2026-10-02', tz: 'UTC' }] },
    });
    expect(utc.ok && utc.value.map((e) => e.title).sort()).toEqual(['낮', '심야']);
  });

  it('잘못된 날짜·범위·시간대를 거부한다', () => {
    const r = validateViewConfig('events', {
      ...defaultViewConfig('events'),
      filter_config: {
        search: '',
        conditions: [
          { type: 'dateRange', field: 'start_at', from: '2026-02-30', to: null },
          { type: 'dateRange', field: 'end_at', from: '2026-10-05', to: '2026-10-01' },
          { type: 'dateRange', field: 'updated_at', from: null, to: null, tz: 'Mars/Base' },
        ],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues!.map((i) => i.code)).toEqual(['INVALID_DATE', 'INVALID_DATE', 'INVALID_TIMEZONE']);
  });
});

describe('VIEW-007 검색과 필터 조합', () => {
  it('검색어(제목·설명) + 상태 + 프로젝트 필터 + 정렬 조합', async () => {
    const { p1 } = await seedTasks();
    const r = await d.views.applySortAndFilter<any>('tasks', {
      ...defaultViewConfig('tasks'),
      sort_config: [{ field: 'title', dir: 'asc' }],
      filter_config: { search: '보고', conditions: [{ type: 'in', field: 'status', values: ['todo', 'in_progress'] }] },
    });
    // '보고서'(제목), '코드 리뷰'(설명에 '보고서'), '디자인 보고'는 done 이라 제외
    expect(r.ok && r.value.map((t) => t.title)).toEqual(['보고서', '코드 리뷰']);
    const withProject = await d.views.applySortAndFilter<any>('tasks', {
      ...defaultViewConfig('tasks'),
      filter_config: { search: '보고', conditions: [{ type: 'in', field: 'project', values: [p1.id] }] },
    });
    expect(withProject.ok && withProject.value.map((t) => t.title).sort()).toEqual(['디자인 보고', '보고서']);
  });

  it('삭제된 프로젝트를 참조하는 필터는 오류 없이 감지·정리된다', async () => {
    const { p1, p2 } = await seedTasks();
    const filter = { search: '', conditions: [{ type: 'in' as const, field: 'project', values: [p1.id, p2.id] }] };
    await d.domain.softDelete('projects', p2.id);
    const data = await d.domain.snapshot();
    expect(findStaleReferences('tasks', filter, data)).toEqual([{ conditionIndex: 0, field: 'project', value: p2.id }]);
    expect(removeStaleReferences('tasks', filter, data).conditions[0]).toEqual({ type: 'in', field: 'project', values: [p1.id] });
    expect(() => applySortAndFilterPure('tasks', data, { sort_config: [], filter_config: filter })).not.toThrow();
    // 이름 변경은 ID 참조이므로 영향 없음
    await d.domain.updateProject(p1.id, { name: '알파-2' });
    expect(findStaleReferences('tasks', filter, await d.domain.snapshot()).length).toBe(1);
  });
});

describe('VIEW-008 존재하지 않는 필드 설정 거부', () => {
  it('컬럼·정렬·필터의 알 수 없는 필드와 필터 유형을 거부한다', async () => {
    const v = await defaultView();
    const r1 = await d.views.updateView(v.id, { column_config: [...v.column_config, { field: 'secret', visible: true, position: 99, width: 100, pinned: false }] });
    expect(!r1.ok && r1.error.issues![0].code).toBe('UNKNOWN_FIELD');
    const r2 = await d.views.updateView(v.id, { sort_config: [{ field: 'deleted_at', dir: 'asc' }] });
    expect(!r2.ok && r2.error.issues![0].code).toBe('UNKNOWN_FIELD');
    const r3 = await d.views.updateView(v.id, { filter_config: { search: '', conditions: [{ type: 'sql', field: 'title', values: ['1=1'] } as never] } });
    expect(!r3.ok && r3.error.issues![0].code).toBe('INVALID_FILTER_TYPE');
    const r4 = await d.views.updateView(v.id, { filter_config: { search: '', conditions: [{ type: 'in', field: 'status', values: ["x' OR 1=1"] }] } });
    expect(!r4.ok && r4.error.issues![0].code).toBe('INVALID_FILTER_VALUE');
    // 표시 이름(한글)을 식별자로 쓰는 설정도 거부
    const r5 = validateViewConfig('tasks', { ...defaultViewConfig('tasks'), sort_config: [{ field: '제목', dir: 'asc' }] });
    expect(!r5.ok && r5.error.issues![0].code).toBe('UNKNOWN_FIELD');
    const after = await d.views.getView(v.id);
    expect(after.ok && after.value).toEqual(v);
  });
});

describe('VIEW-009 잘못된 너비 및 설정 데이터 거부', () => {
  it('너비 범위, 중복 순서, 중복 필드, 타입 오류, 알 수 없는 속성을 거부하고 기존 설정을 보존한다', async () => {
    const v = await defaultView();
    const cases: Array<[unknown, string]> = [
      [v.column_config.map((c) => (c.field === 'title' ? { ...c, width: 5 } : c)), 'INVALID_WIDTH'],
      [v.column_config.map((c) => (c.field === 'title' ? { ...c, width: 99999 } : c)), 'INVALID_WIDTH'],
      [v.column_config.map((c) => (c.field === 'title' ? { ...c, width: 'wide' } : c)), 'INVALID_WIDTH'],
      [v.column_config.map((c) => (c.field === 'status' ? { ...c, position: 0 } : c)), 'DUPLICATE_POSITION'],
      [[...v.column_config, { ...v.column_config[0], position: 50 }], 'DUPLICATE_FIELD'],
      [v.column_config.map((c) => (c.field === 'title' ? { ...c, position: -1 } : c)), 'INVALID_POSITION'],
      [v.column_config.map((c) => (c.field === 'title' ? { ...c, onclick: 'alert(1)' } : c)), 'UNKNOWN_KEY'],
      ['not-an-array', 'INVALID_TYPE'],
    ];
    for (const [cols, code] of cases) {
      const r = await d.views.updateView(v.id, { column_config: cols as never });
      expect(r.ok, code).toBe(false);
      if (!r.ok) expect(r.error.issues!.map((i) => i.code)).toContain(code);
    }
    const nameR = await d.views.updateView(v.id, { name: '   ' });
    expect(!nameR.ok && nameR.error.code).toBe('VALIDATION');
    const keyR = await d.views.updateView(v.id, { owner_id: 'someone' } as never);
    expect(!keyR.ok && keyR.error.issues![0].code).toBe('UNKNOWN_KEY');
    const after = await d.views.getView(v.id);
    expect(after.ok && after.value).toEqual(v);
    expect(await d.db.getAll('view_outbox')).toHaveLength(1); // 최초 생성 op 만 존재
  });
});

describe('VIEW-010 보기 설정 변경 후 업무 데이터 불변성', () => {
  it('숨기기·순서·너비·정렬·필터·이름·복제·기본지정·삭제·복구가 업무 데이터를 바꾸지 않는다', async () => {
    await seedTasks();
    await d.domain.createEvent({ title: 'e', start_at: '2026-10-02T01:00:00Z', end_at: '2026-10-02T02:00:00Z' });
    const before = await domainDump(d.db);
    const v = await defaultView();
    await d.views.updateView(v.id, { column_config: v.column_config.map((c, i) => ({ ...c, visible: c.field === 'title' || i % 2 === 0, width: 150 })) });
    await d.views.updateView(v.id, { sort_config: [{ field: 'title', dir: 'desc' }], filter_config: { search: '없는검색어', conditions: [{ type: 'in', field: 'status', values: ['done'] }] } });
    const filtered = await d.views.applySortAndFilter('tasks', (await d.views.getView(v.id)).ok ? { ...defaultViewConfig('tasks'), filter_config: { search: '없는검색어', conditions: [] } } : {});
    expect(filtered.ok && filtered.value.length).toBe(0); // 필터로 0건이어도
    const dup = await d.views.duplicateView(v.id);
    if (!dup.ok) throw new Error();
    await d.views.setDefaultView(dup.value.id);
    await d.views.updateView(dup.value.id, { name: '새 이름' });
    await d.views.deleteView(dup.value.id);
    await d.views.restoreView(dup.value.id);
    await d.views.listViews('events');
    expect(await domainDump(d.db)).toEqual(before); // updated_at, version, completed_at 포함 동일
    expect((await d.domain.snapshot()).tasks).toHaveLength(5); // 필터 결과 0건 ≠ 삭제
    // 변경 큐에는 보기 op 만 존재
    const ops = await d.db.getAll('view_outbox');
    const viewIds = new Set((await d.db.getAll('view_preferences')).map((x) => x.id));
    expect(ops.every((o) => viewIds.has(o.view_id))).toBe(true);
  });
});

describe('VIEW-019 기본 보기 복원 시 업무 데이터 보존', () => {
  it('resetView 는 선택한 보기의 설정만 기본값으로 되돌린다', async () => {
    await seedTasks();
    const before = await domainDump(d.db);
    const v = await defaultView();
    const other = await d.views.createView({ domain: 'tasks', name: '다른 보기', config: { ...defaultViewConfig('tasks'), sort_config: [{ field: 'title', dir: 'asc' }] } });
    await d.views.updateView(v.id, { name: '내 보기', sort_config: [{ field: 'priority', dir: 'asc' }], filter_config: { search: 'x', conditions: [] } });
    const r = await d.views.resetView(v.id);
    expect(r.ok).toBe(true);
    if (!r.ok || !other.ok) return;
    const { column_config, sort_config, filter_config, layout_config } = r.value;
    expect({ column_config, sort_config, filter_config, layout_config }).toEqual(defaultViewConfig('tasks'));
    expect(r.value.id).toBe(v.id);
    expect(r.value.name).toBe('내 보기');
    const o = await d.views.getView(other.value.id);
    expect(o.ok && o.value.sort_config).toEqual([{ field: 'title', dir: 'asc' }]);
    expect(await domainDump(d.db)).toEqual(before);
  });
});

describe('VIEW-020 보기 삭제 및 복구 정책', () => {
  it('소프트 삭제 → 목록 제외 → 복구 가능, 마지막 보기 삭제 불가, 기본 보기 삭제 시 승계', async () => {
    const v = await defaultView();
    const last = await d.views.deleteView(v.id);
    expect(!last.ok && last.error.code).toBe('LAST_VIEW');

    const b = await d.views.createView({ domain: 'tasks', name: 'B' });
    if (!b.ok) throw new Error();
    const del = await d.views.deleteView(v.id); // 기본 보기 삭제
    expect(del.ok).toBe(true);
    const list = await d.views.listViews('tasks');
    expect(list.ok && list.value.map((x) => x.id)).toEqual([b.value.id]);
    expect(list.ok && list.value[0].is_default).toBe(true);
    const deleted = await d.views.listDeletedViews('tasks');
    expect(deleted.ok && deleted.value.map((x) => x.id)).toEqual([v.id]);

    const restored = await d.views.restoreView(v.id);
    expect(restored.ok && restored.value.deleted_at).toBeNull();
    expect((await d.views.listViews('tasks')).ok).toBe(true);
    const ids = await d.views.listViews('tasks');
    expect(ids.ok && ids.value.length).toBe(2);
  });

  it('보존 기간(30일)이 지난 로컬 삭제 보기만 정리된다', async () => {
    await defaultView();
    const b = await d.views.createView({ domain: 'tasks', name: 'B' });
    const c = await d.views.createView({ domain: 'tasks', name: 'C' });
    if (!b.ok || !c.ok) throw new Error();
    await d.views.deleteView(b.value.id);
    expect(await d.views.purgeDeletedViews(Date.now() + 29 * 86400000)).toBe(0);
    expect(await d.views.purgeDeletedViews(Date.now() + 31 * 86400000)).toBe(1);
    expect((await d.views.getView(b.value.id)).ok).toBe(false);
    expect((await d.views.getView(c.value.id)).ok).toBe(true);
  });
});
