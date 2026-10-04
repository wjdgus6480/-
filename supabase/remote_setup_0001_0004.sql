-- DOTDAY 원격 초기 설정: migrations 0001~0004 를 순서대로 합친 파일 (자동 생성, 직접 수정하지 말 것)
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여 넣고 Run.
-- 한 트랜잭션: 중간에 실패하면 아무것도 적용되지 않는다.
begin;

-- 사전 점검: 이미 같은 이름의 객체가 있으면 아무것도 바꾸지 않고 중단
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public'
             and table_name in ('projects','categories','tasks','events','view_preferences','view_preference_ops','domain_ops')) then
    raise exception 'DOTDAY 테이블이 이미 있습니다. 적용을 중단합니다 (기존 데이터 보호).';
  end if;
end $$;

-- ===== migrations/20261002000001_base_domain.sql =====
-- DOTDAY 기본 도메인 (v0.1~v0.2 범위의 최소 스키마)
-- 기존 이력이 없는 상태에서 새로 시작했기 때문에 기본 도메인을 이 파일로 고정한다.
-- 이후 기능은 이 파일을 수정하지 않고 새 마이그레이션으로 추가한다.

create table public.projects (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text not null default '',
  status text not null default 'active' check (status in ('active', 'on_hold', 'done', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1 check (version >= 1)
);

create table public.categories (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  color text not null default '#888888',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1 check (version >= 1)
);

create table public.tasks (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 300),
  description text not null default '',
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  due_date date,
  project_id uuid references public.projects(id) on delete set null,
  category_id uuid references public.categories(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1 check (version >= 1)
);

create table public.events (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 300),
  description text not null default '',
  start_at timestamptz not null,
  end_at timestamptz not null,
  all_day boolean not null default false,
  timezone text not null default 'Asia/Seoul',
  recurrence_rule text,
  project_id uuid references public.projects(id) on delete set null,
  category_id uuid references public.categories(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1 check (version >= 1),
  check (end_at >= start_at)
);

create index tasks_owner_idx on public.tasks (owner_id) where deleted_at is null;
create index events_owner_start_idx on public.events (owner_id, start_at) where deleted_at is null;
create index projects_owner_idx on public.projects (owner_id) where deleted_at is null;
create index categories_owner_idx on public.categories (owner_id) where deleted_at is null;

alter table public.projects enable row level security;
alter table public.categories enable row level security;
alter table public.tasks enable row level security;
alter table public.events enable row level security;

create policy projects_owner on public.projects for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy categories_owner on public.categories for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy tasks_owner on public.tasks for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy events_owner on public.events for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

grant select, insert, update, delete on public.projects, public.categories, public.tasks, public.events to authenticated;

-- ===== migrations/20261002000002_view_preferences.sql =====
-- DOTDAY v0.3: 사용자 정의 테이블 보기 설정
-- 업무 테이블(tasks, events, projects, categories)은 변경하지 않는다.

-- 허용 필드 목록. src/views/fields.ts 의 레지스트리와 같아야 한다 (tests/view.server.test.ts 에서 검증).
create function public.view_pref_allowed_fields(p_view_key text) returns text[]
language sql immutable as $$
  select case p_view_key
    when 'tasks' then array['title','description','status','priority','due_date','project','category','created_at','updated_at','completed_at']
    when 'events' then array['title','description','start_at','end_at','all_day','timezone','recurring','project','category','updated_at']
    when 'projects' then array['name','description','status','created_at','updated_at','task_count','open_task_count','event_count']
    else array[]::text[]
  end
$$;

create function public.view_pref_config_valid(p_view_key text, p_cols jsonb, p_sorts jsonb, p_filters jsonb)
returns boolean language plpgsql immutable as $$
declare
  allowed text[] := public.view_pref_allowed_fields(p_view_key);
  el jsonb;
  seen_fields text[] := array[]::text[];
  seen_pos int[] := array[]::int[];
begin
  if jsonb_typeof(p_cols) <> 'array' or jsonb_typeof(p_sorts) <> 'array' or jsonb_typeof(p_filters) <> 'object' then
    return false;
  end if;
  for el in select * from jsonb_array_elements(p_cols) loop
    if jsonb_typeof(el) <> 'object'
       or not (el->>'field' = any(allowed))
       or el->>'field' = any(seen_fields)
       or jsonb_typeof(el->'width') <> 'number' or (el->>'width')::numeric not between 60 and 800
       or jsonb_typeof(el->'position') <> 'number' or (el->>'position')::int = any(seen_pos)
       or jsonb_typeof(el->'visible') <> 'boolean' then
      return false;
    end if;
    seen_fields := seen_fields || (el->>'field');
    seen_pos := seen_pos || (el->>'position')::int;
  end loop;
  if jsonb_array_length(p_sorts) > 3 then return false; end if;
  for el in select * from jsonb_array_elements(p_sorts) loop
    if not (el->>'field' = any(allowed)) or coalesce(el->>'dir', '') not in ('asc', 'desc') then
      return false;
    end if;
  end loop;
  if p_filters ? 'search' and (jsonb_typeof(p_filters->'search') <> 'string' or char_length(p_filters->>'search') > 200) then
    return false;
  end if;
  if p_filters ? 'conditions' then
    if jsonb_typeof(p_filters->'conditions') <> 'array' then return false; end if;
    for el in select * from jsonb_array_elements(p_filters->'conditions') loop
      if not (el->>'field' = any(allowed)) or coalesce(el->>'type', '') not in ('in', 'dateRange', 'bool') then
        return false;
      end if;
    end loop;
  end if;
  return true;
end;
$$;

create sequence public.view_preferences_seq;

create table public.view_preferences (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  local_profile_id text,
  view_key text not null check (view_key in ('tasks', 'events', 'projects')),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  column_config jsonb not null,
  sort_config jsonb not null default '[]'::jsonb,
  filter_config jsonb not null default '{}'::jsonb,
  layout_config jsonb not null default '{}'::jsonb check (jsonb_typeof(layout_config) = 'object'),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1 check (version >= 1),
  server_seq bigint not null default nextval('public.view_preferences_seq'),
  constraint view_preferences_config_valid
    check (public.view_pref_config_valid(view_key, column_config, sort_config, filter_config))
);

create index view_preferences_owner_key_idx on public.view_preferences (owner_id, view_key) where deleted_at is null;
create index view_preferences_owner_seq_idx on public.view_preferences (owner_id, server_seq);

-- 멱등성 기록: 같은 operation ID 재전송 시 저장된 결과를 그대로 돌려준다.
create table public.view_preference_ops (
  op_id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  view_id uuid not null,
  result jsonb not null,
  applied_at timestamptz not null default now()
);
create index view_preference_ops_owner_idx on public.view_preference_ops (owner_id, applied_at);

alter table public.view_preferences enable row level security;
alter table public.view_preference_ops enable row level security;

create policy view_preferences_select on public.view_preferences for select to authenticated
  using (owner_id = auth.uid());
create policy view_preferences_insert on public.view_preferences for insert to authenticated
  with check (owner_id = auth.uid());
create policy view_preferences_update on public.view_preferences for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy view_preferences_delete on public.view_preferences for delete to authenticated
  using (owner_id = auth.uid());

create policy view_preference_ops_select on public.view_preference_ops for select to authenticated
  using (owner_id = auth.uid());
create policy view_preference_ops_insert on public.view_preference_ops for insert to authenticated
  with check (owner_id = auth.uid());

grant select, insert, update, delete on public.view_preferences to authenticated;
grant select, insert on public.view_preference_ops to authenticated;
grant usage on sequence public.view_preferences_seq to authenticated;

-- 변경 적용 RPC. security invoker 이므로 위 RLS 가 그대로 적용된다.
-- 반환: {status: 'applied'|'conflict'|'not_found'|'rejected', row?, duplicate?, reason?}
create function public.apply_view_preference_op(
  p_op_id uuid, p_view_id uuid, p_base_version integer, p_patch jsonb
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_prev jsonb;
  v_row public.view_preferences;
  v_result jsonb;
  v_key text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select result into v_prev from public.view_preference_ops where op_id = p_op_id;
  if found then
    return v_prev || jsonb_build_object('duplicate', true);
  end if;

  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in ('view_key', 'name', 'column_config', 'sort_config', 'filter_config',
                     'layout_config', 'is_default', 'deleted_at', 'local_profile_id', 'created_at') then
      return jsonb_build_object('status', 'rejected', 'reason', 'invalid_patch_key:' || v_key);
    end if;
  end loop;

  select * into v_row from public.view_preferences where id = p_view_id for update;

  begin
    if not found then
      if p_base_version <> 0 then
        return jsonb_build_object('status', 'not_found');
      end if;
      insert into public.view_preferences (
        id, owner_id, local_profile_id, view_key, name, column_config, sort_config,
        filter_config, layout_config, is_default, created_at, deleted_at
      ) values (
        p_view_id, v_uid, p_patch->>'local_profile_id', p_patch->>'view_key', p_patch->>'name',
        p_patch->'column_config', coalesce(p_patch->'sort_config', '[]'::jsonb),
        coalesce(p_patch->'filter_config', '{}'::jsonb), coalesce(p_patch->'layout_config', '{}'::jsonb),
        coalesce((p_patch->>'is_default')::boolean, false),
        coalesce((p_patch->>'created_at')::timestamptz, now()),
        (p_patch->>'deleted_at')::timestamptz
      ) returning * into v_row;
    elsif v_row.version <> p_base_version then
      -- 충돌 결과는 기록하지 않는다. 클라이언트가 병합 후 같은 op_id 로 재시도할 수 있다.
      return jsonb_build_object('status', 'conflict', 'row', to_jsonb(v_row));
    else
      update public.view_preferences set
        name = case when p_patch ? 'name' then p_patch->>'name' else name end,
        column_config = case when p_patch ? 'column_config' then p_patch->'column_config' else column_config end,
        sort_config = case when p_patch ? 'sort_config' then p_patch->'sort_config' else sort_config end,
        filter_config = case when p_patch ? 'filter_config' then p_patch->'filter_config' else filter_config end,
        layout_config = case when p_patch ? 'layout_config' then p_patch->'layout_config' else layout_config end,
        is_default = case when p_patch ? 'is_default' then (p_patch->>'is_default')::boolean else is_default end,
        deleted_at = case when p_patch ? 'deleted_at' then (p_patch->>'deleted_at')::timestamptz else deleted_at end,
        version = version + 1,
        updated_at = now(),
        server_seq = nextval('public.view_preferences_seq')
      where id = p_view_id
      returning * into v_row;
    end if;
  exception
    when unique_violation then
      -- 다른 사용자의 ID 이거나 이미 존재: 내용을 노출하지 않고 거부
      return jsonb_build_object('status', 'rejected', 'reason', 'id_unavailable');
    when check_violation or not_null_violation or invalid_text_representation then
      return jsonb_build_object('status', 'rejected', 'reason', 'invalid_config');
  end;

  v_result := jsonb_build_object('status', 'applied', 'row', to_jsonb(v_row));
  insert into public.view_preference_ops (op_id, owner_id, view_id, result)
    values (p_op_id, v_uid, p_view_id, v_result);
  return v_result;
end;
$$;

grant execute on function public.apply_view_preference_op(uuid, uuid, integer, jsonb) to authenticated;

-- ===== migrations/20261002000003_domain_sync.sql =====
-- DOTDAY v0.4: 업무 데이터(프로젝트·분류·일정·투두) 동기화
-- 기존 테이블을 재구축하지 않고 컬럼·인덱스·함수만 추가한다.
-- 보기 설정 동기화(view_preferences, apply_view_preference_op)와는 별개의 기능이다.

create sequence public.domain_seq;

alter table public.projects   add column server_seq bigint not null default nextval('public.domain_seq');
alter table public.categories add column server_seq bigint not null default nextval('public.domain_seq');
alter table public.tasks      add column server_seq bigint not null default nextval('public.domain_seq');
alter table public.events     add column server_seq bigint not null default nextval('public.domain_seq');

create index projects_owner_seq_idx   on public.projects   (owner_id, server_seq);
create index categories_owner_seq_idx on public.categories (owner_id, server_seq);
create index tasks_owner_seq_idx      on public.tasks      (owner_id, server_seq);
create index events_owner_seq_idx     on public.events     (owner_id, server_seq);

-- 반복 일정의 회차 예외: 별도 일정 행으로 저장 (단일 회차 변경·취소)
alter table public.events
  add column recurrence_parent_id uuid references public.events(id) on delete cascade,
  add column original_start_at timestamptz,
  add column is_cancelled boolean not null default false;

alter table public.events
  add constraint events_override_pair check ((recurrence_parent_id is null) = (original_start_at is null)),
  add constraint events_override_no_rule check (recurrence_parent_id is null or recurrence_rule is null),
  add constraint events_rule_format check (
    recurrence_rule is null or recurrence_rule ~ '^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;(INTERVAL=[1-9][0-9]{0,2}|COUNT=[1-9][0-9]{0,3}|UNTIL=[0-9]{8}|BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU)){0,6}))*$'
  );

create unique index events_override_unique on public.events (recurrence_parent_id, original_start_at) where recurrence_parent_id is not null;

-- 멱등성 기록
create table public.domain_ops (
  op_id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entity text not null,
  record_id uuid not null,
  result jsonb not null,
  applied_at timestamptz not null default now()
);
create index domain_ops_owner_idx on public.domain_ops (owner_id, applied_at);
alter table public.domain_ops enable row level security;
create policy domain_ops_select on public.domain_ops for select to authenticated using (owner_id = auth.uid());
create policy domain_ops_insert on public.domain_ops for insert to authenticated with check (owner_id = auth.uid());
grant select, insert on public.domain_ops to authenticated;
grant usage on sequence public.domain_seq to authenticated;

-- 엔티티별 동기화 허용 필드. src/domain/types.ts ENTITY_FIELDS 와 같아야 한다 (테스트로 검증).
-- 허용 목록에 없는 엔티티는 null → 거부. 동적 SQL 의 테이블·컬럼 이름은 이 상수 목록에서만 나온다.
create function public.domain_sync_fields(p_entity text) returns text[]
language sql immutable as $$
  select case p_entity
    when 'projects' then array['name','description','status','deleted_at']
    when 'categories' then array['name','color','deleted_at']
    when 'tasks' then array['title','description','status','priority','due_date','project_id','category_id','completed_at','deleted_at']
    when 'events' then array['title','description','start_at','end_at','all_day','timezone','recurrence_rule','recurrence_parent_id','original_start_at','is_cancelled','project_id','category_id','deleted_at']
    else null
  end
$$;

-- 업무 데이터 변경 적용 RPC. security invoker → 0001 의 RLS(owner_id = auth.uid())가 그대로 적용된다.
-- 반환: {status: 'applied'|'conflict'|'not_found'|'rejected'|'retry', row?, duplicate?, reason?}
--   retry: 참조 대상(프로젝트·분류·반복 원본)이 아직 서버에 없음 → 클라이언트가 나중에 재전송
create function public.apply_domain_op(
  p_op_id uuid, p_entity text, p_id uuid, p_base_version integer, p_patch jsonb
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_allowed text[];
  v_prev jsonb;
  v_key text;
  v_old jsonb;
  v_new jsonb;
  v_cols text;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  v_allowed := public.domain_sync_fields(p_entity);
  if v_allowed is null then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_entity');
  end if;

  select result into v_prev from public.domain_ops where op_id = p_op_id;
  if found then
    return v_prev || jsonb_build_object('duplicate', true);
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_patch');
  end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if not (v_key = any(v_allowed) or (v_key = 'created_at' and p_base_version = 0)) then
      return jsonb_build_object('status', 'rejected', 'reason', 'invalid_patch_key:' || v_key);
    end if;
  end loop;

  -- 참조 검사: RLS 로 보이는(=내 소유) 행만 참조할 수 있다.
  begin
    if coalesce(p_patch->>'project_id', '') <> '' and not exists (select 1 from public.projects where id = (p_patch->>'project_id')::uuid) then
      return jsonb_build_object('status', 'retry', 'reason', 'missing_reference:project_id');
    end if;
    if coalesce(p_patch->>'category_id', '') <> '' and not exists (select 1 from public.categories where id = (p_patch->>'category_id')::uuid) then
      return jsonb_build_object('status', 'retry', 'reason', 'missing_reference:category_id');
    end if;
    if coalesce(p_patch->>'recurrence_parent_id', '') <> '' and not exists (select 1 from public.events where id = (p_patch->>'recurrence_parent_id')::uuid) then
      return jsonb_build_object('status', 'retry', 'reason', 'missing_reference:recurrence_parent_id');
    end if;
  exception when invalid_text_representation then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_reference');
  end;

  execute format('select to_jsonb(t) from public.%I t where t.id = $1 for update', p_entity) into v_old using p_id;

  begin
    if v_old is null then
      if p_base_version <> 0 then
        return jsonb_build_object('status', 'not_found');
      end if;
      v_new := p_patch || jsonb_build_object(
        'id', p_id, 'owner_id', v_uid, 'version', 1, 'updated_at', now(),
        'created_at', coalesce(p_patch->'created_at', to_jsonb(now())),
        'server_seq', nextval('public.domain_seq'));
      execute format('insert into public.%I select * from jsonb_populate_record(null::public.%I, $1) returning to_jsonb(%I.*)', p_entity, p_entity, p_entity)
        into v_new using v_new;
    elsif (v_old->>'version')::int <> p_base_version then
      return jsonb_build_object('status', 'conflict', 'row', v_old);
    else
      v_new := v_old || p_patch || jsonb_build_object(
        'version', (v_old->>'version')::int + 1, 'updated_at', now(), 'server_seq', nextval('public.domain_seq'));
      select string_agg(quote_ident(c), ', ') into v_cols from unnest(v_allowed || array['version', 'updated_at', 'server_seq']) as c;
      execute format('update public.%I t set (%s) = (select %s from jsonb_populate_record(null::public.%I, $1)) where t.id = $2 returning to_jsonb(t)', p_entity, v_cols, v_cols, p_entity)
        into v_new using v_new, p_id;
    end if;
  exception
    when unique_violation then
      return jsonb_build_object('status', 'rejected', 'reason', 'id_unavailable');
    when foreign_key_violation then
      return jsonb_build_object('status', 'retry', 'reason', 'foreign_key');
    when check_violation or not_null_violation or invalid_text_representation
         or invalid_datetime_format or datetime_field_overflow or string_data_right_truncation then
      return jsonb_build_object('status', 'rejected', 'reason', 'invalid_data');
  end;

  v_result := jsonb_build_object('status', 'applied', 'row', v_new);
  insert into public.domain_ops (op_id, owner_id, entity, record_id, result)
    values (p_op_id, v_uid, p_entity, p_id, v_result);
  return v_result;
end;
$$;

grant execute on function public.apply_domain_op(uuid, text, uuid, integer, jsonb) to authenticated;

-- ===== migrations/20261004000004_write_guards.sql =====
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

commit;
