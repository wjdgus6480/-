# DOTDAY v0.4 개발·검증 보고서

- 작성일: 2026-10-02
- 기준선: v0.3 (테스트 39개, typecheck, build) → `docs/DEVELOPMENT_AUDIT.md`
- v0.3 보고서는 `docs/TEST_REPORT.md`에 그대로 보존

## 1. 실제 실행한 명령과 결과

| 명령 | 결과 |
|---|---|
| `npm test` (`vitest run`) | **9 files, 97 passed / 0 failed**, exit 0 (v0.3의 39개 포함) |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0. JS 354.32 kB (gzip 106.62 kB), CSS 9.63 kB |
| 안정성 확인 | 전체 테스트 4회 연속 실행에서 97/97 |

파일별 통과 수: view.core 23, view.sync 11, view.io 4, view.mobile 1 (v0.3 기준선 39) / data.local 15, data.sync 17, data.migrate 5, recurrence 17, remote.supabase 4 (신규 58).

## 2. 검증 환경 구분

| 구분 | 무엇으로 | 한계 |
|---|---|---|
| 자동화 테스트 | Vitest + fake-indexeddb + **PGlite에서 `supabase/migrations/*.sql` 3개를 그대로 실행** (`authenticated` 역할, `auth.uid()` 대체로 RLS 실제 적용) | 실제 Supabase(PostgREST, GoTrue, 네트워크)는 아님 |
| Supabase 어댑터 | supabase-js 호출 모양을 흉내 낸 스텁 (REM-001) | 실제 HTTP 응답 아님 |
| 실제 브라우저 | Claude 내장 브라우저 + Vite dev 서버 (localhost) | 클라우드 미연결(로컬 전용 모드) |
| 실제 Supabase | — | **BLOCKED**: 프로젝트 URL·키 없음 (`.env` 없음) |

## 3. 자동화 테스트 (PASS / FAIL)

### 기존 VIEW-001~020 — 모두 PASS (변경 없음, 회귀 없음)

### 로컬 업무 데이터
| ID | 결과 | 내용 |
|---|---|---|
| DATA-001 | PASS | 4종 CRUD, 새 저장소 인스턴스(재실행)에서 복원, 삭제→휴지통→복구, 변경 없는 수정은 버전·수정일·큐 불변, 잘못된 값(빈 제목, 2/30, 상태, 종료<시작, 시간대, 반복 규칙) 저장 거부 |
| DATA-002 | PASS | 완료 시 completed_at 기록, 되돌리면 null, 다시 완료하면 새 시각 |
| DATA-003 | PASS | 레코드+outbox 원자성(큐 쓰기 실패 시 생성·수정 모두 롤백), 같은 레코드 op 병합, 반복 일정 삭제 시 회차 예외도 같은 트랜잭션 |
| DATA-004 | PASS | 같은 기기에서 계정별 데이터 분리 (v0.3 결함 수정) |
| DATA-005 | PASS | IndexedDB v1→v2 업그레이드 시 업무·보기·meta 보존, 옛 일정은 기본값으로 읽고 수정 가능, 다운그레이드 열기 거부 |
| DATA-006 | PASS | 내보내기→다른 기기 가져오기(ID·참조 유지), 재가져오기 시 '동일'로 건너뜀, 잘못된 파일 6종은 전체 거부하고 데이터·백업 불변, 파일의 owner_id 무시, 같은 ID 다른 내용은 덮어쓰지 않음, 가져오기 전 백업으로 복구 |
| DATA-007 | PASS | 보기 변경·초기화·복제·삭제 후 업무 스토어와 **domain_outbox 불변**, 일정 테이블에 회차 예외 행 미표시 |

