"""领域操作的受控审计接入；领域不得直接操作核心审计 DocType。"""
import frappe

from shangshu_core.actions import _definition, _assert_action_role, _summary, _canonical
from shangshu_core.domains import raw_resource
from shangshu_core.identity import get_identity
from shangshu_core import unified_log


def query_domain_action_audits(action_id, filters=None, scope='self'):
    """可信领域读取本域审计摘要；员工仅本人，all 仅系统管理员。"""
    from shangshu_core.field_access import enforced_row_scope
    owner, _ = raw_resource('actions', action_id)
    if not owner or getattr(frappe.flags, 'shangshu_call_domain', None) != owner['id']:
        frappe.throw('只能在所属领域执行上下文查询本域动作事实', frappe.PermissionError)
    get_identity()
    scoped = enforced_row_scope(dict(filters or {}), scope, frappe.session.user,
                                'System Manager' in frappe.get_roles())
    scoped['action_id'] = action_id
    # **统一日志库**：旧表的历史行 ＋ 统一表的新行 ⇒ 形状不变。
    return unified_log.merged_legacy_rows('Shangshu Action Execution Audit', 'action', filters=scoped,
        fields=['name', 'idempotency_key', 'input_summary_json', 'actor_user',
                'creation', 'status', 'action_id'], order_by='creation asc', limit_page_length=500)


def get_action_request_status(idempotency_key):
    """只读恢复入口；旧审计不被伪装成可自动重放的完整执行结果。"""
    from shangshu_core.action_requests import find_request

    identity = get_identity()
    request = find_request(idempotency_key)
    if request:
        if request.actor_identity != identity.name or request.enterprise_id != identity.enterprise_id:
            frappe.throw("当前用户无权读取该执行记录", frappe.PermissionError)
        action = _definition(request.action_id, request.action_version)
        _assert_action_role(action)
        return {"status": request.status, "action_id": request.action_id,
                "action_version": request.action_version, "audit": request.execution_audit,
                "replay_available": request.status == "Succeeded", "legacy": False,
                # 失败原因随回执可查（回执丢失恢复路径要知道为什么失败，不只是失败了）
                "failure_reason": (request.failure_reason if request.status == "Failed" else "")}
    receipt = get_action_receipt(idempotency_key)
    if not receipt:
        return {"status": "NotFound", "replay_available": False, "legacy": False}
    _assert_action_role(_definition(receipt.action_id, receipt.action_version))
    reference = None
    if receipt.reference_doctype and receipt.reference_name:
        frappe.get_doc(receipt.reference_doctype, receipt.reference_name).check_permission("read")
        reference = {"doctype": receipt.reference_doctype, "name": receipt.reference_name}
    return {"status": receipt.status, "action_id": receipt.action_id,
            "action_version": receipt.action_version, "audit": receipt.name,
            "reference": reference, "legacy": True, "replay_available": False,
            "next_step": "核对原业务记录；旧审计不证明完整输入相同，不要换键重复执行"}


def get_action_receipt(idempotency_key):
    """按幂等键取回执（**统一日志表的新行 ＋ 旧表的历史行**；形状不变）。"""
    rows = unified_log.unified_rows("action", {"idempotency_key": idempotency_key})
    if rows:
        receipt = unified_log.LegacyRow(unified_log.project_action_row(rows[0]))
        receipt["doctype"] = "Shangshu Action Execution Audit"
        if receipt.get("actor_identity") != get_identity().name:
            frappe.throw("幂等键属于其他执行身份", frappe.PermissionError)
        return receipt
    name = frappe.db.get_value("Shangshu Action Execution Audit", {"idempotency_key": idempotency_key}, "name")
    if not name:
        return None
    receipt = frappe.get_doc("Shangshu Action Execution Audit", name)
    if receipt.actor_identity != get_identity().name:
        frappe.throw("幂等键属于其他执行身份", frappe.PermissionError)
    return receipt


