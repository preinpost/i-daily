import { useEffect, useState } from "react";
import { useToast } from "./Toast";

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
			className="fixed inset-x-0 bottom-0 top-tabh z-50 flex flex-col overflow-y-auto bg-bg"
		>
			<div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-5 pb-12 pt-7">
				<h2 className="m-0 text-xl font-extrabold text-ink">⚙️ 설정</h2>
				{firstRun && (
					<p className="tint-accent m-0 rounded-[10px] px-3.5 py-2.5 text-[13px] text-ink">
						처음 실행이에요. 아래 <b>Jira 연동</b>으로 로그인하면 이름·사이트
						주소가 자동으로 채워지고 업무일지가 활성화됩니다.
					</p>
				)}

				<h3 className="mt-4 border-t border-line pt-4 text-[15px] font-extrabold text-ink">
					🎫 Jira 연동
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
