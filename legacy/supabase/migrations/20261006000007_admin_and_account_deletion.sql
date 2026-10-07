-- DOTDAY v0.5: 관리자 구분 + 본인 계정 탈퇴 (원격 미적용 · 별도 승인 필요)
-- 기존 테이블·데이터는 바꾸지 않는다.
--
-- [관리자]
--   - 관리자 여부는 서버 표 app_admins 로만 결정한다. 클라이언트(anon·authenticated)는 이 표를 읽거나 쓸 수 없다.
--   - 지정·해제는 Supabase SQL Editor(소유자 권한)에서만 한다. 이메일 비교·하드코딩 없음.
--       insert into public.app_admins (user_id, note) values ('<auth.users.id 확인 후>', 'owner');
--   - 관리자에게 다른 회원 데이터를 볼 수 있는 전역 권한은 주지 않는다 (RLS 그대로). is_admin() 은 '내가 관리자인가'만 답한다.
--
-- [탈퇴] delete_my_account(p_confirm)
--   - 로그인한 본인(auth.uid())의 auth.users 행만 삭제한다. 인자로 사용자 ID 를 받지 않는다 → 다른 회원 삭제 불가.
--   - 재인증: 최근 10분 안에 로그인(비밀번호·OAuth·메일 코드)한 세션만 허용 (auth.users.last_sign_in_at, 서버에서 판단).
--   - 업무 데이터·보기 설정·동기화 기록은 모두 owner_id → auth.users ON DELETE CASCADE 로 같은 트랜잭션에서 삭제된다.
--     하나라도 실패하면 전체 롤백 → 부분 삭제 상태가 남지 않는다.
--   - 관리자 계정은 잠김 방지를 위해 먼저 app_admins 에서 해제해야 탈퇴할 수 있다.
--   - security definer: 함수 소유자 권한으로 auth.users 를 지운다. search_path 를 비워 객체 바꿔치기를 막는다.
--   - 이미 발급된 액세스 토큰은 만료(기본 1시간)까지 형식상 유효하지만, 행이 없으므로 RLS 상 볼 데이터가 없다.
--
-- 롤백: supabase/remote_rollback_0006_0007.sql (탈퇴로 지워진 데이터는 되돌릴 수 없음 — 백업으로만 복구)

create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  note text not null default '',
  granted_at timestamptz not null default now()
);
alter table public.app_admins enable row level security;
-- 정책을 만들지 않고 권한도 회수 → 클라이언트에서 접근 불가
revoke all on public.app_admins from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.app_admins from anon;
  end if;
  revoke all on public.app_admins from authenticated;
end $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins a where a.user_id = auth.uid())
$$;

create or replace function public.delete_my_account(p_confirm text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_last timestamptz;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_confirm is distinct from 'DELETE' then
    return jsonb_build_object('status', 'rejected', 'reason', 'confirm_required');
  end if;
  select u.last_sign_in_at into v_last from auth.users u where u.id = v_uid;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_last is null or v_last < now() - interval '10 minutes' then
    return jsonb_build_object('status', 'reauth_required');
  end if;
  if exists (select 1 from public.app_admins a where a.user_id = v_uid) then
    return jsonb_build_object('status', 'rejected', 'reason', 'admin_account');
  end if;
  delete from auth.users u where u.id = v_uid;
  return jsonb_build_object('status', 'deleted');
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['public.is_admin()', 'public.delete_my_account(text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', f);
    end if;
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
