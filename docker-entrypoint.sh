#!/bin/sh
set -e

echo "[discordrive] Applying DB schema..."
cd /app/packages/database
npx prisma db push --accept-data-loss

echo "[discordrive] Starting API..."
cd /app
exec pnpm --filter @discordrive/api start