### 업무 데이터 동기화 (PGlite 서버)
| ID | 결과 | 내용 |
|---|---|---|
| SYNC-001 | PASS | PC→모바일 4종 전송, 모바일 완료→PC 반영, **재동기화 시 pushed 0·conflicts 0 (거짓 충돌 없음)**, 회차 예외 동기화 |
| SYNC-002 | PASS | 오프라인 편집이 로컬에 저장되고 큐에 남음 → 재접속 시 전송 → 다른 기기 반영 |
| SYNC-003 | PASS | 응답 유실 후 같은 op_id 재전송: 서버 version 1회 증가, op 기록 1건. 생성 재전송도 중복 없음 |
| SYNC-004 | PASS | 독립 필드 자동 병합, 같은 필드 충돌 기록(base/local/remote)과 해결 전 서버 불변, 시작·종료 시각은 한 단위로 비교 |
| SYNC-005 | PASS | 삭제 vs 수정 충돌(양방향)과 유지/삭제 선택, 양쪽 삭제는 충돌 없이 tombstone 동기화 |
| SYNC-006 | PASS | B는 A의 행 SELECT/UPDATE/DELETE 0건, RPC not_found/rejected, A의 프로젝트 참조 불가, owner_id·version·server_seq·id 변경 거부, 직접 UPDATE로 소유권 이전 시 RLS 오류, 허용 외 엔티티·잘못된 값·반복 규칙 거부, 미인증 거부, 서버 허용 필드 = 클라이언트 |
| SYNC-007 | PASS | 참조 순서(프로젝트 먼저), **회차 예외가 큐에서 원본보다 앞서도 한 번에 전송** (간헐 실패 회귀), 동기화 실패 중 로컬 저장 계속 |
| SYNC-008 | PASS | 업무 동기화와 보기 설정 동기화가 서로의 데이터를 보내지 않음 |

### 계정 연결·이전
| ID | 결과 | 내용 |
|---|---|---|
| MIG-001 | PASS | 미리보기(종류별 건수, 참조된 삭제 항목 1), 로그인 전에는 전송 안 함, 백업 생성, 7건 이전 후 서버 재조회로 7/7 검증, 이후 재전송 없음, 보기 설정 이전은 별도 결과 |
| MIG-002 | PASS | 중간 연결 끊김 시 로컬 원본 불변 → 재시도 시 같은 op_id로 이어서 완료, 서버 건수 정확(중복 없음), 백업 1개만. 처음부터 오프라인이면 아무 변경 없음 |
| MIG-003 | PASS | 같은 ID·같은 내용 = same(6), 같은 ID·다른 내용 = server_kept(1, 로컬 값은 백업), A로 이전 후 B 로그인 시 A 데이터 비노출·B로 업로드 안 됨 |

### 반복 일정
| ID | 결과 | 내용 |
|---|---|---|
| REC-001 | PASS | 규칙 저장 형식: 파싱·직렬화 왕복, 잘못된 규칙 10종 거부, 서버 CHECK 정규식과 일치 |
| REC-002 | PASS | 매일 COUNT, 2주마다 월·수 UNTIL(포함), 매월 31일(없는 달 건너뜀), 매년 2/29(윤년만), 종료 없는 반복은 범위 끝까지 |
| REC-003 | PASS | 뉴욕 서머타임 시작: 벽시계 09:00 유지, UTC 14:00→13:00. 서머타임 종료를 넘는 23:30~00:30 길이 유지. 종일 반복 |
| REC-004 | PASS | 과거·미래 범위 조회, 변경 회차, 취소 회차, 다른 날로 옮긴 회차(원래 날짜에는 안 나옴), 삭제된 반복 |
| REC-005 | PASS | 단일 회차 변경·취소·되돌리기, 같은 회차 재수정 시 같은 행 갱신, 전체 수정(제목: 예외 유지 / 시간: 예외 초기화), 결정적 예외 ID, 비반복 일정 거부 |

### Supabase 어댑터
| ID | 결과 | 내용 |
|---|---|---|
| REM-001 | PASS | `+00:00` 시각을 `Z`로 정규화 (v0.3 결함 수정), RPC 이름·인자, 쿼리 빌더 사용, 네트워크·인증 오류 분류 |

## 4. 실제 브라우저 테스트 (PASS / FAIL / NOT TESTED)

| 항목 | 결과 | 근거 |
|---|---|---|
| v0.3 DB(v1)를 v0.4가 열 때 데이터 보존 | PASS | 실제 브라우저에 남아 있던 v0.3 데이터가 업그레이드 후에도 작업 5건(전부 version 1), 일정 3, 프로젝트 2, 분류 2, 보기 3으로 그대로임. 새 스토어 3개 추가 |
| 반복 일정 회차 표시 | PASS | 옛 `FREQ=WEEKLY` 일정이 10/03·10/10·10/17·10/24·10/31로 전개, 테이블은 1행 유지 |
| 이 회차만 수정 | PASS | 10/10 제목 변경 → 그 회차만 바뀌고 "이 회차 변경됨" 표시 |
| 회차 취소 | PASS | 10/17 취소 → 목록에서 사라짐 |
| 반복 일정 생성 (매주 월·수, 4회) | PASS | 폼으로 생성 → 10/05·10/07·10/12·10/14, 저장된 규칙 `FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4` |
| 새로고침 후 유지 | PASS | 위 변경 모두 유지, 예외 행 2개 + 새 일정이 outbox에 대기 |
| 삭제 → 휴지통 → 복구 | PASS | 장보기 삭제(4/4건) → 휴지통에 표시 → 복구(5/5건) |
| 잘못된 업무 데이터 가져오기 | PASS | 오류 안내, 데이터 동일, 백업 미생성 |
| 모바일(375px) 캘린더·회차 편집 | PASS | 가로 넘침 없음, 편집기는 하단 시트, 수정 범위 선택 표시 |
| 콘솔 오류 | PASS | 새로고침 후 오류 0건 |
| 로그인·계정 이전 대화상자 | NOT TESTED | Supabase 미설정이라 화면에 나타나지 않음 |
| PC·모바일 실제 동기화 | NOT TESTED | 실서버 없음 (자동화로만 검증) |

