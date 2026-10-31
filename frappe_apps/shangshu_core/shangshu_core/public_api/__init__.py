from shangshu_core.transaction_failure import raise_if_transaction_failed, assert_transaction_healthy
from shangshu_core.write_zone_certification import invalidate_managed_write_zone, certify_managed_write_zone
from shangshu_core.action_packages import register_package_rollback
from shangshu_core.object_companions import get_object_companion, get_file_companion, authorize_companion_cells, bind_object_companion, list_object_companion_files
"""尚书平台公共 API v1。

业务 App 只能从本模块导入平台能力；其他 ``shangshu_core.*`` 模块均视为
私有实现，可在不破坏本模块契约的前提下重构。
"""

from shangshu_core.audit_access import authorize_audit_actor
from shangshu_core.actions import action_proposal_summary, action_proposal_units, get_proposal_validation_snapshot
from shangshu_core.identity import identity_aliases, identity_department, ensure_identity_for_user
from shangshu_core.receipts import query_action_fact_audits, query_action_audits, get_audit_proposal, get_audit_trace
# 按受管记录取日志（2026-10-22 收进内核的公共口）：日志块要能按案件看。
from shangshu_core.conversation_evidence import issue_conversation
from shangshu_core.receipts import query_conversation_context, query_business_audits
# **域写自己的过程记录**（2026-10-23，§8 第 11／12 项）：统一日志库的**写口**，
# 域只许走这里（不许 import 内核内部模块）。助手与别的域走平台服务 `platform.log.record`。
from shangshu_core.process_log import (
    declare_process_log_fields,
    query_process_records,
    write_process_record,
)
from shangshu_core.org_admin import has_department_authority, resolve_department_key, current_actor_organization_snapshot
# **主体判定口**（PKG-117-T01）：列级/表级权限按「主体范围」（全局/部门/个人）判 ——
# **域层按主体判**（复用这里的判定口），物理表只给宽底座角色，细判在内核/域层。
from shangshu_core.org_admin import subject_context, subject_allows, field_subject_allows
# **主体范围声明的形状校验**（PKG-117-T01 · 导出半）：域要判「这份声明形状合不合法」
# 时**有正式口可调** ⇒ 不必再借 `subject_allows` 绕道触发同一份校验
# （绕道＝依赖「`subject_allows` 会先做形状校验且对空 user 不抛别的错」这个实现细节）。
# ⚠️ `shangshu_core.subject_access` 是**纯规则**模块（不碰 frappe、不 import 内核其它模块）
# ⇒ 这里顶层 import **不成环**；⚠️ 反过来 `field_access.py` **不许**顶层 import 它
# （那条判据按**文件路径**加载 `field_access.py`，顶层 import 会把它打红）。
from shangshu_core.subject_access import normalize_scope, normalize_access
from shangshu_core.field_access import map_owner_subject, register_content_gate, deny_reason
from shangshu_core.attachments import can_read_reference, reference_doctype
# **受管对象的正式定义**（compiled／active 那一份）—— **权威那份**。
# ⚠️ 与 `model_records.definition()` 的区别：那个是**给页面用的投影**；
#    **判定**（下载闸、能力投影）要用**这一份**。
# ⚠️ **取不到回 `None`**（对象行不在／没有生效修订）—— **不编**。
# ⚠️ 这里**延迟 import**（不顶层 import `model_records`）—— 免得把一大块运行时拖进公共面。
def managed_object_definition(object_id):
    """受管对象的**正式定义**（compiled／active 那一份）—— **权威那份**。

    ⚠️ 与 `model_records.definition()` 的区别：那个是**给页面用的投影**
    （按当前用户的读权限过滤过字段 ＋ 算过可写标记）；**判定**要用**这一份**。
    ⚠️ **取不到回 `None`**（对象行不在／没有生效修订）—— **不编**。
    """
    from shangshu_core.model_records import compiled_definition
    return compiled_definition(object_id)

from shangshu_core.model_definition_reads import managed_object_definitions

