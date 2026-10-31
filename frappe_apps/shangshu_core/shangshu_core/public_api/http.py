"""public_api v1 的 Frappe HTTP 适配层。

浏览器/BFF 只调用本模块；Python 业务 App 使用 ``shangshu_core.public_api``。
"""

import frappe
from frappe.sessions import get_csrf_token
from werkzeug.wrappers import Response

from shangshu_core.http_headers import content_disposition

from shangshu_core.public_api import (
    application_catalog, get_application, list_domains, query_dataset, set_domain_enabled, workbench_data,
    complete_node_execution,
    get_process_launch_context,
    launch_process,
    get_process_task,
    complete_process_task,
    publish_portal_definition,
    create_process_definition,
    execute_registered_action,
    get_contract_snapshot,
    get_design_context,
    get_instance_replay,
    get_request_context,
    get_action_request_status,
    create_application_definition,
    publish_application_definition,
    get_application_release_status,
    prepare_object_change,
    get_object_change,
    execute_object_change,
    cancel_object_change,
    set_application_enabled,
    get_application_definition,
    list_application_definitions,
    save_application_draft,
    invoke_domain_service,
    get_action_proposal,
    list_object_definitions,
    get_object_definition,
    list_collaboration_people,
    list_identities,
    list_action_proposals,
    get_action_proposal_review,
    accept_action_proposal_units,
    list_process_definitions,
    list_process_instances,
    list_published_processes,
    list_registered_actions,
    list_registered_events,
    platform_contributions,
    publish_definition,
    publish_event,
    propose_registered_action,
    query_object_records,
    get_object_record,
    save_process_draft,
    simulate_process,
    validate_process_definition,
    resolve_action_proposal,
    retry_event_delivery,
    reference_execution,
    reference_notifications,
)


def _manager():
    if "System Manager" not in frappe.get_roles():
        frappe.throw("需要系统管理员权限", frappe.PermissionError)


@frappe.whitelist()
def contract():
    return get_contract_snapshot()


@frappe.whitelist()
def session():
    context = get_request_context()
    return {
        "identity_id": context["identity_id"],
        "collaboration_key": context["collaboration_key"],
        "user_name": context["user_name"],
        "user_type": frappe.db.get_value("User", context["user_name"], "user_type"),
        "display_name": frappe.utils.get_fullname(context["user_name"]),
        "enterprise": {"id": context["enterprise_id"], "name": "当前企业", "mode": "single_deployment"},
        "roles": context["roles"],
        "capabilities": {"process_design": "System Manager" in context["roles"]} | context["capabilities"],
        "trace_id": context["trace_id"],
    }


@frappe.whitelist()
def people():
    return list_collaboration_people()


@frappe.whitelist()
def identity_list():
    """账号清单（System Manager）。写操作走既有通用动作路由 platform.identity.*，不另开 HTTP 写口。"""
    return list_identities()


@frappe.whitelist()
def domains(include_disabled=0):
    include = bool(int(include_disabled))
    if include:
        _manager()
    rows = list_domains(include_disabled=include)
    if include:
        from shangshu_core.lifecycle import domain_lifecycle
        for row in rows:
            try:
                row['lifecycle'] = domain_lifecycle(row['id'])
            except Exception as error:
                row['lifecycle'] = {'disable_blockers': ['预检失败：' + str(error)], 'error': True}
    return rows


@frappe.whitelist(methods=["POST"])
def domain_status(domain_id, enabled, reason, stop_mode='drain'):
    return set_domain_enabled(domain_id, enabled, reason, stop_mode)


@frappe.whitelist()
def contributions(include_work=0):
    return platform_contributions(include_work=bool(int(include_work)))


@frappe.whitelist()
def applications(include_disabled=0, design=0, summary=0):
    include = bool(int(include_disabled))
    design_mode = bool(int(design))
    if include or design_mode:
        _manager()
    return application_catalog(include_disabled=include, include_resources=design_mode, design=design_mode, summary=bool(int(summary)))


@frappe.whitelist()
def application(application_id, design=0):
    design_mode = bool(int(design))
    if design_mode:
        _manager()
    return get_application(application_id, include_disabled=design_mode, include_resources=design_mode)


