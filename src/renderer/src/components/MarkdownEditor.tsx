import { useEditor, EditorContent, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { Markdown } from "tiptap-markdown";
import { useEffect, useRef } from "react";
import {
  Undo2,
  Redo2,
  Bold,
  Italic,
  Strikethrough,
  Code,
  SquareCode,
  List,
  ListOrdered,
  ListChecks,
  TextQuote,
  Link as LinkIcon,
  Minus,
  Table as TableIcon,
  BetweenVerticalStart,
  BetweenHorizontalStart,
  Trash2,
  Columns3,
  Rows3,
} from "lucide-react";

type Props = {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
};

// Tiptap 기반 마크다운 위지윅 에디터.
// 저장 포맷은 계속 "마크다운 문자열" — value(마크다운) ↔ 에디터 라운드트립.
export function MarkdownEditor({ value, onChange, placeholder }: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder: placeholder || "마크다운으로 자유롭게…" }),
      Markdown.configure({
        html: false,
        tightLists: true,
        bulletListMarker: "-",
        linkify: true,
        breaks: false,
        transformPastedText: true,
      }),
    ],
    content: value || "",
    onUpdate: ({ editor }) => {
      const md = (editor.storage as any).markdown.getMarkdown() as string;
      onChangeRef.current(md);
    },
    editorProps: {
      attributes: {
        class: "md-editor tiptap",
      },
    },
  });

  // 외부에서 value 가 바뀐 경우(날짜 전환·초기화 등)만 에디터에 반영.
  useEffect(() => {
    if (!editor) return;
    const current = (editor.storage as any).markdown.getMarkdown() as string;
    if (value !== current) {
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
  }, [value, editor]);

  return (
    <div className="md-wrap">
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}

/* ── 툴바 ─────────────────────────────────────────────────── */

function Toolbar({ editor }: { editor: Editor }) {
  // 선택/문서 변경 시 버튼 활성 상태 갱신
  const s = useEditorState({
    editor,
    selector: ({ editor }) => ({
      canUndo: editor.can().undo(),
      canRedo: editor.can().redo(),
      heading: editor.isActive("heading", { level: 1 })
        ? "h1"
        : editor.isActive("heading", { level: 2 })
          ? "h2"
          : editor.isActive("heading", { level: 3 })
            ? "h3"
            : "p",
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      strike: editor.isActive("strike"),
      code: editor.isActive("code"),
      bulletList: editor.isActive("bulletList"),
      orderedList: editor.isActive("orderedList"),
      taskList: editor.isActive("taskList"),
      blockquote: editor.isActive("blockquote"),
      codeBlock: editor.isActive("codeBlock"),
      link: editor.isActive("link"),
      table: editor.isActive("table"),
    }),
  });

  const c = () => editor.chain().focus();

  const setHeading = (v: string) => {
    if (v === "p") c().setParagraph().run();
    else c().toggleHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 }).run();
  };

  const toggleLink = () => {
    if (s.link) return c().unsetLink().run();
    const url = window.prompt("링크 URL");
    if (url) c().setLink({ href: url }).run();
  };

  return (
    <div className="md-toolbar">
      <div className="md-tb-group">
        <TbBtn title="실행 취소" disabled={!s.canUndo} onClick={() => c().undo().run()}>
          {IC.undo}
        </TbBtn>
        <TbBtn title="다시 실행" disabled={!s.canRedo} onClick={() => c().redo().run()}>
          {IC.redo}
        </TbBtn>
      </div>

      <span className="md-tb-sep" />

      <div className="md-tb-group">
        <select
          className="md-tb-select"
          value={s.heading}
          onChange={(e) => setHeading(e.target.value)}
          title="문단 스타일"
        >
          <option value="p">본문</option>
          <option value="h1">제목 1</option>
          <option value="h2">제목 2</option>
          <option value="h3">제목 3</option>
        </select>
      </div>

      <span className="md-tb-sep" />

      <div className="md-tb-group">
        <TbBtn title="굵게" active={s.bold} onClick={() => c().toggleBold().run()}>
          {IC.bold}
        </TbBtn>
        <TbBtn title="기울임" active={s.italic} onClick={() => c().toggleItalic().run()}>
          {IC.italic}
        </TbBtn>
        <TbBtn title="취소선" active={s.strike} onClick={() => c().toggleStrike().run()}>
          {IC.strike}
        </TbBtn>
        <TbBtn title="인라인 코드" active={s.code} onClick={() => c().toggleCode().run()}>
          {IC.code}
        </TbBtn>
      </div>

      <span className="md-tb-sep" />

      <div className="md-tb-group">
        <TbBtn title="불릿 목록" active={s.bulletList} onClick={() => c().toggleBulletList().run()}>
          {IC.bullet}
        </TbBtn>
        <TbBtn title="번호 목록" active={s.orderedList} onClick={() => c().toggleOrderedList().run()}>
          {IC.ordered}
        </TbBtn>
        <TbBtn title="체크리스트" active={s.taskList} onClick={() => c().toggleTaskList().run()}>
          {IC.task}
        </TbBtn>
      </div>

      <span className="md-tb-sep" />

      <div className="md-tb-group">
        <TbBtn title="인용" active={s.blockquote} onClick={() => c().toggleBlockquote().run()}>
          {IC.quote}
        </TbBtn>
        <TbBtn title="코드 블록" active={s.codeBlock} onClick={() => c().toggleCodeBlock().run()}>
          {IC.codeBlock}
        </TbBtn>
        <TbBtn title="링크" active={s.link} onClick={toggleLink}>
          {IC.link}
        </TbBtn>
        <TbBtn title="구분선" onClick={() => c().setHorizontalRule().run()}>
          {IC.hr}
        </TbBtn>
      </div>

      <span className="md-tb-sep" />

      <div className="md-tb-group">
        <TbBtn
          title="표 삽입 (3×3)"
          active={s.table}
          onClick={() =>
            c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          }
        >
          {IC.table}
        </TbBtn>
        {s.table && (
          <>
            <TbBtn title="열 추가" success onClick={() => c().addColumnAfter().run()}>
              {IC.colAfter}
            </TbBtn>
            <TbBtn title="행 추가" success onClick={() => c().addRowAfter().run()}>
              {IC.rowAfter}
            </TbBtn>
            <TbBtn title="열 삭제" danger onClick={() => c().deleteColumn().run()}>
              {IC.colDelete}
            </TbBtn>
            <TbBtn title="행 삭제" danger onClick={() => c().deleteRow().run()}>
              {IC.rowDelete}
            </TbBtn>
            <TbBtn title="표 삭제" danger onClick={() => c().deleteTable().run()}>
              {IC.tableDelete}
            </TbBtn>
          </>
        )}
      </div>
    </div>
  );
}

