# PHASE 1 — RLS 및 데이터베이스 권한 강화

상태: **SQL 작성·로컬(PGlite) 검증 완료 / 원격 미적용 (승인 대기)**

## 1. 표별 현황과 목표 권한

PGlite 에 Supabase 기본 권한(anon·authenticated·service_role 에 ALL)을 재현한 뒤 측정했다. 원격 실제 값은 `supabase/remote_inspect_readonly.sql` [2]~[4] 로 확인해야 한다.

| 표 | RLS | 정책 | 0005 까지 (재현) | 0006 이후 authenticated | 0006 이후 anon |
|---|---|---|---|---|---|
| projects / categories / tasks / events | 켜짐 | `for all` owner = auth.uid() | SELECT·INSERT·UPDATE·**TRUNCATE·REFERENCES·TRIGGER** (DELETE 는 0004 가 회수) | SELECT·INSERT·UPDATE | 없음 |
| view_preferences | 켜짐 | select/insert/update/delete owner | 위와 같음 | SELECT·INSERT·UPDATE | 없음 |
| domain_ops / view_preference_ops | 켜짐 | select·insert owner | ALL | SELECT·INSERT (직접 INSERT 는 0005 트리거가 거부) | 없음 |
| app_admins (0007 신규) | 켜짐 | **없음** | — | 없음 | 없음 |
| 시퀀스 domain_seq / view_preferences_seq | — | — | USAGE·SELECT·**UPDATE(setval)** | USAGE 만 | 없음 |
| public 함수 전체 | — | — | PUBLIC·anon 실행 가능 | 실행 가능 | **없음** |

INSERT·UPDATE 를 남기는 이유: 동기화 RPC 가 `security invoker` 라서 사용자 권한으로 기록한다. RPC 를 `security definer` 로 바꾸면 더 줄일 수 있지만 0003 의 동작을 바꾸는 큰 변경이라 이번 범위에서 제외했다(직접 쓰기도 RLS·0004·0006 트리거가 보호).

## 2. 사용자별 격리 검증 (테스트 계정 A/B)

`tests/security.rls-isolation.test.ts` — 실제 마이그레이션 SQL 을 PGlite 에서 실행, `set role authenticated` + JWT `sub` 로 회원을 흉내낸다.

| 시나리오 | 결과 | 테스트 |
|---|---|---|
| A·B 가 각자 자기 행만 조회 (4표 + domain_ops) | 통과 | SEC-RLS-002 |
| A 가 B 의 행 UPDATE / 삭제 표시 → 0행 영향, B 데이터 그대로 | 통과 | SEC-RLS-002 |
| `owner_id` 위조 INSERT (업무·보기 설정) → RLS 거부 | 통과 | SEC-RLS-002 |
| UPDATE 로 소유권 이전 → RLS 거부 | 통과 | SEC-RLS-002, 기존 SYNC-006 |
| RPC 로 B 의 ID 수정(not_found)·같은 ID 생성(id_unavailable)·`owner_id` 패치(rejected)·허용 외 엔티티(rejected) | 통과 | SEC-RLS-002 |
| B 의 프로젝트·분류·반복 원본 참조 (직접 쓰기 → 트리거 거부, RPC → retry) | 통과 | SEC-RLS-002 |
| domain_ops 직접 INSERT(본인·타인)·UPDATE·DELETE 거부 | 통과 | SEC-RLS-002 |
| TRUNCATE(7표)·setval·시퀀스 조회 거부, B 데이터 보존 | 통과 | SEC-RLS-002 |
| anon: 7표 조회·쓰기, RPC·탈퇴·is_admin 실행 거부 | 통과 | SEC-RLS-002 |
| 권한 표 전체(anon 무권한, authenticated 최소 권한) | 통과 | SEC-RLS-001 |
| 모든 표 RLS 켜짐, public 뷰 없음, security definer 는 2개뿐이며 search_path 고정 | 통과 | SEC-RLS-001 |
| 0005 까지 상태에서 R1(TRUNCATE)·R2(setval)·R3(anon 권한) 재현 | 재현됨 | SEC-RLS-000 |

우회 경로 점검: REST(표 직접) ✔, RPC ✔, 뷰(없음) ✔, 함수(security definer 2개 — 인자로 사용자 ID 를 받지 않음) ✔, 트리거(전부 invoker, 소유권 필드 미변경) ✔, FK 참조(0006 트리거로 보완) ✔.

## 3. 마이그레이션 0005 검토 (기존, 원격 미적용)

