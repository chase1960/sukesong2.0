#!/usr/bin/env bash
# R967-F05 · 运行版本核验快照（**只读**，不部署、不重启、不改任何文件）
#
#   bash scripts/f05-runtime-snapshot.sh <compose_project> [期望SHA]
#   例：bash scripts/f05-runtime-snapshot.sh shangshu-local-green 9673f540
#
# 计划 §五 F-5 原话：
#   「部署后确认 Node 进程、Frappe web、worker 都加载新代码，HTTP 资源哈希与提交一致，
#     **不能只复制文件不重启**。」
#
# ── 这个脚本只做「读」，判断由人做 ────────────────────────────────────
# 它把「跑的是不是新代码」该看的**五项事实**打出来：
#   ① Frappe web / worker / schedule 三个**独立进程**各自的起始时刻
#   ② Node 容器进程起始时刻
#   ③ 容器里**实际导入**的模块内容（inspect.getsource，不是看挂载目录）
#   ④ 数据库迁移版本
#   ⑤ **四类文件抽样对比**（.py / .json / .yml）—— 2026-10-17 一天漏过四次
#      .json 最阴：不在 import 时报错，要到接口真查那列才炸（Unknown column）
#
# 「进程起于 早于 代码同步于 = 在跑旧代码」—— Python 不热加载，没重启就验，验的是旧代码。
#
# ⚠️ 本脚本**不跑 sync-apps.sh**（源落后 364 笔，跑下去所有实例集体回退）。
# ⚠️ 本脚本**不碰 3800**（那台用户在验）；要它先明确点名。
# ⚠️ 「跑过」≠「生效」；这份快照只证明「此刻跑的是哪份」，不证明功能对。

set -euo pipefail

PROJ="${1:-}"
EXPECT_SHA="${2:-}"
[ -n "$PROJ" ] || { echo "用法: bash scripts/f05-runtime-snapshot.sh <compose_project> [期望SHA]" >&2; exit 1; }

FRAPPE="${PROJ}-frappe-1"
NODE="${PROJ}-node-1"

echo "════════════════════════════════════════════════════════"
echo " R967-F05 运行版本快照 · ${PROJ}"
echo " 期望 SHA：${EXPECT_SHA:-（未给）}"
echo " 采集于：$(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "════════════════════════════════════════════════════════"

# ── ① Frappe 容器里的三个独立进程 ───────────────────────────────
echo
echo "① Frappe 容器进程（web / worker / schedule 是**三个独立进程**）"
echo "   容器：${FRAPPE}"
echo
echo "   PID   起始时刻(容器时区)      命令"
docker exec "$FRAPPE" sh -c '
  self=$$
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    [ "$pid" = "$self" ] && continue
    cmd=$(tr "\0" " " < "$p/cmdline" 2>/dev/null | sed "s/ *$//")
    # 排除本脚本自己（sh -c 的 cmdline 里含 "frappe serve" 字样）
    case "$cmd" in sh\ -c*|"") continue ;; esac
    case "$cmd" in
      *"frappe serve"*|*"frappe worker"*|*"frappe schedule"*|*socketio*)
        start=$(stat -c %y "$p" 2>/dev/null | cut -d. -f1)
        printf "   %-5s %-25s %s\n" "$pid" "$start" "$cmd" ;;
    esac
  done' || echo "   ⚠️ 读不到（容器没起？）"

# ── ② Node 容器 ────────────────────────────────────────────────
echo
echo "② Node（BFF / 前端）容器进程"
echo "   容器：${NODE}"
docker inspect -f '   StartedAt：{{.State.StartedAt}}   Status：{{.State.Status}}' "$NODE" 2>/dev/null \
  || echo "   ⚠️ 读不到"

