#!/bin/bash
set -euo pipefail

CONFIG_PATH="/home/openclaw/.openclaw/openclaw.json"

# Pull Google Workspace OAuth credentials from S3 (best-effort — Gmail MCP
# degrades gracefully if these are absent)
if [ -n "${DATA_BUCKET:-}" ]; then
  echo "[start] Syncing Google Workspace credentials from s3://${DATA_BUCKET}/secrets/google-workspace/..."
  mkdir -p "${HOME}/.google_workspace_mcp/credentials"
  aws s3 sync "s3://${DATA_BUCKET}/secrets/google-workspace/" "${HOME}/.google_workspace_mcp/credentials/" \
    --only-show-errors || echo "[start] WARNING: google-workspace credential sync failed; Gmail MCP will be unavailable"
fi

echo "[start] Patching openclaw.json..."
node /app/dist/patch-config.js "${CONFIG_PATH}" 2>&1 || echo "[start] WARNING: patch-config exited with code $?"

echo "[start] Starting Bridge server (background)..."
node /app/dist/index.js &
BRIDGE_PID=$!

echo "[start] Starting OpenClaw Gateway (foreground)..."
openclaw gateway run --port 18789 --verbose --bind loopback 2>&1 &
GATEWAY_PID=$!

# Wait for either process to exit
wait -n ${BRIDGE_PID} ${GATEWAY_PID} 2>/dev/null || true

echo "[start] A process exited, shutting down..."
kill ${BRIDGE_PID} ${GATEWAY_PID} 2>/dev/null || true
wait
