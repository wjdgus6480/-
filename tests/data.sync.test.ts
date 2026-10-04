import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENTITY_FIELDS, type CalendarEvent, type Task } from '../src/domain/types';
import { expandEvents } from '../src/domain/recurrence';
import { RemoteError } from '../src/views/remote';
import { makeDevice, makeServer, serverQuery, USER_A, USER_B, type Device } from './helpers';

let server: PGlite;
beforeAll(async () => {
  server = await makeServer();
});
beforeEach(async () => {
  await server.exec('delete from public.domain_ops; delete from public.tasks; delete from public.events; delete from public.projects; delete from public.categories;');
});

const rows = (sql: string, params: unknown[] = [], user = USER_A) => serverQuery(server, user, sql, params);
async function ok(dev: Device) {
  const r = await dev.domainSync.sync();
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
async function pcAndMobile() {
  const pc = await makeDevice({ owner: USER_A, server, name: 'pc' });
  const mobile = await makeDevice({ owner: USER_A, server, name: 'mobile' });
  return { pc, mobile };
}

describe('SYNC-001 PC·모바일 양방향 동기화', () => {
  it('PC 에서 만든 프로젝트·분류·일정·작업이 모바일에 오고, 모바일 수정이 PC 로 돌아간다', async () => {
    const { pc, mobile } = await pcAndMobile();
    const p = await pc.domain.createProject({ name: '알파' });
    const c = await pc.domain.createCategory({ name: '업무', color: '#2563eb' });
    const t = await pc.domain.createTask({ title: '보고서', project_id: p.id, category_id: c.id, due_date: '2026-10-09' });
    const e = await pc.domain.createEvent({ title: '회의', start_at: '2026-10-05T01:00:00.000Z', end_at: '2026-10-05T02:00:00.000Z', timezone: 'Asia/Seoul', recurrence_rule: 'FREQ=WEEKLY;COUNT=4', project_id: p.id });
    expect((await ok(pc)).pushed).toBe(4);
    expect(await pc.db.getAll('domain_outbox')).toHaveLength(0);
    expect((await ok(mobile)).pulled).toBe(4);
    const ms = await mobile.domain.snapshot();
    expect(ms.tasks[0]).toMatchObject({ id: t.id, title: '보고서', project_id: p.id, due_date: '2026-10-09', owner_id: USER_A });
    expect(ms.events[0]).toMatchObject({ id: e.id, recurrence_rule: 'FREQ=WEEKLY;COUNT=4', start_at: e.start_at });
    // 서버 값과 비교해 정확히 같은 동기화 필드
    for (const f of ENTITY_FIELDS.tasks) expect((ms.tasks[0] as any)[f], f).toEqual((t as any)[f]);

    await mobile.domain.updateTask(t.id, { status: 'done' });
    await ok(mobile);
    await ok(pc);
    const back = await pc.domain.get<Task>('tasks', t.id);
    expect(back).toMatchObject({ status: 'done', version: 2 });
    expect(back!.completed_at).toBeTruthy();
    // 다시 동기화해도 변화 없음 (거짓 충돌·불필요한 전송 없음)
    const again = await ok(pc);
    expect(again).toMatchObject({ pushed: 0, conflicts: 0, merged: 0 });
  });

  it('회차 예외(단일 회차 변경·취소)도 동기화된다', async () => {
    const { pc, mobile } = await pcAndMobile();
    const m = await pc.domain.createEvent({ title: '데일리', start_at: '2026-10-05T00:00:00.000Z', end_at: '2026-10-05T00:15:00.000Z', timezone: 'Asia/Seoul', recurrence_rule: 'FREQ=DAILY;COUNT=3' });
    await pc.domain.cancelOccurrence(m.id, '2026-10-06T00:00:00.000Z');
    await ok(pc);
    await ok(mobile);
    const occ = expandEvents((await mobile.domain.snapshot()).events, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
    expect(occ.map((o) => o.start_at)).toEqual(['2026-10-05T00:00:00.000Z', '2026-10-07T00:00:00.000Z']);
  });
});

describe('SYNC-002 오프라인 편집 후 재접속', () => {
  it('오프라인 변경은 로컬에 저장되고 큐에 남았다가 재접속 시 전송된다. 실패해도 로컬 데이터는 보존', async () => {
    const { pc, mobile } = await pcAndMobile();
    const t = await pc.domain.createTask({ title: '초안' });
    await ok(pc);
    pc.online = false;
    await pc.domain.updateTask(t.id, { title: '오프라인 수정' });
    await pc.domain.createTask({ title: '오프라인 새 작업' });
    const r = await pc.domainSync.sync();
    expect(r.ok).toBe(false);
    expect(pc.domainSync.state.status).toBe('offline');
    expect((await pc.domain.snapshot()).tasks.map((x) => x.title).sort()).toEqual(['오프라인 새 작업', '오프라인 수정']);
    expect((await pc.db.getAll('domain_outbox')).length).toBe(2);
    pc.online = true;
    expect((await ok(pc)).pushed).toBe(2);
    await ok(mobile);
    expect((await mobile.domain.snapshot()).tasks.map((x) => x.title).sort()).toEqual(['오프라인 새 작업', '오프라인 수정']);
  });
});

describe('SYNC-003 서버 응답 유실과 재시도 (멱등성)', () => {
  it('응답이 유실되어 같은 op_id 로 다시 보내도 한 번만 반영된다', async () => {
    const { pc } = await pcAndMobile();
    const t = await pc.domain.createTask({ title: 'A' });
    await ok(pc);
    await pc.domain.updateTask(t.id, { title: 'B' });
    pc.domainRemote!.dropNextResponse = true;
    expect((await pc.domainSync.sync()).ok).toBe(false);
    const [op] = await pc.db.getAll('domain_outbox');
    await ok(pc);
    expect(pc.domainRemote!.pushCalls.filter((c) => c.op_id === op.op_id)).toHaveLength(2);
    const [row] = await rows('select title, version from public.tasks');
    expect(row).toEqual({ title: 'B', version: 2 });
    expect((await rows('select count(*)::int n from public.domain_ops where op_id = $1', [op.op_id]))[0].n).toBe(1);
  });
  it('생성 op 재전송도 중복 행을 만들지 않는다', async () => {
    const { pc } = await pcAndMobile();
    await pc.domain.createProject({ name: 'P' });
    pc.domainRemote!.dropNextResponse = true;
    await pc.domainSync.sync();
    await ok(pc);
    expect(await rows('select name from public.projects')).toEqual([{ name: 'P' }]);
  });
});

describe('SYNC-004 동시 수정: 독립 필드 자동 병합과 같은 필드 충돌', () => {
  it('PC 는 제목, 모바일은 우선순위를 바꾸면 자동 병합', async () => {
    const { pc, mobile } = await pcAndMobile();
    const t = await pc.domain.createTask({ title: '원본' });
    await ok(pc);
    await ok(mobile);
    await pc.domain.updateTask(t.id, { title: 'PC 제목' });
    await mobile.domain.updateTask(t.id, { priority: 'urgent' });
    await ok(pc);
    expect((await ok(mobile)).merged).toBe(1);
    await ok(pc);
    for (const dev of [pc, mobile]) expect(await dev.domain.get<Task>('tasks', t.id)).toMatchObject({ title: 'PC 제목', priority: 'urgent', version: 3 });
  });

  it('같은 필드는 충돌로 기록되고 선택에 따라 해결된다', async () => {
    const { pc, mobile } = await pcAndMobile();
    const t = await pc.domain.createTask({ title: '원본' });
    await ok(pc);
    await ok(mobile);
    await pc.domain.updateTask(t.id, { title: 'PC', description: 'PC 설명' });
    await mobile.domain.updateTask(t.id, { title: '모바일', due_date: '2026-12-01' });
    await ok(pc);
    expect((await ok(mobile)).conflicts).toBe(1);
    const [c] = await mobile.domainSync.listConflicts();
    expect(c.kind).toBe('field');
    expect(c.groups).toEqual([{ fields: ['title'], base: { title: '원본' }, local: { title: '모바일' }, remote: { title: 'PC' } }]);
    expect(c.merged_fields).toEqual(['due_date']);
    expect((await rows('select title from public.tasks'))[0].title).toBe('PC'); // 해결 전 서버 불변
    expect((await mobile.domainSync.resolveConflict(c.id, {})).ok).toBe(false);
    expect((await mobile.domainSync.resolveConflict(c.id, { title: 'local' })).ok).toBe(true);
    await ok(mobile);
    await ok(pc);
    for (const dev of [pc, mobile]) expect(await dev.domain.get<Task>('tasks', t.id)).toMatchObject({ title: '모바일', description: 'PC 설명', due_date: '2026-12-01' });
  });

  it('두 기기가 같은 작업을 각각 완료하면 충돌 없이 먼저 서버에 반영된 완료 시각을 쓴다 (Q-05)', async () => {
    const { pc, mobile } = await pcAndMobile();
    const t = await pc.domain.createTask({ title: '같이 완료' });
    await ok(pc);
    await ok(mobile);
    await pc.domain.updateTask(t.id, { status: 'done' });
    await new Promise((r) => setTimeout(r, 5));
    await mobile.domain.updateTask(t.id, { status: 'done', title: '모바일 제목' });
    await ok(pc);
    const r = await ok(mobile);
    expect(r.conflicts).toBe(0);
    const srv = (await rows('select status, completed_at, title from public.tasks'))[0];
    const pcDone = (await pc.domain.get<Task>('tasks', t.id))!.completed_at;
    expect(srv.status).toBe('done');
    expect(new Date(srv.completed_at).toISOString()).toBe(pcDone);
    expect(srv.title).toBe('모바일 제목'); // 다른 필드 변경은 그대로 반영
    expect((await mobile.domain.get<Task>('tasks', t.id))!.completed_at).toBe(pcDone); // 로컬도 서버와 일치
  });

  it('한쪽은 완료, 다른 쪽은 완료 취소면 사용자가 고르도록 충돌로 남긴다', async () => {
    const { pc, mobile } = await pcAndMobile();
    const t = await pc.domain.createTask({ title: 'x', status: 'done' });
    await ok(pc);
    await ok(mobile);
    await pc.domain.updateTask(t.id, { status: 'todo' });
    await mobile.domain.updateTask(t.id, { status: 'in_progress' });
    await ok(pc);
    expect((await ok(mobile)).conflicts).toBe(1);
  });

  it('시작·종료 시각은 한 단위로 비교한다 (섞여서 종료<시작 이 되지 않음)', async () => {
    const { pc, mobile } = await pcAndMobile();
    const e = await pc.domain.createEvent({ title: '회의', start_at: '2026-10-05T01:00:00.000Z', end_at: '2026-10-05T02:00:00.000Z' });
    await ok(pc);
    await ok(mobile);
    await pc.domain.updateEvent(e.id, { start_at: '2026-10-05T05:00:00.000Z', end_at: '2026-10-05T06:00:00.000Z' });
    await mobile.domain.updateEvent(e.id, { end_at: '2026-10-05T03:00:00.000Z' });
    await ok(pc);
    expect((await ok(mobile)).conflicts).toBe(1);
    const [c] = await mobile.domainSync.listConflicts();
    expect(c.groups[0].fields).toEqual(['start_at', 'end_at', 'all_day', 'timezone', 'recurrence_rule']);
    await mobile.domainSync.resolveConflict(c.id, { [c.groups[0].fields.join(',')]: 'remote' });
    await ok(mobile);
    const after = await mobile.domain.get<CalendarEvent>('events', e.id);
    expect([after!.start_at, after!.end_at]).toEqual(['2026-10-05T05:00:00.000Z', '2026-10-05T06:00:00.000Z']);
    expect(await mobile.db.getAll('domain_outbox')).toHaveLength(0);
  });
});

describe('SYNC-005 수정과 삭제 충돌', () => {
  it('한쪽 삭제·다른 쪽 수정은 삭제 충돌로 표시되고, 유지/삭제를 선택할 수 있다', async () => {
    const { pc, mobile } = await pcAndMobile();
    const t = await pc.domain.createTask({ title: '원본' });
    await ok(pc);
    await ok(mobile);
    await pc.domain.updateTask(t.id, { title: 'PC 에서 수정' });
    await mobile.domain.softDelete('tasks', t.id);
    await ok(pc);
    expect((await ok(mobile)).conflicts).toBe(1);
    const [c] = await mobile.domainSync.listConflicts();
    expect(c.kind).toBe('delete');
    expect(c.groups.map((g) => g.fields)).toEqual([['deleted_at']]);
    // 삭제 취소(서버 = 수정된 버전 유지)
    await mobile.domainSync.resolveConflict(c.id, { deleted_at: 'remote' });
    await ok(mobile);
    expect(await mobile.domain.get<Task>('tasks', t.id)).toMatchObject({ title: 'PC 에서 수정', deleted_at: null });
  });

  it('원격 삭제 + 로컬 수정 → 삭제 충돌, 로컬(유지) 선택 시 복구되어 모든 기기에 보인다', async () => {
    const { pc, mobile } = await pcAndMobile();
    const t = await pc.domain.createTask({ title: '원본' });
    await ok(pc);
    await ok(mobile);
    await pc.domain.softDelete('tasks', t.id);
    await mobile.domain.updateTask(t.id, { title: '모바일 수정' });
    await ok(pc);
    await ok(mobile);
    const [c] = await mobile.domainSync.listConflicts();
    expect(c.kind).toBe('delete');
    await mobile.domainSync.resolveConflict(c.id, { deleted_at: 'local' });
    await ok(mobile);
    await ok(pc);
    expect(await pc.domain.get<Task>('tasks', t.id)).toMatchObject({ title: '모바일 수정', deleted_at: null });
  });

  it('양쪽 모두 삭제하면 충돌 없이 삭제된다 (tombstone 동기화)', async () => {
    const { pc, mobile } = await pcAndMobile();
    const p = await pc.domain.createProject({ name: 'P' });
    await ok(pc);
    await ok(mobile);
    await pc.domain.softDelete('projects', p.id);
    await mobile.domain.softDelete('projects', p.id);
    await ok(pc);
    const r = await ok(mobile);
    expect(r.conflicts).toBe(0);
    expect((await mobile.domain.snapshot()).projects).toEqual([]);
    expect((await rows('select deleted_at from public.projects'))[0].deleted_at).toBeTruthy();
  });
});

describe('SYNC-006 사용자 간 데이터 접근 차단 (RLS·RPC)', () => {
  it('B 는 A 의 업무 데이터를 조회·수정·삭제·소유권 변경할 수 없다', async () => {
    const a = await makeDevice({ owner: USER_A, server, name: 'a' });
    const p = await a.domain.createProject({ name: 'A 프로젝트' });
    const t = await a.domain.createTask({ title: 'A 작업', project_id: p.id });
    await ok(a);
    expect(await rows('select * from public.tasks', [], USER_B)).toEqual([]);
    expect(await serverQuery(server, USER_B, 'select * from public.projects')).toEqual([]);
    const upd = await server.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: USER_B })]);
      await tx.exec('set local role authenticated');
      const u = await tx.query(`update public.tasks set title = 'hacked' where id = $1`, [t.id]);
      return u.affectedRows;
    });
    expect(upd).toBe(0);
    // v0.4.1(0004): 직접 DELETE 는 RLS 이전에 권한 자체가 없다 (기존 기대값 '0건'보다 강화)
    await expect(serverQuery(server, USER_B, `delete from public.tasks where id = $1`, [t.id])).rejects.toThrow(/permission denied/);
    const call = (user: string, entity: string, id: string, base: number, patch: object) =>
      serverQuery(server, user, `select public.apply_domain_op($1, $2, $3, $4, $5::jsonb) as r`, [crypto.randomUUID(), entity, id, base, JSON.stringify(patch)]).then((r) => r[0].r);
    expect((await call(USER_B, 'tasks', t.id, 1, { title: 'hacked' })).status).toBe('not_found');
    expect((await call(USER_B, 'tasks', t.id, 0, { title: 'x', description: '', status: 'todo', priority: 'low' })).status).toBe('rejected');
    // B 가 A 의 프로젝트를 참조하는 작업을 만들 수 없다
    expect((await call(USER_B, 'tasks', crypto.randomUUID(), 0, { title: 'x', description: '', status: 'todo', priority: 'low', project_id: p.id })).status).toBe('retry');
    // A 자신도 owner_id·version·server_seq 를 직접 바꿀 수 없다 (허용 필드 외 거부)
    for (const k of ['owner_id', 'version', 'server_seq', 'id']) expect((await call(USER_A, 'tasks', t.id, 1, { [k]: USER_B })).status, k).toBe('rejected');
    // 직접 UPDATE 로 소유권을 넘기는 것도 RLS 가 막는다
    await expect(serverQuery(server, USER_A, `update public.tasks set owner_id = $1 where id = $2`, [USER_B, t.id])).rejects.toThrow(/row-level security/);
    // 허용되지 않은 엔티티·잘못된 값
    expect((await call(USER_A, 'view_preferences', t.id, 1, {})).status).toBe('rejected');
    expect((await call(USER_A, 'tasks', t.id, 1, { status: 'later' })).status).toBe('rejected');
    expect((await call(USER_A, 'events', crypto.randomUUID(), 0, { title: 'x', description: '', start_at: '2026-10-05T02:00:00Z', end_at: '2026-10-05T03:00:00Z', all_day: false, timezone: 'UTC', is_cancelled: false, recurrence_rule: 'FREQ=HOURLY' })).status).toBe('rejected');
    // 미인증 거부
    await expect(server.exec(`set role authenticated; select public.apply_domain_op(gen_random_uuid(), 'tasks', gen_random_uuid(), 0, '{}'::jsonb)`)).rejects.toThrow(/not_authenticated/);
    await server.exec('reset role');
    expect((await rows('select title, owner_id from public.tasks'))[0]).toEqual({ title: 'A 작업', owner_id: USER_A });
  });

  it('서버 허용 필드 목록이 클라이언트 ENTITY_FIELDS 와 같다', async () => {
    for (const e of ['projects', 'categories', 'tasks', 'events'] as const) {
      const [r] = await serverQuery(server, USER_A, 'select public.domain_sync_fields($1) f', [e]);
      expect(r.f, e).toEqual([...ENTITY_FIELDS[e]]);
    }
  });
});

