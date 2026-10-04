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
