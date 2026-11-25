#!/bin/bash
# watch-pr-comments.sh - blocking watcher for NEW PR or issue activity
#
# Blocks until a NEW comment, review, or inline review comment lands on the PR
# (or a new comment lands on the issue), then prints only the new items plus a
# resumable cursor. Replaces repeated `gh pr view --json comments,reviews` or
# `gh issue view --json comments` full-payload polling.
#
# Accepts a PR URL (.../pull/N) or an issue URL (.../issues/N). Reviews and
# inline review comments are PR-only; in issue mode only the issue's comment
# thread is watched (the pulls/* endpoints 404 for a plain issue).
#
# Usage:
#   watch-pr-comments.sh <pr-or-issue-url> [since-iso8601]
#
# Env overrides:
#   WATCH_INTERVAL - poll interval seconds (default 20)
#   WATCH_MAX_WAIT - max wait seconds (default 570)
#   WATCH_SETTLE   - after the first new item, wait this long and poll once
#                    more so a review and its inline comments arrive together
#                    (default 30; 0 disables)
#
# Exit codes:
#   0 - new activity found; prints items then NEXT_SINCE=<cursor for next run>
#   2 - usage or API error
#   3 - timed out with no new activity; NEXT_SINCE=<cursor> unchanged
#
# NEXT_SINCE is the poll-round START time, not the newest item timestamp — an
# item landing on an already-polled endpoint mid-round is re-served on the
# next run instead of being skipped. Cross-run duplicates are possible and
# benign; silently losing feedback is not.

set -euo pipefail

pr_url="${1:-}"
since="${2:-}"

if [[ -z "$pr_url" ]]; then
    echo "Usage: watch-pr-comments.sh <pr-or-issue-url> [since-iso8601]" >&2
    exit 2
fi

if [[ "$pr_url" =~ github\.com/([^/]+)/([^/]+)/(pull|issues)/([0-9]+) ]]; then
    owner="${BASH_REMATCH[1]}"
    repo="${BASH_REMATCH[2]}"
    pr_number="${BASH_REMATCH[4]}"
    [[ "${BASH_REMATCH[3]}" == "pull" ]] && is_pr=true || is_pr=false
else
    echo "Error: Invalid PR or issue URL: $pr_url" >&2
    exit 2
fi

if [[ -n "$since" ]]; then
    cursor="$since"
else
    # Same 1s back-off as NEXT_SINCE (see the round cursor below): an item
    # landing in the startup second would otherwise sit exactly on the
    # whole-second boundary and be skipped by after-cursor filtering.
    startup_epoch=$(( $(date +%s) - 1 ))
    cursor=$(date -u -r "$startup_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
        || date -u -d "@$startup_epoch" +%Y-%m-%dT%H:%M:%SZ)
fi
poll_interval="${WATCH_INTERVAL:-20}"
max_wait="${WATCH_MAX_WAIT:-570}"
start_time=$(date +%s)

comments_etag=""
review_comments_etag=""

seen_ids_file=$(mktemp)
trap 'rm -f "$seen_ids_file"' EXIT

found_new=false

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

    # `|| true` keeps set -e/pipefail from killing the script when a failed
    # gh call has no status line or etag header — the non-200/304 check below
    # must see the empty value and report the error instead.
    fetch_code=$(echo "$response" | head -1 | grep -oE '[0-9]{3}' | head -1 || true)
    fetch_etag=$(echo "$response" | grep -i '^etag:' | sed 's/^[Ee][Tt][Aa][Gg]: *//' | tr -d '\r' || true)
    fetch_body=$(echo "$response" | sed '1,/^\r*$/d')

    if [[ "$fetch_code" != "200" && "$fetch_code" != "304" ]]; then
        echo "Error: gh api $endpoint failed: $response" >&2
        exit 2
    fi
}

