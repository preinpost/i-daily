// mcp/server.ts — MCP 2026-07-28 읽기 전용 서버 factory (PoC).
// createMcpHandler 가 요청마다 이 factory 를 호출한다. 쓰기는 등록하지 않는다.
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { d1Backend } from "../shared/store-drizzle.ts";
import {
	todayStr,
	dayResponse,
	serializeDoc,
	type Doc,
} from "../shared/model.ts";

export type McpProps = {
	accountId: string;
	name: string;
};

const DATE = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
	.optional()
	.describe("날짜(YYYY-MM-DD). 생략 시 오늘");

function text(payload: unknown) {
	const body =
		typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
	return { content: [{ type: "text" as const, text: body }] };
}

function err(message: string) {
	return text({ ok: false, error: message });
}

function requireProps(): McpProps | null {
	const auth = getMcpAuthContext();
	const accountId = String(auth?.props?.accountId || "").trim();
	if (!accountId) return null;
	return {
		accountId,
		name: String(auth?.props?.name || "").trim(),
	};
}

function resolveDate(date?: string): string {
	return date || todayStr();
}

/** 요청마다 새 서버. env 는 fetch 클로저에서 주입. */
export function createIDailyMcpServer(env: Env): McpServer {
	const server = new McpServer({
		name: "i-daily",
		version: "0.2.31",
	});

	server.registerTool(
		"whoami",
		{
			description: "현재 MCP 인가 사용자(Atlassian account_id)를 반환한다.",
			inputSchema: {},
		},
		async () => {
			const props = requireProps();
			if (!props) return err("unauthorized");
			return text({ ok: true, ...props });
		},
	);

	server.registerTool(
		"list_days",
		{
			description: "업무일지 날짜 목록과 오늘·설정 요약을 반환한다(읽기).",
			inputSchema: {},
		},
		async () => {
			const props = requireProps();
			if (!props) return err("unauthorized");
			const db = drizzle(env.DB);
			const backend = d1Backend(db, props.accountId);
			const cfg = await backend.readConfig();
			return text({
				ok: true,
				days: await backend.store.list(),
				today: todayStr(),
				user: props.accountId,
				owner: cfg.owner,
				jiraBase: cfg.jiraBase,
			});
		},
	);

	server.registerTool(
		"get_day",
		{
			description: "특정 날짜 업무일지 전체 Doc 을 반환한다(읽기).",
			inputSchema: { date: DATE },
		},
		async ({ date }) => {
			const props = requireProps();
			if (!props) return err("unauthorized");
			const d = resolveDate(date);
			const db = drizzle(env.DB);
			const backend = d1Backend(db, props.accountId);
			const doc = await backend.store.get(d);
			if (!doc) return err(`not found: ${d}`);
			const cfg = await backend.readConfig();
			return text({ ok: true, ...dayResponse(cfg.jiraBase, doc) });
		},
	);

	server.registerTool(
		"get_day_markdown",
		{
			description: "특정 날짜 업무일지를 마크다운 문자열로 반환한다(읽기).",
			inputSchema: { date: DATE },
		},
		async ({ date }) => {
			const props = requireProps();
			if (!props) return err("unauthorized");
			const d = resolveDate(date);
			const db = drizzle(env.DB);
			const backend = d1Backend(db, props.accountId);
			const doc = await backend.store.get(d);
			if (!doc) return err(`not found: ${d}`);
			const cfg = await backend.readConfig();
			return text(serializeDoc(cfg.jiraBase, doc));
		},
	);

	server.registerTool(
		"get_scrum",
		{
			description:
				"특정 날짜의 스크럼(prev/today) 블록만 반환한다(읽기).",
			inputSchema: { date: DATE },
		},
		async ({ date }) => {
			const props = requireProps();
			if (!props) return err("unauthorized");
			const d = resolveDate(date);
			const db = drizzle(env.DB);
			const backend = d1Backend(db, props.accountId);
			const doc = (await backend.store.get(d)) as Doc | null;
			if (!doc) return err(`not found: ${d}`);
			return text({
				ok: true,
				date: d,
				owner: doc.owner,
				scrum: doc.scrum,
			});
		},
	);

	server.registerTool(
		"query_tasks",
		{
			description:
				"기간·사이드·티켓키로 태스크 행을 조회한다(읽기). side ∈ prev|today|daily.",
			inputSchema: {
				from: z.string().optional().describe("시작일 YYYY-MM-DD"),
				to: z.string().optional().describe("종료일 YYYY-MM-DD"),
				side: z.string().optional().describe("prev | today | daily"),
				key: z.string().optional().describe("티켓 키 부분일치"),
			},
		},
		async ({ from, to, side, key }) => {
			const props = requireProps();
			if (!props) return err("unauthorized");
			const db = drizzle(env.DB);
			const backend = d1Backend(db, props.accountId);
			const tasks = await backend.queryTasks({
				from: from || undefined,
				to: to || undefined,
				side: side || undefined,
				key: key || undefined,
			});
			return text({ ok: true, count: tasks.length, tasks });
		},
	);

	return server;
}

/** OAuthProvider apiHandler 용 — ctx.props(accountId) 를 MCP authContext 로 전달. */
export const mcpApiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return createMcpHandler(() => createIDailyMcpServer(env), {
			route: "/mcp",
		})(request, env, ctx);
	},
};
