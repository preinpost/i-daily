// server/agent.ts — 주간업무보고 결정적 집계 (서버 측).
// Cloudflare Workers 는 로컬 프로세스 spawn 불가 → CLI 에이전트 없음.
// LLM 다듬기(BYOK)는 제거됨 — 일지 태스크 집계 텍스트만 반환.
import type { Backend } from "../shared/backend.ts";
import {
	buildWeeklyDigest,
	renderDigestText,
	splitDigestText,
	weekWindow,
} from "../shared/report.ts";

type GenerateOpts = {
	from?: string;
	to?: string;
};
type GenerateResult = {
	ok: true;
	from: string;
	to: string;
	count: number;
	text: string;
	thisWeek: string;
	nextWeek: string;
	deterministic: string;
	usedAgent: null;
};

/** 기간(기본: 전주 금~금주 목)의 태스크를 결정적으로 집계해 주간보고 텍스트를 만든다. */
export async function generateReport(
	backend: Backend,
	opts: GenerateOpts = {},
): Promise<GenerateResult> {
	const win = weekWindow();
	const from = opts.from || win.from;
	const to = opts.to || win.to;
	const cfg = await backend.readConfig();

	const rows = await backend.queryTasks({ from, to });
	const digest = buildWeeklyDigest(rows, cfg.owner || "", from, to);
	const deterministic = renderDigestText(digest);
	const { thisWeek, nextWeek } = splitDigestText(deterministic);
	return {
		ok: true,
		from,
		to,
		count: digest.count,
		text: deterministic,
		thisWeek,
		nextWeek,
		deterministic,
		usedAgent: null,
	};
}
