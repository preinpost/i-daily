// main/agent.ts — 주간업무보고 에이전트. setupJira 패턴을 그대로 따른다(IPC 모듈 1개).
//   agent:scan     → PC에 설치된 코딩 에이전트 CLI(claude/codex/pi) 탐지 + 버전.
//   agent:generate → queryTasks(Fri~Thu)로 결정적 digest 생성 → (선택 시) 에이전트로 서술만 다듬기.
//
// 하이브리드: 숫자/티켓키는 digest에서 확정. 에이전트가 없거나 실패해도 결정적 텍스트가 fallback.
// GUI로 실행된 앱은 셸 PATH를 못 물려받으므로(특히 macOS) 표준 설치경로를 PATH에 보강한다.
import { ipcMain } from "electron";
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import type Database from "better-sqlite3";
import { queryTasks } from "../shared/store.ts";
import {
	buildWeeklyDigest,
	renderDigestText,
	buildAgentPrompt,
	weekWindow,
	DEFAULT_REPORT_PROMPT,
} from "../shared/report.ts";
import { readConfig } from "../shared/store.ts";

// 각 CLI의 비대화(non-interactive) 실행 스펙. 프롬프트는 마지막 인자로 전달(세 CLI의
// 문서화된 `-p "…"` / `exec "…"` 형식). 실제 플래그가 다르면 args만 조정하면 된다.
type AgentSpec = {
	id: string;
	label: string;
	bin: string;
	args: string[];
	versionArgs: string[];
};
const AGENTS: AgentSpec[] = [
	{
		id: "claude",
		label: "Claude Code",
		bin: "claude",
		args: ["-p"],
		versionArgs: ["--version"],
	},
	{
		id: "codex",
		label: "Codex",
		bin: "codex",
		args: ["exec"],
		versionArgs: ["--version"],
	},
	{
		id: "pi",
		label: "pi",
		bin: "pi",
		args: ["-p"],
		versionArgs: ["--version"],
	},
];

let _db: Database.Database;
let _user = "local";

export function setupAgent(db: Database.Database, user: string): void {
	_db = db;
	_user = user;
	ipcMain.handle("agent:scan", () => scan());
	ipcMain.handle("agent:generate", (_e, opts: GenerateOpts) =>
		generate(opts || {}),
	);
	ipcMain.handle("agent:default-prompt", () => DEFAULT_REPORT_PROMPT);
}

// ───────────────────────── PATH 보강(GUI 앱 대비) ─────────────────────────
function augmentedPath(): string {
	const home = homedir();
	const extra = [
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		join(home, ".local", "bin"),
		join(home, ".local", "share", "mise", "shims"), // mise 관리 도구(node/bun/… 전카버)
		join(home, ".asdf", "shims"), // asdf 관리 도구
		join(home, ".bun", "bin"),
		join(home, ".cargo", "bin"),
		join(home, ".npm-global", "bin"),
		join(home, ".volta", "bin"),
		join(home, "AppData", "Roaming", "npm"), // Windows npm global
	];
	const cur = (process.env.PATH || "").split(delimiter);
	const merged = [...cur, ...extra.filter((p) => existsSync(p))];
	return [...new Set(merged)].join(delimiter);
}
const spawnEnv = () => ({ ...process.env, PATH: augmentedPath() });

// bin 실제 경로 탐지(which/where + 직접 후보). 못 찾으면 null.
function resolveBin(bin: string): string | null {
	const isWin = process.platform === "win32";
	const home = homedir();
	const dirs = augmentedPath().split(delimiter);
	const exts = isWin ? [".cmd", ".exe", ".bat", ""] : [""];
	for (const d of dirs) {
		for (const ext of exts) {
			const p = join(d, bin + ext);
			if (existsSync(p)) return p;
		}
	}
	void home;
	return null;
}

// ───────────────────────── 스캔 ─────────────────────────
type Scanned = {
	id: string;
	label: string;
	bin: string;
	path: string;
	version: string;
};
async function scan(): Promise<{ agents: Scanned[] }> {
	const found: Scanned[] = [];
	for (const a of AGENTS) {
		const path = resolveBin(a.bin);
		if (!path) continue;
		const version = await getVersion(path, a.versionArgs);
		found.push({ id: a.id, label: a.label, bin: a.bin, path, version });
	}
	return { agents: found };
}
function getVersion(path: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			path,
			args,
			{ env: spawnEnv(), timeout: 5000 },
			(err, stdout, stderr) => {
				if (err) return resolve("");
				resolve(
					((stdout || stderr || "").trim().split("\n")[0] || "").slice(0, 60),
				);
			},
		);
	});
}

// ───────────────────────── 생성 ─────────────────────────
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
async function generate(opts: GenerateOpts): Promise<GenerateResult> {
	const win = weekWindow();
	const from = opts.from || win.from;
	const to = opts.to || win.to;
	const cfg = readConfig(_db, _user);

	const rows = queryTasks(_db, _user, { from, to });
	const digest = buildWeeklyDigest(rows, cfg.owner || "", from, to);
	const deterministic = renderDigestText(digest);

	// 항목이 없거나 에이전트 미사용이면 결정적 텍스트만.
	if (!opts.useAgent || digest.count === 0) {
		return {
			ok: true,
			from,
			to,
			count: digest.count,
			text: deterministic,
			deterministic,
			usedAgent: null,
		};
	}

	const spec = AGENTS.find((a) => a.id === (opts.agentId || cfg.reportAgent));
	if (!spec) {
		return {
			ok: true,
			from,
			to,
			count: digest.count,
			text: deterministic,
			deterministic,
			usedAgent: null,
			warn: "선택된 에이전트가 없어 결정적 집계만 반환했습니다.",
		};
	}
	const path = resolveBin(spec.bin);
	if (!path) {
		return {
			ok: true,
			from,
			to,
			count: digest.count,
			text: deterministic,
			deterministic,
			usedAgent: null,
			warn: `${spec.label} 바이너리를 찾지 못해 결정적 집계만 반환했습니다.`,
		};
	}

	try {
		const prompt = buildAgentPrompt(digest, cfg.reportPrompt);
		const out = await runAgent(path, [...spec.args, prompt]);
		const text = (out || "").trim();
		if (!text) throw new Error("빈 응답");
		return {
			ok: true,
			from,
			to,
			count: digest.count,
			text,
			deterministic,
			usedAgent: spec.label,
		};
	} catch (e) {
		return {
			ok: true,
			from,
			to,
			count: digest.count,
			text: deterministic,
			deterministic,
			usedAgent: null,
			warn: `${spec.label} 실행 실패(${msg(e)}) — 결정적 집계로 대체.`,
		};
	}
}

// 프롬프트를 인자로 넘기고 stdout 수집(shell 미경유 → 이스케이프 불필요). stdin은 즉시 닫음. 90초 타임아웃.
function runAgent(path: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(path, args, {
			env: spawnEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "",
			err = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("타임아웃(90초)"));
		}, 90_000);
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (err += d.toString()));
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(out);
			else
				reject(new Error(`exit ${code}: ${(err || out).trim().slice(0, 200)}`));
		});
	});
}

function msg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
