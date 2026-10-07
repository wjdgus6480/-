/**
 * 실제 Spring Boot 서버와 붙여 보는 통합 테스트 (평소 npm test 에서는 건너뜀).
 *   1) backend 실행 (README '로컬 개발' 참고)
 *   2) E2E_API_URL=http://localhost:8080 npx vitest run tests/e2e.backend.test.ts
 * 두 기기(같은 계정)와 다른 계정 하나를 만들어, 프론트의 실제 동기화 엔진이 서버를 거쳐 데이터를 주고받는지 확인한다.
 */
import { describe, expect, it } from 'vitest';
import { ApiClient, type StoredSession } from '../src/app/api';
import { openDotdayDB } from '../src/db/idb';
import { RestDomainRemote } from '../src/domain/remote';
import { DomainRepository } from '../src/domain/repo';
import { DomainSyncEngine } from '../src/domain/sync';
import { RestViewRemote } from '../src/views/remote';
import { ViewRepository } from '../src/views/repo';
import { ViewSyncEngine } from '../src/views/sync';
import { memoryStorage } from './apiFake';

const BASE = process.env.E2E_API_URL;

async function device(name: string, auth: { email: string; password: string; signup?: boolean }) {
  const api = new ApiClient(BASE!, memoryStorage(), (...a) => fetch(...a));
  const s = await api.request<StoredSession>('POST', auth.signup ? '/api/auth/signup' : '/api/auth/login', { email: auth.email, password: auth.password });
  api.setSession(s);
  const session = { owner: s.user.id as string | null, ownerId() { return this.owner; }, localProfileId: `e2e-${name}` };
  const db = await openDotdayDB(`e2e-${name}-${Math.random()}`);
  const domain = new DomainRepository(db, () => session.owner);
  const views = new ViewRepository(db, session, domain);
  const domainSync = new DomainSyncEngine(db, domain, () => new RestDomainRemote(api, () => session.owner));
  const viewSync = new ViewSyncEngine(db, views, () => new RestViewRemote(api, () => session.owner));
  return { api, db, domain, views, domainSync, viewSync, userId: s.user.id };
}

describe.skipIf(!BASE)('E2E 실제 서버 동기화', () => {
  // Render 무료 플랜은 요청마다 수백 ms 라 30초 기본 제한으로는 부족하다
  it('같은 계정의 두 기기가 서버를 거쳐 생성·수정을 주고받고, 다른 계정에는 보이지 않는다', async () => {
    const email = `e2e-${Date.now()}@example.com`;
    // 운영 서버에 돌려도 흔적이 남지 않게, 실패해도 만든 테스트 계정은 지운다 (방금 로그인했으므로 재인증 불필요)
    const created: Awaited<ReturnType<typeof device>>[] = [];
    try {
      const a = await device('a', { email, password: 'secret123', signup: true });
      created.push(a);
      const b = await device('b', { email, password: 'secret123' });

      const p = await a.domain.createProject({ name: '통합 테스트 프로젝트' });
      const t = await a.domain.createTask({ title: '서버 거쳐 가는 할 일', project_id: p.id, due_date: '2026-10-09' });
      const ra = await a.domainSync.sync();
      expect(ra, JSON.stringify(ra)).toMatchObject({ ok: true });

      const rb = await b.domainSync.sync();
      expect(rb, JSON.stringify(rb)).toMatchObject({ ok: true });
      const bt = (await b.domain.snapshot()).tasks.find((x) => x.id === t.id);
      expect(bt).toMatchObject({ title: '서버 거쳐 가는 할 일', project_id: p.id, due_date: '2026-10-09' });

      // B 가 고친 것을 A 가 받는다
      await b.domain.updateTask(t.id, { title: 'B 가 고친 제목', status: 'done' });
      await b.domainSync.sync();
      await a.domainSync.sync();
      expect((await a.domain.snapshot()).tasks.find((x) => x.id === t.id)).toMatchObject({ title: 'B 가 고친 제목', status: 'done' });

      // 보기 설정도 동기화된다: A 의 기본 보기(목록을 열 때 생성)가 서버를 거쳐 B 에 보인다
      const av = await a.views.listViews('tasks');
      expect(av.ok).toBe(true);
      const viewName = av.ok ? av.value[0].name : '';
      expect(await a.viewSync.syncViewPreferences()).toMatchObject({ ok: true });
      const pulled = await new RestViewRemote(a.api, () => a.userId).pullSince(0);
      expect(pulled.map((v) => v.name)).toContain(viewName);
      expect(await b.viewSync.syncViewPreferences()).toMatchObject({ ok: true });

      // 다른 계정은 아무것도 받지 못한다
      const c = await device('c', { email: `e2e-other-${Date.now()}@example.com`, password: 'secret123', signup: true });
      created.push(c);
      await c.domainSync.sync();
      expect((await c.domain.snapshot()).tasks.find((x) => x.id === t.id)).toBeUndefined();
      expect(await new RestDomainRemote(c.api, () => c.userId).pullSince('tasks', 0)).toEqual([]);
    } finally {
      for (const d of created) expect(await d.api.request('POST', '/api/account/delete', { confirm: 'DELETE' })).toMatchObject({ status: 'deleted' });
    }
  }, 180_000);
});
