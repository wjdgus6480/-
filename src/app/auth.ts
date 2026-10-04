import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

/** 화면에 보여 줄 인증 상태 (React 상태로 구독) */
export interface AuthView {
  userId: string | null;
  email: string | null;
  /** 사용자가 직접 하지 않은 로그아웃 (세션 만료·다른 기기의 전체 로그아웃 등) */
  expired: boolean;
  /** 비밀번호 재설정 링크로 들어온 상태 → 새 비밀번호 입력 필요 */
  recovery: boolean;
}

export type AuthResult = { ok: true; message?: string } | { ok: false; message: string; code?: string };

const KO: Record<string, string> = {
  invalid_credentials: '이메일 또는 비밀번호가 맞지 않습니다.',
  email_not_confirmed: '이메일 확인이 아직 끝나지 않았습니다. 받은 메일의 링크를 열어 주세요.',
  over_email_send_rate_limit: '메일 발송 한도(무료 시간당 2통)를 넘었습니다. 잠시 뒤 다시 시도하거나 비밀번호로 로그인하세요.',
  weak_password: '비밀번호가 너무 약합니다 (6자 이상).',
  same_password: '이전과 같은 비밀번호입니다.',
  user_already_exists: '이미 가입된 이메일입니다. 로그인하거나 비밀번호를 재설정하세요.',
  otp_expired: '코드가 만료되었거나 맞지 않습니다. 가장 최근 메일의 코드를 입력하세요.',
  reauthentication_needed: '보안을 위해 재인증이 필요합니다. 메일로 받은 코드를 입력하세요.',
};

function fail(e: { message?: string; code?: string } | null): AuthResult {
  const code = e?.code ?? '';
  return { ok: false, code, message: KO[code] ?? e?.message ?? '알 수 없는 오류' };
}

/**
 * Supabase 인증 래퍼.
 * - 기본 로그아웃은 이 기기만(scope:'local'). 전체 기기 로그아웃은 별도(scope:'global').
 * - 인증 이벤트를 하나의 상태로 모아 React 에 즉시 반영한다.
 * - 로그아웃·만료 시 기기 데이터와 미전송 대기열은 건드리지 않는다(이 클래스는 저장소에 접근하지 않음).
 */
export class AuthController {
  state: AuthView = { userId: null, email: null, expired: false, recovery: false };
  private listeners = new Set<(s: AuthView, event: AuthChangeEvent | 'INIT') => void>();
  private userSignOut = false;
  private unsub: (() => void) | null = null;

  constructor(readonly client: SupabaseClient | null) {}

  /** 시작 시 저장된 세션으로 초기 상태를 만든다 */
  init(session: Session | null) {
    this.set({ userId: session?.user.id ?? null, email: session?.user.email ?? null }, 'INIT');
    if (!this.client || this.unsub) return;
    const { data } = this.client.auth.onAuthStateChange((event, s) => this.handle(event, s));
    this.unsub = () => data.subscription.unsubscribe();
  }

  dispose() {
    this.unsub?.();
    this.unsub = null;
  }

