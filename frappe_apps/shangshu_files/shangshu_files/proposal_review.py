"""Excel review units use stable row IDs plus the actual current header name.

文件单元格审核：稳定行ID／列名；不引入业务字段、晋升或第二份值。
"""
from copy import deepcopy
import hashlib
import json

import frappe


def _cells(action_id,payload):
    return payload.get('cells') if action_id=='files.sheet_cells_write' else [
        {key:payload.get(key) for key in ('row_id','header','value')}]


def _id(cell):
    return 'cell-'+hashlib.sha256(json.dumps([cell['row_id'],cell['header']],ensure_ascii=False).encode()).hexdigest()[:32]


def _expected_versions(action_id, payload):
    if action_id == 'files.sheet_cells_write':
        return payload.get('expected_record_versions') or {}
    if 'expected_record_version' in payload:
        return {payload.get('row_id'): payload['expected_record_version']}
    return {}


def _prepare_cells(action_id, payload, state, request, cells, target):
    """Reuse the snapshot the core just checked; never read/rebase during prepare.

    Before any accepted write, retain the original read versions. After a real
    partial save, only the core's checked snapshot and persisted pending-value
    baselines authorize the next batch. The registered saver still checks these
    versions, so a race after that snapshot remains a conflict.
    """
    snapshot = request.get('snapshot')
    if (not isinstance(snapshot, dict) or snapshot.get('target') != target
            or not isinstance(snapshot.get('version'), dict)
            or not isinstance(snapshot.get('units'), list)):
        frappe.throw('缺少内核已核对的审核快照；本次未保存', frappe.ValidationError)
    version = snapshot['version']
    if (type(version.get('content_version')) is not int
            or type(version.get('structure_version')) is not int):
        frappe.throw('审核快照缺少可核实的版本；本次未保存', frappe.ValidationError)
    selected = request.get('units')
    known = {_id(cell): cell for cell in cells}
    units = {unit['unit_id']: unit for unit in snapshot['units']}
    if (not isinstance(selected, list) or not selected or len(set(selected)) != len(selected)
            or set(selected) - (set(known) & set(units))):
        frappe.throw('审核项无效、重复或未经过核对；本次未保存', frappe.ValidationError)
    if not snapshot.get('writable'):
        frappe.throw('当前表格不可写', frappe.PermissionError)
    original_versions = _expected_versions(action_id, payload)
    current_versions = version.get('record_versions') or {}
    rows = {known[uid]['row_id'] for uid in selected}
    if state.get('accepted'):
        baseline = state.get('baselines') or {}
        if (state.get('bound_target') != target or not state.get('operations')
                or any(uid not in baseline for uid in selected)):
            frappe.throw('已保存部分缺少可核实的后续审核基线，请重新提议；本次未保存',
                         frappe.TimestampMismatchError)
        # The core checks these same before-values before invoking prepare. Keep
        # the boundary explicit: a partial-state marker alone cannot rebase edits.
        if any(json.dumps(units[uid].get('comparison_value', units[uid].get('current_value')),
                          ensure_ascii=False, sort_keys=True, default=str)
               != json.dumps(baseline[uid], ensure_ascii=False, sort_keys=True, default=str)
               for uid in selected):
            frappe.throw('待审位置已被其他操作修改，请重新提议；本次未保存', frappe.TimestampMismatchError)
        expected_content = version['content_version']
        expected_versions = {rid: current_versions[rid] for rid in rows if rid in current_versions}
        if any(rid in original_versions and rid not in expected_versions for rid in rows):
            frappe.throw('审核快照缺少原受管记录的版本；本次未保存', frappe.TimestampMismatchError)
    else:
        expected_content = payload.get('expected_content_version')
        expected_versions = {rid: original_versions[rid] for rid in rows if rid in original_versions}
        if (version['content_version'] != expected_content
                or any(current_versions.get(rid) != value for rid, value in expected_versions.items())):
            frappe.throw('提案对应的原始记录已更新，请重新核对并提议；本次未保存',
                         frappe.TimestampMismatchError)
    if version['structure_version'] != payload.get('expected_structure_version'):
        frappe.throw('提案对应的表结构已更新，请重新提议；本次未保存', frappe.TimestampMismatchError)
    edits = request.get('edited_value') or {}
    selected_set = set(selected)
    selected_cells = [{**deepcopy(cell), 'value': deepcopy(edits.get(_id(cell), cell['value']))}
                      for cell in cells if _id(cell) in selected_set]
    result = {'table': payload['table'], 'expected_content_version': expected_content,
              'expected_structure_version': payload['expected_structure_version'], 'op_id': request['op_id']}
    if payload.get('sheet'):
        result['sheet'] = payload['sheet']
    if action_id == 'files.sheet_cells_write':
        result['cells'] = selected_cells
        if expected_versions:
            result['expected_record_versions'] = expected_versions
    else:
        result.update(selected_cells[0])
        if expected_versions:
            result['expected_record_version'] = expected_versions[selected_cells[0]['row_id']]
    return {'payload': result}