브라우저 검증에서 발견해 고친 것:
- 회차 목록 버튼에 접근 가능한 이름이 없었다 → 날짜·시간·제목으로 aria-label 추가
- 칩 형태 라디오·체크박스가 `display:none`이라 키보드로 접근할 수 없었다 → 시각적으로만 숨기고 포커스 테두리 표시

## 5. 실제 Supabase 테스트 (PASS / FAIL / BLOCKED)

| 항목 | 결과 |
|---|---|
| 마이그레이션 0001~0003 실서버 적용 | BLOCKED |
| Auth(매직 링크) 로그인·로그아웃 | BLOCKED |
| RLS·RPC 실서버 동작 | BLOCKED (PGlite에서는 PASS) |
| 미인증 요청 거부 | BLOCKED (PGlite에서는 PASS) |
| 네트워크 오류·응답 유실 시 멱등성 | BLOCKED (PGlite에서는 PASS) |
| 두 실제 기기 간 동기화 | BLOCKED |

## 6. 구현 상태

| 기능 | 상태 |
|---|---|
| 로컬 업무 CRUD, 완료 상태, 검색·필터·정렬, 재실행 복원 | IMPLEMENTED |
| 업무 데이터 + outbox 원자적 기록 | IMPLEMENTED |
| 삭제(tombstone)·휴지통·복구(30일) | IMPLEMENTED |
| 업무 데이터 가져오기·내보내기·백업 복구 | IMPLEMENTED |
| 계정별 로컬 데이터 분리 | IMPLEMENTED |
| 업무 데이터 동기화(멱등·버전·병합 단위·삭제 충돌·충돌 UI) | IMPLEMENTED (실서버 미검증) |
| 계정 연결 이전(미리보기·확인·백업·검증·별도 보고) | IMPLEMENTED (실서버 미검증) |
| 반복 일정 계산·회차 예외·서머타임 | IMPLEMENTED |
| 완료 이력(여러 번 완료한 기록 목록) | NOT IMPLEMENTED: 최근 completed_at만 보관 |
| 실시간 반영(Realtime) | NOT IMPLEMENTED: 변경 후 1.5초 / 30초 주기 / 온라인 복귀 시 동기화 |
| 반복 일정 '이 회차와 이후 모두' 수정 | NOT IMPLEMENTED: 이 회차만 / 전체만 |
| 서버 측 휴지통 영구 삭제(30일 후) | NOT IMPLEMENTED: 서버 행은 soft-delete로 남음 |

## 7. 미해결 문제·위험

1. **실서버 미검증**: 정책·함수는 PGlite에서 실행했지만, Supabase의 PostgREST 직렬화·권한(`anon`/`authenticated` 기본 grant)·JWT는 확인하지 못했다.
   - 재현: `.env` 설정 → 마이그레이션 적용 → 두 브라우저 프로필로 같은 계정에 로그인 → 한쪽 수정 → 다른 쪽 30초 내 반영 확인
2. **직접 테이블 쓰기 허용**: 0001에서 `authenticated`에 tasks 등의 insert/update/delete를 허용했기 때문에, 클라이언트가 RPC를 거치지 않고 자기 행을 직접 고칠 수 있다. 소유권은 RLS가 막지만 version·server_seq는 증가하지 않아 다른 기기가 그 변경을 받지 못할 수 있다. 앱 코드는 RPC만 사용한다.
   - 개선안: 새 마이그레이션에서 직접 쓰기 grant를 회수하고 RPC를 `security definer` + 명시적 owner 검사로 전환하거나, update 트리거로 version·server_seq를 갱신
