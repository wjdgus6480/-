# DOTDAY 공개 서비스 전환 — 최종 보고서 (PHASE 5·6)

작성 2026-10-06 · 기준 커밋 `2445902`(`v0.4.2-prod`) 위의 **커밋하지 않은 작업 트리** · 원격 변경 0건

## 1. 한눈에 보기

| 구분 | 상태 |
|---|---|
| 코드 구현 | 완료: 소셜 로그인 버튼·콜백 오류 처리, CAPTCHA 토큰 전달, 가입 확인 코드·재전송 쿨다운, 계정 존재 비노출, 회원 탈퇴 화면, 이 기기 데이터 지우기, 처리방침·약관 화면 |
| SQL 준비 | 완료: 0006(최소 권한), 0007(관리자 표·탈퇴 RPC), 원격 점검(읽기 전용)·적용·롤백 스크립트 |
| 로컬 테스트 | **182 / 182 통과** (기존 128 + 신규 54, 기존 1건은 새 정책에 맞게 수정), 타입 검사·Production 빌드 성공 |
| 실제 제공자 연동 | **미완료** (Google·Kakao·Naver 앱 등록·비밀키 입력 안 함) — 모의 테스트만 |
| 원격 DB 적용 | **미적용** (0005·0006·0007 모두) |
| 원격 Auth 설정 | **변경 없음** (Confirm email·CAPTCHA·SMTP·제공자) |
| 실제 기기 검증 | **미완료** (PC Chrome·iPhone Safari 실기기). 브라우저 미리보기에서 데스크톱·375px 폭 화면만 확인, 로그인 요청은 보내지 않음 |
| Production 배포 | **안 함** |

## 2. 변경 파일 (작업 전 clean → 작업 후)

수정 9: `src/App.tsx`, `src/app/auth.ts`, `src/app/services.ts`, `src/ui/AuthForms.tsx`, `src/ui/SettingsPage.tsx`, `src/styles.css`, `tests/auth.test.tsx`, `tests/helpers.ts`, `.claude/launch.json`(검증용 포트 5174 설정 추가)
신규 코드 4: `src/app/config.ts`, `src/app/deviceData.ts`, `src/ui/Captcha.tsx`, `src/ui/LegalPages.tsx`
신규 SQL 5: `supabase/migrations/20261006000006_least_privilege.sql`, `…000007_admin_and_account_deletion.sql`, `supabase/remote_inspect_readonly.sql`, `supabase/remote_apply_0006_0007.sql`, `supabase/remote_rollback_0006_0007.sql`
신규 테스트 4: `tests/security.rls-isolation.test.ts`, `tests/public.auth.test.tsx`, `tests/device.data.test.tsx`, `tests/public.sync-regression.test.ts`
신규 문서: `docs/public/00~06`
**변경하지 않은 것**: 0001~0005 마이그레이션, IndexedDB 버전(2)·스토어, 동기화 엔진, 로그인 전 데이터 이전 흐름, 기존 테이블·ID·소유권 규칙. 라이브러리 추가 없음(Turnstile 은 설정 시에만 공식 스크립트 로드).

테스트 하네스 변경: `tests/helpers.ts` 의 PGlite 서버가 이제 `anon`·`service_role` 역할과 **Supabase 기본 권한**을 재현한다. 이 변경으로 기존 128개는 그대로 통과했고, 0005 까지의 권한 위험(R1~R3)이 드러났다.

## 3. 필수 테스트 대응표

