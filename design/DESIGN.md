# DOTDAY 디자인 기준서

Stitch(stitch.withgoogle.com)로 새 디자인을 만들고 코드에 옮길 때의 기준이다.
Stitch 결과물은 **시안**으로만 쓰고, 실제 반영은 `src/styles.css` 의 토큰·클래스를 바꾸는 방식으로 한다.
(Stitch 가 내보내는 Tailwind HTML 을 그대로 붙이지 않는다. 이 앱은 Tailwind 를 쓰지 않고 React 컴포넌트가 아래 클래스 이름에 의존한다.)

## 1. 반영 순서

1. Stitch 에서 `STITCH_PROMPTS.md` 의 0번(공통 스타일) → 1~7번 화면 순서로 생성
2. 결과 중 마음에 드는 화면을 골라 **스크린샷 + Export 코드(HTML/CSS)** 를 전달
3. 색·모서리·그림자·글꼴 → `:root` 토큰 값만 교체 (컴포넌트 수정 없음)
4. 레이아웃·간격 → 해당 클래스 CSS 수정
5. 구조가 바뀌는 요소(아이콘, 헤더 배치 등)만 TSX 수정 → `npm run typecheck` · `npm test`

### Stitch MCP 연결

스크린샷·코드를 손으로 옮기는 대신 Claude Code 가 Stitch MCP 로 직접 화면 이미지·코드를 가져온다.

```bash
# API 키: stitch.withgoogle.com → 프로필 → Stitch settings → API key → Create key
claude mcp add stitch --transport http https://stitch.googleapis.com/mcp --header "X-Goog-Api-Key: <API 키>" -s user
```

`-s user` 라서 키는 `~/.claude.json` 에만 저장되고 이 저장소에는 들어가지 않는다. 키를 `.mcp.json` 이나 문서에 적지 않는다.
등록 후 Claude Code 를 다시 시작하거나 `/mcp` 로 연결을 확인한다.

- 프로젝트: **DOTDAY Pixel Calendar PWA** — ID `1519152837107330025`
- 디자인 시스템 화면: `140fe06f9a8c4b08aa298129ad74781e` (DOTDAY Design System Specification)
- 화면 14개 (2026-10-07 기준 생성 중):
  `08cb93fc7e0740469d6cba345e4e6559` `e5eb2fc93e40434eaaa6726401162830` `5f273c2b3dfb4c218747a75fd46c7e52`
  `0dd853680b6f4abd81307ab68bdc7b71` `d5661458b5af4cc3b7399508ec9f0c53` `feabb7e89503489787f47941795ffea1`
  `4b1473ffb63e4231b7eabb2277ef552a` `ffdf9c7a538940a3a1bf2dd74efc88ee` `2c5510d978b946d39254359ee847ccc8`
  `9251b0765557477bb32608c65e5aea70` `5bba1e9cf22a445ba649937269dd6dbf` `0113e8e93c3b422495f126432e7a2803`
  `1ba3a3090ea441fb84659d232bbd2190` `112eb4cd80fc46fd8793e3b257c50c32`
- 가져온 이미지·코드는 `design/stitch/<화면 ID>/` 에 저장해 비교 기준으로 남긴다 (Stitch HTML 은 참고용, 앱에 직접 붙이지 않음).

## 2. 디자인 토큰 (`src/styles.css` `:root`)

적용 중인 디자인: Stitch **Warm Henesys Tactile Modern** (원본 `stitch-design-system.md`, 2026-10-07 반영).
따뜻한 양피지 톤 + 헤네시스 주황 + 레트로 픽셀 포인트.

