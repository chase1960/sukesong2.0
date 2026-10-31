"""内核的**数据归属口径**（纯口径，**零数据库依赖** ⇒ 离线也断得住）。

**这两条口径是什么（2026-10-25 用户拍板）**

① **新建业务表走「晋升」那条路**，**不建自己的 DocType**。
   晋升那条路的完整形态：
   **表文件（xlsx，在文件中心）→ 每一列都晋升成受管列 → 受管对象 ＋ 受管记录 →
   域的动作从内核重新注册（写路径指向受管记录）**。
   为什么是这条路：受管记录是**内核里的东西**（受字段 ACL 管、受版本闸管、审计进统一日志库、
   跨域可读可写）⇒ 域拆了以后**数据还能被接手**；而域自建的 DocType 是**域的私产**
   （物理表在 Frappe 里，别的域不许直接读写 ⇒ 只能人工交接）。

   **存量怎么办**：域自建的 DocType 表**逐域重走一遍晋升**（也要 xlsx、每一列都晋升、
   动作重新注册）⇒ 重走完就没有自建表了。
   ⇒ 所以内核**不拦存量**（拦了会挡住迁移），**只拦新增**：域的声明里**新出现**一个带
   `doctype` 的对象 ⇒ 当场点名拒。

② **域名下还有「没人接手的数据」时，不许停用这个域**。
   为什么：受管记录在内核的物理表里、DocType 行在 Frappe 里 ⇒ **域拆了（逻辑没了）
   数据不会跟着走** ⇒ 会静悄悄地变成**孤儿数据**（没人声明、没人认领、没人能写）。
   ⇒ 停用/拆走前必须先处理（迁走、退役、或转成受管对象）⇒ 内核在这里**点名报出来**。

**为什么单独成一件**：这两条是**口径**，不是行为 —— 行为那一半要读库（受管记录条数、
DocType 行数），口径这一半**纯函数** ⇒ 离线判据能直接断它，
不靠「跑一遍站点」才发现口径被改坏了。
"""

# 域声明里的对象：带 `doctype` ＝ **自建表**（域自己的 DocType）；
# 带 `managed_title` ＝ **受管对象**（走受管那条路，不算自建表）。
_NATIVE_MARK = "doctype"


def _declared_objects(contribution):
    """一份域贡献里的对象声明（只认 dict 项）。"""
    if not isinstance(contribution, dict):
        return []
    return [item for item in (contribution.get("objects") or []) if isinstance(item, dict)]


def new_native_table_violations(old_contribution, new_contribution):
    """**新出现**的自建 DocType 表（新建业务表不许自建表 ⇒ 走晋升那条路）。

    返回：违反口径的对象 id 列表（**空 = 没有违反**）。

    · `old_contribution` 是**上一次登记**的域贡献；**`None` ＝ 域第一次登记**
      （那一次全部声明都是新的，但**那不是新增** ⇒ 放行，否则域根本装不上）；
    · **存量不拦**：上一轮就有的自建表原样留着（逐域重走晋升期间不许挡住迁移）。
    """
    if old_contribution is None:
        # **首次登记**：不是「新增」（域刚装上时所有声明都是新的）。
        return []
    known = {str(item.get("id") or "") for item in _declared_objects(old_contribution)
             if item.get(_NATIVE_MARK)}
    violations = []
    for item in _declared_objects(new_contribution):
        if not item.get(_NATIVE_MARK):
            continue
        object_id = str(item.get("id") or "")
        if object_id and object_id not in known:
            violations.append(object_id)
    return violations


def native_table_violation_note(domain_display, violations):
    """给「新增自建表」那句人话（**点名到对象 id**）。"""
    return ("%s 新声明了自建 DocType 表（%s）：**新建业务表走「晋升」那条路**"
            "（表文件 → 每一列都晋升 → 受管对象 ＋ 受管记录 → 动作从内核重新注册）；"
            "存量的自建表请**逐域重走一遍晋升**（迁移期间不拦）。"
            % (domain_display, "、".join(str(item) for item in violations)))


def orphan_data_blockers(domain_display, owned_data):
    """域名下**还有没人接手的数据** ⇒ 停用/拆走前必须先处理。

    `owned_data` ＝ `[(标签, 条数)]`（标签：受管对象标题 或 DocType 名；条数：数据条数）。
    返回：阻断文案列表（**空 = 没有孤儿数据**）。

    文案要**点名到哪张表、多少条** —— 只说「有数据」没人能处理。
    """
    blockers = []
    for item in owned_data or []:
        try:
            label, count = item[0], int(item[1])
        except (TypeError, ValueError, IndexError):
            continue
        if count > 0 and str(label or "").strip():
            blockers.append("%s 名下还有 %d 条数据没人接手：%s —— 请先迁走、退役或转成受管对象"
                            % (domain_display, count, str(label).strip()))
    return blockers
