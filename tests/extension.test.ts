import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../pi/extensions/fin-2x.ts";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "2x-extension-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const notifications: string[] = [];
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: (name: string, value: any) => commands.set(name, value),
    registerTool: (value: any) => tools.set(value.name, value),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", id: String(entries.length), customType, data }),
    sendMessage: (message: any) => notifications.push(message.content),
    exec: async (command: string, args: string[]) => {
      const result = spawnSync(command, args, { encoding: "utf8" });
      return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
  extension(pi as unknown as ExtensionAPI);
  const ctx = {
    cwd: process.cwd(), hasUI: true, signal: undefined,
    sessionManager: { getBranch: () => entries },
    ui: { notify: (message: string) => notifications.push(message), confirm: async () => true },
  };
  handlers.get("session_start")!({}, ctx);
  const paths = [
    ["create-pr", "plugins/pr-tools/skills/create-pr/SKILL.md"],
    ["fix-flaky-tests", "plugins/test-tools/skills/fix-flaky-tests/SKILL.md"],
    ["secure-github-actions", "plugins/security-tools/skills/secure-github-actions/SKILL.md"],
    ["tool-misses", "pi/skills/tool-misses/SKILL.md"],
    ["permissions-analyzer", "pi/skills/permissions-analyzer/SKILL.md"],
  ];
  const start = (prompt = "Hello", pathsToLoad = paths) => handlers.get("before_agent_start")!({ messageType: "user", prompt, systemPromptOptions: { skills: pathsToLoad.map(([name, path]) => ({ name, filePath: resolve(path) })), promptGuidelines: [] } }, ctx);
  start();
  return { handlers, commands, tools, entries, notifications, ctx, dir, start,
    cleanup: () => { handlers.get("session_shutdown")!({}, ctx); rmSync(dir, { recursive: true, force: true }); if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; },
  };
}

test("extension factory is inert and registers commands/tools", (t) => {
  const h = harness(); t.after(h.cleanup);
  assert.equal(h.tools.size, 1);
  assert.equal(h.commands.size, 1);
  assert.equal(h.entries.length, 0);
  assert.equal(h.notifications.length, 0);
});

test("PR guard rejects direct create but not quoted text; read activation resets on compaction/tree", async (t) => {
  const h = harness(); t.after(h.cleanup);
  const call = (command: string) => h.handlers.get("tool_call")!({ toolName: "bash", input: { command } }, h.ctx);
  assert.equal((await call("gh pr create --title x")).block, true);
  assert.equal(await call("echo 'gh pr create'"), undefined);
  assert.equal(await call("cat <<'EOF'\ngh pr create\nEOF"), undefined);
  const path = resolve("plugins/pr-tools/skills/create-pr/SKILL.md");
  h.entries.push({ type: "message", id: "a", message: { role: "assistant", content: [{ type: "toolCall", name: "read", id: "r", arguments: { path } }] } });
  h.entries.push({ type: "message", id: "b", message: { role: "toolResult", toolName: "read", toolCallId: "r", isError: false, content: [{ type: "text", text: readFileSync(path, "utf8") }] } });
  assert.equal(await call("gh pr create --title x"), undefined);
  h.entries.push({ type: "compaction" });
  assert.equal((await call("gh pr create --title x")).block, true);
  h.entries.splice(0);
  h.handlers.get("session_tree")!({}, h.ctx);
  assert.equal((await call("gh pr create --title x")).block, true);
});

test("disabled skill resource does not auto-load or guard", async (t) => {
  const h = harness(); t.after(h.cleanup);
  assert.equal(h.start("Investigate this flaky test", []), undefined);
  const call = await h.handlers.get("tool_call")!({ toolName: "bash", input: { command: "gh pr create" } }, h.ctx);
  assert.equal(call, undefined);
});

test("nudges deduplicate, preserve results, and support persistent opt-out", async (t) => {
  const h = harness(); t.after(h.cleanup);
  assert.match(h.start("Investigate this flaky test").message.content, /# Fix Flaky Tests/);
  assert.equal(h.start("Investigate this flaky test"), undefined);
  const event = { toolName: "read", input: { path: ".github/workflows/ci.yml" }, isError: false, content: [{ type: "text", text: "workflow" }], structuredContent: { retained: true } };
  const result = h.handlers.get("tool_result")!(event, h.ctx);
  assert.equal(result.content[0].text, "workflow");
  assert.deepEqual(result.structuredContent, event.structuredContent);
  assert.match(result.content[1].text, /secure-github-actions/);
  assert.equal(h.handlers.get("tool_result")!(event, h.ctx), undefined);
  await h.commands.get("fin-2x").handler("tool-misses off", h.ctx);
  assert.equal(h.handlers.get("tool_result")!({ toolName: "bash", input: {}, isError: true, content: [{ type: "text", text: "bash: jq: command not found" }] }, h.ctx), undefined);
  assert.equal(JSON.parse(readFileSync(join(h.dir, "fin-2x/hooks.json"), "utf8"))["tool-misses"], false);
});

test("approval is opt-in, exact GREEN only, and fails closed without UI or valid policy", async (t) => {
  const h = harness(); t.after(h.cleanup);
  const call = (command: string) => h.handlers.get("tool_call")!({ toolName: "bash", input: { command } }, h.ctx);
  assert.equal(await call("npm test"), undefined);
  await h.commands.get("fin-2x").handler("permissions on", h.ctx);
  writeFileSync(join(h.dir, "fin-2x/permissions.json"), JSON.stringify({ enabled: true, allow: ["git status", "npm test"] }));
  h.ctx.hasUI = false;
  assert.equal(await call("git status"), undefined);
  assert.equal((await call("npm test")).block, true);
  writeFileSync(join(h.dir, "fin-2x/permissions.json"), "{");
  assert.equal((await call("git status")).block, true);
});

test("five actual approval dialogs produce one permission tip", async (t) => {
  const h = harness(); t.after(h.cleanup);
  mkdirSync(join(h.dir, "fin-2x"));
  writeFileSync(join(h.dir, "fin-2x/permissions.json"), JSON.stringify({ enabled: true, allow: [] }));
  for (let i = 0; i < 5; i++) await h.handlers.get("tool_call")!({ toolName: "bash", input: { command: "npm test" } }, h.ctx);
  const event = { toolName: "bash", input: {}, isError: false, content: [{ type: "text", text: "ok" }] };
  assert.match(h.handlers.get("tool_result")!(event, h.ctx).content[1].text, /permissions-analyzer/);
  assert.equal(h.handlers.get("tool_result")!(event, h.ctx), undefined);
});
