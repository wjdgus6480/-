import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { createServices, type Services } from '../src/app/services';
import { domainDump } from './helpers';

function mockViewport(mobile: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: mobile && q.includes('max-width'),
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as never;
}

const titles = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.querySelector('td[data-field="title"]')?.textContent ?? '');

let s: Services;
beforeEach(async () => {
  mockViewport(true);
  location.hash = '#tasks';
  s = await createServices(`mobile-${Math.random()}`);
  await s.domain.createTask({ title: '가 작업', priority: 'low', due_date: '2026-10-09' });
  await s.domain.createTask({ title: '나 작업', priority: 'urgent', due_date: '2026-10-03', status: 'done' });
  await s.domain.createTask({ title: '다 작업', priority: 'high', due_date: '2026-10-05' });
});
afterEach(() => {
  cleanup();
  s.sync.stop();
  s.domainSync.stop();
});

describe('VIEW-018 모바일 화면에서 정렬과 필터 사용', () => {
  it('모바일 폭에서 정렬·필터·컬럼 설정을 사용할 수 있고, 숨긴 컬럼은 그대로 숨겨진다', async () => {
    const lv = await s.views.listViews('tasks');
    if (!lv.ok) throw new Error();
    const v = lv.value[0];
    await s.views.updateView(v.id, { column_config: v.column_config.map((c) => (c.field === 'category' ? { ...c, visible: false } : c)) });
    const before = await domainDump(s.db);

    render(<App services={s} />);
    await waitFor(() => expect(titles()).toHaveLength(3));
    // 기본 정렬: 마감일 오름차순
    expect(titles()).toEqual(['나 작업', '다 작업', '가 작업']);
    // 사용자가 숨긴 컬럼은 모바일에서도 숨김, 표시 컬럼은 반응형이 임의로 숨기지 않음
    const headers = screen.getAllByRole('columnheader').map((h) => h.getAttribute('data-field')).filter(Boolean);
    expect(headers).toEqual(['title', 'status', 'priority', 'due_date', 'project']);
    // 모바일: 헤더 드래그 비활성(터치 대신 메뉴 ▲▼ 사용), 첫 고정 컬럼만 sticky
    expect(screen.getAllByRole('columnheader').find((h) => h.getAttribute('data-field') === 'title')!.className).toContain('sticky');
    expect(screen.getAllByRole('columnheader').find((h) => h.getAttribute('data-field') === 'title')!.getAttribute('data-reorderable')).toBe('false');

    // 정렬 패널: 기존 규칙 제거 후 우선순위 내림차순
    fireEvent.click(screen.getByRole('button', { name: /^정렬/ }));
    let dlg = screen.getByRole('dialog', { name: '정렬' });
    fireEvent.click(within(dlg).getByRole('button', { name: '정렬 2 삭제' }));
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: '정렬' })).queryByRole('button', { name: '정렬 2 삭제' })).toBeNull());
    dlg = screen.getByRole('dialog', { name: '정렬' });
    fireEvent.change(within(dlg).getByLabelText('정렬 1 필드'), { target: { value: 'priority' } });
    await waitFor(() => expect((within(screen.getByRole('dialog', { name: '정렬' })).getByLabelText('정렬 1 필드') as HTMLSelectElement).value).toBe('priority'));
    fireEvent.change(within(screen.getByRole('dialog', { name: '정렬' })).getByLabelText('정렬 1 방향'), { target: { value: 'desc' } });
    await waitFor(() => expect(titles()).toEqual(['나 작업', '다 작업', '가 작업']));
    fireEvent.click(within(screen.getByRole('dialog', { name: '정렬' })).getByRole('button', { name: '닫기' }));
    // 다중 정렬 대신 단일 정렬 확인: 오름차순으로 바꾸면 순서 반전
    fireEvent.click(screen.getByRole('button', { name: /^정렬/ }));
    fireEvent.change(within(screen.getByRole('dialog', { name: '정렬' })).getByLabelText('정렬 1 방향'), { target: { value: 'asc' } });
    await waitFor(() => expect(titles()).toEqual(['가 작업', '다 작업', '나 작업']));
    fireEvent.keyDown(window, { key: 'Escape' });

    // 필터 패널: 상태 = 할 일
    fireEvent.click(screen.getByRole('button', { name: /^필터/ }));
    const fdlg = screen.getByRole('dialog', { name: '필터' });
    const statusGroup = within(fdlg).getByRole('group', { name: '상태' });
    fireEvent.click(within(statusGroup).getByLabelText('할 일'));
    await waitFor(() => expect(titles()).toEqual(['가 작업', '다 작업']));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: /^필터 1/ })).toBeTruthy();

    // 검색
    fireEvent.change(screen.getByLabelText('검색'), { target: { value: '다' } });
    await waitFor(() => expect(titles()).toEqual(['다 작업']));

    // 컬럼 패널: 모바일에서 ▲▼ 로 순서 변경
    fireEvent.click(screen.getByRole('button', { name: /^컬럼/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '컬럼 설정' })).getByRole('button', { name: '우선순위 위로' }));
    await waitFor(() => {
      const h = screen.getAllByRole('columnheader').map((x) => x.getAttribute('data-field')).filter(Boolean);
      expect(h).toEqual(['title', 'priority', 'status', 'due_date', 'project']);
    });

    // 설정이 저장되었고 업무 데이터는 그대로
    await act(async () => new Promise((r) => setTimeout(r, 700))); // 검색 저장 지연
    const saved = await s.views.getView(v.id);
    expect(saved.ok && saved.value.sort_config).toEqual([{ field: 'priority', dir: 'asc' }]);
    expect(saved.ok && saved.value.filter_config).toEqual({ search: '다', conditions: [{ type: 'in', field: 'status', values: ['todo'] }] });
    expect(saved.ok && saved.value.column_config.find((c) => c.field === 'category')!.visible).toBe(false);
    expect(await domainDump(s.db)).toEqual(before);
  });
});
