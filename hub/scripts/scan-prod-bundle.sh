#!/usr/bin/env bash
# scan-prod-bundle.sh — CI gate: FAIL the build if a real secret or the dev sign-in switcher /
# synthetic test credentials leak into the production bundle. Run AFTER `vite build` (which must be
# a prod build: VITE_ALLOW_DEV_SIGNIN unset, so DevSignIn + DEV_ACCOUNTS + the shared password
# tree-shake out). Non-vacuous: the same patterns DO appear when VITE_ALLOW_DEV_SIGNIN=true.
#
# Usage (CI):  npm --prefix hub run build && bash hub/scripts/scan-prod-bundle.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="${1:-$ROOT/dist}"        # vite.config.ts → build.outDir = ../dist (repo root)

if [ ! -d "$DIST" ]; then echo "FAIL: dist not found at $DIST — build first"; exit 2; fi
if ! ls "$DIST"/assets/*.js >/dev/null 2>&1; then echo "FAIL: no JS in $DIST/assets — build did not produce a bundle"; exit 2; fi

# Forbidden in a prod bundle: dev switcher + synthetic creds, and any real secret.
FORBIDDEN=(
  'localtest123'                 # the dev switcher shared password
  'local.test'                   # synthetic account emails (seth@/brielle@/rose@/newcomer@local.test)
  'DEV_ACCOUNTS'
  'service_role'                 # a service-role key must NEVER reach the client
  'SUPABASE_SERVICE_ROLE'
  'sk_live_'                     # Stripe LIVE secret
  'sk_test_'                     # Stripe test secret
  'STRIPE_SECRET'
  'STRIPE_WEBHOOK_SECRET'
  'MAINTENANCE_SECRET'
)

fail=0
for pat in "${FORBIDDEN[@]}"; do
  if grep -rslF "$pat" "$DIST" >/dev/null 2>&1; then
    echo "FAIL: forbidden pattern in prod bundle: '$pat'  ->  $(grep -rslF "$pat" "$DIST" | tr '\n' ' ')"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "PROD BUNDLE SCAN: FAILED — a secret or the dev switcher leaked. Do not deploy."
  exit 1
fi
echo "PROD BUNDLE SCAN: CLEAN — no secrets, no dev switcher, no synthetic credentials in $DIST."
