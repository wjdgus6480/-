import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { DomainSnapshot } from '../domain/types';
import type { DomainSyncState } from '../domain/sync';
import type { SyncState } from '../views/sync';
import type { ViewDomain, ViewPreference } from '../views/types';
import type { Services } from './services';

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('ServicesContext missing');
  return s;
}

const EMPTY: DomainSnapshot = { tasks: [], events: [], projects: [], categories: [] };

export function useDomainData(): DomainSnapshot {
  const { domain } = useServices();
  const [data, setData] = useState<DomainSnapshot>(EMPTY);
  useEffect(() => {
    let alive = true;
    const load = () => domain.snapshot().then((d) => alive && setData(d));
    load();
    const off = domain.subscribe(load);
    return () => {
      alive = false;
      off();
    };
  }, [domain]);
  return data;
}

export function useViews(domainKey: ViewDomain) {
  const { views } = useServices();
  const [list, setList] = useState<ViewPreference[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const r = await views.listViews(domainKey);
    if (r.ok) {
      setList(r.value);
      setError(null);
    } else setError(r.error.message);
  }, [views, domainKey]);
  useEffect(() => {
    void reload();
    return views.onChange(() => void reload());
  }, [views, reload]);
  return { list, error, reload };
}

export function useSyncState(): SyncState {
  const { sync } = useServices();
  const [s, setS] = useState(sync.state);
  useEffect(() => {
    const off = sync.subscribe(setS);
    return () => void off();
  }, [sync]);
  return s;
}

export function useDomainSyncState(): DomainSyncState {
  const { domainSync } = useServices();
  const [s, setS] = useState(domainSync.state);
  useEffect(() => {
    const off = domainSync.subscribe(setS);
    return () => void off();
  }, [domainSync]);
  return s;
}

export function useIsMobile(): boolean {
  const query = '(max-width: 640px)';
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  const [m, setM] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

/** 브라우저 저장소 접근은 실패할 수 있으므로 감싼다 (화면 편의용: 마지막으로 연 보기) */
export const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, v: string) {
    try {
      localStorage.setItem(key, v);
    } catch {
      /* ignore */
    }
  },
};