| # | 요구 | 결과 | 근거 (파일 › 테스트 ID) | 종류 |
|---|---|---|---|---|
| 1 | 이메일 가입·인증 | 통과 | public.auth › PUB-AUTH-001/003, auth › AUTH-002 | 모의 클라이언트 |
| 2 | 로그인·로그아웃·세션 만료 | 통과 | auth › AUTH-001, AUTH-004 | 모의 |
| 3 | 비밀번호 재설정 | 통과 | auth › AUTH-003, PUB-AUTH-001 | 모의 |
| 4 | Google/Kakao/Naver 콜백 | 통과(모의) | PUB-AUTH-004/005 | **모의 — 실연동 미완료** |
| 5 | OAuth 오류·취소·중복 계정 | 통과(모의) | PUB-AUTH-005 | 모의 |
| 6 | 회원 A/B 격리 | 통과 | security.rls-isolation › SEC-RLS-002 | PGlite (실제 SQL) |
| 7 | owner_id 위조 차단 | 통과 | SEC-RLS-002 | PGlite |
| 8 | 비로그인 접근 차단 | 통과 | SEC-RLS-001/002 | PGlite |
| 9 | 탈퇴 시 다른 회원 보존 | 통과 | SEC-DEL-001, PUB-DEL-001 | PGlite + 모의 |
| 10 | 미전송 시 기기 데이터 삭제 방지 | 통과 | device.data › DEV-001/004 | fake-indexeddb |
| 11 | PC·iPhone 동기화 회귀 | 통과 | data.sync › SYNC-001, public.sync-regression › PUB-SYNC-001 | 2기기 시뮬레이션 (실기기 아님) |
| 12 | 오프라인 생성·수정·삭제 후 복구 | 통과 | PUB-SYNC-001, SYNC-002 | 시뮬레이션 |
| 13 | 재시도·중복 전송 방지 | 통과 | SYNC-003, SYNC-009, PUB-SYNC-001 | 시뮬레이션 |
| 14 | 모바일 로그인 UI·리다이렉트 | 부분 | 375px 미리보기 확인, 리다이렉트 오류 처리 테스트 | **실기기 Safari 미검증** |
| 15 | 타입 검사·Production 빌드 | 통과 | `npm run build` | 실행 |

실행 명령: `npm test` (13 → 17 파일, 128 → 182 테스트) · `npm run build`

## 4. 보안 점검 결과

| 항목 | 결과 |
|---|---|
| 프런트엔드 비밀키 | 번들에 service_role·secret 없음. `sb_secret_` 문자열 1건은 supabase-js 의 키 접두어 검사 코드이며 기준선 번들에도 동일하게 존재 |
| 관리자 판정 | 서버 표만, 이메일 비교·하드코딩 없음, 클라이언트 지정 불가 |
| 계정 자동 연결 | Supabase 가 확인된 같은 이메일을 자동 연결 → 요구사항과 차이 (`02_AUTH_SOCIAL_EMAIL.md` §1) **사용자 결정 필요** |
| CAPTCHA | 클라이언트 준비 완료, **서버 검증은 Supabase 설정이 켜져야 동작** |
| 계정 존재 노출 | 가입·메일 로그인·재설정 문구 통일 |
| flowType | implicit 유지 (iPhone 메일 링크 회귀 방지) — PKCE 전환은 실기기 검증 후 |

## 5. 공개 준비 점검표 (PHASE 6)

| 항목 | 상태 |
|---|---|
| 기존 사용자 데이터 보존 | 코드: 기존 데이터·스키마 변경 없음 ✔ / 원격 적용 전 CSV 백업 절차 문서화 |
| 기존 인증·동기화 유지 | 로컬 회귀 182 통과 ✔ / 실서버 재확인 필요 |
| 이메일 인증·재전송 제한 | 코드 ✔ / **Confirm email 원격 확인 필요** |
| CAPTCHA 검증 | 코드 ✔ / **서버 설정 승인 필요** |
| RLS·DB 권한 | 로컬 ✔ / **0005·0006·0007 원격 적용 승인 필요** |
| A/B 격리 | 로컬 ✔ / 실서버에서 테스트 계정 2개로 재확인 필요 |
| 탈퇴·기기 데이터 보호 | 코드·로컬 ✔ / 탈퇴는 0007 적용 후 동작 |
| 처리방침·약관 | 초안 ✔ / **법률 자문·문의처 필요** |
| 무료 플랜 조건 | 문서 ✔ (`03`) — 1주 비활동 일시 중지·자동 백업 없음·메일 시간당 2통이 주요 위험 |
| 백업·복구 | 문서 ✔ (`docs/RECOVERY.md`, `01` §6) |
| 사용량 초과 대응 | 문서 ✔ (`03`) |
| 오류 로그·사용자 안내 | 사용자 안내 ✔ / 서버 오류 로그 수집 도구는 없음(무료 범위에서 Supabase 대시보드 로그만) |
| Production 롤백 | 문서 ✔ (Hobby: 직전 한 단계 rollback, 그 외 promote) |
| PC Chrome·iPhone Safari | **미검증** |

판단: **아직 공개 배포 불가.** 원격 권한 강화(0005·0006)와 Confirm email·CAPTCHA·메일 발송 대책이 적용되기 전에는 누구나 가입할 수 있게 열면 R1(전 회원 데이터 TRUNCATE) 위험이 남는다.

## 6. 승인이 필요한 항목 (각각 별도 승인)

