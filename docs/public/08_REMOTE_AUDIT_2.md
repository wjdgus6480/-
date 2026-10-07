# 원격 Supabase 2차 READ-ONLY 감사 (2026-10-06)

원격 요청 0건 추가(이번 단계는 로컬 소스·로컬 재현·감사 쿼리 보강만). 원격 변경 0건.

```text
REMOTE CATALOG ACCESS = UNAVAILABLE
```
- 없음: DB 비밀번호, service_role/secret, Supabase CLI, psql, Vercel CLI
- 세션에 `supabase` MCP 서버가 있으나 **미인증**. 인증 시 카탈로그 조회가 가능하지만 쓰기 SQL 도 실행할 수 있으므로 read-only 설정 필수.
- 공개 REST GET 으로 이미 확인한 것(1차): anon 7표 SELECT 거부, anon 의 IMMUTABLE 함수 2개 실행 가능, Auth 공개 설정, app_admins 없음.
- REST GET 으로 **확인할 수 없는 것**: authenticated 권한 전체, anon 의 INSERT/UPDATE/DELETE/TRUNCATE, 시퀀스 권한, 정책 본문, 트리거, FK 정의, security definer, auth 스키마.

## 1. 감사 쿼리 `supabase/remote_audit_readonly_onequery.sql`

- 본문은 `WITH … SELECT` 한 문장. 쓰기·DDL·GRANT/REVOKE·setval/nextval 없음(정적 검사 테스트 REM-AUDIT-001).
- 파일 안에 `SET TRANSACTION READ ONLY` 문은 없다(SQL Editor 는 마지막 결과만 보여 주기 때문). 대신 로컬 테스트가 **`SET TRANSACTION READ ONLY` 트랜잭션 안에서 실행**해 통과함을 확인 — 쓰기가 섞여 있으면 Postgres 가 오류를 낸다. 원격에서도 감싸서 실행하고 싶으면 `begin; set transaction read only; <쿼리> ; rollback;` 으로 실행 가능(결과 표시는 Editor 동작에 따름).
- 이번 보강: `auth.fks_referencing_auth_users`(모든 스키마의 auth.users 참조 FK 와 ON DELETE 동작), `auth.auth_users_owner`, `auth.storage_objects_estimate`.

## 2. R1 — authenticated TRUNCATE

| 근거 | 결과 |
|---|---|
| 로컬 소스(0001~0005) | TRUNCATE 를 **명시적으로 부여한 문장 없음** (`grep`) |
| 원격에 실제 적용된 파일 | `remote_setup_0001_0004.sql` 본문 = 마이그레이션 파일과 동일(비교 확인) |
| 원격 카탈로그 | 조회 불가 |
| 자동 GRANT(기본 권한) 여부 | anon SELECT 부재로 "자동 GRANT 없음" 을 시사하지만 **확인 아님** |

→ **R1 = UNKNOWN**. RLS 와 무관하게, `has_table_privilege('authenticated', …, 'TRUNCATE')` 결과가 있어야 판정 가능.

## 3. R2 — 시퀀스

- 사용 시퀀스: `public.domain_seq`(업무 4표 server_seq), `public.view_preferences_seq`. 그 외 serial/identity 없음.
- 소스상 부여: 두 시퀀스 모두 authenticated 에 `USAGE` 만 (nextval·currval 가능, setval 불가). setval 은 UPDATE 권한 필요.
- 원격 카탈로그 조회 불가 → **R2 = UNKNOWN**.

## 4. R3 — anon

| 항목 | 판정 |
|---|---|
| 7표 SELECT | **DENIED — CONFIRMED** (42501) |
| INSERT / UPDATE / DELETE / TRUNCATE | **UNKNOWN** (SELECT 거부에서 추론하지 않음) |
| 함수 EXECUTE | **일부 가능 — CONFIRMED** (`domain_sync_fields`, `view_pref_allowed_fields`). 나머지 함수는 UNKNOWN. `apply_domain_op` 가 본문 첫 줄에서 `not_authenticated` 로 거부하더라도 EXECUTE 권한 자체가 열려 있는 문제는 별개 |

