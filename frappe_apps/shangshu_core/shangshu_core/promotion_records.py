"""晋升接入受管记录：把工作簿的固定行映射成受管对象记录（公共内核能力）。

**不另起第二套记录引擎**：对象定义与物理表走既有 `model_changes`
（准备 → 迁移 → 生效指针），记录读写走既有 `model_records`
（字段权限、记录版本、业务校验、审计）。本模块只做**晋升侧的编排**，
并保证三件事：**对象不重复建、字段不重复建、记录不重复建**。

**DDL 边界**：受管对象的物理表由 `execute_object_change` 建立 —— 那是 DDL
（MariaDB 会隐式提交），混在动作事务里会毁掉回滚点。**这里一次 commit 都不许有**
（域围栏的规矩：锁由外层请求/任务事务释放，不在退出时提交）⇒ DDL 走内核的
**独立迁移**口（`shangshu_core.independent_migration.run_independent_migration`）：
它在**受控窗口**里提交并跑 DDL，**并在提交后重建动作的 savepoint**
（DDL 的隐式提交会销毁它 ⇒ 不重建的话失败路径回滚会炸、动作卡在 Running）。
失败后**按同一幂等键重来**：变更计划本身可续作（`Planned`/`Failed` 都能再执行），
记录写入走公共动作的幂等键，重试不会建出第二份对象/字段/记录。这与契约
「DDL/模型发布与数据回填不能假装是一个可回滚事务」一致。

⚠️ **2026-10-25 用户拍板的口径**：**新建业务表走这一条路**（表文件 → **每一列**都晋升 →
受管对象 ＋ 受管记录 → 动作从内核重新注册），**不建自己的 DocType**；
**域自建的 DocType 表逐域重走一遍晋升**（存量重走期间内核不拦，
但域的新声明里**不许再出现**自建表）。完整口径见 `shangshu_core.data_ownership`。
为什么：受管记录在**内核**里（受字段 ACL 管、受版本闸管、审计进统一日志库、跨域可读可写）
⇒ 域拆了以后数据**还能被接手**；自建的 DocType 是**域的私产** ⇒ 域拆了就成了孤儿数据。

**谁来调**：文件域（`shangshu_files`）的晋升入口。域目录里做不到这件事 ——
受管模型、物理表、记录版本与审计都在内核，域里自己写一份就是第二套记录引擎。
"""

import frappe

from shangshu_core import subject_access
from shangshu_core.design_support import require_designer

# 晋升列类型 → 受管字段类型。只映射标量：明细/关联在晋升这一步没有语义。
TYPE_MAP = {
    "text": "text",
    # ⚠️ **长文本**（2026-10-25 客户真数据撞出来的）：「短文本」那一档的物理列容量是
    # **140**（Frappe Data）⇒ 客户示例企业总表的「联系人信息」有 63 处超 140 字符（最长 580）
    # ⇒ 那是**真业务内容**、不是脏数据 ⇒ 清掉＝丢真信息 ⇒ 短文本这一档装不下。
    # ⇒ 这里放行 `long_text`：内核的受管模型**本来就有**这一档
    # （`model_schema.TYPES["long_text"] = "Long Text"`、`field_schema` 给它
    # `multiline: True` 且**不设 maxLength**）—— 只是这张映射表以前没认它。
    "long_text": "long_text",
    "number": "decimal",
    "date": "date",
    "boolean": "boolean",
}

# 受管字段 ID 的合法形状（`model_schema.compile_object` 的同一口径）。
# 这里先拒一遍，是为了让拒因说清是**晋升列的字段名**不合法，
# 而不是让域里收到一句没头没尾的「字段 ID 格式错误」。
import re

FIELD_ID = re.compile(r"[a-z][a-z0-9_]{0,47}")

RESERVED_FIELD_IDS = {"name", "modified"}

DEFAULT_ROLES = ["Desk User"]


def _fail(message):
    frappe.throw(message, frappe.ValidationError)


def change_key_for(application_id, identity_id, idempotency_key, compiled):
    """**模型变更的键**（纯函数，2026-10-30 · PKG-133 · W2）。

    ⚠️ **为什么键要带上「编译后模型」的指纹**（站上实测撞出来的）：
    原来的键是 `content_hash([应用, 身份, "promotion-extend:" + 入参键])`
    ⇒ **只带声明指纹**（入参那个 `promotion-access:{表}:{声明指纹前16位}`）
    ⇒ 而「这次要不要另起一次模型变更」判的是**编译后**的模型
    （`_unchanged_promotion_definition`：编译结果与已生效的模型不一样 ⇒ 要变更）
    ⇒ **内核改一行编译器行为**（比如「从现在起必填」的字段物理列不再标 `reqd`）
    ⇒ 声明**一个字没动** ⇒ 声明指纹**没变** ⇒ 键**没变**
    ⇒ 撞上**上一次**那条变更 ⇒ 内核判「这把键配了不同内容」⇒ 拒
    （人看到的话是「幂等键已用于不同对象变更」——**说的是键，说的是变更，人完全看不懂**）
    ⇒ **后果：内核改一行编译器行为 ⇒ 那张表再也晋升不上去**。
    ⇒ 现在键里**带上编译后模型的指纹**：
    · 模型规格**没变** ⇒ 键不变 ⇒ **幂等照旧成立**（同一件事重试仍是同一把键）；
    · 模型规格**变了** ⇒ 键变 ⇒ 那是**另一件事** ⇒ 另起一次变更、另跑一次迁移
    ⇒ 人看到的会是「这次变更已经生效」，而不是一句看不懂的键冲突。

    ⚠️ **为什么用模型指纹而不是声明指纹**：声明指纹在**入参**里（文件域算），
    它**看不见编译器行为**；模型指纹是**编译器自己产的**（`compile_object` 的结果）
    ⇒ 编译器怎么变，它就怎么变 ⇒ 天然对齐。
    """
    from shangshu_core.design_support import content_hash
    return content_hash([str(application_id), str(identity_id),
                         "promotion-extend:" + str(idempotency_key),
                         content_hash(compiled)])


