#!/usr/bin/env bash
# Fail if console.{error,warn,log} interpolates a known-PII identifier.
#
# This is what would have caught the May 2026 audit findings H1
# (normalizedEmail) and H2 (staff_name) at PR time. It is grep-based on
# purpose — a curated, short deny-list is more honest than a clever AST
# rule that hides its own gaps.
#
# Add new field names to DENY as new PII columns are introduced
# (emergency_contact_name, etc.). False positives here cost real time,
# so keep the list narrow.

set -euo pipefail

DENY='email|staff_name|first_name|last_name|full_name|phone|password|secret|api[_-]?key|cardNumber|cvv'

# Run grep. Exit code 1 (no matches) is fine; we only want to fail on
# 0 (matches) or 2+ (grep itself errored). The default `|| true` trick
# hides real grep errors, which is exactly how a portability bug in the
# regex would slip into CI silently.
set +e
hits=$(grep -rEn \
  "console\.(error|warn|log)\s*\([^)]*\\\$\{(${DENY})" \
  src cua-service/src \
  --include='*.ts' --include='*.tsx' \
  --exclude-dir=__tests__ \
  --exclude-dir=node_modules \
  --exclude-dir=.next)
grep_rc=$?
set -e

if [[ $grep_rc -ge 2 ]]; then
  echo "ERROR: grep failed with exit code $grep_rc (regex or env problem in this script)." >&2
  exit 1
fi

# `phone_lookup` is a redacted-on-write lookup column, not the phone
# itself. Filter false positives out of the hit list. Same idea for
# `phone164` references inside redacted-then-logged paths is rare enough
# that we don't bother — if it ever fires, the redact* helper is the fix.
if [[ -n "$hits" ]]; then
  hits=$(printf '%s\n' "$hits" | grep -vE '\$\{phone_lookup' || true)
fi

if [[ -n "$hits" ]]; then
  echo "ERROR: PII identifier interpolated into console.* call." >&2
  echo "Use log.* with structured fields, or a redact* helper from src/lib/api-validate.ts." >&2
  echo "" >&2
  echo "$hits" >&2
  exit 1
fi

echo "[check-no-pii-logs] clean."
