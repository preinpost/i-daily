# i-daily

데일리 업무일지 웹앱 (Cloudflare Workers · D1 · Hono · Drizzle).

- 데이터의 진실은 D1(SQLite)에 있다 — 유저별 정규화 테이블(`days` / `sections` / `blocks` / `spaces` / `tasks` / `list_items` / `shortcuts`).
- 브라우저 UI(React)는 `window.api.request(method, path, body)`로 요청하고, Hono 서버(Workers)의 `routeWith()` → Drizzle/D1로 이어진다.
- Electron 데스크톱 앱에서 웹앱으로 전환했다(이전 아키텍처는 git history 참고). 도메인 로직(model/store/report)과 UI 컴포넌트는 무손상 재사용.

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

### ⚙️ 설정

- 이름 · 채널 · Jira 주소 등 user별 값을 코드가 아닌 DB에 저장한다(아래 [설정](#설정) 섹션 참고).

## 개발 실행

```sh
npm install       # 의존성 설치
npm run dev       # API(wrangler:8787) + UI(Vite:5173) 동시 실행 → http://localhost:5173
npm run db:migrate:local   # 로컬 D1 스키마 적용(최초 1회)
```

`npm run dev` 후 **브라우저는 `http://localhost:5173`** 을 연다(UI + HMR). `/api/*`는 자동으로 8787(wrangler·D1)로 프록시된다. 8787은 백엔드 API 로그용이라 브라우저로 열지 않는다.

## 빌드 / 배포

```sh
npm run build      # Vite → dist/web (SPA)
npm run deploy     # Cloudflare Workers 배포(빌드 포함)
```

- 배포 대상: `https://i-daily.<your-subdomain>.workers.dev` (Workers + D1 + Assets).
- 스키마 변경: `npm run db:generate` → `npm run db:migrate:remote`.

### GitHub Actions (`.github/workflows/release.yml`)

semver bump → tag → D1 마이그레이션(remote) → `wrangler deploy` → GitHub Release 생성까지 자동화. `Actions → Release → Run workflow`로 수동 실행(bump: patch/minor/major).

Repo Settings → Secrets and variables → Actions 에 아래 2개를 등록해야 한다:

| Secret | 값 | 확인 방법 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Custom Token | 아래 "Cloudflare API 토큰 발급" 참고 |
| `CLOUDFLARE_ACCOUNT_ID` | 계정 ID | `npx wrangler whoami` 출력의 Account ID 컬럼 |

```sh
gh secret set CLOUDFLARE_API_TOKEN --repo preinpost/i-daily
gh secret set CLOUDFLARE_ACCOUNT_ID --repo preinpost/i-daily
```

#### Cloudflare API 토큰 발급

<https://dash.cloudflare.com/profile/api-tokens> → **Create Token → Create Custom Token**

- Permissions: `Account` → `D1` → `Edit`, `Account` → `Workers Scripts` → `Edit`
  (선택: `Account` → `Account Settings` → `Read`, `User` → `User Details` → `Read`)
- Account Resources: **Include → 배포할 특정 계정 하나만 선택** — `All accounts`는 D1 쿼리 API에서
  `Authentication error [code: 10000]`로 거부되는 경우가 있었음(계정 스코프가 특정 D1 리소스에
  제대로 안 붙는 것으로 추정). 반드시 계정을 명시적으로 선택할 것.
- Zone Resources: 커스텀 도메인/라우트 안 쓰면 없어도 무방.

`CLOUDFLARE_ACCOUNT_ID`를 잘못 넣어도 토큰 권한이 맞더라도 동일한 10000 에러가 난다 — 둘 다
`wrangler whoami` 결과와 정확히 일치하는지 먼저 확인.

## 테스트 / 타입체크

```sh
npm test          # model · store · api 라우팅 · report (better-sqlite3 in-memory, Node 러너)
npm run typecheck
```

테스트는 `node --import tsx --test`로 실행한다. better-sqlite3는 devDep으로 로컬 인메모리 테스트만 담당(Workers 번들에 포함되지 않음).

## 구조

```text
src/
  worker/index.ts        Cloudflare Workers 엔트리: env.DB(D1) → Drizzle → d1Backend → Hono. /api/* 처리, 정적은 assets 위임.
  server/app.ts          Hono 앱: 도메인 라우트(jira/agent) + 일지 CRUD catch-all(routeWith).
  server/jira.ts         Atlassian OAuth 2.0(3LO) + REST + 로그인(=연결) — /api/jira/callback 에서 /me 로 account_id 를 받아 세션 발급.
  server/agent.ts        주간보고 결정적 집계(Workers는 CLI spawn 불가 → 에이전트 비활성화).
  shared/backend.ts      Backend seam — route()가 DB 드라이버를 추상화한 인터페이스.
  shared/schema.ts       Drizzle 스키마 = 진실의 원천(11테이블 + task_rows 뷰: oauth_states/sessions 포함).
  shared/store-drizzle.ts D1용 스토어(Drizzle, batch). store.ts(better-sqlite3)와 동일 진실.
  shared/store.ts        better-sqlite3 스토어 + sqliteBackend — 테스트 전용(devDep).
  shared/api.ts          route() → routeWith(backend): 전송·DB 드라이버 무관 라우팅.
  shared/model.ts        순수 로직: 타입 · 파서 · 렌더러 · docToRows/rowsToDoc (부작용 없음 → 테스트 대상).
  shared/report.ts       주간/실적 리포트 집계.
  renderer-web/          index.html · main.tsx — 웹 진입(window.api → webApi 설치).
  renderer/              styles.css(Tailwind v4 토큰·프리미티브, @source로 컴포넌트 스캔)
  renderer/src/          React + TS 렌더러 (App 등, Electron·웹 공유 컴포넌트)
    web-api.ts           브라우저 전용 window.api — fetch 기반 request + 도메인 라우트 호출.
    lib/api.ts           api(method,path,body) 전송 래퍼.
    components/          Tabs · TopHeader · DayCard · TicketsPane · ConfigPane · WeeklyReportPane 등.
wrangler.jsonc           Workers 설정: D1 바인딩 + Assets(SPA) + nodejs_compat.
vite.web.config.ts       웹 SPA 빌드(React + Tailwind). root=src/renderer-web.
drizzle.config.ts        drizzle-kit 설정(schema → migrations).
migrations/              D1 마이그레이션 SQL.
test/                    model · store · api · report 테스트 · tiny.ts(expect shim).
```

## 데이터 / 스키마

DB 는 Cloudflare D1(SQLite)다. 스키마의 진실 원천은 `src/shared/schema.ts`(Drizzle) 이고, `drizzle-kit generate` 가 `migrations/*.sql` 을 생성한다. 적용은 `wrangler d1 migrations apply i-daily --local|--remote`.

하루치 `Doc`는 정규화된 행들로 왕복한다.

- `days(user, date, owner, preamble, updated_at, PK(user, date))` — 하루 메타.
- `sections(user, date, pos, kind, title, body)` — 순서 있는 섹션(`raw`만 body).
- `blocks(user, date, side, issues, collab)` — 스크럼 블록별 이슈/협업. side ∈ prev | today.
- `spaces(...)` → `tasks(... jkey, descr, progress, due, subs_json)` — 스크럼 태스크(하위 = subs_json).
- `list_items(user, date, pos, done, jkey, descr, progress, due, subs_json)` — 일일 진행 업무.
- `shortcuts(user, pos, name, url)` — 바로가기.
- `settings(user, json)` · `jira_auth(user, json)` — user별 config / Jira OAuth 토큰.
- `oauth_states(state, payload, created_at)` — OAuth `state`(CSRF) 단기 저장(TTL 5분). Workers 멀티인스턴스 대응.
- `sessions(sid, user, created_at, expires_at)` — 로그인 세션. httpOnly `sid` 쿠키 → user(account_id).
- `task_rows` (VIEW) — 스크럼 태스크 + 일일 항목을 `(date, side, space, jkey, descr, progress, due)`로 평탄화(빈 행 제외). side ∈ prev | today | daily.

스키마는 모든 테이블의 PK가 `(user, ...)`로 시작 → DB 재설계 없이 멀티유저 지원 구조. user 는 세션(account_id)에서 주입되며, 미로그인 시 `SETUP("setup")` 센텬넬( OAuth 클라이언트 config 보관).

## 설정 (⚙️ 설정 탭 → DB 저장)

회사/개인 값은 코드에 하드코딩하지 않고 설정 페이지 → `settings` 테이블(user별 JSON)에 저장한다. 최초 실행(저장 이력 없음) 시 자동으로 ⚙️ 설정 페이지로 이동하며, `이름 · 채널명 · Jira 주소`를 채우면 업무일지가 활성화된다.

| 항목 | 설명 |
| --- | --- |
| `owner` | 작성자 이름(헤더·문서 메타) |
| `jiraBase` | Jira 호스트 (예: `https://your-org.atlassian.net`) — `/browse/티켓`은 자동 |

- 스페이스 입력 자동완성은 설정이 아니라 **과거 일지에 쓴 라벨**을 학습한다 (`GET /api/spaces`, 최근 사용순).
- API: `GET/PUT /api/config`.
- 미설정 값은 환경변수(`OWNER` · `JIRA_BASE`)로 초기값만 주입할 수 있다(공개 배포 시 비운다).

### Jira OAuth 클라이언트 (서버 전역 secret)

Jira 연동(=로그인)에 필요한 OAuth 2.0 (3LO) 클라이언트 `client_id`/`client_secret`은 **user 설정이 아닌 서버 전역 secret**이다. settings(JSON)가 아닌 env 에서만 읽는다 — 과거 settings 에 두면 `GET /api/days` 응답으로 브라우저에 secret 이 유출된다.

- 로컬 dev: `.dev.vars` 에 `JIRA_CLIENT_ID` / `JIRA_CLIENT_SECRET` (`wrangler dev` 가 읽는다). 예시는 `.dev.vars.example`.
- 배포: `npx wrangler secret put JIRA_CLIENT_ID` / `npx wrangler secret put JIRA_CLIENT_SECRET` (값 붙여넣고 엔터).
  **`wrangler deploy` 재실행 불필요** — secret put 은 이미 배포된 Worker에 즉시 반영된다.
- 등록 확인: `npx wrangler secret list` (값은 안 보여주고 이름만 나온다).
- Atlassian 앱의 **Callback URL** — Better Auth 전환 후는 아래 두 개를 등록한다.
  - 운영: `https://i-daily.<your-subdomain>.workers.dev/api/auth/callback/atlassian`
  - 로컬 dev: `http://localhost:5173/api/auth/callback/atlassian`
  - (레거시) `/api/jira/callback` 은 구버전 호환용.
- 기타 env: `JIRA_REDIRECT_URI`(레거시 콜백 URL 고정).
- 미설정 시 로그인 페이지에 "서버에 Jira OAuth 클라이언트가 설정되지 않았습니다" 경고가 뜨고 로그인 버튼이 비활성화된다(정상 동작). 둘 등록하면 새로고침만으로 사라진다.

### Microsoft Graph (보조 연결 — 로그인 대체 아님)

로그인은 Atlassian 그대로다. Excel·Teams 등 Graph API 기능용으로 Microsoft 계정을 **설정 탭에서 link** 한다. 토큰은 Better Auth `account` 테이블에 저장되며, 서버는 `getMicrosoftAccessToken` / `graphFetch` (`src/server/microsoft.ts`) 로 호출한다.

- 로컬: `.dev.vars` 에 `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / (선택) `MICROSOFT_TENANT_ID`
- 배포: `npx wrangler secret put MICROSOFT_CLIENT_ID` 등
- Azure 앱 Redirect URI (Web):
  - 로컬: `http://localhost:5173/api/auth/callback/microsoft`
  - 운영: `https://i-daily.<subdomain>.workers.dev/api/auth/callback/microsoft`
- Delegated permissions: 우선 `User.Read`(+ BA 기본 `openid`/`offline_access`)만. Excel·Teams 스코프는 기능 추가 시 `MICROSOFT_EXTRA_SCOPES`와 Azure permissions를 같이 늘린다.
- 회사 테넌트는 **사용자 동의 자체가 막혀** 있으면 `User.Read`만 있어도 “관리자 승인 필요”가 뜬다 → Entra 관리자에게 앱 동의 요청, 또는 Enterprise applications 사용자 동의 정책 확인.
- `MICROSOFT_TENANT_ID` 기본값 코드 쪽은 `organizations`(회사 계정). 단일 테넌트면 GUID 권장.

### Better Auth (웹 세션 + MCP OAuth 인가서버)

웹 로그인과 MCP OAuth 를 모두 Better Auth 가 담당한다. **배포 전 secret 2개를 반드시 등록**해야 한다.

```bash
# 공개 base URL — issuer·MCP resource(aud)·쿠키 오리진을 전부 이 값이 결정한다.
npx wrangler secret put BETTER_AUTH_URL      # 예: https://i-daily.<sub>.workers.dev

# 서명 시크릿(≥32자). 짧으면 코드가 dev 기본값으로 백오프한다.
npx wrangler secret put BETTER_AUTH_SECRET   # openssl rand -base64 32
```

> `BETTER_AUTH_URL` 을 빼면 `http://localhost:5173` 로 폴백되어 운영에서 OAuth 가 전부 깨진다.

생성되는 주요 경로:

| 용도 | 경로 |
| --- | --- |
| issuer | `{BETTER_AUTH_URL}/api/auth` |
| MCP resource (aud) | `{BETTER_AUTH_URL}/mcp` |
| AS metadata | `/.well-known/oauth-authorization-server/api/auth` |
| Protected resource metadata | `/.well-known/oauth-protected-resource/mcp` |

일부 MCP 클라이언트(예: MCP Inspector)는 metadata 의 `*_endpoint` 를 안 읽고
`issuer + /authorize` 같은 관습 경로로 친다. 그래서 `/authorize`·`/token`·`/register` 등
루트 별칭을 워커가 받아 Better Auth 로 넘긴다(`OAUTH_PATH_ALIASES`).

> [!warning] 이 경로들은 **`wrangler.jsonc` 의 `assets.run_worker_first`** 에도 들어있어야 한다.
> 빠지면 SPA fallback 이 인가 요청을 삼켜 앱 화면이 뜨고 OAuth 가 조용히 실패한다.
> 로컬 dev 는 `vite.web.config.ts` 의 proxy 에도 동일 경로가 필요하다.

## TODO — 남은 작업

웹 전환은 완료했고, 다음은 정식 사용을 위한 남은 항목들이다.

- [x] **Atlassian OAuth 로그인 (= Jira 연결)** — 1클릭 흐름: 연결 버튼 = 로그인. `read:me`로 account_id 를 받아 `sessions` 표(httpOnly `sid` 쿠키)에 저장 → `user` 주입. 미로그인은 `SETUP("setup")` 센텬넬 유저로 OAuth 클라이언트 config 보관, 첫 로그인 즉시 account_id 로 이관. 멀티유저 전환 기반. **와료**(redirect URI 콘솔 등록후 실사용 가능).
- [x] **Jira OAuth state 저장소** — `server/jira.ts`의 `_pending` (in-memory) 폐지 → `oauth_states` D1 표. Workers 멀티인스턴스에서도 connect/callback 이 다른 isolate 에 떨어져 동작. TTL 5분.
- [ ] **Jira redirect URI 등록** — Atlassian 개발자 콘솔에 `https://i-daily.<your-subdomain>.workers.dev/api/jira/callback` 등록 필요(코드는 완료, 콘솔 등록만 남음).
- [ ] **자동업데이트** — 웹은 새로고침이 곧 업데이트. `useAutoUpdate` 훅의 update.* 스텁을 제거하거나 "새로고침" 안내로 교체.
- [ ] **better-sqlite3 제거** — 현재 테스트 전용 devDep 으로 잔존(빠른 in-memory 테스트). D1 기반 테스트(로컬 wrangler D1)로 전환하면 완전 제거 가능.
- [ ] **D1 동시성** — better-sqlite3 동기/단일 프로세스. D1 은 자동커밋 + batch. 다중 워커 배포 시 WAL/단일 인스턴스 정책 점검.