def field_type(promotion_type):
    """晋升列类型 → 受管字段类型。**不认的类型当场拒**，不静默按文字存。"""
    kind = TYPE_MAP.get(str(promotion_type or "").strip())
    if not kind:
        _fail("晋升列类型不受支持：%r（允许 %s）"
              % (promotion_type, "/".join(sorted(TYPE_MAP))))
    return kind


def _constraints(col, kind):
    """晋升规则 → 受管字段约束。**不支持的组合当场拒**，不静默丢掉规则。"""
    rules = col.get("rules") or {}
    if not isinstance(rules, dict):
        _fail("晋升列 %s 的规则必须是对象" % col.get("header"))
    result = {}
    if rules.get("min") is not None or rules.get("max") is not None:
        if kind not in ("decimal", "integer"):
            _fail("晋升列 %s 的数值上下限不适用于该类型" % col.get("header"))
        if rules.get("min") is not None:
            result["minimum"] = rules["min"]
        if rules.get("max") is not None:
            result["maximum"] = rules["max"]
    return result


def _value_domain(col):
    """列的**值域清单** → 受管字段的 `value_domain`（**没有就返回 None**）。

    ⚠️ **清单挂在 `rules` 里**（`options` ＋ `allow_custom`；域里
    `case_value_domains.py` 写进来）⇒ **不新建一套机制**，顺着这条现成的路走。

    · `options` —— 标准项清单（**没写就没有清单**，不猜、不编）；
    · `allow_custom` —— **没写 = 不拦**（清单只当提示：下拉提供其他，
      人工填写原文保存 —— 旧项目那条口径）；**显式写 `false` = 硬拦**。

    ⚠️ **清单原样带进内核**（不 trim、不改写）—— 清单是**声明**，
    内核只按它判「这个值在不在清单里」。
    """
    rules = col.get("rules") or {}
    if "options" not in rules:
        return None                      # **没声明清单** ⇒ 这一列没有值域规则
    options = rules.get("options")
    if not isinstance(options, list) or not options:
        # ⚠️ **声明了却不是清单** ⇒ **当场拒**（不静默当成「没有清单」）
        #   ——「静默丢掉规则」正是这条链最忌讳的那件事。
        _fail("晋升列「%s」的值域清单必须是非空的列表" % (col.get("header") or col.get("field")))
    allow = rules.get("allow_custom")
    candidate = {"options": [str(item) for item in options],
                 "allow_custom": True if allow is None else bool(allow)}
    # ⚠️ **形状校验交给内核那一份**（`model_schema._value_domain`）⇒
    #   **校验只维护一处**（域侧不另写一套 ⇒ 不会漂）。
    from shangshu_core.model_schema import _value_domain as _kernel_value_domain
    try:
        return _kernel_value_domain({"value_domain": candidate},
                                    str(col.get("header") or "").strip() or col.get("field") or "")
    except ValueError as error:
        _fail(str(error))


