# DOTDAY v0.4 품질 검토

- 조사일: 2026-10-04
- 범위: `src/**`, `supabase/migrations/0001~0003`, `tests/**`, `docs/*`
- 기준선(실제 실행): `npm test` 9 files **97 passed / 0 failed**, `typecheck` exit 0, `build` exit 0
- `.env` 없음 → 실서버 항목은 모두 **BLOCKED**

## 1. 조사만으로 확인된 정상 동작 (코드 변경 불필요)

| 항목 | 근거 | 결과 |
|---|---|---|
| 같은 기기 계정 간 업무 데이터 격리 | `DomainRepository.snapshot/get`이 owner_id로 걸러냄. DATA-004, MIG-003 | PASS |
| 로그아웃 시 로컬 데이터 보존 | SIGNED_OUT은 owner만 null로 바꾸고 삭제하지 않음. 이전 계정의 미전송 op는 owner가 달라 전송되지 않고 같은 계정으로 다시 로그인하면 전송 | PASS (코드 확인) |
| 업무 데이터+outbox 원자성 | `commit()` 단일 트랜잭션, 예외 시 abort. DATA-003 | PASS |
| 서버 반영 전 outbox 유지 | `ack()`에서만 삭제, 오류 시 pending 복귀. SYNC-002/003 | PASS |
| 멱등성 | `domain_ops`/`view_preference_ops` op_id. SYNC-003, VIEW-012 | PASS |
| RPC 보안 기본 | 두 RPC 모두 `security invoker` + `set search_path = public`, `auth.uid()` null이면 거부, owner_id·version·server_seq·id는 patch 허용 목록에 없음, 클라이언트 버전은 비교에만 사용 | PASS (PGlite) |
| RLS | 4개 업무 테이블과 view_preferences 모두 `owner_id = auth.uid()` using/with check | PASS (PGlite) |
| 내보내기 범위 | `exportData`는 현재 owner의 snapshot만 사용 | PASS |

## 2. 문제 목록

| ID | 심각도 | 문제 | 재현 | 수정 대상 |
|---|---|---|---|---|
| Q-01 | **P0** | 0001이 `authenticated`에 업무 테이블 직접 UPDATE/DELETE를 허용함. 직접 UPDATE는 version·server_seq를 올리지 않아 다른 기기가 변경을 받지 못하고, 직접 DELETE는 tombstone 없이 행을 지워 다른 기기에 남음. view_preferences도 같음 | PostgREST로 `PATCH /tasks?id=eq.X` 실행 → 다른 기기 pull에 나타나지 않음 | 신규 `0004_write_guards.sql` |
| Q-02 | **P0** | 계정 이전 중(서버 업로드와 로컬 교체 사이)에 사용자가 같은 레코드를 수정하면 로컬 교체가 서버 값으로 덮어써 수정이 사라짐. 이전을 동시에 두 번 실행하는 것도 막지 않음 | 업로드 직후 로컬 수정 → 교체 후 수정 소실 | `src/domain/migrate.ts` |
| Q-03 | P1 | 인증 만료(401) 오류도 30초마다 무한 재시도하고 상태는 '오류'로만 표시. 백오프 없음 | 세션 만료 상태에서 동기화 반복 | `src/lib/syncPolicy.ts`(신규), 두 sync 엔진, UI |
| Q-04 | P1 | 반복 일정 전체의 시간·규칙을 바꾸면 회차별 수정·취소가 모두 삭제됨 | 회차 수정 후 시작 시각 변경 | `src/domain/recurrence.ts`, `repo.ts`, `RecordEditor.tsx` |
| Q-05 | P1 | 두 기기가 같은 작업을 각각 완료하면 completed_at만 달라 충돌로 표시됨 (불필요한 사용자 개입) | 양쪽 완료 후 동기화 | `src/domain/sync.ts` |
| Q-06 | P1 | 삭제된 반복 일정을 복구해도 함께 삭제된 회차 예외는 삭제 상태로 남음 | 회차 취소 → 일정 삭제 → 복구 → 취소했던 회차가 다시 보임 | `src/domain/repo.ts` |
| Q-07 | P2 | '이 회차와 이후 모두 수정' 미구현 | — | `repo.ts`, `RecordEditor.tsx` |
| Q-08 | P2 | 모달이 닫힐 때 포커스를 원래 위치로 돌려주지 않고, Tab이 모달 밖으로 나감 | 키보드로 패널 열고 닫기 | `src/ui/ViewMenus.tsx` |
| Q-09 | P2 | 완료 이력(여러 번 완료 기록) 없음 | — | 설계만 (5절) |
| Q-10 | P3 | `domain_ops`에 클라이언트가 직접 INSERT 가능(security invoker 때문). 자기 op_id 결과만 조작 가능해 자기 데이터 동기화만 방해 | — | 문서화 (위험 수용) |

