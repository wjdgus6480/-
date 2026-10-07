-- ============================================================================
-- DOTDAY MySQL 스키마 v1 (Flyway: 서버가 시작할 때 1회 적용)
-- 대상: MySQL 8.4 (Aiven defaultdb, utf8mb4 / utf8mb4_0900_ai_ci — 테이블은 DB 기본값을 따른다)
-- 이 파일은 적용된 뒤에는 수정하지 않고, 이후 변경은 V2__... 로 추가한다.
--
-- 공통 정책 (자세한 이유: docs/DB_DESIGN.md)
--  - ID: CHAR(36) UUID. 앱이 오프라인에서 ID 를 먼저 만들고 나중에 서버로 보낸다(로컬 우선)
--  - 시각: DATETIME(3), UTC. 서버(Java)가 UTC 로 변환해서 넣는다. 화면 표시는 사용자 시간대(기본 Asia/Seoul)
--  - 삭제: 업무 데이터는 deleted_at 소프트 삭제(다른 기기에 '삭제됨' 전달). 회원 탈퇴 때만 실제 삭제
--  - 동기화: version(충돌 판단), server_seq(변경분 커서)
--  - 소유권: 모든 사용자 데이터에 owner_id. 서버가 모든 쿼리에 owner_id = 로그인 사용자 조건을 붙인다
--  - 상태 값: 소문자 문자열 + CHECK (값 추가가 쉽고 React·Java 에서 그대로 쓴다)
--  - 문자열은 작은따옴표만 쓴다 (Aiven sql_mode 의 ANSI_QUOTES)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 사용자·인증
-- ---------------------------------------------------------------------------

-- 사용자. 비밀번호는 BCrypt 해시만 저장한다 (평문·토큰 저장 없음)
create table users (
  id char(36) primary key,
  email varchar(320) not null,
  password_hash varchar(100) not null,
  name varchar(100) null,
  profile_image_url varchar(500) null,
  created_at datetime(3) not null,
  updated_at datetime(3) not null,
  -- 마지막 로그인 (탈퇴 등 민감한 작업의 '최근 로그인' 확인에 사용)
  last_sign_in_at datetime(3),
  constraint users_email_unique unique (email)
);

-- 사용자 설정 (사용자당 1행, 최소 구조)
create table user_settings (
  user_id char(36) primary key,
  language varchar(8) not null default 'ko',
  timezone varchar(64) not null default 'Asia/Seoul',
  theme varchar(16) not null default 'light',
  calendar_view varchar(8) not null default 'month',
  -- 0 = 일요일, 1 = 월요일
  week_start_day tinyint not null default 0,
  notification_enabled boolean not null default true,
  created_at datetime(3) not null,
  updated_at datetime(3) not null,
  constraint user_settings_user_fk foreign key (user_id) references users (id) on delete cascade,
  constraint user_settings_theme_chk check (theme in ('system', 'light', 'dark')),
  constraint user_settings_view_chk check (calendar_view in ('month', 'week', 'day')),
  constraint user_settings_week_chk check (week_start_day in (0, 1))
);

-- 로그인 세션 (기기 단위). 토큰 자체는 저장하지 않고 세션 ID 만 둔다(JWT 의 sid).
-- 로그아웃은 revoked_at 을 채운다 → '이 기기' / '모든 기기' 로그아웃
create table auth_sessions (
  id char(36) primary key,
  user_id char(36) not null,
  created_at datetime(3) not null,
  revoked_at datetime(3),
  constraint auth_sessions_user_fk foreign key (user_id) references users (id) on delete cascade
);
create index auth_sessions_user_idx on auth_sessions (user_id);

