-- DOTDAY 롤백: 0007 → 0006 (데이터 행은 바꾸지 않음) — 문제가 생겼을 때만, 승인 후 실행
-- 주의: 탈퇴 RPC 로 이미 삭제된 계정·데이터는 이 스크립트로 복구되지 않는다 (백업으로만 복구).
-- 권한은 '앱이 동작하는 최소 상태'(0001~0005 의 명시적 grant)로 되돌린다.
-- 적용 전 상태와 똑같이 되돌리려면 remote_inspect_readonly.sql [2-b] 로 저장해 둔 GRANT 문을 이어서 실행한다.
begin;

-- 0007
drop function if exists public.delete_my_account(text);
drop function if exists public.is_admin();
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'app_admins') then
    if exists (select 1 from public.app_admins) then
      raise notice 'app_admins 에 지정된 관리자가 있습니다. 표를 삭제합니다 (관리자 지정 기록만 사라짐).';
    end if;
    drop table public.app_admins;
  end if;
end $$;

-- 0006
drop trigger if exists tasks_refs_guard on public.tasks;
drop trigger if exists events_refs_guard on public.events;
drop function if exists public.guard_same_owner_refs();

grant select, insert, update on public.projects, public.categories, public.tasks, public.events, public.view_preferences to authenticated;
grant select, insert on public.domain_ops, public.view_preference_ops to authenticated;
grant usage on sequence public.domain_seq, public.view_preferences_seq to authenticated;
grant execute on function public.apply_domain_op(uuid, text, uuid, integer, jsonb) to authenticated;
grant execute on function public.apply_view_preference_op(uuid, uuid, integer, jsonb) to authenticated;

commit;
