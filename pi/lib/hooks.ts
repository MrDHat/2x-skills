import { resolve } from "node:path";

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

export function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
}

export function afterCompaction(entries: readonly unknown[]): unknown[] {
  const last = entries.findLastIndex((entry) => record(entry).type === "compaction");
  return entries.slice(last + 1);
}

export function wasSuggested(entries: readonly unknown[], name: string): boolean {
  return afterCompaction(entries).some((entry) => {
    const item = record(entry);
    return item.type === "custom" && item.customType === "fin-2x.suggested" && item.data?.name === name;
  });
}

export function skillActive(entries: readonly unknown[], path: string, cwd: string): boolean {
  const branch = afterCompaction(entries).map(record);
  const removed = new Set(branch.filter((e) => e.type === "context_edit").map((e) => e.targetId));
  const calls = new Map<string, { path: string; entryId: string }>();
  for (const entry of branch) {
    if (removed.has(entry.id)) continue;
    if (entry.type !== "message") continue;
    const message = record(entry.message);
    if (message.role === "user") {
      const content = textContent(message.content);
      // Only Pi's top-level skill expansion, not arbitrary mentions of its name.
      if (content.startsWith(`<skill name="create-pr" location="${path}">\n`) && content.includes("\n</skill>")) return true;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "toolCall" && block.name === "read" && typeof block.arguments?.path === "string" &&
            !(block.arguments.offset > 1) && block.arguments.limit == null) {
          calls.set(block.id, { path: resolve(cwd, block.arguments.path), entryId: entry.id });
        }
      }
    }
    if (message.role === "toolResult" && message.toolName === "read" && !message.isError &&
        calls.get(message.toolCallId)?.path === path) {
      const output = textContent(message.content);
      // Reading only the frontmatter or a truncated fragment is not activation.
      if (output.includes("## Core Rules") && output.includes("## Anti-Patterns") && !output.includes("Use offset=")) return true;
    }
  }
  return false;
}

export function flakyPrompt(prompt: string): boolean {
  const dispute = /(wrongly|incorrectly|mis-?) ?(closed|identified|diagnos)|re-?investigate|reopen|wrong root cause|dispute(d)?.{0,25}(closure|diagnosis|root cause)/i;
  if (dispute.test(prompt) && /https?:\/\/\S+\/issues\/\d+/i.test(prompt)) return true;
  if (/\breview (this |the )?(pull request|pr)\b|\bcode review\b/i.test(prompt)) return false;
  return /\b(flaky|intermittent(ly)?|fail(s|ing)? in ci|passes locally|passes on retry|ci.only|flake|browser crash|xit|skipped (spec|test))\b/i.test(prompt);
}

export function workflowPath(path: unknown): boolean {
  return typeof path === "string" && /(?:^|\/)\.github\/workflows(?:-disabled)?\/[^\n]+\.ya?ml$/.test(path.replaceAll("\\", "/"));
}

export function toolMiss(output: string, isError: boolean): boolean {
  if (!isError && !/(?:^|\n)Command exited with code [1-9]\d*/.test(output)) return false;
  const lines = output.split("\n").filter((line) => !/\.claude\/plugins\/.*\/hooks\//.test(line));
  const missing = /^\s*(?:(?:[a-zA-Z0-9._/-]+|line \d+): )*(?:[A-Za-z_][\w.-]*: command not found|command not found: [A-Za-z_][\w.-]*)\s*$/;
  return lines.some((line) => missing.test(line) || /(?:sed: .*invalid command code|grep: invalid option -- ['"]?P|find: .*unknown primary|\b(?:xargs|date|readlink|sort|head|tail): .*illegal (?:option|line count|offset)|tar: Option --.*is not supported|awk: .*function .* is not defined)/i.test(line));
}
