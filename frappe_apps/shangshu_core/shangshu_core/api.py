import frappe
from frappe.sessions import get_csrf_token

from shangshu_core.domains import (
    application_catalog,
    get_application,
    list_domains,
    platform_contributions,
    query_dataset,
    role_capabilities,
    set_domain_enabled,
    workbench_data,
)
from shangshu_core.identity import get_identity
from shangshu_core.runtime import (
    complete_node_execution,
    get_design_context,
    get_instance_replay,
    create_process_definition,
    list_process_definitions,
    list_process_instances,
    list_published_processes,
    publish_definition,
    save_process_draft,
    simulate_process,
    validate_process_definition,
)


@frappe.whitelist()
def get_session():
    identity = get_identity()
    roles = frappe.get_roles()
    return {
        "identity_id": identity.identity_id,
        "user_name": frappe.session.user,
        "display_name": frappe.utils.get_fullname(frappe.session.user),
        "enterprise": {"id": identity.enterprise_id, "name": "当前企业", "mode": "single_deployment"},
        "roles": roles,
        "capabilities": {"process_design": "System Manager" in roles} | role_capabilities(roles),
    }


@frappe.whitelist()
def get_domains(include_disabled=0):
    include = bool(int(include_disabled))
    if include and "System Manager" not in frappe.get_roles():
        frappe.throw("需要系统管理员权限", frappe.PermissionError)
    return list_domains(include_disabled=include)


@frappe.whitelist()
def get_platform_contributions():
    return platform_contributions()


@frappe.whitelist()
def get_applications(include_disabled=0, design=0):
    include = bool(int(include_disabled))
    design_mode = bool(int(design))
    if (include or design_mode) and "System Manager" not in frappe.get_roles():
        frappe.throw("需要系统管理员权限", frappe.PermissionError)
    return application_catalog(include_disabled=include, include_resources=design_mode)


@frappe.whitelist()
def get_application_detail(application_id, design=0):
    design_mode = bool(int(design))
    if design_mode and "System Manager" not in frappe.get_roles():
        frappe.throw("需要系统管理员权限", frappe.PermissionError)
    return get_application(application_id, include_disabled=design_mode, include_resources=design_mode)


@frappe.whitelist()
def get_workbench():
    return workbench_data()


@frappe.whitelist()
def get_datasets():
    return platform_contributions()["datasets"]


@frappe.whitelist()
def dataset_query(dataset_id, filters=None, page=1, page_length=30):
    return query_dataset(dataset_id, frappe.parse_json(filters or "{}"), page, page_length)


@frappe.whitelist(methods=["POST"])
def change_domain_status(domain_id, enabled, reason, stop_mode='drain'):
    return set_domain_enabled(domain_id, enabled, reason, stop_mode)


@frappe.whitelist()
def get_bff_csrf():
    """仅供同源 BFF 转发写请求；平台 session 响应不向产品前端暴露此值。"""
    if frappe.session.user in (None, "Guest"):
        frappe.throw("需要登录", frappe.PermissionError)
    return {"csrf_token": get_csrf_token()}


@frappe.whitelist()
def get_processes():
    return list_published_processes()


@frappe.whitelist()
def get_process_definitions():
    return list_process_definitions()


@frappe.whitelist(methods=["POST"])
def process_definition_create(title, business_object=None):
    return create_process_definition(title, business_object)


@frappe.whitelist()
def get_process_instances(view="started"):
    return list_process_instances(view)


@frappe.whitelist()
def get_process_instance(name):
    return get_instance_replay(name)


@frappe.whitelist(methods=["POST"])
def publish_process(definition_id, expected_revision=None):
    return publish_definition(definition_id, expected_revision)


@frappe.whitelist()
def process_design_context(definition_id):
    return get_design_context(definition_id)


@frappe.whitelist(methods=["POST"])
def process_draft_save(definition_id, graph, expected_revision):
    return save_process_draft(definition_id, graph, expected_revision)


@frappe.whitelist(methods=["POST"])
def process_validate(definition_id, graph=None):
    return validate_process_definition(definition_id, graph)


@frappe.whitelist(methods=["POST"])
def process_simulate(definition_id, sample=None, graph=None):
    return simulate_process(definition_id, sample, graph)


@frappe.whitelist(methods=["POST"])
def start_process_instance(definition_id, business_doctype=None, business_name=None, business_object_id=None):
    from shangshu_core.public_api.http import process_start
    return process_start(definition_id, business_doctype, business_name, business_object_id=business_object_id)


@frappe.whitelist(methods=["POST"])
def complete_execution(execution, token, selected_tool=None, output=None, reason=None, callback_id=None):
    return complete_node_execution(
        execution,
        token,
        selected_tool=selected_tool,
        output_data=output,
        reason=reason,
        callback_id=callback_id,
    )
