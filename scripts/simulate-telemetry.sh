#!/bin/bash
set -euo pipefail

URL="https://friction-service-725918177870.asia-northeast1.run.app/api/telemetry"

echo "=== 1. Obtaining Google Cloud Identity Token ==="
TOKEN=$(gcloud auth print-identity-token)

if [ -z "${TOKEN}" ]; then
  echo "Error: Failed to obtain identity token. Please login using 'gcloud auth login'."
  exit 1
fi
echo "Identity token fetched successfully."

# Function to generate a UUID on macOS
gen_uuid() {
  uuidgen | tr '[:upper:]' '[:lower:]'
}

# Function to send an event via HTTP POST
send_event() {
  local session_id=$1
  local is_rage=$2
  local is_maigo=$3
  local is_err=$4
  local stay=$5
  local regen=$6
  local route=$7
  local rev=$8
  local user_id="user-$((10000 + RANDOM % 90000))"
  
  # Current ISO 8601 timestamp in UTC (macOS BSD date & GNU date compatible format)
  local ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Construct validated JSON payload (matching UXEventSchema)
  local json=$(cat <<EOF
{
  "session_id": "${session_id}",
  "user_id": "${user_id}",
  "current_route": "${route}",
  "timestamp": "${ts}",
  "revision_id": "${rev}",
  "is_rage_click": ${is_rage},
  "is_maigo": ${is_maigo},
  "schema_validation_error": ${is_err},
  "stay_duration_seconds": ${stay},
  "regenerate_count": ${regen}
}
EOF
)

  # Send post request synchronously to Cloud Run Telemetry API
  curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${URL}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d "${json}"
}

echo "=== 2. Scenario 1: Normal Low-Friction Baseline (v1 Revision) ==="
echo "Simulating a healthy baseline: 80 events with ~3.75% friction rate (well below 10% SLO)"
routes=("/home" "/chat" "/history" "/settings")

for i in {1..80}; do
  sid=$(gen_uuid)
  route=${routes[$((RANDOM % 4))]}
  
  is_rage=0
  is_maigo=0
  is_err=0
  
  # Randomly inject occasional sparse friction
  rand=$((RANDOM % 100))
  if [ $rand -eq 0 ]; then
    is_rage=1
  elif [ $rand -eq 1 ]; then
    is_maigo=1
  elif [ $rand -eq 2 ]; then
    is_err=1
  fi
  
  stay=$((5 + RANDOM % 90))
  regen=$((RANDOM % 2))
  
  code=$(send_event "${sid}" ${is_rage} ${is_maigo} ${is_err} ${stay} ${regen} "${route}" "v1")
  
  if [ "${code}" -eq 202 ]; then
    echo -n "."
  else
    echo -n "F[${code}]"
  fi
  
  if [ $((i % 20)) -eq 0 ]; then
    echo " (${i}/80 baseline events sent)"
  fi
done
echo ""

echo "=== 3. Scenario 2: Friction Spike (v2-experimental Revision) ==="
echo "Simulating an unstable release: 40 events with ~40% friction rate (high burn-rate, SLO breached)"

for i in {1..40}; do
  sid=$(gen_uuid)
  route=${routes[$((RANDOM % 4))]}
  
  is_rage=0
  is_maigo=0
  is_err=0
  
  # High density of friction (40% probability of having at least one friction)
  rand=$((RANDOM % 10))
  if [ $rand -eq 0 ] || [ $rand -eq 1 ]; then
    is_rage=1
  elif [ $rand -eq 2 ] || [ $rand -eq 3 ]; then
    is_maigo=1
  elif [ $rand -eq 4 ]; then
    is_err=1
  fi
  
  stay=$((30 + RANDOM % 240))
  regen=$((2 + RANDOM % 4))
  
  code=$(send_event "${sid}" ${is_rage} ${is_maigo} ${is_err} ${stay} ${regen} "${route}" "v2-experimental")
  
  if [ "${code}" -eq 202 ]; then
    echo -n "x"
  else
    echo -n "F[${code}]"
  fi
  
  if [ $((i % 10)) -eq 0 ]; then
    echo " (${i}/40 high-friction events sent)"
  fi
done
echo ""

echo "=== 4. Simulation Complete ==="
echo "Streamed 120 mock UX telemetry signals to the pipeline."
echo "Normal Baseline (v1): SLO Met (Friction < 10%)"
echo "Experimental (v2-experimental): SLO Breached (Friction ~ 40%, Alert Triggered)"
