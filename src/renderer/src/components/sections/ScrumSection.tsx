import { ScrumBlock } from "./ScrumBlock";

export function ScrumSection({ title, curDate }: { title: string; curDate: string }) {
  return (
    <div className="mb-[22px]">
      <h3 className="mb-2.5 mt-0 flex items-center gap-[7px] text-[15px] tracking-[-0.2px]">
        <span>{title}</span>
      </h3>

      <div className="rules mb-3.5 rounded-[10px] border border-line bg-panel-2 p-[10px_12px] text-[12.5px] text-ink-2">
        <details>
          <summary>
            회사 규정 체크리스트 <span className="font-normal text-ink-2">(펼치기)</span>
          </summary>
          <ol className="mt-2 grid list-decimal gap-[3px] pl-[18px]">
            <li>
              모든 업무는 <b>일일 진행 업무에 먼저 등록</b> → 전일/금일은 드롭다운으로 선택 (티켓 중복 입력 금지)
            </li>
            <li>
              각 항목에 <b>진척률(%)·마감일</b> 필수 — 형식 <span className="kbd">(N%, ~M/D)</span> · 전일/금일에서만 쪽별
              override
            </li>
            <li>
              <b>전일</b> = 실제로 <b>한</b> 일만 / <b>금일</b> = 실제로 <b>할</b> 일만
            </li>
            <li>
              계획 외 추가로 한 일은 <b>익일 전일 업무</b>에 기재
            </li>
            <li>
              <b>해소된 이슈</b>는 이슈 사항에서 제거
            </li>
            <li>
              출근 후 <b>30분 이내</b> 공유가 목표
            </li>
          </ol>
        </details>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ScrumBlock which="prev" curDate={curDate} />
        <ScrumBlock which="today" curDate={curDate} />
      </div>
    </div>
  );
}
