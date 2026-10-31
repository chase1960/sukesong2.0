#!/usr/bin/env bash
# Frappe 容器入口：首次启动把预置 bench 拷进数据卷并建站；之后起 web + socketio + schedule + worker。
# 服务面与 ops/devhost-frappe/start.mjs 对齐（bench serve --noreload + schedule + worker --queue short,default,long）。
set -euo pipefail

BENCH_DIR=/home/frappe/frappe-bench
PRISTINE=/opt/shangshu/pristine/frappe-bench

if [ ! -f "$BENCH_DIR/sites/common_site_config.json" ]; then
  echo "[init] 首次启动：填充 bench 数据卷…"
  mkdir -p "$BENCH_DIR"
  cp -a "$PRISTINE"/. "$BENCH_DIR"/
fi

cd "$BENCH_DIR"

# Redis/DB 地址以容器网络名写进 common_site_config（幂等）
bench set-mariadb-host "${DB_HOST:-mariadb}"
bench set-config -g redis_cache "${REDIS_CACHE_URL:-redis://redis-cache:6379}"
bench set-config -g redis_queue "${REDIS_QUEUE_URL:-redis://redis-queue:6379}"
# DevHost 实测 redis_socketio 与 redis_cache 同一实例，无第三路
bench set-config -g redis_socketio "${REDIS_CACHE_URL:-redis://redis-cache:6379}"
bench set-config -g socketio_port "${FRAPPE_SOCKETIO_PORT:-19002}"
bench set-config -g webserver_port "${FRAPPE_WEB_PORT:-18002}"
bench set-config -g default_site "${SITE_NAME}"

# 初始化以完成标记为准（site_config 存在 ≠ 初始化完成；中断后重跑靠标记判定）
if [ ! -f "sites/.b-init-done-${SITE_NAME}" ]; then
  /opt/shangshu/init-site.sh
fi

echo "[start] bench serve / socketio / schedule / worker…"
bench serve --port "${FRAPPE_WEB_PORT:-18002}" --noreload &
SERVE_PID=$!
bench socketio &
SOCKETIO_PID=$!
bench schedule &
SCHED_PID=$!
bench worker --queue short,default,long &
WORKER_PID=$!

term() {
  kill "$SERVE_PID" "$SOCKETIO_PID" "$SCHED_PID" "$WORKER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap term SIGTERM SIGINT

# 任一核心进程退出则整容器退出（让 compose 重启策略接管，不静默半死）
wait -n "$SERVE_PID" "$SOCKETIO_PID" "$SCHED_PID" "$WORKER_PID" || true
term
exit 1
