// main/jira.ts — Jira OAuth 2.0 (3LO) + REST. MCP 스타일:
//   브라우저 인가(auth.atlassian.com) → 로컬 콜백(loopback) 캐치 → 토큰 교환 →
//   accessible-resources로 cloudId 해석 → api.atlassian.com/ex/jira/{cloudId}/... 호출.
//
// 토큰은 sqlite jira_auth 테이블(user별 JSON)에 평문 저장. access token(1h)
// 만료 시 refresh token(회전)으로 자동 갱신. client_id/secret 은 settings(DB config)에서 읽는다.
// (safeStorage/Keychain 은 macOS 로그인 비번 팝업을 유발해 제거. 로컬 단일유저 위협모델.)
//
// 사전 준비(1회, 사용자): developer.atlassian.com → OAuth 2.0 (3LO) 앱 생성 →
//   Callback URL 에 정확히 `http://localhost:43117/callback` 등록 →
//   Permissions 에 Jira API 추가(read:jira-work, read:jira-user) →
//   Settings 의 client id/secret 을 ⚙️ 설정에 붙여넣기.
import { app, ipcMain, shell } from "electron";
import { createServer, type Server } from "node:http";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import {
	readConfig,
	readJiraAuth,
	writeJiraAuth,
	clearJiraAuth,
	type JiraAuth,
} from "../shared/store.ts";

const CALLBACK_PORT = 43117;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const RESOURCES_URL =
	"https://api.atlassian.com/oauth/token/accessible-resources";
// offline_access → refresh token 발급. read:jira-work(이슈), read:jira-user(currentUser 해석).
const SCOPES = "read:jira-work read:jira-user offline_access";

type Tokens = JiraAuth;

let _db: Database.Database;
let _user = "local";

// loopback 콜백 서버는 앱 생애에 한 번만 띄우고 재사용(포트 재바인딩 경합 방지).
// 진행 중 인가 1건만 유지 — 재클릭 시 이전 것을 취소하고 새로 시작.
let _server: Server | null = null;
let _pending: {
	state: string;
	resolve: (code: string) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
} | null = null;

export function setupJira(db: Database.Database, user: string): void {
	_db = db;
	_user = user;
	// 레거시: safeStorage 로 쓰던 userData/jira-auth.json 정리(더 이상 읽지 않음).
	try {
		const legacy = join(app.getPath("userData"), "jira-auth.json");
		if (existsSync(legacy)) unlinkSync(legacy);
	} catch {
		/* noop */
	}

	ipcMain.handle("jira:status", () => statusPayload());
	ipcMain.handle("jira:connect", () => connect());
	ipcMain.handle("jira:logout", () => {
		clearTokens();
		return statusPayload();
	});
	ipcMain.handle("jira:tickets", () => tickets());
}

// ───────────────────────── 토큰 저장(sqlite jira_auth) ─────────────────────────
function saveTokens(t: Tokens): void {
	writeJiraAuth(_db, _user, t);
}
function loadTokens(): Tokens | null {
	return readJiraAuth(_db, _user);
}
function clearTokens(): void {
	clearJiraAuth(_db, _user);
}

function creds(): { clientId: string; clientSecret: string } {
	const cfg = readConfig(_db, _user) as any;
	return {
		clientId: (cfg.jiraClientId || "").trim(),
		clientSecret: (cfg.jiraClientSecret || "").trim(),
	};
}

// ───────────────────────── OAuth 3LO 흐름 ─────────────────────────
async function connect(): Promise<any> {
	const { clientId, clientSecret } = creds();
	if (!clientId || !clientSecret) {
		return {
			ok: false,
			error: "먼저 ⚙️ 설정에 Jira client id / secret 을 입력하세요.",
		};
	}
	try {
		const state = randomBytes(16).toString("hex");
		const code = await runOAuth(clientId, state);
		const tok = await exchangeCode(clientId, clientSecret, code);
		const site = await resolveSite(tok.access_token);
		saveTokens({
			accessToken: tok.access_token,
			refreshToken: tok.refresh_token,
			expiresAt: Date.now() + (tok.expires_in - 60) * 1000,
			...site,
		});
		return { ok: true, ...statusPayload() };
	} catch (e) {
		const m = msg(e);
		if (m === "replaced") return { ok: false, replaced: true }; // 재시도로 대체됨 — 조용히
		return { ok: false, error: m };
	}
}

