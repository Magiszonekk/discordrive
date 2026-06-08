#!/usr/bin/env bash
# DiscorDrive v4 — HTTP End-to-End Speed Benchmark
# Testuje produkcję discordrive.cikowice.pl przez SSH tunnel
#
# Uruchomienie:
#   chmod +x /home/ubuntu/Desktop/discordrive/discordrive/scripts/benchmark-e2e.sh
#   ./scripts/benchmark-e2e.sh
#
# Wymaga: curl, openssl (dla sha256), jq (opcjonalnie)

set -euo pipefail

BASE_URL="http://localhost"  # nginx lokalnie forwarduje do tunelu
API_PORT=3000
GRAPHQL="$BASE_URL/graphql"

# --- Auth ---
echo "🔐 Logowanie..."
TOKEN=$(curl -s -X POST "$GRAPHQL" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation Login($email: String!, $password: String!) { login(email: $email, password: $password) { token } }",
    "variables": { "email": "speedtest@discordrive.local", "password": "speedtest123" }
  }' | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['login']['token'])" 2>/dev/null || echo "")

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "⚠️  Nie udało się zalogować — pomijam test E2E HTTP"
  echo "    (potrzebne jest założenie konta speedtest@discordrive.local)"
  exit 0
fi

echo "   Token: ${TOKEN:0:20}..."

# --- Helpers ---
format_mbps() {
  local bytes=$1 ms=$2
  if [ "$ms" -le 0 ]; then echo "N/A"; return; fi
  python3 -c "print(f'{$bytes/1024/1024/($ms/1000):.2f}')"
}

sha256_hex() {
  python3 -c "import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())"
}

# --- Upload benchmarks ---
echo ""
echo "═══════════════════════════════════════════════════"
echo "  📤 UPLOAD BENCHMARK (HTTP → production)"
echo "═══════════════════════════════════════════════════"

UPLOAD_SIZES=(102400 1048576 5242880 10485760)  # 100KB, 1MB, 5MB, 10MB
UPLOAD_TIMES=()

for size in "${UPLOAD_SIZES[@]}"; do
  # Generate random binary data
  data=$(python3 -c "import sys,os; sys.stdout.buffer.write(os.urandom($size))")

  # Init upload (GraphQL)
  resp=$(curl -s -X POST "$GRAPHQL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{
      \"query\": \"mutation(\$input: InitSecureUploadRequest!) { initUpload(input: \$input) { fileId } }\",
      \"variables\": {
        \"input\": {
          \"totalCiphertextBytes\": \"$size\",
          \"chunkCount\": 1,
          \"wrappedFEK\": \"$(echo -n 'test' | base64)\",
          \"argon2Params\": {\"memoryKB\": 19456, \"iterations\": 2, \"parallelism\": 1, \"saltB64\": \"AAAA\"}
        }
      }
    }")

  file_id=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['initUpload']['fileId'])" 2>/dev/null || echo "")

  if [ -z "$file_id" ]; then
    echo "   ❌ $size B — initUpload failed"
    continue
  fi

  # Upload blob content
  start_ms=$(python3 -c "import time; print(int(time.time()*1000))")
  upload_resp=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PUT "$BASE_URL/api/blob/$file_id/content" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @- <<< "$data")
  end_ms=$(python3 -c "import time; print(int(time.time()*1000))")
  elapsed=$((end_ms - start_ms))

  if [ "$upload_resp" = "200" ]; then
    speed=$(format_mbps $size $elapsed)
    echo "   ✅ $(format_bytes $size) in ${elapsed}ms (${speed} MB/s)"
    UPLOAD_TIMES+=("$elapsed")
  else
    echo "   ❌ $(format_bytes $size) — HTTP $upload_resp"
  fi
done

echo ""
echo "═══════════════════════════════════════════════════"
echo "  📥 DOWNLOAD BENCHMARK (production → HTTP)"
echo "═══════════════════════════════════════════════════"

# Upload a known file first then download it
test_data=$(python3 -c "import os; os.urandom(1048576)")
expected_hash=$(echo -n "$test_data" | sha256_hex)

# Init
resp=$(curl -s -X POST "$GRAPHQL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"query\": \"mutation(\$input: InitSecureUploadRequest!) { initUpload(input: \$input) { fileId } }\",
    \"variables\": {
      \"input\": {
        \"totalCiphertextBytes\": \"1048576\",
        \"chunkCount\": 1,
        \"wrappedFEK\": \"$(echo -n 'test' | base64)\",
        \"argon2Params\": {\"memoryKB\": 19456, \"iterations\": 2, \"parallelism\": 1, \"saltB64\": \"AAAA\"}
      }
    }
  }")
dl_file_id=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['initUpload']['fileId'])" 2>/dev/null || echo "")

if [ -n "$dl_file_id" ]; then
  # Upload
  curl -s -X PUT "$BASE_URL/api/blob/$dl_file_id/content" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @- <<< "$test_data" > /dev/null

  # Commit manifest so file is in READY state
  commit_hash=$(echo -n "$test_data" | sha256_hex)
  curl -s -X POST "$GRAPHQL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{
      \"query\": \"mutation(\$fileId: String!, \$manifestBlobId: String!, \$totalCiphertextBytes: String!, \$chunkCount: Int!) { commitManifest(fileId: \$fileId, manifestBlobId: \$manifestBlobId, totalCiphertextBytes: \$totalCiphertextBytes, chunkCount: \$chunkCount) { success } }\",
      \"variables\": {
        \"fileId\": \"$dl_file_id\",
        \"manifestBlobId\": \"$dl_file_id\",
        \"totalCiphertextBytes\": \"1048576\",
        \"chunkCount\": 1
      }
    }" > /dev/null

  # Download 3x
  echo "   Plik 1 MB — 3 pobrania:"
  for i in 1 2 3; do
    start_ms=$(python3 -c "import time; print(int(time.time()*1000))")
    dl_data=$(curl -s "$BASE_URL/api/blob/$dl_file_id/content" \
      -H "Authorization: Bearer $TOKEN")
    end_ms=$(python3 -c "import time; print(int(time.time()*1000))")
    elapsed=$((end_ms - start_ms))
    actual_hash=$(echo -n "$dl_data" | sha256_hex)
    speed=$(format_mbps ${#dl_data} $elapsed)

    if [ "$actual_hash" = "$expected_hash" ]; then
      echo "     Run $i: ${elapsed}ms — ${speed} MB/s ✓"
    else
      echo "     Run $i: HASH MISMATCH ❌"
    fi
  done
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  📊 Koniec benchmarku E2E"
echo "═══════════════════════════════════════════════════"