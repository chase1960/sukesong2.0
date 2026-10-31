"""
权限判定的**纯规则**（纯函数，不碰 frappe）。

三块：
  ① **字段级**有效权限（PKG-001-T09 的 B 半）—— 逐字段 read/write/download
  ② **行级读作用域强制**（F12）—— 不许靠调用方自觉圈 `actor_user`
  ③ **内容就绪闸**（D 契约 §17）—— 挡「最新那份没回填完就下载」的裸 URL 口

**为什么单独成模块**：和 `replay_guard.py` 同一个理由 ——
「单独成模块是为了能脱离 frappe 运行时直接测这条派发约定本身」。
判据见 `shangshu-server/scripts/tests/test_field_access.py`。

---

## ⚠️ 两条链，**各用各的模型**（PKG-117-T01，2026-10-25）

本文件里「角色键」那套（`field_allows_roles` / `field_gaps` /
`field_capabilities` / `declare_gaps` / `assert_well_declared` /
`open_by_default`）**只服务「建模对象链」** —— 用户用建模器建的普通对象。

**受管表链**（晋升上来的表）从 2026-10-25 起**只走新模型**：
**四个操作 × 主体三档**（`read`/`write`/`filter`/`download`
× `global`/`department`/`personal`），规则本体在
**`shangshu_core.subject_access`**（纯规则层，同样能脱离 frappe 直接测）。

⇒ **两条链各自只用自己的模型**，本模块**不写回落分支**互相兜：
带 `access` 的走新模型，带 `read_roles` 的走旧模型 ——
**由声明自己的形状决定走哪条**，不猜。

---

**字段声明形状（建模对象链）**：字段是一张表里的一列/一条属性，形如
`{"id": "金额", "read_roles": [...], "write_roles": [...], "download_roles": [...]}`
—— 与既有 `shangshu_core.model_records._fields` 读的 `compiled["fields"]` 元素**同构**。
`model_records` 那边也改用这里同一份规则，**不写第二套**（§「已有能力不重写」）。

**未声明的维度怎么办**（2026-10-15 用户拍板，口径见 `field_allows_roles`）：
`read`/`write` **不限制**（照抄既有 `_fields` 的语义，改了会把存量建模对象锁死）；
`download` **零声明即拒**（用户 2026-10-15 选 (c)）—— 没声明「谁能下载」的字段
**一律不给下载**：不跟着读走、不默认开。要拒就显式写 `[]`。
**漏写 = 不限**是 read/write 的既有约定，所以配完跑 `declare_gaps()` 揪单边声明。
（本段原写的旧口径是「download 跟读权走」，改行为时注释没跟上，**贴假标** ——
FA-22 ⑦ 钉着，不许再退回去。）

> **上面这段口径只对「建模对象链」成立**（角色键那条链）。
> **受管表链**（晋升上来的表）的新口径是：
> **未声明 = 继承表级**（继承链 = 列 → 列的读 → 表 → 表的读），
> **表级也未声明 = 拒**（fail-closed，编译期就报错）。
> **旧口径原文保留在上，作对照用** —— 它**不是**受管表链的口径。

**⚠️ 「撤权后立即失效」靠的是什么**：本模块**不缓存、不记状态**，每次调用拿当次
传进来的参数现算。角色集由调用方（`org_admin` / 领域）**每次现取**
（`frappe.get_roles()`），所以撤权/调岗后下一次判定立刻就是新结果。
谁在这里加缓存，谁就把「撤权后立即失效」弄没了。
"""

import re

# ⚠️ `subject_access` **不**在这里顶层 import：本模块的判据
# （`shangshu-server/scripts/tests/test_field_access.py`）是**按文件路径**加载它的
# （那时 `shangshu_core` 包不在 sys.path 上）⇒ 顶层 import 会把那条判据打红。
# ⇒ 新模型的转发口**在函数里 import**（逻辑本体仍然只有一份）。


