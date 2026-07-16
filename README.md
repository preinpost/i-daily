# i-daily

데일리 업무일지 — **Electron 데스크톱 앱** (Windows · macOS · Linux).

**진실 = sqlite**(정규화 테이블 — `days`/`sections`/`blocks`/`spaces`/`tasks`/`list_items`/`shortcuts`), 유저별.
렌더러(브라우저 UI)는 `window.api.request(method,path,body)` → **IPC** → 메인 프로세스의 `route()` → `better-sqlite3`.
과거 Bun 웹서버/Cloudflare 경로는 데스크톱 전용으로 전환하며 폐기. 전송(transport)만 HTTP→IPC로 바뀌어 UI 로직은 그대로다.

## 실행 (개발)

```sh
npm install        # 의존성 + better-sqlite3를 Electron ABI로 리빌드(postinstall)
npm run dev        # electron-vite dev — 창 + HMR
```

## 빌드 / 배포판

```sh
npm run build          # out/ 로 번들(main·preload·renderer)
npm run dist:mac       # release/ 에 dmg·zip
npm run dist:win       # release/ 에 nsis 설치본·portable
npm run dist:linux     # release/ 에 AppImage·deb
```

> 크로스 빌드는 각 OS가 필요하다(mac은 macOS에서). 3-OS 산출물은 GitHub Actions 매트릭스(macos/windows/ubuntu)로 자동화 권장.
> 아이콘은 `build/icon.icns`(mac)·`build/icon.ico`(win)·`build/icon.png`(linux, 512px)를 두면 자동 사용, 없으면 기본 아이콘.

### 자동 업데이트 (GitHub Releases)

패키징된 앱은 시작 시(및 4시간마다) GitHub Release를 확인해 새 버전이 있으면 상단 배너로 안내한다.
헤더 `vX.Y.Z` 뱃지를 클릭하면 수동 검사. **다운로드 → 재시작** 으로 설치.

| OS | 업데이트 대상 산출물 | 비고 |
|---|---|---|
| Windows | NSIS 설치본 | portable은 비대상 |
| macOS | zip | **코드 서명·공증** 없으면 설치 단계에서 Gatekeeper가 막을 수 있음 |
| Linux | AppImage | deb는 비대상 |

Release 자산에 `latest.yml` / `latest-mac.yml` / `latest-linux.yml` 과 `*.blockmap` 이 반드시 있어야 한다(워크플로가 포함). 저장소가 **private** 이면 클라이언트에서 토큰 없이 피드를 못 읽으므로, 릴리스 자산을 public으로 두거나 generic provider를 써야 한다.

배포: Actions → **Release** 워크플로 → patch/minor/major 선택 실행.

## 테스트 / 타입체크

```sh
npm test        # model 왕복 + store 왕복/쿼리/유저격리 + route(IPC 라우팅)
npm run typecheck
```

테스트는 `ELECTRON_RUN_AS_NODE=1 electron`으로 실행 → better-sqlite3를 앱과 **동일한 Electron ABI**로 로드(리빌드 핑퐁 없음).

## 구조