def record_action_receipt(action_id, reference_doctype, reference_name, input_summary,
                          result_summary, idempotency_key, confirmation_text=""):
    from shangshu_core.action_provenance import current_action_provenance
    domain, resource = raw_resource("actions", action_id)
    if not domain or not resource:
        frappe.throw("审计动作未注册", frappe.ValidationError)
    pinned = getattr(frappe.flags, "shangshu_action_pin", None) or {}
    version = pinned.get("action_version") if pinned.get("action_id") == action_id else None
    action = _definition(action_id, version)
    _assert_action_role(action)
    if action.confirmation_policy == "required" and not confirmation_text:
        frappe.throw("该动作需要确认凭据", frappe.ValidationError)
    frappe.get_doc(reference_doctype, reference_name).check_permission("read")
    previous = get_action_receipt(idempotency_key)
    if previous:
        if previous.action_id != action_id:
            frappe.throw("幂等键已用于其他动作", frappe.ValidationError)
        return previous
    # **统一日志库**（PKG-020-T01）：回执只写统一表这一处；
    # 旧表保留表结构与历史行，不再新增。
    legacy_row = {
        "action_id":action_id, "action_version":action.action_version,
        "actor_identity":get_identity().name, "actor_user":frappe.session.user,
        "reference_doctype":reference_doctype, "reference_name":reference_name,
        "input_summary_json":_canonical(_summary(input_summary)),
        "result_summary_json":_canonical(_summary(result_summary)),
        "source_snapshot_json":_canonical(current_action_provenance(action_id)),
        "confirmed":1 if confirmation_text else 0, "confirmation_text":confirmation_text,
        "idempotency_key":idempotency_key, "status":"Succeeded", "duration_ms":0,
    }
    doc = unified_log.write_log(
        kind="action", what_id=action_id, domain_id=domain["id"],
        actor_user=frappe.session.user, actor_identity=get_identity().name,
        trigger_source="user", result="Succeeded",
        reference_doctype=reference_doctype, reference_name=reference_name,
        idempotency_key=idempotency_key,
        detail={
            "input_summary": _summary(input_summary),
            "result_summary": _summary(result_summary),
            "action_version": action.action_version,
            "confirmed": legacy_row["confirmed"],
            "confirmation_text": confirmation_text,
            "source_snapshot": current_action_provenance(action_id),
            # 旧形状快照：旧读口按它投影回去 ⇒ 既有返回形状不变。
            "legacy": legacy_row,
        })
    return unified_log.LegacyRow({**legacy_row, "name": doc.name,
                                  "doctype": "Shangshu Action Execution Audit"})


def list_reference_audits(references):
    result = []
    for reference in references:
        doctype, name = reference
        frappe.get_doc(doctype, name).check_permission("read")
        result.extend(unified_log.merged_legacy_rows("Shangshu Action Execution Audit", 'action',
                                    filters={"reference_doctype":doctype,"reference_name":name},
                                    fields=["name","action_id","actor_user","confirmed","confirmation_text","status","creation"],
                                    order_by="creation asc"))
    return sorted(result, key=lambda row: str(row.creation))


def query_action_fact_audits(action_id, filters=None, scope="self"):
    """受管事实查询：独立日志授权、当前企业范围、固定投影和上限。"""
    from shangshu_core.audit_access import audit_query_filters
    allowed = {"actor_user", "idempotency_key", "status", "creation", "name"}
    filters = dict(filters or {})
    if set(filters) - allowed:
        frappe.throw("审计筛选字段不支持", frappe.ValidationError)
    filters = audit_query_filters(filters, scope)
    filters["action_id"] = action_id
    # **统一日志库**：旧表的历史行 ＋ 统一表的新行 ⇒ 形状不变。
    return unified_log.merged_legacy_rows("Shangshu Action Execution Audit", 'action', filters=filters,
        fields=["name", "idempotency_key", "input_summary_json", "result_summary_json", "actor_user", "creation", "status", "action_id", "executor_source"],
        order_by="creation asc", limit_page_length=500)


