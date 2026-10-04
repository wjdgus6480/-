import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { createServices } from '../src/app/services';
import { makeDevice, makeServer, USER_A } from './helpers';

afterEach(cleanup);

describe('SYNC-010 앱 재진입 시 서버 동기화 (visibilitychange)', () => {
  it('화면이 다시 보이면 업무 데이터 동기화(pull)가 바로 실행된다', async () => {
    const server = await makeServer();
    const d = await makeDevice({ owner: USER_A, server });
    let pulls = 0;
    const orig = d.domainRemote!.pullSince.bind(d.domainRemote!);
    d.domainRemote!.pullSince = async (...a) => {
      pulls++;
      return orig(...a);
    };
    d.domainSync.start();
    await waitFor(() => expect(pulls).toBeGreaterThan(0)); // 시작 시 pull
    await d.domainSync.sync(); // 시작 동기화 완료 대기
    const before = pulls;
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(pulls).toBeGreaterThan(before));
    d.domainSync.stop();
  });
});

describe('SYNC-011 로그인 전 데이터 이전 안내가 사라지지 않음', () => {
  it("'나중에'를 눌러도 아직 올라가지 않은 데이터가 있다는 알림과 옮기기 버튼이 남는다", async () => {
    const s = await createServices(`pending-${Math.random()}`);
    await s.domain.createTask({ title: '로그인 전 작업' });
    s.session.owner = USER_A; // 로그인된 상태로 시작
    render(<App services={s} />);
    await screen.findByRole('dialog', { name: '로그인 전 데이터를 계정으로 옮길까요?' });
    fireEvent.click(screen.getByRole('button', { name: /나중에/ }));
    const notice = await screen.findByText(/아직 계정에 올라가지 않아/);
    expect(notice.textContent).toContain('1건');
    fireEvent.click(screen.getByRole('button', { name: '계정으로 옮기기' }));
    expect(await screen.findByRole('dialog', { name: '로그인 전 데이터를 계정으로 옮길까요?' })).toBeTruthy();
    await act(async () => {
      s.sync.stop();
      s.domainSync.stop();
    });
  });
});