| 토큰 | 라이트 | 다크 | 용도 |
|---|---|---|---|
| `--bg` / `--surface` / `--surface-2` | #faf8f5 / #ffffff / #f5f1eb | #1a1714 / #23201c / #2d2925 | 배경 / 카드·표 / 표 머리글·hover |
| `--text` / `--text-2` / `--muted` / `--placeholder` | #2d2926 / #59534d / #6b635b / #8c847b | #f3ebe4 / #d6cbc1 / #b3a89d / #8c847b | 글자 단계 |
| `--border` / `--border-strong` | #e8e2d8 / #d8d1c5 | #3d3731 / #514942 | 구분선 / hover·체크박스 테두리 |
| `--accent` / `--accent-hover` / `--accent-strong` / `--accent-edge` | #ff8a3d / #ff9a57 / #e57328 / #d4661e | #ff9a57 / #ffb68d / #ffb68d / #b8561a | 주요 버튼 채움, 테두리, 버튼 아래 턱 |
| `--accent-text` / `--accent-soft` / `--accent-ring` | #9a4600 / #fff1e8 / 주황 15% | #ffb68d / #3d2616 | 선택 탭·칩 글자 / 배경 / 포커스 링 |
| `--on-accent` | #682d00 | #321200 | 주황 버튼 위 글자 (아래 접근성 참고) |
| `--danger` / `--warn-bg` / `--success` | #ba1a1a / #fff9e6 / #2f7a49 | #ffb4ab / #3a3220 / #79db94 | |
| `--check` / `--check-edge` | #48a968 / #3b8c55 | | 완료 체크박스 |
| 배지 `--urgent-*` `--high-*` `--done-*` `--info-*` | 피치 / 골드 / 초록 / 하늘 연한 배경 + 진한 글자 | 어두운 톤 | 긴급 / 높음·보류 / 완료 / 진행 중 |
| `--radius-sm/radius/radius-lg/radius-sheet/radius-pill` | 6 / 12 / 18 / 24 / 999px | | 체크박스 / 버튼·입력 / 카드·표 / 독·바텀시트 / 배지 |
| `--shadow-card` `--shadow-btn` `--shadow-panel` `--shadow-sheet` `--shadow-dock` | 카드 아래 2px 턱, 버튼 아래 주황 턱 등 | | |
| `--font` / `--font-mono` | Plus Jakarta Sans → Pretendard(한글) / Space Mono | | 본문 / 날짜·시각·숫자 칸 |

글꼴은 `index.html` 에서 Google Fonts(Plus Jakarta Sans, Space Mono)와 jsDelivr(Pretendard)로 불러온다. Plus Jakarta Sans 에는 한글이 없어서 한글은 Pretendard 로 넘어간다.
다크 모드는 OS 설정을 따른다. Stitch 시스템에 다크 팔레트가 없어 같은 색상환으로 직접 만들었다.