def review(action_id,payload,state,request,actor_user):
    from shangshu_files.service import proposal_guard
    operation=request['operation'];purpose=request.get('purpose','read')
    # 2026-10-21（agent 建表一线）：`files.create`（建表 ＋ 表头 ＋ 占位 ＋ 归属）
    # 也走逐项审核 —— **确认前看得见**（表名/每个表头/占位文字/归属逐项列出、逐项能改），
    # **一次确认、一次落库**。载荷形状跟格值那支不同 ⇒ 单开一支，不混进 `_cells`。
    if action_id=='files.create':
        return _create_table(payload,state,request,purpose,actor_user)
    # 合并说明（来自 fast 那版）：`files.edit_cells`（自由文件/工作簿里按行/列坐标改格）
    # 也走逐项审核。它是**另一种载荷形状**（file + changes[{sheet,row,column,value}]），
    # 与表格格值审核不是同一条路 —— 单开一支，不混进 `_cells`。
    if action_id=='files.edit_cells':
        return _free_cells(payload,request,purpose,actor_user)
    target={'module':'excel','table':payload['table']}
    if operation=='target':return target
    proposal_guard(action_id,payload,purpose,actor_user)
    if operation=='authorize':return None
    if operation=='bind':return target
    all_cells=_cells(action_id,payload)
    from shangshu_files.proposal_projection import project
    visible=project(action_id,payload)
    cells=_cells(action_id,visible['payload'])
    if not isinstance(cells,list) or not cells:
        frappe.throw('该提案没有可审核的格值',frappe.ValidationError)
    if len({_id(cell) for cell in cells})!=len(cells):
        frappe.throw('同一提案不能重复写同一个单元格',frappe.ValidationError)
    if operation=='legacy_edit':
        edited=request['edited_value']
        if len(cells)!=1 or not isinstance(edited,dict) or set(edited)!={'type','value'}:
            frappe.throw('多格提案请通过逐项审核入口修改指定候选值',frappe.ValidationError)
        return {_id(cells[0]):deepcopy(edited)}
    if operation=='prepare':
        return _prepare_cells(action_id,payload,state,request,cells,target)
    if operation!='describe':frappe.throw('未知的表格审核操作',frappe.ValidationError)
    from shangshu_files.sheet import read_payload
    read={'table':payload['table'],'row_ids':list(dict.fromkeys(c['row_id'] for c in cells))}
    if payload.get('sheet'):read['sheet']=payload['sheet']
    snapshot=read_payload(None,read,{'review_readonly':True})
    row_map={r['row_id']:r['values'] for r in snapshot['rows']}
    units=[]
    for cell in cells:
        rid,header=cell['row_id'],cell['header']
        if rid not in row_map or header not in row_map[rid]:
            frappe.throw('提案所在行或列已改变，请重新提议',frappe.TimestampMismatchError)
        units.append({'unit_id':_id(cell),'label':rid+' · '+header,'kind':'cell',
                      'target':{'row_id':rid,'header':header},
                      # 合并说明（2026-10-21）：**恢复 `editable` 标记** —— 合并时这一项被漏掉了，
                      # 而审核界面（`shangshu-web/js/proposal-review.js`）就是靠 `unit.editable`
                      # 决定「这一项能不能手工改值」⇒ 漏掉它，界面里**一项都不可编辑**。
                      # 表格格值**就是**逐项审核要改的东西（可写才可改；不可写时由核心的
                      # `can_accept` / `accept_unavailable_reason` 挡住采纳）。
                      'value':deepcopy(cell['value']),'current_value':deepcopy(row_map[rid][header]),
                      'editable':bool(snapshot.get('writable'))})
    record_versions = {row['row_id']: row['record_version'] for row in snapshot['rows']
                       if row.get('record_version')}
    expected_versions = _expected_versions(action_id,payload)
    return {'target':target,'units':units,'all_unit_ids':[_id(c) for c in all_cells],
            'review_scope':'currently_readable','writable':bool(snapshot.get('writable')),
            'version':{'content_version':snapshot['content_version'],
                       'structure_version':snapshot['structure_version'],'record_versions':record_versions},
            'initial_version_matches':payload.get('expected_content_version')==snapshot['content_version']
               and payload.get('expected_structure_version')==snapshot['structure_version']
               and all(record_versions.get(rid)==value for rid,value in expected_versions.items()
                       if rid in row_map)}