def query_action_audits(filters=None, page=1, page_length=50):
    """All registered-action audit rows in the caller's independent log scope.

    Returns existing immutable evidence, not reconstructed cell history. Summary
    fields retain their original truncation/redaction semantics. No conversation
    text is inferred from an actor, a nearby timestamp, or client-supplied text.
    """
    from shangshu_core.audit_access import audit_query_filters
    values = dict(filters or {}) if isinstance(filters, (dict,type(None))) else None
    allowed = {'actor_user','action_id','status','executor_source','name','idempotency_key','conversation_key'}
    if values is None or set(values) - allowed:
        frappe.throw('日志筛选字段不支持', frappe.ValidationError)
    for key,value in values.items():
        if not isinstance(value,str) or not value.strip() or len(value)>200:
            frappe.throw('日志筛选仅支持非空精确值', frappe.ValidationError)
    try:
        p, size = int(page), int(page_length)
    except (TypeError,ValueError):
        frappe.throw('日志分页参数无效', frappe.ValidationError)
    if isinstance(page,bool) or isinstance(page_length,bool) or p<1 or size<1 or size>200:
        frappe.throw('日志页码须大于0，每页1至200条', frappe.ValidationError)
    scoped = audit_query_filters(values, 'managed')
    fields = ['name','action_id','action_version','actor_identity','actor_user','executor_source',
              'creation','status','duration_ms','input_summary_json','result_summary_json',
              'record_changes_json','reference_doctype','reference_name','confirmed',
              'confirmation_text','idempotency_key','source_snapshot_json','package','conversation_key']
    # **统一日志库**：旧表的历史行 ＋ 统一表的新行 ⇒ 形状不变（总数也合起来算）。
    total = unified_log.merged_legacy_count('Shangshu Action Execution Audit', 'action', scoped)
    rows = unified_log.merged_legacy_rows('Shangshu Action Execution Audit', 'action', filters=scoped,
        fields=fields, order_by='creation desc, name desc',
        limit_start=(p-1)*size, limit_page_length=size)
    items = _project_action_audit_items(rows)
    return {'items':items,'total':total,'page':p,'page_length':size,
            'has_more':p*size<total,'scope':'managed','llm_calls':0}


def _project_action_audit_items(rows):
    import json
    import re
    from shangshu_core.action_provenance import project_action_provenance
    items=[]
    def decode(raw):
        if not raw:return None
        try:return json.loads(raw)
        except (ValueError,TypeError):return None
    for row in rows:
        inp=decode(row.get('input_summary_json'))
        confirmation=str(row.get('confirmation_text') or '')
        proposal=re.match(r'^提案\s+(APROP-[A-Za-z0-9-]+)\s',confirmation)
        items.append({'audit':row['name'],'action_id':row.get('action_id'),
            'action_version':row.get('action_version'),
            'actor':{'user':row.get('actor_user'),'identity_id':row.get('actor_identity')},
            'source':row.get('executor_source') or 'unknown',
            'source_provenance':'recorded_executor_label',
            'execution_provenance':project_action_provenance(row.get('source_snapshot_json')),
            'time':str(row.get('creation') or ''),
            'status':row.get('status'),'duration_ms':row.get('duration_ms'),
            'idempotency_key':row.get('idempotency_key'),
            'op_id':inp.get('op_id') if isinstance(inp,dict) else None,
            'input_summary':inp,'result_summary':decode(row.get('result_summary_json')),
            'record_changes':decode(row.get('record_changes_json')),
            'package':row.get('package'),
            'snapshot_kind':'persisted_audit_summary',
            'record':{'doctype':row.get('reference_doctype'),'name':row.get('reference_name')},
            'confirmed':bool(row.get('confirmed')),'confirmation':confirmation,
            'proposal_reference':proposal.group(1) if proposal else None,
            'conversation_evidence':{'status':'linked' if row.get('conversation_key') else 'not_linked','reference':row.get('conversation_key') or None}})
    return items


