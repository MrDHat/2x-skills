import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { flakyPrompt, skillActive, toolMiss, wasSuggested, workflowPath } from "../pi/lib/hooks.ts";

const path = resolve("plugins/pr-tools/skills/create-pr/SKILL.md");
const read = { type: "message", id: "a", message: { role: "assistant", content: [{ type: "toolCall", id: "r", name: "read", arguments: { path } }] } };
const result = { type: "message", id: "b", message: { role: "toolResult", toolName: "read", toolCallId: "r", isError: false, content: [{ type: "text", text: "## Core Rules\n## Anti-Patterns" }] } };

test("PR activation requires a successful complete skill read on current branch", () => {
  assert.equal(skillActive([read, result], path, process.cwd()), true);
  assert.equal(skillActive([read], path, process.cwd()), false);
  assert.equal(skillActive([read, { ...result, message: { ...result.message, isError: true } }], path, process.cwd()), false);
  assert.equal(skillActive([read, result, { type: "compaction" }], path, process.cwd()), false);
  assert.equal(skillActive([{ type: "compaction" }, read, result], path, process.cwd()), true);
  assert.equal(skillActive([read, result, { type: "context_edit", targetId: "b", replacement: null }], path, process.cwd()), false);
  assert.equal(skillActive([{ ...read, message: { ...read.message, content: [{ ...read.message.content[0], arguments: { path, limit: 5 } }] } }, result], path, process.cwd()), false);
  assert.equal(skillActive([read, { ...result, message: { ...result.message, content: [{ type: "text", text: "## Core Rules\n## Anti-Patterns\nUse offset=100" }] } }], path, process.cwd()), false);
});

test("explicit Pi skill expansion activates, a mention does not", () => {
  const user = (content: string) => ({ type: "message", message: { role: "user", content } });
  assert.equal(skillActive([user(`<skill name="create-pr" location="${path}">\ninstructions\n</skill>`)], path, process.cwd()), true);
  assert.equal(skillActive([user("Please load create-pr")], path, process.cwd()), false);
});

test("dedup markers are branch-local and reset after compaction", () => {
  const marker = { type: "custom", customType: "fin-2x.suggested", data: { name: "x" } };
  assert.equal(wasSuggested([marker], "x"), true);
  assert.equal(wasSuggested([marker, { type: "compaction" }], "x"), false);
  assert.equal(wasSuggested([], "x"), false);
});

test("flaky triggers preserve dispute priority and review exclusions", () => {
  assert.equal(flakyPrompt("Review this PR fixing a flaky test"), false);
  assert.equal(flakyPrompt("Review #5 wrongly closed https://github.com/a/b/issues/5"), true);
  assert.equal(flakyPrompt("Set up jest and pytest"), false);
  assert.equal(flakyPrompt("Why does this pass on retry?"), false);
  assert.equal(flakyPrompt("This test passes on retry"), true);
  assert.equal(flakyPrompt("How do I verify this CI-only flake?"), true);
});

test("workflow scope is anchored and includes disabled workflow directory", () => {
  assert.equal(workflowPath("/repo/.github/workflows/test.yml"), true);
  assert.equal(workflowPath(".github/workflows-disabled/test.yaml"), true);
  assert.equal(workflowPath("/repo/not.github/workflows/test.yml"), false);
  assert.equal(workflowPath("/repo/.github/workflows/test.yml.bak"), false);
});

test("tool miss nudges require failed structured diagnostics", () => {
  assert.equal(toolMiss("bash: jq: command not found", false), false);
  assert.equal(toolMiss("docs say jq: command not found", true), false);
  assert.equal(toolMiss("bash: jq: command not found", true), true);
  assert.equal(toolMiss("zsh: command not found: jq", true), true);
  assert.equal(toolMiss("grep: invalid option -- P\nCommand exited with code 2", false), true);
  assert.equal(toolMiss("/tmp/.claude/plugins/foo/hooks/x.sh: line 1: jq: command not found", true), false);
  assert.equal(toolMiss("/repo/hooks/x.sh: line 1: jq: command not found", true), true);
});