  subscribe(fn: (s: AuthView, event: AuthChangeEvent | 'INIT') => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private set(p: Partial<AuthView>, event: AuthChangeEvent | 'INIT') {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((fn) => fn(this.state, event));
  }

  /** onAuthStateChange 처리 (테스트에서 직접 호출 가능) */
  handle(event: AuthChangeEvent, session: Session | null) {
    if (event === 'SIGNED_OUT') {
      const wasIn = !!this.state.userId;
      this.set({ userId: null, email: null, expired: wasIn && !this.userSignOut, recovery: false }, event);
      this.userSignOut = false;
      return;
    }
    if (!session) return;
    this.set(
      { userId: session.user.id, email: session.user.email ?? null, expired: false, recovery: event === 'PASSWORD_RECOVERY' ? true : this.state.recovery },
      event,
    );
  }

  // ---------- 로그인 ----------

  async signInWithPassword(email: string, password: string): Promise<AuthResult> {
    if (!this.client) return { ok: false, message: '클라우드가 설정되지 않았습니다.' };
    const { error } = await this.client.auth.signInWithPassword({ email: email.trim(), password });
    return error ? fail(error) : { ok: true };
  }

  async signUp(email: string, password: string): Promise<AuthResult> {
    if (!this.client) return { ok: false, message: '클라우드가 설정되지 않았습니다.' };
    const { data, error } = await this.client.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: window.location.origin } });
    if (error) return fail(error);
    // 이미 가입된 이메일이면 Supabase 는 오류 대신 identities 가 빈 사용자를 돌려준다(이메일 존재 여부 노출 방지)
    if (data.user && data.user.identities?.length === 0) return fail({ code: 'user_already_exists' });
    return { ok: true, message: data.session ? '가입되었습니다.' : '확인 메일을 보냈습니다. 메일의 링크를 열면 가입이 완료됩니다.' };
  }

  async sendMagicLink(email: string): Promise<AuthResult> {
    if (!this.client) return { ok: false, message: '클라우드가 설정되지 않았습니다.' };
    // 새 사용자 자동 가입은 막는다(가입은 비밀번호 가입으로)
    const { error } = await this.client.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: window.location.origin, shouldCreateUser: false } });
    return error ? fail(error) : { ok: true, message: '메일의 로그인 링크를 이 브라우저에서 열거나, 메일의 인증 코드를 입력하세요. 새 메일을 요청하면 이전 메일은 무효가 됩니다.' };
  }

  async verifyEmailCode(email: string, token: string): Promise<AuthResult> {
    if (!this.client) return { ok: false, message: '클라우드가 설정되지 않았습니다.' };
    const { error } = await this.client.auth.verifyOtp({ email: email.trim(), token: token.trim(), type: 'email' });
    return error ? fail(error) : { ok: true };
  }

  // ---------- 비밀번호 ----------

  /**
   * 로그인한 상태에서 비밀번호 설정·변경. 메일 로그인만 쓰던 기존 사용자도 데이터 그대로 비밀번호를 추가할 수 있다.
   * 프로젝트에서 'Secure password change'가 켜져 있고 최근 로그인이 아니면 reauthentication_needed → requestReauth() 후 nonce 와 함께 다시 호출.
   */
  async setPassword(password: string, nonce?: string): Promise<AuthResult> {
    if (!this.client) return { ok: false, message: '클라우드가 설정되지 않았습니다.' };
    const { error } = await this.client.auth.updateUser(nonce ? { password, nonce } : { password });
    if (error) return fail(error);
    this.set({ recovery: false }, 'USER_UPDATED');
    return { ok: true, message: '비밀번호를 설정했습니다. 다음부터 이메일과 비밀번호로 로그인할 수 있습니다.' };
  }

  /** 재인증 코드 메일 요청 (Secure password change 사용 시) */
  async requestReauth(): Promise<AuthResult> {
    if (!this.client) return { ok: false, message: '클라우드가 설정되지 않았습니다.' };
    const { error } = await this.client.auth.reauthenticate();
    return error ? fail(error) : { ok: true, message: '재인증 코드를 메일로 보냈습니다.' };
  }

  async sendPasswordReset(email: string): Promise<AuthResult> {
    if (!this.client) return { ok: false, message: '클라우드가 설정되지 않았습니다.' };
    const { error } = await this.client.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
    return error ? fail(error) : { ok: true, message: '재설정 메일을 보냈습니다. 메일의 링크를 이 브라우저에서 열면 새 비밀번호를 입력할 수 있습니다.' };
  }

  // ---------- 로그아웃 ----------

  /** 이 기기만 로그아웃. 다른 기기 세션은 유지된다. */
  async signOutThisDevice(): Promise<AuthResult> {
    if (!this.client) return { ok: true };
    this.userSignOut = true;
    const { error } = await this.client.auth.signOut({ scope: 'local' });
    return error ? fail(error) : { ok: true };
  }

  /** 모든 기기에서 로그아웃 (다른 기기는 토큰 갱신 시점에 로그아웃됨, 최대 액세스 토큰 만료 시간) */
  async signOutAllDevices(): Promise<AuthResult> {
    if (!this.client) return { ok: true };
    this.userSignOut = true;
    const { error } = await this.client.auth.signOut({ scope: 'global' });
    return error ? fail(error) : { ok: true };
  }

  clearExpired() {
    this.set({ expired: false }, 'USER_UPDATED');
  }

  /** 재설정 화면을 닫는다 (비밀번호는 바뀌지 않고, 이미 로그인된 상태는 유지) */
  clearRecovery() {
    this.set({ recovery: false }, 'USER_UPDATED');
  }
}

export function useAuthView(auth: AuthController): AuthView {
  const [s, setS] = useState(auth.state);
  useEffect(() => {
    setS(auth.state);
    return auth.subscribe((st) => setS(st));
  }, [auth]);
  return s;
}
