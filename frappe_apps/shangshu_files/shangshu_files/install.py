from shangshu_core.public_api import ensure_registered_domains, register_action

import frappe
from shangshu_files.domain import ACTIONS, PACKAGE_ACTION_VERSIONS, file_kind
from shangshu_files.domain_paths import ensure_declared_paths
from shangshu_files.location import ensure_constraints


def _register_actions():
    """**把本域的动作重新登记一遍**（幂等；同号同版本定义一样就当没变）。

    **为什么要有这个函数**（2026-10-26 实测撞出来的）：
    内核自己的动作每次 migrate 都登记（`shangshu_core.install.ensure_foundation`）——
    **域的动作却只在本域 `setup()`（装域时）登记** ⇒
    **「改了动作清单，migrate 不会刷新」** ⇒ 现场那个动作**调不出来**
    （内核 `refresh_domain_contributions` 的文档串里就写着这个症状：「动作未注册或已停用」）。
    ⇒ 登记循环抽到这里，**`refresh()` 也调**（内核每次 migrate 逐域调 refresh）
    ⇒ **改了动作清单，migrate 就刷新**（不用人记得手工跑 install.setup）。

    ⚠️ **版本进位是安全的**：`register_action` 的主键是「动作号@版本」⇒
    **版本进位＝新增一行**（不撞「同号同版本定义不一致」那道闸）；
    同一个号同一个版本定义没变 ⇒ 直接当没变（幂等）。
    """
    for action, title, roles, schema in ACTIONS:
        # files.upload 1.1.0：入参加 attribution（建表归属，B2）——同 key 不许隐式改定义，版本升位
        # 2026-10-13：四个结构动作（加行/加列/改表头/改表名）入参加 op_id（原操作号，计划
        # PKG-003-T04「提交携带原操作号」），schema 变了 → 各升 1.1.0，不许隐式覆盖旧定义。
        # files.sheet_paste_apply 是新动作，直接 1.0.0。
        # 2026-10-14：files.import_attachment 入参加 attribution（G1 归档也落组织归属）→ 1.1.0；
        #   同日两支并集再入参 mail_system（所有人/关联邮件，服务端推导，用户请求带上一律拒）
        #   → 1.2.0。加的都是**可选**字段，老载荷照旧合法 → 属小版本进位，不是大版本。
        #   合并前 B 只认 attribution、C 只认 mail_system，而 delivery.py 两个都发
        #   → 报「动作包含未声明字段」，来信附件自动入库一直在失败。合成并集后进位。
        # 2026-10-14 PKG-013-T01：`client_timestamp` 标 `ss_role='audit'`（审计上下文，
        #   不参与「是不是同一次」的业务指纹比对）→ schema 变了，**files.action_fact 升 1.1.0**。
        #   ⚠️ 这一笔当场演示了「两侧同时改、版本号同时升」的必要：只改 schema 不升版本，
        #   `register_action` 的闸会报「动作资源重复且定义不一致，禁止隐式覆盖」拦下迁移。
        # 2026-10-15 用户「**尚书是单例，没有企业归属**」→ ATTRIBUTION 的 enum 去掉 `enterprise`，
        # 合法值只剩 personal/department。**这是大版本进位，不是小版本**：
        # 之前那句「加的都是可选字段，老载荷照旧合法 → 属小版本」的**反面**就是这条 ——
        # `{'level':'enterprise'}` 原先是**合法**载荷，现在**非法**，老调用方会当场被拒。
        # 按 semver：破坏兼容 = major。升 2.0.0，别升 1.x —— 升小版本等于说「老的照旧能用」。
        # 受影响三个动作：files.upload / files.create / files.import_attachment（都带 ATTRIBUTION）。
        # 2026-10-15 第二刀：**新建必填归属**（用户选修法一「上传必填归属」）——
        # `attribution` 从可选变**必填**，原来能建的（不传归属）现在建不了。
        # **再破坏一次兼容**，跟上面 2.0.0 同一判据 → **3.0.0**，不挤进 2.x
        # （挤进 2.x 等于说「2.x 老调用照旧能用」，那是假的）。
        # 2026-10-15 用户「**合成吧，这样后面好维护**」+「要区分的是**晋升字段这个动作**
        # 和**写入这个动作**」→ `files.cell_write` 的**角色面**从 `['System Manager']` 放开到
        # `ROLES`（Desk User）。**写入不该被晋升的权限拖累** —— 晋升（`files.promotion_define`）
        # 仍是 System Manager，一字不动。
        # **角色面变了就是定义变了**，同 key 不升版本会被 `register_action` 的闸拦下。升 1.1.0：
        # **老调用方照旧能用**（System Manager 仍在 ROLES 之上，多出来的是可调的人），
        # 是**放宽**不是破坏 → 按 semver 走小版本，不走 2.0.0。
        # ⚠️ 但这是**安全相关的语义变化**，写在这里是为了让人一眼看见，不是靠小版本藏起来。
        #
        # `files.sheet_cell_write` 同日**行为**变了（合成进同一个实现，有字段的列改走数据库）
        # —— schema/roles 没变、闸不会拦，但**行为变了也该说一声**，一并进位 1.1.0。
        # 2026-10-17 用户「结构权是权限维度，表主当然有」→ 8 个结构动作的角色面
        # 从 `['Sheet Structure Editor']` 放宽到 `['Desk User']`（真判改由
        # `sheet._require_structure` → `org_admin.structure_allows` 在函数内做）。
        # **角色面变了就是定义变了**，同 key 不升版本会被 register_action 的闸拦下：
        # 原 1.1.0 的 4 个 → 1.2.0；BASE967-19 的 4 个 1.0.0 → 1.1.0。
        # 放宽是兼容性方向（老调用照旧可用），但**安全语义变了**，写在这里让人一眼看见。
        # 2026-10-18 43859cb1 改 `sheet.undo_cells`/`_fast_undo_cells` 回包 before/after 的语义
        # （before 改为恢复后值，after 改为被撤掉的旧值——修复「撤回后值没变」的产品 bug）：
        # 客户端读 after 拿旧值/读 before 拿新值，含义反了 = 定义变了，下面 4 个写动作 1.2.0 → 1.2.1。
        # 2026-10-18 a3c4c78c 把 `sheet._fast_undo_cells` 与 `sheet.undo_cells` 统一为
        # `before=恢复后值, after=撤回前值`（修复「页面撤了等于没撤」），含义反了 = 定义变了。
        # `sheet_cells_undo` 原本走 `.get(action,'1.0.0')` 兜底，显式提为 1.0.1。
        # 2026-10-20 FIX-18（1.3.1）：1.3.0 里的 fill_color 用了带 ()| 的正则，
        # 平台的 pattern 安全子集禁这两个字符 → 注册进去也过不了校验。
        # 改成「平台只管类型、格式由域内校验」（域内给中文提示），与边框同口径。
        # 2026-10-20 FIX-18：样式补丁新增 6 个**可选**项（fill_color/italic/underline/
        # horizontal_align/vertical_align/clear_format）→ 老载荷照旧合法 = 小版本进位
        # 1.2.0 → 1.3.0。列宽动作新增**可选**的 auto_fit_columns，且 column_widths
        # 从必填改为「与自动算宽二选一」→ 老调用方照旧可用 = 小版本进位 1.0.0 → 1.1.0。
        # Existing-field ACL editors pin the definition SHA; schema adds an optional guard.
        # Register a new immutable action revision rather than replacing 1.1.0.
        # 2026-10-20 FIX-49：列头筛选（Excel 的表现形式）——
        # `files.sheet_view_save` 的 view.filters 多了一个匹配方式 `in`（值在这几个里），
        # 且 `in` 的 value 是**字符串数组**（老四个 operator 的 value 仍是 ≤1000 字的字符串，一个字没改）。
        # 老载荷照旧合法（不含 `in` 的视图还是老样子）= **小版本进位** 1.0.0 → 1.1.0。
        # 同号不升版本会被 register_action 的闸拦下（定义不一致但版本号相同）。
        # PKG-132：new_resource 扩展到所有文件类型，说明随公开 schema 更新；
        # 保持旧载荷兼容，但必须登记新版本，不能同号覆盖旧定义。
        version = {'files.upload': '3.4.0', 'files.update_meta': '1.0.2', 'files.restore': '1.1.0',
                   # 2026-10-21：`files.upload` 的入参加了两个**可选**项
                   # （`create_only` 同名拒绝 / `new_resource` 同名另存），
                   # 且 FIX-60 把「.xlsx 同名 ⇒ 恒为新表」这条口径改了回来
                   # （合并时曾被降级成「默认追版本」）。
                   # **定义变了就必须升版本号** —— 同号不升会被 `register_action` 的闸拦下
                   # （「动作资源重复且定义不一致，禁止隐式覆盖」），**每个站点的 `bench migrate` 都会失败**。
                   # 老载荷照旧合法（多出来的两项可选、载荷形状没变；同名 xlsx 的结果回到我们线一直以来的口径）
                   # ⇒ 按 semver 走**小版本** 3.0.0 → 3.1.0，不走 2.x/4.0。
                   #
                   # 2026-10-21（agent 建表一线）：**归属字段的 description 重写成"人话＋怎么填"**
                   # （模型是照 description 办事的 ⇒ 它才知道该先问用户「这张表归谁」），
                   # **三个带归属的动作的 schema 都变了** ⇒ 三个都要升版本号
                   # （同号不升会被 register_action 的闸拦下，每个站点的 bench migrate 都会失败）。
                   # **只改 description、字段集合没变** ⇒ 老载荷照旧合法 = 小版本进位。
                   # ① files.upload 3.1.0 → 3.2.0；② files.import_attachment 3.0.0 → 3.1.0；
                   # ③ files.create 3.0.0 → 3.1.0（另加**可选**的 headers/placeholder
                   #   ＋ 标题改成说人话的一份 ⇒ 载荷形状仍是「file_name ＋ 其余可选」）。
                   'files.import_attachment': '3.1.0', 'files.create': '3.1.0', 'files.action_fact': '1.1.0',
                   # Optional append_at_end supports filtered-view appends; preserve old callers.
                   'files.sheet_input_write': '1.4.0', 'files.sheet_paste_apply': '1.4.0',
                   # 2026-10-20 PKG-004-T03 第 5 批：批量写可带**逐行受管记录版本**
                   # （`expected_record_versions`）⇒ 那一行被别人改过 ⇒ 整包被拒。
                   # 新增**可选**字段 ⇒ 老载荷照旧合法 = 小版本进位 1.2.0 → 1.3.0。
                   'files.sheet_cells_write': '1.3.0',
                   'files.sheet_style_write': '1.3.1', 'files.sheet_layout_update': '1.1.0',
                   # 第四批成包编辑：查找替换 / 填充序列 / 选择性粘贴（新动作，从 1.0.0 起）
                   'files.sheet_find_replace': '1.0.0', 'files.sheet_fill_series': '1.0.0',
                   'files.sheet_paste_special': '1.0.0',
                   'files.sheet_row_append': '1.2.2', 'files.sheet_column_append': '1.2.2',
                   'files.sheet_header_rename': '1.2.2', 'files.sheet_rename': '1.2.1',
                   'files.sheet_row_insert': '1.2.1', 'files.sheet_column_insert': '1.1.1',
                   'files.sheet_row_delete': '1.2.1', 'files.sheet_column_delete': '1.1.1',                   # 2026-10-20 PKG-004-T03 第 2 步：写已晋升格可带**受管记录版本**
                   # （`expected_record_version`）⇒ 陈旧写当场拒（不是后写覆盖先写）。
                   # 新增**可选**字段 ⇒ 老载荷照旧合法 = 小版本进位。
                   'files.cell_write': '1.4.0', 'files.sheet_cell_write': '1.4.0', 'files.formal_value_write': '1.3.0',
                   'files.sheet_range_read': '1.2.0',
                   # 2026-10-29（用户口径：个人视图加**列序**）：`files.sheet_view_save`
                   # 的 view 多了一个**可选**字段 `columns`（列名数组，按这个顺序显示）
                   # ⇒ 老载荷（不带它）照旧合法 ⇒ **小版本进位** 1.1.0 → 1.2.0。
                   # 同号不升版本会被 register_action 的闸拦下（「定义不一致但版本号相同」）
                   # ⇒ 每个站点的 `bench migrate` 都会失败。
                   'files.sheet_view_save': '1.2.0',
                   # 2026-10-29（「再点一次自动行高」的回头路）：`files.sheet_row_heights_write`
                   # 的 `row_heights` **值域放宽到 0**（0 ＝ 恢复自动行高：文件里那一行
                   # 不写 ht／customHeight ⇒ 打开就是自动行高）。
                   # ⇒ **入参 schema 变了 ⇒ 定义变了 ⇒ 版本必须进位** 1.0.0 → **1.1.0**。
                   # 老载荷（行高 ≥ 1）照旧合法 ⇒ 按 semver 走**小版本**。
                   # ⚠️ **不升版本的后果**：同一个 `动作号@1.0.0` 在站上已经登记着旧形状
                   # ⇒ `register_action` 的闸当场拒（「定义不一致但版本号相同」）
                   # ⇒ **每个站点的 `bench migrate` 都会失败**。
                   'files.sheet_row_heights_write': '1.1.0',
                   # 2026-10-21（合并 fast 之后）：`files.sheet_sort` 新增**可选**字段 `header`
                   # （与 `column` 同义，两种载荷形状都收），且 `column` 从必填改为
                   # 「与 `header` 二选一」⇒ **老载荷（发 `column`）照旧合法** = 小版本进位
                   # 1.1.0 → 1.2.0。同号不升版本会被 register_action 的闸拦下。
                   'files.sheet_sort': '1.2.0',
                   # 2026-10-26（PKG-117-T01 补记 · **修真缺陷**）：`files.promotion_define`
                   # 的**入参 schema 变了**（2026-10-25 加了表级权限主体范围 `access`，
                   # 列项也放开了 `additionalProperties`）⇒ **定义变了 ⇒ 版本必须进位**
                   # 1.2.0 → **1.3.0**。
                   # ⚠️ **不升版本的后果**（站上实测撞出来的）：同一个 `动作号@1.2.0` 在站上
                   # 已经登记着**旧形状** ⇒ `register_action` 的闸当场拒
                   # （「定义不一致但版本号相同」）⇒ **`bench migrate` 直接失败**
                   # ⇒ 部署升级那条路直接断。
                   'files.promotion_define': '1.3.0',
                   'files.sheet_cells_undo': '1.1.0',
                   # 合并说明：fast 那边的动作清单里**本分支没有**的动作，版本从 1.0.0 起 ——
                   # （同一个动作号只能有一个定义；同号不同版本会被 register_action 的闸拦下。）
                   # 2026-10-21（版本口径修复）：`files.edit_cells` 的前置条件**换了字段** ——
                   # 旧的是 `expected_modified`（记录修改时间：改个文件名也会推进它 ⇒ 假过期），
                   # 新的是 `expected_content_revision`（内容修订号：内容真变没变的凭据）。
                   # **必填字段换了 ⇒ 老载荷不再合法 ⇒ 破坏兼容 = 大版本进位** 1.0.1 → 2.0.0。
                   # （`expected_version` 仍在，但语义写清是「当前上传版本号」＝ `version_count` − 1。）
                   # 2.0.1/2.1.0：**description 又补了一句「坐标怎么算」**（工作表名取
                   # `sheet_range_read` 的 `sheet_title`；第 1 行是表头、数据行从第 2 行起）。
                   # ⚠️ **只改 description 也必须升版本号** —— `register_action` 的闸按
                   # 「同 registry_key 定义不一致就拒绝覆盖」判，description 在 schema 里
                   # ⇒ 同一版本号改文案会被拦下（DuplicateEntryError）⇒ 小版本进位 2.0.0 → 2.1.0。
                   # 2026-10-28（PKG-132 收尾 · 清客户总表的日期列）：**值的类型标记放行了 `d`（日期）**
                   # —— 以前只有 s／n／b ⇒ **日期格写不进去**（产品改不了日期列）
                   # ⇒ 改了输入 schema ⇒ **小版本进位** 2.1.0 → **2.2.0**（老载荷照旧合法）。
                   # 2026-10-28（同上）：**行号上限 1000 → 100000**（真表 15,503 行 ⇒ 1000 等于只能改前一千行）
                   # ⇒ 改了输入 schema ⇒ **小版本进位** 2.2.0 → **2.3.0**。
                   'files.new_version': '1.1.0', 'files.edit_cells': '2.3.0',
                   'files.sheet_structure': '1.0.0', 'files.sheet_style': '1.0.0',
                   # 2026-10-22（包件交接第 1 步）：`files.upload` 入参加**可选**的
                   # `container_sha256`（血缘：这份字节来自哪个原包）⇒ 老载荷照旧合法
                   # = **小版本进位** 3.2.0 → 3.3.0。
                   # `files.package.store` 是**新动作**（按包存成员 ＋ 广播成员清单），从 1.0.0 起。
                   'files.package.store': '1.0.0',
                   # 2026-10-23（PKG-047-T01 · 契约 §8 第 13 项）：**文件 ↔ 文件附件绑定**两个新动作
                   # （`files.attachment.bind` 挂附件 ／ `files.attachment.list` 父件侧列附件），从 1.0.0 起。
                   # ⚠️ `files.attachment.list` **1.0.0 → 1.0.1**：第一版误把它登记成**写**动作
                   # （⇒ 读口却要幂等键）⇒ **effect 变了就是定义变了** ⇒ 同号会被
                   # `register_action` 的闸拦下（DuplicateEntryError）—— 这正是它该做的。
                   'files.attachment.bind': '1.0.0', 'files.attachment.list': '1.0.1'}.get(action, '1.0.0')
        # 查询类动作标 read：读不需要幂等键（写才要）。
        # 只读动作不一定叫 *_query（T07 的 files.sheet_range_read 就是只读但不叫 query），
        # 所以列一份显式 READ 清单，不靠名字猜。
        # PKG-018-T06 第一阶段：`files.table_aggregate` 也是只读（统计一张表，不写任何东西）。
        # 2026-10-23（PKG-047-T01）：`files.attachment.list` 也是只读
        # （**父件侧列自己的附件** —— 不写任何东西，不该要幂等键）。
        READ_ACTIONS = {'files.sheet_range_read', 'files.table_aggregate',
                        'files.attachment.list'}
        effect = 'read' if (action.endswith('_query') or action in READ_ACTIONS) else 'write'
        confirm = 'none' if effect == 'read' else 'required'
        version = PACKAGE_ACTION_VERSIONS.get(action, version)
        register_action(action, version, title, effect, confirm, roles, schema, {})