NEEDS = ("read", "write", "download")
_RULE_OF = {"read": "read_roles", "write": "write_roles", "download": "download_roles"}
# 拒因里的维度名。**四个操作都认**（新模型的「筛」也要有中文名，
# 不然报错里会出现英文维度名，用户不懂）。
# ⚠️ **「助手」那一档已去掉**（用户 2026-10-26 23:0x 拍板）⇒ 不再有它的中文名。
_NEED_LABEL = {"read": "读", "write": "写", "download": "下载"}


def rule_of(need):
    """need → 字段声明里的角色规则键。**不是 read/write/download 的明确拒**，
    不静默当成 read —— 静默降级等于把「下载权」当「读权」放过去。"""
    if need not in NEEDS:
        raise ValueError("need 只认 read / write / download，收到：%r" % (need,))
    return _RULE_OF[need]


def field_allows_roles(field, roles, need="read"):
    """纯判定：这组角色能不能对这个字段做 need。**不查库、不查身份。**

    ⚠️ **只服务「建模对象链」**（角色键）。**受管表链**走
    `subject_access.field_allows_subject`（主体范围，三个操作）——
    两条链各用自己的模型，这里**不**给受管表链兜底。

    `System Manager` 照旧旁路（既有语义，不改）。

    **未声明该维度时怎么办**（2026-10-15 用户拍板，口径见下）：
      · `read` / `write` —— **不限制**。这是既有 `model_records._fields` 的约定
        （`rule not in field` → 放行），本模块不改它；改了会把存量单边声明的字段
        当场锁死（实测 3820 上 11 个字段里就有一个 `jiaoyan` 只写了 write_roles）。
        **用户 2026-10-15 明确说「不该」改成漏写即拒** —— 这两个维度**保持现状**。
      · `download` —— **零声明即拒**（用户 2026-10-15 选 (c)）。没声明「谁能下载」的字段，
        **一律不给下载**：不回落 `read_roles`、不默认开、不跟着读走。

        **改之前**：回落 `read_roles`（读得到就下得了）。
        **改之后**：零声明 = 拒。
        **为什么改**：用户 2026-10-12「不因可见就可导出」说的是**读不自动带出导出**；
        「回落 read_roles」正是那句话的反面。E 转达用户原话选的是 (c) 而不是
        (a)「按部门级下载资格给」—— 所以「部门级表默认部门内有下载资格」那句
        **仍成立，但只在有声明时**；零声明就是拒。

    要拒就显式写 `[]`（`write_roles: []` = 无人可改）。**read/write 漏写 = 不限**是既有约定，
    所以配置期用 `declare_gaps()` 把单边声明揪出来（见 FA-10）。
    **download 不同**：漏写就是拒，不用配也不会漏到导出侧。判据 FA-20 钉着。
    """
    rule = rule_of(need)
    current = set(roles or ())
    if "System Manager" in current:
        return True
    if rule not in field:
        # download 未声明 → **拒**（用户 2026-10-15 选 (c)「零声明即拒」，不回落）
        if need == "download":
            return False
        return True  # read/write 未声明 = 不限制（同 model_records._fields，B1 保持）
    return bool(current.intersection(field[rule]))


def deny_reason(field_id, need="read"):
    """拒绝理由：**点名是哪个字段**。泛泛一句「没权限」用户无从定位。"""
    return "字段「%s」没有%s权限" % (field_id, _NEED_LABEL.get(need, need))


def field_gaps(fields, roles, need="read"):
    """缺 need 权的字段 id 清单（有序、不重）。

    D 的「有导出资格但缺一字段读权 → 拒整文件」用它：回**具体缺哪几个**，
    不是回 true/false —— 报错里要能点名，用户才看得懂。
    """
    missing = []
    for field in fields or ():
        if field_allows_roles(field, roles, need):
            continue
        fid = field.get("id")
        if fid not in missing:
            missing.append(fid)
    return missing


