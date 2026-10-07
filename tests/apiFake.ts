import { vi } from 'vitest';
import { ApiClient, type StoredSession } from '../src/app/api';

/** 메모리 Storage (localStorage 대신) */
export function memoryStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

export type Route = (body: any, init: RequestInit) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

/**
 * 가짜 Spring Boot API. 'POST /api/auth/login' 같은 키로 응답을 정한다. 실제 네트워크 없음.
 * 정해지지 않은 경로는 404. 'offline' 이 켜지면 fetch 자체가 실패한다.
 */
export function fakeApi(routes: Record<string, Route> = {}, opts: { session?: StoredSession | null } = {}) {
  const state = { offline: false };
  const fetchFn = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (state.offline) throw new TypeError('Failed to fetch');
    const path = url.replace('http://api.test', '').split('?')[0];
    const key = `${init.method ?? 'GET'} ${path}`;
    const route = routes[key];
    const r = route ? await route(init.body ? JSON.parse(String(init.body)) : undefined, init) : { status: 404, body: { code: 'not_found', message: 'no route' } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  const storage = memoryStorage(opts.session ? { 'dotday.session': JSON.stringify(opts.session) } : {});
  const api = new ApiClient('http://api.test', storage, fetchFn as unknown as typeof fetch);
  const calls = (key: string) =>
    fetchFn.mock.calls
      .filter(([url, init]) => `${init?.method ?? 'GET'} ${String(url).replace('http://api.test', '').split('?')[0]}` === key)
      .map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : undefined));
  return { api, fetchFn, storage, state, calls };
}

export function storedSession(id = 'user-1', email = 'me@example.com', ttlMs = 3_600_000): StoredSession {
  return { access_token: `token-${id}`, expires_at: new Date(Date.now() + ttlMs).toISOString(), user: { id, email } };
}

export const ok = (body?: unknown) => ({ status: 200, body });
export const noContent = () => ({ status: 204 });
export const err = (status: number, code: string, message = code) => ({ status, body: { code, message } });
