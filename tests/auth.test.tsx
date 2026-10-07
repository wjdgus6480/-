import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { AuthController } from '../src/app/auth';
import { ServicesContext } from '../src/app/context';
import { createServices, normalizeApiUrl, type Services } from '../src/app/services';
import { DeleteAccount, LoginForms } from '../src/ui/AuthForms';
import { err, fakeApi, noContent, ok, storedSession } from './apiFake';
import { domainDump } from './helpers';

afterEach(cleanup);

const session = (id = 'user-1', email = 'me@example.com') => ({ user: { id, email } });

function controller(f: ReturnType<typeof fakeApi>) {
  const a = new AuthController(f.api);
  a.init();
  return a;
}

/** 가짜 API 를 붙인 서비스 (실제 네트워크 없음) */
async function servicesWith(f: ReturnType<typeof fakeApi>): Promise<Services> {
  const s = await createServices(`auth-${Math.random()}`);
  const auth = new AuthController(f.api);
  auth.subscribe((st) => {
    s.session.owner = st.userId;
    s.session.email = st.email;
  });
  auth.init();
  return { ...s, auth, api: f.api };
}

describe('AUTH-001 로그아웃 범위', () => {
  it('이 기기 로그아웃은 /logout, 모든 기기는 /logout-all. 둘 다 토큰을 지우고 만료 안내를 띄우지 않는다', async () => {
    const f = fakeApi({ 'POST /api/auth/logout': noContent, 'POST /api/auth/logout-all': noContent }, { session: storedSession() });
    const a = controller(f);
    expect(a.state.userId).toBe('user-1');
    await a.signOutThisDevice();
    expect(f.calls('POST /api/auth/logout')).toHaveLength(1);
    expect(a.state).toMatchObject({ userId: null, expired: false });
    expect(f.api.getSession()).toBeNull();
    expect(f.storage.getItem('dotday.session')).toBeNull();

    f.api.setSession(storedSession());
    a.handle('SIGNED_IN', session());
    await a.signOutAllDevices();
    expect(f.calls('POST /api/auth/logout-all')).toHaveLength(1);
    expect(a.state).toMatchObject({ userId: null, expired: false });
  });

  it('오프라인이어도 이 기기 로그아웃은 된다. 모든 기기 로그아웃은 서버가 필요하므로 실패 안내 후 로그인 유지', async () => {
    const f = fakeApi({}, { session: storedSession() });
    const a = controller(f);
    f.state.offline = true;
    const all = await a.signOutAllDevices();
    expect(all.ok).toBe(false);
    expect(a.state.userId).toBe('user-1');
    await a.signOutThisDevice();
    expect(a.state).toMatchObject({ userId: null, expired: false });
  });

  it('사용자가 하지 않은 로그아웃(토큰 요청이 401: 만료·다른 기기의 전체 로그아웃)은 expired 로 표시하고 토큰을 지운다', async () => {
    const f = fakeApi({ 'GET /api/auth/me': () => err(401, 'session_not_found') }, { session: storedSession() });
    const a = controller(f);
    await a.verify();
    expect(a.state).toMatchObject({ userId: null, expired: true });
    expect(f.api.getSession()).toBeNull();
  });

  it('저장된 토큰의 만료 시각이 지났으면 시작할 때 만료 안내와 함께 로그아웃 상태', () => {
    const f = fakeApi({}, { session: storedSession('user-1', 'me@example.com', -1000) });
    const a = controller(f);
    expect(a.state).toMatchObject({ userId: null, expired: true });
    expect(f.api.getSession()).toBeNull();
  });

  it('오프라인에서 시작해도 저장된 세션으로 로그인 상태를 유지한다 (로컬 우선)', async () => {
    const f = fakeApi({}, { session: storedSession('user-7') });
    f.state.offline = true;
    const a = controller(f);
    await a.verify();
    expect(a.state).toMatchObject({ userId: 'user-7', expired: false });
  });
});

