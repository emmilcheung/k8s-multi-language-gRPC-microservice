#!/bin/sh
set -eu

KONG_URL="${KONG_URL:-http://kong:8000}"
GRAPHQL_URL="${KONG_URL}/graphql"
SIGNUP_URL="${KONG_URL}/api/users/signup"
CREATE_TICKET_URL="${KONG_URL}/api/tickets"
SEED_PASSWORD="${SEED_PASSWORD:-Password123!}"

seed_email="seed-$(date +%s)-$$@example.com"
signup_headers="$(mktemp)"
signup_body="$(mktemp)"
create_body="$(mktemp)"
trap 'rm -f "${signup_headers}" "${signup_body}" "${create_body}"' EXIT

signup_status="$(curl -sS -o "${signup_body}" -D "${signup_headers}" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${seed_email}\",\"password\":\"${SEED_PASSWORD}\"}" \
  "${SIGNUP_URL}")"

if [ "${signup_status}" -ne 201 ] && [ "${signup_status}" -ne 200 ]; then
  echo "seed: signup failed with status ${signup_status}"
  cat "${signup_body}"
  exit 1
fi

token_cookie="$(tr -d '\r' < "${signup_headers}" | awk 'tolower($1) == "set-cookie:" && $2 ~ /^token=/ { value=$2; sub(/^token=/, "", value); sub(/;.*$/, "", value); print value; exit }')"
if [ -z "${token_cookie}" ]; then
  echo "seed: token cookie missing from signup response"
  cat "${signup_headers}"
  exit 1
fi

create_status="$(curl -sS -o "${create_body}" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H "Cookie: token=${token_cookie}" \
  -d '{"title":"Deterministic Seed Ticket","price":"49.99","quota":200,"maxPerUser":4}' \
  "${CREATE_TICKET_URL}")"

if [ "${create_status}" -lt 200 ] || [ "${create_status}" -ge 300 ]; then
  echo "seed: ticket creation failed with status ${create_status}"
  cat "${create_body}"
  exit 1
fi

has_ticket_edges() {
  response="$(curl -sS \
    -H 'Content-Type: application/json' \
    -H "Cookie: token=${token_cookie}" \
    -d '{"query":"query SeedProbe { ticketsConnection(first: 5) { edges { node { id } } } }"}' \
    "${GRAPHQL_URL}")"
  echo "${response}" | grep -Fq '"edges":[{' || echo "${response}" | grep -Fq '"edges": [{'
}

i=0
while [ "${i}" -lt 30 ]; do
  if has_ticket_edges; then
    echo "seed: ticketsConnection probe succeeded"
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

echo "seed: ticketsConnection still empty after seeding"
exit 1
