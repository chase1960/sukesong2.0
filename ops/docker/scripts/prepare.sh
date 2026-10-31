#!/usr/bin/env bash
# 构建前置：把 Frappe 源码 tarball 放进 .cache/（不入库）。A/B/C 三家构建前各跑一次。
# 来源优先级：$FRAPPE_TARBALL > 本机材料目录 > 提示手动放置。
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HERE/.cache"
DEST="$HERE/.cache/frappe-v15.118.0.tar.gz"
if [ -f "$DEST" ]; then
  echo "[prepare] 已就位: $DEST"; exit 0
fi
CANDIDATES=(
  "${FRAPPE_TARBALL:-}"
  "/path/to/workspace"
  "$HERE/../frappe-stack/frappe-v15.118.0.tar.gz"
)
for src in "${CANDIDATES[@]}"; do
  [ -n "$src" ] && [ -f "$src" ] || continue
  cp "$src" "$DEST"
  echo "[prepare] 从 $src 复制到 $DEST"
  exit 0
done
echo "[prepare] 没找到 frappe-v15.118.0.tar.gz。请设置 FRAPPE_TARBALL=<路径> 或手动放到 $DEST" >&2
exit 1
