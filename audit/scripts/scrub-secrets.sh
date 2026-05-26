#!/usr/bin/env bash
set -euo pipefail

# Redact common secret-bearing key/value patterns from logs before persistence.
sed -E '
  s/((STRIPE_SECRET(_KEY)?|DATABASE_URL|X_USER_ID_SIGNING_KEY|QR_SIGNING_KEY|JWT_SECRET|RSA_PRIVATE_KEY|REFRESH_TOKEN[^ =:]*)[[:space:]]*[:=][[:space:]]*)[^[:space:]'"'"'"]+/\1[REDACTED]/gI
'
