-- DOTDAY v0.4.2: 멱등성 기록 표 직접 쓰기 차단 (QUALITY_REVIEW Q-10)
-- 문제: domain_ops / view_preference_ops 는 RPC 가 security invoker 라서 authenticated 에 INSERT 권한이 있다.
--       사용자가 REST 로 자기 op_id 결과를 미리 넣으면 자기 기기의 변경이 '이미 적용됨'으로 처리되어 사라질 수 있다.
--       (RLS 때문에 다른 사용자에게는 영향 없음)
-- 해결: RPC 실행 중에만 켜지는 설정값(dotday.rpc)을 함수 속성으로 붙이고, 트리거가 그 값이 없으면 INSERT 를 거부한다.
--       RPC 본문·권한·RLS 는 바꾸지 않는다. 클라이언트(PostgREST)는 이 설정값을 바꿀 수 없다.
-- 롤백: drop trigger ...; drop function public.guard_ops_insert();
--       alter function public.apply_domain_op(uuid, text, uuid, integer, jsonb) reset dotday.rpc;
--       alter function public.apply_view_preference_op(uuid, uuid, integer, jsonb) reset dotday.rpc;

alter function public.apply_domain_op(uuid, text, uuid, integer, jsonb) set dotday.rpc = '1';
alter function public.apply_view_preference_op(uuid, uuid, integer, jsonb) set dotday.rpc = '1';

create function public.guard_ops_insert() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('dotday.rpc', true), '') <> '1' then
    raise exception 'direct writes to % are not allowed', tg_table_name using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger domain_ops_insert_guard before insert on public.domain_ops
  for each row execute function public.guard_ops_insert();
create trigger view_preference_ops_insert_guard before insert on public.view_preference_ops
  for each row execute function public.guard_ops_insert();