def field_capabilities(fields, roles):
    """逐列有效能力 —— 读回包要附带的那个「谁能对哪列做什么」。

    回 ``{字段id: {"read": bool, "write": bool, "download": bool}}``。

    ⚠️ **这条只服务「建模对象链」**（角色键那条链，**三个维度**）。
    **受管表链**（晋升上来的表）走**新模型**、回**五个维度**
    （多「筛」「助手」两维）⇒ 那是 `shangshu_core.subject_access.field_capabilities`，
    **本函数不服务它**，两条链不混。

    **为什么要有**（契约 `接口契约.md:430`）：「打开表/范围读取返回当前用户可读的值和
    执行操作所必需的**逐列有效能力/限制**……前端据此呈现只读/可编辑/部分可编辑」。
    没有这个，前端只能整表猜：全当可编辑（错了会提交失败）或全当只读（浪费可编辑的列）。

    **`:431` 的三条约束本函数都守**：
      · **复用同一受管权限来源** —— 就是 `field_allows_roles`，**不写第二套**
      · **后端不信客户端提交的权限结果** —— 服务端现算，调用方拿去展示，不信回传
      · **不缓存** —— 每次现算，撤权/调岗后下一包立刻是新结论（同本模块全局约定）

    **判定口径**照 `field_allows_roles`（**建模对象链**）：read/write 未声明=不限，
    download 零声明=拒。
    所以「读得到下不了」的列会是 ``read=True, download=False`` —— 那是**正确**结论，
    不是 bug。System Manager 旁路也照旧。

    **不管的事**：行级范围（`enforced_row_scope` 管）、资源级归属（`org_admin` 管）。
    本函数只给**字段维度**；调用方把三路合起来才是「有效权限」全貌。
    **为什么不替调用方合**：三路的取消/失效条件不同（撤字段权 / 撤行范围 / 改归属），
    合成规则属于调用方的领域，塞进来就是猜。
    """
    out = {}
    for field in fields or ():
        fid = field.get("id")
        out[fid] = {
            "read": field_allows_roles(field, roles, "read"),
            "write": field_allows_roles(field, roles, "write"),
            "download": field_allows_roles(field, roles, "download"),
        }
    return out


# ---------------- 新模型（主体范围）的入口：**逻辑只写一份** ----------------
# 受管表链（晋升上来的表）走「三个操作 × 主体三档」，规则本体在
# `shangshu_core.subject_access`（纯规则层）。这里**只做转发**，
# **不写第二套判定** —— 两条链各自用自己的模型，但**每条链的规则都只有一份**。

def field_allows_subject(field, subject, op, table_access=None):
    """**受管表链**的单列单操作判定（新模型入口，规则见 `subject_access`）。

    `field` 带 `access`（主体范围声明）；`table_access` 是表级声明
    （列没声明那个操作就继承表级）。
    """
    from shangshu_core import subject_access
    return subject_access.field_allows_subject(field, subject, op, table_access)


def subject_capabilities(fields, subject, table_access=None):
    """**受管表链**的逐列有效能力 —— **五个维度**（多「筛」「助手」两维）。

    与上面那个建模链的 `field_capabilities` **不是同一套**：那个是角色键三维，
    这个是主体范围三维。**别混用**。
    """
    from shangshu_core import subject_access
    return subject_access.field_capabilities(fields, subject, table_access)


# 单边声明检测只看 read/write 两个**既有**维度。`download_roles` 是本模块新增的，
# 存量声明里根本没有，拿它当单边会把每一条都误报。
_ONE_SIDED = ("read_roles", "write_roles")