3. **반복 규칙·시간 변경 시 회차 예외 삭제**: 전체 반복의 시간이나 규칙을 바꾸면 회차별 변경·취소가 삭제된다(확인 대화상자 표시, 휴지통에서는 개별 복구가 안 되고 백업으로만 복구 가능).
4. **가져오기 오류 표시**: 레코드마다 첫 번째 오류만 보고한다.
5. **같은 계정 두 기기에서 동시에 첫 기본 보기 생성**: 보기 설정에 '기본 보기'가 2개 생길 수 있다(v0.3부터 알려진 사항, 가장 최근 것을 기본으로 사용).
6. **여러 탭**: v0.3 탭을 연 채 v0.4 탭을 열면 IndexedDB 업그레이드가 그 탭을 닫을 때까지 대기한다(데이터 손상 없음).

## 8. 수정·추가한 파일

새 마이그레이션: `supabase/migrations/20261002000003_domain_sync.sql` (기존 0001·0002는 수정하지 않음)

| 구분 | 파일 |
|---|---|
| 신규 | `src/domain/recurrence.ts`, `src/domain/sync.ts`, `src/domain/remote.ts`, `src/domain/migrate.ts`, `src/lib/serverRow.ts`, `src/ui/OccurrenceList.tsx` |
| 신규 테스트 | `tests/data.local.test.ts`, `tests/data.sync.test.ts`, `tests/data.migrate.test.ts`, `tests/recurrence.test.ts`, `tests/remote.supabase.test.ts` |
| 수정 | `src/domain/types.ts`, `src/domain/repo.ts`, `src/db/idb.ts`(v2), `src/views/remote.ts`(정규화), `src/views/fields.ts`(예외 행 제외), `src/app/services.ts`, `src/app/context.tsx`, `src/App.tsx`(이전 미리보기·확인), `src/ui/RecordEditor.tsx`(반복 편집·회차 범위), `src/ui/TablePage.tsx`, `src/ui/SettingsPage.tsx`(업무 동기화·충돌·휴지통·데이터 입출력), `src/styles.css`, `tests/helpers.ts`, `tests/view.mobile.test.tsx`(정리), `package.json`(0.4.0, @types/node) |
| 문서 | `docs/DEVELOPMENT_AUDIT.md`, `docs/TEST_REPORT_v0.4.md`, `README.md` |

---

# v0.4.1 변경 이력 (2026-10-04, 품질 개선·안정화)

위 v0.4 내용은 당시 기록 그대로 보존한다. 상세 문제 분석은 `docs/QUALITY_REVIEW_v0.4.md`.

## 실행 명령과 실제 결과

| 명령 | 작업 전 (기준선) | 작업 후 |
|---|---|---|
| `npm test` | 9 files, 97 passed / 0 failed | **11 files, 113 passed / 0 failed** |
| `npm run typecheck` | exit 0 | exit 0 |
| `npm run build` | exit 0 | exit 0 (JS 362.23 kB, gzip 109.06 kB) |

파일별: view.core 23, view.sync 11, view.io 4, view.mobile 1, data.local 16, data.sync 20, data.migrate 7, recurrence 21, remote.supabase 4, security.write-guards 4, a11y 2.
기준선 97개는 모두 유지된다. 그중 2개는 의도된 동작 변경으로 기대값을 바꿨다(QUALITY_REVIEW 7절).

## 새 마이그레이션
`supabase/migrations/20261004000004_write_guards.sql` (0001~0003은 수정하지 않음)
- 업무 4개 테이블과 view_preferences에 BEFORE INSERT/UPDATE 트리거를 둬서, 서버가 version·server_seq·updated_at을 결정하고 id 변경을 거부한다.
- authenticated·anon의 직접 DELETE를 회수한다(삭제는 tombstone으로만).
- 적용 순서: 0001 → 0002 → 0003 → 0004. 롤백: 트리거와 함수를 drop하고 delete 권한을 재부여한다(데이터 변경 없음).

