import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDeviceData, purgeOwnerData, summarizeDeviceData } from '../src/app/deviceData';
import { ServicesContext } from '../src/app/context';
import { createServices } from '../src/app/services';
import { getMeta, setMeta } from '../src/db/idb';
import { DeviceDataSection } from '../src/ui/SettingsPage';
import { makeDevice, makeServer, USER_A, USER_B } from './helpers';

afterEach(cleanup);

describe('DEV-001 이 기기 데이터 지우기 (서버 데이터와 무관)', () => {
  it('미전송 변경이 있으면 지우지 않는다 (유실 방지)', async () => {
    const server = await makeServer();
    const d = await makeDevice({ owner: USER_A, server });
    await d.domain.createTask({ title: '미전송' });
    const r = await clearDeviceData(d.db, { currentOwner: USER_A });
    expect(r).toMatchObject({ ok: false, reason: 'unsent', summary: { unsent: 1 } });
    expect((await d.db.getAll('tasks')).length).toBe(1);
  });

  it('로그인 전(서버에 없는) 데이터가 있으면 지우지 않는다', async () => {
    const d = await makeDevice({ owner: null });
    await d.domain.createTask({ title: '게스트' });
    await d.db.clear('domain_outbox'); // 대기열이 없어도 서버 사본이 없으므로 보호
    expect(await clearDeviceData(d.db, { currentOwner: null })).toMatchObject({ ok: false, summary: { guestRecords: 1, unsent: 0 } });
  });

  it('모두 동기화된 상태면 지우고, 모든 스토어와 dotday 화면 설정만 비운다 (서버 데이터는 그대로)', async () => {
    const server = await makeServer();
    const d = await makeDevice({ owner: USER_A, server });
    await d.domain.createTask({ title: '동기화됨' });
    await d.domainSync.sync();
    localStorage.setItem('dotday.lastView.tasks', 'v1');
    localStorage.setItem('other-app', 'keep');
    expect(await clearDeviceData(d.db, { currentOwner: USER_A })).toEqual({ ok: true });
    for (const s of d.db.objectStoreNames) expect(await d.db.count(s as never), s).toBe(0);
    expect(localStorage.getItem('dotday.lastView.tasks')).toBeNull();
    expect(localStorage.getItem('other-app')).toBe('keep');
    expect((await server.query<{ n: number }>(`select count(*)::int n from public.tasks`)).rows[0].n).toBe(1);
    // 다시 로그인한 기기는 서버에서 내려받는다
    const again = await makeDevice({ owner: USER_A, server });
    await again.domainSync.sync();
    expect((await again.domain.snapshot()).tasks.map((t) => t.title)).toEqual(['동기화됨']);
  });

  it('사용자가 명시적으로 동의(acceptLoss)하면 미전송이 있어도 지운다', async () => {
    const d = await makeDevice({ owner: USER_A });
    await d.domain.createTask({ title: '버림' });
    expect(await clearDeviceData(d.db, { currentOwner: USER_A, acceptLoss: true })).toEqual({ ok: true });
    expect(await d.db.count('domain_outbox')).toBe(0);
  });
});

describe('DEV-002 탈퇴한 계정 데이터만 기기에서 정리', () => {
  it('A 의 레코드·대기열·커서만 지우고, 로그인 전 데이터와 B 의 데이터는 남긴다', async () => {
    const d = await makeDevice({ owner: USER_A });
    await d.domain.createTask({ title: 'A 작업' });
    await setMeta(d.db, `domain_sync_cursor:${USER_A}:tasks`, 5);
    await setMeta(d.db, `view_sync_cursor:${USER_A}`, 3);
    d.session.owner = USER_B;
    await d.domain.createTask({ title: 'B 작업' });
    await setMeta(d.db, `domain_sync_cursor:${USER_B}:tasks`, 7);
    d.session.owner = null;
    await d.domain.createTask({ title: '게스트 작업' });
    const { removed } = await purgeOwnerData(d.db, USER_A);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect((await d.db.getAll('tasks')).map((t) => t.title).sort()).toEqual(['B 작업', '게스트 작업']);
    expect(await d.db.count('domain_outbox')).toBe(2);
    expect(await getMeta(d.db, `domain_sync_cursor:${USER_A}:tasks`)).toBeUndefined();
    expect(await getMeta(d.db, `view_sync_cursor:${USER_A}`)).toBeUndefined();
    expect(await getMeta(d.db, `domain_sync_cursor:${USER_B}:tasks`)).toBe(7);
  });
});

describe('DEV-003 계정 전환 시 다른 계정 데이터 비노출 (회귀)', () => {
  it('A 로그아웃 → B 로그인: B 화면에는 A 의 데이터가 보이지 않는다', async () => {
    const d = await makeDevice({ owner: USER_A });
    await d.domain.createTask({ title: 'A 비밀' });
    d.session.owner = null;
    expect((await d.domain.snapshot()).tasks).toEqual([]);
    d.session.owner = USER_B;
    expect((await d.domain.snapshot()).tasks).toEqual([]);
    const sum = await summarizeDeviceData(d.db, USER_B);
    expect(sum.otherAccountRecords).toBe(1);
  });
});

describe('DEV-004 설정 화면: 위험 시 동의 체크 전까지 버튼 비활성', () => {
  it('미전송이 있으면 경고와 동의 체크가 필요하고, 동의 후 지우면 새로 고침한다', async () => {
    const s = await createServices(`dev-ui-${Math.random()}`);
    await s.domain.createTask({ title: '게스트' });
    const reload = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <ServicesContext.Provider value={s}>
        <DeviceDataSection reload={reload} />
      </ServicesContext.Provider>,
    );
    expect(await screen.findByText(/서버에 없는 데이터가 사라집니다/)).toBeTruthy();
    const btn = screen.getByRole('button', { name: '이 기기 데이터 지우기' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/사라지는 것을 확인했습니다/));
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(await s.db.count('tasks')).toBe(0);
    s.sync.stop();
    s.domainSync.stop();
  });
});
