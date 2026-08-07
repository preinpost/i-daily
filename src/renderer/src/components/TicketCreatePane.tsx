// TicketCreatePane.tsx — 내 티켓 탭의 '업무등록' 부속 화면.
// Jira createmeta 로 프로젝트 → 이슈타입 → 생성 필드를 동적으로 그려 티켓을 생성한다.
// 생성 후에는 (부모가 준) 콜백으로 목록 갱신/일일 추가를 이어받는다.
import { useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "./Toast";
import { MarkdownEditor } from "./MarkdownEditor";

type Issue = {
	key: string;
	summary: string;
	type?: string;
	status?: string;
	url?: string;
};

type Allow = { id: string; name: string; value?: string };
type FieldMeta = {
	key: string;
	name: string;
	required: boolean;
	type: string;
	system: string;
	allowedValues: Allow[];
};
type Project = {
	id: string;
	key: string;
	name: string;
	issueTypes: { id: string; name: string; subtask: boolean }[];
};

// createmeta 폼 설계: summary/description 는 상단 고정, 그 외 시스템 필드 순서대로.
const EXTRA_SYSTEMS = [
	"priority",
	"duedate",
	"labels",
	"components",
	"versions",
	"assignee",
	"reporter",
];

// select 계열에서 option 을 만들어 준다(기본값 자리 마련).
const labelOf = (a: Allow) => a.name || a.value || a.id;

// 즐겨찾는 프로젝트 (별표) — localStorage 보존.
const FAV_KEY = "fav-projects";
function loadFavs(): string[] {
	try {
		const v = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}

// 검색 가능한 프로젝트 콤보박스 — key(IIPQ 등)/이름으로 필터 + 별표 즐겨찾기.
function ProjectPicker({
	projects,
	value,
	onPick,
}: {
	projects: Project[];
	value: string;
	onPick: (key: string) => void;
}) {
	const [q, setQ] = useState("");
	const [open, setOpen] = useState(false);
	const [hi, setHi] = useState(0);
	const [favs, setFavs] = useState<Set<string>>(() => new Set(loadFavs()));
	const boxRef = useRef<HTMLDivElement>(null);

	const selected = projects.find((p) => p.key === value);
	const isFav = !!value && favs.has(value);
	// 닫힌 상태에선 선택된 라벨, 열린 상태에선 입력 중인 검색어를 보여준다.
	const query = selected && !open ? `${selected.key} · ${selected.name}` : q;

	const filtered = useMemo(() => {
		const s = q.trim().toLowerCase();
		const base = !s
			? projects
			: projects.filter(
					(p) =>
						p.key.toLowerCase().includes(s) ||
						p.name.toLowerCase().includes(s),
				);
		return {
			fav: base.filter((p) => favs.has(p.key)),
			rest: base.filter((p) => !favs.has(p.key)),
		};
	}, [projects, q, favs]);
	// 하이라이트/키보드는 즐겨찾기 → 나머지 순의 평탄 목록으로 다룬다.
	const ordered = useMemo(
		() => [...filtered.fav, ...filtered.rest],
		[filtered],
	);
	const total = ordered.length;

	useEffect(() => setHi(0), [q, total]);

	// 외부 클릭 시 닫기.
	useEffect(() => {
		if (!open) return;
		const onDoc = (e: MouseEvent) => {
			if (boxRef.current && !boxRef.current.contains(e.target as Node))
				setOpen(false);
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [open]);

	function choose(p: Project) {
		onPick(p.key);
		setQ("");
		setOpen(false);
	}

	function toggleFav(key: string) {
		if (!key) return;
		setFavs((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			localStorage.setItem(FAV_KEY, JSON.stringify([...next]));
			return next;
		});
	}

	const row = (p: Project, i: number) => (
		<button
			key={p.key}
			type="button"
			onMouseDown={(e) => {
				e.preventDefault();
				choose(p);
			}}
			onMouseEnter={() => setHi(i)}
			className={
				"flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] " +
				(i === hi ? "bg-accent-soft text-ink" : "text-ink")
			}
		>
			<span
				role="button"
				title={favs.has(p.key) ? "즐겨찾기 해제" : "즐겨찾기 등록"}
				onMouseDown={(e) => {
					e.preventDefault();
					e.stopPropagation();
					toggleFav(p.key);
				}}
				onClick={(e) => e.stopPropagation()}
				className={
					"w-4 shrink-0 cursor-pointer rounded-[4px] text-center text-[14px] leading-none transition-colors " +
					(favs.has(p.key)
						? "text-amber-500 hover:text-amber-600"
						: "text-ink-2 hover:text-amber-500")
				}
			>
				{favs.has(p.key) ? "★" : "☆"}
			</span>
			<span className="font-mono font-bold text-accent-text">{p.key}</span>
			<span className="truncate text-ink-2">{p.name}</span>
		</button>
	);

	return (
		<div ref={boxRef} className="relative">
			<input
				value={query}
				placeholder="검색: ID(예: IIPQ) 또는 프로젝트 이름"
				style={{ paddingLeft: 30 }}
				onFocus={() => {
					setOpen(true);
					setQ("");
					setHi(0);
				}}
				onChange={(e) => {
					setQ(e.target.value);
					setHi(0);
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown") {
						e.preventDefault();
						setOpen(true);
						setHi((h) => Math.min(h + 1, total - 1));
					} else if (e.key === "ArrowUp") {
						e.preventDefault();
						setHi((h) => Math.max(h - 1, 0));
					} else if (e.key === "Enter") {
						e.preventDefault();
						if (open && ordered[hi]) choose(ordered[hi]);
						else setOpen(true);
					} else if (e.key === "Escape") {
						setOpen(false);
						setQ("");
					} else {
						setOpen(true);
					}
				}}
			/>
			{/* 별표 — 현재 선택 프로젝트를 즐겨찾기 토글 */}
			{value && (
				<button
					type="button"
					title={isFav ? "즐겨찾기 해제" : "즐겨찾기 등록"}
					onMouseDown={(e) => {
						e.preventDefault();
						e.stopPropagation();
						toggleFav(value);
					}}
					onClick={(e) => e.stopPropagation()}
					className={
						"absolute left-1.5 top-1/2 -translate-y-1/2 cursor-pointer rounded-[5px] px-1 py-0.5 text-[15px] leading-none transition-colors " +
						(isFav
							? "text-amber-500 hover:text-amber-600"
							: "text-ink-2 hover:text-amber-500")
					}
				>
					{isFav ? "★" : "☆"}
				</button>
			)}
			{open && (
				<div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-[6px] border border-line bg-panel shadow-card">
					{!total ? (
						<div className="px-3 py-2 text-[12.5px] text-ink-2">
							일치하는 프로젝트 없음
						</div>
					) : (
						<>
							{filtered.fav.length > 0 && (
								<>
									<div className="flex items-center gap-1 px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wide text-ink-2">
										★ 즐겨찾기
									</div>
									{filtered.fav.map((p, i) => row(p, i))}
								</>
							)}
							{filtered.fav.length > 0 && filtered.rest.length > 0 && (
								<div className="my-1 border-t border-line" />
							)}
							{filtered.rest.length > 0 && (
								<>
									{filtered.fav.length > 0 && (
										<div className="flex items-center gap-1 px-3 pb-1 pt-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-2">
											전체
										</div>
									)}
									{filtered.rest.map((p, i) =>
										row(p, i + filtered.fav.length),
									)}
								</>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}

type User = {
	accountId: string;
	displayName: string;
	emailAddress?: string;
	active?: boolean;
};

// 즐겨찾는 사용자 (별표) — localStorage 보존.
const FAV_USERS_KEY = "fav-users";
function loadFavUsers(): string[] {
	try {
		const v = JSON.parse(localStorage.getItem(FAV_USERS_KEY) || "[]");
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}

// 검색 가능한 사용자 콤보박스 — 이름/이메일로 필터 + 별표 즐겨찾기 (담당자/보고자).
export function UserPicker({
	users,
	value,
	onPick,
}: {
	users: User[];
	value: string;
	onPick: (accountId: string) => void;
}) {
	const [q, setQ] = useState("");
	const [open, setOpen] = useState(false);
	const [hi, setHi] = useState(0);
	const [favs, setFavs] = useState<Set<string>>(() => new Set(loadFavUsers()));
	const boxRef = useRef<HTMLDivElement>(null);

	const selected = users.find((u) => u.accountId === value);
	const isFav = !!value && favs.has(value);
	const query = selected && !open ? (selected.displayName || selected.accountId) : q;

	const filtered = useMemo(() => {
		const s = q.trim().toLowerCase();
		const base = !s
			? users
			: users.filter(
					(u) =>
						u.displayName.toLowerCase().includes(s) ||
						(u.emailAddress || "").toLowerCase().includes(s),
				);
		return {
			fav: base.filter((u) => favs.has(u.accountId)),
			rest: base.filter((u) => !favs.has(u.accountId)),
		};
	}, [users, q, favs]);
	const ordered = useMemo(
		() => [...filtered.fav, ...filtered.rest],
		[filtered],
	);
	const total = ordered.length;

	useEffect(() => setHi(0), [q, total]);

	useEffect(() => {
		if (!open) return;
		const onDoc = (e: MouseEvent) => {
			if (boxRef.current && !boxRef.current.contains(e.target as Node))
				setOpen(false);
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [open]);

	function choose(u: User) {
		onPick(u.accountId);
		setQ("");
		setOpen(false);
	}
	function toggleFav(accountId: string) {
		if (!accountId) return;
		setFavs((prev) => {
			const next = new Set(prev);
			if (next.has(accountId)) next.delete(accountId);
			else next.add(accountId);
			localStorage.setItem(FAV_USERS_KEY, JSON.stringify([...next]));
			return next;
		});
	}

	const row = (u: User, i: number) => (
		<button
			key={u.accountId}
			type="button"
			onMouseDown={(e) => {
				e.preventDefault();
				choose(u);
			}}
			onMouseEnter={() => setHi(i)}
			className={
				"flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] " +
				(i === hi ? "bg-accent-soft text-ink" : "text-ink")
			}
		>
			<span
				role="button"
				title={favs.has(u.accountId) ? "즐겨찾기 해제" : "즐겨찾기 등록"}
				onMouseDown={(e) => {
					e.preventDefault();
					e.stopPropagation();
					toggleFav(u.accountId);
				}}
				onClick={(e) => e.stopPropagation()}
				className={
					"w-4 shrink-0 cursor-pointer rounded-[4px] text-center text-[14px] leading-none transition-colors " +
					(favs.has(u.accountId)
						? "text-amber-500 hover:text-amber-600"
						: "text-ink-2 hover:text-amber-500")
				}
			>
				{favs.has(u.accountId) ? "★" : "☆"}
			</span>
			<span className="truncate font-medium">{u.displayName}</span>
			{u.emailAddress && (
				<span className="truncate text-[11.5px] text-ink-2">{u.emailAddress}</span>
			)}
		</button>
	);

	return (
		<div ref={boxRef} className="relative">
			<input
				value={query}
				placeholder="검색: 이름 또는 이메일"
				style={{ paddingLeft: 30 }}
				onFocus={() => {
					setOpen(true);
					setQ("");
					setHi(0);
				}}
				onChange={(e) => {
					setQ(e.target.value);
					setHi(0);
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown") {
						e.preventDefault();
						setOpen(true);
						setHi((h) => Math.min(h + 1, total - 1));
					} else if (e.key === "ArrowUp") {
						e.preventDefault();
						setHi((h) => Math.max(h - 1, 0));
					} else if (e.key === "Enter") {
						e.preventDefault();
						if (open && ordered[hi]) choose(ordered[hi]);
						else setOpen(true);
					} else if (e.key === "Escape") {
						setOpen(false);
						setQ("");
					} else {
						setOpen(true);
					}
				}}
			/>
			{value && (
				<button
					type="button"
					title={isFav ? "즐겨찾기 해제" : "즐겨찾기 등록"}
					onMouseDown={(e) => {
						e.preventDefault();
						e.stopPropagation();
						toggleFav(value);
					}}
					onClick={(e) => e.stopPropagation()}
					className={
						"absolute left-1.5 top-1/2 -translate-y-1/2 cursor-pointer rounded-[5px] px-1 py-0.5 text-[15px] leading-none transition-colors " +
						(isFav
							? "text-amber-500 hover:text-amber-600"
							: "text-ink-2 hover:text-amber-500")
					}
				>
					{isFav ? "★" : "☆"}
				</button>
			)}
			{open && (
				<div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-[6px] border border-line bg-panel shadow-card">
					{!total ? (
						<div className="px-3 py-2 text-[12.5px] text-ink-2">
							일치하는 사용자 없음
						</div>
					) : (
						<>
							{filtered.fav.length > 0 && (
								<>
									<div className="flex items-center gap-1 px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wide text-ink-2">
										★ 즐겨찾기
									</div>
									{filtered.fav.map((u, i) => row(u, i))}
								</>
							)}
							{filtered.fav.length > 0 && filtered.rest.length > 0 && (
								<div className="my-1 border-t border-line" />
							)}
							{filtered.rest.length > 0 && (
								<>
									{filtered.fav.length > 0 && (
										<div className="flex items-center gap-1 px-3 pb-1 pt-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-2">
											전체
										</div>
									)}
									{filtered.rest.map((u, i) => row(u, i + filtered.fav.length))}
								</>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}

// 상위 항목(부모 티켓) 선택 — 티켓 ID/제목으로 검색(서버 검색 디바운스, 즐겨찾기 없음).
export function ParentPicker({
	project,
	value,
	onPick,
}: {
	project: string;
	value: string;
	onPick: (issue: Issue) => void; // key + summary 함께 전달
}) {
	const [q, setQ] = useState("");
	const [open, setOpen] = useState(false);
	const [hi, setHi] = useState(0);
	const [results, setResults] = useState<Issue[]>([]);
	const [fetching, setFetching] = useState(false);
	const [sel, setSel] = useState<Issue | null>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const seq = useRef(0);

	// 외부(프로젝트/타입 변경 시 초기화)에서 value 가 비워지면 sel 도 리셋.
	useEffect(() => {
		if (!value) setSel(null);
	}, [value]);

	// 검색어가 바뀌면 디바운스 후 서버에서 조회.
	useEffect(() => {
		if (!open || !project) return;
		const id = ++seq.current;
		setFetching(true);
		const t = setTimeout(async () => {
			const r = await window.api?.jira?.searchIssues?.(project, q.trim());
			if (id !== seq.current) return;
			setResults(r?.ok ? r.issues || [] : []);
			setHi(0);
			setFetching(false);
		}, 280);
		return () => clearTimeout(t);
	}, [q, open, project]);

	// 외부 클릭 시 닫기.
	useEffect(() => {
		if (!open) return;
		const onDoc = (e: MouseEvent) => {
			if (boxRef.current && !boxRef.current.contains(e.target as Node))
				setOpen(false);
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [open]);

	const query =
		sel && !open
			? `${sel.key}${sel.summary ? " · " + sel.summary : ""}`
			: q;

	function choose(iss: Issue) {
		setSel(iss);
		onPick(iss);
		setQ("");
		setOpen(false);
	}

	return (
		<div ref={boxRef} className="relative">
			<input
				value={query}
				placeholder="검색: 티켓 ID(예: IIPQ-123) 또는 제목"
				onFocus={() => {
					setOpen(true);
					setQ("");
					setHi(0);
				}}
				onChange={(e) => {
					setQ(e.target.value);
					setHi(0);
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown") {
						e.preventDefault();
						setOpen(true);
						setHi((h) => Math.min(h + 1, results.length - 1));
					} else if (e.key === "ArrowUp") {
						e.preventDefault();
						setHi((h) => Math.max(h - 1, 0));
					} else if (e.key === "Enter") {
						e.preventDefault();
						if (open && results[hi]) choose(results[hi]);
						else setOpen(true);
					} else if (e.key === "Escape") {
						setOpen(false);
						setQ("");
					} else {
						setOpen(true);
					}
				}}
			/>
			{open && (
				<div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-[6px] border border-line bg-panel shadow-card">
					{fetching && !results.length ? (
						<div className="px-3 py-2 text-[12.5px] text-ink-2">검색 중…</div>
					) : !results.length ? (
						<div className="px-3 py-2 text-[12.5px] text-ink-2">
							일치하는 티켓 없음
						</div>
					) : (
						results.map((iss, i) => (
							<button
								key={iss.key}
								type="button"
								onMouseDown={(e) => {
									e.preventDefault();
									choose(iss);
								}}
								onMouseEnter={() => setHi(i)}
								className={
									"flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] " +
									(i === hi ? "bg-accent-soft text-ink" : "text-ink")
								}
							>
								<span className="font-mono font-bold text-accent-text">
									{iss.key}
								</span>
								<span className="truncate">{iss.summary}</span>
								{iss.status && (
									<span className="ml-auto shrink-0 text-[11.5px] text-ink-2">
										{iss.status}
									</span>
								)}
							</button>
						))
					)}
				</div>
			)}
		</div>
	);
}

export function TicketCreatePane({
	onCreated,
	onViewChange,
}: {
	onCreated?: (t: { key: string; summary: string }) => void;
	onViewChange?: (v: "create" | "list") => void;
}) {
	const toast = useToast();
	const [metaLoading, setMetaLoading] = useState(true);
	const [metaError, setMetaError] = useState("");
	const [projects, setProjects] = useState<Project[]>([]);
	const [site, setSite] = useState("");

	const [projectKey, setProjectKey] = useState("");
	const [issueTypeId, setIssueTypeId] = useState("");
	const [fieldsMeta, setFieldsMeta] = useState<FieldMeta[]>([]);
	const [fieldsLoading, setFieldsLoading] = useState(false);
	const [fieldsError, setFieldsError] = useState("");
	// 프로젝트의 배정 가능 사용자(담당자/보고자 드롭박스용) + 로그인 유저(/me).
	const [users, setUsers] = useState<User[]>([]);
	const [currentUser, setCurrentUser] = useState("");

	// 스칼라 입력값(요약/설명/선택/날짜/라벨 텍스트…) — field key → raw string
	const [values, setValues] = useState<Record<string, string>>({});
	// 다중 선택(컴포넌트/버전…) — field key → 선택된 id[]
	const [multi, setMulti] = useState<Record<string, string[]>>({});

	const [submitting, setSubmitting] = useState(false);
	const [created, setCreated] = useState<{ key: string; summary: string; url: string } | null>(null);
	const seen = useRef(false);

	const setVal = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));
	const toggleMulti = (k: string, id: string) =>
		setMulti((s) => {
			const cur = s[k] || [];
			return { ...s, [k]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
		});

	// 프로젝트/이슈타입 메타 로드(1회).
	useEffect(() => {
		if (seen.current) return;
		seen.current = true;
		(async () => {
			const r = await window.api?.jira?.createMeta?.();
			if (!r || !r.ok) {
				setMetaError(r?.error || "생성 메타를 불러오지 못했습니다 (Jira 연결 확인).");
				setMetaLoading(false);
				return;
			}
			setProjects(r.projects || []);
			setSite(r.site || "");
			setMetaLoading(false);
		})();
	}, []);

	// 프로젝트 변경 → 이슈타입/필드 초기화.
	function pickProject(key: string) {
		setProjectKey(key);
		setIssueTypeId("");
		setFieldsMeta([]);
		setValues({});
		setMulti({});
		setFieldsError("");
		setCreated(null);
	}

	// 이슈타입 선택 → 해당 조합의 필드 메타 조회.
	useEffect(() => {
		if (!projectKey || !issueTypeId) return;
		let cancelled = false;
		setFieldsLoading(true);
		setFieldsError("");
		setCreated(null);
		(async () => {
			const r = await window.api?.jira?.createFields?.(projectKey, issueTypeId);
			if (cancelled) return;
			setFieldsLoading(false);
			if (!r || !r.ok) {
				setFieldsError(r?.error || "필드 메타를 불러오지 못했습니다.");
				setFieldsMeta([]);
				return;
			}
			setFieldsMeta(r.fields || []);
		})();
		return () => {
			cancelled = true;
		};
	}, [projectKey, issueTypeId]);

	// 프로젝트 변경 → 배정 가능 사용자 로드(/me 기본값 포함).
	useEffect(() => {
		if (!projectKey) {
			setUsers([]);
			setCurrentUser("");
			return;
		}
		let cancelled = false;
		(async () => {
			const r = await window.api?.jira?.users?.(projectKey);
			if (cancelled) return;
			if (r?.ok) {
				setUsers(r.users || []);
				setCurrentUser(r.current || "");
			} else {
				setUsers([]);
				setCurrentUser("");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [projectKey]);

	// 담당자/보고자 기본값 → 로그인 유저(/me). 사용자가 지운 경우엔 다시 안 덮는다.
	useEffect(() => {
		if (!currentUser) return;
		setValues((s) => {
			let changed = false;
			const next = { ...s };
			for (const f of fieldsMeta) {
				if (
					(f.system === "assignee" || f.system === "reporter") &&
					!(next[f.key] || "")
				) {
					next[f.key] = currentUser;
					changed = true;
				}
			}
			return changed ? next : s;
		});
	}, [currentUser, fieldsMeta]);

	const curProject = projects.find((p) => p.key === projectKey);
	const issueTypes = curProject?.issueTypes || [];

	// 상단 배치(요약·설명)를 제외한 나머지 표시 필드:
	//  - 알려진 시스템 필드(우선순위/마감/라벨/컴포넌트/버전/담당자/리포터)는 있으면 표시
	//  - 그 외 필수 필드는 놓치지 않도록 끝에 표시(optional 커스텀 필드는 숨김 — 소음 방지)
	const { core, extras } = useMemo(() => {
		const map = new Map(fieldsMeta.map((f) => [f.key, f]));
		const sum = map.get("summary");
		const desc = map.get("description");
		const known = new Set(EXTRA_SYSTEMS);
		const extra = fieldsMeta
			.filter((f) => f.key !== "summary" && f.key !== "description")
			// 위쪽 프로젝트/이슈타입 선택과 중복인 시스템 필드(project/issuetype)는 제외.
			.filter((f) => f.system !== "project" && f.system !== "issuetype")
			.filter((f) => f.key !== "project" && f.key !== "issuetype")
			.filter((f) => known.has(f.system) || f.required)
			.sort((a, b) => {
				const ai = EXTRA_SYSTEMS.indexOf(a.system);
				const bi = EXTRA_SYSTEMS.indexOf(b.system);
				if (ai !== -1 && bi !== -1) return ai - bi;
				if (ai !== -1) return -1;
				if (bi !== -1) return 1;
				return 0;
			});
		return { core: [sum, desc].filter(Boolean) as FieldMeta[], extras: extra };
	}, [fieldsMeta]);

	// 하나의 raw 값(string)을 Jira 가 원하는 JSON 으로 변환.
	function toJiraScalar(f: FieldMeta, raw: string): unknown {
		const v = (raw || "").trim();
		if (!v) return undefined;
		switch (f.system) {
			case "priority": {
				const av = f.allowedValues.find((a) => a.id === v);
				return av ? { id: av.id } : { name: v };
			}
			case "assignee":
			case "reporter": {
				// UserPicker 가 accountId 를 준다.
				return { accountId: v };
			}
			case "labels":
				return v.split(/[\s,]+/).filter(Boolean);
			case "parent":
				// 상위 항목 — ParentPicker 가 티켓 키를 준다.
				return { key: v };
			default: {
				if (f.allowedValues.length) {
					const av = f.allowedValues.find((a) => a.id === v);
					if (av) return av.id ? { id: av.id } : { name: av.name || av.value };
					return { name: v };
				}
				if (f.type === "number") return Number(v);
				return v;
			}
		}
	}
	// 다중 선택 → Jira 의 array 값([{id}…] 또는 라벨 문자열 목록).
	function toJiraMulti(f: FieldMeta, ids: string[]): unknown {
		if (f.system === "labels") return ids;
		return ids.map((id) => {
			const av = f.allowedValues.find((a) => a.id === id);
			if (av && av.id) return { id: av.id };
			if (av) return { name: av.name || av.value || id };
			return { id };
		});
	}

	// 제출 전 모든 필수 필드(raw)가 채워졌는지 검사.
	function missingRequired(): string[] {
		const out: string[] = [];
		for (const f of [...core, ...extras]) {
			if (!f.required) continue;
			const raw = f.type === "array" ? (multi[f.key] || []).join(",") : values[f.key] || "";
			if (!raw.trim()) out.push(f.name);
		}
		return out;
	}

	async function submit() {
		const missing = missingRequired();
		if (missing.length) {
			toast("필수 입력: " + missing.join(", "));
			return;
		}
		if (!projectKey || !issueTypeId) return toast("프로젝트/이슈타입을 선택하세요");
		setSubmitting(true);
		const fields: Record<string, unknown> = {};
		for (const f of [...core, ...extras]) {
			if (f.type === "array") {
				const ids = multi[f.key] || [];
				if (ids.length) fields[f.key] = toJiraMulti(f, ids);
				else if (f.system === "labels") fields[f.key] = [];
			} else {
				const val = toJiraScalar(f, values[f.key] || "");
				if (val !== undefined) fields[f.key] = val;
			}
		}
		const r = await window.api?.jira?.createIssue?.({
			projectKey,
			issueTypeId,
			fields,
		});
		setSubmitting(false);
		if (!r || !r.ok) return toast(r?.error || "생성 실패");
		const summary = String(fields.summary || values.summary || "").trim();
		setCreated({
			key: r.key || "",
			summary,
			url: r.url || "",
		});
		toast((r.key || "티켓") + " 생성됨");
		if (onCreated && r.key) onCreated({ key: r.key, summary });
	}

	// ── 렌더 ──
	if (created) {
		return (
			<div className="rounded-card border border-line bg-panel-2 p-6 text-center">
				<div className="text-[15px] font-bold text-ink">티켓이 생성되었습니다</div>
				<div className="mt-2 inline-block rounded-[6px] border border-line bg-panel px-3 py-1.5 font-mono text-[13px] font-bold text-accent-text">
					{created.key}
				</div>
				{created.summary && (
					<div className="mt-2 text-[13px] text-ink-2">{created.summary}</div>
				)}
				<div className="mt-5 flex flex-wrap items-center justify-center gap-2">
					{created.url && (
						<a className="btn btn-primary" href={created.url} target="_blank" rel="noopener noreferrer">
							Jira에서 열기 ↗
						</a>
					)}
					<button
						type="button"
						className="btn"
						onClick={() => {
							setCreated(null);
							setValues({});
							setMulti({});
						}}
					>
						새로 등록
					</button>
					<button type="button" className="btn btn-ghost" onClick={() => onViewChange?.("list")}>
						← 내 티켓으로
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="mx-auto w-full max-w-[720px] rounded-card border border-line bg-panel-2 p-5">
			<div className="mb-4 flex items-center justify-between">
				<h3 className="m-0 inline-flex items-baseline gap-2 text-[15px] font-bold text-ink">
					업무등록
					{site && <span className="text-[12.5px] font-medium text-ink-2">@ {site}</span>}
				</h3>
				<button type="button" className="btn btn-ghost" onClick={() => onViewChange?.("list")}>
					← 내 티켓
				</button>
			</div>

			{metaLoading ? (
				<p className="py-4 text-[13px] text-ink-2">생성 가능한 프로젝트 불러오는 중…</p>
			) : metaError ? (
				<p className="rounded-[6px] border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
					{metaError}
				</p>
			) : !projects.length ? (
				<p className="py-4 text-[13px] text-ink-2">
					생성 가능한 프로젝트가 없습니다 (Jira 작성 권한 확인).
				</p>
			) : (
				<form
					className="flex flex-col gap-3.5"
					onSubmit={(e) => {
						e.preventDefault();
						void submit();
					}}
				>
					{/* 프로젝트 · 이슈타입 */}
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
							<span className="flex items-center gap-0.5">
								프로젝트 <span className="text-danger">*</span>
							</span>
							<ProjectPicker
								projects={projects}
								value={projectKey}
								onPick={pickProject}
							/>
						</label>
						<label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
							<span className="flex items-center gap-0.5">
								이슈 타입 <span className="text-danger">*</span>
							</span>
							<select
								value={issueTypeId}
								onChange={(e) => setIssueTypeId(e.target.value)}
								disabled={!projectKey}
								required
							>
								<option value="">{projectKey ? "선택…" : "프로젝트 먼저"}</option>
								{issueTypes.map((t) => (
									<option key={t.id} value={t.id}>
										{t.name}
									</option>
								))}
							</select>
						</label>
					</div>

					{fieldsLoading ? (
						<p className="py-2 text-[13px] text-ink-2">필드 구성 불러오는 중…</p>
					) : fieldsError && !core.length ? (
						<p className="rounded-[6px] border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
							{fieldsError}
						</p>
					) : !core.length && !fieldsLoading ? (
						<p className="rounded-[6px] border border-line bg-panel px-3 py-2.5 text-[13px] text-ink-2">
							프로젝트와 이슈 타입을 선택하면 입력 폼이 나타납니다.
						</p>
					) : (
						<>
							{/* 요약 · 설명 (고정 상단) */}
							{core.map((f) => {
								if (f.system === "description") {
									return (
										<label key={f.key} className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
											<span className="flex items-center gap-0.5">{f.name}</span>
											{/* 업무일지 메모 에디터 재사용 — 마크다운 값 → 서버에서 ADF 변환 */}
											<MarkdownEditor
												value={values[f.key] || ""}
												onChange={(md) => setVal(f.key, md)}
												placeholder="설명 (마크다운)"
											/>
										</label>
									);
								}
								return (
									<label key={f.key} className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
										<span className="flex items-center gap-0.5">
											{f.name} <span className="text-danger">*</span>
										</span>
										<input
											value={values[f.key] || ""}
											onChange={(e) => setVal(f.key, e.target.value)}
											placeholder="요약(제목)"
											required
										/>
									</label>
								);
							})}

							{/* 기타 필드 */}
							{extras.map((f) => {
								const isMulti = f.type === "array";
								const label = (
									<span>
										{f.name}
										{f.required && <span className="text-danger"> *</span>}
									</span>
								);
								// 시스템 인식 위젯
								if (f.system === "parent" || f.key === "parent") {
									// 상위 항목(하위 작업일 때 필수) — 티켓 ID/제목 검색. 즐겨찾기 없음.
									return (
										<label key={f.key} className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
											{label}
											<ParentPicker
												project={projectKey}
												value={values[f.key] || ""}
												onPick={(iss) => setVal(f.key, iss.key)}
											/>
										</label>
									);
								}
								if (f.system === "assignee" || f.system === "reporter") {
									// 담당자/보고자 — 검색+즐겨찾기 드롭박스, 기본값=/me.
									const selected = users.find((u) => u.accountId === values[f.key]);
									return (
										<label key={f.key} className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
											{label}
											{users.length ? (
												<UserPicker
													users={users}
													value={values[f.key] || ""}
													onPick={(id) => setVal(f.key, id)}
												/>
											) : (
												<input
													value={
														selected ? selected.displayName : values[f.key] || ""
													}
													disabled
													placeholder="사용자 목록을 불러오지 못했습니다"
												/>
											)}
										</label>
									);
								}
								if (f.system === "duedate")
									return (
										<label key={f.key} className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
											{label}
											<input
												type="date"
												value={values[f.key] || ""}
												onChange={(e) => setVal(f.key, e.target.value)}
											/>
										</label>
									);
								if (f.system === "labels")
									return (
										<label key={f.key} className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
											{label}
											<input
												value={(multi[f.key] || []).join(", ")}
												onChange={(e) =>
													setMulti((s) => ({
														...s,
														[f.key]: e.target.value.split(/[\s,]+/).filter(Boolean),
													}))
												}
												placeholder="쉼표로 구분 (예: backend, urgent)"
											/>
										</label>
									);
								// allowedValues 가 있으면 select / multi-checkbox
								if (f.allowedValues.length) {
									if (isMulti)
										return (
											<div key={f.key} className="flex flex-col gap-1.5 text-[12.5px] font-semibold text-ink-2">
												{label}
												<div className="flex flex-wrap gap-1.5">
													{f.allowedValues.map((a) => {
														const on = (multi[f.key] || []).includes(a.id);
														return (
															<button
																key={a.id}
																type="button"
																onClick={() => toggleMulti(f.key, a.id)}
																className={
																	"rounded-full border px-2.5 py-1 text-[12px] font-semibold transition-colors " +
																	(on
																		? "border-accent bg-accent text-accent-ink"
																		: "border-line bg-panel text-ink-2 hover:text-ink")
																}
															>
																{labelOf(a)}
															</button>
														);
													})}
												</div>
											</div>
										);
									return (
										<label key={f.key} className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
											{label}
											<select value={values[f.key] || ""} onChange={(e) => setVal(f.key, e.target.value)}>
												<option value="">선택…</option>
												{f.allowedValues.map((a) => (
													<option key={a.id} value={a.id}>
														{labelOf(a)}
													</option>
												))}
											</select>
										</label>
									);
								}
								// 그 외(required 커스텀 필드 등) — 타입 기반 입력
								return (
									<label key={f.key} className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
										{label}
										<input
											type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}
											value={values[f.key] || ""}
											onChange={(e) => setVal(f.key, e.target.value)}
										/>
									</label>
								);
							})}

							<div className="mt-1 flex items-center gap-2">
								<button
									type="submit"
									className="btn btn-primary"
									disabled={submitting || !projectKey || !issueTypeId}
								>
									{submitting ? "등록 중…" : "티켓 등록"}
								</button>
								<span className="text-[12px] text-ink-2">
									<span className="text-danger">*</span> 필수 항목
								</span>
							</div>
						</>
					)}
				</form>
			)}
		</div>
	);
}
