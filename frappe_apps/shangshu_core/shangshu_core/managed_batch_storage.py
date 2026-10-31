"""批写复用刚锁定的完整前像；仍逐行执行原生 Document.save。

不预载后续目标，不合并 SQL UPDATE，不拆开 before/save/after 的逐行顺序。
只省本行 get_doc(for_update=True) 之后，check_if_latest 再取同一前像的读取。
"""
import copy
from contextlib import contextmanager
from contextvars import ContextVar

import frappe


_enabled = ContextVar('shangshu_managed_batch_before_doc', default=False)


@contextmanager
def save_scope(action_version):
    token = _enabled.set(str(action_version or '') == '1.1.0')
    try:
        yield
    finally:
        _enabled.reset(token)


@contextmanager
def locked_before_doc(doc, compiled):
    """仅完整加载并持有行锁的内核平坦记录可复用；特殊类型继续原生读取。"""
    if not _enabled.get():
        yield
        return
    from frappe.model.document import Document
    if (type(doc) is not Document or not str(doc.doctype).startswith('SSM ')
            or doc.doctype != (compiled.get('doctype') or {}).get('name')
            or not getattr(doc.flags, 'for_update', False) or doc.is_new()
            or getattr(doc.meta, 'issingle', False) or getattr(doc.meta, 'is_virtual', False)
            or doc.meta.get_table_fields()
            or any(field.get('type') == 'detail' for field in compiled.get('fields', []))
            or any(name in doc.__dict__ for name in (
                'save', '_save', 'load_doc_before_save', 'check_if_latest',
                '_set_defaults', 'set_user_and_timestamp'))):
        yield
        return
    # raw get 保留 None/False/0；不用 get_valid_dict，避免 Frappe 数值序列化
    # 把真实 NULL 转为 0。取全部物理列，未改列仍参与规则/原生 hook/版本记录。
    previous = frappe.get_doc({'doctype': doc.doctype, **{
        name: copy.deepcopy(doc.get(name)) for name in doc.meta.get_valid_columns()}})
    previous.flags.for_update = True
    original = doc.load_doc_before_save
    consumed = False

    def load_before(*, raise_exception=False):
        nonlocal consumed
        if consumed:
            # hook 若再次保存当前文档，重新取该时刻的数据库前像。
            return original(raise_exception=raise_exception)
        consumed = True
        doc._doc_before_save = previous

    doc.load_doc_before_save = load_before
    try:
        yield
    finally:
        doc.__dict__.pop('load_doc_before_save', None)