**Stitch 와 다르게 한 점**
- 주황 버튼 글자: Stitch 는 흰색(#fff)이지만 #ff8a3d 위 대비가 2.35:1 이라 Stitch 팔레트의 `on-primary-container` #682d00 (4.56:1) 사용. 흰 글자로 되돌리려면 `--on-accent: #ffffff`.
- `--muted`: Stitch 의 Clay #8c847b 는 흰 바탕 3.68:1 이라 작은 글자(표 머리글 12px)에 못 미친다 → #6b635b (5.2:1). #8c847b 는 placeholder·완료 행에만.
- 3단 타임라인 / 미니 달력 / 진행 막대 / 픽셀 아이콘 배지 레이아웃은 넣지 않음 (4장 규칙: 표 중심). 진행 막대는 프로젝트 "작업 수/미완료"에 나중에 붙일 후보.

**CSS 로 넣은 Stitch 요소**: 눌리는 주황 버튼(아래 턱 + 1px 내려감), 22px 퀘스트 체크박스(초록 + 픽셀 체크 + 튀는 애니메이션, `prefers-reduced-motion` 시 끔), 완료 행 흐림 + 주황 취소선(`:has()`), 날짜·시각·숫자 칸 Space Mono, 주황 포커스 링, 모바일 플로팅 독(유리 효과 + 선택 탭 아래 주황 점), 로고 앞 픽셀 점, 회차 목록 hover 시 왼쪽 주황 띠.

## 3. 화면 목록

| # | 화면 | 진입 | 주요 요소 | 컴포넌트 |
|---|---|---|---|---|
| A | 앱 셸 | 항상 | 로고 `DOTDAY`, 탭(투두·캘린더·프로젝트·설정), 동기화 배지 | `App.tsx` `.top` `.tabs` `.sync-badge` |
| B | 투두 표 | `#tasks` | 보기 선택+⋯, 검색, 정렬/필터/컬럼/+추가, 건수, 표(완료 체크박스 리드 셀) | `TablePage` `DataTable` |
| C | 캘린더 | `#events` | 다가오는 일정 목록(날짜별 그룹) + 일정 표 | `OccurrenceList` + B 와 같은 표 |
| D | 프로젝트 표 | `#projects` | 이름·설명·상태·작업 수·미완료 | B 와 같은 표 |
| E | 편집 패널 | 행 클릭 / +추가 | 데스크톱 오른쪽 420px 시트, 모바일 하단 시트 | `RecordEditor` `Panel` |
| F | 보기 패널들 | 정렬·필터·컬럼·⋯ | 컬럼 목록(체크·▲▼·📌·너비), 정렬 규칙, 필터 칩·날짜범위 | `ViewMenus` |
| G | 설정 | `#settings` | 카드 나열: 계정/로그인, 동기화 상태, 충돌 해결, 보기 관리, 휴지통, 내보내기·가져오기, 분류, 기기 데이터 지우기 | `SettingsPage` `AuthForms` |
| H | 알림 띠 | 조건부 | 로그인 만료, 로그인 전 데이터 이전 | `.notice` |

표에 들어가는 실제 값(시안에 그대로 쓰기):
- 투두 컬럼: 제목 · 상태(할 일/진행 중/완료) · 우선순위(낮음/보통/높음/긴급) · 마감일 · 프로젝트 · 분류
- 일정 컬럼: 제목 · 시작 시각 · 종료 시각 · 종일 · 반복 · 프로젝트 · 분류
- 프로젝트 컬럼: 이름 · 설명 · 상태(진행 중/보류/완료/보관) · 수정일 · 작업 수 · 미완료 작업
- 분류는 색 점(●) + 이름
- 동기화 배지 문구: 동기화됨 / 동기화 중 / 전송 대기 · 대기 3 / 오프라인 / 동기화 오류 / 로그인 만료 / 로컬

## 4. 바꾸면 안 되는 규칙 (Stitch 시안이 어겨도 코드에는 반영 안 함)

- 앱의 중심은 **사용자가 컬럼을 고르는 표**다. 카드 그리드·칸반·월간 달력으로 바꾸지 않는다 (추가 기능으로는 가능하지만 이번 범위 밖).
- 제목/이름 컬럼은 숨길 수 없다. 열기·완료 체크 칸은 컬럼 설정 밖의 고정된 첫 칸이다.
- 모바일에서는 표를 **가로 스크롤**한다. 화면이 좁다고 컬럼을 자동으로 숨기지 않는다. 첫 칸만 고정(sticky).
- 모바일 탭은 하단 고정 탭바(엄지 영역), 패널은 바텀시트. 터치 대상 최소 44px, 입력창 글자 16px (iOS 확대 방지).
- 동기화 상태 배지는 항상 보인다. 오류를 성공처럼 보이게 하지 않는다 (나쁜 상태 우선).
- 범위 밖: 소셜 로그인 버튼, 이메일 인증, CAPTCHA. 시안에 나와도 넣지 않는다.

## 5. 남은 보완점

- **아이콘**: 지금은 문자(⋯ ▲▼ 📌 ✕)를 쓴다. Stitch 의 픽셀 미니 아이콘 느낌으로 인라인 SVG 몇 개를 만들면 어울린다.
- **확인/입력 대화상자**: 보기 이름 변경·삭제 확인이 `window.prompt/confirm` 이라 브라우저 기본 모양이 나온다 → `Panel` 기반 모달로 교체 후보.
- **파비콘**: 없음. 로고 앞 픽셀 점과 같은 모양으로 `public/favicon.svg` 를 만들면 된다.
- **간격 토큰**: 숫자 그대로 (Stitch 는 8pt 그리드: 4/8/16/24/32).
- **Pretendard CDN**: 외부 CDN 의존. 오프라인 우선 앱이라 나중에 `public/` 으로 내려받아 두는 것도 고려.