def build_definition(title, columns, access=None):
    """从晋升列定义拼受管对象定义（**纯函数**，不碰库）。

    **受管表这条链只走「主体范围」新模型**（PKG-117-T01；
    契约 `账号与权限.md` 2026-10-25 22:4x「**不留兼容函数**」）：

      · **列**的主体范围声明（`access`：三个操作 × 全局/部门/个人）**原样带进**受管字段
        —— 晋升不扩大任何人的权限，列上声明的限制要跟着字段走；
      · 列若还带着**旧三键**（`read_roles`/`write_roles`/`download_roles`）⇒ **明确拒**
        —— 角色键是**建模对象链**（用户用建模器建的普通对象）的写法，
        受管表这条链**不认**，也**不留兼容写法**；
      · **表级 `access` 必填**（表级主体范围是**独立声明**的）。

    ⚠️ **为什么表级不再由各列并集推导**（原来那条路叫 `_access_from_columns`，**已删**）：
    并集联动让「改一列」连带把整张表的表级收窄 —— 改一个字段的声明，
    别人对**整张表**的访问也跟着变。契约把它改成
    「**表级独立声明**；列默认继承它」⇒ 并集联动取消。
    ⇒ 表级 `access` 由**调用方（域）显式传进来**，内核**不替它猜**。
    """
    if not access:
        _fail("受管表必须声明表级主体范围（access）：读/写/下载必填，筛与助手可省；"
              "表级是独立声明的，不许由各列并集推导")
    try:
        subject_access.normalize_access(access, where="表级权限声明",
                                       required=subject_access.REQUIRED_OPS,
                                       extra_keys=("record_scope",))
    except ValueError as error:
        _fail(str(error))
    fields = []
    for col in columns or []:
        if not isinstance(col, dict) or not col.get("promoted"):
            continue
        header = str(col.get("header") or "").strip()
        fid = str(col.get("field") or "").strip()
        if not header or not fid:
            _fail("晋升列必须有表头和字段名")
        if not FIELD_ID.fullmatch(fid) or fid in RESERVED_FIELD_IDS:
            _fail("晋升列 %s 的字段名 %r 不合法（须为小写字母开头的字母数字下划线，且不能叫 name/modified）"
                  % (header, fid))
        role_keys = [key for key in subject_access.ROLE_KEYS if key in col]
        if role_keys:
            _fail("晋升列 %s 还在用角色键（%s）—— 受管表这条链只走「主体范围」"
                  "（三个操作 × 全局/部门/个人），不留兼容写法"
                  % (header, "、".join(role_keys)))
        kind = field_type(col.get("type"))
        rules = col.get("rules") or {}
        # ---- **「必填」分两档**（2026-10-30 · PKG-133 · W2）----
        #   默认：必填＝**存量也要补**（把一个已有字段改成必填时，空着的旧记录会被内核的
        #         「现有记录缺少必填值，请先补齐后重试」当场挡下）。
        #   声明 `rules.required_backfill = false` ⇒ **从现在起必填**：
        #         · 模型字段**照样** required ⇒ harness-values 那三项约束里的「能不能留空」是准的；
        #           空着的存量字段**不挡**这一行的别的格子（整条记录校验时跳过空值）；
        #         · **不要求把存量补齐** ⇒ 由内核的回填闸看这个键放行；
        #         · **写空不拒**（2026-10-30 用户口径：必填是**提醒**不是拦路 ——
        #           「不强制不能保存（因为我一行要一个格子一个格子输入）」，
        #           空着的格子由前端**框红＋toast 提醒**）⇒ 拒空的是**字段级**那道闸
        #           （写那一格时），不是文件域的规则闸。
        required = bool(rules.get("required"))
        field = {"id": fid, "label": header, "type": kind, "required": required}
        if rules.get("required_backfill") is False:
            field["required_backfill"] = False
        constraints = _constraints(col, kind)
        if constraints:
            field["constraints"] = constraints
        # ---- **值域清单跟着定义进内核**（原收敛条目 02 · 2026-10-26）----
        #   以前清单**只存在文件域的声明里**（`rules.options` ＋ `rules.allow_custom`）
        #   ⇒ 编译成受管对象定义时**被丢掉** ⇒ 对象侧的写入口不知道这一列有清单
        #   ⇒ 清单外的值能从 `platform.object.create`／`update` 那条路写进去
        #   ⇒ 「非法枚举在所有写入口均拒绝」不成立。
        #   ⇒ 现在清单进定义 ⇒ 所有写入口按**同一份**清单判。
        value_domain = _value_domain(col)
        if value_domain:
            field["value_domain"] = value_domain
        if "access" in col:
            try:
                field["access"] = subject_access.normalize_access(
                    col["access"], where="晋升列 %s 的权限声明" % header,
                    required=subject_access.REQUIRED_OPS)
            except ValueError as error:
                _fail(str(error))
        # ⚠️ **列没声明 `access`** ⇒ 不在这里拒，**继承表级**（契约 §三 第 2／3 条：
        # 「列没有声明 ⇒ 继承整张表的权限」）。这是**模型规则**。
        # 「**新晋升必填**」（契约 §三 第 1 条）那道闸在**域的入口闸**
        # （文件域 `shangshu_files/access_scope.py`）—— 各归各家：
        # 内核负责「声明了但形状不合法 ⇒ 拒」与「旧三键 ⇒ 拒」，
        # **不在内核重复造一道入口闸**（也不因内核这道闸挡住存量列的续晋升）。
        fields.append(field)
    if not fields:
        _fail("没有可晋升的列")
    return {"schema_version": 1, "title": str(title or "").strip() or "晋升表",
            "kind": "record", "fields": fields, "access": access}


def _application(table, title, idempotency_key):
    """晋升对象的归属应用。**同一张表复用同一个应用**（幂等键按表固定）。"""
    from shangshu_core.applications import create_application_definition
    require_designer()
    app = create_application_definition(str(title or "").strip() or ("晋升表 " + str(table)),
                                        "promotion-app:" + str(table))
    return app["id"]


def _publish(application_id, object_id, revision, title):
    """把受管对象挂进应用并发布 —— 员工才读得到、用得上这个对象。

    对象版本变了（后续加字段）要**重新发布一次**，绑定版本才一致 ——
    这就是「绑定升级」，不许拿旧版本绑定糊弄。
    """
    from shangshu_core.applications import (save_application_draft, publish_application_definition,
                                            get_application_definition)
    current = get_application_definition(application_id)
    spec = {"schema_version": 1, "title": str(title or "").strip() or "晋升表",
            "description": "晋升工作簿的受管对象", "allowed_roles": list(DEFAULT_ROLES),
            "bindings": [{"kind": "datasets", "resource_id": object_id,
                          "owner_domain": application_id, "version": str(revision)}]}
    saved = save_application_draft(application_id, spec, current["draft_revision"])
    publish_application_definition(application_id, saved["draft_revision"])
    return saved


def _row_key(prefix, idempotency_key, row_id, life):
    """行级幂等键：**带「第几世」**。

    **为什么必须带世**（2026-10-25 站上实测撞出来的第三个内核缺口）：
    同一张表**退役过一次再晋升**时，行键若不变 ⇒ 动作通道把它当**同一笔旧请求**
    ⇒ 直接**重放上一世的旧结果**（**不建行**）⇒ 新表是**空的**，而代码说「成功」
    ⇒ **静默丢数据**（最难查的一种）。

    ⇒ **不同世用不同的键**（各世各建各的）；**同一世内重试仍是同一把键**（幂等成立）。
    **第一世保持原样**（老键不许变 ⇒ 已有的表不受影响）。
    """
    if life <= 1:
        return "%s:%s:%s" % (prefix, idempotency_key, row_id)
    return "%s:%s:%s:life%d" % (prefix, idempotency_key, row_id, life)


