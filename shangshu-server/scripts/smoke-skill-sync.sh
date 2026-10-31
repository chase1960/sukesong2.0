#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
SERVER_PID=""
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
npx tsx src/main.ts &
SERVER_PID=$!
sleep 2

curl -s -X POST http://127.0.0.1:3000/api/login -H 'Content-Type: application/json' -d '{"password":"admin"}' -c /tmp/ss-smoke-cookie.txt
KEY=$(curl -s -X POST http://127.0.0.1:3000/api/skill-keys -H 'Content-Type: application/json' -b /tmp/ss-smoke-cookie.txt -d '{"name":"smoke","role":"upload"}' | grep -o '"key":"[^"]*"' | cut -d'"' -f4)
echo "key=$KEY"

curl -s -X POST http://127.0.0.1:3000/api/skills/smoke-skill/push \
  -H 'Content-Type: application/json' \
  -H "X-Shangshu-Key: $KEY" \
  -d '{"parent":"","localHead":"abc","files":[{"path":"skill.md","content":"# Smoke"}],"message":"init"}'
echo ""

curl -s http://127.0.0.1:3000/api/skills -b /tmp/ss-smoke-cookie.txt
echo ""
echo "skill-sync smoke ok"
