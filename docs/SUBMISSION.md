# DOTDAY — 과제 제출 요약

AI 도구(Claude Code)를 활용해 풀스택 웹 애플리케이션을 기획부터 실제 배포까지 완료한 결과입니다. 기준일 2026-10-07.

## 1. 접속 주소

| 구분 | 주소 | 비고 |
|---|---|---|
| 서비스 (프론트) | https://dotday-silk.vercel.app | Vercel 무료 |
| API (백엔드) | https://dotday-api.onrender.com/api/health | Render 무료 web service. 15분 무요청 시 잠듦 → 첫 요청 30초~1분 |
| 저장소 | https://github.com/wjdgus6480/- | `main` = 배포 코드 |

## 2. 과제 요구사항 대응

| 요구사항 | 결과 | 근거 |
|---|---|---|
| AI 도구 활용 | ✅ | Claude Code 로 설계·구현·테스트·배포. 커밋의 `Co-Authored-By`, 작업 지침 `CLAUDE.md`. 디자인은 Google Stitch(MCP 연동) |
| 기획 | ✅ | `README.md`(구조·API), `docs/DB_DESIGN.md`(DB 설계), `design/DESIGN.md`(디자인 기준) |
| Frontend: React | ✅ | React 19 + TypeScript + Vite (`src/`) |
| Backend: Spring Boot | ✅ | Spring Boot 3.5, Java 21 (`backend/`) |
| Database: MySQL | ✅ | MySQL 8.4, Flyway 마이그레이션 (`backend/src/main/resources/db/migration`) |
| Version Control: Git / GitHub | ✅ | GitHub 공개 저장소 |
| 프론트 배포: Vercel | ✅ | 위 주소. 환경변수 `VITE_API_URL` 로 API 연결 |
| 백엔드 배포: Render | ✅ | `render.yaml` Blueprint, Docker(`backend/Dockerfile`), health check `/api/health` |
| DB 배포: Render MySQL | ✅ (대체) | **Render 는 관리형 MySQL 을 제공하지 않고**, 직접 띄우려면 유료 플랜 전용 디스크가 필요하다. 그래서 무료·기간 제한 없는 **Aiven for MySQL** 을 쓰고 Render 에서 TLS(`ssl-mode=REQUIRED`)로 접속한다 |

## 3. 시스템 구성

```
[브라우저: React + IndexedDB] ──HTTPS(JWT)──▶ [Spring Boot API] ──JDBC/TLS──▶ [MySQL 8.4]
          Vercel                                Render (Docker)                Aiven
```

- **로컬 우선**: 변경은 브라우저 IndexedDB 에 먼저 저장되고, 동기화 엔진이 서버로 보낸다. 서버가 잠들어 있거나 오프라인이어도 앱은 그대로 쓸 수 있다.
- **동기화**: 변경마다 `op_id` 를 붙여 재전송해도 한 번만 적용(멱등). 충돌은 필드 단위 3-way 병합. 변경분은 커서(`server_seq`)로 가져온다.
- **보안**: 모든 쿼리는 JWT 의 사용자(`owner_id`)로 제한. 기기별 세션·전체 로그아웃, 탈퇴 등 민감 작업은 최근 10분 내 로그인 필요. CORS 는 서비스 주소만 허용.

## 4. 주요 기능

- 투두·캘린더 일정·프로젝트·분류 관리, 반복 일정(회차별 수정·취소), 휴지통(30일 복구), 내보내기·가져오기
- 사용자가 고르는 표: 컬럼 표시·순서·너비·고정, 정렬, 필터, 검색, 보기 여러 개 저장 (보기 설정도 기기 간 동기화)
- 투두 **카드 보기**(지난 기한·오늘·예정 묶음), 캘린더 **월간 보기**, 데스크톱 사이드바 미니 달력
- 회원가입·로그인, 로그인 전 데이터를 계정으로 옮기기, 여러 기기 동기화, 충돌 해결 화면
- 모바일 대응: 하단 독 메뉴, 바텀시트 편집, 가로 스크롤 표, 다크 모드

## 5. 테스트 결과

| 범위 | 결과 | 실행 |
|---|---|---|
| 프론트 단위·통합 | 184 통과, 1 건너뜀 | `npm test` (여러 기기 동기화 시뮬레이션 포함) |
| 백엔드 API | 31 실행, 실패 0 (1 건너뜀) | `backend/ ./mvnw test` (H2) · `scripts/mysql-test.sh` (실제 MySQL) |
| 운영 서버 E2E | 통과 | `E2E_API_URL=https://dotday-api.onrender.com npx vitest run tests/e2e.backend.test.ts` — 가입 → 두 기기 동기화 → 다른 계정 격리 → 테스트 계정 삭제 |
| CORS | 서비스 주소 200, 다른 출처 403 | 배포 서버에 preflight 요청 |

## 6. AI 도구 활용 방식

- **Claude Code**: 요구사항 정리, Supabase 버전에서 Spring Boot + MySQL 로 백엔드 전환, 테스트 작성, 배포 설정(`render.yaml`, Dockerfile, Vercel), 배포 오류 진단(Render 로그에서 잘못 들어간 `DATABASE_URL` 발견)과 운영 서버 E2E 검증.
- **Google Stitch**: 디자인 시스템("Warm Henesys Tactile Modern")과 화면 시안 생성. Stitch MCP 를 Claude Code 에 연결해 시안을 가져오고, 색·글꼴·모양 토큰과 사이드바·카드·월간 달력으로 코드에 반영 (`design/`).
- 사람이 결정한 것: 기능 범위, 디자인 반영 범위(데이터 모델 변경이 필요한 EXP·하위 퀘스트 등은 제외), 배포 계정·비밀 값 입력.

## 7. 알려진 제약

- Render 무료 플랜 수면으로 첫 요청이 느리다 (앱은 기다리는 동안에도 동작).
- Aiven 무료 플랜은 장기간 사용하지 않으면 알림 후 서비스가 꺼질 수 있다.
- 이메일 인증·비밀번호 재설정 메일, 소셜 로그인은 이번 범위에서 제외.
