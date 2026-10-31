"""文件域表格身份适配；只查完整文件 ID，不读工作簿内容、不创建资源。"""
import os

import frappe

DOCTYPE = "Shangshu File Center File"


def resolve_table_resource(resource_id):
    # 不命中时不进入文件域，也不读取其他文件或目录。
    if not frappe.db.exists(DOCTYPE, resource_id):
        return None
    from shangshu_core.public_api import domain_execution
    with domain_execution("com.shangshu.files"):
        doc = frappe.get_doc(DOCTYPE, resource_id)
        doc.check_permission("read")
        if doc.status != "Active":
            frappe.throw("文件已回收或不可用，请恢复后打开", frappe.ValidationError)
        if os.path.splitext(str(doc.file_name or ""))[1].lower() != ".xlsx":
            return None
        return {"table": resource_id, "source": "xlsx"}