def query_business_audits(object_id, business_name=None, page=1, page_length=50):
    """**按受管记录取日志**（2026-10-22 收进内核的公共能力）。

    为什么要有这个口（用户 2026-10-22 原话）：
    「为了让『日志』这一块能按案件看，内核还需补两个口——让动作审计与事件能正式挂到
      受管记录上（与流程那个 `business_object_id` 同款思路），以及让域能按业务标识
      取到这些记录；**在这之前，前端的日志块最多只能看全局流水，看不到某一个案子**。」

    授权：**与全局流水同一套独立日志授权**（`audit_query_filters`）——
    按业务标识缩小范围**不放宽权限**：看不到的员工的日志，照样看不到。
    唯一事实仍在**内核那一份审计与事件信封**；这里只是**按业务标识取出来**。

    返回：动作审计行 ＋ 事件信封行，**每条都带来源编号**（可点回原始记录）。
    """
    import json

    from shangshu_core.audit_access import audit_query_filters
    object_id = str(object_id or "").strip()
    if not object_id:
        frappe.throw("请指定受管对象 ID", frappe.ValidationError)
    if business_name is not None:
        business_name = str(business_name).strip()
        if not business_name:
            frappe.throw("受管记录名无效", frappe.ValidationError)
    try:
        p, size = int(page), int(page_length)
    except (TypeError, ValueError):
        frappe.throw("日志分页参数无效", frappe.ValidationError)
    if isinstance(page, bool) or isinstance(page_length, bool) or p < 1 or size < 1 or size > 200:
        frappe.throw("日志页码须大于0，每页1至200条", frappe.ValidationError)

    scoped = audit_query_filters({}, "managed")
    audit_filters = dict(scoped)
    audit_filters["business_object_id"] = object_id
    if business_name:
        audit_filters["business_name"] = business_name
    # **统一日志库**：旧表的历史行 ＋ 统一表的新行 ⇒ 形状不变。
    audit_rows = unified_log.merged_legacy_rows("Shangshu Action Execution Audit", 'action', filters=audit_filters,
        fields=["name", "action_id", "action_version", "actor_user", "creation", "status",
                "executor_source", "business_object_id", "business_name", "result_summary_json", "package"],
        order_by="creation desc, name desc", limit_start=(p - 1) * size, limit_page_length=size)

    def decode(raw):
        if not raw:
            return None
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return None

    items = []
    for row in audit_rows:
        package = row.get("package")
        summary = decode(row.get("result_summary_json"))
        matched_names = set()
        if isinstance(package, dict):
            # 记录/对象视图只投影本次筛选的目标，不泄露同包其他对象、记录或输入摘要。
            count = 0
            for step in package.get("steps", []):
                for change in step.get("record_changes", []):
                    data = change.get("data") or {}
                    if data.get("object_id") == object_id and (not business_name or change.get("name") == business_name):
                        matched_names.add(change.get("name"))
                        count += len(data.get("changes") or [])
            summary = {"record_count": len(matched_names), "change_count": count, "scope": "requested_target"}
        items.append({
            "kind": "action_audit",
            "audit": row.get("name"),
            "source_id": row.get("name"),
            "action_id": row.get("action_id"),
            "action_version": row.get("action_version"),
            "actor": {"user": row.get("actor_user")},
            "time": str(row.get("creation") or ""),
            "status": row.get("status"),
            "source": row.get("executor_source") or "unknown",
            "business_object_id": object_id if package else str(row.get("business_object_id") or ""),
            "business_name": str(business_name or "") if package else str(row.get("business_name") or ""),
            "result_summary": summary,
        })

    # 事件信封：**同一件事的另一半**（业务判断与投递结论在信封里，域不再抄第二份）。
    event_filters = dict(scoped)
    event_filters["business_object_id"] = object_id
    if business_name:
        event_filters["business_name"] = business_name
    event_rows = frappe.get_all("Shangshu Event Envelope", filters=event_filters,
        fields=["name", "event_id", "event_version", "actor_user", "published_at", "status",
                "business_object_id", "business_name", "payload_json"],
        order_by="published_at desc, name desc", limit_start=(p - 1) * size, limit_page_length=size)
    for row in event_rows:
        items.append({
            "kind": "event_envelope",
            "audit": row.get("name"),
            "source_id": row.get("name"),
            "event_id": row.get("event_id"),
            "event_version": row.get("event_version"),
            "actor": {"user": row.get("actor_user")},
            "time": str(row.get("published_at") or ""),
            "status": row.get("status"),
            "business_object_id": str(row.get("business_object_id") or ""),
            "business_name": str(row.get("business_name") or ""),
            "payload": decode(row.get("payload_json")),
        })
    items.sort(key=lambda item: item.get("time") or "", reverse=True)
    return {"items": items, "page": p, "page_length": size,
            "object_id": str(object_id or ""),
            # ⚠️ 没指定记录名时是**空串**（不是 null）—— 动作回执的 schema 校验
            # 要求文本字段（null ⇒ 整个调用被拒）。2026-10-22 在 3850 上实测踩到。
            "business_name": str(business_name or ""),
            "scope": "managed", "llm_calls": 0}