// 콜백 서버는 한 번만 띄우고 재사용. 진행 중 인가 1건(_pending)만 유지한다.
function ensureServer(): Promise<void> {
	if (_server) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			const u = new URL(req.url || "/", REDIRECT_URI);
			if (u.pathname !== "/callback") {
				res.writeHead(404);
				res.end();
				return;
			}
			const err = u.searchParams.get("error");
			const gotState = u.searchParams.get("state");
			const gotCode = u.searchParams.get("code");
			const cur = _pending;
			const ok = !err && !!gotCode && !!cur && gotState === cur.state;
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(
				`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;padding:48px;text-align:center;color:#222">` +
					`<h2>${ok ? "\u2705 \uc5f0\uacb0\ub418\uc5c8\uc2b5\ub2c8\ub2e4" : "\u274c \uc778\uc99d \uc2e4\ud328"}</h2>` +
					`<p>\uc774 \ucc3d\uc744 \ub2eb\uace0 i-daily \ub85c \ub3cc\uc544\uac00\uc138\uc694.</p></body>`,
			);
			if (!cur) return; // 대기 중인 인가 없음(중복 콜백 등) → 무시
			clearTimeout(cur.timer);
			_pending = null;
			if (err) return cur.reject(new Error(`인가 거부: ${err}`));
			if (!gotCode) return cur.reject(new Error("인가 코드가 없습니다."));
			if (gotState !== cur.state)
				return cur.reject(new Error("state 불일치(재시도)."));
			cur.resolve(gotCode);
		});
		server.on("error", reject); // EADDRINUSE 등 → connect()에서 표면화
		server.listen(CALLBACK_PORT, "127.0.0.1", () => {
			_server = server;
			resolve();
		});
	});
}

// 인가 URL을 기본 브라우저로 열고 콜백 코드를 기다린다(RFC 8252 native app 패턴).
// 재클릭 시 이전 대기를 취소하고 새로 연다 → 포트 재바인딩/버튼 잠김 문제 없음.
async function runOAuth(clientId: string, state: string): Promise<string> {
	await ensureServer();
	if (_pending) {
		// 이전 시도 취소
		clearTimeout(_pending.timer);
		const prev = _pending;
		_pending = null;
		prev.reject(new Error("replaced")); // 새 인증 시도로 대체
	}
	return new Promise<string>((resolve, reject) => {
		const timer = setTimeout(
			() => {
				if (_pending && _pending.timer === timer) {
					_pending = null;
					reject(new Error("인증 시간 초과(3분). 다시 시도하세요."));
				}
			},
			3 * 60 * 1000,
		);
		_pending = { state, resolve, reject, timer };
		const q = new URLSearchParams({
			audience: "api.atlassian.com",
			client_id: clientId,
			scope: SCOPES,
			redirect_uri: REDIRECT_URI,
			state,
			response_type: "code",
			prompt: "consent",
		});
		void shell.openExternal(`${AUTHORIZE_URL}?${q}`).catch((e) => {
			if (_pending && _pending.timer === timer) {
				clearTimeout(timer);
				_pending = null;
				reject(new Error("브라우저 열기 실패: " + msg(e)));
			}
		});
	});
}

async function exchangeCode(
	clientId: string,
	clientSecret: string,
	code: string,
): Promise<{
	access_token: string;
	refresh_token: string;
	expires_in: number;
}> {
	const r = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: clientId,
			client_secret: clientSecret,
			code,
			redirect_uri: REDIRECT_URI,
		}),
	});
	if (!r.ok) throw new Error(`토큰 교환 실패 (${r.status}): ${await r.text()}`);
	return (await r.json()) as any;
}

