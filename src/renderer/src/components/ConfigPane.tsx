import { useEffect, useState } from "react";
import { useToast } from "./Toast";
import { api } from "../lib/api";
import type { Config } from "../types";

type JiraStatus = {
	connected?: boolean;
	configured?: boolean;
	site?: string;
	siteUrl?: string;
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
	const [reportAgent, setReportAgent] = useState(config.reportAgent || "");
	const [lunchLat, setLunchLat] = useState(config.lunchLat || "");
	const [lunchLng, setLunchLng] = useState(config.lunchLng || "");
	const [lunchRadius, setLunchRadius] = useState(config.lunchRadius || "1000");
	const [agents, setAgents] = useState<
		{ id: string; label: string; version: string; path: string }[] | null
	>(null);
	const [scanning, setScanning] = useState(false);
	const [savedAt, setSavedAt] = useState("");
	const [js, setJs] = useState<JiraStatus>(null);
	const [me, setMe] = useState<{ user: string; isSetup: boolean } | null>(null);
	const [hideFirstRun, setHideFirstRun] = useState(false);

	// config 가 갱신되면(저장 후) 폼 재동기화
	useEffect(() => {
		setReportAgent(config.reportAgent || "");
		setLunchLat(config.lunchLat || "");
		setLunchLng(config.lunchLng || "");
		setLunchRadius(config.lunchRadius || "1000");
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
		const me = window.api?.me;
		if (!j) return;
		try {
			const [st, mi] = await Promise.all([j.status(), me ? me() : null]);
			setJs(st);
			setMe(mi);
		} catch {
			setJs(null);
			setMe(null);
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
			// owner·jiraBase 는 Jira 로그인이 자동 채움 — 기존 값 보존(설정 입력칸 없음).
			owner: config.owner,
			jiraBase: config.jiraBase,
			reportAgent: reportAgent.trim(),
			lunchLat: lunchLat.trim(),
			lunchLng: lunchLng.trim(),
			lunchRadius: lunchRadius.trim() || "1000",
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
			toast("로그아웃 — Jira 연결 해제됨");
		} catch {
			/* noop */
		}
		// 로그아웃 = 세션 만료 → user 가 setup 으로 복귀. 새 상태로 재부팅.
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
				{firstRun && !hideFirstRun && (
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

				<h3 className="mt-4 border-t border-line pt-4 text-[15px] font-extrabold text-ink">
					🍽️ 점심 (카카오 로컬 API)
				</h3>
				<p className="tint-accent m-0 rounded-[10px] px-3.5 py-2.5 text-xs text-ink">
					<button
						type="button"
						className="cursor-pointer border-0 bg-transparent p-0 font-inherit text-accent underline"
						onClick={() =>
							window.open(
								"https://developers.kakao.com/console/my-app",
								"_blank",
								"noopener",
							)
						}
					>
						developers.kakao.com
					</button>{" "}
					→ 내 앱 → 플랫폼 <b>Web</b> 추가 → 사이트 도메인 등록 →{" "}
					<b>REST API 키</b> 발급. 키는 서버 전역 secret 으로 관리됩니다 — 이
					설정화면이 아닌, 배포자가{" "}
					<code className="rounded-[5px] bg-panel px-[5px] py-px font-mono">
						wrangler secret put KAKAO_REST_KEY
					</code>{" "}
					로 등록합니다. 여기서는 사무실 좌표/반경만 설정합니다.
				</p>

				<div className="flex flex-col gap-1.5">
					<span className="text-[13px] font-bold text-ink">
						사무실 좌표 (위도·경도, WGS84)
					</span>
					<div className="flex items-center gap-2">
						<input
							className={fieldCls}
							style={{ width: 120 }}
							placeholder="위도(y)"
							value={lunchLat}
							onChange={(e) => setLunchLat(e.target.value)}
						/>
						<input
							className={fieldCls}
							style={{ width: 120 }}
							placeholder="경도(x)"
							value={lunchLng}
							onChange={(e) => setLunchLng(e.target.value)}
						/>
						<button
							type="button"
							className="btn btn-ghost"
							title="현재 위치 좌표로 채우기 (브라우저 위치 권한)"
							onClick={() => {
								navigator.geolocation?.getCurrentPosition(
									(pos) => {
										setLunchLat(String(pos.coords.latitude));
										setLunchLng(String(pos.coords.longitude));
										toast("현재 위치 좌표를 채웠어요");
									},
									() => toast("위치 권한이 필요해요"),
								);
							}}
						>
							📍 현재 위치
						</button>
					</div>
					<small className="text-xs text-ink-2">
						카카오맵에서 사무실 우클릭 → “이곳의 좌표”로 확인. 위도=세로(y),
						경도=가로(x).
					</small>
				</div>

				<label className="flex flex-col gap-1.5">
					<span className="text-[13px] font-bold text-ink">
						검색 반경 (m, 100~20000)
					</span>
					<input
						className={fieldCls}
						style={{ width: 120 }}
						placeholder="1000"
						value={lunchRadius}
						onChange={(e) => setLunchRadius(e.target.value)}
					/>
				</label>

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
