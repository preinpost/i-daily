// TicketEditPane.tsx — 내 티켓 탭의 '티켓 수정' 부속 화면.
// editmeta + 이슈 상세로 수정 폼을 구성하고 변경할 필드만 PUT 한다.
// 담당자/보고자·상위 항목은 검색 드롭박스(UserPicker/ParentPicker) 재사용,
// 설명은 업무일지 메모 에디터(MarkdownEditor) 사용.
import { useEffect, useMemo, useState } from "react";
import { useToast } from "./Toast";
import { MarkdownEditor } from "./MarkdownEditor";
import { UserPicker, ParentPicker } from "./TicketCreatePane";
import type { Ticket } from "../types";

type Allow = { id: string; name: string; value?: string };
type FieldMeta = {
	key: string;
	name: string;
	required: boolean;
	type: string;
	system: string;
	allowedValues: Allow[];
};
type User = { accountId: string; displayName: string; emailAddress?: string };

const EXTRA_SYSTEMS = [
	"priority",
	"duedate",
	"labels",
	"components",
	"versions",
	"assignee",
	"reporter",
];
const labelOf = (a: Allow) => a.name || a.value || a.id;

export function TicketEditPane({
	ticket,
	onClose,
	onUpdated,
}: {
	ticket: Ticket;
	onClose: () => void;
	onUpdated?: (key: string) => void;
}) {
	const toast = useToast();
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState("");

	const [projectKey, setProjectKey] = useState("");
	const [issueTypeName, setIssueTypeName] = useState("");
	const [fieldsMeta, setFieldsMeta] = useState<FieldMeta[]>([]);
	const [users, setUsers] = useState<User[]>([]);

	const [values, setValues] = useState<Record<string, string>>({});
	const [multi, setMulti] = useState<Record<string, string[]>>({});
	const [submitting, setSubmitting] = useState(false);

	const setVal = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));
	const toggleMulti = (k: string, id: string) =>
		setMulti((s) => {
			const cur = s[k] || [];
			return { ...s, [k]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
		});

	// 로드: 이슈 상세 + editmeta (+ 프로젝트 사용자).
	useEffect(() => {
		let cancelled = false;
		(async () => {
			const [g, m] = await Promise.all([
				window.api?.jira?.get?.(ticket.key),
				window.api?.jira?.editMeta?.(ticket.key),
			]);
			if (cancelled) return;
			if (!g?.ok || !m?.ok) {
				setLoadError(g?.error || m?.error || "불러오기 실패");
				setLoading(false);
				return;
			}
			const issue = g;
			setProjectKey(issue.projectKey || "");
			setIssueTypeName(issue.issueTypeName || "");
			// 초기값 세팅
			const v: Record<string, string> = {
				summary: issue.summary || "",
				description: issue.descriptionMd || "",
				duedate: issue.duedate || "",
				assignee: issue.assignee?.accountId || "",
				reporter: issue.reporter?.accountId || "",
			};
			if (issue.priority?.id) v.priority = issue.priority.id;
			if (issue.parent?.key) v.parent = issue.parent.key;
			const mm: Record<string, string[]> = {};
			if (Array.isArray(issue.labels)) mm.labels = issue.labels;
			if (Array.isArray(issue.components))
				mm.components = issue.components.map((c: { id: string }) => c.id);
			setValues(v);
			setMulti(mm);
			setFieldsMeta(m.fields || []);
			if (issue.projectKey) {
				const u = await window.api?.jira?.users?.(issue.projectKey);
				if (u?.ok) setUsers(u.users || []);
			}
			setLoading(false);
		})();
		return () => {
			cancelled = true;
		};
	}, [ticket.key]);

	// 상단 배치(요약·설명) 제외 필드 — 담당자/보고자 등 시스템 필드 + 필수 필드.
	const { core, extras } = useMemo(() => {
		const map = new Map(fieldsMeta.map((f) => [f.key, f]));
		const known = new Set(EXTRA_SYSTEMS);
		const extra = fieldsMeta
			.filter((f) => f.key !== "summary" && f.key !== "description")
			.filter((f) => f.system !== "project" && f.system !== "issuetype")
			.filter((f) => f.key !== "project" && f.key !== "issuetype")
			.filter((f) => known.has(f.system) || f.required);
		return {
			core: [map.get("summary"), map.get("description")].filter(Boolean) as FieldMeta[],
			extras: extra,
		};
	}, [fieldsMeta]);

	function toJiraScalar(f: FieldMeta, raw: string): unknown {
		const v = (raw || "").trim();
		if (!v) return undefined;
		switch (f.system) {
			case "priority": {
				const av = f.allowedValues.find((a) => a.id === v);
				return av ? { id: av.id } : { name: v };
			}
			case "assignee":
			case "reporter":
				return { accountId: v };
			case "parent":
				return { key: v };
			case "labels":
				return v.split(/[\s,]+/).filter(Boolean);
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
	function toJiraMulti(f: FieldMeta, ids: string[]): unknown {
		if (f.system === "labels") return ids;
		return ids.map((id) => {
			const av = f.allowedValues.find((a) => a.id === id);
			if (av && av.id) return { id: av.id };
			if (av) return { name: av.name || av.value || id };
			return { id };
		});
	}

	function missingRequired(): string[] {
		const out: string[] = [];
		for (const f of [...core, ...extras]) {
			if (!f.required) continue;
			const raw = f.type === "array" ? (multi[f.key] || []).join(",") : values[f.key] || "";
			if (!raw.trim()) out.push(f.name);
		}
		return out;
	}

	async function save() {
		const missing = missingRequired();
		if (missing.length) return toast("필수 입력: " + missing.join(", "));
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
		const r = await window.api?.jira?.edit?.(ticket.key, fields);
		setSubmitting(false);
		if (!r || !r.ok) return toast(r?.error || "수정 실패");
		toast(ticket.key + " 수정됨");
		onUpdated?.(ticket.key);
		onClose();
	}

	const label = (f: FieldMeta) => (
		<span>
			{f.name}
			{f.required && <span className="text-danger"> *</span>}
		</span>
	);

	return (
		<div className="mx-auto w-full max-w-[720px] rounded-card border border-line bg-panel-2 p-5">
			<div className="mb-4 flex items-center justify-between">
				<h3 className="m-0 inline-flex items-baseline gap-2 text-[15px] font-bold text-ink">
					티켓 수정
					<span className="font-mono text-accent-text">{ticket.key}</span>
					{issueTypeName && (
						<span className="text-[12.5px] font-medium text-ink-2">{issueTypeName}</span>
					)}
				</h3>
				<button type="button" className="btn btn-ghost" onClick={onClose}>
					← 닫기
				</button>
			</div>

			{loading ? (
				<p className="py-4 text-[13px] text-ink-2">불러오는 중…</p>
			) : loadError ? (
				<p className="rounded-[6px] border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
					{loadError}
				</p>
			) : (
				<form
					className="flex flex-col gap-3.5"
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					{core.map((f) => {
						if (f.system === "description") {
							return (
								<label key={f.key} className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
									<span className="flex items-center gap-0.5">{f.name}</span>
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

					{extras.map((f) => {
						const isMulti = f.type === "array";
						if (f.system === "assignee" || f.system === "reporter") {
							return (
								<label key={f.key} className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
									{label(f)}
									<UserPicker
										users={users}
										value={values[f.key] || ""}
										onPick={(id) => setVal(f.key, id)}
									/>
								</label>
							);
						}
						if (f.system === "parent" || f.key === "parent") {
							return (
								<label key={f.key} className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
									{label(f)}
									<ParentPicker
										project={projectKey}
										value={values[f.key] || ""}
										onPick={(iss) => setVal(f.key, iss.key)}
									/>
								</label>
							);
						}
						if (f.system === "duedate")
							return (
								<label key={f.key} className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
									{label(f)}
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
									{label(f)}
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
						if (f.allowedValues.length) {
							if (isMulti)
								return (
									<div key={f.key} className="flex flex-col gap-1.5 text-[12.5px] font-semibold text-ink-2">
										{label(f)}
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
									{label(f)}
									<select
										value={values[f.key] || ""}
										onChange={(e) => setVal(f.key, e.target.value)}
									>
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
						return (
							<label key={f.key} className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
								{label(f)}
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
							disabled={submitting}
						>
							{submitting ? "저장 중…" : "저장"}
						</button>
						<span className="text-[12px] text-ink-2">
							<span className="text-danger">*</span> 필수 항목
						</span>
					</div>
				</form>
			)}
		</div>
	);
}
