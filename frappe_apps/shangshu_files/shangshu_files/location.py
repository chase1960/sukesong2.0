"""文件域自己的位置/版本唯一性；只在安装迁移时执行 DDL。"""
import frappe
from frappe.query_builder.functions import Count
from shangshu_files.domain import DIRECTORY_PATTERN

FILE = 'Shangshu File Center File'
VERSION = 'Shangshu File Center Version'


def normalize_directory(directory):
    value = str(directory or '/').strip() or '/'
    if len(value) > 200 or not DIRECTORY_PATTERN.match(value):
        frappe.throw('目录路径须形如 /案件/CN3024518，仅支持字母、数字、中文、点、横线与下划线', frappe.ValidationError)
    return value.rstrip('/') or '/'


def slot(status, name):
    return 'active' if status == 'Active' else 'recycled:' + name


def ensure_constraints():
    """停写升级：先拒绝历史歧义，再回填内部列并加约束，不更改业务修改时间。"""
    files, versions = frappe.qb.DocType(FILE), frappe.qb.DocType(VERSION)
    repeated_file = (frappe.qb.from_(files).select(files.directory, files.file_name)
                     .where(files.status == 'Active').groupby(files.directory, files.file_name)
                     .having(Count('*') > 1).limit(1)).run(as_dict=True)
    repeated_version = (frappe.qb.from_(versions).select(versions.file, versions.version_no)
                        .groupby(versions.file, versions.version_no)
                        .having(Count('*') > 1).limit(1)).run(as_dict=True)
    if repeated_file or repeated_version:
        frappe.throw('文件域升级中止：存在同目录同名在库文件或重复版本号。请先核对历史记录，未自动合并或删除。', frappe.ValidationError)
    offset = 0
    while True:
        rows = frappe.get_all(FILE, fields=['name', 'status', 'location_slot'],
                              order_by='name asc', limit_start=offset, limit_page_length=500)
        if not rows:
            break
        for row in rows:
            expected = slot(row.status, row.name)
            if row.location_slot != expected:
                frappe.db.set_value(FILE, row.name, 'location_slot', expected, update_modified=False)
        offset += len(rows)
    # 原数据库排序规则同时约束大小写/重音，不引入一套哈希比较语义。
    frappe.db.add_unique(FILE, ['directory', 'file_name', 'location_slot'], 'unique_active_file_location')
    frappe.db.add_unique(VERSION, ['file', 'version_no'], 'unique_file_version')
