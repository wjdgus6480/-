import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { asAnon, makeServer, serverQuery, USER_A, USER_B } from './helpers';

const TABLES = ['projects', 'categories', 'tasks', 'events', 'view_preferences', 'domain_ops', 'view_preference_ops'];
const DOMAIN = ['projects', 'categories', 'tasks', 'events'];

async function rpc(pg: PGlite, user: string, entity: string, id: string, base: number, patch: Record<string, unknown>) {
  const [r] = await serverQuery(pg, user, 'select public.apply_domain_op($1, $2, $3, $4, $5::jsonb) as r', [crypto.randomUUID(), entity, id, base, JSON.stringify(patch)]);
  return r.r as { status: string; reason?: string; row?: any };
}

/** 회원 A·B 가 각각 프로젝트·분류·일정·투두를 하나씩 가진 서버 */
async function seeded(upTo?: string) {
  const pg = await makeServer({ upTo });
  const ids: Record<string, Record<string, string>> = { [USER_A]: {}, [USER_B]: {} };
  for (const u of [USER_A, USER_B]) {
    const p = crypto.randomUUID();
    const c = crypto.randomUUID();
    const t = crypto.randomUUID();
    const e = crypto.randomUUID();
    // 앱(DomainSyncEngine)처럼 생성 시 허용 필드를 모두 보낸다 (jsonb_populate_record 는 빠진 키를 null 로 채움)
    expect((await rpc(pg, u, 'projects', p, 0, { name: `P-${u.slice(-1)}`, description: '', status: 'active', deleted_at: null })).status).toBe('applied');
    expect((await rpc(pg, u, 'categories', c, 0, { name: `C-${u.slice(-1)}`, color: '#888888', deleted_at: null })).status).toBe('applied');
    expect(
      (await rpc(pg, u, 'tasks', t, 0, { title: `T-${u.slice(-1)}`, description: '', status: 'todo', priority: 'medium', due_date: null, project_id: p, category_id: c, completed_at: null, deleted_at: null })).status,
    ).toBe('applied');
    expect(
      (
        await rpc(pg, u, 'events', e, 0, {
          title: `E-${u.slice(-1)}`, description: '', start_at: '2026-10-06T00:00:00Z', end_at: '2026-10-06T01:00:00Z', all_day: false, timezone: 'Asia/Seoul',
          recurrence_rule: null, recurrence_parent_id: null, original_start_at: null, is_cancelled: false, project_id: null, category_id: null, deleted_at: null,
        })
      ).status,
    ).toBe('applied');
    ids[u] = { projects: p, categories: c, tasks: t, events: e };
  }
  return { pg, ids };
}

const TASK = (o: Record<string, unknown>) => ({ title: 'x', description: '', status: 'todo', priority: 'medium', due_date: null, project_id: null, category_id: null, completed_at: null, deleted_at: null, ...o });

const count = async (pg: PGlite, sql: string, params: unknown[] = []) => Number((await pg.query<{ n: number }>(sql, params)).rows[0].n);

describe('SEC-RLS-000 기준선: 0005 까지 + Supabase 기본 권한 (취약점 재현, 0006 의 근거)', () => {
  it('로그인한 회원 A 가 TRUNCATE 로 회원 B 의 데이터까지 지울 수 있다 (TRUNCATE 는 RLS 를 무시)', async () => {
    const { pg } = await seeded('20261005000005');
    // tasks 는 다른 표가 참조하지 않으므로 cascade 없이 TRUNCATE 가능
    await serverQuery(pg, USER_A, 'truncate public.tasks');
    expect(await count(pg, `select count(*)::int n from public.tasks where owner_id = '${USER_B}'`)).toBe(0);
  });

  it('회원 A 가 전 회원 공용 시퀀스를 되돌릴 수 있다 (다른 회원 기기의 동기화 커서보다 낮은 server_seq 발생)', async () => {
    const { pg } = await seeded('20261005000005');
    await serverQuery(pg, USER_A, `select setval('public.domain_seq', 1)`);
    expect(await count(pg, `select last_value::int n from public.domain_seq`)).toBe(1);
  });

  it('비로그인(anon)에게 쓰기·TRUNCATE 권한이 남아 있다', async () => {
    const pg = await makeServer({ upTo: '20261005000005' });
    const [r] = (await pg.query<{ ins: boolean; tr: boolean }>(`select has_table_privilege('anon', 'public.tasks', 'INSERT') ins, has_table_privilege('anon', 'public.tasks', 'TRUNCATE') tr`)).rows;
    expect(r).toEqual({ ins: true, tr: true });
  });
});