def declare_gaps(fields):
    """配置期体检：揪出**危险方向**的单边声明。

    ⚠️ **只服务「建模对象链」**（角色键：`read_roles` / `write_roles`）。
    **受管表链**不走这条：它的口径是**「继承表级 ＋ 必填」** ——
    列级 `read`/`write`/`download` **必填**（缺了**编译期就报错**），
    `filter` 可省（省了就跟随「读」）。
    ⇒ 这里看到的「漏写」在受管表链上是**编译期拒**，不是「默认开放」。

    **两个方向不等价，不能一刀切** —— 实测踩过：3820 上 `jiaoyan`（检验）是
    「人人可读、只有检验员可写」，那是**完全正当的设计**，一刀切会把好配置判死。
    我先前两个方向一起拦，就把这个正当字段判成了「拒绝启动」。

      · **只写 `read_roles`、漏 `write_roles`** → 🔴 **脚枪**
        只有财务看得见，却**人人可改**。这正是「漏写 = 人人可做」最伤人的那一面，
        也是 E 说的那条（漏 `write_roles` = 人人可改金额）。
      · **只写 `write_roles`、漏 `read_roles`** → ✅ **正常设计**
        人人看得见、只有特定角色可改。读维度默认开放，由 `open_by_default` 列出来
        （**看得见**即可，不当错）。

    所以这里只拦危险方向：要「可读不可改」必须显式写 `write_roles: []`，
    不能靠漏写碰巧成立。回人话清单，不是 true/false。
    """
    problems = []
    for field in fields or ():
        if "read_roles" in field and "write_roles" not in field:
            problems.append(
                "字段「%s」声明了 read_roles 却漏写 write_roles —— 未声明 = 不限制，"
                "这等于「只有指定角色看得见，却**人人可改**」。"
                "要「可读不可改」请显式写 write_roles: []" % field.get("id")
            )
    return problems


# ---------------- 行级读作用域强制（F12） ----------------

ROW_SCOPES = ("self", "all")


def enforced_row_scope(filters, scope, me, is_manager):
    """把「调用方自觉圈 actor_user」变成**服务端强制**（纯函数）。

    **为什么必须有**：审计表的读权限只给了 System Manager，而产品口径是
    「本人查得到本人的事实」，于是领域代码用 `frappe.get_all` **绕过行级 ACL**
    再自己圈范围。可那道边界原先只活在**注释里对调用方的口头约定**上
    （「调用方必须已经把 `actor_user` 圈进 filters」）—— 调用方忘一圈，
    整张审计表就漏出去。**注释不是强制。** 这里把它变成不圈也圈。

    `scope='self'` —— **强制** `actor_user = me`，**覆盖**调用方塞进来的任何值。
       （不是「有就用、没有就补」——那样调用方塞个别人照样漏。）
    `scope='all'` —— 只有管理员能用，非管理员**明确拒**；不塞 actor_user，就是全部。
    其它 scope —— **明确拒**，不静默当成 self（静默降级等于把「查全部」当「查自己」放过去）。
    """
    if scope not in ROW_SCOPES:
        raise ValueError("scope 只认 self / all，收到：%r" % (scope,))
    if scope == "all":
        if not is_manager:
            raise PermissionError("无权读取全部行（scope=all 只对管理员开放）")
        return dict(filters or {})
    out = dict(filters or {})
    out["actor_user"] = me  # 强制覆盖，不看调用方塞了什么
    return out


# ---------------- 「漏写 = 人人可做」的两道闸 ----------------
# 本模块沿用既有约定「未声明该维度 = 不限制」（read/write，见上）。可这条在权限路径上
# 是 **fail-open** —— 漏写 `write_roles` 就等于**人人可改**。所以：
#   ① 单边声明 = **硬闸拒启动**（`assert_well_declared`），不是打印一句提示
#   ② 「默认开放」的**看得见**：`open_by_default` 回一份可清点清单，
#      「人人可做」必须数得出来，不许藏在「没写」里

def assert_well_declared(fields):
    """配置期硬闸：**单边声明当场拒**（只写了 read 没写 write，或反过来）。

    拒的是「声明了一半」—— 那多半是想限制却漏写，一放过去就是 fail-open。
    两边都写、或一个都没写，不归这个闸管（零声明走 `open_by_default` 清单，看得见即可）。

    ⚠️ **只服务「建模对象链」**（角色键）。**受管表链**的硬闸在**编译期**
    （`model_schema.compile_object` → `subject_access.normalize_access`）：
    必填的 `read`/`write`/`download` **缺了就报错拒**，可选的
    `filter` 缺了就跟随「读」。
    """
    gaps = declare_gaps(fields)
    if gaps:
        raise ValueError("字段声明不完整，拒绝启动：%s" % "；".join(gaps))