@frappe.whitelist()
def workbench():
    return workbench_data()


@frappe.whitelist()
def application_definitions():
    return list_application_definitions()


@frappe.whitelist()
def application_definition(application_id):
    return get_application_definition(application_id)


@frappe.whitelist(methods=["POST"])
def application_create(title, idempotency_key):
    return create_application_definition(title, idempotency_key)


@frappe.whitelist(methods=["POST"])
def application_save(application_id, definition, expected_revision):
    return save_application_draft(application_id, definition, expected_revision)


@frappe.whitelist(methods=["POST"])
def application_publish(application_id, expected_revision):
    return publish_application_definition(application_id, expected_revision)


@frappe.whitelist()
def application_release_status(application_id):
    return get_application_release_status(application_id)


@frappe.whitelist(methods=["POST"])
def application_status(application_id, enabled, reason, expected_revision):
    return set_application_enabled(application_id, enabled, reason, expected_revision)


@frappe.whitelist(methods=["POST"])
def object_change_prepare(application_id, definition, idempotency_key, object_id=None, expected_revision=0):
    return prepare_object_change(application_id, definition, idempotency_key, object_id, expected_revision)


@frappe.whitelist()
def object_change(change_id):
    return get_object_change(change_id)


@frappe.whitelist(methods=["POST"])
def object_change_execute(change_id, confirmed=False):
    return execute_object_change(change_id, confirmed)


@frappe.whitelist(methods=["POST"])
def object_change_cancel(change_id):
    return cancel_object_change(change_id)


@frappe.whitelist()
def datasets():
    from shangshu_core import model_records
    return platform_contributions()["datasets"] + [model_records.dataset(item["id"]) for item in model_records.list_definitions()]


@frappe.whitelist()
def object_record(object_id, name):
    return get_object_record(object_id, name)


@frappe.whitelist()
def dataset_records(dataset_id, filters=None, page=1, page_length=30):
    return query_dataset(dataset_id, frappe.parse_json(filters or "{}"), page, page_length)


@frappe.whitelist()
def objects(search=None, page=None, page_length=20, summary=0, attribution_level=None):
    """目录摘要按页读取；完整配置目录仍为显式无page的原调用。"""
    return list_object_definitions(search=search, page=int(page) if page is not None else None,
        page_length=int(page_length), summary=bool(int(summary)), attribution_level=attribution_level)


@frappe.whitelist(methods=["GET"])
def table_resource(resource_id):
    from shangshu_core.public_api import resolve_table_resource
    return resolve_table_resource(resource_id)


@frappe.whitelist(methods=["GET"])
def object_definition(object_id):
    """当前会话下的单对象公开定义，包含 companion；不返回对象目录或记录。"""
    return get_object_definition(object_id)


@frappe.whitelist()
def object_records(object_id, filters=None, page=1, page_length=30,
                   fields=None, read_scope=None, include_definition=1):
    return query_object_records(object_id, frappe.parse_json(filters or "{}"), page, page_length,
        fields=frappe.parse_json(fields) if fields is not None else None,
        read_scope=frappe.parse_json(read_scope) if read_scope is not None else None,
        include_definition=bool(int(include_definition)))


@frappe.whitelist()
def actions(tools_only=0):
    return list_registered_actions(bool(int(tools_only)))


@frappe.whitelist(methods=["POST"])
def action_execute(action_id, payload=None, confirmed=0, idempotency_key=None, source="user",execution_id=None, conversation_credential=None):
    from shangshu_core.conversation_evidence import conversation_scope
    with conversation_scope(conversation_credential):
        try:
            return execute_registered_action(
                action_id, frappe.parse_json(payload or "{}"), confirmed, idempotency_key,
                source, execution_id=execution_id,
            )
        except Exception as error:
            from shangshu_core.actions import persist_http_action_failure
            persist_http_action_failure(error)
            raise

