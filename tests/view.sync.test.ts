import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateLocalViewsToAccount } from '../src/views/migrate';
import { defaultViewConfig } from '../src/views/validate';
import type { ViewPreference } from '../src/views/types';
import { asUser, domainDump, makeDevice, makeServer, USER_A, USER_B, type Device } from './helpers';

let server: PGlite;
beforeAll(async () => {
  server = await makeServer();
});
beforeEach(async () => {
  await server.exec('delete from public.view_preference_ops; delete from public.view_preferences;');
});

async function first(dev: Device, domain: 'tasks' | 'events' | 'projects' = 'tasks'): Promise<ViewPreference> {
  const r = await dev.views.listViews(domain);
  if (!r.ok) throw new Error(r.error.message);
  return r.value[0];
}

async function serverRows(userId = USER_A) {
  return asUser(server, userId, async (tx) => (await tx.query('select * from public.view_preferences order by created_at')).rows as any[]);
}

/** PC 에서 기본 보기를 만들어 동기화하고, 모바일에서 같은 보기를 받아온다 */
async function twoDevices() {
  const pc = await makeDevice({ owner: USER_A, server, name: 'pc' });
  const mobile = await makeDevice({ owner: USER_A, server, name: 'mobile' });
  const v = await first(pc);
  expect((await pc.sync.syncViewPreferences()).ok).toBe(true);
  await mobile.sync.syncViewPreferences();
  const mv = await mobile.views.getView(v.id);
  expect(mv.ok).toBe(true);
  return { pc, mobile, v };
}

describe('VIEW-011 오프라인 설정 변경', () => {
  it('오프라인에서 변경이 로컬 저장·큐 등록되고, 재접속 후 서버에 반영된다', async () => {
    const { pc, mobile, v } = await twoDevices();
    pc.online = false;
    const r = await pc.views.updateView(v.id, { column_config: v.column_config.map((c) => (c.field === 'priority' ? { ...c, visible: false } : c)) });
    expect(r.ok).toBe(true);
    const ops = await pc.db.getAll('view_outbox');
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ view_id: v.id, fields: ['column_config'], status: 'pending' });
    const s = await pc.sync.syncViewPreferences();
    expect(!s.ok && s.error.code).toBe('REMOTE_UNAVAILABLE');
    expect(pc.sync.state.status).toBe('offline');
    // 업무 데이터 저장은 동기화 실패와 무관하게 동작
    const task = await pc.domain.createTask({ title: '오프라인 작업' });
    expect(task.id).toBeTruthy();

    pc.online = true;
    const s2 = await pc.sync.syncViewPreferences();
    expect(s2.ok && s2.value.pushed).toBe(1);
    expect(await pc.db.getAll('view_outbox')).toHaveLength(0);
    await mobile.sync.syncViewPreferences();
    const mv = await mobile.views.getView(v.id);
    expect(mv.ok && mv.value.column_config.find((c) => c.field === 'priority')!.visible).toBe(false);
    expect(mv.ok && mv.value.version).toBe(2);
  });

  it('오프라인 동안 여러 번 바꾸면 하나의 op 로 합쳐진다', async () => {
    const { pc, v } = await twoDevices();
    pc.online = false;
    await pc.views.updateView(v.id, { name: 'A' });
    await pc.views.updateView(v.id, { name: 'B' });
    await pc.views.updateView(v.id, { sort_config: [{ field: 'title', dir: 'asc' }] });
    const ops = await pc.db.getAll('view_outbox');
    expect(ops).toHaveLength(1);
    expect(ops[0].fields.sort()).toEqual(['name', 'sort_config']);
  });

  it('레코드 저장과 큐 등록은 원자적이다 (트랜잭션 실패 시 둘 다 반영되지 않음)', async () => {
    const dev = await makeDevice();
    const v = await first(dev);
    const origPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: any[]) {
      if (this.name === 'view_outbox') throw new DOMException('quota', 'QuotaExceededError');
      return origPut.apply(this, args as never);
    } as never;
    try {
      const r = await dev.views.updateView(v.id, { name: '실패해야 함' });
      expect(!r.ok && r.error.code).toBe('STORAGE');
    } finally {
      IDBObjectStore.prototype.put = origPut;
    }
    const after = await dev.views.getView(v.id);
    expect(after.ok && after.value.name).toBe('기본 보기');
    expect((await dev.db.getAll('view_outbox')).every((o) => o.fields.length === 7)).toBe(true); // 최초 생성 op 만
  });
});

