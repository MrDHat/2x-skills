#!/bin/bash
# pr-check-watcher.sh - ETag-based fast polling for GitHub PR checks
#
# Uses conditional HTTP requests (If-None-Match) to poll every 3 seconds
# with zero rate-limit cost for unchanged responses. Only 200 responses
# (where something actually changed) count against the API quota.
#
# Polls BOTH the check-runs API (GitHub Actions, etc.) and the commit
# statuses API (Buildkite, Jenkins, etc.) to match `gh pr checks` semantics.
#
# This is the generic CI-green watcher (any PR, any CI, fastest polling).
# Buildkite and Jenkins above are just examples of commit-status-based CI —
# any provider that posts to the commit statuses or check-runs API works.
#
# Usage:
#   pr-check-watcher.sh <pr-url> [last-etags]
#
# Arguments:
#   pr-url      - Full GitHub PR URL (e.g., https://github.com/org/repo/pull/123)
#   last-etags  - Optional ETags from a previous run to resume polling
#                 (format: <check-runs-etag>|||<statuses-etag>)
#
# Exit codes:
#   0 - All checks completed successfully
#   1 - One or more checks failed
#   2 - Error (invalid args, API failure)
#   3 - Timed out, caller should re-run with the RESUME_ETAGS printed on last line

set -euo pipefail

pr_url="${1:-}"
resume_etags="${2:-}"

if [[ -z "$pr_url" ]]; then
    echo "Usage: pr-check-watcher.sh <pr-url> [last-etags]" >&2
    exit 2
fi

# Extract owner/repo/pr_number from URL
if [[ "$pr_url" =~ github\.com/([^/]+)/([^/]+)/pull/([0-9]+) ]]; then
    owner="${BASH_REMATCH[1]}"
    repo="${BASH_REMATCH[2]}"
    pr_number="${BASH_REMATCH[3]}"
else
    echo "Error: Invalid PR URL: $pr_url" >&2
    exit 2
fi

# Get the HEAD commit SHA for the PR
head_sha=$(gh api "repos/$owner/$repo/pulls/$pr_number" --jq '.head.sha' 2>/dev/null)
if [[ -z "$head_sha" ]]; then
    echo "Error: Could not get HEAD SHA for PR #$pr_number" >&2
    exit 2
fi

echo "Monitoring checks for PR #$pr_number (commit ${head_sha:0:7})..."

# Parse resume ETags (format: <check-runs-etag>|||<statuses-etag>)
runs_etag=""
status_etag=""
if [[ -n "$resume_etags" ]]; then
    runs_etag="${resume_etags%%|||*}"
    status_etag="${resume_etags#*|||}"
    # If no ||| separator was present, status_etag equals the full string — clear it
    if [[ "$status_etag" == "$resume_etags" ]]; then
        status_etag=""
    fi
fi

last_summary=""
last_runs_body=""
last_status_body=""
poll_interval="${WATCH_INTERVAL:-3}"
max_wait="${WATCH_MAX_WAIT:-570}"  # bounded window, overridable for tests
start_time=$(date +%s)

