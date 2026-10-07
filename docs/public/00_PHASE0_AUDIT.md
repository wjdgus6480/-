# PHASE 0 — 감사 및 기준선 (2026-10-06)

표기: **[확인]** 이번에 직접 확인 · **[전달]** 기존 문서·커밋 메시지로 전달받은 정보(재확인 안 함) · **[미확인]** 접근 권한이 없어 확인 못 함 · **[제안]**

## 1. Git

| 항목 | 상태 | 근거 |
|---|---|---|
| 브랜치 | [확인] `main`, 작업 시작 시 변경 없음(clean) | `git status -sb` |
| 최신 커밋 | [확인] `2445902 docs: 롤백 제한(Hobby)·환경변수 등록 기록` | `git log` |
| 태그 | [확인] `v0.4.1-baseline`(=`38d6328`), `v0.4.2-prod`(=`2445902`, HEAD) | `git tag`, `git log -1 v0.4.2-prod` |
| 원격 저장소 | [전달] 없음 (로컬 Git 만) | `docs/RECOVERY.md` |

## 2. Production 과 코드의 일치

- [미확인] Vercel 배포 목록을 조회하지 않았다(배포 계정 접근은 이번 범위에서 하지 않음).
- [전달] `docs/RECOVERY.md`: 현재 Production `dotday-mnvrtwrbu-dotday.vercel.app`(2026-10-04), "태그 `v0.4.1-baseline` = 현재 Production 코드".
- **불일치**: 태그 이름 `v0.4.2-prod` 는 HEAD 를 가리키는데, RECOVERY.md 는 v0.4.1-baseline 을 Production 으로 적고 있다. 어느 쪽이 실제 Production 인지 사용자 확인이 필요하다.
  - 확인 방법: `npx vercel ls dotday --scope dotday` 로 최신 Production 배포 시각을 보고, 그 시각과 커밋 시각(`v0.4.2-prod` = 2026-10-05 09:50 KST)을 비교.

## 3. 테스트·타입 검사·빌드 (작업 전 기준선)

| 항목 | 결과 | 근거 |
|---|---|---|
| `npm test` | [확인] 13 파일 / 128 테스트 통과 | 2026-10-06 10:29 실행 |
| `npm run build` (tsc + vite) | [확인] 성공, 번들 589 kB (경고: 500 kB 초과) | 같은 시각 |
| 테스트의 운영 데이터 접근 가능성 | [확인] 없음. `vite.config.ts` 가 테스트에서 `VITE_SUPABASE_*` 를 빈 값으로 덮고, 서버 계약은 PGlite(메모리 DB)·fake-indexeddb 로만 검증 | `vite.config.ts`, `tests/helpers.ts` |

## 4. 원격 DB 스키마·RLS·0001~0005 적용 상태

- [미확인] 원격 DB 카탈로그를 조회하지 않았다. 이 PC 에는 공개용 publishable key 만 있고 DB 비밀번호·service_role 이 없다(의도된 상태).
- [전달] 0001~0004 원격 적용 완료, **0005 원격 미적용** (커밋 `a7db978` 메시지, `supabase/remote_apply_0005.sql` 존재).
- [제안] `supabase/remote_inspect_readonly.sql` (읽기 전용) 을 SQL Editor 에서 실행하면 위 항목과 아래 권한을 모두 확인할 수 있다. 결과에는 이메일·내용이 없고 개수·권한만 나온다.

## 5. 저장소 구조와 기존 구현 (재사용 대상)

| 영역 | 파일 | 상태 |
|---|---|---|
| 인증 래퍼 | `src/app/auth.ts` `AuthController` | [확인] 비밀번호 로그인·가입·메일 링크/코드·비밀번호 설정/재설정·이 기기/전체 로그아웃·만료 감지 |
| 인증 UI | `src/ui/AuthForms.tsx` | [확인] `LoginForms`, `SetPasswordForm`, `AccountActions` |
| Supabase 클라이언트 | `src/app/services.ts` | [확인] publishable key 만, `persistSession/autoRefreshToken/detectSessionInUrl`, flowType 기본값(implicit) |
| IndexedDB | `src/db/idb.ts` | [확인] DB 이름 `dotday`, **버전 2**, 스토어 12개 |
| 계정 분리 | `src/domain/repo.ts` | [확인] 같은 기기에서 `owner_id` 로 필터 → 로그아웃·계정 전환 시 다른 계정 데이터가 화면에 나오지 않음. 단 브라우저 저장소에는 남음 |
| Outbox | `domain_outbox`, `view_outbox` | [확인] 레코드와 같은 트랜잭션으로 기록. 로그인 전(owner null) 변경도 쌓이지만 전송하지 않음 |
| 동기화 | `src/domain/sync.ts`, `src/views/sync.ts` | [확인] RPC `apply_domain_op`/`apply_view_preference_op` + `server_seq` 커서 조회. 30초 주기·온라인·화면 표시 시. **Realtime 미사용** |
| 로그인 전 데이터 이전 | `src/domain/migrate.ts`, `App.tsx` | [확인] 미리보기 → 사용자 승인 → 백업 → 이전 (자동 이전 없음) |
| 원격 호출 | `src/domain/remote.ts`, `src/views/remote.ts` | [확인] 클라이언트는 RPC 와 SELECT 만 사용. 직접 INSERT/UPDATE/DELETE 없음 |

