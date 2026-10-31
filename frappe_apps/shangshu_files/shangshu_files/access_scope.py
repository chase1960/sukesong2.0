"""域侧的**声明校验与主体判定适配**（PKG-117-T01 · 文件域这一半）。

**是什么**：受管表（晋升上来的表）这条链上的权限声明，形状是
**「三个操作 × 主体四档」**（读（筛）／写／下载 各自一个
全局／部门／个人／**无人**范围）。

⚠️ **降维（用户 2026-10-27 06:2x 口径）**：权限只有**三个**操作 ——
**读（筛）／写／下载**，且**递进**（不能读就不能写、不能下载）。
「筛」并进了「读」（能读就能筛）；「助手」那一档**去掉**（助手跟着账号走）。
⇒ 存量声明里写着 `filter`／`assistant` 的，**视同未声明**（不拒、不放宽）。

⚠️ **四档**（用户 2026-10-26 拍板 · 决议③）：全局／部门／个人**后面加「无人」**
（`{"scope": "none"}` —— 这一列/这一操作**谁都不给**；内核那边**显式拒、不抛错**）。
**域里不许自己写档位白名单** —— 形状一律**直调内核公开面** `normalize_access`
⇒ 内核加第四档（`none`）**自动生效**，域这边**一行都不用改**
（域里留第二份档位清单＝两份事实 —— 那正是这条链一直在清的东西）。

**规则本体只有一份，在内核**：
· 纯规则层 `shangshu_core.subject_access`（形状、继承链、判定）；
· 公开面 `shangshu_core.public_api` 导出 `subject_context` /
  `subject_allows` / `field_subject_allows`，
  以及**形状校验**的 `normalize_scope` / `normalize_access`（PKG-117-T01 · 导出半）。

**域只管三件事**（各归各家，**不写第二套规则**）：

1. **入口闸**：每个晋升列**必须写清**三个操作的主体范围；**表级独立声明**
   （不再由各列并集推导 —— 契约 2026-10-25 22:4x「取消并集联动」）。
   不合法 ⇒ **当场拒**，理由**点名是哪个列、哪个操作、缺什么**。
2. **继承**：列没声明 ⇒ 继承表级；表级也没声明 ⇒ **拒**。
   **继承链本体在内核**（`resolve_op_scope`），
   域经 `field_subject_allows` 这个组合口**调它**。
   ⚠️ **递进**（不能读就不能写、不能下载）也在**内核**那个口里 ⇒ 域不自己判。
3. **判定适配**：组织事实取内核 `subject_context`（**域不查组织表**），
   判定调内核 `subject_allows` / `field_subject_allows`。

⚠️ **域里不许有第二份规则**（仓库约定 §13「公共工具只留一份」）：
连**形状校验**也走内核 —— 公开面**正式导出**了 `normalize_scope` /
`normalize_access`（2026-10-26 · PKG-117-T01 导出半）⇒ 域**直调**，
**不再**借 `subject_allows` 绕道触发（绕道＝依赖「`subject_allows` 会先做
形状校验且对空 user 不抛别的错」这个**实现细节**）。
域只把内核抛的 `ValueError` **翻译成「当场拒」**并带上**定位串**（哪个列、哪个操作）。

⚠️ **边界**：这条链只服务**受管表**。**建模对象链**（用户用建模器建的普通对象）
**照旧用角色键**（`read_roles` / `write_roles` / `download_roles`），
在 `shangshu_core.field_access` 里 —— 两条链**各自只用自己的模型**，不互相兜。

**测试通过 = `tests/test_promotion_subject_access.py`** 的编号 PS-01～PS-13。
"""
import frappe

from shangshu_core.public_api import (subject_allows, field_subject_allows, subject_context,
                                      normalize_access)

