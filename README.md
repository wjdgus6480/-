# DOTDAY v0.5

투두, 캘린더 일정, 프로젝트를 원하는 형태의 테이블로 보는 개인용 앱입니다.

```
[브라우저: React + IndexedDB]  ──HTTPS(JWT)──▶  [Spring Boot API]  ──JDBC──▶  [MySQL]
        Vercel (무료)                          Render (무료 web service)      Aiven (무료 MySQL)
```

- **Frontend**: Vite + React 19 + TypeScript. IndexedDB 에 먼저 저장하는 로컬 우선 구조라 로그인 없이·오프라인에서도 동작합니다.
- **Backend**: Spring Boot 3.5 (Java 21) — `backend/`. 인증(JWT + 기기별 세션), 동기화 API, 소유자 격리.
- **Database**: MySQL 8 (Aiven for MySQL 무료 플랜) — 스키마는 Flyway(`backend/src/main/resources/db/migration`)로 서버가 시작할 때 자동 적용됩니다.
- **Version Control**: Git / GitHub — https://github.com/wjdgus6480/-

## 운영 주소

| 구성 | 주소 · 서비스 |
|---|---|
| 프론트엔드 (Vercel) | https://dotday-silk.vercel.app |
| 백엔드 API (Render 무료 web service) | https://dotday-api.onrender.com — 상태 확인 `/api/health` |
| 데이터베이스 | Aiven for MySQL 8.4 무료 플랜 |

- 과제 권장 구성은 "Render MySQL" 이지만 Render 는 관리형 MySQL 을 제공하지 않고, 직접 띄우려면 유료 플랜 전용 디스크가 필요합니다. 그래서 무료로 쓸 수 있는 Aiven MySQL 로 대체했습니다.
- Render 무료 플랜은 15분간 요청이 없으면 잠들어, 첫 접속에 30초~1분 이상 걸립니다.
- 배포 검증 (2026-10-07): 운영 서버에서 CORS(Vercel 주소) → 가입 → 로그인 → 할 일 저장(MySQL) → 다시 조회 → 테스트 계정 삭제까지 통과. 백엔드 테스트 전체는 실제 Aiven MySQL(`dotday_test`)에서도 통과.

## 로컬 개발

### 프론트엔드

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # 프론트 테스트 (서버 없이 실행)
```

`.env` 의 `VITE_API_URL` 이 비어 있으면 로컬 전용 모드입니다. 설정 화면에서 "샘플 데이터 추가"로 바로 써 볼 수 있습니다.

### 백엔드 (JDK 21 필요)

```bash
cd backend
./mvnw test                                   # 서버 테스트 (H2 메모리 DB, Docker·MySQL 불필요)
bash scripts/mysql-test.sh                    # 같은 테스트를 실제 MySQL 에서 (backend/local.env 필요)
DATABASE_URL='mysql://…' JWT_SECRET=<32자 이상 임의 문자열> ./mvnw spring-boot:run     # http://localhost:8080
```

프론트 `.env` 에 `VITE_API_URL=http://localhost:8080` 을 넣으면 로그인과 기기 간 동기화가 켜집니다.
실제 서버와 붙여 보는 통합 테스트: `E2E_API_URL=http://localhost:8080 npx vitest run tests/e2e.backend.test.ts`

| 서버 환경변수 | 설명 |
|---|---|
| `DATABASE_URL` | Aiven 'Service URI' 그대로 (`mysql://avnadmin:…@…aivencloud.com:포트/defaultdb?ssl-mode=REQUIRED`). TLS 는 항상 켬 |
| `DB_URL` / `DB_USER` / `DB_PASSWORD` | `DATABASE_URL` 대신 JDBC 로 따로 지정할 때 |
| `JWT_SECRET` | 토큰 서명 키 (32바이트 이상). 없으면 서버가 시작하지 않습니다 |
| `CORS_ORIGINS` | 허용할 프론트 주소 (쉼표 구분) |
| `TOKEN_TTL` | 로그인 유지 기간 (기본 14d) |

## 배포

1. **GitHub** 에 저장소를 올립니다.
2. **MySQL (Aiven 무료)**: Render 는 무료 MySQL 이 없어서(디스크가 유료 플랜 전용) Aiven 을 씁니다.
   aiven.io 가입(카드 불필요) → Create service → MySQL → **Free plan** → Render 와 가까운 지역 선택 → 생성 후 Overview 의 **Service URI** 복사.
   무료 플랜: 1 CPU · 1GB RAM · 1GB 저장, 기간 제한 없음. 오래 쓰지 않으면 Aiven 이 알림 후 서비스를 끌 수 있습니다.
   실제 MySQL 검증: `backend/local.env` 에 `DB_URL`·`DB_USER`·`DB_PASSWORD` 를 적고 `bash backend/scripts/mysql-test.sh` (같은 서버에 `dotday_test` DB 를 자동으로 만들어 씀. `TEST_DATABASE_URL` 을 적으면 그 DB 를 사용).
3. **Render (백엔드)**: New → Blueprint → 이 저장소 선택 → `render.yaml` 의 `dotday-api` 생성 → `DATABASE_URL`(Service URI)·`CORS_ORIGINS` 입력.
   `JWT_SECRET` 은 자동 생성됩니다. 무료 플랜은 15분간 요청이 없으면 잠들고, 첫 요청에 30초~1분이 걸립니다
   (그동안 프론트는 변경을 기기에 보관했다가 서버가 깨어나면 자동으로 보냅니다).
