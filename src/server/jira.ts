// server/jira.ts — Atlassian OAuth 2.0 (3LO) + REST + 로그인(=연결) 통합.
//
// 1클릭 흐름: 클라이언트 GET /api/jira/connect → 인가 URL 반환 → 새 창에서 Atlassian 인가 →
//   /api/jira/callback?code=&state= →
//     1) state 를 D1(oauth_states)에서 회수(CSRF + TTL 검증)         ← in-memory _pending 폐지
//     2) 코드 → 토큰 교환
//     3) /me 로 account_id(신원) + accessible-resources 로 cloudId(사이트) 동시 확보
//     4) 첫 로그인이면 setup 프로파일의 settings 을 account_id 로 이관
//     5) jira_auth[account_id] 저장 + sessions 행 발급(sid 쿠키)
//   → 성공 HTML(팝업이 메인창에 postMessage 로 알림 → 메인창 리로드).
//
// user 키: 미로그인 = SETUP_USER("setup"). 로그인 후 = Atlassian account_id.
// OAuth 클라이언트 자격(client id/secret)은 앱 전역 env(secret) — settings(JSON)가 아닌.
// 첫 로그인 시 setup 프로파일의 user 설정(owner/jiraBase 등)을 account_id 로 복사(공유).
import { randomBytes } from "node:crypto";
import type { Backend } from "../shared/backend.ts";
import { SETUP_USER } from "../shared/backend.ts";
import {
	readJiraAuth,
	writeJiraAuth,
	clearJiraAuth,
	migrateConfig,
	writeOauthState,
	consumeOauthState,
	writeSession,
	deleteSession,
	d1Backend,
	type JiraAuth,
} from "../shared/store-drizzle.ts";
import type { DrizzleD1Database } from "drizzle-orm/d1";

type DB = DrizzleD1Database;

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const RESOURCES_URL =
	"https://api.atlassian.com/oauth/token/accessible-resources";
const ME_URL = "https://api.atlassian.com/me"; // read:me → account_id(신원)
// offline_access → refresh token. read:me → /me 로 account_id 확보(로그인).
// write:jira-work → 마감일(duedate) 역방향 반영. 추가 시 기존 사용자는 재연결(재동의) 필요.
const SCOPES =
	"read:jira-work write:jira-work read:jira-user read:me offline_access";

// 세션 TTL — 30일. httpOnly sid 쿠키와 동일.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type CallbackResult = {
	html: string;
	sid?: string;
	maxAge?: number;
};

// redirect URI: env > 요청 오리진. Atlassian 콘솔에 등록된 값과 일치해야 함.
function redirectUri(origin: string): string {
	const env = (
		globalThis as { process?: { env?: Record<string, string | undefined> } }
	).process?.env?.JIRA_REDIRECT_URI;
	return env || `${origin}/api/jira/callback`;
}

// OAuth 클라이언트 자격(client id/secret) — 앱 전역 secret(env). user 설정이 아님.
// 과거에는 settings JSON 에 저장→ GET /api/days 로 브라우저에 유출되었으므로
// env(wrangler secret)에서만 읽는다. 미설정 시 OAuth 시작 단계에서 명확히 거절.
function clientCreds(): { clientId: string; clientSecret: string } {
	const e = (
		globalThis as { process?: { env?: Record<string, string | undefined> } }
	).process?.env;
	return {
		clientId: (e?.JIRA_CLIENT_ID || "").trim(),
		clientSecret: (e?.JIRA_CLIENT_SECRET || "").trim(),
	};
}

function msg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function esc(s: string): string {
	return s.replace(/[&<>]/g, (c) =>
		c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
	);
}