def _seed(object_id, revision, rows, idempotency_key):
    """为范围内每一行建一条受管记录。**幂等键按行固定** ⇒ 重试不重复建。"""
    from shangshu_core.actions import execute_registered_action
    from shangshu_core.model_lifecycle import object_life
    records = {}
    life = object_life(object_id)
    for row in rows or []:
        row_id = str(row.get("row_id") or "")
        if not row_id:
            _fail("记录行身份缺失")
        key = _row_key("promotion-row", idempotency_key, row_id, life)
        created = execute_registered_action(
            "platform.object.create",
            {"object_id": object_id, "expected_revision": revision,
             "values": dict(row.get("values") or {})},
            confirmed=True, idempotency_key=key, source="user")
        records[row_id] = created["result"]["name"]
    return records


def _set_values(object_id, revision, name, values, idempotency_key):
    """给**已有**记录加值（后续晋升）。幂等键按记录固定 ⇒ 重试不重复写。"""
    from shangshu_core.actions import execute_registered_action
    from shangshu_core.model_lifecycle import object_life
    from shangshu_core.model_records import MODEL
    model = frappe.get_doc(MODEL, object_id)
    modified = frappe.db.get_value(model.physical_doctype, name, "modified")
    execute_registered_action(
        "platform.object.update",
        {"object_id": object_id, "name": name, "expected_revision": revision,
         "expected_modified": str(modified), "values": dict(values or {})},
        confirmed=True, idempotency_key=idempotency_key, source="user")


def create_promoted_records(*, object_id, rows, idempotency_key):
    """已有对象新增工作簿行：不做 DDL，沿用正式创建动作的权限、完整规则、唯一键与审计。

    文件域须先核实固定行及显式新增来源。相同操作按对象生命周期和行身份幂等；
    本口不补默认值，也不放宽必填约束，未达到当前创建规则的候选照常拒绝。
    """
    from shangshu_core.model_records import MODEL
    if not idempotency_key or not isinstance(rows, list) or not rows:
        _fail("新增受管记录需要明确行和值以及幂等键")
    model = frappe.get_doc(MODEL, object_id)
    records = _seed(object_id, model.active_revision, rows, idempotency_key)
    return {"object_id": object_id, "revision": model.active_revision, "records": records}


def provision_promoted_records(*, table, title, columns, rows, idempotency_key, application_id=None,
                               access=None):
    """**首次晋升**：建受管对象 + 为范围内每行建一条受管记录。

    返回 `{object_id, revision, records}` —— `records` 是「工作簿固定行 ID →
    受管记录 ID」的映射，后续晋升与旧 JSON 迁移都靠它接续。

    `access` 是**表级主体范围声明**（`{read: {...}, write: {...}, download: {...},
    filter: {...}, record_scope: ...}`）—— **必填**。

    ⚠️ **不再有「不传就按各列并集推导」那条路**（契约 2026-10-25 22:4x）：
    表级是**独立声明**的，列默认继承它 ⇒ 域里**必须**显式传进来。
    """
    from shangshu_core.model_changes import prepare_object_change
    from shangshu_core.independent_migration import run_independent_migration
    if not access:
        _fail("晋升必须声明表级主体范围（access）：读/写/下载必填，筛与助手可省")
    application_id = application_id or _application(table, title, idempotency_key)
    definition = build_definition(title, columns, access=access)
    change = prepare_object_change(application_id, definition, "promotion-object:" + str(table))
    # ⚠️ **这里不能自己提交**（围栏里不许自行提交）——
    #    DDL 走内核的「独立迁移」口：它在受控窗口里提交并跑 DDL，
    #    **并在提交后重建动作的 savepoint**（DDL 的隐式提交会销毁它）。
    applied = run_independent_migration(change["id"], confirmed=True)
    object_id = change["object_id"]
    revision = applied["target_revision"]
    records = _seed(object_id, revision, rows, idempotency_key)
    # ⚠️ **这里也不提交**：记录写入与应用发布跟这条动作在**同一个事务**里，
    #    由最外层请求边界统一提交（围栏的规矩：锁由外层释放）。
    _publish(application_id, object_id, revision, title)
    return {"object_id": object_id, "revision": revision, "records": records,
            "application_id": application_id}


def _unchanged_promotion_definition(model, application_id, definition, idempotency_key):
    """已生效且完全同义的声明不建空迁移；锁和准入仍按模型变更边界核验。"""
    import json
    from shangshu_core.design_support import require_application, lock_lifecycle, content_hash
    from shangshu_core.model_schema import compile_object, ModelError
    from shangshu_core.model_changes import CHANGE
    from shangshu_core.model_records import MODEL
    from shangshu_core.model_lifecycle import object_life

    identity = require_designer()
    app = require_application(application_id, identity)
    key = "promotion-extend:" + str(idempotency_key)
    if len(key) > 200:
        _fail("对象变更需要有效幂等键")
    lock_lifecycle()
    # 无 DDL 的分支不会释放锁；仍按记录写入口的 app → model 次序，避免反向锁序。
    app = require_application(application_id, identity, lock=True)
    current = frappe.get_doc(MODEL, model.name, for_update=True)
    if current.application != application_id or current.enterprise_id != identity.enterprise_id:
        frappe.throw("对象不属于当前应用", frappe.PermissionError)
    if current.revision != model.revision:
        frappe.throw("对象草稿已变化，请刷新后重试", frappe.TimestampMismatchError)
    try:
        # 晋升定义只映射标量，因此无需装配本应用其他对象或明细定义。
        compiled = compile_object(application_id, current.name, definition)
    except ModelError as error:
        _fail(str(error))
    if not current.active_revision or json.loads(current.active_json) != compiled:
        return None
    # 未完成迁移必须继续原计划，不能因生效指针相同就标成 no-op。
    if frappe.db.get_value(CHANGE, {"object_model": current.name,
            "status": ["in", ["Planned", "Running", "Failed"]]}, "name", for_update=True):
        return None
    change_key = change_key_for(application_id, identity.identity_id, idempotency_key, compiled)
    life = object_life(current.name)
    if life > 1:
        change_key = content_hash([change_key, "life", life])
    if frappe.db.get_value(CHANGE, change_key, "name", for_update=True):
        previous = frappe.get_doc(CHANGE, change_key, for_update=True)
        if previous.object_model != current.name or json.loads(previous.compiled_json) != compiled:
            frappe.throw("幂等键已用于不同对象变更", frappe.DuplicateEntryError)
    published = (json.loads(frappe.get_doc("Shangshu Application Revision",
                    app.published_revision).definition_json)
                 if app.status == "Published" and app.published_revision else {})
    bound = any(binding.get("resource_id") == current.name and
                str(binding.get("version")) == str(current.active_revision)
                for binding in published.get("bindings", []))
    return {"revision": current.active_revision, "publish_required": not bound}


