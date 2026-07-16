# i-daily

데일리 업무일지 데스크톱 앱 (Electron · Windows / macOS / Linux).

- 데이터의 진실은 sqlite에 있다 — 유저별 정규화 테이블(`days` / `sections` / `blocks` / `spaces` / `tasks` / `list_items` / `shortcuts`).
- 렌더러(브라우저 UI)는 `window.api.request(method, path, body)`로 요청하고, IPC를 거쳐 메인 프로세스의 `route()` → `better-sqlite3`로 이어진다.
- 과거 Bun 웹서버 / Cloudflare 경로는 데스크톱 전용으로 전환하며 폐기했다. 전송(transport)만 HTTP → IPC로 바뀌었고 UI 로직은 그대로다.

## 주요 기능

상단 탭으로 네 가지 화면을 오간다.

### 📋 업무일지

- 날짜별 문서를 스크럼 · 리스트 · raw 섹션으로 자유롭게 구성한다.
- 스크럼은 이전/오늘(prev/today) 블록에 스페이스 → 태스크(하위 포함)로 정리하고, 리스트는 일일 진행 업무를 체크 형태로 적는다.
- 전날 업무를 오늘로 이월하고, 티켓 키(`PREFIX-123`)는 설정한 Jira 주소로 자동 링크된다.
- 드래그로 섹션·항목 순서를 바꾸고, 자주 쓰는 링크는 바로가기(shortcuts)로 둔다.

### 🎫 내 티켓

- 내게 할당된 Jira 티켓을 조회한다(현재는 read 전용 — 조회만, 상태 변경 없음).
- 상태별 칸반 컬럼으로 보고, 티켓을 클릭 한 번으로 업무일지(스크럼/일일 항목)에 복사한다.

### 📄 주간보고

- 보고 주기(전주 금요일 ~ 금주 목요일)의 업무를 스페이스·티켓 기준으로 집계한다.
- 결정적 집계 결과를 기본으로 두고, 에이전트(LLM)로 문장을 다듬을 수 있으며 원문 대비 변경점을 diff로 보여준다.

### ⚙️ 설정

