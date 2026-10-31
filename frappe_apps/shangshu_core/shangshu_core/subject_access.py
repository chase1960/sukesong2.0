"""列级/表级权限的**主体范围**模型（PKG-117-T01 内核半）—— 纯规则层，**不碰 frappe**。

口径本体：`fde/设计/契约/账号与权限.md` 第 233–293 行
（「2026-10-25 列级权限按『主体范围』分配」＋ 22:4x「不留兼容函数」订正）。

**为什么是纯规则层**：和 `shangshu_core.field_access.py` **同一个理由** ——
「单独成模块是为了能脱离 frappe 运行时直接测这条派发约定本身」。
本模块**不查库、不查身份、不缓存**：主体（`member_of` / `head_departments`）由调用方
喂进来 ⇒ 撤权/调岗后下一次判定立刻是新结果。
判据见 `frappe_apps/shangshu_core/shangshu_core/tests/test_subject_access.py`。

**为什么主体判定走 `org_admin`**：契约明写「**域层按主体判**（复用
`shangshu_core.org_admin` 的判定口），**物理表给宽底座角色**」——
Frappe 的 DocPerm **只能写角色** ⇒「全局/部门/个人」写不进物理表 ⇒
物理表只落**宽底座角色**（`model_schema.physical_permissions`），让
`doc.check_permission` 过；**细判在域层/内核层**。
本模块只提供**纯规则**，**主体上下文**（这个人是谁、在哪些部门、管哪些部门）
由 `org_admin.subject_context` 现取 ⇒ 判定口统一在 `org_admin`，
**域不 import 内核私有名**（只走 `shangshu_core.public_api`）。

**为什么表级与列级是两层**（契约 §三、§四）：
  · **列级** = 这一列对三个操作各自的主体范围（最细）；
  · **表级** = 这张表整体的主体范围（最粗）；
  · **列没声明 ⇒ 继承表级**（该操作在表级的主体范围）；
  · **表级也没声明 ⇒ 拒绝**（fail-closed），并且**编译期就报错**，不许运行时才发现；
  · ⇒ 表级是**独立声明**的，**不再由各列并集推导**（并集联动会让「改一列」
    连带把整张表的表级收窄 —— 契约明令取消）。

**这套模型长什么样**（**唯一**一套，不另造第三套）：

  · **四个操作**：`read`（读）/ `write`（写）/ `filter`（筛）/ `download`（下载）
    —— 每一列对这四个操作**各自**声明主体范围。
    ⚠️ **原第五档「助手（assistant）」已去掉**（用户 2026-10-26 23:0x 拍板）：它从来没有
    任何一处真拿它判过（助理和人走**同一条读路**）⇒ 写上去「说了不算」⇒ 去掉。
    **存量声明里带着它的，按「视同未声明」处理**（不拒、不放宽）。
  · **主体四档**：`global`（全员可读可写）/ `department`（某个部门及其管理范围）/
    `personal`（某个人）/ **`none`（无人 —— 明确写「这一列/这一操作不给任何人」）**。
    **不新造 `enterprise` 档**（尚书是单例，没有企业归属）。
  · **`department` 档的 `departments` 装的是**部门 key**（不是标题）——
    与 `member_of` / `head_departments` **同一套标识** ⇒ 声明里写标题**不命中**。
  · **管理员旁路**：主体带 `is_admin`（Frappe 角色 `System Manager`）⇒
    **四档全部放行**（含 `none`）—— 与旧链 `field_access` 的旁路**同一口径**；
    这条**可翻转**（见 `ADMIN_BYPASS_INCLUDES_NONE`）。

**列级声明**（挂在列上）：
    {"id": "金额", "label": "金额", "type": "number",
     "access": {
       "read":      {"scope": "global"},
       "write":     {"scope": "department", "departments": ["7e573b3dda51"]},
       "filter":    {"scope": "department", "departments": ["7e573b3dda51"]},  # ⚠️ 已并进「读」（存量键视同未声明）
       "download":  {"scope": "personal",  "users": ["zhang@x.com"]}}}   # 三个操作都必填

**表级声明**（挂在对象 `access` 上）：形状同上，另带 `record_scope`。

**三条继承规则**（契约 §三）：
  1. **列没声明 ⇒ 继承表级**该操作；
  2. **表级也没声明 ⇒ 拒绝**（fail-closed），并且**编译期就报错**，不许运行时才发现；
  3. **`filter` 未声明 ⇒ 跟随「读」** —— 顺序是
     **列 → 列的读 → 表 → 表的读**（先看同层的「读」，本层没有再看下一层）。

**为什么单独成模块**：和 `field_access.py` 同一个理由 ——
「单独成模块是为了能脱离 frappe 运行时直接测这条派发约定本身」。
本模块**不查库、不查身份、不缓存**：主体（`member_of` / `head_departments`）由调用方
（`shangshu_core.org_admin`）喂进来 ⇒ 撤权/调岗后下一次判定立刻是新结果。

**边界**：这条链只服务**受管表**（晋升上来的表）。**建模对象链**（用户用建模器建的
普通对象）**照旧用角色键**（`read_roles` / `write_roles` / `download_roles`），
在 `shangshu_core.field_access` 里 —— **两条链各自只用自己的模型**，
这里**不写回落分支**互相兜。
"""