describe('SEC-RLS-001 권한 표 (0006 적용 후 최소 권한)', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await makeServer();
  });

  it('anon 은 DOTDAY 표·시퀀스·함수에 아무 권한이 없다', async () => {
    for (const t of TABLES) {
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        expect((await pg.query<{ v: boolean }>(`select has_table_privilege('anon', $1, $2) v`, [`public.${t}`, p])).rows[0].v, `${t} ${p}`).toBe(false);
      }
    }
    for (const s of ['domain_seq', 'view_preferences_seq']) {
      expect((await pg.query<{ v: boolean }>(`select has_sequence_privilege('anon', $1, 'USAGE,SELECT,UPDATE') v`, [`public.${s}`])).rows[0].v).toBe(false);
    }
    const fns = (await pg.query<{ f: string; v: boolean }>(
      `select p.oid::regprocedure::text f, has_function_privilege('anon', p.oid, 'EXECUTE') v from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
    )).rows;
    expect(fns.length).toBeGreaterThan(5);
    expect(fns.filter((f) => f.v).map((f) => f.f)).toEqual([]);
  });

  it('authenticated: 업무 표는 SELECT/INSERT/UPDATE 만, 동기화 기록은 SELECT/INSERT 만, TRUNCATE·REFERENCES·TRIGGER·DELETE 없음', async () => {
    const expected: Record<string, string[]> = {
      projects: ['SELECT', 'INSERT', 'UPDATE'],
      categories: ['SELECT', 'INSERT', 'UPDATE'],
      tasks: ['SELECT', 'INSERT', 'UPDATE'],
      events: ['SELECT', 'INSERT', 'UPDATE'],
      view_preferences: ['SELECT', 'INSERT', 'UPDATE'],
      domain_ops: ['SELECT', 'INSERT'],
      view_preference_ops: ['SELECT', 'INSERT'],
    };
    for (const t of TABLES) {
      const have: string[] = [];
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        if ((await pg.query<{ v: boolean }>(`select has_table_privilege('authenticated', $1, $2) v`, [`public.${t}`, p])).rows[0].v) have.push(p);
      }
      expect(have, t).toEqual(expected[t]);
    }
    const [s] = (await pg.query<{ u: boolean; sel: boolean; upd: boolean }>(
      `select has_sequence_privilege('authenticated', 'public.domain_seq', 'USAGE') u, has_sequence_privilege('authenticated', 'public.domain_seq', 'SELECT') sel, has_sequence_privilege('authenticated', 'public.domain_seq', 'UPDATE') upd`,
    )).rows;
    expect(s).toEqual({ u: true, sel: false, upd: false });
  });

  it('모든 DOTDAY 표에 RLS 가 켜져 있다 (app_admins 포함)', async () => {
    const rows = (await pg.query<{ relname: string; on: boolean }>(
      `select c.relname, c.relrowsecurity "on" from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'`,
    )).rows;
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES, 'app_admins'].sort());
    expect(rows.filter((r) => !r.on)).toEqual([]);
  });

  it('public 스키마에 뷰가 없다 (뷰를 통한 RLS 우회 경로 없음)', async () => {
    expect(await count(pg, `select count(*)::int n from pg_views where schemaname = 'public'`)).toBe(0);
  });

  it('security definer 함수는 is_admin·delete_my_account 뿐이며 search_path 가 고정되어 있다', async () => {
    const rows = (await pg.query<{ proname: string; cfg: string[] | null }>(
      `select p.proname, p.proconfig cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef`,
    )).rows;
    expect(rows.map((r) => r.proname).sort()).toEqual(['delete_my_account', 'is_admin']);
    for (const r of rows) expect(r.cfg?.some((c) => c.startsWith('search_path='))).toBe(true);
  });
});