// ───────────────────────── 상태 ─────────────────────────
// 실제 세션 유효성 검증 — 액세스 토큰이 만료됐으면 refresh 를 시도하고,
// refresh 조차 실패(토큰 무효/폐기)하면 저장된 인증을 지우고 invalid 로 판정해 재로그인을 유도한다.
// (기존에는 토큰 행 존재 여부만 반환해, 만료된 세 션이 '연결됨'으로 보이던 문제 해소)
export async function jiraStatus(backend: Backend, db: DB): Promise<any> {
	const cc = clientCreds();
	const configured = !!(cc.clientId && cc.clientSecret);
	const base = {
		user: backend.user,
		isSetup: backend.user === SETUP_USER,
		configured,
	};
	const t = await readJiraAuth(db, backend.user);
	if (!configured)
		return {
			...base,
			connected: false,
			state: "not-configured",
			reason: "서버에 Jira OAuth 클라이언트가 설정되지 않음",
			site: "",
			siteUrl: "",
			expiresAt: null,
		};
	if (!t)
		return {
			...base,
			connected: false,
			state: "not-connected",
			reason: "Jira에 연결되어 있지 않습니다",
			site: "",
			siteUrl: "",
			expiresAt: null,
		};
	const expired = Date.now() >= t.expiresAt;
	try {
		const vt = await getValidToken(backend, db); // 만료 시 refresh, 실패 시 clear+throw
		return {
			...base,
			connected: true,
			state: expired ? "refreshed" : "ok",
			site: t.siteName || "",
			siteUrl: t.siteUrl || "",
			expiresAt: vt.expiresAt,
		};
	} catch (e) {
		return {
			...base,
			connected: false,
			state: "invalid",
			reason: msg(e) || "Jira 세션 만료 — 다시 로그인하세요.",
			site: t.siteName || "",
			siteUrl: t.siteUrl || "",
			expiresAt: null,
		};
	}
}

// ───────────────────────── OAuth 시작 ─────────────────────────
// 인가 URL 생성 + state 를 D1(oauth_states)에 persist. 클라이언트가 새 창으로 이 URL 을 연다.
// 콜백(/api/jira/callback)이 별도 요청(→다른 isolate 일 수 있음)이므로 in-memory 가 아닌 DB 로 state 를 잇는다.
export async function jiraConnect(
	backend: Backend,
	db: DB,
	origin: string,
): Promise<any> {
	const { clientId, clientSecret } = clientCreds();
	if (!clientId || !clientSecret)
		return {
			ok: false,
			error:
				"Jira OAuth 클라이언트(client id/secret)가 서버에 설정되지 않았습니다. 관리자에게 문의하세요.",
		};
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

	await writeOauthState(db, state, {
		redirectUri: redir,
		fromUser: backend.user, // connect 시작 시 user(첫 로그인: setup / 재연결: account_id)
		createdAt: Date.now(),
	});

	return { ok: true, authorizeUrl: `${AUTHORIZE_URL}?${q}` };
}

// ───────────────────────── 콜백 처리 ─────────────────────────
// Atlassian 이 /api/jira/callback?code=&state= 로 리다이렉트. state 회수 → 토큰 교환 →
// /me 로 account_id 확보 → setup→account_id 마이그레이션 → jira_auth 저장 → 세션 발급.
export async function jiraCallback(
	db: DB,
	code: string | null,
	state: string | null,
	err: string | null,
): Promise<CallbackResult> {
	if (err) return { html: `인가 거부: ${esc(err)}` };
	if (!code || !state) return { html: "인가 코드가 없습니다." };

	const p = await consumeOauthState(db, state);
	if (!p)
		return {
			html: "state 가 만료했거나 일치하지 않습니다. 설정에서 연결 버튼을 다시 누르세요.",
		};

	const { clientId, clientSecret } = clientCreds();
	if (!clientId || !clientSecret)
		return {
			html: "❌ 서버에 Jira OAuth 클라이언트가 설정되지 않았습니다. 관리자에게 문의하세요.",
		};
	try {
		const tok = await exchangeCode(clientId, clientSecret, code, p.redirectUri);
		// 사이트(URL·cloudId)와 신원(account_id·표시이름)을 동시 확보.
		const site = await resolveSite(tok.access_token);
		const me = await resolveMe(tok.access_token);
		const accountId = me.accountId;
		if (!accountId)
			throw new Error("account_id 를 받지 못했습니다(read:me 스코프 확인).");

		// 첫 로그인: setup 프로파일의 settings 을 account_id 로 복사.
		// (fromUser !== account_id && account_id 에 설정 없을 때만. 재연결 no-op.)
		if (p.fromUser === SETUP_USER && accountId !== SETUP_USER) {
			await migrateConfig(db, SETUP_USER, accountId);
		}

		// owner(이름)·jiraBase(호스트 URL)는 설정 입력칸을 없애고 로그인에서 자동 반영.
		// account_id 프로파일 config 에 Jira 표시이름·사이트 URL 을 덮어쓴다.
		const acctBackend = d1Backend(db, accountId);
		const acctCfg = await acctBackend.readConfig();
		await acctBackend.writeConfig({
			...acctCfg,
			owner: me.name || acctCfg.owner,
			jiraBase: site.siteUrl || acctCfg.jiraBase,
		});

		await writeJiraAuth(db, accountId, {
			accessToken: tok.access_token,
			refreshToken: tok.refresh_token,
			expiresAt: Date.now() + (tok.expires_in - 60) * 1000,
			...site,
		});

		const sid = randomBytes(24).toString("hex");
		await writeSession(db, sid, accountId, Date.now() + SESSION_TTL_MS);

		return {
			html: "✅ 로그인되었고 Jira 도 연결되었습니다.",
			sid,
			maxAge: SESSION_TTL_MS / 1000,
		};
	} catch (e) {
		return { html: "❌ 인증 실패: " + esc(msg(e)) };
	}
}