from shangshu_core.actions import (
    execute_registered_action,
    get_action_proposal,
    list_action_proposals,
    list_registered_actions,
    propose_registered_action,
    resolve_action_proposal,
)
from shangshu_core.proposal_review import (
    get_action_proposal_review, accept_action_proposal_units, assert_no_pending_proposal_reviews,
    # **暂存这一档**（PKG-118-T01）：候选多一档「暂存」—— 只标记，**正式值一个字都不改**；
    # 采用（`accept`）才写正式值，明确保存（提交整组）才入库。
    stage_action_proposal_units, unstage_action_proposal_units,
)
# 合并说明：fast 新增的公共组织面与本域审计查询入口 —— 两个都留。
from shangshu_core.public_api import organization
from shangshu_core.public_api import business_access
from shangshu_core.receipts import query_domain_action_audits
from shangshu_core.contracts import API_VERSION, get_contract_snapshot
# 与 win 沟通的**契约层**（设备通道）归内核（2026-10-22 用户拍板）：
# 令牌哈希、凭据校验的六条失败原因、操作号的构造规矩 —— **纯规则，不碰 frappe**。
# 域从这儿拿规则（**这两个名字是正式导出**：`token_hash`／`validate_device_action`）。
# ⚠️ **别再直 import 私有模块** `shangshu_core.device_channel` —— 域闸
# `check-platform-contract.mjs` 会判 `PRIVATE_CORE_IMPORT`（PKG-082-T01）。
from shangshu_core.device_channel import (DEVICE_ACTION_NOT_ALLOWED, DEVICE_CREDENTIAL_EXPIRED,
                                          DEVICE_CREDENTIAL_INACTIVE, DEVICE_CREDENTIAL_INVALID,
                                          DEVICE_ID_MISMATCH, DEVICE_ID_REQUIRED,
                                          device_action_key, token_hash, validate_device_action)
from shangshu_core.contracts import get_device_channel_contract
from shangshu_core.attachments import bind_record_attachments, get_record_attachments
from shangshu_core.mutable_files import WorkingFileTransaction
# 重放守卫用：只窥缓存结果、**不当响应放行**。领域守卫靠它认出「新建类」动作
# 那次刚建出来的对象（载荷里还没有编号），才能复核「现在还归不归你」。
from shangshu_core.action_requests import peek_result
from shangshu_core.domain_execution import domain_execution
from shangshu_core.model_changes import prepare_object_change, get_object_change, execute_object_change, cancel_object_change
# 按业务标识找行（2026-10-22 收进内核的公共能力）：example 与 UC02 关联费用用**同一个办法**，
# 域里不再各写一遍找行逻辑。
from shangshu_core.model_records import find_record_by_identity
# 退役受管对象/应用（2026-10-22 收进内核）：清理残留不再靠脚本直接删内核表。
from shangshu_core.model_lifecycle import (retire_managed_object, retire_application,
                                           get_managed_object_model)
# 按业务编号找行（表层）：example 与 UC02 关联费用用**同一个办法**。
from shangshu_core.business_identity import find_row_by_business_identity
# 晋升接入受管记录（PKG-004-T03）：文件域的晋升入口经这里接公共内核的
# 受管模型/记录能力 —— 域里自己写一份记录引擎就是第二套存储。
from shangshu_core.promotion_records import (
    provision_promoted_records,
    create_promoted_records,
    extend_promoted_records,
    migrate_legacy_promoted_values,
    read_promoted_values,
    write_promoted_values,
    convert_workbook_value,
    read_record_versions,
)
from shangshu_core.applications import create_application_definition, get_application_definition, list_application_definitions, save_application_draft, publish_application_definition, get_application_release_status, set_application_enabled
from shangshu_core.database import ensure_immutable_triggers
from shangshu_core.domains import (
    application_catalog,
    get_application,
    list_domains,
    query_dataset,
    workbench_data,
    assert_domain_enabled,
    assert_resource_enabled,
    ensure_registered_domains,
    invoke_domain_service,
    is_domain_enabled,
    platform_contributions,
    role_capabilities,
    set_domain_enabled,
)
from shangshu_core.identity import get_identity, list_collaboration_people
from shangshu_core.identity_admin import list_identities
from shangshu_core.reference_work import reference_execution, update_reference_work, reference_notifications
from shangshu_core.manifest import check_registered_manifests
from shangshu_core.immutable import ImmutableDocument
# **公共分析语义**（PKG-018-T06）：受管记录（`platform.object.aggregate`）与
# 表格（XLSX／绑定表，`files.table_aggregate`）**用同一套**统计口径 ——
# 指标集、可用筛选方式、类型兼容、上限、求和精度、分组截断**只有这一份**。
# 业务域只能从这里取，别自己写一套。
from shangshu_core import analysis
# 查询回执（**版本化结构**）：把「这次查到了什么」随结果一起返回。
from shangshu_core.query_receipt import build_receipt as build_query_receipt
from shangshu_core.events import list_registered_events, publish_event, retry_event_delivery
from shangshu_core.objects import find_managed_object_definition, get_object_definition, get_object_record, list_object_definitions, query_object_records
from shangshu_core.table_resources import resolve_table_resource
from shangshu_core.service_reads import read_registered_service
from shangshu_core.process_portal import get_process_launch_context, launch_process, get_process_task, complete_process_task, publish_portal_definition
from shangshu_core.receipts import get_action_receipt, get_action_request_status, record_action_receipt, list_reference_audits
from shangshu_core.runtime import (
    begin_node_execution,
    complete_node_execution,
    create_process_definition,
    fail_node_execution,
    get_design_context,
    get_instance_replay,
    list_process_definitions,
    list_process_instances,
    list_published_processes,
    publish_definition,
    register_action,
    register_domain_process_definition,
    save_process_draft,
    simulate_process,
    start_process,
    validate_process_definition,
)


