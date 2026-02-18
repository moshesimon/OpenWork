import type { WorkspaceTextEditOperation } from "@/types/agent";

export function applyWorkspaceTextEditOperation(
  source: string,
  operation: WorkspaceTextEditOperation,
): string {
  if (operation.type === "replace_range") {
    const start = clampOffset(operation.start, source.length);
    const end = clampOffset(operation.end, source.length);
    if (end < start) {
      throw new Error("Invalid replace_range operation.");
    }

    return `${source.slice(0, start)}${operation.text}${source.slice(end)}`;
  }

  if (operation.type === "insert") {
    const offset = clampOffset(operation.offset, source.length);
    return `${source.slice(0, offset)}${operation.text}${source.slice(offset)}`;
  }

  const start = clampOffset(operation.start, source.length);
  const end = clampOffset(operation.end, source.length);
  if (end < start) {
    throw new Error("Invalid delete_range operation.");
  }

  return `${source.slice(0, start)}${source.slice(end)}`;
}

export function applyWorkspaceTextEditOperations(
  source: string,
  operations: WorkspaceTextEditOperation[],
): string {
  return operations.reduce(
    (current, operation) => applyWorkspaceTextEditOperation(current, operation),
    source,
  );
}

export function diffToSingleReplaceOperation(
  before: string,
  after: string,
): WorkspaceTextEditOperation[] {
  if (before === after) {
    return [];
  }

  let start = 0;
  const maxSharedPrefix = Math.min(before.length, after.length);
  while (start < maxSharedPrefix && before[start] === after[start]) {
    start += 1;
  }

  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  return [
    {
      type: "replace_range",
      start,
      end: beforeEnd + 1,
      text: after.slice(start, afterEnd + 1),
    },
  ];
}

function clampOffset(value: number, max: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Edit operation index must be a finite number.");
  }

  const integer = Math.trunc(value);
  return Math.max(0, Math.min(integer, max));
}
