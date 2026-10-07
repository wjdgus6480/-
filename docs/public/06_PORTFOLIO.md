# DOTDAY — 포트폴리오 정리

> 개인용 일정·투두 앱을 누구나 가입하는 무료 공개 서비스로 바꾸기 위한 보안·인증·데이터 보존 설계. 실제 개인정보·토큰·키·사용자 데이터는 포함하지 않는다.

## 1. 시스템 구성

```
[PC Chrome / iPhone Safari]
  React 19 + Vite + TypeScript (정적 사이트, Vercel Hobby)
  ├─ IndexedDB "dotday" v2 : 업무 데이터 · 보기 설정 · 변경 대기열(outbox) · 충돌 · 백업
  ├─ 동기화 엔진 : 30초 주기 / 온라인 복귀 / 화면 표시 시 (숨김 화면은 쉼)
  └─ supabase-js (publishable key 만)
            │ HTTPS (JWT)
            ▼
[Supabase Free]
  Auth : 이메일·비밀번호 / 메일 코드 / (예정) Google·Kakao·Naver / (예정) Turnstile CAPTCHA
  Postgres + PostgREST
  ├─ RLS : owner_id = auth.uid()  (모든 표)
  ├─ RPC : apply_domain_op / apply_view_preference_op (security invoker, 멱등 op_id)
  ├─ 트리거 : version·server_seq 서버 강제, 동기화 기록 직접 쓰기 차단, 타 소유자 참조 차단
  └─ RPC : delete_my_account (security definer, 본인만, 10분 내 재인증)
```

## 2. 인증 흐름

1. 가입 → (CAPTCHA 토큰 서버 검증) → 확인 메일(링크 또는 6자리 코드) → 인증 전에는 세션 없음 → 데이터 접근 불가
2. 로그인 → 세션 → `auth.uid()` 로 RLS 적용 → 로그인 전 데이터가 있으면 **미리보기 → 사용자 승인 → 백업 → 이전**
3. 소셜 로그인 → 제공자 → Supabase 콜백(state/PKCE) → 앱으로 복귀. 오류·취소는 URL 의 `error` 파라미터를 읽어 한국어로 안내
4. 로그아웃: 기본은 이 기기만, 선택적으로 모든 기기. 로그아웃·만료가 기기 데이터와 미전송 대기열을 지우지 않음
5. 탈퇴: 재인증 → RPC → cascade 삭제(한 트랜잭션) → 그 계정의 기기 데이터만 정리 → 로그아웃

## 3. RLS·권한 설계에서 배운 것

- **RLS 만으로는 부족했다.** `TRUNCATE` 는 RLS 를 적용받지 않고, Supabase 기존 프로젝트는 새 표에 anon·authenticated 까지 기본 권한을 준다. 그래서 정책은 완벽해도 "로그인한 아무나 전체 표를 비울 수 있는" 상태가 가능했다.
- 공용 시퀀스(`server_seq`)의 `setval` 권한은 다른 회원의 동기화를 멈출 수 있는 **테넌트 간 영향** 경로였다.
- FK 검사는 RLS 를 무시하므로 다른 회원 행의 존재 여부를 탐지·참조할 수 있었다 → 트리거로 같은 소유자만 참조.
- 해결 원칙: 표·시퀀스·함수마다 "앱이 실제로 호출하는 것"(RPC + SELECT)을 코드에서 찾아 그만큼만 grant, 나머지는 revoke.
- 관리자는 서버 표로만 판정하고, 관리자에게도 다른 회원 데이터 열람 권한을 주지 않았다.

## 4. 테스트 전략

