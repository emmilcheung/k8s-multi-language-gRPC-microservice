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

# Seed additional varied tickets for browse-page search/filter demonstration
while IFS= read -r ticket_json; do
  [ -z "${ticket_json}" ] && continue
  extra_status="$(curl -sS -o "${create_body}" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -H "Cookie: token=${token_cookie}" \
    -d "${ticket_json}" \
    "${CREATE_TICKET_URL}")" || true
  if [ "${extra_status}" -lt 200 ] || [ "${extra_status}" -ge 300 ]; then
    echo "seed: extra ticket creation failed with status ${extra_status}" || true
  fi
done <<'TICKETS'
{"title":"Phoenix · Alpha Zulu Tour","price":"78.00","quota":150,"maxPerUser":4,"category":"CONCERT","event":{"title":"Alpha Zulu Tour","startsAt":"2026-06-15T19:00:00Z","venueName":"The Greek Theatre"}}
{"title":"Warriors vs Lakers","price":"120.00","quota":150,"maxPerUser":4,"category":"SPORTS","event":{"title":"Warriors vs Lakers","startsAt":"2026-06-10T20:00:00Z","venueName":"Chase Center"}}
{"title":"John Mulaney Live","price":"45.00","quota":150,"maxPerUser":4,"category":"COMEDY","event":{"title":"John Mulaney Live","startsAt":"2026-06-08T21:00:00Z","venueName":"The Paramount"}}
{"title":"Hamilton","price":"199.00","quota":150,"maxPerUser":4,"category":"THEATRE","event":{"title":"Hamilton","startsAt":"2026-07-20T19:30:00Z","venueName":"Orpheum Theatre"}}
{"title":"Outside Lands Festival","price":"330.00","quota":150,"maxPerUser":4,"category":"FESTIVAL","event":{"title":"Outside Lands Festival","startsAt":"2026-08-09T12:00:00Z","venueName":"Golden Gate Park"}}
{"title":"Tame Impala","price":"22.00","quota":150,"maxPerUser":4,"category":"CONCERT","event":{"title":"Tame Impala","startsAt":"2026-06-05T20:00:00Z","venueName":"Bill Graham Civic"}}
{"title":"Comedy Open Mic","price":"15.00","quota":150,"maxPerUser":4,"category":"COMEDY","event":{"title":"Comedy Open Mic","startsAt":"2026-06-03T20:30:00Z","venueName":"Cobb's"}}
TICKETS

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
