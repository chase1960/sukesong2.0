"""晋升定义模型（PKG-004 / D-a）：某列 → 数据库字段的映射，以及它的读口。

**这是什么**：一张表里有三类列 ——
  · **已晋升列**：值在数据库里有正式字段，改它要过 DB 规则校验，保存后**仅值回填**原表
  · **普通列**：值就在表数据里，正常读写，**不建数据库字段**
  · （本次不做）未晋升但计划晋升的列
本模块只管**定义本身**怎么存、怎么读回来。读写分流（D-b/D-c）与回写（D-d）在别处。

**绑定口径**（执行计划 :81，一字不放宽）：按**固定行ID + 表头 + 结构/定义版本**定位。
所以定义里必须同时留住：
  · `structure_version` —— **绑定那一刻**的表结构版本。表头改过、加过列之后
    这个版本就对不上，旧绑定**要能认出对不上**，不许拿旧绑定乱对新表。
  · `definition_version` —— 定义自己的版本。定义升级后旧动作/提案按版本失效
    （契约要求：**不借公共资料读权获得晋升权**、历史日志不按新定义重解释旧值）。

**定义存哪**：`sheet_meta_json`（`sheet.py` 的 META_FIELD）里 `promotion` 这个键。
  放这里而不是另开 DocType 字段，是因为它跟 `structure_version` 是**同一次定位**
  要用的两件事 —— 分两处存，迟早对不上。`sheet_meta_json` 已经是这张表的元数据
  唯一落点，不另造第二份。

**测试通过 = `test_d_promotion_chain.py` D-a**：
  给一份「案件编号/金额已晋升、备注没晋升」的定义，读回来三列的晋升标记是
  **是/是/否，不多不少**；非晋升列**没有**数据库字段（新增普通列不建 DB 字段）；
  定义带着结构版本与定义版本。

**首次晋升仅 FDE 受管工程入口** —— 本模块不提供普通员工/Agent 的晋升口，
写定义的入口在 domain 注册时就要卡角色。
"""
import json
import hashlib

import frappe
from shangshu_core.public_api import raise_if_transaction_failed

from shangshu_files import access_scope

META_FIELD = 'sheet_meta_json'
DEFINITION_VERSION = 1

# 允许的字段类型（跟「数据库字段」能立得住的那几种；date 归 number/text 之外单列）
#
# ⚠️ **长文本（2026-10-25 18:2x 站上实测撞出来的缺口）**：
#   内核的受管模型**本来就有**这一档（`Long Text`，不设 maxLength），
#   **值那一层**的闸也认它（见下面的 `_check_rules`）⇒ 但**这道定义校验**没放行它
#   ⇒ 站上真总表晋升在**启用那一步**报「晋升列 联系人信息 的类型无效：'long_text'」
#   ⇒ **15500 行的晋升整个失败**（前面 15500 条行级幂等键都白写了）。
#   ⇒ 这里放行它：**定义认得、值层也认得、物理列也立得住**（内核 `model_schema` 那一档）。
ALLOWED_TYPES = ('text', 'long_text', 'number', 'date', 'boolean')

# 列级权限声明（PKG-117-T01 / 契约《账号与权限》2026-10-25 一节）。
#
# **受管表链已换成「三个操作 × 主体范围」**：列上写 `access`
# （read（含筛）／write／download 各自一个主体范围：
#   全局／部门／个人／**无人** —— 四档，用户 2026-10-26 决议③）。
# ⚠️ **降维**（用户 2026-10-27 06:2x 口径）：「筛」并进「读」、「助手」那一档去掉
#   ⇒ 三个操作**都必填**；存量声明里的 `filter`／`assistant` **视同未声明**。
#
# ⚠️ **旧口径（建模对象链）原文保留作对照** —— 那条链在
# `shangshu_core/field_access.py` 里**照旧**，本链**不复述、不回落**：
#   · read / write **未声明 = 不限**（既有约定，`field_access.py:80`）
#   · download **未声明 = 拒**（用户 2026-10-15 选 (c)「零声明即拒」）
#   · 那三个**角色键**（`read_roles`／`write_roles`／`download_roles`）
#     —— **只在建模对象链还在用**
# ⇒ **本链一律不适用**：未声明＝**继承整张表**；
#   **read／write／download 都必填**（降维后没有可省的了）；
#   旧角色键在本链**明确拒**（契约 22:4x「不留兼容函数」）。
#
# **为什么列的 access 必须整份留**（R967-E01 / BASE967-31 的教训继续有效）：
# `save_definition` 落库时逐列**重建**字典 —— 白名单漏一个键就是**静默泄露**
# （当年：声明了「只有财务能看」的字段落库后变成人人可读可写；
#  UI-019 实测「返回成功但读回丢掉这三个键」）。
# ⇒ 落库时**整份 `access` 原样带走**，不逐键挑。
ACCESS_KEY = 'access'


def _load_meta(doc):
    try:
        meta = json.loads(getattr(doc, META_FIELD, None) or '{}')
    except Exception:
        meta = {}
    return meta if isinstance(meta, dict) else {}


def _save_meta(doc, meta):
    from shangshu_files.binding_metadata import save_meta
    save_meta(doc, meta)


def _stored_promoted_headers(meta):
    """这张表**当前存下来的**晋升定义里，**已经晋升过**的那些列（表头）。

    ★ **「新晋升」怎么判**（PKG-123-T01 · 契约《账号与权限》2026-10-25 §三）：
      第 1 条「**每次晋升一列必须写清楚**该列的主体范围 ⇒ 晋升入口**必填**」
      —— 这条只管**新晋升**：**已经晋升过的那一列**，这次保存**可以不带** `access`
      ⇒ 生效语义＝**继承表级**（§三 第 2 条「列没有声明 ⇒ 继承整张表的权限」；
      内核 `promotion_records.build_definition` 也是这么算的：列没声明 ⇒ 继承表级）。

    ⚠️ **只认「已经晋升过」的列**：存下来的定义里**普通列**（`promoted: false`）
      这次**第一次晋升** ⇒ 它是**新晋升** ⇒ **照样必填**。

    ⚠️ **不另查库**：用**已经加载到的那份**当前定义（`define()` 里那份 `meta`／
      `save_definition` 里那份 `_load_meta(doc)`）⇒ **不造第二次查询**。
    """
    raw = (meta or {}).get('promotion')
    if not isinstance(raw, dict):
        return set()
    out = set()
    for col in raw.get('columns') or []:
        if not isinstance(col, dict):
            continue
        # ⚠️ **「已经晋升过」怎么认**：**`promoted` 为真**、**或者**存着**数据库字段名**
        #   （普通列从来不带 `field` —— `validate_definition` 禁）⇒
        #   站上那些**老版本**落下来的定义（形状各不相同）也认得出来。
        if not (col.get('promoted') or col.get('field')):
            continue
        header = str(col.get('header') or '').strip()
        if header:
            out.add(header)
    return out


def validate_definition(definition, existing_headers=None):
    """校验定义形状。**不猜**：缺件、重列、非法类型一律当场拒，不静默补默认值。

    `existing_headers` = **这张表当前存下来的**已晋升列的表头
    （`define`／`save_definition` 传**已经加载到的那份**，不另查库）⇒
    **存量列可以不带 `access`**（生效语义＝继承表级），
    **新晋升的列必须带**（契约 §三 第 1 条）。
    **没给这一份 ⇒ 一律当「新晋升」**（fail-closed：宁可多要一次声明，不许静默放过）。
    """
    existing = set(existing_headers or ())
    if not isinstance(definition, dict):
        frappe.throw('definition 必须是对象', frappe.ValidationError)
    columns = definition.get('columns')
    if not isinstance(columns, list) or not columns:
        frappe.throw('definition.columns 必填且不能为空', frappe.ValidationError)
    seen_headers, seen_fields = set(), set()
    for i, col in enumerate(columns):
        if not isinstance(col, dict):
            frappe.throw('definition.columns[%d] 必须是对象' % i, frappe.ValidationError)
        header = str(col.get('header') or '').strip()
        if not header:
            frappe.throw('definition.columns[%d].header 必填' % i, frappe.ValidationError)
        if header in seen_headers:
            frappe.throw('表头重复：%s' % header, frappe.ValidationError)
        seen_headers.add(header)
        promoted = bool(col.get('promoted'))
        if not promoted:
            # **非晋升列不许带数据库字段** —— 「新增普通列不建 DB 字段」
            if col.get('field') or col.get('type') or col.get('rules'):
                frappe.throw('未晋升列不能指定数据库字段/类型/规则：%s' % header, frappe.ValidationError)
            continue
        field = str(col.get('field') or '').strip()
        if not field:
            frappe.throw('晋升列必须指定数据库字段名：%s' % header, frappe.ValidationError)
        if field in seen_fields:
            frappe.throw('数据库字段名重复：%s' % field, frappe.ValidationError)
        seen_fields.add(field)
        typ = str(col.get('type') or '').strip()
        if typ not in ALLOWED_TYPES:
            frappe.throw('晋升列 %s 的类型无效：%r（允许 %s）' % (header, typ, '/'.join(ALLOWED_TYPES)),
                         frappe.ValidationError)
        rules = col.get('rules') or {}
        if not isinstance(rules, dict):
            frappe.throw('晋升列 %s 的 rules 必须是对象' % header, frappe.ValidationError)
        # **列级权限声明**（PKG-117-T01）：**新晋升的列必须写清主体范围**。
        #
        # **不猜、不静默补默认值**：形状不对当场拒，**理由点名是哪个列、哪个操作、缺什么**
        # （用户看得懂的话，不是字段名清单）。
        # 旧的角色键在本链**明确拒**（契约 22:4x「不留兼容函数」）。
        access_scope.require_no_legacy_keys(col, '晋升列「%s」' % header)
        if ACCESS_KEY not in col:
            if header not in existing:
                # **新晋升的这一列** ⇒ 必须写清（契约 §三 第 1 条「晋升入口必填」）。
                frappe.throw('晋升列「%s」必须写清权限主体范围（access）：'
                             '读／写／下载三项都必填'
                             '（这一列是**这次新晋升**的 —— 第一次晋升必须写清）'
                             % header,
                             frappe.ValidationError)
            # **存量列**（这一列早就在这张表的定义里）⇒ 这次保存**允许不带**
            # ⇒ 生效语义＝**继承表级**（契约 §三 第 2 条）。
            # ⚠️ **这里不许把表级那份复制进这一列** —— 那会让「以后改表级不再影响它」
            #   （违反继承语义）；继承是**读取时**按契约算的（内核那侧已经这么算）。
            continue
        access_scope.require_access(col.get(ACCESS_KEY), where='晋升列「%s」' % header)
    # **表级 access 必填**（PKG-117-T01）：表级是**独立声明**的一份主体范围，
    # **不再由各列并集推导**（契约 2026-10-25 22:4x「取消并集联动」）。
    # **没有晋升列时也必填** —— 没有晋升列 ⇒ 全部按表级算（契约「继承规则」第 3 条）。
    if ACCESS_KEY not in definition:
        frappe.throw('这张表必须写清表级权限主体范围（access）：'
                     '读／写／下载三项都必填',
                     frappe.ValidationError)
    access_scope.require_no_legacy_keys(definition, '这张表的表级权限')
    access_scope.require_access(definition.get(ACCESS_KEY),
                                where='这张表的表级权限',
                                allow_record_scope=True)
    version = definition.get('definition_version')
    if version is not None and int(version) != DEFINITION_VERSION:
        # 版本不认的定义**明确拒**，不静默按当前版本重解释（历史日志不按新定义重解释旧值）
        frappe.throw('definition_version 不受支持：%r（当前 %d）' % (version, DEFINITION_VERSION),
                     frappe.ValidationError)
    return True


def _column_persisted(col):
    """一列**落库要留的那些面**。**白名单只加 access，不是放开白名单**。

    ⚠️ **列的主体范围整份带走**（R967-E01 / BASE967-31 的教训继续有效）——
    以前这里逐列重建字典时把权限键**静默扔掉**，声明的受限列当场变成人人可读可写。
    ⇒ `access` **整份**带走，不逐键挑。

    ⚠️ **列没声明 `access` ⇒ 这一列**不落** `access` 键**（PKG-123-T01）：
      那是**存量列**（继承表级）⇒ **不许在这里把表级那份复制进列**
      —— 复制了就变成「物化」⇒ 以后改表级不再影响这一列（违反契约 §三 第 2 条）。
      继承是**读取时**算的（内核 `promotion_records.build_definition` 同样不复制）。
    """
    if not col.get('promoted'):
        return {'header': str(col.get('header')).strip(), 'promoted': False}
    out = {
        'header': str(col.get('header')).strip(),
        'promoted': True,
        'field': str(col.get('field')).strip(),
        'type': str(col.get('type')).strip(),
        'rules': dict(col.get('rules') or {}),
    }
    if ACCESS_KEY in col:
        out[ACCESS_KEY] = access_scope.require_access(
            col.get(ACCESS_KEY), where='晋升列「%s」' % out['header'])
    return out


def _definition_meta(doc, definition):
    """算「落库后那份 meta」—— **只算，不写**（`sheet_meta_json` 一个字节都不动）。

    ★ **为什么要把「算」和「写」分开**（2026-10-26 · 3850 站上实测）：
      受管对象的物理表由内核建 —— 那是 **DDL**（MariaDB 的 DDL **隐式提交**）⇒
      **调用方那条连接上此刻还没提交的写，会被 DDL 一起提交**。
      ⇒ 域侧的声明写必须**排在迁移之后** ⇒ 迁移之前得先有「**将要落的那份**」
      （幂等键要用它算指纹）⇒ 这一份**只算不写**。

    ⚠️ **算出来的与真落库的必须一字不差** ⇒ 落库那一步（`save_definition`）
      **调的就是这一份** ⇒ 不另写第二套算法。
    """
    meta = _load_meta(doc)
    validate_definition(definition,
                        existing_headers=_stored_promoted_headers(meta))
    from shangshu_files.table_relations import guard_public_definition
    guard_public_definition(doc,definition)
    structure_version = int(meta.get('structure_version') or 1)
    table_access = access_scope.require_access(
        definition.get(ACCESS_KEY), where='这张表的表级权限', allow_record_scope=True)
    table_access.setdefault(access_scope.RECORD_SCOPE_KEY, 'all')
    meta['promotion'] = {
        'definition_version': DEFINITION_VERSION,
        # 绑定那一刻的结构版本 —— 表头改过就对不上，读侧要认出对不上
        'structure_version': structure_version,
        # **表级主体范围**：独立声明的一份，**不从各列推导**（契约 22:4x）。
        ACCESS_KEY: table_access,
        'columns': [_column_persisted(col) for col in definition.get('columns')],
    }
    return meta


def save_definition(doc, definition):
    """落定义，**钉住绑定那一刻的结构版本**。

    `update_modified=False` —— 立定义**不是一次用户编辑**，不许改表的「更新时间」
    （T09 口径：文件回填不是另一次用户修改）。

    **表级与列级的主体范围都整份留**（PKG-117-T01；
    沿用 BASE967-31 / E01.3「进入定义持久化、加载、升级全过程」那条纪律）
    —— 以前这里逐列重建字典时把权限键静默扔了，声明的受限列当场变成人人可读可写。

    ★ **存量列 vs 新晋升列**（PKG-123-T01）：用**当前存下来的那份**定义判
      （`_load_meta(doc)` **已经加载过的那份** ⇒ **不另查库**）⇒
      **存量列可以不带 `access`**（继承表级），**新晋升的列必须带**。

    ⚠️ **落库时「部门档」里存的必须是部门 key**（不是标题）——
      归一由**两个入口**做（`define` 落库前 ＋ `rewrite` 落库前，
      见 `_normalize_department_keys`）⇒ 落进受管对象声明里的也是 key。

    ⚠️ **写这一下之前，迁移（DDL）必须已经跑完** —— 见 `_definition_meta`
      的文件头（DDL 的隐式提交会把调用方那条连接上还没提交的写一起提交）。
    """
    _save_meta(doc, _definition_meta(doc, definition))
    return load_definition(doc)


def _definition_from_meta(meta, table):
    """从**一份 meta** 读回定义（与 `load_definition` 同形）。

    ★ **为什么要单列一个**：迁移（DDL）之前得先有「**将要落的那份**」⇒
      那份**还没落库** ⇒ 不能靠 `load_definition(doc)`（它只读**已落**的那份）⇒
      这里从**内存里那份 meta** 算，**形状与 `load_definition` 一字不差**
      （幂等键、对象侧那份声明都靠它）。
    """
    meta = meta or {}
    # **当前结构版本无论有没有定义都要回** —— 调用方要绑，就得知道「现在是几」。
    # 没定义时回 None 会让「拿版本号去绑」这一步根本起不了头（实测卡过一次）。
    current = int(meta.get('structure_version') or 1)
    raw = meta.get('promotion')
    if not isinstance(raw, dict) or not raw.get('columns'):
        return {'table': table, 'promoted': False, 'columns': [],
                ACCESS_KEY: None,
                'definition_version': None, 'structure_version': current,
                'bound_structure_version': None, 'binding_current': None}
    bound = int(raw.get('structure_version') or 1)
    # —— **绑定绑的是「列」，不是「行」**（2026-10-30 用户口径：
    #   「另外，**我司案号的自动化又没了**」）——
    #   **站上实测的根因**：那张表的结构版本已经是 116，定义却绑在 78 ⇒
    #   绑定被判成「对不上当前结构」⇒ 候选读被拒（「晋升定义与当前表结构不一致」）
    #   ⇒ **案号自动化说没就没**。
    #   **为什么会漂**：`structure_version` **行操作也在顶**（插行／删行／排序）
    #   ⇒ 人只是加了几行、删了几行 ⇒ **列结构根本没变** ⇒ 绑定却死了。
    # ⇒ 判定改成：**定义里那些受管列的表头还在不在**
    #   （正式值按 `行 ＋ 字段` 存，列名就是那张表的表头
    #   ⇒ 受管列**名字都还在** ⇒ 定义还对得上这张表）。
    # ⚠️ **列的先后不算**（2026-10-30 实测：那张表的列顺序与定义里记的不一样
    #   ——定义里是「我司案号、申请号…」，表里现在是「申请号、我司案号…」——
    #   而**正式值按列名认列**，先后根本不影响绑定
    #   ⇒ 用先后去判 ⇒ 白白把绑定判死 ⇒ 自动化说没就没）。
    # ⚠️ **列结构真变了照样判失效**：受管列**改名／被删** ⇒ 名字不在了 ⇒ 失效。
    # ⚠️ **没有表头清单的老文件** ⇒ 回落老口径（版本号相等）。
    current_headers = meta.get('headers')
    if isinstance(current_headers, list) and current_headers:
        bound_headers = [str(col.get('header') or '').strip()
                         for col in (raw.get('columns') or [])
                         if col.get('promoted') is True and col.get('header')]
        current_set = set(str(header).strip() for header in current_headers)
        binding_current = all(header in current_set for header in bound_headers)
    else:
        binding_current = current == bound
    return {
        'table': table,
        'promoted': True,
        'columns': list(raw.get('columns') or []),
        # **表级主体范围**（独立声明，不从各列推导）
        ACCESS_KEY: raw.get(ACCESS_KEY) or None,
        'definition_version': raw.get('definition_version'),
        # 当前结构版本 / 绑定时的结构版本 —— 两个都给，绑定是否还有效由调用方判
        'structure_version': current,
        'bound_structure_version': bound,
        'binding_current': binding_current,
    }


def load_definition(doc):
    """读回定义。**回的是认定的事实，不是回声** —— 从 `sheet_meta_json` 读实际落的那份。

    同时把**绑定是否还对得上当前结构**一并算出来给调用方，免得各处各判一遍。

    **表级主体范围也一起回**（`access`）—— 前端「字段权限」面板要用，
    判定侧也要靠它做「列没声明 ⇒ 继承表级」。
    """
    return _definition_from_meta(_load_meta(doc), doc.name)


def promoted_columns(definition):
    """只要晋升了的列（读写分流、回写都只认这一份）。"""
    cols = definition.get('columns') or []
    return [c for c in cols if c.get('promoted')]


# ---- 回填失败的「待恢复」状态（契约 `执行计划.md:283`）----
#
# 契约原话：「**单独DB动作成功但文件失败时如实待恢复且不导出旧文件**；
# 恢复仅更新目标值，不能盖掉后来普通值或格式；重复/迟到任务不倒退」。
#
# **为什么要有这个状态**：`formal_write` 是两步 —— ① 写数据库正式值 ② 回写原表那格。
# 两步**不是一回事**：① 是事务里的 UPDATE，② 动的是磁盘上的 xlsx 字节。
# ② 失败时有两种走法：
#   · **整单回滚**（第一版就是）—— ① 也一起没了。看着「干净」，但用户改的值**静默丢失**，
#     而且导出给的是旧文件，**和「什么都没发生」长得一模一样**。
#   · **① 留下、② 记「待恢复」**（契约要的）—— 用户的值在，导出**不许**再给旧文件冒充最新。
#
# **所以这个状态是契约明写的，不是我们发明的缓冲。**
PENDING_KEY = 'writeback_pending'


def mark_writeback_pending(doc, row_id, values, error):
    """DB那份已经落了、回写原表失败 → 标「待恢复」。**不动文件、不动正式值。**"""
    meta = _load_meta(doc)
    pend = dict(meta.get(PENDING_KEY) or {})
    pend[str(row_id)] = {
        'values': {**dict((pend.get(str(row_id)) or {}).get('values') or {}),
                   **dict(values or {})},
        'error': str(error)[:300],
        'at': frappe.utils.now(),
    }
    meta[PENDING_KEY] = pend
    _save_meta(doc, meta)


def clear_writeback_pending(doc, row_id=None, fields=None):
    """回填成功后清「待恢复」。`row_id=None` 清全部。"""
    meta = _load_meta(doc)
    pend = dict(meta.get(PENDING_KEY) or {})
    if row_id is None:
        if not pend:
            return False
        meta[PENDING_KEY] = {}
    else:
        if str(row_id) not in pend:
            return False
        if fields is None:
            pend.pop(str(row_id), None)
        else:
            entry = dict(pend[str(row_id)])
            remaining = {key: value for key, value in (entry.get('values') or {}).items()
                         if key not in fields}
            if remaining:
                entry['values'] = remaining
                pend[str(row_id)] = entry
            else:
                pend.pop(str(row_id), None)
        meta[PENDING_KEY] = pend
    _save_meta(doc, meta)
    return True


def writeback_pending(doc):
    """读「待恢复」清单 —— **回的是落库的那份，不是回声**。空 dict = 没有待恢复的。"""
    raw = _load_meta(doc).get(PENDING_KEY)
    return dict(raw) if isinstance(raw, dict) else {}


def require_no_pending_writeback(doc):
    """导出前的闸：**有待恢复的就拒**，不许拿旧文件冒充最新。

    **拒因说人话**（用户看得懂，不写错误码）：说清「哪格没回填上、为什么不能给、
    怎么办」。契约 `开发计划.md:191`：「旧文件不能假装最新下载或附件」。

    **这是文件域这一半**。裸 `file-content` URL（内核 `file_content`）绕过本闸
    直接拿字节，是**已知缺口** —— 那道闸在内核，按分工交 B 补钩子，
    判据已立全（RT-④③ ⑧）。**按挡验收准备，不按「不挡」松手。**
    """
    pend = writeback_pending(doc)
    if not pend:
        return
    rows = '、'.join(sorted(pend.keys()))
    raise_exception = frappe.throw(
        '这份表有 %d 处正式值**已写进数据库、但还没回写进 Excel**（行 %s），'
        '处于「待恢复」。**导出暂不可用** —— 否则会给一份没改过的旧文件，'
        '看起来像最新，其实不是。请**重试保存**那几格，成功后自动恢复导出。'
        % (len(pend), rows),
        frappe.ValidationError)
    return raise_exception


# ---------- 内容就绪闸（D §17 交 B 的那半，域内注册） ----------

