#!/usr/bin/env bash
# Walks the whole Gaggibot flow end to end with curl, using DRY RUN mode so no Discord account is
# needed. Run it from gaggibot/:  npm run smoke
set -euo pipefail

PORT="${GAGGIBOT_PORT:-3999}"
TOKEN="${GAGGIBOT_SHARED_TOKEN:-0123456789abcdef0123456789abcdef}"
BASE="http://127.0.0.1:${PORT}"
DATA_DIR="$(mktemp -d)"
USER_ID="100000000000000000"
AUTH=(-H "authorization: Bearer ${TOKEN}" -H "content-type: application/json")

cleanup() { [[ -n "${PID:-}" ]] && kill "${PID}" 2>/dev/null || true; rm -rf "${DATA_DIR}"; }
trap cleanup EXIT

api() { # method path [json]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "${body}" ]]; then curl -fsS -X "${method}" "${AUTH[@]}" -d "${body}" "${BASE}${path}";
  else curl -fsS -X "${method}" "${AUTH[@]}" "${BASE}${path}"; fi
}
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Starting gaggibot in DRY RUN mode on port ${PORT}"
GAGGIBOT_DRY_RUN=1 DISCORD_USER_IDS="${USER_ID}" GAGGIBOT_SHARED_TOKEN="${TOKEN}" \
  PORT="${PORT}" DATA_DIR="${DATA_DIR}" LOG_LEVEL=warn node dist/index.js &
PID=$!
for _ in $(seq 1 40); do curl -fsS "${BASE}/health" >/dev/null 2>&1 && break; sleep 0.25; done

say "1. Health"
curl -fsS "${BASE}/health"; echo

say "2. Test button endpoint (sends the test DM / records it in dry run)"
api POST /api/v1/test; echo

say "3. Upload a shot (this is what the display does after every shot)"
api POST /api/v1/shots '{"deviceId":"machine","shot":{"id":224,"profile":"Direct Lever","duration":28.4,"weight":36.2,"temperature":93,"pressure":9.1,"flow":1.8},"previous":{"rating":3,"grindSetting":"3.5","doseIn":"18.0","beanType":"Ethiopia Guji","notes":"previous note"}}'; echo
sleep 0.5

say "4. Messages the bot would have sent"
api GET /api/v1/_dev/outbox | python3 -c 'import json,sys
for m in json.load(sys.stdin)["messages"]:
    print("---"); print(m["content"]); print("buttons:", " | ".join(b["label"] for b in m["buttons"]) or "(none)")'

say "5. Answer: tap the 4 button, then reply with the remaining steps"
api POST /api/v1/_dev/press '{"customId":"gm:rate:4"}' >/dev/null; sleep 0.3
api POST /api/v1/_dev/reply '{"text":"3.2"}' >/dev/null; sleep 0.3
api POST /api/v1/_dev/reply '{"text":"18"}' >/dev/null; sleep 0.3
api POST /api/v1/_dev/reply '{"text":"Ethiopia Guji"}' >/dev/null; sleep 0.3
api POST /api/v1/_dev/reply '{"text":"bright, a bit sour"}' >/dev/null; sleep 0.5

say "6. Final messages (recap last)"
api GET /api/v1/_dev/outbox | python3 -c 'import json,sys
for m in json.load(sys.stdin)["messages"][-3:]: print("---"); print(m["content"])'

say "7. Feedback the display polls for (one event per answered field)"
EVENTS=$(api GET "/api/v1/feedback/machine?after=0"); echo "${EVENTS}"
THROUGH=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["events"][-1]["id"])' <<<"${EVENTS}")

say "8. Acknowledge, then confirm the watermark advanced"
api POST /api/v1/feedback/machine/ack "{\"through\":${THROUGH}}" >/dev/null
api GET "/api/v1/feedback/machine?after=${THROUGH}"; echo

say "OK — full flow verified without Discord"
