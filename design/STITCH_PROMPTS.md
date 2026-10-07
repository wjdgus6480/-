# Stitch 프롬프트

사용법: Stitch 에서 새 프로젝트 → 모드 **Web** (모바일 시안은 같은 프롬프트로 **Mobile** 모드 한 번 더) → 아래 0번을 먼저 넣고, 이어서 1~7번을 한 화면씩 넣는다.
Stitch 는 영어 지시를 더 잘 따르므로 지시는 영어, 화면 글자는 한국어로 적었다. 기준은 `DESIGN.md`.

---

## 0. 공통 스타일 (첫 프롬프트)

```
Design a clean, minimal productivity web app called "DOTDAY" (Korean UI). It shows todos, calendar events and projects as user-configurable data tables, similar to Notion database tables or Linear lists. Dense but calm, lots of whitespace, no illustrations, no gradients.

Style rules for every screen:
- Neutral gray background, white surfaces, one accent color (blue), soft status colors for badges (red=긴급, amber=높음, green=완료, blue=진행 중).
- Rounded corners 8px for buttons/inputs, 10px for cards/tables, pill-shaped badges and chips.
- Base font 14px, Korean-friendly sans-serif (Pretendard or Noto Sans KR).
- Thin 1px borders instead of heavy shadows. Only side panels/bottom sheets have a shadow.
- Provide both light and dark theme.
- Use real Korean labels exactly as given. Do not add social login, charts, sidebars or marketing sections.
```

## 1. 앱 셸 + 투두 표 (데스크톱)

```
Main screen, desktop 1400px wide.
Header row: text logo "DOTDAY" on the left, then tabs "투두" (selected), "캘린더", "프로젝트", "설정". At the far right a small pill status badge "동기화됨" (green text).
Toolbar below: a dropdown "★ 기본 보기" with a "⋯" button, a search input "검색 (제목·설명)" that fills the remaining width, then buttons "정렬 1", "필터", "컬럼 (2 숨김)" and a primary blue button "+ 추가".
Small gray text: "투두 8 / 12건 (나머지는 이 보기의 필터로 숨겨짐)".
A data table inside a bordered rounded container. First narrow column has a checkbox per row (complete toggle). Columns: 제목, 상태, 우선순위, 마감일 ▲, 프로젝트, 분류. Status and priority are pill badges. 분류 shows a colored dot + name (업무, 개인, 공부). Column headers are small gray semibold text; the sorted header shows a small blue ▲. 8 realistic Korean task rows, one row in hover state, one completed row.
```

## 2. 투두 표 (모바일 390px)

```
Same todo screen for mobile 390px.
Header: "DOTDAY" left, status pill "전송 대기 · 대기 3" right.
Tabs move to a fixed bottom tab bar (투두, 캘린더, 프로젝트, 설정), each at least 48px tall.
Toolbar: view dropdown + "⋯" on one line, full-width search on the next line, then a 4-column grid of buttons: 정렬, 필터, 컬럼, + 추가.
The table keeps all its columns and scrolls horizontally; only the first column (checkbox) and the 제목 column are sticky. Show it partially scrolled so the horizontal scroll is visible. Touch targets at least 44px.
```

## 3. 캘린더

```
Calendar tab, desktop. Tab "캘린더" selected.
Above the table, a collapsible card titled "▾ 회차 보기 (6개)" with period chips "지난 30일", "이번 주" (selected), "앞으로 30일", "직접 지정". It lists occurrences grouped by small gray day headings ("10월 7일 (수)", "10월 8일 (목)"): each item shows time "09:30" in gray tabular numbers, title, a small "반복" badge if recurring, and project name.
Below it the same toolbar and table as the todo screen, columns: 제목, 시작 시각, 종료 시각, 종일, 반복, 프로젝트, 분류. No checkbox column.
Do NOT turn this into a month grid calendar.
```

## 4. 프로젝트

```
Projects tab, desktop. Same toolbar and table. Columns: 이름, 설명, 상태 (진행 중 / 보류 / 완료 / 보관 badges), 수정일, 작업 수, 미완료 작업 (numbers right-aligned). 5 realistic Korean projects.
```

## 5. 편집 패널

```
Record editor. Desktop: a 420px panel sliding in from the right over a dimmed table, header "투두 편집" with a close ✕ button.
Form fields stacked with small gray labels: 제목, 설명 (textarea), row of 상태 / 우선순위 selects, 마감일 date, row of 프로젝트 / 분류 selects. Buttons at the bottom: primary "저장", danger text button "삭제".
Mobile 390px version: same form as a bottom sheet with 14px top corners, max 85% height, 16px input text.
Also show the event editor variant: 시작/종료 datetime, "종일" checkbox, and a "반복" fieldset (매일/매주/매월, 간격, 요일 chips 월~일, 종료 조건).
```

## 6. 보기 설정 패널 (정렬·필터·컬럼)

```
Three side-panel states on the todo screen:
1) "컬럼 설정": list of columns, each row has a visibility checkbox, label, up/down arrow icons, a pin icon, and a small width input "260". The "제목" row has its checkbox disabled (cannot be hidden).
2) "정렬": rows of [field select] [오름차순/내림차순 select] [remove ✕], plus "+ 정렬 추가".
3) "필터": grouped boxes "상태", "우선순위", "프로젝트", "분류" with selectable pill chips (selected = blue outline + soft blue background), and "마감일" with a from–to date range plus quick chips "오늘", "이번 주", "지난 기한".
```

## 7. 설정

```
Settings tab, single column max 800px, stacked cards with section titles:
- "계정 · 기기 간 동기화": signed-in email, key-value rows (업무 데이터: 동기화됨 / 보기 설정: 대기 2 / 마지막 동기화: 오후 3:12), buttons "지금 동기화", "이 기기 로그아웃", "모든 기기 로그아웃".
- "확인이 필요한 변경": one conflict item showing field "마감일" with two radio options "이 기기: 10월 9일" / "서버: 10월 10일" and button "선택한 값으로 저장".
- "보기 관리", "휴지통" (items restorable for 30 days, "복구" button), "업무 데이터 내보내기 · 가져오기", "분류" (color dot + name list with add form).
- A collapsible red-tinted "이 기기 데이터 지우기" danger zone at the bottom.
Also show the logged-out state of the account card: email + password inputs, "로그인" primary button, link "회원가입".
```

---

## 전달할 때

화면마다 아래를 보내 주면 된다. (전부가 아니어도 됨 — 최소 1·2·5번)
1. **스크린샷** (라이트, 가능하면 다크도)
2. **코드**: Stitch 화면 선택 → `</>` Code → 복사 또는 Export(ZIP) 의 `code.html`
3. 마음에 드는 점 / 안 드는 점 한두 줄 (예: "색은 좋은데 표가 너무 성김")
