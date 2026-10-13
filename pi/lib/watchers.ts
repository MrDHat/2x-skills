import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export type WatchKind = "comments" | "merge" | "checks";
const scripts: Record<WatchKind, string> = {
  comments: "watch-pr-comments.sh",
  merge: "watch-pr-merged.sh",
  checks: "pr-check-watcher.sh",
};
const cursors: Record<WatchKind, string> = {
  comments: "NEXT_SINCE", merge: "RESUME_ETAG", checks: "RESUME_ETAGS",
};

export interface WatchResult {
  url: string;
  kind: WatchKind;
  code: number;
  output: string;
}

interface Job {
  url: string;
  kind: WatchKind;
  child?: ChildProcess;
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
}

export class Watchers {
  private jobs = new Map<string, Job>();
  private scriptsDir: string;
  private report: (result: WatchResult) => void;
  constructor(scriptsDir: string, report: (result: WatchResult) => void) {
    this.scriptsDir = scriptsDir;
    this.report = report;
  }

  start(url: string, cwd: string): void {
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(url)) {
      throw new Error("Expected a full https://github.com/OWNER/REPO/pull/NUMBER URL");
    }
    const kinds = Object.keys(scripts) as WatchKind[];
    const missing = kinds.filter((kind) => !this.jobs.has(`${url}:${kind}`));
    if (this.jobs.size + missing.length > 12) throw new Error("At most four PRs can be watched; stop a watcher first");
    for (const kind of missing) {
      const key = `${url}:${kind}`;
      const job: Job = { url, kind, stopped: false };
      this.jobs.set(key, job);
      this.run(key, job, cwd, "");
    }
  }

  list(): string[] { return [...this.jobs.keys()]; }

  stop(url?: string): void {
    for (const [key, job] of this.jobs) {
      if (url && job.url !== url) continue;
      job.stopped = true;
      clearTimeout(job.timer);
      if (job.child?.pid) {
        const pid = job.child.pid;
        const kill = (signal: NodeJS.Signals) => {
          try {
            if (process.platform === "win32") job.child?.kill(signal);
            else process.kill(-pid, signal); // also stop gh/sleep children
          } catch { /* already exited */ }
        };
        kill("SIGTERM");
        const escalation = setTimeout(() => kill("SIGKILL"), 1000);
        escalation.unref();
        job.child.once("close", () => clearTimeout(escalation));
      }
      this.jobs.delete(key);
    }
  }

  private run(key: string, job: Job, cwd: string, cursor: string): void {
    if (job.stopped) return;
    let output = "";
    const child = spawn("bash", [join(this.scriptsDir, scripts[job.kind]), job.url, cursor], {
      cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WATCH_MAX_WAIT: "570" },
    });
    job.child = child;
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65536); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    // Outer watchdog bounds scripts that hang in a network call despite their deadline.
    const deadline = setTimeout(() => {
      if (job.stopped) return;
      this.stop(job.url);
      this.report({ url: job.url, kind: job.kind, code: 2, output: "Watcher exceeded its 11-minute hard deadline; monitoring stopped." });
    }, 660000);
    deadline.unref();
    child.once("error", (error) => { output += `\n${error.message}`; });
    child.once("close", (code) => {
      clearTimeout(deadline);
      job.child = undefined;
      if (job.stopped) return;
      if (code === 3 || (code === 0 && job.kind === "comments")) {
        const next = output.match(new RegExp(`(?:^|\\n)${cursors[job.kind]}=([^\\n]*)`))?.[1];
        if (code === 0) this.report({ url: job.url, kind: job.kind, code, output });
        if (next !== undefined) {
          job.timer = setTimeout(() => this.run(key, job, cwd, next), 1000);
          job.timer.unref();
          return;
        }
        output += "\nNo resume cursor returned; monitoring stopped.";
      }
      this.jobs.delete(key);
      this.report({ url: job.url, kind: job.kind, code: code ?? 2, output });
      if (job.kind === "merge" && (code === 0 || code === 1)) this.stop(job.url);
    });
  }
}
