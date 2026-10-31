"""Current field read projection for candidates; never mutates stored proposals."""
from copy import deepcopy
import frappe


def _project_free_cells(value):
    """`files.edit_cells` 的载荷投影：补上**当前文件修订**（只给确认卡读回用）。

    2026-10-21（版本口径修复）：动作的前置条件换成了「当前上传版本号 ＋ 当前内容修订号」
    （`expected_modified` 那个「记录修改时间」不再参与过期判定 —— 改个文件名也会推进它）。
    但公共壳的确认卡读回（`shangshu-web/js/file-detail.js` 的 `files.edit_cells` presenter）
    仍然要一个 `expected_modified` 才能核对「文件没被动过」⇒ 这里**按当前记录补上**它。

    ⚠️ **只是显示层的投影，不改存储的提案载荷**，也不参与过期判定 ——
    真正的并发保护在采纳那一刻（`service.check_live_revision`：上传版本号 ＋ 内容修订号）。
    """
    file = value.get('file')
    if not file:
        return {'payload': value, 'redacted': False}
    from shangshu_files.service import DOCTYPE
    doc = frappe.get_doc(DOCTYPE, str(file))
    doc.check_permission('read')
    value['expected_modified'] = str(doc.modified)
    return {'payload': value, 'redacted': False}


def project(action_id, payload):
    value = deepcopy(payload or {})
    if action_id == 'files.edit_cells':
        return _project_free_cells(value)
    table = value.get('table')
    if not table:
        return {'payload': value, 'redacted': False}
    from shangshu_files import promotion
    doc = frappe.get_doc('Shangshu File Center File', str(table))
    doc.check_permission('read')
    definition = promotion.load_definition(doc)
    caps, columns = promotion._field_caps(doc, definition=definition)
    hidden = {c['header'] for c in columns if not (caps.get(c['field']) or {}).get('read')}
    if not hidden:
        return {'payload': value, 'redacted': False}
    cells = value.get('cells')
    if isinstance(cells, list):
        selected = [c for c in cells if isinstance(c, dict) and c.get('header') not in hidden]
        if not selected:
            frappe.throw('当前没有可查看的候选项', frappe.PermissionError)
        value['cells'] = selected
        from shangshu_files.proposal_review import _id
        return {'payload': value, 'redacted': len(selected) != len(cells),
                'unit_ids': [_id(c) for c in selected]}
    if value.get('header'):
        if value['header'] in hidden:
            frappe.throw('当前没有可查看的候选项', frappe.PermissionError)
        return {'payload': value, 'redacted': False}
    if isinstance(value.get('values'), dict):
        hidden_fields = {c['field'] for c in columns if c['header'] in hidden}
        selected = {k:v for k,v in value['values'].items() if k not in hidden_fields}
        if not selected:
            frappe.throw('当前没有可查看的候选项', frappe.PermissionError)
        changed = len(selected) != len(value['values'])
        value['values'] = selected
        return {'payload': value, 'redacted': changed}
    if isinstance(value.get('matrix'), list) or 'start_col' in value:
        # Coordinate packets are indivisible registered actions. Keep accessible
        # packets usable; do not reshape a matrix and silently shift its targets.
        from shangshu_files.sheet import read_payload
        metadata = read_payload(None, {'table':table, 'page':1, 'page_length':1}, {'review_readonly':True})
        headers = metadata.get('headers') or []
        start = int(value.get('start_col') or 0)
        width = max((len(r) for r in value.get('matrix',[]) if isinstance(r,list)),default=1)
        if any(h in hidden for h in headers[start:start+width]):
            frappe.throw('此范围含不可查看的字段，请按可访问范围重新提议', frappe.PermissionError)
    return {'payload': value, 'redacted': False}
