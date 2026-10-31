"""组织事实与受管组织动作（B1，下一批 §5）。

组织事实的**唯一权威**是四个 DocType：
  Shangshu Department（部门稳定身份/树/启停）、Shangshu Org Member（任职/负责人）、
  Shangshu Org Owner（企业管理者）、Shangshu Org Attribution（资源归属）。

旧 ``collaboration_group``（Identity 上的三选一）**不再是部门权威**：新授权一律查本模块
的组织事实；旧字段只作历史/展示兼容（目录 allowed_groups_json 的组名映射归 B6 补录），
不维护第二套可独立修改的部门事实。不按「管理」标签自动赋予老板身份——企业管理者只能
经 owner_assign 显式任命。

管理动作只给系统管理员（受管设置入口，供 FDE 配置；不靠测试 SQL 冒充产品能力）。
"""

import frappe

from shangshu_core.identity_admin import _manager


# ---------- 小工具 ----------

def _dept_row(department):
    row = frappe.db.get_value(
        "Shangshu Department",
        str(department or "").strip(),
        ["name", "title", "parent", "enterprise_id", "enabled"],
        as_dict=True,
    )
    if not row:
        frappe.throw("部门不存在", frappe.ValidationError)
    return row


def _user_email(payload):
    email = str(payload.get("user") or "").strip().lower()
    if not email:
        frappe.throw("请指定用户", frappe.ValidationError)
    if not frappe.db.exists("User", email):
        frappe.throw(f"账号不存在：{email}", frappe.ValidationError)
    return email


def _enterprise(payload):
    return str(payload.get("enterprise") or "default").strip() or "default"


# ---------- 部门 ----------

def department_create(_action_id, payload, _context):
    """建部门：名称/上级/企业归属；拒绝同层重名、跨企业挂接（树校验在 DocType.validate）。"""
    _manager()
    title = str(payload.get("name") or "").strip()
    if not title:
        frappe.throw("请填写部门名称", frappe.ValidationError)
    enterprise = _enterprise(payload)
    parent = str(payload.get("parent") or "").strip() or None
    if parent:
        p = _dept_row(parent)
        if p.enterprise_id != enterprise:
            frappe.throw("不能跨企业挂接部门", frappe.ValidationError)
    exists = frappe.db.get_value(
        "Shangshu Department",
        {"title": title, "enterprise_id": enterprise, "parent": parent or ""},
        "name",
    )
    if exists:
        frappe.throw("同一上级下已有同名部门", frappe.ValidationError)
    doc = frappe.get_doc({
        "doctype": "Shangshu Department",
        "department_id": frappe.generate_hash(length=12),
        "title": title,
        "parent": parent,
        "enterprise_id": enterprise,
        "enabled": 1,
    }).insert(ignore_permissions=True)
    return {"department": doc.name, "title": doc.title, "enterprise": doc.enterprise_id}


def department_rename(_action_id, payload, _context):
    """改名：只改名称，部门稳定身份不变（用户 2026-10-12 钉死）。"""
    _manager()
    row = _dept_row(payload.get("department"))
    title = str(payload.get("name") or "").strip()
    if not title:
        frappe.throw("请填写部门名称", frappe.ValidationError)
    frappe.db.set_value("Shangshu Department", row.name, "title", title, update_modified=True)
    return {"department": row.name, "title": title, "unchanged_identity": True}


def department_set_status(_action_id, payload, _context):
    """启停部门。停用后不再作为新的任职/归属落点；既有历史事实保留。"""
    _manager()
    row = _dept_row(payload.get("department"))
    enabled = 1 if payload.get("enabled") else 0
    frappe.db.set_value("Shangshu Department", row.name, "enabled", enabled, update_modified=True)
    return {"department": row.name, "enabled": bool(enabled)}


def department_update(_action_id, payload, _context):
    """改挂上级（含循环/跨企业拒绝——DocType.validate 兜底，此处先给业务话）。"""
    _manager()
    row = _dept_row(payload.get("department"))
    parent = str(payload.get("parent") or "").strip() or None
    if parent == row.name:
        frappe.throw("上级部门不能是自己（循环部门关系）", frappe.ValidationError)
    if parent:
        p = _dept_row(parent)
        if p.enterprise_id != row.enterprise_id:
            frappe.throw("不能跨企业挂接部门", frappe.ValidationError)
        seen = {row.name}
        cur = parent
        while cur:
            if cur in seen:
                frappe.throw("循环部门关系被拒绝", frappe.ValidationError)
            seen.add(cur)
            cur = frappe.db.get_value("Shangshu Department", cur, "parent") or None
    frappe.db.set_value("Shangshu Department", row.name, "parent", parent, update_modified=True)
    return {"department": row.name, "parent": parent}


# ---------- 任职 / 负责人 ----------

def member_assign(_action_id, payload, _context):
    """进部门（一人可多部门任职=兼任）。停用部门不接新任职（M11）。"""
    _manager()
    email = _user_email(payload)
    row = _dept_row(payload.get("department"))
    if not row.enabled:
        frappe.throw("部门已停用，不能作为新的任职落点", frappe.ValidationError)
    if frappe.db.exists("Shangshu Org Member", {"user": email, "department": row.name}):
        return {"user": email, "department": row.name, "already": True}
    frappe.get_doc({
        "doctype": "Shangshu Org Member",
        "user": email,
        "department": row.name,
        "is_head": 0,
    }).insert(ignore_permissions=True)
    return {"user": email, "department": row.name}


def member_remove(_action_id, payload, _context):
    """调岗/移出：删任职记录；同人其他部门任职不受影响。"""
    _manager()
    email = _user_email(payload)
    row = _dept_row(payload.get("department"))
    frappe.db.delete("Shangshu Org Member", {"user": email, "department": row.name})
    return {"user": email, "department": row.name, "removed": True}