| 항목 | 내용 |
|---|---|
| 목적 | 사용자가 REST 로 자기 `op_id` 결과를 미리 넣어, 자기 다른 기기의 변경을 "이미 적용됨"으로 만들어 잃게 하는 경로 차단 (Q-10). RLS 때문에 다른 회원에게는 영향 없음 |
| 변경 범위 | 두 RPC 에 함수 속성 `dotday.rpc = '1'` 부여, `guard_ops_insert()` 함수, ops 두 표에 BEFORE INSERT 트리거 |
| 바꾸지 않는 것 | RPC 본문·권한·RLS·데이터 |
| 데이터 영향 | 없음 (기존 행 변경 없음, 새 INSERT 만 검사) |
| 멱등성 | 마이그레이션 파일 자체는 **멱등 아님**(`create function`/`create trigger` 재실행 시 오류). `remote_apply_0005.sql` 이 이미 적용됐는지 먼저 검사하고 중단하므로 운영 적용은 안전 |
| 롤백 | 트리거 2개·함수 drop + 두 RPC `reset dotday.rpc` (파일 머리 주석) |
| 위험 | PostgREST 가 함수 속성 `set dotday.rpc` 를 그대로 적용하는지는 실서버 [미확인]. 로컬에서는 통과(SEC-001, SEC-RLS-002) |

## 4. 신규 0006 — 최소 권한 (`supabase/migrations/20261006000006_least_privilege.sql`)

1. 7개 표: PUBLIC·anon 권한 전부 회수, authenticated 는 전부 회수 후 필요한 것만 재부여.
2. 시퀀스: USAGE 만 (setval·조회 차단).
3. public 함수: PUBLIC·anon 실행 회수, authenticated 만.
4. `guard_same_owner_refs()` 트리거: tasks(project_id, category_id), events(+recurrence_parent_id) 가 **같은 소유자 행만** 참조. 참조 값이 바뀔 때만 검사 → 기존 행의 다른 필드 수정에는 영향 없음.
- 데이터 행 변경 없음. 멱등(재실행 테스트 SEC-RLS-003).

## 5. 신규 0007 — 관리자 구분 + 탈퇴 RPC (`20261006000007_admin_and_account_deletion.sql`)

### 관리자
- `public.app_admins(user_id)` 표: RLS 켜고 정책·권한 없음 → 클라이언트는 읽기·쓰기 불가.
- 지정은 SQL Editor(소유자)에서만: `insert into public.app_admins (user_id, note) values ('<ID>', 'owner');` — 소유자 계정 ID 는 `remote_inspect_readonly.sql` [9] 등으로 **직접 확인한 뒤** 넣는다. 코드·마이그레이션에 하드코딩하지 않았다.
- `is_admin()` 은 "내가 관리자인가"만 답한다. **관리자에게 다른 회원 데이터를 보는 전역 권한을 주지 않았다** (테스트 SEC-ADM-001). 프런트엔드도 관리자 여부로 화면을 바꾸지 않는다(현재 관리자 기능 없음).

### 탈퇴 RPC `delete_my_account(p_confirm text)`
- 본인(auth.uid())만, 인자로 사용자 ID 를 받지 않음.
- 서버가 재인증 판단: `auth.users.last_sign_in_at` 이 10분 이내여야 함.
- `delete from auth.users` 한 번 → 모든 표의 `on delete cascade` 로 같은 트랜잭션에서 삭제 → **부분 삭제 상태 없음**.
- 관리자는 먼저 해제해야 탈퇴 가능(운영자 잠김 방지).
- `security definer` + `search_path = ''`.
- [미확인 · 적용 전 확인 필요] Supabase 의 함수 소유자(postgres)가 `auth.users` 를 DELETE 할 권한이 있는지 → `remote_inspect_readonly.sql` [10]. 없으면 대안: Edge Function(서버에서 service_role 로 `auth.admin.deleteUser`)을 쓰고 클라이언트 호출부만 바꾼다. 공식 문서는 Admin API 와 SQL Editor 삭제를 모두 안내한다 ([Managing user data](https://supabase.com/docs/guides/auth/managing-user-data)).
- 이미 발급된 액세스 토큰은 만료(기본 1시간)까지 형식상 유효하지만, 행이 삭제되어 RLS 상 볼 데이터가 없다.

## 6. 원격 적용 절차 (승인 후)

1. `remote_inspect_readonly.sql` 전체 실행 → 결과 저장 (특히 [2-b] GRANT 문 = 정확한 원래 권한)
2. 대시보드 Table Editor 에서 7개 표 CSV 내보내기 (Free 는 자동 백업 없음)
3. (승인 시) `remote_apply_0005.sql`
4. (승인 시) `remote_apply_0006_0007.sql` — 0005 미적용·이미 적용·다른 소유자 참조 데이터가 있으면 스스로 중단, 한 트랜잭션
5. `remote_inspect_readonly.sql` 다시 실행 → [2][3][4] 가 이 문서 1절 표와 같은지 비교
6. 두 기기로 로그인 → 수정 → 30초 안에 반영 확인

롤백: `remote_rollback_0006_0007.sql` (+ 필요 시 1에서 저장한 GRANT 문). 롤백 후에도 동기화가 동작함을 리허설 테스트로 확인(SEC-RLS-004).
