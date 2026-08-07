import { useEffect, useRef, useState } from "react";
import { EditorContext } from "./context/EditorContext";
import { useToast } from "./components/Toast";
import { Tabs, type View } from "./components/Tabs";
import { TopHeader } from "./components/TopHeader";
import { DayCard } from "./components/DayCard";
import { TicketsPane } from "./components/TicketsPane";
import { ConfigPane } from "./components/ConfigPane";
import { MsGraphTestPane } from "./components/MsGraphTestPane";
import { Login } from "./components/Login";
import { WeeklyReportPane } from "./components/WeeklyReportPane";
import { api } from "./lib/api";
import {
	emptyDoc,
	mergeSpaceLabels,
	normCfg,
	normalizeDoc,
	shiftDate,
	todayDailyItems,
} from "./lib/model";
import {
	dailyToBlock,
	renderScrum,
	renderScrumHtml,
	serializeDoc,
	todayStr,
} from "../../shared/model";
import type { Config, Doc, Meta } from "./types";

export function App() {
	const toast = useToast();

	const [ready, setReady] = useState(false);
	// 인증 게이트: null=확인 전, false=미로그인(로그인 화면), true=로그인됨(앱).
	const [authed, setAuthed] = useState<boolean | null>(null);
	const [view, setView] = useState<View>(() => {
		const qs = new URLSearchParams(location.search);
		const v = qs.get("view");
		return v === "tickets" ||
			v === "report" ||
			v === "config" ||
			v === "ms"
			? v
			: "log";
	});
	const [meta, setMeta] = useState<Meta>({
		today: null,
		owner: "",
		jiraBase: "",
	});
	const [config, setConfig] = useState<Config>(normCfg(null));
	const [spaceHistory, setSpaceHistory] = useState<string[]>([]);
	const [firstRun, setFirstRun] = useState(false);
	// 서버 응답(부팅 1회)이 아니라 매번 new Date() → KST 로 계산. 앱을 켜둔 채
	// 자정을 넘겨도 '오늘'이 어제로 굳지 않는다.
	const [curDate, setCurDate] = useState(() => todayStr());
	const [teams, setTeams] = useState("");
	// 로그인 세션(Better Auth) 만료로 인해 강제 로그인 게이트로 전환됐는지.
	const [sessionExpired, setSessionExpired] = useState(false);
	const [saveState, setSaveState] = useState({ cls: "", note: "—" });
	const [, setVer] = useState(0);

	const docRef = useRef<Doc | null>(null);
	const dirty = useRef(false);
	const curDateRef = useRef(curDate);
	const metaRef = useRef(meta);
	const teamsRef = useRef("");
	const teamsHtmlRef = useRef("");
	/** 마지막으로 서버에서 받아 적용한 Doc 지문 — MCP 등 외부 쓰기 감지용. */
	const serverFpRef = useRef("");
	/** 탭+헤더 크롬 높이 → 오버레이 pane top 오프셋 */
	const chromeRef = useRef<HTMLDivElement>(null);

	// 핸들러가 항상 최신 값을 보도록 매 렌더 동기화
	curDateRef.current = curDate;
	metaRef.current = meta;

	// 상단 크롬(탭·헤더) 높이를 CSS 변수로 동기화 — 탭 전환 시 레이아웃 점프 방지
	useEffect(() => {
		const el = chromeRef.current;
		if (!el) return;
		const sync = () => {
			document.documentElement.style.setProperty(
				"--chrome-offset",
				`${el.offsetHeight}px`,
			);
		};
		sync();
		const ro = new ResizeObserver(sync);
		ro.observe(el);
		return () => {
			ro.disconnect();
			document.documentElement.style.removeProperty("--chrome-offset");
		};
	}, [ready, authed]);

	const bump = () => setVer((v) => v + 1);
	const setDot = (cls: string, note?: string) =>
		setSaveState((s) => ({ cls, note: note ?? s.note }));
	const setDirty = (v: boolean) => {
		dirty.current = v;
	};
	const markDirty = () => {
		setDirty(true);
		setDot("dirty", "● 저장 안 됨");
	};
	const commit = () => {
		markDirty();
		bump();
	};

	function applyTeams(t: string, html: string) {
		teamsRef.current = t;
		teamsHtmlRef.current = html;
		setTeams(t);
	}

	function rememberServerDoc(doc: Doc) {
		serverFpRef.current = JSON.stringify(doc);
	}

	async function loadDate(date: string) {
		if (
			dirty.current &&
			date !== curDateRef.current &&
			!confirm("저장하지 않은 변경이 있습니다. 저장하지 않고 이동할까요?")
		) {
			return;
		}
		setCurDate(date);
		curDateRef.current = date;
		setDirty(false);
		const r = await api<any>("GET", "/api/day/" + date);
		if (r.ok && r.json) {
			docRef.current = r.json.data;
			applyTeams(r.json.teams, r.json.teamsHtml || "");
			setDot("", "불러옴");
		} else {
			docRef.current = emptyDoc(metaRef.current, date);
			applyTeams("", "");
			setDot("", "새 기록 · 입력하면 생성됨");
		}
		normalizeDoc(docRef.current!);
		rememberServerDoc(docRef.current!);
		setReady(true);
		bump();
	}

	async function saveNow(): Promise<boolean> {
		const doc = docRef.current;
		if (!doc) return false;
		if (!dirty.current) {
			toast("변경 없음");
			return true; // 저장할 게 없으므로 종료해도 안전
		}
		setDot("busy", "저장 중…");
		const r = await api<any>("PUT", "/api/day/" + curDateRef.current, doc);
		if (r.ok && r.json) {
			setDirty(false);
			if (r.json.data) {
				docRef.current = r.json.data;
				normalizeDoc(docRef.current!);
			}
			rememberServerDoc(docRef.current!);
			applyTeams(r.json.teams, r.json.teamsHtml || "");
			setDot(
				"",
				"저장됨 · " +
					new Date().toLocaleTimeString("ko-KR", {
						hour: "2-digit",
						minute: "2-digit",
					}),
			);
			// 저장 후 스페이스 자동완성 후보 갱신
			const sp = await api<{ spaces: string[] }>("GET", "/api/spaces");
			if (sp.ok && sp.json?.spaces) setSpaceHistory(sp.json.spaces);
			toast("저장됨");
			bump();
			return true;
		}
		setDot("err", "저장 실패 — 서버 확인");
		toast("저장 실패 — 서버 확인");
		return false;
	}

	async function revert() {
		if (!dirty.current) return toast("되돌릴 변경이 없어요");
		if (
			!confirm(
				"저장하지 않은 변경을 모두 버리고 마지막 저장 상태로 되돌릴까요?",
			)
		)
			return;
		setDot("busy", "되돌리는 중…");
		const date = curDateRef.current;
		const r = await api<any>("GET", "/api/day/" + date);
		if (r.ok && r.json) {
			docRef.current = r.json.data;
			applyTeams(r.json.teams, r.json.teamsHtml || "");
			setDot("", "되돌림 · 마지막 저장 상태");
		} else {
			docRef.current = emptyDoc(metaRef.current, date);
			applyTeams("", "");
			setDot("", "되돌림 · 새 기록");
		}
		normalizeDoc(docRef.current!);
		rememberServerDoc(docRef.current!);
		setDirty(false);
		toast("마지막 저장 상태로 되돌렸어요");
		bump();
	}

	/** MCP·다른 탭 등 외부 쓰기 감지 — dirty 가 아닐 때만 서버 Doc 으로 덮어쓴다. */
	async function syncFromServer() {
		if (dirty.current) return;
		if (document.visibilityState === "hidden") return;
		if (!docRef.current) return;
		const date = curDateRef.current;
		const r = await api<any>("GET", "/api/day/" + date);
		if (dirty.current || date !== curDateRef.current) return;
		if (r.ok && r.json?.data) {
			const next = r.json.data as Doc;
			normalizeDoc(next);
			const fp = JSON.stringify(next);
			if (fp === serverFpRef.current) return;
			docRef.current = next;
			rememberServerDoc(next);
			applyTeams(r.json.teams || "", r.json.teamsHtml || "");
			setDot("", "동기화됨");
			bump();
			toast("외부에서 갱신됨");
			return;
		}
		// 서버에 없음 → 로컬이 비어 있지 않으면(외부에서 삭제된 경우) 스켈레톤으로
		if (r.status === 404 && serverFpRef.current) {
			const empty = emptyDoc(metaRef.current, date);
			normalizeDoc(empty);
			const fp = JSON.stringify(empty);
			if (fp === serverFpRef.current) return;
			docRef.current = empty;
			rememberServerDoc(empty);
			applyTeams("", "");
			setDot("", "새 기록 · 입력하면 생성됨");
			bump();
			toast("외부에서 갱신됨");
		}
	}

	// 데일리 스크럼 생성 — 금일 블록을 오늘 일일 진행 업무로 확정하고(이슈·협업 유지)
	// Teams 붙여넣기 텍스트를 클라이언트에서 즉시 렌더. 저장하면 서버도 같은 텍스트를 반환.
	function generateScrum() {
		const doc = docRef.current;
		if (!doc) return;
		const items = todayDailyItems(doc).filter(
			(it) => (it.key || "").trim() || (it.desc || "").trim(),
		);
		if (!items.length) return toast("일일 진행 업무에 먼저 항목을 추가하세요");
		const block = dailyToBlock(
			items,
			doc.scrum.today.issues,
			doc.scrum.today.collab,
		);
		doc.scrum.today = block;
		applyTeams(
			renderScrum(config.jiraBase, doc.scrum),
			renderScrumHtml(config.jiraBase, doc.scrum),
		);
		commit();
		toast("데일리 스크럼 생성됨 — 아래 Teams 텍스트 확인");
		document
			.getElementById("teams-output")
			?.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}

	async function copyMd() {
		const doc = docRef.current;
		if (!doc) return toast("복사할 내용이 없어요");
		const md = serializeDoc(config.jiraBase, doc);
		try {
			await navigator.clipboard.writeText(md);
			toast("마크다운 복사됨 — 옵시디언 일지에 붙여넣기");
		} catch {
			toast("복사 실패 — 직접 선택하세요");
		}
	}

	async function copy() {
		try {
			if (teamsHtmlRef.current && window.ClipboardItem) {
				await navigator.clipboard.write([
					new ClipboardItem({
						"text/html": new Blob([teamsHtmlRef.current], {
							type: "text/html",
						}),
						"text/plain": new Blob([teamsRef.current], { type: "text/plain" }),
					}),
				]);
			} else {
				await navigator.clipboard.writeText(teamsRef.current);
			}
			toast("복사됨 — Teams에 붙여넣기 (서식 유지)");
		} catch {
			try {
				await navigator.clipboard.writeText(teamsRef.current);
				toast("복사됨");
			} catch {
				toast("복사 실패 — 직접 선택하세요");
			}
		}
	}

	// boot
	useEffect(() => {
		(async () => {
			const r = await api<any>("GET", "/api/days");
			if (!r.ok) {
				setDot("err", "앱을 다시 시작해 주세요 (IPC 응답 없음)");
				return;
			}
			// 미로그인(setup 유저)이면 앱 대신 전체화면 로그인 게이트.
			if (r.json.isSetup) {
				setAuthed(false);
				return;
			}
			setAuthed(true);
			// 서버가 준 today 는 참고만; 기준은 항상 클라이언트에서 재계산한 KST 오늘.
			const today = todayStr();
			const cfg = normCfg(r.json.config || {});
			const m: Meta = { today, owner: cfg.owner, jiraBase: cfg.jiraBase };
			metaRef.current = m;
			setMeta(m);
			setConfig(cfg);
			setSpaceHistory(Array.isArray(r.json.spaces) ? r.json.spaces : []);
			const qs = new URLSearchParams(location.search);
			await loadDate(qs.get("date") || today);
			if (r.json.firstRun || !r.json.configured) {
				setFirstRun(true);
				setView("config");
				toast("설정을 먼저 등록하세요 (Jira 주소·이름)");
			}
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// 자정 롤오버 감지 — 세션을 밤새 켜둔 채 두면 meta.today 가 어제로 고정되어
	// '오늘로 가기'·'지난 기록' 판정이 어긋난다. 주기적·복귀 시에 new Date() 로 재계산.
	useEffect(() => {
		const sync = () => {
			const t = todayStr();
			setMeta((m) => (m.today === t || m.today === null ? m : { ...m, today: t }));
		};
		const id = setInterval(sync, 30_000);
		document.addEventListener("visibilitychange", sync);
		window.addEventListener("focus", sync);
		return () => {
			clearInterval(id);
			document.removeEventListener("visibilitychange", sync);
			window.removeEventListener("focus", sync);
		};
	}, []);

	// 외부 쓰기(MCP 등) — 탭 복귀·창 포커스 시에만 재로드(주기 폴링 없음 → Workers 요청 최소).
	useEffect(() => {
		if (!ready || !authed) return;
		const onResume = () => {
			if (document.visibilityState === "visible") void syncFromServer();
		};
		document.addEventListener("visibilitychange", onResume);
		window.addEventListener("focus", onResume);
		return () => {
			document.removeEventListener("visibilitychange", onResume);
			window.removeEventListener("focus", onResume);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ready, authed]);

	// 로그인 세션(Better Auth) 유효성 자동 감지.
	// 세션이 만료되면 서버가 setup 유저로 강등돼 jiraBase·owner 가 비어 팀즈 링크 등이
	// 조용히 빠지는 문제를 막기 위해, 감지 즉시 전체화면 로그인 게이트로 전환해 재로그인을 유도한다.
	const sessionBusy = useRef(false);
	async function checkSession() {
		if (sessionBusy.current) return;
		sessionBusy.current = true;
		try {
			const me = await window.api?.me?.();
			if (me && me.isSetup && authed === true) {
				setSessionExpired(true);
				setAuthed(false);
			}
		} catch {
			/* 네트워크 오류는 무시 — 다음 주기/포커스 때 재시도 */
		} finally {
			sessionBusy.current = false;
		}
	}
	useEffect(() => {
		if (authed !== true || !ready) return;
		const onActive = () => {
			if (document.visibilityState === "visible") checkSession();
		};
		document.addEventListener("visibilitychange", onActive);
		window.addEventListener("focus", onActive);
		const id = setInterval(checkSession, 5 * 60_000);
		return () => {
			document.removeEventListener("visibilitychange", onActive);
			window.removeEventListener("focus", onActive);
			clearInterval(id);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [authed, ready]);

	// Jira OAuth 팝업이 로그인 완료를 postMessage 로 알리면(= 새 sid 쿠키 반영됨) 재부팅.
	// 새 세션 user(account_id) 로 config/일지를 다시 불러오기 위해 location.reload.
	useEffect(() => {
		const onMsg = (e: MessageEvent) => {
			if (e.origin !== location.origin) return;
			if (e.data && e.data.type === "i-daily-login") location.reload();
		};
		window.addEventListener("message", onMsg);
		return () => window.removeEventListener("message", onMsg);
	}, []);

	// ⌘S 저장 — 헤더가 있는 업무일지 탭에서만 동작
	useEffect(() => {
		if (view !== "log") return;
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
				e.preventDefault();
				saveNow();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [view]);

	useEffect(() => {
		document.body.classList.toggle("viewing-web", view !== "log");
		const qs = new URLSearchParams(location.search);
		if (view === "log") qs.delete("view");
		else qs.set("view", view);
		const qsStr = qs.toString();
		const url = qsStr ? `${location.pathname}?${qsStr}` : location.pathname;
		history.replaceState(null, "", url);
	}, [view]);

	// 미로그인 → 전체화면 로그인 게이트(URL 은 그대로). 세션 만료로 전환된 경우 안내 문구를 붙인다.
	if (authed === false) {
		return (
			<Login
				notice={
					sessionExpired
						? "로그인 세션이 만료되었습니다. 다시 로그인하면 기존 업무일지가 그대로 복원됩니다."
						: undefined
				}
			/>
		);
	}

	if (authed === null || !ready || !docRef.current) {
		return (
			<div className="mx-auto max-w-[980px] px-5 py-10 text-ink-2">
				불러오는 중…
			</div>
		);
	}

	return (
		<EditorContext.Provider
			value={{ doc: docRef.current, meta, config, commit, rerender: bump }}
		>
			<div ref={chromeRef} className="app-chrome sticky top-0 z-[100]">
				<Tabs view={view} onView={setView} />
				{/* 상단 헤더(브랜드·날짜·저장·바로가기)는 업무일지 탭에서만 보인다 —
				   다른 탭에선 불필요한 크롬이라 숨긴다(단축키도 헤더가 있는 곳에서만 동작). */}
				{view === "log" && (
					<TopHeader
						curDate={curDate}
						meta={meta}
						saveCls={saveState.cls}
						saveNote={saveState.note}
						onSave={saveNow}
						onRevert={revert}
					/>
				)}
			</div>
			<main className="mx-auto max-w-[980px] px-5 pb-12" hidden={view !== "log"}>
				<DayCard
					curDate={curDate}
					today={meta.today}
					onShift={(days) => loadDate(shiftDate(curDate, days))}
					onPickDate={(date) => loadDate(date)}
					onGenerateScrum={generateScrum}
					teams={teams}
					onCopy={copy}
					onCopyMd={copyMd}
				/>
			</main>

			<TicketsPane active={view === "tickets"} />
			<WeeklyReportPane active={view === "report"} />
			<MsGraphTestPane active={view === "ms"} />
			<ConfigPane active={view === "config"} firstRun={firstRun} />

			<datalist id="spaceList">
				{mergeSpaceLabels(spaceHistory, docRef.current).map((s) => (
					<option key={s} value={s} />
				))}
			</datalist>
		</EditorContext.Provider>
	);
}
