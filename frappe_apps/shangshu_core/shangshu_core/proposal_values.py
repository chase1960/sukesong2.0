"""Explicit, bounded recovery of one table-value proposal's original delta.

The normal proposal get/list stays small. This service reauthorizes the stored
positions and returns their original payload, never current values or versions.
"""
import json

import frappe

MAX_BYTES = 1024 * 1024
MAX_ROWS = 50
MAX_FIELDS = 64
MAX_CELLS = 2000
ACTIONS = frozenset({'platform.object.update_many', 'platform.object.companion_write'})
STATUSES = frozenset({'Proposed', 'Confirmed', 'Rejected', 'Failed'})


def input_schema():
    return {'type': 'object', 'additionalProperties': False, 'required': ['proposal_id'],
            'properties': {'proposal_id': {'type': 'string', 'minLength': 1, 'maxLength': 140}}}


def _fail(message, kind=None):
    frappe.throw(message, kind or frappe.ValidationError)


def _id(value, label, maximum=140):
    if (not isinstance(value, str) or not value or value != value.strip()
            or len(value) > maximum):
        _fail('%s无效' % label)
    return value


def _budget(rows, fields, cells):
    if not rows or len(rows) > MAX_ROWS or not fields or len(fields) > MAX_FIELDS or cells > MAX_CELLS:
        _fail('候选值恢复限50行、64列、2000格；请通过原业务审核入口查看更大范围')


def _update_scope(payload):
    records = payload.get('records')
    if not isinstance(records, list) or not records:
        _fail('候选缺少明确记录变化')
    names, fields, cells = [], set(), 0
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get('values'), dict) or not record['values']:
            _fail('候选记录变化格式无效')
        name = _id(record.get('name'), '候选行身份')
        if name not in names:
            names.append(name)
        for key, value in record['values'].items():
            fields.add(_id(key, '候选字段'))
            if isinstance(value, (dict, list)):
                _fail('此恢复入口只支持表格标量变化，复杂字段请使用原业务审核入口')
        cells += len(record['values'])
        _budget(names, fields, cells)
    return names, fields


def _companion_scope(payload):
    cells = payload.get('cells')
    if not isinstance(cells, list) or not cells:
        _fail('候选缺少明确单元格变化')
    rows, headers = [], []
    for cell in cells:
        if not isinstance(cell, dict):
            _fail('候选单元格格式无效')
        rid, header = _id(cell.get('row_id'), '候选行身份'), _id(cell.get('header'), '候选表头', 32767)
        if rid not in rows:
            rows.append(rid)
        if header not in headers:
            headers.append(header)
        _budget(rows, headers, len(cells))
    return rows, headers


def read(_service, request, _context=None):
    from shangshu_core.actions import (get_action_proposal, _definition, _assert_action_role,
                                      _validate_schema, _json)
    from shangshu_core.domains import raw_resource, assert_domain_enabled
    from shangshu_core.objects import get_object_definition

    if not isinstance(request, dict) or set(request) != {'proposal_id'}:
        _fail('候选值恢复只接受proposal_id')
    proposal_id = _id(request['proposal_id'], '提案身份')
    public = get_action_proposal(proposal_id)  # Current actor/enterprise/target visibility first.
    doc = frappe.get_doc('Shangshu Action Proposal', proposal_id)
    if (doc.name != proposal_id or public.get('id') != proposal_id
            or public.get('capability') != doc.action_id
            or doc.status not in STATUSES or public.get('status') != doc.status.lower()):
        _fail('提案状态已变化或无法核实，请重新读取')
    if doc.action_id not in ACTIONS:
        _fail('此入口只恢复已支持的表格值候选，不返回其他动作内容')
    domain, resource = raw_resource('actions', doc.action_id)
    tool_domain, tool = raw_resource('tools', doc.action_id)
    if not domain or not resource or not resource.get('handler') or not tool_domain or not tool:
        _fail('该候选动作当前不可访问', frappe.PermissionError)
    assert_domain_enabled(domain['id'])
    _assert_action_role(_definition(doc.action_id))
    pinned = _definition(doc.action_id, doc.action_version)
    raw = doc.payload_json
    if not isinstance(raw, str) or len(raw.encode('utf-8')) > MAX_BYTES:
        _fail('候选值恢复载荷超过1MiB或格式无效')
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        _fail('候选值载荷不是有效JSON')
    _validate_schema(payload, _json(pinned.input_schema_json, {}))
    if not isinstance(payload, dict):
        _fail('候选值载荷必须是对象')
    object_id = _id(payload.get('object_id'), '候选对象身份')
    definition = get_object_definition(object_id)
    if definition.get('id') != object_id:
        _fail('候选对象身份不一致', frappe.PermissionError)
    visible = {field['id'] for field in definition.get('fields') or [] if isinstance(field, dict) and field.get('id')}
    if doc.action_id == 'platform.object.update_many':
        if definition.get('source') != 'managed':
            _fail('该候选不是受管对象批量值变化')
        names, fields = _update_scope(payload)
        if fields - visible:
            _fail('候选含当前不可读或已不存在的字段', frappe.PermissionError)
        # The proposal's actor qualification alone is not row authorization.
        # Reuse the existing scoped reader, identities only; never copy its new
        # versions into the original candidate or expose those read results.
        from shangshu_core.model_records import get_records
        get_records(object_id, names, fields=[], read_scope={'mode': 'rows', 'purpose': 'interactive'})
    else:
        rows, headers = _companion_scope(payload)
        binding = definition.get('companion')
        if (not isinstance(binding, dict) or binding.get('file_id') != payload.get('file_id')
                or binding.get('definition_revision') != payload.get('definition_revision')):
            _fail('原对象的工作簿绑定已变化，不能恢复旧候选', frappe.PermissionError)
        source_fields = {item['header']: item['field_id'] for item in binding.get('field_columns') or []}
        if any(source_fields[header] not in visible for header in headers if header in source_fields):
            _fail('候选含当前不可读或已不存在的原对象字段', frappe.PermissionError)
        from shangshu_core.domains import invoke_domain_service
        snapshot = invoke_domain_service('files.sheet_read', {
            'table': payload['file_id'], 'row_ids': rows, 'headers': headers})
        current_rows = snapshot.get('rows')
        if (snapshot.get('table') != payload['file_id'] or not isinstance(current_rows, list)
                or len(current_rows) != len(rows)
                or {row.get('row_id') for row in current_rows} != set(rows)):
            _fail('候选目标行不存在或当前不可读', frappe.PermissionError)
        row_map = {row['row_id']: row for row in current_rows}
        for cell in payload['cells']:
            current = (row_map[cell['row_id']].get('values') or {}).get(cell['header'])
            if (not isinstance(current, dict) or current.get('hidden')
                    or current.get('type') == 'hidden' or 'value' not in current):
                _fail('候选目标单元格当前不可读', frappe.PermissionError)
    # Return only the stored delta, including its ORIGINAL versions. No save,
    # commit, current-value merge, schema migration or alternate storage route.
    return {'id': proposal_id, 'capability': doc.action_id, 'payload': payload}