## 수정 파일
| 파일 | 이유 |
|---|---|
| `src/domain/migrate.ts` | Q-02 이전 중 수정 보존, 중복 실행 방지 |
| `src/lib/syncPolicy.ts` (신규) | Q-03 오류 분류·백오프·상태 라벨 (두 엔진 공용) |
| `src/domain/sync.ts`, `src/views/sync.ts` | Q-03 autoSync/백오프/인증 만료, Q-05 동시 완료 |
| `src/domain/recurrence.ts` | Q-04 `remapExceptions` |
| `src/domain/repo.ts` | Q-04 예외 재배치·미리보기, Q-06 복구, Q-07 `updateFollowing`/`followingRule` |
| `src/ui/RecordEditor.tsx` | 수정 범위 3가지, 삭제 영향 미리보기 확인 |
| `src/ui/ViewMenus.tsx` | Q-08 포커스 관리, 포커스 탈취 수정 |
| `src/ui/SettingsPage.tsx`, `src/App.tsx` | 동기화 상태(인증 만료·재시도 시각·진단 정보 접기), 복구 경고, 토큰 갱신 시 재시도 |
| `src/ui/ErrorBoundary.tsx` (신규), `src/main.tsx` | 렌더 오류 시 빈 화면 방지 |
| `src/styles.css` | 인증 만료 배지, 모바일 dvh·safe-area |
| `tests/*` | SEC-001, MIG-004, SYNC-009, Q-05, REC Q-04/06/07, A11Y, 가져오기 저장 실패 |

## 보안 검증 결과
| 항목 | PGlite(실제 SQL) | 실서버 |
|---|---|---|
| RLS 4개 테이블 + view_preferences 소유권 | PASS | BLOCKED |
| RPC `security invoker` + `search_path` 고정 + `auth.uid()` 확인 | PASS (코드 확인 + 미인증 거부 테스트) | BLOCKED |
| owner_id·version·server_seq·id 조작 거부 (RPC) | PASS | BLOCKED |
| 직접 UPDATE 시 버전 강제 / 직접 DELETE 거부 | PASS (SEC-001) | BLOCKED |
| 다른 사용자 데이터 참조 거부 | PASS | BLOCKED |
| `service_role` 키 미포함 | PASS (`.env.example`에는 anon 키만, 코드 검색 결과 없음) | — |

## 실제 브라우저 검증 (2026-10-04)
| 항목 | 결과 |
|---|---|
| '이 회차와 이후 모두' (10/12부터 20:00) → 10/05·07은 19:00 유지, 10/12·14는 20:00, 남은 2회 표시 | PASS |
| 수정 범위 3가지 표시와 설명 | PASS |
| 패널 Tab 순환(마지막 → 닫기), Esc 후 연 버튼으로 포커스 복귀 | PASS |
| 렌더 오류 시 안내 화면(ErrorBoundary) | PASS (개발 중 실제 발생한 오류로 확인) |
| 모바일 375px 일정 편집: 가로 넘침 없음, 시트 스크롤로 저장 버튼 도달 | PASS |
| 모바일 키보드가 열린 상태 | NOT TESTED (에뮬레이션 불가) |
| 세션 만료 안내 화면 | NOT TESTED (Supabase 없음, 엔진 상태는 자동화로 PASS) |
| 콘솔 오류 (새 탭) | PASS (0건) |

## 실서버 검증
로그인·로그아웃, 두 계정 격리, 두 기기 동기화, 직접 API 권한, 동시 수정, 네트워크 복구, 마이그레이션 적용 모두 **BLOCKED** (Supabase 접근 정보 없음).

## 배포 가능 여부
- **로컬 전용(클라우드 없이) 배포: 가능.** 근거: 자동화 113/113, typecheck·build 통과, 브라우저 핵심 흐름 PASS, 데이터 보존(v1→v2 업그레이드, 휴지통, 백업) 검증.
- **클라우드 동기화 배포: 보류.** 근거: 실서버 검증이 전부 BLOCKED. 0001~0004를 적용한 Supabase에서 위 실서버 항목을 확인한 뒤 판단해야 한다.

## 남은 위험·미구현
1. 실서버 미검증 (최우선)
2. 완료 이력(Q-09) 미구현: 설계만 있음
3. `domain_ops` 직접 INSERT 가능(Q-10): 자기 동기화만 방해할 수 있어 위험을 수용
4. 서버 tombstone 영구 삭제 없음: 서버 행은 soft-delete로 남음
5. 같은 계정 두 기기에서 동시에 첫 기본 보기를 만들면 2개가 될 수 있음(v0.3부터 알려진 사항)

## 다음 단계 우선순위
1. Supabase 무료 프로젝트에 0001~0004를 적용하고 실서버 항목을 검증
2. 완료 이력(task_completions) 구현
3. 서버 tombstone 정리 작업(예약 함수)
4. Realtime은 실서버 검증 뒤 "변경 알림 → pull" 용도로만 검토
