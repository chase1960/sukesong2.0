"""受管应用定义隔离数据库验证，拒绝任何业务站点。"""
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

root = Path(sys.argv[1]).resolve()
site = "employee-probe.localhost"
if root.parent != Path("/private/tmp") or not root.name.startswith("shangshu-agent-probe."):
    raise SystemExit("仅限专用隔离目录")
config = json.loads((root / "sites" / site / "site_config.json").read_text())
if config.get("db_socket") != str(root / "db.sock") or config.get("db_name") != "employee_probe":
    raise SystemExit("拒绝非隔离数据库")
os.chdir(root / "sites")
import frappe
frappe.init(site=site)
frappe.connect()
frappe.set_user("Administrator")
from shangshu_core.public_api import create_application_definition, get_application_definition, save_application_draft, application_catalog, list_domains
from shangshu_core import applications
from shangshu_core import design_support
from shangshu_core.public_api import publish_application_definition

try:
    for name in ("shangshu_application_definition", "shangshu_application_revision", "shangshu_application_release"):
        frappe.reload_doc("shangshu_core", "doctype", name, force=True)
    frappe.db.commit()
    before = application_catalog()
    key = "s1-" + frappe.generate_hash(length=16)
    app = create_application_definition("采购协同", key)
    same = create_application_definition("采购协同", key)
    assert same["id"] == app["id"] and same["idempotent"]
    assert app["status"] == "Draft" and app["draft_revision"] == 1
    context = get_application_definition(app["id"])
    assert context["design_context"]["release"] == applications.get_application_release_status(app["id"])
    assert context["design_context"]["domains"] == list_domains(include_disabled=True)
    assert any(role["id"] == "Desk User" for role in context["role_options"])
    assert not any(role["id"] in {"Guest", "All"} for role in context["role_options"])
    for role in ("Guest", "All", "role-does-not-exist"):
        invalid = dict(app["draft"], allowed_roles=[role])
        try:
            save_application_draft(app["id"], invalid, 1)
            raise AssertionError("无效应用角色不能保存")
        except frappe.ValidationError:
            pass
    try:
        create_application_definition("另一应用", key)
        raise AssertionError("同键异内容不能通过")
    except frappe.DuplicateEntryError:
        pass
    domains = {row["id"]: row for row in list_domains(include_disabled=True)}
    spec = app["draft"]
    spec["bindings"] = [
        {"kind":"datasets","resource_id":"finance.invoice","owner_domain":"com.shangshu.finance","version":domains["com.shangshu.finance"]["version"]},
        {"kind":"actions","resource_id":"platform.object.query","owner_domain":"com.shangshu.core","version":domains["com.shangshu.core"]["version"]},
    ]
    saved = save_application_draft(app["id"], spec, 1)
    assert saved["draft_revision"] == 2 and len(saved["draft"]["bindings"]) == 2
    assert save_application_draft(app["id"], spec, 2)["draft_revision"] == 2
    assert frappe.db.count(applications.REVISION, {"application": app["id"]}) == 2
    design = application_catalog(design=True)
    assert sum(item["id"] == app["id"] for item in design) == 1
    summary = next(item for item in design if item["id"] == app["id"])
    assert summary["source"] == "managed" and "draft" not in summary
    assert summary["resource_counts"]["datasets"] == 1
    options = get_application_definition(app["id"])["design_context"]["resource_options"]
    assert any(item["resource_id"] == "finance.invoice" and item["kind"] == "datasets" for item in options)
    # 内容相同但依赖声明升级，不能被“空保存”吞掉。
    altered = json.loads(json.dumps(list_domains(include_disabled=True)))
    finance = next(item for item in altered if item["id"] == "com.shangshu.finance")
    next(item for item in finance["contribution"]["datasets"] if item["id"] == "finance.invoice")["description"] = "依赖变更探针"
    point = "s1_dependency_noop_probe"
    frappe.db.savepoint(point)
    with patch.object(applications, "list_domains", return_value=altered):
        assert save_application_draft(app["id"], spec, 2)["draft_revision"] == 3
    frappe.db.rollback(save_point=point)
    for field, invalid in (("resource_id", "unknown.resource"), ("owner_domain", "com.shangshu.core"), ("version", "999.0.0")):
        bad = json.loads(json.dumps(spec))
        bad["bindings"][0][field] = invalid
        try:
            save_application_draft(app["id"], bad, 2)
            raise AssertionError("未知引用、错误归属和版本不能静默忽略")
        except frappe.ValidationError:
            pass
    try:
        save_application_draft(app["id"], spec, 1)
        raise AssertionError("旧 revision 不能覆盖")
    except frappe.TimestampMismatchError:
        pass
    disabled = json.loads(json.dumps(list(domains.values())))
    for domain in disabled:
        if domain["id"] == "com.shangshu.finance":
            domain["enabled"] = False
    with patch.object(applications, "list_domains", return_value=disabled):
        try:
            save_application_draft(app["id"], spec, 2)
            raise AssertionError("停用域不能新增引用")
        except frappe.ValidationError:
            pass
    assert frappe.db.count(applications.REVISION, {"application":app["id"]}) == 2
    history = frappe.get_doc(applications.REVISION, app["id"] + ":1")
    assert json.loads(history.definition_json)["bindings"] == []
    try:
        history.definition_json = "{}"
        history.save(ignore_permissions=True)
        raise AssertionError("历史不能覆盖")
    except frappe.ValidationError:
        pass
    with patch.object(frappe, "get_roles", return_value=["Desk User"]):
        try:
            application_catalog(design=True)
            raise AssertionError("员工不能读取统一设计目录")
        except frappe.PermissionError:
            pass
        try:
            get_application_definition(app["id"])
            raise AssertionError("员工不能读配置草稿")
        except frappe.PermissionError:
            pass
    identity = applications.get_identity()
    identity.enterprise_id = "different-enterprise"
    with patch.object(design_support, "get_identity", return_value=identity):
        try:
            get_application_definition(app["id"])
            raise AssertionError("管理员也不能跨企业读取草稿")
        except frappe.PermissionError:
            pass
    assert application_catalog() == before  # 未发布草稿不污染员工目录。
    frappe.db.commit()
    frappe.destroy()
    frappe.init(site=site)
    frappe.connect()
    frappe.set_user("Administrator")
    assert get_application_definition(app["id"])["draft_revision"] == 2
    published = publish_application_definition(app["id"], 2)
    assert published["published_revision"] == app["id"] + ":2"
    from shangshu_core.public_api import set_domain_enabled, set_application_enabled
    try:
        set_domain_enabled("com.shangshu.finance", False, "隔离依赖阻断测试")
        raise AssertionError("被发布应用引用的域不能停用")
    except frappe.ValidationError:
        pass
    publish_application_definition(app["id"], 2)
    status = applications.get_application_release_status(app["id"])
    assert status["available"] and len(status["releases"]) == 1
    with patch.object(applications, "list_domains", return_value=disabled):
        status = applications.get_application_release_status(app["id"])
        assert not status["available"] and status["issues"][0]["code"] == "domain_disabled"
        assert not any(item["id"] == app["id"] for item in applications.published_application_catalog())
    visible = next(item for item in application_catalog(True, True) if item["id"] == app["id"])
    assert visible["title"] == "采购协同" and len(visible["resources"]["datasets"]) == 1
    changed = json.loads(json.dumps(spec))
    changed["title"] = "未发布的新名称"
    save_application_draft(app["id"], changed, 2)
    assert next(item for item in application_catalog() if item["id"] == app["id"])["title"] == "采购协同"
    with patch.object(frappe, "get_roles", return_value=["Guest"]):
        assert not any(item["id"] == app["id"] for item in applications.published_application_catalog())
    publish_application_definition(app["id"], 3)
    releases = applications.get_application_release_status(app["id"])["releases"]
    assert len(releases) == 2 and releases[0]["previous_revision"] == app["id"] + ":2"
    assert next(item for item in application_catalog() if item["id"] == app["id"])["title"] == "未发布的新名称"
    assert save_application_draft(app["id"], changed, 3)["draft_revision"] == 3
    changed["description"] = "测试新的真实修订"
    save_application_draft(app["id"], changed, 3)
    from shangshu_core.shangshu_core.doctype.shangshu_application_definition.shangshu_application_definition import ShangshuApplicationDefinition
    with patch.object(ShangshuApplicationDefinition, "save", side_effect=RuntimeError("test publish failure")):
        try:
            publish_application_definition(app["id"], 4)
            raise AssertionError("发布保存失败应抛出")
        except RuntimeError:
            pass
    status = applications.get_application_release_status(app["id"])
    assert status["published_revision"] == app["id"] + ":3" and len(status["releases"]) == 2
    release = frappe.get_doc(applications.RELEASE, releases[0]["name"])
    release.previous_revision = None
    try:
        release.save(ignore_permissions=True)
        raise AssertionError("发布审计不能覆盖")
    except frappe.ValidationError:
        pass
    # 仅将本次隔离测试应用停用，保留修订证据，不污染后续基线目录断言。
    set_application_enabled(app["id"], False, "隔离停用", 4)
    assert not any(item["id"] == app["id"] for item in application_catalog())
    set_application_enabled(app["id"], True, "隔离恢复", 4)
    assert any(item["id"] == app["id"] for item in application_catalog())
    set_application_enabled(app["id"], False, "隔离测试归档", 4)
    assert frappe.db.count(applications.REVISION, {"application":app["id"]}) == 4
    point = "s1_missing_binding_probe"
    frappe.db.savepoint(point)
    missing_domains = json.loads(json.dumps(list_domains(include_disabled=True)))
    source = next(item for item in missing_domains if item["id"] == "com.shangshu.finance")
    source["contribution"]["datasets"] = [item for item in source["contribution"]["datasets"] if item["id"] != "finance.invoice"]
    with patch.object(applications, "list_domains", return_value=missing_domains):
        try:
            save_application_draft(app["id"], changed, 4)
            raise AssertionError("失效引用未移除时仍应阻断")
        except frappe.ValidationError:
            pass
        removed = dict(changed, bindings=[item for item in changed["bindings"] if item["resource_id"] != "finance.invoice"])
        result = save_application_draft(app["id"], removed, 4)
        assert result["draft_revision"] == 5 and result["published_revision"] == app["id"] + ":3"
    frappe.db.rollback(save_point=point)
    frappe.db.commit()
    print("PASS application create/retry/conflict/cross-domain refs/revision history/permissions/reconnect/legacy catalog")
finally:
    frappe.db.rollback()
    frappe.destroy()
