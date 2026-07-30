import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor } from "../context/EditorContext";
import { useToast } from "./Toast";
import { todayDailyItems } from "../lib/model";
import {
	ensureListSection,
	parseTeamsPaste,
} from "../../../shared/model";

export function TeamsImportModal({ onClose }: { onClose: () => void }) {
	const { doc, commit } = useEditor();
	const toast = useToast();
	const [text, setText] = useState("");
	const ref = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		ref.current?.focus();
	}, []);

	function apply() {
		if (!doc) return;
		const year =
			Number((doc.date || "").slice(0, 4)) || new Date().getFullYear();
		const parsed = parseTeamsPaste(text, year);
		const hasMeta = !!(parsed.issues || parsed.collab);
		if (!parsed.items.length && !hasMeta) {
			toast("금일 진행 업무에서 가져올 내용이 없어요");
			return;
		}

		const existing = todayDailyItems(doc).filter(
			(it) => (it.key || "").trim() || (it.desc || "").trim(),
		);
		if (
			existing.length &&
			!confirm(
				`일일 진행 업무 ${existing.length}건을 Teams 붙여넣기(${parsed.items.length}건)로 바꿀까요?`,
			)
		)
			return;

		const sec = ensureListSection(doc);
		sec.items = parsed.items;
		doc.scrum.today.issues = parsed.issues;
		doc.scrum.today.collab = parsed.collab;
		commit();
		const bits = [`항목 ${parsed.items.length}건`];
		if (hasMeta) bits.push("이슈·협업");
		toast(`Teams에서 가져옴 — ${bits.join(" · ")}`);
		onClose();
	}

	return createPortal(
		<div
			className="fixed inset-0 z-[200] flex items-center justify-center bg-black/45 p-4"
			onMouseDown={onClose}
		>
			<div
				className="flex max-h-[min(90vh,640px)] w-full max-w-[560px] flex-col rounded-xl border border-line bg-panel p-4 shadow-2xl"
				onMouseDown={(e) => e.stopPropagation()}
			>
				<h4 className="m-0 mb-1 text-[15px] font-bold text-ink">
					Teams에서 가져오기
				</h4>
				<p className="mb-3 mt-0 text-[12.5px] leading-[1.5] text-ink-2">
					지금 선택한 날짜의 Teams 데일리 스크럼을 붙여넣으세요.{" "}
					<b className="font-semibold text-ink">금일 진행 업무</b>만 일일 진행
					업무·이슈·협업으로 가져오고, 전일 블록은 무시합니다.
				</p>
				<textarea
					ref={ref}
					className="min-h-[220px] w-full flex-1 resize-y font-mono text-[12.5px] leading-[1.45]"
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") onClose();
						if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
							e.preventDefault();
							apply();
						}
					}}
				/>
				<div className="mt-3.5 flex justify-end gap-2">
					<button type="button" className="btn btn-ghost" onClick={onClose}>
						취소
					</button>
					<button
						type="button"
						className="btn btn-primary"
						disabled={!text.trim()}
						onClick={apply}
					>
						가져오기
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
