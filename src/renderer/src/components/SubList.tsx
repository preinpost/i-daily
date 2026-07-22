import { useEffect, useRef } from "react";
import { useEditor } from "../context/EditorContext";
import { useSubReorder } from "../lib/useDnd";

// 일일 항목의 하위 목록(편집).
export function SubList({ subs }: { subs: string[] }) {
	const { commit } = useEditor();
	const ref = useRef<HTMLDivElement>(null);
	const prevLen = useRef(subs.length);

	useEffect(() => {
		if (subs.length > prevLen.current) {
			const ins = ref.current?.querySelectorAll<HTMLInputElement>(".subin");
			if (ins && ins.length) ins[ins.length - 1].focus();
		}
		prevLen.current = subs.length;
	});

	return (
		<div ref={ref} className="w-full basis-full">
			{subs.map((val, i) => (
				<SubRow key={i} subs={subs} index={i} commit={commit} />
			))}
		</div>
	);
}

function SubRow({
	subs,
	index,
	commit,
}: {
	subs: string[];
	index: number;
	commit: () => void;
}) {
	const { over, handleProps, rowProps } = useSubReorder(subs, index, commit);

	return (
		<div
			className={
				"sub-bullet drag-row mt-1 ml-2 flex items-center gap-1.5 rounded " +
				(over ? "dragover" : "")
			}
			{...rowProps}
		>
			<span
				className="draghandle flex-none cursor-grab select-none px-[3px] text-[13px] leading-none text-ink-2"
				title="드래그해서 하위 순서 변경"
				{...handleProps}
			>
				⠿
			</span>
			<input
				className="subin flex-1 text-[13px]"
				value={subs[index] || ""}
				placeholder="하위 항목"
				onChange={(e) => {
					subs[index] = e.target.value;
					commit();
				}}
			/>
			<button
				type="button"
				className="btn btn-icon btn-tiny flex-none text-[15px] leading-none"
				title="하위 삭제"
				onClick={() => {
					subs.splice(index, 1);
					commit();
				}}
			>
				−
			</button>
		</div>
	);
}
