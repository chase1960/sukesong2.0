"""文件元数据唯一持久化口：绑定身份改变先撤销内核并行资格。"""
import json

import frappe


def _object_id(meta):
    binding = meta.get('promotion_binding')
    if binding is None:
        return ''
    if not isinstance(binding, dict):
        frappe.throw('晋升绑定元数据格式无效', frappe.ValidationError)
    return str(binding.get('object_id') or '')


def save_meta(doc, meta):
    # 写入方仍拥有原文件锁和恢复协议；这里不另开事务、不提前释放锁。
    current = frappe.db.sql(
        'SELECT sheet_meta_json, managed_object_id FROM `tabShangshu File Center File` '
        'WHERE name=%s FOR UPDATE', (doc.name,), as_dict=True)
    if not current:
        frappe.throw('文件不存在', frappe.DoesNotExistError)
    old = json.loads(current[0].get('sheet_meta_json') or '{}')
    if not isinstance(old, dict) or not isinstance(meta, dict):
        frappe.throw('文件元数据格式无效', frappe.ValidationError)
    new_id = _revoke_changed(old, meta, current[0].get('managed_object_id'))
    # JSON 与反查索引是同一 SQL；索引不存在/写失败必须报错，不再吞错。
    doc.db_set({'sheet_meta_json': json.dumps(meta, ensure_ascii=False),
                'managed_object_id': new_id}, update_modified=False)


def _revoke_changed(old, new, indexed_id):
    from shangshu_core.public_api import invalidate_managed_write_zone
    old_id, new_id, indexed_id = _object_id(old), _object_id(new), str(indexed_id or '')
    if old_id != new_id or indexed_id != new_id:
        for object_id in sorted({old_id, new_id, indexed_id} - {''}):
            invalidate_managed_write_zone(object_id)
    return new_id


def guard_saved_binding(doc, before):
    """原生save（含工作文件保存）也走同一身份判断；索引随文档一起落库。"""
    old = json.loads((before.get('sheet_meta_json') if before else None) or '{}')
    new = json.loads(doc.get('sheet_meta_json') or '{}')
    if not isinstance(old, dict) or not isinstance(new, dict):
        frappe.throw('文件绑定元数据格式无效', frappe.ValidationError)
    doc.managed_object_id = _revoke_changed(old, new,
        before.get('managed_object_id') if before else None)


def inspect_projection_scope(object_id):
    """仅显式工程核验全量读取；日常编辑不调用。任一不一致不授予资格。"""
    bound = False
    last = ''
    while True:
        rows = frappe.db.sql(
            'SELECT name, sheet_meta_json, managed_object_id FROM `tabShangshu File Center File` '
            'WHERE name>%s ORDER BY name LIMIT 200 LOCK IN SHARE MODE', (last,), as_dict=True)
        if not rows:
            break
        for row in rows:
            try:
                meta = json.loads(row.get('sheet_meta_json') or '{}')
                actual = _object_id(meta)
            except (ValueError, TypeError, AttributeError):
                frappe.throw('文件绑定元数据无法核验：' + row['name'], frappe.ValidationError)
            if actual != str(row.get('managed_object_id') or ''):
                frappe.throw('文件绑定与索引不一致：' + row['name'], frappe.ValidationError)
            bound = bound or actual == object_id
        last = rows[-1]['name']
    return {'handler': 'shangshu_files.promotion.on_managed_record_change', 'bound': bound}
