"""身份与账号生命周期：平台模式下唯一的管理入口。

平台模式的身份权威是 Frappe ``User`` + ``Shangshu Identity``。本模块只操作这两者，
不读写 Node 兼容用户表，避免出现第二身份权威。

- 读：``list_identities`` 供 System Manager 查看账号、角色、平台角色与协作分组；不返回密码、会话或任何凭据。
- 写：注册为受管 Action（``platform.identity.*``），复用既有确认、幂等与执行审计；
  本模块的 handler 被 Action 调用，不自行 commit，也不提供绕过确认的直接写入口。

角色词汇用平台角色（admin/manager/finance/staff）并在此处集中映射到 Frappe Role，
管理员不需要理解底层角色名；反向的能力→平台角色映射由 BFF 单点实现，不在前端重复。
"""

import re

import frappe
from frappe.utils.password import update_password

from shangshu_core.domains import platform_contributions, role_capabilities
from shangshu_core.identity import ensure_identity_for_user

GROUPS = ("管理", "开发", "财务")
PLATFORM_ROLES = ("admin", "manager", "finance", "staff")
ROLE_MAP = {
    "admin": ["System Manager"],
    "manager": ["Desk User", "Collaboration Manager"],
    "finance": ["Desk User", "Finance Approver", "Cashier"],
    "staff": ["Desk User"],
}
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
# 登录用户名（选填）：小写短名，禁 @ 与空格——保证不会和任何邮箱形账号名混淆，
# 登录匹配（name OR username）才不会命中第二个人。
USERNAME = re.compile(r"^[a-z0-9][a-z0-9._-]{1,30}$")
MIN_PASSWORD = 8


def _requested_roles(payload, default=None):
    """兼容旧单角色请求；组合角色仍以 Frappe Role 为唯一事实。"""
    if 'roles' in payload and 'role' in payload:
        frappe.throw('role 与 roles 不能同时提交', frappe.ValidationError)
    values = payload.get('roles', [payload.get('role', default)])
    if (not isinstance(values, list) or not values
            or any(not isinstance(value, str) or value not in PLATFORM_ROLES for value in values)
            or len(set(values)) != len(values)):
        frappe.throw('请选择至少一个有效且不重复的平台角色', frappe.ValidationError)
    return values


def _platform_roles(roles):
    """Frappe 角色 → 平台角色投影。与 BFF 登录会话的映射保持同一规则：
    expense_approve（业务费用审批授权）同样按协作管理呈现，避免清单与会话各说各话。"""
    capabilities = role_capabilities(roles)
    values = []
    if 'System Manager' in roles:
        values.append('admin')
    if 'collaboration_manage' in capabilities or 'expense_approve' in capabilities:
        values.append('manager')
    if 'finance_review' in capabilities or 'finance_payment' in capabilities:
        values.append('finance')
    return values or (['staff'] if 'Desk User' in roles else [])
# 内置超级管理员：不可停用、不可改角色。DB 排序大小写不敏感，必须用存储名比较，不能小写化后比。
BUILTIN_ADMIN = "Administrator"


def _manager():
    if "System Manager" not in frappe.get_roles():
        frappe.throw("需要系统管理员权限", frappe.PermissionError)


def _identity_of(email):
    return frappe.db.get_value(
        "Shangshu Identity", {"user": email}, ["name", "collaboration_key", "collaboration_group", "collaboration_scope", "status"], as_dict=True
    )


def _validate_group(group):
    value = str(group or "").strip()
    if value and value not in GROUPS:
        frappe.throw(f"部门必须是：{'、'.join(GROUPS)}，或留空表示未分配", frappe.ValidationError)
    return value


def _validate_scope(scope):
    if scope not in ('related', 'department', 'company'):
        frappe.throw('任务管理范围必须是本人相关、本部门或全公司', frappe.ValidationError)
    return scope


def _enabled_admins():
    """仍是启用 System Manager 的员工账号（含内置 Administrator）；用于"至少保留一个管理员"护栏。"""
    names = set()
    if frappe.db.get_value("User", BUILTIN_ADMIN, "enabled"):
        names.add(BUILTIN_ADMIN)
    for row in frappe.get_all(
        "Has Role", filters={"role": "System Manager", "parenttype": "User"}, pluck="parent"
    ):
        if frappe.db.get_value("User", row, "enabled") and frappe.db.get_value("User", row, "user_type") == "System User":
            names.add(row)
    return names


