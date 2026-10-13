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

## Claude-specific workflows

Claude's permissions, session format, telemetry, memory layout, and hooks are not
Pi APIs. The Claude-specific skill directory is deliberately not in the Pi
manifest. Pi-native versions and extensions are added in the next layers of the
integration stack. Claude's hook shell scripts are not executed by Pi.

## Checks

Run `npm test` (Python 3 required). This validates packaging and portable script
paths without modifying your Pi configuration or calling a model.