def head_assign(_action_id, payload, _context):
    """任命部门负责人（可多人；缺任职记录时自动补一条）。停用部门不接新任命。"""
    _manager()
    email = _user_email(payload)
    row = _dept_row(payload.get("department"))
    if not row.enabled:
        frappe.throw("部门已停用，不能作为新的任职落点", frappe.ValidationError)
    existing = frappe.db.get_value(
        "Shangshu Org Member", {"user": email, "department": row.name}, "name"
    )
    if existing:
        frappe.db.set_value("Shangshu Org Member", existing, "is_head", 1, update_modified=True)
    else:
        frappe.get_doc({
            "doctype": "Shangshu Org Member",
            "user": email,
            "department": row.name,
            "is_head": 1,
        }).insert(ignore_permissions=True)
    return {"user": email, "department": row.name, "head": True}


def head_remove(_action_id, payload, _context):
    """取消负责人任命（任职记录保留，只清负责人标记）。"""
    _manager()
    email = _user_email(payload)
    row = _dept_row(payload.get("department"))
    existing = frappe.db.get_value(
        "Shangshu Org Member", {"user": email, "department": row.name}, "name"
    )
    if existing:
        frappe.db.set_value("Shangshu Org Member", existing, "is_head", 0, update_modified=True)
    return {"user": email, "department": row.name, "head": False}


# ---------- 企业管理者（老板） ----------

def owner_assign(_action_id, payload, _context):
    """任命企业管理者。与 System Manager 互不相认；不按部门标签自动赋予。"""
    _manager()
    email = _user_email(payload)
    enterprise = _enterprise(payload)
    if frappe.db.exists("Shangshu Org Owner", {"user": email, "enterprise_id": enterprise}):
        return {"user": email, "enterprise": enterprise, "already": True}
    frappe.get_doc({
        "doctype": "Shangshu Org Owner",
        "user": email,
        "enterprise_id": enterprise,
    }).insert(ignore_permissions=True)
    return {"user": email, "enterprise": enterprise, "owner": True}


def owner_remove(_action_id, payload, _context):
    _manager()
    email = _user_email(payload)
    enterprise = _enterprise(payload)
    frappe.db.delete("Shangshu Org Owner", {"user": email, "enterprise_id": enterprise})
    return {"user": email, "enterprise": enterprise, "removed": True}


# ---------- 资源归属 ----------

def _attribution_effects(resource, old_att, new_att):
    """影响预览（B6「受管归属补录与影响预览」）：逐账号比补录前后读/写判定。

    before=None（无归属=旧目录口径）标 'legacy'；只列读或写有变化的账号。
    内置 Administrator 是硬超管、不是组织主体，不进清单。用户可多时此清单是全量
    启用账号——FDE 工具口径可接受，不算产品热路径。
    """
    users = set(frappe.get_all("User", filters={"enabled": 1}, pluck="name"))
    users |= set(frappe.get_all("Shangshu Org Member", pluck="user"))
    users |= set(frappe.get_all("Shangshu Org Owner", pluck="user"))
    users |= set(frappe.get_all("Shangshu Org Grant", filters={"resource": resource}, pluck="grantee_user"))
    for att in (old_att, new_att):
        owner = getattr(att, "owner_user", None) if att is not None else None
        if owner:
            users.add(owner)
    out = []
    for user in sorted(u for u in users if u and u != "Administrator" and u != "Guest"):
        b_r = read_allows(user, resource, attribution=old_att)
        b_w = write_allows(user, resource, attribution=old_att)
        a_r = read_allows(user, resource, attribution=new_att)
        a_w = write_allows(user, resource, attribution=new_att)
        entry = {"user": user}
        changed = False
        b_s = bool(b_w and structure_allows(user,resource,old_att)) if old_att else None
        a_s = bool(a_w and structure_allows(user,resource,new_att))
        for key, before, after in (("read", b_r, a_r), ("write", b_w, a_w),
                ("structure",b_s,a_s),
                ("download",download_allows(user,resource,old_att),download_allows(user,resource,new_att)),
                ("share",share_right_allows(user,resource,old_att),share_right_allows(user,resource,new_att)),
                ("assign",assign_allows(user,resource,old_att),assign_allows(user,resource,new_att))):
            if before == after or (before is None and after is None):
                continue
            changed = True
            entry[key] = {"before": "legacy" if before is None else bool(before), "after": bool(after)}
        if changed:
            out.append(entry)
    return out


def _attribution_enterprise(att, resource=None):
    if att and att.get('level') == 'department' and att.get('department'):
        return frappe.db.get_value('Shangshu Department',att['department'],'enterprise_id')
    owner = att.get('owner_user') if att else resource_owner(resource)
    return frappe.db.get_value('Shangshu Identity',{'user':owner},'enterprise_id') if owner else None


def _head_manages_attribution(user,att):
    if not att:return False
    heads=set(org_context(user)['head_departments'])
    if att.get('level')=='department':return att.get('department') in heads
    owner=att.get('owner_user')
    return bool(owner and heads.intersection(frappe.get_all('Shangshu Org Member',filters={'user':owner},pluck='department')))


def assign_allows(user,resource,attribution=None):
    """Current ownership/managed assignment scope, independent of edit/share/read."""
    from shangshu_core.identity import get_identity
    try:identity=get_identity(user)
    except frappe.PermissionError:return False
    att=attribution if attribution is not None else resource_attribution(resource)
    if _attribution_enterprise(att,resource)!=identity.enterprise_id:return False
    if 'System Manager' in frappe.get_roles(user):return True
    if att:
        return str(att.get('owner_user') or '').lower()==user.lower() or _head_manages_attribution(user,att)
    return str(resource_owner(resource) or '').lower()==user.lower()