describe('AUTH-002 로그인·가입 호출 계약과 오류 안내', () => {
  it('로그인: 앞뒤 공백을 지운 이메일로 요청하고 받은 세션을 저장한다', async () => {
    const s = storedSession('user-2', 'me@example.com');
    const f = fakeApi({ 'POST /api/auth/login': () => ok(s) });
    const a = controller(f);
    const events: string[] = [];
    a.subscribe((_st, e) => events.push(e));
    expect(await a.signInWithPassword(' me@example.com ', 'pw1234')).toEqual({ ok: true });
    expect(f.calls('POST /api/auth/login')[0]).toEqual({ email: 'me@example.com', password: 'pw1234' });
    expect(a.state).toMatchObject({ userId: 'user-2', email: 'me@example.com' });
    expect(JSON.parse(f.storage.getItem('dotday.session')!)).toEqual(s);
    expect(events).toContain('SIGNED_IN');
  });

  it('서버 오류 코드를 한국어로 안내한다', async () => {
    const cases: [ReturnType<typeof err>, string][] = [
      [err(400, 'invalid_credentials'), '이메일 또는 비밀번호가 맞지 않습니다.'],
      [err(429, 'over_request_rate_limit'), '로그인 시도가 너무 많습니다. 15분 뒤 다시 시도하세요.'],
      [err(409, 'user_already_exists'), '이미 가입된 이메일입니다. 로그인하세요.'],
    ];
    for (const [resp, msg] of cases) {
      const f = fakeApi({ 'POST /api/auth/login': () => resp });
      expect(await controller(f).signInWithPassword('me@example.com', 'x')).toMatchObject({ ok: false, message: msg });
    }
  });

  it('로그인 실패(400)는 세션 만료로 취급하지 않는다', async () => {
    const f = fakeApi({ 'POST /api/auth/login': () => err(400, 'invalid_credentials') });
    const a = controller(f);
    await a.signInWithPassword('me@example.com', 'x');
    expect(a.state.expired).toBe(false);
  });

  it('서버에 닿지 못하면(오프라인·서버 잠듦) 다시 시도하라고 안내한다', async () => {
    const f = fakeApi();
    f.state.offline = true;
    const r = await controller(f).signInWithPassword('me@example.com', 'x');
    expect(r).toMatchObject({ ok: false, code: 'network' });
  });

  it('가입하면 바로 로그인된다', async () => {
    const f = fakeApi({ 'POST /api/auth/signup': () => ({ status: 201, body: storedSession('new-1', 'new@example.com') }) });
    const a = controller(f);
    expect(await a.signUp('new@example.com', 'secret1')).toEqual({ ok: true, message: '가입되었습니다.' });
    expect(a.state.userId).toBe('new-1');
  });

  it('로그인 화면: 가입 탭으로 바꿔 가입하고, 실패 안내를 보여 준다', async () => {
    const f = fakeApi({ 'POST /api/auth/login': () => err(400, 'invalid_credentials'), 'POST /api/auth/signup': () => ({ status: 201, body: storedSession() }) });
    const s = await servicesWith(f);
    render(
      <ServicesContext.Provider value={s}>
        <LoginForms />
      </ServicesContext.Provider>,
    );
    fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'me@example.com' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'secret1' } });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByText('이메일 또는 비밀번호가 맞지 않습니다.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('가입'));
    fireEvent.click(screen.getByRole('button', { name: '가입하기' }));
    expect(await screen.findByText('가입되었습니다.')).toBeTruthy();
    expect(f.calls('POST /api/auth/signup')[0]).toEqual({ email: 'me@example.com', password: 'secret1' });
    s.sync.stop();
    s.domainSync.stop();
  });
});

describe('AUTH-003 비밀번호 변경', () => {
  it('현재 비밀번호와 새 비밀번호를 보낸다', async () => {
    const f = fakeApi({ 'PUT /api/auth/password': noContent }, { session: storedSession() });
    expect(await controller(f).changePassword('old123', 'new123')).toMatchObject({ ok: true });
    expect(f.calls('PUT /api/auth/password')[0]).toEqual({ current_password: 'old123', new_password: 'new123' });
  });
});

describe('AUTH-004 앱 연동: 만료 안내·데이터 보존·재로그인 동기화', () => {
  it('세션이 끊겨도 기기 데이터와 미전송 대기열은 그대로이고, 다시 로그인하면 같은 데이터가 보인다', async () => {
    const s = await createServices(`auth-${Math.random()}`);
    s.auth.handle('SIGNED_IN', session('user-9'));
    await s.domain.createTask({ title: '로그인 중 작업' });
    const before = await domainDump(s.db);
    const outbox = await s.db.getAll('domain_outbox');
    render(<App services={s} />);
    await screen.findByText('로그인 중 작업');
    s.auth.handle('SIGNED_OUT', null); // 사용자가 하지 않은 로그아웃
    expect(await screen.findByText(/로그인이 만료되었거나/)).toBeTruthy();
    expect(await domainDump(s.db)).toEqual(before);
    expect(await s.db.getAll('domain_outbox')).toEqual(outbox);
    const spy = vi.spyOn(s.domainSync, 'sync');
    s.auth.handle('SIGNED_IN', session('user-9'));
    await screen.findByText('로그인 중 작업');
    expect(screen.queryByText(/로그인이 만료되었거나/)).toBeNull();
    expect(spy).toHaveBeenCalled();
    s.sync.stop();
    s.domainSync.stop();
  });

  it('API 주소 끝의 / 를 정리하고, 비어 있으면 로컬 전용', () => {
    expect(normalizeApiUrl('https://api.example.com/')).toBe('https://api.example.com');
    expect(normalizeApiUrl('  ')).toBeNull();
    expect(normalizeApiUrl(undefined)).toBeNull();
  });
});

