---
name: permissions-analyzer
description: Review the optional Fin 2x Pi bash approval policy using GREEN/YELLOW/RED safety tiers. Use to audit exact auto-allowed commands or reduce repeated approval prompts without changing Claude settings.
---

# Pi Permission Policy Review

Pi has no built-in Claude permission allowlist or fewer-permission-prompts command.
This skill reviews the optional Fin 2x extension's bash-only approval policy,
not a sandbox. Other tools/extensions, user shell commands, and external processes
are outside that gate. Do not imply it is a complete security boundary.

Read `<agent-dir>/fin-2x/permissions.json`; `<agent-dir>` is
PI_CODING_AGENT_DIR or ~/.pi/agent. Missing policy means disabled. The schema is:

```json
{"enabled": false, "allow": ["git status --short"]}
```

Only exact commands classified GREEN by the extension can bypass confirmation.
The conservative GREEN set is `pwd`, `git status` (with --short, --branch, or
--porcelain), and `git diff --stat`/`git diff --name-only`. Shell syntax,
interpreters, package managers, network/privileged/destructive commands are RED.
Everything else is YELLOW/unknown and still requires per-call approval, even if
listed in `allow`. The gate asks permission rather than automatically refusing
RED: RED means never auto-allow, not never run an approved development command.
Invalid policy JSON blocks bash rather than silently disabling the gate.

Use `/fin-2x permissions status` to inspect state, and `/fin-2x permissions on`
to opt into the gate (UI confirmation required). It is disabled by default.
For `enable`/`disable` suggestion arguments, use `/fin-2x permissions-tips on|off`;
turning tips off does not disable the approval gate.

Review each allow entry against the shared safety rationale at
`plugins/claude-code-tools/skills/permissions-analyzer/references/safety-tiers.md`
(relative to the package root). Do not broaden a command into a prefix/glob rule.
Propose removing RED, YELLOW, duplicates, and ineffective patterns. Show the exact
diff and ask for explicit approval before any write. Preserve the enabled state
unless the user asks to change it. With no approval, provide a read-only report.
Never write ~/.claude/settings.json or install another permission extension.