def _audit_row(name):
    """按名字取一行审计（**统一表的新行 ＋ 旧表的历史行**；形状不变）。"""
    if frappe.db.exists(unified_log.LOG_DOCTYPE, name):
        rows = unified_log.unified_rows("action", {"name": name})
        if rows:
            return unified_log.LegacyRow(unified_log.project_action_row(rows[0]))
    if frappe.db.exists('Shangshu Action Execution Audit', name):
        return frappe.get_doc('Shangshu Action Execution Audit', name)
    return None


def _audit_row_by_idempotency(idempotency_key, actor):
    """按幂等键取一行审计（**统一表的新行 ＋ 旧表的历史行**；形状不变）。"""
    found = []
    for row in unified_log.unified_rows("action", {"idempotency_key": idempotency_key}):
        legacy = unified_log.project_action_row(row)
        if legacy.get("actor_identity") == actor["identity_id"] and legacy.get("actor_user") == actor["user"]:
            found.append(unified_log.LegacyRow(legacy))
    if not found:
        names = frappe.get_all('Shangshu Action Execution Audit', filters={
            'idempotency_key': idempotency_key, 'actor_identity': actor['identity_id'],
            'actor_user': actor['user']}, pluck='name', limit_page_length=2)
        if len(names) > 1:
            frappe.throw('请求存在多个回执，不能唯一追溯', frappe.ValidationError)
        if names:
            found.append(frappe.get_doc('Shangshu Action Execution Audit', names[0]))
    if len(found) > 1:
        frappe.throw('请求存在多个回执，不能唯一追溯', frappe.ValidationError)
    return found[0] if found else None


def get_audit_proposal(user, proposal_id):
    """Read decision/receipt evidence under log authority, never review authority.

    No candidate values, payload, summary, edit text or decision capabilities are
    returned. References come from persisted core proposal state, not the caller.
    """
    import json
    from shangshu_core.audit_access import authorize_audit_actor
    from shangshu_core.action_provenance import project_action_provenance
    actor = authorize_audit_actor(user)
    if not isinstance(proposal_id,str) or not proposal_id or len(proposal_id)>140:
        frappe.throw('请指定有效提案', frappe.ValidationError)
    proposal = frappe.get_doc('Shangshu Action Proposal',proposal_id)
    if proposal.actor_user != actor['user'] or proposal.enterprise_id != actor['enterprise_id']:
        frappe.throw('该提案不在当前日志授权范围内',frappe.PermissionError)
    try:
        state = json.loads(proposal.get('review_state_json') or '{}')
    except (TypeError,ValueError):
        state = {}
    if not isinstance(state,dict):state={}
    accepted = state.get('accepted') or {}
    if not isinstance(accepted,dict):accepted={}
    decisions = [{'unit_id':key,'by':value.get('by'),'at':str(value.get('at') or ''),'audit':value.get('audit')}
                 for key,value in accepted.items() if isinstance(value,dict)]
    audit_ids = list(dict.fromkeys([p for p in [proposal.get('execution_audit'),
                    *[d.get('audit') for d in decisions]] if isinstance(p,str) and p]))
    # Metadata only. Bound the response; full audit rows remain individually
    # accessible through the same independent scoped action_audits query.
    rows = unified_log.merged_legacy_rows('Shangshu Action Execution Audit', 'action',
        filters={'name':['in',audit_ids[:200]]},
        fields=['name','action_id','action_version','actor_user','creation','status','executor_source'],
        order_by='creation asc, name asc',limit_page_length=200) if audit_ids else []
    receipts=[{'audit':r['name'],'action_id':r.get('action_id'),'action_version':r.get('action_version'),
               'actor_user':r.get('actor_user'),'time':str(r.get('creation') or ''),'status':r.get('status'),
               'source':r.get('executor_source') or 'unknown','source_provenance':'recorded_executor_label'} for r in rows]
    return {'scope':'audit_only','can_confirm':False,'payload_included':False,
            'proposal':{'id':proposal.name,'action_id':proposal.action_id,'action_version':proposal.action_version,
                        'actor_user':proposal.actor_user,'status':str(proposal.status or '').lower(),
                        'created_at':str(proposal.get('creation') or ''),
                        'decision_by':proposal.get('decision_by'),'decision_at':str(proposal.get('decision_at') or ''),
                        'execution_audit':proposal.get('execution_audit'),
                        'source_provenance':project_action_provenance(proposal.get('source_snapshot_json'))},
            'accepted_count':len(decisions),'accepted':decisions[:200],
            'accepted_truncated':len(decisions)>200,'receipts':receipts,
            'receipt_count':len(audit_ids),'receipts_truncated':len(audit_ids)>200}