def open_by_default(fields):
    """② 可清点的「默认开放」清单 —— 哪些字段的哪些维度是**人人可做**的。

    回**人话清单**（带字段名和维度），不是 true/false —— 这份要能对账、能贴给配置方看。
    两类会进清单：
      · **零声明**：三个维度全开放
      · **单边声明**：缺的那个维度开放（download 未声明时回落 read_roles，
        所以 read 有声明的话 download 不算开放）

    ⚠️ **只服务「建模对象链」**（角色键）。**受管表链**没有「默认开放」这档：
    列没声明 ⇒ **继承表级**；表级也没声明 ⇒ **拒**（fail-closed）。
    ⇒ 受管表链的「人人可做」得看**表级声明本身**是不是 `global`。
    """
    out = []
    for field in fields or ():
        fid = field.get("id")
        open_dims = []
        for need in ("read", "write"):
            if _RULE_OF[need] not in field:
                open_dims.append(_NEED_LABEL.get(need, need))
        # download 未声明时回落 read_roles —— 有 read_roles 就不算默认开放
        if "download_roles" not in field and "read_roles" not in field:
            open_dims.append("下载")
        if open_dims:
            out.append("字段「%s」的 %s 维度默认开放（未声明 = 不限制，人人可做）"
                       % (fid, "、".join(open_dims)))
    return out


# ---------------- 混版报错点名哪一侧旧（PKG-013-T05） ----------------
# 放本模块的理由同上：**脱离 frappe 可测**。它和字段级/行级不是一回事，
# 但都是内核的**纯判定规则**，共用同一个存放理由。（模块名叫 field_access 已经
# 略窄，改名成 core_rules 之类是候选清理项，本笔不夹带改名。）

def _semver_key(value):
    m = re.match(r"(\d+)\.(\d+)\.(\d+)", str(value or ""))
    return tuple(int(x) for x in m.groups()) if m else None


def version_conflict_note(action_id, stored, incoming):
    """混版报错的**报因**：不许只说「版本不同」，要点名**哪一侧旧、旧在哪**。

    为什么必须有：先前的报因是「动作或动作版本不同，不是同一次请求」「动作资源重复且
    定义不一致，禁止隐式覆盖」—— 读的人只能两头翻账猜谁旧。今天两次踩的
    `files.import_attachment`/`files.action_fact` 就是这个样子。

    两种情形**不许混为一谈**：
      · **版本号不同** —— 能判谁旧，就点名谁旧 + 两侧版本号
      · **版本号相同、定义不同** —— **判不出谁旧**（同号无法排序），这时不许硬说某侧旧，
        要说清是「**改了定义却没升版本号**」，并把解法讲明（升版本号）
    """
    a, b = _semver_key(stored), _semver_key(incoming)
    if a is not None and b is not None and a != b:
        stored_older = a < b
        older, newer = (stored, incoming) if stored_older else (incoming, stored)
        who_old = "库里已注册的那份" if stored_older else "这次调用带来的那份"
        who_new = "这次调用带来的那份" if stored_older else "库里已注册的那份"
        return ("动作 %s 版本不一致：%s %s 比 %s %s **旧** —— "
                "请确认是该升库里的（重新登记 %s），还是调用方该改用 %s"
                % (action_id, who_old, older, who_new, newer, newer, newer))
    return ("动作 %s 定义不一致但版本号相同（%s）—— **同号判不出谁旧**，"
            "但「改了定义却没升版本号」是确定的。请把版本号升一位再登记，"
            "别用同一个 %s 覆盖旧定义（那是隐式覆盖，闸不会放）。"
            % (action_id, stored, stored))


# ---- 提案改值（edited_value）的形状判定 ----
# 放本模块的理由同上：**脱离 frappe 可测**。它是内核的纯判定规则，跟字段级/行级/混版
# 报因不是一回事，但共用同一个存放理由。（模块名已略窄，改名 core_rules 是候选清理项。）

def _is_typed_value(obj):
    return isinstance(obj, dict) and "type" in obj


