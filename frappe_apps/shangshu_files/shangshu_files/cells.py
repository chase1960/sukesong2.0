"""固定版本的有界单元格读取/变更；不是另一份表格存储或 AI 专用写通道。"""
import copy
import hashlib
import math


def apply_changes(workbook, changes):
    if not workbook.get('editable'):
        raise ValueError(workbook.get('reason') or '原文件只读，不能修改')
    if not isinstance(changes, list) or not 1 <= len(changes) <= 100:
        raise ValueError('每次须修改1至100个单元格')
    draft = copy.deepcopy(workbook)
    sheets = {s['title']: s for s in draft['sheets']}
    seen, diff = set(), []
    for change in changes:
        if not isinstance(change, dict) or set(change) != {'sheet', 'row', 'column', 'value'}:
            raise ValueError('单元格修改须含工作表、行、列和值')
        sheet = sheets.get(change['sheet'])
        row, col = change['row'], change['column']
        if not sheet or type(row) is not int or type(col) is not int or not 1 <= row <= sheet['rows'] or not 1 <= col <= sheet['columns']:
            raise ValueError('工作表或单元格坐标不存在，请先读取原表')
        key = (change['sheet'], row, col)
        if key in seen:
            raise ValueError('同一单元格不可重复修改')
        seen.add(key)
        value = change['value']
        if value is not None:
            if not isinstance(value, dict) or set(value) != {'t', 'v'}:
                raise ValueError('单元格值须为明确类型或null（清空）')
            kind, raw = value['t'], value['v']
            valid = (kind == 's' and isinstance(raw, str) and len(raw) <= 32767
                     or kind == 'n' and type(raw) in (int, float) and math.isfinite(raw) and abs(raw) <= 9007199254740991
                     or kind == 'b' and type(raw) is bool)
            if not valid:
                raise ValueError('首版仅支持文字、有限精度数值、布尔值和清空；公式不能执行')
        before = sheet['cells'][row-1][col-1]
        diff.append({'sheet': change['sheet'], 'row': row, 'column': col, 'before': before, 'after': value})
        sheet['cells'][row-1][col-1] = value
    return draft, diff


def read(_service, payload, context):
    import frappe
    from shangshu_files import workbook
    from shangshu_files.domain import versions
    try:
        if type(payload.get('version')) is not int or not payload.get('file'):
            raise ValueError('请选择固定文件版本')
        history = versions('files.versions', {'file': payload['file']}, context)
        draft = workbook.invoke('files.workbook', {'operation': 'open', 'file': payload['file'], 'version': payload['version']}, context)
        result = {'file': history['file'], 'version': payload['version'], 'editable': draft['editable'], 'reason': draft['reason'],
                  'sheets': [{k: s[k] for k in ('title', 'rows', 'columns')} for s in draft['sheets']]}
        if 'changes' in payload:
            _, result['changes'] = apply_changes(draft, payload['changes'])
            return result
        sheet = next((s for s in draft['sheets'] if s['title'] == payload.get('sheet', draft['sheets'][0]['title'])), None)
        row, col, rows, cols = (payload.get(k, v) for k, v in [('row', 1), ('column', 1), ('rows', 20), ('columns', 10)])
        if not sheet or any(type(n) is not int for n in (row, col, rows, cols)) or not 1 <= rows <= 50 or not 1 <= cols <= 20 \
                or not 1 <= row <= sheet['rows'] or not 1 <= col <= sheet['columns']:
            raise ValueError('读取范围无效，每次最多50行20列')
        selected = copy.deepcopy([r[col-1:col-1+cols] for r in sheet['cells'][row-1:row-1+rows]])
        # 长文只给显式摘要，避免把整份工作簿塞进上下文；不能当成完整原值。
        for r in selected:
            for value in r:
                if value and isinstance(value['v'], str) and len(value['v']) > 512:
                    value['v'] = value['v'][:512]; value['truncated'] = True
        return {**result, 'sheet': sheet['title'], 'row': row, 'column': col, 'cells': selected}
    except ValueError as error:
        frappe.throw(str(error), frappe.ValidationError)