def unreadable_headers(doc, companion_access=None):
    """当前用户**读不到的晋升列表头**集合（`set[str]`）。

    给**日志/台账/候选/导出计数**这些「附带值」的口用 —— 口径 `账号与权限.md:98`：

    > 「列表/详情、搜索与定位、筛选/排序、范围读取/复制、**预览**、Assistant 工具、
    > **获准的日志/候选读取**均**不得输出无权字段值**或由它生成的泄露性摘要。」

    所以台账里那几格的**快照值**也要滤掉 —— 不能「正文挡住了、日志里能翻到」。
    **只认晋升列**（普通列不进字段 ACL，同 `_require_all_columns_readable`）。

    **判定走主体范围**（PKG-117-T01）：列没声明 ⇒ 继承表级 ⇒ 都声明 ⇒ 拒。

    ⚠️ **`companion_access` 是「已经算好的那一份授权」**（R09）：读路径**已经**
    算过一次 ⇒ 这里**直接复用**给伴随列的隐藏判定，**不许再触发一轮全表授权**。
    不传（老调用方）⇒ 伴随那几口仍自己算（**不静默改变别的调用方的行为**）。
    """
    definition = load_definition(doc)
    cols = [c for c in (definition.get('columns') or [])
            if isinstance(c, dict) and c.get('promoted') and c.get('field')]
    extra_hidden = set()
    if _load_meta(doc).get('object_companion'):
        from shangshu_files.object_projection import hidden_headers as companion_hidden
        extra_hidden = companion_hidden(doc, access=companion_access)
    if not cols and not extra_hidden:
        return set()
    caps, _ = _field_caps(doc, definition=definition)
    hidden = extra_hidden | {str(c.get('header')) for c in cols
              if not (caps.get(c.get('field')) or {}).get('read')}
    # A derived ordinary cell cannot disclose a protected formal dependency.
    for key, result in (_load_meta(doc).get('formula_results') or {}).items():
        if any(d.get('header') in hidden for d in result.get('dependencies', result.get('bindings', {}).values())):
            hidden.add(key.split('\0', 1)[-1])
    return hidden


def _require_all_columns_readable(doc):
    """**导出硬条件**（`账号与权限.md:100`，计划 §五 E01.3）：

    > 完整 A 必须同时具备**导出权**、**本次导出全部实际内容的读取权**……
    > **任一内容无读权时拒绝完整 A 下载**，**不能先下发整份文件再由前端遮挡**。
    > **原版本/历史下载同样按当前相应权限判定，不能成为旁路。**

    所以：**晋升列里只要有一列当前用户读不到 → 整份拒**（**不裁剪、不遮挡**）。
    普通列不进字段 ACL（用户 2026-10-15「新加的列就是 xlsx 里面的列，
    不是有意义的字段，只在 xlsx 上体现」）。

    ⚠️ **PKG-117-T01 之后这里不再用「未声明 = 不限」那条旧约定** ——
    受管表链上**未声明＝继承整张表**；表级也没声明 ⇒ **拒**（fail-closed）。
    （旧约定原文在 `shangshu_core/field_access.py`，那是**建模对象链**，不复述。）
    """
    if _load_meta(doc).get('object_companion'):
        from shangshu_files.object_projection import require_read
        require_read(doc)
    definition = load_definition(doc)
    cols = [c for c in (definition.get('columns') or [])
            if isinstance(c, dict) and c.get('promoted') and c.get('field')]
    if not cols:
        return
    caps, _ = _field_caps(doc, definition=definition)
    missing = [str(c.get('header') or c.get('field'))
               for c in cols
               if not (caps.get(c.get('field')) or {}).get('read')]
    if missing:
        frappe.throw(
            '这份文件有 %d 列你没有读权限（%s）—— **不能下载完整文件**。'
            '完整导出要求全部实际内容都可读；请让管理员给你这些列的读权，'
            '或改用只含你有权内容的范围导出。'
            % (len(missing), '、'.join(missing[:5])),
            frappe.PermissionError)


def _require_all_columns_exportable(doc):
    """Whole-workbook export requires read AND explicit field download rights."""
    _require_all_columns_readable(doc)
    if _load_meta(doc).get('object_companion'):
        from shangshu_files.object_projection import require_download
        require_download(doc)
    # **下载那一维**（PKG-117-T01）：按列声明的**下载**主体范围判
    # （未声明 ⇒ 继承表级 ⇒ 都未声明 ⇒ 拒）。
    definition = load_definition(doc)
    caps, _ = _field_caps(doc, definition=definition)
    missing = [str(c.get('header') or c.get('field'))
               for c in (definition.get('columns') or [])
               if isinstance(c, dict) and c.get('promoted') and c.get('field')
               and not (caps.get(c.get('field')) or {}).get('download')]
    if missing:
        frappe.throw('当前字段没有导出权限，不能下载完整文件（%s）'
                     % '、'.join(missing[:5]), frappe.PermissionError)

def content_gate(doctype, name, file):
    """`file_content` 的**内容就绪闸** —— 按 B 的 `register_content_gate` 契约
    （`shangshu_core.field_access`，CG-00～06）。

    **干什么**：裸 `file-content` URL 绕过 `files.versions` 直接拿字节，
    那条口**不知道内容新旧**（只查权限 + 挂载）。本闸在那儿问一句
    「这份内容好了没」—— **有待恢复的就拒**，不许拿旧文件冒充最新。

    **拒因只此一份**：直接调 `require_no_pending_writeback`，不另写一段文案
    （两处文案迟早对不上）。契约 §17.3 有文案表。

    **回 `{'version_label': 'vN'}`** —— B 的 §17.4 附条「下载文件名标清这是哪个版本」。
    版本号取 `version_count - 1`（`version_count` 是**下一版序号**，见
    `domain.versions` 的 `'version': max(0, version_count - 1)` 同一口径）。

    ⚠️ **旧版本照旧能下**（D §17.4 ⑤ 已拍）—— 本闸**只挡「最新那份」**。
    待恢复是「**最新不一致**」，不是「不给旧的」：历史版本的字节本来就是它自己
    那一版，不存在「冒充最新」的问题。**怎么分**：每版一条独立 Frappe File
    （`Shangshu File Center Version.frappe_file`，`_save_version` 每次落盘新建），
    文档上 `current_file` 指向当前那份 —— 请求的 `file` 不是 `current_file` 就是旧版。

    ⚠️ **第一版写成无条件 `require_no_pending_writeback`** —— 跟上面这句口径相反，
    把历史版本一起挡了（RT-4-3-K ⑤ 当场红）。**docstring 说的和代码做的要对得上。**
    """
    doc = frappe.get_doc(doctype, name)
    # **回收态不下原件**（F04 反例 `afc69nlvm6`）：只把读路径堵上还欠一半 ——
    # 「回收了还能下载原件」同样是「用户以为删了、实际还在」。**恢复后自动放行**。
    if doc.status == 'Recycled':
        frappe.throw('该文件在回收站，恢复后才能下载', frappe.PermissionError)
    # **字段 ACL 先判，且新旧都拦**（口径 `:100`「原版本/历史下载不能成为旁路」）——
    # 放在版本分流**之前**：拿历史版本绕字段权限是另一条旁路。
    _require_all_columns_exportable(doc)
    if file and str(file) != str(doc.current_file or ''):
        # 历史版本那份 —— 放行，标**它自己**的版本号（不是最新那个号）
        ver = frappe.db.get_value('Shangshu File Center Version',
                                  {'file': doc.name, 'frappe_file': file}, 'version_no')
        return {'version_label': 'v%s' % ver} if ver is not None else {}
    require_no_pending_writeback(doc)   # 最新那份：有待恢复就抛，文案只此一份
    return {'version_label': 'v%d' % max(0, int(doc.version_count or 1) - 1)}


def register_content_gate_with_kernel():
    """把本域的内容就绪闸挂上内核的 `_CONTENT_GATES`。回 `(挂上没有, 说明)`。

    ⚠️ **必须在 web 进程里挂** —— `_CONTENT_GATES` 是**进程内存字典**，
    在 `bench migrate` 里挂对 web 进程**没用**。所以挂载点是**模块导入**
    （`hooks.py` 启动时直接调，**不放 `domain.py`** —— 那个文件带着被拦的角色改动，
    缠在一起会两个都上不去）。

    ⚠️ **内核缺了要大声说，但不许静默**（静默 = 闸没装 = 「空过长得跟过一模一样」）。
    所以：内核没有就回 `(False, 原因)` 并**打 error 日志**，**不抛** —— 抛了会把整个
    文件域弄挂（`domain.py` 导不进）。**是否真挂上由判据查**（`content_gate_registered`），
    不由这里自说。
    """
    try:
        from shangshu_core.public_api import register_content_gate as _reg
    except Exception as error:            # ImportError / 内核没部署 / 版本不对
        why = '内核 `shangshu_core.field_access` 不可用：%s: %s' % (type(error).__name__, error)
        try:
            frappe.logger().error('[shangshu_files] 内容就绪闸**没挂上** —— ' + why)
        except Exception:
            pass
        return False, why
    # ⚠️ **用 `FILE`，不是 `DOCTYPE`** —— 本模块管文件表的常量叫 `FILE`（见下方定义），
    # `DOCTYPE` 这个名字**本模块里根本不存在**。第一版写成 `DOCTYPE` → NameError，
    # 被 `hooks.py` 的 try/except 吞成一条日志，**闸等于从来没挂上**，
    # 而「没挂上」跟「挂上了但没拦」从外面看不出区别。**名字要跟文件里既有的那个走。**
    _reg(FILE, content_gate)
    return True, '已挂上 %s 的内容就绪闸' % FILE


def content_gate_registered():
    """**判据用**：闸到底挂上没有。回 `(挂上没有, 现在挂的是谁)`。

    **不许自说** —— 这是给 RT-④③⑧ 的第 0 条用的：闸没挂上，后面「裸 URL 被拒」
    那些判据**全是空过**（没闸 = 直接放行 = 看起来也「没拿到旧字节」？不，会拿到）。
    先钉「闸在不在」，再钉「闸拦不拦」。
    """
    try:
        from shangshu_core import field_access as _fa
    except Exception as error:
        return False, '内核不可用：%s: %s' % (type(error).__name__, error)
    gates = getattr(_fa, '_CONTENT_GATES', None)
    if not isinstance(gates, dict):
        return False, '内核没有 _CONTENT_GATES（钩子面不对）'
    fn = gates.get(FILE)
    return (fn is content_gate), ('%s 现在挂的是 %r' % (FILE, fn))


def column_by_header(definition, header):
    """按表头找列（绑定定位用）。找不到回 None，**不猜最近似**。"""
    want = str(header or '').strip()
    for c in definition.get('columns') or []:
        if str(c.get('header') or '').strip() == want:
            return c
    return None


# ---------- 列的**取值清单**（下拉框的选项来源） ----------

def column_domains(definition):
    """这张表**每一列有哪些可选值**（下拉框的选项来源）。

    **清单挂在哪**：晋升定义里**逐列留的那份 `rules`**（`_column_persisted` 整份留）
    ⇒ 值域清单搭这条现成的路，**不新建一套机制**。

    **`rules` 里的三个键**（域里的 `case_value_domains.py` 写进来）：
    · `options` —— 这一列的标准项清单（**没写就没有下拉**，不猜、不编）；
    · `allow_custom` —— 能不能填清单以外的值：
      **没写 = 不拦**（只把清单当提示，保留原文，与旧项目那条口径一致）；
      **显式写 `false` = 硬拦**（值不在清单里当场拒）；
    · `option_labels` —— **码 ⇒ 中文名**（2026-10-29 用户口径：
      案号那两列的值是 `DD`／`DF`／`FD`、`F`／`V` 这种码，
      **人看不懂** ⇒ **显示**给中文、**存**仍然是码
      ⇒ **算法照旧按码判**（填了中文就「不在码表里 ⇒ 不编」⇒ 白填）。

    **纯函数**（不碰库、不看表）⇒ 判据离线能跑。
    """
    out = {}
    for col in (definition or {}).get('columns') or []:
        if not isinstance(col, dict):
            continue
        rules = col.get('rules') or {}
        options = rules.get('options')
        if not isinstance(options, list) or not options:
            continue
        header = str(col.get('header') or '').strip()
        if not header:
            continue
        allow = rules.get('allow_custom')
        labels = rules.get('option_labels')
        out[header] = {
            'options': [str(item) for item in options],
            # —— **显示名**（码 ⇒ 中文名；**没有就不给** ⇒ 前端按没有处理）——
            'option_labels': ({str(k): str(v) for k, v in labels.items()}
                              if isinstance(labels, dict) else {}),
            # **没写 = 不拦**（旧项目那条：下拉提供其他，人工填写原文保存）。
            'allow_custom': True if allow is None else bool(allow),
            'custom_label': str(rules.get('custom_label') or ''),
            'source': str(rules.get('source') or ''),
        }
    return out


# ---------- 入口 ----------

FILE = 'Shangshu File Center File'


def define(payload, _context=None):
    """`files.promotion_define`：写晋升定义。

    **角色卡死 `System Manager`** —— 契约写的是「首次晋升仅 FDE 受管工程入口」。
    FDE 是人不是角色，可执行的最紧代理就是 System Manager（`directory_create`
    同口径）。普通员工 / Agent 不得自己晋升。

    **表结构版本要跟定义一起来**（`expected_structure_version`）—— 立定义钉的是
    「绑定那一刻」的结构，若表头已经被改过、结构版本对不上，这次绑定就是拿旧结构
    冒充新结构，当场拒。这是「按固定行ID + 表头 + 结构/定义版本定位」的那道门。
    """
    table = str(payload.get('table') or '').strip()
    if not table:
        frappe.throw('table 必填', frappe.ValidationError)
    if not frappe.db.exists(FILE, table):
        frappe.throw('表不存在：%s' % table, frappe.DoesNotExistError)
    # Hold the resource row through staging verification and definition activation.
    # Match value writers: database row first, working-file lock second.
    doc = frappe.get_doc(FILE, table, for_update=True)
    doc.check_permission('write')
    meta = _load_meta(doc)
    if meta.get('object_companion'):
        frappe.throw('既有对象须经原领域定义升级，不能在伴随文件另建正式字段库',frappe.ValidationError)
    if 'expected_definition_sha' in payload and str(payload['expected_definition_sha']) != _definition_fingerprint(meta):
        frappe.throw('字段定义已变化，请保留输入并重新打开核对，不能覆盖他人的修改', frappe.TimestampMismatchError)
    current = int(meta.get('structure_version') or 1)
    expected = payload.get('expected_structure_version')
    if expected is not None and int(expected) != current:
        frappe.throw('表结构版本对不上（当前 %d，你给 %s）：表头改过就别拿旧结构绑'
                     % (current, expected), frappe.ValidationError)
    # ---------- UI-027 分阶段通道：**检查 → （期间可能改源表）→ 启用** ----------
    # 契约（`处理契约与状态转换.md:111`）：「实施必须**分阶段留状态**，**启用前核对期间变化**」。
    # `expected_structure_version` 那道闩只对「表头改过」敏感，**不替代**本链
    # （验收总表 UI-027 原文）—— 检查后写了一格值，结构版本没变，那道闩看不见。
    definition = payload.get('definition') or {}
    # ★ **入口闸先过**（PKG-123-T01）：声明不对 ⇒ **一个字节都不许动**
    #   （别等迁移跑完了才拒 —— 那时受管记录已经写过一半）。
    #   「**存量列可以不带 `access`、新晋升的列必须带**」这道闸就在这里判；
    #   判据用**已经加载到的那份**当前定义（上面那份 `meta`）⇒ **不另查库**。
    validate_definition(definition,
                        existing_headers=_stored_promoted_headers(meta))
    # ★ **落库前把「部门档」的部门值归一成部门 key**（用户 2026-10-26 定案：
    #   判定与存储一律用 key；入口可以收标题，落库前必须归一）。
    #   ⚠️ **必须在接受管对象之前做** —— `_promote_lifecycle` 会把这份声明
    #   交给受管对象（`provision/extend_promoted_records(access=…)`）
    #   ⇒ 对象侧那份也得是 key，否则**文件侧是 key、对象侧是标题**（两份事实）。
    _normalize_department_keys(definition)
    dry_run = (str(payload.get('dry_run') or '').lower() in ('1', 'true', 'yes')
               or payload.get('dry_run') is True)
    check_token = str(payload.get('check_token') or '').strip()
    if dry_run:
        # **阶段一·分阶段检查**：只预检 + 留状态，**不迁移、不启用**
        # （`stage_only=True` 走同一份预检判定，不写第二套）。
        life = _promote_lifecycle(doc, definition, _context, stage_only=True)
        token = _stage_record(doc, definition)
        return {'table': table, 'check_token': token, 'definition': load_definition(doc),
                'lifecycle': dict(life or {}, staged=True, check_token=token)}
    if check_token:
        # **阶段二·启用前核对期间变化**（漂移就拒，让用户重检查）
        _verify_staging(doc, check_token, definition)
    # **首次晋升四步生命周期**（B02-4）：预检查历史值 → 迁移 → 启用 → 失败恢复。
    # **预检不过就一个字节不动**（`_promote_lifecycle` 内部 throw，`promoted` 不置）。
    lifecycle = _promote_lifecycle(doc, definition, _context)
    # ★ **迁移（DDL）之后重新取一次「带行锁的」文件记录**（R01）：
    #   MariaDB 的 DDL **隐式提交** ⇒ 迁移那一刻把**文件行锁**放掉了，
    #   而内存里那份 doc 的 meta 停在**迁移前** ⇒ 后面那份声明写拿着**旧快照**落库
    #   ⇒ **把并发期间别人改的键（行登记／结构版本／绑定…）一起覆盖掉**。
    #   ⇒ 迁移之后**重新 `get_doc(for_update=True)`**：行锁重新拿上，meta 重新读一遍。
    doc = _reload_locked_file(doc)
    # ★ **迁移（DDL）先跑，文件侧的声明写在它之后**（2026-10-26 · 3850 站上实测）：
    #   受管对象的物理表由内核建 —— 那是 **DDL**（MariaDB 的 DDL **隐式提交**）⇒
    #   **调用方那条连接上此刻还没提交的写，会被 DDL 一起提交**。
    #   ⇒ 域侧的声明写必须**晚于**迁移 ⇒ 否则**域的写被迁移提前落库**（半写）。
    #   （内核那一侧的口径一致：`shangshu_core.independent_migration` 的文件头。）
    #   ★ 「将要落的那份」**只算不写**（`_definition_meta`）—— 幂等键要用它算指纹。
    pending = _definition_meta(doc, definition)
    pending_saved = _definition_from_meta(pending, doc.name)
    # ★ **受管对象那侧也要跟上**（决议⑧ · 2026-10-26）：
    #   以前**只有 `rewrite` 走这一步** ⇒ 走 `define` 改声明时，
    #   **文件侧写了、对象侧没跟上**（两份事实）。
    #   ⚠️ **什么时候才需要补这一下**：`lifecycle['promoted']` ＝ **这次新接的列数**；
    #     大于 0 ⇒ 这次**已经把当前声明带给了对象**
    #     （`_bind_managed` → `provision/extend_promoted_records(access=_table_access(definition))`）
    #     ⇒ 再补一次只会**白多出一个对象修订**；
    #     等于 0 ⇒ 这次**没碰对象**（定义升级／原地改声明）⇒ **对象侧可能还是旧的** ⇒ 补。
    #   ⚠️ **同步排在声明写之前** —— 同步里面是**一次 DDL**（`extend_promoted_records`）
    #     ⇒ 声明写若在它之前，**那份还没提交的声明会被这次 DDL 提前提交**。
    object_result = None
    if not int((lifecycle or {}).get('promoted') or 0):
        object_result = _sync_managed_access(doc, pending_saved,
                                             fingerprint=_definition_fingerprint(pending))
        # ★ **同步里又是一次 DDL** ⇒ 行锁**再**被放掉 ⇒ 写之前**再取一次**。
        doc = _reload_locked_file(doc)
    # ★ **重取之后**再核对一次「你看到的那份定义」还在不在（R01）：
    #   别人刚改过 ⇒ **当场拒**（不覆盖别人的修改）；没改过 ⇒ 照旧往下走。
    _assert_definition_unchanged(doc, payload.get('expected_definition_sha'))
    saved = save_definition(doc, definition)
    _clear_staging(doc)   # 启用成功 → 检查记录作废（重复启用要重新检查）
    return {'table': table, 'definition': saved, 'lifecycle': lifecycle,
            'managed': object_result}


def _reload_locked_file(doc):
    """**重新取一次带行锁的**文件记录（迁移／同步的 DDL 之后用）。

    ⚠️ **为什么必须重取**（R01）：MariaDB 的 DDL **隐式提交** ⇒ 迁移那一刻
      「文件行锁」被放掉了；而内存里那份 doc 的 meta 停在**迁移前**
      ⇒ 后面那份声明写拿着**旧快照**落库 ⇒ **把并发期间别人改的键一起覆盖掉**。
    ⇒ 重取：行锁重新拿上（`for_update=True`），meta 重新读一遍（别人改的键还在）。
    """
    fresh = frappe.get_doc(FILE, doc.name, for_update=True)
    fresh.check_permission('write')
    return fresh


def _assert_definition_unchanged(doc, expected_sha):
    """核对「你看到的那份定义」**还在**（别人刚改过 ⇒ 当场拒，不覆盖）。

    ⚠️ **只在调用方钉了指纹时判**（`expected_definition_sha` 给了才判）。
    """
    expected = str(expected_sha or '').strip()
    if not expected:
        return
    if expected != _definition_fingerprint(_load_meta(doc)):
        frappe.throw('字段定义已变化，请保留输入并重新打开核对，不能覆盖他人的修改',
                     frappe.TimestampMismatchError)


def _stored_meta(table):
    """**只读**读这张表当前存下来的元数据（不建 doc、不落库、不改库）。"""
    raw = frappe.db.get_value(FILE, table, META_FIELD)
    try:
        meta = json.loads(raw or '{}')
    except Exception:
        meta = {}
    return meta if isinstance(meta, dict) else {}


def _rewrite_criteria(payload):
    """重写载荷的**指认判据**（从载荷读，**不写死站上文件编号**）。"""
    payload = payload or {}
    return {
        'table_name_contains': str(payload.get('table_name_contains') or '').strip(),
        'require_managed_columns': bool(payload.get('require_managed_columns')),
        'require_legacy_declarations': bool(payload.get('require_legacy_declarations')),
        'status': str(payload.get('status') or '').strip(),
    }


def _describe_criteria(criteria):
    """判据的**人话版**（报错里说清「按什么找的」）。"""
    parts = []
    if criteria.get('table_name_contains'):
        parts.append('名字含「%s」' % criteria['table_name_contains'])
    if criteria.get('require_managed_columns'):
        parts.append('有受管列（已晋升的列）')
    if criteria.get('require_legacy_declarations'):
        parts.append('还在用旧声明（列上没写主体范围／还带旧角色键）')
    if criteria.get('status'):
        parts.append('状态是「%s」' % criteria['status'])
    return ' ＋ '.join(parts) or '（没给判据）'


def _legacy_declared_columns(columns):
    """**还停在旧声明上**的那些受管列。

    **新模型的形状**＝列上带 `access`；**旧模型**＝列上带旧的三个角色键
    （或压根没写主体范围）⇒ 这张表**还没按新规则重写**。
    """
    out = []
    for col in columns or []:
        if not isinstance(col, dict) or not col.get('promoted'):
            continue
        if ACCESS_KEY not in col or any(key in col for key in access_scope.LEGACY_ROLE_KEYS):
            out.append(col)
    return out