describe('SYNC-007 참조 순서와 실패 시 로컬 보존', () => {
  it('새 프로젝트를 참조하는 새 작업은 프로젝트를 먼저 보내 한 번에 동기화된다', async () => {
    const { pc } = await pcAndMobile();
    const t = await pc.domain.createTask({ title: '먼저 만든 작업' });
    const p = await pc.domain.createProject({ name: '나중에 만든 프로젝트' });
    await pc.domain.updateTask(t.id, { project_id: p.id });
    const r = await ok(pc);
    expect(r).toMatchObject({ pushed: 2, retry: 0 });
  });

  it('회차 예외가 큐에서 원본보다 앞에 있어도 한 번의 동기화로 모두 올라간다 (간헐 실패 회귀)', async () => {
    const { pc } = await pcAndMobile();
    const m = await pc.domain.createEvent({ title: '반복', start_at: '2026-10-05T00:00:00.000Z', end_at: '2026-10-05T01:00:00.000Z', recurrence_rule: 'FREQ=DAILY;COUNT=3' });
    const ov = await pc.domain.cancelOccurrence(m.id, '2026-10-06T00:00:00.000Z');
    // 큐 순서를 강제로 뒤집는다: 예외 → 원본
    const ops = await pc.db.getAll('domain_outbox');
    const mo = ops.find((o) => o.record_id === m.id)!;
    const oo = ops.find((o) => o.record_id === ov.id)!;
    await pc.db.put('domain_outbox', { ...oo, seq: mo.seq - 1 });
    const r = await ok(pc);
    expect(r).toMatchObject({ pushed: 2, retry: 0 });
    expect(await pc.db.getAll('domain_outbox')).toHaveLength(0);
    expect((await rows('select count(*)::int n from public.events'))[0].n).toBe(2);
  });

  it('동기화가 실패해도 업무 데이터 저장은 계속되고 큐는 유지된다', async () => {
    const { pc } = await pcAndMobile();
    pc.online = false;
    for (let i = 0; i < 3; i++) await pc.domain.createTask({ title: `t${i}` });
    await pc.domainSync.sync();
    expect((await pc.domain.snapshot()).tasks).toHaveLength(3);
    expect(await pc.db.getAll('domain_outbox')).toHaveLength(3);
  });
});

