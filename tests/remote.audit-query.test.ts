import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeServer, serverQuery, USER_A, USER_B } from './helpers';

const SQL = readFileSync('legacy/supabase/remote_audit_readonly_onequery.sql', 'utf8');

/** 원격 Supabase 에 있는 auth 컬럼·표 일부를 흉내 (감사 쿼리 실행용) */
async function server(upTo?: string) {
  const pg = await makeServer({ upTo });
  await pg.exec(`
    alter table auth.users add column email_confirmed_at timestamptz;
    create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid, provider text);
    insert into auth.identities (user_id, provider) select id, 'email' from auth.users;
  `);
  return pg;
}

async function audit(pg: Awaited<ReturnType<typeof server>>) {
  // READ ONLY 트랜잭션: 쿼리에 쓰기가 하나라도 있으면 Postgres 가 오류를 낸다
  return pg.transaction(async (tx) => {
    await tx.exec('set transaction read only');
    const r = await tx.query<{ audit: string }>(SQL);
    return JSON.parse(r.rows[0].audit);
  });
}

describe('REM-AUDIT-001 원격 감사 쿼리 (읽기 전용 단일 SELECT)', () => {
  it('주석을 뺀 본문에 쓰기·DDL·권한 변경 문이 없다', () => {
    const body = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(body).not.toMatch(/\b(insert|update|delete|truncate|alter|drop|grant|revoke|create|copy|vacuum|lock|setval|nextval)\s/i);
    expect(body.trim().toLowerCase().startsWith('with')).toBe(true);
    expect(body.match(/;/g)?.length).toBe(1);
  });

  it('0005 까지 상태: READ ONLY 트랜잭션에서 실행되고 R1·R2·R3 를 그대로 보여 준다', async () => {
    const a = await audit(await server('20261005000005'));
    expect(a.migration_markers).toMatchObject({ m0005_ops_insert_guard: true, m0005_rpc_setting: true, m0006_refs_guard: false, m0007_app_admins: false });
    expect(a.table_privileges.tasks.authenticated).toContain('TRUNCATE');
    expect(a.table_privileges.tasks.anon).toContain('INSERT');
    expect(a.sequence_privileges.domain_seq.roles.authenticated.update_setval).toBe(true);
    expect(a.auth).toMatchObject({ users_total: 2, identities_by_provider: { email: 2 }, has_last_sign_in_at_column: true });
    expect(Object.keys(a.rls).sort()).toEqual(['categories', 'domain_ops', 'events', 'projects', 'tasks', 'view_preference_ops', 'view_preferences']);
  });

  it('0006·0007 적용 후: 같은 쿼리로 권한 강화가 확인된다', async () => {
    const a = await audit(await server());
    expect(a.migration_markers).toMatchObject({ m0006_refs_guard: true, m0007_app_admins: true });
    expect(a.table_privileges.tasks).toMatchObject({ anon: [], authenticated: ['INSERT', 'SELECT', 'UPDATE'] });
    expect(a.sequence_privileges.domain_seq.roles.authenticated).toEqual({ usage: true, select: false, update_setval: false });
    expect(a.functions.filter((f: any) => f.security_definer).map((f: any) => f.name).sort()).toEqual(['delete_my_account', 'is_admin']);
    expect(a.functions.every((f: any) => f.exec.anon === false)).toBe(true);
  });
});

describe('REM-AUDIT-002 자동 GRANT 없는 Supabase 모델(2026-05-30 이후 생성 프로젝트)', () => {
  it('0005 까지: anon 은 표 권한 없음(원격 GET 결과와 일치), authenticated 는 명시적 grant 만 — TRUNCATE·setval 없음', async () => {
    const pg = await makeServer({ upTo: '20261005000005', defaults: 'none' });
    await pg.exec(`alter table auth.users add column email_confirmed_at timestamptz; create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid, provider text);`);
    const a = await audit(pg);
    for (const t of ['projects', 'categories', 'tasks', 'events', 'view_preferences', 'domain_ops', 'view_preference_ops']) {
      expect(a.table_privileges[t].anon, t).toEqual([]);
      expect(a.table_privileges[t].authenticated, t).not.toContain('TRUNCATE');
    }
    expect(a.table_privileges.tasks.authenticated).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(a.sequence_privileges.domain_seq.roles.authenticated).toEqual({ usage: true, select: false, update_setval: false });
    // 함수는 Postgres 기본값(PUBLIC 실행)이라 anon 도 실행 가능 — 원격 GET 결과와 일치
    expect(a.functions.find((f: any) => f.name === 'domain_sync_fields').exec.anon).toBe(true);
  });

  it('같은 모델에서 0006·0007 적용 스크립트가 충돌 없이 들어가고 결과 권한이 같다', async () => {
    const pg = await makeServer({ upTo: '20261005000005', defaults: 'none' });
    await pg.exec(readFileSync('legacy/supabase/remote_apply_0006_0007.sql', 'utf8'));
    await pg.exec(`alter table auth.users add column email_confirmed_at timestamptz; create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid, provider text);`);
    const a = await audit(pg);
    expect(a.table_privileges.tasks).toMatchObject({ anon: [], authenticated: ['INSERT', 'SELECT', 'UPDATE'] });
    expect(a.functions.every((f: any) => f.exec.anon === false)).toBe(true);
    expect(a.migration_markers).toMatchObject({ m0006_refs_guard: true, m0007_app_admins: true });
  });
});