# ---- 建表（files.create）逐项审核：表名 / 每个表头 / 占位文字 / 归属 ----
#
# 2026-10-21（agent 建表一线）。**为什么单开一支**：`files.create` 的载荷形状
# （file_name + headers + placeholder + attribution）跟格值那支（cells）完全不同，
# 混进 `_cells` 只会把两件事搅在一起。
#
# **一次确认、一次落库**：采用哪几项就只落哪几项 —— 没采用的项**不写任何正式值**
# （不是"先建了再补"）。表已经建出来之后**不再接受第二次建表**
# （否则同一个提案会建出第二张表）。

CREATE_NAME = 'create-name'
CREATE_PLACEHOLDER = 'create-placeholder'
CREATE_ATTRIBUTION = 'create-attribution'


def _create_header_id(index):
    return 'create-header-%d' % index


def _attribution_text(attribution):
    """归属的**人话写法**：审核项上显示、也接受人改回来的那一份。

    `personal`（归你个人）／`personal:<账号>`（归某个具体的人）／
    `department:<部门ID>`（归某个部门）。
    """
    att = attribution or {}
    level = str(att.get('level') or '').strip()
    if level == 'department':
        return 'department:' + str(att.get('department') or '')
    if level == 'personal':
        owner = str(att.get('owner_user') or '').strip()
        return 'personal:' + owner if owner else 'personal'
    return level


def _parse_attribution_text(text, fallback):
    """把审核项里改回来的那句话还原成归属字典；认不出来就用原来那份。"""
    raw = str(text or '').strip()
    if not raw:
        return fallback
    level, _, detail = raw.partition(':')
    level = level.strip().lower()
    detail = detail.strip()
    if level == 'department':
        return {'level': 'department', 'department': detail}
    if level == 'personal':
        return {'level': 'personal', 'owner_user': detail} if detail else {'level': 'personal'}
    # 别的写法（譬如 enterprise）**照原样交下去** ⇒ `_apply_attribution`
    # 用用户原话拒（「尚书是单例，没有企业归属」），这层不另造口径。
    return {'level': level} if level else fallback


def _created_values(state):
    """这张表建出来了吗？建出来了就把**正式值**取回来（审核卡上显示「当前正式值」）。"""
    result = (state or {}).get('result') or {}
    if not result.get('file_id'):
        return None
    return {'file_id': result.get('file_id'), 'file_name': result.get('file_name'),
            'headers': list(result.get('headers') or []),
            'placeholder': result.get('placeholder'),
            'attribution': result.get('attribution') or {}}


def _create_units(payload, created):
    """建表的审核项：表名 / 每个表头 / 占位文字 / 归属。

    **形状照 `files.sheet_cells_write` 那一支**（`unit_id/label/kind/target/value/
    current_value/editable`）—— 前端的逐项审核卡只认这一种形状。
    """
    from shangshu_files.service import PLACEHOLDER_DEFAULT
    formal = list((created or {}).get('headers') or [])
    units = [{'unit_id': CREATE_NAME, 'label': '表名', 'kind': 'field',
              'target': {'field': 'file_name'},
              'value': str(payload.get('file_name') or ''),
              'current_value': (created or {}).get('file_name'), 'editable': True}]
    for index, header in enumerate(payload.get('headers') or []):
        units.append({'unit_id': _create_header_id(index),
                      'label': '表头 %d：%s' % (index + 1, header), 'kind': 'field',
                      'target': {'field': 'headers', 'index': index},
                      'value': str(header),
                      'current_value': formal[index] if index < len(formal) else None,
                      'editable': True})
    units.append({'unit_id': CREATE_PLACEHOLDER,
                  'label': '占位文字（写进前两行第一格）', 'kind': 'field',
                  'target': {'field': 'placeholder'},
                  'value': str(payload.get('placeholder') or PLACEHOLDER_DEFAULT),
                  'current_value': (created or {}).get('placeholder'), 'editable': True})
    units.append({'unit_id': CREATE_ATTRIBUTION,
                  'label': '归属（personal=归你个人；personal:某人=归某个人；department:部门=归某部门）',
                  'kind': 'field', 'target': {'field': 'attribution'},
                  'value': _attribution_text(payload.get('attribution')),
                  'current_value': _attribution_text((created or {}).get('attribution')),
                  'editable': True})
    return units