describe('SEC-RLS-002 회원 A/B 데이터 격리 (0006·0007 적용 후)', () => {
  it('각 회원은 자기 행만 조회한다 (모든 표)', async () => {
    const { pg, ids } = await seeded();
    for (const u of [USER_A, USER_B]) {
      for (const t of DOMAIN) {
        const rows = await serverQuery(pg, u, `select id, owner_id from public.${t}`);
        expect(rows.map((r) => r.id), `${u} ${t}`).toEqual([ids[u][t]]);
      }
      const ops = await serverQuery(pg, u, 'select owner_id from public.domain_ops');
      expect(ops.length).toBe(4);
      expect(ops.every((o) => o.owner_id === u)).toBe(true);
    }
  });

  it('A 는 B 의 행을 직접 수정·삭제 표시할 수 없다 (0행 영향, B 데이터 그대로)', async () => {
    const { pg, ids } = await seeded();
    await serverQuery(pg, USER_A, `update public.tasks set title = '탈취' where id = $1`, [ids[USER_B].tasks]);
    await serverQuery(pg, USER_A, `update public.events set deleted_at = now() where id = $1`, [ids[USER_B].events]);
    const [t] = (await pg.query<any>('select title from public.tasks where id = $1', [ids[USER_B].tasks])).rows;
    const [e] = (await pg.query<any>('select deleted_at from public.events where id = $1', [ids[USER_B].events])).rows;
    expect(t.title).toBe('T-b');
    expect(e.deleted_at).toBeNull();
  });

  it('요청 본문의 owner_id 위조(INSERT)를 거부한다', async () => {
    const { pg } = await seeded();
    await expect(serverQuery(pg, USER_A, `insert into public.projects (id, owner_id, name) values ($1, $2, '위조')`, [crypto.randomUUID(), USER_B])).rejects.toThrow(/row-level security/);
    await expect(serverQuery(pg, USER_A, `insert into public.view_preferences (id, owner_id, view_key, name, column_config) values ($1, $2, 'tasks', 'x', '[]')`, [crypto.randomUUID(), USER_B])).rejects.toThrow(/row-level security/);
  });

  it('UPDATE 로 소유권을 다른 회원에게 넘길 수 없다', async () => {
    const { pg, ids } = await seeded();
    await expect(serverQuery(pg, USER_A, 'update public.projects set owner_id = $1 where id = $2', [USER_B, ids[USER_A].projects])).rejects.toThrow(/row-level security/);
    const [p] = (await pg.query<any>('select owner_id from public.projects where id = $1', [ids[USER_A].projects])).rows;
    expect(p.owner_id).toBe(USER_A);
  });

  it('RPC 로도 B 의 행에 접근할 수 없고, owner_id 는 패치할 수 없다', async () => {
    const { pg, ids } = await seeded();
    expect((await rpc(pg, USER_A, 'tasks', ids[USER_B].tasks, 1, { title: 'x' })).status).toBe('not_found');
    expect(await rpc(pg, USER_A, 'tasks', ids[USER_B].tasks, 0, TASK({}))).toMatchObject({ status: 'rejected', reason: 'id_unavailable' });
    expect(await rpc(pg, USER_A, 'tasks', ids[USER_A].tasks, 1, { owner_id: USER_B })).toMatchObject({ status: 'rejected', reason: 'invalid_patch_key:owner_id' });
    expect(await rpc(pg, USER_A, 'domain_ops', crypto.randomUUID(), 0, {})).toMatchObject({ status: 'rejected', reason: 'invalid_entity' });
    const [t] = (await pg.query<any>('select title, version from public.tasks where id = $1', [ids[USER_B].tasks])).rows;
    expect(t).toEqual({ title: 'T-b', version: 1 });
  });

  it('다른 회원의 프로젝트·분류·반복 원본을 참조할 수 없다 (직접 쓰기는 트리거, RPC 는 RLS)', async () => {
    const { pg, ids } = await seeded();
    const B = ids[USER_B];
    await expect(serverQuery(pg, USER_A, `insert into public.tasks (id, owner_id, title, project_id) values ($1, $2, 'x', $3)`, [crypto.randomUUID(), USER_A, B.projects])).rejects.toThrow(/not owned/);
    await expect(serverQuery(pg, USER_A, 'update public.tasks set category_id = $1 where id = $2', [B.categories, ids[USER_A].tasks])).rejects.toThrow(/not owned/);
    await expect(
      serverQuery(pg, USER_A, `insert into public.events (id, owner_id, title, start_at, end_at, recurrence_parent_id, original_start_at) values ($1, $2, 'x', now(), now(), $3, now())`, [crypto.randomUUID(), USER_A, B.events]),
    ).rejects.toThrow(/not owned/);
    expect(await rpc(pg, USER_A, 'tasks', crypto.randomUUID(), 0, TASK({ project_id: B.projects }))).toMatchObject({ status: 'retry', reason: 'missing_reference:project_id' });
    // 자기 소유 참조와 참조와 무관한 수정은 그대로 동작
    expect((await rpc(pg, USER_A, 'tasks', ids[USER_A].tasks, 1, { title: '수정', project_id: ids[USER_A].projects })).status).toBe('applied');
  });

  it('동기화 기록(domain_ops) 직접 삽입은 본인 것이든 남의 것이든 거부된다', async () => {
    const { pg } = await seeded();
    for (const owner of [USER_A, USER_B]) {
      await expect(
        serverQuery(pg, USER_A, `insert into public.domain_ops (op_id, owner_id, entity, record_id, result) values ($1, $2, 'tasks', $1, '{}')`, [crypto.randomUUID(), owner]),
      ).rejects.toThrow(/not allowed|row-level security/);
    }
    await expect(serverQuery(pg, USER_A, `update public.domain_ops set result = '{}'`)).rejects.toThrow(/permission denied/);
    await expect(serverQuery(pg, USER_A, `delete from public.domain_ops`)).rejects.toThrow(/permission denied/);
  });

  it('TRUNCATE·setval 은 거부되고 B 의 데이터는 그대로다', async () => {
    const { pg } = await seeded();
    for (const t of TABLES) await expect(serverQuery(pg, USER_A, `truncate public.${t} cascade`), t).rejects.toThrow(/permission denied/);
    await expect(serverQuery(pg, USER_A, `select setval('public.domain_seq', 1)`)).rejects.toThrow(/permission denied/);
    await expect(serverQuery(pg, USER_A, `select last_value from public.domain_seq`)).rejects.toThrow(/permission denied/);
    expect(await count(pg, `select count(*)::int n from public.tasks where owner_id = '${USER_B}'`)).toBe(1);
  });

  it('비로그인(anon)은 개인 데이터 조회·쓰기·RPC 를 모두 거부당한다', async () => {
    const { pg } = await seeded();
    for (const t of TABLES) await expect(asAnon(pg, (tx) => tx.query(`select * from public.${t}`)), t).rejects.toThrow(/permission denied/);
    await expect(asAnon(pg, (tx) => tx.query(`insert into public.projects (id, name) values ($1, 'x')`, [crypto.randomUUID()]))).rejects.toThrow(/permission denied/);
    await expect(asAnon(pg, (tx) => tx.query(`select public.apply_domain_op($1, 'tasks', $1, 0, '{}')`, [crypto.randomUUID()]))).rejects.toThrow(/permission denied/);
    await expect(asAnon(pg, (tx) => tx.query(`select public.delete_my_account('DELETE')`))).rejects.toThrow(/permission denied/);
    await expect(asAnon(pg, (tx) => tx.query(`select public.is_admin()`))).rejects.toThrow(/permission denied/);
  });
});