describe('AUTH-005 회원 탈퇴 (클라이언트, 서버 쪽은 backend AuthApiTest 에서 검증)', () => {
  it('서버 결과를 상태별로 안내한다', async () => {
    const cases: [unknown, object][] = [
      [{ status: 'deleted' }, { ok: true }],
      [{ status: 'reauth_required' }, { ok: false, code: 'reauth_required' }],
      [{ status: 'rejected', reason: 'admin_account' }, { ok: false, code: 'admin_account' }],
    ];
    for (const [body, want] of cases) {
      const f = fakeApi({ 'POST /api/account/delete': () => ok(body) }, { session: storedSession() });
      expect(await controller(f).deleteAccount()).toMatchObject(want);
      expect(f.calls('POST /api/account/delete')[0]).toEqual({ confirm: 'DELETE' });
    }
  });

  it("'탈퇴' 입력 + 비밀번호 재인증 후 삭제 → 그 계정의 기기 데이터만 지우고 로그아웃, 로그인 전 데이터는 보존", async () => {
    const f = fakeApi(
      { 'POST /api/auth/reauth': noContent, 'POST /api/account/delete': () => ok({ status: 'deleted' }), 'POST /api/auth/logout': () => err(401, 'session_not_found') },
      { session: storedSession('user-del') },
    );
    const s = await servicesWith(f);
    await s.domain.createTask({ title: '탈퇴할 계정 작업' });
    s.session.owner = null;
    await s.domain.createTask({ title: '로그인 전 작업' });
    s.session.owner = 'user-del';
    render(
      <ServicesContext.Provider value={s}>
        <DeleteAccount />
      </ServicesContext.Provider>,
    );
    expect(await screen.findByText(/아직 서버로 보내지 않은 변경이 2건/)).toBeTruthy();
    const btn = screen.getByRole('button', { name: '계정과 서버 데이터 영구 삭제' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/비밀번호/), { target: { value: 'secret1' } });
    fireEvent.change(screen.getByLabelText(/확인을 위해/), { target: { value: '탈퇴' } });
    fireEvent.click(btn);
    expect(await screen.findByText(/탈퇴가 완료되었습니다/)).toBeTruthy();
    expect(f.calls('POST /api/auth/reauth')[0]).toEqual({ password: 'secret1' });
    expect(s.auth.state).toMatchObject({ userId: null, expired: false });
    const titles = (await s.db.getAll('tasks')).map((t) => t.title);
    expect(titles).toEqual(['로그인 전 작업']);
    expect((await s.db.getAll('domain_outbox')).length).toBe(1); // 로그인 전 작업의 대기열만 남음
    s.sync.stop();
    s.domainSync.stop();
  });

  it('재인증 실패 시 서버 탈퇴를 호출하지 않는다', async () => {
    const f = fakeApi({ 'POST /api/auth/reauth': () => err(400, 'invalid_credentials'), 'POST /api/account/delete': () => ok({ status: 'deleted' }) }, { session: storedSession('user-x') });
    const s = await servicesWith(f);
    render(
      <ServicesContext.Provider value={s}>
        <DeleteAccount />
      </ServicesContext.Provider>,
    );
    fireEvent.change(screen.getByLabelText(/비밀번호/), { target: { value: 'wrong' } });
    fireEvent.change(screen.getByLabelText(/확인을 위해/), { target: { value: '탈퇴' } });
    fireEvent.click(screen.getByRole('button', { name: '계정과 서버 데이터 영구 삭제' }));
    expect(await screen.findByText('이메일 또는 비밀번호가 맞지 않습니다.')).toBeTruthy();
    expect(f.calls('POST /api/account/delete')).toHaveLength(0);
    s.sync.stop();
    s.domainSync.stop();
  });
});
