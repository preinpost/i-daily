import { useEditor } from "../../context/EditorContext";
import { useToast } from "../Toast";
import { api } from "../../lib/api";
import {
	blockHasContent,
	copyListItemToScrum,
	emptyBlock,
	todayDailyItems,
} from "../../lib/model";
import { confirmReset } from "../../lib/ui";
import { useCopyZone } from "../../lib/useDnd";
import { ScrumSpace } from "./ScrumSpace";
import type { ListItem, Which } from "../../types";

const CFG: Record<Which, { label: string; tag: string }> = {
	prev: { label: "전일 진행 업무", tag: "한 일" },
	today: { label: "금일 진행 업무", tag: "할 일" },
};

export function ScrumBlock({
	which,
	curDate,
}: {
	which: Which;
	curDate: string;
}) {
	const { doc, commit } = useEditor();
	const toast = useToast();
	const scrum = doc.scrum;
	const block = scrum[which];
	const { label, tag } = CFG[which];

	// 빈 영역으로 드롭 → 라벨 없는 스페이스에 등록
	const { over, props } = useCopyZone((item) => {
		const r = copyListItemToScrum(scrum, which, item, null);
		toast(r.msg);
		if (r.ok) commit();
	});

	async function importPrev() {
		const has = (scrum.prev.spaces || []).some((sp) =>
			(sp.tasks || []).some((t) => t.key || t.desc),
		);
		if (
			has &&
			!confirm("전일 진행 업무를 직전 근무일의 '일일 진행 업무'로 덮어쓸까요?")
		)
			return;
		const r = await api<any>("GET", `/api/day/${curDate}/prev-daily`);
		if (r.ok && r.json && r.json.block && r.json.count) {
			scrum.prev = r.json.block;
			commit();
			toast(`${r.json.from} 일일 ${r.json.count}건 가져옴 — 진척/마감 확인`);
		} else toast("가져올 어제 일일 기록이 없어요");
	}

	function syncToday() {
		const items = todayDailyItems(doc).filter(
			(it) => (it.key || "").trim() || (it.desc || "").trim(),
		);
		if (!items.length) return toast("가져올 오늘 일일 기록이 없어요");
		const dup = (it: ListItem) => {
			const key = (it.key || "").trim().toUpperCase();
			const desc = (it.desc || "").trim();
			return (scrum.today.spaces || []).some((sp) =>
				(sp.tasks || []).some((t) =>
					key
						? (t.key || "").trim().toUpperCase() === key
						: (t.desc || "").trim() === desc,
				),
			);
		};
		let added = 0;
		items.forEach((it) => {
			if (dup(it)) return;
			let sp = (scrum.today.spaces || []).find((s) => !(s.label || "").trim());
			if (!sp) {
				sp = { label: "", tasks: [] };
				scrum.today.spaces.push(sp);
			}
			sp.tasks.push({
				key: it.key || "",
				desc: it.desc || "",
				progress: typeof it.progress === "number" ? it.progress : "",
				due: it.due || "",
				subs: (it.subs || []).slice(),
			});
			added++;
		});
		if (!added) return toast("이미 모두 금일에 있어요");
		commit();
		toast(`오늘 일일 ${added}건 추가 — 진척/마감 확인`);
	}

	return (
		<div className="overflow-hidden rounded-xl border border-line bg-panel-2">
			<div className="flex items-center gap-2 border-b border-line bg-panel px-3.5 py-[11px]">
				<span className="text-[14px] font-[650]">{label}</span>
				<span className="rounded-full bg-chip px-2 py-0.5 text-[11px] text-ink-2">
					{tag}
				</span>
				<div className="flex-1" />
				{which === "prev" && (
					<button
						type="button"
						className="btn btn-tiny btn-ghost"
						title="직전 근무일의 '일일 진행 업무'를 전일 진행 업무로 가져옵니다"
						onClick={importPrev}
					>
						↧ 어제 일일
					</button>
				)}
				{which === "today" && (
					<button
						type="button"
						className="btn btn-tiny btn-ghost"
						title="오늘 '일일 진행 업무'에서 금일에 없는 항목만 일괄 등록합니다 (진척·마감은 일일 값으로 시드, 이후 독립)"
						onClick={syncToday}
					>
						↧ 오늘 일일
					</button>
				)}
				<button
					type="button"
					className="btn btn-tiny btn-ghost"
					title={label + "만 비웁니다 (저장 전이면 새로고침으로 복구)"}
					onClick={() => {
						if (!blockHasContent(block)) return toast("이미 비어 있어요");
						if (!confirmReset(label)) return;
						scrum[which] = emptyBlock();
						commit();
						toast(label + " 초기화");
					}}
				>
					초기화
				</button>
				<button
					type="button"
					className="btn btn-tiny btn-ghost"
					onClick={() => {
						block.spaces.push({
							label: "",
							tasks: [{ key: "", desc: "", progress: "", due: "", subs: [] }],
						});
						commit();
					}}
				>
					+ 스페이스
				</button>
			</div>

			<div className="px-3.5 pb-3.5 pt-3">
				<div
					className={"rounded-[10px] " + (over ? "dragover-copy" : "")}
					{...props}
				>
					{!block.spaces.length && (
						<div className="whitespace-pre-line p-3.5 text-center text-[13px] text-ink-2">
							{"스페이스를 추가한 뒤 일일 진행 업무에서 항목을 선택하세요\n"}
							<span className="mt-1.5 block text-xs opacity-85">
								또는 일일 진행 업무를 여기로 드래그
							</span>
						</div>
					)}
					{block.spaces.map((sp, si) => (
						<ScrumSpace
							key={si}
							space={sp}
							block={block}
							which={which}
							index={si}
						/>
					))}
				</div>

				<div className="mt-1.5">
					<label className="mb-[3px] block text-xs text-ink-2">이슈 사항</label>
					<input
						placeholder="없음"
						value={block.issues || ""}
						onChange={(e) => {
							block.issues = e.target.value;
							commit();
						}}
					/>
				</div>
				<div className="mt-1.5">
					<label className="mb-[3px] block text-xs text-ink-2">
						협업 및 기타
					</label>
					<input
						placeholder="없음"
						value={block.collab || ""}
						onChange={(e) => {
							block.collab = e.target.value;
							commit();
						}}
					/>
				</div>
			</div>
		</div>
	);
}