def patch_edited_value(raw, edited_value):
    """把批准时的改进建议值并进提案载荷，回**新的**载荷（不改入参）。

    **两种形状，按 `edited_value` 自己的形状判，不猜**：

    ① **单值改写** `{"type": …, "value": …}` —— 载荷有 `value` 键就换它；
       没有但 `cells` 恰好一条就换 `cells[0].value`；**多格明确拒**（不猜要改哪一格）。
    ② **多字段按名改写** `{字段名: {"type": …, "value": …}, …}` ——
       按字段名逐个换载荷里同名的键。**字段名不在载荷里明确拒**，点名是哪个字段。

    **为什么要扩 ②**：`mail.save_draft` 的载荷是多字段对象（`subject`/`body`/`to`/`cc`…），
    邮件审核人要把主题和正文**分别**改成不同内容时没有口，逼得调用方自己拼载荷 ——
    那就绕回「领域直写内核表」的老路。按名替换不涉及猜：**字段名是调用方点名的**。

    **不猜的边界一条不松**：
      · 多格 `cells` 仍明确拒 —— 按名替换**不解除**「不猜哪一格」
      · 混形状（既有 `type`/`value` 又夹字段映射）明确拒 —— 判不出是单值还是映射，不猜
      · 空 / 非 dict / 值不是带 `type` 的对象，一律明确拒（不静默忽略、不 500）

    **已知用不了的形状**：载荷里若真有叫 `type` 的字段，多字段形状会被当成单值 ——
    走不通会明确拒（找不到 `value`/单格 `cells` 就报「不是单值改写」），不会改错东西。
    """
    if not isinstance(edited_value, dict) or not edited_value:
        raise ValueError("edited_value 须是带 type 的值对象")

    if "type" in edited_value:
        # ① 单值改写（现状一字不改）
        # 混形状自检：除 type/value 外还有键、且那个键的值是「带 type 的对象」——
        # 那可能是想按字段名改，判不出来，不猜。
        mixed = [k for k, v in edited_value.items()
                 if k not in ("type", "value") and _is_typed_value(v)]
        if mixed:
            raise ValueError(
                "edited_value 形状混了：既有 type/value 又有按字段名的改值 %s —— "
                "判不出是改单值还是改字段，不猜。请要么只传 {type, value}，"
                "要么只传 {字段名: {type, value}}" % (mixed,))
        if not _is_typed_value(edited_value):
            raise ValueError("edited_value 须是带 type 的值对象")
        out = dict(raw)
        if "value" in out:
            out["value"] = edited_value
        elif isinstance(out.get("cells"), list) and len(out["cells"]) == 1:
            cells = [dict(out["cells"][0])]
            cells[0]["value"] = edited_value
            out["cells"] = cells
        else:
            raise ValueError("该提案不是单值改写，无法用 edited_value 编辑")
        return out

    # ② 多字段按名改写
    for name, v in edited_value.items():
        if not _is_typed_value(v):
            raise ValueError("字段「%s」的改值须是带 type 的值对象，收到：%r" % (name, v))
        if name not in raw:
            raise ValueError("提案载荷里没有字段「%s」，不猜要改哪里" % (name,))
    out = dict(raw)
    for name, v in edited_value.items():
        out[name] = v
    return out


# ---- 归属映射：owner_subject_* → attribution 三元组 ----
# 放本模块的理由同上：**脱离 frappe 可测**。它是纯翻译，不碰运行时、不查库、**不缓存**。

# 文件/邮件域的「所有人类型」→ 内核归属层级。**只有这两条，没有第三条**。
_OWNER_KIND_MAP = {
    "Employee": "personal",
    "Department": "department",
}