-- 관리자 지정은 DB 에서만 한다 (API 로 읽거나 쓸 수 없음). 관리자는 지정 해제 전 탈퇴 불가
--   insert into app_admins (user_id, note, granted_at) values ('<users.id>', 'owner', utc_timestamp(3));
create table app_admins (
  user_id char(36) primary key,
  note varchar(200) not null default '',
  granted_at datetime(3) not null,
  constraint app_admins_user_fk foreign key (user_id) references users (id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- 업무 데이터 (모두 사용자별)
-- ---------------------------------------------------------------------------

-- server_seq 발급용 카운터 (행 잠금 → 번호 순서 = 커밋 순서)
create table seq_counters (
  name varchar(32) primary key,
  current_value bigint not null
);
insert into seq_counters (name, current_value) values ('domain', 0);
insert into seq_counters (name, current_value) values ('views', 0);

-- 카테고리 (일정·할 일 공용: 개인, 업무, 공부, 운동, 기타 …)
-- owner_id + name 은 UNIQUE 로 두지 않는다: 오프라인의 두 기기가 같은 이름을 동시에 만들면
-- 동기화가 거부되어 데이터가 갈 곳을 잃는다. 중복 이름은 화면에서 안내한다.
create table categories (
  id char(36) primary key,
  owner_id char(36) not null,
  name varchar(200) not null,
  color varchar(64) not null default '#888888',
  created_at datetime(3) not null,
  updated_at datetime(3) not null,
  deleted_at datetime(3),
  version int not null default 1,
  server_seq bigint not null,
  constraint categories_owner_fk foreign key (owner_id) references users (id) on delete cascade,
  constraint categories_version_chk check (version >= 1)
);
create index categories_owner_seq_idx on categories (owner_id, server_seq);

-- 프로젝트 (할 일·일정을 묶음)
create table projects (
  id char(36) primary key,
  owner_id char(36) not null,
  name varchar(400) not null,
  description mediumtext not null,
  status varchar(16) not null default 'active',
  created_at datetime(3) not null,
  updated_at datetime(3) not null,
  deleted_at datetime(3),
  version int not null default 1,
  server_seq bigint not null,
  constraint projects_owner_fk foreign key (owner_id) references users (id) on delete cascade,
  constraint projects_status_chk check (status in ('active', 'on_hold', 'done', 'archived')),
  constraint projects_version_chk check (version >= 1)
);
create index projects_owner_seq_idx on projects (owner_id, server_seq);

-- 할 일
--  status: todo(할 일) / in_progress(진행 중) / done(완료). completed 는 status 에서 계산되는 열(직접 쓰지 않음)
--  priority: low / medium / high / urgent
--  due_date: 날짜만 쓰는 마감 (YYYY-MM-DD)
create table todos (
  id char(36) primary key,
  owner_id char(36) not null,
  title varchar(1000) not null,
  description mediumtext not null,
  status varchar(16) not null default 'todo',
  completed boolean generated always as (status = 'done'),
  priority varchar(16) not null default 'medium',
  due_date date,
  project_id char(36),
  category_id char(36),
  created_at datetime(3) not null,
  updated_at datetime(3) not null,
  completed_at datetime(3),
  deleted_at datetime(3),
  version int not null default 1,
  server_seq bigint not null,
  constraint todos_owner_fk foreign key (owner_id) references users (id) on delete cascade,
  -- 카테고리·프로젝트가 지워져도 할 일은 남긴다 (분류만 비움)
  constraint todos_project_fk foreign key (project_id) references projects (id) on delete set null,
  constraint todos_category_fk foreign key (category_id) references categories (id) on delete set null,
  constraint todos_status_chk check (status in ('todo', 'in_progress', 'done')),
  constraint todos_priority_chk check (priority in ('low', 'medium', 'high', 'urgent')),
  constraint todos_version_chk check (version >= 1)
);
create index todos_owner_seq_idx on todos (owner_id, server_seq);
-- 내 할 일 / 미완료(completed = false) / 마감일 순
create index todos_owner_completed_due_idx on todos (owner_id, completed, due_date);

-- 일정
--  종일 일정: all_day = true, start_at = 그 시간대의 자정, end_at = 다음 날 자정(포함하지 않음)
--  반복: recurrence_rule (RFC 5545 RRULE 부분집합, 예: FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10)
--        한 회차만 바꾸거나 취소하면 recurrence_parent_id + original_start_at 을 가진 예외 행을 만든다
--  color 가 NULL 이면 카테고리 색을 쓴다
create table events (
  id char(36) primary key,
  owner_id char(36) not null,
  title varchar(1000) not null,
  description mediumtext not null,
  location varchar(255) not null default '',
  color varchar(16) null,
  start_at datetime(3) not null,
  end_at datetime(3) not null,
  all_day boolean not null default false,
  timezone varchar(64) not null default 'Asia/Seoul',
  recurrence_rule varchar(255),
  recurrence_parent_id char(36),
  original_start_at datetime(3),
  is_cancelled boolean not null default false,
  project_id char(36),
  category_id char(36),
  created_at datetime(3) not null,
  updated_at datetime(3) not null,
  deleted_at datetime(3),
  version int not null default 1,
  server_seq bigint not null,
  constraint events_owner_fk foreign key (owner_id) references users (id) on delete cascade,
  -- 반복 원본이 지워지면 그 예외 회차도 함께 지운다
  constraint events_parent_fk foreign key (recurrence_parent_id) references events (id) on delete cascade,
  constraint events_project_fk foreign key (project_id) references projects (id) on delete set null,
  constraint events_category_fk foreign key (category_id) references categories (id) on delete set null,
  constraint events_range_chk check (end_at >= start_at),
  constraint events_version_chk check (version >= 1),
  -- 같은 반복 일정의 같은 회차에는 예외 행이 하나만 (NULL 끼리는 다른 값이라 일반 일정은 영향 없음)
  constraint events_override_unique unique (recurrence_parent_id, original_start_at)
);
create index events_owner_seq_idx on events (owner_id, server_seq);
-- 기간 조회: owner_id = ? and start_at < :끝 and end_at > :시작
create index events_owner_period_idx on events (owner_id, start_at, end_at);

-- 일정 알림 ('시작 N분 전'). 일정 1개에 여러 개, 일정이 지워지면 함께 지운다
create table reminders (
  id char(36) primary key,
  owner_id char(36) not null,
  event_id char(36) not null,
  remind_before_minutes int not null,
  reminder_type varchar(16) not null default 'notification',
  created_at datetime(3) not null,
  updated_at datetime(3) not null,
  deleted_at datetime(3),
  version int not null default 1,
  server_seq bigint not null,
  constraint reminders_owner_fk foreign key (owner_id) references users (id) on delete cascade,
  constraint reminders_event_fk foreign key (event_id) references events (id) on delete cascade,
  -- 0분(정각) ~ 4주 전 (10분·30분·1시간·하루 전 등)
  constraint reminders_minutes_chk check (remind_before_minutes between 0 and 40320),
  constraint reminders_type_chk check (reminder_type in ('notification', 'email')),
  constraint reminders_version_chk check (version >= 1),
  constraint reminders_event_minutes_unique unique (event_id, remind_before_minutes)
);
create index reminders_owner_seq_idx on reminders (owner_id, server_seq);

-- ---------------------------------------------------------------------------
-- 동기화 기록·보기 설정
-- ---------------------------------------------------------------------------

-- 같은 변경(op_id)을 두 번 보내도 한 번만 적용하기 위한 기록
create table domain_ops (
  owner_id char(36) not null,
  op_id char(36) not null,
  entity varchar(16) not null,
  record_id char(36) not null,
  result mediumtext not null,
  applied_at datetime(3) not null,
  primary key (owner_id, op_id),
  constraint domain_ops_owner_fk foreign key (owner_id) references users (id) on delete cascade
);

-- 테이블 보기 설정 (컬럼·정렬·필터). JSON 은 서버가 검증한 뒤 문자열로 저장
create table view_preferences (
  id char(36) primary key,
  owner_id char(36) not null,
  local_profile_id varchar(100),
  view_key varchar(16) not null,
  name varchar(200) not null,
  column_config mediumtext not null,
  sort_config mediumtext not null,
  filter_config mediumtext not null,
  layout_config mediumtext not null,
  is_default boolean not null default false,
  created_at datetime(3) not null,
  updated_at datetime(3) not null,
  deleted_at datetime(3),
  version int not null default 1,
  server_seq bigint not null,
  constraint view_preferences_owner_fk foreign key (owner_id) references users (id) on delete cascade,
  constraint view_preferences_key_chk check (view_key in ('tasks', 'events', 'projects')),
  constraint view_preferences_version_chk check (version >= 1)
);
create index view_preferences_owner_seq_idx on view_preferences (owner_id, server_seq);

create table view_preference_ops (
  owner_id char(36) not null,
  op_id char(36) not null,
  view_id char(36) not null,
  result mediumtext not null,
  applied_at datetime(3) not null,
  primary key (owner_id, op_id),
  constraint view_preference_ops_owner_fk foreign key (owner_id) references users (id) on delete cascade
);
