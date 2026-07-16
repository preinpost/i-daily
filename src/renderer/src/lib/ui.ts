export function confirmReset(label: string): boolean {
  return confirm(label + "를 비울까요? (저장 전이면 새로고침으로 복구)");
}

// textarea 높이를 내용에 맞춰 확장(입력 오버플로 대신).
export function autoGrow(ta: HTMLTextAreaElement | null): void {
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}