def list_identities():
    """System Manager 只读账号清单。角色与能力来自既有授权投影，不新建第二份角色事实。"""
    _manager()
    result = []
    for user in frappe.get_all(
        "User",
        filters={"user_type": "System User"},
        fields=["name", "full_name", "enabled", "last_login", "username"],
    ):
        roles = sorted(frappe.get_all("Has Role", filters={"parent": user.name, "parenttype": "User"}, pluck="role"))
        identity = _identity_of(user.name)
        result.append(
            {
                "email": user.name,
                "display_name": user.full_name or user.name,
                "username": user.username or "",
                "enabled": bool(user.enabled),
                "last_login": user.last_login,
                "roles": roles,
                "platform_roles": _platform_roles(roles),
                "capabilities": sorted(role_capabilities(roles).keys()),
                "collaboration_group": (identity.collaboration_group if identity else "") or "",
                "collaboration_scope": (identity.collaboration_scope if identity else "") or "department",
                "identity_status": (identity.status if identity else ""),
                "collaboration_key": (identity.collaboration_key if identity else ""),
                "is_self": user.name == frappe.session.user,
            }
        )
    result.sort(key=lambda item: (item["display_name"], item["email"]))
    return result


def _require_user(email):
    """解析为库里存储的真实账号名（大小写不敏感匹配），避免 'administrator' 命中内置 'Administrator'。"""
    value = str(email or "").strip()
    if not value:
        frappe.throw("缺少账号", frappe.ValidationError)
    name = frappe.db.get_value("User", {"name": value}, "name")
    if not name:
        frappe.throw(f"账号不存在：{value}", frappe.DoesNotExistError)
    return name


def _assert_manageable(name, action):
    """内置超级管理员与本人账号不可被停用/改角色。"""
    if name == BUILTIN_ADMIN:
        frappe.throw(f"内置超级管理员账号不能{action}", frappe.ValidationError)
    if name.lower() == str(frappe.session.user or "").lower():
        frappe.throw(f"不能{action}自己的账号", frappe.ValidationError)


def _validate_username(raw):
    """登录短名（选填）。留空=只用邮箱登录；设置后可凭短名登录（需站点开启用户名登录）。"""
    value = str(raw or "").strip().lower()
    if not value:
        return ""
    if not USERNAME.match(value):
        frappe.throw("登录用户名须为 2–31 位小写字母/数字/点/横线/下划线，且不以符号开头", frappe.ValidationError)
    if frappe.db.exists("User", {"username": value}) or frappe.db.exists("User", {"name": value}):
        frappe.throw(f"登录用户名已被占用：{value}", frappe.ValidationError)
    return value


def create_identity(_action_id, payload, _context):
    """新建员工账号：User + 不可变 Identity 一次成型，初始密码由管理员设定并转交。"""
    _manager()
    email = str(payload.get("email") or "").strip().lower()
    if not EMAIL.match(email):
        frappe.throw("请填写有效邮箱作为账号（约定 <账号>@shangshu.local）", frappe.ValidationError)
    if frappe.db.exists("User", email):
        frappe.throw(f"账号已存在：{email}", frappe.ValidationError)
    requested_roles = _requested_roles(payload, 'staff')
    password = str(payload.get("initial_password") or "")
    if len(password) < MIN_PASSWORD:
        frappe.throw(f"初始密码至少 {MIN_PASSWORD} 位", frappe.ValidationError)
    group = _validate_group(payload.get("collaboration_group"))
    scope = _validate_scope(payload.get('collaboration_scope', 'department'))
    username = _validate_username(payload.get("username"))
    display = str(payload.get("display_name") or "").strip() or email.split("@")[0]

    user_doc = {
        "doctype": "User",
        "email": email,
        "first_name": display,
        "send_welcome_email": 0,
        "user_type": "System User",
        "roles": [{"role": name} for name in sorted({name for role in requested_roles for name in ROLE_MAP[role]})],
    }
    if username:
        user_doc["username"] = username
    frappe.get_doc(user_doc).insert(ignore_permissions=True)
    ensure_identity_for_user(email)
    frappe.db.set_value('Shangshu Identity', _identity_of(email).name, 'collaboration_scope', scope, update_modified=False)
    if group:
        frappe.db.set_value("Shangshu Identity", _identity_of(email).name, "collaboration_group", group, update_modified=False)
    update_password(email, password, logout_all_sessions=True)
    return {"email": email, "display_name": display, "role": requested_roles[0], "platform_roles": requested_roles,
            "collaboration_group": group, "username": username}


