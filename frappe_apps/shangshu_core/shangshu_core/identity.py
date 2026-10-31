import uuid

import frappe

from shangshu_core import request_cache


DEFAULT_ENTERPRISE_ID = "default"


def ensure_identity_for_user(user, method=None):
    """为 Frappe User 建立不可变 UUID；User rename 只更新 Link，不改变 subject。"""
    user_name = user.name if hasattr(user, "name") else str(user)
    existing = frappe.db.get_value("Shangshu Identity", {"user": user_name}, "name")
    if existing:
        return existing
    identity_id = str(uuid.uuid4())
    doc = frappe.get_doc(
        {
            "doctype": "Shangshu Identity",
            "identity_id": identity_id,
            "collaboration_key": identity_id,
            "user": user_name,
            "enterprise_id": DEFAULT_ENTERPRISE_ID,
            "status": "Active",
        }
    )
    doc.insert(ignore_permissions=True)
    return doc.name


def get_identity(user=None):
    """平台身份 —— **同一请求内复用**（2026-10-27 夜 · PKG-132 性能线）。

    以前这里每次都要三条查询（用户是否启用 / 身份编号 / 身份文档），
    而**每个动作执行、每条受管记录读写都要拿一次身份**
    ⇒ 批量写 500 行就是 1500 条查询只为读同一份「我是谁」。
    ⇒ 改成**同一请求内读一次**（`request_cache`）。

    ⚠️ 身份**停用/改绑**发生在请求之间 ⇒ 请求开始时缓存自然不存在，
    不会拿旧身份硬扛（`frappe.init()` 每次请求都清 `frappe.local.cache`）。
    """
    user = user or frappe.session.user
    if not user or user == "Guest":
        frappe.throw("需要登录后才能获取身份", frappe.PermissionError)

    def _load():
        if not frappe.db.get_value("User", user, "enabled"):
            frappe.throw("账号已停用或不存在", frappe.PermissionError)
        name = ensure_identity_for_user(user)
        identity = frappe.get_doc("Shangshu Identity", name)
        if identity.status != "Active":
            frappe.throw("平台身份已停用", frappe.PermissionError)
        return identity

    return request_cache.get(("identity", str(user)), _load)


def backfill_collaboration_keys():
    """仅迁移旧身份的引用键；不改历史任务、消息或用户密码。"""
    aliases = {"Administrator": "admin", "staff1@shangshu.local": "staff",
               "manager1@shangshu.local": "manager", "finance1@shangshu.local": "finance"}
    for row in frappe.get_all("Shangshu Identity", fields=["name", "user", "collaboration_key"]):
        if not row.collaboration_key:
            frappe.db.set_value("Shangshu Identity", row.name, "collaboration_key",
                                aliases.get(row.user, row.user), update_modified=False)


def list_collaboration_people():
    """同部署企业的启用员工目录 + 部门目录；身份、停用状态与协作分组均以平台为准。

    部门与任务管理范围分开；未分配默认仅本人，不参与对象/字段/流程权限。

    **BASE967-16 联合筛选**（2026-10-19）：owner-filter 之前只装员工身份，
    部门归属无法筛选 → **加部门项**：
    ```
    {"kind": "department", "identity_id": "<dept_id>", "department_id": "...",
     "department_name": "...", "scope": "department"}
    ```
    `kind='employee'` 是员工身份，**A 按 `kind` 分组/标 label**。
    默认**只装员工**（不撑大下拉）；A 传 `include_groups: bool` 显式要时再装部门。
    """
    identity = get_identity()
    if frappe.db.get_value("User", frappe.session.user, "user_type") != "System User":
        frappe.throw("需要员工账号", frappe.PermissionError)
    result = []
    # ① 员工身份（始终装；不动）
    for row in frappe.get_all("Shangshu Identity",
                             filters={"enterprise_id": identity.enterprise_id, "status": "Active"},
                             fields=["identity_id", "user", "collaboration_key", "collaboration_group", "collaboration_scope"]):
        user = frappe.db.get_value("User", row.user, ["enabled", "user_type", "full_name"], as_dict=True)
        if user and user.enabled and user.user_type == "System User" and row.collaboration_key:
            result.append({"kind": "employee",
                           "identity_id": row.identity_id, "username": row.collaboration_key,
                           "user_name": row.user,
                           "display_name": user.full_name or row.user,
                           "group": row.collaboration_group or "", "scope": row.collaboration_scope or "department"})
    return sorted(result, key=lambda item: (item.get("display_name") or item.get("department_name") or "",
                                            item.get("identity_id") or ""))