# GitHub list endpoints cap at one page per request — after a full (100-item)
# first page, keep appending pages until a short one. Sets $all_body; "" on 304.
read_endpoint() {
    local endpoint="$1" etag="$2" page=2 body count
    all_body=""
    fetch_with_etag "$endpoint" "$etag"
    [[ "$fetch_code" == "304" ]] && return 0

    all_body="$fetch_body"
    count=$(jq 'length' <<<"$all_body" 2>/dev/null || echo 0)
    while (( ${count:-0} == 100 )); do
        body=$(gh api "${endpoint}&page=${page}" 2>&1) || {
            echo "Error: gh api ${endpoint}&page=${page} failed: $body" >&2
            exit 2
        }
        # Merge via stdin, not --argjson — a full page of large comment
        # bodies can exceed the OS argv size limit.
        all_body=$(printf '%s\n%s\n' "$all_body" "$body" | jq -c -s '.[0] + .[1]' 2>/dev/null) || {
            echo "Error: unexpected JSON from ${endpoint}&page=${page}" >&2
            exit 2
        }
        count=$(jq 'length' <<<"$body" 2>/dev/null || echo 0)
        page=$((page + 1))
    done
}

# `since=` is re-sent unchanged on every poll of this run, so a fresh 200 can
# re-include items already printed by an earlier poll — de-dupe by id.
already_seen() {
    local key="$1"
    if grep -qxF "$key" "$seen_ids_file" 2>/dev/null; then
        return 0
    fi
    echo "$key" >> "$seen_ids_file"
    return 1
}

# Prints newly-seen rows (id, author, timestamp, state-or-empty, location,
# body) and tracks found_new as a global. Rows are US-delimited (\x1f): a
# non-whitespace IFS preserves empty fields, where consecutive tabs would
# collapse and shift the body into the state column.
emit_rows() {
    local prefix="$1" rows="$2"
    [[ -z "$rows" ]] && return 0
    while IFS=$'\x1f' read -r id author ts state loc body; do
        [[ -z "$id" ]] && continue
        if already_seen "$prefix-$id"; then
            continue
        fi
        if [[ "$prefix" == "review" ]]; then
            echo "review($state) $author $ts: $body"
        elif [[ -n "$loc" ]]; then
            echo "$prefix $author $ts $loc: $body"
        else
            echo "$prefix $author $ts: $body"
        fi
        found_new=true
    done <<< "$rows"
}

# Every printed line lands in the agent's context, so bodies are cut down to
# what a reader needs. HTML comments, images and tags go; collapsed <details>
# sections (bots park proposed diffs, nitpicks and "prompt for AI agents"
# blocks there) are dropped and replaced by the `gh api` call that reads the
# full body, so nothing is lost — the agent fetches it only when it acts.
#
# CodeRabbit gets two extra rules. Its walkthrough/summary comment (and the
# "review in progress" / rate-limit notices it rewrites in place) is skipped
# outright: it is edited several times per review, and each edit would wake
# the agent with nothing to act on. And a review whose body is empty after
# cleaning (GitHub's wrapper around a batch of inline comments) is skipped,
# since the inline comments themselves are reported.
#
# Comments use updated_at to match the `since` filter's semantics — an edited
# old comment is served with its edit time, so it's reported once instead of
# on every subsequent run.
jq_defs='
def strip_details:
  if test("<details[^>]*>(?:(?!<details)[\\s\\S])*?</details>")
  then gsub("<details[^>]*>(?:(?!<details)[\\s\\S])*?</details>"; " ") | strip_details
  else . end;
