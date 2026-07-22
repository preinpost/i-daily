import type { ReactNode } from "react";
import { useEditor } from "../../context/EditorContext";
import { RawSection } from "./RawSection";
import { ListSection } from "./ListSection";
import { ScrumSection } from "./ScrumSection";

export function SectionList({
	curDate,
	onGenerateScrum,
	teamsBlock,
}: {
	curDate: string;
	onGenerateScrum: () => void;
	teamsBlock?: ReactNode;
}) {
	const { doc, commit } = useEditor();
	return (
		<div>
			{doc.sections.map((sec, idx) => {
				if (sec.kind === "scrum")
					return (
						<div key={idx}>
							<ScrumSection
								title={sec.title}
								curDate={curDate}
								onGenerate={onGenerateScrum}
							/>
							{teamsBlock}
						</div>
					);
				if (sec.kind === "list")
					return <ListSection key={idx} sec={sec} curDate={curDate} />;
				return (
					<RawSection
						key={idx}
						sec={sec}
						onRemove={() => {
							doc.sections.splice(idx, 1);
							commit();
						}}
					/>
				);
			})}
			<div className="mb-0.5 mt-2">
				<button
					type="button"
					className="btn btn-ghost"
					onClick={() => {
						doc.sections.push({ title: "새 섹션", kind: "raw", body: "" });
						commit();
					}}
				>
					+ 섹션 추가
				</button>
			</div>
		</div>
	);
}