@frappe.whitelist(methods=["POST"])
def action_propose(action_id, payload=None, idempotency_key=None, source="ai",execution_id=None, conversation_credential=None):
    from shangshu_core.conversation_evidence import conversation_scope
    with conversation_scope(conversation_credential):
        return propose_registered_action(
            action_id,
            frappe.parse_json(payload or "{}"),
            idempotency_key,
            source,
            execution_id=execution_id,
        )

@frappe.whitelist(methods=['POST'])
def reference_run(operation,execution_id=None,object_id=None,name=None):
    return reference_execution(operation,execution_id,object_id,name)


@frappe.whitelist()
def work_notifications(page=1,page_length=30):
    return reference_notifications(page,page_length)


@frappe.whitelist()
def action_proposal_summary(status=None):
    """① 提案摘要（计数）—— **不带 units / 候选全文值**（BASE44 病根：重复大包）。

    R967-B01（2026-10-17）三读口之一。**按 status 分组的计数**，跟 `list_action_proposals`
    同一鉴权（`_proposal_visible`）。**一份判定源两个粒度** —— 摘要/列表/units 三口共用一份可见性。
    """
    from shangshu_core.public_api import action_proposal_summary as query
    return query(status)


@frappe.whitelist()
def action_proposals(status="Proposed", after=None, limit=50):
    """②a 提案列表（cursor 分页）—— **不带 units / 候选全文值**。

    `after` = 上一页最后一条的 `name`（稳定，不随 creation 变）。回 `next_cursor`/`has_more`。
    """
    from shangshu_core.actions import list_action_proposals
    result = list_action_proposals(status, after=after, limit=limit)
    return {"allowed": True, **result, "reason": ""}


@frappe.whitelist()
def action_proposal_units(proposal_id, row_from=None, row_to=None, offset=None, limit=None):
    """②b 单提案 units（range 按行段取）—— **带摘要，不带全文值**。

    **可随机定位**（拖滚动条跳到第 800 行）—— **不是顺序游标**（Assistant 从 UI 消费倒推）。
    **全文值走 ③**（`action_proposal_get`），**不在此口回**（BASE44 病根）。
    """
    from shangshu_core.public_api import action_proposal_units as query
    return query(proposal_id, row_from=row_from, row_to=row_to, offset=offset, limit=limit)


@frappe.whitelist()
def action_proposal_get(proposal_id):
    """③ 受管读取一条提案（010-T01 公共部分补缺口）。**含全文值，按权限**。

    鉴权与 list 一致：同企业 +（System Manager | 本人发起 | 动作在自己角色集里）。
    **BASE44 修法**：全文值只在此口回，①/②a/②b 只给「有哪些」。
    """
    from shangshu_core.actions import get_action_proposal
    return get_action_proposal(proposal_id)


@frappe.whitelist()
def action_proposal_review(proposal_id):
    """**逐项审核读口（G3）**：回审核目录（units + 版本号 + 可用性）。

    基线内核有、重做内核时整块丢了 —— A 的 Excel 页内控制器
    （`inline-review.ts`）走的就是这条 `/review`。**没有它，「全部确认」打不开。**
    """
    from shangshu_core.proposal_review import get_action_proposal_review
    return get_action_proposal_review(proposal_id)


@frappe.whitelist(methods=["POST"])
def action_proposal_accept(proposal_id, op_id, expected_review_revision, units=None, edited_value=None):
    """**逐项确认（G3）**：按 `expected_review_revision` 做乐观锁，逐项接受并执行。

    `units=None` = 全部待审项；`edited_value` = `{unit_id: {type, value}}` 改值。
    重放同一 `op_id` 不重复执行（内核 `_execute` 里按原操作号复用回执）。
    """
    if isinstance(units, str):
        units = frappe.parse_json(units)
    if isinstance(edited_value, str):
        edited_value = frappe.parse_json(edited_value)
    from shangshu_core.proposal_review import accept_action_proposal_units
    return accept_action_proposal_units(proposal_id, op_id, expected_review_revision, units, edited_value)


