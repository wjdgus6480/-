-- DOTDAY 원격 보안 감사 — SELECT 한 문장 (읽기 전용 · 아무것도 바꾸지 않음)
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여 넣고 Run → 결과 셀(audit) 하나를 복사해 전달.
-- 결과에는 이메일·이름·업무 내용·키 값이 없다. 권한·정책·함수 정의 메타데이터와 행 개수만 나온다.
-- 쓰기 문장(INSERT/UPDATE/DELETE/DDL/GRANT/REVOKE)이 없고, 호출하는 함수는 모두 조회용(has_*_privilege, pg_get_*)이다.
with
roles as (
  select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role')
),
tbls as (
  select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
),
seqs as (
  select c.oid, c.relname, pg_get_userbyid(c.relowner) as owner
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'S'
),
funcs as (
  select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.provolatile,
         p.proconfig, pg_get_userbyid(p.proowner) as owner, p.proacl::text as acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
)
select jsonb_pretty(jsonb_build_object(
  'meta', jsonb_build_object(
    'database', current_database(),
    'current_user', current_user,
    'server_version', current_setting('server_version'),
    'checked_at', now()
  ),
  'migration_markers', jsonb_build_object(
    'm0003_domain_ops', exists (select 1 from tbls where relname = 'domain_ops'),
    'm0004_tasks_guard', exists (select 1 from pg_trigger where tgname = 'tasks_guard' and not tgisinternal),
    'm0005_ops_insert_guard', exists (select 1 from pg_trigger where tgname = 'domain_ops_insert_guard' and not tgisinternal),
    'm0005_rpc_setting', exists (select 1 from funcs where proname = 'apply_domain_op' and proconfig::text like '%dotday.rpc=1%'),
    'm0006_refs_guard', exists (select 1 from pg_trigger where tgname = 'tasks_refs_guard' and not tgisinternal),
    'm0007_app_admins', exists (select 1 from tbls where relname = 'app_admins')
  ),
  'table_privileges', (
    select jsonb_object_agg(t.relname, (
      select jsonb_object_agg(r.rolname, (
        select coalesce(jsonb_agg(p order by p), '[]'::jsonb)
        from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
        where has_table_privilege(r.rolname, t.oid, p)
      )) from roles r
    )) from tbls t
  ),
  'table_acl_public', (select jsonb_object_agg(c.relname, c.relacl::text) from pg_class c join tbls t on t.oid = c.oid),
  'rls', (select jsonb_object_agg(relname, jsonb_build_object('enabled', relrowsecurity, 'forced', relforcerowsecurity, 'owner', owner)) from tbls),
  'policies', (
    select coalesce(jsonb_agg(jsonb_build_object('table', tablename, 'policy', policyname, 'cmd', cmd, 'permissive', permissive,
      'roles', roles, 'using', qual, 'with_check', with_check) order by tablename, policyname), '[]'::jsonb)
    from pg_policies where schemaname = 'public'
  ),
  'sequence_privileges', (
    select jsonb_object_agg(s.relname, jsonb_build_object('owner', s.owner, 'roles', (
      select jsonb_object_agg(r.rolname, jsonb_build_object(
        'usage', has_sequence_privilege(r.rolname, s.oid, 'USAGE'),
        'select', has_sequence_privilege(r.rolname, s.oid, 'SELECT'),
        'update_setval', has_sequence_privilege(r.rolname, s.oid, 'UPDATE'))) from roles r
    ))) from seqs s
  ),
  'functions', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', f.proname, 'args', f.args, 'security_definer', f.prosecdef, 'volatility', f.provolatile,
      'config', f.proconfig, 'owner', f.owner, 'acl', f.acl,
      'exec', (select jsonb_object_agg(r.rolname, has_function_privilege(r.rolname, f.oid, 'EXECUTE')) from roles r)
    ) order by f.proname), '[]'::jsonb) from funcs f
  ),
  'triggers', (
    select coalesce(jsonb_agg(jsonb_build_object('table', c.relname, 'trigger', tg.tgname, 'function', p.proname,
      'enabled', tg.tgenabled, 'definition', pg_get_triggerdef(tg.oid)) order by c.relname, tg.tgname), '[]'::jsonb)
    from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = tg.tgfoid
    where n.nspname = 'public' and not tg.tgisinternal
  ),
  'foreign_keys', (
    select coalesce(jsonb_agg(jsonb_build_object('table', c.relname, 'name', con.conname, 'definition', pg_get_constraintdef(con.oid)) order by c.relname, con.conname), '[]'::jsonb)
    from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and con.contype = 'f'
  ),
  'views_in_public', (select coalesce(jsonb_agg(viewname), '[]'::jsonb) from pg_views where schemaname = 'public'),
  'default_privileges_public', (
    select coalesce(jsonb_agg(jsonb_build_object('owner', pg_get_userbyid(d.defaclrole), 'objtype', d.defaclobjtype, 'acl', d.defaclacl::text)), '[]'::jsonb)
    from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
    where n.nspname = 'public' or d.defaclnamespace = 0
  ),
  'cross_owner_refs', (
    select jsonb_build_object(
      'task_project', (select count(*) from public.tasks t join public.projects p on p.id = t.project_id where p.owner_id <> t.owner_id),
      'task_category', (select count(*) from public.tasks t join public.categories c on c.id = t.category_id where c.owner_id <> t.owner_id),
      'event_project', (select count(*) from public.events e join public.projects p on p.id = e.project_id where p.owner_id <> e.owner_id),
      'event_category', (select count(*) from public.events e join public.categories c on c.id = e.category_id where c.owner_id <> e.owner_id),
      'event_parent', (select count(*) from public.events e join public.events r on r.id = e.recurrence_parent_id where r.owner_id <> e.owner_id))
  ),
  'row_counts', jsonb_build_object(
    'projects', (select count(*) from public.projects),
    'categories', (select count(*) from public.categories),
    'tasks', (select count(*) from public.tasks),
    'events', (select count(*) from public.events),
    'view_preferences', (select count(*) from public.view_preferences),
    'domain_ops', (select count(*) from public.domain_ops),
    'view_preference_ops', (select count(*) from public.view_preference_ops),
    'distinct_owners_tasks', (select count(distinct owner_id) from public.tasks)
  ),
  'auth', jsonb_build_object(
    'users_total', (select count(*) from auth.users),
    'users_email_unconfirmed', (select count(*) from auth.users where email_confirmed_at is null),
    'users_signed_in_last_7d', (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
    'identities_by_provider', (select coalesce(jsonb_object_agg(provider, n), '{}'::jsonb) from (select provider, count(*) n from auth.identities group by provider) x),
    'has_last_sign_in_at_column', exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'last_sign_in_at'),
    'current_user_can_delete_auth_users', has_table_privilege(current_user, 'auth.users', 'DELETE'),
    'current_user_can_reference_auth_users', has_table_privilege(current_user, 'auth.users', 'REFERENCES'),
    'auth_users_owner', (select pg_get_userbyid(relowner) from pg_class where oid = 'auth.users'::regclass),
    -- 0007 탈퇴 시 삭제 범위: auth.users 를 참조하는 모든 FK (모든 스키마). a=no action, r=restrict, c=cascade, n=set null, d=set default
    'fks_referencing_auth_users', (
      select coalesce(jsonb_agg(jsonb_build_object('table', con.conrelid::regclass::text, 'name', con.conname, 'on_delete', con.confdeltype) order by 1), '[]'::jsonb)
      from pg_constraint con where con.contype = 'f' and con.confrelid = 'auth.users'::regclass
    ),
    -- Storage 객체 소유자가 있으면 auth.users 삭제가 막힐 수 있음 (Supabase 문서). 통계 기반 추정치, 표가 없으면 null
    'storage_objects_estimate', (select n_live_tup from pg_stat_all_tables where relid = to_regclass('storage.objects'))
  )
)) as audit;
