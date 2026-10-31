#!/usr/bin/env bash
# 空数据初始化：装应用 → 建站 → migrate 两次（第二次验幂等）→ 修 max_file_size 数字坑 → 建测试身份。
# 幂等：站点已存在时跳过建站；应用安装按 apps.txt 缺啥补啥。
set -euo pipefail

BENCH_DIR=/home/frappe/frappe-bench
SHANGSHU_SRC="${SHANGSHU_SRC:-/srv/shangshu}"
SITE_NAME="${SITE_NAME:?SITE_NAME 必须设置}"
cd "$BENCH_DIR"

echo "[init] 同步应用源码（来自 ${SHANGSHU_SRC}/frappe_apps，只读挂载）…"
# 安装顺序按 required_apps：core → files/finance/warehouse/mail → orders
for app in shangshu_core shangshu_files shangshu_finance shangshu_warehouse shangshu_mail shangshu_orders; do
  if [ -d "${SHANGSHU_SRC}/frappe_apps/${app}" ]; then
    rm -rf "apps/${app}"
    cp -a "${SHANGSHU_SRC}/frappe_apps/${app}" "apps/${app}"
  fi
done

for app in shangshu_core shangshu_files shangshu_finance shangshu_warehouse shangshu_mail shangshu_orders; do
  [ -d "apps/${app}" ] || continue
  echo "[init] pip install -e apps/${app}"
  ./env/bin/pip install -e "apps/${app}" --no-build-isolation -q
done

# apps.txt 归一化：修掉历史坏行（末尾缺换行会拼成 frappeshangshu_core），补登记本仓库应用，保证每 app 一行、文件以换行收尾。
./env/bin/python - <<'PY'
from pathlib import Path
p = Path('sites/apps.txt')
lines = []
for raw in (p.read_text().splitlines() if p.exists() else []):
    line = raw.strip()
    if not line:
        continue
    if line.startswith('frappeshangshu_'):
        line = line.replace('frappeshangshu_', 'shangshu_')
    if line not in lines:
        lines.append(line)
if 'frappe' not in lines:
    lines.insert(0, 'frappe')
for app in ('shangshu_core', 'shangshu_files', 'shangshu_finance', 'shangshu_warehouse', 'shangshu_mail', 'shangshu_orders'):
    if Path('apps/' + app).is_dir() and app not in lines:
        lines.append(app)
p.write_text('\n'.join(lines) + '\n')
print('[init] apps.txt 归一化:', lines)
PY

if [ ! -f "sites/${SITE_NAME}/site_config.json" ]; then
  echo "[init] 建站 ${SITE_NAME}（DB root 口令经参数传入，容器内不进 shell 历史）…"
  bench new-site "$SITE_NAME" \
    --admin-password "${ADMIN_PASSWORD:?ADMIN_PASSWORD 必须设置}" \
    --db-root-password "${DB_ROOT_PASSWORD:?DB_ROOT_PASSWORD 必须设置}" \
    --mariadb-user-host-login-scope='%'
fi

for app in shangshu_core shangshu_files shangshu_finance shangshu_warehouse shangshu_mail shangshu_orders; do
  [ -d "apps/${app}" ] || continue
  bench --site "$SITE_NAME" install-app "$app"
done

echo "[init] migrate 两次（第二次验幂等）…"
bench --site "$SITE_NAME" migrate
bench --site "$SITE_NAME" migrate

echo "[init] 构建前端资产（bench build）…"
bench build --apps "$([ -d apps/shangshu_core ] && echo shangshu_core) frappe" 2>/dev/null || bench build

echo "[init] max_file_size 必须是数字（bench set-config 会写成字符串导致上传 500）…"
./env/bin/python - "$SITE_NAME" "${MAX_FILE_SIZE:-33554432}" <<'PY'
import json, sys
site, size = sys.argv[1], int(sys.argv[2])
path = f"sites/{site}/site_config.json"
cfg = json.load(open(path))
cfg["max_file_size"] = size  # 数字，不是字符串
json.dump(cfg, open(path, "w"), ensure_ascii=False, indent=1)
print(f"[init] max_file_size = {size} (type={type(size).__name__})")
PY

echo "[init] 建测试身份（口令只进容器 env/本地 secrets 文件，不进仓库）…"
./env/bin/python /opt/shangshu/create_users.py "$SITE_NAME" "${TEST_USER_PASSWORD:-test-user-pw}"

touch "sites/.b-init-done-${SITE_NAME}"
echo "[init] 完成。站点 ${SITE_NAME} 就绪。"