def edit(payload, _context=None):
    """旧坐标载荷的薄适配；所有日常格值写都进入 sheet.write_cells。

    原上传版本和当前内容版本必须同时匹配。没有稳定行身份或非主工作表时明确拒绝，
    保留原件及只读能力，不能回落编解码后再整簿保存。
    """
    import frappe
    import json
    from shangshu_files import service, sheet
    doc = service._writable(payload.get('file'))
    service.check_live_revision(doc, payload)
    meta = sheet._load_meta(doc)
    if 'rows' not in meta or not meta.get('primary_sheet') or not meta.get('ss_clean'):
        frappe.throw('该工作簿尚无稳定行身份，需先显式迁移后编辑；原件未改动', frappe.ValidationError)
    changes = payload.get('changes')
    if not isinstance(changes, list) or not 1 <= len(changes) <= 100:
        frappe.throw('每次须修改1至100个单元格', frappe.ValidationError)
    content = sheet._content(doc, for_write=True)
    entry, _diagnostics = sheet._parsed(doc, content, incremental=True)
    title = entry.get('sheet_title') or meta.get('sheet_name')
    headers = entry['headers']
    rows = meta['rows']
    targets = []
    seen = set()
    try:
        for change in changes:
            if not isinstance(change, dict) or set(change) != {'sheet', 'row', 'column', 'value'}:
                raise ValueError('单元格修改须含工作表、行、列和值')
            if change['sheet'] != title:
                raise ValueError('当前受管编辑入口未支持此工作表，请先显式迁移；本次未保存')
            row, column = change['row'], change['column']
            if row == 1:
                raise ValueError('表头请使用明确的改表头动作，本次未保存')
            if type(row) is not int or type(column) is not int or not 2 <= row <= len(rows) + 1 or not 1 <= column <= len(headers):
                raise ValueError('单元格坐标不在已有稳定行列中，请先在表格中扩展；本次未保存')
            key = (row, column)
            if key in seen:
                raise ValueError('同一单元格不可重复修改')
            seen.add(key)
            targets.append({'row_id': rows[row - 2], 'header': headers[column - 1],
                            'value': _typed(change['value'])})
    except ValueError as error:
        frappe.throw(str(error), frappe.ValidationError)
    # 使用已核对的原请求版本生成退化幂等键，不能读新版本后把重试变成另一笔动作。
    identity = [doc.name, payload.get('expected_version'), payload.get('expected_content_revision'),
                str(frappe.session.user), changes]
    op_id = str(payload.get('op_id') or (_context or {}).get('idempotency_key') or '')
    if not op_id:
        op_id = 'office:' + hashlib.sha256(json.dumps(identity, ensure_ascii=False, sort_keys=True,
                                                        separators=(',', ':')).encode()).hexdigest()[:32]
    result = sheet.write_cells({'table': doc.name, 'sheet': meta['primary_sheet'], 'cells': targets,
        'op_id': op_id, 'expected_content_version': payload['expected_content_revision'],
        'expected_structure_version': int(meta.get('structure_version') or 1)}, _context)
    return {'file': doc.name, 'version': service.upload_version(doc),
            'upload_version': service.upload_version(doc), 'changed_cells': result['applied'],
            'content_revision': result['content_version'], 'op_id': op_id}


def _typed(value):
    """仅转换旧载荷；实际类型、规则、权限和受管值提交由统一写入口校验。"""
    if value is None:
        return {'type': 'empty', 'value': None}
    if not isinstance(value, dict) or set(value) != {'t', 'v'}:
        raise ValueError('单元格值须为明确类型或null（清空）')
    if not isinstance(value['t'], str):
        raise ValueError('单元格值类型无效')
    # ⚠️ **2026-10-28（PKG-132 收尾 · 清客户总表的日期列时撞出来的）**：
    #   **日期格以前写不进去**（类型标记只有 s／n／b ⇒ 写入口按列类型判时
    #   「定稿日期 须为日期」当场拒）⇒ **产品改不了日期列**。
    #   ⇒ 补上 `d`（值写 ISO 日期 `YYYY-MM-DD`；写入口那侧转成真日期并套上日期格式）。
    kind = {'s': 'text', 'n': 'number', 'b': 'boolean', 'd': 'date'}.get(value['t'])
    if not kind:
        raise ValueError('单元格值类型无效')
    return {'type': kind, 'value': value['v']}