@frappe.whitelist(methods=["POST"])
def action_proposal_reject_units(proposal_id, op_id, expected_review_revision=None, units=None):
    """**逐项放弃**：只把选中的审核项标成「不采用」，**不写任何正式值**。

    用户 2026-10-19 A17：助手建议改两个格子，要能「部分采用、部分拒绝」。
    放弃是丢弃，不查内容版本（与整笔放弃同一口径），免得「先采用一格、
    表版本 +1」把「再放弃另一格」顶掉。只能放弃还没处理过的项。
    重放同一 `op_id` 不重复改状态。
    """
    if isinstance(units, str):
        units = frappe.parse_json(units)
    from shangshu_core.proposal_review import reject_action_proposal_units
    return reject_action_proposal_units(proposal_id, op_id, expected_review_revision, units)


@frappe.whitelist(methods=["POST"])
def action_proposal_stage_units(proposal_id, op_id, expected_review_revision, units=None, edited_value=None):
    """**逐项暂存**：只把选中的审核项标成「我看过、先存着」，**正式值一个字都不改**。

    **这是什么**：审核中心的候选多一档「暂存」（`staged`）——
    用户 2026-10-25 原话：「在单元格里单击等同于在审核中心暂存」
    ⇒ 人在表格里点一个单元格时，要的是「**这一项先存着**」，不是「正式值当场就改了」。
    **暂存 ≠ 采用 ≠ 保存**：本口**一个正式值都不写**；采用（`/accept`）才写；
    明确保存（提交整组）才入库。
    **暂存不绕过整组规则**：本口**不跑**整组闸（暂存只是标记），
    `/accept` 时那条规则照旧跑（暂存过的项**不算「已核对完」** —— 它一个字都还没提交）。

    `units=None` = 全部待审项；`edited_value` = `{unit_id: {type, value}}` 改值
    （暂存的是**人改过的那份**；采用时按那个值写）。
    重放同一 `op_id` 不重复生效（内核按原操作号复用回执，换选中项或换值 ⇒ 拒）。
    回执**就是 `/review` 的同一个形状**（`_public`）⇒ 前端拿到直接替换描述符。
    """
    if isinstance(units, str):
        units = frappe.parse_json(units)
    if isinstance(edited_value, str):
        edited_value = frappe.parse_json(edited_value)
    from shangshu_core.proposal_review import stage_action_proposal_units
    return stage_action_proposal_units(proposal_id, op_id, expected_review_revision, units, edited_value)


@frappe.whitelist(methods=["POST"])
def action_proposal_unstage_units(proposal_id, op_id, expected_review_revision, units):
    """**取消暂存**：这一项回到「待审」（`pending`），**正式值一个字都不动**。

    **与「逐项放弃」的区别**：放弃是**丢弃**（这一项不再待审）；
    取消暂存是**收回标记**（这一项还在队列里，人还能再核对、再采用）。
    `units` **必填**（取消要说清取消哪几项；没有「全部取消」这回事）。
    重放同一 `op_id` 不重复改状态。
    """
    if isinstance(units, str):
        units = frappe.parse_json(units)
    from shangshu_core.proposal_review import unstage_action_proposal_units
    return unstage_action_proposal_units(proposal_id, op_id, expected_review_revision, units)


@frappe.whitelist()
def action_request_status(idempotency_key):
    return get_action_request_status(idempotency_key)


@frappe.whitelist(methods=["POST"])
def action_proposal_resolve(proposal_id, decision, edited_value=None):
    if isinstance(edited_value, str):
        try:
            edited_value = frappe.parse_json(edited_value)
        except (TypeError, ValueError):
            pass
    return resolve_action_proposal(proposal_id, decision, edited_value)


@frappe.whitelist(methods=["POST"])
def service_invoke(service_id, payload=None):
    return invoke_domain_service(service_id, frappe.parse_json(payload or "{}"))


@frappe.whitelist(methods=["GET", "POST"])
def service_read(service_id, payload=None):
    from shangshu_core.public_api import read_registered_service
    return read_registered_service(service_id, frappe.parse_json(payload or "{}"))


@frappe.whitelist()
def events():
    return list_registered_events()


@frappe.whitelist(methods=["POST"])
def event_publish(event_id, payload=None, idempotency_key=None, correlation_id=None):
    return publish_event(
        event_id,
        frappe.parse_json(payload or "{}"),
        idempotency_key,
        correlation_id,
    )


