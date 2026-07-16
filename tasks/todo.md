# i-daily → Electron 데스크톱 앱 전환 (Win/macOS/Linux)

방향: **데스크톱 전용**. Bun/Cloudflare 폐기 → Node 포팅 + IPC 네이티브 + better-sqlite3 + electron-vite/electron-builder.

## 체크리스트

- [x] 브랜치 `electron-migration` 생성
- [x] 디렉터리 재구성(git mv 이력 보존): `src/{main,preload,shared,renderer}`
- [x] `store.ts` bun:sqlite → better-sqlite3 포팅(`db.query`→`prepare`, `run`→`exec`, `pragma()`), `openDb(path)` 추가, fsStore node:fs
- [x] `model.ts` Windows용 HOME/USERPROFILE 폴백
- [x] `api.ts` — server.ts `handle(Request)` → 전송 무관 `route(method,path,body,user,db)` 추출(Cf-Access 제거)
- [x] `main/index.ts` — 창·IPC('api')·DB(userData)·window.open→외부 브라우저
- [x] `preload/index.ts` — contextBridge `window.api.request`
- [x] `renderer/client.js` — `api()` 본문만 IPC로 교체(나머지 무손상)
- [x] `renderer/index.html` — 절대경로 `/client.js` → module `./client.js`(file:// 대응)
- [x] `electron.vite.config.ts` · `electron-builder.yml`(3-OS·asarUnpack) · tsconfig(bun 타입 제거) · package.json 스크립트
- [x] 테스트 포팅: bun:test → node:test(`tiny.ts` shim), 경로 `../src/shared/*` + `api.test.ts` 신규
- [x] `postinstall: electron-builder install-app-deps`, `test`는 Electron-as-Node 실행
- [x] README 갱신

## 검증 결과

- `npm run typecheck` ✅
- `npm run build` ✅ (main 21KB · preload 0.2KB · renderer html+assets)
- `npm test` ✅ **13/13** (route 5 · model 5 · store 3) — Electron ABI에서 실행
- `npm run dev` ✅ 실제 Electron 앱 부팅: 렌더러 프로세스 생존, 로그 오류 0,
  `~/Library/Application Support/i-daily/i-daily.db` 생성(스키마 7테이블+뷰) → 실런타임 better-sqlite3 로드 확인
- 빌드 산출물 IPC 배선 확인: preload `exposeInMainWorld("api")`+`ipcRenderer.invoke`, 렌더러 `window.api.request`, main `"api"`→`route(...)`

## 남은 것(후속)

- [ ] `build/icon.{icns,ico,png}` 아이콘(현재 기본 아이콘)
- [ ] `npm run dist:*` 실제 패키징 산출(로컬은 mac만, win/linux는 CI 매트릭스 권장)
- [ ] (선택) `.github/workflows/build.yml` 3-OS 매트릭스
- [ ] (선택) 코드 서명/공증(정식 배포 시)

## Review

- REST 경계(`api()` 래퍼 1함수)가 격리돼 있어 전송만 IPC로 교체 → client.js 200+줄·UI 무손상.
- `Store` 인터페이스 + `docToRows/rowsToDoc`가 이미 드라이버 무관이라 sqlite 드라이버 스왑이 기계적.
- 네이티브 ABI 핑퐁은 테스트도 Electron-as-Node로 실행해 단일 ABI로 통일(리빌드 불필요).
