import { RemoteError } from '../lib/remoteError';

/** 로그인 결과로 받은 세션. 브라우저 저장소에 보관해 새로고침·오프라인에서도 로그인 상태를 유지한다. */
export interface StoredSession {
  access_token: string;
  /** ISO 시각. 지나면 서버가 401 을 돌려주므로 시작할 때 미리 만료로 처리한다 */
  expires_at: string;
  user: { id: string; email: string };
}

const STORAGE_KEY = 'dotday.session';

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * DOTDAY REST API(Spring Boot) 클라이언트.
 * - 토큰은 Authorization: Bearer 헤더로만 보낸다.
 * - 토큰을 실어 보낸 요청이 401 이면 세션이 끝난 것(만료·다른 기기에서 모든 기기 로그아웃·탈퇴)으로 보고 onUnauthorized 를 부른다.
 * - fetch 자체가 실패하면(오프라인·서버 잠듦) network 오류로 분류한다.
 */
export class ApiClient {
  onUnauthorized: (() => void) | null = null;
  private session: StoredSession | null;

  constructor(
    readonly baseUrl: string,
    private storage: Storage | null = defaultStorage(),
    private fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {
    this.session = this.load();
  }

  getSession(): StoredSession | null {
    return this.session;
  }

  setSession(s: StoredSession | null) {
    this.session = s;
    try {
      if (s) this.storage?.setItem(STORAGE_KEY, JSON.stringify(s));
      else this.storage?.removeItem(STORAGE_KEY);
    } catch {
      // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 이번 실행 동안만 유지한다
    }
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const token = this.session?.access_token;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new RemoteError(e instanceof Error ? e.message : 'network error', 'network', undefined, 0);
    }
    const text = await res.text();
    let data: any = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (res.ok) return data as T;
    const code: string | undefined = data?.code;
    const message: string = data?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) {
      // 토큰 없이 보낸 요청의 401 은 세션 만료가 아니다
      if (token && this.session?.access_token === token) this.onUnauthorized?.();
      throw new RemoteError(message, 'auth', code ?? 'session_not_found', 401);
    }
    // 502·503·504: Render 무료 플랜이 깨어나는 중이거나 일시 장애 → 네트워크 오류처럼 나중에 다시 시도
    if (res.status === 502 || res.status === 503 || res.status === 504) throw new RemoteError(message, 'network', code, res.status);
    throw new RemoteError(message, 'server', code, res.status);
  }

  private load(): StoredSession | null {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw) as StoredSession;
      return s?.access_token && s.user?.id ? s : null;
    } catch {
      return null;
    }
  }
}
