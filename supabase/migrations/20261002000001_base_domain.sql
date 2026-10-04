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