- 이름 · 채널 · Jira 주소 등 user별 값을 코드가 아닌 DB에 저장한다(아래 [설정](#설정) 섹션 참고).

## 개발 실행

```sh
npm install    # 의존성 설치 + better-sqlite3를 Electron ABI로 리빌드(postinstall)
npm run dev    # electron-vite dev — 창 + HMR
```

## 빌드 / 배포판

```sh
npm run build        # out/ 로 번들(main · preload · renderer)
npm run dist:mac     # release/ 에 dmg · zip
npm run dist:win     # release/ 에 nsis 설치본 · portable
npm run dist:linux   # release/ 에 AppImage · deb
```

- 크로스 빌드는 각 OS가 필요하다(mac 산출물은 macOS에서). 3-OS 산출물은 GitHub Actions 매트릭스(macos / windows / ubuntu)로 자동화하는 것을 권장한다.
- 아이콘은 `build/icon.icns`(mac) · `build/icon.ico`(win) · `build/icon.png`(linux, 512px)를 두면 자동 사용하고, 없으면 기본 아이콘을 쓴다.

### 자동 업데이트 (GitHub Releases)

패키징된 앱은 시작 시 그리고 4시간마다 GitHub Release를 확인해, 새 버전이 있으면 상단 배너로 안내한다. 헤더의 `vX.Y.Z` 뱃지를 클릭하면 수동으로 검사하고, **다운로드 → 재시작**으로 설치한다.

| OS | 업데이트 대상 산출물 | 비고 |
| --- | --- | --- |
| Windows | NSIS 설치본 | portable은 비대상 |
| macOS | zip | 코드 서명·공증이 없으면 설치 단계에서 Gatekeeper가 막을 수 있음 |
| Linux | AppImage | deb는 비대상 |

Release 자산에는 `latest.yml` / `latest-mac.yml` / `latest-linux.yml`과 `*.blockmap`이 반드시 있어야 한다(워크플로가 포함한다). 저장소가 private이면 클라이언트가 토큰 없이 피드를 못 읽으므로, 릴리스 자산을 public으로 두거나 generic provider를 써야 한다.

배포는 Actions → **Release** 워크플로에서 patch / minor / major를 선택해 실행한다.

## 테스트 / 타입체크

```sh
npm test         # model · store · api(IPC 라우팅) · report 왕복/쿼리/유저격리
npm run typecheck
```

테스트는 `ELECTRON_RUN_AS_NODE=1 electron`으로 실행한다 — better-sqlite3를 앱과 동일한 Electron ABI로 로드하므로 리빌드 핑퐁이 없다.

## 구조

```
src/
  main/index.ts          Electron 메인: 창 · IPC('api') · DB 경로(userData) · window.open→외부 브라우저
  main/update.ts         electron-updater(GitHub Release) · IPC update:* · 시작/주기 체크
  main/jira.ts           Jira 연동 헬퍼
  main/agent.ts          에이전트 연동
  preload/index.ts       contextBridge로 window.api.request + window.api.update 노출(contextIsolation)
  shared/model.ts        순수 로직: 타입 · 파서 · 렌더러 · docToRows/rowsToDoc (부작용 없음 → 테스트 대상)
  shared/store.ts        better-sqlite3(진실=정규화 테이블 왕복) · queryTasks(task_rows 뷰) · migrateV1/V2
  shared/api.ts          route(method, path, body, user, db) → {status, body} — 전송 무관 라우팅
  shared/report.ts       주간/실적 리포트 집계
  renderer/              index.html · styles.css(Tailwind v4 토큰·프리미티브)
  renderer/src/          React + TS 렌더러 (main.tsx 진입)
    App.tsx              오케스트레이터: boot · 날짜 로드/저장/이월 · dirty · 탭/패인
    types.ts             렌더러 도메인 타입 + window.api 브릿지 타입
    context/             EditorContext (doc 편집 공유)
    hooks/               useAutoUpdate (GitHub Release 배너)
    lib/                 api(IPC 래퍼) · model(순수 헬퍼) · dnd/useDnd(드래그) · ui
    components/          Tabs · TopHeader · Shortcuts · DayCard · TicketsPane · ConfigPane
                         WeeklyReportPane · Toast · ContextMenu · DragHandle · GoButton
    components/sections/ SectionList · List/Raw/Scrum(Section · Block · Space · Task) · SubList
electron.vite.config.ts  main / preload / renderer 3섹션 · React + Tailwind 플러그인(renderer)
electron-builder.yml     3-OS 타깃 · asarUnpack(better-sqlite3) · publish github(preinpost/i-daily)
test/                    model · store · api · report 테스트 · tiny.ts(expect shim)
```

## 데이터 / 스키마

DB 위치는 `app.getPath('userData')/i-daily.db`다(패키지 앱 번들은 읽기전용이라 쓰기 가능한 userData에 둔다). `DB_PATH` env로 변경할 수 있다.

- macOS: `~/Library/Application Support/i-daily/i-daily.db`
- Windows: `%APPDATA%\i-daily\i-daily.db`
- Linux: `~/.config/i-daily/i-daily.db`

하루치 `Doc`는 정규화된 행들로 왕복한다.

- `days(user, date, owner, preamble, updated_at, PK(user, date))` — 하루 메타.
- `sections(user, date, pos, kind, title, body)` — 순서 있는 섹션(`raw`만 body).
- `blocks(user, date, side, issues, collab)` — 스크럼 블록별 이슈/협업. side ∈ prev | today.
- `spaces(...)` → `tasks(... jkey, descr, progress, due, subs_json)` — 스크럼 태스크(하위 = subs_json).
- `list_items(user, date, pos, done, jkey, descr, progress, due, subs_json)` — 일일 진행 업무.
- `shortcuts(user, pos, name, url)` — 바로가기.
- `task_rows` (VIEW) — 스크럼 태스크 + 일일 항목을 `(date, side, space, jkey, descr, progress, due)`로 평탄화(빈 행 제외). side ∈ prev | today | daily.
- v1(`days.doc` JSON blob) DB는 첫 실행 시 자동 변환한다(원본은 `*_v1` 테이블로 보존).

## 설정 (⚙️ 설정 탭 → DB 저장)

회사/개인 값은 코드에 하드코딩하지 않고 설정 페이지 → `settings` 테이블(user별 JSON)에 저장한다. 최초 실행(저장 이력 없음) 시 자동으로 ⚙️ 설정 페이지로 이동하며, `이름 · 채널명 · Jira 주소`를 채우면 업무일지가 활성화된다.

| 항목 | 설명 |
| --- | --- |
| `owner` | 작성자 이름(헤더·문서 메타) |
| `jiraBase` | Jira 호스트 (예: `https://your-org.atlassian.net`) — `/browse/티켓`은 자동 |
| `spaces` | 스페이스 입력 자동완성 목록 |
| `spaceRules` | 티켓 prefix → 스페이스 자동 추천(`PREFIX=스페이스`) |

- API: `GET/PUT /api/config`.
- 미설정 값은 환경변수(`OWNER` · `JIRA_BASE`)로 초기값만 주입할 수 있다(공개 배포 시 비운다).
- 기타 env: `DB_PATH` · `IDAILY_USER`(로컬 유저, 기본 `local`).
