# 원격 Supabase READ-ONLY 보안 감사 (2026-10-05 KST 11시경)

원격에 보낸 요청은 **모두 GET** 이다(쓰기·DDL·설정 변경·배포 0건). 키 값은 출력·기록하지 않았다.
표기: **[확인]** 원격 응답으로 직접 확인 · **[추론]** 확인된 사실에서 추론(검증 필요) · **[미확인]**

## 0. 접근 수단

| 수단 | 상태 |
|---|---|
| publishable key (`.env`) | 있음 → 공개 엔드포인트 GET 만 가능 |
| DB 비밀번호 / service_role / secret key | **없음** (의도된 상태) |
| Supabase CLI·psql | 설치 안 됨 |
| Vercel CLI | 설치 안 됨 (설치=패키지 다운로드라 이번 단계에서 하지 않음) |

→ DB 카탈로그(권한·정책·트리거·함수)는 직접 조회 불가. 대신 **SELECT 한 문장 감사 쿼리** `supabase/remote_audit_readonly_onequery.sql` 를 준비했다. 로컬에서 `SET TRANSACTION READ ONLY` 트랜잭션 안에서 실행되는 것을 테스트로 확인(REM-AUDIT-001/002).

## 1. 원격 프로젝트 식별

| 항목 | 값 | 근거 |
|---|---|---|
| project ref | `sazaeyultnekwheasjwy` | [확인] `.env` URL 호스트 |
| project URL | `https://sazaeyultnekwheasjwy.supabase.co` | [확인] |
| Production 번들이 가리키는 프로젝트 | 같은 URL | [확인] 공개 Production JS 에 포함된 Supabase URL |
| 환경 | Production 으로 판단 (이 저장소가 아는 유일한 프로젝트, Production 번들이 사용) | [확인] + Free 플랜은 브랜칭이 없어 DB 하나 [추론] |
| Auth 서버 | GoTrue v2.197.0, 정상 응답 | [확인] `GET /auth/v1/health` |
| 마이그레이션 상태 | 0001~0004 의 표·함수 존재 [확인: 7개 표가 404 아닌 권한 오류, `domain_sync_fields`·`view_pref_allowed_fields` 함수 응답]. 0005 [미확인]. 0007 미적용 [확인: `app_admins` 404] | REST GET |

## 2. 실제 Production 버전

| 기준 | 값 |
|---|---|
| Git HEAD | `2445902` (작업 트리에 미커밋 변경 있음) |
| `v0.4.2-prod` | `2445902` |
| RECOVERY.md (수정 전) | `v0.4.1-baseline` |
| 공개 사이트 `dotday-silk.vercel.app` | `assets/index-cI3tAxyU.js`, Last-Modified 2026-10-05 00:53 GMT(09:53 KST) |
| `v0.4.2-prod` 를 임시 폴더에서 빌드 | `index-cI3tAxyU.js` — **SHA-256 앞 16자리 `35f85292c58b0b28` 로 공개 파일과 바이트 단위 일치** |
| `v0.4.1-baseline` 빌드 | `index-duWzcPer.js` — 불일치 |
| Vercel 배포의 commit SHA | [미확인] CLI 미설치. 배포 방식이 로컬 prebuilt(`vercel deploy --prebuilt`)라 Git 메타데이터가 없을 수 있음 |

**실제 Production = `v0.4.2-prod` 의 코드** (그 뒤 커밋은 문서·줄바꿈만이라 번들 동일). RECOVERY.md 를 이 근거로 고쳤다.

## 3. 테이블 권한 (anon, GET 으로만 판별)

| 표 | anon SELECT | 근거 |
|---|---|---|
| projects / categories / tasks / events / view_preferences / domain_ops / view_preference_ops | **거부** (42501 permission denied) | [확인] `GET /rest/v1/<표>?select=…&limit=0` |
| app_admins | 표 없음 | [확인] PGRST205 |

- anon INSERT/UPDATE/DELETE/TRUNCATE, authenticated 의 모든 권한: [미확인] (쓰기 요청이나 로그인 없이는 판별 불가 — 이번 단계 금지)
- **중요한 정정**: PHASE 0~6 의 로컬 테스트는 "Supabase 가 새 표에 anon·authenticated 까지 ALL 을 자동 부여"하는 옛 모델을 가정했다. 그런데 원격 anon 은 0001~0005 가 anon 에 grant 한 적이 없는 SELECT 도 없다. 옛 모델이었다면 SELECT 가 있어야 한다. → 이 프로젝트는 **자동 GRANT 없는 새 기본값**(2026-05-30 이후 생성 프로젝트, Vercel 프로젝트 생성일 2026-10-04 와도 맞음)일 가능성이 높다 [추론].
  - 그 모델이면 authenticated 는 마이그레이션의 명시적 grant 만 가진다: 업무 표 SELECT·INSERT·UPDATE(DELETE 는 0004 회수), ops SELECT·INSERT, 시퀀스 USAGE → **TRUNCATE·setval 없음** (로컬 재현: REM-AUDIT-002).
  - 단 이것은 추론이다. 대시보드에서 누군가 권한을 바꿨을 가능성 등은 감사 쿼리로만 배제할 수 있다.