def _create_table(payload, state, request, purpose, actor_user):
    """`files.create` 的逐项审核：建表 ＋ 表头 ＋ 占位 ＋ 归属，逐项可改。

    **表名是这次操作的对象**（不是可取舍的内容项）：采用与否都用提案里的表名，
    人改了就用改后的；**归属必须被明确采用** —— 没采用就当场拒，
    不许悄悄替人默认一个（归属决定谁看得到，**猜错就是越权**）。
    """
    from shangshu_files.service import PLACEHOLDER_DEFAULT, proposal_guard
    operation = request['operation']
    if operation == 'target':
        return {'module': 'excel', 'name': str(payload.get('file_name') or '')}
    proposal_guard('files.create', payload, purpose, actor_user)
    if operation == 'authorize':
        return None
    created = _created_values(state)
    if operation == 'bind':
        result = request.get('result') or {}
        name = result.get('file_id') or result.get('file')
        return {'module': 'excel', 'file': name, 'table': name,
                'name': result.get('file_name') or payload.get('file_name')}
    units = _create_units(payload, created)
    if operation == 'describe':
        target = {'module': 'excel', 'name': str(payload.get('file_name') or '')}
        if created:
            target = {'module': 'excel', 'file': created['file_id'], 'table': created['file_id'],
                      'name': created['file_name']}
        return {'target': target, 'units': units,
                'all_unit_ids': [unit['unit_id'] for unit in units],
                # 表已经建出来了 ⇒ 不再接受第二次建表（否则同一个提案会建出第二张表）
                'writable': created is None,
                'version': {'create': 1},
                'initial_version_matches': True}
    if operation != 'prepare':
        frappe.throw('未知的建表审核操作', frappe.ValidationError)
    if created is not None:
        frappe.throw('这张表已经建好了（%s），不能再建一次；要改表头请到表里改'
                     % (created.get('file_name') or ''), frappe.ValidationError)
    selected = set(request.get('units') or [])
    edits = request.get('edited_value') or {}

    def value_of(unit_id, fallback):
        edited = edits.get(unit_id)
        return fallback if edited is None else edited

    file_name = str(value_of(CREATE_NAME, payload.get('file_name')) or '').strip()
    if not file_name:
        frappe.throw('建表必须先确认表名', frappe.ValidationError)
    result = {'file_name': file_name}
    # 表头：只落**被采用**的那几项（保持原顺序）；没采用的一列都不写。
    headers = []
    for index, header in enumerate(payload.get('headers') or []):
        unit_id = _create_header_id(index)
        if unit_id in selected:
            headers.append(str(value_of(unit_id, header) or '').strip())
    if headers:
        result['headers'] = headers
    # 占位文字：被采用才写（不采用 ⇒ 表里一个占位字都没有）。
    if CREATE_PLACEHOLDER in selected:
        result['placeholder'] = str(value_of(CREATE_PLACEHOLDER,
            payload.get('placeholder') or PLACEHOLDER_DEFAULT) or '').strip()
    # 归属：**必须被明确采用** —— 没采用就当场拒，不替人默认。
    if CREATE_ATTRIBUTION not in selected:
        frappe.throw('建表必须先确认归属：这张表归谁？① 归你个人 ② 归某个部门 ③ 归某个人',
                     frappe.ValidationError)
    attribution_text = str(value_of(CREATE_ATTRIBUTION,
        _attribution_text(payload.get('attribution'))) or '').strip()
    if not attribution_text:
        frappe.throw('建表必须先确认归属：这张表归谁？① 归你个人 ② 归某个部门 ③ 归某个人',
                     frappe.ValidationError)
    result['attribution'] = _parse_attribution_text(attribution_text,
        payload.get('attribution') or {'level': 'personal'})
    for key in ('directory', 'directory_id', 'tags', 'note'):
        if key in payload:
            result[key] = payload[key]
    return {'payload': result}