describe('VIEW-012 동일 작업 재전송', () => {
  it('응답이 유실되어 같은 op_id 로 재전송해도 서버에 한 번만 적용된다', async () => {
    const { pc, v } = await twoDevices();
    await pc.views.updateView(v.id, { name: '재전송 테스트' });
    pc.remote!.dropNextResponse = true;
    const s1 = await pc.sync.syncViewPreferences();
    expect(s1.ok).toBe(false);
    const ops = await pc.db.getAll('view_outbox');
    expect(ops).toHaveLength(1); // 아직 확인되지 않아 남아 있음
    const opId = ops[0].op_id;
    const s2 = await pc.sync.syncViewPreferences();
    expect(s2.ok).toBe(true);
    const calls = pc.remote!.pushCalls.filter((c) => c.op_id === opId);
    expect(calls).toHaveLength(2);
    const rows = await serverRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('재전송 테스트');
    expect(rows[0].version).toBe(2); // 두 번 적용됐다면 3
    const opRows = await asUser(server, USER_A, async (tx) => (await tx.query('select count(*)::int as n from public.view_preference_ops where op_id = $1', [opId])).rows[0].n);
    expect(opRows).toBe(1);
  });

  it('생성 op 재전송도 보기를 중복 생성하지 않는다', async () => {
    const pc = await makeDevice({ owner: USER_A, server });
    await first(pc);
    pc.remote!.dropNextResponse = true;
    await pc.sync.syncViewPreferences();
    await pc.sync.syncViewPreferences();
    expect(await serverRows()).toHaveLength(1);
  });
});

describe('VIEW-013 서로 다른 필드 설정 변경 병합', () => {
  it('PC 는 정렬, 모바일은 컬럼을 바꾸면 자동 병합된다', async () => {
    const { pc, mobile, v } = await twoDevices();
    await pc.views.updateView(v.id, { sort_config: [{ field: 'title', dir: 'desc' }] });
    const mv = (await mobile.views.getView(v.id)) as { ok: true; value: ViewPreference };
    await mobile.views.updateView(v.id, { column_config: mv.value.column_config.map((c) => (c.field === 'title' ? { ...c, width: 333 } : c)) });
    expect((await pc.sync.syncViewPreferences()).ok).toBe(true);
    const ms = await mobile.sync.syncViewPreferences();
    expect(ms.ok && ms.value.merged).toBe(1);
    expect(ms.ok && ms.value.conflicts).toBe(0);
    await pc.sync.syncViewPreferences();
    for (const dev of [pc, mobile]) {
      const r = await dev.views.getView(v.id);
      expect(r.ok && r.value.sort_config).toEqual([{ field: 'title', dir: 'desc' }]);
      expect(r.ok && r.value.column_config.find((c) => c.field === 'title')!.width).toBe(333);
      expect(r.ok && r.value.version).toBe(3);
    }
    expect(await mobile.db.getAll('view_conflicts')).toHaveLength(0);
  });
});

describe('VIEW-014 같은 필드의 동시 변경 충돌', () => {
  it('같은 필드 동시 변경은 충돌로 기록되고 사용자가 선택해 해결한다', async () => {
    const { pc, mobile, v } = await twoDevices();
    await pc.views.updateView(v.id, { name: 'PC 이름', sort_config: [{ field: 'title', dir: 'asc' }] });
    await mobile.views.updateView(v.id, { name: '모바일 이름', layout_config: { density: 'compact' } });
    await pc.sync.syncViewPreferences();
    const ms = await mobile.sync.syncViewPreferences();
    expect(ms.ok && ms.value.conflicts).toBe(1);
    const conflicts = await mobile.sync.listConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].fields).toEqual([{ field: 'name', base: '기본 보기', local: '모바일 이름', remote: 'PC 이름' }]);
    expect(conflicts[0].merged_fields).toEqual(['layout_config']);
    // 해결 전에는 서버가 바뀌지 않는다
    expect((await serverRows())[0].name).toBe('PC 이름');

    const bad = await mobile.sync.resolveViewConflict(conflicts[0].id, {});
    expect(!bad.ok && bad.error.code).toBe('INVALID_RESOLUTION');
    const res = await mobile.sync.resolveViewConflict(conflicts[0].id, { name: 'local' });
    expect(res.ok).toBe(true);
    await mobile.sync.syncViewPreferences();
    await pc.sync.syncViewPreferences();
    const row = (await serverRows())[0];
    expect(row.name).toBe('모바일 이름');
    expect(row.sort_config).toEqual([{ field: 'title', dir: 'asc' }]); // PC 변경 유지
    expect(row.layout_config).toEqual({ density: 'compact' }); // 모바일 독립 변경 유지
    const pv = await pc.views.getView(v.id);
    expect(pv.ok && pv.value.name).toBe('모바일 이름');
  });

  it('원격 값을 선택하면 로컬 변경을 버린다', async () => {
    const { pc, mobile, v } = await twoDevices();
    await pc.views.updateView(v.id, { name: 'PC' });
    await mobile.views.updateView(v.id, { name: 'M' });
    await pc.sync.syncViewPreferences();
    await mobile.sync.syncViewPreferences();
    const [c] = await mobile.sync.listConflicts();
    await mobile.sync.resolveViewConflict(c.id, { name: 'remote' });
    expect(await mobile.db.getAll('view_outbox')).toHaveLength(0);
    const mv = await mobile.views.getView(v.id);
    expect(mv.ok && mv.value.name).toBe('PC');
  });
});