## 5. 0006 이 실제로 해결하는 것

| 문제 | 현재 remote 상태 | 0006 효과 | 적용 필요 |
|---|---|---|---|
| anon table privilege | SELECT 없음(확인), 쓰기 UNKNOWN | 전부 revoke. SELECT 는 **이미 안전 → 재확인용 no-op**. 쓰기 권한이 있다면 실제 제거 | 필요 (쓰기 UNKNOWN) |
| function EXECUTE | anon 일부 실행 가능(확인) | PUBLIC·anon 회수, authenticated 만 | **필요 — 확인된 문제를 실제로 제거** |
| TRUNCATE | UNKNOWN | authenticated·anon 회수 | 있으면 실제 제거, 없으면 no-op |
| sequence setval | UNKNOWN | USAGE 만 남김 | 있으면 실제 제거, 없으면 no-op |
| cross-user reference | 소스상 FAIL (아래 6) | 트리거로 같은 소유자만 참조 | **필요 — 실제 위험 제거** |
| explicit minimum grant | 소스상 authenticated 에 DELETE(view_preferences 포함)는 0004 가 회수, 나머지 명시 grant | 표·시퀀스·함수 권한을 한 곳에 고정 | 필요 (드리프트 방지) |

## 6. R4 — 교차 소유자 참조 (소스 분석 + 로컬 재현)

| FK | 대상 | ON DELETE | 소유자 구분 |
|---|---|---|---|
| tasks.project_id | projects.id | SET NULL | 없음 |
| tasks.category_id | categories.id | SET NULL | 없음 |
| events.project_id | projects.id | SET NULL | 없음 |
| events.category_id | categories.id | SET NULL | 없음 |
| events.recurrence_parent_id | events.id | **CASCADE** | 없음 |
| *.owner_id (7표) | auth.users.id | CASCADE | — |
| domain_ops.record_id, view_preference_ops.view_id | FK 없음 | — | — |

- RLS WITH CHECK 는 새 행의 `owner_id` 만 검사하고, FK 검사는 RLS 를 거치지 않는다. authenticated 는 tasks·events 에 INSERT·UPDATE 를 명시적으로 받았다(0001).
- 동기화 RPC 는 참조 대상을 RLS 로 확인해 막지만, **직접 REST 쓰기**는 다른 회원의 UUID 를 알면 참조할 수 있다 → 로컬 재현(REM-AUDIT-004).
- 영향: 다른 회원 UUID(무작위 v4)를 알아야 하므로 악용 난이도는 높다. 다만 0007 과 결합하면 아래처럼 **다른 회원 데이터의 삭제·수정**으로 이어진다.

→ **R4 = FAIL** (원격에 적용된 0001 소스 기준. 원격 FK 카탈로그 자체는 미확인. 실제 교차 참조 행 존재 여부는 감사 쿼리 `cross_owner_refs` 로 확인)

## 7. 0007 구조 검증

### 7-1 auth.users 삭제
- `delete_my_account(p_confirm text)`: `SECURITY DEFINER`, `search_path = ''`, 객체는 모두 스키마 한정(`auth.users`, `public.app_admins`).
- 소유자 = 적용 시 SQL Editor 실행 역할(보통 `postgres`). 그 역할이 `auth.users` 에 DELETE 권한이 있어야 동작 → **UNKNOWN** (감사 쿼리 `current_user_can_delete_auth_users`, `auth_users_owner`). Supabase 문서는 SQL Editor 에서 auth.users 삭제를 안내하지만 이 프로젝트에서 확인한 것은 아니다.
- EXECUTE: PUBLIC·anon 회수, authenticated 만. 인자에 사용자 ID 없음(본인만).
- Storage 객체 소유자가 있으면 삭제가 막힐 수 있다(Supabase 문서). DOTDAY 는 Storage 를 쓰지 않지만 원격 상태는 UNKNOWN (`storage_objects_estimate`).