```
src/
  main/index.ts       Electron 메인: 창 · IPC('api') · DB 경로(userData) · window.open→외부 브라우저
  main/update.ts      electron-updater(GitHub Release) · IPC update:* · 시작/주기 체크
  preload/index.ts    contextBridge로 window.api.request + window.api.update 노출(contextIsolation)
  shared/model.ts     순수 로직: 타입 · 파서 · 렌더러 · docToRows/rowsToDoc (부작용 없음 → 테스트 대상)
  shared/store.ts     better-sqlite3(진실=정규화 테이블 왕복) · queryTasks(task_rows 뷰) · migrateV1/V2 · fsStore(md)
  shared/api.ts       route(method,path,body,user,db)→{status,body} — IPC가 호출하는 전송 무관 라우팅
  renderer/           index.html · styles.css(Tailwind v4 토큰·프리미티브)
  renderer/src/       React + TS 렌더러 (main.tsx 진입)
    App.tsx           오케스트레이터: boot · 날짜 로드/저장/이월 · dirty · 탭/패인
    types.ts          렌더러 도메인 타입 + window.api 브릿지 타입
    context/          EditorContext (doc 편집 공유)
    hooks/            useAutoUpdate (GitHub Release 배너)
    lib/              api(IPC 래퍼) · model(순수 헬퍼) · dnd/useDnd(드래그) · ui
    components/       Tabs · TopHeader · Shortcuts · DayCard · Tickets/ConfigPane · Toast · ContextMenu
    components/sections/  SectionList · List/Raw/Scrum(Section·Block·Space·Task) · SubList
electron.vite.config.ts   main/preload/renderer 3섹션 · React + Tailwind 플러그인(renderer)
electron-builder.yml      3-OS 타깃 · asarUnpack(better-sqlite3) · publish github(preinpost/i-daily)
test/                 model.test.ts · store.test.ts · api.test.ts · tiny.ts(expect shim)
```

## 데이터 / 스키마

- **DB 위치** — `app.getPath('userData')/i-daily.db` (패키지 앱 번들은 읽기전용이라 쓰기 가능한 userData에).
  - macOS: `~/Library/Application Support/i-daily/i-daily.db`
  - Windows: `%APPDATA%\i-daily\i-daily.db`
  - Linux: `~/.config/i-daily/i-daily.db`
  - `DB_PATH` env로 변경 가능.
- 하루치 `Doc`는 정규화 행들로 왕복:
  - `days(user,date,owner,channel,preamble,updated_at, PK(user,date))` — 하루 메타.
  - `sections(user,date,pos,kind,title,body)` — 순서 있는 섹션(`raw`만 body).
  - `blocks(user,date,side,issues,collab)` — 스크럼 블록별 이슈/협업. side ∈ prev|today.
  - `spaces(...)` → `tasks(...jkey,descr,progress,due,subs_json)` — 스크럼 태스크(하위=subs_json).
  - `list_items(user,date,pos,done,jkey,descr,progress,due,subs_json)` — 일일 진행 업무.
  - `shortcuts(user,pos,name,url)` — 바로가기.
  - `task_rows` (VIEW) — 스크럼 태스크 + 일일 항목을 `(date,side,space,jkey,descr,progress,due)`로 평탄화(빈 행 제외). side ∈ prev|today|daily.
  - v1(`days.doc` JSON blob) DB는 첫 실행 시 자동 변환(원본은 `*_v1` 테이블로 보존).
- `~/daily/*.md` — 옵시디언 escape hatch(`fsStore`, 현재 코드로만 유지).

## 설정 (⚙️ 설정 탭 → DB 저장)

회사/개인 값은 코드에 하드코딩하지 않고 **설정 페이지 → `settings` 테이블(user별 JSON)** 에 저장한다.
최초 실행(저장 이력 없음) 시 자동으로 ⚙️ 설정 페이지로 이동하며, `이름 · 채널명 · Jira 주소`를 채우면 업무일지가 활성화된다.

| 항목 | 설명 |
|---|---|
| `owner` | 작성자 이름(헤더·문서 메타) |
| `jiraBase` | Jira 호스트 (예: `https://your-org.atlassian.net`) — `/browse/티켓`은 자동 |
| `spaces` | 스페이스 입력 자동완성 목록 |
| `spaceRules` | 티켓 prefix → 스페이스 자동 추천(`PREFIX=스페이스`) |

API: `GET/PUT /api/config`. 미설정 값은 환경변수(`OWNER`·`JIRA_BASE`)로 초기값만 주입 가능(공개 배포 시 비움).

기타 env: `DAILY_DIR` · `DB_PATH` · `IDAILY_USER`(로컬 유저, 기본 local)