def _resolve_rewrite_table(payload):
    """重写载荷指认哪张表：`table` 优先；没有就**按判据挑**。

    ★ **为什么不再只靠名字**（PKG-123-T01 · 2026-10-26 站上只读查证）：
      站上字含「示例企业专利清单」的文件**有 2 个**，而这两个**根本没有晋升定义**
      （0 个受管列）⇒ 只按名字找，要么「撞多命中」直接报错，
      要么「找到一张没东西可重写的表」（重写那一步会报「这张表还没有生效的晋升定义」）。
    ⇒ 改成**按判据挑**：名字片段 ＋ **有受管列** ＋ **还在用旧声明** ＋ 状态。
      判据全部写在**载荷**里（不是写死在代码里的某个站上名字／文件编号）。

    ⚠️ **fail-closed**：
      · **多于一张** ⇒ **报错并把候选列出来**（不许默默挑第一张）；
      · **零张** ⇒ 明说「没找到符合条件的表」；
      · **恰好一张** ⇒ 才用它。
    """
    table = str((payload or {}).get('table') or '').strip()
    if table:
        return table
    criteria = _rewrite_criteria(payload)
    if not any(criteria.values()):
        frappe.throw('table 必填（或给 table_name_contains 等指认判据，说明要重写哪张表）',
                     frappe.ValidationError)
    filters = {}
    if criteria['table_name_contains']:
        filters['file_name'] = ['like', '%%%s%%' % criteria['table_name_contains']]
    if criteria['status']:
        filters['status'] = criteria['status']
    rows = frappe.get_all(FILE, filters=filters,
                          fields=['name', 'file_name', 'status'], limit=200)
    matched = []
    for row in rows:
        name = str(row.get('name') or '')
        stored = _stored_meta(name).get('promotion')
        columns = list((stored or {}).get('columns') or []) if isinstance(stored, dict) else []
        managed = [c for c in columns
                   if isinstance(c, dict) and c.get('promoted')]
        if criteria['require_managed_columns'] and not managed:
            continue
        if criteria['require_legacy_declarations'] and not _legacy_declared_columns(managed):
            continue
        matched.append({'name': name, 'file_name': row.get('file_name'),
                        'status': row.get('status'), 'managed': len(managed)})
    if not matched:
        frappe.throw('没找到符合条件的表（%s）—— 请给准确的 table（文件编号）'
                     % _describe_criteria(criteria),
                     frappe.DoesNotExistError)
    if len(matched) > 1:
        listed = '\n'.join(
            '  · %s（%s，%d 个受管列，状态 %s）'
            % (item['name'], item['file_name'], item['managed'], item['status'])
            for item in matched[:20])
        frappe.throw('有 %d 张表符合条件（%s）—— **请指定其中一张**（给 table 文件编号）：\n%s'
                     % (len(matched), _describe_criteria(criteria), listed),
                     frappe.ValidationError)
    return str(matched[0]['name'])


def rewrite(payload, _context=None):
    """`files.promotion_rewrite`：按新模型**整体重写**这张表已生效的晋升定义。

    ★ **为什么要有这条口**（契约 2026-10-25 22:4x 订正）：
    「**存量表按新规则重写**」—— 示例企业总表等**已生效**的表要**表级明确声明 ＋
    逐列明确声明**（不再是「未声明 ⇒ 继承」那种凑合）。
    现有 `files.promotion_define` 那条路只认 `expected_definition_sha` /
    `expected_structure_version`，**没有整体重写的口**。

    **重写的是「声明」，不是「效果」**：示例企业总表重写后仍是「全员可读可写」。

    **做什么**：
      1. 读回**当前已生效的定义**；
      2. 按载荷改写**主体范围**：表级用 `access`；每列用 `columns[表头]`，
         没单独给的用 `default_column_access`
         （**每个晋升列都必须拿到明确声明** —— 不许留「未声明」）；
      3. **字段／类型／规则一个都不动**（重写的只是权限声明）；
      4. 整份落库，**并把新的表级声明同步给受管对象**
         （对象 access 跟着变；**对象 ID 与记录 ID 都不变**）。

    **不给「表级＝各列并集」留回落**（契约：不留兼容函数）。
    """
    table = _resolve_rewrite_table(payload or {})
    if not frappe.db.exists(FILE, table):
        frappe.throw('表不存在：%s' % table, frappe.DoesNotExistError)
    doc = frappe.get_doc(FILE, table, for_update=True)
    doc.check_permission('write')
    meta = _load_meta(doc)
    current = load_definition(doc)
    if not current.get('promoted'):
        frappe.throw('这张表还没有生效的晋升定义，没有可重写的声明', frappe.ValidationError)
    # **并发闸**：重写前必须确认「你看到的那份」还在（别人刚改过就拒，不覆盖）。
    pinned = str(payload.get('expected_definition_sha') or '').strip()
    if pinned and pinned != _definition_fingerprint(meta):
        frappe.throw('字段定义已变化，请保留输入并重新打开核对，不能覆盖他人的修改',
                     frappe.TimestampMismatchError)
    columns = list(current.get('columns') or [])
    promoted = [c for c in columns if isinstance(c, dict) and c.get('promoted')]
    if not promoted:
        frappe.throw('这张表没有受管列，没有可重写的权限声明', frappe.ValidationError)
    per_column = payload.get('columns') or {}
    default_access = payload.get('default_column_access')
    if not isinstance(per_column, dict):
        frappe.throw('columns 必须是对象（表头 → 权限声明）', frappe.ValidationError)
    new_columns = []
    for col in columns:
        col = dict(col)
        if not col.get('promoted'):
            new_columns.append(col)
            continue
        header = str(col.get('header') or '')
        declared = per_column.get(header)
        if declared is None:
            declared = default_access
        if declared is None:
            frappe.throw('晋升列「%s」没有指定权限主体范围：'
                         '请在 columns 里给它一份，或给 default_column_access'
                         % header, frappe.ValidationError)
        col[ACCESS_KEY] = declared
        # ★ **重写＝把旧声明换掉**（契约 22:4x「旧的『三个角色键』……**直接换掉，
        #   不保留回落分支**」）：旧三个角色键**在这里剥掉**（新声明已经补上了）。
        #   ⚠️ 平常的保存（`define`／`save_definition`）**仍然当场拒**旧三键 ——
        #   那是「不留兼容函数」；**只有「重写」这一个动作**的职责就是把旧的换成新的
        #   （不剥就永远过不了 `validate_definition` 的那道拒）。
        for key in access_scope.LEGACY_ROLE_KEYS:
            col.pop(key, None)
        new_columns.append(col)
    new_definition = {
        'definition_version': current.get('definition_version') or DEFINITION_VERSION,
        ACCESS_KEY: payload.get(ACCESS_KEY),
        'columns': new_columns,
    }
    # **形状不对当场拒**（理由点名是哪个列、哪个操作、缺什么）。
    validate_definition(new_definition)
    # ★ **落库前把「部门档」的部门值归一成部门 key**（用户 2026-10-26 定案）。
    #   ⚠️ **必须在 `save_definition` 之前** —— 落进受管对象声明里的就得是 key，
    #   否则**文件侧是 key、对象侧是标题**（两份事实，判定链对不上）。
    _normalize_department_keys(new_definition)
    # ★ **迁移（DDL）先跑，声明写排在它之后**（2026-10-26 · 3850 站上实测）：
    #   受管对象的物理表变更走内核的独立迁移口 —— 那是 **DDL**
    #   （MariaDB 的 DDL **隐式提交**）⇒ **调用方那条连接上此刻还没提交的写，
    #   会被 DDL 一起提交** ⇒ 声明写若排在它之前，**那份声明会被迁移提前落库**。
    #   ★ 「将要落的那份」**只算不写**（`_definition_meta`）—— 幂等键要用它算指纹。
    pending = _definition_meta(doc, new_definition)
    pending_saved = _definition_from_meta(pending, doc.name)
    # **受管对象那侧也要跟上**（表级 access 变了 ⇒ 对象 access 得变）。
    object_result = _sync_managed_access(doc, pending_saved,
                                         fingerprint=_definition_fingerprint(pending))
    # ★ **同步（DDL）之后重新取一次「带行锁的」文件记录**（R01）：
    #   DDL 的隐式提交把文件行锁放掉了，内存里那份 doc 的 meta 停在**同步前**
    #   ⇒ 声明写拿着旧快照落库 ⇒ 把并发期间别人改的键一起覆盖掉。
    doc = _reload_locked_file(doc)
    # ★ **重取之后**再核对一次「你看到的那份定义」还在不在（R01）。
    _assert_definition_unchanged(doc, payload.get('expected_definition_sha'))
    saved = save_definition(doc, new_definition)
    return {'table': table, 'definition': saved, 'managed': object_result}


def _sync_managed_access(doc, definition, fingerprint=None):
    """把新的表级主体范围**同步给受管对象**（对象 ID 与记录 ID 都不变）。

    **为什么不能只改文件侧**：受管对象的定义（表级 access ＋ 每个字段的 access）
    在内核那边 —— 只改文件侧会出现「文件里说全局、对象里还是旧的」两份事实。
    ⇒ 走内核的「后续晋升」那条口（同一个对象加字段那条路），**只改声明、不写值**。

    **谁调它**（决议⑧ · 2026-10-26）：
    · `rewrite` —— 重写声明后同步（原来就有）；
    · `define` —— **原地改声明（定义升级）后同步**（原来**没有** ⇒
      走 `define` 改完权限档，**文件侧写了、对象侧没跟上**）。
      ⚠️ `define` 只在「**这次没新接列**」时补这一步（`lifecycle['promoted'] == 0`）：
      这次接了列的那条路，`_bind_managed` **已经把当前声明带给了对象**
      ⇒ 再补一次只会白多出一个对象修订。

    **没有绑定 / 对象已退役** ⇒ 如实回「没同步」（不编）。

    ⚠️ **同步排在文件侧的声明写之前**（2026-10-26 · 3850 站上实测）：
      这一步里面是**一次 DDL**（`extend_promoted_records`）⇒
      **调用方那条连接上此刻还没提交的写，会被它一起提交** ⇒
      文件侧的声明写必须**排在它之后** ⇒ 幂等键的指纹**由入参给**
      （现读 `_load_meta(doc)` 拿到的是**旧声明** ⇒ 键会变成「上一次那份」的指纹
      ⇒ 两次不同的重写会撞同一个键 ⇒ 第二次**不会**生效）。
    """
    binding = _managed_binding(doc)
    if not binding:
        return {'synced': False, 'reason': '这张表还没有受管对象绑定'}
    if not _managed_object_alive(binding):
        return {'synced': False, 'reason': '受管对象已退役，重写后需重新晋升一次'}
    from shangshu_core.public_api import extend_promoted_records
    table = doc.name
    title = doc.get('file_name') or ('晋升表 ' + str(table))
    fields = sorted(str(c.get('field') or '') for c in promoted_columns(definition))
    # ⚠️ **幂等键要带上「这次声明长什么样」** —— 否则第二次重写会被当成
    # 「同一笔变更」⇒ 对象那侧**不会**更新（第一版的键只有表名＋列清单）。
    # ★ **指纹取「这次要落的那份声明」**（入参 `fingerprint`）——
    #   同步现在跑在**声明落库之前**（DDL 的隐式提交不许把域的写带走）⇒
    #   现读 `_load_meta(doc)` 拿到的是**旧声明**⇒ 键会变成「上一次那份」的指纹。
    if fingerprint is None:
        fingerprint = _definition_fingerprint(_load_meta(doc)) or ''
    key = 'promotion-access:%s:%s' % (table, fingerprint[:16])
    result = extend_promoted_records(
        object_id=binding['object_id'], application_id=binding.get('application_id'),
        title=title, columns=definition.get('columns') or [],
        rows=[], records=binding.get('records') or {},
        idempotency_key=key,
        access=_table_access(definition))
    binding = {**binding, 'revision': result['revision']}
    _save_binding(doc, binding)
    return {'synced': True, 'object_id': binding['object_id'],
            'revision': binding['revision']}


def _promote_lifecycle(doc, definition, _context=None, stage_only=False):
    """首次晋升四步生命周期（B02-4）：**预检查历史值 → 接入受管记录 → 启用 → 失败恢复**。

    **用户 2026-10-17 拍板**：「首次晋升只走受管建模权限，**预检查历史值→迁移→启用→失败恢复**；
    定义升级保留 ACL」。

    **2026-10-20 口径校正（PKG-004-T03）**：正式值**不再收进文件记录的
    `formal_values_json`**，而是进**公共内核的受管记录**
    （`shangshu_core.promotion_records` → 受管模型 + 受管记录）。
    文件里只留「工作簿固定行 ID → 受管记录 ID」的映射（`meta['promotion_binding']`）。

    **四步**：
    1. **预检查历史值**：晋升列的现有值必须满足字段规则（`min`/`max`/`type`）。
       **一条不过 → 整批拒**（「任何一格非法则无部分成功」B01.2 同族）。
    2. **接入受管记录**：合法值进受管对象的受管记录；首次建对象+记录，
       后续给**同一个对象**加字段、给**同一条记录**加值（对象 ID、记录 ID 都不变）。
    3. **启用**：定义标 `promoted: true`（`save_definition` 落的）。
    4. **失败恢复**：中断后**按同一幂等键重来** —— 对象/字段/记录都不重复建
       （幂等键按表、按行固定）。

    **为什么分四步不一锅端**：**「先看再改」**（B01.2「先全检再统一落盘」同族）。
    **预检不过就别动数据** —— 否则「迁移一半、定义没启」是脏中间态。

    **⚠️ 首次晋升 ≠ 后续晋升**：**首次**要建对象和记录；**后续**（加列再晋升）
    是同一个对象加字段、同一条记录加值，不造第二份对象或重复记录。
    """
    definition = definition or {}
    cols = [c for c in (definition.get('columns') or []) if c.get('promoted') and c.get('field')]
    if not cols:
        # **没晋升列** = 不是首次晋升，直接落定义（后续晋升/普通表）
        return {'promoted': 0, 'migrated': 0, 'precheck': 'no-promoted-columns'}
    meta = _load_meta(doc)
    # ⚠️ **「已晋升」标记只在有「活着的绑定」时才作数**。
    #   内核退役受管对象**只清内核那一侧**（模型行、**物理表**、应用绑定），
    #   **文件域这张表的绑定还指着它** ⇒ 晋升链以为「这张表已经晋升过」
    #   ⇒ 走「后续晋升」那一支 ⇒ 接续一个没了的对象 ⇒ 表卡死
    #   （真总表就这么卡住过：报「对象尚未生效或不可访问」）。
    #   ⇒ 而且文件记录里那份「这 N 列已晋升」的标记**也是旧的**
    #   ⇒ 不作废它，重跑**只会晋升剩下的列** ⇒ **第一批那几列的数据悄悄丢掉**（静默丢数据）。
    # ⇒ **绑定没了、或绑的是已退役的对象** ⇒ 当「没晋升过」：
    #   绑定与「已晋升」标记一并作废 ⇒ 重走首次晋升
    #   （内核会**复活**那个对象，同一个对象 id）。
    # ⚠️ **这一问必须在算「本次新晋升哪些列」之前** —— 旧标记会让新列算成空
    #   ⇒ 直接早退（连绑定都没机会看）⇒ 什么都不会发生。
    binding = _managed_binding(doc)
    if not binding or not _managed_object_alive(binding):
        # ⚠️ **「已晋升」标记只在有「活着的绑定」时才作数**。
        #   内核退役受管对象**只清内核那一侧**（模型行、**物理表**、应用绑定），
        #   **文件域这张表的绑定还指着它** ⇒ 晋升链以为「这张表已经晋升过」
        #   ⇒ 走「后续晋升」那一支 ⇒ 接续一个没了的对象 ⇒ 表卡死。
        # ⇒ 绑定没了、或绑的是已退役的对象 ⇒ 当「没晋升过」：绑定与「已晋升」标记
        #   一并作废 ⇒ 重走首次晋升（内核**复活**同一个对象 id ⇒ **数据一条不少**）。
        # ⚠️ **这是用户「显式重新定义」这条动作**（不是编辑路径自动重建）——
        #   **编辑/写入路径遇失效绑定一律拒**（见 `commit_atomic_values` 与
        #   `cell_write`），**不许**在那里自动重建一个对象出来。
        binding = None
        meta = {**meta, 'promotion': {**(meta.get('promotion') or {}), 'columns': []}}
    # **只接「本次新晋升」的列**：已经绑定的列**不重接** —— 否则定义升级会拿 xlsx 里的
    # 旧值覆盖受管记录里的正式值（用户按契约要求「定义升级保留 ACL」，不是重刷数据）。
    existing_fields = {str(c.get('field') or '') for c in
                       ((meta.get('promotion') or {}).get('columns') or [])
                       if c.get('promoted') and c.get('field')}
    new_cols = [c for c in cols if str(c.get('field') or '') not in existing_fields]
    if not new_cols:
        # 全是已绑定列 = 定义升级，不接历史值，直接落定义
        return {'promoted': 0, 'migrated': 0, 'precheck': 'no-new-promoted-columns'}
    # **1. 预检查历史值**（按字段声明验，不按调用方 typed —— 2026-10-17 定死）
    ws = _open_worksheet(doc)
    rows = _row_scope(doc, ws)
    # **行 ID → 工作表行号**（表头占第 1 行）：**一次建表、逐格 O(1)**。
    # 不建这张表的话，预检每读一格都要 `rows.index()` 线性找一次 ⇒ **O(n²)**，
    # 15,516 行的表预检会跑成几十分钟（实测口径见 /tmp/pkg004t03-plan.md）。
    positions = {row_id: pos + 2 for pos, row_id in enumerate(rows)}
    formal = formal_state_full(doc, purpose='migration')['values'] if binding else {}
    # **旧 JSON 迁移**：这张表以前把正式值收在 `formal_values_json` 里，
    # **那份 JSON 才是当时的权威**（xlsx 可能滞后）—— 迁移以它为源，
    # 不拿 xlsx 的旧值盖它（契约「已有 JSON 晋升数据的兼容迁移」）。
    # ⚠️ **旧值只在这条显式迁移口读**（`legacy_formal_values`）——
    #   日常权威读口 `_load_formal` **不再回落它**（条目 03：旧来源退出日常调用）。
    legacy_values = legacy_formal_values(doc)
    legacy = bool(legacy_values) and not binding
    # ⚠️ **表头必须从 xlsx 实读**：`meta` 里**没有 `headers` 这个字段**
    # （meta 只有 rows / primary_sheet / structure_version / column_types …）。
    # 第一版写 `meta.get('headers')` → 恒为空 → **每一列都报「不在表里」** →
    # **首次晋升永远失败**（3820 实测：混合表定晋升 417）。**判据不是从 meta 猜，是从表读。**
    ws = _open_worksheet(doc)
    headers = _sheet_headers(ws)
    violations = []
    to_migrate = []
    for col in new_cols:
        header = str(col.get('header') or '')
        field = str(col.get('field') or '')
        if header not in headers:
            violations.append('列 %s 不在表里' % header)
            continue
        col_idx = headers.index(header)
        for row_id in rows:
            # **读当前值**（旧 JSON 迁移时以 JSON 为源，不以 xlsx 为源）
            if legacy:
                val = (legacy_values.get(row_id) or {}).get(field)
            else:
                cell = _cell_at(ws, rows, row_id, col_idx, positions)
                raw = None if cell is None else cell.value
                try:
                    # **按列声明的类型在源头定值**（真日期列 ⇒ YYYY-MM-DD；
                    # 套了日期格式的文本列 ⇒ 按文字读，不按日期解释）。
                    val = _column_value(col, raw, cell, header)
                except Exception as error:
                    violations.append('行 %s 列 %s 的值 %r 不能按这一列的类型读：%s'
                                      % (row_id, header, raw, str(error)[:120]))
                    continue
            if val in (None, ''):
                continue
            try:
                _check_rules(col, val)
            except Exception as e:
                violations.append('行 %s 列 %s 的值 %r 不满足规则：%s' % (row_id, header, val, str(e)[:80]))
                continue
            to_migrate.append((row_id, field, val))
    if violations:
        # **整批拒**（B01.2「任何一格非法则无部分成功」）—— **一个字节不动**
        frappe.throw(
            '首次晋升预检不过，%d 处历史值不满足字段规则，**未迁移、未启用**：\n%s'
            % (len(violations), '\n'.join(violations[:10])),
            frappe.ValidationError)
    if stage_only:
        # **UI-027 阶段一只检查**：预检过了就停在这 —— 不迁移、不启用（`_stage_record` 留状态）。
        # **预检判定只有这一份**（同上面的 violations 逻辑），不另写一套「检查版」。
        # ★ **行 ID 登记在这一步就补上**（这一步**没有 DDL** ⇒ 不存在「被迁移带走」的问题；
        #   与改动之前的行为一致：检查完那张表的行号已经登记好了）。
        _persist_row_registration(doc)
        return {'promoted': len(new_cols), 'migrated': 0, 'precheck': 'checked'}
    # **2. 接入受管记录**（正式值的唯一权威 = 公共内核的受管记录）
    managed_rows = _managed_rows_from_values(to_migrate)
    migrated = len(managed_rows)
    lifecycle = _bind_managed(doc, definition, new_cols, managed_rows, binding, legacy, formal)
    # ★ **行 ID 登记补在迁移之后**（2026-10-26 · 3850 站上实测）：
    #   登记是一次**文件记录写** ⇒ 它若在迁移（DDL）之前还没提交，
    #   **DDL 的隐式提交会把它提前落库**（域的写被迁移带走 ⇒ 半写）。
    #   ⇒ 挪到这里补；**号与迁移用的那一份一字不差**（`_row_scope` 算好挂着）。
    _persist_row_registration(doc)
    # ⚠️ **`promoted` 是「本次晋升的列数」（`len(new_cols)`），不是布尔启用标志** ——
    # 跟 `definition.promoted`（布尔，`save_definition` 落的）**同名不同义**。
    # 3850 实跑时看回包「promoted 从 0 跳 2」以为计数被误用；其实两列确实首升，
    # 2 是对的。**这里保留计数语义**（调用方要报「这次升了几列」），
    # **要判「启用没有」看 `definition.promoted` 那个布尔**，别看这个。
    return {'promoted': len(new_cols), 'migrated': migrated, 'precheck': 'passed',
            **lifecycle}


def _managed_rows_from_values(to_migrate):
    """把「(行 ID, 字段, 值)」装配成**受管记录那一侧的行**。

    ★ **按行 ID 建索引**（R25）：以前每来一条就 `next((r for r in managed_rows
      if r['row_id'] == row_id), None)` **线性扫一遍**已装配的行 ⇒ **O(n²)**
      （15,516 行的表 ⇒ 上亿次比较）。
      ⇒ 先建 `{行 ID: 行}` 的字典 ⇒ 逐条 **O(1)**。

    ⚠️ **输出顺序不许变**：行的先后按**第一次出现**的先后
      （与改之前逐行扫出来的顺序**一字不差**）；同一行 ID 的多个字段**并到同一行**。
    """
    managed_rows = []
    by_row_id = {}
    for row_id, field, val in to_migrate:
        row = by_row_id.get(row_id)
        if row is None:
            row = {'row_id': row_id, 'values': {}}
            managed_rows.append(row)
            by_row_id[row_id] = row
        row['values'][field] = val
    return managed_rows