OPS = ("read", "write", "download")
REQUIRED_OPS = ("read", "write", "download")
SCOPES = ("global", "department", "personal", "none")

# **管理员（Frappe 角色 `System Manager`）旁路**：主体带 `is_admin` ⇒ **四档全部放行**
# （含 `none`）—— 与旧链 `field_access` 对 `System Manager` 一律旁路**同一口径**。
# ⚠️ **这条是可翻转的**：把这里改成 `False` 即表示 **`none` 连管理员也不给**
# （其余三档的旁路**不受影响**）。
# 为什么默认放行：「`none`」这一档的用途是「不给业务人员」，不是「连管理员都锁死」
# —— 管理员要能排查/导出。
ADMIN_BYPASS_INCLUDES_NONE = True

# 「可省 ⇒ 跟随『读』」的操作 —— **降维后没有可省的了**（三个都要必填）。
FOLLOW_READ = ()

# 旧链的角色键（**只用来拒绝**，不用来判）。
ROLE_KEYS = ("read_roles", "write_roles", "download_roles")

# ⚠️ **「助手」这一档已去掉**（用户 2026-10-26 23:0x 拍板）。
#   它从来**没有被执行过**（助理和人走同一条读路）⇒ 写上去「说了不算」，
#   比没有更坏（人会以为 AI 看不到这列）。⇒ **这一档从声明形状里去掉**，
#   **不是**改成「真拦」。
#   ⇒ **存量声明里已经写着 `assistant` 的，按「视同未声明」处理**：
#   **不许因此拒绝加载**，也不许因此放宽别的判定（其余三档照旧判）。
# ⚠️ **「筛」也并进了「读」**（用户 2026-10-27 06:2x 口径：读（筛）／写／下载 三个操作）
#   ⇒ 存量声明里写着 `filter` 的，同样**视同未声明**（能读就能筛，筛不再单独一刀）。
LEGACY_IGNORED_OPS = ("assistant", "filter")

_OP_LABEL = {"read": "读", "write": "写", "download": "下载"}


def _label(op):
    return _OP_LABEL.get(op, str(op))


def is_subject_access(raw):
    """这份声明是不是「主体范围」形状（新模型）。

    判据：**声明里有没有操作键**（`read`/`write`/`filter`/`download`）。
    旧形状（`read_roles` / `write_roles` / `download_roles`）没有 ⇒ 走旧链。
    """
    if not isinstance(raw, dict):
        return False
    return any(op in raw for op in OPS)


def assert_no_role_keys(raw, where=None):
    """新形状里**不许再出现**三个角色键（受管表链只走新模型，不留兼容写法）。"""
    if not isinstance(raw, dict):
        return
    found = [key for key in ROLE_KEYS if key in raw]
    if found:
        raise ValueError(
            "%s 还在用角色键 %s —— 这一条链只走「主体范围」（四个操作 × 全局/部门/个人/无人），"
            "不留兼容写法" % (where or "这份声明", "、".join(found)))


