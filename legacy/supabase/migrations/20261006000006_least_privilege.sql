-- DOTDAY v0.5: 공개 서비스 전 최소 권한 정리 (원격 미적용 · 별도 승인 필요)
-- 0001~0005 는 수정하지 않는다. 테이블 구조·데이터·ID·RLS 정책은 바꾸지 않는다.
--
-- 배경: Supabase 기존 프로젝트는 public 스키마의 새 테이블·시퀀스·함수에 anon·authenticated 까지
--       기본 권한(ALL)을 자동으로 부여해 왔다. 0001~0005 는 필요한 권한을 grant 했지만 회수는 하지 않았다.
--   1) TRUNCATE 는 RLS 를 적용받지 않는다 → 로그인한 아무 회원이 모든 회원의 표를 비울 수 있다.
--   2) 시퀀스 UPDATE(setval) → 전 회원이 공유하는 domain_seq 를 되돌리면 다른 회원 기기의 동기화가 멈춘다.
--   3) anon(비로그인)은 RLS 정책이 없어 행은 못 보지만, 쓰기·TRUNCATE 권한 자체는 남아 있을 수 있다.
--   4) REFERENCES/TRIGGER, 함수 EXECUTE(PUBLIC·anon) 는 앱에 필요 없다.
--   5) FK 검사는 RLS 를 무시한다 → 직접 REST 로 다른 회원의 프로젝트·분류·반복 원본 ID 를 참조할 수 있다.
--
-- 앱이 실제로 쓰는 권한 (src/domain/remote.ts, src/views/remote.ts):
--   업무 4표·view_preferences: SELECT(동기화 조회) + INSERT/UPDATE(security invoker RPC 가 사용자 권한으로 기록)
--   domain_ops·view_preference_ops: SELECT + INSERT(RPC 내부, 직접 쓰기는 0005 트리거가 차단)
--   시퀀스: USAGE(nextval) 만 / 함수: authenticated 실행
--
-- 멱등: revoke/grant 는 반복 실행해도 같은 결과. 트리거는 없을 때만 만든다.
-- 롤백: supabase/remote_rollback_0006_0007.sql 참고 (데이터 변경 없음, 권한·트리거만 원복).

do $$
declare
  t text;
  tables text[] := array['projects', 'categories', 'tasks', 'events', 'view_preferences', 'domain_ops', 'view_preference_ops'];
  r text;
begin
  foreach t in array tables loop
    -- anon·PUBLIC: 어떤 권한도 필요 없다
    foreach r in array array['anon', 'public'] loop
      if r = 'public' or exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on public.%I from %s', t, r);
      end if;
    end loop;
    -- authenticated: 일단 전부 회수 후 필요한 것만 다시 부여
    execute format('revoke all on public.%I from authenticated', t);
  end loop;

  grant select, insert, update on public.projects, public.categories, public.tasks, public.events, public.view_preferences to authenticated;
  grant select, insert on public.domain_ops, public.view_preference_ops to authenticated;

  foreach t in array array['domain_seq', 'view_preferences_seq'] loop
    foreach r in array array['anon', 'public'] loop
      if r = 'public' or exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on sequence public.%I from %s', t, r);
      end if;
    end loop;
    execute format('revoke all on sequence public.%I from authenticated', t);
    execute format('grant usage on sequence public.%I to authenticated', t);
  end loop;
end;
$$;

-- 함수: PUBLIC·anon 실행 회수, authenticated 만 (트리거·CHECK 제약에서 쓰는 함수 포함)
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'domain_sync_fields', 'apply_domain_op', 'view_pref_allowed_fields', 'view_pref_config_valid',
      'apply_view_preference_op', 'guard_sync_columns', 'guard_ops_insert')
  loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', f);
    end if;
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- 다른 회원 소유 행 참조 차단 (FK 는 RLS 를 무시하므로 트리거로 보완)
-- 참조 값이 바뀌거나 새로 들어올 때만 검사 → 기존 행의 다른 필드 수정에는 영향 없음.
-- RPC(apply_domain_op)는 이미 RLS 로 같은 검사를 하므로 앱 동작은 그대로다.
create or replace function public.guard_same_owner_refs() returns trigger
language plpgsql set search_path = public as $$
declare
  n jsonb := to_jsonb(new);
  o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  col text;
  target text;
  ok boolean;
begin
  foreach col in array tg_argv loop
    target := case col when 'project_id' then 'projects' when 'category_id' then 'categories' when 'recurrence_parent_id' then 'events' end;
    if target is null then
      raise exception 'guard_same_owner_refs: unknown column %', col;
    end if;
    -- owner_id 변경은 RLS(with check owner_id = auth.uid())가 이미 막으므로 여기서는 참조 값 변경만 본다
    if n->>col is not null and (tg_op = 'INSERT' or n->>col is distinct from o->>col) then
      -- EXECUTE 는 FOUND 를 바꾸지 않으므로 결과를 변수로 받는다
      execute format('select exists (select 1 from public.%I r where r.id = $1 and r.owner_id = $2)', target)
        into ok using (n->>col)::uuid, (n->>'owner_id')::uuid;
      if not ok then
        raise exception 'reference % not owned by row owner', col using errcode = '23503';
      end if;
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function public.guard_same_owner_refs() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.guard_same_owner_refs() from anon;
  end if;
end $$;
grant execute on function public.guard_same_owner_refs() to authenticated;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'tasks_refs_guard') then
    create trigger tasks_refs_guard before insert or update on public.tasks
      for each row execute function public.guard_same_owner_refs('project_id', 'category_id');
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'events_refs_guard') then
    create trigger events_refs_guard before insert or update on public.events
      for each row execute function public.guard_same_owner_refs('project_id', 'category_id', 'recurrence_parent_id');
  end if;
end $$;
