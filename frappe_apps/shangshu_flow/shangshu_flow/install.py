import json

import frappe
from frappe.utils import add_days, nowdate

WORKFLOW_NAME = "费用报销审批"
DEMO_EXPENSE = "EXP-DEMO-0001"

TEST_USERS = (
    # (email, full_name, roles)
    ("staff1@shangshu.local", "尚小员", ("Desk User",)),
    ("manager1@shangshu.local", "尚经理", ("Desk User", "Expense Approver")),
    ("finance1@shangshu.local", "尚财务", ("Desk User", "Finance Approver")),
)
TEST_USER_PASSWORD = "shangshu123"

# 画布坐标：Frappe Workflow Builder 依据 workflow_data 恢复节点位置。
STATE_LAYOUT = {
    "Draft": (0, 170),
    "Pending Manager Approval": (430, 170),
    "Pending Finance Review": (860, 90),
    "Approved": (1290, 90),
    "Rejected": (860, 330),
}
ACTION_LAYOUT = {
    "action-1": (215, 170),
    "action-2": (645, 130),
    "action-3": (645, 270),
    "action-4": (1075, 90),
    "action-5": (1075, 200),
    "action-6": (645, 330),
}
TRANSITIONS = (
    # (state, action, next_state, allowed, builder_id)
    ("Draft", "Submit", "Pending Manager Approval", "Desk User", "action-1"),
    ("Pending Manager Approval", "Manager Approve", "Pending Finance Review", "Expense Approver", "action-2"),
    ("Pending Manager Approval", "Reject", "Rejected", "Expense Approver", "action-3"),
    ("Pending Finance Review", "Finance Approve", "Approved", "Finance Approver", "action-4"),
    ("Pending Finance Review", "Reject", "Rejected", "Finance Approver", "action-5"),
    ("Rejected", "Submit", "Pending Manager Approval", "Desk User", "action-6"),
)
STATES = (
    # (state, doc_status, allow_edit, builder_id)
    ("Draft", "0", "Desk User", "1"),
    ("Pending Manager Approval", "0", "Expense Approver", "2"),
    ("Pending Finance Review", "0", "Finance Approver", "3"),
    ("Approved", "1", "System Manager", "4"),
    ("Rejected", "0", "Desk User", "5"),
)


def after_install():
    ensure_foundation()
    ensure_login_foundation()
    seed_demo()
    mark_setup_complete()
    ensure_localization()


def after_migrate():
    """迁移只能补缺，不能覆盖管理员已经保存的流程定义和画布坐标。"""
    if not frappe.db.exists("Workflow", WORKFLOW_NAME):
        ensure_foundation()
    ensure_login_foundation()  # 无条件：升级站点也要补齐登录配置
    mark_setup_complete()
    ensure_localization()


def ensure_localization():
    """站点语言切简体中文：Builder 的 __() 翻译生效，产品术语由 App 自带 zh.csv 覆盖。

    注意：本版 get_user_lang 的回退链不查 System Settings.language，
    因此必须把 User.language 显式设为 zh，用户级缓存随 ORM 写入自动失效。
    """
    frappe.db.set_single_value("System Settings", "language", "zh")
    frappe.db.sql("update `tabUser` set language = 'zh' where ifnull(language, '') != 'zh'")
    # 本地化默认管理员显示名（登录名与权限不变，仅显示）。
    if frappe.db.get_value("User", "Administrator", "first_name") in (None, "", "Administrator"):
        frappe.db.set_value("User", "Administrator", "first_name", "管理员")
    # 企业内部系统：关闭 Guest 自助注册（登录页入口与后端 sign_up 同一开关）。
    frappe.db.set_single_value("Website Settings", "disable_signup", 1)
    frappe.clear_cache()
    frappe.db.commit()


def before_tests():
    """固定密码账号仅供测试环境使用，绝不在正常安装时创建。"""
    ensure_foundation()
    ensure_login_foundation()
    create_test_users()


def ensure_foundation():
    for role in ("Expense Approver", "Finance Approver"):
        if not frappe.db.exists("Role", role):
            frappe.get_doc({"doctype": "Role", "role_name": role}).insert(ignore_permissions=True)

    administrator = frappe.get_doc("User", "Administrator")
    administrator.add_roles("Expense Approver", "Finance Approver")

    for state, style in (
        ("Draft", "Primary"),
        ("Pending Manager Approval", "Warning"),
        ("Pending Finance Review", "Warning"),
        ("Approved", "Success"),
        ("Rejected", "Danger"),
    ):
        if not frappe.db.exists("Workflow State", state):
            frappe.get_doc(
                {"doctype": "Workflow State", "workflow_state_name": state, "style": style}
            ).insert(ignore_permissions=True)

    for action in ("Submit", "Manager Approve", "Finance Approve", "Reject"):
        if not frappe.db.exists("Workflow Action Master", action):
            frappe.get_doc(
                {"doctype": "Workflow Action Master", "workflow_action_name": action}
            ).insert(ignore_permissions=True)

    workflow = frappe.get_doc("Workflow", WORKFLOW_NAME) if frappe.db.exists("Workflow", WORKFLOW_NAME) else frappe.new_doc("Workflow")
    workflow.update(
        {
            "workflow_name": WORKFLOW_NAME,
            "document_type": "Expense Request",
            "is_active": 1,
            "send_email_alert": 0,
            "workflow_state_field": "workflow_state",
            "states": [],
            "transitions": [],
        }
    )
    for state, doc_status, allow_edit, builder_id in STATES:
        workflow.append(
            "states",
            {
                "state": state,
                "doc_status": doc_status,
                "allow_edit": allow_edit,
                # Builder 的规范 ID：状态为纯数字，转换为 action-N，两者不可冲突。
                "workflow_builder_id": builder_id,
            },
        )

    for state, action, next_state, allowed, builder_id in TRANSITIONS:
        workflow.append(
            "transitions",
            {
                "state": state,
                "action": action,
                "next_state": next_state,
                "allowed": allowed,
                "allow_self_approval": 1,
                "workflow_builder_id": builder_id,
            },
        )

    workflow.workflow_data = json.dumps(build_workflow_data())

    if workflow.is_new():
        workflow.insert(ignore_permissions=True)
    else:
        workflow.save(ignore_permissions=True)
    frappe.clear_cache(doctype="Expense Request")
    frappe.db.commit()