## 4. 함수 실행 권한 (부작용 없는 IMMUTABLE 함수만 GET)

| 함수 | anon 실행 | 영향 |
|---|---|---|
| `domain_sync_fields('tasks')` | **가능** (200, 상수 배열 반환) | 낮음 — 이미 공개된 필드 목록 |
| `view_pref_allowed_fields('tasks')` | **가능** (200) | 낮음 |
| `apply_domain_op` 등 쓰기 RPC | [미확인] — POST 가 필요해 시도하지 않음. PUBLIC 기본 실행 권한이면 anon 도 호출 가능하지만 함수 첫 줄에서 `not_authenticated` 로 거부 (코드 근거) |

→ Postgres 기본값(함수 EXECUTE 는 PUBLIC)이 그대로다. 0006 이 회수 대상으로 정한 항목과 일치.

## 5. Auth (공개 `GET /auth/v1/settings`)

| 항목 | 값 | 코드와 일치 |
|---|---|---|
| 이메일 로그인 | 켜짐 | ✔ |
| **가입 허용** (`disable_signup`) | **false → 누구나 가입 가능 (현재 Production)** | — |
| **이메일 인증** (`mailer_autoconfirm`) | **false → 인증 전 세션 없음 (Confirm email 켜짐)** | ✔ 가입 후 "확인 메일" 안내 흐름과 일치 |
| 익명 로그인 | 꺼짐 | ✔ |
| Google | **꺼짐** | ✔ (로컬 새 코드에서는 "준비 중" 표시) |
| Kakao | **꺼짐** | ✔ |
| Naver(사용자 지정 제공자) | [미확인] — 이 엔드포인트는 사용자 지정 제공자를 보여 주지 않음 | — |
| 전화·SAML·패스키 | 꺼짐 | — |
| CAPTCHA | [미확인] — 공개 설정에 없음. Production 앱(v0.4.2)은 토큰을 보내지 않으므로, 서버 CAPTCHA 가 켜져 있다면 지금 가입·로그인이 실패하고 있어야 함 |
| Redirect URLs·Site URL·요청 한도·수동 연결·SMTP | [미확인] — 대시보드에서만 확인 가능 |

## 6. 비밀 노출 점검 (공개 Production 번들)

- service_role·secret 키 값: 0건 · JWT 형태 문자열: 0건 · `sb_secret_` 1건은 supabase-js 의 키 접두어 검사 코드
- 번들의 publishable key 는 공개용(설계상 정상)

## 7. 위험 판정 요약

| | 판정 | 근거 |
|---|---|---|
| R1 TRUNCATE | UNKNOWN (PASS 가능성 높음) | anon SELECT 부재로 자동 GRANT 없는 모델 추론. authenticated 권한 미확인 |
| R2 SEQUENCE | UNKNOWN (PASS 가능성 높음) | 같은 추론. 0003 은 USAGE 만 grant |
| R3 ANON | 표 SELECT PASS(확인) / 표 쓰기 UNKNOWN / 함수 실행 FAIL(확인, 영향 낮음) | REST GET |
| R4 CROSS-USER | 설계상 존재(0001 FK 는 소유자를 구분하지 않음, RPC 는 RLS 로 차단) · 원격 스키마 UNKNOWN | 마이그레이션 파일 |

## 8. 지금 실제로 영향을 주는 무료 플랜·운영 위험

1. **가입이 열려 있음 + authenticated 권한 미확인**: R1 이 실제로 FAIL 이라면 낯선 사람이 가입·메일 인증만으로 전 회원 데이터를 지울 수 있다. 감사 쿼리 실행이 최우선.
2. **기본 메일 시간당 2통 + 가입 허용**: 누구든 가입·재전송을 반복하면 운영자의 비밀번호 재설정 메일까지 막힌다(SMTP 미확인).
3. **자동 백업 없음(Free)**: 원격 변경 전 CSV 백업이 유일한 복구 수단.
4. **1주 비활동 일시 중지**: 현재 활성(health 정상). 사용자가 적은 공개 초기에 발생 가능.
5. Vercel Hobby: 정적 사이트·비상업이라 현재 영향 없음.

