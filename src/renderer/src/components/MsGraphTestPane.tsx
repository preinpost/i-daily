// MsGraphTestPane.tsx — Microsoft Graph 실험/디버그 탭.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "./Toast";

type MsStatus = {
	configured?: boolean;
	connected?: boolean;
	displayName?: string;
	email?: string;
	scopes?: string[];
	clientIdPrefix?: string;
	tenantId?: string;
	error?: string;
} | null;

type GraphResult = {
	ok?: boolean;
	status?: number;
	url?: string;
	ms?: number;
	body?: unknown;
	error?: string;
} | null;

type Preset = {
	id: string;
	label: string;
	method: string;
	path: string;
	body?: string;
	hint?: string;
};

type ChatRow = {
	id: string;
	topic: string;
	chatType: string;
	updated: string;
	preview: string;
};

/** Graph /me/chats 응답 → 표용 행. */
function parseChats(body: unknown): ChatRow[] {
	const o = body as {
		value?: Array<{
			id?: string;
			topic?: string | null;
			chatType?: string;
			lastUpdatedDateTime?: string;
			lastMessagePreview?: {
				body?: { content?: string };
				from?: { user?: { displayName?: string } };
				createdDateTime?: string;
			};
			members?: Array<{ displayName?: string; email?: string }>;
		}>;
	};
	const list = Array.isArray(o?.value) ? o.value : [];
	return list.map((c) => {
		const members = (c.members || [])
			.map((m) => m.displayName || m.email || "")
			.filter(Boolean)
			.slice(0, 4)
			.join(", ");
		const topic =
			(c.topic || "").trim() ||
			members ||
			(c.chatType === "oneOnOne" ? "1:1 채팅" : "(제목 없음)");
		const prev = c.lastMessagePreview;
		const who = prev?.from?.user?.displayName || "";
		const text = (prev?.body?.content || "").replace(/<[^>]+>/g, "").trim();
		const preview = [who, text].filter(Boolean).join(": ").slice(0, 120);
		return {
			id: String(c.id || ""),
			topic,
			chatType: String(c.chatType || ""),
			updated: String(
				c.lastUpdatedDateTime || prev?.createdDateTime || "",
			),
			preview,
		};
	});
}

// members expand 는 테넌트/스코프에 따라 거절될 수 있어 preview 만.
const CHATS_PATH = "/me/chats?$top=50&$expand=lastMessagePreview";

const PRESETS: Preset[] = [
	{
		id: "me",
		label: "GET /me",
		method: "GET",
		path: "/me",
		hint: "프로필 (User.Read)",
	},
	{
		id: "me-select",
		label: "GET /me (필드)",
		method: "GET",
		path: "/me?$select=displayName,mail,userPrincipalName,jobTitle,officeLocation,mobilePhone,id",
		hint: "자주 쓰는 필드만",
	},
	{
		id: "chats",
		label: "GET /me/chats",
		method: "GET",
		path: CHATS_PATH,
		hint: "Teams 채팅 목록 (Chat.ReadWrite)",
	},
	{
		id: "joined-teams",
		label: "GET /me/joinedTeams",
		method: "GET",
		path: "/me/joinedTeams",
		hint: "참가 팀 목록",
	},
	{
		id: "drive-root",
		label: "GET /me/drive/root/children",
		method: "GET",
		path: "/me/drive/root/children?$top=20",
		hint: "OneDrive 루트 (Files.* 필요)",
	},
	{
		id: "calendar",
		label: "GET /me/calendar/events",
		method: "GET",
		path: "/me/calendar/events?$top=5&$orderby=start/dateTime",
		hint: "일정 (Calendars.Read 필요)",
	},
	{
		id: "send-chat",
		label: "POST chat message",
		method: "POST",
		path: "/chats/{chat-id}/messages",
		body: JSON.stringify(
			{ body: { contentType: "text", content: "hello from i-daily" } },
			null,
			2,
		),
		hint: "chat-id 바꿔서 전송 (Chat.ReadWrite)",
	},
];

function pretty(v: unknown): string {
	if (v == null) return "";
	if (typeof v === "string") {
		try {
			return JSON.stringify(JSON.parse(v), null, 2);
		} catch {
			return v;
		}
	}
	try {
		return JSON.stringify(v, null, 2);
	} catch {
		return String(v);
	}
}