describe('VIEW-015 계정 연결 후 설정 이전', () => {
  it('로그인 전 설정을 백업 후 이전하고, 중복·충돌을 구분해 요약한다', async () => {
    // 클라우드에 이미 다른 기기의 설정이 있다
    const other = await makeDevice({ owner: USER_A, server, name: 'other' });
    const ov = await first(other); // '기본 보기' (기본 설정)
    await other.views.createView({ domain: 'tasks', name: '업무용', config: { ...defaultViewConfig('tasks'), sort_config: [{ field: 'title', dir: 'asc' }] } });
    await other.sync.syncViewPreferences();

    const dev = await makeDevice({ owner: null, server, name: 'guest' });
    await dev.domain.createTask({ title: '게스트 작업' });
    const domainBefore = await domainDump(dev.db);
    const gv = await first(dev); // 같은 이름+같은 설정 → duplicate
    await dev.views.createView({ domain: 'tasks', name: '업무용', config: { ...defaultViewConfig('tasks'), sort_config: [{ field: 'priority', dir: 'desc' }] } }); // 이름 같고 설정 다름 → rename
    await dev.views.createView({ domain: 'projects', name: '진행 중 프로젝트', config: { ...defaultViewConfig('projects'), filter_config: { search: '', conditions: [{ type: 'in', field: 'status', values: ['active'] }] } } }); // create
    expect(gv.owner_id).toBeNull();
    // 로그인 전에는 서버로 아무것도 보내지 않는다
    expect((await dev.sync.syncViewPreferences()).ok && dev.sync.state.status).toBe('local-only');

    dev.session.owner = USER_A; // 로그인
    // 네트워크 실패 시 로컬 설정 유지
    dev.online = false;
    const failed = await migrateLocalViewsToAccount(dev.db, dev.remote!);
    expect(!failed.ok && failed.error.code).toBe('REMOTE_UNAVAILABLE');
    expect((await dev.db.getAll('view_preferences')).filter((v) => v.owner_id === null)).toHaveLength(3);

    dev.online = true;
    const r = await migrateLocalViewsToAccount(dev.db, dev.remote!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ total: 3, created: 1, renamed: 1, duplicates: 1, verified: 3, domainData: 'NOT_IMPLEMENTED' });
    expect(r.value.backupId).toBeTruthy();
    const backup = await dev.db.get('view_backups', r.value.backupId!);
    expect(backup!.views).toHaveLength(3);

    const names = (await serverRows()).filter((x) => !x.deleted_at).map((x) => `${x.view_key}:${x.name}`).sort();
    expect(names).toEqual(['tasks:기본 보기', 'tasks:업무용', 'tasks:업무용 (이 기기)', 'projects:진행 중 프로젝트'].sort());
    // 로컬도 계정 소유로 교체됨, 중복은 클라우드 ID 사용
    const local = await dev.db.getAll('view_preferences');
    expect(local.every((v) => v.owner_id === USER_A)).toBe(true);
    expect(local.find((v) => v.view_key === 'tasks' && v.name === '기본 보기')!.id).toBe(ov.id);
    // 다른 기기에서 반영
    await other.sync.syncViewPreferences();
    const ol = await other.views.listViews('projects');
    expect(ol.ok && ol.value.map((x) => x.name)).toContain('진행 중 프로젝트');
    // 업무 데이터는 별도: 이전 기능이 건드리지 않았다
    expect(await domainDump(dev.db)).toEqual(domainBefore);
  });
});

