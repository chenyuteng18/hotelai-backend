#!/bin/bash
# M2 Pipeline Smoke Test
# Verifies the pipeline is working end-to-end

set -e

BASE_URL="http://localhost:3002"
echo "=== M2 Pipeline Smoke Test ==="
echo "Timestamp: $(date)"
echo ""

# 1. Health check
echo "[1/6] Health check..."
HEALTH=$(curl -s "$BASE_URL/api/v1/health")
echo "  Response: $HEALTH"
echo ""

# 2. Login to get token
echo "[2/6] Authenticating..."
TOKEN=$(curl -s -X POST "$BASE_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"superadmin","password":"Admin@123"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "  ERROR: Failed to get auth token"
  exit 1
fi
echo "  Token obtained (first 20 chars): ${TOKEN:0:20}..."
echo ""

# 3. Check pipeline status
echo "[3/6] Pipeline status..."
STATUS=$(curl -s "$BASE_URL/api/v1/pipeline/status" -H "Authorization: Bearer $TOKEN")
echo "  Response: $STATUS"
echo ""

# 4. Trigger competitor refresh
echo "[4/6] Triggering competitor refresh..."
TRIGGER=$(curl -s -X POST "$BASE_URL/api/v1/pipeline/run/competitor" -H "Authorization: Bearer $TOKEN")
echo "  Response: $TRIGGER"
echo "  Waiting 10s for processing..."
sleep 10
echo ""

# 5. Check pipeline runs
echo "[5/6] Pipeline run history..."
RUNS=$(curl -s "$BASE_URL/api/v1/pipeline/runs?limit=5" -H "Authorization: Bearer $TOKEN")
echo "  Response: $RUNS"
echo ""

# 6. Check alerts
echo "[6/6] Pipeline alerts..."
ALERTS=$(curl -s "$BASE_URL/api/v1/pipeline/alerts" -H "Authorization: Bearer $TOKEN")
echo "  Response: $ALERTS"
echo ""

echo "=== Smoke Test Complete ==="
echo "Check PM2 logs for detailed pipeline output:"
echo "  pm2 logs hotelai-backend --lines 50"
