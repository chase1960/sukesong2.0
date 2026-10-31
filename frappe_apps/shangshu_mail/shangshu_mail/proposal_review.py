"""Mail defines review units; core alone owns proposal state and action execution.

既有草稿的逐字段审核；新建草稿沿原整单确认，不隐式创建或更换邮箱。
"""
from copy import deepcopy
import json

import frappe
from shangshu_mail import account
from shangshu_mail.domain import EDITABLE_FIELDS
from shangshu_core.public_api import get_record_attachments

FIELDS = ('mailbox','subject','to','cc','body','attachments')
LABELS = {'mailbox':'发件邮箱','subject':'主题','to':'收件人','cc':'抄送','body':'正文','attachments':'附件'}


def _json(value, default):
    return json.loads(value) if value else deepcopy(default)


def _formal(doc, actor_user):
    if not doc:
        return {'subject':'','body':'','body_format':'Text','to':[],'cc':[],
                'attachments':[],'inline_resources':[],'attachment_labels':[],
                'reply_to_mail':'','mailbox':account.account_name(actor_user)}
    labels=_json(doc.get('attachment_labels_json'),{})
    return {'subject':doc.get('subject') or '', 'body':doc.get('body') or '',
            'body_format':doc.get('body_format') or 'Text',
            'to':_json(doc.get('to_json'),[]),'cc':_json(doc.get('cc_json'),[]),
            'attachments':_json(doc.get('attachment_ids_json'),[]),
            'inline_resources':_json(doc.get('inline_resources_json'),[]),
            # Only editable display fields belong in a save_draft payload.
            # Server snapshot provenance must never be replayed as user input.
            'attachment_labels':[{'file':key,'label':value.get('label',''),
                                  **({'name':value['name']} if value.get('name') else {})}
                                 for key,value in labels.items() if isinstance(value,dict)],
            'reply_to_mail':doc.get('reply_to_mail') or '',
            'mailbox':doc.get('mailbox_id') or account.account_name(doc.owner)}


