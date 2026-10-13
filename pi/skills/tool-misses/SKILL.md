---
name: tool-misses
description: Scan recent Pi sessions for missing CLI tools and BSD/GNU incompatibilities, then propose installation and AGENTS.md guidance. Use when the user invokes tool-misses or asks about repeated shell tool failures in Pi.
disable-model-invocation: true
---

# Pi Tool Misses

This is the Pi-native version, not a scanner of Claude transcripts. Resolve
`<package-dir>` to three directories above this SKILL.md's parent directory.
Substitute its absolute path in commands. Do not use CLAUDE_PLUGIN_ROOT.

For `scan` (the default), run:

```bash
python3 "<package-dir>/pi/scripts/sessions.py" misses --days 14
```

Use `--root <session-directory>` when the user supplies a custom session location.
The default honors PI_CODING_AGENT_SESSION_DIR and PI_CODING_AGENT_DIR. The script
cannot infer a CLI `--session-dir` or project `sessionDir`; ask if no files are found
or the root differs from the current session. Report the root and scan counts.
Only failed ancestor-linked bash calls count; successful output quoting an error
does not. An empty result is not evidence all tools exist.

For each result, check current availability (`command -v <tool>`). Separate still
missing, installed but undocumented, and resolved tools. Read the shared database
at `plugins/claude-code-tools/skills/tool-misses/references/tool-database.md` if
needed. On macOS propose known Homebrew formulae; elsewhere detect the OS/package
manager and propose its equivalent, never assume Homebrew or invent a formula.

Show install commands and proposed guidance. Ask for explicit user approval
before installing anything or editing `<agent-dir>/AGENTS.md`; preserve existing
content. Guidance should name GNU-prefixed tools rather than replacing system
binaries. Never change Claude settings or CLAUDE.md as part of this Pi workflow.
User-dismissed tools go into `<agent-dir>/fin-2x/tool-misses-ignored.json` as
`{"ignored": ["tool"]}` after confirmation. Merge, do not overwrite other dismissals.

For `on`, `off`, or `status`, ask the user to run `/fin-2x tool-misses <action>`.
That extension command controls suggestions; it never installs tools. Without
the extension, report that suggestions are unavailable rather than touching
Claude's marker files. Do not auto-run this scan after a suggestion.