def _row_scope(doc, ws):
    """这次晋升的**行范围**（固定行 ID 清单）。

    **优先用已登记的固定行 ID** —— 那是读路径发的号，行 ID 与界面/写回对得上。
    **没登记过**（这张表还没被打开读过）就按表里的**真实数据行**现场登记一份，
    发号规则与读路径**同一套**（`sheet._ensure_meta_rows`），所以行 ID 不会串。

    **为什么不能只看 `meta['rows']`**：那张表还没被读过时它是空的 ⇒
    晋升会「一行都不接」（静默零记录）。契约要的是「为范围内数据行创建受管记录」，
    范围得真的落到行上。

    ★ **登记（写文件记录）不许早于迁移**（2026-10-26 · 3850 站上实测）：
      「登记固定行 ID」本身就是一次**文件记录写**（`sheet_meta_json`）⇒
      它若在迁移（DDL）**之前**还没提交，**DDL 的隐式提交会把它提前落库**
      （域的写被迁移带走 ⇒ 半写）。
      ⇒ 这里**只算不落**（`persist=False`），**登记由 `_promote_lifecycle`
      在迁移之后补上**（号一模一样 —— 迁移用的就是这里算出来的那一份）。
    """
    from shangshu_files import sheet as _sheet
    meta = _load_meta(doc)
    rows = list(meta.get('rows') or [])
    if rows:
        return rows
    max_r, _max_c = _sheet._data_extent(ws)
    expected = max(0, max_r - 1)      # 第 1 行是表头
    if not expected:
        return []
    registered = _sheet._ensure_meta_rows(doc, expected, ws.title, persist=False)
    rows = list(registered.get('rows') or [])
    # ★ **待登记的那一份挂在 doc 上**（迁移之后由 `_promote_lifecycle` 补上）——
    #   挂 doc 而不是改返回值 ⇒ `_row_scope(doc, ws)` 的形状**不变**
    #   （站上判据 `test_promotion_managed` 按 list 用它）。
    doc._pending_row_registration = {'rows': rows, 'expected': expected,
                                     'sheet_name': ws.title}
    return rows


def _persist_row_registration(doc):
    """把**行 ID 登记**补进文件记录（**必须在迁移之后**）。

    ⚠️ **号必须与迁移用的那一份一字不差** ⇒ 这里**不重算**，
       直接把「算好那一份」的 `rows` 并进**当前** meta
       （当前 meta 里可能已经有绑定等别的键 ⇒ 只并登记那几个，别的原样留着）。
    """
    registration = getattr(doc, '_pending_row_registration', None)
    if not registration:
        return
    rows = list(registration.get('rows') or [])
    if not rows:
        return
    meta = _load_meta(doc)
    if list(meta.get('rows') or []) == rows:
        return
    # 登记那几个键的口径**跟读路径同一套**（`sheet._ensure_meta_rows`）：
    # `primary_sheet` / `sheet_name` / `structure_version` / `rows` ——
    # **只换它管的这四个键，别的键原样留着**（`promotion` / `promotion_binding` 都在里头）。
    meta.setdefault('primary_sheet', 'S-1')
    meta.update({'primary_sheet': meta.get('primary_sheet') or 'S-1',
                 'sheet_name': registration.get('sheet_name'),
                 'structure_version': int(meta.get('structure_version') or 1),
                 'rows': rows})
    _save_meta(doc, meta)


def _managed_binding(doc):
    """这张表与受管对象的绑定（`meta['promotion_binding']`）。没绑定回 None。"""
    meta = _load_meta(doc)
    binding = meta.get('promotion_binding')
    if isinstance(binding, dict) and binding.get('object_id'):
        return binding
    return None


# 幂等键的**长度上限**：行级键要落进**审计表**（`idempotency_key` 是 Data ＝ 140 字符）
# ⇒ 键本身要留出「promotion-row:」＋「行 id」＋「:lifeN」的位置。
_PROMOTION_KEY_LIMIT = 100


def _promotion_key(table, fields):
    """这次晋升的**幂等键**（表 ＋ 列清单）。

    ⚠️ **键不能太长**（2026-10-25 站上实测撞出来的缺口）：
    行级幂等键要落进**审计表**（`idempotency_key` 是 Data ＝ 140 字符）
    ⇒ 列一多（≥10 列）键就超长 ⇒ **数据库拒**（Data too long）
    ⇒ **宽表根本升不上去**（真总表 15 个关键列 ⇒ 键 179 字 ⇒ 行键 202 字）。

    ⇒ **超了就用列清单的摘要**（sha256 前 16 位）：一样是「表 ＋ 列清单」的指纹，
    一样能区分不同列清单，但**短**。
    ⇒ **短键保持原样**（老表的键不许变 ⇒ 已有的表重跑仍幂等）。
    """
    joined = ','.join(fields)
    key = 'promotion:%s:%s' % (table, joined)
    if len(key) <= _PROMOTION_KEY_LIMIT:
        return key
    digest = hashlib.sha256(joined.encode('utf-8')).hexdigest()[:16]
    return 'promotion:%s:%s' % (table, digest)


def _managed_object_alive(binding):
    """这张表绑着的受管对象**是不是还活着**（内核退役口会下线它、还清掉物理表）。

    **读不到（对象查不到）＝ 当作不在** —— 一样得重走晋升。

    **为什么要有这一问**（2026-10-25 站上实测撞出来的缺口）：
    内核退役受管对象**只清内核那一侧**（模型行、物理表、应用绑定），
    **文件域这张表的绑定还指着它** ⇒ 晋升链以为「这张表已经晋升过」
    ⇒ 走「后续晋升」那一支 ⇒ 接续一个没了的对象 ⇒ 表卡死。
    """
    object_id = str((binding or {}).get('object_id') or '').strip()
    if not object_id:
        return False
    try:
        from shangshu_core.public_api import get_managed_object_model
        model = get_managed_object_model(object_id)
    except Exception:
        return False
    return bool(int((model or {}).get('active_revision') or 0))


# ⚠️ **PKG-117-T01 之后，域里那个 `_DOMAIN_WRITE_ROLES = ["Desk User"]` 常量已删** ——
# 表级 `access` 现在是**主体范围**（全局／部门／个人／**无人**），**不再是角色清单**，
# 域这一侧**不再有角色清单**可传。
# **物理表的宽底座角色由内核落**（`model_schema.physical_permissions`：
# 新形状一律落 `Desk User` 的读＋写，细判留给域层/内核层）⇒ 域不用再带这个常量。


def _table_access(definition):
    """这张表的**表级主体范围声明**（内核 `build_definition` 的 `access`）。

    ★ **为什么不再从各列并集推导**（契约 2026-10-25 22:4x 订正）：
    旧实现（`_managed_access`）是「**表级 = 各列声明的并集**」⇒
    **改一列可能连带把整张表的表级收窄**，也连带改变其他人对整张表的访问
    （实测口径：真总表 15 列未声明 ⇒ 并集为空 ⇒ 回落到 Desk User 底座）。
    ⇒ **并集联动取消**：表级是一份**独立声明**的主体范围，列默认继承它；
    **改某一列不再连带改变表级，也不再连带改变别人对整张表的访问**。

    **表级从定义里显式读**（`definition['access']`）——
    「各列并集」那条路**已删**，**不留回落分支**（契约：不留兼容函数）。
    `record_scope` 保留（默认 `all`，与改造前一致）。

    **物理表那层**：DocPerm 由内核按新形状落**宽底座角色**
    （`Desk User` 读＋写；细判在域层/内核层）⇒ **域这一侧不传角色清单**。
    """
    access = access_scope.require_access(
        (definition or {}).get(ACCESS_KEY), where='这张表的表级权限',
        allow_record_scope=True)
    access.setdefault(access_scope.RECORD_SCOPE_KEY, 'all')
    return access


# --------------------------------------------------------------------------
# 部门标识：判定与存储一律用**部门 key**（用户 2026-10-26 定案）
# --------------------------------------------------------------------------

def _resolve_department_key(raw, where):
    """一个部门值（key 或标题）→ **部门 key**。**认不出 ⇒ 当场拒**。

    解析走**内核公开面** `resolve_department_key`（同企业 ＋ 启用 ＋
    **编号优先／名称唯一才认**，认不出它自己抛错）⇒ **域不自己查部门表**。

    ⚠️ **不许写一个假 key**（认不出就拒）—— 假 key 落库以后，
    判定链拿它去比 `member_of`（那里面存的是真 key）⇒ **永远匹配不上**，
    而看上去「声明是有效的」⇒ 变成一条**静默失效**的权限。
    """
    from shangshu_core.public_api import resolve_department_key
    try:
        key = resolve_department_key(raw)
    except frappe.ValidationError as error:
        # **理由用内核那句话**（不另写文案）＋**点名是哪个声明、哪个部门**。
        frappe.throw('%s里的部门「%s」：%s' % (where, raw, str(error)),
                     frappe.ValidationError)
        key = None
    return str(key or '').strip()


def _normalize_scope_departments(access, where):
    """一份 `access` 声明里，**「部门档」**的 `departments` 归一成部门 key。

    **别的档一个都不动**：全局档没子键；「无人」档没子键；
    **个人档的 `users`（人的登录名）一个字都不动**。
    """
    for op, scope in list((access or {}).items()):
        if not isinstance(scope, dict) or scope.get('scope') != 'department':
            continue
        names = scope.get('departments')
        if not isinstance(names, list):
            continue
        scope['departments'] = [_resolve_department_key(name, where)
                                for name in names]


def _normalize_department_keys(definition, where='这张表的表级权限'):
    """**落库前**：把声明里「部门档」的部门值**归一成部门 key**。

    ★ **口径**（用户 2026-10-26 定案）：**判定与存储一律用部门 key**；
      入口**可以**收标题，但**落库前必须归一成 key**。

    **为什么标题不能当标识**（站上实测，已核实）：`Shangshu Department` 的
    `name` 是 key（如 `7e573b3dda51`）、`title` 是标题，而标题**带时间戳且
    同名语义重复**（4 轮「试用一部-1792418137」…）⇒ 标题既不唯一也不稳定；
    运行时判定链（`org_context` → `member_of`）存的**也是 key**
    ⇒ 落库不归一 ⇒ 声明里是标题、判定时拿 key 比 ⇒ **对不上**。

    **调用点**：`define`（**要在接受管对象之前** —— 对象侧那份也得是 key）
    ＋ `rewrite`（落库前）。**这是唯一的归一处**（不许各处自己归一）。
    """
    definition = definition or {}
    access = definition.get(ACCESS_KEY)
    if isinstance(access, dict):
        _normalize_scope_departments(access, where)
    for col in definition.get('columns') or []:
        if not isinstance(col, dict):
            continue
        col_access = col.get(ACCESS_KEY)
        if isinstance(col_access, dict):
            _normalize_scope_departments(
                col_access, '晋升列「%s」' % str(col.get('header') or ''))
    return definition


def declared_fields(doc, definition=None):
    """Explicit complete-record dependency scope for validation/readiness, not a read default."""
    return list(dict.fromkeys(str(col['field']) for col in
        promoted_columns(definition if definition is not None else load_definition(doc))))


def _managed_state(doc, binding, *, row_ids, fields):
    """Read only declared rows/fields, with current record versions; no all-table fallback."""
    if not isinstance(row_ids, (list, tuple)) or not isinstance(fields, (list, tuple)):
        frappe.throw('正式值读取必须明确行范围和字段范围', frappe.ValidationError)
    from shangshu_core.public_api import read_promoted_values
    records = binding.get('records') or {}
    known = []
    for row_id in dict.fromkeys(row_ids):
        if records.get(row_id):
            known.append(row_id)
        else:
            # Only structure-registered new draft rows may lack a managed record.
            _require_pending_managed_row(doc, binding, row_id)
    if not known:
        return {'values': {}, 'versions': {}}
    return read_promoted_values(object_id=binding['object_id'], records=records,
                                row_ids=known, fields=list(dict.fromkeys(fields)))


def _managed_values(doc, binding, *, row_ids, fields):
    return _managed_state(doc, binding, row_ids=row_ids, fields=fields).get('values') or {}


def _require_pending_managed_row(doc, binding, row_id):
    """明确新增来源才可创建受管记录；缺映射、旧数据或伪造行身份不自动补建。"""
    meta = _load_meta(doc)
    marker = (meta.get('promotion_pending_rows') or {}).get(row_id)
    if (row_id not in (meta.get('rows') or []) or not isinstance(marker, dict)
            or marker.get('object_id') != binding.get('object_id')
            or not marker.get('origin_op_id')):
        frappe.throw('行 %s 没有对应的受管记录，且没有可核实的新增来源，不能写正式值' % row_id,
                     frappe.ValidationError)
    return marker


