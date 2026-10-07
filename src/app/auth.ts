import { useEffect, useState } from 'react';
import { RemoteError } from '../lib/remoteError';
import type { ApiClient, StoredSession } from './api';

/** 화면에 보여 줄 인증 상태 (React 상태로 구독) */
export interface AuthView {
  userId: string | null;
  email: string | null;
  /** 사용자가 직접 하지 않은 로그아웃 (세션 만료·다른 기기의 전체 로그아웃 등) */
  expired: boolean;
}

export type AuthEvent = 'INIT' | 'SIGNED_IN' | 'SIGNED_OUT' | 'USER_UPDATED' | 'TOKEN_REFRESHED';

/** handle() 에 넘기는 세션 모양 (서버 응답의 user 부분) */
export interface AuthSession {
  user: { id: string; email?: string | null };
}

export type AuthResult = { ok: true; message?: string } | { ok: false; message: string; code?: string };

const NO_CLOUD: AuthResult = { ok: false, message: '서버가 설정되지 않았습니다.' };

const KO: Record<string, string> = {
  invalid_credentials: '이메일 또는 비밀번호가 맞지 않습니다.',
  weak_password: '비밀번호가 너무 약합니다 (6자 이상).',
  same_password: '이전과 같은 비밀번호입니다.',
  user_already_exists: '이미 가입된 이메일입니다. 로그인하세요.',
  over_request_rate_limit: '로그인 시도가 너무 많습니다. 15분 뒤 다시 시도하세요.',
  email_address_invalid: '사용할 수 없는 이메일 주소입니다.',
  session_not_found: '로그인 세션이 만료되었습니다. 다시 로그인하세요.',
};

function fail(e: unknown): AuthResult {
  if (e instanceof RemoteError) {
    if (e.kind === 'network') return { ok: false, code: 'network', message: '서버에 연결하지 못했습니다. 인터넷 연결을 확인하거나, 서버가 깨어나는 중이면 30초~1분 뒤 다시 시도하세요.' };
    return { ok: false, code: e.code, message: (e.code && KO[e.code]) || e.message || '알 수 없는 오류' };
  }
  return { ok: false, message: e instanceof Error ? e.message : '알 수 없는 오류' };
}

/**
 * Spring Boot 인증 API 래퍼.
 * - 기본 로그아웃은 이 기기만. 전체 기기 로그아웃은 서버가 이 계정의 모든 세션을 끊는다(다른 기기는 다음 요청에서 401).
 * - 인증 이벤트를 하나의 상태로 모아 React 에 즉시 반영한다.
 * - 로그아웃·만료 시 기기 데이터와 미전송 대기열은 건드리지 않는다(이 클래스는 저장소에 접근하지 않음).
 */
export class AuthController {
  state: AuthView = { userId: null, email: null, expired: false };
  private listeners = new Set<(s: AuthView, event: AuthEvent) => void>();
  private userSignOut = false;

  constructor(readonly api: ApiClient | null) {
    if (api) {
      // 토큰을 실은 요청이 401 → 서버에서 세션이 끝남 (만료·다른 기기의 전체 로그아웃·탈퇴)
      api.onUnauthorized = () => {
        if (!this.state.userId) return;
        api.setSession(null);
        this.handle('SIGNED_OUT', null);
      };
    }
  }

  /** 시작 시 저장된 세션으로 초기 상태를 만든다. 만료 시각이 지났으면 만료 안내와 함께 로그아웃 상태로 시작한다. */
  init() {
    const s = this.api?.getSession() ?? null;
    if (s && Date.parse(s.expires_at) <= Date.now()) {
      this.api?.setSession(null);
      this.set({ userId: null, email: null, expired: true }, 'INIT');
      return;
    }
    this.set({ userId: s?.user.id ?? null, email: s?.user.email ?? null, expired: false }, 'INIT');
  }

  /**
   * 저장된 세션이 서버에서 아직 유효한지 확인한다 (앱 시작 후 백그라운드).
   * 오프라인이면 그대로 둔다 → 로컬 우선: 인터넷이 없어도 로그인 상태로 계속 쓸 수 있다.
   */
  async verify(): Promise<void> {
    if (!this.api?.getSession()) return;
    try {
      await this.api.request('GET', '/api/auth/me');
    } catch {
      // 401 은 onUnauthorized 가 처리, 네트워크 오류는 무시
    }
  }

  subscribe(fn: (s: AuthView, event: AuthEvent) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private set(p: Partial<AuthView>, event: AuthEvent) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((fn) => fn(this.state, event));
  }

  /** 인증 상태 변경을 반영한다 (테스트에서 직접 호출 가능) */
  handle(event: AuthEvent, session: AuthSession | null) {
    if (event === 'SIGNED_OUT') {
      const wasIn = !!this.state.userId;
      this.set({ userId: null, email: null, expired: wasIn && !this.userSignOut }, event);
      this.userSignOut = false;
      return;
    }
    if (!session) return;
    this.set({ userId: session.user.id, email: session.user.email ?? null, expired: false }, event);
  }

