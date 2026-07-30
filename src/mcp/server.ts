// mcp/server.ts — MCP 서버 (읽기 + 에이전트형 쓰기). Better Auth Bearer props 주입.
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { d1Backend } from "../shared/store-drizzle.ts";
import {
	todayStr,
	dayResponse,
	serializeDoc,
	parseDoc,
	carryNew,
	appendDailyTasks,
	dailyItemsOf,
	type Doc,
	type ListItem,
} from "../shared/model.ts";
import {
	weekWindow,
	buildWeeklyDigest,
	DEFAULT_REPORT_PROMPT,
	WEEKLY_REPORT_PRESENT_INSTRUCTION,
	composeWeeklyReportText,
	splitDigestText,
} from "../shared/report.ts";
import { generateReport } from "../server/agent.ts";
import {
	listWeeklyReports,
	getWeeklyReport,
	putWeeklyReport,
} from "../shared/store-drizzle.ts";
import type { McpProps } from "../auth/index.ts";

export type { McpProps };

const DATE = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
	.optional()
	.describe("날짜(YYYY-MM-DD). 생략 시 오늘");

/** 웹 UI 일일 진행 행과 동일 필드. key 또는 desc 중 하나 필요. */
const DailyTaskItem = z.object({
	key: z.string().optional().describe("티켓 키 (예: IIPQ-10)"),
	desc: z.string().optional().describe("한 일 설명"),
	progress: z
		.number()
		.min(0)
		.max(100)
		.optional()
		.describe("진척 % (0–100)"),
	due: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
		.optional()
		.describe("마감일 YYYY-MM-DD"),
	space: z.string().optional().describe("스페이스 라벨 (예: CONE Watcher N)"),
	subs: z.array(z.string()).optional().describe("하위 항목 문자열 배열"),
	done: z.boolean().optional().describe("완료 여부 (기본 false)"),
});

function text(payload: unknown) {
	const body =
		typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
	return { content: [{ type: "text" as const, text: body }] };
}

function err(message: string) {
	return text({ ok: false, error: message });
}

function resolveDate(date?: string): string {
	return date || todayStr();
}

function dbOf(env: Env) {
	return drizzle(env.DB);
}

function backendOf(env: Env, props: McpProps) {
	return d1Backend(dbOf(env), props.accountId);
}

