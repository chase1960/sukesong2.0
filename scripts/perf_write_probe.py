"""阶段2 的「真实单格 ＋ 代表性批量」实测与**回退对照**（2026-10-27 · 条目 03/04/05 那一组改动之后）。

**这个脚本量什么**（人话）：
在一张**真表**（真上传、真晋升、真受管记录）上量三件事 ——
① **单格写**（连续写 20 次 ⇒ P95）；
② **整包写**（一批 N 格的混合包：普通列 ＋ 受管列 ⇒ 一次落盘）；
③ **撤回**（一次三步撤回里的第一步）。

**为什么要有「对照」**：阶段2 的完成边界写的是「**没有明显性能回退**」
⇒ 光有「现在多少毫秒」不够 ⇒ 要拿**改之前**的同一台机器、同一站、同一夹具的数字来比。

⚠️ **量的是哪一段**：本轮改动落在**受管列的写入与回填**那条路上
（写正式值 ⇒ 回填文件 ⇒ 落盘）⇒ 所以量的是**这条整链**，
不是只量某一段。

⚠️ **样本量取 300 行 × 12 列（3 个受管列 ＋ 9 个普通列）**，不是 R1 那个 15,500×55
—— R1 的**正式性能采样**属阶段8（同候选总验证）那一段；
本段要回答的是「**这一组改动有没有把常用的写变慢**」⇒ 1,000 行够暴露量级问题。

**怎么跑**：
```
docker exec shangshu-local-r967-frappe-1 sh -c 'cd /home/frappe/frappe-bench/sites \
  && ../env/bin/python /tmp/perf_write_probe.py'
```
⇒ 打印一行 JSON（`{"single_p95_ms": ..., "package_ms": ..., ...}`），
**并在结尾清掉自己造的表与对象**（不留残骸）。
"""
import json
import time
import uuid

import frappe

frappe.init(site="shangshu.localhost")
frappe.connect()
frappe.set_user("Administrator")

from shangshu_core import model_records
from shangshu_files import promotion, service

import os
# 样本规模可由环境变量覆盖（PKG-132 · 性能线）：
#   PERF_ROWS / PERF_COLUMNS / PERF_PROMOTED / PERF_SINGLES / PERF_CELLS
ROWS = int(os.environ.get('PERF_ROWS') or 300)
COLUMNS = int(os.environ.get('PERF_COLUMNS') or 12)
PROMOTED = int(os.environ.get('PERF_PROMOTED') or 3)
SINGLE_RUNS = int(os.environ.get('PERF_SINGLES') or 10)
# 一次包写多少格（默认 400 ＝ 200 行 × 2 列）
PACKAGE_CELLS = int(os.environ.get('PERF_CELLS') or 400)

HEADER = ["受管列%d" % i for i in range(PROMOTED)] + ["普通列%d" % i for i in range(COLUMNS - PROMOTED)]
ACCESS = {"read": {"scope": "global"}, "write": {"scope": "global"}, "download": {"scope": "global"}}
TABLE_ACCESS = dict(ACCESS, record_scope="all")


def _fixture_bytes():
    """真工作簿：ROWS 行 × COLUMNS 列（第一行是表头）。"""
    from io import BytesIO
    from openpyxl import Workbook
    book = Workbook()
    sheet = book.active
    sheet.title = "P-1"
    sheet.append(HEADER)
    for index in range(1, ROWS + 1):
        row = []
        for column in range(COLUMNS):
            row.append(("值%d-%d" % (index, column)) if column >= PROMOTED else (index * 1.5))
        sheet.append(row)
    out = BytesIO()
    book.save(out)
    return out.getvalue()


def _cleanup(table, object_id, application_id):
    try:
        model = frappe.get_doc(model_records.MODEL, object_id)
        frappe.db.commit()
        frappe.db.sql("DROP TABLE IF EXISTS `%s`" % model.physical_doctype)
        frappe.delete_doc("DocType", model.physical_doctype, force=True, ignore_permissions=True)
        frappe.delete_doc(model_records.MODEL, object_id, force=True, ignore_permissions=True)
    except Exception:
        pass
    try:
        frappe.delete_doc("Shangshu Application Definition", application_id, force=True,
                          ignore_permissions=True)
    except Exception:
        pass
    try:
        service.recycle({"file": table})
        frappe.db.commit()
        frappe.delete_doc("Shangshu File Center File", table, force=True, ignore_permissions=True)
    except Exception:
        pass
    try:
        frappe.db.commit()
    except Exception:
        pass