describe('SEC-ADM-001 관리자 구분 (서버 표 app_admins)', () => {
  it('클라이언트는 관리자 표를 읽거나 쓸 수 없고 스스로 관리자가 될 수 없다', async () => {
    const pg = await makeServer();
    await expect(serverQuery(pg, USER_A, 'select * from public.app_admins')).rejects.toThrow(/permission denied/);
    await expect(serverQuery(pg, USER_A, 'insert into public.app_admins (user_id) values ($1)', [USER_A])).rejects.toThrow(/permission denied/);
    expect((await serverQuery(pg, USER_A, 'select public.is_admin() v'))[0].v).toBe(false);
  });

  it('소유자가 SQL 로 지정한 회원만 관리자이며, 관리자도 다른 회원 데이터를 볼 수 없다', async () => {
    const { pg, ids } = await seeded();
    await pg.query(`insert into public.app_admins (user_id, note) values ($1, 'owner')`, [USER_A]);
    expect((await serverQuery(pg, USER_A, 'select public.is_admin() v'))[0].v).toBe(true);
    expect((await serverQuery(pg, USER_B, 'select public.is_admin() v'))[0].v).toBe(false);
    expect((await serverQuery(pg, USER_A, 'select id from public.tasks')).map((r) => r.id)).toEqual([ids[USER_A].tasks]);
  });
});