# ── ③ 容器里实际导入的模块（不是看挂载目录）────────────────────
echo
echo "③ 容器里**实际导入**的那份代码（inspect.getsource，不用看 /srv/shangshu 挂载）"
# 只 import 不连库 —— 看的是 Python 实际加载的那份源，不需要数据库
docker exec "$FRAPPE" sh -c 'cd /home/frappe/frappe-bench && ./env/bin/python -c "
import frappe, inspect, hashlib
frappe.init(site=\"shangshu.localhost\", sites_path=\"/home/frappe/frappe-bench/sites\")
import shangshu_files.sheet as s
src = inspect.getsource(s)
print(\"   shangshu_files.sheet     行数 %d  md5 %s\" % (len(src.splitlines()), hashlib.md5(src.encode()).hexdigest()[:12]))
import shangshu_mail.delivery as d
src2 = inspect.getsource(d)
print(\"   shangshu_mail.delivery   行数 %d  md5 %s\" % (len(src2.splitlines()), hashlib.md5(src2.encode()).hexdigest()[:12]))
"' 2>&1 | sed 's/^/   /' || echo "   ⚠️ 读不到"

# ── ④ 数据库迁移版本 ──────────────────────────────────────────
echo
echo "④ 数据库迁移版本"
# 走 bench 的 mariadb 客户端（绕开 frappe.connect 写 /home/frappe/logs 的权限问题）
docker exec -u frappe "$FRAPPE" sh -c 'cd /home/frappe/frappe-bench && /home/frappe/.local/bin/bench --site shangshu.localhost mariadb --batch -e "select patch, creation from \`tabPatch Log\` order by creation desc limit 3"' 2>&1 | sed 's/^/   /' || echo "   ⚠️ 读不到"

# ── ⑤ 四类文件抽样对比（.py / .json / .yml / BFF）─────────────
# 2026-10-17 一天撞到四次「同步漏某一类」：field_access.py（.py）、edited_at 与
# related_mail（.json）、shangshu-plugin.yml 4 个动作（.yml）、platform.ts（BFF）。
# .json 最阴 —— 不在 import 时报错，要到接口真查那一列才炸（Unknown column）。
echo
echo "⑤ 四类文件抽样对比（容器 == 目标SHA？）"
if [ -n "$EXPECT_SHA" ]; then
  # 每类抽一个代表。仓库路径 → 容器路径：frappe_apps/ ↔ /home/frappe/frappe-bench/apps/
  check_one() {
    repo_path="$1"; ctr_path="$2"; label="$3"
    local_hash=$(git show "$EXPECT_SHA:$repo_path" 2>/dev/null | md5sum | cut -d' ' -f1)
    if [ -z "$local_hash" ]; then
      printf "   %-8s %-6s （%s 里没有这个文件，跳过）\n" "$label" "—" "$EXPECT_SHA"
      return
    fi
    ctr_hash=$(docker exec "$FRAPPE" md5sum "$ctr_path" 2>/dev/null | cut -d' ' -f1)
    if [ -z "$ctr_hash" ]; then
      printf "   %-8s %s  容器里没有 %s\n" "$label" "$local_hash" "$ctr_path"
    elif [ "$local_hash" = "$ctr_hash" ]; then
      printf "   %-8s ✅ 一致   %s\n" "$label" "$local_hash"
    else
      printf "   %-8s ❌ 不一致  基线 %s / 容器 %s\n" "$label" "$local_hash" "$ctr_hash"
    fi
  }
  APPS=/home/frappe/frappe-bench/apps
  check_one "frappe_apps/shangshu_files/shangshu_files/sheet.py" \
            "$APPS/shangshu_files/shangshu_files/sheet.py" ".py"
  check_one "frappe_apps/shangshu_files/shangshu_files/shangshu_files/doctype/shangshu_file_center_sheet_op/shangshu_file_center_sheet_op.json" \
            "$APPS/shangshu_files/shangshu_files/shangshu_files/doctype/shangshu_file_center_sheet_op/shangshu_file_center_sheet_op.json" ".json"
  check_one "frappe_apps/shangshu_files/shangshu-plugin.yml" \
            "$APPS/shangshu_files/shangshu-plugin.yml" ".yml"
  echo "   BFF      （platform.ts 在 node 容器，本条不抽；用 HTTP 资源哈希或 node 容器单独核）"
  echo
  echo "   ⚠️ 抽样只代表「这一类大致跟上了」，**不代表全类都对**。"
  echo "      报账仍要按四类写清「同步了什么」，缺一类写「无」（CLAUDE.md 尾注同规矩）。"
else
  echo "   （没给期望 SHA，跳过。用法：bash $0 <proj> <SHA>）"
fi

# ── 判定表（人不填，脚本只打事实）────────────────────────────
echo
echo "════════════════════════════════════════════════════════"
echo " 怎么判（人做，别让脚本替你下结论）"
echo "════════════════════════════════════════════════════════"
cat <<'NOTE'
   ⚠️ 判法要**分层** —— 不是所有文件变了都要重启（2026-10-17 差点报错）：

   ┌ 前端静态 `shangshu-web/**`
   │   **不需要重启** —— express.static 每次请求读盘；staticGzip 按 路径+mtime 缓存。
   │   验法：**HTTP 取实际字节算哈希**，与提交里同路径文件比。
   │   （进程起始早于文件 mtime 是**正常**的，别据此判旧代码）
   └
   ┌ Python `frappe_apps/**`
   │   **必须重启** —— 不热加载。
   │   验法：① 三个进程起始**都晚于**文件 mtime；② 容器内 inspect.getsource 的 md5 与提交一致
   └
   ┌ BFF 源码 `shangshu-server/src/**`
   │   **必须重启** —— `node --import tsx src/main.ts` 启动时加载。
   │   验法：node 容器 StartedAt 晚于文件 mtime + 实际导入内容一致
   └

   **「进程起于早于文件 mtime = 在跑旧代码」只对后两层成立。**

   ④ 迁移版本不落后于本次提交引入的迁移
   ⑤ 四类抽样（.py / .json / .yml）都一致；BFF 单独核
      2026-10-17 一天撞到四次「漏某一类同步」：
        .py   = field_access.py
        .json = edited_at / related_mail（Unknown column，接口 500）
        .yml  = shangshu-plugin.yml 4 个动作（不注册）
        BFF   = platform.ts
      **.json 最阴** —— 不在 import 时报错，要到接口真查那列才炸。

   ⚠️ 五项**全对上**才能写「在跑新代码」。
      有一项对不上就写「未验证」并点名是哪一项 —— 不许含糊。

   ⚠️ 本快照是「此刻」的事实。部署/重启之后要**重跑**这份快照再判。
NOTE
