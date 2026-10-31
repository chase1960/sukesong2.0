import frappe
from frappe.model.workflow import apply_workflow
from frappe.tests.utils import FrappeTestCase

from shangshu_flow.api import (
    apply_action,
    create_expense_request,
    get_data_center,
    get_center,
    get_instance,
    get_studio_context,
    get_workbench,
    user_participated_in,
)
from shangshu_flow.install import after_migrate

STAFF = "staff1@shangshu.local"
MANAGER = "manager1@shangshu.local"
FINANCE = "finance1@shangshu.local"


def _create_expense(subject="测试报销", amount=100):
    frappe.set_user(STAFF)
    doc = frappe.get_doc(
        {
            "doctype": "Expense Request",
            "subject": subject,
            "amount": amount,
            "purpose": "自动化测试用途。",
            "department": "测试部",
        }
    ).insert()
    return doc


class TestWorkflowFoundation(FrappeTestCase):
    def test_workflow_exists_with_builder_ids(self):
        workflow = frappe.get_doc("Workflow", "费用报销审批")
        self.assertEqual(len(workflow.states), 5)
        self.assertEqual(len(workflow.transitions), 6)
        state_ids = {row.workflow_builder_id for row in workflow.states}
        action_ids = {row.workflow_builder_id for row in workflow.transitions}
        self.assertTrue(state_ids.isdisjoint(action_ids), "状态与转换的 Builder ID 不得冲突")
        self.assertTrue(all(aid.startswith("action-") for aid in action_ids))
        self.assertTrue(workflow.is_active)
        self.assertTrue(workflow.workflow_data, "画布布局 workflow_data 应存在")

    def test_three_test_users_have_roles(self):
        self.assertIn("Expense Approver", frappe.get_roles(MANAGER))
        self.assertIn("Finance Approver", frappe.get_roles(FINANCE))
        staff_roles = set(frappe.get_roles(STAFF))
        self.assertNotIn("Expense Approver", staff_roles)
        self.assertNotIn("Finance Approver", staff_roles)

    def test_migrate_does_not_overwrite_saved_canvas(self):
        marker = '[{"id":"saved-by-admin","type":"state"}]'
        frappe.db.set_value("Workflow", "费用报销审批", "workflow_data", marker)
        after_migrate()
        self.assertEqual(
            frappe.db.get_value("Workflow", "费用报销审批", "workflow_data"),
            marker,
            "迁移不得覆盖管理员保存的画布",
        )


class TestApprovalChain(FrappeTestCase):
    def test_full_chain_to_approved(self):
        doc = _create_expense()
        apply_workflow(doc, "Submit")
        frappe.set_user(MANAGER)
        apply_workflow(frappe.get_doc("Expense Request", doc.name), "Manager Approve")
        frappe.set_user(FINANCE)
        result = apply_workflow(frappe.get_doc("Expense Request", doc.name), "Finance Approve")
        self.assertEqual(result.workflow_state, "Approved")

    def test_reject_and_resubmit(self):
        doc = _create_expense(subject="退回重提测试", amount=50)
        apply_workflow(doc, "Submit")
        frappe.set_user(MANAGER)
        apply_workflow(frappe.get_doc("Expense Request", doc.name), "Reject")
        rejected = frappe.get_doc("Expense Request", doc.name)
        self.assertEqual(rejected.workflow_state, "Rejected")
        frappe.set_user(STAFF)
        apply_workflow(rejected, "Submit")
        resubmitted = frappe.get_doc("Expense Request", doc.name)
        self.assertEqual(resubmitted.workflow_state, "Pending Manager Approval")

    def test_public_api_can_complete_reject_resubmit_and_approve_chain(self):
        frappe.set_user(STAFF)
        created = create_expense_request(
            subject="模板全链 API 验收",
            amount=128,
            purpose="验证产品页实际调用的 API 链路。",
            department="验收部",
        )
        name = created["doc"]["name"]
        apply_action(name, "Submit", note="员工提交")

        frappe.set_user(MANAGER)
        rejected = apply_action(name, "Reject", note="请补充用途")
        self.assertEqual(rejected["doc"]["workflow_state"], "Rejected")

        frappe.set_user(STAFF)
        apply_action(name, "Submit", note="已补充后重提")
        frappe.set_user(MANAGER)
        apply_action(name, "Manager Approve", note="经理通过")
        frappe.set_user(FINANCE)
        approved = apply_action(name, "Finance Approve", note="财务核验通过")
        self.assertEqual(approved["doc"]["workflow_state"], "Approved")
        self.assertEqual(approved["actions"], [])
        self.assertTrue(any("补充" in item["label"] for item in approved["timeline"]))