def resource_assign(_action_id, payload, _context):
    """Transfer the authoritative attribution; historical creator is not an owner grant."""
    from shangshu_core.identity import get_identity
    from shangshu_core.field_access import attribution_level
    resource=str(payload.get('resource') or '').strip()
    if not resource:frappe.throw('请指定资源',frappe.ValidationError)
    # This existing action operates on actual file resources; never manufacture
    # attribution for an arbitrary string or a missing/recycled resource.
    file=frappe.get_doc('Shangshu File Center File',resource,for_update=True)
    if file.status!='Active':frappe.throw('只能移交有效资源',frappe.ValidationError)
    old_name=frappe.db.get_value('Shangshu Org Attribution',{'resource':resource},'name')
    old_doc=frappe.get_doc('Shangshu Org Attribution',old_name,for_update=True) if old_name else None
    old_att=frappe._dict({key:old_doc.get(key) for key in ('resource','level','department','owner_user','modified')}) if old_doc else None
    user=frappe.session.user;identity=get_identity(user)
    if not assign_allows(user,resource,old_att):frappe.throw('当前归属或管理范围不允许移交该资源',frappe.PermissionError)
    department=str(payload.get('department') or '').strip() or None
    owner=str(payload.get('owner_user') or '').strip().lower() or None
    try:level=attribution_level(payload.get('level'),department,owner)
    except ValueError as error:frappe.throw(str(error),frappe.ValidationError)
    if level=='personal':
        if not owner:frappe.throw('个人归属必须选择有效所有人',frappe.ValidationError)
        department=None
    else:
        if not department:frappe.throw('部门归属必须选择部门',frappe.ValidationError)
        if 'owner_user' not in payload:frappe.throw('部门移交须明确选择或清空当前管理人',frappe.ValidationError)
        dept=_dept_row(department)
        if not dept.enabled or dept.enterprise_id!=identity.enterprise_id:frappe.throw('目标部门无效或不在当前企业',frappe.PermissionError)
    if owner:
        target=get_identity(owner)
        if target.enterprise_id!=identity.enterprise_id:frappe.throw('目标所有人不在当前企业',frappe.PermissionError)
    new_att=frappe._dict({'resource':resource,'level':level,'department':department,'owner_user':owner})
    roles=set(frappe.get_roles(user));current_owner=bool(old_att and str(old_att.get('owner_user') or '').lower()==user.lower())
    if 'System Manager' not in roles:
        if not current_owner and old_att:
            if not _head_manages_attribution(user,new_att):frappe.throw('负责人不能移交到管理范围以外',frappe.PermissionError)
        elif level=='department' and not create_grant_allows(user,department):
            frappe.throw('目标部门不在本人已授权范围',frappe.PermissionError)
    version=str(old_doc.modified) if old_doc else 'unassigned:'+str(file.modified)
    preview=payload.get('dry_run') is True or str(payload.get('dry_run') or '').lower() in ('1','true','yes')
    if not preview and payload.get('expected_modified')!=version:
        frappe.throw('归属已变化或尚未预览，请重新核对后移交',frappe.TimestampMismatchError)
    effects=_attribution_effects(resource,old_att,new_att)
    result={'resource':resource,'level':level,'department':department,'owner_user':owner,'current':old_att,
            'effects':effects,'expected_modified':version,'applied':False}
    if preview:return result
    fields={'level':level,'department':department,'owner_user':owner}
    if old_doc:
        old_doc.update(fields);old_doc.save(ignore_permissions=True)
    else:
        old_doc=frappe.get_doc({'doctype':'Shangshu Org Attribution','resource':resource,**fields}).insert(ignore_permissions=True)
    if isinstance(_context,dict):
        _context['record_change']={'doctype':'Shangshu Org Attribution','name':old_doc.name,
            'data':{'resource':resource,'before':old_att,'after':new_att,
                    'previous_modified':version,'modified':str(old_doc.modified)}}
    return {**result,'applied':True,'modified':str(old_doc.modified),'previous':old_att,'current':new_att}


# ---------- 建表授权 / 明确共享（默认读权的唯一例外，契约 §3.11） ----------

def create_grant(_action_id, payload, _context):
    """跨部门建表授权：获准员工可把新表归属到该部门。受管动作（FDE 配置入口）。"""
    _manager()
    email = _user_email(payload)
    row = _dept_row(payload.get("department"))
    scope = str(payload.get("scope") or "").strip()
    if scope != "create":
        frappe.throw("建表授权的 scope 只能是 create", frappe.ValidationError)
    if not row.enabled:
        frappe.throw("部门已停用，不能作为新的授权落点", frappe.ValidationError)
    dup = frappe.db.get_value(
        "Shangshu Org Grant",
        {"kind": "create", "grantee_user": email, "department": row.name},
        "name",
    )
    if dup:
        return {"user": email, "department": row.name, "scope": "create", "already": True}
    frappe.get_doc({
        "doctype": "Shangshu Org Grant",
        "kind": "create",
        "grantee_user": email,
        "department": row.name,
        "access": "create",
    }).insert(ignore_permissions=True)
    return {"user": email, "department": row.name, "scope": "create"}


def _share_caller_can_grant(resource, caller, access):
    """转授权检查：只有资源归属人（或系统管理员）能共享，且档位不超自身。

    「管理读不带共享」：老板/负责人对默认可读的表没有转授权（用户 2026-10-12）。
    普通编辑者即使能写也不能转授（契约 §6 M5）。
    """
    if not resource_attribution(resource):
        # 分类错误说清楚（B6，用户⑤「分类错误」口径）：无归属资源不进组织共享体系，
        # 先经受管入口补归属再共享——不是「你不是归属人」，是这资源还没归属。
        frappe.throw("该资源无组织归属，不能按组织共享；请先经受管入口补归属再共享", frappe.PermissionError)
    if "System Manager" in frappe.get_roles():
        return
    att = resource_attribution(resource)
    if (att.owner_user or "").lower() != caller:
        frappe.throw("只有资源归属人可以共享该资源", frappe.PermissionError)
    # 归属人对本人资源有完整档位，因此 read/edit 都在其自身权限内