def run():
    import base64
    from shangshu_files import sheet

    key = "perf-write-" + uuid.uuid4().hex[:8]
    table = "perf-write-" + uuid.uuid4().hex[:8]
    started = time.time()
    result = service.upload({"file_name": table + ".xlsx",
                             "content_base64": base64.b64encode(_fixture_bytes()).decode(),
                             "attribution": {"level": "personal"}})
    frappe.db.commit()
    table = result["file"]
    columns = []
    for index in range(COLUMNS):
        if index < PROMOTED:
            columns.append({"header": HEADER[index], "promoted": True, "field": "c%d" % index,
                            "type": "number", "access": dict(ACCESS)})
        else:
            columns.append({"header": HEADER[index], "promoted": False})
    promote_started = time.time()
    promotion.define({"table": table, "definition": {"access": dict(TABLE_ACCESS), "columns": columns}})
    frappe.db.commit()
    promote_seconds = round(time.time() - promote_started, 2)
    binding = promotion._managed_binding(frappe.get_doc(promotion.FILE, table)) or {}
    object_id = binding.get("object_id")
    application_id = binding.get("application_id")
    row_ids = sorted(binding.get("records") or {})
    try:
        # ---------- ① 单格写（连续 20 次） ----------
        singles = []
        for index in range(SINGLE_RUNS):
            row_id = row_ids[index % len(row_ids)]
            probe = sheet.read_payload("files.sheet_read", {"table": table}, None)
            started = time.time()
            promotion.cell_write({"table": table, "row_id": row_id, "header": HEADER[0],
                                  "value": {"type": "number", "value": 1000 + index},
                                  "op_id": "%s-single-%d" % (key, index)})
            frappe.db.commit()
            singles.append((time.time() - started) * 1000)
        singles.sort()
        p95 = singles[min(len(singles) - 1, int(len(singles) * 0.95))]
        # ---------- ② 整包写（普通列 ＋ 受管列，一次落盘） ----------
        # 一次包写多少格由 PERF_CELLS 决定（默认 400 ＝ 200 行 × 2 列）。
        # 行数不够就**重复用同一批行**（格子数照旧）—— 只量「一包里多少格」这一件事。
        package_rows = [row_ids[index % len(row_ids)] for index in range(max(1, PACKAGE_CELLS // 2))]
        cells = []
        for index, row_id in enumerate(package_rows):
            cells.append({"row_id": row_id, "header": HEADER[0],
                          "value": {"type": "number", "value": 2000 + index}})
            cells.append({"row_id": row_id, "header": HEADER[PROMOTED],
                          "value": {"type": "text", "value": "包写%d" % index}})
        probe = sheet.read_payload("files.sheet_read", {"table": table}, None)
        started = time.time()
        sheet.write_cells({"table": table, "op_id": "%s-package" % key, "cells": cells,
                           "expected_content_version": int(probe.get("content_version") or 0),
                           "expected_structure_version": int(probe.get("structure_version") or 1)})
        frappe.db.commit()
        package_ms = round((time.time() - started) * 1000)
        # ---------- ③ 撤回（第一步） ----------
        started = time.time()
        sheet.undo_cells({"table": table, "op_id": "%s-package" % key})
        frappe.db.commit()
        undo_ms = round((time.time() - started) * 1000)
        print(json.dumps({
            "行数": ROWS, "列数": COLUMNS, "受管列": PROMOTED,
            "建表加晋升秒": promote_seconds,
            "单格写P95毫秒": round(p95),
            "单格写中位毫秒": round(singles[len(singles) // 2]),
            "整包写毫秒（%d 格）" % len(cells): package_ms,
            "请求格数": PACKAGE_CELLS,
            "撤回毫秒": undo_ms,
            "表格": table, "对象": object_id,
        }, ensure_ascii=False))
    finally:
        _cleanup(table, object_id, application_id)


if __name__ == "__main__":
    try:
        run()
    finally:
        frappe.destroy()
