# PHASE 2·3 — 소셜 로그인, 이메일 인증, 스팸 방어

상태: **클라이언트 코드·모의 테스트 완료 / 실제 제공자 연동·Supabase 설정 변경 없음 (승인 대기)**

## 1. 소셜 로그인 제공자 비교 (공식 문서 기준, 2026-10-06 확인)

| 항목 | Google | Kakao | Naver |
|---|---|---|---|
| Supabase 지원 | **기본 제공자** | **기본 제공자** | 기본 제공자 아님 → **사용자 지정 OAuth2/OIDC 제공자**(`custom:naver`) |
| 근거 | [auth-google](https://supabase.com/docs/guides/auth/social-login/auth-google) | [auth-kakao](https://supabase.com/docs/guides/auth/social-login/auth-kakao) | [custom-oauth-providers](https://supabase.com/docs/guides/auth/custom-oauth-providers) |
| 필요한 개발자 계정 | Google Cloud 프로젝트 | Kakao Developers 앱 | NAVER Developers 애플리케이션 |
| 앱 등록·검수 | OAuth 동의 화면(대상·범위·브랜딩). openid/email/profile 은 기본 범위. 브랜드 확인·커스텀 도메인 권장 | 카카오 로그인 활성화, 동의항목, Client Secret 활성화. **`account_email` 은 비즈 앱만** 가능 | 서비스 공개 전 **네이버 검수 필수**(가입·로그인 전 과정 화면 캡처 제출) — 검수 전에는 등록된 개발자만 로그인 가능 |
| 콜백 URL (제공자 쪽에 등록) | `https://<project-ref>.supabase.co/auth/v1/callback` | 같음 | 같음 |
| Supabase 에 넣는 값 | Client ID / Secret | REST API 키 / Client Secret | Client ID / Secret, authorization·token·userinfo URL, 속성 매핑 |
| 앱(Vercel)에 넣는 값 | 없음 (`VITE_AUTH_PROVIDERS` 에 `google` 표시만) | 같음 | 같음 |
| 무료 여부 | 무료 | 무료 | 무료. Supabase Free 는 사용자 지정 제공자 **최대 3개** |
| 이메일 제공 | 확인된 이메일 | 비즈 앱이 아니면 없음 → Supabase "Allow users without an email" 필요 | 사용자 동의 시 제공. 사용자 정보 응답이 `response` 안에 중첩 → **속성 매핑 가능 여부 미확인** |
| 보안 | 제공자↔Supabase state 검증 | 같음 | 사용자 지정 제공자는 **PKCE 기본 켜짐** |
| PC Chrome / iPhone Safari | 리다이렉트 방식이라 둘 다 동작 예상 (실기기 미검증) | 같음. 카카오톡 앱 로그인 연계는 제공자 처리 | 같음 |
| 난이도·유지보수 | 낮음 | 중간 (비즈 앱 여부에 따라 이메일 처리 다름) | 높음 (사용자 지정 제공자 설정·검수·응답 형식 차이) |

### 단계적 도입안 [제안]
1. **Google** 먼저 — 설정이 가장 단순하고 확인된 이메일을 준다.
2. **Kakao** — 개인 앱은 이메일 없이 로그인 가능하게 설정. 이메일 없는 계정은 비밀번호 재설정·메일 로그인을 쓸 수 없음을 안내.
3. **Naver** — 사용자 지정 제공자로 시험 연결 → 속성 매핑이 안 되면 자체 OAuth 서버(Edge Function) 구현이 필요한데, 토큰 검증·세션 발급을 직접 맡게 되어 유지보수 위험이 크다. **매핑이 되는지 먼저 실험하고, 안 되면 Naver 는 보류**하는 것을 권장. 검수 일정도 고려.

### 구현한 것 (`src/app/auth.ts`, `src/ui/AuthForms.tsx`, `src/app/config.ts`)
- 기존 로그인 화면 위에 "Google/카카오/네이버로 계속하기" 버튼. 이메일 로그인·가입·재설정은 그대로.
- `VITE_AUTH_PROVIDERS`(공개 값, 예 `google,kakao`)에 없는 제공자는 **비활성 + "(준비 중)"** 과 안내 문구. 서버에서 꺼진 제공자를 누르면 "준비 중" 안내.
- `signInWithOAuth({ provider, options: { redirectTo: 현재 주소 } })`. naver → `custom:naver`.
- 콜백 오류 처리: `?error=…` 또는 `#error=…` 로 돌아오면 취소·state 만료·이미 연결된 계정·중복 이메일 등을 한국어 배너로 안내하고, 주소창에서 오류 값만 지운다 (토큰 값은 읽지 않음).
- 비밀키는 코드·저장소·번들에 없다 (Supabase 대시보드에만 입력).
- OAuth 로 로그인해도 같은 RLS·소유권 규칙이 적용된다 (세션의 `auth.uid()` 기준).

### 클라이언트 흐름(flowType) — 결정 사항
- 현재 supabase-js 기본값(implicit)을 **유지**했다. PKCE 로 바꾸면 메일 링크(가입 확인·비밀번호 재설정)를 **요청한 브라우저에서만** 열 수 있다. iPhone 에서 홈 화면 앱으로 요청하고 메일 앱이 Safari 로 링크를 열면 저장소가 달라 재설정이 실패할 수 있다(기존 동작 회귀).
- 제공자↔Supabase 구간은 Supabase 가 state(사용자 지정 제공자는 PKCE 포함)로 보호한다. 앱으로 돌아오는 토큰은 URL 조각(#)에 담겨 서버로 전송되지 않고 supabase-js 가 즉시 지운다.
- [승인 필요] PKCE 로 전환하려면 실기기에서 메일 링크 흐름을 다시 검증해야 한다.

### 계정 중복·연결 — **요구사항과 다른 점 (중요)**
- Supabase 는 **확인된 같은 이메일의 소셜 계정을 기존 사용자에 자동 연결**한다. 미확인 신원은 연결 전에 제거해 선점 공격을 막는다. 공식 문서에 끄는 설정은 안내되어 있지 않다 ([Identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking)).
- 따라서 "이메일이 같다는 이유만으로 자동 연결하지 않는다"는 요구는 Supabase 기본 기능만으로는 **완전히 충족되지 않는다**. 현실적 위험은 "제공자가 확인했다고 보증한 이메일"에 한정된다.
- 앱 코드는 임의 연결을 하지 않으며, 수동 연결(`linkIdentity`)은 구현하지 않았다(설정 기본값 꺼짐).
- 선택지: (a) 위 정책을 받아들이고 처리방침에 명시, (b) Kakao·Naver 를 이메일 없이 받아 자동 연결 대상에서 제외, (c) Auth Hook 으로 가입을 제한 — 추가 설계 필요. **사용자 결정 필요.**

## 2. 이메일 인증

| 항목 | 상태 |
|---|---|
| 인증 전 이용 제한 | 서버 설정 **Confirm email** 이 켜져 있으면 인증 전에는 세션이 발급되지 않아 RLS 상 데이터 접근 불가. 로그인 시 `email_not_confirmed` 안내. **원격 설정값 [미확인]** — 공개 전 반드시 켜져 있어야 함 |
| 클라이언트 보완 | 가입 직후 "코드로 인증 / 확인 메일 다시 받기" 패널. 메일 링크를 다른 기기에서 열 수 없어도 6자리 코드로 인증 (`verifyOtp type:'signup'`) |
| 재전송 쿨다운 | 화면 60초 카운트다운 + 서버의 같은 주소 60초 제한 |
| 계정 존재 여부 비노출 | 가입(기존 이메일)·메일 로그인(미가입 주소)·재설정 모두 같은 문구. **기존 "이미 가입된 이메일입니다" 안내를 제거**(기존 테스트를 새 정책으로 수정) |
| 발송 한도 초과 | `over_email_send_rate_limit` → 재시도 안내 |
| 비밀정보 노출 | 오류는 코드별 한국어 문구로 바꾸고, 알 수 없는 오류만 서버 설명 120자 이내 표시 |

### 기본 메일 한도로 가능한 가입 수
- 기본 메일은 **프로젝트 전체 시간당 2통** → 가입 확인·재전송·재설정·메일 로그인을 모두 합쳐 시간당 2건. 공개 서비스에서는 사실상 부족하다(동시에 3명이 가입하면 1명은 실패).
- 대응: 커스텀 SMTP 연결(승인 필요), 소셜 로그인 병행으로 메일 의존 축소, 평소 비밀번호 로그인 권장 문구 유지.

## 3. 스팸 방어 선택지 비교

| 방법 | 스팸 차단 | 무료 | 가입 편의 | 개인정보 | 난이도 | Supabase 호환 | 메일 한도 대응 | 모바일 | 장애 시 |
|---|---|---|---|---|---|---|---|---|---|
| 1. 메일 인증만 | 낮음 (가입 시도마다 메일 소모 → 한도 고갈 공격 가능) | ○ | 좋음 | 최소 | 이미 됨 | ○ | ✕ | ○ | — |
| 2. + 요청 제한 | 중간 | ○ (Supabase 기본 IP 5분 30회) | 좋음 | IP(서버) | 설정만 | ○ 대시보드 | △ | ○ | 한도 완화 |
| 3. + CAPTCHA | 높음 | ○ Turnstile 무료·무제한 | 약간 불편 (대부분 자동 통과) | Cloudflare 가 브라우저 신호 처리 | 낮음 (구현함) | ○ hCaptcha·Turnstile 공식 지원 | ○ 봇 메일 소모 차단 | ○ | 서버 CAPTCHA 끄기 = 즉시 복구 |
| 4. + 비정상 가입 탐지 | 매우 높음 | △ 직접 구현 | 좋음 | 로그 수집 증가 | 높음 | Auth Hook 필요 | ○ | ○ | 복잡 |
| 5. OAuth 병행 | 높음 (제공자가 봇 차단) | ○ | 가장 좋음 | 제공자 정보 수신 | 중간 | ○ | ○ 메일 불필요 | ○ | 이메일 가입으로 대체 |

**권장: 2 + 3 + 5** (Turnstile + Supabase 기본 요청 제한 + Google/Kakao 병행). 4 는 사용자가 늘면 검토.

### CAPTCHA 구현 (`src/ui/Captcha.tsx`)
- Turnstile 무료: 요청 무제한, 위젯 20개, 위젯당 호스트 10개 ([Turnstile plans](https://developers.cloudflare.com/turnstile/plans/)). hCaptcha 무료판은 대부분 사용자에게 문제 풀이가 나온다(공식 Pro 페이지 설명) → Turnstile 권장.
- `VITE_TURNSTILE_SITE_KEY`(공개 키)가 있을 때만 스크립트를 불러오고, 토큰을 받기 전에는 제출 버튼 비활성. 가입·로그인·메일 로그인·재설정·재전송 요청에 `captchaToken` 전달. 토큰은 1회용이라 요청마다 위젯을 다시 만든다.
- **실제 차단은 서버**: Supabase 대시보드 › Authentication › Attack Protection 에서 CAPTCHA 를 켜고 Turnstile **Secret 키**를 넣어야 서버가 토큰을 검증하고 없거나 틀리면 거부한다. 화면 위젯만으로는 보호가 아니다.
- 적용 순서(중요): ① 사이트 키를 넣은 앱 배포 → ② 서버 CAPTCHA 켜기. 반대로 하면 그 사이 모든 가입·로그인이 실패한다.
- 장애 복구: Turnstile 장애로 가입이 막히면 서버 CAPTCHA 를 끄면 즉시 복구된다(앱은 토큰이 없어도 요청을 보냄).
- 공식 문서는 서버가 어떤 엔드포인트에서 토큰을 검증하는지 상세히 적고 있지 않다 → 서버 설정 후 "토큰 없이 가입 요청 → 거부"를 실서버에서 확인해야 한다 ([auth-captcha](https://supabase.com/docs/guides/auth/auth-captcha)).

## 4. 무료 SMTP 후보 (연결하지 않음)

| 제공자 | 무료 발송량 | 도메인 | 비고 |
|---|---|---|---|
| Supabase 기본 | 시간당 2통 | 불필요 | 운영용 아님(공식 안내) |
| Resend | 하루 100통, 월 3,000통, 도메인 3개 | 자체 도메인 인증(SPF/DKIM) 필요 | 초과 요금 없음(발송 중단) ([pricing](https://resend.com/pricing)) |
| Brevo | 하루 300통 | 발신 도메인 인증 요구 | SMTP relay 제공 (2026 비교 기사 기준, 공식 약관 재확인 필요) |
| Gmail SMTP | 계정 한도 내 | 불필요 | 개인 계정 비밀번호/앱 비밀번호를 서버에 맡겨야 함, 약관상 대량·서비스 발송 부적합 → **비권장** |

- 공통: 커스텀 SMTP 는 **자체 도메인**이 사실상 필요하다(`*.vercel.app` 으로는 발신 도메인 인증 불가). 무료 도메인 조건은 `03_FREE_TIER_OPERATIONS.md`.
- SMTP 연결·도메인 구입·DNS 설정은 승인 대상이다.