def share_grant(_action_id, payload, _context):
    """明确共享：个人或多选部门（用户 2026-10-12「可以选 abc 三个部门共享」）。

    共享到部门按「部门范围包含下属部门」生效（授权判定里展开子树）。
    """
    resource = str(payload.get("resource") or "").strip()
    if not resource:
        frappe.throw("请指定共享资源", frappe.ValidationError)
    access = str(payload.get("access") or "").strip()
    if access not in ("read", "edit"):
        frappe.throw("共享档位只能是 read 或 edit", frappe.ValidationError)
    # 单数/复数都认（契约样例两种写法都有）
    users = payload.get("users") or []
    departments = payload.get("departments") or []
    if isinstance(users, str):
        users = [users]
    if isinstance(departments, str):
        departments = [departments]
    if payload.get("user"):
        users = list(users) + [payload.get("user")]
    if payload.get("department"):
        departments = list(departments) + [payload.get("department")]
    users = [str(u or "").strip().lower() for u in users if str(u or "").strip()]
    departments = [str(d or "").strip() for d in departments if str(d or "").strip()]
    if not users and not departments:
        frappe.throw("共享必须指定个人或部门", frappe.ValidationError)
    caller = frappe.session.user.lower()
    _share_caller_can_grant(resource, caller, access)
    for email in users:
        if not frappe.db.exists("User", email):
            frappe.throw(f"被共享账号不存在：{email}", frappe.ValidationError)
    for dept in departments:
        _dept_row(dept)
    grants = []
    for email in users:
        dup = frappe.db.get_value(
            "Shangshu Org Grant",
            {"kind": "share", "resource": resource, "grantee_user": email},
            "name",
        )
        if dup:
            frappe.db.set_value("Shangshu Org Grant", dup, "access", access, update_modified=True)
            grants.append({"user": email, "access": access})
            continue
        frappe.get_doc({
            "doctype": "Shangshu Org Grant", "kind": "share", "resource": resource,
            "grantee_user": email, "access": access,
        }).insert(ignore_permissions=True)
        grants.append({"user": email, "access": access})
    for dept in departments:
        dup = frappe.db.get_value(
            "Shangshu Org Grant",
            {"kind": "share", "resource": resource, "grantee_department": dept},
            "name",
        )
        if dup:
            frappe.db.set_value("Shangshu Org Grant", dup, "access", access, update_modified=True)
            grants.append({"department": dept, "access": access})
            continue
        frappe.get_doc({
            "doctype": "Shangshu Org Grant", "kind": "share", "resource": resource,
            "grantee_department": dept, "access": access,
        }).insert(ignore_permissions=True)
        grants.append({"department": dept, "access": access})
    return {"resource": resource, "access": access, "grants": grants}


def share_revoke(_action_id, payload, _context):
    """撤共享：按个人或部门精确撤，不影响同资源的其他共享（M5b）。"""
    resource = str(payload.get("resource") or "").strip()
    if not resource:
        frappe.throw("请指定共享资源", frappe.ValidationError)
    user = str(payload.get("user") or "").strip().lower() or None
    department = str(payload.get("department") or "").strip() or None
    if not user and not department:
        frappe.throw("撤共享必须指定个人或部门", frappe.ValidationError)
    if user and department:
        frappe.throw("一次只撤个人或部门之一", frappe.ValidationError)
    caller = frappe.session.user.lower()
    _share_caller_can_grant(resource, caller, "read")
    filters = {"kind": "share", "resource": resource}
    if user:
        filters["grantee_user"] = user
    else:
        filters["grantee_department"] = department
    frappe.db.delete("Shangshu Org Grant", filters)
    return {"resource": resource, "user": user, "department": department, "revoked": True}


# ---------- 组织读权判定（B2/B3 的公共口） ----------

def _descendants(dept_name):
    """部门范围包含下属部门（契约 §3.1）。"""
    out = {dept_name}
    frontier = [dept_name]
    while frontier:
        rows = frappe.get_all(
            "Shangshu Department",
            filters={"parent": ("in", frontier)},
            pluck="name",
        )
        nxt = [r for r in rows if r not in out]
        out.update(nxt)
        frontier = nxt
    return out


def department_row(department):
    """公开取部门行（含启停），供建表归属校验复用。"""
    return _dept_row(department)


def department_title(department):
    """部门显示名（A 归属列用）；无部门或部门不存在返回 None。"""
    if not department:
        return None
    return frappe.db.get_value("Shangshu Department", str(department).strip(), "title")


def query_departments(_dataset_id, filters=None, page=1, page_length=100):
    """部门下拉数据集（A1 可选归属）：只返回**当前用户可建表归属**的部门。

    成员所属（精确）+ 负责人管辖（含下属）+ create_grant 授权部门；
    系统管理员（FDE 受管配置口）看全部启用部门。字段：name/title/parent/enterprise/enabled。
    """
    filters = filters or {}
    if not isinstance(filters, dict) or any(not isinstance(v, str) and not isinstance(v, (int, float, bool)) for v in filters.values()):
        frappe.throw("部门筛选参数无效", frappe.ValidationError)
    email = frappe.session.user.lower()
    if "System Manager" in frappe.get_roles():
        allowed = None  # 全部
    else:
        ctx = org_context(email)
        allowed = set(ctx["member_of"]) | set(ctx["head_departments"])
        granted = frappe.get_all(
            "Shangshu Org Grant",
            filters={"kind": "create", "grantee_user": email},
            pluck="department",
        )
        allowed |= set(granted)
    conditions = {}
    for key in ("enterprise_id", "parent", "enabled"):
        if key in filters and filters[key] not in (None, ""):
            conditions[key] = filters[key]
    if allowed is not None:
        conditions["name"] = ("in", sorted(allowed) or [""])
    rows = frappe.get_all(
        "Shangshu Department",
        filters=conditions,
        fields=["name", "title", "parent", "enterprise_id", "enabled"],
        order_by="title asc",
        limit_start=(max(int(page), 1) - 1) * min(int(page_length), 100),
        limit_page_length=min(int(page_length), 100),
    )
    total = frappe.db.count("Shangshu Department", conditions)
    out = []
    for r in rows:
        out.append({
            "name": r.name,
            "title": r.title,
            "parent": r.parent,
            "enterprise": r.enterprise_id,
            "enabled": bool(r.enabled),
        })
    return {"dataset_id": "platform.department", "rows": out,
            "total": int(total), "page": max(int(page), 1), "page_length": min(int(page_length), 100)}