def collaboration_people(_service, payload, _context):
    """`identity.list_collaboration_people` 领域服务的处理器：回 `{people: [...], groups: [...]}`。

    **为什么不直接把 `list_collaboration_people` 注册成 handler**：它回的是**裸列表**，
    而链路是 `handler → Frappe {message:…} → BFF frappePost 取 body.message →
    res.json({ok:true, ...msg})`。**数组被摊成对象**（`{ok:true,"0":…,"1":…}`），
    前端 `file-center.js` 的取值链 `d.result?.people || d.people || []` 仍然取不到 ——
    **服务通了但下拉照旧空的，「修了等于没修」**。

    所以这里包一层，形状对齐前端已经写好的取值链，前端一行不用改。

    **入参**（BASE967-16 联合筛选，2026-10-19）：
      `include_groups: bool`（默认 False）—— **为 False 不装部门**（不撑大下拉），
      为 True 时**额外**装部门项到 `groups` 字段，**不混进 people**
      （A 按 `kind` 字段分两组，**不混数组**，混了改一次全员踩雷）。
    """
    payload = payload or {}
    include_groups = bool(payload.get('include_groups'))
    out = {"people": list_collaboration_people()}
    if include_groups:
        out["groups"] = list_department_groups(enterprise_id=get_identity().enterprise_id)
    return out


def list_department_groups(enterprise_id=None):
    """BASE967-16 联合筛选的部门项（A 端 owner-filter 部门下拉用）。

    形状：
    ```
    {"kind": "department", "identity_id": "<dept_id>", "department_id": "<dept_id>",
     "department_name": "<title>", "scope": "department"}
    ```
    **不取 disabled 部门**（跟员工身份 Active 过滤对齐），
    **不取根节点**（根节点是企业本身不是部门），
    排序按 `department_name`。
    """
    from shangshu_core.org_admin import org_context
    identity_user = frappe.session.user if frappe.session.user else None
    if identity_user:
        ctx = org_context(identity_user)
        enterprise_id = enterprise_id or ctx.get("enterprise_id")
    if not enterprise_id:
        return []
    result = []
    for row in frappe.get_all("Shangshu Department",
                              filters={"enterprise_id": enterprise_id, "enabled": 1},
                              fields=["department_id", "title"]):
        # 以真实部门ID为身份，不根据显示名称猜测企业根节点
        if not row.department_id:
            continue
        result.append({
            "kind": "department",
            "identity_id": row.department_id,
            "department_id": row.department_id,
            "department_name": row.title or row.department_id,
            "scope": "department",
        })
    return sorted(result, key=lambda x: (x.get("department_name") or "", x.get("department_id") or ""))


def identity_aliases(value):
    """同企业身份的存量引用别名；不产生身份、不授予资源权限。"""
    raw = str(value or '').strip()
    if not raw:
        return []
    identity = get_identity()
    rows = frappe.get_all("Shangshu Identity", filters={"enterprise_id": identity.enterprise_id},
        or_filters={"identity_id": raw, "user": raw, "collaboration_key": raw},
        fields=["identity_id", "user", "collaboration_key"], limit_page_length=1)
    return list(dict.fromkeys([raw] + [str(v) for r in rows for v in r.values() if v]))


def identity_department(user):
    """存量协作组读取；仅提供身份映射，不作为部门授权判定。"""
    return str(frappe.db.get_value("Shangshu Identity", {"user": user}, "collaboration_group") or '').strip()