  // ---------- 로그인 ----------

  async signInWithPassword(email: string, password: string): Promise<AuthResult> {
    return this.startSession('/api/auth/login', email, password);
  }

  /** 가입하면 바로 로그인된다 (1단계: 메일 인증 없음) */
  async signUp(email: string, password: string): Promise<AuthResult> {
    const r = await this.startSession('/api/auth/signup', email, password);
    return r.ok ? { ok: true, message: '가입되었습니다.' } : r;
  }

  private async startSession(path: string, email: string, password: string): Promise<AuthResult> {
    if (!this.api) return NO_CLOUD;
    try {
      const s = await this.api.request<StoredSession>('POST', path, { email: email.trim(), password });
      this.api.setSession(s);
      this.handle('SIGNED_IN', s);
      return { ok: true };
    } catch (e) {
      return fail(e);
    }
  }

  // ---------- 탈퇴 ----------

  /** 탈퇴 전 재인증. 성공하면 서버의 '최근 로그인 시각'이 갱신된다. */
  async reauthenticateWithPassword(password: string): Promise<AuthResult> {
    if (!this.api) return NO_CLOUD;
    try {
      await this.api.request('POST', '/api/auth/reauth', { password });
      return { ok: true };
    } catch (e) {
      return fail(e);
    }
  }

  /**
   * 본인 계정 탈퇴. 서버가 토큰의 사용자만 지운다 (사용자 ID 를 보내지 않음).
   * 성공 후 이 기기의 데이터 정리와 로그아웃은 호출한 쪽에서 한다.
   */
  async deleteAccount(): Promise<AuthResult> {
    if (!this.api) return NO_CLOUD;
    let r: { status?: string; reason?: string };
    try {
      r = (await this.api.request<{ status?: string; reason?: string }>('POST', '/api/account/delete', { confirm: 'DELETE' })) ?? {};
    } catch (e) {
      return fail(e);
    }
    if (r.status === 'deleted') return { ok: true, message: '탈퇴가 완료되었습니다. 서버의 계정과 데이터를 삭제했습니다.' };
    if (r.status === 'reauth_required') return { ok: false, code: 'reauth_required', message: '보안을 위해 비밀번호를 다시 입력한 뒤 탈퇴하세요 (최근 10분 안의 로그인이 필요합니다).' };
    if (r.reason === 'admin_account') return { ok: false, code: 'admin_account', message: '관리자 계정은 관리자 지정을 먼저 해제해야 탈퇴할 수 있습니다.' };
    return { ok: false, code: r.status ?? 'unknown', message: '탈퇴를 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.' };
  }

  // ---------- 비밀번호 ----------

  /** 로그인한 상태에서 비밀번호 변경 (현재 비밀번호 확인) */
  async changePassword(currentPassword: string, newPassword: string): Promise<AuthResult> {
    if (!this.api) return NO_CLOUD;
    try {
      await this.api.request('PUT', '/api/auth/password', { current_password: currentPassword, new_password: newPassword });
      return { ok: true, message: '비밀번호를 변경했습니다.' };
    } catch (e) {
      return fail(e);
    }
  }

  // ---------- 로그아웃 ----------

  /** 이 기기만 로그아웃. 다른 기기 세션은 유지된다. 서버에 닿지 못해도(오프라인) 이 기기에서는 로그아웃한다. */
  async signOutThisDevice(): Promise<AuthResult> {
    if (!this.api) return { ok: true };
    this.userSignOut = true;
    try {
      await this.api.request('POST', '/api/auth/logout');
    } catch {
      // 오프라인이거나 이미 끊긴 세션 → 이 기기의 토큰만 지우면 된다
    }
    this.api.setSession(null);
    if (this.state.userId) this.handle('SIGNED_OUT', null);
    else this.userSignOut = false;
    return { ok: true };
  }

  /** 모든 기기에서 로그아웃. 서버가 세션을 끊어야 하므로 연결되지 않으면 실패로 안내한다. */
  async signOutAllDevices(): Promise<AuthResult> {
    if (!this.api) return { ok: true };
    this.userSignOut = true;
    try {
      await this.api.request('POST', '/api/auth/logout-all');
    } catch (e) {
      this.userSignOut = false;
      // 이미 세션이 끝났다면(401) onUnauthorized 가 로그아웃 처리했다
      if (!(e instanceof RemoteError && e.kind === 'auth')) return fail(e);
    }
    this.api.setSession(null);
    if (this.state.userId) this.handle('SIGNED_OUT', null);
    else this.userSignOut = false;
    return { ok: true };
  }

  clearExpired() {
    this.set({ expired: false }, 'USER_UPDATED');
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