def build_workflow_data():
    """生成 Builder 可恢复的画布 JSON：状态、动作节点与连线位置。"""
    elements = []
    state_ids = {}
    for state, _doc_status, _allow_edit, builder_id in STATES:
        state_ids[state] = builder_id
        x, y = STATE_LAYOUT[state]
        elements.append({"id": builder_id, "type": "state", "position": {"x": x, "y": y}})
    for from_state, _action, to_state, _allowed, builder_id in TRANSITIONS:
        x, y = ACTION_LAYOUT[builder_id]
        elements.append(
            {
                "id": builder_id,
                "type": "action",
                "position": {"x": x, "y": y},
                "data": {"from_id": state_ids[from_state], "to_id": state_ids[to_state]},
            }
        )
        elements.append(transition_edge(state_ids[from_state], builder_id))
        elements.append(transition_edge(builder_id, state_ids[to_state]))
    return elements


def transition_edge(source, target):
    return {
        "id": f"edge-{source}-{target}",
        "type": "transition",
        "source": source,
        "target": target,
        "sourceHandle": "right",
        "targetHandle": "left",
        "updatable": True,
        "animated": True,
    }


def seed_demo():
    if frappe.db.exists("Expense Request", DEMO_EXPENSE):
        return
    doc = frappe.get_doc(
        {
            "doctype": "Expense Request",
            "name": DEMO_EXPENSE,
            "subject": "上海客户现场差旅报销",
            "amount": 2680,
            "expense_date": add_days(nowdate(), -2),
            "department": "销售部",
            "cost_center": "华东区",
            "applicant": "Administrator",
            "purpose": "客户实施启动会，含高铁、住宿及市内交通。",
            "ai_summary": "票据金额与申请金额一致；建议经理确认项目归属后流转财务。",
        }
    ).insert(ignore_permissions=True, set_name=DEMO_EXPENSE)
    from frappe.model.workflow import apply_workflow

    apply_workflow(doc, "Submit")
    frappe.get_doc(
        {
            "doctype": "Process Copy",
            "reference_doctype": "Expense Request",
            "reference_name": doc.name,
            "user": "Administrator",
            "note": "项目费用同步",
        }
    ).insert(ignore_permissions=True)
    frappe.db.commit()


def ensure_login_foundation(commit=True):
    """登录配置：非破坏性幂等，绝不触碰 Workflow / states / transitions / workflow_data。

    默认落地由 `auth.on_login_after_request`（after_request）实现，无需额外
    Workspace。此处不做任何删除：不自动删除 Workspace，不改动用户数据，
    也不写 frappe.log_error。仅把测试账号上可能遗留的 default_workspace 清空
    （登录落地已不依赖它），使升级站点与空站都只依赖 Page 版落地。
    """
    from shangshu_flow.auth import TEST_ACCOUNT_EMAILS

    for email in TEST_ACCOUNT_EMAILS:
        if frappe.db.exists("User", email) and frappe.db.get_value(
            "User", email, "default_workspace"
        ) == "shangshu-process-center":
            frappe.db.set_value("User", email, "default_workspace", "")

    if commit:
        frappe.db.commit()


def _create_test_user(email, full_name, password, roles=(), commit=False):
    """测试专用：幂等创建单个系统用户。`password` 为必填，不得默认使用固定密码。

    仅被测试与 create_test_users 调用；正常安装/迁移路径绝不调用。
    `commit=False`（默认）不提交事务，供测试复用；`commit=True` 立即提交。
    """
    if not password:
        raise ValueError("测试用户必须显式提供密码")
    if frappe.db.exists("User", email):
        user = frappe.get_doc("User", email)
    else:
        user = frappe.get_doc(
            {
                "doctype": "User",
                "email": email,
                "first_name": full_name,
                "username": email.split("@")[0],
                "enabled": 1,
                "send_welcome_email": 0,
                "user_type": "System User",
            }
        )
        user.flags.ignore_permissions = True
        user.flags.no_welcome_mail = True
        user.insert(ignore_permissions=True)
        # 新建用户后才能设置密码。
        from frappe.utils.password import update_password

        update_password(user.name, password)
    existing = {row.role for row in user.roles or []}
    for role in roles:
        if role not in existing:
            user.append("roles", {"role": role})
    user.save(ignore_permissions=True)
    if commit:
        frappe.db.commit()
    return user


def create_test_users():
    """三个固定测试用户：普通员工 / 经理 / 财务，用于完整链路验证。"""
    for email, full_name, roles in TEST_USERS:
        _create_test_user(email, full_name, TEST_USER_PASSWORD, roles)
    frappe.db.commit()


def mark_setup_complete():
    """无头安装时跳过 setup wizard 拦截（v15 依据 Installed Application 判断）。"""
    for app in ("frappe", "shangshu_flow"):
        if frappe.db.exists("Installed Application", {"app_name": app}):
            frappe.db.set_value("Installed Application", {"app_name": app}, "is_setup_complete", 1)
    frappe.db.set_single_value("System Settings", "setup_complete", 1)