def _request_audit_trace(request_id, actor):
    """已获日志读权的请求映射；不解密结果、不锁请求，不借 child key 放宽包权限。"""
    from shangshu_core.action_requests import request_name
    request = frappe.db.get_value('Shangshu Action Request', request_name(request_id),
        ['actor_identity', 'enterprise_id', 'action_id', 'action_version', 'status', 'execution_audit'], as_dict=True)
    if not request:
        return None
    if request.actor_identity != actor['identity_id'] or request.enterprise_id != actor['enterprise_id']:
        frappe.throw('该请求不在当前日志授权范围内', frappe.PermissionError)
    if request.status != 'Succeeded' or not request.execution_audit:
        return None
    audit = _audit_row(request.execution_audit)
    if audit is None or audit.actor_identity != actor['identity_id'] or audit.actor_user != actor['user']:
        frappe.throw('该请求的审计不在当前日志授权范围内', frappe.PermissionError)
    direct = (audit.idempotency_key == request_id and audit.action_id == request.action_id
              and audit.get('action_version') == request.action_version)
    package = audit.get('package') or {}
    linked = isinstance(package, dict) and package.get('version') == 1 and any(
        isinstance(step, dict) and step.get('idempotency_key') == request_id
        and step.get('action_id') == request.action_id and step.get('action_version') == request.action_version
        for step in package.get('steps', []))
    if not direct and not linked:
        frappe.throw('请求与包日志步骤不一致，不能追溯', frappe.ValidationError)
    return {'status': 'linked', 'scope': 'audit_only', 'can_confirm': False,
            'actor_user': actor['user'], 'request_id': request_id, 'action_id': request.action_id,
            'root_action_id': audit.action_id, 'proposal_id': None, 'operation_id': audit.name}


def get_audit_trace(user, operation_id=None, request_id=None):
    """Exact, read-only recovery of persisted execution links, never execution.

    operation_id is an audit document name, not a client-provided cell op_id.
    A request key proves a persisted link only; Node must also match its own
    immutable request journal before presenting conversation evidence.
    """
    import json
    import re
    from shangshu_core.audit_access import authorize_audit_actor
    actor = authorize_audit_actor(user)
    if bool(operation_id) == bool(request_id):
        frappe.throw('请精确指定一个审计编号或请求编号', frappe.ValidationError)
    value = operation_id or request_id
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        frappe.throw('追溯编号无效', frappe.ValidationError)
    proposal = None
    audit = None
    if request_id:
        names = frappe.get_all('Shangshu Action Proposal', filters={
            'idempotency_key': request_id, 'actor_user': actor['user'],
            'actor_identity': actor['identity_id'], 'enterprise_id': actor['enterprise_id']},
            pluck='name', limit_page_length=2)
        if len(names) > 1:
            frappe.throw('请求存在多个提案，不能唯一追溯', frappe.ValidationError)
        if names:
            proposal = frappe.get_doc('Shangshu Action Proposal', names[0])
        else:
            request_trace = _request_audit_trace(request_id, actor)
            if request_trace:
                return request_trace
            audit = _audit_row_by_idempotency(request_id, actor)
    else:
        audit = _audit_row(operation_id)
        if audit is not None:
            names = frappe.get_all('Shangshu Action Proposal', filters={
                'execution_audit': operation_id, 'actor_user': actor['user'],
                'actor_identity': actor['identity_id'], 'enterprise_id': actor['enterprise_id']},
                pluck='name', limit_page_length=2)
            if len(names) > 1:
                frappe.throw('审计存在多个提案，不能唯一追溯', frappe.ValidationError)
            if names:
                proposal = frappe.get_doc('Shangshu Action Proposal', names[0])
            else:
                match = re.match(r'^提案\s+(APROP-[A-Za-z0-9-]+)\s', audit.get('confirmation_text') or '')
                if match and frappe.db.exists('Shangshu Action Proposal', match.group(1)):
                    candidate = frappe.get_doc('Shangshu Action Proposal', match.group(1))
                    try:
                        state = json.loads(candidate.get('review_state_json') or '{}')
                    except (TypeError, ValueError):
                        state = {}
                    accepted = state.get('accepted', {}) if isinstance(state, dict) else {}
                    if isinstance(accepted, dict) and any(isinstance(v, dict) and v.get('audit') == operation_id for v in accepted.values()):
                        proposal = candidate
    if proposal:
        if (proposal.actor_user != actor['user'] or proposal.actor_identity != actor['identity_id']
                or proposal.enterprise_id != actor['enterprise_id']):
            frappe.throw('该追溯不在当前日志授权范围内', frappe.PermissionError)
        if audit and audit.action_id != proposal.action_id:
            frappe.throw('提案与审计动作不一致', frappe.ValidationError)
        return {'status': 'linked', 'scope': 'audit_only', 'can_confirm': False,
                'actor_user': actor['user'], 'request_id': proposal.idempotency_key,
                'action_id': proposal.action_id, 'proposal_id': proposal.name,
                'operation_id': audit.name if audit else proposal.get('execution_audit') or None}
    if audit:
        if audit.actor_identity != actor['identity_id'] or audit.actor_user != actor['user']:
            frappe.throw('该追溯不在当前日志授权范围内', frappe.PermissionError)
        return {'status': 'linked', 'scope': 'audit_only', 'can_confirm': False,
                'actor_user': actor['user'], 'request_id': audit.idempotency_key,
                'action_id': audit.action_id, 'proposal_id': None, 'operation_id': audit.name}
    return {'status': 'not_linked', 'scope': 'audit_only', 'can_confirm': False}