@frappe.whitelist(methods=["POST"])
def event_retry(envelope_id):
    return retry_event_delivery(envelope_id)


@frappe.whitelist()
def csrf():
    if frappe.session.user in (None, "Guest"):
        frappe.throw("需要登录", frappe.PermissionError)
    return {"csrf_token": get_csrf_token()}


@frappe.whitelist()
def processes():
    return list_published_processes()


@frappe.whitelist()
def process_definitions():
    return list_process_definitions()


@frappe.whitelist(methods=["POST"])
def process_definition_create(title, business_object=None):
    return create_process_definition(title, business_object)


@frappe.whitelist()
def process_instances(view="started"):
    return list_process_instances(view)


@frappe.whitelist()
def process_instance(name):
    return get_instance_replay(name)


@frappe.whitelist()
def process_launch_context(definition_id):
    return get_process_launch_context(definition_id)


@frappe.whitelist(methods=["POST"])
def process_launch(definition_id, values, idempotency_key, confirmed=False):
    return launch_process(definition_id, values, idempotency_key, confirmed)


@frappe.whitelist()
def process_task(name):
    return get_process_task(name)


@frappe.whitelist(methods=["POST"])
def process_task_complete(name, node_id, values, idempotency_key, decision=None, confirmed=False):
    return complete_process_task(name, node_id, values, idempotency_key, decision, confirmed)


@frappe.whitelist()
def process_design(definition_id):
    return get_design_context(definition_id)


@frappe.whitelist(methods=["POST"])
def process_save(definition_id, graph, expected_revision):
    return save_process_draft(definition_id, graph, expected_revision)


@frappe.whitelist(methods=["POST"])
def process_validate(definition_id, graph=None):
    return validate_process_definition(definition_id, graph)


@frappe.whitelist(methods=["POST"])
def process_simulate(definition_id, sample=None, graph=None):
    return simulate_process(definition_id, sample, graph)


@frappe.whitelist(methods=["POST"])
def process_publish(definition_id, expected_revision=None):
    return publish_portal_definition(definition_id, expected_revision)


@frappe.whitelist(methods=["POST"])
def process_start(definition_id, business_doctype=None, business_name=None, business_object_id=None):
    frappe.throw("此原始发起接口已停用，请使用 http_v2.process_start 或应用发起入口（需表单、确认和幂等键）", frappe.PermissionError)


@frappe.whitelist(methods=["POST"])
def execution_complete(execution, token, selected_tool=None, output=None, reason=None, callback_id=None):
    return complete_node_execution(execution, token, selected_tool, output, reason, callback_id)