### 7-2 last_sign_in_at
- GoTrue 의 사용자 객체 필드로 공개 API 에 존재. 원격 DB 컬럼 존재 여부는 **UNKNOWN** (`has_last_sign_in_at_column`). 없으면 함수 생성은 되지만(plpgsql 은 실행 시 검사) 호출 시 오류.

### 7-3 탈퇴 시 삭제·변경되는 데이터 (소스 기준 계산)
사용자 X 탈퇴(`delete from auth.users where id = X`) 시:
1. **삭제**: owner_id = X 인 projects, categories, tasks, events, view_preferences, domain_ops, view_preference_ops 행 전부(CASCADE).
2. **삭제**: X 의 events 를 recurrence_parent_id 로 참조하는 **다른 회원의 events**(CASCADE) — 교차 참조가 있을 때만.
3. **수정**: X 의 projects/categories 를 참조하는 다른 회원의 tasks/events 는 project_id·category_id 가 NULL 로 바뀌고 version·server_seq 증가(0004 트리거) — 교차 참조가 있을 때만.
4. **auth 내부 표**(identities·sessions·refresh tokens 등)와 Storage 등 다른 스키마의 FK 동작: **UNKNOWN** — 감사 쿼리 `fks_referencing_auth_users` 로 확정 필요(RESTRICT/NO ACTION 이 있으면 탈퇴 자체가 실패).
- 2·3 은 "다른 사용자 데이터를 건드리지 않는다" 원칙 위반 → 0006 트리거가 새 교차 참조를 막고, `remote_apply_0006_0007.sql` 사전 점검이 기존 교차 참조가 1건이라도 있으면 중단(REM-AUDIT-004). **0007 은 반드시 0006 과 함께/뒤에 적용**.

### 7-4 관리자
- 하드코딩 없음, 환경변수 없음. 별도 표 `public.app_admins` (RLS 켜짐, 정책·권한 없음).
- 원격에 표 없음 — **CONFIRMED** (PGRST205). 0007 이 생성. 관리자 행은 0007 이 넣지 않으므로 적용 직후 관리자 0명(탈퇴 RPC 의 관리자 차단 조건도 무해). 지정은 소유자 ID 확인 후 별도 승인.

### 판정: **0007 = UNKNOWN** (7-1 권한, 7-2 컬럼, 7-3 의 auth·storage FK 동작, 교차 참조 행 수가 원격에서 미확인)

## 8. Auth (DASHBOARD REQUIRED 항목)
Redirect URLs · Site URL · SMTP · Rate limits · CAPTCHA · Identity linking(수동 연결 설정) — 공개 엔드포인트에 없음.

## 9. 작업 트리 vs `v0.4.2-prod` (src 6개 파일, +474/−39)

| 영역 | 변경 |
|---|---|
| Supabase client | 생성 옵션 그대로(publishable key, implicit flow, 세션 저장·자동 갱신). 시작 시 리다이렉트 오류 읽기·주소창 정리만 추가 |
| Auth | 소셜 로그인(`signInWithOAuth`), 가입 확인 재전송(`resend`)·코드 인증(`verifyOtp type=signup`), 계정 존재 비노출 문구, 오류 코드 매핑 |
| CAPTCHA | `VITE_TURNSTILE_SITE_KEY` 있을 때만 위젯, 각 요청에 `captchaToken`(서버 설정 없으면 무시됨) |
| 탈퇴 | `rpc('delete_my_account')` — 0007 미적용 시 "미적용" 안내 |
| 기기 데이터 | IndexedDB 스토어 비우기·계정별 정리. DB 버전 변경 없음 |
| RLS 관련 | 클라이언트 쪽 변경 없음. 동기화 경로(`apply_domain_op`, `apply_view_preference_op`, SELECT) 그대로 |
| 비밀 | 소스에 키 값 없음(주석 언급뿐) |

## 10. 원격 상태를 확정하는 방법 (둘 중 하나)
1. 사용자가 SQL Editor 에서 `remote_audit_readonly_onequery.sql` 실행 → JSON 전달
2. `supabase` MCP 서버를 **read-only 로** 인증 → 같은 쿼리를 이 세션에서 실행
