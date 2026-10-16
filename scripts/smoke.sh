#!/usr/bin/env bash
# End-to-end smoke test against a running Compose stack (after the seed has finished).
# Checks replication and search, a live lead conversation through Temporal and the
# sandbox handset, the report validator, and that every dashboard page renders.
set -euo pipefail

API="${API:-http://localhost:${API_PORT:-4100}}"
WEB="${WEB:-http://localhost:${WEB_PORT:-3100}}"
OFFICE="${OFFICE:-tidewater}"
# A fresh fictional number per run, from an area code the seed never reaches.
HANDSET="${HANDSET:-+128955501$(printf %02d $((RANDOM % 100)))}"
jq() { command jq "$@" | tr -d '\r'; }  # jq on Windows prints CRLF
pass() { printf '  ok  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; exit 1; }
post() { curl -fsS -X POST -H 'content-type: application/json' "$@"; }

echo "api $API · web $WEB"
curl -fsS "$API/healthz" >/dev/null && pass "api healthy"
curl -fsS "$WEB/api/health" >/dev/null && pass "web healthy"

PLATFORM=$(post "$API/v1/auth/dev-token" -d '{"platform":true}' | jq -r .token)
PIPE=$(curl -fsS -H "authorization: Bearer $PLATFORM" "$API/v1/ops/pipeline")
ON_MARKET=$(echo "$PIPE" | jq .totals.on_market)
INDEXED=$(echo "$PIPE" | jq .totals.indexed)
[ "$ON_MARKET" -gt 39000 ] || fail "on-market listings $ON_MARKET"
[ $(( ON_MARKET - INDEXED )) -lt 200 ] && [ $(( INDEXED - ON_MARKET )) -lt 200 ] || fail "index $INDEXED vs on-market $ON_MARKET"
pass "replicated $ON_MARKET on-market listings, $INDEXED indexed"
echo "$PIPE" | jq -e '.markets[] | select(.code == "HMR") | .issues[] | select(.value == "Contingent")' >/dev/null && pass "unmapped HMR status logged for review"

SEARCH=$(post "$API/v1/t/$OFFICE/search" -d '{"q":"3 bed under 600k near the river with a yard","size":5}')
echo "$SEARCH" | jq -e '.filters.beds_min == 3 and .filters.price_max == 600000 and .filters.location.id == "ecm-ellery-river" and (.filters.features | index("large_yard")) != null and .interpretation.parser == "rules"' >/dev/null \
  || fail "natural-language parse: $(echo "$SEARCH" | jq -c .filters)"
echo "$SEARCH" | jq -e '.total > 0 and (.results | length) > 0' >/dev/null || fail "search returned no homes"
pass "NL search parsed by rules and returned $(echo "$SEARCH" | jq .total) homes"
FH=$(post "$API/v1/t/$OFFICE/search" -d '{"q":"safe neighborhood with good schools 3 bed"}')
echo "$FH" | jq -e '(.interpretation.notices | index("fair_housing")) != null and .filters.keywords == []' >/dev/null || fail "fair housing notice"
pass "steering terms never become filters"

LISTING=$(echo "$SEARCH" | jq -r '.results[0].id')
ENC=$(printf '%s' "$HANDSET" | jq -sRr @uri)
# Take the marker before the inquiry: the first text usually lands within a second.
START=$(curl -fsS "$API/sandbox/handsets/$ENC/messages" | jq 'map(.id) | max // 0')
LEAD=$(post "$API/v1/t/$OFFICE/leads" -d "{\"first_name\":\"Smoke\",\"phone\":\"$HANDSET\",\"listing_id\":\"$LISTING\",\"consent_sms\":true}")
echo "$LEAD" | jq -e '.texting == true' >/dev/null || fail "lead not texting: $LEAD"
wait_for() {
  local pattern="$1" after="$2"
  for _ in $(seq 1 40); do
    local body
    body=$(curl -fsS "$API/sandbox/handsets/$ENC/messages?after=$after" | jq -r '[.[] | select(.direction == "to_handset")] | last | .body // empty')
    if [ -n "$body" ] && echo "$body" | grep -Eq "$pattern"; then echo "$body"; return 0; fi
    sleep 0.5
  done
  return 1
}
FIRST=$(wait_for "Reply STOP" "$START") || fail "no first touch within 20 s"
pass "first text: $FIRST"
OFFICE_NUMBER=$(curl -fsS "$API/v1/t/$OFFICE" | jq -r .sms_number)
MARK=$(curl -fsS "$API/sandbox/handsets/$ENC/messages" | jq 'map(.id) | max')
post "$API/sandbox/handsets/$ENC/send" -d "{\"to\":\"$OFFICE_NUMBER\",\"body\":\"Yes, can I see it this weekend?\"}" >/dev/null
TIMES=$(wait_for "Which works better" "$MARK") || fail "no showing times offered"
pass "times offered: $TIMES"
MARK=$(curl -fsS "$API/sandbox/handsets/$ENC/messages" | jq 'map(.id) | max')
post "$API/sandbox/handsets/$ENC/send" -d "{\"to\":\"$OFFICE_NUMBER\",\"body\":\"The first one works\"}" >/dev/null
BOOKED=$(wait_for "booked" "$MARK") || fail "showing not booked"
pass "booked: $BOOKED"

OFFICE_TOKEN=$(post "$API/v1/auth/dev-token" -d "{\"tenant_slug\":\"$OFFICE\"}" | jq -r .token)
FARM=$(curl -fsS -H "authorization: Bearer $OFFICE_TOKEN" "$API/v1/console/farms" | jq -r '[.[] | select(.report_status == "draft")][0].id')
[ "$FARM" != "null" ] || fail "no draft farm report"
DETAIL=$(curl -fsS -H "authorization: Bearer $OFFICE_TOKEN" "$API/v1/console/farms/$FARM")
REPORT=$(echo "$DETAIL" | jq -r .report.id)
ORIGINAL=$(echo "$DETAIL" | jq '{body: .report.body}')
BAD=$(post -H "authorization: Bearer $OFFICE_TOKEN" "$API/v1/console/reports/$REPORT/revise" -d '{"body":"Homes here sold in a median of 4 days at a median price of $999,000."}')
echo "$BAD" | jq -e '.ok == false and .status == "needs_review" and (.unmatched | length) == 2' >/dev/null || fail "validator accepted invented figures: $BAD"
post -H "authorization: Bearer $OFFICE_TOKEN" "$API/v1/console/reports/$REPORT/revise" -d "$ORIGINAL" | jq -e '.ok == true' >/dev/null || fail "original report did not re-validate"
pass "report validator rejected two invented figures and re-accepted the original"

check_page() {
  local path="$1" text="$2"
  local html
  html=$(curl -fsS -b "office=$OFFICE" "$WEB$path") || fail "GET $path"
  echo "$html" | grep -q "$text" || fail "$path missing '$text'"
  pass "page $path"
}
check_page "/" "IDX search and lead engagement"
check_page "/s/$OFFICE" "Tallowmere"
check_page "/s/$OFFICE/listing/$LISTING" "Ask about this home"
check_page "/console" "Median first response"
check_page "/console/conversations" "Conversations"
check_page "/console/relationships" "Relationship health"
check_page "/console/farms" "Farm reports"
check_page "/console/farms/$FARM" "Computed stats"
check_page "/console/pipeline" "On-market listings"
check_page "/console/phone" "Sandbox phone"
echo "smoke passed"
