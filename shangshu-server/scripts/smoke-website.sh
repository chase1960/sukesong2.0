#!/usr/bin/env bash
# Smoke test: 尚书官网管理模块。
# 起 server（隔离数据）→ 登录 → widgets 数量 → 未配置时降级。
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER_PID=""
COOKIE="/tmp/ss-web-smoke-$$.txt"
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$COOKIE"
}
trap cleanup EXIT

# 隔离数据目录，避免污染真实 config / store
export _SS_DATA_DIR
_SS_DATA_DIR=$(mktemp -d)

npx tsx src/main.ts &
SERVER_PID=$!
sleep 3

# --- 登录 ---
echo "=== login ==="
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://127.0.0.1:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"admin"}' \
  -c "$COOKIE")
if [ "$HTTP_CODE" != "200" ]; then
  echo "FAIL: login returned $HTTP_CODE"
  exit 1
fi
echo "login OK"

# --- /api/dashboard/widgets 应返回 5 张官网卡 ---
echo "=== dashboard/widgets ==="
WIDGETS=$(curl -s http://127.0.0.1:3000/api/dashboard/widgets -b "$COOKIE")
COUNT=$(echo "$WIDGETS" | grep -o '"id"' | wc -l)
echo "widget count: $COUNT"
if [ "$COUNT" -ne 5 ]; then
  echo "FAIL: expected 5 widgets, got $COUNT"
  echo "$WIDGETS"
  exit 1
fi
echo "widgets OK"

# --- 未配置官网时 /api/website/stats/daily 应返回 kind=NOT_CONFIGURED ---
echo "=== website/stats/daily (not configured) ==="
RESP=$(curl -s -w "\n%{http_code}" http://127.0.0.1:3000/api/website/stats/daily -b "$COOKIE")
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
echo "status: $HTTP_CODE"
echo "body:   $BODY"

if [ "$HTTP_CODE" -ne 503 ]; then
  echo "FAIL: expected 503, got $HTTP_CODE"
  exit 1
fi
if ! echo "$BODY" | grep -q '"kind"'; then
  echo "FAIL: response missing kind field"
  exit 1
fi
KIND=$(echo "$BODY" | grep -o '"kind":"[^"]*"' | cut -d'"' -f4)
if [ "$KIND" != "NOT_CONFIGURED" ]; then
  echo "FAIL: expected kind=NOT_CONFIGURED, got kind=$KIND"
  exit 1
fi
echo "NOT_CONFIGURED OK"

echo ""
echo "=== website smoke OK ==="