# Helper: fetch an API endpoint with optional ETag, sets $fetch_code, $fetch_etag, $fetch_body
fetch_with_etag() {
    local endpoint="$1"
    local etag="$2"
    local response

    if [[ -n "$etag" ]]; then
        response=$(gh api "$endpoint" -i -H "If-None-Match: $etag" 2>&1) || true
    else
        response=$(gh api "$endpoint" -i 2>&1) || true
    fi

    fetch_code=$(echo "$response" | head -1 | grep -oE '[0-9]{3}' | head -1 || true)
    fetch_etag=$(echo "$response" | grep -i '^etag:' | sed 's/^[Ee][Tt][Aa][Gg]: *//' | tr -d '\r' || true)
    fetch_body=$(echo "$response" | sed '1,/^\r*$/d')
    # Conditional requests are only valid for a single page. For larger lists,
    # refetch all pages and clear the ETag so changes beyond page one are seen.
    if [[ "$fetch_code" == "200" ]] && echo "$fetch_body" | jq -e '.total_count > ((.check_runs // .statuses // []) | length)' >/dev/null 2>&1; then
        fetch_body=$(gh api --paginate --slurp "$endpoint" | jq -c '
          if .[0] | has("check_runs") then
            {total_count: .[0].total_count, check_runs: [.[].check_runs[]]}
          else
            {total_count: .[0].total_count, statuses: [.[].statuses[]]}
          end') || { echo "Error: could not read all check/status pages" >&2; exit 2; }
        fetch_etag=""
    fi
}

while true; do
    elapsed=$(( $(date +%s) - start_time ))
    if (( elapsed > max_wait )); then
        echo ""
        echo "Polling window expired after $(( max_wait / 60 )) minutes. Checks still running."
        echo "Last status: $last_summary"
        echo "RESUME_ETAGS=${runs_etag}|||${status_etag}"
        exit 3
    fi

    # A new push must invalidate both caches; never report checks for an old head.
    current_sha=$(gh api "repos/$owner/$repo/pulls/$pr_number" --jq '.head.sha' 2>/dev/null) || {
        echo "Error: could not refresh PR head" >&2
        exit 2
    }
    if [[ -z "$current_sha" ]]; then
        echo "Error: empty PR head" >&2
        exit 2
    fi
    if [[ "$current_sha" != "$head_sha" ]]; then
        head_sha="$current_sha"
        runs_etag=""
        status_etag=""
        last_runs_body=""
        last_status_body=""
        echo "New PR head ${head_sha:0:7}; restarting check monitoring."
    fi

    runs_changed=false
    status_changed=false
    round_ok=true

    # A resumed process has ETags but no cached response bodies. Fetch each
    # endpoint unconditionally once, then use ETags within this window.
    [[ -z "$last_runs_body" ]] && runs_etag=""
    [[ -z "$last_status_body" ]] && status_etag=""

    # Poll check-runs API
    fetch_with_etag "repos/$owner/$repo/commits/$head_sha/check-runs?per_page=100" "$runs_etag"
    if [[ "$fetch_code" == "200" ]]; then
        runs_etag="$fetch_etag"
        last_runs_body="$fetch_body"
        runs_changed=true
    elif [[ "$fetch_code" != "304" ]]; then
        echo "Warning: check-runs returned HTTP $fetch_code, retrying..." >&2
        round_ok=false
    fi

    # Poll commit statuses API
    fetch_with_etag "repos/$owner/$repo/commits/$head_sha/status?per_page=100" "$status_etag"
    if [[ "$fetch_code" == "200" ]]; then
        status_etag="$fetch_etag"
        last_status_body="$fetch_body"
        status_changed=true
    elif [[ "$fetch_code" != "304" ]]; then
        echo "Warning: statuses returned HTTP $fetch_code, retrying..." >&2
        round_ok=false
    fi

    # Never interpret absent data from a failed endpoint as green.
    if [[ "$round_ok" == "false" || -z "$last_runs_body" || -z "$last_status_body" ]]; then
        sleep "$poll_interval"
        continue
    fi

    # If neither changed, skip processing
    if [[ "$runs_changed" == "false" && "$status_changed" == "false" ]]; then
        sleep "$poll_interval"
        continue
    fi

    # Count check runs
    runs_total=$(echo "$last_runs_body" | jq '.total_count // 0')
    runs_completed=$(echo "$last_runs_body" | jq '[.check_runs[] | select(.status == "completed")] | length')
    runs_in_progress=$(echo "$last_runs_body" | jq '[.check_runs[] | select(.status == "in_progress")] | length')
    runs_queued=$(echo "$last_runs_body" | jq '[.check_runs[] | select(.status == "queued")] | length')
    runs_success=$(echo "$last_runs_body" | jq '[.check_runs[] | select(.conclusion == "success" or .conclusion == "skipped" or .conclusion == "neutral")] | length')
    runs_failure=$(echo "$last_runs_body" | jq '[.check_runs[] | select(.status == "completed" and (.conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral"))] | length')

    # Count commit statuses (from combined status endpoint, already deduplicated)
    statuses_total=$(echo "$last_status_body" | jq '[.statuses // [] | .[]] | length')
    statuses_success=$(echo "$last_status_body" | jq '[.statuses // [] | .[] | select(.state == "success")] | length')
    statuses_failure=$(echo "$last_status_body" | jq '[.statuses // [] | .[] | select(.state == "failure" or .state == "error")] | length')
    statuses_pending=$(echo "$last_status_body" | jq '[.statuses // [] | .[] | select(.state == "pending")] | length')
    statuses_completed=$(( statuses_success + statuses_failure ))

    # Merge totals
    total=$(( runs_total + statuses_total ))
    completed=$(( runs_completed + statuses_completed ))
    in_progress=$(( runs_in_progress + statuses_pending ))
    queued=$runs_queued
    success=$(( runs_success + statuses_success ))
    failure=$(( runs_failure + statuses_failure ))

    if (( total == 0 )); then
        if [[ "no_checks" != "$last_summary" ]]; then
            echo "No checks found yet, waiting..."
            last_summary="no_checks"
        fi
        sleep "$poll_interval"
        continue
    fi

    # Build summary string for change detection
    summary="total=$total completed=$completed in_progress=$in_progress queued=$queued success=$success failure=$failure"

    # Only print when something changes
    if [[ "$summary" != "$last_summary" ]]; then
        echo "[$((elapsed))s] $completed/$total complete ($success passed, $failure failed, $in_progress pending, $queued queued)"
        last_summary="$summary"
    fi

    # Check terminal conditions
    if (( completed == total && total > 0 )); then
        # Close the push-during-poll race before emitting a terminal result.
        terminal_sha=$(gh api "repos/$owner/$repo/pulls/$pr_number" --jq '.head.sha' 2>/dev/null) || exit 2
        [[ "$terminal_sha" != "$head_sha" ]] && continue
        if (( failure > 0 )); then
            echo ""
            echo "FAILED checks:"
            # Failed check runs
            echo "$last_runs_body" | jq -r '.check_runs[] | select(.status == "completed" and (.conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral")) | "  - \(.name): \(.conclusion) (\(.html_url))"'
            # Failed commit statuses
            echo "$last_status_body" | jq -r '.statuses // [] | .[] | select(.state == "failure" or .state == "error") | "  - \(.context): \(.state) (\(.target_url))"'
            exit 1
        else
            echo ""
            echo "All $total checks completed successfully."
            exit 0
        fi
    fi

    sleep "$poll_interval"
done