def _field_acl_gate(ref_doctype, ref_name, file):
    """E01.3 导出闸：**按主体判**（`download` 维度），**所有**晋升列都得能下载，少一列整份拒。

    只对挂载的「受管表/邮件附件」生效：
    - `attached_to_doctype` 在白名单内（文件域或邮件域）→ 检查
    - 其它（普通 Frappe File）→ 放过（基线 read 已拦）

    ⚠️ **受管表链**（晋升上来的表）从 2026-10-25 起走**主体范围**模型
    （PKG-117-T01，契约 `账号与权限.md` 2026-10-25）：
      · 每列对 `download` 各自声明主体范围；
      · 列**没声明** ⇒ **继承表级**；
      · 表级 `download` **没声明** ⇒ **拒**（fail-closed，不猜、不放行）。

    **主体判定走内核的判定口**（`org_admin.field_subject_allows`）
    ⇒ **域层按主体判**；物理表那边只给**宽底座角色**让 `doc.check_permission` 过，
    细判在这里/内核层。

    ⚠️ **表级声明的来源**：**受管对象的正式定义**（compiled／active 那一份）—— **权威**。
    文件侧那份（`sheet_meta_json` 里的 `promotion`）**只当输入**：它只告诉我们
    「这张文件对应哪个受管对象」，**不再自己当生效规则评估**
    （用户 2026-10-26 23:0x 决定二：「定义有一份权威，其他配置是生成结果」）。
    ⚠️ **取不到受管对象的正式定义**（对象行不在／没有生效修订）⇒ **回落文件侧那份**，
    **不静默收紧存量下载**（真表证据 2026-10-27：站上 881 个带绑定的文件里，
    **641 个的受管对象行已经不在** —— 那是**判据残骸**为主；一刀 fail-closed 会
    把这批文件的下载全拒掉）。⚠️ 这个回落是**过渡口径**，不是「两份都要满足」。

    **System Manager 旁路**照旧（既有约定，不破）。
    """
    try:
        file_doc = frappe.get_doc("File", file)
    except Exception:
        return
    managed = (file_doc.attached_to_doctype or "") in (
        "Shangshu File Center File",
        "Shangshu Mail Message",
    )
    if not managed:
        return
    # ① **文件侧那份只当输入**：告诉我们这张文件对应哪个受管对象。
    try:
        from shangshu_files import promotion as _prom
        _doc = frappe.get_doc(file_doc.attached_to_doctype, ref_name)
        binding = _prom._managed_binding(_doc) or {}
    except Exception:
        return
    # ② **判定按受管对象的正式定义**（compiled）—— 不再用文件侧那份副本。
    cols = []
    table_access = None
    object_id = binding.get("object_id")
    if object_id:
        from shangshu_core.public_api import managed_object_definition
        compiled = managed_object_definition(object_id) or {}
        for f in compiled.get("fields") or []:
            if not isinstance(f, dict) or not f.get("id"):
                continue
            if f.get("type") == "detail":
                continue  # 子表字段不是这张表的列
            cols.append({"id": f.get("id"), "label": f.get("label") or f.get("id"),
                         "access": f.get("access")})
        table_access = compiled.get("access")
    if not cols:
        # ⚠️ **取不到正式定义** ⇒ 回落**文件侧**那份（维持现状，不静默收紧）。
        try:
            defn = _prom.load_definition(_doc) or {}
        except Exception:
            return
        for c in defn.get("columns") or []:
            if not isinstance(c, dict) or not c.get("promoted"):
                continue
            cols.append({"id": c.get("field") or c.get("id"), "label": c.get("header") or c.get("field"),
                         "access": c.get("access")})
        table_access = defn.get("access")
    if not cols:
        return
    roles = set(frappe.get_roles() or [])
    # System Manager 旁路（既有约定，照旧不破）。
    if "System Manager" in roles:
        return
    from shangshu_core.org_admin import field_subject_allows, subject_context
    subject = subject_context(frappe.session.user)
    for c in cols:
        fid = c.get("id")
        if not fid:
            continue
        field = {"id": fid}
        if isinstance(c.get("access"), dict):
            field["access"] = c["access"]
        try:
            allowed = field_subject_allows(frappe.session.user, field, "download",
                                           table_access=table_access, ctx=subject)
        except ValueError as error:
            frappe.throw("字段「%s」的下载权限未声明完整，整份下载被拒：%s"
                         % (c.get("label") or fid, error), frappe.PermissionError)
        if not allowed:
            frappe.throw("字段「%s」对当前用户没有下载权限，整份下载被拒" % (c.get("label") or fid),
                         frappe.PermissionError)


