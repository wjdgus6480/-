import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Task } from '../src/domain/types';
import { makeDevice, makeServer, serverQuery, USER_A } from './helpers';

let server: PGlite;
beforeAll(async () => {
  server = await makeServer();
});

describe('SEC-001 직접 테이블 쓰기 보호 (Q-01)', () => {
  it('RPC 를 거치지 않은 직접 UPDATE 도 version·server_seq 가 올라 다른 기기에 전달된다', async () => {
    const pc = await makeDevice({ owner: USER_A, server, name: 'pc' });
    const mobile = await makeDevice({ owner: USER_A, server, name: 'm' });
    const t = await pc.domain.createTask({ title: '원본' });
    await pc.domainSync.sync();
    await mobile.domainSync.sync();
    const [before] = await serverQuery(server, USER_A, 'select version, server_seq from public.tasks where id = $1', [t.id]);
    // 클라이언트가 version 을 낮추고 owner/created_at 을 바꾸려 해도 서버가 무시
    await serverQuery(server, USER_A, `update public.tasks set title = '직접 수정', version = 1 where id = $1`, [t.id]);
    const [after] = await serverQuery(server, USER_A, 'select title, version, server_seq from public.tasks where id = $1', [t.id]);
    expect(after.version).toBe(before.version + 1);
    expect(Number(after.server_seq)).toBeGreaterThan(Number(before.server_seq));
    await mobile.domainSync.sync();
    expect((await mobile.domain.get<Task>('tasks', t.id))!.title).toBe('직접 수정');
  });

  it('직접 DELETE(tombstone 없는 삭제)는 거부된다', async () => {
    const pc = await makeDevice({ owner: USER_A, server, name: 'pc2' });
    const p = await pc.domain.createProject({ name: 'P' });
    await pc.domainSync.sync();
    for (const tbl of ['projects', 'tasks', 'events', 'categories', 'view_preferences']) {
      await expect(serverQuery(server, USER_A, `delete from public.${tbl} where true`), tbl).rejects.toThrow(/permission denied/);
    }
    expect((await serverQuery(server, USER_A, 'select count(*)::int n from public.projects where id = $1', [p.id]))[0].n).toBe(1);
  });

  it('직접 INSERT 는 version 1·새 server_seq 로 강제된다', async () => {
    const id = crypto.randomUUID();
    await serverQuery(server, USER_A, `insert into public.projects (id, owner_id, name, version, server_seq) values ($1, $2, 'x', 99, 1)`, [id, USER_A]);
    const [r] = await serverQuery(server, USER_A, 'select version, server_seq from public.projects where id = $1', [id]);
    expect(r.version).toBe(1);
    expect(Number(r.server_seq)).toBeGreaterThan(1);
  });

  it('보기 설정도 직접 UPDATE 시 version 이 오른다', async () => {
    const d = await makeDevice({ owner: USER_A, server, name: 'v' });
    const l = await d.views.listViews('tasks');
    await d.sync.syncViewPreferences();
    const id = l.ok ? l.value[0].id : '';
    await serverQuery(server, USER_A, `update public.view_preferences set name = '직접' where id = $1`, [id]);
    const [r] = await serverQuery(server, USER_A, 'select version from public.view_preferences where id = $1', [id]);
    expect(r.version).toBe(2);
  });
});