def map_owner_subject(owner_subject_kind, owner_subject):
    """把文件/邮件域的「所有人」翻译成内核归属三元组 ``(level, department, owner_user)``。

    **公共一份**：文件域（`shangshu_files` 的 `mail_system.owner_subject_*`）和邮件域
    （`shangshu_mail`）都要做这个翻译。各写一份 = 各说各的「Employee 算什么」，早晚分叉。

    **判定口径是用户已定的，不是猜的**（契约 §3.5）：

      · `账号与权限.md` §3 第 **7** 条（2026-10-10）—— 老板=全企业、负责人=所辖及以下、
        **个人级不向管理者保密**。所以 ``Employee``→``personal``、``Department``→``department``
        是**落实已定口径**，不是放宽。
      · 同文件 ``:192`` 第 **5** 条（2026-10-13）—— 「**历史不明归属保持既有权限并待核，
        不批量填企业归属**」。所以本函数**绝不返回 ``enterprise``**：文件域那套里
        enterprise **没有来源**（enum 只有 Employee/Department），映射不许凭空造一个。

    **边界**：
      · 只管「字段怎么对应」，**不管谁能看** —— 判定权在 ``default_read_allows`` 那侧。
        撤权/调岗判「**当前**权限」（`账号与权限.md:40/:137/:154`），不判入库时归属；
        本函数**不缓存、不记快照**，谁加缓存谁就把撤权弄没了（同 ``field_allows_roles``）。
      · 类型/ID 不合法**明确拒**，不猜、不兜底、不发明第三种归属。
      · ID **原样保留**（不改大小写、不猜格式）—— 要跟权威表对得上，改了就串人。
    """
    kind = str(owner_subject_kind or "").strip()
    subject = str(owner_subject or "").strip()
    if kind not in _OWNER_KIND_MAP:
        raise ValueError(
            "所有人类型无效：%r —— 只认 Employee（→personal）/ Department（→department）。"
            "**尚书是单例，没有企业归属**（用户 2026-10-15 原话）——"
            "所以没有 enterprise 这条路，永不产生；"
            "不明归属请保持既有权限并待核（用户 2026-10-13，账号与权限.md:192）。" % (owner_subject_kind,))
    if not subject:
        raise ValueError("所有人不能为空（%s 必须带归属对象 ID）" % kind)
    level = _OWNER_KIND_MAP[kind]
    if level == "personal":
        return level, None, subject
    return level, subject, None


_ATTRIBUTION_LEVELS = ("personal", "department")


def attribution_level(level=None, department=None, owner_user=None):
    """把归属层级收成内核三元组用的那个 ``level``。**只认 ``personal`` / ``department``。**

    **用户 2026-10-15 原话**：「**尚书是单例，没有企业归属。**」
    不是「(a)/(c) 选哪条」，是**那个桶压根不该存在** —— 所以 ``enterprise`` **永不产生**：
    不许显式传，**更不许在没给 level 时自作主张落一个**。

    **改之前**（``org_admin.py:255-257`` 的兜底）::

        level = "department" if department else ("personal" if owner_user else "enterprise")

    最后那个 ``else "enterprise"`` **就是「落一个默认 enterprise」** —— 用户明令禁止的那条。
    3820 库里那些 ``department``/``owner_user`` 全 NULL 的行形状对得上，是它造的，
    不是谁故意传的。**关 doctype 选项挡不住它**：那只是挡「显式传」，挡不住「什么都不传被兜底」。

    **未给 level 时的推断保留两条**（别整条删掉）：

      · ``department`` 在场 → ``department``
      · ``owner_user`` 在场 → ``personal``

    前置查过：``test_b1_org.py:123``/``:163`` **不传 level、只给 department**，
    依赖的就是上面第一条。**``else "enterprise"`` 那条没有任何东西依赖** —— 所以只删 else。
    **整条删掉会弄坏 test_b1_org.py**，那正是「动 0 之前先查谁在依赖」要查的东西。

    **两者皆无 → 明确拒**，不猜、不兜底、不发明第三种归属。
    纯翻译（不碰 frappe、不查库、不缓存），同 ``map_owner_subject`` 的路子。
    """
    raw = str(level or "").strip()
    if raw:
        if raw not in _ATTRIBUTION_LEVELS:
            raise ValueError(
                "归属层级无效：%r —— 只认 %s。"
                "**尚书是单例，没有企业归属**（用户 2026-10-15 原话），"
                "所以 enterprise 永不产生：不许显式传、也不许没给 level 时兜底成它。"
                % (level, " / ".join(_ATTRIBUTION_LEVELS)))
        return raw
    # 没给 level：前两条推断留着（有测试依赖，见上）；第三条不许兜底
    dept = str(department or "").strip()
    if dept:
        return "department"
    owner = str(owner_user or "").strip()
    if owner:
        return "personal"
    raise ValueError(
        "请指定归属层级 level（personal / department）。"
        "既没给 level、也没给 department 或 owner_user —— **不猜、不兜底成 enterprise**："
        "尚书是单例，没有企业归属（用户 2026-10-15 原话）。")


