-- DOTDAY 원격 점검 (읽기 전용 · 아무것도 바꾸지 않음)
-- Supabase 대시보드 > SQL Editor 에서 한 블록씩 실행하고 결과를 저장한다.
-- 0006/0007 적용 전·후에 각각 실행해 비교한다. 결과에 개인정보는 없다(이메일·내용 미조회, 개수만).

-- [1] 적용된 DOTDAY 객체로 마이그레이션 상태 추정
select
  exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'domain_ops') as m0003_domain_sync,
  exists (select 1 from pg_trigger where tgname = 'tasks_guard') as m0004_write_guards,
  exists (select 1 from pg_trigger where tgname = 'domain_ops_insert_guard') as m0005_ops_insert_guard,
  exists (select 1 from pg_trigger where tgname = 'tasks_refs_guard') as m0006_least_privilege,
  exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'app_admins') as m0007_admin_deletion;

-- [2] 표 권한 (anon·authenticated). ★ 적용 전 결과를 반드시 저장 → 정확한 롤백용
select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC')
group by grantee, table_name order by table_name, grantee;

-- [2-b] 현재 권한을 GRANT 문으로 출력 (롤백 시 그대로 실행 가능)
select format('grant %s on public.%I to %I;', privilege_type, table_name, grantee) as restore_sql
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;

-- [3] 시퀀스 권한
select c.relname as sequence, r.rolname as role,
  has_sequence_privilege(r.rolname, c.oid, 'USAGE') as usage,
  has_sequence_privilege(r.rolname, c.oid, 'SELECT') as select,
  has_sequence_privilege(r.rolname, c.oid, 'UPDATE') as update_setval
from pg_class c join pg_namespace n on n.oid = c.relnamespace
cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
where n.nspname = 'public' and c.relkind = 'S' order by 1, 2;

-- [4] 함수 실행 권한 + security definer + search_path
select p.oid::regprocedure as function, p.prosecdef as security_definer, p.proconfig as config,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' order by 1;

-- [5] RLS 상태와 정책
select c.relname as table, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' order by 1;

select tablename, policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2;

-- [6] 트리거 · 뷰 (우회 경로 확인)
select event_object_table as table, trigger_name, action_timing, string_agg(event_manipulation, ',') as events
from information_schema.triggers where trigger_schema = 'public' group by 1, 2, 3 order by 1, 2;
select schemaname, viewname from pg_views where schemaname = 'public';

-- [7] 0006 사전 점검: 다른 소유자 행을 참조하는 기존 행 수 (모두 0 이어야 함)
select
  (select count(*) from public.tasks t join public.projects p on p.id = t.project_id where p.owner_id <> t.owner_id) as task_project,
  (select count(*) from public.tasks t join public.categories c on c.id = t.category_id where c.owner_id <> t.owner_id) as task_category,
  (select count(*) from public.events e join public.projects p on p.id = e.project_id where p.owner_id <> e.owner_id) as event_project,
  (select count(*) from public.events e join public.categories c on c.id = e.category_id where c.owner_id <> e.owner_id) as event_category,
  (select count(*) from public.events e join public.events r on r.id = e.recurrence_parent_id where r.owner_id <> e.owner_id) as event_parent;

-- [8] 규모 (개수만 · 백업 대조용)
select 'auth.users' as t, count(*) from auth.users
union all select 'projects', count(*) from public.projects
union all select 'categories', count(*) from public.categories
union all select 'tasks', count(*) from public.tasks
union all select 'events', count(*) from public.events
union all select 'view_preferences', count(*) from public.view_preferences
union all select 'domain_ops', count(*) from public.domain_ops
union all select 'view_preference_ops', count(*) from public.view_preference_ops;

-- [9] 사용자별 행 수 (ID 만, 이메일 미조회) — 관리자 지정 전 소유자 계정 ID 확인용
select owner_id, count(*) from public.tasks group by owner_id order by 2 desc;

-- [10] auth.users 삭제 가능 여부 (탈퇴 RPC 전제, 실제 삭제는 하지 않음)
select has_table_privilege(current_user, 'auth.users', 'DELETE') as can_delete_auth_users, current_user;
