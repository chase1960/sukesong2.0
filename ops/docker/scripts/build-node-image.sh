#!/usr/bin/env bash
# 重建 Node BFF 镜像（**唯一入口** —— 镜像不是代码，别人拿不到，只能靠这个脚本重建出同一份）。
# 用法：./scripts/build-node-image.sh <代码工作树的路径> [镜像 tag]
#   例：./scripts/build-node-image.sh /path/to/workspace
# 产出：shangshu-local-node:<tag>（默认 2026-10-21）
#
# 为什么要有这个脚本（两条真踩过的坑）：
# ① 镜像里那份依赖必须与代码的 package-lock 对得上，否则运行时会撞
#    「package-lock changed: rebuild the node image before starting」那道闸
#    （2026-10-21 在 3850 上真撞过：基线一推进，node 就起不来）。
# ② 容器里跑不了工作树那份 node_modules（开发机 Mac 装的，esbuild 是 darwin 二进制）
#    ⇒ 运行器要用**镜像里这份 Linux 依赖**。
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:?用法：build-node-image.sh <代码工作树路径> [镜像 tag]}"
TAG="${2:-2026-10-21}"
NODE_IMAGE="$(grep '^NODE_IMAGE=' "$HERE/versions.env" | cut -d= -f2)"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$SRC/shangshu-server/package.json" "$SRC/shangshu-server/package-lock.json" "$STAGE/"
cp "$HERE/scripts/start-node.sh" "$STAGE/start-node.sh"
cp "$HERE/Dockerfile.node" "$STAGE/Dockerfile"

echo "[build] 底座 node：$NODE_IMAGE"
echo "[build] lock：$(sha256sum "$STAGE/package-lock.json" | cut -c1-16)"
docker build --build-arg "NODE_IMAGE=$NODE_IMAGE" -t "shangshu-local-node:$TAG" "$STAGE"
echo "[build] 完成：shangshu-local-node:$TAG"
echo "[build] 用它：compose 里 node 的 image 改成 shangshu-local-node:$TAG 后重建 node 容器"