describe('VIEW-017 사용자 간 설정 접근 차단', () => {
  it('RLS 로 다른 사용자의 보기를 읽거나 수정·덮어쓸 수 없다', async () => {
    const a = await makeDevice({ owner: USER_A, server, name: 'a' });
    const av = await first(a);
    await a.sync.syncViewPreferences();

    // B 는 A 의 행을 볼 수 없다
    expect(await serverRows(USER_B)).toHaveLength(0);
    // B 가 직접 UPDATE 해도 0건
    const upd = await asUser(server, USER_B, async (tx) => (await tx.query(`update public.view_preferences set name = 'hacked' where id = $1`, [av.id])).affectedRows);
    expect(upd).toBe(0);
    // B 가 A 의 ID 로 RPC 를 호출해도 거부
    const res = await asUser(server, USER_B, async (tx) =>
      (await tx.query(`select public.apply_view_preference_op($1, $2, 1, $3::jsonb) as r`, [crypto.randomUUID(), av.id, JSON.stringify({ name: 'hacked' })])).rows[0].r,
    );
    expect(res.status).toBe('not_found');
    const res2 = await asUser(server, USER_B, async (tx) =>
      (await tx.query(`select public.apply_view_preference_op($1, $2, 0, $3::jsonb) as r`, [crypto.randomUUID(), av.id, JSON.stringify({ view_key: 'tasks', name: 'x', column_config: [] })])).rows[0].r,
    );
    expect(res2.status).toBe('rejected');
    // B 가 owner_id 를 A 로 지정해 INSERT 할 수 없다
    await expect(
      asUser(server, USER_B, (tx) => tx.query(`insert into public.view_preferences (id, owner_id, view_key, name, column_config) values ($1, $2, 'tasks', 'x', '[]')`, [crypto.randomUUID(), USER_A])),
    ).rejects.toThrow(/row-level security/);
    // A 의 op 기록도 볼 수 없다 (멱등성 결과 탈취 방지)
    const ops = await asUser(server, USER_B, async (tx) => (await tx.query('select * from public.view_preference_ops')).rows);
    expect(ops).toHaveLength(0);
    // 미인증 호출 거부
    await expect(server.exec(`set role authenticated; select public.apply_view_preference_op(gen_random_uuid(), gen_random_uuid(), 0, '{}'::jsonb)`)).rejects.toThrow(/not_authenticated/);
    await server.exec('reset role');
    expect((await serverRows())[0].name).toBe('기본 보기');

    // 로컬: 같은 기기에서 B 로 로그인하면 A 의 보기가 보이지 않는다
    a.session.owner = USER_B;
    const bl = await a.views.listViews('tasks');
    expect(bl.ok && bl.value.every((v) => v.id !== av.id)).toBe(true);
    expect((await a.views.getView(av.id)).ok).toBe(false);
  });

  it('서버도 허용되지 않은 필드·너비를 거부한다 (클라이언트 우회 방지)', async () => {
    const bad = async (patch: object) =>
      asUser(server, USER_A, async (tx) => (await tx.query(`select public.apply_view_preference_op($1, $2, 0, $3::jsonb) as r`, [crypto.randomUUID(), crypto.randomUUID(), JSON.stringify(patch)])).rows[0].r);
    const cols = defaultViewConfig('tasks').column_config;
    expect((await bad({ view_key: 'tasks', name: 'x', column_config: [...cols, { field: 'password', visible: true, position: 50, width: 100 }] })).status).toBe('rejected');
    expect((await bad({ view_key: 'tasks', name: 'x', column_config: cols.map((c) => ({ ...c, width: 9999 })) })).status).toBe('rejected');
    expect((await bad({ view_key: 'tasks', name: 'x', column_config: cols, sort_config: [{ field: 'title', dir: 'sideways' }] })).status).toBe('rejected');
    expect((await bad({ view_key: 'notes', name: 'x', column_config: [] })).status).toBe('rejected');
    expect((await bad({ owner_id: USER_B })).status).toBe('rejected');
    expect((await bad({ view_key: 'tasks', name: 'ok', column_config: cols })).status).toBe('applied');
  });
});
