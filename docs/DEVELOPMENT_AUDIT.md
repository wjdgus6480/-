# DOTDAY 개발 현황 조사 (v0.3 → v0.4 착수 시점)

- 조사일: 2026-10-02
- 경로: `C:\Users\wjdgu\Desktop\캘린더` (git 저장소 아님)
- 조사 방법: 실제 파일 열람 + 명령 실행. 파일 수정 시각이 모두 v0.3 작업 시점(17:30~17:52)이라 v0.3 보고 이후 외부 변경은 없음.

## 1. 기준선 명령 결과 (실제 실행)

| 명령 | 결과 |
|---|---|
| `npm test` | 4 files, **39 passed / 0 failed** |
| `npm run typecheck` | exit 0 (오류 없음) |
| `npm run build` | 성공. JS 306.10 kB (gzip 93.33 kB), CSS 8.64 kB |

`.env` 파일이 없음 → **Supabase 접근 정보 없음** → 실서버 관련 항목은 BLOCKED.

## 2. 구조

| 영역 | 파일 | 비고 |
|---|---|---|
| 진입/라우팅 | `src/main.tsx`, `src/App.tsx` | 해시 라우팅 `#tasks #events #projects #settings` |
| 서비스 조립 | `src/app/services.ts` | IndexedDB 열기, local_profile_id, env 있으면 Supabase client |
| 업무 모델 | `src/domain/types.ts` | Task, CalendarEvent, Project, Category (UUID, owner_id, version, deleted_at) |
| 업무 저장소 | `src/domain/repo.ts` | create/update/softDelete, seedSample |
| IndexedDB | `src/db/idb.ts` | DB `dotday` **version 1**: tasks, events, projects, categories, view_preferences, view_outbox, view_conflicts, view_backups, meta |
| 보기 설정 | `src/views/*` | fields/validate/engine/repo/sync/migrate/remote |
| UI | `src/ui/*` | TablePage, DataTable, ViewMenus, RecordEditor, SettingsPage |
| 마이그레이션 | `supabase/migrations/` | `20261002000001_base_domain.sql` → `20261002000002_view_preferences.sql` (이름 순 적용) |
| 테스트 | `tests/*` | view.core / view.sync / view.io / view.mobile + helpers(PGlite 서버) |

## 3. 기능별 상태

| 기능 | 상태 | 근거 / 문제 |
|---|---|---|
| 투두·일정·프로젝트·분류 생성/조회/수정 | IMPLEMENTED | `DomainRepository` create*/update* |
| 업무 데이터 삭제 | PARTIAL | `softDelete`만 있음. **복구 기능·휴지통 UI 없음** |
| 완료 상태 | IMPLEMENTED | status=done 시 completed_at 기록, 되돌리면 null |
| 완료 이력(여러 번 완료 기록) | NOT IMPLEMENTED | 최근 completed_at 하나만 보관 |
| 검색·필터·정렬 | IMPLEMENTED | 보기 엔진 (VIEW-005~007) |
| 새로고침 후 복원 | IMPLEMENTED | IndexedDB. 브라우저 검증 PASS (v0.3) |
| 날짜·시간대·종일 | IMPLEMENTED | 일정 편집기가 일정 시간대 기준으로 변환, 종일은 배타적 종료 |
| 계정 간 업무 데이터 분리(같은 기기) | **NOT IMPLEMENTED (결함)** | `snapshot()`이 owner_id로 걸러내지 않음 → 로그인 계정이 바뀌면 데이터가 섞임 |
| 업무 데이터 변경의 outbox 원자성 | NOT IMPLEMENTED | 업무 데이터에는 outbox가 없음 (단일 put) |
| 업무 데이터 가져오기/내보내기 | NOT IMPLEMENTED | 보기 설정만 가능 |
| 사용자 정의 테이블 보기 | IMPLEMENTED | VIEW-001~020 PASS |
| 보기 설정 오프라인 큐·멱등성·병합·충돌 | IMPLEMENTED | PGlite 기준. 실서버 미검증 |
| 보기 설정 계정 이전 | IMPLEMENTED | `migrateLocalViewsToAccount`. 실서버 미검증 |
| `SupabaseViewRemote` | PARTIAL (결함) | RPC/쿼리 빌더 호출은 있음. **서버 timestamptz(`+00:00`)를 정규화하지 않아** 실서버에서 base 비교가 항상 '원격 변경'으로 판정될 수 있음 (거짓 충돌). 테스트용 PgliteRemote만 정규화함 |
| Supabase Auth | PARTIAL | 이메일 OTP 로그인, getSession, SIGNED_IN 처리. 로그아웃은 페이지 새로고침. **실서버 미검증** |
| 인증 스텁 | 테스트 전용 | `tests/helpers.ts`: `authenticated` 역할 + `auth.uid()` 대체 |
| 업무 데이터 서버 스키마 | PARTIAL | 0001에 테이블·RLS 있음. **동기화용 server_seq, op 기록, RPC 없음** |
| 업무 데이터 클라우드 동기화 | NOT IMPLEMENTED | |
| 업무 데이터 계정 이전 | NOT IMPLEMENTED | 이전 요약에 'NOT_IMPLEMENTED'로 표시 중 |
| 반복 일정 저장 | PARTIAL | `recurrence_rule` 문자열(FREQ=DAILY/WEEKLY/MONTHLY/YEARLY)만 저장 |
| 반복 날짜 계산·예외 회차 | NOT IMPLEMENTED | 계산 코드 없음, 예외 모델 없음 |
| 실제 Supabase 적용·검증 | BLOCKED | 접근 정보 없음 |

> v0.4 작업 후 상태는 `docs/TEST_REPORT_v0.4.md` 6절 참조. 위 두 결함(snapshot owner 필터, SupabaseViewRemote 정규화)은 수정되었고 회귀 테스트(DATA-004, REM-001)가 있다.

## 4. v0.4 작업 계획 (조사 결과 반영)

1. 결함 수정: snapshot owner 필터, SupabaseViewRemote 타임스탬프 정규화 (+회귀 테스트)
2. IndexedDB v2 업그레이드(스토어 추가만, 기존 데이터 보존) — 업무 outbox / 충돌 / 백업
3. 업무 데이터 변경 + outbox 원자적 기록, 삭제 복구(휴지통), 가져오기/내보내기
4. 새 마이그레이션 `20261002000003_domain_sync.sql`: server_seq, op 기록 테이블, `apply_domain_op` RPC, 반복 예외 컬럼
5. 업무 데이터 동기화 엔진(보기 설정 동기화와 별도)
6. 업무 데이터 계정 이전(미리보기, 백업, 검증)
7. 반복 일정 계산(RFC 5545 부분집합)과 회차 예외

## 변경 이력
- 2026-10-04 (v0.4.1): 품질 검토 결과는 `docs/QUALITY_REVIEW_v0.4.md`, 실행 결과는 `docs/TEST_REPORT_v0.4.md` "v0.4.1 변경 이력" 절. 마이그레이션 0004 추가(트리거, DELETE 회수). 기준선 97 → 113 테스트.
