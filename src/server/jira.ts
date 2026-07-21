// server/jira.ts — Jira OAuth 2.0 (3LO) + REST (서버 측). main/jira.ts 이식.
//
// 핵심 재설계: 데스크톱의 loopback 콜백(127.0.0.1:port) → 서버 라우트 콜백(/api/jira/callback).
// 흐름: 클라이언트 GET /api/jira/connect → 인가 URL 반환 → 새 창에서 Atlassian 인가 →
//       /api/jira/callback?code=...&state=... → 토큰 교환 → jira_auth(D1) 저장 → 성공 페이지.
//
// 인가 진행 상태(state → resolve/reject)는 in-memory. 단일 인스턴스 전제(PoC).
// Workers는 인스턴스가 무상태/격리되므로, 정식에선 state를 D1/KV/쿠키에 저장해야 한다.
// 지금은 로컬 dev 검증용 — 클라이언트가 /api/jira/connect 를 poll 하거나 페이지에서 확인.
//
// 토큰 저장: D1 jira_auth(store-drizzle.ts). config(jiraClientId/Secret/Base)는 Backend.
import { randomBytes } from "node:crypto";
import type { Backend } from "../shared/backend.ts";
import {
	readJiraAuth,
	writeJiraAuth,
	clearJiraAuth,
	type JiraAuth,
} from "../shared/store-drizzle.ts";
import type { DrizzleD1Database } from "drizzle-orm/d1";

type DB = DrizzleD1Database;

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const RESOURCES_URL =
	"https://api.atlassian.com/oauth/token/accessible-resources";
// read:me(신원)는 3단계 로그인용 예비. offline_access → refresh token.
const SCOPES = "read:jira-work read:jira-user read:me offline_access";

// 인가 진행 상태. Workers 멀티인스턴스에선 불충분 → PoC 이후 state 저장소 도입.
let _pending: {
	state: string;
	resolve: (code: string) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
} | null = null;

// redirect URI: env > 요청 오리진. Atlassian 콘솔에 등록된 값과 일치해야 함.
function redirectUri(origin: string): string {
	const env = (
		globalThis as { process?: { env?: Record<string, string | undefined> } }
	).process?.env?.JIRA_REDIRECT_URI;
	return env || `${origin}/api/jira/callback`;
}

function msg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// ───────────────────────── 상태 ─────────────────────────
export async function jiraStatus(backend: Backend, db: DB): Promise<any> {
	const cfg = await backend.readConfig();
	const t = await readJiraAuth(db, backend.user);
	return {
		configured: !!(cfg.jiraClientId && cfg.jiraClientSecret),
		connected: !!t,
		site: t?.siteName || "",
		siteUrl: t?.siteUrl || "",
	};
}

// jira* 함수들은 Drizzle db 를 명시 파라미터로 받는다(store-drizzle 함수들이 DB 를 요구).

// ───────────────────────── OAuth 시작 ─────────────────────────
// 인가 URL 생성 + 진행 상태 등록. 클라이언트가 새 창으로 이 URL 을 연다.
// 콜백(/api/jira/callback)이 코드를 잡으면 이 Promise 가 resolve 된다.
export async function jiraConnect(
	backend: Backend,
	db: DB,
	origin: string,
): Promise<any> {
	const cfg = await backend.readConfig();
	const clientId = (cfg.jiraClientId || "").trim();
	const clientSecret = (cfg.jiraClientSecret || "").trim();
	if (!clientId || !clientSecret)
		return {
			ok: false,
			error: "먼저 ⚙️ 설정에 Jira client id / secret 을 입력하세요.",
		};

	// 이전 대기가 있으면 취소(재시도).
	if (_pending) {
		clearTimeout(_pending.timer);
		const prev = _pending;
		_pending = null;
		prev.reject(new Error("replaced"));
	}

	const state = randomBytes(16).toString("hex");
	const redir = redirectUri(origin);
	const q = new URLSearchParams({
		audience: "api.atlassian.com",
		client_id: clientId,
		scope: SCOPES,
		redirect_uri: redir,
		state,
		response_type: "code",
		prompt: "consent",
	});

	return new Promise<any>((resolve) => {
		const timer = setTimeout(
			() => {
				if (_pending && _pending.timer === timer) {
					_pending = null;
					resolve({
						ok: false,
						error: "인증 시간 초과(3분). 다시 시도하세요.",
					});
				}
			},
			3 * 60 * 1000,
		);
		_pending = {
			state,
			resolve: (code) => {
				// 콜백이 코드를 주면 토큰 교환으로 이어진다.
				exchangeAndSave(backend, db, clientId, clientSecret, code, redir)
					.then(() => resolve({ ok: true }))
					.catch((e) => resolve({ ok: false, error: msg(e) }));
			},
			reject: (e) => resolve({ ok: false, error: msg(e) }),
			timer,
		};
		resolve({ ok: true, authorizeUrl: `${AUTHORIZE_URL}?${q}` });
	});
}