def get_request_context():
    """返回稳定身份上下文；不暴露 session、密码或 CSRF 等凭据。"""
    import frappe

    identity = get_identity()
    roles = frappe.get_roles()
    trace_id = getattr(frappe.flags, "shangshu_trace_id", None)
    if not trace_id:
        trace_id = getattr(frappe.local, "request_id", None) or frappe.generate_hash(length=24)
        frappe.flags.shangshu_trace_id = trace_id
    return {
        "identity_id": identity.identity_id,
        "collaboration_key": identity.collaboration_key,
        "identity_name": identity.name,
        "enterprise_id": identity.enterprise_id,
        "user_name": frappe.session.user,
        "roles": roles,
        "capabilities": role_capabilities(roles),
        "trace_id": trace_id,
    }


def require_roles(*allowed):
    import frappe

    if not set(allowed).intersection(frappe.get_roles()):
        frappe.throw("当前用户没有执行该动作的业务角色", frappe.PermissionError)


def require_capability(capability, resource=None):
    import frappe

    roles = frappe.get_roles()
    if "System Manager" in roles:
        return
    if not role_capabilities(roles).get(capability):
        suffix = f"（资源：{resource}）" if resource else ""
        frappe.throw(f"当前用户缺少能力：{capability}{suffix}", frappe.PermissionError)