def _revoke_sessions_after_commit(email):
    """框架清会话会 commit；仅在身份/密码与审计一起提交后调用。

    使用 Frappe 事务回调，回滚自动取消；不在 Action 内释放域执行屏障。
    """
    from frappe.sessions import clear_sessions
    frappe.db.after_commit.add(lambda: clear_sessions(user=email, keep_current=True, force=True))


def set_identity_status(_action_id, payload, _context):
    """启用/停用账号。停用同时关闭身份状态并撤销会话；不删除历史数据。"""
    _manager()
    email = _require_user(payload.get("email"))
    enabled = bool(payload.get("enabled"))
    if not enabled:
        _assert_manageable(email, "停用")
        admins = _enabled_admins()
        if email in admins and len(admins) <= 1:
            frappe.throw("必须保留至少一个启用的系统管理员", frappe.ValidationError)
    frappe.db.set_value("User", email, "enabled", 1 if enabled else 0)
    identity = _identity_of(email)
    if identity:
        frappe.db.set_value(
            "Shangshu Identity", identity.name, "status", "Active" if enabled else "Disabled", update_modified=False
        )
    if not enabled:
        _revoke_sessions_after_commit(email)
    return {"email": email, "enabled": enabled}


def set_identity_group(_action_id, payload, _context):
    """部门与任务管理范围独立设置；旧请求省略范围时保留原值。"""
    _manager()
    email = _require_user(payload.get("email"))
    group = _validate_group(payload.get("collaboration_group"))
    identity = _identity_of(email)
    if not identity:
        frappe.throw("该账号还没有平台身份，请先迁移身份", frappe.ValidationError)
    scope = _validate_scope(payload.get('collaboration_scope', identity.collaboration_scope or 'department'))
    frappe.db.set_value("Shangshu Identity", identity.name, "collaboration_group", group, update_modified=False)
    frappe.db.set_value('Shangshu Identity', identity.name, 'collaboration_scope', scope, update_modified=False)
    return {"email": email, "collaboration_group": group, "collaboration_scope": scope}


# 平台角色管理的角色集合：改角色只增删这些，不触碰为其他目的单独授予的角色。
MANAGED_ROLES = frozenset(role for roles in ROLE_MAP.values() for role in roles)


def _assignable_business_roles():
    """只接受当前启用领域明确声明可分配的角色；平台角色仍由上方映射管理。"""
    result = set()
    for item in platform_contributions().get("roles") or []:
        role = item.get("role")
        if item.get("assignable") is True and isinstance(role, str) and role not in MANAGED_ROLES:
            if frappe.db.exists("Role", role):
                result.add(role)
    return result


def set_identity_role(_action_id, payload, _context):
    """切换平台角色；可选地单独指定领域角色，旧请求仍保留原领域角色。"""
    _manager()
    email = _require_user(payload.get("email"))
    requested_roles = _requested_roles(payload)
    _assert_manageable(email, "修改角色")
    current = set(frappe.get_all("Has Role", filters={"parent": email, "parenttype": "User"}, pluck="role"))
    target = {name for role in requested_roles for name in ROLE_MAP[role]}
    business_roles = payload.get("business_roles")
    if business_roles is not None:
        eligible = _assignable_business_roles()
        if (not isinstance(business_roles, list) or
                any(not isinstance(role, str) or role not in eligible for role in business_roles) or
                len(set(business_roles)) != len(business_roles)):
            frappe.throw("业务角色未声明为可分配，或存在重复角色", frappe.ValidationError)
        target |= set(business_roles)
        preserved = current - MANAGED_ROLES - eligible
    else:
        preserved = current - MANAGED_ROLES
    if "System Manager" in current and "System Manager" not in target:
        admins = _enabled_admins() - {email}
        if not admins:
            frappe.throw("必须保留至少一个启用的系统管理员", frappe.ValidationError)
    doc = frappe.get_doc("User", email)
    doc.set("roles", [])
    for name in sorted(preserved | target):
        doc.append("roles", {"role": name})
    doc.save(ignore_permissions=True)
    return {"email": email, "role": requested_roles[0], "platform_roles": requested_roles, "roles": sorted(row.role for row in doc.roles)}


def reset_identity_password(_action_id, payload, _context):
    """管理员重置密码并撤销该账号现有会话；不返回密码本身。"""
    _manager()
    email = _require_user(payload.get("email"))
    password = str(payload.get("new_password") or "")
    if len(password) < MIN_PASSWORD:
        frappe.throw(f"密码至少 {MIN_PASSWORD} 位", frappe.ValidationError)
    update_password(email, password, logout_all_sessions=False)
    _revoke_sessions_after_commit(email)
    return {"email": email, "sessions_revoked": True}
