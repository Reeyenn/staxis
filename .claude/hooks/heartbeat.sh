#!/usr/bin/env bash
# Claude Code PostToolUse hook → /api/claude-heartbeat
#
# Fires after every tool call so the Staxis admin System tab can render
# "session N is active right now on branch X". Runs in the background
# so it never adds latency to a tool call.
#
# Wired up in .claude/settings.json. Anyone who opens Claude Code in
# this repo will automatically start emitting heartbeats — no env
# vars or per-machine setup needed.

set -e

# Hook payload arrives on stdin as JSON.
INPUT="$(cat)"

# Best-effort parse with jq; if jq isn't installed, exit silently.
command -v jq >/dev/null 2>&1 || exit 0

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)

[ -z "$SESSION_ID" ] && exit 0

BRANCH=""
if [ -n "$CWD" ] && [ -d "$CWD/.git" ] || git -C "${CWD:-$PWD}" rev-parse --git-dir >/dev/null 2>&1; then
  BRANCH=$(git -C "${CWD:-$PWD}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
fi

# Build payload safely (jq -n produces valid JSON even if values contain
# quotes / unicode).
PAYLOAD=$(jq -nc --arg s "$SESSION_ID" --arg b "$BRANCH" --arg t "$TOOL" --arg c "$CWD" \
  '{sessionId: $s, branch: $b, tool: $t, cwd: $c}')

# Fire and forget. Short timeout so a slow network never blocks the
# next tool call. Output discarded.
(
  curl -s -m 3 -o /dev/null \
    -X POST -H 'Content-Type: application/json' \
    -d "$PAYLOAD" \
    "https://hotelops-ai.vercel.app/api/claude-heartbeat" \
    >/dev/null 2>&1 || true
) &

# Always exit 0 so the hook never blocks Claude's tool call from completing.
exit 0