| # | 작업 | 준비물 | 위험 | 롤백 |
|---|---|---|---|---|
| A1 | 원격 읽기 전용 점검 실행 | `remote_inspect_readonly.sql` | 없음(조회만) | — |
| A2 | 0005 원격 적용 | `remote_apply_0005.sql` | 낮음 (ops 직접 INSERT 차단) | 파일 머리 주석 |
| A3 | 0006·0007 원격 적용 | `remote_apply_0006_0007.sql` (사전 점검 내장, 한 트랜잭션) | 중간: 앱이 쓰지 않는 권한 회수. RPC·조회는 리허설 통과 | `remote_rollback_0006_0007.sql` + A1 의 GRANT 문 |
| A4 | 소유자 계정을 app_admins 에 지정 | A1 [9] 로 ID 확인 후 INSERT 1줄 | 낮음 | `delete from public.app_admins where user_id = …` |
| A5 | Confirm email 켜짐 확인/설정 | 대시보드 | 꺼져 있었다면 기존 미인증 사용자 로그인 영향 | 설정 원복 |
| A6 | Turnstile 위젯 생성 → Vercel 에 `VITE_TURNSTILE_SITE_KEY` → 배포 → Supabase CAPTCHA 켜기 | 순서 필수 | 순서가 바뀌면 모든 가입·로그인 실패 | Supabase CAPTCHA 끄기 |
| A7 | Google OAuth 앱 등록·Supabase 입력·`VITE_AUTH_PROVIDERS=google` | `02` §1 | 낮음 | 제공자 끄고 환경변수 제거 |
| A8 | Kakao (이메일 정책 결정 포함) | `02` §1 | 이메일 없는 계정 처리 | 같음 |
| A9 | Naver 사용자 지정 제공자 시험 + 검수 신청 | `02` §1 | 매핑 불가 가능성 | 제공자 삭제 |
| A10 | 커스텀 SMTP (도메인 필요) | `02` §4 | 도메인 비용, 발신 인증 | 기본 SMTP 로 복귀 |
| A11 | `VITE_CONTACT_EMAIL` 등 공개 환경변수 | — | 없음 | 제거 |
| A12 | Production 배포 | 이 작업 트리 커밋 → 빌드 → 배포 | 화면 변경, 탈퇴는 A3 전엔 '미적용' 안내 | Vercel rollback |
| A13 | 계정 자동 연결 정책 결정 | `02` §1 선택지 a/b/c | — | — |
| A14 | PKCE 전환 여부 | 실기기 메일 링크 검증 필요 | iPhone 재설정 회귀 | 설정 원복 |

권장 순서: A1 → (백업) → A2 → A3 → A1 재실행·비교 → A5 → A12 → A6 → A7 → A4 → 실기기 검증 → 공개.

## 7. 완료율 (요구사항 14개 기준)

| # | 목표 | 코드·로컬 테스트 | 운영 반영 |
|---|---|---|---|
| 1 | 이메일·비밀번호 가입 | ✔ | ✔ (기존 기능, 동작 중으로 전달받음) |
| 2 | 가입 후 이메일 인증 | ✔ | △ Confirm email 미확인 |
| 3 | Google 로그인 | ✔ 모의 | ✕ |
| 4 | Kakao 로그인 | ✔ 모의 | ✕ |
| 5 | Naver 로그인 | △ (custom 제공자 가정, 매핑 미확인) | ✕ |
| 6 | 기존 로그인·로그아웃·재설정 유지 | ✔ | ✔ (코드 변경 후 미배포, 기존 배포는 그대로) |
| 7 | 데이터 격리·RLS 검증 | ✔ | ✕ 원격 미적용 |
| 8 | 관리자·회원 권한 분리 | ✔ | ✕ |
| 9 | 탈퇴·개인정보 처리 | ✔ (법률 검토 제외) | ✕ |
| 10 | PC·iPhone 동기화 유지 | ✔ 시뮬레이션 | △ 실기기 미검증 |
| 11 | 오프라인 후 복구 | ✔ | △ 실기기 미검증 |
| 12 | 무료 운영 조건 검증 | ✔ 문서 | ✔ 문서 |
| 13 | 보안 테스트·공개 전 검증 | ✔ 로컬 | ✕ 실서버 |
| 14 | 포트폴리오 문서화 | ✔ | ✔ |

- **코드·로컬 기준: 13.5 / 14 ≈ 96%** (Naver 를 절반으로 계산)
- **운영 반영 기준: 4 / 14 ≈ 29%** (1, 6, 12, 14 / △ 는 미완료로 계산)