// 접근 가능한 사이트 목록 → cloudId. jiraBase 호스트와 일치하는 사이트를 우선 선택.
async function resolveSite(
	accessToken: string,
): Promise<{ cloudId: string; siteUrl: string; siteName: string }> {
	const r = await fetch(RESOURCES_URL, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		},
	});
	if (!r.ok) throw new Error(`사이트 조회 실패 (${r.status})`);
	const list = (await r.json()) as Array<{
		id: string;
		url: string;
		name: string;
	}>;
	if (!list.length) throw new Error("접근 가능한 Jira 사이트가 없습니다.");
	const cfg = readConfig(_db, _user);
	const wantHost = (cfg.jiraBase || "")
		.replace(/^https?:\/\//, "")
		.replace(/\/.*$/, "")
		.toLowerCase();
	const pick =
		(wantHost &&
			list.find((s) => (s.url || "").toLowerCase().includes(wantHost))) ||
		list[0];
	return { cloudId: pick.id, siteUrl: pick.url, siteName: pick.name };
}

// 유효 토큰 확보. 만료면 refresh(회전 토큰 저장). 실패 시 토큰 폐기 후 에러.
async function getValidToken(): Promise<Tokens> {
	const t = loadTokens();
	if (!t)
		throw new Error("Jira 에 연결되어 있지 않습니다. ⚙️ 설정에서 연결하세요.");
	if (Date.now() < t.expiresAt) return t;

	const { clientId, clientSecret } = creds();
	const r = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: t.refreshToken,
		}),
	});
	if (!r.ok) {
		clearTokens();
		throw new Error(`세션 갱신 실패 (${r.status}) — 다시 연결하세요.`);
	}
	const j = (await r.json()) as any;
	const next: Tokens = {
		...t,
		accessToken: j.access_token,
		refreshToken: j.refresh_token || t.refreshToken, // rotation 대응
		expiresAt: Date.now() + (j.expires_in - 60) * 1000,
	};
	saveTokens(next);
	return next;
}

// ───────────────────────── 내 티켓 조회 ─────────────────────────
async function tickets(): Promise<any> {
	let t: Tokens;
	try {
		t = await getValidToken();
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
	try {
		// assignee 제약이 있어 "무제한 JQL" 에러를 피한다. 상태 무관 전체 → 클라이언트에서 그룹핑.
		const jql = "assignee = currentUser() ORDER BY updated DESC";
		const fields = "summary,status,priority,duedate,updated,issuetype,project";
		const base = `https://api.atlassian.com/ex/jira/${t.cloudId}/rest/api/3/search/jql`;
		const out: any[] = [];
		let pageToken = "";
		// nextPageToken 페이징(최대 5페이지=500건 안전장치).
		for (let i = 0; i < 5; i++) {
			const q = new URLSearchParams({ jql, fields, maxResults: "100" });
			if (pageToken) q.set("nextPageToken", pageToken);
			const r = await fetch(`${base}?${q}`, {
				headers: {
					Authorization: `Bearer ${t.accessToken}`,
					Accept: "application/json",
				},
			});
			if (!r.ok)
				return { ok: false, error: `Jira ${r.status}: ${await r.text()}` };
			const data = (await r.json()) as any;
			for (const it of data.issues || []) out.push(mapIssue(it, t.siteUrl));
			if (!data.nextPageToken) break;
			pageToken = data.nextPageToken;
		}
		return { ok: true, tickets: out, site: t.siteName, siteUrl: t.siteUrl };
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

function mapIssue(i: any, siteUrl: string): any {
	const f = i.fields || {};
	return {
		key: i.key,
		summary: f.summary || "",
		status: f.status?.name || "",
		statusCat: f.status?.statusCategory?.key || "", // new | indeterminate | done
		priority: f.priority?.name || "",
		type: f.issuetype?.name || "",
		due: f.duedate || "",
		updated: f.updated || "",
		project: f.project?.key || "",
		url: `${siteUrl}/browse/${i.key}`,
	};
}

function statusPayload(): any {
	const { clientId, clientSecret } = creds();
	const t = loadTokens();
	return {
		configured: !!(clientId && clientSecret),
		connected: !!t,
		site: t?.siteName || "",
		siteUrl: t?.siteUrl || "",
		redirectUri: REDIRECT_URI,
	};
}

function msg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