@frappe.whitelist(methods=["GET"])
def file_content(ref_doctype, ref_name, file):
    """基础附件契约下载口：会话用户对业务记录有读权限且文件确实挂在该记录上，才返回内容字节。

    供 BFF 以同源会话流式转发；不绕过记录级权限，也不暴露未挂载的自由文件。
    2026-10-18 主控加：**字段级闸**（E01.3 导出 1/2 条）——
    文件中心/邮件附件下载时，按业务对象当前定义里**所有晋升列**逐列检查，
    **任一列不通过** → **整份拒**（不能先下整份再前端遮）。

    ⚠️ **2026-10-25 起这道闸按「主体范围」的 `download` 维度判**
    （PKG-117-T01）：不是按 `read_roles`、也不是按「读」维度 ——
    列没声明下载 ⇒ 继承表级；表级也没声明 ⇒ 拒。详见 `_field_acl_gate`。

    2026-10-22（PKG-024-T01）：**自己造响应**（原来走 `frappe.local.response` 那条路）。
    为什么：那条路把**原件名原样**放进 `Content-Disposition` ——
    中文名 ⇒ 线上是 UTF-8 字节 ⇒ HTTP 头只吃 ASCII ⇒
    Node 的解析器（`fetch`/undici 与 `node:http` 都一样）判**整条响应非法**
    （`Invalid header value char`）⇒ **字节根本读不回来**
    （实测 30 个真实中文文件名里有 8 个读不回来；助手看图、浏览器下载都中招）。
    ⇒ 文件名走 RFC 5987（`filename*=UTF-8''…`，纯 ASCII）＋ 一个 ASCII 兜底名；
      客户端按 UTF-8 还原（浏览器与 BFF 的 `attachmentFilename` 都优先认 `filename*`）。
    """
    import mimetypes

    from shangshu_core.attachments import can_download_reference
    if not can_download_reference(ref_doctype, ref_name):
        frappe.throw("无权下载该记录的附件", frappe.PermissionError)
    file_doc = frappe.get_doc("File", file)
    if file_doc.attached_to_doctype != ref_doctype or file_doc.attached_to_name != ref_name:
        frappe.throw("该文件未挂在此记录上", frappe.PermissionError)
    # 字段级**下载**闸（仅对文件中心/Excel 表与邮件附件生效）：
    # 读当前定义，对所有晋升列按**主体范围**的 `download` 维度逐列判
    # （列没声明 ⇒ 继承表级；表级也没声明 ⇒ 拒），
    # 有一列不通过即整份拒。**不造新权限源**——复用内核的 `org_admin` 主体判定口。
    _field_acl_gate(ref_doctype, ref_name, file)
    # 内容就绪闸（D 契约 §17）：裸 URL 绕过文件域闸的兜底。
    # 钩子抛就抛（拒因说人话，不吞不转错误码）；无钩子默认过。
    # 钩子可选返回 {"version_label": "v3"} —— 附在文件名上（「下载时版本号标清楚」）。
    from shangshu_core.field_access import check_content_ready
    gate_note = check_content_ready(ref_doctype, ref_name, file)
    fname = file_doc.file_name or "file"
    if isinstance(gate_note, dict) and gate_note.get("version_label"):
        # 在扩展名前插入版本标注：`table.xlsx` → `table-v3.xlsx`
        import os as _os
        _base, _ext = _os.path.splitext(fname)
        fname = '%s-%s%s' % (_base, gate_note["version_label"], _ext)
    response = Response()
    response.mimetype = mimetypes.guess_type(fname)[0] or "application/octet-stream"
    response.headers["Content-Disposition"] = content_disposition(fname)
    response.data = file_doc.get_content()
    return response


@frappe.whitelist(methods=["GET"])
def audit_actor(user):
    """Resolve one actor for authorized log evidence; not a staff enumeration API."""
    from shangshu_core.public_api import authorize_audit_actor
    return authorize_audit_actor(user)


@frappe.whitelist(methods=["GET"])
def action_audits(filters=None, page=1, page_length=50):
    """Authorized audit evidence with counts/paging over the same scoped set."""
    from shangshu_core.public_api import query_action_audits
    return query_action_audits(frappe.parse_json(filters or "{}"), page, page_length)


@frappe.whitelist(methods=["GET"])
def audit_proposal(user, proposal_id):
    """Decision evidence only; independent log authority grants no review power."""
    from shangshu_core.public_api import get_audit_proposal
    return get_audit_proposal(user, proposal_id)


@frappe.whitelist()
def audit_trace(user, operation_id=None, request_id=None):
    """Exact persisted trace lookup under independent log authorization."""
    from shangshu_core.public_api import get_audit_trace
    return get_audit_trace(user, operation_id, request_id)


@frappe.whitelist(methods=["POST"])
def conversation_issue():
    from shangshu_core.public_api import issue_conversation
    return issue_conversation()


@frappe.whitelist()
def conversation_context(conversation_key, log_no, before=4, after=4):
    from shangshu_core.public_api import query_conversation_context
    return query_conversation_context(conversation_key, log_no, before, after)
