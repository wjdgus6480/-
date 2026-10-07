import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RestDomainRemote } from '../src/domain/remote';
import { ENTITY_FIELDS } from '../src/domain/types';
import { classifyFailure } from '../src/lib/syncPolicy';
import { FIELD_REGISTRY } from '../src/views/fields';
import { RemoteError, RestViewRemote } from '../src/views/remote';
import { err, fakeApi, ok, storedSession } from './apiFake';

const backend = (p: string) => readFileSync(join(process.cwd(), 'backend/src/main/java/com/dotday/sync', p), 'utf8');

describe('REM-001 REST 원격 어댑터 (Spring Boot API 호출 계약)', () => {
  it('업무 데이터: 변경 1건을 POST 하고, 결과 row 의 시각을 클라이언트 표기로 정규화한다', async () => {
    const row = { id: 't1', owner_id: 'u1', version: '2', server_seq: '10', updated_at: '2026-10-02T08:48:24.206+00:00', due_date: '2026-10-09' };
    const f = fakeApi({ 'POST /api/sync/domain/ops': () => ok({ status: 'applied', row }) }, { session: storedSession('u1') });
    const remote = new RestDomainRemote(f.api, () => 'u1');
    const req = { op_id: 'op1', entity: 'tasks' as const, id: 't1', base_version: 1, patch: { title: 'x' } };
    const r = await remote.push(req);
    expect(f.calls('POST /api/sync/domain/ops')[0]).toEqual(req);
    expect(r).toMatchObject({ status: 'applied', row: { version: 2, server_seq: 10, updated_at: '2026-10-02T08:48:24.206Z' } });
    // 토큰은 헤더로 보낸다
    expect((f.fetchFn.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBe('Bearer token-u1');
  });

  it('업무 데이터: 엔티티별 since 커서로 가져온다', async () => {
    const f = fakeApi({ 'GET /api/sync/domain/events': () => ok([{ id: 'e1', owner_id: 'u1', version: 1, server_seq: 7, start_at: '2026-10-02T00:00:00+00:00' }]) }, { session: storedSession('u1') });
    const rows = await new RestDomainRemote(f.api, () => 'u1').pullSince('events', 5, 100);
    expect(String(f.fetchFn.mock.calls[0][0])).toBe('http://api.test/api/sync/domain/events?since=5&limit=100');
    expect(rows[0].start_at).toBe('2026-10-02T00:00:00.000Z');
    await expect(new RestDomainRemote(f.api, () => 'u1').pullSince('users' as never, 0)).rejects.toThrow();
  });

  it('보기 설정: push 와 pull 경로', async () => {
    const f = fakeApi(
      { 'POST /api/sync/views/ops': () => ok({ status: 'conflict', row: { id: 'v1', version: 3, server_seq: 4 } }), 'GET /api/sync/views': () => ok([]) },
      { session: storedSession('u1') },
    );
    const remote = new RestViewRemote(f.api, () => 'u1');
    expect(await remote.push({ op_id: 'o', view_id: 'v1', base_version: 1, patch: {} })).toMatchObject({ status: 'conflict', row: { version: 3 } });
    expect(await remote.pullSince(0)).toEqual([]);
    expect(String(f.fetchFn.mock.calls[1][0])).toBe('http://api.test/api/sync/views?since=0&limit=500');
  });

  it('오류 분류: 연결 실패·502~504(서버 깨어나는 중)는 network, 401 은 auth, 그 밖은 server', async () => {
    const kinds: string[] = [];
    for (const resp of [null, err(503, 'x'), err(401, 'session_not_found'), err(500, 'server_error')]) {
      const f = fakeApi({ 'GET /api/sync/views': () => resp! }, { session: storedSession() });
      if (!resp) f.state.offline = true;
      try {
        await new RestViewRemote(f.api, () => 'user-1').pullSince(0);
      } catch (e) {
        expect(e).toBeInstanceOf(RemoteError);
        kinds.push(classifyFailure(e));
      }
    }
    expect(kinds).toEqual(['network', 'network', 'auth', 'server']);
  });
});

describe('REM-002 서버(Java)와 클라이언트의 허용 필드 일치', () => {
  it('EntitySpec.java 의 필드 목록이 ENTITY_FIELDS 와 같다', () => {
    const src = backend('EntitySpec.java');
    for (const entity of Object.keys(ENTITY_FIELDS) as (keyof typeof ENTITY_FIELDS)[]) {
      const block = src.match(new RegExp(`ALL\\.put\\("${entity}", new EntitySpec\\("\\w+", List\\.of\\(([\\s\\S]*?)\\),\\s*\\n\\s*(?:r ->|EntitySpec::)`));
      expect(block, entity).toBeTruthy();
      const fields = [...block![1].matchAll(/\w+\("(\w+)"/g)].map((m) => m[1]);
      expect(fields, entity).toEqual([...ENTITY_FIELDS[entity]]);
    }
  });

  it('ViewConfigValidator.java 의 허용 필드가 FIELD_REGISTRY 와 같다', () => {
    const src = backend('ViewConfigValidator.java');
    for (const domain of ['tasks', 'events', 'projects'] as const) {
      const m = src.match(new RegExp(`"${domain}", List\\.of\\(([^)]+)\\)`));
      const fields = m![1].split(',').map((s) => s.trim().replace(/"/g, ''));
      expect(fields, domain).toEqual(FIELD_REGISTRY[domain].map((f) => f.key));
    }
  });
});