// 코드 → 토큰 교환.
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
	return (await r.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};
}

// 접근 가능한 첫 사이트 → cloudId·URL·이름. jiraBase 입력칸을 없았으므로
// 연결한 사이트를 그대로 채택(다중 사이트이면 첫 번째).
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
	const pick = list[0];
	return { cloudId: pick.id, siteUrl: pick.url, siteName: pick.name };
}

// ───────────────────────── 신원(account_id) ─────────────────────────
// /me (read:me 스코프) 로 로그인 유저의 account_id(=user 키) + 표시이름 확보.
// name 은 설정 ‘이름(owner)’ 자동 채움에 쓰인다(설정 입력칸 폐지).
async function resolveMe(
	accessToken: string,
): Promise<{ accountId: string; name: string }> {
	const r = await fetch(ME_URL, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		},
	});
	if (!r.ok) return { accountId: "", name: "" };
	const j = (await r.json()) as { account_id?: string; name?: string };
	return {
		accountId: (j.account_id || "").trim(),
		name: (j.name || "").trim(),
	};
}

// ───────────────────────── 토큰 갱신 ─────────────────────────
async function getValidToken(backend: Backend, db: DB): Promise<JiraAuth> {
	const t = await readJiraAuth(db, backend.user);
	if (!t)
		throw new Error("Jira 에 연결되어 있지 않습니다. ⚙️ 설정에서 연결하세요.");
	if (Date.now() < t.expiresAt) return t;

	const { clientId, clientSecret } = clientCreds();
	if (!clientId || !clientSecret)
		throw new Error("서버에 Jira OAuth 클라이언트가 설정되지 않았습니다.");
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
		// 우선순위 높은 순이 먼저(표시 정렬은 클라이언트 sortTickets 가 확정).
		const jql = "assignee = currentUser() ORDER BY priority ASC, updated DESC";
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

// ───────────────────────── 마감일 역방향 반영 ─────────────────────────
// 일지에서 마감일을 고치면 실제 티켓의 duedate 도 맞춘다.
// "실제 티켓이 있는 경우만" — 없는 키(404)·권한 없음(403)은 에러가 아니라 조용히 skip.
const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
export const isJiraKey = (k: string): boolean => KEY_RE.test((k || "").trim());

export async function jiraSetDue(
	backend: Backend,
	db: DB,
	keyRaw: string,
	dueRaw: string,
): Promise<any> {
	const key = (keyRaw || "").trim().toUpperCase();
	const due = (dueRaw || "").trim();
	if (!isJiraKey(key)) return { ok: true, skipped: "not-a-key" };
	if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due))
		return { ok: false, error: "날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)." };

	let t: JiraAuth;
	try {
		t = await getValidToken(backend, db);
	} catch {
		// 미연결이면 일지 저장 자체를 막을 이유는 없다 — 조용히 skip.
		return { ok: true, skipped: "not-connected" };
	}
	try {
		const url = `https://api.atlassian.com/ex/jira/${t.cloudId}/rest/api/3/issue/${encodeURIComponent(key)}`;
		const r = await fetch(url, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${t.accessToken}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			// duedate: null → 마감일 해제.
			body: JSON.stringify({ fields: { duedate: due || null } }),
		});
		if (r.status === 204 || r.ok) return { ok: true, key, due };
		// 없는 티켓/권한 없음 → 무시(사용자 흐름을 끊지 않는다).
		if (r.status === 404) return { ok: true, skipped: "not-found", key };
		if (r.status === 401 || r.status === 403)
			return { ok: true, skipped: "forbidden", key };
		return { ok: false, key, error: `Jira ${r.status}: ${await r.text()}` };
	} catch (e) {
		return { ok: false, key, error: msg(e) };
	}
}

