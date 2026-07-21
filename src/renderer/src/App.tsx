import { useEffect, useRef, useState } from "react";
import { EditorContext } from "./context/EditorContext";
import { useToast } from "./components/Toast";
import { Tabs, type View } from "./components/Tabs";
import { TopHeader } from "./components/TopHeader";
import { DayCard } from "./components/DayCard";
import { TicketsPane } from "./components/TicketsPane";
import { LunchPane } from "./components/LunchPane";
import { ConfigPane } from "./components/ConfigPane";
import { Login } from "./components/Login";
import { WeeklyReportPane } from "./components/WeeklyReportPane";
import { api } from "./lib/api";
import {
	emptyDoc,
	mergeSpaceLabels,
	normCfg,
	normalizeDoc,
	shiftDate,
	ymd,
} from "./lib/model";
import { serializeDoc } from "../../shared/model";
import type { Config, Doc, Meta } from "./types";

export function App() {
	const toast = useToast();

	const [ready, setReady] = useState(false);
	// 인증 게이트: null=확인 전, false=미로그인(로그인 화면), true=로그인됨(앱).
	const [authed, setAuthed] = useState<boolean | null>(null);
	const [view, setView] = useState<View>(() => {
		const qs = new URLSearchParams(location.search);
		const v = qs.get("view");
		return v === "tickets" || v === "lunch" || v === "report" || v === "config"
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
	const [curDate, setCurDate] = useState(ymd(new Date()));
	const [teams, setTeams] = useState("");
	const [saveState, setSaveState] = useState({ cls: "", note: "—" });
	const [, setVer] = useState(0);

	const docRef = useRef<Doc | null>(null);
	const dirty = useRef(false);
	const curDateRef = useRef(curDate);
	const metaRef = useRef(meta);
	const teamsRef = useRef("");
	const teamsHtmlRef = useRef("");

	// 핸들러가 항상 최신 값을 보도록 매 렌더 동기화
	curDateRef.current = curDate;
	metaRef.current = meta;

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
		setDirty(false);
		toast("마지막 저장 상태로 되돌렸어요");
		bump();
	}

	async function carry() {
		if (
			dirty.current &&
			!confirm(
				"저장하지 않은 변경이 있습니다. 이월하면 사라집니다. 계속할까요?",
			)
		)
			return;
		if (
			!confirm(
				"직전 근무일 '금일'을 '전일'로 이월하고 초안을 채웁니다.\n현재 " +
					curDateRef.current +
					" 입력을 덮어쓸까요? (이월은 즉시 서버에 저장됩니다)",
			)
		)
			return;
		const r = await api<any>(
			"POST",
			"/api/day/" + curDateRef.current + "/carry",
		);
		if (r.ok && r.json) {
			docRef.current = r.json.data;
			normalizeDoc(docRef.current!);
			applyTeams(r.json.teams, r.json.teamsHtml || "");
			setDirty(false);
			setDot("", "이월·저장됨");
			toast("이월 완료 — 진척률·마감일 확인하세요");
			bump();
		} else toast("이월 실패");
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

	function onConfigSaved(cfg: Config, _configured: boolean) {
		setConfig(cfg);
		setMeta((m) => ({ ...m, owner: cfg.owner, jiraBase: cfg.jiraBase }));
		metaRef.current = {
			...metaRef.current,
			owner: cfg.owner,
			jiraBase: cfg.jiraBase,
		};
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
			const today = r.json.today as string;
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

	// ⌘S 저장
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
				e.preventDefault();
				saveNow();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		document.body.classList.toggle("viewing-web", view !== "log");
		const qs = new URLSearchParams(location.search);
		if (view === "log") qs.delete("view");
		else qs.set("view", view);
		const qsStr = qs.toString();
		const url = qsStr ? `${location.pathname}?${qsStr}` : location.pathname;
		history.replaceState(null, "", url);
	}, [view]);

	// 미로그인 → 전체화면 로그인 게이트(URL 은 그대로).
	if (authed === false) {
		return <Login />;
	}

	if (authed === null || !ready || !docRef.current) {
		return (
			<div className="mx-auto max-w-[1080px] px-[18px] py-10 text-ink-2">
				불러오는 중…
			</div>
		);
	}

	return (
		<EditorContext.Provider
			value={{ doc: docRef.current, meta, config, commit, rerender: bump }}
		>
			<Tabs view={view} onView={setView} />
			<TopHeader
				curDate={curDate}
				meta={meta}
				saveCls={saveState.cls}
				saveNote={saveState.note}
				onSave={saveNow}
				onRevert={revert}
			/>
			<main className="mx-auto max-w-[1080px] px-[18px]">
				<DayCard
					curDate={curDate}
					onShift={(days) => loadDate(shiftDate(curDate, days))}
					onPickDate={(date) => loadDate(date)}
					onCarry={carry}
					teams={teams}
					onCopy={copy}
					onCopyMd={copyMd}
				/>
			</main>

			<TicketsPane active={view === "tickets"} />
			<LunchPane active={view === "lunch"} config={config} />
			<WeeklyReportPane
				active={view === "report"}
				config={config}
				onSaved={onConfigSaved}
			/>
			<ConfigPane
				active={view === "config"}
				config={config}
				firstRun={firstRun}
				onSaved={onConfigSaved}
			/>

			<datalist id="spaceList">
				{mergeSpaceLabels(spaceHistory, docRef.current).map((s) => (
					<option key={s} value={s} />
				))}
			</datalist>
		</EditorContext.Provider>
	);
}
