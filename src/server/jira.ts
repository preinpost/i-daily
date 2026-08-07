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

// ───────────────────────── 업무등록(티켓 생성) ─────────────────────────
// createmeta 로 업무등록 폼을 구성한다(프로젝트 → 이슈타입 → 필드).
// write:jira-work 스코프가 있어 생성/마감일 반영이 가능하다.

// 프로젝트에 배정 가능한 사용자 목록(담당자/보고자 드롭박스용).
// current: 로그인 계정의 accountId(=backend.user) — 폼 기본값(/me)에 쓴다.
export async function jiraProjectUsers(
	backend: Backend,
	db: DB,
	projectKeyRaw: string,
): Promise<any> {
	const projectKey = (projectKeyRaw || "").trim();
	if (!projectKey) return { ok: false, error: "프로젝트 키가 필요합니다." };
	let t: JiraAuth;
	try {
		t = await getValidToken(backend, db);
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
	try {
		const url = `https://api.atlassian.com/ex/jira/${t.cloudId}/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=200`;
		const r = await fetch(url, {
			headers: {
				Authorization: `Bearer ${t.accessToken}`,
				Accept: "application/json",
			},
		});
		if (!r.ok) return { ok: false, error: `Jira ${r.status}: ${await r.text()}` };
		const data = (await r.json()) as any[];
		const users = (Array.isArray(data) ? data : [])
			.filter((u) => !u.accountType || u.accountType !== "app")
			.map((u) => ({
				accountId: u.accountId || "",
				displayName: u.displayName || "",
				emailAddress: u.emailAddress || "",
				active: !!u.active,
			}));
		const isId = (id: string) => users.some((u) => u.accountId === id);
		// 로그인 유저가 배정 목록에 없어도 기본값(/me) 으로 쓸 수 있게 포함시킨다.
		const current = backend.user && backend.user !== "setup" ? backend.user : "";
		if (current && !isId(current)) {
			users.unshift({
				accountId: current,
				displayName: "나 (본인)",
				emailAddress: "",
				active: true,
			});
		}
		return { ok: true, users, current };
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

// 프로젝트 내 이슈 검색(상위 항목/부모 티켓용) — 키 또는 제목으로 검색.
export async function jiraSearchIssues(
	backend: Backend,
	db: DB,
	projectKeyRaw: string,
	qRaw: string,
): Promise<any> {
	const projectKey = (projectKeyRaw || "").trim();
	if (!projectKey) return { ok: false, error: "프로젝트 키가 필요합니다." };
	let t: JiraAuth;
	try {
		t = await getValidToken(backend, db);
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
	const q = (qRaw || "").trim();
	try {
		const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		let jql = `project = ${esc(projectKey)}`;
		if (q) {
			// 티켓 키(IIPQ-123) 형태면 키 정확히, 아니면 텍스트(제목/설명) 부분일치.
			const keyMatch = /^[A-Z][A-Z0-9_]+-\d+$/i.test(q);
			if (keyMatch) jql += ` AND (key = "${q.toUpperCase()}" OR text ~ "${esc(q)}")`;
			else jql += ` AND text ~ "${esc(q)}"`;
		}
		jql += " ORDER BY updated DESC";
		const url = `https://api.atlassian.com/ex/jira/${t.cloudId}/rest/api/3/search/jql?maxResults=25&fields=summary,issuetype,status&jql=${encodeURIComponent(jql)}`;
		const r = await fetch(url, {
			headers: {
				Authorization: `Bearer ${t.accessToken}`,
				Accept: "application/json",
			},
		});
		if (!r.ok) return { ok: false, error: `Jira ${r.status}: ${await r.text()}` };
		const data = (await r.json()) as any;
		const issues = (data.issues || []).map((i: any) => ({
			key: i.key,
			summary: i.fields?.summary || "",
			type: i.fields?.issuetype?.name || "",
			status: i.fields?.status?.name || "",
			url: `${t.siteUrl}/browse/${i.key}`,
		}));
		return { ok: true, issues };
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

// 생성 가능한 프로젝트 + 이슈타입 목록(가볍게).
// Jira 첨부 이미지 프록시 — 세션 토큰으로 attachment 컨텐츠를 받아 렌더러에 서빙.
// 참고: 숫자 id 는 첨부파일(첨부 API로 조회 가능). UUID(fileId) 는 에디터 붙여넣기
// 이미지 — 공개 Media API 가 없어 조회 불가. 저장 시 media 노드(id 보존)로 살아남는다.
export async function jiraImage(
	backend: Backend,
	db: DB,
	idRaw: string,
): Promise<any> {
	const id = (idRaw || "").trim();
	// 첨부(숫자)만 조회 가능. 그 외(UUID 등)는 지원하지 않는다.
	if (!/^[0-9]+$/.test(id)) return { ok: false, error: "unsupported-media" };
	let t: JiraAuth;
	try {
		t = await getValidToken(backend, db);
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
	try {
		const url = `https://api.atlassian.com/ex/jira/${t.cloudId}/rest/api/3/attachment/content/${id}`;
		const r = await fetch(url, {
			headers: {
				Authorization: `Bearer ${t.accessToken}`,
				Accept: "application/octet-stream",
			},
		});
		if (!r.ok) return { ok: false, error: `Jira ${r.status}` };
		const buf = await r.arrayBuffer();
		return {
			ok: true,
			buffer: buf,
			contentType: r.headers.get("content-type") || "application/octet-stream",
		};
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

export async function jiraCreateMeta(backend: Backend, db: DB): Promise<any> {
	let t: JiraAuth;
	try {
		t = await getValidToken(backend, db);
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
	try {
		const url = `https://api.atlassian.com/ex/jira/${t.cloudId}/rest/api/3/issue/createmeta`;
		const r = await fetch(url, {
			headers: {
				Authorization: `Bearer ${t.accessToken}`,
				Accept: "application/json",
			},
		});
		if (!r.ok) return { ok: false, error: `Jira ${r.status}: ${await r.text()}` };
		const data = (await r.json()) as any;
		const projects = (data.projects || []).map((p: any) => ({
			id: p.id,
			key: p.key,
			name: p.name,
			issueTypes: (p.issuetypes || []).map((it: any) => ({
				id: it.id,
				name: it.name,
				subtask: !!it.subtask,
			})),
		}));
		return { ok: true, projects, site: t.siteName };
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

// 프로젝트+이슈타입 조합의 생성 필드(required·type·allowedValues 등)를 가져와서
// 폼을 동적으로 그린다. summary/description/priority/duedate 등 기본 필드와
// 프로젝트별 필수 커스텀 필드까지 한 번에 확보한다.
export async function jiraCreateFields(
	backend: Backend,
	db: DB,
	projectKeyRaw: string,
	issueTypeIdRaw: string,
): Promise<any> {
	const projectKey = (projectKeyRaw || "").trim();
	const issueTypeId = (issueTypeIdRaw || "").trim();
	if (!projectKey || !issueTypeId)
		return { ok: false, error: "프로젝트/이슈타입이 필요합니다." };
	let t: JiraAuth;
	try {
		t = await getValidToken(backend, db);
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
	try {
		const url = `https://api.atlassian.com/ex/jira/${t.cloudId}/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}?maxResults=200`;
		const r = await fetch(url, {
			headers: {
				Authorization: `Bearer ${t.accessToken}`,
				Accept: "application/json",
			},
		});
		if (!r.ok) return { ok: false, error: `Jira ${r.status}: ${await r.text()}` };
		const data = (await r.json()) as any;
		// 응답의 최상위 배열 키는 'fields' (각 항목엔 fieldId/key/name/required/schema/allowedValues).
		const fields = (data.fields || []).map((f: any) => ({
			key: f.key,
			name: f.name,
			required: !!f.required,
			type: f.schema?.type || "",
			system: f.schema?.system || "",
			allowedValues: (f.allowedValues || []).map((av: any) => ({
				id: av.id,
				name: av.name,
				value: av.value,
			})),
		}));
		return { ok: true, fields };
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

// description 은 마크다운(에디터) → ADF 문서로 변환해 전달(Jira 설명은 doc 스키마).
// 제목/목록/코드블록/인용/표/굵게·기울임·취소선·링크·인라인코드 등을 지원한다.
function parseInline(text: string): any[] {
	const out: any[] = [];
	const push = (t: string, marks?: any[]) => {
		if (t) out.push(marks?.length ? { type: "text", marks, text: t } : { type: "text", text: t });
	};
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		// 링크 [label](url)
		if (ch === "[") {
			const close = text.indexOf("]", i);
			if (close > i && text[close + 1] === "(") {
				const endP = text.indexOf(")", close + 2);
				if (endP > close + 2) {
					push(text.slice(i + 1, close), [{ type: "link", attrs: { href: text.slice(close + 2, endP) } }]);
					i = endP + 1;
					continue;
				}
			}
			push(ch);
			i++;
			continue;
		}
		// 인라인 코드
		if (ch === "`") {
			const close = text.indexOf("`", i + 1);
			if (close > i) {
				push(text.slice(i + 1, close), [{ type: "code" }]);
				i = close + 1;
				continue;
			}
		}
		// 굵게
		if (text.startsWith("**", i)) {
			const close = text.indexOf("**", i + 2);
			if (close > i + 1) {
				push(text.slice(i + 2, close), [{ type: "strong" }]);
				i = close + 2;
				continue;
			}
		}
		// 취소선
		if (text.startsWith("~~", i)) {
			const close = text.indexOf("~~", i + 2);
			if (close > i + 1) {
				push(text.slice(i + 2, close), [{ type: "strike" }]);
				i = close + 2;
				continue;
			}
		}
		// 기울임(단일 *)
		if (ch === "*") {
			const close = text.indexOf("*", i + 1);
			if (close > i && text[close + 1] !== "*") {
				push(text.slice(i + 1, close), [{ type: "em" }]);
				i = close + 1;
				continue;
			}
		}
		push(ch);
		i++;
	}
	return out;
}

function splitTableRow(line: string): string[] {
	return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((s) => s.trim());
}

function mdToAdf(text: string): any {
	const content: any[] = [];
	const lines = String(text).split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "") {
			i++;
			continue;
		}
		// 표
		if (/^\s*\|/.test(line)) {
			const rows: string[][] = [];
			while (i < lines.length && /^\s*\|/.test(lines[i])) {
				rows.push(splitTableRow(lines[i]));
				i++;
			}
			if (rows.length) {
				const header = rows[0] || [];
				const body = rows.slice(1).filter((r) => !/^[-:\s|]+$/.test(r.join("|")));
				const cell = (t: string, hd: boolean) => ({
					type: hd ? "tableHeader" : "tableCell",
					content: [{ type: "paragraph", content: parseInline(t) }],
				});
				const headRow = { type: "tableRow", content: header.map((c) => cell(c, true)) };
				const bodyRows = body.map((r) => ({ type: "tableRow", content: r.map((c) => cell(c, false)) }));
				content.push({
					type: "table",
					attrs: { isNumberColumnEnabled: false },
					content: [headRow, ...bodyRows],
				});
			}
			continue;
		}
		// 코드블록
		if (/^\s*(```|~~~)/.test(line)) {
			const lang = line.trim().slice(3).trim();
			const buf: string[] = [];
			i++;
			while (i < lines.length && !/^\s*(```|~~~)/.test(lines[i])) {
				buf.push(lines[i]);
				i++;
			}
			i++; // 닫는 펜스
			content.push({
				type: "codeBlock",
				attrs: lang ? { language: lang } : undefined,
				content: [{ type: "text", text: buf.join("\n") }],
			});
			continue;
		}
		// 제목
		const h = /^(#{1,6})\s+(.*)$/.exec(line);
		if (h) {
			content.push({ type: "heading", attrs: { level: Math.min(h[1].length, 6) }, content: parseInline(h[2]) });
			i++;
			continue;
		}
		// 가로줄
		if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
			content.push({ type: "rule" });
			i++;
			continue;
		}
		// 인용
		if (/^\s*>\s?/.test(line)) {
			const q: string[] = [];
			while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
				q.push(lines[i].replace(/^\s*>\s?/, ""));
				i++;
			}
			content.push({ type: "blockquote", content: [{ type: "paragraph", content: parseInline(q.join("\n")) }] });
			continue;
		}
		// 목록
		const ol = /^\s*\d+\.\s+/.test(line);
		if (ol || /^\s*[-*+]\s+/.test(line)) {
			const re = ol ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/;
			const items: any[] = [];
			while (i < lines.length && re.test(lines[i])) {
				const itemBlocks: any[] = [
					{ type: "paragraph", content: parseInline(lines[i].replace(re, "")) },
				];
				i++;
				// 이 목록 항목에 말린 들여쓰기 이미지 줄 → media 노드로 재구성(보존).
				const imgLine = /^\s*!\[([^\]]*)\]\(([^)]*)\)\s*$/;
				while (i < lines.length && imgLine.test(lines[i])) {
					const m = imgLine.exec(lines[i]);
					const q = (m?.[2] || "").split("?")[1] || "";
					const id = new URLSearchParams(q).get("id") || "";
					if (id)
						itemBlocks.push({
							type: "mediaSingle",
							attrs: { layout: "center" },
							content: [
								{ type: "media", attrs: { id, type: "file", width: 1080, height: 608, alt: m?.[1] || "" } },
							],
						});
					i++;
				}
				items.push({ type: "listItem", content: itemBlocks });
			}
			content.push({ type: ol ? "orderedList" : "bulletList", content: items });
			continue;
		}
		// 이미지 ![alt](src) → media/mediaSingle 재구성(베스트에포트).
		const img = /^\s*!\[([^\]]*)\]\(([^)]*)\)\s*$/.exec(line);
		if (img && img[2].includes("/api/jira/image?id=")) {
			const q = img[2].split("?")[1] || "";
			const id = new URLSearchParams(q).get("id") || "";
			if (id) {
				content.push({
					type: "mediaSingle",
					attrs: { layout: "center" },
					content: [
						{
							type: "media",
							attrs: { id, type: "file", width: 1080, height: 608, alt: img[1] || "" },
						},
					],
				});
				i++;
				continue;
			}
		}
		// 본문(여러 줄 병합)
		const buf: string[] = [line];
		i++;
		while (
			i < lines.length &&
			lines[i].trim() !== "" &&
			!/^\s*(#|\||```|~~~|>\s?|[-*_]\s*([-*_]\s*){2,})/.test(lines[i]) &&
			!/^\s*\d+\.\s+/.test(lines[i]) &&
			!/^\s*[-*+]\s+/.test(lines[i])
		) {
			buf.push(lines[i]);
			i++;
		}
		content.push({ type: "paragraph", content: parseInline(buf.join("\n")) });
	}
	if (!content.length) content.push({ type: "paragraph", content: [] });
	return { version: 1, type: "doc", content };
}

// 티켓 생성. body = { projectKey, issueTypeId, fields }
// fields 는 Jira field key → 값(우리가 그린 폼 값, 이미 Jira 가 원하는 JSON 형태).
export async function jiraCreateIssue(
	backend: Backend,
	db: DB,
	body: any,
): Promise<any> {
	const projectKey = (body?.projectKey || "").trim();
	const issueTypeId = (body?.issueTypeId || "").trim();
	const fields = body?.fields || {};
	if (!projectKey || !issueTypeId)
		return { ok: false, error: "프로젝트/이슈타입이 필요합니다." };
	const summary = String(fields.summary || "").trim();
	if (!summary) return { ok: false, error: "요약(제목)을 입력하세요." };
	// description 이 plain text 로 오면 ADF로 변환.
	if (typeof fields.description === "string" && fields.description.trim())
		fields.description = mdToAdf(fields.description);

	let t: JiraAuth;
	try {
		t = await getValidToken(backend, db);
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
	const payload = {
		fields: {
			project: { key: projectKey },
			issuetype: { id: issueTypeId },
			...fields,
		},
	};
	try {
		const url = `https://api.atlassian.com/ex/jira/${t.cloudId}/rest/api/3/issue`;
		const r = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${t.accessToken}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		const text = await r.text();
		let j: any = {};
		try {
			j = JSON.parse(text);
		} catch {
			/* non-JSON (204 등) */
		}
		if (r.status === 201 || r.ok) {
			return {
				ok: true,
				key: j.key,
				id: j.id,
				url: `${t.siteUrl}/browse/${j.key}`,
				warnings: j.warnings || [],
			};
		}
		if (r.status === 400) {
			if (j.errors)
				return {
					ok: false,
					error:
						"입력값이 올바르지 않습니다: " +
						Object.entries(j.errors)
							.map(([k, v]) => `${k}: ${v}`)
							.join(", "),
				};
			return { ok: false, error: `Jira 400: ${text}` };
		}
		if (r.status === 401 || r.status === 403)
			return { ok: false, error: "Jira 에 작성 권한이 없습니다." };
		return { ok: false, error: `Jira ${r.status}: ${text}` };
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

// ───────────────────────── 티켓 수정 ─────────────────────────
// ADF → 마크다운(에디터 라운드트립) — mdToAdf 의 역방향.
function adfToMd(adf: any): string {
	const inline = (nodes?: any[]): string =>
		(nodes || [])
			.map((n) => {
				if (n.type === "text") {
					let t = n.text || "";
					const has = (k: string) => (n.marks || []).some((m: any) => m.type === k);
					if (has("code")) t = "`" + t + "`";
					if (has("strong")) t = "**" + t + "**";
					if (has("em")) t = "*" + t + "*";
					if (has("strike")) t = "~~" + t + "~~";
					const link = (n.marks || []).find((m: any) => m.type === "link");
					if (link) t = `[${t}](${link.attrs?.href || ""})`;
					return t;
				}
				if (n.type === "hardBreak") return "\n";
				if (n.type === "image" || n.type === "media" || n.type === "mediaSingle") {
					const a = n.type === "mediaSingle" ? n.content?.[0]?.attrs : n.attrs;
					const id = a?.id;
					const src = a?.src || (id ? `/api/jira/image?id=${id}` : "");
					return src ? `![${a?.alt || ""}](${src})` : "";
				}
				return "";
			})
			.join("");
	const imgMd = (n: any): string => {
		const a = n.type === "mediaSingle" ? n.content?.[0]?.attrs : n.attrs;
		const id = a?.id;
		const src = a?.src || (id ? `/api/jira/image?id=${id}` : "");
		return src ? `![${a?.alt || ""}](${src})` : "";
	};
	const block = (node: any, depth = 0): string => {
		switch (node.type) {
			case "paragraph":
				return inline(node.content) + "\n\n";
			case "heading":
				return "#".repeat(Math.min(node.attrs?.level || 1, 6)) + " " + inline(node.content) + "\n\n";
			case "bulletList":
			case "orderedList": {
				const ordered = node.type === "orderedList";
				return (node.content || [])
					.map((li: any, liN: number) => {
						const parts = (li.content || [])
							.map((b: any) =>
								b.type === "paragraph"
									? inline(b.content)
									: b.type === "mediaSingle" || b.type === "media" || b.type === "image"
										? imgMd(b)
										: b.content
											? (b.content as any[])
													.map((x) => block(x, depth + 1))
													.join("")
												: "",
							)
							.filter(Boolean);
						const prefix =
							"\t".repeat(depth) + (ordered ? `${liN + 1}. ` : "- ");
						const first = parts.shift() || "";
						const rest = parts
							.map((p: string) => "\n" + "\t".repeat(depth) + "   " + p)
							.join("");
						return first ? prefix + first + rest : "";
					})
					.filter(Boolean)
					.join("\n") + "\n\n";
			}
			case "codeBlock":
				return "```" + (node.attrs?.language || "") + "\n" + inline(node.content) + "\n```\n\n";
			case "blockquote":
				return (node.content || []).map((b: any) => "> " + inline(b.content)).join("\n") + "\n\n";
			case "rule":
				return "---\n\n";
			case "table": {
				// 셀은 블록(문단·이미지 등)을 포함할 수 있으므로 block() 으로 렌더한다.
				const cellMd = (c: any) =>
					(c.content || [])
						.map((b: any) => block(b))
						.join(" ")
						.replace(/\s+/g, " ")
						.trim();
				const rows = (node.content || []).map((row: any) =>
					(row.content || []).map(cellMd),
				);
				const lines = rows.map((r: string[]) => `| ${r.join(" | ")} |`);
				if (lines.length && rows[0].some((x: string) => x)) {
					const sep = `| ${rows[0].map(() => "---").join(" | ")} |`;
					lines.splice(1, 0, sep);
				}
				return lines.join("\n") + "\n\n";
			}
			case "mediaSingle":
			case "media":
			case "image": {
				// Jira 첨부 이미지 → 프록시 URL 로 마크다운 이미지 변환.
				const attrs =
					node.type === "mediaSingle" ? node.content?.[0]?.attrs : node.attrs;
				const id = attrs?.id;
				const src = attrs?.src || (id ? `/api/jira/image?id=${id}` : "");
				if (!src) return "";
				return `![${attrs?.alt || ""}](${src})\n\n`;
			}
			default:
				return (node.content ? (node.content as any[]).map((x) => block(x, depth)).join("") : "");
		}
	};
	const body = (adf?.content || []).map((n: any) => block(n)).join("");
	return body.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// 티켓 상세 — 수정 폼 초기값 구성용.
export async function jiraGetIssue(
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
		const url = `https://api.atlassian.com/ex/jira/${t.cloudId}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,priority,duedate,labels,components,assignee,reporter,issuetype,project,parent,status`;
		const r = await fetch(url, {
			headers: {
				Authorization: `Bearer ${t.accessToken}`,
				Accept: "application/json",
			},
		});
		if (!r.ok) {
			if (r.status === 404) return { ok: false, error: "티켓을 찾을 수 없습니다." };
			return { ok: false, error: `Jira ${r.status}: ${await r.text()}` };
		}
		const d = (await r.json()) as any;
		const f = d.fields || {};
		return {
			ok: true,
			key: d.key,
			summary: f.summary || "",
			descriptionMd: f.description ? adfToMd(f.description) : "",
			projectKey: f.project?.key || "",
			issueTypeId: f.issuetype?.id || "",
			issueTypeName: f.issuetype?.name || "",
			priority: f.priority ? { id: f.priority.id, name: f.priority.name } : null,
			duedate: f.duedate || "",
			labels: f.labels || [],
			components: (f.components || []).map((c: any) => ({ id: c.id, name: c.name })),
			assignee: f.assignee
				? { accountId: f.assignee.accountId, displayName: f.assignee.displayName }
				: null,
			reporter: f.reporter
				? { accountId: f.reporter.accountId, displayName: f.reporter.displayName }
				: null,
			parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || "" } : null,
			status: f.status?.name || "",
			url: `${t.siteUrl}/browse/${d.key}`,
		};
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

// 수정 가능한 필드 메타(editmeta). project/issuetype 등 고정 필드는 제외되어 온다.
export async function jiraEditMeta(
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
		const url = `https://api.atlassian.com/ex/jira/${t.cloudId}/rest/api/3/issue/${encodeURIComponent(key)}/editmeta?maxResults=200`;
		const r = await fetch(url, {
			headers: {
				Authorization: `Bearer ${t.accessToken}`,
				Accept: "application/json",
			},
		});
		if (!r.ok) return { ok: false, error: `Jira ${r.status}: ${await r.text()}` };
		const data = (await r.json()) as any;
		const map = data.fields || {};
		const fields = Object.entries(map).map(([k, v]: any) => ({
			key: k,
			name: v.name || "",
			required: !!v.required,
			type: v.schema?.type || "",
			system: v.schema?.system || "",
			allowedValues: (v.allowedValues || []).map((av: any) => ({
				id: av.id,
				name: av.name,
				value: av.value,
			})),
		}));
		return { ok: true, fields };
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

// 티켓 수정(변경할 필드만 PUT). description 마크다운 → ADF 변환.
export async function jiraEditIssue(
	backend: Backend,
	db: DB,
	keyRaw: string,
	fields: any,
): Promise<any> {
	const key = (keyRaw || "").trim().toUpperCase();
	if (!isJiraKey(key)) return { ok: false, error: "티켓 키가 올바르지 않습니다." };
	let t: JiraAuth;
	try {
		t = await getValidToken(backend, db);
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
	const editable = { ...(fields || {}) };
	if (typeof editable.description === "string" && editable.description.trim())
		editable.description = mdToAdf(editable.description);
	try {
		const url = `https://api.atlassian.com/ex/jira/${t.cloudId}/rest/api/3/issue/${encodeURIComponent(key)}`;
		const r = await fetch(url, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${t.accessToken}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ fields: editable }),
		});
		if (r.status === 204 || r.ok) return { ok: true, key };
		const text = await r.text();
		if (r.status === 400) {
			let j: any = {};
			try {
				j = JSON.parse(text);
			} catch {
				/* noop */
			}
			if (j.errors)
				return {
					ok: false,
					error:
						"입력값이 올바르지 않습니다: " +
						Object.entries(j.errors)
							.map(([k, v]) => `${k}: ${v}`)
							.join(", "),
				};
			return { ok: false, error: `Jira 400: ${text}` };
		}
		if (r.status === 401 || r.status === 403)
			return { ok: false, error: "Jira 에 편집 권한이 없습니다." };
		return { ok: false, error: `Jira ${r.status}: ${text}` };
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

// ───────────────────────── 로그아웃(=연결 해제) ─────────────────────────
// jira_auth 만 삭제. 웹 세션은 Better Auth(/api/auth/sign-out)가 담당.
export async function jiraLogout(backend: Backend, db: DB): Promise<any> {
	await clearJiraAuth(db, backend.user);
	return jiraStatus(backend, db);
}
