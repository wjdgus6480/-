-- DOTDAY v0.4.1: 직접 테이블 쓰기 보호 (QUALITY_REVIEW Q-01)
-- 0001~0003 은 수정하지 않는다.
-- 1) RPC 를 거치지 않은 직접 INSERT/UPDATE 도 version·server_seq·updated_at 을 서버가 결정한다.
--    → 다른 기기가 server_seq 로 변경을 받아 가고, 클라이언트가 버전을 조작할 수 없다.
-- 2) 직접 DELETE(tombstone 없는 삭제)를 막는다. 앱은 deleted_at 으로만 삭제한다.
-- 소유권(owner_id) 검사는 기존 RLS 가 계속 담당한다(트리거는 owner_id 를 건드리지 않음).
-- 롤백: drop trigger ... ; drop function public.guard_sync_columns(); grant delete ... to authenticated;

create function public.guard_sync_columns() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.server_seq := nextval(tg_argv[0]::regclass);
    new.updated_at := now();
  else
    if new.id is distinct from old.id then
      raise exception 'id cannot change' using errcode = '42501';
    end if;
    new.created_at := old.created_at;
    new.version := old.version + 1;
    new.updated_at := now();
    new.server_seq := nextval(tg_argv[0]::regclass);
  end if;
  return new;
end;
$$;

create trigger projects_guard   before insert or update on public.projects   for each row execute function public.guard_sync_columns('public.domain_seq');
create trigger categories_guard before insert or update on public.categories for each row execute function public.guard_sync_columns('public.domain_seq');
create trigger tasks_guard      before insert or update on public.tasks      for each row execute function public.guard_sync_columns('public.domain_seq');
create trigger events_guard     before insert or update on public.events     for each row execute function public.guard_sync_columns('public.domain_seq');
create trigger view_preferences_guard before insert or update on public.view_preferences for each row execute function public.guard_sync_columns('public.view_preferences_seq');

-- 직접 삭제 금지 (Supabase 기본 권한으로 anon 에도 부여되어 있을 수 있음)
do $$
declare r text;
begin
  foreach r in array array['authenticated', 'anon'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke delete on public.projects, public.categories, public.tasks, public.events, public.view_preferences from %I', r);
    end if;
  end loop;
end;
$$;
