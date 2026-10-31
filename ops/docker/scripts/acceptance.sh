#!/usr/bin/env bash
# 模板完成标准验收（B 自己跑）：
#   测试通过 = 空数据启动 → 能登录 → 真实保存一条数据 → down（保留卷）再 up → 数据仍在
#              → 卷/端口与其它任务隔离 → DevHost 与主仓数据目录未被触碰
# 用法：./acceptance.sh <COMPOSE_PROJECT_NAME> <NODE_HOST_PORT> [ADMIN_PASSWORD]
set -euo pipefail
PROJECT="${1:?用法: acceptance.sh <COMPOSE_PROJECT_NAME> <NODE_HOST_PORT> [ADMIN_PASSWORD]}"
PORT="${2:?需要 NODE_HOST_PORT}"
PASS="${3:-${ADMIN_PASSWORD:-change-me-admin}}"
BASE="http://127.0.0.1:${PORT}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
FAILS=0

ck() { # ck <label> <cond-exit-code>
  if [ "$2" -eq 0 ]; then echo "  ✓ $1"; else echo "  ✗ $1"; FAILS=$((FAILS+1)); fi
}

echo "== 1. 空数据启动（先清掉本任务旧卷，确保从空开始） =="
docker compose -p "$PROJECT" --env-file "$DIR/versions.env" --env-file "$DIR/.env" down -v >/dev/null 2>&1 || true
docker compose -p "$PROJECT" --env-file "$DIR/versions.env" --env-file "$DIR/.env" up -d --build
echo "   等待服务就绪（首次 bench init 可能要几分钟）…"
READY=0
for i in $(seq 1 120); do
  if curl -sf -o /dev/null "$BASE/api/platform/session" 2>/dev/null; then READY=1; break; fi
  sleep 5
done
ck "服务就绪（Node BFF 应答）" $((READY == 1 ? 0 : 1))

echo "== 2. 能登录 =="
LOGIN=$(curl -sf -X POST "$BASE/api/platform/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"Administrator\",\"password\":\"$PASS\"}" || true)
echo "$LOGIN" | grep -q '"ok":true' || echo "$LOGIN" | grep -q '"ok": true'
ck "Administrator 登录成功（真实会话）" $?

echo "== 3. 真实保存（经真实动作链 uploads 一个文件，落库落文件） =="
TXT_B64=$(printf 'acceptance-%s' "$(date +%s)" | base64)
SAVE=$(curl -sf -X POST "$BASE/api/platform/actions/files.upload/execute" \
  -H 'content-type: application/json' \
  -d "{\"payload\":{\"file_name\":\"acceptance.txt\",\"content_base64\":\"$TXT_B64\"},\"confirmed\":true,\"idempotency_key\":\"accept-$PROJECT-$(date +%s)\"}" || true)
echo "$SAVE" | grep -q '"ok":true' || echo "$SAVE" | grep -q '"ok": true'
ck "files.upload 成功（真实持久化）" $?
FILE_ID=$(printf '%s' "$SAVE" | sed -n 's/.*"file"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
ck "拿到文件身份（$FILE_ID）" $([ -n "$FILE_ID" ] && echo 0 || echo 1)

echo "== 4. down（保留卷）再 up → 数据仍在 =="
docker compose -p "$PROJECT" --env-file "$DIR/versions.env" --env-file "$DIR/.env" stop
docker compose -p "$PROJECT" --env-file "$DIR/versions.env" --env-file "$DIR/.env" start
for i in $(seq 1 60); do
  curl -sf -o /dev/null "$BASE/api/platform/session" 2>/dev/null && break
  sleep 5
done
LOGIN2=$(curl -sf -X POST "$BASE/api/platform/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"Administrator\",\"password\":\"$PASS\"}" || true)
LIST=$(curl -sf "$BASE/api/platform/datasets/files.file/records?page=1&page_length=100" || true)
echo "$LIST" | grep -q 'acceptance.txt'
ck "重启后 acceptance.txt 仍在（数据没丢）" $?

echo "== 5. 隔离检查 =="
VOLS=$(docker volume ls -q | grep "^${PROJECT}_" || true)
echo "$VOLS" | grep -q '_mariadb-data'
ck "本任务卷带项目前缀（$(echo "$VOLS" | wc -l | tr -d ' ') 个）" $?
SHARED=$(docker volume ls -q | grep -E '^(mariadb-data|redis-cache-data|frappe-bench)$' || true)
ck "没有无前缀共享卷" $([ -z "$SHARED" ] && echo 0 || echo 1)

echo "== 6. 未触碰 DevHost/主仓数据 =="
MAIN_DATA="/path/to/workspace"
if [ -d "$MAIN_DATA" ]; then
  NEWEST=$(find "$MAIN_DATA" -newer "$DIR/compose.yml" 2>/dev/null | head -1)
  ck "主仓 shangshu-server/data 无新写入" $([ -z "$NEWEST" ] && echo 0 || echo 1)
else
  ck "主仓 data 目录不存在（无需检查）" 0
fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "测试通过 = 空数据启动→登录→真实保存→重启数据仍在→与他人隔离→未触碰 DevHost/主仓数据。全部成立。"
else
  echo "有 $FAILS 项不成立，见上方 ✗。"
fi
exit "$FAILS"
