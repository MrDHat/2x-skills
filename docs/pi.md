# Pi support

## Installation

```bash
pi install git:github.com/MrDHat/2x-skills
# Or pin a branch/tag while reviewing a stack:
pi install git:github.com/MrDHat/2x-skills@MrDHat/pi-package
```

All GitHub contributions for this integration target `MrDHat/2x-skills`, not
its upstream parent. Installation does not change the Claude marketplace.

For development, `pi install /absolute/path/to/2x-skills`, then `/reload`.
Pi loads the directories declared in the root `package.json`; Claude Code
continues using `.claude-plugin` manifests and `hooks.json`.

## Shared skills

| Skill | Pi command |
| --- | --- |
| Skill quality review | `/skill:skill-review` |
| GitHub Actions security | `/skill:secure-github-actions` |
| Flaky tests | `/skill:fix-flaky-tests` |
| Architectural review | `/skill:thermo-nuclear-code-review` |
| Pull request creation | `/skill:create-pr` |
| GitHub asset upload | `/skill:attach-github-assets` |

The review rubric can review Claude plugins from Pi. Its Claude hook conventions
remain rules about the artifact being reviewed, not requirements of the Pi host.
Anthropic's optional `plugin-dev:skill-reviewer` is not supplied by this package.

Pi loads the same instructions and references rather than generated copies.
Resolve relative references from the loaded skill directory. Substitute absolute
paths for `<skill-dir>` and `<plugin-dir>` in script examples.

Claude tool names in shared instructions translate as follows: Read → `read`,
Bash → `bash`, Edit → `edit`, Write → `write`. Search with `grep`/`find` if enabled,
or shell commands otherwise. Skill invocation means reading the other skill's
`SKILL.md` (or asking the user to use `/skill:name`). AskUserQuestion means asking
the user in conversation and waiting. Never invent unavailable tools. Pi does not
enforce Claude's `allowed-tools` frontmatter. No subagent extension is required
for the shared skills.

## Pi-native workflows

The Claude-specific skill directory is deliberately not in the Pi manifest.
Instead it loads these native versions:

| Claude workflow | Pi equivalent |
| --- | --- |
| `tool-misses` | `/skill:tool-misses` scans Pi's ancestor-linked bash results |
| `cc-cost-analysis` | `/skill:pi-cost-analysis` reads local Pi usage estimates |
| `audit-memory` | `/skill:audit-memory --root <directory>` audits an explicit corpus |
| `permissions-analyzer` | `/skill:permissions-analyzer` reviews the optional Fin 2x policy |

Pi has no built-in memory store or Claude-style approval allowlist. The memory
workflow requires an explicit root; it never falls back to Claude data. Cost
reports include all branches and deduplicate copied fork history; prices are
estimates, and missing prices are not counted as free. No external telemetry or
session upload is involved.

The report script honors `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`.
Pass `--root` for CLI `--session-dir` or project `sessionDir` overrides: an offline
script cannot infer the current process's CLI settings. Errors name the selected
root rather than silently scanning a different corpus.

## Extensions and hooks

Tested with Pi 1.2.0 (`@earendil-works` packages). The extension uses Pi's native
events, not a Claude hook runner:

| Claude hook behavior | Pi integration |
| --- | --- |
| Flaky-test prompt injection | `before_agent_start`, same priority/exclusion rules |
| Workflow security injection | Successful `read`/`edit`/`write` result, scoped to workflow YAML |
| PR skill activation + PR interception | Complete skill read or explicit `/skill:create-pr`, checked on the active branch |
| Compaction marker cleanup | State before the latest compaction never satisfies the PR guard or nudge dedup |
| Missing-tool suggestions | Failed bash result only; manual scan, no automatic installs |
| Permission counting and suggestions | Actual dialogs from the opt-in Fin 2x gate, tip after five |

