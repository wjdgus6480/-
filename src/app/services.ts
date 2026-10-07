import { ApiClient } from './api';
import { AuthController } from './auth';
import { getMeta, openDotdayDB, setMeta, type DB } from '../db/idb';
import { RestDomainRemote, type DomainRemote } from '../domain/remote';
import { DomainRepository } from '../domain/repo';
import { DomainSyncEngine } from '../domain/sync';
import { uuid } from '../lib/util';
import { RestViewRemote, type ViewRemote } from '../views/remote';
import { ViewRepository } from '../views/repo';
import { ViewSyncEngine } from '../views/sync';

export interface Services {
  db: DB;
  domain: DomainRepository;
  views: ViewRepository;
  /** 보기 설정 동기화 */
  sync: ViewSyncEngine;
  /** 업무 데이터 동기화 (보기 설정과 별개) */
  domainSync: DomainSyncEngine;
  session: { owner: string | null; email: string | null; ownerId(): string | null; localProfileId: string };
  /** Spring Boot API 클라이언트. VITE_API_URL 이 비어 있으면 null → 로컬 전용 모드 */
  api: ApiClient | null;
  /** 인증 상태·로그인·로그아웃 (React 에는 useAuthView 로 연결) */
  auth: AuthController;
  remote: ViewRemote | null;
  domainRemote: DomainRemote | null;
}

/** 'https://api.example.com/' → 'https://api.example.com' */
export function normalizeApiUrl(url: string | undefined): string | null {
  const u = url?.trim().replace(/\/+$/, '');
  return u ? u : null;
}

export async function createServices(dbName = 'dotday'): Promise<Services> {
  const db = await openDotdayDB(dbName);
  let profile = await getMeta<string>(db, 'local_profile_id');
  if (!profile) {
    profile = uuid();
    await setMeta(db, 'local_profile_id', profile);
  }
  const session = {
    owner: null as string | null,
    email: null as string | null,
    ownerId() {
      return this.owner;
    },
    localProfileId: profile,
  };
  // 브라우저 번들에는 API 주소만 들어간다 (DB 접속 정보·JWT 비밀 키는 서버 환경변수에만)
  const baseUrl = normalizeApiUrl(import.meta.env.VITE_API_URL as string | undefined);
  const api = baseUrl ? new ApiClient(baseUrl) : null;
  const auth = new AuthController(api);
  // 인증 상태가 바뀌면 저장소가 쓰는 owner 를 먼저 맞춘다 (구독 순서상 화면 갱신보다 앞)
  auth.subscribe((st) => {
    session.owner = st.userId;
    session.email = st.email;
  });
  auth.init();
  void auth.verify();
  const remote = api ? new RestViewRemote(api, () => session.owner) : null;
  const domainRemote = api ? new RestDomainRemote(api, () => session.owner) : null;
  const domain = new DomainRepository(db, () => session.owner);
  const views = new ViewRepository(db, session, domain);
  const sync = new ViewSyncEngine(db, views, () => remote);
  const domainSync = new DomainSyncEngine(db, domain, () => domainRemote);
  return { db, domain, views, sync, domainSync, session, api, auth, remote, domainRemote };
}
