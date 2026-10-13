---
name: pi-cost-analysis
description: Analyze Pi token usage and recorded cost estimates from local session JSONL, including cache usage, summaries, and non-message usage. Use to break down Pi spending or compare model usage; not Claude OpenTelemetry billing.
---

# Pi Cost Analysis

Resolve `<package-dir>` to three directories above this SKILL.md's parent directory
and substitute its absolute path. Run the read-only report:

```bash
python3 "<package-dir>/pi/scripts/sessions.py" costs --days 14
```

Pass `--root <directory>` for a custom session location. Default storage honors
PI_CODING_AGENT_DIR and PI_CODING_AGENT_SESSION_DIR, not CLI/project overrides;
confirm the root when those overrides may be in use. Show date window, root,
files scanned, input/output tokens, cache reads/writes, and recorded USD by model.

The report covers all branches because abandoned work still costs money. Copied
fork entries are deduplicated by ID, timestamp, and usage. It includes assistant,
compaction, branch-summary, and standalone usage records (including cache warming).
Summary records without provider/model stay unattributed; do not assign them to
the last visible model. Missing cost fields mean unknown, not zero. Recorded
zeroes can mean unpriced/subscription usage, not a free provider. Session estimates
are not invoices and may omit usage from failed requests or third-party extensions.

For a one-session check use Pi's `/session`. Compare equivalent workloads and
windows before recommending model changes. Do not infer per-user/team spend from
one user's local history. No telemetry service or external upload is required;
never upload session content without explicit permission. Claude OTel analysis
remains available through the Claude plugin, not this Pi skill.