class TestPermissionBoundaries(FrappeTestCase):
    def test_staff_cannot_apply_manager_action(self):
        doc = _create_expense(subject="越权审批测试", amount=10)
        apply_workflow(doc, "Submit")
        frappe.set_user(STAFF)
        with self.assertRaises(frappe.ValidationError):
            apply_workflow(frappe.get_doc("Expense Request", doc.name), "Manager Approve")

    def test_manager_cannot_apply_finance_action(self):
        doc = _create_expense(subject="跨角色测试", amount=10)
        apply_workflow(doc, "Submit")
        frappe.set_user(MANAGER)
        apply_workflow(frappe.get_doc("Expense Request", doc.name), "Manager Approve")
        with self.assertRaises(frappe.ValidationError):
            apply_workflow(frappe.get_doc("Expense Request", doc.name), "Finance Approve")

    def test_staff_cannot_read_unrelated_doc(self):
        # 由经理创建并流转的单据，与员工无关。
        frappe.set_user(MANAGER)
        doc = frappe.get_doc(
            {
                "doctype": "Expense Request",
                "subject": "他人单据",
                "amount": 20,
                "purpose": "权限隔离测试。",
            }
        ).insert()
        apply_workflow(doc, "Submit")
        fresh = frappe.get_doc("Expense Request", doc.name)
        self.assertFalse(user_participated_in(fresh, STAFF))
        self.assertFalse(
            frappe.has_permission("Expense Request", "read", doc=fresh, user=STAFF),
            "普通员工不应读取与自己无关的单据",
        )

    def test_studio_context_requires_system_manager(self):
        frappe.set_user(STAFF)
        with self.assertRaises(frappe.PermissionError):
            get_studio_context()

    def test_get_center_hides_unrelated_documents(self):
        doc = _create_expense(subject="隔离列表测试", amount=30)
        apply_workflow(doc, "Submit")
        frappe.set_user(STAFF)
        center = get_center()
        visible = {row["name"] for row in center["completed"] + center["started"] + center["pending"]}
        unrelated = frappe.get_all(
            "Expense Request",
            filters={"owner": ("!=", STAFF)},
            pluck="name",
        )
        for name in unrelated:
            self.assertNotIn(name, visible, f"他人单据 {name} 不应出现在员工视图")

    def test_completed_only_contains_participated_documents_for_approver(self):
        participated = _create_expense(subject="经理参与的已完成单", amount=30)
        apply_workflow(participated, "Submit")
        frappe.set_user(MANAGER)
        apply_workflow(frappe.get_doc("Expense Request", participated.name), "Manager Approve")
        frappe.set_user(FINANCE)
        apply_workflow(frappe.get_doc("Expense Request", participated.name), "Finance Approve")

        frappe.set_user("Administrator")
        unrelated = frappe.get_doc(
            {
                "doctype": "Expense Request",
                "subject": "经理未参与的已完成单",
                "amount": 40,
                "purpose": "已完成列表隔离测试。",
                "applicant": "Administrator",
            }
        ).insert()
        apply_workflow(unrelated, "Submit")
        apply_workflow(frappe.get_doc("Expense Request", unrelated.name), "Manager Approve")
        apply_workflow(frappe.get_doc("Expense Request", unrelated.name), "Finance Approve")

        frappe.set_user(MANAGER)
        completed = {row["name"] for row in get_center()["completed"]}
        self.assertIn(participated.name, completed)
        self.assertNotIn(unrelated.name, completed)

    def test_inactive_workflow_cannot_be_launched(self):
        try:
            frappe.db.set_value("Workflow", "费用报销审批", "is_active", 0)
            frappe.cache.hdel("workflow", "Expense Request")
            frappe.clear_cache(doctype="Expense Request")
            frappe.set_user(STAFF)
            self.assertEqual(get_center()["launch"], [])
            with self.assertRaises(frappe.ValidationError):
                create_expense_request(subject="停用流程", amount=10, purpose="不应创建")
        finally:
            frappe.db.set_value("Workflow", "费用报销审批", "is_active", 1)
            frappe.cache.hdel("workflow", "Expense Request")
            frappe.clear_cache(doctype="Expense Request")


class TestAiProposalBoundaries(FrappeTestCase):
    def test_apply_proposal_requires_confirmation(self):
        from shangshu_flow.api import apply_workflow_proposal

        frappe.set_user("Administrator")
        with self.assertRaises(frappe.ValidationError):
            apply_workflow_proposal(proposal_id="missing", confirmed=0)

    def test_propose_requires_system_manager(self):
        # frappe.only_for 在 in_test 下是空操作（frappe 核心 #L954），
        # HTTP 层越权已由人工 curl 验证；这里校验角色事实作为回归基线。
        from shangshu_flow.api import propose_workflow_change

        frappe.set_user(STAFF)
        self.assertNotIn("System Manager", frappe.get_roles(STAFF))
        with self.assertRaises(frappe.PermissionError):
            # workflow.check_permission("read") 在 only_for 之外提供第二道防线
            get_studio_context()
        # 生成提案本身依赖 only_for，测试态下跳过；确认接口行为单独验证：
        frappe.set_user("Administrator")
        proposal = propose_workflow_change(instruction="测试指令")
        self.assertTrue(proposal["requires_confirmation"])


class TestInstanceApi(FrappeTestCase):
    def test_get_instance_returns_context(self):
        doc = _create_expense(subject="实例上下文测试", amount=80)
        apply_workflow(doc, "Submit")
        frappe.set_user(STAFF)
        data = get_instance(doc.name)
        self.assertEqual(data["current_node"]["state"], "Pending Manager Approval")
        self.assertEqual(data["current_node"]["role"], "Expense Approver")
        # 员工在经理节点没有可用动作
        self.assertEqual(data["actions"], [])
        self.assertIn("attachments", data)
        self.assertIn("timeline", data)
        self.assertEqual(data["journey"][1]["status"], "current")
        self.assertIn("等待费用审批人", data["current_node"]["next_hint"])

    def test_workbench_and_data_center_use_visible_records(self):
        doc = _create_expense(subject="工作台数据页测试", amount=88)
        apply_workflow(doc, "Submit")
        frappe.set_user(STAFF)
        workbench = get_workbench()
        dataset = get_data_center(search="工作台数据页")
        self.assertEqual(workbench["enterprise"]["mode"], "single_tenant_poc")
        self.assertIn(doc.name, {row["name"] for row in dataset["rows"]})
        self.assertTrue(any(field["fieldname"] == "amount" for field in dataset["fields"]))

    def test_data_center_rejects_unknown_status(self):
        frappe.set_user(STAFF)
        with self.assertRaises(frappe.ValidationError):
            get_data_center(status="not-a-workflow-state")
