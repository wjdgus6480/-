import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateLocalDataToAccount, previewLocalDataMigration } from '../src/domain/migrate';
import type { Task } from '../src/domain/types';
import { migrateLocalViewsToAccount } from '../src/views/migrate';
import { domainDump, makeDevice, makeServer, serverQuery, USER_A, USER_B } from './helpers';

let server: PGlite;
beforeAll(async () => {
  server = await makeServer();
});
beforeEach(async () => {
  await server.exec('delete from public.domain_ops; delete from public.tasks; delete from public.events; delete from public.projects; delete from public.categories; delete from public.view_preference_ops; delete from public.view_preferences;');
});

async function guestWithData() {
  const dev = await makeDevice({ owner: null, server, name: 'guest' });
  const p = await dev.domain.createProject({ name: '로컬 프로젝트' });
  const gone = await dev.domain.createCategory({ name: '지운 분류' });
  const c = await dev.domain.createCategory({ name: '분류' });
  await dev.domain.createTask({ title: '작업1', project_id: p.id, category_id: c.id });
  await dev.domain.createTask({ title: '작업2', category_id: gone.id });
  await dev.domain.softDelete('categories', gone.id); // 삭제됐지만 작업2 가 참조
  const t3 = await dev.domain.createTask({ title: '휴지통 작업' });
  await dev.domain.softDelete('tasks', t3.id); // 참조되지 않는 삭제 항목 → 이전 안 함
  const m = await dev.domain.createEvent({ title: '반복', start_at: '2026-10-05T00:00:00.000Z', end_at: '2026-10-05T01:00:00.000Z', timezone: 'Asia/Seoul', recurrence_rule: 'FREQ=DAILY;COUNT=3' });
  await dev.domain.cancelOccurrence(m.id, '2026-10-06T00:00:00.000Z');
  await dev.views.listViews('tasks');
  return { dev, p, gone, m };
}

describe('MIG-001 미리보기·백업·이전·서버 재검증·별도 보고', () => {
  it('이전 대상 종류·건수를 미리 보여주고, 성공 시 서버에서 다시 읽어 검증한다', async () => {
    const { dev } = await guestWithData();
    const preview = await previewLocalDataMigration(dev.db);
    expect(preview).toEqual({ counts: { projects: 1, categories: 2, events: 2, tasks: 2 }, total: 7, referencedDeleted: 1 });
    // 로그인 전에는 업무 동기화가 서버로 보내지 않는다
    expect((await dev.domainSync.sync()).ok && dev.domainSync.state.status).toBe('local-only');
    expect(await serverQuery(server, USER_A, 'select * from public.tasks')).toEqual([]);

    dev.session.owner = USER_A;
    const r = await migrateLocalDataToAccount(dev.db, dev.domainRemote!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ total: 7, created: { projects: 1, categories: 2, events: 2, tasks: 2 }, same: 0, serverKept: 0, verifiedTotal: 7, mismatches: [] });
    const backup = await dev.db.get('domain_backups', r.value.backupId!);
    expect(backup!.owner_id).toBeNull();
    expect(backup!.data.tasks.map((t) => t.title).sort()).toEqual(['작업1', '작업2', '휴지통 작업']);
    const srv = await serverQuery(server, USER_A, 'select title from public.tasks order by title');
    expect(srv.map((x) => x.title)).toEqual(['작업1', '작업2']);
    // 로컬은 계정 소유로 바뀌고 동기화 상태가 기록되어, 이후 동기화에서 다시 보내지 않는다
    const snap = await dev.domain.snapshot();
    expect(snap.tasks.every((t) => t.owner_id === USER_A && t._sync?.server_version === 1)).toBe(true);
    const s = await dev.domainSync.sync();
    expect(s.ok && s.value).toMatchObject({ pushed: 0, conflicts: 0 });

    // 보기 설정 이전은 별도 기능이며 별도 결과를 낸다
    dev.session.owner = USER_A;
    const v = await migrateLocalViewsToAccount(dev.db, dev.remote!);
    expect(v.ok && v.value.total).toBe(1);
  });
});

describe('MIG-002 이전 실패 시 로컬 유지와 재시도', () => {
  it('중간에 연결이 끊기면 로컬 원본이 그대로이고, 다시 시도하면 중복 없이 이어서 완료된다', async () => {
    const { dev } = await guestWithData();
    const before = await domainDump(dev.db);
    dev.session.owner = USER_A;
    dev.domainRemote!.failOnEntity = 'events'; // 프로젝트·분류는 올라간 뒤 실패
    const r1 = await migrateLocalDataToAccount(dev.db, dev.domainRemote!);
    expect(!r1.ok && r1.error.code).toBe('REMOTE_UNAVAILABLE');
    expect(await domainDump(dev.db)).toEqual(before);
    expect((await serverQuery(server, USER_A, 'select count(*)::int n from public.projects'))[0].n).toBe(1);
    dev.session.owner = null;
    expect((await dev.domain.snapshot()).tasks).toHaveLength(2); // 로그인 전 화면에서 그대로 보임

    dev.session.owner = USER_A;
    dev.domainRemote!.failOnEntity = null;
    const r2 = await migrateLocalDataToAccount(dev.db, dev.domainRemote!);
    expect(r2.ok && r2.value).toMatchObject({ total: 7, verifiedTotal: 7 });
    for (const t of ['projects', 'categories', 'events', 'tasks']) {
      const [{ n }] = await serverQuery(server, USER_A, `select count(*)::int n from public.${t}`);
      expect(n, t).toBe({ projects: 1, categories: 2, events: 2, tasks: 2 }[t]);
    }
    // 같은 백업을 재사용(첫 시도 때 만든 백업 1개)
    expect((await dev.db.getAll('domain_backups')).filter((b) => b.reason === 'migration')).toHaveLength(1);
  });

  it('네트워크가 처음부터 없으면 아무것도 바꾸지 않는다', async () => {
    const { dev } = await guestWithData();
    const before = await domainDump(dev.db);
    dev.session.owner = USER_A;
    dev.online = false;
    const r = await migrateLocalDataToAccount(dev.db, dev.domainRemote!);
    expect(!r.ok && r.error.code).toBe('REMOTE_UNAVAILABLE');
    expect(await domainDump(dev.db)).toEqual(before);
  });
});