__all__ = [
    "business_access",
    # 公共分析语义（受管记录与表格共用一份口径）
    "analysis",
    "build_query_receipt",
    "provision_promoted_records",
    "create_promoted_records",
    "extend_promoted_records",
    "migrate_legacy_promoted_values",
    "read_promoted_values",
    "write_promoted_values",
    "reference_doctype",
    "action_proposal_summary",
    "action_proposal_units",
    "get_proposal_validation_snapshot",
    "identity_aliases",
    "identity_department",
    "ensure_identity_for_user",
    "authorize_audit_actor",
    "query_action_audits",
    "query_conversation_context",
    "issue_conversation",
    "query_business_audits",
    "find_record_by_identity",
    "retire_managed_object",
    # 读受管对象的模型事实（owner／revision／active_revision）—— 只读。
    # 域要知道「自己的对象归哪个应用、当前修订几号」只能走这个口，
    # 自己查内核表就是跨域摸内核的表（PRIVATE_CORE_DOCTYPE_ACCESS）。
    "get_managed_object_model",
    # 设备通道的纯规则（不碰 frappe）：域从公开面拿，别再直 import 私有模块。
    "token_hash",
    "validate_device_action",
    "find_row_by_business_identity",
    "retire_application",
    "get_audit_proposal",
    "get_audit_trace",
    "get_object_companion",
    "get_file_companion",
    "authorize_companion_cells",
    "bind_object_companion",
    "list_object_companion_files",
    "query_action_fact_audits",
    "has_department_authority",
    "current_actor_organization_snapshot",
    "resolve_department_key",
    # **主体判定口**（PKG-117-T01）：域层按主体判（全局/部门/个人），别自己写一套。
    "subject_context",
    "subject_allows",
    "field_subject_allows",
    # **主体范围声明的形状校验**（PKG-117-T01 · 导出半）：域判声明合不合法时**直调**这两个口，
    # 不必再借 `subject_allows` 绕道触发（域只把它翻译成「当场拒」并补定位串）。
    "normalize_scope",
    "normalize_access",
    "map_owner_subject",
    "register_content_gate",
    "deny_reason",
    "can_read_reference",
    "managed_object_definition",
    "managed_object_definitions",
    # **域写自己的过程记录**（2026-10-23，§8 第 11／12 项）：统一日志库的公开写口。
    # 域只许走这两个（不许 import 内核内部模块）；助手与别的域走平台服务
    # `platform.log.record`（同一条路）⇒ 域与域之间不直接依赖。
    "write_process_record",
    "declare_process_log_fields",
    # **读口**：按受管记录取过程记录（写进去的那几行**读得回来**才算数）。
    "query_process_records",

    "WorkingFileTransaction",
    # 合并说明：fast 新增的公共组织面与本域审计查询入口 —— 与上面的清单取并集。
    "organization",
    "query_domain_action_audits",
    "bind_record_attachments",
    "get_record_attachments",
    "peek_result",
    "domain_execution",
    "reference_execution",
    "update_reference_work",
    "reference_notifications",
    "check_registered_manifests",
    "application_catalog",
    "get_application",
    "list_domains",
    "query_dataset",
    "workbench_data",
    "API_VERSION",
    "get_action_receipt",
    "record_action_receipt",
    "list_reference_audits",
    "get_process_launch_context",
    "launch_process",
    "get_process_task",
    "complete_process_task",
    "publish_portal_definition",
    "ImmutableDocument",
    "assert_domain_enabled",
    "assert_resource_enabled",
    "get_action_request_status",
    "create_application_definition",
    "publish_application_definition",
    "get_application_release_status",
    "prepare_object_change",
    "get_object_change",
    "execute_object_change",
    "cancel_object_change",
    "set_application_enabled",
    "get_application_definition",
    "list_application_definitions",
    "save_application_draft",
    "begin_node_execution",
    "complete_node_execution",
    "create_process_definition",
    "ensure_immutable_triggers",
    "ensure_registered_domains",
    "execute_registered_action",
    "register_package_rollback",
    "raise_if_transaction_failed",
    "assert_transaction_healthy",
    "invalidate_managed_write_zone",
    "certify_managed_write_zone",
    "fail_node_execution",
    "find_managed_object_definition",
    "get_contract_snapshot",
    "get_design_context",
    "get_identity",
    "get_instance_replay",
    "get_object_definition",
    "get_object_record",
    "get_request_context",
    "invoke_domain_service",
    "is_domain_enabled",
    "list_identities",
    "list_object_definitions",
    "list_collaboration_people",
    "get_action_proposal",
    "list_action_proposals",
    "get_action_proposal_review",
    "accept_action_proposal_units",
    # **暂存这一档**（PKG-118-T01）：只标记，不写正式值；跨入口共享同一份暂存状态。
    "stage_action_proposal_units",
    "unstage_action_proposal_units",
    "assert_no_pending_proposal_reviews",
    "list_process_definitions",
    "list_process_instances",
    "list_published_processes",
    "list_registered_actions",
    "list_registered_events",
    "platform_contributions",
    "publish_definition",
    "publish_event",
    "propose_registered_action",
    "query_object_records",
    "resolve_table_resource",
    "read_registered_service",
    "register_action",
    "register_domain_process_definition",
    "require_capability",
    "require_roles",
    "resolve_action_proposal",
    "process_node_provenance",
    # 合并说明：fast 在这里列的 get_action_proposal_review / accept_action_proposal_units
    # 本文件上方 __all__ 里已经有了（同一份清单不重复列），这里只补 fast 独有的。
    "retry_event_delivery",
    "role_capabilities",
    "set_domain_enabled",
    "save_process_draft",
    "simulate_process",
    "start_process",
    "validate_process_definition",
]

from shangshu_core.public_resources import public_resource_allows, assert_relation_direction, resource_enterprise

from shangshu_core.field_access import field_allows_roles

# Trusted Python runtime scope; deliberately not whitelisted as an HTTP endpoint.
from shangshu_core.action_provenance import process_node_provenance
