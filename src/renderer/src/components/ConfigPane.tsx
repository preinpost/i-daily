import { useEffect, useMemo, useState } from "react";
import { useToast } from "./Toast";
import { weekWindow } from "../../../shared/report.ts";
import { kstParts } from "../../../shared/model.ts";

type JiraStatus = {
	connected?: boolean;
	configured?: boolean;
	site?: string;
	siteUrl?: string;
} | null;

/** 운영 MCP endpoint — OAuth resource(aud) 와 동일. */
const MCP_URL = "https://i-daily.dl-inje-dev-services.workers.dev/mcp";

type McpClientTab = "claude" | "codex" | "pi";

const MCP_TABS: { id: McpClientTab; label: string }[] = [
	{ id: "claude", label: "Claude" },
	{ id: "codex", label: "Codex" },
	{ id: "pi", label: "Pi" },
];

function CodeBlock({
	code,
	onCopy,
}: {
	code: string;
	onCopy: (text: string) => void;
}) {
	return (
		<div className="relative">
			<pre className="m-0 overflow-x-auto rounded-[9px] bg-panel px-3.5 py-3 font-mono text-[12px] leading-relaxed text-ink whitespace-pre">
				{code}
			</pre>
			<button
				type="button"
				className="btn btn-ghost absolute right-2 top-2 px-2 py-1 text-[11px]"
				onClick={() => onCopy(code)}
				title="복사"
			>
				복사
			</button>
		</div>
	);
}

type ExportFormat = "md" | "json";

type DateRangePreset = {
	id: string;
	label: string;
	range: (now: Date) => { from: string; to: string };
};

const pad2 = (n: number): string => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number): string =>
	`${y}-${pad2(m)}-${pad2(d)}`;

// KST 기준 월의 첫날·말일.
function monthBounds(ref: Date, offset = 0): { from: string; to: string } {
	const { y, m } = kstParts(ref);
	const tm = m + offset; // 1-base
	const year = y + Math.floor((tm - 1) / 12);
	const mon = ((tm - 1) % 12) + 1;
	const from = ymd(year, mon, 1);
	const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate(); // 0일 = 저번 달 말일
	return { from, to: ymd(year, mon, lastDay) };
}

// 저번 주(금~목) = 이번 주 창에서 7일 전.
function prevWeekWindow(ref: Date): { from: string; to: string } {
	const w = weekWindow(ref);
	const fromD = new Date(w.from + "T00:00:00Z");
	fromD.setUTCDate(fromD.getUTCDate() - 7);
	const toD = new Date(w.to + "T00:00:00Z");
	toD.setUTCDate(toD.getUTCDate() - 7);
	return {
		from: ymd(
			fromD.getUTCFullYear(),
			fromD.getUTCMonth() + 1,
			fromD.getUTCDate(),
		),
		to: ymd(
			toD.getUTCFullYear(),
			toD.getUTCMonth() + 1,
			toD.getUTCDate(),
		),
	};
}

const PRESETS: DateRangePreset[] = [
	{ id: "thisWeek", label: "이번주", range: (n) => weekWindow(n) },
	{ id: "lastWeek", label: "저번주", range: (n) => prevWeekWindow(n) },
	{ id: "thisMonth", label: "이번달", range: (n) => monthBounds(n, 0) },
	{ id: "lastMonth", label: "저번달", range: (n) => monthBounds(n, -1) },
	{
		id: "all",
		label: "전체",
		range: () => ({ from: "0000-01-01", to: "9999-12-31" }),
	},
];