def resources_by_level(level):
    """**某个归属层级**下的资源编号（如 `akr6lm8fo1` 这样的文件编号）。

    ⚠️ 为什么要有（2026-10-28 · PKG-132 · 审查报告 R11）：
      目录页的归属筛选以前是**前端**在已取回的清单里筛 ⇒ 计数只对「手头这一批」成立
      ⇒ **说谎**（筛选后总数还是没筛的那个数）。
      ⇒ 改成**服务端**按层级圈出资源编号，再当筛选条件用 ⇒ 分页与总数随之正确。

    ⚠️ 只回**确实有这一层归属**的资源；无归属（存量/普通文件）**不在内**
    —— 与前端那层筛选的口径一致（无归属就是没有那一层）。
    """
    wanted = str(level or '').strip()
    if not wanted:
        return []
    rows = frappe.get_all("Shangshu Org Attribution", filters={"level": wanted},
                          fields=["resource"], limit_page_length=0)
    return [str(row.get("resource") or "") for row in rows if row.get("resource")]


def resource_attribution(resource):
    """资源的组织归属记录；None = 无归属（存量/普通文件走旧目录授权，B6 兼容）。"""
    row = frappe.db.get_value(
        "Shangshu Org Attribution",
        {"resource": str(resource or "").strip()},
        ["resource", "level", "department", "owner_user", "modified"],
        as_dict=True,
    )
    return row or None


def attribution_record(resource, level, department=None, owner_user=None):
    """落一条资源归属记录（域建表/补录时经此写入，不直写核心 DocType——
    check:platform-contract 的 PRIVATE_CORE_DOCTYPE_ACCESS 边界）。

    建表权/归属合法性由调用方（files.upload 的 _apply_attribution、
    resource_assign）按各自口径判完再调这里。
    **但 `level` 这一项本函数自己也收一道**（2026-10-15 补）——
    以前它零校验直接 ``insert(ignore_permissions=True)``，**下游不设闸**：
    上游不产生 ≠ 下游不收（同「翻译 ≠ 授权」那族）。用户 2026-10-15
    「**尚书是单例，没有企业归属**」得落到写入口，不能只写在纸上。
    判据 FA-21。
    """
    from shangshu_core.field_access import attribution_level as _attribution_level
    try:
        level = _attribution_level(level, department=department, owner_user=owner_user)
    except ValueError as e:
        frappe.throw(str(e), frappe.ValidationError)
    frappe.get_doc({
        "doctype": "Shangshu Org Attribution",
        "resource": str(resource or "").strip(),
        "level": level,
        "department": department if level == "department" else None,
        "owner_user": owner_user,
    }).insert(ignore_permissions=True)


def org_context(user):
    """一个人的组织上下文（权威判定用，尽量一次算清）。

    - ``member_of``：**精确**任职部门（负责人任职也算）——成员读本部门表，
      不自动展开下属（下属部门是独立范围；契约里「范围包含下属」只给
      负责人管辖和共享覆盖用）。
    - ``head_departments``：管辖范围 = 所负责部门 + 全部下属
      （用户 2026-10-12「部门负责人可以读部门及以下」）。
    - ``owned_enterprises``：企业管理者身份（老板）的企业集。
    """
    email = str(user or "").strip().lower()
    owned = frappe.get_all(
        "Shangshu Org Owner", filters={"user": email}, pluck="enterprise_id"
    )
    member_of, head_of = set(), set()
    for row in frappe.get_all(
        "Shangshu Org Member", filters={"user": email}, fields=["department", "is_head"]
    ):
        member_of.add(row.department)  # 负责人也是任职人
        if row.is_head:
            head_of.add(row.department)
    head_departments = set()
    for d in head_of:
        head_departments |= _descendants(d)
    return {
        "user": email,
        "owned_enterprises": sorted(set(owned)),
        "head_departments": sorted(head_departments),
        "head_of": sorted(head_of),
        "member_of": sorted(member_of),
        # 兼容旧键名：精确任职部门（不再展开下属）
        "member_departments": sorted(member_of),
    }


# ---------- 主体判定口（PKG-117-T01：列级权限按「主体范围」分配） ----------

def subject_context(user):
    """一个人的**主体判定上下文** —— 「主体范围」那条链认的那份 subject。

    ⚠️ **主体不是角色**：全局/部门/个人/**无人**四档判的是**人**
    （任职部门、管辖范围、本人），不是角色清单 ⇒ 这里取 `org_context` 的
    **任职部门**（`member_of`）与**管辖范围**（`head_departments`），
    **不是** `frappe.get_roles()`（只有管理员那一项例外，见下）。

    ⚠️ **部门标识用 key**：`member_of` / `head_departments` 装的是**部门 key**
    （`Shangshu Org Member.department` 存的就是 key）⇒ 声明里的 `departments`
    也要写 **key**；写**标题**（同一个部门的文字名）**不命中**。

    ⚠️ **管理员旁路**：`is_admin` = 这个人有没有 Frappe 角色 `System Manager`
    ⇒ 主体判定里**四档全部放行**（含 `none`；那个开关在
    `shangshu_core.subject_access.ADMIN_BYPASS_INCLUDES_NONE`）。

    **不缓存**：每次现取（与本模块全局约定一致）⇒ 撤权/调岗后下一包立刻是新结论。
    """
    ctx = org_context(user)
    return {"user": ctx["user"],
            "member_of": list(ctx["member_of"]),
            "head_departments": list(ctx["head_departments"]),
            # 管理员标记（**唯一**一处从角色取事实的地方）⇒ 纯规则层只认这个布尔。
            "is_admin": "System Manager" in (frappe.get_roles(user) or ())}


