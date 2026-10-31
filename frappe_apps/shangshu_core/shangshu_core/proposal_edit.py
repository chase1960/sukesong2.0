"""Explicit edits of proposed values; identity and concurrency tokens stay pinned."""
from copy import deepcopy

_IDENTITY_KEYS = {'table', 'sheet', 'mail', 'mailbox', 'name', 'record_id', 'row_id',
                  'object_id', 'op_id', 'idempotency_key', 'action_id', 'action_version',
                  'expected_modified', 'expected_content_version', 'expected_structure_version'}

def patch_edited_value(payload, edited):
    if not isinstance(payload, dict) or not isinstance(edited, dict) or not edited:
        raise ValueError('edited_value 须是带 type/value 的值对象或字段映射')
    result = deepcopy(payload)
    def typed(value):
        if not isinstance(value, dict) or set(value) != {'type', 'value'}:
            raise ValueError('edited_value 须是带 type/value 的值对象')
        if value['type'] not in ('text', 'number', 'date', 'boolean', 'null', 'formula'):
            raise ValueError('edited_value 的 type 不支持')
        return deepcopy(value)
    if 'type' in edited or 'value' in edited:
        if set(edited) != {'type', 'value'}:
            raise ValueError('edited_value 不允许混合单值和字段映射')
        value = typed(edited)
        if 'value' in result:
            result['value'] = value
        elif isinstance(result.get('cells'), list) and len(result['cells']) == 1:
            result['cells'][0]['value'] = value
        else:
            raise ValueError('该提案不是单值改写，无法用 edited_value 编辑')
    else:
        for key, value in edited.items():
            if key in _IDENTITY_KEYS or key.startswith('expected_'):
                raise ValueError('不能修改提案目标或版本：' + key)
            if key not in result:
                raise ValueError('提案中不存在字段：' + key)
            value = typed(value)
            result[key] = value if isinstance(result[key], dict) and 'type' in result[key] else value['value']
    return result
