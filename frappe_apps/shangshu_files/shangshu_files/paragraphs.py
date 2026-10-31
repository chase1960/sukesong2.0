"""固定DOCX段落的有界读取与修改；与人工编辑共用格式服务/换版，不是第二写通道。"""
import re


def preview(opened, changes):
    if not opened.get('editable'):
        raise ValueError(opened.get('reason') or '此DOCX没有可编辑正文')
    if not isinstance(changes, list) or not 1 <= len(changes) <= 20:
        raise ValueError('每次修改1至20个普通正文段落')
    originals = {p['key']: (i+1, p) for i, p in enumerate(opened['paragraphs'])}
    seen, result, size = set(), [], 0
    for change in changes:
        if not isinstance(change, dict) or set(change) != {'key', 'text'}:
            raise ValueError('正文修改须含固定段落编号与完整新文字')
        key, text = change['key'], change['text']
        if not isinstance(key, str) or key in seen or key not in originals:
            raise ValueError('段落不存在或重复，请重新读取固定版本')
        number, original = originals[key]
        if not original['editable'] or len(original['text']) > 4000:
            raise ValueError('复杂格式或超长段落只读，请用人工编辑器核对')
        if not isinstance(text, str) or len(text) > 4000 or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff]', text):
            raise ValueError('段落文字超过4000字或含非法字符')
        size += len(text)
        if size > 20000:
            raise ValueError('单次正文修改最多2万字')
        seen.add(key)
        result.append({'key': key, 'number': number, 'before': original['text'], 'after': text})
    return result


def read(_service, payload, context):
    import frappe
    from shangshu_files import document
    from shangshu_files.domain import versions
    try:
        if not payload.get('file') or type(payload.get('version')) is not int:
            raise ValueError('请选择固定文件版本')
        history = versions('files.versions', {'file': payload['file']}, context)
        opened = document.invoke('files.document', {'operation':'open', 'file':payload['file'], 'version':payload['version']}, context)
        result = {'file': history['file'], 'version': payload['version'], 'editable': opened['editable'], 'reason': opened['reason']}
        if 'changes' in payload:
            return {**result, 'changes': preview(opened, payload['changes'])}
        start, limit = payload.get('start', 1), payload.get('limit', 10)
        if type(start) is not int or type(limit) is not int or start < 1 or not 1 <= limit <= 20:
            raise ValueError('段落范围无效，每次最多读取20段')
        paragraphs = opened['paragraphs']
        values = [{**p, 'number': i+start, 'text': p['text'][:4000], 'truncated': len(p['text'])>4000,
                   'editable': opened['editable'] and p['editable'] and len(p['text'])<=4000}
                  for i, p in enumerate(paragraphs[start-1:start-1+limit])]
        return {**result, 'paragraphs': values, 'total': len(paragraphs),
                'next_start': start+len(values) if start+len(values)<=len(paragraphs) else None,
                'notice': '只读已有正文；复杂格式/超长段落只读，表格及页眉等保留原件。修改仅产生文件版本，不改变业务状态。'}
    except ValueError as error:
        frappe.throw(str(error), frappe.ValidationError)


def edit(payload):
    import frappe
    from shangshu_files import document, service
    doc = service._writable(payload.get('file'))
    if 'expected_version' not in payload or 'expected_modified' not in payload:
        frappe.throw('正文修改必须提供固定版本和文件修订', frappe.ValidationError)
    service.check_content_revision(doc, payload)
    reference = {'file': doc.name, 'version': payload['expected_version']}
    opened = document.invoke('files.document', {'operation':'open', **reference}, {})
    try:
        diff = preview(opened, payload.get('changes'))
        if all(c['before']==c['after'] for c in diff):
            raise ValueError('正文没有变化，不新增空版本')
    except ValueError as error:
        frappe.throw(str(error), frappe.ValidationError)
    encoded = document.invoke('files.document', {'operation':'encode', **reference, 'changes':payload['changes']}, {})
    result = service.new_version({'file':doc.name, 'expected_version':payload['expected_version'],
        'expected_modified':payload['expected_modified'], 'content_base64':encoded['content_base64'], 'note':payload.get('note','')})
    return {**result, 'changed_paragraphs': len(diff)}