def subject_allows(user, scope, ctx=None):
    """这个人对这份**主体范围**有没有该操作的资格（**按主体判**，不按角色）。

    `scope` = `{"scope": "global"}` / `{"scope": "department", "departments": [...]}`
    / `{"scope": "personal", "users": [...]}` / `{"scope": "none"}`（**无人**）。
    `ctx` 可以由调用方现取后传进来（省一次查库）；不传就现取。

    ⚠️ **管理员旁路**：`ctx["is_admin"]` 为真（Frappe 角色 `System Manager`）⇒
    **四档全部放行**（含 `none`）—— 与旧链 `field_access` 的旁路**同一口径**；
    `none` 这一档要不要连管理员也不给，由
    `shangshu_core.subject_access.ADMIN_BYPASS_INCLUDES_NONE` 说了算。
    """
    from shangshu_core import business_access
    business_access.require_identity(user)
    if business_access.is_open(user):
        return True
    from shangshu_core.subject_access import subject_allows as _allows
    return _allows(scope, ctx or subject_context(user))


def field_subject_allows(user, field, op, table_access=None, ctx=None):
    """**列 → 继承表级** 的组合口：这一列的这个操作，这个人对不对得上。

    `field` 是受管字段声明（新形状：带 `access`）；`table_access` 是表级声明
    （列没声明那个操作就继承表级）。规则本体在 `shangshu_core.subject_access`
    （纯规则，可脱离 frappe 测）。

    ⚠️ **管理员旁路**：同 `subject_allows` —— `ctx["is_admin"]` 为真 ⇒ **四档全部放行**
    （含 `none`）。
    """
    from shangshu_core import business_access
    business_access.require_identity(user)
    if business_access.is_open(user):
        return True
    from shangshu_core.subject_access import field_allows_subject
    return field_allows_subject(field, ctx or subject_context(user), op, table_access)


def default_read_allows(user, attribution, ctx=None):
    """默认管理读（不是共享）：老板=全企业；负责人=所辖部门及以下（含辖内个人表）；
    成员=本部门（精确，不展开下属）。个人级不向管理者保密。

    管理读取不自动授予编辑/结构/下载/共享/代发（用户 2026-10-12 补充）——
    这里只答「默认可读」，其他动作各自另判。
    """
    if not attribution:
        return False
    ctx = ctx or org_context(user)
    level = attribution.get("level")
    enterprise = attribution.get("enterprise") or "default"
    if level == "enterprise":
        return enterprise in ctx["owned_enterprises"]
    if level == "department":
        dept = attribution.get("department")
        if not dept:
            return False
        if dept in ctx["member_of"]:
            return True  # 本人所属部门的表
        if dept in ctx["head_departments"]:
            return True  # 负责人=所辖部门及以下
        # 老板=全企业都看得到（含各部门表）
        row = frappe.db.get_value("Shangshu Department", dept, "enterprise_id")
        return bool(row) and row in ctx["owned_enterprises"]
    if level == "personal":
        owner = (attribution.get("owner_user") or "").lower()
        if owner == ctx["user"]:
            return True
        # 个人级不向管理者保密：负责人看辖内、老板看全企业
        owned_rows = frappe.get_all(
            "Shangshu Org Member", filters={"user": owner}, pluck="department"
        )
        for d in owned_rows:
            if d in ctx["head_departments"]:
                return True
        row = frappe.db.get_value("Shangshu Identity", {"user": owner}, "enterprise_id")
        return bool(row) and row in ctx["owned_enterprises"]
    return False


def share_allows(user, resource, need="read", ctx=None):
    """明确共享（默认读权之外唯一例外，契约 §3.11）：个人或部门共享命中即放行。

    共享到部门按「部门范围包含下属部门」生效——命中条件是**用户的任职部门
    落在共享部门子树内**（下属部门的成员/负责人因此覆盖到）。need: read|edit；
    edit 共享含 read。
    """
    email = str(user or "").strip().lower()
    resource = str(resource or "").strip()
    if not email or not resource:
        return False
    if need == "read":
        from shangshu_core.public_resources import public_resource_allows
        if public_resource_allows(email,resource):return True
    rows = frappe.get_all(
        "Shangshu Org Grant",
        filters={"kind": "share", "resource": resource},
        fields=["access", "grantee_user", "grantee_department"],
    )
    if not rows:
        return False
    rank = {"read": 1, "edit": 2}
    want = rank.get(need, 1)
    ctx = ctx or org_context(email)
    user_depts = set(ctx["member_of"]) | set(ctx["head_of"])
    for row in rows:
        if rank.get(row.access, 0) < want:
            continue
        if row.grantee_user:
            if row.grantee_user.lower() == email:
                return True
            continue
        if row.grantee_department:
            if user_depts & _descendants(row.grantee_department):
                return True
    return False


def create_grant_allows(user, department):
    """建表授权判定：所属部门（精确）/管辖范围（含下属）内不经授权；跨部门看 create_grant。"""
    email = str(user or "").strip().lower()
    dept = str(department or "").strip()
    if not email or not dept:
        return False
    ctx = org_context(email)
    if dept in ctx["member_of"] or dept in ctx["head_departments"]:
        return True
    return bool(frappe.db.exists(
        "Shangshu Org Grant",
        {"kind": "create", "grantee_user": email, "department": dept},
    ))


# ---------- 资源授权合成口（files 各入口统一走这里） ----------

def read_allows(user, resource, attribution=None):
    """归属资源的读权 = 默认管理读 + 明确共享。无归属返回 None（由调用方走旧目录授权）。

    创建人（doc.owner）的保留读由调用方（files）另判——归属人字段在组织侧。
    """
    from shangshu_core import business_access
    business_access.require_identity(user)
    trial = business_access.resource_decision(resource, user)
    if trial is not None:
        return trial
    att = attribution or resource_attribution(resource)
    if not att:
        return None
    ctx = org_context(user)
    if default_read_allows(user, att, ctx=ctx):
        return True
    return share_allows(user, resource, "read", ctx=ctx)