## 6. 사용자별 소유권과 동기화 경로

- [확인] 모든 업무 표·보기 설정·동기화 기록: `owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade`.
- [확인] RLS: 업무 4표 `for all to authenticated using/with check (owner_id = auth.uid())`. RPC 는 `security invoker` → RLS 그대로 적용.
- [확인] 0004: version·server_seq·updated_at 서버 강제, 직접 DELETE 회수(anon·authenticated).
- [확인] 0005(원격 미적용): `domain_ops`/`view_preference_ops` 직접 INSERT 차단 트리거.

### 이번 감사에서 새로 찾은 위험 (로컬 재현, 원격 [미확인])
Supabase 기존 프로젝트는 public 스키마의 새 객체에 anon·authenticated 까지 기본 권한을 자동 부여해 왔고, 0001~0005 는 필요한 권한을 grant 만 하고 **회수하지 않았다**. 테스트 서버를 이 기본 권한까지 흉내내도록 바꾸자 아래가 재현됐다 (`tests/security.rls-isolation.test.ts` SEC-RLS-000).

| # | 위험 | 심각도 | 이유 |
|---|---|---|---|
| R1 | 로그인한 회원이 `TRUNCATE public.tasks` → **모든 회원의 투두 삭제** | 치명 | TRUNCATE 는 RLS 를 적용받지 않음 |
| R2 | 회원이 `setval('public.domain_seq', 1)` → 다른 회원 기기의 동기화 커서보다 낮은 `server_seq` 발생 → 변경이 다른 기기에 안 내려감 | 높음 | 전 회원 공용 시퀀스에 UPDATE 권한 |
| R3 | anon 에 INSERT·TRUNCATE 권한 잔존 | 높음 | 기본 권한 |
| R4 | 직접 REST 로 다른 회원의 프로젝트·분류·반복 원본 ID 참조 가능 | 낮음 | FK 검사는 RLS 를 무시 (RPC 는 막음) |

- 실제 원격에 기본 권한이 ALL 로 걸려 있는지는 [미확인] — `remote_inspect_readonly.sql` [2]·[3] 으로 확인 필요.
- 참고: Supabase 는 2026-10-30 부터 기존 프로젝트에도 "새 테이블 자동 노출 안 함"을 강제하지만, **기존 테이블의 권한은 그대로 유지**된다고 공지했다. 즉 이미 만든 DOTDAY 표의 R1~R3 은 저절로 사라지지 않는다. ([Supabase changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically))

## 7. 인증·가입 설정

| 항목 | 상태 |
|---|---|
| Confirm email(가입 시 메일 인증 필수) | [미확인] 대시보드 Authentication › Sign In / Providers › Email. 코드상 `signUp` 이 세션 없이 돌아오면 "확인 메일" 안내 → 켜져 있을 가능성이 높지만 확인 필요 |
| Secure password change | [전달] 코드가 `reauthentication_needed` 를 처리하도록 준비됨, 실제 설정값 [미확인] |
| 소셜 제공자 | [확인] 코드에 없음(이번에 추가). 원격 제공자 설정 [미확인] |
| CAPTCHA | [확인] 코드에 없음(이번에 추가). 원격 설정 [미확인] |
| 메일 발송 한도 | [확인·공식] 기본 메일: **시간당 2통** (프로젝트 전체). 같은 주소 OTP/링크 재요청 60초 간격 ([Rate limits](https://supabase.com/docs/guides/auth/rate-limits)) |
| 가입·로그인 요청 한도 | [확인·공식] IP 당 5분 30회 |

## 8. 무료 운영 플랜 → `03_FREE_TIER_OPERATIONS.md`

## 9. 백업·복구·롤백

| 항목 | 상태 |
|---|---|
| 코드 백업 | [전달] `Desktop\DOTDAY_backups\dotday_full_*.zip` (비밀 포함, 공유 금지), 해시 복원 확인 기록 있음 |
| 배포 롤백 | [전달] Hobby 는 Instant Rollback 이 **직전 Production 한 단계만**, 그 이전은 `vercel promote` |
| 서버 데이터 백업 | [확인·공식] Supabase Free 는 자동 백업 **미포함** → Table Editor CSV 내보내기 또는 사용자가 직접 `supabase db dump` |
| 기기 데이터 | [확인] 앱의 업무 데이터 내보내기(.json), 가져오기 전 자동 백업 |

## 10. 작업 범위 결정

- 원격 DB·Auth 설정·SMTP·OAuth 등록·Vercel 환경변수·배포는 **하지 않았다** (승인 대기 → `05_FINAL_REPORT.md` §6).
- 로컬 코드·SQL 파일·테스트·문서만 변경했다. 기존 커밋·태그는 건드리지 않았다.