function TbBtn({
  title,
  active,
  danger,
  success,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  danger?: boolean;
  success?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={
        "md-tb-btn" +
        (active ? " is-active" : "") +
        (danger ? " is-danger" : "") +
        (success ? " is-success" : "")
      }
      disabled={disabled}
      // mousedown 기본동작 막아 에디터 포커스/선택 유지
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/* ── 아이콘 (currentColor, 18px) ───────────────────────────── */
const SZ = 18;
const IC = {
  undo: <Undo2 size={SZ} />,
  redo: <Redo2 size={SZ} />,
  bold: <Bold size={SZ} />,
  italic: <Italic size={SZ} />,
  strike: <Strikethrough size={SZ} />,
  code: <Code size={SZ} />,
  bullet: <List size={SZ} />,
  ordered: <ListOrdered size={SZ} />,
  task: <ListChecks size={SZ} />,
  quote: <TextQuote size={SZ} />,
  codeBlock: <SquareCode size={SZ} />,
  link: <LinkIcon size={SZ} />,
  hr: <Minus size={SZ} />,
  table: <TableIcon size={SZ} />,
  colAfter: <BetweenVerticalStart size={SZ} />,
  rowAfter: <BetweenHorizontalStart size={SZ} />,
  colDelete: <Columns3 size={SZ} />,
  rowDelete: <Rows3 size={SZ} />,
  tableDelete: <Trash2 size={SZ} />,
};