4. **Vercel (프론트)**: 환경변수 `VITE_API_URL=https://<서비스>.onrender.com` 을 넣고 다시 배포합니다.
5. Render 의 `CORS_ORIGINS` 에 Vercel 주소(`https://<프로젝트>.vercel.app`)가 들어 있는지 확인합니다.

## API

| 메서드 · 경로 | 설명 |
|---|---|
| `POST /api/auth/signup` · `POST /api/auth/login` | 가입·로그인 → `{access_token, expires_at, user}` |
| `GET /api/auth/me` | 토큰 확인 |
| `POST /api/auth/logout` · `POST /api/auth/logout-all` | 이 기기 / 모든 기기 로그아웃 (서버 세션 폐기) |
| `PUT /api/auth/password` | 비밀번호 변경 (현재 비밀번호 확인) |
| `POST /api/auth/reauth` · `POST /api/account/delete` | 재인증 · 본인 탈퇴 (최근 10분 내 로그인 필요) |
| `POST /api/sync/domain/ops` · `GET /api/sync/domain/{entity}?since=` | 업무 데이터 변경 적용 · 변경분 가져오기 |
| `POST /api/sync/views/ops` · `GET /api/sync/views?since=` | 보기 설정 변경 적용 · 변경분 가져오기 |
| `GET /api/health` | 상태 확인 (Render health check) |

변경 적용 결과는 `applied | conflict | not_found | rejected | retry` 중 하나이며, 같은 `op_id` 를 다시 보내면 저장된 결과를 돌려줍니다(멱등).
모든 쿼리는 토큰의 사용자(`owner_id`)로 제한됩니다.

## 구조

```
src/domain/      업무 데이터 (보기 설정과 분리)
  repo.ts        로컬 우선 저장소: CRUD + outbox 원자 기록, 휴지통, 가져오기/내보내기, 회차 수정
  recurrence.ts  반복 규칙(RFC 5545 부분집합)·회차 계산·서머타임
  sync.ts        DomainSyncEngine: 멱등 전송, 병합 단위 3-way 병합, 삭제 충돌
  migrate.ts     계정 연결 시 로그인 전 데이터 이전(미리보기·백업·검증)
  remote.ts      서버 계약(DomainRemote) + REST 구현
src/views/       보기 설정 (fields·validate·engine·repo·sync·migrate, remote.ts = REST 구현)
src/app/
  api.ts         API 클라이언트 (토큰 보관, 401 → 세션 만료 처리, 오류 분류)
  auth.ts        AuthController: 로그인·가입·로그아웃·비밀번호 변경·탈퇴
  services.ts    저장소·동기화 엔진·인증 조립 (VITE_API_URL 없으면 로컬 전용)
src/ui/          테이블, 컬럼/정렬/필터 메뉴, 설정 화면, 로그인 화면
backend/
  src/main/java/com/dotday/auth/   SecurityConfig(JWT·CORS), AuthService(가입·로그인·세션·탈퇴), 로그인 시도 제한
  src/main/java/com/dotday/sync/   DomainOpService·ViewOpService(변경 적용 판정), EntitySpec(필드·검사 규칙)
  src/main/resources/db/migration/ Flyway 스키마 (V1__init.sql)
  src/test/                        인증·동기화·사용자 격리 테스트 (MockMvc + H2)
  Dockerfile                       Render 배포용
render.yaml      Render Blueprint (백엔드)
tests/           프론트 테스트 (동기화 엔진은 PGlite 에뮬레이터 서버로, REST 어댑터는 가짜 fetch 로 검증)
legacy/supabase/ v0.4 까지 쓰던 Supabase(Postgres) SQL. 운영에는 쓰지 않으며, 동기화 엔진 테스트의 에뮬레이터 서버로만 사용
docs/            v0.4 까지의 품질 검토·테스트 보고서 (docs/public 은 Supabase 시절 운영 점검 기록)
```

### 1단계 범위 밖 (v0.4 Supabase 판에는 있었음)
메일 인증·매직링크·비밀번호 재설정 메일, Google·카카오·네이버 로그인, CAPTCHA. 메일 발송 서비스와 OAuth 연동을 서버에 붙이는 2단계 작업입니다.

## 설계 결정

- **식별 컬럼(제목·이름)은 숨길 수 없습니다.** 순서와 너비는 바꿀 수 있습니다. 행 열기/완료 체크는 컬럼 설정과 관계없는 맨 앞 고정 칸에 있습니다.
- **모바일은 가로 스크롤 방식입니다.** 사용자가 정한 표시/숨김을 반응형 레이아웃이 바꾸지 않습니다. 모바일에서는 첫 번째 고정 컬럼만 고정되고, 순서는 컬럼 메뉴의 ▲▼로 바꿉니다.
- **보기 설정은 자동 저장됩니다.** "다른 이름으로 저장"은 복제로 합니다.
- **버전**: `version`은 서버가 확인한 버전입니다(0 = 아직 서버에 없음). 충돌은 최상위 필드(이름, 컬럼, 정렬, 필터, 레이아웃, 기본 여부, 삭제 상태) 단위로 판단합니다.
- **기본 보기가 여러 개인 경우**(동기화 경합)에는 가장 최근에 수정된 것을 기본으로 봅니다.
- **삭제**는 소프트 삭제이며 30일 동안 설정 화면에서 복구할 수 있습니다. 서버 행은 soft-delete 상태로 남습니다.
