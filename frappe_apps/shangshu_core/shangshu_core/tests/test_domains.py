import copy

import frappe
from frappe.tests.utils import FrappeTestCase
from unittest.mock import patch

from shangshu_core.domains import (
    CORE_DOMAIN_ID,
    _normalize_workbench_cards,
    _providers,
    _validate_contributions,
    application_catalog,
    ensure_registered_domains,
    list_domains,
    platform_contributions,
    query_dataset,
    role_capabilities,
    set_domain_enabled,
    workbench_data,
)
from shangshu_core.runtime import create_process_definition, list_process_definitions, list_published_processes, start_process
from shangshu_core.api import get_applications


FINANCE = "com.shangshu.finance"
PROCESS = "com.shangshu.finance.expense_approval"


class TestDomainControlPlane(FrappeTestCase):
    def test_manifest_dependency_versions_missing_targets_and_cycles(self):
        from shangshu_core.manifest import check_registered_manifests
        import yaml
        original = yaml.safe_load
        def loader(change):
            def load(text):
                manifest = original(text)
                if manifest["id"] == FINANCE:
                    manifest["dependencies"] = change
                return manifest
            return load
        for dependencies in ([CORE_DOMAIN_ID + '@">=99.0"'],
                             ['com.shangshu.missing@">=0.1"'],
                             [CORE_DOMAIN_ID + '@"not-a-version"']):
            with patch("shangshu_core.manifest.yaml.safe_load", side_effect=loader(dependencies)):
                with self.assertRaises(frappe.ValidationError):
                    check_registered_manifests()
        def cycle(text):
            manifest = original(text)
            if manifest["id"] == CORE_DOMAIN_ID:
                manifest["dependencies"] = [FINANCE + '@">=0.1"']
            return manifest
        with patch("shangshu_core.manifest.yaml.safe_load", side_effect=cycle):
            with self.assertRaisesRegex(frappe.ValidationError, "循环"):
                check_registered_manifests()
        # ⚠️ **2026-10-26（PKG-119-T01 订正）**：这一段原来把财务域的依赖改成**只有 core**
        # ⇒ 期望它过检。**但内核的规则是「manifest 的 dependencies 必须与 App 的
        # required_apps 一致」**（`manifest.py` 的「manifest 依赖与 App 依赖不一致」那道闸）
        # ⇒ 财务域的 `required_apps` 2026-10-22（`c3f8dedbb`）起就含**文件域**了
        # ⇒ 只写 core **本来就该被拒** ⇒ **这条判据自己过期了**
        # （它要站点才跑 ⇒ **离线基线结构上看不见这条红** ⇒ 一直没人发现）。
        # ⇒ 改法：把**合法的依赖集**补齐（core ＋ files）⇒ **断的还是同一件事**
        #（「版本写法对不对」），只是不再自相矛盾。
        with patch("shangshu_core.manifest.yaml.safe_load", side_effect=loader(
                [CORE_DOMAIN_ID + '@">=0.1 <1.0"', 'com.shangshu.files@">=0.12 <1.0"'])):
            self.assertIn(FINANCE, check_registered_manifests()["checked"])
        self.assertIn(FINANCE, check_registered_manifests()["checked"])

    def test_migration_stops_before_foundation_when_manifest_check_fails(self):
        from shangshu_core.install import after_migrate
        with patch("shangshu_core.manifest.check_registered_manifests", side_effect=frappe.ValidationError("依赖版本不兼容")), \
                patch("shangshu_core.install.ensure_foundation") as foundation:
            with self.assertRaises(frappe.ValidationError):
                after_migrate()
            foundation.assert_not_called()

    def setUp(self):
        frappe.set_user("Administrator")
        ensure_registered_domains()
        # These tests isolate finance lifecycle; the separately tested orders
        # consumer is installed in the integrated baseline but not active here.
        dependent = 'com.shangshu.orders'
        enabled = frappe.db.get_value('Shangshu Domain', dependent, 'enabled')
        if enabled is not None:
            frappe.db.set_value('Shangshu Domain', dependent, 'enabled', 0)
            self.addCleanup(frappe.db.set_value, 'Shangshu Domain', dependent, 'enabled', enabled)
        if not frappe.db.get_value("Shangshu Domain", FINANCE, "enabled"):
            set_domain_enabled(FINANCE, 1, "测试准备：恢复财务")
        # 此组验证财务本身；六App组合中先正常停用其强依赖消费者，不能绕过生命周期。
        self.orders_enabled=bool(frappe.db.get_value('Shangshu Domain','com.shangshu.orders','enabled'))
        if self.orders_enabled:set_domain_enabled('com.shangshu.orders',False,'测试隔离财务消费者')

    def tearDown(self):
        frappe.set_user("Administrator")
        if frappe.db.exists("Shangshu Domain", FINANCE) and not frappe.db.get_value("Shangshu Domain", FINANCE, "enabled"):
            set_domain_enabled(FINANCE, 1, "测试清理：恢复财务")
        if self.orders_enabled:set_domain_enabled('com.shangshu.orders',True,'测试恢复财务消费者')

    def test_registration_is_idempotent_and_does_not_override_admin_state(self):
        set_domain_enabled(FINANCE, 0, "验证迁移不覆盖管理员停用状态")
        ensure_registered_domains()
        self.assertEqual(frappe.db.get_value("Shangshu Domain", FINANCE, "enabled"), 0)
        disabled = next(row for row in list_domains(include_disabled=True) if row["id"] == FINANCE)
        self.assertFalse(disabled["enabled"])
        self.assertNotIn("query", str(disabled["contribution"]))

    def test_disable_filters_resources_and_blocks_new_business(self):
        self.assertIn(PROCESS, {row["definition_id"] for row in list_published_processes()})
        before = platform_contributions()
        expected = {
            section: {row["id"] for row in before[section] if row.get("domain_id") != FINANCE}
            for section in ("datasets", "processes", "tools", "applications")
        }
        set_domain_enabled(FINANCE, 0, "验证纯内核资源裁剪")
        contributions = platform_contributions()
        for section in expected:
            self.assertEqual({row["id"] for row in contributions[section]}, expected[section])
            self.assertFalse(any(row.get("domain_id") == FINANCE for row in contributions[section]))
        # 自建应用不属于代码域贡献，不能把它们当成停用财务后应消失的资源。
        catalog = application_catalog()
        self.assertEqual({row["id"] for row in catalog if row.get("source") != "managed"}, expected["applications"])
        self.assertFalse(any(row.get("domain_id") == FINANCE for row in catalog))
        self.assertNotIn(PROCESS, {row["definition_id"] for row in list_published_processes()})
        self.assertEqual(role_capabilities(["Finance Approver"]), {})
        with self.assertRaises(frappe.PermissionError):
            start_process(PROCESS)
        with self.assertRaises(frappe.PermissionError):
            query_dataset("finance.invoice")

    def test_application_catalog_projects_real_domain_resources(self):
        application = next(row for row in application_catalog(include_resources=True) if row["id"] == "com.shangshu.finance.expense_management")
        self.assertEqual(application["title"], "费用管理")
        self.assertEqual(application["primary_action"]["target"], PROCESS)
        self.assertEqual(application["resource_counts"]["datasets"], 5)
        self.assertEqual(application["resource_counts"]["processes"], 1)
        self.assertEqual(len(application["resources"]["actions"]), 13)
        self.assertTrue(all(step["complete"] for step in application["setup_steps"]))

    def test_staff_only_reads_visible_applications_and_cannot_enter_design_mode(self):
        email = f"coretest-staff-{frappe.generate_hash(length=8)}@shangshu.local"
        user = frappe.get_doc({
            "doctype": "User", "email": email, "first_name": "Core Test Staff",
            "enabled": 1, "user_type": "System User", "send_welcome_email": 0,
        })
        user.append("roles", {"role": "Desk User"})
        user.insert(ignore_permissions=True)
        try:
            frappe.set_user(email)
            application = next(row for row in application_catalog() if row["id"] == "com.shangshu.finance.expense_management")
            visible = {row["id"] for row in application["datasets"]}
            self.assertIn("finance.invoice", visible)
            self.assertIn("finance.expense_claim", visible)
            self.assertNotIn("finance.payable", visible)
            self.assertNotIn("finance.ledger_entry", visible)
            self.assertNotIn("finance.cash_movement", visible)
            self.assertNotIn("finance.payable", {row["id"] for row in platform_contributions()["datasets"]})
            with self.assertRaises(frappe.PermissionError):
                get_applications(design=1)
        finally:
            frappe.set_user("Administrator")
            if frappe.db.exists("User", email):
                frappe.delete_doc("User", email, ignore_permissions=True, force=True)

    def test_enable_disable_is_audited_and_reenable_is_idempotent(self):
        # **统一日志库**（PKG-020-T01）：域变更审计只写统一表这一处。
        before = frappe.db.count("Shangshu Unified Log", {"what_kind": "domain_change", "domain_id": FINANCE})
        before_versions = frappe.db.count("Shangshu Process Definition Version", {"definition": frappe.db.get_value("Shangshu Process Definition", {"definition_id": PROCESS}, "name")})
        before_definition = frappe.db.get_value("Shangshu Process Definition", {"definition_id": PROCESS}, ["last_published_version", "graph_json"], as_dict=True)
        changed = set_domain_enabled(FINANCE, 0, "测试停用")
        duplicate = set_domain_enabled(FINANCE, 0, "重复停用")
        restored = set_domain_enabled(FINANCE, 1, "测试恢复")
        duplicate_restore = set_domain_enabled(FINANCE, 1, "重复恢复")
        self.assertTrue(changed["changed"])
        self.assertFalse(duplicate["changed"])
        self.assertTrue(restored["changed"])
        self.assertFalse(duplicate_restore["changed"])
        self.assertEqual(frappe.db.count("Shangshu Unified Log", {"what_kind": "domain_change", "domain_id": FINANCE}), before + 2)
        ensure_registered_domains()
        after_definition = frappe.db.get_value("Shangshu Process Definition", {"definition_id": PROCESS}, ["last_published_version", "graph_json"], as_dict=True)
        self.assertEqual(after_definition, before_definition)
        self.assertEqual(frappe.db.count("Shangshu Process Definition Version", {"definition": frappe.db.get_value("Shangshu Process Definition", {"definition_id": PROCESS}, "name")}), before_versions)
        self.assertEqual(len([row for row in list_domains(include_disabled=True) if row["id"] == FINANCE]), 1)

    def test_non_manager_cannot_change_domain_state(self):
        frappe.set_user("staff1@shangshu.local")
        with self.assertRaises(frappe.PermissionError):
            set_domain_enabled(FINANCE, 0, "越权停用")

    def test_a_domain_that_still_owns_data_is_named_before_it_can_be_stopped(self):
        """**名下还有「没人接手的数据」⇒ 停用被点名拦**（域拆了数据不会跟着走）。

        2026-10-25 用户拍板：受管记录在内核的物理表里、DocType 行在 Frappe 里
        ⇒ 逻辑没了、数据成了孤儿 ⇒ 停用前必须先处理 ⇒ 这里点名（哪张表、多少条）。
        """
        from shangshu_core.lifecycle import domain_lifecycle

        # 财务域的「发票」是**自建 DocType** 那条路（不是受管对象）⇒ 断的是 DocType 行数。
        doctype = "Shangshu Finance Invoice"
        expected = frappe.db.count(doctype)
        blockers = domain_lifecycle(FINANCE)["disable_blockers"]
        named = [item for item in blockers if doctype in item]
        if expected:
            self.assertTrue(named, "名下还有 %d 行数据，停用却没有被点名：%s" % (expected, blockers))
            self.assertIn(str(expected), named[0])
            self.assertIn("没人接手", named[0])
        else:
            self.assertFalse(named, "这张表没有数据，却被算成「还有数据没人接手」：%s" % named)

    def test_platform_core_cannot_be_disabled_and_registration_repairs_legacy_state(self):
        before = frappe.db.count("Shangshu Unified Log", {"what_kind": "domain_change", "domain_id": CORE_DOMAIN_ID})
        with self.assertRaises(frappe.PermissionError):
            set_domain_enabled(CORE_DOMAIN_ID, 0, "不应允许停用平台核心")
        self.assertEqual(frappe.db.get_value("Shangshu Domain", CORE_DOMAIN_ID, "enabled"), 1)
        self.assertEqual(frappe.db.count("Shangshu Unified Log", {"what_kind": "domain_change", "domain_id": CORE_DOMAIN_ID}), before)
        try:
            frappe.db.set_value("Shangshu Domain", CORE_DOMAIN_ID, {
                "enabled": 0,
                "disabled_by": "Administrator",
                "disabled_reason": "模拟旧版本错误状态",
            }, update_modified=False)
            ensure_registered_domains()
            repaired = frappe.db.get_value(
                "Shangshu Domain", CORE_DOMAIN_ID,
                ["enabled", "disabled_by", "disabled_reason"], as_dict=True,
            )
            self.assertEqual(repaired.enabled, 1)
            self.assertFalse(repaired.disabled_by)
            self.assertFalse(repaired.disabled_reason)
        finally:
            frappe.db.set_value("Shangshu Domain", CORE_DOMAIN_ID, {
                "enabled": 1, "disabled_by": None, "disabled_reason": None,
            }, update_modified=False)

    def test_workbench_v1_rejects_unsupported_declaration_and_private_provider(self):
        finance = copy.deepcopy(next(item for item in _providers() if item["id"] == FINANCE))
        finance["workbench"][0]["kind"] = "chart"
        with self.assertRaises(frappe.ValidationError):
            _validate_contributions([finance])
        finance = copy.deepcopy(next(item for item in _providers() if item["id"] == FINANCE))
        finance["workbench_provider"] = "another_app.dashboard.cards"
        with self.assertRaises(frappe.PermissionError):
            _validate_contributions([finance])

    def test_workbench_provider_cannot_add_undeclared_cards_or_spoof_domain(self):
        finance = copy.deepcopy(next(item for item in _providers() if item["id"] == FINANCE))
        with self.assertRaises(frappe.PermissionError):
            _normalize_workbench_cards(finance, [{"id": "finance.hidden", "value": 1}])
        with self.assertRaises(frappe.PermissionError):
            _normalize_workbench_cards(finance, [{
                "id": "finance.pending_claims", "value": 1, "domain_id": CORE_DOMAIN_ID,
            }])

    def test_workbench_cards_are_declared_normalized_and_owned(self):
        cards = workbench_data()
        finance_cards = [card for card in cards if card["domain_id"] == FINANCE]
        self.assertEqual({card["id"] for card in finance_cards}, {
            "finance.pending_claims", "finance.open_payables", "finance.invoices",
        })
        self.assertTrue(all(card["kind"] == "metric" for card in finance_cards))
        self.assertTrue(all(isinstance(card["value"], (str, int, float)) for card in finance_cards))

    def test_core_can_create_and_reopen_an_unpublished_blank_process(self):
        created = create_process_definition("客户资料归档")
        self.assertEqual(created["status"], "Draft")
        row = next(item for item in list_process_definitions() if item.definition_id == created["definition_id"])
        self.assertEqual(row.title, "客户资料归档")
        self.assertFalse(row.last_published_version)
        frappe.set_user("staff1@shangshu.local")
        with self.assertRaises(frappe.PermissionError):
            create_process_definition("越权流程")

    def test_new_empty_domain_registers_through_contribution_without_private_core_change(self):
        domain_id = "com.shangshu.contract.probe"
        contribution = {
            "id": domain_id,
            "name": "契约探针",
            "owner_app": "contract_probe",
            "version": "1.0.0",
            "platform_api": ">=1.0 <2.0",
            "default_enabled": True,
            "health": {"status": "healthy", "message": "只验证注册面"},
            "applications": [], "navigation": [], "workbench": [], "objects": [], "datasets": [],
            "processes": [], "actions": [], "tools": [], "services": [], "events": [],
            "subscriptions": [], "roles": [], "pages": [],
        }
        current = _providers()
        try:
            with patch("shangshu_core.domains._providers", return_value=[*current, contribution]):
                ensure_registered_domains()
                projected = platform_contributions()
                self.assertIn(domain_id, {row["id"] for row in projected["domains"]})
                self.assertEqual([row for row in application_catalog() if row.get("domain_id") == domain_id], [])
        finally:
            if frappe.db.exists("Shangshu Domain", domain_id):
                frappe.delete_doc("Shangshu Domain", domain_id, ignore_permissions=True, force=True)

    def test_duplicate_domain_id_is_rejected_before_registration(self):
        contribution = {
            "id": "com.shangshu.contract.duplicate",
            "name": "重复领域",
            "owner_app": "contract_probe",
            "version": "1.0.0",
            "platform_api": ">=1.0 <2.0",
        }
        with patch("shangshu_core.domains._providers", return_value=[contribution, dict(contribution)]):
            with self.assertRaises(frappe.DuplicateEntryError):
                ensure_registered_domains()