describe('SEC-DEL-001 본인 계정 탈퇴 RPC', () => {
  it('확인 문구가 없거나 최근 로그인이 아니면 거부한다', async () => {
    const { pg } = await seeded();
    expect((await serverQuery(pg, USER_A, `select public.delete_my_account('yes') r`))[0].r).toMatchObject({ status: 'rejected', reason: 'confirm_required' });
    await pg.query(`update auth.users set last_sign_in_at = now() - interval '11 minutes' where id = $1`, [USER_A]);
    expect((await serverQuery(pg, USER_A, `select public.delete_my_account('DELETE') r`))[0].r).toEqual({ status: 'reauth_required' });
    expect(await count(pg, `select count(*)::int n from auth.users where id = '${USER_A}'`)).toBe(1);
  });

  it('본인 계정과 본인 데이터(업무·보기·동기화 기록)만 지우고 B 는 그대로 둔다', async () => {
    const { pg, ids } = await seeded();
    await serverQuery(pg, USER_B, `select public.apply_view_preference_op($1, $2, 0, $3::jsonb)`, [
      crypto.randomUUID(),
      crypto.randomUUID(),
      JSON.stringify({ view_key: 'tasks', name: 'B 보기', column_config: [], sort_config: [], filter_config: {}, layout_config: {}, is_default: false }),
    ]).catch(() => undefined); // 보기 설정 패치 형식은 view 테스트에서 검증, 여기선 있으면 보존 확인용
    const before = await count(pg, `select (select count(*) from public.tasks where owner_id = '${USER_B}') + (select count(*) from public.events where owner_id = '${USER_B}') + (select count(*) from public.domain_ops where owner_id = '${USER_B}') + (select count(*) from public.view_preferences where owner_id = '${USER_B}') n`);
    const [r] = await serverQuery(pg, USER_A, `select public.delete_my_account('DELETE') r`);
    expect(r.r).toEqual({ status: 'deleted' });
    expect(await count(pg, `select count(*)::int n from auth.users where id = '${USER_A}'`)).toBe(0);
    for (const t of [...DOMAIN, 'domain_ops', 'view_preferences', 'view_preference_ops']) {
      expect(await count(pg, `select count(*)::int n from public.${t} where owner_id = '${USER_A}'`), t).toBe(0);
    }
    const after = await count(pg, `select (select count(*) from public.tasks where owner_id = '${USER_B}') + (select count(*) from public.events where owner_id = '${USER_B}') + (select count(*) from public.domain_ops where owner_id = '${USER_B}') + (select count(*) from public.view_preferences where owner_id = '${USER_B}') n`);
    expect(after).toBe(before);
    const [bt] = (await pg.query<any>('select title, project_id from public.tasks where id = $1', [ids[USER_B].tasks])).rows;
    expect(bt).toEqual({ title: 'T-b', project_id: ids[USER_B].projects });
  });

  it('관리자 계정은 해제 전에는 탈퇴할 수 없다 (잠김 방지)', async () => {
    const pg = await makeServer();
    await pg.query(`insert into public.app_admins (user_id) values ($1)`, [USER_A]);
    expect((await serverQuery(pg, USER_A, `select public.delete_my_account('DELETE') r`))[0].r).toMatchObject({ status: 'rejected', reason: 'admin_account' });
    expect(await count(pg, `select count(*)::int n from auth.users where id = '${USER_A}'`)).toBe(1);
  });

  it('탈퇴 RPC 는 사용자 ID 인자를 받지 않는다 (다른 회원 지정 불가)', async () => {
    const pg = await makeServer();
    const args = (await pg.query<{ a: string }>(`select pg_get_function_arguments('public.delete_my_account(text)'::regprocedure) a`)).rows[0].a;
    expect(args).toBe('p_confirm text');
  });
});