// ───────────────────────── 콜백 처리 ─────────────────────────
// Atlassian 이 /api/jira/callback?code=&state= 로 리다이렉트. 여기서 _pending 을 확정.
export async function jiraCallback(
	backend: Backend,
	db: DB,
	origin: string,
	code: string | null,
	state: string | null,
	err: string | null,
): Promise<string> {
	// 콜백이 인가 시작(jiraConnect) 보다 먼저 도착할 수 없다(인가 URL 을 먼저 받아야 함).
	// 하지만 클라이언트가 authorizeUrl 을 아직 안 열었을 수도 → _pending 없으면 안내.
	if (err) {
		if (_pending) {
			clearTimeout(_pending.timer);
			_pending = null;
		}
		return `인가 거부: ${err}`;
	}
	if (!code || !state) return "인가 코드가 없습니다.";
	const cur = _pending;
	if (!cur)
		return "인가 대기 중이 아닙니다. 설정에서 연결 버튼을 다시 누르세요.";
	if (state !== cur.state) {
		clearTimeout(cur.timer);
		_pending = null;
		return "state 불일치(재시도).";
	}
	clearTimeout(cur.timer);
	_pending = null;
	try {
		await exchangeAndSave(
			backend,
			db,
			(await backend.readConfig()).jiraClientId,
			(await backend.readConfig()).jiraClientSecret,
			code,
			redirectUri(origin),
		);
		return "✅ 연결되었습니다. 이 창을 닫고 i-daily 로 돌아가세요.";
	} catch (e) {
		return "❌ 인증 실패: " + msg(e);
	}
}

// 코드 → 토큰 교환 → accessible-resources 로 cloudId 해석 → jira_auth 저장.
async function exchangeAndSave(
	backend: Backend,
	db: DB,
	clientId: string,
	clientSecret: string,
	code: string,
	redir: string,
): Promise<void> {
	const tok = await exchangeCode(clientId, clientSecret, code, redir);
	const site = await resolveSite(backend, tok.access_token);
	await writeJiraAuth(db, backend.user, {
		accessToken: tok.access_token,
		refreshToken: tok.refresh_token,
		expiresAt: Date.now() + (tok.expires_in - 60) * 1000,
		...site,
	});
}

async function exchangeCode(
	clientId: string,
	clientSecret: string,
	code: string,
	redir: string,
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
			redirect_uri: redir,
		}),
	});
	if (!r.ok) throw new Error(`토큰 교환 실패 (${r.status}): ${await r.text()}`);
	return (await r.json()) as any;
}

// 접근 사이트 → cloudId. jiraBase 호스트와 일치하는 사이트 우선.
async function resolveSite(
	backend: Backend,
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
	const cfg = await backend.readConfig();
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

// ───────────────────────── 토큰 갱신 ─────────────────────────
async function getValidToken(backend: Backend, db: DB): Promise<JiraAuth> {
	const t = await readJiraAuth(db, backend.user);
	if (!t)
		throw new Error("Jira 에 연결되어 있지 않습니다. ⚙️ 설정에서 연결하세요.");
	if (Date.now() < t.expiresAt) return t;

	const cfg = await backend.readConfig();
	const clientId = (cfg.jiraClientId || "").trim();
	const clientSecret = (cfg.jiraClientSecret || "").trim();
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
		await clearJiraAuth(db, backend.user);
		throw new Error(`세션 갱신 실패 (${r.status}) — 다시 연결하세요.`);
	}
	const j = (await r.json()) as any;
	const next: JiraAuth = {
		...t,
		accessToken: j.access_token,
		refreshToken: j.refresh_token || t.refreshToken,
		expiresAt: Date.now() + (j.expires_in - 60) * 1000,
	};
	await writeJiraAuth(db, backend.user, next);
	return next;
}

// ───────────────────────── 내 티켓 조회 ─────────────────────────
export async function jiraTickets(backend: Backend, db: DB): Promise<any> {
	let t: JiraAuth;
	try {
		t = await getValidToken(backend, db);
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
	try {
		const jql = "assignee = currentUser() ORDER BY updated DESC";
		const fields = "summary,status,priority,duedate,updated,issuetype,project";
		const base = `https://api.atlassian.com/ex/jira/${t.cloudId}/rest/api/3/search/jql`;
		const out: any[] = [];
		let pageToken = "";
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
		statusCat: f.status?.statusCategory?.key || "",
		priority: f.priority?.name || "",
		type: f.issuetype?.name || "",
		due: f.duedate || "",
		updated: f.updated || "",
		project: f.project?.key || "",
		url: `${siteUrl}/browse/${i.key}`,
	};
}

export async function jiraLogout(backend: Backend, db: DB): Promise<any> {
	await clearJiraAuth(db, backend.user);
	return jiraStatus(backend, db);
}
