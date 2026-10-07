import { describe, expect, it } from 'vitest';
import type { Task } from '../src/domain/types';
import { makeDevice, makeServer, USER_A, USER_B } from './helpers';

/** 0006(최소 권한)·0007 까지 적용된 서버에서 기존 동기화가 그대로 동작하는지 (PC·iPhone 역할의 두 기기) */
describe('PUB-SYNC-001 권한 강화 후 동기화 회귀', () => {
  it('오프라인에서 생성·수정·삭제 → 온라인 복구 → 다른 기기에 같은 결과', async () => {
    const server = await makeServer();
    const pc = await makeDevice({ owner: USER_A, server, name: 'pc' });
    const phone = await makeDevice({ owner: USER_A, server, name: 'iphone' });
    const keep = await pc.domain.createTask({ title: '유지' });
    const gone = await pc.domain.createTask({ title: '삭제 예정' });
    const p = await pc.domain.createProject({ name: '프로젝트' });
    expect((await pc.domainSync.sync()).ok).toBe(true);
    await phone.domainSync.sync();

    phone.online = false;
    const created = await phone.domain.createTask({ title: '오프라인 생성', project_id: p.id });
    await phone.domain.updateTask(keep.id, { title: '오프라인 수정' });
    await phone.domain.softDelete('tasks', gone.id);
    expect((await phone.domainSync.sync()).ok).toBe(false);
    expect(await phone.db.count('domain_outbox')).toBe(3);

    phone.online = true;
    expect((await phone.domainSync.sync()).ok).toBe(true);
    expect(await phone.db.count('domain_outbox')).toBe(0);
    await pc.domainSync.sync();
    const tasks = (await pc.domain.snapshot()).tasks;
    expect(tasks.map((t) => t.title).sort()).toEqual(['오프라인 생성', '오프라인 수정']);
    expect((await pc.domain.get<Task>('tasks', created.id))!.project_id).toBe(p.id);
  });

  it('응답 유실 후 재전송해도 한 번만 반영되고(멱등), 다른 회원 기기에는 아무것도 내려가지 않는다', async () => {
    const server = await makeServer();
    const a = await makeDevice({ owner: USER_A, server, name: 'a' });
    const b = await makeDevice({ owner: USER_B, server, name: 'b' });
    const t = await a.domain.createTask({ title: '한 번만' });
    a.domainRemote!.dropNextResponse = true;
    expect((await a.domainSync.sync()).ok).toBe(false);
    expect((await a.domainSync.sync()).ok).toBe(true);
    const rows = (await server.query<{ version: number }>('select version from public.tasks where id = $1', [t.id])).rows;
    expect(rows).toEqual([{ version: 1 }]);
    await b.domainSync.sync();
    expect((await b.domain.snapshot()).tasks).toEqual([]);
  });
});