export function createIDailyMcpServer(env: Env, props: McpProps): McpServer {
	const server = new McpServer({
		name: "i-daily",
		version: "0.2.32",
	});

	server.registerTool(
		"whoami",
		{
			description: "현재 MCP 인가 사용자(Atlassian account_id)를 반환한다.",
			inputSchema: {},
		},
		async () => text({ ok: true, ...props }),
	);

	server.registerTool(
		"list_days",
		{
			description: "업무일지 날짜 목록과 오늘·설정 요약을 반환한다(읽기).",
			inputSchema: {},
		},
		async () => {
			const backend = backendOf(env, props);
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
			const d = resolveDate(date);
			const backend = backendOf(env, props);
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
			const d = resolveDate(date);
			const backend = backendOf(env, props);
			const doc = await backend.store.get(d);
			if (!doc) return err(`not found: ${d}`);
			const cfg = await backend.readConfig();
			return text(serializeDoc(cfg.jiraBase, doc));
		},
	);

	server.registerTool(
		"get_scrum",
		{
			description: "특정 날짜의 스크럼(prev/today) 블록만 반환한다(읽기).",
			inputSchema: { date: DATE },
		},
		async ({ date }) => {
			const d = resolveDate(date);
			const backend = backendOf(env, props);
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
			const backend = backendOf(env, props);
			const tasks = await backend.queryTasks({
				from: from || undefined,
				to: to || undefined,
				side: side || undefined,
				key: key || undefined,
			});
			return text({ ok: true, count: tasks.length, tasks });
		},
	);

	server.registerTool(
		"search_content",
		{
			description:
				"일지 전문 검색(읽기). 메모·스크럼 이슈/협업·태스크(desc/subs/space)에서 q 부분일치. " +
				"회의/메모를 찾을 때 get_day 를 날짜마다 반복하지 말고 이 도구를 먼저 써라. " +
				"응답 hits: date, section, kind(raw|issues|collab|task), snippet.",
			inputSchema: {
				q: z.string().min(1).describe("검색어(부분일치)"),
				from: z.string().optional().describe("시작일 YYYY-MM-DD"),
				to: z.string().optional().describe("종료일 YYYY-MM-DD"),
				section: z
					.string()
					.optional()
					.describe("섹션 제목 정확일치 (예: 메모, 데일리 스크럼)"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.describe("최대 히트 수(기본 50)"),
			},
		},
		async ({ q, from, to, section, limit }) => {
			const backend = backendOf(env, props);
			const hits = await backend.searchContent({
				q,
				from: from || undefined,
				to: to || undefined,
				section: section || undefined,
				limit: limit ?? undefined,
			});
			return text({ ok: true, count: hits.length, hits });
		},
	);

	server.registerTool(
		"get_week_window",
		{
			description:
				"현재 기준(KST) 주간보고 기본 기간을 반환한다: 시작=그 주기 금요일(저번 주 금 포함), 끝=그 주기 목요일(이번 주 목). generate_weekly_report 가 인자 없이 쓰는 값과 동일.",
			inputSchema: {},
		},
		async () => {
			const win = weekWindow();
			return text({
				ok: true,
				...win,
				hint: "기본=전주 금~금주 목. generate_weekly_report 는 from/to 생략 시 이 기간을 쓴다. 표 요약 금지 — Teams 붙여넣기 형식만.",
			});
		},
	);

	server.registerTool(
		"generate_weekly_report",
		{
			description:
				"주간업무보고 Teams 붙여넣기용 집계. " +
				"기본 기간=전주 금요일~금주 목요일. from/to 생략 시 그 기본값. " +
				"기본으로 DB에 저장한다(save=false 로만 생략). 저장 여부를 사용자에게 묻지 마라. " +
				"응답 text/thisWeek/nextWeek 를 Teams 붙여넣기 형식으로 보여라(표 재구성 금지). " +
				"서술만 다듬은 뒤에는 묻지 말고 save_weekly_report 로 덮어써라.",
			inputSchema: {
				from: DATE.describe(
					"시작일 YYYY-MM-DD(보통 금요일). 생략 시 전주 금요일",
				),
				to: DATE.describe(
					"종료일 YYYY-MM-DD(보통 목요일). 생략 시 금주 목요일",
				),
				save: z
					.boolean()
					.optional()
					.describe("집계 후 DB 저장(기본 true). false 면 저장 안 함"),
			},
		},
		async ({ from, to, save }) => {
			const win = weekWindow();
			const f = from || win.from;
			const t = to || win.to;
			if (f > t) return err("from must be <= to");
			const backend = backendOf(env, props);
			const cfg = await backend.readConfig();
			const report = await generateReport(backend, {
				from: f,
				to: t,
				useAgent: false,
			});
			const rows = await backend.queryTasks({ from: f, to: t });
			const digest = buildWeeklyDigest(rows, cfg.owner || "", f, t);
			const polishPrompt = DEFAULT_REPORT_PROMPT.replaceAll("{from}", f)
				.replaceAll("{to}", t)
				.replaceAll("{owner}", cfg.owner || "");
			const shouldSave = save !== false;
			let savedAt: string | null = null;
			if (shouldSave) {
				const saved = await putWeeklyReport(dbOf(env), props.accountId, {
					from: report.from,
					to: report.to,
					thisWeek: report.thisWeek,
					nextWeek: report.nextWeek,
				});
				savedAt = saved.updatedAt;
			}
			return text({
				ok: true,
				from: report.from,
				to: report.to,
				count: report.count,
				defaultWindow: win,
				usedDefault: !from && !to,
				saved: shouldSave,
				savedAt,
				text: report.text,
				thisWeek: report.thisWeek,
				nextWeek: report.nextWeek,
				digest,
				polishPrompt,
				instruction: WEEKLY_REPORT_PRESENT_INSTRUCTION,
				formatExample: [
					"금주 업무 내용",
					"[CONE Watcher N]",
					"ㅇ[IIPQ-10] [CONE Watcher N] 가이드(위키) 페이지 버전 관리 (90%, ~7/31)",
					"  - AX네이티브테크실 요청사항",
					"  - Cloudflare D1 -> MongoDB로 교체",
					"",
					"차주 업무 내용",
					"[CONE Watcher N]",
					"ㅇ[IIPQ-10] [CONE Watcher N] 가이드(위키) 페이지 버전 관리 (90%, ~7/31)",
					"  - AX네이티브테크실 요청사항",
				].join("\n"),
			});
		},
	);

	server.registerTool(
		"list_weekly_reports",
		{
			description:
				"저장된 주간보고 스냅샷 목록(최신 from 순). 주간보고 탭 오른쪽 목록과 동일.",
			inputSchema: {},
		},
		async () => {
			const items = await listWeeklyReports(dbOf(env), props.accountId);
			return text({ ok: true, count: items.length, reports: items });
		},
	);

	server.registerTool(
		"get_weekly_report",
		{
			description:
				"저장된 주간보고 한 건을 반환한다. from/to 생략 시 기본 주간(전주 금~금주 목).",
			inputSchema: {
				from: DATE.describe("시작일 YYYY-MM-DD. 생략 시 전주 금요일"),
				to: DATE.describe("종료일 YYYY-MM-DD. 생략 시 금주 목요일"),
			},
		},
		async ({ from, to }) => {
			const win = weekWindow();
			const f = from || win.from;
			const t = to || win.to;
			const row = await getWeeklyReport(dbOf(env), props.accountId, f, t);
			if (!row) return err(`not found: ${f} ~ ${t}`);
			return text({
				ok: true,
				...row,
				text: composeWeeklyReportText(row.thisWeek, row.nextWeek),
			});
		},
	);

	server.registerTool(
		"save_weekly_report",
		{
			description:
				"주간보고 스냅샷을 저장한다(쓰기). thisWeek/nextWeek 또는 text. from/to 생략 시 기본 주간. 같은 기간이면 덮어쓴다. 저장 여부를 사용자에게 묻지 말고 바로 호출한다.",
			inputSchema: {
				from: DATE.describe("시작일 YYYY-MM-DD. 생략 시 전주 금요일"),
				to: DATE.describe("종료일 YYYY-MM-DD. 생략 시 금주 목요일"),
				thisWeek: z
					.string()
					.optional()
					.describe("금주 업무 내용 본문(헤더 제외)"),
				nextWeek: z
					.string()
					.optional()
					.describe("차주 업무 내용 본문(헤더 제외)"),
				text: z
					.string()
					.optional()
					.describe("금주/차주 헤더 포함 전체 텍스트(thisWeek/nextWeek 없을 때)"),
			},
		},
		async ({ from, to, thisWeek, nextWeek, text: fullText }) => {
			const win = weekWindow();
			const f = from || win.from;
			const t = to || win.to;
			if (f > t) return err("from must be <= to");
			let tw = thisWeek ?? "";
			let nw = nextWeek ?? "";
			if (
				fullText != null &&
				thisWeek === undefined &&
				nextWeek === undefined
			) {
				const parts = splitDigestText(fullText);
				tw = parts.thisWeek;
				nw = parts.nextWeek;
			}
			if (!tw.trim() && !nw.trim()) {
				return err("thisWeek/nextWeek 또는 text 필요");
			}
			const saved = await putWeeklyReport(dbOf(env), props.accountId, {
				from: f,
				to: t,
				thisWeek: tw,
				nextWeek: nw,
			});
			return text({
				ok: true,
				status: "saved",
				...saved,
				text: composeWeeklyReportText(saved.thisWeek, saved.nextWeek),
			});
		},
	);

	// ── write ──

	server.registerTool(
		"create_day",
		{
			description:
				"날짜 일지를 생성한다(쓰기). 직전 근무일 일일 진행 → 전일 스크럼으로 이월. 이미 있으면 force=true 일 때만 덮어쓴다.",
			inputSchema: {
				date: DATE,
				force: z
					.boolean()
					.optional()
					.describe("기존 일지가 있어도 덮어쓰기(기본 false)"),
			},
		},
		async ({ date, force }) => {
			const d = resolveDate(date);
			const backend = backendOf(env, props);
			const cfg = await backend.readConfig();
			const existing = await backend.store.get(d);
			if (existing && !force) {
				return text({
					ok: true,
					status: "exists",
					date: d,
					...dayResponse(cfg.jiraBase, existing),
				});
			}
			const doc = await carryNew(backend.store, d, cfg.owner);
			await backend.store.put(d, doc);
			return text({
				ok: true,
				status: existing ? "overwritten" : "created",
				date: d,
				...dayResponse(cfg.jiraBase, doc),
			});
		},
	);

	server.registerTool(
		"add_daily_task",
		{
			description:
				"일일 진행 업무에 항목을 추가한다(쓰기). items 는 웹 UI와 동일 필드(key/desc/progress/due/space/subs). 일지가 없으면 create_if_missing 시 carry 로 생성.",
			inputSchema: {
				date: DATE,
				items: z
					.array(DailyTaskItem)
					.min(1)
					.describe("추가할 일일 항목(구조화)"),
				space: z
					.string()
					.optional()
					.describe("기본 스페이스(항목에 space 없을 때 적용)"),
				create_if_missing: z
					.boolean()
					.optional()
					.describe("일지 없으면 carry 생성 후 추가(기본 true)"),
			},
		},
		async ({ date, items, space, create_if_missing }) => {
			const d = resolveDate(date);
			const backend = backendOf(env, props);
			const cfg = await backend.readConfig();
			const createMissing = create_if_missing !== false;
			let doc = await backend.store.get(d);
			let created = false;
			if (!doc) {
				if (!createMissing) return err(`not found: ${d}`);
				doc = await carryNew(backend.store, d, cfg.owner);
				created = true;
			}
			const defaultSpace = (space || "").trim();
			const rows: ListItem[] = items.map((it) => ({
				done: !!it.done,
				key: it.key || "",
				desc: it.desc || "",
				progress: it.progress ?? "",
				due: it.due || "",
				subs: it.subs ?? [],
				space: (it.space || "").trim() || defaultSpace,
			}));
			const added = appendDailyTasks(doc, rows);
			if (!added.length) return err("no non-empty items (key 또는 desc 필요)");
			await backend.store.put(d, doc);
			return text({
				ok: true,
				date: d,
				created,
				added: added.length,
				items: added,
				daily: dailyItemsOf(doc),
			});
		},
	);

	server.registerTool(
		"put_day_markdown",
		{
			description:
				"마크다운 전체로 해당 날짜 일지를 저장한다(쓰기). ## 섹션 파싱. 기존 일지를 통째로 교체한다.",
			inputSchema: {
				date: DATE,
				markdown: z.string().min(1).describe("업무일지 마크다운 본문"),
			},
		},
		async ({ date, markdown }) => {
			const d = resolveDate(date);
			const backend = backendOf(env, props);
			const cfg = await backend.readConfig();
			const doc = parseDoc(markdown, d, cfg.owner);
			doc.date = d;
			doc.owner ||= cfg.owner;
			await backend.store.put(d, doc);
			return text({
				ok: true,
				status: "saved",
				date: d,
				...dayResponse(cfg.jiraBase, doc),
			});
		},
	);

	return server;
}

export async function handleMcpRequest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	props: McpProps,
): Promise<Response> {
	return createMcpHandler(() => createIDailyMcpServer(env, props), {
		route: "/mcp",
		authContext: { props },
	})(request, env, ctx);
}
