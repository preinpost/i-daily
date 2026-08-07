import { useEditor, EditorContent, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { Markdown } from "tiptap-markdown";
import { Extension } from "@tiptap/core";
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

/* ── Tab / Shift-Tab 처리 ─────────────────────────────────
   기본 동작(브라우저 포커스 이동)을 막고 문맥별로 들여쓰기를 처리한다.
   - 표: 다음/이전 셀
   - 리스트/체크리스트: 뎁스 증가·감소
   - 코드블록: CodeBlock 확장의 enableTabIndentation 에 위임(2칸)
   - 그 외: 아무것도 안 하지만 포커스는 유지
---------------------------------------------------------- */
const INDENT = "  ";
const inCodeBlock = (editor: Editor) =>
  editor.state.selection.$from.parent.type.name === "codeBlock";

const TabHandling = Extension.create({
  name: "tabHandling",
  priority: 1000, // StarterKit·Table 의 기본 Tab 바인딩보다 먼저 잡는다
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        if (inCodeBlock(editor)) {
          // 커서만 있는 경우 CodeBlock 내장 처리는 insertContent("  ") 를 쓰는데,
          // tiptap-markdown 이 insertContent 문자열을 마크다운으로 파싱해서 공백이 사라진다.
          // 그래서 이 경우만 직접 트랜잭션으로 공백을 넣는다.
          if (editor.state.selection.empty) {
            return editor.commands.command(({ tr, state, dispatch }) => {
              if (dispatch) {
                const { from, to } = state.selection;
                dispatch(tr.insertText(INDENT, from, to).scrollIntoView());
              }
              return true;
            });
          }
          return false; // 범위 선택은 CodeBlock 확장이 줄 단위로 처리
        }
        if (editor.isActive("table")) return editor.commands.goToNextCell() || true;
        if (editor.isActive("taskItem")) return editor.commands.sinkListItem("taskItem") || true;
        if (editor.isActive("listItem")) return editor.commands.sinkListItem("listItem") || true;
        return true; // 포커스가 밖으로 나가지 않도록 소비
      },
      "Shift-Tab": ({ editor }) => {
        if (inCodeBlock(editor)) return false;
        if (editor.isActive("table")) return editor.commands.goToPreviousCell() || true;
        if (editor.isActive("taskItem")) return editor.commands.liftListItem("taskItem") || true;
        if (editor.isActive("listItem")) return editor.commands.liftListItem("listItem") || true;
        return true;
      },
    };
  },
});

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
      StarterKit.configure({
        // 코드블록 안에서 Tab/Shift-Tab 들여쓰기 활성화 (기본값 false)
        codeBlock: { enableTabIndentation: true, tabSize: 2 },
      }),
      Image.configure({ inline: false, allowBase64: true }),
      TabHandling,
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

  // 설명 내부 이미지 로드 실패(붙여넣기 이미지는 Jira 공개 API 로 조회 불가) →
  // 깨진 아이콘 대신 안내 문구로 교체. 이미지 노드는 Doc 에 유지되어 저장 시 보존된다.
  // 주의: 프록시가 즉시 4xx 로 응답하면 error 이벤트가 리스너 장착 전에 지나간다.
  //       그래서 이미 실패한 <img>(complete+naturalWidth=0) 는 즉시 교체한다.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;
    const replace = (img: HTMLImageElement) => {
      if ((img as any).__mdPh) return;
      (img as any).__mdPh = true;
      const ph = document.createElement("span");
      ph.textContent =
        "🖼️ [이미지: 붙여넣기 이미지는 편집기에서 렌더 불가 · 저장 시 보존]";
      ph.title = img.getAttribute("src") || "";
      ph.style.cssText =
        "display:inline-block;padding:10px 12px;margin:6px 0;border-radius:6px;" +
        "background:var(--panel-2);border:1px dashed var(--line-strong);color:var(--ink-2);font-size:12.5px;";
      img.replaceWith(ph);
    };
    const bind = () => {
      dom.querySelectorAll("img").forEach((img) => {
        if ((img as any).__mdPh) return;
        if (img.complete && img.naturalWidth === 0) replace(img);
        else img.addEventListener("error", () => replace(img), { once: true });
      });
    };
    bind();
    // value 갱신(setContent) 으로 새 <img> 가 생기는 경우 재바인딩.
    const ro = new MutationObserver(bind);
    ro.observe(dom, { childList: true, subtree: true });
    return () => ro.disconnect();
  }, [editor, value]);

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
