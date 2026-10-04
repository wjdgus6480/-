# DOTDAY v0.4

투두, 캘린더 일정, 프로젝트를 원하는 형태의 테이블로 보는 개인용 앱입니다. 무료 스택으로 만들었습니다.

- 프론트엔드: Vite + React + TypeScript (정적 배포 가능: Cloudflare Pages, Netlify, Vercel 무료)
- 로컬 저장: IndexedDB. 로그인 없이 바로 쓸 수 있고 오프라인에서도 동작합니다.
- 클라우드(선택): Supabase 무료 티어(Postgres + RLS + 이메일 매직링크 로그인)

## 실행

```bash
npm install
```

```bash
npm run dev
```

http://localhost:5173 을 연 뒤 설정 화면에서 "샘플 데이터 추가"를 누르면 바로 써 볼 수 있습니다.

```bash
npm test
```

## 클라우드 동기화 켜기 (선택, 무료)

1. supabase.com에서 무료 프로젝트를 만듭니다.
2. SQL Editor에서 `supabase/migrations/` 파일을 이름 순서대로 실행합니다(또는 `supabase db push`).
3. `.env.example`을 `.env`로 복사하고 URL과 anon key를 넣습니다.
4. Authentication → URL Configuration에 앱 주소를 추가합니다(매직링크 리디렉션용).

> v0.4부터 **업무 데이터(투두·일정·프로젝트·분류)**와 **보기 설정**이 각각 따로 동기화됩니다. 로그인하면 로그인 전 데이터의 종류와 건수를 먼저 보여 주고, 확인을 받은 뒤 백업하고 옮깁니다.
> 브라우저에는 anon(publishable) 키만 넣습니다. `service_role` 키는 절대 `.env`의 `VITE_` 변수에 넣지 마세요(번들에 포함됩니다).
> 실제 Supabase 연결은 아직 검증되지 않았습니다(자동화 테스트는 PGlite로 같은 SQL을 실행). `docs/TEST_REPORT_v0.4.md` 참고.

## 구조

```
src/domain/      업무 데이터 (보기 설정과 분리)
  repo.ts        로컬 우선 저장소: CRUD + outbox 원자 기록, 휴지통, 가져오기/내보내기, 회차 수정
  recurrence.ts  반복 규칙(RFC 5545 부분집합)·회차 계산·서머타임
  sync.ts        DomainSyncEngine: 멱등 전송, 병합 단위 3-way 병합, 삭제 충돌
  migrate.ts     계정 연결 시 로그인 전 데이터 이전(미리보기·백업·검증)
  remote.ts      apply_domain_op RPC 계약 + Supabase 구현
src/views/
  fields.ts      허용 필드 레지스트리 (안정 키 ↔ 표시 이름)
  validate.ts    validateViewConfig, 기본 설정
  engine.ts      applySortAndFilter (순수 함수, 원본 불변)
  repo.ts        ViewRepository: list/get/create/update/duplicate/setDefault/delete/restore/reset, 가져오기·내보내기·백업
  sync.ts        ViewSyncEngine: 오프라인 큐, 멱등 전송, 3-way 병합, 충돌 해결
  migrate.ts     계정 연결 시 로컬 보기 설정 이전
  remote.ts      서버 계약 + Supabase 구현
src/ui/          테이블, 컬럼/정렬/필터 메뉴, 설정 화면
supabase/migrations/  0001 기본 도메인, 0002 view_preferences, 0003 업무 동기화, 0004 직접 쓰기 보호 (이름 순서대로 적용)
docs/QUALITY_REVIEW_v0.4.md  품질 검토 (문제·심각도·수정 결과)
tests/           VIEW / DATA / SYNC / MIG / REC / REM 자동화 테스트 97개 (PGlite로 실제 SQL·RLS 실행)
docs/DEVELOPMENT_AUDIT.md  v0.4 착수 시점 현황 조사
docs/TEST_REPORT.md        v0.3 검증 결과
docs/TEST_REPORT_v0.4.md   v0.4 검증 결과·위험·수정 파일
```

## 설계 결정

- **식별 컬럼(제목·이름)은 숨길 수 없습니다.** 순서와 너비는 바꿀 수 있습니다. 행 열기/완료 체크는 컬럼 설정과 관계없는 맨 앞 고정 칸에 있습니다.
- **모바일은 가로 스크롤 방식입니다.** 사용자가 정한 표시/숨김을 반응형 레이아웃이 바꾸지 않습니다. 모바일에서는 첫 번째 고정 컬럼만 고정되고, 순서는 컬럼 메뉴의 ▲▼로 바꿉니다.
- **보기 설정은 자동 저장됩니다.** "다른 이름으로 저장"은 복제로 합니다.
- **버전**: `version`은 서버가 확인한 버전입니다(0 = 아직 서버에 없음). 충돌은 최상위 필드(이름, 컬럼, 정렬, 필터, 레이아웃, 기본 여부, 삭제 상태) 단위로 판단합니다.
- **기본 보기가 여러 개인 경우**(동기화 경합)에는 가장 최근에 수정된 것을 기본으로 봅니다.
- **삭제**는 소프트 삭제이며 30일 동안 설정 화면에서 복구할 수 있습니다. 서버 행은 soft-delete 상태로 남습니다.