def query_conversation_context(conversation_key, log_no, before=4, after=4):
    """有界同会话动作窗口；所有 SQL 在 LIMIT 前应用独立日志授权。"""
    from shangshu_core.audit_access import audit_query_filters
    import re
    if (not isinstance(conversation_key, str) or not re.fullmatch(r"CONV-[0-9a-f]{48}", conversation_key)
            or not isinstance(log_no, str) or not re.fullmatch(r"LOG-[A-Za-z0-9-]{1,100}", log_no)):
        frappe.throw("会话或锚点编号无效", frappe.ValidationError)
    sizes = []
    for value in (before, after):
        try:
            size = int(value)
        except (ValueError, TypeError):
            frappe.throw("窗口大小无效", frappe.ValidationError)
        if isinstance(value, bool) or str(size) != str(value) or not 0 <= size <= 20:
            frappe.throw("窗口每侧只支持0至20条", frappe.ValidationError)
        sizes.append(size)
    scoped = audit_query_filters({"conversation_key": conversation_key}, "managed")
    anchors = unified_log.unified_rows("action", {**scoped, "name": log_no}, limit_page_length=1)
    if not anchors:
        frappe.throw("锚点不可见或不属于此会话", frappe.PermissionError)
    anchor = anchors[0]
    params = {}
    predicate = unified_log._log_predicate("action", scoped, params, "ctx", unified=True)
    params.update(anchor_time=anchor['creation'], anchor_name=anchor['name'])
    sides = []
    for operator, order, size in (("<", "DESC", sizes[0]), (">", "ASC", sizes[1])):
        if not size:
            sides.append([])
            continue
        # creation/name 是稳定全序；不按随机 LOG 编号推断时间，不用 OFFSET 或全会话 count。
        sql = ("SELECT * FROM `tabShangshu Unified Log` WHERE " + predicate
               + " AND (`creation` " + operator + " %(anchor_time)s OR (`creation` = %(anchor_time)s"
               + " AND `name` " + operator + " %(anchor_name)s)) ORDER BY `creation` " + order
               + ", `name` " + order + " LIMIT %(window_size)s")
        sides.append(frappe.db.sql(sql, {**params, "window_size": size}, as_dict=True))
    rows = list(reversed(sides[0])) + [anchor] + sides[1]
    return {"conversation_key": conversation_key, "anchor": log_no,
            "items": _project_action_audit_items([unified_log.project_action_row(r) for r in rows]),
            "before_count": len(sides[0]), "after_count": len(sides[1]), "llm_calls": 0}