#: 三个操作 —— **与内核 `subject_access.OPS` 同名同序**（内核那份是权威；
#: 这里只当「声明完整性」与「能力投影」的遍历清单，**不是规则**）。
#: ⚠️ **降维**（用户 2026-10-27 06:2x 口径）：读（筛）／写／下载 —— **筛并进了「读」**，
#: 「助手」那一档已去掉 ⇒ 存量声明里的 `filter`／`assistant` **视同未声明**。
OPS = ('read', 'write', 'download')

#: 必填的三个（读／写／下载）—— **每个晋升列必填**（域的入口闸）。
REQUIRED_OPS = ('read', 'write', 'download')

#: 旧链的角色键 —— **本链只用来拒绝**（契约 22:4x「不留兼容函数」）。
LEGACY_ROLE_KEYS = ('read_roles', 'write_roles', 'download_roles')

#: 表级 `access` 额外保留的那个键（**不是**主体范围，是记录范围）。
#:
#: ⚠️ **别把它当「主体档位」**：这一组是**记录范围**（**本人的行** / **全部行**），
#:    与「全局／部门／个人／无人」那**四档主体范围**是两回事 —— 判定链上读的是
#:    `scope` 那个键，这一个只管「能看到的行有多宽」。
RECORD_SCOPE_KEY = 'record_scope'
RECORD_SCOPES = ('own', 'all')

# ℹ️ 操作的中文名（「读／写／筛／下载／助手」）**归内核那份规则**了 ——
# 域判形状时把整份声明交给 `normalize_access`，它抛的 `ValueError` 里
# 已经带中文操作名 ⇒ 域**不再留第二份**（原来那份 `_OP_LABEL` 已删）。


# --------------------------------------------------------------------------
# 一、入口闸：声明形状（**规则走内核**，域只补定位串与「当场拒」）
# --------------------------------------------------------------------------

def reject_legacy_keys(container, where):
    """容器里还带旧的三个角色键 ⇒ **明确拒**（不留兼容、不回落）。

    契约 2026-10-25 22:4x：「旧的『三个角色键』……**直接换掉，不保留回落分支**」。
    """
    found = [key for key in LEGACY_ROLE_KEYS if key in (container or {})]
    if found:
        raise ValueError(
            '%s 还用着旧的**角色键**（%s）—— 这条链只走「三个操作 × 主体范围」'
            '（全局／部门／个人／无人），不留兼容写法' % (where, '、'.join(found)))


def validate_access(access, where='权限声明', required=REQUIRED_OPS,
                    allow_record_scope=False):
    """校验一份 `access` 声明（三操作 × 主体范围）。**不合法 ⇒ 抛 `ValueError`**。

    **形状规则全在内核**（公开面**正式导出**的 `normalize_access`／`normalize_scope`）：
      · **必填**：`required` 里的操作必须在（读／写／下载 必填）；
      · **不许有别的键**：只认那三个操作（表级另加 `record_scope`）；
        ⚠️ **存量键 `filter`／`assistant` 视同未声明**（内核那一份处理，域不重复实现）。
      · **形状**：每个操作的主体范围由内核那份 `normalize_scope` 判
        （**四档**：全局／部门／个人／**无人** —— 域里**没有**档位白名单，
        内核加档位域这边自动生效）。

    域**只给定位串**（`where`＝哪个列／哪张表）并把内核抛的 `ValueError`
    **翻译成「当场拒」**（见 `require_access`）⇒ **域里不写第二份形状规则**。
    """
    extra = (RECORD_SCOPE_KEY,) if allow_record_scope else ()
    # **直调内核公开面**（不是借 `subject_allows` 绕道触发）：声明形状一句话交给内核判。
    normalize_access(access, where=where, required=required, extra_keys=extra)
    out = {}
    for op in OPS:
        if op not in access:
            continue
        out[op] = access[op] if isinstance(access[op], dict) else dict(access[op])
    if allow_record_scope and RECORD_SCOPE_KEY in access:
        scope = str(access[RECORD_SCOPE_KEY] or '').strip()
        if scope not in RECORD_SCOPES:
            raise ValueError('%s 的 %s 只能是 %s 之一（收到 %r）'
                             % (where, RECORD_SCOPE_KEY, '／'.join(RECORD_SCOPES), scope))
        out[RECORD_SCOPE_KEY] = scope
    return out