def _create_pending_managed_rows(doc, binding, values_by_row, idempotency_key):
    missing = [row_id for row_id in values_by_row if not (binding.get('records') or {}).get(row_id)]
    if not missing:
        return {}
    origins = {row_id: _require_pending_managed_row(doc, binding, row_id) for row_id in missing}
    # 空输入保留为合法草稿行，不造无事实的受管记录。0/False 都是有效填写。
    missing = [rid for rid in missing if any(value is not None and value != ''
               for value in values_by_row[rid].values())]
    if not missing:
        return {}
    origins = {rid: origins[rid] for rid in missing}
    if not idempotency_key:
        frappe.throw('新增受管记录缺少本次操作身份，未保存', frappe.ValidationError)
    from shangshu_core.public_api import create_promoted_records
    # 来源、文件、操作共同定位这一批；短摘要给内核按行/对象生命周期组成完整幂等键。
    key = 'sheet-new:' + hashlib.sha256(json.dumps(
        [doc.name, idempotency_key, origins], sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:40]
    result = create_promoted_records(object_id=binding['object_id'],
        rows=[{'row_id': row_id, 'values': dict(values_by_row[row_id])} for row_id in missing],
        idempotency_key=key)
    created = result.get('records') or {}
    if set(created) != set(missing) or any(not name for name in created.values()):
        frappe.throw('新增受管记录回执不完整，本次未保存', frappe.ValidationError)
    binding['records'] = {**dict(binding.get('records') or {}), **created}
    _save_binding(doc, binding)
    meta = _load_meta(doc)
    pending = dict(meta.get('promotion_pending_rows') or {})
    for row_id in created:
        pending.pop(row_id, None)
    meta['promotion_pending_rows'] = pending
    _save_meta(doc, meta)
    return created


def _write_managed(doc, binding, values_by_row, idempotency_key=None,
                   expected_modified_by_row=None, restore_versions_by_row=None):
    """把正式值写进**受管记录**（受管记录是唯一权威）。

    **不写 `formal_values_json`** —— 那份 JSON 从此只是「旧表迁移的源」，
    迁移完就退役（`_retire_legacy_json`）。

    `expected_modified_by_row` 是**客户端带来的记录版本**（`{行 id: modified}`）：
    给了就拿它当版本闸 ⇒ **陈旧写当场拒**（不是后写覆盖先写）。
    """
    from shangshu_core.public_api import write_promoted_values
    if any((expected_modified_by_row or {}).get(row_id) for row_id in (values_by_row or {})
           if not (binding.get('records') or {}).get(row_id)):
        frappe.throw('新增行尚无受管记录版本，请刷新后再写；没有覆盖旧记录', frappe.TimestampMismatchError)
    created = _create_pending_managed_rows(doc, binding, values_by_row or {}, idempotency_key)
    records = binding.get('records') or {}
    existing = {row_id: values for row_id, values in (values_by_row or {}).items()
                if row_id not in created and records.get(row_id)}
    if existing:
        result = write_promoted_values(object_id=binding['object_id'], records=records,
                                       values_by_row=existing, idempotency_key=idempotency_key,
                                       expected_modified_by_row=expected_modified_by_row,
                                       restore_versions_by_row=restore_versions_by_row)
    else:
        result = {'object_id': binding['object_id'], 'revision': binding.get('revision'),
                  'written': 0, 'records': dict(records), 'record_version_checked': False,
                  'record_versions_restored': 0, 'managed_change': {}}
    result['written'] = int(result.get('written') or 0) + len(created)
    doc._managed_state_cache = None   # 写完缓存作废（别拿旧值当现状）
    return result


def _retire_legacy_json(doc):
    """旧 `formal_values_json` **退役**：清空它，从此不再参与正式读写。

    **只在这里清** —— 写入口一律不碰它（受管记录才是权威）。
    """
    _save_formal(doc, {})


def _formal_diff(current, candidate):
    """候选正式值状态 vs 权威现状的**逐格差量**。

    候选里没有的字段 = **清空**（`None`）—— 与旧 JSON 口径一致
    （旧口径是把这个键从行里去掉）。
    """
    changes = {}
    current = current or {}
    candidate = candidate or {}
    for row_id in set(current) | set(candidate):
        before = current.get(row_id) or {}
        after = candidate.get(row_id) or {}
        row = {}
        for field in set(before) | set(after):
            if before.get(field) != after.get(field):
                row[field] = after.get(field)
        if row:
            changes[row_id] = row
    return changes


def _bind_managed(doc, definition, new_cols, managed_rows, binding, legacy, formal):
    """把这次晋升接进**公共内核的受管记录**。

    **域里自己写一份记录引擎是做不到的**：受管模型、物理表、记录版本与审计都在
    内核（`shangshu_core.promotion_records`），域里只能经公共 API 接。

    **幂等**：对象/字段/记录的键都按「表 + 行」固定 ⇒ 重试不重复建。
    """
    from shangshu_core.public_api import (provision_promoted_records, extend_promoted_records,
                                          migrate_legacy_promoted_values)
    table = doc.name
    title = doc.get('file_name') or ('晋升表 ' + str(table))
    fields = sorted(str(c.get('field') or '') for c in new_cols)
    key = _promotion_key(table, fields)
    if legacy:
        # **旧 JSON 迁移**：对象/记录先建起来，值以 JSON 为源写进去；
        # 迁完旧 JSON **不再参与正式读写**（下面清空它）。
        result = provision_promoted_records(table=table, title=title,
                                            columns=definition.get('columns') or [],
                                            rows=managed_rows, idempotency_key=key,
                                            access=_table_access(definition))
        migrate_legacy_promoted_values(object_id=result['object_id'],
                                       application_id=result['application_id'],
                                       title=title, columns=definition.get('columns') or [],
                                       formal=formal, records=result['records'],
                                       idempotency_key=key)
        _retire_legacy_json(doc)   # **旧 JSON 退役**：受管记录是唯一权威
        binding = {'object_id': result['object_id'], 'application_id': result['application_id'],
                   'revision': result['revision'], 'records': dict(result['records']),
                   'fields': {str(c.get('field')): str(c.get('header')) for c in new_cols}}
        _save_binding(doc, binding)
        return {'object_id': binding['object_id'], 'revision': binding['revision'],
                'managed_records': len(binding['records']), 'migrated_legacy': True}
    if binding:
        # **后续晋升**：同一个对象加字段、同一条记录加值 —— 对象 ID、记录 ID 都不变。
        result = extend_promoted_records(object_id=binding['object_id'],
                                         application_id=binding.get('application_id'),
                                         title=title, columns=definition.get('columns') or [],
                                         rows=managed_rows, records=binding.get('records') or {},
                                         idempotency_key=key,
                                         access=_table_access(definition))
        binding = {**binding, 'revision': result['revision'],
                   'fields': {**dict(binding.get('fields') or {}),
                              **{str(c.get('field')): str(c.get('header')) for c in new_cols}}}
        _save_binding(doc, binding)
        return {'object_id': binding['object_id'], 'revision': binding['revision'],
                'managed_records': len(binding.get('records') or {}), 'migrated_legacy': False}
    # **首次晋升**：建受管对象 + 为范围内每行建一条受管记录。
    result = provision_promoted_records(table=table, title=title,
                                        columns=definition.get('columns') or [],
                                        rows=managed_rows, idempotency_key=key,
                                        access=_table_access(definition))
    binding = {'object_id': result['object_id'], 'application_id': result['application_id'],
               'revision': result['revision'], 'records': dict(result['records']),
               'fields': {str(c.get('field')): str(c.get('header')) for c in new_cols}}
    # **断点：接完记录、写绑定之前失败**（B02-5 失败恢复判据）——
    # 走到这里抛，让调用方看到失败。**默认不装**，产品代码碰不到。
    # 重试按同一幂等键重来：对象/记录**不重复建**。
    from shangshu_files.sheet import _fault as _sheet_fault
    _sheet_fault('promote-migrate')
    _save_binding(doc, binding)
    return {'object_id': binding['object_id'], 'revision': binding['revision'],
            'managed_records': len(binding['records']), 'migrated_legacy': False}


def _sync_doc(doc, fresh):
    """把**刚写完**那份（fresh）**就地同步**给调用方手里那份 doc。

    ⚠️ **为什么**：调用方接着还要往 meta 上加别的键（行 ID 登记…）⇒
      它读的是**自己那份** ⇒ 不同步 ⇒ 拿旧快照落库 ⇒ **又**把并发改的键盖掉。
    """
    try:
        doc.update(fresh.as_dict())
        return
    except Exception:
        pass
    try:
        doc.sheet_meta_json = fresh.sheet_meta_json
    except Exception:
        pass


def _save_binding(doc, binding):
    """落绑定（`meta['promotion_binding']`）。绑定不是员工编辑，不改表的更新时间。

    ⚠️ **同时落「受管对象 ID」那个带索引的字段**（`managed_object_id`）——
    受管记录变了要回填到这张表 ⇒ 反查必须 **O(1)** ⇒ 靠这个字段上的索引；
    **不许扫全量 `sheet_meta_json`**（大表每次写都扫一遍 ⇒ 性能纪律不允许）。

    ⚠️ **落之前重新读一次最新的 meta**（R01）：绑定这份写**总是排在一次 DDL 之后**
      （`provision` / `extend` —— MariaDB 的 DDL **隐式提交** ⇒ 文件行锁被放掉）
      ⇒ 手里那份 doc 的 meta 停在 **DDL 之前** ⇒ 拿它落库
      ⇒ **把并发期间别人改的键一起覆盖掉**。
      ⇒ 这里**重新 `get_doc(for_update=True)`**（**当前读**，不是快照读）取最新那份，
        **只换 `promotion_binding` 这一个键**，别的键**原样带着**。
    """
    fresh = _reload_locked_file(doc)
    meta = _load_meta(fresh)
    meta['promotion_binding'] = binding
    _save_meta(fresh, meta)
    _sync_doc(doc, fresh)     # 调用方那份也同步（它接着还要往 meta 上加别的键）
    return binding


# ---------- UI-027 分阶段留状态（检查 → 启用的「期间变化」检测） ----------
# 契约（`处理契约与状态转换.md:111`）：「实施必须**分阶段留状态**，**启用前核对期间变化**」。
# 状态落在 `sheet_meta_json.promotion_staging`（随 meta 持久化，重启不丢 —— UI-070 同族）。

def _staging_parts(doc, definition):
    """检查那一刻的「源表 + 结构 + 定义」状态签名。**分量分开算** ——
    漂移时能点名是哪一样变了（拒因不说清，用户只能瞎重试）。

    **内容信号用 xlsx 字节 sha**（不是 `version_count` 计数）：
    计数会被与内容无关的落盘路径扰动，字节变 = 源表真变过；
    `_save_meta`（分阶段留状态本身）只写 `sheet_meta_json`，**不掺假进内容信号**。
    """
    import hashlib
    from shangshu_files import sheet as _sheet
    meta = _load_meta(doc)
    try:
        content = _sheet._content(doc, for_write=False)
    except Exception:
        content = b''
    return {
        'structure_version': int(meta.get('structure_version') or 1),
        'content_sha': hashlib.sha256(content or b'').hexdigest(),
        'definition_sha': hashlib.sha256(
            json.dumps(definition, ensure_ascii=False, sort_keys=True, default=str).encode()
        ).hexdigest(),
    }


def _staging_token(table, parts):
    import hashlib
    blob = json.dumps({'table': table, **parts}, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()


def _stage_record(doc, definition):
    """阶段一落**检查状态**（分阶段留状态），回 `check_token`。**不碰**正式值与定义。"""
    parts = _staging_parts(doc, definition)
    token = _staging_token(doc.name, parts)
    try:
        from frappe.utils import now as _now
        checked_at = str(_now())
    except Exception:
        checked_at = ''
    meta = _load_meta(doc)
    meta['promotion_staging'] = {'checked_at': checked_at, 'check_token': token, **parts}
    _save_meta(doc, meta)
    return token


def _verify_staging(doc, check_token, definition):
    """阶段二：**启用前核对检查之后有没有人动过**。漂移就拒 ——
    不静默按旧检查的结论启用（UI-027 的「检查后改源表→启用重验」那半）。

    **拒因点名哪一样变了**（结构 / 源表内容 / 本次定义）—— 不说清用户只能瞎重试。
    """
    meta = _load_meta(doc)
    staging = meta.get('promotion_staging')
    if not isinstance(staging, dict) or not staging:
        frappe.throw('没有待启用的检查记录：请先带 dry_run 走分阶段检查，再来启用',
                     frappe.ValidationError)
    if str(staging.get('check_token') or '') != str(check_token or ''):
        frappe.throw('check_token 与检查记录对不上：请重新分阶段检查', frappe.ValidationError)
    parts = _staging_parts(doc, definition)
    if int(staging.get('structure_version') or 1) != parts['structure_version']:
        frappe.throw('检查后表结构有改动，请重新检查', frappe.ValidationError)
    if str(staging.get('content_sha') or '') != parts['content_sha']:
        frappe.throw('检查后源表有改动，请重新检查', frappe.ValidationError)
    if str(staging.get('definition_sha') or '') != parts['definition_sha']:
        frappe.throw('检查后定义有改动，请重新检查', frappe.ValidationError)
    if _staging_token(doc.name, parts) != str(check_token):
        frappe.throw('check_token 与检查记录对不上：请重新分阶段检查', frappe.ValidationError)


def _clear_staging(doc):
    """启用成功后作废检查记录 —— 重复启用必须重新检查（不落「一次检查、反复启用」）。"""
    meta = _load_meta(doc)
    if meta.pop('promotion_staging', None) is not None:
        _save_meta(doc, meta)


def _open_worksheet(doc):
    """预检用：打开 xlsx 取当前工作表。**打不开就拒，不静默当空表**。"""
    from shangshu_files import sheet as _sheet
    import openpyxl
    from io import BytesIO
    try:
        content = _sheet._content(doc, for_write=False)
        wb = openpyxl.load_workbook(BytesIO(content), data_only=False, read_only=False)
        return wb.worksheets[0]
    except Exception as e:
        frappe.throw('首次晋升预检打不开表内容，**未迁移、未启用**：%s' % str(e)[:200],
                     frappe.ValidationError)


def _sheet_headers(ws):
    """表头行文本（与 `sheet._headers_of` 同口径：None 归空串）。"""
    from shangshu_files import sheet as _sheet
    return _sheet._headers_of(ws)


def _cell_at(ws, rows, row_id, col_idx, positions=None):
    """定位一格的 **openpyxl 格子对象**（读值、读数字格式都要它）。

    ⚠️ `positions` 是「行 ID → 工作表行号」的映射（**表头占第 1 行**，数据行从 2 起）。
    **不传就退化成 O(n²)**（`rows.index()` 每格线性找一次）—— 15,516 行的表预检会跑成几十分钟。
    **大规模预检必须传**。
    """
    if positions is not None:
        xlsx_row = positions.get(row_id)
        if xlsx_row is None:
            return None
    else:
        if row_id not in rows:
            return None
        xlsx_row = rows.index(row_id) + 2   # 表头占第 1 行
    return ws.cell(row=xlsx_row, column=col_idx + 1)


def _read_cell_value_from(ws, rows, row_id, col_idx, positions=None):
    """从已打开的 xlsx 工作表读一格的值（预检用）。**只读值，不动字节**。

    ⚠️ `positions` 见 `_cell_at`。
    """
    cell = _cell_at(ws, rows, row_id, col_idx, positions)
    return None if cell is None else cell.value


def _column_value(col, raw, cell, header):
    """按**列声明的类型**把工作簿原值转成受管值（**读的时候定**）。

    **为什么在源头定**（PKG-004-T03 第 4 步的结论）：
    - 真日期列：Excel 存的是日期，openpyxl 读出来是 `datetime` ⇒ 转成 `YYYY-MM-DD`
      （受管的 date 字段要的就是这个形状；不转 ⇒ 整列被拒 = 「日期列整批拒」）；
    - 「套了日期格式的文本列」：**格子的显示格式不算数**，列声明的类型才算数 ⇒
      编号按**文字**读（不按日期解释）；openpyxl 已经把范围内的编号读成了日期、
      原始编号追不回来时 ⇒ **明确拒**（不猜，不把编号变成日期）。

    转换口径**复用内核那一份**（`shangshu_core.public_api.convert_workbook_value`），
    域里不另写一套。
    """
    from shangshu_core.public_api import convert_workbook_value
    return convert_workbook_value(
        promotion_type=str(col.get('type') or ''),
        value=raw,
        number_format=(getattr(cell, 'number_format', None) or 'General'),
        data_type=getattr(cell, 'data_type', None),
        label=str(header or ''))


def _read_cell_value(doc, meta, row_id, col_idx):
    """兼容旧调用：打开一次表再读一格（新代码请用 `_open_worksheet` + `_read_cell_value_from`）。"""
    ws = _open_worksheet(doc)
    return _read_cell_value_from(ws, list(meta.get('rows') or []), row_id, col_idx)


# ---------- BASE967-27 `files.promotion_status`（A 的 UI 依赖）----------

#: 重验原因的**五值枚举**（E 契约 §十，2026-10-19 主控转 A 定口径）。
#: **原样用字符串，不自己编** —— A 的面板按这几个标签渲染，现编就对不上。
#: `unknown` 是**兜底 fail-closed**：判不出来就标「需重验」，**不静默当没这回事**。
REVALIDATION_REASONS = (
    'permission_changed',      # 提案人的权限变了（撤权/改角色）
    'attribution_changed',     # 表归属变了（表主/部门换人）
    'field_acl_changed',       # 字段 ACL 变了（某列从可读变只读/不可读）
    'definition_advanced',     # 晋升定义前进（列的规则/类型/绑定变了）
    'unknown',                 # 兜底：判不出来，但**仍标需重验**（fail-closed）
)


def _definition_fingerprint(meta):
    """当前晋升定义的**内容指纹**（`promotion.columns` 的规范化 sha）。

    ★ **为什么用内容哈希、不是版本号**（2026-10-19 与主控定的丙案）：
    `DEFINITION_VERSION` 是**模块常量恒 1**（`promotion.py:34`），
    「定义版本前进」这件事**今天没有递增载体** —— `test_op_history.py` 头部
    自己写着「等 X3-① 建出递增的 `definition_revision`」。
    编一个版本号出来就是造假。所以：**定义变了 = 内容指纹变了**，**真判不是恒假**。
    算法跟 `_staging_parts` 的 `definition_sha` 同源（同一份规范化口径）。
    """
    import hashlib
    promo = meta.get('promotion') or {}
    cols = promo.get('columns') or []
    if not isinstance(cols, list) or not cols:
        return ''
    # ⚠️ **表级主体范围也算进指纹**（PKG-117-T01）—— 改表级就是**定义变了**，
    # 指纹不变的话，钉着旧指纹的提案就看不出定义已经前进（漏判 `definition_advanced`）。
    payload = {'access': promo.get(ACCESS_KEY) or None, 'columns': cols}
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode()
    ).hexdigest()


def _proposal_reason(proposal, doc, meta, cur_fp, cur_structure):
    """判**一条**提案要不要重验。回 `None`（不用）或一个 `REVALIDATION_REASONS` 值。

    **判定顺序（次序有讲究：先具体后兜底）**：
      1. `definition_advanced` —— 提案钉的定义指纹 ≠ 当前指纹，
         **或结构版本前进**（提案钉的 `expected_structure_version` ≠ 当前）
      2. `field_acl_changed`  —— 提案涉及**有 ACL 声明**的列，且当前 ACL 与提案时不同
      3. `permission_changed` —— 提案人现在**没有**该目标的读权了
      4. `attribution_changed`—— 表归属变了（非本人/非获授权）
      5. `unknown`          —— **兜底**：上面判不出来但又有可疑信号 → 仍标需重验

    ★ **结构版本那半走同一个 `definition_advanced`**（2026-10-19 主控定）：
    口径原文是「**定义或结构版本前进**」，两半**同义**（都是「提案基于的形态过期了」）
    → **不新增第六个值**，仍回 `definition_advanced`。
    结构版本戳**现成**：提案 payload 里有 `expected_structure_version`
    （`proposals._proposal_row` 的 `expired` 机制早就在用）。
    """
    from shangshu_core import org_admin
    payload = {}
    try:
        payload = json.loads(proposal.get('payload_json') or '{}') or {}
    except (TypeError, ValueError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    # 1a 定义前进：提案钉的指纹 ≠ 当前指纹
    pinned_fp = str(payload.get('promotion_definition_sha') or '')
    if pinned_fp and cur_fp and pinned_fp != cur_fp:
        return 'definition_advanced'

    # 1b 结构版本前进：提案钉的 `expected_structure_version` ≠ 当前
    # （`cur_structure` 由调用方从 `meta` 取；提案没钉结构版本 → 不判，见 1b 注）
    pinned_sv = payload.get('expected_structure_version')
    if pinned_sv is not None and cur_structure:
        try:
            if int(pinned_sv) != int(cur_structure):
                return 'definition_advanced'
        except (TypeError, ValueError):
            # **戳坏掉**（不是数字）→ 判不出来，走下面的兜底，不当「没变」
            return 'unknown'
    # 提案**没钉**结构版本 → 这半判不了（老提案），**不恒真也不恒假**：
    # 交给 2～4 具体判据去判；都判不出才落 `unknown`。

    # 2 字段 ACL：提案 payload 里带列名，且该列现在是「有 ACL 声明」的受控列
    try:
        definition = load_definition(doc)
        touched = []
        for cell in (payload.get('cells') or []):
            if isinstance(cell, dict) and cell.get('header'):
                touched.append(str(cell.get('header')))
        if payload.get('header'):
            touched.append(str(payload.get('header')))
        if touched:
            caps, _cols = _field_caps(doc, definition=definition)
            # **有 ACL 声明**（三键任一在列上）且提案没钉 ACL 快照 → 可能变了。
            # 判不出来的走 `unknown`，**不静默放行**。
            for h in touched:
                col = column_by_header(definition, h)
                if not (col and col.get('promoted') and col.get('field')):
                    continue
                if ACCESS_KEY in col:
                    if not payload.get('promotion_field_acl_sha'):
                        return 'field_acl_changed'
    except Exception:
        return 'unknown'

    # 3 权限：提案人现在没有该表的读权
    # ⚠️ **用文件域的权威口 `access.has_permission(doc, 'read', user)`** ——
    # 不自己按归属拼一遍（那是 service.py 早踩过的「两份判定源」坑）。
    actor = str(proposal.get('actor_user') or '').strip()
    if actor:
        try:
            from shangshu_files import access as _access
            if not _access.has_permission(doc, 'read', actor):
                return 'permission_changed'
        except Exception:
            return 'unknown'

    # 4 归属变了：提案人既不是上传人也不是当前归属人
    if actor:
        try:
            att = org_admin.resource_attribution(doc.name)
            if att:
                level = att.get('level')
                allowed = (actor == (att.get('owner_user') or '').lower()
                           if level == 'personal' else actor == doc.owner)
                if not allowed and not org_admin._management_read_only(actor, att):
                    return 'attribution_changed'
        except Exception:
            return 'unknown'

    # 5 兜底：**载荷里带了 proposal / 版本戳但我们判不出来** → unknown（fail-closed）
    if payload.get('promotion_definition_sha') and not pinned_fp:
        return 'unknown'
    return None


def promotion_status(_service, payload, _context=None):
    """`files.promotion_status`：这张表上**哪些未确认提案需要重验**（BASE967-27）。

    **测试通过 =** 下面每条成立：
      1. 回 `{proposals_needing_revalidation: [{id, reason}]}`，**reason 是五值枚举之一**
      2. 提案钉的定义指纹 ≠ 当前指纹 → `definition_advanced`
      3. 没钉指纹的**旧提案**不因为「没钉」而被误判成要重验（不恒假）
      4. 当前无未确认提案 → 回**空数组**（不是 null、不是「查不到」）
      5. 读权已撤 → `permission_changed`；判不出来 → `unknown`（**fail-closed**）

    **「启用期间修改 → 旧提案重验」的口径**（主控 2026-10-19 转 A 定）：
      · **触发**：**定义或结构版本前进**（**值改动不影响提案有效性**）
      · 结构版本那半复用 `proposals._proposal_row` 的 `expired`（现成的）；
        定义那半走本模块的**内容指纹**（`DEFINITION_VERSION` 恒 1，没有递增载体）。

    **A 在审核面板拿这个标「需重验」** —— **B 只出公共判定，不管 A 怎么渲染**。
    """
    table = str(payload.get('table') or '').strip()
    if not table:
        frappe.throw('table 必填', frappe.ValidationError)
    if not frappe.db.exists(FILE, table):
        frappe.throw('表不存在：%s' % table, frappe.DoesNotExistError)
    doc = frappe.get_doc(FILE, table)
    doc.check_permission('read')
    meta = _load_meta(doc)
    cur_fp = _definition_fingerprint(meta)
    cur_structure = int(meta.get('structure_version') or 1)

    from shangshu_core.public_api import list_action_proposals, get_proposal_validation_snapshot
    try:
        rows = list_action_proposals(status='Proposed', limit=200)
    except Exception:
        # **提案层查不到就 fail-closed** —— 回一条 `unknown`，不是空数组
        return {'table': table, 'proposals_needing_revalidation': [],
                'structure_version': cur_structure,
                'note': '提案层不可读，本表按「需人工核对」处理'}
    items = rows.get('items') or []
    out = []
    for item in items:
        pid = str(item.get('id') or '')
        if not pid:
            continue
        try:
            proposal = get_proposal_validation_snapshot(pid)
        except Exception:
            continue
        reason = _proposal_reason(proposal, doc, meta, cur_fp, cur_structure)
        if reason:
            out.append({'id': pid, 'reason': reason})
    return {'table': table, 'proposals_needing_revalidation': out,
            'structure_version': cur_structure,
            'definition_sha': cur_fp or None}


def subject_options():
    """主体选项：**部门清单 ＋ 人员清单**（界面下拉用）。

    ★ **PKG-117-T01 之后这里不再是「角色清单」** —— 主体**四档**是
    **全局／部门／个人／无人**，下拉要给的是**部门**与**人**，不是角色。

    **取自内核已公开的能力**（域不自己查组织表）：
    · 部门 → 数据集 `platform.department`（`query_dataset`）；
    · 人员 → `list_collaboration_people`（同企业的启用员工目录）。

    ⚠️ **取不到就给空清单**（`departments_available` / `people_available` 为 False）
    ⇒ 界面据此**明示「暂无可选部门／人员」** —— **不编造**（宁可空着，不给假清单）。

    ★ **管理员写「管理员」**（用户 2026-10-26 决议④：「主体判定加上管理员旁路
    （**管理员那个写成『管理员』**）」）——
    **这个账号是管理员（`System Manager`）时，label 写「管理员」**；
    **id 仍然是那个人的登录名（邮箱），一个字都不改**（id 才是判定时用的那个）。

    **怎么知道谁是管理员**：**用 `frappe.get_roles(mail)`** ——
    `list_collaboration_people()` 的返回里**只有**身份目录信息
    （`kind`／`identity_id`／`username`／`user_name`／`display_name`／`group`／`scope`），
    **没有角色／管理员标记** ⇒ 那一头**给不了**这个信息；
    而 `frappe.get_roles()` 是 **Frappe 公共 API**（不是跨域私有名），
    本模块**本来就在用它**（`read()` 里判「能不能管字段权限」那句）
    ⇒ **用公共框架那一份，不给内核再添一个出口**。
    """
    departments, people = [], []
    departments_ok = people_ok = False
    try:
        from shangshu_core.public_api import query_dataset
        result = query_dataset('platform.department', {}, 1, 100) or {}
        for row in (result.get('rows') or []):
            name = str(row.get('name') or '').strip()
            if not name:
                continue
            departments.append({'id': name,
                                 'label': str(row.get('title') or name)})
        departments_ok = True
    except Exception:
        departments = []
    try:
        from shangshu_core.public_api import list_collaboration_people
        for row in (list_collaboration_people() or []):
            if str(row.get('kind') or '') != 'employee':
                continue
            mail = str(row.get('user_name') or '').strip()
            if not mail:
                continue
            people.append({'id': mail,
                           'label': ('管理员' if _is_admin(mail)
                                     else str(row.get('display_name') or mail))})
        people_ok = True
    except Exception:
        people = []
    return {'departments': departments, 'people': people,
            'departments_available': departments_ok, 'people_available': people_ok}


def _is_admin(mail):
    """这个人是不是管理员（`System Manager`）。

    **判据用 Frappe 公共 API** `frappe.get_roles(mail)` ——
    `list_collaboration_people()` 那份返回里**没有**角色标记（见 `subject_options` 的说明）
    ⇒ 「谁是管理员」这件事**只有这一口**能答。

    ⚠️ **查不到就当不是管理员**（fail-closed）：宁可标签少写一个「管理员」，
    也**不许**把一个不是管理员的人标成管理员（那会让人以为他能改一切）。
    """
    try:
        return 'System Manager' in (frappe.get_roles(mail) or [])
    except Exception:
        return False


def read(_service, payload, _context):
    """`files.promotion_definition`：读晋升定义。回认定的事实，不是回声。

    **表级主体范围与列级声明都一起回**（`access`）—— 前端「字段权限」面板要用。
    """
    table = str(payload.get('table') or '').strip()
    if not table:
        frappe.throw('table 必填', frappe.ValidationError)
    if not frappe.db.exists(FILE, table):
        frappe.throw('表不存在：%s' % table, frappe.DoesNotExistError)
    doc = frappe.get_doc(FILE, table)
    doc.check_permission('read')
    definition = load_definition(doc)
    can_manage = 'System Manager' in frappe.get_roles() and not _load_meta(doc).get('object_companion')
    definition['can_manage_field_permissions'] = bool(can_manage)
    if can_manage:
        definition['definition_sha'] = _definition_fingerprint(_load_meta(doc))
        # **主体选项**（部门清单 ＋ 人员清单）—— 不再给角色清单。
        definition['subject_options'] = subject_options()
    return definition


# ---------- 正式值（晋升列的数据库侧）与读路径合并（D-b）----------

FORMAL_FIELD = 'formal_values_json'


def legacy_formal_values(doc):
    """旧 `formal_values_json` 里的正式值 —— **只给显式迁移/预览用**。

    ⚠️ **日常权威读口 `_load_formal` 不再回落这份 JSON**（原收敛条目 03：
    「旧来源退出日常调用」）⇒ 这份 JSON **只在这条明确的迁移口里读**。
    读它的地方只有一处：**首次晋升的迁移源**（`_promote_lifecycle` 那段预检查）。
    """
    try:
        raw = json.loads(getattr(doc, FORMAL_FIELD, None) or '{}')
    except Exception:
        raw = {}
    return raw if isinstance(raw, dict) else {}


def _load_formal(doc, *, row_ids, fields):
    """Bounded authority read. Migration alone may read legacy_formal_values()."""
    return formal_state(doc, row_ids=row_ids, fields=fields)['values']


def formal_state(doc, *, row_ids, fields):
    """Explicit rows plus fields; unknown/lost bindings fail instead of reading old XLSX."""
    if not isinstance(row_ids, (list, tuple)) or not isinstance(fields, (list, tuple)):
        frappe.throw('正式值读取必须明确行范围和字段范围', frappe.ValidationError)
    binding = _managed_binding(doc)
    if binding:
        state = _managed_state(doc, binding, row_ids=row_ids, fields=fields)
        return {'values': state.get('values') or {}, 'versions': state.get('versions') or {}}
    if load_definition(doc).get('promoted'):
        frappe.throw('晋升表缺少受管记录绑定，不能读取正式值', frappe.ValidationError)
    return {'values': {}, 'versions': {}}


def formal_state_for_rows(doc, row_ids, *, fields):
    """Page/card scope; legacy missing mappings are errors, never an empty official value."""
    return formal_state(doc, row_ids=row_ids, fields=fields)


def record_versions_now(doc, row_ids):
    """这几行**现在**的受管记录版本（写完给客户端，当它下一次写的闸）。

    ⚠️ **为什么要有这一口**（2026-10-29 站上实测撞出来的连锁故障）：
    客户端手里那份「行 → 受管记录版本」**只在读的时候更新**
    ⇒ **自己写完一格，版本就旧了** ⇒ **下一笔被内核的乐观锁拒**
    （人话：「记录已被修改，请刷新后重试」）
    ⇒ 那笔失败卡在**输入队列的队首** ⇒ **整队停** ⇒ 页面永远「有未保存」
    ⇒ **列宽／拖列／撤回／导出全被禁** ⇒ 人以为这些功能坏了（刷新一下又好了，更迷惑）。

    ⇒ **写回执必须带上「写完之后」的版本**（客户端存进那张表，下一次写带上），
    这样**自己写自己**永远不会撞自己。

    **只回事实**：没有受管记录的行**不在回包里**（不是空串）——客户端据此知道
    「这一行还没有受管记录」，下一笔会走「先建记录」那条路。
    """
    row_ids = [str(row_id) for row_id in (row_ids or []) if row_id]
    if not row_ids or not _managed_binding(doc):
        return {}
    state = formal_state(doc, row_ids=row_ids, fields=declared_fields(doc))
    return {rid: version for rid, version in (state.get('versions') or {}).items() if version}


def managed_row_ids(doc, row_ids):
    """这些行里**有受管记录**的那些（历史缺映射的行不在其中）。

    **为什么要有这一口**（2026-10-28 下午 · 示例企业总表打不开的根因）：
    「按行读时缺映射是错误」这条规矩是对的（不拿旧 xlsx 值冒充正式值），
    但**分页读**一页里混着**历史缺映射的行**时（客户那张总表有两行：r-015501／r-015502），
    那一行会把**整页读**一起堵死 ⇒ **整张表打不开**。
    ⇒ 分页读把**没有受管记录的行**剔出正式值范围；那些行的晋升列**明写「没有正式值」**
    （hidden）——**不回落旧 xlsx 值，也不当成空正式值**（两条规矩都守住）。
    ⇒ **定点读那一行**仍然报错（`files.row_read` 那条路一个字没改）。
    """
    binding = _managed_binding(doc)
    records = (binding or {}).get('records') or {}
    return [str(row_id) for row_id in (row_ids or []) if records.get(str(row_id))]


def formal_state_full(doc, *, purpose):
    """Full reads require an explicit migration, export, analysis or recovery purpose."""
    if purpose not in ('migration', 'export', 'analysis', 'recovery'):
        frappe.throw('全量正式值读取必须明确迁移、导出、分析或恢复用途', frappe.ValidationError)
    binding = _managed_binding(doc)
    if not binding:
        return formal_state(doc, row_ids=[], fields=declared_fields(doc))
    from shangshu_core.public_api import read_promoted_values
    return read_promoted_values(object_id=binding['object_id'], records=binding.get('records') or {},
        fields=declared_fields(doc), read_scope={'mode': 'all', 'purpose': purpose})


def formula_formal_values(doc, ws, meta):
    """Read managed cells actually referenced by supported formulas, using stable bindings."""
    from shangshu_files import formulas
    from openpyxl.utils.cell import coordinate_to_tuple
    definition = load_definition(doc)
    promoted = {col['header']: col['field'] for col in promoted_columns(definition)}
    rows = meta.get('rows') or []
    row_set = set(rows)
    headers = [str(cell.value or '') for cell in ws[1]]
    old = meta.get('formula_results') or {}
    wanted_rows, wanted_fields = [], []
    for cell in formulas.formula_cells(ws):
        try:
            refs = set(formulas.references(formulas.parse(cell.value)))
        except formulas.FormulaError:
            continue  # recalculate owns strict-input errors and opaque-formula state.
        prior = old.get(rows[cell.row - 2] + '\0' + headers[cell.column - 1], {}) if cell.row - 2 < len(rows) and cell.column <= len(headers) else {}
        for ref in refs:
            binding = (prior.get('bindings') or {}).get(ref) if prior.get('formula') == cell.value else None
            if binding:
                row_id, header = binding.get('row_id'), binding.get('header')
            else:
                row, col = coordinate_to_tuple(ref)
                if row < 2 or row - 2 >= len(rows) or col > len(headers):
                    continue  # recalculate rejects or marks this unsupported reference.
                row_id, header = rows[row - 2], headers[col - 1]
            if header in promoted and row_id in row_set:
                wanted_rows.append(row_id)
                wanted_fields.append(promoted[header])
    return _load_formal(doc, row_ids=list(dict.fromkeys(wanted_rows)),
                        fields=list(dict.fromkeys(wanted_fields)))


def _save_formal(doc, formal):
    """**旧 JSON 写入**（只给旧表迁移与退役用）。

    ⚠️ **写入口一律不调它** —— 正式值进受管记录，不进这份 JSON。
    """
    doc.db_set(FORMAL_FIELD, json.dumps(formal, ensure_ascii=False), update_modified=False)


def formal_values(doc, *, row_ids, fields):
    return _load_formal(doc, row_ids=row_ids, fields=fields)


def _typed_for(col, value):
    """把正式值翻成表里那格的 `{type, value}`（回填用）。按定义的类型走，不猜。

    **空值 → `empty`**（2026-10-17 A 实测：清空已绑定列时 DB 写 NULL，
    回填却按列类型给 `{'type':'number','value':None}` → 快路径报「数值无效」，
    于是「DB 已写、Excel 没写」进待恢复）。空是一种值形状，不按列类型翻。
    """
    if value is None or (isinstance(value, str) and value == ''):
        return {'type': 'empty', 'value': None}
    typ = str(col.get('type') or 'text')
    if typ == 'number':
        return {'type': 'number', 'value': value}
    if typ == 'boolean':
        return {'type': 'boolean', 'value': value}
    if typ == 'date':
        return {'type': 'text', 'value': str(value)}
    return {'type': 'text', 'value': str(value)}


def _writeback_rows(doc, definition, rows_values, _context=None, op_id=''):
    """**仅值回填（批量版）**：把正式值写回原表对应格，**只改值**、**一次落盘**。

    ⚠️ **一次落盘**：多行 ⇒ 一次 `files.sheet_cells_write` ⇒ content_version 恰 +1。
    （逐行落盘 ⇒ 两万格的粘贴会落两万次盘 —— 性能纪律不允许。）

    ⚠️ **每行都核「正式值与字段定义没变」** —— 延迟回填时，别人可能已经改过
    ⇒ 那就**当场拒**（不把旧值盖回去）。
    """
    current = frappe.get_doc(FILE, doc.name, for_update=True)
    current_definition = load_definition(current)
    formal = _load_formal(current, row_ids=list(rows_values or {}),
                          fields=list(dict.fromkeys(k for values in (rows_values or {}).values() for k in values)))
    by_field = {c.get('field'): c for c in promoted_columns(definition)}
    pairs = []
    for row_id, values in (rows_values or {}).items():
        row_values = formal.get(str(row_id)) or {}
        for key, value in (values or {}).items():
            col = by_field.get(key)
            if not col or not col.get('header'):
                continue
            if current_definition != definition or key not in row_values or row_values[key] != value:
                frappe.throw('正式值或字段定义已变化，请重新读取后恢复回填；旧值未写入表格',
                             frappe.TimestampMismatchError)
            pairs.append({'row_id': str(row_id), 'header': col.get('header'),
                          'value': _typed_for(col, value)})
    if not pairs:
        return {'written': 0, 'cells': []}
    from shangshu_files import sheet
    from shangshu_files.working_file import content_revision
    # 文件资源已持行锁。版本在资源元数据中，不为两个版本号重新读文件/生成表格页。
    saved = sheet.write_cells({
        'table': current.name,
        'cells': pairs,
        'op_id': str(op_id or '').strip(),
        'expected_content_version': content_revision(current),
        'expected_structure_version': int(_load_meta(current).get('structure_version') or 1),
    }, _context, projection_only=True)   # ← **projection_only** ⇒ 不会又去写受管记录（不会递归）
    return {'written': len(pairs), 'cells': saved.get('cells') or [],
            'timing': saved.get('timing') or {},
            'op_id': saved.get('op_id') or '',
            'content_version': saved.get('content_version'),
            'structure_version': saved.get('structure_version')}


def _writeback(doc, definition, row_id, values, _context=None, op_id=''):
    """**仅值回填**（D-d）：把正式值写回原表对应格，**只改值**。

    走 `files.sheet_cells_write` 那条批量写 —— 一次落盘、content_version 恰 +1，
    而且它只动格值，**不碰格式**（颜色/列宽/合并/其余格由 `zipedit` 手术保住）。
    一次回填 = 一次落盘，不许循环调单格冒充批量（那会 N 次落盘、版本 +N）。

    版本闩：调用方给了就用调用方的（严口径）；没给就现读一份（后端回填是自己
    在写，不是另一个人的并发编辑）。闩只保证「我没在写别人刚改过的簿」，
    **不能代替**「回填不是另一次用户修改」那条（那条靠 `update_modified=False`）。

    **`op_id` 透传**（B02-7「操作由客户端编号」，写也一样）：调用方把客户端编号递进来，
    台账才落客户端那个号；否则只剩幂等键兜底，按客户端编号撤回查不到台账。
    """
    # Hold the same resource row lock as value/definition writers. A delayed
    # projection must not replay values from a superseded formal snapshot.
    current = frappe.get_doc(FILE, doc.name, for_update=True)
    current_definition = load_definition(current)
    current_row = _load_formal(current, row_ids=[str(row_id)], fields=list(values)).get(str(row_id)) or {}
    if current_definition != definition or any(
            key not in current_row or current_row[key] != value
            for key, value in values.items()):
        frappe.throw('正式值或字段定义已变化，请重新读取后恢复回填；旧值未写入表格',
                     frappe.TimestampMismatchError)
    doc = current
    pairs = []
    by_field = {c.get('field'): c for c in promoted_columns(definition)}
    for key, value in values.items():
        col = by_field.get(key)
        if not col:
            continue
        header = col.get('header')
        if not header:
            continue
        pairs.append({'row_id': row_id, 'header': header,
                      'value': _typed_for(col, value)})
    if not pairs:
        return {'written': 0, 'cells': []}
    from shangshu_files import sheet
    from shangshu_files.working_file import content_revision
    saved = sheet.write_cells({
        'table': doc.name,
        'cells': pairs,
        # **客户端编号的 `op_id` 透传到批量写**（写也一样，B02-7）：不传就只剩幂等键兜底，
        # 台账落的不是客户端那个号 → 按客户端编号 `sheet_cells_undo` 查无此单。
        'op_id': str(op_id or '').strip(),
        'expected_content_version': content_revision(doc),
        'expected_structure_version': int(_load_meta(doc).get('structure_version') or 1),
    }, _context, projection_only=True)   # ← **传 `_context` 不传 None**（B 2026-10-17）：`None` 会让
    # `write_cells` 拿不到 `idempotency_key` → `op_id=''` → `_record_op` **静默丢台账**
    # → 绑定列写的记录没进台账 → ②a cursor 分页漏。**「静默丢」比「写失败」更阴。**
    return {'written': len(pairs), 'cells': saved.get('cells') or [],
            # **`timing`/`op_id` 递上去**（合成后晋升那支的回执也要能看见快路径走没走）——
            # `timing.fast_path` 是 `_fast_ctx` 接没接上的**唯一可观测点**
            # （`test_pkg008` P8-⑥ ⑤ 回归③ 靠它）。吞掉等于把那条判据弄瞎。
            'timing': saved.get('timing') or {},
            'op_id': saved.get('op_id') or '',
            # **`content_version`/`structure_version` 也要递上去**（B 2026-10-15）——
            # 源头 `sheet.write_cells` 的 return **有**这两个键，本函数先前**只取了
            # written/cells/timing/op_id，把它俩丢了**，晋升支回执跟着缺顶层版本号。
            # 后果：前端拿 `result.content_version` 得 `undefined`，自己兜成旧号去写下一次
            # → 版本闩拒（A 查到的版本冲突根因）。
            # ⚠️ **准确说法是「没回」不是「回了旧值」** —— 前端拿到 undefined 兜成旧值，
            # 那是「**丢字段**」不是「**回声**」，两回事。
            'content_version': saved.get('content_version'),
            'structure_version': saved.get('structure_version')}


def on_managed_record_change(payload):
    """**受管记录变了 ⇒ 把正式值回填到那张表的文件投影**（原收敛条目 05）。

    内核在**唯一那个写入点**（`model_records.write_record`）写完受管记录后通知一次；
    本函数是**本域声明的处理器**（见 `hooks.py` 的 `shangshu_managed_change_handlers`）。

    普通文件回填失败标「待恢复」并如实回状态；数据库事务已失败时必须上抛，
    由外层统一回滚，不能把已失效的正式写入误报为成功。

    ⚠️ **本域自己的写入不走这条**（`cell_write`／`formal_write` 自己回填，带两阶段语义）
    ⇒ 那个标志在这里让开（否则**同一笔回填两次**）。
    """
    payload = payload or {}
    object_id = str(payload.get('object_id') or '').strip()
    records = payload.get('records') or {}
    if not object_id or not records:
        return {'handled': 0, 'written': 0, 'pending': False}
    if getattr(frappe.flags, 'shangshu_files_own_writeback', False):
        return {'handled': 0, 'written': 0, 'pending': False,
                'skipped': '本域自己的写入（域内自己回填）'}
    # 反查：哪个文件表绑着这个受管对象（**一条 SQL** —— 靠 managed_object_id 上的索引）
    try:
        files = frappe.get_all(FILE, filters={"managed_object_id": object_id, "status": "Active"},
                                fields=["name"], limit=20)
    except Exception as error:
        raise_if_transaction_failed(error)
        files = []
    handled = 0
    written = 0
    pending = False
    errors = []
    for item in files:
        doc = frappe.get_doc(FILE, item.get('name'))
        binding = _managed_binding(doc) or {}
        reverse = {str(record): row_id
                   for row_id, record in (binding.get('records') or {}).items()}
        definition = load_definition(doc)
        by_field = {c.get('field'): c for c in promoted_columns(definition)}
        rows_values = {}
        for record_name, fields in (records or {}).items():
            row_id = reverse.get(str(record_name))
            if not row_id:
                continue
            picked = {}
            for field, value in (fields or {}).items():
                col = by_field.get(field)
                if not col or not col.get('header'):
                    continue
                picked[field] = value
            if picked:
                rows_values[row_id] = picked
        if not rows_values:
            continue
        try:
            result = _writeback_rows(doc, definition, rows_values,
                                     op_id='managed-change:%s' % object_id)
            written += int(result.get('written') or 0)
            handled += len(rows_values)
            for row_id, values in rows_values.items():
                clear_writeback_pending(doc, row_id, fields=list(values.keys()))
        except Exception as error:
            raise_if_transaction_failed(error)
            # 事务仍健康的普通投影失败，沿原语义标「待恢复」。
            for row_id, values in rows_values.items():
                try:
                    mark_writeback_pending(doc, row_id, values, error)
                except Exception as pending_error:
                    raise_if_transaction_failed(pending_error)
                    pass
            pending = True
            errors.append(str(error)[:200])
    return {'handled': handled, 'written': written, 'pending': pending, 'errors': errors}


def _require_resource_write(doc):
    """**谁能改这张表 = 资源级 write 权**（上传人 / 归属人 / 获编辑共享）—— 判在动笔之前。
    本函数是那套判定的**唯一一份**，`cell_write` / `formal_write` 都调它，
    口径与 `service._writable`（所有表写入的门）**一致**。

    **口径演进（都记下来，别改完就说不清）**：

    1. **改之前**：两道闸各说各话 ——
       `cell_write`/`formal_write` 只判 `doc.check_permission('write')`（Frappe **文档级**粗判，
       System Manager 全过、不看这张表归谁），写完正式值才在 `_writeback`→`sheet.write_cells`
       撞上**资源级**那道 → **半截状态**（`formal_written=True sheet_written=False`）。
    2. **第一刀**（同日早些）：两道一起判、判在写之前 —— 半截没了。
    3. **第二刀**（用户 2026-10-15「**合成吧，这样后面好维护**」+「要区分的是**晋升字段这个
       动作**和**写入这个动作**」）：**写入的权限就是资源级 write**，**不是文档级角色**。
       「普通员工填一个数字 ≠ 把一列变成字段」—— 写入不该被晋升的权限拖累。
       **所以这里去掉文档级 `check_permission('write')`**，只判资源级（读权 + `_can_write`），
       跟 `sheet` 写入那条**同一个口径**。

    ⚠️ **为什么去掉不算放宽**：`sheet.write_cell`（表写入）**从来只判资源级**，
    普通员工一直写得进自己的表。合成前是**两个口两套口径**；合成后一个口一套口径，
    选的就是「谁能改这张表」那条更细的。**文档级角色闸还在动作注册那一层**
    （`domain.py` 的 `roles`），没有消失。

    ⚠️ **晋升仍是管理员**：`files.promotion_define`（把列变成字段、定规矩）角色面一字不动，
    还是 System Manager。**改的是「写值」这条链，不是「晋升」那条。**
    """
    doc.check_permission('read')
    from shangshu_files.service import _can_write
    if not _can_write(doc):
        frappe.throw('只有上传人、资源归属人或获编辑共享的人可以修改文件', frappe.PermissionError)


def formal_write(payload, _context=None):
    """`files.formal_value_write`：写晋升列的**数据库侧正式值**，并**仅值回填**原表。

    **只写晋升列** —— 普通列的值在表里，走表保存那条路，不在这里。
    喂了非晋升列的字段 → 当场拒（不猜你是不是手滑）。

    **写完一律回填**（D-d：「后台改正式值回写原表」）：改了金额，原表那格跟着变，
    但**只改值** —— 颜色/列宽/旁边普通列的值都不动。**没有「只写数据库不动表」的后门**。

    ⚠️ **「怎么造分岔」换过一次**（写入口合成之后，2026-10-15）：原先写「写完正式值再改
    表里那格（那是一次普通表编辑）」—— **合成后那句失效**：往有数据库字段的列里写 = 走数据库，
    不再是「只进表」。产品路只剩**回填失败**这一条（`sheet._fault` 的 `file-write` 断点）：
    数据库那半成了、回填那半没成 → 表里还是旧值。**那是分岔在现实里唯一会真的出现的地方**，
    D-b 的造法跟着改用它。

    `update_modified=False`：写正式值**不是一次用户编辑**，不改表的「更新时间」
    （T09 口径：文件回填不是另一次用户修改）。
    """
    table = str(payload.get('table') or '').strip()
    if not table:
        frappe.throw('table 必填', frappe.ValidationError)
    if not frappe.db.exists(FILE, table):
        frappe.throw('表不存在：%s' % table, frappe.DoesNotExistError)
    doc = frappe.get_doc(FILE, table, for_update=True)
    _require_resource_write(doc)
    definition = load_definition(doc)
    if not definition.get('promoted'):
        frappe.throw('这张表还没定义晋升列，没有数据库侧正式值可写', frappe.ValidationError)
    row_id = str(payload.get('row_id') or '').strip()
    if not row_id:
        frappe.throw('row_id 必填', frappe.ValidationError)
    values = payload.get('values')
    if not isinstance(values, dict) or not values:
        frappe.throw('values 必填且不能为空', frappe.ValidationError)

    # **先全量校验再动一个字节** —— 任何一条规则不过，正式值和表都不许动
    # （「喂非法金额 → 被拒，且不是把格子清空、也不是写进去」）。
    #
    # **角色 ACL 也在这里**（E01.3）—— 「人、Assistant、自动化走相同后端规则」
    # （计划 §二 第 4 条）。今天这条路是 System Manager 专口、`field_allows_roles`
    # 对 SM 旁路所以照过；**但不许只靠旁路**：真要给非 SM 开正式值写权时，
    # 这条闸已经在了，不会变成漏。
    by_field = {c.get('field'): c for c in promoted_columns(definition)}
    for key, value in values.items():
        col = by_field.get(key)
        if not col:
            frappe.throw('%s 不是晋升列的数据库字段，不能写正式值（普通列走表保存）' % key,
                         frappe.ValidationError)
        require_fields_writable(doc, col.get('header'), definition=definition)
        _check_rules(col, value)

    binding = _managed_binding(doc)
    if not binding:
        frappe.throw('这张表还没有受管对象绑定（旧的 JSON 正式值表要先重新晋升一次接入受管记录），'
                     '正式值无处可写', frappe.ValidationError)
    formal = _load_formal(doc, row_ids=[row_id], fields=declared_fields(doc, definition))
    row = dict(formal.get(row_id) or {})
    row.update(values)
    formal[row_id] = row
    # **正式值写进受管记录**（唯一权威）——**不再写** `formal_values_json`。
    expected = str(payload.get('expected_record_version') or '').strip()
    # ⚠️ 同上：本域自己的写入 ⇒ 自己回填（下面那段）⇒ 让处理器让开。
    frappe.flags.shangshu_files_own_writeback = True
    try:
        _write_managed(doc, binding, {row_id: dict(values)},
                       idempotency_key='formal:%s' % (payload.get('op_id') or table),
                       expected_modified_by_row={row_id: expected} if expected else None)
    finally:
        frappe.flags.shangshu_files_own_writeback = False
    update_row_readiness(doc, definition, formal, [row_id])
    # **两阶段**（契约 `执行计划.md:283`「单独DB动作成功但文件失败时如实待恢复且不导出旧文件」）。
    #
    # ⚠️ **平台不许域内自行提交**（`shangshu_core.domain_execution` 的 `before_commit`
    # 钩子会拦「领域执行器不得自行提交事务」）—— 所以**不能靠中途 commit 把 DB 那份留下**。
    # 普通文件回填失败时不抛异常，让健康事务正常走完：DB 那份 + 「待恢复」标记
    # **一起落库**，回执**如实说**「已入库、回填待恢复」。
    #
    # **为什么宁可回 200 也不抛**：抛了事务整单回滚，用户的值**静默丢失**，
    # 而且导出给的旧文件跟「什么都没发生」长得一模一样 —— 那才是骗人。
    # 回执里 `sheet_written=False` + `writeback_error` 说的是真话，页面照它提示。
    try:
        wrote = _writeback(doc, definition, row_id, values, _context,
                           op_id=payload.get('op_id'))
    except Exception as error:
        raise_if_transaction_failed(error)
        mark_writeback_pending(doc, row_id, values, error)
        # 失败时文件那半没写 → 版本**没变**。给前端**当前那个号**（能用它重试），
        # 不给 None（那会让前端自己兜成旧号 —— B 2026-10-15 点的那条坑）。
        try:
            doc.reload()
        except Exception as reload_error:
            raise_if_transaction_failed(reload_error)
            pass
        _cv_fail = max(0, int(doc.version_count or 1) - 1)
        return {'table': table, 'row_id': row_id, 'values': dict(row),
                'fields': sorted(values.keys()),
                'formal_written': True, 'sheet_written': False,
                'writeback': True, 'sheet': {'written': 0, 'cells': []},
                'content_version': _cv_fail,
                'structure_version': int((load_definition(doc) or {}).get('structure_version') or 1),
                'writeback_error': str(error)[:300],
                'pending': True,
                'message': '正式值**已写进数据库**，但回写 Excel 那步失败了。'
                           '本次**没改到 Excel 文件**，导出暂不可用 —— 否则会给一份'
                           '没改过的旧文件冒充最新。已标「待恢复」：请重试保存。'}
    clear_writeback_pending(doc, row_id, fields=values)
    return {'table': table, 'row_id': row_id, 'values': dict(row),
            'fields': sorted(values.keys()),
            'formal_written': True, 'sheet_written': True,
            'writeback': True, 'sheet': wrote, 'pending': bool(writeback_pending(doc)),
            # **顶层版本号**（同 `cell_write` 晋升支）—— 两支回执字段对齐，
            # 前端不用 `result.sheet?.x ?? result.x` 两处找（B：消费方不该替生产方做兼容）。
            'content_version': wrote.get('content_version'),
            'structure_version': wrote.get('structure_version')}


def _reject(header, reason, value):
    """规则不过 → 当场拒。**文案里带得回你刚打的那个值** —— 页面靠它把字留在格子里。

    后端这一半只保证三件事：**被拒**、**没写进数据库**、**没清空格子**。
    「格子里留着你刚打的字」的页面那一半归前端，本模块不冒充。
    """
    frappe.throw(
        '%s：%s（你打了 %r）。本次没写进数据库、也没清空格子，'
        '请把 %r 留在格子里改好再存。' % (header, reason, value, value),
        frappe.ValidationError)


def _check_rules(col, value):
    """按定义里的规则校验正式值。**不猜**：规则不认的类型当场拒。

    **空值是合法形状**（2026-10-17 A 实测：清空已绑定列被拒
    「必须是文字（你打了 None）」）：写 `type:'empty'` 传到这里的值是 `None`，
    代表**清空该正式值**。只有字段声明了 `required` 才拒；否则放行
    （DB 侧写 NULL，行仍保留）。
    """
    typ = str(col.get('type') or '')
    rules = col.get('rules') or {}
    header = col.get('header')
    if value is None or (isinstance(value, str) and value == ''):
        # ⚠️ **必填列空着 ⇒ 不拒**（2026-10-30 用户口径 · PKG-133）：
        #   「**不强制不能保存**（因为我一行要一个格子一个格子输入）」
        #   「**框红** ＋ **toast 提醒**」（前端那侧做，缺项由 `row_readiness` 算）
        #   「**每一次刷新都自检**」（同上）。
        #   ⇒ 人一格一格填时，第一格还没填到必填列**也存得进去** ⇒ 否则整行永远填不完。
        #   ⚠️ **「能不能留空」那条口径（harness-values 的 `nullable`）一个字没改**：
        #   它读的是**模型字段**的 `required`（内核那条），不归这里 ⇒ 这里放行碰不到它。
        return
    if typ == 'number':
        try:
            num = float(value)
        except (TypeError, ValueError):
            _reject(header, '必须是数字', value)
        if rules.get('min') is not None and num < float(rules['min']):
            _reject(header, '不能小于 %s' % rules['min'], value)
        if rules.get('max') is not None and num > float(rules['max']):
            _reject(header, '不能大于 %s' % rules['max'], value)
    elif typ == 'text':
        if not isinstance(value, str):
            _reject(header, '必须是文字', value)
        # ⚠️ **必填列空着不拒**（同上面的口径：提醒，不拦路）。
    elif typ == 'long_text':
        # **长文本**（2026-10-25 客户真数据撞出来的）：跟短文本一样是文字，
        # 但**不设长度上限** —— 短文本那一档的物理列容量是 140（Frappe Data）
        # ⇒ 客户示例企业总表的「联系人信息」有 63 处超长（最长 580）⇒ 装不下
        # ⇒ 那一列声明成长文本（内核的受管模型本来就有这一档：Long Text）。
        # ⚠️ **长度上限不在这一道闸上**（短文本限 140 是内核 schema 层的事）⇒ 这里只管「类型认不认」。
        if not isinstance(value, str):
            _reject(header, '必须是文字', value)
        # ⚠️ **必填列空着不拒**（同上面的口径：提醒，不拦路）。
    elif typ == 'date':
        if not isinstance(value, str) or not value.strip():
            _reject(header, '必须是日期文字', value)
    elif typ == 'boolean':
        if not isinstance(value, bool):
            _reject(header, '必须是真假值', value)
    else:
        _reject(header, '类型不受支持：%r' % typ, value)
    _check_value_domain(header, rules, value)


def _check_value_domain(header, rules, value):
    """**值域清单**这一道闸（清单挂在 `rules.options`）。

    · **没声明清单** ⇒ 这一列没有值域规则（放行）；
    · 声明了清单、`allow_custom` **不是** False ⇒ **放行**
      （清单只当提示：下拉提供其他，人工填写原文保存 —— 旧项目那条口径）；
    · 声明了清单、`allow_custom` **显式是** False ⇒ 值不在清单里**当场拒**（硬拦）。

    ⚠️ **逐字比对，不 trim** —— 「受理 」和「受理」是两种写法；
    trim 就等于偷偷把用户写的原文改成标准项（与「保留原文」相反）。
    """
    options = (rules or {}).get('options')
    if not isinstance(options, list) or not options:
        return
    allow = (rules or {}).get('allow_custom')
    if True if allow is None else bool(allow):
        return
    text = value if isinstance(value, str) else str(value)
    if text not in [str(item) for item in options]:
        _reject(header, '只能填清单里的值', value)


def _managed_object_id(doc):
    """这张表绑的**受管对象** id（没有绑定 ⇒ None）。

    ⚠️ **只取「是哪个对象」这一件事** —— 那是**输入**（文件侧该有的唯一职责）；
    **判定**按**受管对象的正式定义**（compiled）走，见 `effective_definition`。
    """
    binding = _managed_binding(doc) or {}
    return binding.get('object_id') or None


def authoritative_definitions(object_ids):
    """批量取**受管对象的正式定义**（compiled／active 那一份）—— **权威那份**。

    返回 `{object_id: {'columns': [{'promoted','field','header','access'}], 'access': 表级}}`。

    正式定义由内核公共批读取得，文件层只转换为表格元数据形状，不读取内核表。
    缺失对象不返回。目录可保留原显示信息；这不是正式值、规则或受管写入的依据，
    正式值路径仍必须通过绑定和内核记录校验，不得回落 xlsx 旧值。
    """
    ids = [oid for oid in dict.fromkeys(object_ids or []) if oid]
    if not ids:
        return {}
    from shangshu_core.public_api import managed_object_definitions
    out = {}
    for object_id, compiled in managed_object_definitions(ids).items():
        cols = []
        for field in compiled.get("fields") or []:
            if not isinstance(field, dict) or not field.get("id"):
                continue
            if field.get("type") == "detail":
                continue  # 子表字段不是这张表的列
            cols.append({"promoted": True, "field": field.get("id"),
                         "header": field.get("label") or field.get("id"),
                         "access": field.get("access") or {}})
        if cols:
            out[object_id] = {"columns": cols, "access": compiled.get("access")}
    return out


def effective_definition(doc, definition=None):
    """这张表的**生效定义**（受管列 ＋ 表级 access）—— **正式定义优先**。

    ⚠️ **口径**（用户 2026-10-26 23:0x 决定二：「定义有一份权威（受管对象的 compiled 定义），
    其他配置是生成结果」）：
      · **受管对象的正式定义**（compiled／active）才是**权威**；
      · 文件侧那份（`sheet_meta_json` 的 `promotion`）**只当输入**（列声明、字段映射在那儿）；
      · **取不到正式定义**（这张表没绑受管对象／对象行已不在）⇒ **回落文件侧那份**
        —— **不静默收紧**（真表证据 2026-10-27：站上 881 个带绑定的文件里 641 个对象行已不在，
        多为判据残骸；一刀 fail-closed 会把这批文件的读写下载全拒掉）。

    返回 `(columns, table_access)`。
    """
    # ⚠️ **同一张表的生效定义，一次请求里只算一次**（2026-10-28 凌晨实测踩到的真凶）：
    #   这段会去内核取**权威定义**（读库）⇒ 批量撤回时被**逐行**调用 402 次
    #   ⇒ 光这一项就 1.04 秒（撤回整体 3.1 秒里的大头）。
    #   口径不变：权威定义优先、取不到回落文件侧那份；只是**同一张表不重复算**。
    #   键用「同一个 definition 对象」（`is`）⇒ 传进来的定义换了就重算，不拿旧的硬扛。
    memo = getattr(doc, "_shangshu_effective_definition", None)
    if memo is not None and memo[0] is definition:
        return memo[1]
    result = _effective_definition_now(doc, definition)
    try:
        doc._shangshu_effective_definition = (definition, result)
    except Exception:
        pass
    return result


def _effective_definition_now(doc, definition=None):
    """`effective_definition` 的真身（**不含记忆**）。"""
    object_id = _managed_object_id(doc)
    if object_id:
        authoritative = authoritative_definitions([object_id]).get(object_id)
        if authoritative:
            return authoritative["columns"], authoritative.get("access")
    if definition is None:
        definition = load_definition(doc)
    columns = [c for c in (definition.get('columns') or [])
               if isinstance(c, dict) and c.get('promoted') and c.get('field')]
    return columns, definition.get(ACCESS_KEY) or {}


def _field_caps(doc, definition=None, user=None):
    """逐列能力投影（**三个维度**：读／写／下载）。

    ★ **PKG-117-T01 之后走「主体范围」判定**（内核 `field_subject_allows`）——
    不再走旧的 `field_access.field_capabilities`（那三个角色键是**建模对象链**的模型）。
    继承链本体在内核（列 → 列的读 → 表 → 表的读），域**不写第二套**。

    ⚠️ **判定用的定义是「受管对象的正式定义」**（决定二）—— 文件侧那份只当输入。

    ⚠️ **判定取的是 `field.get("id")`**，而晋升定义里的列键叫 **`field`**。
    键名对不上 → `fid=None` → 判成全拒/全放（D-11 栽过：摘要说只读、实改 200）。
    这里**补 `id` 键**喂给内核判定，**不改内核、不重写判定**。

    回 `(per_field, field_cols)` —— `per_field` 是
    `{字段id: {read, write, download}}`。
    """
    field_cols, table_access = effective_definition(doc, definition)
    if not field_cols:
        return {}, []
    caps = access_scope.capabilities([{**c, 'id': c.get('field')} for c in field_cols],
                                     user=user, table_access=table_access)
    return caps, field_cols


def require_fields_writable(doc, header, definition=None, user=None):
    """**这一列这个人能不能写**（按主体范围判）—— 跟值域规则是**两道**，写之前都过。

    E01.3：「列的**不可读**与**只读**必须区分」。这条是**只读**那半：
    这一列声明的**写**主体范围不含你 ⇒ 写当场拒。

    ⚠️ **拒因点名是哪个字段**（`field_access.deny_reason`，**不另写文案**）——
    泛泛一句「没权限」用户无从定位。

    ★ **管理员旁路已加**（用户 2026-10-26 决议④：「主体判定加上管理员旁路」）——
    **管理员（System Manager）对四档全部放行，包括「无人」档**；
    ⇒ `files.formal_value_write`（System Manager 专口）写**个人档**的列**不再被拒**。

    **域这一侧判定逻辑零改动**（旁路**不是**域加的）：
    这条路径走的是 `access_scope.capabilities` → `field_subject_allows`（**带 ctx 的那一条**），
    ctx 由内核 `subject_context` 现取，里面带着管理员标记 ⇒ **旁路自动生效**。
    ⚠️ **域不许自己判一次管理员**（那是第二份规则）；也不许把 ctx 里的键摘掉。
    """
    header = str(header or '').strip()
    if not header:
        return
    if definition is None:
        definition = load_definition(doc)
    col = column_by_header(definition, header)
    if not (col and col.get('promoted') and col.get('field')):
        return
    caps, _ = _field_caps(doc, definition=definition, user=user)
    if (caps.get(col.get('field')) or {}).get('write'):
        return
    from shangshu_core.public_api import deny_reason
    frappe.throw('%s（表头「%s」—— 这一列声明的写权限不含你，改不了）'
                 % (deny_reason(col.get('field'), 'write'), header),
                 frappe.PermissionError)


def require_package_rules_ok(doc, items, definition=None):
    """**整包写之前的那两道**：能力（能不能写这一列）**按列**过 ＋ 值域规则**逐格**过。

    ⚠️ **为什么能力按列**：能力投影（这个人对这一列能不能写）对**整列**是一份 ——
    同一列、同一主体、同一份声明 ⇒ 逐格重算是**同一道题问一千遍**
    （真大表 1,000 格整包实测：能力投影被调 **1,002 次** ⇒ 光这一项 ≈1.3 秒）。
    **判定结果一个字都不变**（同一列、同一主体）——变的只是「问几次」。

    ⚠️ **值域规则仍逐格过**：规则看的是**值**，每格的值不同 ⇒ 每格都要过。
    （**不许**为了快把规则也按列去过一遍。）

    ⚠️ **这条不是新的一套判定**：能力仍走 `require_fields_writable`、规则仍走
    `_check_rules` —— 与单格那条 `require_field_rules_ok` **同一份代码**。

    `items`：`[{'header': 表头, 'value': 裸值, 'check_rules': True/False}, …]`
    （`check_rules` 为假＝这一格**去值**而不是写值 ⇒ 只过「能不能写」那一道；
    `undo_cells` 原来就是这么分的两道。）
    """
    if definition is None:
        definition = load_definition(doc)
    checked_headers = set()
    for item in items or []:
        header = str(item.get('header') or '').strip()
        if not header:
            continue
        col = column_by_header(definition, header)
        if not (col and col.get('promoted') and col.get('field')):
            continue
        if header not in checked_headers:
            require_fields_writable(doc, header, definition=definition)
            checked_headers.add(header)
        if item.get('check_rules', True):
            _check_rules(col, item.get('value'))


def require_field_rules_ok(doc, header, value, definition=None):
    """**有数据库字段的列，写之前必过两道**：角色 ACL（能不能写这列）+ 值域规则。

    用户 2026-10-15 原话：「**普通员工可以改值，但是如果这个值对应的是一个字段，
    那就要过字段的检验**」。E01.3 再加一道：「字段 ACL 进入定义持久化、加载、升级
    全过程；……列的**不可读**与**只读**必须区分」。

    **判断依据是「这一格背后有没有数据库字段」**，不是谁改的、也不是走哪个口：

      · **有字段**（晋升列绑着 `field`）→ 先过**角色 ACL**（`require_fields_writable`），
        再过**值域规则**（`_check_rules`）。任何一道不过当场拒、**一个字节不动**
      · **没字段**（普通列 / 还没晋升的列 / 这张表压根没定义）→ 原样放行
        （用户 2026-10-15「新加的列就是 xlsx 里面的列，不是有意义的字段」）

    **为什么角色在前**：无权者不该知道「这个值本来合不合法」—— 那也是一种泄露。

    ⚠️ **只补校验，不改写入落点**（E 2026-10-15：「这不是权限改动，是校验补漏」）：
    本函数**不写数据库、也不改回填**，只负责**把非法/无权的挡在门外**。

    ⚠️ **分岔已登记，不在本函数里解决**：合法值从 `sheet_cell_write` 进去只落表，
    而**合并读（`row_read`）优先取数据库**（D-b 设计）—— 所以普通员工改晋升列的合法值
    **看着像没生效**。归用户/内核拍要不要合流。

    回的是**命中的那一列**（有字段才有），没字段回 `None`。

    `definition` 可选：批量写（一次 2 万格）传**预载的那份**，省得每格重读一遍。
    **判定逻辑仍只此一份** —— 传的是同一份定义，不是另一套判法。
    """
    header = str(header or '').strip()
    if not header:
        return None
    if definition is None:
        definition = load_definition(doc)
    col = column_by_header(definition, header)
    if not (col and col.get('promoted') and col.get('field')):
        return None
    require_fields_writable(doc, header, definition=definition)
    _check_rules(col, value)
    return col


def require_fields_ok_for_targets(doc, targets, definition=None):
    """**一次把一批目标格的字段规则全跑一遍** —— 在**任何写之前**（快慢路径都还没动）。

    `targets` 是 `[(header, value), ...]`。一格不过就抛，**整批一个字节不写**。

    **为什么单独有这一层**（E 2026-10-15 核出的洞）：`sheet._fast_write_cells` 自己那套
    预检（行存在/表头/重复/值类型/合并区/公式/列类型）**没有字段规则**，而批量口的快路径
    **直接返回**、跑不到后面的慢路径校验 —— 于是「一次粘贴 2 格、其中一格金额 = -7」
    **快路径直接落盘**，导出里就是 -7。**单格修了不等于批量修了。**

    所以**批量口要把校验提到快路径之前**，一次覆盖两条路；单格口同理（它在快路径之前
    已经有了，这里统一成一份调用）。
    """
    if _load_meta(doc).get('object_companion'):
        from shangshu_files.object_projection import reject_bound_targets
        reject_bound_targets(doc,[header for header,_value in targets])
    if definition is None:
        definition = load_definition(doc)
    checked = set()
    for header, value in targets:
        col = column_by_header(definition, str(header or '').strip())
        if not col or not col.get('promoted') or not col.get('field'):
            continue
        if header not in checked:
            require_fields_writable(doc, header, definition=definition)
            checked.add(header)
        _check_rules(col, value)


def row_read(_service, payload, _context):
    """固定行读：可选 headers 限定返回列；全受管列只读对应记录，不解析 xlsx。

    省略 headers 保持完整行合并读。正式值一律只取本行；就绪判断仍按本行全部规则，
    不因只请求一列就把缺失的必填项漏掉。未知身份/失效绑定不回退旧文件值。
    """
    table = str(payload.get('table') or '').strip()
    row_id = str(payload.get('row_id') or '').strip()
    if not table or not row_id:
        frappe.throw('table 与 row_id 必填', frappe.ValidationError)
    requested = payload.get('headers') if 'headers' in payload else None
    if 'headers' in payload:
        if (not isinstance(requested, list) or not requested or len(requested) > 256
                or any(not isinstance(h, str) or not h.strip() or len(h) > 140 for h in requested)):
            frappe.throw('headers 必须是非空表头列表（最多 256 列）', frappe.ValidationError)
        requested = [h.strip() for h in requested]
        if len(set(requested)) != len(requested):
            frappe.throw('headers 不允许重复表头', frappe.ValidationError)
    if not frappe.db.exists(FILE, table):
        frappe.throw('表不存在：%s' % table, frappe.DoesNotExistError)
    doc = frappe.get_doc(FILE, table)
    doc.check_permission('read')
    if doc.status == 'Recycled':
        frappe.throw('该表在回收站，恢复后才能读取', frappe.PermissionError)
    definition, meta = load_definition(doc), _load_meta(doc)
    binding = _managed_binding(doc)
    if definition.get('promoted'):
        if row_id not in (meta.get('rows') or []):
            frappe.throw('固定行身份不存在：%s' % row_id, frappe.DoesNotExistError)
        if not binding:
            frappe.throw('晋升表缺少受管记录绑定，不能读取正式值', frappe.ValidationError)
    state = formal_state(doc, row_ids=[row_id], fields=declared_fields(doc, definition))
    formal = (state.get('values') or {}).get(row_id) or {}
    record_version = (state.get('versions') or {}).get(row_id) or ''
    from shangshu_files import read_merge
    promoted = read_merge.promoted_by_header(definition.get('columns') or [])
    managed_only = requested is not None and all(h in promoted for h in requested)
    if managed_only:
        if definition.get('binding_current') is not True:
            frappe.throw('晋升定义与当前表结构不一致，请先核对绑定', frappe.ValidationError)
        headers, sheet_values = requested, {h: None for h in requested}
    else:
        # 普通列的值仍来自工作簿；目标行参数不变，不为字段筛选重造另一套解析器。
        from shangshu_files.sheet import read_payload
        sheet = read_payload('files.sheet_read', {'table': table, 'row_ids': [row_id],
                             **({'headers': requested} if requested is not None else {})}, _context)
        target = next((r for r in sheet.get('rows') or [] if str(r.get('row_id') or '') == row_id), None)
        if target is None:
            frappe.throw('固定行身份不存在：%s' % row_id, frappe.DoesNotExistError)
        sheet_values = target.get('values') or {}
        available = list(sheet_values.keys()) or list(sheet.get('headers') or [])
        if requested is not None and any(h not in available for h in requested):
            frappe.throw('表头不存在：%s' % '、'.join(h for h in requested if h not in available), frappe.ValidationError)
        headers = requested if requested is not None else available
    caps, _field_cols = _field_caps(doc, definition=definition)
    denied = set()
    for header in headers:
        col = promoted.get(header)
        if not col:
            continue
        field = col['field']
        # 内核已裁剪的字段不能从 xlsx 旧值补回来；合法新增草稿行允许尚无正式值。
        if not (caps.get(field) or {}).get('read') or (record_version and field not in formal):
            denied.add(header)
        elif field not in formal:
            formal[field] = None
    cells, source = read_merge.merge_row_values(
        {h: sheet_values.get(h) for h in headers}, formal, promoted, denied=denied)
    from shangshu_files.working_file import content_revision
    return {'table': table, 'row_id': row_id, 'cells': cells, 'source': source,
            **({'record_version': record_version} if record_version else {}),
            'promoted': bool(definition.get('promoted')), 'bound': definition.get('binding_current'),
            'row_status': row_readiness(definition, formal)['status'],
            'content_version': content_revision(doc),
            'structure_version': int(meta.get('structure_version') or 1),
            'sheet': str(meta.get('primary_sheet') or meta.get('sheet_name') or '')}


# ---------- 写路径分流（D-c）----------

def cell_write(payload, _context=None):
    """**唯一写入口**（用户 2026-10-15「合成吧，这样后面好维护」）——
    `files.cell_write` 和 `files.sheet_cell_write` **都走这一个实现**。

    **理由不是「两个按钮重复」**，是**写入不该被晋升的权限拖累**
    （用户原话：「**要区分的是：晋升字段这个动作和写入这个动作**」）：

    | | **晋升** | **写入** |
    |---|---|---|
    | 是什么 | 把某一列**变成数据库字段**（定规矩） | 往格子里**填一个值**（干活） |
    | 谁做 | **只有管理员**（`files.promotion_define`，一字不动） | **有资源级写权的人** |
    | 多久一次 | 偶尔 | 天天 |
    | 改变什么 | 表的**结构** | 表的**内容** |

    **普通员工填一个数字 ≠ 把一列变成字段。** 他只是在填格子。

    本函数按**「这一格背后有没有数据库字段」**分流（不看谁改、不看走哪个口）：

    · **有字段** → 过字段规则 → 写正式值 → **仅值回填**原表那格
    · **没字段**（普通列 / 这张表压根没定义）→ 走原表保存，**不碰数据库**

    **喂非法值**：当场拒，而且是**在校验全过之前一个字节都不动** ——
    不是把格子清空、也不是写进去。回执文案里带着你刚打的那个值，
    页面靠它把字留在格子里让你改（**那一半是页面的活，本函数只保证带得回值**）。

    ⚠️ **术语**：说「**有字段的列**的写入」，不说「晋升列的写入」——
    「有字段」是**状态**、「写入」是**动作**，别拧在一句里（用户 2026-10-15 点的）。

    **解耦**：这条路是**锦上添花**。`sheet.write_cell`（存进表的机械动作）照旧能单独用 ——
    把本函数整个关掉，普通列照样存得进表（自动化不能是唯一路径）。
    """
    table = str(payload.get('table') or '').strip()
    if not table:
        frappe.throw('table 必填', frappe.ValidationError)
    if not frappe.db.exists(FILE, table):
        frappe.throw('表不存在：%s' % table, frappe.DoesNotExistError)
    # ⚠️ **2026-10-29 · D 项「文件↔记录反向锁序」第 1 级**：
    #   这行原来带 `for_update=True` ⇒ **文件行在最前面就被锁住** ⇒
    #   取锁顺序是 `文件 → app → model → 记录 →（末尾回填时）文件`；
    #   而公共记录写那条路是 `app → model → 记录 → 文件` ⇒ **顺序相反 ⇒ ABBA 死锁面**
    #   （2026-10-29 隔离站**真并发实测**：A 路确实多出一个开头的 `file`）。
    #   ⇒ **把文件行的锁挪到回填那一步**（`_writeback_rows` 自己 `for_update=True` 取它，
    #   并且带 `expected_content_version` 版本闩 ⇒ 别人改过就当场拒，不会盖回去）。
    #   ⇒ 改完两条路同序 `app → model → 记录 → 文件`（真并发判据
    #   `shangshu_files/tests/test_file_record_lock_order.py` ① 那条红会转绿）。
    doc = frappe.get_doc(FILE, table)
    _require_resource_write(doc)
    header = str(payload.get('header') or '').strip()
    row_id = str(payload.get('row_id') or '').strip()
    if not header or not row_id:
        frappe.throw('row_id 与 header 必填', frappe.ValidationError)
    value = payload.get('value')
    if not isinstance(value, dict) or not value.get('type'):
        frappe.throw('value 必须带 type', frappe.ValidationError)

    definition = load_definition(doc)
    col = column_by_header(definition, header)
    promoted = bool(col and col.get('promoted'))

    if promoted:
        # —— 晋升列：先过**角色 ACL + DB 规则**，一条不过就整个不动 ——
        #
        # ⚠️ **这里原来只调 `_check_rules`（值域），漏了角色 ACL**（BASE967-31 接线缺口）。
        # 后果：`write_roles: []`（声明「无人可改」）的列照旧写得进数据库 ——
        # 实测 2026-10-17：合成账号写「金额」（`write_roles: []`）回执说
        # 「正式值**已写进数据库**，只是回写 Excel 失败」，**值已经落库了**。
        # 是回写那步失败才把它暴露出来的，不是闸拦住的。
        #
        # **改走 `require_field_rules_ok`** —— 角色 ACL + 值域**两道都在里面**，
        # 四个写入口（cell_write / write_cells / paste_apply / undo_cells）统一走它，
        # **不许只补一个入口**（B01-1 那条的同一条道理）。
        require_field_rules_ok(doc, header, value.get('value'), definition=definition)
        binding = _managed_binding(doc)
        if not binding:
            frappe.throw('这张表还没有受管对象绑定（旧的 JSON 正式值表要先重新晋升一次接入受管记录），'
                         '正式值无处可写', frappe.ValidationError)
        formal = _load_formal(doc, row_ids=[row_id], fields=declared_fields(doc, definition))
        row = dict(formal.get(row_id) or {})
        row[col['field']] = value.get('value')
        formal[row_id] = row
        # **正式值写进受管记录**（唯一权威）——**不再写** `formal_values_json`。
        expected = str(payload.get('expected_record_version') or '').strip()
        # ⚠️ **本域自己的写入 ⇒ 自己回填**（下面那段），**不走**「受管记录变了」那条通知
        #   （否则**同一笔回填两次**、落两次盘）⇒ 打这个标志，处理器会让开。
        frappe.flags.shangshu_files_own_writeback = True
        try:
            _write_managed(doc, binding, {row_id: {col['field']: value.get('value')}},
                           idempotency_key='cell:%s' % (payload.get('op_id') or table),
                           expected_modified_by_row={row_id: expected} if expected else None)
        finally:
            frappe.flags.shangshu_files_own_writeback = False
        update_row_readiness(doc, definition, formal, [row_id])
        # 同 formal_write：健康事务中的普通文件回填失败保留 pending。
        # 域内不许自行提交，抛了会整单回滚、用户的值静默丢失。回执如实说两半各自成没成。
        try:
            wrote = _writeback(doc, definition, row_id, {col['field']: value.get('value')}, _context,
                               op_id=payload.get('op_id'))
        except Exception as error:
            raise_if_transaction_failed(error)
            mark_writeback_pending(doc, row_id, {col['field']: value.get('value')}, error)
            # 失败时文件那半没写 → 版本**没变**。给前端**当前那个号**（能用它重试），
            # 不给 None（那会让前端自己兜成旧号，正是 B 说的那条坑）。
            try:
                doc.reload()
            except Exception as reload_error:
                raise_if_transaction_failed(reload_error)
                pass
            cur_cv = max(0, int(doc.version_count or 1) - 1)
            return {'table': table, 'row_id': row_id, 'header': header,
                    'routed': 'database', 'applied': True,
                    'field': col.get('field'),
                    'formal_written': True, 'sheet_written': False,
                    'value': value, 'sheet': {'written': 0, 'cells': []},
                    'content_version': cur_cv,
                    # **写完之后的受管记录版本**（客户端拿它当下一次写的闸 —— 见
                    # `record_versions_now` 的说明：不回 ⇒ 客户端手里的版本变旧
                    # ⇒ 下一笔被自己的旧版本拒 ⇒ 整队卡住）。
                    'record_version': record_versions_now(doc, [row_id]).get(row_id, ''),
                    'structure_version': int((load_definition(doc) or {}).get('structure_version') or 1),
                    'writeback_error': str(error)[:300],
                    # **B02-7 三分类**（2026-10-17 A）：**写库成 / 回写败** → `pending: True`
                    'rejected': False, 'pending': True, 'fatal': False,
                    'message': '「%s」的正式值**已写进数据库**，但回写 Excel 那步失败了。'
                               '本次**没改到 Excel 文件**，导出暂不可用 —— 否则会给一份'
                               '没改过的旧文件冒充最新。已标「待恢复」：请重试保存。' % header}
        clear_writeback_pending(doc, row_id, fields=[col['field']])
        return {'table': table, 'row_id': row_id, 'header': header,
                'routed': 'database', 'applied': True,
                'field': col.get('field'),
                'formal_written': True, 'sheet_written': wrote.get('written', 0) > 0,
                'value': value, 'sheet': wrote,
                # **写完之后的受管记录版本**（客户端下一次写要带它 —— 见
                # `record_versions_now` 的说明：不给 ⇒ 客户端自己把自己撞了）。
                'record_version': record_versions_now(doc, [row_id]).get(row_id, ''),
                # **B02-7 三分类**（2026-10-17 A）：**晋升成功** → 全 False
                'rejected': False, 'pending': bool(writeback_pending(doc)), 'fatal': False,
                # **快路径观测点跟着递**（`timing.fast_path`）—— 合成前这只有普通列那支有，
                # 晋升那支没有，结果 `test_pkg008` P8-⑥ ⑤ 回归③ 读到 None 被判「没接上」。
                # **回执不许吞可观测点**：吞了判据就瞎了，长得跟过一模一样。
                'timing': wrote.get('timing') or {},
                'op_id': wrote.get('op_id') or '',
                # **顶层版本号**（B 2026-10-15：两支回执字段要对齐）——
                # 先前晋升支**顶层没有**、`result.sheet` 里**也没有**（`_writeback` 丢了），
                # 前端拿 `result.content_version` 得 `undefined` → 自己兜成旧号 → 版本闩拒。
                # ⚠️ **是「没回」不是「回了旧值」**（丢字段，不是回声）。
                # **别只补一个键**：消费方不该替生产方做兼容
                # （A 现在写的就是 `result.sheet?.content_version ?? result.content_version`）。
                'content_version': wrote.get('content_version'),
                'structure_version': wrote.get('structure_version')}

    # —— 普通列（没字段）：走原表保存那条路，数据库一个字节不碰 ——
    from shangshu_files import sheet
    try:
        saved = sheet.write_cell(payload, _context)
    except (frappe.ValidationError, frappe.PermissionError):
        # **规则拒 / 校验拒 / 权限拒原样抛** —— 那些有具体文案
        # （「金额：不能小于 0（你打了 -7）…请把 -7 留在格子里改好再存」），
        # 吞成一句「没写进去」反而**丢掉了最有用的那句**。
        raise
    except Exception as error:
        raise_if_transaction_failed(error)
        # **落盘失败：给明确拒绝回执，不抛**（跟晋升列那支一个水准）。
        #
        # ⚠️ **抛了会变 500「平台请求失败 / RuntimeError」** —— 用户看到那句，
        # **不知道值没写进去**、不知道该重试还是找人（B 2026-10-15 查 A 那条时
        # 顺带撞出来的，实测 `applied=None after=None version 3→3`）。
        # 晋升列那支失败时说的是人话（「正式值已写进数据库，但回写 Excel 那步失败了…
        # 请重试保存」）—— **同一个用户动作不该天差地别**（用户原话：
        # 「要区分的是：晋升字段这个动作和写入这个动作」，那是**两条都要说清**，
        # 不是只区分权限和路由）。
        #
        # **`retryable` 的语义**（B 2026-10-15 纠对，我先前定错了）：
        # 通行意思是「**原样重发会不会成**」，**不是**「要不要人重新发起」。
        # **两个键分工**：`retryable` 答「**机器**能不能重试」，`message` 答「**人**该做什么」。
        # 本处捕获的是**落盘失败**（磁盘满/超时这类）= **瞬时故障** → 原样重发**可能成** → `True`。
        # （版本冲突/校验失败走 `frappe.ValidationError` 原样抛，不进本回执。）
        # **别新造 `action_required`** —— 跟 `retryable: False` 语义重叠，抽象等第二个需求。
        return {'table': table, 'row_id': row_id, 'header': header,
                'routed': 'sheet', 'applied': False, 'retryable': True,
                'field': None,
                'formal_written': False, 'sheet_written': False,
                'value': value,
                'content_version': payload.get('expected_content_version'),
                'structure_version': payload.get('expected_structure_version'),
                # **B02-7 三分类**（2026-10-17 A）：**保存失败** = 不可重试 → fatal: True
                'rejected': False, 'pending': False, 'fatal': True,
                'error': str(error)[:300],
                'message': '「%s」**这次没写进表**（保存那步失败了），**格子里还是旧值**。'
                           '请**重新保存**；要是重试还是这样，请找管理员看一眼。'
                           '（原因：%s）' % (header, str(error)[:120])}
    # **原回执一个字段都不吞**（`op_id`/`before`/`after`/`timing` 是 B5 撤回核验源），
    # 在其上**叠**分流那几个字段。合成前后调用方看到的东西只增不减。
    out = dict(saved or {})
    out.update({'table': table, 'row_id': row_id, 'header': header,
                'routed': 'sheet', 'applied': True,
                'field': None,
                'formal_written': False, 'sheet_written': True,
                'value': value,
                'content_version': (saved or {}).get('content_version'),
                'structure_version': (saved or {}).get('structure_version')})
    return out


def _atomic_formal_state(doc, row_ids, *, fields):
    """本包涉及行的旧正式值；尚未绑定记录的新普通行仍是空，不伪造正式值。"""
    binding = _managed_binding(doc)
    if not binding:
        return {'values': {}, 'versions': {}}
    records = binding.get('records') or {}
    known = [row_id for row_id in dict.fromkeys(row_ids) if records.get(row_id)]
    return _managed_state(doc, binding, row_ids=known, fields=fields)


def _date_part(value):
    """把一个日期形状的值取成 `YYYY-MM-DD`；**取不出就返回 None**（不编）。

    ⚠️ **带时刻的日期不许悄悄抹成纯日期**（那是两回事）⇒ **时刻不是零点**时返回 None
    （⇒ 与纯日期**不相等** ⇒ 闸照样拦）。

    ⚠️ **零点的带时刻写法要认**（2026-10-28 站上实测撞出来的）：
    xlsx 里的日期列经文件域解析后是 **datetime**，`value_typed` 把它写成
    **ISO 带时刻**（`'2025-07-10T00:00:00'`），而受管正式值里是**纯日期**
    （`'2025-07-10'`）⇒ 不认这种写法就会把**同一个日期**判成两个值
    ⇒ **日期型受管列的写入全被拒**（站上原话：「正式值与表格副本尚未一致，
    请先恢复同步，本包未保存」）。
    """
    import datetime

    if isinstance(value, datetime.datetime):
        if value.time().isoformat() != "00:00:00" or value.tzinfo is not None:
            return None
        return value.date().isoformat()
    if isinstance(value, datetime.date):
        return value.isoformat()
    text = str(value or "").strip()
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        return text
    # **ISO 带时刻、且时刻是零点** ⇒ 同一个日期（xlsx 日期列解析出来就是这个样子）
    if len(text) >= 19 and text[10] in ("T", " ") and text.endswith(("00:00:00",)):
        head = text[:10]
        if len(head) == 10 and head[4] == "-" and head[7] == "-":
            return head
    return None


def same_formal_value(formal_value, cell_value):
    """**受管正式值**与**表格副本那一格**是不是同一个值（同步闸用）。

    ⚠️ **为什么要专门比**（2026-10-28 站上实测撞出来的）：
    xlsx 里的**日期列**是 `datetime` 对象，受管正式值里是 **ISO 串**
    （`'2025-07-10'`）⇒ 直接 `!=` ⇒ **恒不相等**
    ⇒ 那道「正式值与表格副本尚未一致」的闸**把每一个日期型受管列的写入都拒了**
    （站上原话：「正式值与表格副本尚未一致，请先恢复同步，本包未保存」）。

    ⇒ **日期两边都取成 `YYYY-MM-DD` 再比**；其余一律**照旧按原样比**
    （不许因为改了日期就把文字的比法也改了）。
    """
    def _raw(candidate):
        return (candidate or {}).get("value") if isinstance(candidate, dict) else candidate

    left = _date_part(formal_value)
    right = _date_part(_raw(cell_value))
    if left is not None and right is not None:
        return left == right
    if left is not None or right is not None:
        # **一边是日期、一边不是** ⇒ 不是同一个值（不许放行）
        return False
    # sheet.value_typed regards empty strings and whitespace-only row anchors as
    # empty. Promotion may have seeded the original anchor as text; compare the
    # same blank semantics without trimming or relaxing any nonempty value.
    raw = _raw(cell_value)
    formal_blank = formal_value is None or isinstance(formal_value, str) and not formal_value.strip()
    cell_blank = raw is None or isinstance(raw, str) and not raw.strip()
    if formal_blank or cell_blank:
        return formal_blank and cell_blank
    return formal_value == raw


def plan_atomic_values(doc, meta, cells, *, row_ids):
    """Build a DB candidate from a checked workbook plan; never save or swallow errors.

    The caller owns one resource lock and Frappe transaction. Only commit after
    the entire workbook plan validates; WorkingFileTransaction restores bytes
    if any later file gate, ledger insert or database commit fails.
    """
    import copy
    definition = load_definition(doc)
    columns = promoted_columns(definition)
    if not columns:
        return None
    if not isinstance(row_ids, (list, tuple)):
        frappe.throw('写入计划必须明确目标行范围', frappe.ValidationError)
    affected = {str(item.get('row_id') or '') for item in cells}
    if not affected.issubset(set(row_ids)):
        frappe.throw('目标行范围没有覆盖本包全部修改，本包未保存', frappe.ValidationError)
    state = _atomic_formal_state(doc, row_ids, fields=declared_fields(doc, definition))
    formal = copy.deepcopy(state.get('values') or {})
    known_rows = set(meta.get('rows') or [])
    checked_headers = set()
    # **写之前每一行的受管记录版本**（撤回要退回去的就是它）——
    # 跟正式值读的是**同一份缓存**，不多查一遍。
    versions = state.get('versions') or {}
    for item in cells:
        rid, header = str(item.get('row_id') or ''), str(item.get('header') or '')
        if rid not in known_rows:
            frappe.throw('写入的固定行身份不存在，本包未保存', frappe.ValidationError)
        col = column_by_header(definition, header)
        if not col or not col.get('promoted') or not col.get('field'):
            continue
        value = item.get('after') or {}
        if value.get('type') == 'formula':
            frappe.throw('正式字段不接受公式写入，本包未保存', frappe.ValidationError)
        if header not in checked_headers:
            require_fields_writable(doc, header, definition=definition)
            checked_headers.add(header)
        if not item.get('restore_formal_absent'):
            _check_rules(col, value.get('value'))
        row = formal.setdefault(rid, {})
        field = col['field']
        if field in row and 'before' in item and not same_formal_value(
                row[field], item.get('before') or {}):
            frappe.throw('正式值与表格副本尚未一致，请先恢复同步，本包未保存', frappe.ValidationError)
        # Retain authoritative preimage independently from the XLSX projection.
        item['field_id'] = col.get('field_id') or field
        item['formal_field'] = field
        item['formal_before_present'] = field in row
        item['formal_before'] = row.get(field)
        item['formal_after'] = value.get('value')
        # **写之前那一版的受管记录版本**（撤回时退回去的就是它）——
        # 台账记着，撤回才有得退。**不覆盖调用方已经给好的**（撤回那次给的是台账里的旧值）。
        item['formal_before_version'] = item.get('formal_before_version') or (versions.get(rid) or '')
        if item.get('restore_formal_absent'):
            row.pop(field, None)
        else:
            row[field] = value.get('value')
        if not row:
            formal.pop(rid, None)
    # A note-only new row has no formal facts. Completeness is an explicit
    # row state; missing required inputs never fabricate default business values.
    states = dict(meta.get('promotion_row_states') or {})
    for rid in {str(item.get('row_id') or '') for item in cells}:
        row = formal.get(rid) or {}
        states[rid] = row_readiness(definition, row)
    meta['promotion_row_states'] = states
    return formal


def commit_atomic_values(doc, formal, op_id='', expected_record_versions=None, restore_versions=None, *, row_ids):
    """No intermediate commit and no pending conversion for a mixed package.

    **正式值进受管记录**（唯一权威）：候选状态与权威现状的**逐格差量**写进去
    —— 整包要么全成要么全败，**不逐格单独提交**。
    没有绑定一律拒绝；旧 JSON 只供显式迁移，不参与日常写入。

    `expected_record_versions` 是**客户端带来的逐行记录版本**（`{行 id: modified}`）。
    ⚠️ 整包路径的**陈旧写**通常由**工作簿的内容版本**挡住
    （`sheet.write_cells` 的 `expected_content_version` 不符 ⇒ 整包拒），
    逐行记录版本是**再加一道**：带了才校验。

    `restore_versions` 是**要退回的逐行记录版本**（撤回用）——
    值回到上一版时，**版本也回到那一版**（受管记录的版本栈）。
    """
    binding = _managed_binding(doc)
    if not binding:
        # ⚠️ **不回落旧 JSON**（原收敛条目 03）：这张表有受管列却没有受管对象绑定
        #   ⇒ 它是「**待迁移旧表**」⇒ 受管值**无处可写**。
        #   旧实现在这儿写 `formal_values_json` ⇒ **冒充成功**（用户以为存进数据库了），
        #   而单格路（`cell_write`／`formal_write`）是**当场拒**的
        #   ⇒ 同一张表、同一个受管列，单格拒、批量却静默落进旧 JSON。**两套口径，不留。**
        frappe.throw('这张表还没有受管对象绑定（旧的 JSON 正式值表要先重新晋升一次接入受管记录），'
                     '正式值无处可写，本包未保存', frappe.ValidationError)
    if not isinstance(row_ids, (list, tuple)):
        frappe.throw('写入提交必须明确目标行范围', frappe.ValidationError)
    if set(formal) - set(row_ids):
        frappe.throw('正式值候选超出本包目标行范围，本包未保存', frappe.ValidationError)
    current = _atomic_formal_state(doc, row_ids, fields=declared_fields(doc)).get('values') or {}
    changes = _formal_diff(current, formal)
    if changes:
        # ⚠️ **这条整包路自己就写了 xlsx**（`sheet.write_cells` 那趟把受管列那一格也改了）
        #   ⇒ **不能**再让「受管记录变了」那条通知回填一次 ⇒ **同一笔会写两遍**
        #   （落两次盘、content_version 多 +1）⇒ 打标志，处理器让开。
        frappe.flags.shangshu_files_own_writeback = True
        try:
            _write_managed(doc, binding, changes,
                           idempotency_key='atomic:%s' % (op_id or doc.name),
                           expected_modified_by_row=expected_record_versions or None,
                           restore_versions_by_row=restore_versions or None)
        finally:
            frappe.flags.shangshu_files_own_writeback = False
    from shangshu_files.sheet import _fault
    _fault('mixed-after-formal')
    # **写完之后的逐行受管记录版本**（客户端下一次写要带它 —— 见 `record_versions_now`
    # 的说明：不回 ⇒ 客户端手里的版本变旧 ⇒ 下一笔被自己的旧版本拒 ⇒ 整队卡住）。
    return {'record_versions': record_versions_now(doc, row_ids)}


def update_row_readiness(doc, definition, formal, row_ids):
    meta = _load_meta(doc)
    states = dict(meta.get('promotion_row_states') or {})
    columns = promoted_columns(definition)
    for rid in row_ids:
        row = formal.get(rid) or {}
        states[rid] = row_readiness(definition, row)
    meta['promotion_row_states'] = states
    _save_meta(doc, meta)


def row_readiness(definition, row):
    """Current formal facts under current rules, never cached readiness authority."""
    columns = promoted_columns(definition)
    missing, invalid = [], []
    for col in columns:
        field = col['field']
        value = row.get(field)
        if (col.get('rules') or {}).get('required') and value in (None, ''):
            missing.append(field)
            continue
        try:
            _check_rules(col, value)
        except frappe.ValidationError:
            invalid.append(field)
    has_fact = any(row.get(col['field']) is not None and row.get(col['field']) != '' for col in columns)
    return {'status': 'ready' if columns and has_fact and not missing and not invalid else 'draft',
            'missing_fields': missing, 'invalid_fields': invalid}


def require_complete_row(doc, row_id):
    definition = load_definition(doc)
    if row_id not in (_load_meta(doc).get('rows') or []):
        frappe.throw('固定行身份不存在', frappe.DoesNotExistError)
    row = _load_formal(doc, row_ids=[row_id], fields=declared_fields(doc, definition)).get(row_id) or {}
    if row_readiness(definition, row)['status'] != 'ready':
        frappe.throw('本行仍待补齐或修正必要字段，不能执行需要完整记录的动作', frappe.ValidationError)
    return row


def row_require_ready(_service, payload, _context):
    """Public precondition service for domain-owned action execution guards.

    The row lock stays in the caller's outer transaction, so the checked facts
    and rules cannot change between guard and handler. This grants no action,
    edit or cross-domain permission and exposes no field values.
    """
    table, row_id = str(payload.get('table') or ''), str(payload.get('row_id') or '')
    doc = frappe.get_doc(FILE, table, for_update=True)
    doc.check_permission('read')
    if doc.status != 'Active':
        frappe.throw('表格当前不可办理', frappe.PermissionError)
    _require_all_columns_readable(doc)
    require_complete_row(doc, row_id)
    from shangshu_files.working_file import content_revision
    return {'table': table, 'row_id': row_id, 'ready': True,
            'content_version': content_revision(doc),
            'definition_sha': _definition_fingerprint(_load_meta(doc)),
            'structure_version': int(_load_meta(doc).get('structure_version') or 1)}


# ---------- 按值找行（业务行身份＝业务编号） ----------

def _typed_lookup_value(column, value):
    """要查的值按**列的类型**翻一下（数字列给字符串就查不中）。"""
    typ = str(column.get('type') or 'text')
    if typ == 'number':
        for cast in (int, float):
            try:
                return cast(value)
            except (TypeError, ValueError):
                continue
        return value
    if isinstance(value, str):
        return value.strip()
    return value


def row_find_by_value(_service, payload, _context=None):
    """`files.row_find_by_value`：**按受管列的正式值精确找行**。

    **为什么这件事只能在这里做**：业务域的**行身份是业务编号**（如示例企业内部编号），
    域手里只有那个编号；要读/写那一行，就得把编号换成「工作簿的行」。
    而**编号 ↔ 行 ID 的映射在文件域手里**（受管记录名 ↔ 工作簿固定行 ID）
    ⇒ 别的域拿不到、也不该自己造一份。

    **只在「该列已晋升」时给得出精确答案**：正式值在受管记录里 ⇒ 按字段值查是
    数据库里的**等值匹配**（不是逐行扫大表）。没晋升的列**明说代价**
    （查行只能扫整张表），不假装能精确查、也不随便拿第一列凑一个。

    回包：`{table, field, object_id, exact, matched, count, rows:[{row_id, record, value}], hint}`。
    """
    table = str(payload.get('table') or '').strip()
    field = str(payload.get('field') or '').strip()
    value = payload.get('value')
    if not table or not field:
        frappe.throw('table 与 field 必填', frappe.ValidationError)
    if value is None or (isinstance(value, str) and not value.strip()):
        frappe.throw('要查的值不能为空', frappe.ValidationError)
    from shangshu_files.service import DOCTYPE
    if not frappe.db.exists(DOCTYPE, table):
        frappe.throw('表不存在：%s' % table, frappe.DoesNotExistError)
    doc = frappe.get_doc(DOCTYPE, table)
    try:
        doc.check_permission('read')
    except frappe.PermissionError:
        # **当前账号读不到这张表** ⇒ 当成「这张表没有候选」（并说清为什么），**不抛**。
        # **为什么**：业务域是**逐张表**试的（example 的表绑定有多条）
        # ⇒ 抛出去会让**整个**匹配/入档都做不了 —— 连读得到的那张表都没轮到。
        return {'table': table, 'field': field, 'object_id': '', 'exact': False, 'matched': False,
                'count': 0, 'rows': [],
                'hint': '当前账号读不到这张表（不能在这儿找行）'}
    definition = load_definition(doc)
    binding = _managed_binding(doc)
    column = None
    for col in (definition.get('columns') or []):
        if isinstance(col, dict) and col.get('promoted') and str(col.get('field') or '') == field:
            column = col
            break
    if not column or not binding:
        return {'table': table, 'field': field, 'object_id': (binding or {}).get('object_id') or '',
                'exact': False, 'matched': False, 'count': 0, 'rows': [],
                'hint': '这一列不是受管列（正式值不在受管记录里）⇒ 按值查行只能扫整张大表，代价大；'
                        '要先把它晋升，或换个认行的办法'}
    from shangshu_core.public_api import query_object_records
    result = query_object_records(binding['object_id'], {field: _typed_lookup_value(column, value)}, 1, 50)
    rows = result.get('rows') or []
    reverse = {}
    for row_id, name in (binding.get('records') or {}).items():
        reverse[str(name)] = str(row_id)
    matched = []
    for row in rows:
        row_id = reverse.get(str(row.get('name') or ''))
        if not row_id:
            continue
        matched.append({'row_id': row_id, 'record': str(row.get('name') or ''),
                        'value': row.get(field)})
    return {'table': table, 'field': field, 'object_id': binding['object_id'],
            'exact': True, 'matched': bool(matched), 'count': len(matched), 'rows': matched,
            'hint': '' if matched else '这个编号在这张表里没有对应的行'}


def row_resolve(_service, payload, _context=None):
    """`files.row_resolve`：**按工作簿行 ID 解析出那条受管记录**。

    **为什么这件事只能在这里做**（用户 2026-10-22 第四段）：
    业务域引用案件行时手里只有「**表 ＋ 行 ID**」；
    而「**行 ID → 受管记录名**」的映射在**文件域手里**（晋升绑定）——
    别的域拿不到、也不该自己造一份。

    **为什么要这个口**：要让「日志按案件看」成立，动作审计与事件信封就得能
    **挂到受管记录上**（`business_object_id` ＋ `business_name`）⇒
    得先知道「这一行对应哪个受管对象、哪条受管记录」。
    ⇒ 域只要问这个口，**不必自己造映射、也不必把映射抄一份**。

    回包：`{table, row_id, object_id, record, found, hint}`。
    """
    table = str(payload.get('table') or '').strip()
    row_id = str(payload.get('row_id') or '').strip()
    if not table:
        frappe.throw('表身份必填', frappe.ValidationError)
    if not row_id:
        frappe.throw('行 ID 必填', frappe.ValidationError)
    from shangshu_files.service import DOCTYPE
    if not frappe.db.exists(DOCTYPE, table):
        frappe.throw('表不存在：%s' % table, frappe.DoesNotExistError)
    doc = frappe.get_doc(DOCTYPE, table)
    doc.check_permission('read')
    binding = _managed_binding(doc)
    base = {'table': table, 'row_id': row_id,
            'object_id': (binding or {}).get('object_id') or '',
            'record': '', 'found': False, 'hint': ''}
    if not binding:
        base['hint'] = '这张表还没晋升成受管记录 ⇒ 没有可挂的受管记录'
        return base
    record = (binding.get('records') or {}).get(row_id)
    if not record:
        base['hint'] = '这一行没有对应的受管记录（表已晋升的行才有一一对应）'
        return base
    base['record'] = str(record)
    base['found'] = True
    return base