describe('SYNC-009 재시도 정책 (Q-03)', () => {
  it('인증 오류는 자동 재시도하지 않고, 네트워크 오류는 점점 긴 간격으로 기다린 뒤 성공하면 초기화된다', async () => {
    const { pc } = await pcAndMobile();
    await pc.domain.createTask({ title: 'x' });
    const remote = pc.domainRemote!;
    const orig = remote.push.bind(remote);
    remote.push = async () => {
      throw new RemoteError('JWT expired', 'auth');
    };
    await pc.domainSync.sync();
    expect(pc.domainSync.state).toMatchObject({ status: 'auth', nextRetryAt: null });
    expect(pc.domainSync.autoSync()).toBeNull(); // 자동 재시도 안 함
    expect(await pc.db.getAll('domain_outbox')).toHaveLength(1); // 큐 보존

    remote.push = async () => {
      throw new RemoteError('Failed to fetch', 'network');
    };
    await pc.domainSync.sync(); // 다시 로그인 후 명시적 동기화
    expect(pc.domainSync.state.status).toBe('offline');
    const first = Date.parse(pc.domainSync.state.nextRetryAt!) - Date.now();
    expect(pc.domainSync.autoSync()).toBeNull(); // 대기 중
    await pc.domainSync.sync();
    const second = Date.parse(pc.domainSync.state.nextRetryAt!) - Date.now();
    expect(second).toBeGreaterThan(first + 20_000); // 30초 → 60초

    remote.push = orig;
    expect((await pc.domainSync.sync()).ok).toBe(true);
    expect(pc.domainSync.state).toMatchObject({ status: 'idle', nextRetryAt: null });
    expect(pc.domainSync.backoff.failures).toBe(0);
    expect(await pc.db.getAll('domain_outbox')).toHaveLength(0);
  });
});

describe('SYNC-008 보기 설정 동기화와 분리', () => {
  it('업무 동기화는 view_preferences 를 보내지 않고, 보기 동기화는 업무 데이터를 보내지 않는다', async () => {
    const { pc } = await pcAndMobile();
    await pc.views.listViews('tasks');
    await pc.domain.createTask({ title: 'x' });
    await ok(pc);
    expect(await rows('select * from public.view_preferences')).toEqual([]);
    await pc.sync.syncViewPreferences();
    expect((await rows('select * from public.view_preferences')).length).toBe(1);
    expect(pc.remote!.pushCalls.every((c) => !('title' in c.patch))).toBe(true);
    expect(pc.domainRemote!.pushCalls.every((c) => c.entity !== ('view_preferences' as never))).toBe(true);
  });
});