# ⚠️ **模块级列表，不是 `frappe.local`** —— `frappe.local` 是**请求级**的：
# 领域在 `hooks.py` 导入时注册，存进 `frappe.local` 会**随那次请求一起被丢掉**，
# 下一个请求 `resource_owner()` 就查不到解析器（实测：存量表主那条恒回 None）。
# 模块级列表在进程内存里，导入一次就一直在。
_RESOURCE_OWNER_RESOLVERS = []


def _owner_resolvers():
    return list(_RESOURCE_OWNER_RESOLVERS)


def register_owner_resolver(fn):
    """注册「资源名 → 创建人」的解析器。**内核不认识领域 doctype**，由领域在启动时注册。

    形状照抄 `objects.register_attribution_resolver`（同族：内核只定契约，领域给实现）。
    `fn(resource) -> user_email | None`。

    ⚠️ **存模块级列表**（见 `_RESOURCE_OWNER_RESOLVERS` 上面那条注释）。
    """
    if fn not in _RESOURCE_OWNER_RESOLVERS:
        _RESOURCE_OWNER_RESOLVERS.append(fn)


def resource_owner(resource):
    """资源的**创建人**（表主）。**没有解析器或查不到就回 `None`** —— 不猜。"""
    name = str(resource or '').strip()
    if not name:
        return None
    for fn in _owner_resolvers():
        try:
            owner = fn(name)
        except Exception:
            continue
        if owner:
            return str(owner)
    return None


def structure_allows(user, resource, attribution=None):
    """**能不能改这份资源的结构**（加行/加列/改名/删列……）。

    用户 2026-10-17：「**结构权不是一个独立的结构，这个属于权限的一部分**」
    + 「**表主对自己建的表当然有**」。

    **为什么要有这个函数**：文件域的 `can_structure` 现在是
    `structure_ok = manager or 'Sheet Structure Editor' in roles` —— **owner 根本没进这个式子**，
    表主被判成没有结构权（B 2026-10-17 在 3820 实测：boss 拥有 3 张 xlsx、
    `can_edit=True` 但 `can_structure=False`）。这里是那条判定的**权威版**。

    **判定顺序（B 2026-10-17 审定，次序不能换）**：

      1. **表主**（`resource_owner(resource) == user`）→ `True`
         ⚠️ **不看 `attribution`** —— 存量表（无归属）的表主**也**要拿到 True。
         若把「无归属 → None」排在它前面，**存量表主会直接丢权**（B 审出的坑）。
      2. **System Manager** 或 **`Sheet Structure Editor`** → `True`
         （**保留现有角色**，本轮不收紧；删角色是迁移，要用户拍）
      3. `attribution` 为 `None` → **`None`**
         —— 意思是「**归属依赖的那一半**判不了，回落旧口径」，
         **不是**「整条判不了」。**原样返回 `None`，不擅自当 `False`**（B 明确要求）。
      4. 其余 → `False`

    返回 `True` / `False` / `None`。**不缓存、不记快照** —— 撤权/调岗后下一包立刻是新结论。

    **不替调用方把动作侧的角色闸合进来**：动作侧 `roles` 是执行器的粗闸，
    本函数是资源级真判，**两层都要**（B 的定法）。
    """
    from shangshu_core import business_access
    business_access.require_identity(user)
    trial = business_access.resource_decision(resource, user)
    if trial is not None:
        return trial
    email = str(user or '').strip().lower()
    if not email:
        return False
    # 1. 表主 —— **必须在「无归属 → None」之前**
    att = attribution if attribution is not None else resource_attribution(resource)
    owner = att.get('owner_user') if att else resource_owner(resource)
    if owner and owner.lower() == email:
        return True
    # 2. 现有角色（保留，不收紧）
    try:
        roles = set(frappe.get_roles(user))
    except Exception:
        roles = set()
    if 'System Manager' in roles or 'Sheet Structure Editor' in roles:
        return True
    # 3. 归属那半判不了 → None（原样）
    att = attribution if attribution is not None else resource_attribution(resource)
    if att is None:
        return None
    # 4. 有归属、不是表主、没有角色 → False
    # 2026-10-18 主控对齐 E 已审定的「管理默认读不带结构权」口径（用户原话
    # 「结构权属于权限的一部分，表主当然有；管理读不带结构权」）：
    # 第 4 步一律 False，**不**再走 `_management_read_only`。管理权是读/写层面的，
    # 结构权是改 schema 层面的（行/列/表头），两个维度不互相放行。
    return False


def _management_read_only(user, attribution):
    """**管理默认读**（老板 / 负责人），**不含「同部门成员自动可读」**。

    ⚠️ **不能拿 `default_read_allows` 顶** —— 那个函数里有
    `if dept in ctx["member_of"]: return True`，那是「部门所有人自动获读权」。
    这里只认**老板**（`owned_enterprises`）与**负责人**（`head_departments`，含下属）。
    """
    if not attribution:
        return False
    ctx = org_context(user)
    level = attribution.get('level')
    if level == 'department':
        dept = attribution.get('department')
        if not dept:
            return False
        if dept in ctx['head_departments']:
            return True
        row = frappe.db.get_value('Shangshu Department', dept, 'enterprise_id')
        return bool(row) and row in ctx['owned_enterprises']
    if level == 'personal':
        owner = (attribution.get('owner_user') or '').lower()
        if owner == ctx['user']:
            return True
        owned_rows = frappe.get_all('Shangshu Org Member',
                                    filters={'user': owner}, pluck='department')
        for d in owned_rows:
            if d in ctx['head_departments']:
                return True
        row = frappe.db.get_value('Shangshu Identity', {'user': owner}, 'enterprise_id')
        return bool(row) and row in ctx['owned_enterprises']
    return False


