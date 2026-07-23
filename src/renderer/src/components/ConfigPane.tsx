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
	const [lunchLat, setLunchLat] = useState(config.lunchLat || "");
	const [lunchLng, setLunchLng] = useState(config.lunchLng || "");
	const [lunchRadius, setLunchRadius] = useState(config.lunchRadius || "1000");
	// BYOK AI — provider/model 은 config, 키는 서버 암호문으로만 저장(평문 미노출).
	type AiStatus = Awaited<ReturnType<NonNullable<typeof window.api.ai>["status"]>>;
	const [ai, setAi] = useState<AiStatus | null>(null);
	const [aiProvider, setAiProvider] = useState(config.reportProvider || "");
	const [aiModel, setAiModel] = useState(config.reportModel || "");
	const [aiBaseUrl, setAiBaseUrl] = useState(config.reportBaseUrl || "");
	const [aiKey, setAiKey] = useState("");
	const [aiModels, setAiModels] = useState<string[]>([]); // Test 로 불러온 모델 후보
	const [aiBusy, setAiBusy] = useState(false);
	const [aiTesting, setAiTesting] = useState(false);
	const [savedAt, setSavedAt] = useState("");
	const [js, setJs] = useState<JiraStatus>(null);
	const [me, setMe] = useState<{ user: string; isSetup: boolean } | null>(null);
	const [hideFirstRun, setHideFirstRun] = useState(false);

	// config 가 갱신되면(저장 후) 폼 재동기화
	useEffect(() => {
		setAiProvider(config.reportProvider || "");
		setAiModel(config.reportModel || "");
		setAiBaseUrl(config.reportBaseUrl || "");
		setLunchLat(config.lunchLat || "");
		setLunchLng(config.lunchLng || "");
		setLunchRadius(config.lunchRadius || "1000");
	}, [config]);

	async function refreshAi() {
		if (!window.api?.ai) return;
		try {
			const r = await window.api.ai.status();
			setAi(r);
			setAiProvider(r.provider || "");
			setAiModel(r.model || "");
			setAiBaseUrl(r.baseUrl || "");
		} catch {
			setAi(null);
		}
	}

	const aiProviderDef = (ai?.providers || []).find((p) => p.id === aiProvider);
	const aiNeedsBase = !!aiProviderDef?.custom;
	// 불러온 모델 목록 + (목록에 없는) 현재 저장 모델을 앞에 보장.
	const aiModelOptions =
		aiModel && !aiModels.includes(aiModel)
			? [aiModel, ...aiModels]
			: aiModels;

	async function testAi() {
		if (!window.api?.ai || aiTesting) return;
		if (!aiProvider) return toast("provider 를 선택하세요");
		if (!aiKey.trim()) return toast("API 키를 입력하세요");
		if (aiNeedsBase && !aiBaseUrl.trim())
			return toast("custom endpoint URL 을 입력하세요");
		setAiTesting(true);
		try {
			const r = await window.api.ai.test({
				provider: aiProvider,
				apiKey: aiKey.trim(),
				baseUrl: aiBaseUrl.trim(),
			});
			if (r?.ok) {
				setAiModels(r.models || []);
				// 모델 미선택이면 첫 후보/기본값으로 채움.
				if (!aiModel && r.models?.length)
					setAiModel(aiProviderDef?.defaultModel || r.models[0]);
				toast(`✅ 연결 성공 — 모델 ${r.models?.length ?? 0}개`);
			} else {
				setAiModels([]);
				toast("❌ 연결 실패: " + (r?.error || "알 수 없음"));
			}
		} catch {
			toast("❌ 연결 테스트 실패");
		} finally {
			setAiTesting(false);
		}
	}

	async function saveAiKey() {
		if (!window.api?.ai || aiBusy) return;
		if (!aiProvider) return toast("provider 를 선택하세요");
		if (!aiKey.trim()) return toast("API 키를 입력하세요");
		if (aiNeedsBase && !aiBaseUrl.trim())
			return toast("custom endpoint URL 을 입력하세요");
		setAiBusy(true);
		try {
			const model = aiModel || aiProviderDef?.defaultModel || "";
			const r = await window.api.ai.saveKey({
				provider: aiProvider,
				model,
				apiKey: aiKey.trim(),
				baseUrl: aiBaseUrl.trim(),
			});
			if (r?.ok) {
				setAiKey("");
				toast("AI 키 저장됨 (암호화 보관)");
				await refreshAi();
			} else toast("저장 실패: " + (r?.error || "알 수 없음"));
		} catch {
			toast("AI 키 저장 실패");
		} finally {
			setAiBusy(false);
		}
	}

	async function clearAiKey() {
		if (!window.api?.ai || aiBusy) return;
		setAiBusy(true);
		try {
			await window.api.ai.clearKey();
			setAiKey("");
			toast("AI 키 삭제됨 — 집계만 사용");
			await refreshAi();
		} catch {
			toast("삭제 실패");
		} finally {
			setAiBusy(false);
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
			refreshAi();
		}
	}, [active]);

	async function save() {
		const next = {
			// owner·jiraBase 는 Jira 로그인이 자동 채움 — 기존 값 보존(설정 입력칸 없음).
			owner: config.owner,
			jiraBase: config.jiraBase,
			// AI provider/model/baseUrl 은 비밀이 아니므로 일반 설정에도 포함(드롭다운 선택 유지).
			// API 키만 별도 암호화 저장(PUT /api/ai/key). 키 없이 모델만 바꿔도 여기서 저장됨.
			reportProvider: aiProvider,
			reportModel: aiModel.trim(),
			reportBaseUrl: aiNeedsBase ? aiBaseUrl.trim() : "",
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
					🤖 주간업무보고 AI (BYOK)
				</h3>
				<p className="tint-accent m-0 rounded-[10px] px-3.5 py-2.5 text-xs text-ink">
					주간보고의 <b>티켓키·진척%·마감</b>은 앱이 확정합니다. AI 는{" "}
					<b>서술만</b> 자연스럽게 다듬어요. 본인의 <b>API 키</b>를 등록하면
					사용하고, 없으면 결정적 집계 텍스트만 생성합니다. 키는{" "}
					<b>암호화(AES-256-GCM)</b>되어 서버에만 보관되며 화면에 다시 표시되지
					않습니다.
				</p>
				{ai && !ai.encReady && (
					<p className="m-0 rounded-[10px] bg-panel px-3.5 py-2.5 text-xs text-ink-2">
						⚠️ 서버에 <code>AI_ENC_KEY</code> secret 이 없어 키 저장이 불가합니다.
						배포자가 <code>wrangler secret put AI_ENC_KEY</code> 로 등록하세요.
					</p>
				)}
				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-2">
						<span className="text-[13px] text-ink-2">
							{ai?.hasKey
								? `✅ 키 등록됨 · ${ai.provider}${ai.model ? "/" + ai.model : ""}`
								: "키 미등록 — 결정적 집계만 사용"}
						</span>
						{ai?.hasKey && (
							<button
								type="button"
								className="btn btn-ghost"
								onClick={clearAiKey}
								disabled={aiBusy}
							>
								🗑️ 키 삭제
							</button>
						)}
					</div>
					<select
						className={fieldCls}
						style={{ maxWidth: 320 }}
						value={aiProvider}
						onChange={(e) => {
							const pid = e.target.value;
							setAiProvider(pid);
							const def = (ai?.providers || []).find((p) => p.id === pid);
							setAiModel(def?.defaultModel || "");
							setAiModels([]); // provider 바뀌면 모델 후보 초기화
						}}
					>
						<option value="">provider 선택…</option>
						{(ai?.providers || []).map((p) => (
							<option key={p.id} value={p.id}>
								{p.label}
							</option>
						))}
					</select>
					{aiNeedsBase && (
						<input
							className={fieldCls}
							style={{ width: 320 }}
							placeholder="https://예: openrouter.ai/api/v1 (OpenAI 호환 base URL)"
							value={aiBaseUrl}
							onChange={(e) => setAiBaseUrl(e.target.value)}
						/>
					)}
					{aiProvider && (
						<>
							<div className="flex flex-wrap items-center gap-2">
								<input
									className={fieldCls}
									style={{ width: 280 }}
									type="password"
									autoComplete="off"
									placeholder={
										ai?.hasKey
											? "새 키로 교체하려면 입력…"
											: aiProviderDef?.keyHint || "API 키"
									}
									value={aiKey}
									onChange={(e) => setAiKey(e.target.value)}
								/>
								<button
									type="button"
									className="btn btn-ghost"
									onClick={testAi}
									disabled={aiTesting || !aiKey.trim()}
									title="키·endpoint 로 연결 확인 후 모델 목록을 불러옵니다"
								>
									{aiTesting ? "테스트 중…" : "🧪 테스트 & 모델 불러오기"}
								</button>
							</div>
							<div className="flex flex-wrap items-center gap-2">
								{aiModels.length > 0 && (
									<select
										className={fieldCls}
										style={{ maxWidth: 320 }}
										value={aiModelOptions.includes(aiModel) ? aiModel : ""}
										onChange={(e) => setAiModel(e.target.value)}
									>
										<option value="">모델 선택… ({aiModels.length}개)</option>
										{aiModelOptions.map((m) => (
											<option key={m} value={m}>
												{m}
											</option>
										))}
									</select>
								)}
								{(aiModels.length === 0 || aiNeedsBase) && (
									<input
										className={fieldCls}
										style={{ width: 280 }}
										placeholder={
											aiModels.length
												? "또는 모델명 직접 입력"
												: aiProviderDef?.defaultModel ||
													"모델명 입력(테스트로 불러오기)"
										}
										value={aiModel}
										onChange={(e) => setAiModel(e.target.value)}
									/>
								)}
								<button
									type="button"
									className="btn btn-primary"
									onClick={saveAiKey}
									disabled={aiBusy || !ai?.encReady}
								>
									{aiBusy ? "저장 중…" : ai?.hasKey ? "키 교체" : "키 저장"}
								</button>
								{aiModels.length > 0 && (
									<span className="text-xs text-ink-2">
										{aiModels.length}개 모델 불러옴
									</span>
								)}
							</div>
						</>
					)}
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
