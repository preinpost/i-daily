// server/agent.ts — 주간업무보고 에이전트 (서버 측). main/agent.ts 의 결정적 로직 이식.
//
// 핵심 제약: Cloudflare Workers 는 로컬 프로세스 spawn 불가 → 에이전트 CLI(claude/codex/pi)
// 실행을 서버에서 할 수 없다. 따라서 웹에서는 결정적 집계(deterministic)만 제공하고,
// useAgent 옵션은 무시 + warn 로 안내한다. (나중: 에이전트 호출을 별도 서비스로 분리 가능)
// scan() 역시 서버에 CLI가 없으므로 빈 목록을 반환한다.
//
// 집계 로직(buildWeeklyDigest/renderDigestText)은 shared/report.ts 에 순수 함수로 이미 존재 → 재사용.
import type { Backend } from "../shared/backend.ts";
import {
	buildWeeklyDigest,
	renderDigestText,
	weekWindow,
	DEFAULT_REPORT_PROMPT,
} from "../shared/report.ts";

type GenerateOpts = {
	from?: string;
	to?: string;
	agentId?: string;
	useAgent?: boolean;
};
type GenerateResult = {
	ok: true;
	from: string;
	to: string;
	count: number;
	text: string;
	deterministic: string;
	usedAgent: string | null;
	warn?: string;
};

// 결정적 주간 집계. 에이전트 실행 불가(Workers) → useAgent 무시, 집계만.
export async function generateReport(
	backend: Backend,
	opts: GenerateOpts,
): Promise<GenerateResult> {
	const win = weekWindow();
	const from = opts.from || win.from;
	const to = opts.to || win.to;
	const cfg = await backend.readConfig();

	const rows = await backend.queryTasks({ from, to });
	const digest = buildWeeklyDigest(rows, cfg.owner || "", from, to);
	const deterministic = renderDigestText(digest);

	// Workers 환경에선 에이전트 CLI 가 없다 → 항상 결정적 집계.
	// useAgent 가 참이면 안내 warn 만 추가.
	const warn =
		opts.useAgent && digest.count > 0
			? "웹 버전은 에이전트 연동을 지원하지 않아 결정적 집계만 반환합니다."
			: undefined;

	return {
		ok: true,
		from,
		to,
		count: digest.count,
		text: deterministic,
		deterministic,
		usedAgent: null,
		warn,
	};
}

// 서버엔 CLI 없음 → 빈 에이전트 목록. (렌더러가 옵셔널 체이닝으로 스킵)
export function scanAgents(): { agents: never[] } {
	return { agents: [] };
}

export function defaultPrompt(): string {
	return DEFAULT_REPORT_PROMPT;
}