def is_coderabbit: (.user.login // "") | startswith("coderabbitai");
def is_cr_notice: is_coderabbit and ((.body // "") | test("auto-generated comment: [^>]*by coderabbit\\.ai"));
def cleaned($fetch):
  (.body // "") as $raw
  | ($raw | test("<details")) as $collapsed
  | $raw
  | gsub("<!--[\\s\\S]*?-->"; "")
  | strip_details
  | gsub("<picture>[\\s\\S]*?</picture>"; "")
  | gsub("!\\[[^\\]]*\\]\\([^)]*\\)"; "")
  | gsub("<[^>]+>"; "")
  | gsub("[\r\n\t\u001f]+"; " ")
  | gsub("  +"; " ")
  | sub("^ +"; "") | sub(" +$"; "")
  | (if length > 1500 then .[0:1500] + "…(truncated)" else . end)
  | . as $b
  | if $collapsed and ($b | length) > 0 then $b + " [collapsed sections omitted; full text: gh api " + $fetch + " --jq .body]"
    elif $collapsed then "[body is all collapsed sections; full text: gh api " + $fetch + " --jq .body]"
    else $b end;
'
issue_comment_rows_jq="$jq_defs"'.[] | select(is_cr_notice | not)
  | [(.id|tostring), .user.login, (.updated_at // .created_at), "", "",
     cleaned("repos/'"$owner/$repo"'/issues/comments/\(.id)")] | join("\u001f")'
review_rows_jq="$jq_defs"'.[] | select(.submitted_at != null and .submitted_at > $cursor)
  | . as $r | ($r | cleaned("repos/'"$owner/$repo/pulls/$pr_number"'/reviews/\($r.id)")) as $body
  | select(($r.state != "COMMENTED") or ($body | length) > 0)
  | [($r.id|tostring), $r.user.login, $r.submitted_at, $r.state, "", $body] | join("\u001f")'
review_comment_rows_jq="$jq_defs"'.[]
  | [(.id|tostring), .user.login, (.updated_at // .created_at), "",
     ((.path // "") + (if (.line // .original_line) then ":" + ((.line // .original_line)|tostring) else "" end)),
     cleaned("repos/'"$owner/$repo"'/pulls/comments/\(.id)")] | join("\u001f")'

# A reviewer (human or bot) usually posts a review and its inline comments a
# few seconds apart. After the first new item, wait one settle period and poll
# once more so the whole batch arrives in one wake-up instead of several.
settle="${WATCH_SETTLE:-30}"
settled=false

while true; do
    # Back-date the round cursor by one second: timestamps are whole-second,
    # so an item landing in the same second as the cursor would otherwise sit
    # exactly ON the boundary and be skipped by the next run's after-cursor
    # filtering. The overlap can re-serve a boundary item (dup-over-loss).
    round_start_epoch=$(( $(date +%s) - 1 ))
    round_start=$(date -u -r "$round_start_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
        || date -u -d "@$round_start_epoch" +%Y-%m-%dT%H:%M:%SZ)

    read_endpoint "repos/$owner/$repo/issues/$pr_number/comments?since=$cursor&per_page=100" "$comments_etag"
    if [[ -n "$all_body" ]]; then
        [[ -n "$fetch_etag" ]] && comments_etag="$fetch_etag"
        rows="$(jq -r "$issue_comment_rows_jq" <<<"$all_body" 2>/dev/null)" || rows=""
        emit_rows "comment" "$rows"
    fi

    # No since= support and ascending order on the reviews endpoint: a new
    # review appends past page 1, leaving page 1's ETag unchanged — so no
    # conditional requests here; fetch all pages and filter on submitted_at.
    # Reviews are PR-only — the pulls/* endpoint 404s for a plain issue.
    [[ "$is_pr" == true ]] && read_endpoint "repos/$owner/$repo/pulls/$pr_number/reviews?per_page=100" "" || all_body=""
    if [[ -n "$all_body" ]]; then
        rows="$(jq -r --arg cursor "$cursor" "$review_rows_jq" <<<"$all_body" 2>/dev/null)" || rows=""
        emit_rows "review" "$rows"
    fi

    # Inline review comments are PR-only too — skip in issue mode.
    [[ "$is_pr" == true ]] && read_endpoint "repos/$owner/$repo/pulls/$pr_number/comments?since=$cursor&per_page=100" "$review_comments_etag" || all_body=""
    if [[ -n "$all_body" ]]; then
        [[ -n "$fetch_etag" ]] && review_comments_etag="$fetch_etag"
        rows="$(jq -r "$review_comment_rows_jq" <<<"$all_body" 2>/dev/null)" || rows=""
        emit_rows "review-comment" "$rows"
    fi

    if [[ "$found_new" == "true" ]]; then
        if [[ "$settled" == "false" ]] && (( settle > 0 )); then
            settled=true
            sleep "$settle"
            continue
        fi
        echo "NEXT_SINCE=$round_start"
        exit 0
    fi

    # Deadline check runs AFTER each poll round, not before, so at least one
    # round always happens (even with WATCH_MAX_WAIT < WATCH_INTERVAL). When
    # the remaining window is shorter than a full interval, sleep just the
    # remainder and run one final round AT the deadline — activity landing
    # late in the window is still caught. Exit is ~max_wait + one round.
    elapsed=$(( $(date +%s) - start_time ))
    if (( elapsed >= max_wait )); then
        echo "Timed out after ${max_wait}s with no new PR activity."
        echo "NEXT_SINCE=$cursor"
        exit 3
    fi
    remaining=$(( max_wait - elapsed ))
    sleep $(( remaining < poll_interval ? remaining : poll_interval ))
done