def require_access(access, where='权限声明', required=REQUIRED_OPS,
                   allow_record_scope=False):
    """`validate_access` 的**入口闸版**：不合法 ⇒ 当场拒（`frappe.ValidationError`）。"""
    try:
        return validate_access(access, where=where, required=required,
                               allow_record_scope=allow_record_scope)
    except ValueError as error:
        frappe.throw(str(error), frappe.ValidationError)


def require_no_legacy_keys(container, where):
    """入口闸版：带旧角色键 ⇒ 当场拒。"""
    try:
        reject_legacy_keys(container, where)
    except ValueError as error:
        frappe.throw(str(error), frappe.ValidationError)


# --------------------------------------------------------------------------
# 二、判定适配（**全部调内核**：组织事实 `subject_context`，判定 `subject_allows`
#     / `field_subject_allows`；继承链本体在内核 `resolve_op_scope`）
# --------------------------------------------------------------------------

def actor(user=None):
    """当前（或指定的）那个人。"""
    return (str(user or '').strip()
            or str(getattr(frappe.session, 'user', '') or '').strip())


def context(user=None, ctx=None):
    """主体判定上下文（**组织事实取内核 `subject_context`**）。

    ⚠️ **ctx 原样传下去，一个键都不许摘**（用户 2026-10-26 决议④）：
    内核 `org_admin.subject_context` 的返回里多了 **`is_admin`**（管理员标记）
    ⇒ **管理员旁路在域侧自动生效**（管理员＝System Manager，对四档
    **全部放行**，包括「无人」档）—— 域**自己判一次管理员**就是第二份规则。
    """
    if ctx is not None:
        return ctx
    return subject_context(actor(user))


def allows(scope, user=None, ctx=None):
    """这个人对这份主体范围**有没有**资格（**调内核**）。"""
    return bool(subject_allows(actor(user), scope, ctx=ctx))


def field_allows(field, op, user=None, table_access=None, ctx=None):
    """单列单操作判定（**调内核**）。

    内核那个口 = 「列声明 → 列的读 → 表 → 表的读」的继承链 ＋ 主体判定，
    **规则本体在内核**（域不自己写继承链）。
    表级也没声明 ⇒ 内核**抛错**（fail-closed）⇒ 这里按**拒**算。
    """
    try:
        return bool(field_subject_allows(actor(user), field, op, table_access, ctx))
    except ValueError:
        # 「表级也没声明」/ 声明坏了 —— 一律**拒**（不静默放行）。
        return False


def table_allows(table_access, operation, user=None, ctx=None):
    """**表级**主体范围里，这个操作这个人有没有资格。

    继承链本体在内核（`field_subject_allows`：列 → 列的读 → 表 → 表的读）——
    这里传一个**空列声明**，走的正是**表级**那一层。

    ⚠️ **没有表级声明 ⇒ 跟「读」走（True）**：这张表没定义过晋升 ⇒
    **没有列级限制** ⇒ 不该凭空多出「不能筛」的限制。
    """
    if not table_access:
        return True
    return field_allows({}, operation, user=user, table_access=table_access, ctx=ctx)


def capabilities(fields, user=None, table_access=None, ctx=None):
    """逐列能力投影：``{字段id: {read, write, download}}``。

    **三个维度**（读／写／下载；「筛」并进了「读」，「助手」那一档已去掉）——
    每一维都调内核那个口算，**域不自己判**。某一维算不出来（表级也没声明）⇒ 按**拒**算。
    """
    person = actor(user)
    subject = context(person, ctx)
    out = {}
    for field in fields or ():
        field = field or {}
        fid = field.get('id') or field.get('field')
        row = {}
        for op in OPS:
            try:
                row[op] = bool(field_subject_allows(person, field, op, table_access, subject))
            except ValueError:
                row[op] = False
        out[fid] = row
    return out