export function MsGraphTestPane({ active }: { active: boolean }) {
	const toast = useToast();
	const [st, setSt] = useState<MsStatus>(null);
	const [method, setMethod] = useState("GET");
	const [path, setPath] = useState("/me");
	const [body, setBody] = useState("");
	const [busy, setBusy] = useState(false);
	const [chatsBusy, setChatsBusy] = useState(false);
	const [result, setResult] = useState<GraphResult>(null);
	const [chats, setChats] = useState<ChatRow[] | null>(null);
	const [chatsError, setChatsError] = useState<string | null>(null);
	const [history, setHistory] = useState<
		{ t: number; method: string; path: string; status?: number }[]
	>([]);

	const refresh = useCallback(async () => {
		try {
			const s = await window.api.microsoft.status();
			setSt(s);
		} catch {
			setSt(null);
		}
	}, []);

	useEffect(() => {
		if (active) refresh();
	}, [active, refresh]);

	function applyPreset(p: Preset) {
		setMethod(p.method);
		setPath(p.path);
		setBody(p.body || "");
		setResult(null);
	}

	async function loadChats() {
		if (chatsBusy) return;
		if (!st?.connected) {
			toast("먼저 설정에서 Microsoft를 연결하세요");
			return;
		}
		setChatsBusy(true);
		setChatsError(null);
		try {
			const r = (await window.api.microsoft.graph({
				method: "GET",
				path: CHATS_PATH,
			})) as GraphResult;
			setResult(r);
			setMethod("GET");
			setPath(CHATS_PATH);
			if (!r?.ok) {
				const errBody = r?.body as { error?: { message?: string; code?: string } } | null;
				const msg =
					errBody?.error?.message ||
					r?.error ||
					`Graph ${r?.status}`;
				setChats(null);
				setChatsError(String(msg));
				toast(`채팅 목록 실패: ${msg}`);
				return;
			}
			const rows = parseChats(r.body);
			setChats(rows);
			toast(`채팅 ${rows.length}개 불러옴`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			setChatsError(msg);
			toast("채팅 목록 실패: " + msg);
		} finally {
			setChatsBusy(false);
		}
	}

	function pickChat(c: ChatRow) {
		// 메시지 목록 path 채움 — 다음 실험용
		setMethod("GET");
		setPath(
			`/chats/${encodeURIComponent(c.id)}/messages?$top=20&$orderby=createdDateTime desc`,
		);
		setBody("");
		toast(`선택: ${c.topic} — 메시지 조회 path 채움`);
	}

	async function run() {
		if (busy) return;
		if (!st?.connected) {
			toast("먼저 설정에서 Microsoft를 연결하세요");
			return;
		}
		setBusy(true);
		setResult(null);
		try {
			let parsed: unknown = undefined;
			const trimmed = body.trim();
			if (trimmed && method !== "GET" && method !== "DELETE") {
				try {
					parsed = JSON.parse(trimmed);
				} catch {
					toast("Body JSON 파싱 실패");
					setBusy(false);
					return;
				}
			}
			const r = (await window.api.microsoft.graph({
				method,
				path,
				body: parsed,
			})) as GraphResult;
			setResult(r);
			setHistory((h) =>
				[
					{
						t: Date.now(),
						method,
						path,
						status: r?.status,
					},
					...h,
				].slice(0, 12),
			);
			if (r?.ok) toast(`OK ${r.status} · ${r.ms ?? "?"}ms`);
			else toast(`실패 ${r?.status ?? "?"} — ${r?.error || ""}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			setResult({ ok: false, status: 0, body: null, error: msg });
			toast("요청 실패: " + msg);
		} finally {
			setBusy(false);
		}
	}

	const statusLine = useMemo(() => {
		if (!st) return "상태 확인 중…";
		if (!st.configured) return "서버에 Microsoft OAuth 미설정";
		if (!st.connected) return "미연결 — 설정 탭에서 Microsoft 연결";
		const who =
			st.displayName || st.email
				? `${st.displayName || ""}${st.email ? ` <${st.email}>` : ""}`
				: "연결됨";
		const sc =
			st.scopes && st.scopes.length
				? ` · scopes: ${st.scopes.join(" ")}`
				: "";
		const dbg = [
			st.clientIdPrefix ? `app ${st.clientIdPrefix}…` : "",
			st.tenantId ? `tenant ${st.tenantId}` : "",
		]
			.filter(Boolean)
			.join(" · ");
		return `✅ ${who}${sc}${dbg ? ` · ${dbg}` : ""}`;
	}, [st]);

	return (
		<div
			hidden={!active}
			className="fixed inset-x-0 bottom-0 top-[var(--chrome-offset,48px)] z-40 flex flex-col overflow-y-auto bg-bg"
		>
			<div className="mx-auto flex w-full max-w-[960px] flex-col gap-3.5 px-5 pb-12 pt-5">
				<div className="flex flex-wrap items-start justify-between gap-2">
					<div>
						<h2 className="m-0 text-[18px] font-bold tracking-[-0.02em] text-ink">
							Graph 테스트
						</h2>
						<p className="m-0 mt-1 text-[13px] text-ink-2">
							Microsoft Graph를 서버 프록시로 호출합니다. 스코프 없는 API는
							401/403이 납니다 — 그때 권한을 늘리면 됩니다.
						</p>
					</div>
					<button
						type="button"
						className="btn btn-ghost shrink-0"
						onClick={refresh}
					>
						상태 새로고침
					</button>
				</div>

				<p
					className={
						"m-0 rounded-[10px] px-3.5 py-2.5 text-[13px] " +
						(st?.connected
							? "bg-panel text-ink"
							: "tint-accent text-ink")
					}
				>
					{statusLine}
				</p>

				{/* Teams chats */}
				<div className="flex flex-col gap-2 rounded-[12px] border border-line bg-panel p-3.5">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-[14px] font-bold text-ink">
							Teams 채팅 목록
						</span>
						<button
							type="button"
							className="btn btn-primary ml-auto"
							disabled={chatsBusy || !st?.connected}
							onClick={loadChats}
						>
							{chatsBusy ? "불러오는 중…" : "목록 불러오기"}
						</button>
					</div>
					<p className="m-0 text-[12.5px] text-ink-2">
						<code className="rounded bg-bg px-1 font-mono text-[11.5px]">
							GET /me/chats
						</code>{" "}
						— Azure에 Chat.ReadWrite 동의 후에도, 토큰에 스코프가 없으면
						실패합니다. 스코프 변경 후 설정에서 Microsoft **다시 연결**
						하세요. 행을 누르면 메시지 조회 path가 채워집니다.
					</p>
					{chatsError && (
						<p className="tint-accent m-0 rounded-[8px] px-3 py-2 text-[12.5px] text-ink">
							{chatsError}
						</p>
					)}
					{chats && chats.length === 0 && (
						<p className="m-0 text-[13px] text-ink-2">채팅이 없습니다.</p>
					)}
					{chats && chats.length > 0 && (
						<div className="max-h-[320px] overflow-auto rounded-[8px] border border-line">
							<table className="w-full border-collapse text-left text-[12.5px]">
								<thead className="sticky top-0 bg-panel-2 text-ink-2">
									<tr>
										<th className="px-2.5 py-1.5 font-semibold">제목</th>
										<th className="px-2.5 py-1.5 font-semibold">유형</th>
										<th className="px-2.5 py-1.5 font-semibold">미리보기</th>
									</tr>
								</thead>
								<tbody>
									{chats.map((c) => (
										<tr
											key={c.id}
											className="cursor-pointer border-t border-line hover:bg-bg"
											onClick={() => pickChat(c)}
											title={c.id}
										>
											<td className="max-w-[200px] truncate px-2.5 py-1.5 font-medium text-ink">
												{c.topic}
											</td>
											<td className="whitespace-nowrap px-2.5 py-1.5 text-ink-2">
												{c.chatType}
											</td>
											<td className="max-w-[280px] truncate px-2.5 py-1.5 text-ink-2">
												{c.preview || "—"}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>

				{/* presets */}
				<div className="flex flex-col gap-1.5">
					<span className="text-[13px] font-bold text-ink">프리셋</span>
					<div className="flex flex-wrap gap-1.5">
						{PRESETS.map((p) => (
							<button
								key={p.id}
								type="button"
								title={p.hint}
								className="btn btn-ghost px-2.5 py-1 text-[12px]"
								onClick={() => applyPreset(p)}
							>
								{p.label}
							</button>
						))}
					</div>
				</div>

				{/* request builder */}
				<div className="flex flex-col gap-2 rounded-[12px] border border-line bg-panel p-3.5">
					<div className="flex flex-wrap items-center gap-2">
						<select
							className="input w-auto min-w-[7rem]"
							value={method}
							onChange={(e) => setMethod(e.target.value)}
						>
							{["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
								<option key={m} value={m}>
									{m}
								</option>
							))}
						</select>
						<input
							className="input min-w-0 flex-1 font-mono text-[13px]"
							value={path}
							onChange={(e) => setPath(e.target.value)}
							placeholder="/me 또는 https://graph.microsoft.com/v1.0/..."
							spellCheck={false}
						/>
						<button
							type="button"
							className="btn btn-primary shrink-0"
							disabled={busy || !st?.connected}
							onClick={run}
						>
							{busy ? "호출 중…" : "보내기"}
						</button>
					</div>
					{(method === "POST" ||
						method === "PUT" ||
						method === "PATCH") && (
						<textarea
							className="input min-h-[120px] resize-y font-mono text-[12.5px] leading-relaxed"
							value={body}
							onChange={(e) => setBody(e.target.value)}
							placeholder='JSON body 예: { "body": { "content": "hi" } }'
							spellCheck={false}
						/>
					)}
					<p className="m-0 text-[11.5px] text-ink-2">
						path는{" "}
						<code className="rounded bg-bg px-1 font-mono">/me</code> 처럼
						쓰면 자동으로{" "}
						<code className="rounded bg-bg px-1 font-mono">
							https://graph.microsoft.com/v1.0
						</code>{" "}
						가 붙습니다. beta는{" "}
						<code className="rounded bg-bg px-1 font-mono">/beta/...</code>
					</p>
				</div>

				{/* response */}
				<div className="flex flex-col gap-1.5">
					<div className="flex items-center gap-2">
						<span className="text-[13px] font-bold text-ink">응답</span>
						{result && (
							<span className="text-[12px] text-ink-2">
								status {result.status}
								{result.ms != null ? ` · ${result.ms}ms` : ""}
								{result.url ? ` · ${result.url}` : ""}
							</span>
						)}
						{result && (
							<button
								type="button"
								className="btn btn-ghost ml-auto px-2 py-1 text-[11px]"
								onClick={async () => {
									try {
										await navigator.clipboard.writeText(pretty(result.body));
										toast("응답 복사됨");
									} catch {
										toast("복사 실패");
									}
								}}
							>
								복사
							</button>
						)}
					</div>
					<pre className="m-0 max-h-[480px] overflow-auto rounded-[10px] bg-panel px-3.5 py-3 font-mono text-[12px] leading-relaxed text-ink whitespace-pre-wrap break-all">
						{result
							? pretty(
									result.error && !result.body
										? { error: result.error, status: result.status }
										: result.body,
								) || "(empty)"
							: "아직 호출 없음 — 프리셋 고르거나 path 입력 후 보내기"}
					</pre>
				</div>

				{history.length > 0 && (
					<div className="flex flex-col gap-1.5">
						<span className="text-[13px] font-bold text-ink">최근 호출</span>
						<ul className="m-0 list-none space-y-1 p-0">
							{history.map((h) => (
								<li key={h.t}>
									<button
										type="button"
										className="btn btn-ghost w-full justify-start px-2 py-1 text-left font-mono text-[12px]"
										onClick={() => {
											setMethod(h.method);
											setPath(h.path);
										}}
									>
										<span className="text-ink-2">{h.status ?? "—"}</span>
										<span className="ml-2 font-semibold">{h.method}</span>
										<span className="ml-2 truncate">{h.path}</span>
									</button>
								</li>
							))}
						</ul>
					</div>
				)}
			</div>
		</div>
	);
}
