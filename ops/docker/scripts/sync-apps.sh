#!/usr/bin/env bash
# 改了 frappe_apps 下的应用代码后，在宿主跑这条把新代码同步进容器 bench 并迁移。
# 用法：./scripts/sync-apps.sh <COMPOSE_PROJECT_NAME> [SITE_NAME]
set -euo pipefail
PROJECT="${1:?用法: sync-apps.sh <COMPOSE_PROJECT_NAME> [SITE_NAME]}"
SITE="${2:-shangshu.localhost}"

docker compose -p "$PROJECT" exec frappe bash -lc '
  set -e
  for app in shangshu_core shangshu_files shangshu_finance shangshu_warehouse shangshu_mail shangshu_orders; do
    [ -d "/srv/shangshu/frappe_apps/$app" ] || continue
    rm -rf "apps/$app"
    cp -a "/srv/shangshu/frappe_apps/$app" "apps/$app"
  done
  # 新增的域（example_extension / example_extension）要**装进这个站**，
  # 否则模块表里没有它 ⇒ 设备通道会报「No module named 'example_extension'」。
  ./env/bin/python - <<'APPS'
from pathlib import Path
apps=['frappe']+[p.name for p in sorted(Path('apps').glob('shangshu_*')) if p.is_dir()]
Path('sites/apps.txt').write_text('\n'.join(apps)+'\n')
APPS
  for app in $(./env/bin/python -c "from pathlib import Path;print(' '.join(p.name for p in sorted(Path('apps').glob('shangshu_*')) if p.is_dir()))"); do
    if ! grep -qx "$app" sites/apps.txt 2>/dev/null; then :; fi
    bench --site '"$SITE"' install-app "$app" >/dev/null 2>&1 || true
  done
  bench --site '"$SITE"' migrate
'
echo "[sync] 完成（如涉及 DocType/权限变更，重启 frappe 容器再验）：docker compose -p $PROJECT restart frappe"
