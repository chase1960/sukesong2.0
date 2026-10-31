#!/usr/bin/env bash
# R967-F03 · 每个角色一条快速命令
#
#   bash scripts/role-tests.sh A|B|C|D|E [--list] [--out <目录>]
#
# ── 为什么是脚本，不是一行 npm run ────────────────────────────────────────
# runner 的 `--only` 在提交 633d740f 之前**只认第一个**（`argv.indexOf`）。
# 直接写 `--only chat --only confirm`，在旧 runner 上**会静默丢掉后面的** ——
# 跑了 10 个文件却以为跑了 14 个（2026-10-17 D 实跑撞到，F 认）。
#
# 本脚本按「**一次调用只给一个 `--only`**」发指令，新旧 runner 行为一致。
# 想用并集写法，先确认自己树上跑的是 633d740f 之后的 runner（看有没有 selectTests）。
#
# ── 跑之前先核三样（少一样就会出假红/假绿）────────────────────────────────
#   ① 这棵树有没有这些测试文件   ls shangshu-web/js/domains/excel-univer/tests/
#      ⚠️ excel-a-xlsx 那棵树这目录里一个 .test.* 都没有
#   ② 装没装 devDeps             ls shangshu-server/node_modules/typescript
#      没装 → npm --prefix shangshu-server install（在**你要跑的这棵树**里）
#   ③ 跑的哪个 commit            在该仓看 log -1
#   ④ 从**仓根**跑本脚本         脚本自己会 cd 到 shangshu-server/ 去跑 server/excel 组
#      （tsx 装在那层 node_modules；手跑 node --import tsx 时别在仓根跑）
#
# ── 口径 ────────────────────────────────────────────────────────────────
#   · 快速命令 ≠ 完整回归。需站点/凭据的 manual 组不在内（见 F03 文档 §五）
#   · 权限 / 数据完整性 / 恢复 三类不许只跑快速命令（见 F06 文档 §5.2）
#   · 没跑过的写「未跑」，不写「通过」

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

ROLE="${1:-}"; [ -n "$ROLE" ] || usage
shift || true
MODE=""; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE="--list"; shift ;;
    --out)  OUT="${2:-}"; [ -n "$OUT" ] || { echo "--out 需要一个值" >&2; exit 1; }; shift 2 ;;
    *) echo "未知参数: $1" >&2; usage ;;
  esac
done

# ── 每个角色的模式表：groups|only ─────────────────────────────────────────
# 一个 only 一行。加/减模式只改这里。
patterns_for() {
  case "$1" in
    A)
      # Excel 界面：excel-univer 五个 .test.* + 网站侧 excel-* / sheet-*
      echo "excel|excel-univer/tests/"
      echo "server|excel-"
      echo "server|sheet-center"
      echo "server|sheet-keyboard"
      ;;
    B)
      # 表格受管写入 / 晋升 / XLSX 保真
      echo "python|sheet_"
      echo "python|row_append"
      echo "python|zip_missing"
      echo "python|numeric_grid"
      echo "python|record_import"
      echo "python|model_schema"
      ;;
    C)
      # 邮件。41 个文件偏慢，日常改一行用 QUICK=1 走 python 那三个
      if [ "${QUICK:-0}" = "1" ]; then
        echo "python|mail_"
      else
        echo "python|mail_"
        echo "server|mail-"
      fi
      ;;
    D)
      # Assistant。⚠️ agent-loop 必须在 —— 那里住着虚报回执/空回答/落库绑定 16 个守卫用例，
      # 文件名不含 chat/confirm，只写 chat+confirm 会把它漏掉（2026-10-17 D 指出）
      echo "server|chat"
      echo "server|confirm"
      echo "server|agent-loop"
      ;;
    E)
      # 资源/字段/候选权限、归属与关联访问
      # ⚠️ 用 auth.test / identity-admin，不用 auth / identity —— 后者会串味
      #   （auth 命中 flow-**auth**oring，identity 命中 mail-send-identity）
      echo "python|request_binding"
      echo "python|domain_execution"
      echo "python|proposal_guards"
      echo "python|partial_review"
      echo "python|restore_backup"
      echo "python|file_restore"
      echo "server|auth.test"
      echo "server|identity-admin"
      echo "server|platform-legacy"
      echo "server|file-review"
      echo "server|file-detail"
      echo "server|file-center"
      ;;
    *) echo "未知角色: $1（可选 A B C D E）" >&2; exit 1 ;;
  esac
}

STAMP="$(date +%Y%m%d-%H%M%S)"
BASE_OUT="${OUT:-$ROOT/../role-tests-out/$ROLE-$STAMP}"

echo "角色 $ROLE · 根 $ROOT"
echo "输出 $BASE_OUT"
echo "────────────────────────────────────────"

n=0
total_files=0
while IFS='|' read -r groups only; do
  [ -n "$groups" ] || continue
  n=$((n+1))
  out="$BASE_OUT/$n"
  args=(--groups "$groups" --only "$only")
  if [ -n "$MODE" ]; then
    echo "[$n] --groups $groups --only $only"
    node scripts/run-baseline-tests.mjs "${args[@]}" --list \
      | python3 -c "import json,sys;d=json.load(sys.stdin);print('   选中',len(d['selected']));[print('    ',x['file']) for x in d['selected']]"
  else
    mkdir -p "$BASE_OUT"
    echo "[$n] --groups $groups --only $only  →  $(basename "$out")"
    node scripts/run-baseline-tests.mjs "${args[@]}" --out "$out" \
      | sed 's/^/    /' || true
    c="$(python3 -c "import json;print(json.load(open('$out/results.json'))['counts'])" 2>/dev/null || echo '{}')"
    total_files=$((total_files + $(python3 -c "import json;print(len(json.load(open('$out/results.json'))['results']))" 2>/dev/null || echo 0)))
    echo "    小计 $c"
  fi
done < <(patterns_for "$ROLE")

echo "────────────────────────────────────────"
if [ -z "$MODE" ]; then
  echo "角色 $ROLE · 共 $n 轮 · 命中 $total_files 次"
  echo "证据 $BASE_OUT/*/results.json（含 sourceCommit）"
  echo "注：一个文件可能被多个模式命中而跑两遍（如 chat-confirmation-presenter 同时含 chat 与 confirm）——"
  echo "    「命中次数」不是「去重文件数」。要精确去重，用 --list 自己数。"
fi
echo "⚠️ 这是快速命令，不是完整回归。需站点/凭据的 manual 组另跑（F03 文档 §五）。"
