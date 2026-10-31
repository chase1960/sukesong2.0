#!/bin/sh
# 环境就绪后一条命令：造真实数据 → 跑 A1～A7。
#
# 为什么要有这个：Docker 环境是**空数据启动**（B 的 init-site.sh 只建站装应用建用户），
# 没有业务表可打开，A1 都跑不了。所以先用仓里现成的 excel-b1-fixture.py 造真实
# 「Excel 首批测试表」（1000 行 × 8 列，含前导零/长编号/长备注/金额等保真样本）。
#
# 口令从 ops/docker/.env 读，**绝不打印**、绝不进仓库或证据。
set -e

WT="${SHANGSHU_SRC:-/path/to/workspace"
ENVF="$WT/ops/docker/.env"
SITE="${SITE_NAME:-shangshu.localhost}"

[ -f "$ENVF" ] || { echo "缺 $ENVF"; exit 2; }

# 只取口令，不回显
ADMIN_PW=$(grep -E '^ADMIN_PASSWORD=' "$ENVF" | cut -d= -f2-)
[ -n "$ADMIN_PW" ] || { echo ".env 里没有 ADMIN_PASSWORD"; exit 2; }

cd "$WT/ops/docker"

echo "=== 1. 确认 Frappe 站点在跑 ==="
docker compose --env-file versions.env --env-file .env ps
docker compose --env-file versions.env --env-file .env exec -T frappe \
  bash -c "cd /home/frappe/frappe-bench && ./env/bin/python -c \"import frappe; frappe.init('$SITE'); frappe.connect(); print('站点连得上，对象数', frappe.db.count('Shangshu Object'))\"" 2>&1 | tail -3

echo
echo "=== 2. 造真实数据（1000 行 × 8 列）==="
docker compose --env-file versions.env --env-file .env exec -T frappe bash -c "
  cd /home/frappe/frappe-bench
  ./env/bin/python /srv/shangshu/shangshu-server/scripts/excel-b1-fixture.py \
    --site '$SITE' --sites-path /home/frappe/frappe-bench/sites \
    --manifest-out /tmp/excel-manifest.json --secrets-out /tmp/excel-secrets.json \
    --admin-password '$ADMIN_PW' --rows 1000
" 2>&1 | tail -25

echo
echo "=== 3. 把夹具清单取回本机（口令文件只取路径，不打印内容）==="
docker compose --env-file versions.env --env-file .env cp \
  frappe:/tmp/excel-manifest.json "$HOME/.excel-b1/manifest.json" 2>&1 | tail -2 || true
echo "manifest → ~/.excel-b1/manifest.json"

echo
echo "=== 4. 跑 A1 A6 A7（不依赖 B 的 xlsx 后端）==="
cd "$WT/shangshu-web/js/domains/excel-univer"
node tests/agent-a.mjs --only A1 A6 A7 --json-out /path/to/workspace