| 층 | 도구 | 무엇을 |
|---|---|---|
| 서버 계약 | **PGlite**(메모리 Postgres)에서 실제 마이그레이션 SQL 실행 + `set role authenticated` + JWT `sub` 흉내 | RLS·권한 표·RPC·트리거·탈퇴 cascade·원격 적용/롤백 스크립트 리허설 |
| Supabase 환경 재현 | anon/authenticated/service_role 역할 + 기본 권한(default privileges) | "정책은 맞는데 권한이 남은" 상태를 테스트로 드러냄 |
| 기기 저장소 | fake-indexeddb | 오프라인·재시도·멱등·충돌·계정 분리·기기 데이터 지우기 |
| 다기기 | 같은 PGlite 에 기기 2대(PC·iPhone 역할) | 양방향 동기화, 오프라인 생성·수정·삭제 후 복구 |
| 인증·화면 | Testing Library + 가짜 supabase-js | 호출 계약(captchaToken·redirectTo·provider ID), 오류 문구, 쿨다운, 탈퇴 흐름 |
| 운영 데이터 보호 | 테스트에서 Supabase URL·키를 빈 값으로 강제 | 테스트가 실서버에 요청하지 않음 |

결과: 182개 자동 테스트. 모의 테스트와 실제 연동 테스트를 문서에서 구분해 보고한다.

## 5. 데이터 보존 원칙

- 로그아웃·세션 만료·인증 실패는 기기 데이터와 미전송 변경을 지우지 않는다.
- 로그인 전 데이터는 자동으로 계정에 올리지 않는다(미리보기·승인·백업).
- "이 기기 데이터 지우기"는 서버에 없는 데이터가 있으면 기본 차단, 동의해야만 진행.
- 탈퇴는 서버에서 한 트랜잭션 → 부분 삭제 없음. 다른 회원 데이터는 건드리지 않음(테스트).
- IndexedDB 버전·스키마를 올리지 않고 기능을 추가(필요성 입증 전 마이그레이션 금지).
- 원격 변경은 읽기 전용 점검 → 백업 → 사전 검사 내장 스크립트 → 재점검 → 롤백 스크립트 순서.

## 6. 무료 운영 제약

Supabase Free(500MB·egress 5GB·**1주 비활동 시 일시 중지**·자동 백업 없음·기본 메일 시간당 2통), Vercel Hobby(비상업 전용·100GB). Realtime 대신 변경분 폴링으로 전송량을 줄였다. 자세히 → `03_FREE_TIER_OPERATIONS.md`.

## 7. 트러블슈팅 기록

| 문제 | 원인 | 해결 |
|---|---|---|
| 실서버에서 모든 수정이 충돌로 판정 (v0.3) | PostgREST 가 timestamptz 를 `+00:00` 로, 클라이언트는 `Z` 로 표기 | 서버 행 정규화(`normalizeServerRow`) |
| 직접 REST 쓰기로 버전 조작 가능 (v0.4.1) | 클라이언트가 version·server_seq 를 보낼 수 있음 | BEFORE 트리거로 서버가 결정 |
| 자기 기기의 변경이 사라질 수 있음 (v0.4.2) | 멱등 기록 표에 사용자가 직접 INSERT 가능 | RPC 실행 중에만 켜지는 함수 속성 + 트리거 |
| 전 회원 데이터 TRUNCATE 가능 (v0.5) | Supabase 기본 권한 + TRUNCATE 는 RLS 무시 | 0006 최소 권한 |
| 새 트리거가 기존 테스트의 오류 메시지를 바꿈 | BEFORE 트리거가 RLS WITH CHECK 보다 먼저 실행 | 소유권 변경은 RLS 에 맡기고 트리거는 참조 변경만 검사 |
| `EXECUTE … ; IF NOT FOUND` 가 항상 통과 | PL/pgSQL 의 EXECUTE 는 FOUND 를 갱신하지 않음 | `EXECUTE … INTO` 로 결과를 변수에 받음 |
| 탈퇴 화면이 정리 전에 '완료' 표시 | 상태 갱신 순서 | 기기 정리·로그아웃 후 완료 표시 (테스트가 경쟁 상태를 잡아냄) |
| 이미 가입된 이메일 안내가 계정 존재를 노출 | Supabase 가 숨긴 정보를 앱이 되살림 | 가입·메일 로그인·재설정 문구 통일 |