def preview_allows(user, resource, attribution=None):
    """能不能看这份资源的**内容**（正文 / 表格值 / 渲染）—— 跟「能看条目」和
    「能拿原件」是**三件事**，不是一个 `can_edit` 布尔。

    **BASE967-22 的病根就一句：预览错用了 `download_allows`。**
    UI-017 实测「老板四类 PDF 及 A 负责人 A/Child PDF **正文**全部 403」——
    老板有**管理默认读**（`read_allows` 为真），但**没有下载权**。
    拿下载权判预览 → 正文 403。**不是判错了，是判的维度就错了。**

    **所以预览跟「读」走**。口径（`fde/设计/契约/账号与权限.md`，用户已确认）：

      · `:53` 修改资料、删除/恢复、修改规则、共享转授权、**导出/外发**、代员工发信
        及审核批准**分别配置；不能通过「默认可读」自动获得这些动作**。
        普通读取、表内搜索和**授权预览均应体现该默认读权**。 ← 这句钉死「预览跟读走」
      · `:83` 公开范围只扩展读取和使用引用的资格，**不自动扩展**……**导出**或代发权。
      · `:152` 搜索、关联标签、**预览**、复制/导出、候选和日志 | 各入口**不返回无权字段或记录**。

    ⚠️ **本函数只给资源级那一半**。字段级的过滤另由 `field_access` 判
    （口径是 **`preview = read_allows AND 字段 read`**），**不替调用方把两路合起来** ——
    两路的取消/失效条件不同（撤字段权 vs 改归属），合成规则属于调用方的领域。

    **为什么不干脆让调用方写 `read_allows` 就完事**：那样「预览」这个维度就消失了，
    下次有人又会顺手拿 `download_allows` 顶上 —— **那正是 BASE967-22**。
    立一个**有名字的口**，才立得住「三件事」这个区别。

    无归属返回 `None`（跟 `read_allows` 一致，由调用方回落旧目录授权）。
    """
    return read_allows(user, resource, attribution=attribution)


def write_allows(user, resource, attribution=None):
    """归属资源的改值/编辑权 = 归属人 或 编辑共享。管理读不带编辑（用户 2026-10-12）。"""
    from shangshu_core import business_access
    business_access.require_identity(user)
    trial = business_access.resource_decision(resource, user)
    if trial is not None:
        return trial
    att = attribution or resource_attribution(resource)
    if not att:
        return None
    if (att.owner_user or "").lower() == str(user or "").strip().lower():
        return True
    return share_allows(user, resource, "edit", ctx=org_context(user))


def download_allows(user, resource, attribution=None):
    """下载/导出独立于读：部门级默认部门内可下载；企业/个人级导出单列
    （用户 2026-10-12「管理读取不自动授予…下载」「不因可见就可导出」）。

    无归属返回 None（回落读权，保持存量行为）。
    """
    from shangshu_core import business_access
    business_access.require_identity(user)
    trial = business_access.resource_decision(resource, user)
    if trial is not None:
        return trial
    att = attribution or resource_attribution(resource)
    if not att:
        return None
    email = str(user or "").strip().lower()
    if (att.owner_user or "").lower() == email:
        return True
    if share_allows(user, resource, "edit"):
        return True
    if att.level == "department" and att.department:
        rows = frappe.get_all("Shangshu Org Member", filters={"user": email}, pluck="department")
        return att.department in set(rows)  # 部门内（任职/负责于该部门本身）
    return False


def share_right_allows(user, resource, attribution=None):
    """转授权 = 归属人（管理读不带共享，用户 2026-10-12）。无归属返回 None。"""
    from shangshu_core import business_access
    business_access.require_identity(user)
    trial = business_access.resource_decision(resource, user)
    if trial is not None:
        return trial
    att = attribution or resource_attribution(resource)
    if not att:
        return None
    return (att.owner_user or "").lower() == str(user or "").strip().lower()


def all_attribution_resources():
    """当前有组织归属的资源名（清单/计数/搜索与详情同一套校验用）。"""
    return frappe.get_all("Shangshu Org Attribution", pluck="resource", limit=10000)


def org_readable_resources(user):
    """用户按组织事实可读的资源名集（默认管理读 + 明确共享）。"""
    email = str(user or "").strip().lower()
    ctx = org_context(email)
    out = []
    for row in frappe.get_all(
        "Shangshu Org Attribution",
        fields=["resource", "level", "department", "owner_user"],
        limit=10000,
    ):
        att = {"level": row.level, "department": row.department, "owner_user": row.owner_user}
        if default_read_allows(email, att, ctx=ctx) or share_allows(email, row.resource, "read", ctx=ctx):
            out.append(row.resource)
    return out


def has_department_authority():
    return bool(frappe.db.exists("DocType", "Shangshu Department"))


def resolve_department_key(raw):
    """同企业部门 ID/唯一名称解析；解析不授予邮箱或文件访问权。"""
    from shangshu_core.identity import get_identity
    raw = str(raw or '').strip()
    enterprise = get_identity().enterprise_id
    rows = frappe.get_all("Shangshu Department", filters={"enterprise_id": enterprise, "enabled": 1},
        or_filters={"name": raw, "title": raw}, fields=["name", "title"])
    exact = [r.name for r in rows if r.name == raw]
    if exact:
        return exact[0]
    if len(rows) == 1:
        return rows[0].name
    frappe.throw("所属部门不存在、已停用或名称不唯一，请填写本企业部门编号", frappe.ValidationError)


def current_actor_organization_snapshot():
    """当前认证用户的任职快照；调用时保存，历史读取不可重新计算。"""
    user = frappe.session.user
    ctx = org_context(user)
    return {'user': user, 'departments': [
        {'id': key, 'title': department_title(key) or key}
        for key in sorted(set(ctx.get('member_of') or []))
    ]}
