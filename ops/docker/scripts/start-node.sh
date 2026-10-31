#!/usr/bin/env bash
# Node BFF 入口（2026-10-21 重建版）：
# ① **tsx/esbuild 用镜像里那份 Linux 依赖**（/opt/node-deps/node_modules）：
#    代码目录是运行时挂进来的，工作树里的 node_modules 往往是在**开发机（Mac）**上装的
#    ⇒ 它的 esbuild 是 darwin 二进制，**在容器里跑不了**（实测报 "esbuild 不可执行"）。
#    应用自身的依赖仍从工作树解析（纯 JS 依赖不受平台影响）。
# ② **不再因为「package-lock 变了」就拒启动**：代码随基线前进是常态，
#    硬拒等于**每一次基线推进都起不来**（2026-10-21 在 3850 上真撞过）。
#    锁不一致时**以工作树为准**，并打一行提示 + 告诉人怎么重建镜像。
# ③ 兜底：镜像里没有 /opt/node-deps（开发机直跑场景）⇒ 用本地 node_modules，缺了就 npm ci。
set -euo pipefail
cd /srv/shangshu/shangshu-server

IMAGE_DEPS=/opt/node-deps/node_modules
if [ -x "$IMAGE_DEPS/.bin/tsx" ]; then
  if [ -f /opt/node-deps/lock.sha256 ] && [ -f package-lock.json ]; then
    want="$(cat /opt/node-deps/lock.sha256)"; have="$(sha256sum package-lock.json | cut -d' ' -f1)"
    if [ "$want" != "$have" ]; then
      echo "[node] 提示：工作树的 package-lock 与镜像里那份不同（镜像 $want / 工作树 $have）" >&2
      echo "[node]      运行器用镜像那份；应用依赖用工作树那份。要完全对齐请重建镜像：ops/docker/scripts/build-node-image.sh <代码工作树>" >&2
    fi
  fi
  exec "$IMAGE_DEPS/.bin/tsx" src/main.ts
fi

if [ ! -d node_modules/.bin ]; then
  echo "[node] 首次启动：npm ci（lockfile 版本锁定）…"
  npm ci --no-audit --no-fund
fi
echo "[node] 启动 shangshu-server（SHANGSHU_PLATFORM_MODE=${SHANGSHU_PLATFORM_MODE:-unset}）…"
exec npm start
