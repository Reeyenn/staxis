#!/usr/bin/env bash
# Claude Code Stop hook → /api/claude-heartbeat (event=stop)
#
# Fires when Claude finishes responding to the user (end of one turn).
# Posts a "session ended" event so the admin System tab's WORKING badge
# disappears immediately instead of waiting for the heartbeat freshness
# window to expire.
#
# Wired up in .claude/settings.json alongside the PostToolUse hook.

set -e

INPUT="$(cat)"

command -v jq >/dev/null 2>&1 || exit 0

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

PAYLOAD=$(jq -nc --arg s "$SESSION_ID" '{sessionId: $s, event: "stop"}')

(
  curl -s -m 3 -o /dev/null \
    -X POST -H 'Content-Type: application/json' \
    -d "$PAYLOAD" \
    "https://hotelops-ai.vercel.app/api/claude-heartbeat" \
    >/dev/null 2>&1 || true
) &

exit 0