## 9. 로컬 PGlite 와 원격 비교

| 항목 | Local (legacy 모델, 0005까지) | Local (none 모델, 0005까지) | Remote | 차이 |
|---|---|---|---|---|
| anon 표 권한 | ALL(DELETE 제외) | 없음 | SELECT 없음 [확인], 나머지 [미확인] | 원격은 none 모델과 일치 |
| authenticated 표 권한 | +TRUNCATE·REFERENCES·TRIGGER | SELECT·INSERT·UPDATE | [미확인] | — |
| TRUNCATE | authenticated·anon 가능 | 불가 | [미확인] | — |
| sequence | setval 가능 | USAGE 만 | [미확인] | — |
| RLS | 7표 켜짐 | 같음 | [미확인] (권한 오류가 먼저 나서 판별 불가) | — |
| triggers | 0004·0005 | 같음 | [미확인] | — |
| functions anon 실행 | 가능 | 가능 | **가능 [확인]** | 일치 |
| Auth | — | — | 이메일 인증 필수·가입 허용·소셜 꺼짐 [확인] | 코드와 일치 |

## 10. 0005 / 0006 / 0007 판단 (실행하지 않음)

- **0005: 필요** — 원격 적용 여부는 감사 쿼리 `m0005_*` 로 확인. 원격 표·RPC 이름은 0003 과 일치 [확인: 함수 존재]. `remote_apply_0005.sql` 은 이미 적용돼 있으면 스스로 중단.
- **0006: 필요** — 원격이 none 모델이어도 함수 anon 실행 회수(확인된 FAIL)·교차 참조 차단(R4)·명시적 최소 권한 고정 효과가 있다. revoke 는 없는 권한에 대해 무해. none 모델 스키마에서 적용 스크립트가 충돌 없이 들어가는 것을 로컬 확인(REM-AUDIT-002). 원격 스키마 최종 일치(시퀀스 이름·트리거 부재)는 감사 쿼리로 확인 필요.
- **0007: 확인 불가** — 원격에서 ① 함수 소유자(postgres)의 `auth.users` DELETE 권한 ② `last_sign_in_at` 컬럼 ③ 모든 표의 FK 가 `on delete cascade` 인지(삭제 범위) ④ 관리자로 지정할 소유자 계정 ID — 모두 감사 쿼리 `auth`·`foreign_keys`·`row_counts` 로 확인해야 한다.

## 11. 적용 순서 검토

제안된 순서는 대체로 맞다. 다음을 고친다.

1. **READ-ONLY AUDIT(감사 쿼리)** 를 가장 먼저 — 가입이 열려 있으므로 R1 이 FAIL 이면 다른 무엇보다 먼저 대응(임시로 가입 끄기 또는 0006 우선 적용, 둘 다 승인 필요).
2. CSV BACKUP → 0005 → 0006 → 0007 → VERIFY(감사 쿼리 재실행 비교) — 그대로.
3. AUTH SETTINGS VERIFY: 이메일 인증은 이미 확인됨. 남은 것은 Redirect URLs 에 Production 도메인 포함 여부(소셜 로그인 복귀 주소), CAPTCHA 꺼짐 확인, SMTP.
4. **APP DEPLOY 전에 작업 트리 커밋** 필요(현재 미커밋).
5. **Turnstile 순서 — 현재 구현 기준으로 검증**:
   - 사이트 키는 Vite 가 **빌드 시점에 번들에 박는다** (`import.meta.env`). 환경변수만 바꾸고 재빌드하지 않으면 반영되지 않는다.
   - RECOVERY.md 의 배포 경로는 이 PC 의 `.env` 로 `vercel build --prod` 후 prebuilt 배포다. 따라서 키를 **실제로 빌드에 쓰이는 곳**(로컬 `.env` 또는 `vercel pull` 로 받은 Vercel env)에 넣어야 한다.
   - 순서: Turnstile 위젯 생성(호스트에 `dotday-silk.vercel.app` 등 실제 도메인) → 키 넣고 재빌드·배포 → Production 에서 위젯 표시·토큰 전송 확인 → **그 다음** Supabase CAPTCHA 켜기. 서버는 꺼져 있는 동안 토큰을 무시하므로 앱을 먼저 배포해도 안전하다. 반대 순서면 현재 v0.4.2 번들이 토큰을 보내지 않아 전원 가입·로그인 실패.
6. Google → DEVICE TEST — 그대로. Google 전에 Redirect URLs 확인.