def _free_cells(payload,request,purpose,actor_user):
    """`files.edit_cells` 的逐项审核：自由文件（工作簿）里按行/列坐标的格值。

    合并说明（来自 fast 那版）：这一支按 fast 的**载荷形状**（file + changes）实现，
    但套用本分支的**调用协议**：`purpose` 代替 fast 的 `lock`、
    prepare 返回 `{'payload': …}`、describe 多回 `writable` / `all_unit_ids`。

    2026-10-21（版本口径修复）：**读的是「活内容」**（有工作副本就是工作副本那份，
    没有就是当前上传版本那份）—— 审核卡上的「当前值」必须是**用户眼前那份内容**的值，
    否则卡片显示的是旧值、采纳时写的是另一份内容。
    **过期判定用「上传版本号 ＋ 内容修订号」**（不再用 `doc.modified`：改个文件名也会
    推进它 ⇒ 内容没变却被判过期）。
    """
    from shangshu_files import workbook
    from shangshu_files.service import DOCTYPE,_writable,proposal_guard,upload_version
    from shangshu_files.working_file import content_revision
    operation=request['operation']
    proposal_guard('files.edit_cells',payload,purpose,actor_user)
    resolve=purpose=='resolve'
    doc=_writable(payload['file']) if resolve else frappe.get_doc(DOCTYPE,payload['file'])
    doc.check_permission('read')
    target={'module':'file-center','file':doc.name,'name':doc.file_name}
    if operation=='target':return target
    if operation=='authorize':return None
    if operation=='bind':return target
    version=upload_version(doc)
    revision=content_revision(doc)
    draft=_live_draft(doc)
    sheets={item['title']:item for item in draft['sheets']}
    def typed(value):
        return {'type':{'s':'text','n':'number','b':'boolean'}[value['t']],'value':value['v']} if value else {'type':'empty','value':None}
    units=[]
    for cell in payload['changes']:
        ws=sheets.get(cell['sheet']);row,col=cell['row'],cell['column']
        if not ws or not 1<=row<=ws['rows'] or not 1<=col<=ws['columns']:
            frappe.throw('原单元格已不存在，请重新提案',frappe.TimestampMismatchError)
        key=hashlib.sha256(json.dumps([cell['sheet'],row,col],ensure_ascii=False).encode()).hexdigest()[:32]
        units.append({'unit_id':key,'kind':'cell','label':f'{cell["sheet"]} · 第{row}行第{col}列',
            'target':{k:cell[k] for k in ('sheet','row','column')},'current_value':typed(ws['cells'][row-1][col-1]),
            'value':typed(cell['value']),'editable':bool(draft['editable'])})
    if operation=='describe':
        return {'target':target,'units':units,'all_unit_ids':[u['unit_id'] for u in units],
                'review_scope':'currently_readable','writable':bool(draft['editable']),
                'version':{'upload_version':version,'content_revision':revision},
                'initial_version_matches':payload.get('expected_version')==version
                   and payload.get('expected_content_revision')==revision}
    if operation=='legacy_edit':
        edited=request['edited_value']
        if len(units)!=1 or not isinstance(edited,dict) or set(edited)!={'type','value'}:
            frappe.throw('多格提案请通过逐项审核入口修改指定候选值',frappe.ValidationError)
        return {units[0]['unit_id']:deepcopy(edited)}
    if operation!='prepare':frappe.throw('未知的自由文件审核操作',frappe.ValidationError)
    if not draft['editable']:frappe.throw(draft['reason'] or '原件只读',frappe.PermissionError)
    changes=[]
    for cell,unit in zip(payload['changes'],units):
        if unit['unit_id'] not in request['units']:continue
        value=(request.get('edited_value') or {}).get(unit['unit_id'],unit['value'])
        if not isinstance(value,dict) or value.get('type') not in ('text','number','boolean','empty'):
            frappe.throw('单元格仅支持文字、数值、布尔或清空',frappe.ValidationError)
        native=None if value['type']=='empty' else {'t':{'text':'s','number':'n','boolean':'b'}[value['type']],'v':value.get('value')}
        changes.append({**deepcopy(cell),'value':native})
    return {'payload':{**deepcopy(payload),'expected_version':version,'expected_content_revision':revision,
                      'changes':changes}}


def _live_draft(doc):
    """这份表的**活内容**解码稿：有工作副本就是工作副本那份，没有就是当前上传版本那份。"""
    from shangshu_files import workbook, working_file
    from shangshu_files.service import upload_version
    if working_file.has_working_copy(doc):
        from shangshu_files import sheet as _sheet
        try:
            return workbook.decode(_sheet._content(doc, for_write=False))
        except ValueError as error:
            frappe.throw(str(error),frappe.ValidationError)
    return workbook.invoke('files.workbook',{'operation':'open','file':doc.name,
                          'version':upload_version(doc)},{})