def normalize_scope(raw, where=None):
    """校验并规范化**一个**主体范围。**形状不对 ⇒ 明确拒**，并给人话理由。

    `where` 是给人看的定位串（如「字段「金额」的读权限」）⇒ 报错里能点名
    **哪个字段 / 哪个操作**，用户才看得懂。

    规范化结果：
      · `{"scope": "global"}`
      · `{"scope": "department", "departments": [...]}`（去重、去空白、排序）
      · `{"scope": "personal", "users": [...]}`（去重、去空白、排序）
      · `{"scope": "none"}`（**零子键** —— 「无人」这一档不用再写子键）

    ⚠️ `departments` 装的是**部门 key**（不是标题）—— 与 `member_of` /
    `head_departments` 同一套标识。
    """
    label = where or "主体范围"
    if not isinstance(raw, dict):
        raise ValueError(
            "%s 的写法不对：应是 {\"scope\": \"global\"}、"
            "{\"scope\": \"department\", \"departments\": [...]}、"
            "{\"scope\": \"personal\", \"users\": [...]} 或 "
            "{\"scope\": \"none\"}" % label)
    scope = raw.get("scope")
    if scope not in SCOPES:
        raise ValueError("%s 的 scope 只认 global / department / personal / none，收到：%r"
                         % (label, scope))
    if scope == "global":
        extra = sorted(set(raw) - {"scope"})
        if extra:
            raise ValueError("%s 是「全局」，不用再写 %s（多写了就说明没想清楚）"
                             % (label, "、".join(extra)))
        return {"scope": "global"}
    if scope == "department":
        extra = sorted(set(raw) - {"scope", "departments"})
        if extra:
            raise ValueError("%s 是「部门」，只认 departments，多写了：%s"
                             % (label, "、".join(extra)))
        names = raw.get("departments")
        if not isinstance(names, list) or not names:
            raise ValueError("%s 是「部门」，必须写 departments（部门名），且不能为空" % label)
        cleaned = []
        for name in names:
            if not isinstance(name, str) or not name.strip():
                raise ValueError("%s 的 departments 里只能有部门名（文字），收到：%r"
                                 % (label, name))
            cleaned.append(name.strip())
        return {"scope": "department", "departments": sorted(set(cleaned))}
    if scope == "none":
        # ⚠️ **位置必须在 personal 分支之前** —— 否则 `none` 会被当成 personal 处理
        # （personal 是这一段的兜底分支，不写显式分支就会掉进去）。
        extra = sorted(set(raw) - {"scope"})
        if extra:
            raise ValueError("%s 是「无人」，不用再写 %s（多写了就说明没想清楚）"
                             % (label, "、".join(extra)))
        return {"scope": "none"}
    if scope == "personal":
        extra = sorted(set(raw) - {"scope", "users"})
        if extra:
            raise ValueError("%s 是「个人」，只认 users，多写了：%s" % (label, "、".join(extra)))
        users = raw.get("users")
        if not isinstance(users, list) or not users:
            raise ValueError("%s 是「个人」，必须写 users（人），且不能为空" % label)
        cleaned = []
        for user in users:
            if not isinstance(user, str) or not user.strip():
                raise ValueError("%s 的 users 里只能有人的标识（文字），收到：%r" % (label, user))
            cleaned.append(user.strip())
        return {"scope": "personal", "users": sorted(set(cleaned))}
    # 兜底：`SCOPES` 里没走到的档（将来加档忘了写分支）⇒ **当场拒**，不许静默放行。
    raise ValueError("%s 的 scope 还没实现，收到：%r" % (label, scope))


def normalize_access(raw, where=None, required=REQUIRED_OPS, extra_keys=()):
    """校验一份**操作声明**（`{op: 主体范围}`）⇒ 规范化后的同形字典。

    `required` 里的操作**必填**（read / write / download）—— 缺了就**当场拒**，
    并点名缺的是哪个操作。
    """
    label = where or "权限声明"
    if not isinstance(raw, dict):
        raise ValueError("%s 须是对象（操作 → 主体范围），收到：%r" % (label, raw))
    unknown = sorted(set(raw) - set(OPS) - set(extra_keys) - set(LEGACY_IGNORED_OPS))
    if unknown:
        raise ValueError("%s 含不支持的项：%s（只认 %s）"
                         % (label, "、".join(unknown), "、".join(OPS)))
    missing = [op for op in required if op not in raw]
    if missing:
        raise ValueError("%s 缺必填的操作：%s（%s 必填）"
                         % (label, "、".join(_label(op) for op in missing),
                            "、".join(_label(op) for op in required)))
    out = {}
    for op in OPS:
        if op in raw:
            out[op] = normalize_scope(raw[op], where="%s 的「%s」权限" % (label, _label(op)))
    # ⚠️ **遗留的 `assistant` / `filter` 键视同未声明**
    #    （都已去掉的一档 ⇒ 直接忽略，不拒、不放宽）
    _assert_progression(out, label)
    return out