## 3. 선행 조건·위험
- Q-01 마이그레이션은 기존 0001~0003을 수정하지 않는 신규 파일. 트리거만 추가하고 DELETE 권한을 회수하므로 앱 동작(RPC만 사용)에는 영향 없음. 롤백: 트리거 drop, `grant delete` 재부여.
- 실서버에서 PostgREST가 트리거를 우회하지는 않지만 실제 적용은 BLOCKED.

## 4. 검증 방법
- 모든 수정마다 재현 테스트를 먼저 추가하고(수정 전 실패 확인), 수정 후 전체 테스트·typecheck·build를 실행.
- 결과는 `docs/TEST_REPORT_v0.4.md` 변경 이력 절에 기록.

## 5. 완료 이력 설계 (Q-09, 미구현)
- `completed_at`은 **현재 상태**로 유지(형식 변경 없음).
- 별도 엔티티 `task_completions(id uuid, owner_id, task_id, occurrence_start null, completed_at, undone_at null, device, created_at)`, 추가만 하고 수정하지 않음(append-only) → 동시 완료는 두 행으로 남아 충돌이 생기지 않음.
- 반복 일정·작업 회차는 `occurrence_start`로 구분.
- 기존 데이터 전환: `status=done`이고 completed_at이 있는 작업마다 이력 1행을 생성(멱등 ID = hash(task_id, completed_at)).
- 동기화: append-only이므로 기존 엔진에 엔티티 추가로 충분(병합 대상 필드 없음).

## 6. Realtime 평가
현재 구조(변경 후 1.5초, 30초 주기, 온라인 복귀 시)는 개인용으로 충분하다. Realtime은 무료 티어의 동시 연결 한도, RLS 필터 설정, 재연결 처리가 추가로 필요하다. 실서버 동기화를 검증한 뒤 "변경 알림 → pull 트리거" 용도로만 도입하는 것을 권장한다(본 작업 범위 외).

## 7. 수정 결과 (2026-10-04)

| ID | 상태 | 자동화 테스트 | 실제 브라우저 | 실서버 |
|---|---|---|---|---|
| Q-01 직접 쓰기 보호 | 수정 (`0004_write_guards.sql`) | PASS (SEC-001 4건, 수정 전 4건 모두 FAIL 확인) | 해당 없음 | BLOCKED |
| Q-02 이전 중 수정·중복 실행 | 수정 | PASS (MIG-004 2건, 수정 전 FAIL 확인) | NOT TESTED (클라우드 없음) | BLOCKED |
| Q-03 재시도 정책·인증 만료 | 수정 (`lib/syncPolicy.ts`) | PASS (SYNC-009) | 상태 표시 문구만 확인 | BLOCKED |
| Q-04 전체 변경 시 예외 보존 | 수정 | PASS (REC-005 2건 + 기존 테스트 기대값 변경, 아래 참고) | PASS | — |
| Q-05 동시 완료 | 수정 | PASS (수정 전 FAIL 확인) | NOT TESTED | BLOCKED |
| Q-06 반복 일정 복구 | 수정 + 참조 경고 | PASS | NOT TESTED | — |
| Q-07 이 회차와 이후 | 구현 | PASS (브라우저에서 발견한 결함 회귀 테스트 포함) | PASS | — |
| Q-08 모달 포커스 | 수정 | PASS (A11Y-001) | PASS (Tab 순환, Esc 후 포커스 복귀) | — |
| Q-09 완료 이력 | NOT IMPLEMENTED (설계만, 5절) | — | — | — |
| Q-10 domain_ops 직접 INSERT | 위험 수용 (문서화) | — | — | — |

추가로 발견해 고친 것:
- **패널 포커스 탈취**: 패널 effect가 매 렌더마다 다시 실행되어, 부모가 다시 그려질 때 입력 중이던 포커스를 빼앗았다(A11Y-001).
- **'이 회차와 이후'의 회차 수**: 폼이 원래 `COUNT`를 그대로 보내 새 반복 횟수가 늘어났다. 브라우저 검증에서 발견했다.
- **빈 화면**: 렌더 오류 하나에 앱 전체가 빈 화면이 됐다 → `ErrorBoundary`를 추가했다(데이터는 영향 없음 안내).

기존 테스트 기대값을 바꾼 2건 (요구사항에 따른 의도된 동작 변경):
1. SYNC-006: 다른 사용자의 직접 DELETE를 "0건"에서 "권한 거부"로 강화했다(0004에서 DELETE 회수).
2. REC-005: 전체 시간 변경 시 회차 예외를 "삭제"에서 "같은 날짜로 옮겨 보존"으로 바꿨다(Q-04, PHASE 4-2 요구).