def extend_promoted_records(*, object_id, application_id, title, columns, rows, records, idempotency_key,
                            access=None):
    """**后续晋升**：同一个对象加字段、同一条记录加值。

    **对象 ID 与记录 ID 都不变** —— 这是契约明写的：
    「为同一对象增加字段，把新选列的值迁入原来映射的记录；不再造一份对象、
    案件总表或重复记录。」

    `access` 的口径与 `provision_promoted_records` 一致：**表级主体范围声明，必填**
    （不再有「不传就按各列并集推导」那条路 —— 契约 2026-10-25 22:4x 取消并集联动）。
    ⚠️ 首次与后续要传**同一份** —— 表级权限变了就是另一次定义变更，
    绑定版本也会跟着动。
    """
    from shangshu_core.model_changes import prepare_object_change
    from shangshu_core.independent_migration import run_independent_migration
    from shangshu_core.model_records import MODEL
    from shangshu_core.model_lifecycle import object_life
    if not access:
        _fail("晋升必须声明表级主体范围（access）：读/写/下载必填，筛与助手可省")
    model = frappe.get_doc(MODEL, object_id)
    definition = build_definition(title, columns, access=access)
    unchanged = _unchanged_promotion_definition(model, application_id, definition, idempotency_key)
    if unchanged is not None:
        revision = unchanged["revision"]
    else:
        # ⚠️ **键要带上编译后模型的指纹**（2026-10-30 · PKG-133 · W2）：
        #   编译器行为一改 ⇒ 同一份声明编译出来的模型就变了 ⇒ 那是**另一件事**
        #   ⇒ 不能撞上一次那条变更（撞了 ⇒ 「幂等键已用于不同对象变更」⇒
        #   **那张表再也晋升不上去**，人完全看不懂）。
        #   ⇒ 键算法统一走 `change_key_for`（纯函数，判据直接测它）。
        from shangshu_core.model_schema import compile_object
        compiled = compile_object(application_id, object_id, definition)
        change = prepare_object_change(application_id, definition,
                                       "promotion-extend:" + str(idempotency_key),
                                       object_id=object_id, expected_revision=model.revision,
                                       change_key=change_key_for(
                                           application_id, require_designer().identity_id,
                                           idempotency_key, compiled))
        # DDL 仍经独立迁移；定义相等时不进这条路、不增加空修订。
        applied = run_independent_migration(change["id"], confirmed=True)
        revision = applied["target_revision"]
    life = object_life(object_id)
    for row in rows or []:
        row_id = str(row.get("row_id") or "")
        name = (records or {}).get(row_id)
        if not name:
            _fail("行 %s 没有对应的受管记录，不能接续写入" % row_id)
        _set_values(object_id, revision, name, row.get("values") or {},
                    _row_key("promotion-value", idempotency_key, row_id, life))
    # ⚠️ **这里也不提交**：接续写入与应用发布跟这条动作在**同一个事务**里。
    if unchanged is None or unchanged["publish_required"]:
        _publish(application_id, object_id, revision, title)
    return {"object_id": object_id, "revision": revision, "records": dict(records or {}),
            "definition_changed": unchanged is None}


def migrate_legacy_promoted_values(*, object_id, application_id, title, columns, formal, records,
                    idempotency_key):
    """**旧 JSON 正式值单独迁移**：以现行正式值为源，不拿滞后的 xlsx 覆盖它。

    `formal` 是文件记录里那份旧的 `formal_values_json`（行 ID → 字段 → 值）。
    迁移后旧 JSON 不再参与正式读写（调用方负责清空它），受管记录成为唯一权威。
    """
    from shangshu_core.model_records import MODEL
    from shangshu_core.model_lifecycle import object_life
    model = frappe.get_doc(MODEL, object_id)
    revision = model.active_revision
    life = object_life(object_id)
    migrated = 0
    for row_id, values in (formal or {}).items():
        name = (records or {}).get(str(row_id))
        if not name:
            continue
        payload = {key: value for key, value in (values or {}).items() if value not in (None, "")}
        if not payload:
            continue
        _set_values(object_id, revision, name, payload,
                    _row_key("promotion-legacy", idempotency_key, str(row_id), life))
        migrated += 1
    # ⚠️ **这里不提交**：旧值迁移是纯写入（没有 DDL）⇒ 跟这条动作在
    #    **同一个事务**里，由最外层请求边界统一提交。
    return {"object_id": object_id, "revision": revision, "migrated": migrated,
            "records": dict(records or {})}