def _definitely_wider(scope, read_scope):
    """`scope` 是否**确定比** `read_scope` **宽**（⇒ 违反「不能读就不能写/下载」）。

    **只判「确定宽」的那几种，不猜**（内核做确定性检查，不做推断）：
      · 读＝全局 ⇒ 任何范围都**不比它宽**（全局最大）；
      · 读＝部门 D ⇒ 写/下载是**全局**才算宽（部门里不止 D 的人）；
      · 读＝个人 U ⇒ 写/下载是全局／部门／**多了别人**都算宽；
      · 读＝无人 ⇒ 写/下载只要**不是无人**就算宽。

    ⚠️ 「读＝部门 D、写＝部门 D2（D2≠D）」这种**不可比**的组合**不当它宽**
      （内核不知道两个部门谁大）⇒ 放行；真正的拦截由**运行时递进**兜底
      （读不通的人照样写不了）。
    """
    read_kind = read_scope.get("scope")
    kind = scope.get("scope")
    if read_kind == "global":
        return False
    if read_kind == "none":
        return kind != "none"
    if read_kind == "department":
        return kind == "global"
    if read_kind == "personal":
        if kind in ("global", "department"):
            return True
        if kind == "personal":
            # 写的名单里**多了**读名单之外的人 ⇒ 那个人写得着却读不着 ⇒ 更宽。
            return bool(set(scope.get("users") or []) - set(read_scope.get("users") or []))
        return False
    return False


def _assert_progression(access, label):
    """**递进检查（编译期）**：写/下载**确定比读宽** ⇒ 当场拒，并说人话。

    ⚠️ 只在**同一份声明内**比（列级声明自己比、表级声明自己比）；
    跨层的组合（「列只声明写、读继承表级」）由**运行时递进**兜底。
    """
    read_scope = access.get("read")
    if not read_scope:
        return
    for op in ("write", "download"):
        scope = access.get(op)
        if not scope:
            continue
        if _definitely_wider(scope, read_scope):
            raise ValueError(
                "%s 的「%s」范围比「读」更宽 —— 权限是递进的：不能读就不能写、不能下载"
                "（请把「%s」收窄到「读」的范围之内）"
                % (label, _label(op), _label(op)))


def _declared(access, op):
    """这一层有没有声明这个操作（空字典不算声明）。"""
    if not isinstance(access, dict):
        return None
    value = access.get(op)
    if isinstance(value, dict) and value:
        return value
    return None


def resolve_op_scope(field_access, table_access, op):
    """走完「**列 → 列的读 → 表 → 表的读**」这条继承链，返回该操作最终生效的主体范围。

    两个入参都是**操作声明**（`{op: 主体范围}`）—— 列级的取字段上的 `access`，
    表级的取对象上的 `access`。

    **全都没有 ⇒ 抛错**（fail-closed）：宁可拒，不静默放行。
    """
    if op not in OPS:
        raise ValueError("操作只认 read / write / download，收到：%r" % (op,))
    scope = _declared(field_access, op)
    if scope is None and op in FOLLOW_READ:
        scope = _declared(field_access, "read")
    if scope is not None:
        return normalize_scope(scope, where="列的「%s」权限" % _label(op))
    scope = _declared(table_access, op)
    if scope is None and op in FOLLOW_READ:
        scope = _declared(table_access, "read")
    if scope is not None:
        return normalize_scope(scope, where="表的「%s」权限" % _label(op))
    raise ValueError("「%s」权限没声明：列没声明、表也没声明 —— 拒绝（不猜、不放行）"
                     % _label(op))


def _is_admin(person):
    """这个主体是不是**管理员**（Frappe 角色 `System Manager`）。

    **只看主体字典里的 `is_admin`** —— 纯规则层**不查角色**（查角色的活儿在
    `shangshu_core.org_admin.subject_context`）⇒ **缺这个键 = 不是管理员**。
    """
    return bool(person.get("is_admin"))


