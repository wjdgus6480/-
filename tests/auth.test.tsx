import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { AuthController } from '../src/app/auth';
import { createServices } from '../src/app/services';
import { domainDump } from './helpers';

afterEach(cleanup);

const session = (id = 'user-1', email = 'me@example.com') => ({ user: { id, email } }) as any;

/** supabase-js auth API 모양만 흉내낸 가짜 클라이언트 */
function fakeClient(over: Record<string, any> = {}) {
  let handler: ((e: string, s: any) => void) | null = null;
  const auth = {
    onAuthStateChange: vi.fn((cb) => {
      handler = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    }),
    signOut: vi.fn(async () => ({ error: null })),
    signInWithPassword: vi.fn(async () => ({ data: {}, error: null })),
    signUp: vi.fn(async () => ({ data: { user: { identities: [{}] }, session: null }, error: null })),
    signInWithOtp: vi.fn(async () => ({ data: {}, error: null })),
    verifyOtp: vi.fn(async () => ({ data: {}, error: null })),
    updateUser: vi.fn(async () => ({ data: {}, error: null })),
    reauthenticate: vi.fn(async () => ({ data: {}, error: null })),
    resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })),
    ...over,
  };
  return { client: { auth } as any, auth, emit: (e: string, s: any) => handler?.(e, s) };
}

describe('AUTH-001 로그아웃 범위', () => {
  it('기본 로그아웃은 이 기기만(scope:local), 전체 로그아웃은 scope:global, 둘 다 만료 안내를 띄우지 않는다', async () => {
    const f = fakeClient();
    const a = new AuthController(f.client);
    a.init(session());
    await a.signOutThisDevice();
    expect(f.auth.signOut).toHaveBeenLastCalledWith({ scope: 'local' });
    f.emit('SIGNED_OUT', null);
    expect(a.state).toMatchObject({ userId: null, expired: false });
    a.handle('SIGNED_IN', session());
    await a.signOutAllDevices();
    expect(f.auth.signOut).toHaveBeenLastCalledWith({ scope: 'global' });
    f.emit('SIGNED_OUT', null);
    expect(a.state.expired).toBe(false);
  });

  it('사용자가 하지 않은 로그아웃(세션 만료·다른 기기의 전체 로그아웃)은 expired 로 표시한다', () => {
    const f = fakeClient();
    const a = new AuthController(f.client);
    a.init(session());
    f.emit('SIGNED_OUT', null);
    expect(a.state).toMatchObject({ userId: null, expired: true });
    f.emit('SIGNED_IN', session());
    expect(a.state).toMatchObject({ userId: 'user-1', expired: false });
  });
});

describe('AUTH-002 로그인·가입·메일 로그인 호출 계약과 오류 안내', () => {
  it('비밀번호 로그인 오류를 한국어로 안내한다', async () => {
    const f = fakeClient({ signInWithPassword: vi.fn(async () => ({ error: { code: 'invalid_credentials', message: 'Invalid login credentials' } })) });
    const r = await new AuthController(f.client).signInWithPassword(' me@example.com ', 'pw');
    expect(f.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'me@example.com', password: 'pw' });
    expect(r).toMatchObject({ ok: false, message: '이메일 또는 비밀번호가 맞지 않습니다.' });
  });
  it('이미 가입된 이메일로 가입하면(identities 빈 배열) 안내한다', async () => {
    const f = fakeClient({ signUp: vi.fn(async () => ({ data: { user: { identities: [] }, session: null }, error: null })) });
    expect(await new AuthController(f.client).signUp('me@example.com', 'secret1')).toMatchObject({ ok: false, code: 'user_already_exists' });
  });
  it('메일 로그인은 새 계정을 자동 생성하지 않고 현재 주소로 돌아오게 한다', async () => {
    const f = fakeClient();
    await new AuthController(f.client).sendMagicLink('me@example.com');
    expect(f.auth.signInWithOtp).toHaveBeenCalledWith({ email: 'me@example.com', options: { emailRedirectTo: window.location.origin, shouldCreateUser: false } });
  });
  it('메일 발송 한도 초과(429)를 안내한다', async () => {
    const f = fakeClient({ signInWithOtp: vi.fn(async () => ({ error: { code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' } })) });
    expect((await new AuthController(f.client).sendMagicLink('me@example.com')).message).toMatch(/시간당 2통/);
  });
});

describe('AUTH-003 비밀번호 설정 (기존 메일 로그인 사용자)', () => {
  it('로그인 상태에서 updateUser({password}) 로 설정한다', async () => {
    const f = fakeClient();
    const a = new AuthController(f.client);
    a.init(session());
    expect(await a.setPassword('newpass1')).toMatchObject({ ok: true });
    expect(f.auth.updateUser).toHaveBeenCalledWith({ password: 'newpass1' });
  });
  it('Secure password change 가 켜져 재인증이 필요하면 코드 요청 후 nonce 와 함께 다시 설정한다', async () => {
    const updateUser = vi.fn().mockResolvedValueOnce({ error: { code: 'reauthentication_needed', message: 'reauth' } }).mockResolvedValueOnce({ error: null });
    const f = fakeClient({ updateUser });
    const a = new AuthController(f.client);
    a.init(session());
    const r1 = await a.setPassword('newpass1');
    expect(r1).toMatchObject({ ok: false, code: 'reauthentication_needed' });
    await a.requestReauth();
    expect(f.auth.reauthenticate).toHaveBeenCalled();
    expect(await a.setPassword('newpass1', '12345678')).toMatchObject({ ok: true });
    expect(updateUser).toHaveBeenLastCalledWith({ password: 'newpass1', nonce: '12345678' });
  });
  it('재설정 메일은 현재 주소로 돌아오게 하고, PASSWORD_RECOVERY 이벤트에서 recovery 상태가 된다', async () => {
    const f = fakeClient();
    const a = new AuthController(f.client);
    a.init(null);
    await a.sendPasswordReset('me@example.com');
    expect(f.auth.resetPasswordForEmail).toHaveBeenCalledWith('me@example.com', { redirectTo: window.location.origin });
    f.emit('PASSWORD_RECOVERY', session());
    expect(a.state).toMatchObject({ userId: 'user-1', recovery: true });
    await a.setPassword('newpass1');
    expect(a.state.recovery).toBe(false);
  });
});

describe('AUTH-004 앱 연동: 만료 안내·데이터 보존·토큰 갱신 동기화·재설정 화면', () => {
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
    spy.mockClear();
    s.auth.handle('TOKEN_REFRESHED', session('user-9'));
    expect(spy).toHaveBeenCalled(); // 토큰 갱신 후 동기화 재시도
    s.sync.stop();
    s.domainSync.stop();
  });

  it('재설정 링크로 들어오면 새 비밀번호 화면이 뜨고 닫을 수 있다', async () => {
    const s = await createServices(`auth-r-${Math.random()}`);
    render(<App services={s} />);
    s.auth.handle('PASSWORD_RECOVERY', session());
    expect(await screen.findByRole('dialog', { name: '새 비밀번호 설정' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새 비밀번호 설정' })).toBeNull());
    s.sync.stop();
    s.domainSync.stop();
  });
});