// ───────────────────────── 완료 처리(워크플로우 전이) ─────────────────────────
// 워크플로우마다 완료 전이의 이름이 다르다(완료/Done/해결됨/Closed…).
// 이름 대신 to.statusCategory.key === "done" 으로 판별하고, 후보가 여럿이면
// 클라이언트가 서브메뉴로 고르게 목록을 그대로 넘긴다.
// cat = 도착 상태의 statusCategory(new / indeterminate / done) — 칸반 3열과 같은 축.
export type JiraTransition = {
	id: string;
	name: string;
	to: string;
	cat: string;
};

async function transitionsOf(
	t: JiraAuth,
	key: string,
): Promise<JiraTransition[]> {
	const url = `https://api.atlassian.com/ex/jira/${t.cloudId}/rest/api/3/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`;
	const r = await fetch(url, {
		headers: {
			Authorization: `Bearer ${t.accessToken}`,
			Accept: "application/json",
		},
	});
	if (!r.ok) throw new Error(`Jira ${r.status}: ${await r.text()}`);
	const data = (await r.json()) as any;
	// 전이는 워크플로우가 정한 것만 온다 — 전부 넘기고 분류는 클라이언트가 한다.
	return (data.transitions || []).map((x: any) => ({
		id: String(x.id),
		name: x.name || "",
		to: x.to?.name || "",
		cat: x.to?.statusCategory?.key || "",
	}));
}

// 가능한 전이 목록 조회(우클릭 서브메뉴가 열릴 때 호출).
export async function jiraTransitions(
	backend: Backend,
	db: DB,
	keyRaw: string,
): Promise<any> {
	const key = (keyRaw || "").trim().toUpperCase();
	if (!isJiraKey(key)) return { ok: false, error: "티켓 키가 올바르지 않습니다." };
	let t: JiraAuth;
	try {
		t = await getValidToken(backend, db);
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
	try {
		return { ok: true, key, transitions: await transitionsOf(t, key) };
	} catch (e) {
		return { ok: false, key, error: msg(e) };
	}
}

// 선택한 전이 실행. transitionId 가 없으면 완료(done) 후보가 하나일 때만 자동 선택.
export async function jiraTransition(
	backend: Backend,
	db: DB,
	keyRaw: string,
	transitionIdRaw?: string,
): Promise<any> {
	const key = (keyRaw || "").trim().toUpperCase();
	if (!isJiraKey(key)) return { ok: false, error: "티켓 키가 올바르지 않습니다." };
	let t: JiraAuth;
	try {
		t = await getValidToken(backend, db);
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
	try {
		let id = (transitionIdRaw || "").trim();
		let name = "";
		if (!id) {
			const list = (await transitionsOf(t, key)).filter(
				(x) => x.cat === "done",
			);
			if (!list.length)
				return { ok: false, key, error: "완료로 보낼 수 있는 전이가 없습니다." };
			if (list.length > 1)
				return { ok: false, key, error: "완료 전이가 여러 개입니다 — 선택이 필요합니다.", transitions: list };
			id = list[0].id;
			name = list[0].name;
		}
		const url = `https://api.atlassian.com/ex/jira/${t.cloudId}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
		const r = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${t.accessToken}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ transition: { id } }),
		});
		if (r.status === 204 || r.ok) return { ok: true, key, id, name };
		if (r.status === 404)
			return { ok: false, key, error: "티켓을 찾을 수 없습니다." };
		if (r.status === 401 || r.status === 403)
			return { ok: false, key, error: "권한이 없습니다." };
		// 400 = 필수 필드(해결책 등)를 요구하는 워크플로우 — 본문을 그대로 노출해 원인을 알린다.
		return { ok: false, key, error: `Jira ${r.status}: ${await r.text()}` };
	} catch (e) {
		return { ok: false, key, error: msg(e) };
	}
}

// ───────────────────────── 로그아웃(=연결 해제) ─────────────────────────
// jira_auth 만 삭제. 웹 세션은 Better Auth(/api/auth/sign-out)가 담당.
export async function jiraLogout(backend: Backend, db: DB): Promise<any> {
	await clearJiraAuth(db, backend.user);
	return jiraStatus(backend, db);
}