def subject_allows(scope, subject, where=None):
    """纯判定：这个人对这份主体范围**有没有**这个操作的资格。**不查库。**

    `subject` 的形状 = `{"user": "<email>", "member_of": [...],
    "head_departments": [...], "is_admin": bool}`
    —— 由调用方（`shangshu_core.org_admin`）喂进来（那边每次现取，不缓存）。

    判定口径：
      · **管理员**（`is_admin` 为真 ⇔ Frappe 角色 `System Manager`）⇒ **四档全部放行**
        （含 `none`）—— 与旧链 `field_access` 的管理员旁路**同一口径**；
        `ADMIN_BYPASS_INCLUDES_NONE = False` 时，**`none` 连管理员也不给**；
      · `global` ⇒ **任何已登录用户**都允许；
      · `department` ⇒ 用户的**任职部门**或**管辖范围**命中声明的部门
        （**部门 key** —— 与 `member_of` / `head_departments` 同一套标识）；
      · `personal` ⇒ **本人**命中声明的人；
      · `none` ⇒ **一律拒**（返回 False，**不抛错**）——
        「明确写了不给」**≠**「没声明」（没声明 ⇒ `resolve_op_scope` 抛错让人补）。
    """
    normalized = normalize_scope(scope, where=where)
    person = subject if isinstance(subject, dict) else {}
    if _is_admin(person):
        # 管理员旁路 —— **在「没登录用户 ⇒ 拒」那一段之前**判。
        if normalized["scope"] != "none" or ADMIN_BYPASS_INCLUDES_NONE:
            return True
        # 开关关掉 ⇒ `none` 这一档**谁都不给**（管理员也不行）。
        return False
    user = str(person.get("user") or "").strip().lower()
    if not user:
        # 不是已登录用户 ⇒ 无人可放行（fail-closed）。
        return False
    if normalized["scope"] == "global":
        return True
    if normalized["scope"] == "department":
        owned = {str(name).strip().lower() for name in (person.get("member_of") or [])}
        owned |= {str(name).strip().lower() for name in (person.get("head_departments") or [])}
        wanted = {str(name).strip().lower() for name in normalized["departments"]}
        return bool(owned & wanted)
    if normalized["scope"] == "none":
        # 明确写「不给」⇒ **拒**，但**不抛错**（形状是好的，只是答案就是「不给」）。
        return False
    wanted_users = {str(name).strip().lower() for name in normalized["users"]}
    return user in wanted_users


def field_allows_subject(field, subject, op, table_access=None):
    """**单列单操作**判定（纯函数，不查库）。

    列声明了 `access` ⇒ 按列声明走（没声明那个操作就继承表级）；
    列**没有** `access` ⇒ 继承表级；表级也没有 ⇒ **拒**（解析层抛错，fail-closed）。

    ⚠️ 列上带着**角色键** ⇒ **明确拒**：那是建模对象链的写法，
    不许在主体判定这条路上静默当成「没声明」。

    ⚠️ **递进（用户 2026-10-27 06:2x 口径）**：**不能读就不能写、不能下载** ——
    判「写」「下载」时，**先判「读」**：读不通 ⇒ 这一项也不通
    （哪怕写/下载自己声明得更宽）。这样「读是前提」在**运行时**也成立，
    不只靠编译期那道形状检查。
    """
    if not isinstance(field, dict):
        raise ValueError("字段声明须是对象，收到：%r" % (field,))
    if op in ("write", "download"):
        try:
            if not field_allows_subject(field, subject, "read", table_access):
                return False
        except ValueError:
            return False  # 读都算不出来（表级也没声明）⇒ fail-closed
    access = field.get("access")
    if access is None:
        if any(key in field for key in ROLE_KEYS):
            raise ValueError(
                "字段「%s」用的是角色键（%s）—— 那是建模对象链的写法，不走主体判定"
                % (field.get("id"), "、".join(key for key in ROLE_KEYS if key in field)))
        access = {}
    scope = resolve_op_scope(access, table_access, op)
    return subject_allows(scope, subject,
                           where="字段「%s」的「%s」权限" % (field.get("id"), _label(op)))


def field_capabilities(fields, subject, table_access=None):
    """逐列有效能力 —— `{字段id: {op: bool}}`，**四个操作各一维**。

    判定口径与 `field_allows_subject` 一致（**同一份规则**，不写第二套）。
    某个操作**连表级都没声明** ⇒ 该维按**拒**算（fail-closed），**不抛错**
    —— 能力投影要给界面看，不该因为一列没配就整个炸掉。
    """
    out = {}
    for field in fields or ():
        fid = field.get("id")
        row = {}
        for op in OPS:
            try:
                row[op] = bool(field_allows_subject(field, subject, op, table_access))
            except ValueError:
                row[op] = False
        out[fid] = row
    return out


def scope_label(scope):
    """给界面/报错用的**中文名**：全局 / 部门：财务 / 个人：张三 / 无人。"""
    normalized = normalize_scope(scope)
    if normalized["scope"] == "global":
        return "全局"
    if normalized["scope"] == "department":
        return "部门：" + "、".join(normalized["departments"])
    if normalized["scope"] == "none":
        return "无人"
    return "个人：" + "、".join(normalized["users"])