function ExportSection() {
	const toast = useToast();
	const now = useMemo(() => new Date(), []);
	const { from: defFrom, to: defTo } = useMemo(
		() => weekWindow(now),
		[now],
	);
	const [from, setFrom] = useState(defFrom);
	const [to, setTo] = useState(defTo);
	const [fmt, setFmt] = useState<ExportFormat>("md");
	const [busy, setBusy] = useState(false);

	const valid =
		/^\d{4}-\d{2}-\d{2}$/.test(from) &&
		/^\d{4}-\d{2}-\d{2}$/.test(to) &&
		from <= to;

	function applyPreset(r: { from: string; to: string }) {
		setFrom(r.from);
		setTo(r.to);
	}

	function triggerDownload(filename: string, body: string, mime: string) {
		const blob = new Blob([body], { type: mime });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	async function doExport() {
		if (!valid || busy) return;
		setBusy(true);
		try {
			const res = await window.api.exportLog(from, to, fmt);
			if (res.status === 400) {
				toast(res.body?.error || "기간을 확인하세요");
				return;
			}
			// 빈 결과: 서버가 JSON { ok, count:0 } 로 응답. 다운로드 생략.
			if (
				res.body &&
				typeof res.body === "object" &&
				res.body.count === 0
			) {
				toast("해당 기간에 일지가 없어요");
				return;
			}
			const filename = `i-daily_${from}_${to}.${fmt}`;
			if (fmt === "md") {
				triggerDownload(
					filename,
					typeof res.body === "string" ? res.body : "",
					"text/markdown;charset=utf-8",
				);
			} else {
				const body =
					typeof res.body === "object"
						? JSON.stringify(res.body, null, 2)
						: String(res.body || "");
				triggerDownload(filename, body, "application/json;charset=utf-8");
			}
			toast(`내보내기 완료 — ${filename}`);
		} catch {
			toast("내보내기 실패");
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<h3 className="mt-4 border-t border-line pt-4 text-[15px] font-extrabold text-ink">
				📤 업무일지 내보내기
			</h3>
			<p className="tint-accent m-0 rounded-[10px] px-3.5 py-2.5 text-xs text-ink">
				선택한 기간의 데일리 업무일지를 마크다운 또는 JSON 파일로
				내려받습니다. Jira 링크는 설정의 jiraBase 로 생성됩니다.
			</p>

			<div className="flex flex-col gap-1.5">
				<span className="text-[13px] font-bold text-ink">기간</span>
				<div className="flex items-center gap-2">
					<input
						type="date"
						className="input flex-1"
						value={from}
						onChange={(e) => setFrom(e.target.value)}
					/>
					<span className="text-ink-2">~</span>
					<input
						type="date"
						className="input flex-1"
						value={to}
						onChange={(e) => setTo(e.target.value)}
					/>
				</div>
			</div>

			<div className="flex flex-wrap gap-1.5">
				{PRESETS.map((p) => (
				<button
					key={p.id}
					type="button"
					className="btn btn-ghost px-2.5 py-1 text-[12px]"
					onClick={() => applyPreset(p.range(now))}
				>
					{p.label}
				</button>
			))}
			</div>

			<div className="flex items-center gap-2">
				<span className="text-[13px] font-bold text-ink">형식</span>
				<div className="flex border border-line rounded-[8px] overflow-hidden">
					<button
						type="button"
						className={
							"px-3 py-1 text-[12.5px] font-semibold transition " +
							(fmt === "md"
								? "bg-accent text-accent-ink"
								: "bg-transparent text-ink-2 hover:text-ink")
						}
						onClick={() => setFmt("md")}
					>
						Markdown
					</button>
					<button
						type="button"
						className={
							"px-3 py-1 text-[12.5px] font-semibold transition " +
							(fmt === "json"
								? "bg-accent text-accent-ink"
								: "bg-transparent text-ink-2 hover:text-ink")
					}
					onClick={() => setFmt("json")}
				>
						JSON
					</button>
				</div>
				<button
					type="button"
					className="btn btn-primary ml-auto"
					disabled={!valid || busy}
					onClick={doExport}
				>
					{busy ? "내보내는 중…" : "내보내기"}
				</button>
			</div>
		</>
	);
}

function McpConnectDocs({ onCopy }: { onCopy: (text: string) => void }) {
	const [tab, setTab] = useState<McpClientTab>("claude");

	const claudeJson = `{
  "mcpServers": {
    "i-daily": {
      "type": "http",
      "url": "${MCP_URL}"
    }
  }
}`;

	const claudeCli = `claude mcp add --transport http i-daily ${MCP_URL}`;

	const codexToml = `[mcp_servers.i-daily]
url = "${MCP_URL}"`;

	const piJson = `{
  "mcpServers": {
    "i-daily": {
      "url": "${MCP_URL}",
      "auth": "oauth",
      "directTools": true
    }
  }
}`;

	return (
		<>
			<h3 className="mt-4 border-t border-line pt-4 text-[15px] font-extrabold text-ink">
				🔌 MCP 연동
			</h3>
			<p className="tint-accent m-0 rounded-[10px] px-3.5 py-2.5 text-xs text-ink">
				에이전트(Claude / Codex / Pi)에서 i-daily 일지·주간보고 도구를 쓰려면
				아래 MCP URL을 등록하세요. 첫 연결 시 브라우저에서 Atlassian OAuth
				로그인이 뜹니다.
			</p>

			<div className="flex flex-col gap-1.5">
				<span className="text-[13px] font-bold text-ink">Endpoint</span>
				<div className="flex items-center gap-2">
					<code className="min-w-0 flex-1 overflow-x-auto rounded-[9px] bg-panel px-3 py-2 font-mono text-[12px] text-ink">
						{MCP_URL}
					</code>
					<button
						type="button"
						className="btn btn-ghost shrink-0"
						onClick={() => onCopy(MCP_URL)}
					>
						복사
					</button>
				</div>
			</div>

			{/* docs-style tabs */}
			<div
				role="tablist"
				aria-label="MCP 클라이언트"
				className="mt-1 flex gap-0 border-b border-line"
			>
				{MCP_TABS.map((t) => {
					const on = tab === t.id;
					return (
						<button
							key={t.id}
							type="button"
							role="tab"
							aria-selected={on}
							className={
								"relative -mb-px border-0 border-b-2 bg-transparent px-3.5 py-2 text-[13px] font-semibold transition " +
								(on
									? "border-accent text-accent"
									: "border-transparent text-ink-2 hover:text-ink")
							}
							onClick={() => setTab(t.id)}
						>
							{t.label}
						</button>
					);
				})}
			</div>

			<div role="tabpanel" className="flex flex-col gap-3 pt-1">
				{tab === "claude" && (
					<>
						<p className="m-0 text-[13px] leading-relaxed text-ink-2">
							프로젝트 루트 또는{" "}
							<code className="rounded bg-panel px-1 font-mono text-[12px]">
								~/.claude.json
							</code>{" "}
							에 MCP 서버를 추가합니다. HTTP transport + OAuth.
						</p>
						<div className="flex flex-col gap-1.5">
							<span className="text-[12px] font-bold text-ink">
								.mcp.json
							</span>
							<CodeBlock code={claudeJson} onCopy={onCopy} />
						</div>
						<div className="flex flex-col gap-1.5">
							<span className="text-[12px] font-bold text-ink">
								또는 CLI
							</span>
							<CodeBlock code={claudeCli} onCopy={onCopy} />
						</div>
						<ol className="m-0 list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-ink-2">
							<li>위 설정을 저장한 뒤 Claude Code를 재시작합니다.</li>
							<li>
								<code className="rounded bg-panel px-1 font-mono">/mcp</code>{" "}
								에서 <b>i-daily</b> 연결·인증 상태를 확인합니다.
							</li>
							<li>첫 도구 호출 시 브라우저 OAuth 로그인을 완료합니다.</li>
						</ol>
					</>
				)}

				{tab === "codex" && (
					<>
						<p className="m-0 text-[13px] leading-relaxed text-ink-2">
							<code className="rounded bg-panel px-1 font-mono text-[12px]">
								~/.codex/config.toml
							</code>{" "}
							에 remote MCP 서버를 추가합니다.
						</p>
						<div className="flex flex-col gap-1.5">
							<span className="text-[12px] font-bold text-ink">
								config.toml
							</span>
							<CodeBlock code={codexToml} onCopy={onCopy} />
						</div>
						<ol className="m-0 list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-ink-2">
							<li>파일을 저장한 뒤 Codex를 재시작합니다.</li>
							<li>MCP 목록에서 <b>i-daily</b>가 보이는지 확인합니다.</li>
							<li>첫 호출 시 OAuth 로그인을 완료합니다.</li>
						</ol>
					</>
				)}

				{tab === "pi" && (
					<>
						<p className="m-0 text-[13px] leading-relaxed text-ink-2">
							<code className="rounded bg-panel px-1 font-mono text-[12px]">
								~/.pi/agent/mcp.json
							</code>{" "}
							에 OAuth remote MCP를 등록합니다.
						</p>
						<div className="flex flex-col gap-1.5">
							<span className="text-[12px] font-bold text-ink">mcp.json</span>
							<CodeBlock code={piJson} onCopy={onCopy} />
						</div>
						<ol className="m-0 list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-ink-2">
							<li>
								<code className="rounded bg-panel px-1 font-mono">
									auth: &quot;oauth&quot;
								</code>
								는 필수입니다. Pi가 브라우저 로그인을 띄웁니다.
							</li>
							<li>
								<code className="rounded bg-panel px-1 font-mono">
									directTools: true
								</code>
								면 도구가{" "}
								<code className="rounded bg-panel px-1 font-mono">
									i_daily_*
								</code>{" "}
								로 바로 노출됩니다.
							</li>
							<li>저장 후 pi를 다시 띄우면 연결됩니다.</li>
						</ol>
					</>
				)}
			</div>
		</>
	);
}

export function ConfigPane({
	active,
	firstRun,
}: {
	active: boolean;
	firstRun: boolean;
}) {
	const toast = useToast();
	const [js, setJs] = useState<JiraStatus>(null);
	const [me, setMe] = useState<{ user: string; isSetup: boolean } | null>(null);

	async function refreshJira() {
		const j = window.api?.jira;
		const meApi = window.api?.me;
		if (!j) return;
		try {
			const [st, mi] = await Promise.all([j.status(), meApi ? meApi() : null]);
			setJs(st);
			setMe(mi);
		} catch {
			setJs(null);
			setMe(null);
		}
	}
	useEffect(() => {
		if (active) refreshJira();
	}, [active]);

	async function connect() {
		const j = window.api?.jira;
		if (!j) return;
		setJs((s) => ({ ...(s || {}), configured: s?.configured }));
		let r: any = null;
		try {
			r = await j.connect();
		} catch {
			toast("Jira 연결 실패");
			refreshJira();
			return;
		}
		if (r && r.replaced) return; // 재시도로 대체됨
		toast(
			r && r.ok
				? "Jira 연결됨"
				: "Jira 연결 실패: " + ((r && r.error) || "알 수 없음"),
		);
		refreshJira();
	}
	async function logout() {
		try {
			await window.api?.jira.logout();
			toast("로그아웃 — Jira 연결 해제됨");
		} catch {
			/* noop */
		}
		// 로그아웃아웃 = 세션 만료 → user 가 setup 으로 복귀. 새 상태로 재부팅.
		location.reload();
	}

	const jiraText = !js
		? "—"
		: js.connected
			? "✅ " + "연결됨 — " + (js.site || js.siteUrl || "")
			: js.configured
				? "미연결 — 🔗 버튼으로 로그인하세요"
				: "서버에 Jira OAuth 클라이언트가 설정되지 않음(관리자)";
	const connectLabel = js?.connected
		? "🔄 다시 연결"
		: me?.isSetup === false
			? "🔗 로그인"
			: "🔗 Jira 연결";

	return (
		<div
			hidden={!active}
			className="fixed inset-x-0 bottom-0 top-[var(--chrome-offset,48px)] z-40 flex flex-col overflow-y-auto bg-bg"
		>
			<div className="mx-auto flex w-full max-w-[640px] flex-col gap-3.5 px-5 pb-12 pt-5">
				<h2 className="m-0 text-[18px] font-bold tracking-[-0.02em] text-ink">
					설정
				</h2>
				{firstRun && (
					<p className="tint-accent m-0 rounded-[6px] px-3.5 py-3 text-[13px] leading-[1.55] text-accent-text">
						처음 실행이에요. 아래 <b>Jira 연동</b>으로 로그인하면 이름·사이트
						주소가 자동으로 채워지고 업무일지가 활성화됩니다.
					</p>
				)}

				<h3 className="mt-4 border-t border-line pt-4 text-[15px] font-bold text-ink">
					Jira 연동
				</h3>

				<div className="mt-1 flex items-center gap-3">
					<button type="button" className="btn btn-primary" onClick={connect}>
						{connectLabel}
					</button>
					{js?.connected && (
						<button type="button" className="btn btn-ghost" onClick={logout}>
							로그아웃
						</button>
					)}
					<span className="text-[13px] text-ink-2">{jiraText}</span>
				</div>

				<ExportSection />

				<McpConnectDocs
					onCopy={async (text) => {
						try {
							await navigator.clipboard.writeText(text);
							toast("복사됨");
						} catch {
							toast("복사 실패");
						}
					}}
				/>
			</div>
		</div>
	);
}
