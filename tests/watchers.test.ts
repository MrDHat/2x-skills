import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Watchers, type WatchResult } from "../pi/lib/watchers.ts";

const names = ["watch-pr-comments.sh", "watch-pr-merged.sh", "pr-check-watcher.sh"];
const url = "https://github.com/MrDHat/2x-skills/pull/3";
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await pause(30); }
  assert.fail("Timed out waiting for watcher");
}

function fixture(t: { after: (fn: () => void) => void }, script: string) {
  const dir = mkdtempSync(join(tmpdir(), "2x-watch-"));
  for (const name of names) writeFileSync(join(dir, name), "#!/bin/bash\n" + script);
  const reports: WatchResult[] = [];
  const watcher = new Watchers(dir, (result) => reports.push(result));
  t.after(() => { watcher.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, reports, watcher };
}

test("watchers use argument vectors, bound jobs, and reject invalid URLs", async (t) => {
  const h = fixture(t, 'sleep 30\n');
  assert.throws(() => h.watcher.start("https://github.com/a/b/pull/1;evil", h.dir));
  h.watcher.start(url, h.dir);
  h.watcher.start(url, h.dir);
  assert.equal(h.watcher.list().length, 3);
  for (const n of [4, 5, 6]) h.watcher.start(`https://github.com/a/b/pull/${n}`, h.dir);
  assert.equal(h.watcher.list().length, 12);
  assert.throws(() => h.watcher.start("https://github.com/a/b/pull/7", h.dir), /four PRs/);
  h.watcher.stop();
  assert.deepEqual(h.watcher.list(), []);
  await pause(100);
  assert.equal(h.reports.length, 0);
});

test("timeouts resume each watcher with its returned cursor", async (t) => {
  const h = fixture(t, `
name=$(basename "$0")
printf '%s\\n' "$2" >> "$name.args"
if [ ! -f "$name.once" ]; then
  touch "$name.once"
  case "$name" in
    watch-pr-comments.sh) echo 'NEXT_SINCE=2026-01-01T00:00:00Z' ;;
    watch-pr-merged.sh) echo 'RESUME_ETAG="etag"' ;;
    pr-check-watcher.sh) echo 'RESUME_ETAGS="runs"|||"statuses"' ;;
  esac
  exit 3
fi
echo 'mock API error'
exit 2
`);
  h.watcher.start(url, h.dir);
  await until(() => h.reports.length === 3);
  assert.deepEqual(h.watcher.list(), []);
  assert.match(readFileSync(join(h.dir, names[0] + ".args"), "utf8"), /2026-01-01T00:00:00Z/);
  assert.match(readFileSync(join(h.dir, names[1] + ".args"), "utf8"), /"etag"/);
  assert.match(readFileSync(join(h.dir, names[2] + ".args"), "utf8"), /"runs"\|\|\|"statuses"/);
  assert.equal(h.reports.every((r) => r.code === 2 && r.output.includes("mock API error")), true);
});

test("merge closes the other watchers and prevents late messages", async (t) => {
  const h = fixture(t, `
if [ "$(basename "$0")" = "watch-pr-merged.sh" ]; then
  sleep 0.1
  echo 'MERGED abc123'
  exit 0
fi
sleep 30
`);
  h.watcher.start(url, h.dir);
  await until(() => h.reports.length === 1);
  await pause(100);
  assert.equal(h.reports[0].kind, "merge");
  assert.deepEqual(h.watcher.list(), []);
});

test("successful comment activity resumes monitoring instead of ending it", async (t) => {
  const h = fixture(t, `
name=$(basename "$0")
if [ "$name" = "watch-pr-comments.sh" ] && [ ! -f once ]; then
  touch once
  echo 'comment someone: hello'
  echo 'NEXT_SINCE=next-cursor'
  exit 0
fi
printf '%s\\n' "$2" > "$name.args"
sleep 30
`);
  h.watcher.start(url, h.dir);
  await until(() => h.reports.length === 1);
  await pause(1100);
  assert.equal(h.watcher.list().length, 3);
  assert.match(readFileSync(join(h.dir, names[0] + ".args"), "utf8"), /next-cursor/);
});