Nudges are deduplicated on the active branch until compaction. Disabled skill
resources are not auto-loaded; disabling `create-pr` also disables its guard.
`/tree` navigation and session changes cannot reuse an activation from an abandoned
branch. Failed, partial, or truncated reads do not satisfy the PR guard.

Control individual integrations:

```text
/fin-2x status
/fin-2x pr-guard off
/fin-2x flaky-tests off
/fin-2x workflow-security off
/fin-2x tool-misses off
/fin-2x permissions-tips off
```

Use `on` to re-enable or `status` to inspect any hook. Settings persist under
`<agent-dir>/fin-2x/hooks.json`. Optional nudges fail open; a broken PR-command
checker blocks the matching command. The PR guard shares the Claude plugin's
pragmatic quote/heredoc stripping: it catches ordinary `gh pr create`, not every
possible shell wrapper, alias, API invocation, or alternative tool. It is a
workflow aid, **not a security sandbox**.

### Approval policy

The optional permission policy lives at `<agent-dir>/fin-2x/permissions.json`:

```json
{"enabled": false, "allow": ["git status --short"]}
```

It is disabled by default and uses exact command strings, not prefix/glob rules.
Only a small GREEN set of local inspection commands can bypass confirmation;
interpreters/package managers/shell syntax are never auto-allowed. This is a
bash approval helper, **not a sandbox** or a gate over all tools. Claude hook
shell scripts are never executed by Pi.

```text
/fin-2x permissions on
/fin-2x permissions status
/fin-2x permissions off
```

Toggling the policy requires UI confirmation. With the policy enabled, a command
requiring approval is blocked in print/JSON mode; TUI and RPC clients can confirm.
Invalid policy JSON blocks bash, even if it cannot be parsed as enabled. Only
Fin 2x's own dialogs contribute to its counter; unrelated permission extensions
have no common event API and are not silently counted.

### Background PR monitoring

The model-callable `fin_2x_watch_pr` tool accepts `action: start|status|stop` and a
full GitHub PR `url` for `start`. It launches the existing comment, merge, and CI
scripts with argument vectors, reports results as follow-up messages, resumes
exit-3 timeouts using their cursors, and continues comment monitoring after new
activity. GitHub content is explicitly labelled untrusted.

At most four PRs can be watched at once. Output is bounded to the latest 64 KiB,
and an outer 11-minute watchdog stops a stuck batch. Merge/closed results stop
sibling watchers. `/fin-2x watch-stop [PR-URL]` stops one PR or all watchers.
Shutdown, reload, new/resumed/forked sessions, and `/tree` stop the process groups;
restart monitoring explicitly in the new context. Nothing runs in the factory
or merely because the package is installed. `gh`, bash, Python 3, and `jq` must
be available; watchers never create, edit, or merge a PR.

If `gh pr create --repo OWNER/REPO` hits a parent-fork SSO lookup error, use
`gh api --method POST repos/OWNER/REPO/pulls` with explicit `base`, `head`, `title`,
and `body` fields. Do not solve that error by targeting upstream.

### Disable executable integrations

Use `pi config` to disable the extension while keeping skills, or filter it in
settings:

```json
{"packages": [{"source": "git:github.com/MrDHat/2x-skills", "extensions": []}]}
```

Without the extension, invoke skills manually and monitoring is unavailable.
Shared skills contain their own path/attribution guidance; Claude-specific tool
names elsewhere should be interpreted using the compatibility table above.

## Checks

Run `npm ci --ignore-scripts`, `npm test`, and `npm run typecheck` (Python 3 and
Node 22.18+ required). Tests cover packaging, ancestor-linked session parsing,
permission precedence, hook opt-outs and lifecycle, and mock watcher processes.
A no-model RPC smoke test loads the actual package using isolated temporary Pi
settings and checks all ten skills plus the extension command. It does not alter
your normal Pi settings or call a model. Live authenticated asset uploads and
long-running GitHub watcher activity are not exercised by these tests.