# ---- ③ 内容就绪闸（D 契约 §17，内核半）----
# 裸 URL 绕过文件域那道闸的兜底（D 当场坐实 RT-④③ ⑧：待恢复时拿先前记下的 ref
# 直打 `file-content` → HTTP 200 旧字节）。`file_content` 是**通用口**（任何
# doctype 的附件都走它），它不知道「文件中心的表有没有待恢复的回填」—— **该问领域**，
# 不该把文件域的判断塞进内核。所以留**可注册钩子**。
#
# **为什么是钩子而不是写死**：别的域将来也会有「内容没就绪」（附件归档中 / 转码中）。
# 写死 = 下次再改内核。`shangshu_files` 注册一个查 `promotion.writeback_pending`，
# 非空就 throw；将来邮件附件等同族。
#
# **口径已拍（E 2026-10-15）**：**旧版本照旧能下，闸只挡「最新那份」**。
# 「不导出旧文件」是**别把旧的当最新给**，不是「一律不给旧的」—— 待恢复的问题是
# 「最新那份不一致」（DB 有新值、Excel 没跟上）。旧版本是明确历史，用户主动要旧的，
# 给了不算骗。附：下载时版本号标清楚；被拒时拒因说「N 处待恢复」（状态问题不是权限）。
#
# **两道闸都留**（D 钉的）：内核兜底 + 文件域早拒，**不许本闸落地后删文件域那道**。
# 纵深：域内早拒、内核兜底，删一道就漏一个口。
#
# **纯机制，不碰 frappe 查询** —— 钩子自己决定拒不拒（查库是领域的事）。
# 判据 `test_field_access.py` CG-01～06（纯）+ D 的 RT-4-3-K ①～⑤（集成）。

_CONTENT_GATES = {}


def register_content_gate(doctype, fn):
    """给某 doctype 注册「内容就绪」闸。fn(doctype, name, file) → 三种结果：

    1. **返回 None**（或什么都不返）—— 放行，不标注
    2. **返回 dict**（如 `{"version_label": "v3"}`）—— 放行，`file_content` 把标注
       附在下载文件名上（「下载时版本号标清楚」，D 契约 §17.4 附条）
    3. **raise** —— 拒（拒因说人话，别抛错误码）

    **同 doctype 后注册覆盖前一个**（简单可预期）。
    注册方自己负责判定逻辑；内核只派发。谁注册谁负责拒因文案对用户说得懂。
    """
    if not callable(fn):
        raise ValueError('content gate 须是可调用的 fn(doctype, name, file)')
    _CONTENT_GATES[doctype] = fn


def check_content_ready(doctype, name, file):
    """`file_content` 里调：有钩子就问它，钩子抛就抛（拒因原样传出，不吞不转错误码）。

    **返回值**：钩子返回的 dict（含 `version_label` 等标注）或 None。
    `file_content` 拿到 `version_label` 就附在下载文件名上（D 契约 §17.4 附条）。

    **无钩子默认过** —— 没人注册就是「没这回事」，不是「没钩子就拒」。
    这跟**建模对象链** `field_allows_roles` 的「未声明 download 即拒」**故意不同**：
    那边是权限（fail-closed），这边是内容就绪（没钩子 = 该域没这概念 = 放行）。
    （**受管表链**那条 download 闸在 `public_api/http.py` 的 `_field_acl_gate`，
    按**主体范围**判，不走本模块。）
    """
    gate = _CONTENT_GATES.get(doctype)
    if gate is None:
        return None
    return gate(doctype, name, file)
