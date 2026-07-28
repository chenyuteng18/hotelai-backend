#!/bin/bash
# M2 Data Pipeline Deployment Script
# Run this on the server at /opt/hotelai/hotelai-backend/

set -e

echo "=== M2 Data Pipeline Deployment ==="
echo "Timestamp: $(date)"

# 1. Pull latest code
echo "[1/4] Pulling latest code..."
cd /opt/hotelai/hotelai-backend
git pull origin main

# 2. Run database migration
echo "[2/4] Running database migration..."
PGPASSWORD=hotelai_dev_2026 psql -h 127.0.0.1 -U hotelai -d hotelai_dev -f db/migrations/001_m2_pipeline_tables.sql

# 3. Install dependencies (if any new ones)
echo "[3/4] Installing dependencies..."
npm install --production

# 4. Restart PM2
echo "[4/4] Restarting application..."
pm2 restart hotelai-backend

echo ""
echo "=== Deployment Complete ==="
echo "Verifying pipeline status..."
sleep 3
curl -s http://localhost:3002/api/v1/pipeline/status | head -c 500
echo ""
echo ""
echo "Pipeline scheduler should be starting. Check logs:"
echo "  pm2 logs hotelai-backend --lines 20"