# ---------- 工作簿原值 → 受管值（**读的时候定**，不在晋升时再猜） ----------

def convert_workbook_value(*, promotion_type, value, number_format="General", data_type=None,
                           label=""):
    """把工作簿里一格的**原值**转成受管字段的值。

    **为什么在读的时候转，不在晋升时转**：预检查到的值与存进受管记录的值
    必须是**同一个值** —— 不许「检查通过、存进去是另一个」。

    **口径复用内核导入通道**（`record_import_xlsx.cell_value`）——
    域里**不另写一套**转换规则（不猜、不静默改写）。

    **唯一比导入通道更严的一档**：列声明是「文字/数字」而格子里是 **Excel 日期**时
    **明确拒**，不转成日期文字 ——
    Excel 的日期格式会把编号读成日期（openpyxl 就是这么干的），
    照着转就把编号变成了日期：**那是错的数据，不是「猜」**。
    拒因要带得回「怎么改」：把该列的单元格格式改成常规/文本即可。

    `promotion_type` 是**晋升列声明的类型**（text/number/date/boolean）。
    """
    from datetime import date, datetime

    from shangshu_core.record_import_xlsx import ImportError as CellError
    from shangshu_core.record_import_xlsx import cell_value

    kind = TYPE_MAP.get(str(promotion_type or "").strip())
    if not kind:
        _fail("晋升列类型不受支持：%r（允许 %s）"
              % (promotion_type, "/".join(sorted(TYPE_MAP))))
    if value is None or value == "":
        return None
    if str(data_type or "") in ("f", "e"):
        # **Excel 错误格**：实测「编号在日期范围外 + 套了日期格式」就是这样 ——
        # openpyxl 把编号读成 `#VALUE!`，**原始编号在这一步就丢了**。
        # 公式格同理。⇒ **明确拒**（不猜），并说清怎么改。
        _fail("%s：格子里是 Excel %s（多半是这一列套了日期格式、编号被当成了日期）。"
              "请把该列的单元格格式改成常规或文本后重试"
              % (label or "这一列", "公式" if str(data_type) == "f" else "错误值"))
    if kind in ("text", "decimal", "integer") and isinstance(value, (date, datetime)):
        _fail("%s：格子里是 Excel 日期（编号会被读成日期），这一列声明为%s。"
              "请把该列的单元格格式改成常规或文本后重试"
              % (label or "这一列", {"text": "文字", "decimal": "数字",
                                      "integer": "数字"}[kind]))
    cell = {"value": value, "number_format": number_format or "General",
            "data_type": data_type}
    try:
        return cell_value(cell, kind)
    except CellError as error:
        _fail("%s：%s" % (label or "这一列", error))


# ---------- 正式值的读写：受管记录是唯一权威（PKG-004-T03 第 1 步） ----------

