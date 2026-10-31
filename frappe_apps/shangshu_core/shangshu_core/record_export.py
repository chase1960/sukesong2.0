"""受管对象 XLSX 只读导出；查询和权限仍由同一记录适配器负责。"""
import base64
from io import BytesIO
import re

import frappe
from frappe.utils import getdate
from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE

from shangshu_core.model_records import query_records

MAX_ROWS = 5000
MAX_CELLS = 500000
MAX_BYTES = 20 * 1024 * 1024


def _cell(value, field):
    if field["type"] == "date" and value:
        return getdate(value)
    if field["type"] == "integer" and value is not None and len(str(abs(value))) > 15:
        return str(value)  # Excel 数值精度不足时保留原值，不能静默舍入。
    if isinstance(value, str) and (len(value) > 32767 or ILLEGAL_CHARACTERS_RE.search(value)):
        frappe.throw(f"「{field['label']}」含 XLSX 不支持的长度或控制字符，未生成截断文件", frappe.ValidationError)
    return value


def write_workbook(title, fields, rows):
    """原生对象与受管对象共用同一 XLSX 生成契约。"""
    book = Workbook(); sheet = book.active; sheet.title = "数据"
    def append(values):
        sheet.append(values)
        for cell in sheet[sheet.max_row]:
            if isinstance(cell.value, str):
                cell.data_type = "s"
    append([field["label"] for field in fields])
    value_bytes = 0
    for index, row in enumerate(rows):
        values = []
        for field in fields:
            value = _cell(row.get(field["id"]), field)
            value_bytes += len(value.encode('utf-8')) if isinstance(value, str) else 16
            if value_bytes > MAX_BYTES:
                frappe.throw("导出内容超过 20MB，请缩小筛选范围", frappe.ValidationError)
            values.append(value)
        append(values)
    sheet.freeze_panes = "A2"; sheet.auto_filter.ref = sheet.dimensions
    stream = BytesIO(); book.save(stream); content = stream.getvalue(); book.close()
    if len(content) > MAX_BYTES:
        frappe.throw("导出文件超过 20MB，请缩小筛选范围", frappe.ValidationError)
    safe = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', title).strip(' .')[:100] or '数据'
    return {"filename": safe + '.xlsx', "mime_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "content_base64": base64.b64encode(content).decode('ascii'), "total": len(rows)}


def export_records(service_id, payload, context):
    # 同时保护直接 Python 调用；非管理员导出须待明确权限卡，不自动扩大。
    from shangshu_core import business_access
    business_access.require_identity()
    if not business_access.is_open() and "System Manager" not in frappe.get_roles():
        frappe.throw("数据导出暂仅开放给系统管理员", frappe.PermissionError)
    from shangshu_core.model_records import is_managed
    if not is_managed(payload.get("object_id")):
        from shangshu_core import native_objects
        return native_objects.export_records(payload)
    object_id, filters = payload["object_id"], payload.get("filters", {})
    first = query_records(object_id, filters, 1, 100)
    definition, total = first["object"], first["total"]
    if definition["revision"] != payload["expected_revision"]:
        frappe.throw("字段已变化，请刷新数据表后重新导出", frappe.TimestampMismatchError)
    fields = definition["fields"]
    if any(field["type"] == "detail" for field in fields):
        frappe.throw("当前导出不支持明细列，未生成缺列文件", frappe.ValidationError)
    if total > MAX_ROWS or (total + 1) * len(fields) > MAX_CELLS:
        frappe.throw("导出超过 5000 行或 50 万单元格，请缩小筛选范围", frappe.ValidationError)
    book = Workbook(); sheet = book.active; sheet.title = "数据"
    def append(values):
        sheet.append(values)
        for cell in sheet[sheet.max_row]:
            if isinstance(cell.value, str):
                # openpyxl 默认会将 = 开头内容当公式；导出必须保留原文本。
                cell.data_type = "s"
    append([field["label"] for field in fields])
    written = 0; value_bytes = 0
    for page in range(1, (total + 99) // 100 + 1):
        result = first if page == 1 else query_records(object_id, filters, page, 100)
        if result["object"]["revision"] != definition["revision"] or result["total"] != total:
            frappe.throw("数据范围已变化，请重新导出", frappe.ValidationError)
        for row in result["rows"]:
            values = []
            for field in fields:
                value = row.get(field["id"])
                if field["type"] == "reference" and value:
                    value = row.get("_display", {}).get(field["id"], "关联记录不可访问")
                elif field["type"] == "date" and value:
                    value = getdate(value)
                elif field["type"] == "integer" and value is not None and len(str(abs(value))) > 15:
                    value = str(value)  # Excel 数值精度不足时保留原值，不能静默舍入。
                if isinstance(value, str) and (len(value) > 32767 or ILLEGAL_CHARACTERS_RE.search(value)):
                    frappe.throw(f"第 {written + 1} 行「{field['label']}」含 XLSX 不支持的长度或控制字符，未生成截断文件", frappe.ValidationError)
                value_bytes += len(value.encode('utf-8')) if isinstance(value,str) else 16
                if value_bytes > MAX_BYTES:
                    frappe.throw("导出内容超过 20MB，请缩小筛选范围", frappe.ValidationError)
                values.append(value)
            append(values); written += 1
    if written != total:
        frappe.throw("导出行数不完整，请重新尝试", frappe.ValidationError)
    sheet.freeze_panes = "A2"; sheet.auto_filter.ref = sheet.dimensions
    stream = BytesIO(); book.save(stream); content = stream.getvalue(); book.close()
    if len(content) > MAX_BYTES:
        frappe.throw("导出文件超过 20MB，请缩小筛选范围", frappe.ValidationError)
    title = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', definition["title"]).strip(' .')[:100] or '数据'
    return {"filename":title+'.xlsx',"mime_type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "content_base64":base64.b64encode(content).decode('ascii'),"total":written,"revision":definition["revision"]}