def refresh():
    """migrate 时内核逐个调用域的刷新入口（`shangshu_core.domains.refresh_domain_contributions`）。

    **这里做两件与「域注册」有关的事**：
    ① 把**各域自己声明**的那块路径建出来 ⇒ 新装一个域、它声明了路径 ⇒ 下次 migrate 它的路径就在了（不用人去建目录）；
    ② **把本域的动作重新登记一遍**（`_register_actions()`）⇒ **改了动作清单，migrate 就刷新**。

    ⚠️ **第 ② 件事是 2026-10-26 补上的**（实测撞出来的）：
    登记动作的循环原先**只在 `setup()`** 里 ⇒ **migrate 永远不刷新**本域的动作
    ⇒ 现场那个动作**调不出来**（站上实测：文件域少了 4 个动作的登记，
    含契约 §8 第 13 项那个「文件 ↔ 文件附件绑定口」）。
    ⇒ 现在 `refresh()` 也登记 ⇒ **内核每次 migrate 逐域调它**就带上了。
    """
    ensure_registered_domains()
    ensure_declared_paths()
    _register_actions()


def setup():
    ensure_constraints()
    from shangshu_files.directories import migrate
    migrate()
    ensure_registered_domains()
    # **各域自己声明的那块路径**（用户 2026-10-22 15:52）—— 文件中心照办：
    # 域注册/装上时把它声明的路径建出来（幂等；已存在就是不动它）。
    ensure_declared_paths()
    _register_actions()
    # ↑ 动作登记挪到 _register_actions()（refresh() 也调它）——
    #   理由见那个函数的头一句话。













































































































































    # 类型仅由文件名推导；升级补齐索引列，不改变文件内容、归属和修改时间。
    doctype = 'Shangshu File Center File'
    while True:
        missing = frappe.get_all(doctype, filters={'file_kind': ['is', 'not set']},
                                 fields=['name', 'file_name'], limit_page_length=500)
        if not missing:
            break
        for row in missing:
            frappe.db.set_value(doctype, row.name, 'file_kind', file_kind(row.file_name), update_modified=False)