describe('SEC-RLS-003 0006·0007 은 반복 실행해도 같은 결과 (멱등)', () => {
  it('두 번 적용해도 오류 없이 같은 권한·트리거 상태', async () => {
    const { readFileSync } = await import('node:fs');
    const pg = await makeServer();
    for (const f of ['20261006000006_least_privilege.sql', '20261006000007_admin_and_account_deletion.sql']) {
      await pg.exec(readFileSync(`legacy/supabase/migrations/${f}`, 'utf8'));
    }
    expect(await count(pg, `select count(*)::int n from pg_trigger where tgname in ('tasks_refs_guard', 'events_refs_guard')`)).toBe(2);
    expect((await pg.query<{ v: boolean }>(`select has_table_privilege('authenticated', 'public.tasks', 'TRUNCATE') v`)).rows[0].v).toBe(false);
  });
});


describe('SEC-RLS-004 원격 적용·롤백 스크립트 리허설 (PGlite)', () => {
  it('0005 상태에 remote_apply_0006_0007.sql → 권한 강화, 데이터 그대로 / 두 번째 실행은 스스로 중단', async () => {
    const { readFileSync } = await import('node:fs');
    const { pg, ids } = await seeded('20261005000005');
    const before = await count(pg, 'select (select count(*) from public.tasks) + (select count(*) from public.events) + (select count(*) from public.domain_ops) n');
    const apply = readFileSync('legacy/supabase/remote_apply_0006_0007.sql', 'utf8');
    await pg.exec(apply);
    expect((await pg.query<{ v: boolean }>(`select has_table_privilege('authenticated', 'public.tasks', 'TRUNCATE') v`)).rows[0].v).toBe(false);
    expect(await count(pg, 'select (select count(*) from public.tasks) + (select count(*) from public.events) + (select count(*) from public.domain_ops) n')).toBe(before);
    expect((await rpc(pg, USER_A, 'tasks', ids[USER_A].tasks, 1, { title: '적용 후 수정' })).status).toBe('applied');
    await expect(pg.exec(apply)).rejects.toThrow(/이미 적용/);
    await pg.exec('rollback').catch(() => undefined);
  });

  it('0005 미적용 상태에서는 적용 스크립트가 아무것도 바꾸지 않고 중단한다', async () => {
    const { readFileSync } = await import('node:fs');
    const pg = await makeServer({ upTo: '20261004000004' });
    await expect(pg.exec(readFileSync('legacy/supabase/remote_apply_0006_0007.sql', 'utf8'))).rejects.toThrow(/0005/);
    await pg.exec('rollback').catch(() => undefined);
    expect(await count(pg, `select count(*)::int n from pg_trigger where tgname = 'tasks_refs_guard'`)).toBe(0);
  });

  it('롤백 스크립트 후에도 앱 동기화(RPC·조회)가 동작하고 데이터는 그대로다', async () => {
    const { readFileSync } = await import('node:fs');
    const { pg, ids } = await seeded();
    await pg.exec(readFileSync('legacy/supabase/remote_rollback_0006_0007.sql', 'utf8'));
    expect(await count(pg, `select count(*)::int n from pg_proc where proname in ('delete_my_account', 'is_admin', 'guard_same_owner_refs')`)).toBe(0);
    expect((await rpc(pg, USER_A, 'tasks', ids[USER_A].tasks, 1, { title: '롤백 후 수정' })).status).toBe('applied');
    expect((await serverQuery(pg, USER_B, 'select id from public.tasks')).map((r) => r.id)).toEqual([ids[USER_B].tasks]);
  });
});
