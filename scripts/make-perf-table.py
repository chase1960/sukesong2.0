"""在 **perf 站**（容器内）造一张大表 —— 绕开 HTTP 的站点识别问题。

造完打印表号，供 `measure-open-latency-exact.mjs` 用（ACCEPT_BASE / ACCEPT_TABLE）。
"""
import base64
import io
import json
import sys
import time

import frappe

frappe.init(site="example-perf-20261029.localhost")
frappe.connect()
frappe.set_user("Administrator")

ROWS = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
COLS = int(sys.argv[2]) if len(sys.argv) > 2 else 57

from openpyxl import Workbook

wb = Workbook()
ws = wb.active
ws.title = "perf"
headers = ["列%d" % i for i in range(COLS)]
headers[0] = "申请号"
headers[1] = "我司案号"
headers[2] = "案号方向"
headers[3] = "申请途径"
ws.append(headers)
for r in range(ROWS):
    ws.append(["APP%08d" % r, "", "DD", "F"] + [""] * (COLS - 4))
buf = io.BytesIO()
wb.save(buf)
content = buf.getvalue()
print("造好的 xlsx：%d 行 × %d 列，%d 字节" % (ROWS, COLS, len(content)))

from shangshu_core.public_api import execute_registered_action

started = time.time()
result = execute_registered_action(
    "files.upload",
    {
        "file_name": "perf-%d-%d.xlsx" % (ROWS, COLS),
        "content_base64": base64.b64encode(content).decode(),
        "attribution": {"level": "personal"},
    },
    confirmed=True,
    idempotency_key="perf-make-%d-%d-%d" % (ROWS, COLS, int(time.time())),
    source="user",
)
print("上传耗时 %.1f 秒" % (time.time() - started))
print("回包：%s" % json.dumps(result, ensure_ascii=False, default=str)[:400])
file_id = (result.get("result") or {}).get("file")
print("表号：%s" % file_id)
print("PERF_TABLE=%s" % file_id)