describe('MIG-004 이전 도중 수정·중복 실행 (Q-02)', () => {
  it('업로드 중에 사용자가 고친 내용은 로컬 교체 때 사라지지 않고 이후 동기화로 서버에 반영된다', async () => {
    const { dev } = await guestWithData();
    const t1 = (await dev.domain.snapshot()).tasks.find((t) => t.title === '작업1')!;
    dev.session.owner = USER_A;
    const remote = dev.domainRemote!;
    const origPush = remote.push.bind(remote);
    let edited = false;
    remote.push = async (req) => {
      const r = await origPush(req);
      if (!edited && req.entity === 'tasks') {
        edited = true;
        // 이전 중에도 로그인 전 화면에서 편집 중이던 상황 (owner 는 아직 null)
        dev.session.owner = null;
        await dev.domain.updateTask(t1.id, { title: '이전 중 수정' });
        dev.session.owner = USER_A;
      }
      return r;
    };
    const r = await migrateLocalDataToAccount(dev.db, remote);
    expect(r.ok).toBe(true);
    expect((await dev.domain.get<Task>('tasks', t1.id))!.title).toBe('이전 중 수정');
    remote.push = origPush;
    await dev.domainSync.sync();
    expect((await serverQuery(server, USER_A, 'select title from public.tasks where id = $1', [t1.id]))[0].title).toBe('이전 중 수정');
  });

  it('동시에 두 번 실행해도 한 번만 진행된다', async () => {
    const { dev } = await guestWithData();
    dev.session.owner = USER_A;
    const [a, b] = await Promise.all([migrateLocalDataToAccount(dev.db, dev.domainRemote!), migrateLocalDataToAccount(dev.db, dev.domainRemote!)]);
    expect(a).toEqual(b);
    expect((await dev.db.getAll('domain_backups')).filter((x) => x.reason === 'migration')).toHaveLength(1);
    expect((await serverQuery(server, USER_A, 'select count(*)::int n from public.tasks'))[0].n).toBe(2);
  });
});

describe('MIG-003 같은 ID 처리 규칙과 계정 분리', () => {
  it('서버에 같은 ID·같은 내용이면 건너뛰고, 다른 내용이면 서버 값을 유지하며 로컬 값은 백업에 남긴다', async () => {
    const { dev } = await guestWithData();
    const file = await dev.domain.exportData();
    // 다른 기기(같은 계정)에 같은 데이터를 가져와 먼저 올리고, 한 작업 제목만 바꿔 둔다
    const other = await makeDevice({ owner: USER_A, server, name: 'other' });
    await other.domain.importData(JSON.stringify(file));
    const t1 = (await other.domain.snapshot()).tasks.find((t) => t.title === '작업1')!;
    await other.domain.updateTask(t1.id, { title: '작업1(서버 수정)' });
    await other.domainSync.sync();

    dev.session.owner = USER_A;
    const r = await migrateLocalDataToAccount(dev.db, dev.domainRemote!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.serverKept).toBe(1);
    expect(r.value.same).toBe(6); // 나머지 6건(참조된 삭제 분류 포함)은 서버와 동일
    expect(r.value.total).toBe(7);
    expect((await dev.domain.get<Task>('tasks', t1.id))!.title).toBe('작업1(서버 수정)');
    const backup = await dev.db.get('domain_backups', r.value.backupId!);
    expect(backup!.data.tasks.find((t) => t.id === t1.id)!.title).toBe('작업1');
  });

  it('A 로 이전한 뒤 같은 기기에서 B 로 로그인하면 A 데이터가 보이지도, B 로 올라가지도 않는다', async () => {
    const { dev } = await guestWithData();
    dev.session.owner = USER_A;
    await migrateLocalDataToAccount(dev.db, dev.domainRemote!);
    dev.session.owner = USER_B;
    expect(await previewLocalDataMigration(dev.db)).toMatchObject({ total: 0 });
    const r = await migrateLocalDataToAccount(dev.db, dev.domainRemote!);
    expect(r.ok && r.value.total).toBe(0);
    expect(await dev.domain.snapshot()).toEqual({ tasks: [], events: [], projects: [], categories: [] });
    await dev.domain.createTask({ title: 'B 작업' });
    await dev.domainSync.sync();
    expect((await serverQuery(server, USER_B, 'select title from public.tasks')).map((x) => x.title)).toEqual(['B 작업']);
    expect((await serverQuery(server, USER_A, 'select title from public.tasks order by title')).map((x) => x.title)).toEqual(['작업1', '작업2']);
  });
});
