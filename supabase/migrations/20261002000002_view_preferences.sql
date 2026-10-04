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
