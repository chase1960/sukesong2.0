#!/bin/sh
# 邮件测试**公共跑具** —— 「公共工具只留一份」的第三件（前两件是判分/夹具函数）。
#
# 干什么：
#   把 `mail_fixture.py`（公共件）和目标测试脚本 **连着喂进容器**，一次跑完。
#
# 为什么需要它：
#   容器**看不到** git 工作树（只挂了 `开发/本地测试/agent-c` 那份 10-10 的旧快照），
#   而测试脚本是走 stdin 喂进去跑的 —— **`import` 不到兄弟模块**。
#   要让 45 个脚本共用一份 `require`/`hard_delete`/`ensure_user`，就得有人把两份拼起来喂。
#   这个跑具就是那个「有人」，写一次，以后只改一处。
#
# 用法：
#   sh shangshu-server/scripts/run-mail-test.sh shangshu-server/scripts/test-mail-foo.py
#   # 或在 scripts/ 目录里：
#   sh run-mail-test.sh test-mail-foo.py
#
# 一条边界照旧不破：**不用 `docker cp` 直捅 bench**，代码只在 git 工作树里改。

set -eu

CONTAINER="${MAIL_TEST_CONTAINER:-shangshu-local-c-frappe-1}"
PY="${MAIL_TEST_PYTHON:-cd /home/frappe/frappe-bench && ./env/bin/python -}"
HERE=$(cd "$(dirname "$0")" && pwd)

if [ $# -lt 1 ]; then
  echo "用法：run-mail-test.sh <测试脚本.py> [更多脚本.py …]" >&2
  echo "  例：sh run-mail-test.sh test-mail-dot-via-query.py" >&2
  exit 2
fi

FIXTURE="$HERE/mail_fixture.py"
if [ ! -f "$FIXTURE" ]; then
  echo "找不到公共件：$FIXTURE" >&2
  exit 2
fi

# 把公共件放在最前面 —— 后面脚本里如果还留着同名 def，会**盖掉**公共件那份。
# 所以迁过的脚本必须删掉本地定义，否则等于没迁（这也是为什么要迁完搜零残留）。
{
  cat "$FIXTURE"
  for f in "$@"; do
    # 三条路都试：调用方给的原样（可能相对当前目录）、绝对路径、相对本跑具目录。
    # 2026-10-15 栽过：原先只试 `$HERE/$f`，传「相对仓根」的路径就多拼一层。
    if [ -f "$f" ]; then p="$f"
    elif [ -f "$HERE/$f" ]; then p="$HERE/$f"
    else
      echo "找不到测试脚本（试过 原样/$HERE/ 两处）：$f" >&2
      exit 2
    fi
    echo
    echo "# ===== 以下来自 $p ====="
    cat "$p"
  done
} | docker exec -i "$CONTAINER" sh -lc "$PY"