describe('REM-AUDIT-003 0007 탈퇴 삭제 범위 (auth.users 를 참조하는 FK)', () => {
  it('로컬 소스 기준: DOTDAY 7표는 모두 CASCADE, app_admins 도 CASCADE, 그 외 참조 없음', async () => {
    const a = await audit(await server());
    const fks = Object.fromEntries(a.auth.fks_referencing_auth_users.map((f: any) => [f.table, f.on_delete]));
    expect(fks).toEqual({
      'app_admins': 'c', 'categories': 'c', 'domain_ops': 'c', 'events': 'c', 'projects': 'c', 'tasks': 'c', 'view_preference_ops': 'c', 'view_preferences': 'c',
    });
    expect(a.auth.storage_objects_estimate).toBeNull();
  });
});

describe('REM-AUDIT-004 R4 · 0007 순서 (원격과 같은 none 모델, 0005 까지)', () => {
  const ev = (id: string, owner: string, parent?: string) =>
    parent
      ? [`insert into public.events (id, owner_id, title, start_at, end_at, recurrence_parent_id, original_start_at) values ($1, $2, 'x', now(), now(), $3, now())`, [id, owner, parent]]
      : [`insert into public.events (id, owner_id, title, start_at, end_at) values ($1, $2, 'x', now(), now())`, [id, owner]];

  it('R4: 0005 상태에서는 회원 A 가 직접 REST 쓰기로 B 의 프로젝트·반복 원본을 참조할 수 있다 (FK 는 RLS 무시)', async () => {
    const pg = await makeServer({ upTo: '20261005000005', defaults: 'none' });
    const bProject = crypto.randomUUID();
    const bEvent = crypto.randomUUID();
    await serverQuery(pg, USER_B, `insert into public.projects (id, owner_id, name) values ($1, $2, 'B')`, [bProject, USER_B]);
    await serverQuery(pg, USER_B, ev(bEvent, USER_B)[0] as string, ev(bEvent, USER_B)[1] as unknown[]);
    await serverQuery(pg, USER_A, `insert into public.tasks (id, owner_id, title, project_id) values ($1, $2, 'A', $3)`, [crypto.randomUUID(), USER_A, bProject]);
    const [q, p] = ev(crypto.randomUUID(), USER_A, bEvent);
    await serverQuery(pg, USER_A, q as string, p as unknown[]);
    expect((await pg.query<{ n: number }>(`select count(*)::int n from public.tasks t join public.projects p on p.id = t.project_id where p.owner_id <> t.owner_id`)).rows[0].n).toBe(1);
  });

  it('0007 을 0006 없이 적용하면: B 탈퇴가 A 의 일정(B 의 반복 원본 참조)을 삭제하고 A 의 투두를 수정한다 → 0006(사전 점검 포함)이 먼저여야 함', async () => {
    const pg = await makeServer({ upTo: '20261005000005', defaults: 'none' });
    await pg.exec(readFileSync('legacy/supabase/migrations/20261006000007_admin_and_account_deletion.sql', 'utf8'));
    const bProject = crypto.randomUUID();
    const bEvent = crypto.randomUUID();
    const aEvent = crypto.randomUUID();
    const aTask = crypto.randomUUID();
    await serverQuery(pg, USER_B, `insert into public.projects (id, owner_id, name) values ($1, $2, 'B')`, [bProject, USER_B]);
    await serverQuery(pg, USER_B, ev(bEvent, USER_B)[0] as string, ev(bEvent, USER_B)[1] as unknown[]);
    await serverQuery(pg, USER_A, `insert into public.tasks (id, owner_id, title, project_id) values ($1, $2, 'A', $3)`, [aTask, USER_A, bProject]);
    const [q, p] = ev(aEvent, USER_A, bEvent);
    await serverQuery(pg, USER_A, q as string, p as unknown[]);
    expect((await serverQuery(pg, USER_B, `select public.delete_my_account('DELETE') r`))[0].r).toEqual({ status: 'deleted' });
    expect((await pg.query(`select 1 from public.events where id = $1`, [aEvent])).rows.length).toBe(0); // A 의 행 삭제됨
    expect((await pg.query<any>(`select project_id, version from public.tasks where id = $1`, [aTask])).rows[0]).toEqual({ project_id: null, version: 2 }); // A 의 행 수정됨
  });

  it('remote_apply_0006_0007 은 그런 교차 참조가 이미 있으면 적용을 중단한다', async () => {
    const pg = await makeServer({ upTo: '20261005000005', defaults: 'none' });
    const bProject = crypto.randomUUID();
    await serverQuery(pg, USER_B, `insert into public.projects (id, owner_id, name) values ($1, $2, 'B')`, [bProject, USER_B]);
    await serverQuery(pg, USER_A, `insert into public.tasks (id, owner_id, title, project_id) values ($1, $2, 'A', $3)`, [crypto.randomUUID(), USER_A, bProject]);
    await expect(pg.exec(readFileSync('legacy/supabase/remote_apply_0006_0007.sql', 'utf8'))).rejects.toThrow(/다른 소유자 행을 참조/);
    await pg.exec('rollback').catch(() => undefined);
    expect((await pg.query(`select 1 from pg_trigger where tgname = 'tasks_refs_guard'`)).rows.length).toBe(0);
  });
});