def _values_digest(values, modified):
    """正式值 + 记录版本的指纹。**幂等键的一部分**。

    为什么把记录版本也放进去：`platform.object.update` 的载荷里
    `expected_modified` **参与**请求指纹（`action_requests.fingerprint`），
    同一个幂等键配不同的 `expected_modified` 会被判成「不是同一件事」。
    ⇒ 键跟着版本走：**同一笔重试**（记录没被别处改过）命中同键、幂等重放；
    **记录被别人改过** ⇒ 键变了、这次按新版本重写（**不重复建任何东西**）。
    """
    import hashlib
    import json as _json
    payload = _json.dumps({"values": values or {}, "modified": str(modified or "")},
                          ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def read_promoted_values(*, object_id, records, row_ids=None, fields=None, read_scope=None):
    """按「工作簿行 ID → 受管记录 ID」映射读回**受管记录**里的正式值 **＋ 记录版本**。

    返回 `{"values": {工作簿行 ID: {字段 ID: 值}}, "versions": {工作簿行 ID: modified}}`
    —— `values` 与旧的 `formal_values_json` 同形状，好让域里读回填、读就绪、读合并那几处
    **不用各写一套**；`versions` 是**受管记录的版本戳**，域把它带给客户端，
    客户端写回来时带上 ⇒ **陈旧写能被拒**（两个人改同一格，后写的那次被拒）。

    日常必须显式传 `row_ids`；省略时只接受非交互用途的明确 all 范围。
    `fields` 是逻辑字段 ID；空列表只读版本，None 是当前全部可读字段。
    目标读取走**批量读口**（`model_records.get_records`）：**一次**把这些行对应的
    受管记录取回来（授权与字段可见性仍按既有受管记录读口算）——
    未知、无权或已回收记录照常拒绝，不改用裸 SQL，也不在失败时回落整表读取。
    空目标列表返回空结果。显式 all 仍仅查本映射绑定的记录，以列表相同归属及
    回收范围过滤；已回收、不可读或不存在的行不出现在导出/迁移读取结果里。

    **走既有记录读口**（`get_records`）⇒ 字段权限、
    角色权限、记录范围与普通读**完全一样**：域里读不到的字段，这里也读不到
    （域里因此不用、也不许另开旁路）。

    ⚠️ **只读得到活着的记录**（`$scope='active'`）：已回收的记录不进正式值。
    往回收态记录写**当场拒**（`model_records._record`：「记录已回收，请在回收站恢复后操作」）。
    """
    from shangshu_core import model_records
    from shangshu_core.read_scope import normalize_read_scope
    plan = normalize_read_scope(read_scope, rows=row_ids, fields=fields)
    if plan['mode'] == 'query':
        _fail("工作簿正式值读取须指定固定行，条件查询请走对象查询入口")
    selected = list((records or {}).keys()) if plan['mode'] == 'all' else plan['rows']
    for row_id in selected:
        if not (records or {}).get(row_id):
            _fail("行 %s 没有对应的受管记录，不能读取正式值" % row_id)
    targets = [(row_id, str(records[row_id])) for row_id in selected]
    reader = model_records._available_bound_records if plan['mode'] == 'all' else model_records.get_records
    fetched = reader(object_id, [name for _row_id, name in targets], fields=plan['fields'])
    values, versions = {}, {}
    for row_id, name in targets:
        if name not in fetched:
            continue  # 显式 all 沿用授权列表语义；精确 rows 由 get_records 严格拒缺失。
        row = fetched[name]
        values[row_id] = {key: value for key, value in row.items()
                         if key not in ("name", "modified", "creation", "_lifecycle")}
        versions[row_id] = str(row.get("modified") or "")
    return {"values": values, "versions": versions}


def _restore_record_version(model, name, target, current=None):
    """把这条受管记录的**版本戳退回**指定的那一版（撤回用）。

    **受管记录的版本栈**：撤回是**逆向写入** —— 值回到上一版，**版本也回到上一版**。
    不许「值退了、版本停在最新那版」：
    停在最新 ⇒ 客户端手里那份「上一版」的版本号当场作废 ⇒
    **撤完再改同一格会被「记录已被修改，请刷新后重试」挡住**（用户白挨一次）。

    **只往回退，不往前推**：给的目标版本不比当前旧 ⇒ 不动
    （不许造出「比最新还新的版本」）。

    `current` 是**已经取到的当前版本戳**（批量撤回时一次取回 ⇒ 不用逐行查）；
    不给就现取（与旧口径一致）。
    """
    if current is None:
        current = str(frappe.db.get_value(model.physical_doctype, name, "modified") or "")
    target = str(target or "")
    if not current or not target or target >= current:
        return False
    frappe.db.set_value(model.physical_doctype, name, "modified", target, update_modified=False)
    return True


def _restore_record_versions(model, targets, current):
    """撤回已经校验并写回的记录版本；只合批物理更新，不改值或版本判断。

    调用方仍持有本次写动作的记录锁；使用同事务刚读回的当前版本。
    Frappe bulk_update 不自行提交，失败继续由外层动作整包回滚。
    """
    updates = {}
    restored = 0
    for name, target in targets:
        previous = str((current or {}).get(name) or "")
        target = str(target or "")
        if not previous or not target or target >= previous:
            continue
        updates[name] = {"modified": target}
        restored += 1
    if updates:
        # bulk_update 本身不执行 set_value 的缓存失效；只清本次目标记录。
        for name in updates:
            frappe.clear_document_cache(model.physical_doctype, name)
        frappe.db.bulk_update(model.physical_doctype, updates, chunk_size=500,
                              update_modified=False)
        frappe.db.value_cache.pop(model.physical_doctype, None)
    return restored


def _current_versions(model, names):
    """**一次**取回这些受管记录当前的版本戳（`modified`）。

    批量写回/撤回原来逐行 `db.get_value` ⇒ 次数**随行数线性增长**；
    这里一次 `name IN (...)` 取回 ⇒ 次数**不随行数线性增长**。
    取不到的行**不在结果里**（调用方按「没有版本」处理，与旧口径一致）。
    """
    wanted = list(dict.fromkeys(str(name) for name in (names or []) if name))
    if not wanted:
        return {}
    out = {}
    for start in range(0, len(wanted), 500):
        part = wanted[start:start+500]
        rows = frappe.get_all(model.physical_doctype, filters={"name": ["in", part]},
                              fields=["name", "modified"], limit_page_length=0)
        for row in rows:
            out[str(row.get("name"))] = str(row.get("modified") or "")
    return out


def read_record_versions(*, object_id, names):
    """读这若干条受管记录的**版本戳**（`modified`）。

    **只给版本，不给值** —— 版本戳不是业务值；域里用它把「这一行现在的版本」带给客户端，
    客户端写回来时带上 ⇒ 服务端能拒**陈旧写**（两个人改同一格，后写的那次当场被拒）。

    ⚠️ **为什么需要它**：读回包以前**不带版本** ⇒ 前端手上永远是空的版本号 ⇒
    客户端的版本闸**形同虚设**（后端那道闸在，但版本没回来）。

    **只认这个受管对象自己的记录**：别的对象的记录名不返回。
    """
    from shangshu_core.model_records import MODEL
    model = frappe.get_doc(MODEL, object_id)
    wanted = [str(name) for name in (names or []) if name]
    if not wanted:
        return {}
    rows = frappe.get_all(model.physical_doctype, filters={"name": ["in", wanted]},
                          fields=["name", "modified"], limit_page_length=0)
    return {str(row.get("name")): str(row.get("modified") or "") for row in rows}


def write_promoted_values(*, object_id, records, values_by_row, idempotency_key=None,
                          expected_modified_by_row=None, restore_versions_by_row=None):
    """把正式值写进**受管记录**（受管记录是唯一权威）。

    `values_by_row` 是 `{工作簿行 ID: {字段 ID: 值}}`。
    **不建对象、不建字段、不建记录** —— 只更新已有记录的值
    （建对象/建记录是 `provision_promoted_records` 的事）。

    写入走既有公共动作 `platform.object.update` ⇒ 记录版本闸、字段权限、
    业务校验、动作审计**一件都不少**（这是「受管写入复用记录级 patch」那条）。

    `expected_modified_by_row` 是**客户端带来的记录版本**（`{行 ID: modified}`）：
    给了就用它当 `expected_modified` ⇒ **记录被别人改过 ⇒ 这次写当场被拒**
    （`model_records.write_record` 的 `TimestampMismatchError` → 417）。
    **没给就按当前版本写**（老调用方不因此被打断）—— 回执里的
    `record_version_checked` 会说明这次**有没有**真的校验过。

    **幂等**：键按「对象 + 行 + 值 + 记录版本」固定 ⇒ 同一笔重试命中同键、幂等重放；
    记录被别处改过 ⇒ 键变了、这次按新版本重写（**零重复**）。

    `restore_versions_by_row` 是**要退回的版本**（`{行 ID: modified}`）——
    **撤回用**：值回到上一版时，**版本也回到那一版**（受管记录的版本栈）。
    见 `_restore_record_version`。

    返回 `{written, records, record_version_checked, record_versions_restored}`。

    ⚠️ **权威写路径一字未改**：仍然**每行一次** `platform.object.update`
    （版本闸、字段权限、业务校验、动作审计一件都不少）。
    改的只是**它周围的重复开销**（2026-10-27 性能线）：
    · 行 → 记录名与**当前版本**：**一次**批量取回（原来逐行 `db.get_value`）；
    · 模型/定义/角色/主体上下文：**整批装配一次**（`model_records.batch_state`），
      不再每行重装配一遍；
    · 撤回用的版本回退：**批末一次**取当前版本（原来逐行查）。
    """
    from shangshu_core.actions import execute_registered_action
    from shangshu_core.model_records import MODEL
    from shangshu_core import managed_changes, model_records
    model = frappe.get_doc(MODEL, object_id)
    revision = model.active_revision
    written = 0
    checked = False
    restored = 0
    # ⚠️ **批量 ⇒ 批末一次通知**（原收敛条目 05）：逐行写会逐行触发投影落盘
    #   ⇒ 两万格的粘贴会落两万次盘。**一次落盘**才是对的。
    with managed_changes.batch(source="promotion") as batcher:
        # ---- ① 行 → 受管记录名（缺映射**当场拒**，且**在写任何一行之前**） ----
        plan = []
        for row_id in sorted((values_by_row or {})):
            name = str((records or {}).get(str(row_id)) or "")
            if not name:
                _fail("行 %s 没有对应的受管记录，不能写正式值" % row_id)
            plan.append((row_id, name))
        # ---- ② **一次**取回所有目标行的当前版本（不再逐行查） ----
        current = _current_versions(model, [name for _row_id, name in plan])
        written_names = set()
        restore_targets = []
        # ⚠️ **整批复用同一份装配**（模型/定义/角色/主体上下文）——
        #   授权判定本身一字未改，只是**不再每行重装配一遍**。
        with model_records.batch_state():
            # ---- ④ **一次动作执行**（契约《处理契约与状态转换》第 4 步③ 的批量通道）----
            #   以前这里是**每行一次** `platform.object.update`（域声明清单全扫、动作定义、
            #   幂等登记、动作回执各一次 ⇒ 每行约 3.9ms 的固定开销）。
            #   现在**动作框架走一次**；**每条记录的门一件都不少**
            #   （版本闸/字段权限/值域/唯一键逐条照走，实现与单条写共用同一份代码）。
            #   审计**仍然一行一条**（粒度不变）。
            batch = []
            for row_id, name in plan:
                values = dict((values_by_row or {})[row_id] or {})
                expected = (expected_modified_by_row or {}).get(str(row_id))
                if expected:
                    # **客户端带版本**：用它当版本闸 ⇒ 陈旧写当场被拒。
                    modified = str(expected)
                    checked = True
                elif name in written_names:
                    # **同一个受管记录被多行映射** ⇒ 版本要现取（上一行写完版本已变）。
                    modified = str(frappe.db.get_value(model.physical_doctype, name, "modified") or "")
                else:
                    modified = current.get(name, "")
                # ⚠️ **幂等键口径不变**：仍是「对象 ＋ 行 ＋ 值 ＋ 记录版本」。
                key = "promotion-write:%s:%s:%s" % (idempotency_key or object_id, row_id,
                                                   _values_digest(values, modified))
                batch.append({"name": name, "expected_modified": modified, "values": values,
                              "row_id": str(row_id), "idempotency_key": key})
                written_names.add(name)
                target = (restore_versions_by_row or {}).get(str(row_id))
                if target:
                    restore_targets.append((name, str(target)))
            if batch:
                execute_registered_action(
                    "platform.object.update_many",
                    {"object_id": object_id, "expected_revision": revision, "records": batch},
                    confirmed=True,
                    idempotency_key="promotion-write-batch:%s:%s" % (
                        idempotency_key or object_id,
                        _values_digest([item["idempotency_key"] for item in batch], "")),
                    source="user")
                written += len(batch)
        # ---- ③ 撤回用的版本回退：批末取当前版本并合批回填 ----
        #   （只往回退、不往前推；值与版本一起退 —— 语义与旧口径一致。）
        if restore_targets:
            after = _current_versions(model, [name for name, _target in restore_targets])
            restored += _restore_record_versions(model, restore_targets, after)
    return {"object_id": object_id, "revision": revision, "written": written,
            "records": dict(records or {}), "record_version_checked": checked,
            "record_versions_restored": restored,
            # **批末那一次通知的结果**（回填成没成）—— 调用方要拿它回执里说清。
            "managed_change": getattr(batcher, "result", None) or {}}
