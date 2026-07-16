import { useEffect, useState } from "react";
import { useToast } from "./Toast";
import { api } from "../lib/api";
import type { Config } from "../types";

type JiraStatus = {
	connected?: boolean;
	configured?: boolean;
	site?: string;
	siteUrl?: string;
	redirectUri?: string;
} | null;

const fieldCls = "rounded-[9px] bg-panel-2 px-3 py-[9px] text-[13px]";

export function ConfigPane({
	active,
	config,
	firstRun,
	onSaved,
}: {
	active: boolean;
	config: Config;
	firstRun: boolean;
	onSaved: (cfg: Config, configured: boolean) => void;
}) {
	const toast = useToast();
	const [owner, setOwner] = useState(config.owner);
	const [jira, setJira] = useState(config.jiraBase);
	const [clientId, setClientId] = useState(config.jiraClientId || "");
	const [clientSecret, setClientSecret] = useState(
		config.jiraClientSecret || "",
	);
	const [reportAgent, setReportAgent] = useState(config.reportAgent || "");
	const [agents, setAgents] = useState<
		{ id: string; label: string; version: string; path: string }[] | null
	>(null);
	const [scanning, setScanning] = useState(false);
	const [savedAt, setSavedAt] = useState("");
	const [js, setJs] = useState<JiraStatus>(null);
	const [hideFirstRun, setHideFirstRun] = useState(false);

	// config 가 갱신되면(저장 후) 폼 재동기화
	useEffect(() => {
		setOwner(config.owner);
		setJira(config.jiraBase);
		setClientId(config.jiraClientId || "");
		setClientSecret(config.jiraClientSecret || "");
		setReportAgent(config.reportAgent || "");
	}, [config]);

	async function scanAgents() {
		if (!window.api?.agent) return;
		setScanning(true);
		try {
			const r = await window.api.agent.scan();
			setAgents(r?.agents || []);
		} catch {
			setAgents([]);
		} finally {
			setScanning(false);
		}
	}

	async function refreshJira() {
		const j = window.api?.jira;
		if (!j) return;
		try {
			setJs(await j.status());
		} catch {
			setJs(null);
		}
	}
	useEffect(() => {
		if (active) {
			refreshJira();
			scanAgents();
		}
	}, [active]);

	async function save() {
		const next = {
			owner: owner.trim(),
			jiraBase: jira.trim(),
			jiraClientId: clientId.trim(),
			jiraClientSecret: clientSecret.trim(),
			reportAgent: reportAgent.trim(),
		};
		const r = await api<any>("PUT", "/api/config", next);
		if (r.ok && r.json && r.json.config) {
			onSaved(r.json.config, !!r.json.configured);
			setSavedAt(
				new Date().toLocaleTimeString("ko-KR", {
					hour: "2-digit",
					minute: "2-digit",
				}),
			);
			if (r.json.configured) setHideFirstRun(true);
			toast(
				r.json.configured
					? "설정 저장됨"
					: "저장됨 — Jira 주소·이름은 필수예요",
			);
			refreshJira();
		} else toast("설정 저장 실패");
	}

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
			toast("Jira 연결 해제됨");
		} catch {
			/* noop */
		}
		refreshJira();
	}

	const jiraText = !js
		? "—"
		: js.connected
			? "✅ 연결됨 — " + (js.site || js.siteUrl || "")
			: js.configured
				? "미연결 (client id/secret 저장됨)"
				: "client id/secret 을 입력하고 저장하세요";

	return (
		<div
			hidden={!active}
			className="fixed inset-x-0 bottom-0 top-tabh z-50 flex flex-col overflow-y-auto bg-bg"
		>
			<div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-5 pb-12 pt-7">
				<h2 className="m-0 text-xl font-extrabold text-ink">⚙️ 설정</h2>
				{firstRun && !hideFirstRun && (
					<p className="tint-accent m-0 rounded-[10px] px-3.5 py-2.5 text-[13px] text-ink">
						처음 실행이에요. 아래 값을 채우면 업무일지가 활성화됩니다. (Jira
						주소·이름 필수)
					</p>
				)}

				<label className="flex flex-col gap-1.5">
					<span className="text-[13px] font-bold text-ink">이름 (owner)</span>
					<input
						className={fieldCls}
						placeholder="홍길동"
						value={owner}
						onChange={(e) => setOwner(e.target.value)}
					/>
				</label>

				<label className="flex flex-col gap-1.5">
					<span className="text-[13px] font-bold text-ink">
						Jira 호스트 URL
					</span>
					<input
						className={fieldCls}
						placeholder="https://your-org.atlassian.net"
						value={jira}
						onChange={(e) => setJira(e.target.value)}
					/>
					<small className="text-xs text-ink-2">
						호스트만 넣으면 됩니다 —{" "}
						<code className="rounded-[5px] bg-panel px-[5px] py-px font-mono">
							/browse/티켓
						</code>{" "}
						은 자동으로 붙습니다.
					</small>
				</label>

				<h3 className="mt-4 border-t border-line pt-4 text-[15px] font-extrabold text-ink">
					🎫 Jira 연동 (OAuth 2.0 · 3LO)
				</h3>
				<p className="tint-accent m-0 rounded-[10px] px-3.5 py-2.5 text-xs text-ink">
					<button
						type="button"
						className="cursor-pointer border-0 bg-transparent p-0 font-inherit text-accent underline"
						onClick={() =>
							window.open(
								"https://developer.atlassian.com/console/myapps/",
								"_blank",
								"noopener",
							)
						}
					>
						developer.atlassian.com
					</button>{" "}
					→ <b>OAuth 2.0 (3LO)</b> 앱 생성 → Permissions 에 <b>Jira API</b>
					(read:jira-work, read:jira-user) 추가 → Authorization 의{" "}
					<b>Callback URL</b> 에 아래 값을 그대로 등록 → Settings 의 client
					id/secret 을 아래에 붙여넣으세요.
					<br />
					Callback URL:{" "}
					<code className="rounded-[5px] bg-panel px-[5px] py-px font-mono">
						{js?.redirectUri || "http://localhost:43117/callback"}
					</code>
				</p>

				<label className="flex flex-col gap-1.5">
					<span className="text-[13px] font-bold text-ink">Jira Client ID</span>
					<input
						className={fieldCls}
						placeholder="developer.atlassian.com 앱의 Client ID"
						value={clientId}
						onChange={(e) => setClientId(e.target.value)}
					/>
				</label>
				<label className="flex flex-col gap-1.5">
					<span className="text-[13px] font-bold text-ink">
						Jira Client Secret
					</span>
					<input
						className={fieldCls}
						type="password"
						placeholder="••••••••"
						value={clientSecret}
						onChange={(e) => setClientSecret(e.target.value)}
					/>
					<small className="text-xs text-ink-2">
						client secret·발급 토큰은 로컬 SQLite에만 저장됩니다(외부 전송
						없음).
					</small>
				</label>

				<div className="mt-1 flex items-center gap-3">
					<button type="button" className="btn btn-primary" onClick={connect}>
						{js?.connected ? "🔄 다시 연결" : "🔗 Jira 연결"}
					</button>
					{js?.connected && (
						<button type="button" className="btn btn-ghost" onClick={logout}>
							연결 해제
						</button>
					)}
					<span className="text-[13px] text-ink-2">{jiraText}</span>
				</div>

				<h3 className="mt-4 border-t border-line pt-4 text-[15px] font-extrabold text-ink">
					🤖 주간업무보고 에이전트
				</h3>
				<p className="tint-accent m-0 rounded-[10px] px-3.5 py-2.5 text-xs text-ink">
					주간보고의 <b>티켓키·진척%·마감</b>은 앱이 확정합니다. 에이전트는{" "}
					<b>서술만</b> 자연스럽게 다듬어요. 선택하지 않으면 결정적 집계
					텍스트만 생성합니다(에이전트 불필요).
				</p>
				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-3">
						<button
							type="button"
							className="btn btn-ghost"
							onClick={scanAgents}
							disabled={scanning}
						>
							{scanning ? "스캔 중…" : "🔍 에이전트 스캔"}
						</button>
						<span className="text-[13px] text-ink-2">
							{agents == null
								? "—"
								: agents.length
									? `${agents.length}개 발견`
									: "발견된 에이전트 없음"}
						</span>
					</div>
					<label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink">
						<input
							type="radio"
							name="reportAgent"
							checked={!reportAgent}
							onChange={() => setReportAgent("")}
						/>
						사용 안 함 (결정적 집계만)
					</label>
					{(agents || []).map((a) => (
						<label
							key={a.id}
							className="flex cursor-pointer items-center gap-2 text-[13px] text-ink"
						>
							<input
								type="radio"
								name="reportAgent"
								checked={reportAgent === a.id}
								onChange={() => setReportAgent(a.id)}
							/>
							{a.label}
							{a.version && (
								<span className="text-xs text-ink-2">· {a.version}</span>
							)}
						</label>
					))}
				</div>

				<div className="mt-1 flex items-center gap-3">
					<button type="button" className="btn btn-primary" onClick={save}>
						💾 설정 저장
					</button>
					<span className="text-[13px] text-ink-2">
						{savedAt && "저장됨 · " + savedAt}
					</span>
				</div>
			</div>
		</div>
	);
}