def review(action_id, payload, state, request, actor_user):
    from shangshu_mail.service import message, require_draft_edit, proposal_guard
    operation=request['operation'];purpose=request.get('purpose','read')
    name=(state.get('bound_target') or {}).get('mail') or payload.get('mail')
    if operation == 'target':
        return {'module':'mail','mail':name} if name else None
    if operation == 'authorize' and request.get('decision') == 'rejected':
        # Only discarding remaining suggestions can recover from an invalid or
        # deleted target. Ordinary review/accept still reads the actual draft.
        if name and not frappe.db.exists('Shangshu Mail Message',name):
            if not actor_user or actor_user != frappe.session.user:
                frappe.throw('只有原提案发起人可以放弃目标已不存在的邮件建议',frappe.PermissionError)
            result=state.get('result') or {}
            mailbox=result.get('mailbox_id') or payload.get('mailbox') or account.account_name(actor_user)
            account.require_right(mailbox,'edit_draft')
        else:
            proposal_guard(action_id,payload,'resolve',actor_user)
            if name:
                doc=message(name,lock=True)
                require_draft_edit(doc)
        return {'rejection_authorized':True}
    if name:
        doc=message(name,lock=purpose=='resolve')
        if purpose == 'resolve':require_draft_edit(doc)
    else:
        doc=None
        proposal_guard(action_id,payload,purpose,actor_user)
    if operation == 'authorize':return None
    formal=_formal(doc,actor_user)
    units=[]
    source_versions=[]
    for key in FIELDS:
        if key not in payload:continue
        current=formal[key]
        comparison=current
        if key=='body':comparison=[current,formal['body_format'],formal['inline_resources'],formal['reply_to_mail']]
        if key=='attachments':
            sources=[]
            for file_id in sorted(set(payload.get('attachments') or [])):
                source=frappe.get_doc('File',file_id,for_update=request.get('purpose')=='resolve')
                get_record_attachments(source.attached_to_doctype,source.attached_to_name,[file_id])
                # A working workbook is frozen when accepted, not on every
                # edit. Reject if it changed after this review was opened.
                sources.append([file_id,source.content_hash])
            source_versions=sources
            comparison=[current,formal['attachment_labels'],sources]
        units.append({'unit_id':key,'label':LABELS[key],
                      'kind':'html' if key=='body' and payload.get('body_format')=='HTML'
                             else 'list' if key in ('to','cc','attachments') else 'mailbox' if key=='mailbox' else 'text',
                      'value':deepcopy(payload[key]),'current_value':current,
                      'comparison_value':comparison,
                      # 合并说明（2026-10-21）：**恢复 `editable` 标记** ——
                      # 合并时这一项被漏掉了，而审核界面（`shangshu-web/js/proposal-review.js`）
                      # 就是靠 `unit.editable` 决定「这一项能不能手工改值」⇒ 漏掉它，
                      # 界面里**一项都不可编辑**（逐项审核等于只能整项采纳）。
                      # 口径与 fast 那条线一致：**只有主题与正文可手工改值**；
                      # 收件人/抄送/附件/发件邮箱**只允许整项采纳**（候选值照原样落），
                      # 不许借改值换目标或权限范围。
                      'editable':key in EDITABLE_FIELDS,
                      **({'body_format':payload.get('body_format') or 'Text'} if key=='body' else {}),
                      **({'requires_with_content':True,'dependency_note':'新共享邮箱须与至少一项非空内容同批确认；单独确认其他内容不能暗中接受邮箱'}
                         if key=='mailbox' and not doc and payload[key]!=formal['mailbox'] else {})})
    if operation=='describe':
        # 注意：这里**不**设 review_scope —— 邮件域的审核视图要回正式结果（core 按
        # review_scope 决定是否隐去 result）。表格域才设（它只投影当前可读的格）。
        return {'target':{'module':'mail','mail':name or None},'units':units,
                'version':{'mail':name,'version':int(doc.record_version) if doc else 0,
                           **({'attachment_sources':source_versions} if source_versions else {})},
                'initial_version_matches':not payload.get('mail') or payload.get('expected_version')==doc.record_version}
    if operation=='bind':
        result=request.get('result') or {}
        result_name=result.get('name')
        if not result_name:frappe.throw('草稿保存未返回可核对的邮件编号',frappe.ValidationError)
        if name and result_name!=name:frappe.throw('草稿保存返回了其他邮件，已回滚',frappe.ValidationError)
        # **邮件域往统一日志库写「确认」那一条**（§8 第 11 项）：
        # 「这封草稿的候选值被谁确认采纳了」—— 痕迹进统一日志库，**内容不进**。
        # ⚠ 写在哪一档：**bind**（内核执行成功、结果绑回邮件之后）——
        #   ① 只有到这里才知道**这封邮件的编号**（新建草稿的编号是执行之后才有的）
        #      ⇒ 这条记录才挂得住邮件这一行（「按这封信取日志」一次取齐三段）；
        #   ② 只有到这里才知道**确认真的过了**（执行失败会整体回滚）。
        # **写日志失败不许把确认搞没**：确认已经过了 ⇒ 失败只记日志，不往上抛。
        try:
            from shangshu_mail.mailprocess import record_review_confirmed
            plan=request.get('plan') or {}
            record_review_confirmed(result_name,
                                    source=str(request.get('source') or 'user'),
                                    units=plan.get('units') or [],
                                    case_ref=str(result.get('case_ref') or ''))
        except Exception as error:  # noqa: BLE001 —— 确认已过，痕迹写不上只通报
            try:
                frappe.logger('shangshu_mail').warning(
                    '确认已通过，但统一日志库那笔过程记录没写上：%s' % error)
            except Exception:  # noqa: BLE001 —— 连通报都失败也不许把正事搞没
                pass
        return {'module':'mail','mail':result_name}
    if operation=='legacy_edit':
        edited=request['edited_value']
        # 合并说明（2026-10-21）：整单确认的人工改值**两种载荷形状都认** ——
        #   fast ：{'type':'fields','value':{字段名: 值}}   ← 字段名 → 裸值
        #   我们 ：{字段名: {'type':..,'value':..}}          ← 字段名 → 带 type 的值对象
        # 两种都归一成 {字段名: 值} 交回内核（内核那边留痕并改写载荷）。
        unwrapped=False
        if isinstance(edited,dict) and edited.get('type')=='fields':
            inner=edited.get('value')
            if not isinstance(inner,dict):
                frappe.throw('整单确认的字段改写必须是 {type:fields, value:{字段名: 值}}',frappe.ValidationError)
            edited=inner
            unwrapped=True
        if not isinstance(edited,dict) or any(key not in FIELDS or key not in payload for key in edited):
            frappe.throw('只能修改原提案已有的邮件候选字段',frappe.ValidationError)
        # 合并说明（来自 fast 那版）：旧整单确认接口**只允许改主题与正文** ——
        # 不能借改值换目标、附件或权限范围。其余字段要走逐项审核入口。
        # 这份白名单与域声明的 `proposal_editable_fields`（见 domain.py）是**同一份**。
        if set(edited)-set(EDITABLE_FIELDS):
            frappe.throw('旧确认接口仅允许改主题与正文；其他字段请用逐项审核入口修改',frappe.PermissionError)
        result={}
        for key,value in edited.items():
            if isinstance(value,dict) and set(value)=={'type','value'}:
                result[key]=value['value']
            elif unwrapped:
                # fast 那条线的形状：字段名 → 裸值（外层的 type:fields 已经说明了这是字段映射）。
                result[key]=value
            else:
                # 我们这条线的形状：字段名 → 带 type/value 的值对象。**裸值明确拒**
                # （判不出是哪种形状，不猜）。
                frappe.throw('旧确认接口 edited_value 必须是带 type/value 的字段映射',frappe.ValidationError)
        return result
    if operation!='prepare':frappe.throw('未知的邮件审核操作',frappe.ValidationError)
    if doc and doc.status!='Draft':frappe.throw('只有草稿可以接受候选值',frappe.ValidationError)
    selected=request['units'];edits=request.get('edited_value') or {}
    # 合并说明（2026-10-21）：**手工改值只许改主题与正文** ——
    # 收件人/抄送/附件/发件邮箱**只允许整项采纳**（候选值照原样落）。
    # 合并时 fast 那条线这道闸在逐项审核口、本分支那道闸在整单确认口，**两边各有一半**；
    # 现在两道口用**同一份白名单**（`EDITABLE_FIELDS`，与域声明的 `proposal_editable_fields` 同一份）。
    # 理由：借「改候选值」换收件人或权限范围，等于让改值绕过「这项候选是谁提的」这道确认。
    if set(edits)-set(EDITABLE_FIELDS):
        frappe.throw('仅主题与正文允许人工改值；不能借改值换收件人、附件或发件邮箱',frappe.PermissionError)
    result=deepcopy(formal)
    for key in selected:
        value=deepcopy(edits[key] if key in edits else payload[key])
        # The original registered schema performs the final type/length validation.
        result[key]=value
        if key=='body':
            result['body_format']=payload.get('body_format') or formal['body_format']
            result['inline_resources']=deepcopy(payload.get('inline_resources') or [])
            result['reply_to_mail']=payload.get('reply_to_mail') or ''
        elif key=='attachments':result['attachment_labels']=deepcopy(payload.get('attachment_labels') or [])
    if not doc and payload.get('mailbox') and payload['mailbox']!=formal['mailbox'] and 'mailbox' not in selected:
        frappe.throw('这封新草稿指定了其他邮箱，请连同邮箱及至少一项内容一起确认，不能暗中改用个人邮箱',frappe.ValidationError)
    if doc:
        result.update(mail=doc.name,expected_version=int(doc.record_version))
    elif not payload.get('mailbox'):
        # Let the ordinary before_insert assign this authenticated user's personal
        # mailbox. No reviewer/actor ownership is invented by this hook.
        result.pop('mailbox',None)
    # Empty reply context is not a field to invent; the ordinary save action
    # leaves existing links alone if absent, while nonempty known links survive.
    if not result.get('reply_to_mail'):result.pop('reply_to_mail',None)
    # ⚠ **多带一个 `units`**：这一轮**确认了哪几项**（只带字段 id，**不带值**）——
    #   业务载荷 `payload` 一个字没动（内核只读它）；`plan` 整份会传给 `bind` 那一口
    #   ⇒ 「确认」那条日志才说得清这一轮是整单确认还是逐项审核。
    return {'payload':result,'units':[str(unit) for unit in (request.get('units') or [])]}
