"""文件中心域声明：动作 schema、对象与数据集、贡献。"""
import json
import re

import frappe
from shangshu_core.public_api import business_access
from shangshu_files.business_permissions import get_list as business_get_list
from shangshu_files.working_file import content_revision, has_working_copy
from shangshu_files.promotion import REVALIDATION_REASONS  # BASE967-27 promotion_status 服务的五值枚举
from shangshu_files.style_border import BORDER_PRESETS, BORDER_STYLE_CODES  # 边框预设与线型（动作契约声明用）

DOMAIN = 'com.shangshu.files'
ROLES = ['Desk User']
# One public edit/paste/undo action owns one log, including nested managed writes.
# Explicit versions preserve old request/proposal replay; daily callers use latest.
PACKAGE_ACTION_VERSIONS = {
    'files.sheet_cell_write': '1.5.0',
    'files.sheet_cells_write': '1.4.0',
    'files.sheet_input_write': '1.6.0',
    'files.sheet_paste_apply': '1.6.0',
    'files.sheet_cells_undo': '1.2.0',
}
# **结构权是权限维度，不是独立岗位**（用户 2026-10-17）——
# 动作层 `roles` 只是**粗闸**（8 个结构动作现在放宽到 `ROLES`，登录员工都调得到）；
# **真判在 `sheet._require_structure(doc)`** → 内核 `org_admin.structure_allows`：
# 表主 / System Manager / 本角色 → True；无归属 → None（回落旧口径）；其余 False。
# 这个常量保留给「旧口径回落」与迁移说明；**不再直接挂在动作上**。
# 合并说明：fast 那边把这个常量定义成 `ROLES`（= ['Desk User']）并直接挂在那 4 个结构动作上；
# 本分支这 4 个动作本来就用 `ROLES` ⇒ **实际角色面两边一致**，保留本分支的常量值
# （它还守着 domain.py / sheet.py 里那几处「旧口径回落」的 'Sheet Structure Editor' 字面量）。
STRUCTURE_ROLES = ['Sheet Structure Editor']
MANAGER_ROLES = {'System Manager'}

# 目录段仅允许字母、数字、中文、点、横线、下划线；根目录为 /。
SEGMENT = r'[\w\-.一-鿿]+'
DIRECTORY_PATTERN = re.compile(r'^/(?:' + SEGMENT + r'(?:/' + SEGMENT + r')*)?$')


def text(title, maximum=200):
    return {'type': 'string', 'title': title, 'maxLength': maximum}


def schema(properties, required, description=''):
    # `description` 是**人读的契约面**（内核 schema 校验认这个键）——
    # 模型看到的就是它，所以「怎么填」「没问清不要调」写在这儿，模型才知道该问。
    result = {'type': 'object', 'properties': properties, 'required': required,
              'additionalProperties': False}
    if description:
        result['description'] = description
    return result


REF = {'file': text('文件编号', 140)}
CONTENT = {'content_base64': {'type': 'string', 'title': '文件内容（Base64）', 'minLength': 1, 'maxLength': 40000000}}
TAGS = {'tags': {'type': 'array', 'title': '标签', 'maxItems': 10, 'items': text('标签', 20)}}
DIRECTORY = {'directory': {'type': 'string', 'title': '目录路径', 'maxLength': 200}}
DIRECTORY_ID = {'directory_id': text('目录编号', 140)}
NOTE = {'note': text('备注', 500)}
SHA = {'file_sha256': text('内容摘要（可选校验）', 64)}
# 合并说明：fast 那边新增的两个自由文件载荷常量（DOCX 正文 / 工作簿单元格）——
# 它们的动作（files.edit_paragraphs / files.edit_cells）已在合并后的动作清单里，常量要一起留。
CELL_CHANGES = {'type': 'array', 'title': '单元格修改（先读取原件；坐标从1开始）', 'minItems': 1, 'maxItems': 100,
    # ⚠️ **2026-10-28**：行号上限 **1000 → 100000** —— 以前 1000 的上限
    #   等于「一张真表（客户总表 15,503 行）只能改前 1000 行」⇒ **产品改不到后面的行**。
    'items': schema({'sheet': text('工作表名称', 31), 'row': {'type':'integer','minimum':1,'maximum':100000},
                     'column': {'type':'integer','minimum':1,'maximum':100},
                     # ⚠️ **2026-10-28**：`d`（日期）也放行 —— **以前只有 s／n／b**
                     #   ⇒ 日期列根本写不进去（写入口按列类型判：「须为日期」当场拒）。
                     'value': {**schema({'t':{'type':'string','enum':['s','n','b','d']},
                               'v':{'type':['string','number','boolean'],'maxLength':32767}}, ['t','v']), 'type':['object','null']}},
                    ['sheet','row','column','value'])}

PARAGRAPH_CHANGES = {'type':'array', 'title':'普通正文修改（先读固定版本，提供完整新段落）', 'minItems':1, 'maxItems':20,
    'items':schema({'key':text('段落编号',20), 'text':text('完整新正文',4000)}, ['key','text'])}

# 建表归属（B2，交 A 的接口面）：**必填**（用户 2026-10-15 选修法一「上传必填归属」）。
# 原先是「可选；不带=无组织归属（走旧目录授权）」—— 那正是 `:554` 那条边的来源：
# 今天新建的文件谁也没声明 → 无归属行 → 「可读即可下载」。**必填之后新文件走不到那条分支。**
# （存量老文件仍按用户 10-13「历史不明归属保持既有权限并待核」，不动。）
# 合并说明：fast 那边这里写的是「可选」——本分支的「必填」是更晚的定法，取本分支。
ATTRIBUTION = {'attribution': schema({
    # **没有 enterprise** —— 用户 2026-10-15：「尚书是单例，没有企业归属。」
    #
    # **为什么不写 `enum` 而写 `description`**（实测定的，记下来免得下次又改回去）：
    # 写 `enum` 的话，内核 `schema_validation.py:50` 会**先**用硬编码的通用文案拦掉
    # （「动作字段值不在允许范围：payload.attribution.level」）—— **用户那句口径到不了眼前**。
    # 而 `enum` 本来也没人消费：前端详情页显示的是遗留字段 `owner_subject_kind`，
    # **没有归属层级下拉**（grep 过 `shangshu-web/js/`，零命中）。
    # 所以把「合法值 + 为什么没有企业」写进 `description`（人读的契约面），
    # 拒的落点放 `_apply_attribution` —— 那儿能用用户原话当拒因（实测 HTTP 417 就是那句）。
    # **必填**，但**不写进 outer `required`** —— 内核 `schema_validation.py:105` 的必填报错是
    # 硬编码「动作缺少必填字段：payload.attribution」，**说不出「请选个人或部门」**。
    # 跟 `level` 的 enum 同一个取舍（见上）：**人话优先**，拒因落在 `_require_attribution`
    # （`service.py`），那儿能说「不传归属不能建文件。请选个人或部门归属」。
    # A 线读这段 description 就知道是必填；E 已单独知会。
    # **将来内核支持 per-field 必填报错提示，就可以收回 `required` 里去。**
    #
    # 2026-10-21（agent 建表一线）：这段 description **重写成"人话 + 怎么填"** ——
    # 原来只说「合法值只有 personal 和 department」，**没告诉模型怎么填、没告诉它
    # 「没问清归属就别调」** ⇒ agent 少传归属 ⇒ 撞上「不传归属不能建文件」那句拒。
    # **模型是照 description 办事的** ⇒ 口径写在这儿，它才知道该先问用户。
    'level': {'type': 'string', 'title': '归属层级',
              'description': '**必填：这份东西归谁。**合法值只有 personal（个人）和 department（部门）。'
                             '**没有 enterprise** —— 用户 2026-10-15 定：「尚书是单例，没有企业归属。」'
                             '传 enterprise 一律拒，理由就是这句话。'
                             '怎么填：归你个人 → level=personal；归某个部门 → level=department ＋ department=部门ID；'
                             '归某个具体的人 → level=personal ＋ owner_user=该人账号。',
              'minLength': 1, 'maxLength': 32},
    'department': text('归属部门编号（department 级必填）', 140),
    'owner_user': text('归属人（personal 级，默认本人）', 140)},
    ['level'])}

# **改表格单元格这一路的说明**（2026-10-21，版本口径修复）——
# **模型是照 description 办事的** ⇒ 口径写在这儿，它才知道该读哪个值、该带哪两个值。
# 2026-10-21 用户在 3850 站失败的那条：助手把 `version_count`（**下一个可分配号**）
# 当版本号传 ⇒ 差一 ⇒ 提案永远被判成「原始记录已更新」。
EDIT_CELLS_NOTE = (
    '**改表格单元格用这个动作**（一次可改多格，逐格可核）。'
    '**两个前置值都从读方拿，不许猜**：'
    '`expected_version` ＝ **当前上传版本号**（`files.versions` 读回来的 `file.upload_version`；'
    '⚠️ **不是 `version_count`** —— 那是下一个可分配号，差一就会判成过期）；'
    '`expected_content_revision` ＝ **当前内容修订号**（同一处读回来的 `file.content_revision`）。'
    '**内容真被别人改过**（换过版本或页面里改过）⇒ 这两个值会变 ⇒ 提案当场被拒，'
    '重新读一次再提，别把过期值改小。'
    '**坐标怎么算**：工作表名用 `files.sheet_range_read` 回的 `sheet_title`；'
    '**第 1 行是表头，数据行从第 2 行起**（行序＝`files.sheet_range_read` 回的行序，'
    '列号＝表头在 `headers` 里的次序，第 1 列起算）。'
    '改的是**这份表的当前内容**：页面里改过的表（`file.working_copy` 为真）改的是工作副本，'
    '不会覆盖用户手改的内容，也不会新建上传版本。')

# **建表这一路的归属补充说明**（2026-10-21，agent 建表一线）——
# **归属必须由人明确指定**：用户只说「建个表」而没提归属时，**先反问**，拿到答复再调。
# 「不许默认填发起人、不许自己编一个人名」—— 归属决定谁看得到，**猜错就是越权**。
CREATE_ATTRIBUTION_NOTE = (
    '**建表前必须先问清归属**：用户只说「建个表」而没提归属时，'
    '先反问一句「这张表归谁？① 归你个人 ② 归某个部门 ③ 归某个人」，'
    '拿到答复再调这个动作。**不许默认填发起人，也不许自己编一个人名。**'
    '非管理员不能为他人建个人表；跨部门建表要先有该部门的建表授权 —— '
    '用户说「归某同事」时，正确落法是**部门归属**（本人所属或有授权的部门），不是个人表。')

ACTIONS = [
    ('files.sheet_structure', '调整文件行列', ROLES,
     schema({'table':text('文件表身份',140),'expected_content_version':{'type':'integer','minimum':0},
             'expected_structure_version':{'type':'integer','minimum':1},
             'operation':{'type':'string','enum':['row_insert','row_delete','column_insert','column_delete']},
             'before_row_id':text('插入位置的固定行ID',40),'row_ids':{'type':'array','maxItems':1000,'items':text('固定行ID',40)},
             'before_header':text('插入位置的列名',200),'header':text('新列名',200),
             'headers':{'type':'array','maxItems':100,'items':text('列名',200)}},
            ['table','expected_content_version','expected_structure_version','operation'])),
    # 合并说明：fast 那边还有一个 `files.sheet_sort`（载荷是 `header`）——
    # **与本分支的 `files.sheet_sort`（载荷是 `column` + `identity_only`）动作号撞了**。
    # 同一个动作号只能有一个定义（register_action 的闸会以「重复且定义不一致」拦下），
    # 而两个前端（shangshu-web/js/domains/excel-univer/excel-univer-entry.js 与
    # src/backend.ts）实际发的是 `column` + `identity_only` ⇒ **取本分支的**，
    # fast 那条定义删掉（它的 `files.sheet_structure` / `files.sheet_style` 是新动作号，留着）。
    ('files.sheet_style', '修改文件单元格格式', ROLES,
     schema({'table':text('文件表身份',140),'expected_content_version':{'type':'integer','minimum':0},
             'expected_structure_version':{'type':'integer','minimum':1},
             'cells':{'type':'array','minItems':1,'maxItems':20000,
                'items':schema({'row_id':text('固定行ID',40),'header':text('列名',200)},['row_id','header'])},
             'style':schema({'number_format':text('数字格式',80),'bold':{'type':'boolean'},
                'wrap_text':{'type':'boolean'},'border':{'type':'string','enum':['none','all']}},[])},
            ['table','expected_content_version','expected_structure_version','cells','style'])),
    ('files.edit_paragraphs', '修改DOCX普通正文', ROLES,
     schema({**REF, 'expected_version':{'type':'integer','minimum':1}, 'expected_modified':text('当前文件修订',40),
             'changes':PARAGRAPH_CHANGES, **NOTE}, ['file','expected_version','expected_modified','changes'])),
    ('files.edit_cells', '修改表格单元格', ROLES,
     schema({**REF, 'expected_version': {'type':'integer','minimum':1,
                  'title':'当前上传版本号（读到的 file.upload_version；⚠️ 不是 version_count）'},
             'expected_content_revision': {'type':'integer','minimum':1,
                  'title':'当前内容修订号（读到的 file.content_revision）'},
             'changes': CELL_CHANGES, **NOTE},
            ['file','expected_version','expected_content_revision','changes'],
            description=EDIT_CELLS_NOTE)),
    ('files.import_attachment', '归档附件到文件中心', ROLES,
     schema({'source': schema({'ref_doctype': text('来源类型', 140), 'ref_name': text('来源记录', 140),
                               'file': text('来源附件', 140)}, ['ref_doctype', 'ref_name', 'file']),
             **DIRECTORY, **DIRECTORY_ID, **TAGS, **NOTE,
             # C10：来信附件自动入库时由**服务端**推导的两个系统字段（所有人 / 关联邮件），
             # 语义见 字段字典#file-mail-system-fields。
             # 声明在 schema 里，只是让受管收信链能把它们带进来；
             # **谁能填**由 service._mail_sys_fields 判 —— 只认受管收信上下文，
             # 用户请求带上一律拒（契约原话：「员工不能靠改显示文字/请求字段更换所有人或伪造来源」）。
             'mail_system': schema({
                 'owner_subject_kind': {'type': 'string', 'enum': ['Employee', 'Department'],
                                        'title': '所有人类型'},
                 'owner_subject': text('所有人ID（员工ID或部门ID）', 200),
                 'related_mail': text('关联邮件编号', 140)},
                 ['owner_subject_kind', 'owner_subject']),
             # 建表归属（B2，交 A 的接口面）：可选；不带=无组织归属（走旧目录授权）。
             # 2026-10-14 两支并集：B 有 attribution、C 有上面的 mail_system，而 delivery.py
             # **两个都发** → 合并前各自只认一半，报「动作包含未声明字段」，自动入库一直失败。
             # 动作版本进位 1.2.0（见 install.py）。mail_system 的撤除归 PKG-013-T02。
             **ATTRIBUTION}, ['source'])),
    ('files.review', '保存文件审核', ROLES,
     schema({**REF, 'expected_modified': text('文件修订', 40),
             'expected_version': {'type': 'integer', 'minimum': 1},
             'file_name': text('文件名', 200), **TAGS, **NOTE,
             'relations': {'type': 'array', 'maxItems': 20, 'items': schema({
                 'object_id': text('对象编号', 200), 'name': text('记录编号', 140),
                 'expected_revision': {'type': 'integer', 'minimum': 1},
                 'expected_modified': text('记录修订', 40),
                 'values': {'type': 'object', 'additionalProperties': True}},
                 ['object_id', 'name', 'expected_revision', 'expected_modified', 'values'])}},
            ['file', 'expected_modified', 'expected_version', 'relations'])),
    ('files.upload', '上传文件', ROLES,
     schema({'file_name': text('文件名', 200), 'create_only': {'type': 'boolean', 'title': '仅新建（同名拒绝）'},
             'new_resource': {'type':'boolean','title':'作为独立文件导入（所有类型同名另存，不改原文件；表格同名默认另存）'},
             **ATTRIBUTION, **CONTENT, **DIRECTORY, **DIRECTORY_ID, **TAGS, **NOTE, **SHA,
             # **血缘**（2026-10-22 第 1 步：包件交接）：这份字节属于哪个**原包**。
             # 成员靠它溯源到原包；原包只作备份与血缘凭证。
             'container_sha256': text('原包摘要（血缘：这份字节来自哪个包）', 64)},
            ['file_name', 'content_base64'])),
    # ---------- 放字节 ＋ **挂到指定记录上**（PKG-036-T04） ----------
    # **为什么要有**（收口「收信附件自己建 File」那处限期豁免）：
    # 字节**必须**由文件域放（契约「所有进尚书的文件都进文件中心」），
    # 而那封信上的附件**还要按这封信的归属取字节**（读信面／正文 cid:）
    # ⇒ File 行得**挂在那封信上** ⇒ 这个口就是「放字节 ＋ 指定挂在谁身上」那一步。
    ('files.upload_attached', '上传文件并挂到指定记录上', ROLES,
     schema({'file_name': text('文件名', 200),
             'attach_to': {'type': 'object', 'title': '挂到哪条记录上 {doctype, name}',
                           'required': ['doctype', 'name'],
                           'properties': {'doctype': {'type': 'string', 'maxLength': 140},
                                          'name': {'type': 'string', 'maxLength': 140}}},
             **ATTRIBUTION, **CONTENT, **DIRECTORY, **DIRECTORY_ID, **TAGS, **NOTE, **SHA},
            ['file_name', 'content_base64', 'attach_to'])),
    # ---------- 按包存成员 ＋ 广播成员清单（第 1 步：包件交接） ----------
    # **域与域之间只走公开 Action**（域与域之间只走公开 Action）⇒
    # 「一个包解出哪些成员」由**收包的那一头**算好送过来，文件域负责：
    # ① 原包进文件中心（备份与血缘凭证，**不进成员清单**）；
    # ② 成员**逐个**进文件中心（带目录、带血缘）；
    # ③ 广播 `files.package.stored`（成员清单，只有事实）。
    ('files.package.store', '按包存成员并广播成员清单', ROLES,
     schema({'container_sha256': text('原包摘要（成员靠它溯源到原包）', 64),
             'directory': {'type': 'string', 'title': '域自己声明的那块路径（文件中心照它落）',
                           'maxLength': 200},
             **ATTRIBUTION,
             'container': schema({'file_name': text('原包文件名', 200),
                                  'content_base64': {'type': 'string', 'title': '原包字节（Base64）',
                                                     'minLength': 1, 'maxLength': 40000000},
                                  'file_sha256': text('原包摘要（可选校验）', 64),
                                  'size_bytes': {'type': 'integer', 'minimum': 0}},
                                 ['file_name', 'content_base64']),
             'members': {'type': 'array', 'title': '成员清单（list.xml ＋ 正文 ＋ 附件；**原包不在里面**）',
                         'maxItems': 500,
                         'items': schema({'name': text('成员名（包内路径）', 300),
                                          'kind': {'type': 'string', 'title': '成员种类',
                                                   'enum': ['list', 'body', 'attachment']},
                                          'sha256': text('成员摘要', 64),
                                          'size_bytes': {'type': 'integer', 'minimum': 0},
                                          'content_base64': {'type': 'string', 'title': '成员字节（Base64）',
                                                             'minLength': 1, 'maxLength': 40000000}},
                                         ['name', 'kind', 'sha256', 'size_bytes', 'content_base64'])}},
            ['container_sha256', 'directory', 'container', 'members'])),
    ('files.table_relation_define', '配置表格关联列', ROLES,
     schema({'table':text('表',140),'header':text('关联列',140),'target_table':text('目标表',140),'target_header':text('目标列',140),
             'expected_structure_version':{'type':'integer','minimum':1},'expected_revision':{'type':'integer','minimum':1}},
            ['table','header','target_table','target_header','expected_structure_version'])),    ('files.table_relation_remove', '解除整列关联', ROLES,
     schema({'table':text('表',140),'header':text('关联列',140),'expected_revision':{'type':'integer','minimum':1}},['table','header','expected_revision'])),
    ('files.table_relation_set', '设置行关联', ROLES,
     schema({'table':text('表',140),'header':text('关联列',140),'row_id':text('固定行',140),'target_row_id':text('目标固定行',140),
             'expected_revision':{'type':'integer','minimum':1}},['table','header','row_id','expected_revision'])),
    # 2026-10-21（agent 建表一线）：`files.create` 一次完成
    # **建表 ＋ 表头 ＋ 前两行第一格的占位文字 ＋ 归属** —— 一次提案、一次确认、一次落库。
    #
    # `headers` / `placeholder` 是**可选**的：老调用方（人填路径、上传夹具、既有脚本）
    # 照旧只传 file_name ＋ attribution 就行，**载荷形状没变** ⇒ 小版本进位（3.0.0 → 3.1.0）。
    # 标题也从「新建空表」改成说人话的一份（**模型看到的第一个句子就是它**）。
    ('files.create', '新建表格（表名＋表头＋占位，归属必填）', ROLES,
     schema({'file_name': text('文件名', 200),
             'headers': {'type': 'array', 'title': '表头（第一行的列名，按顺序）', 'maxItems': 50,
                         'items': text('列名', 100)},
             'placeholder': text('占位文字（写进前两行第一格；默认「这是占位，请改」）', 200),
             **DIRECTORY, **DIRECTORY_ID, **TAGS, **NOTE,
             **ATTRIBUTION},
            ['file_name'], description=CREATE_ATTRIBUTION_NOTE)),
    ('files.new_version', '上传新版本', ROLES,
     schema({**REF, 'content_base64': {**CONTENT['content_base64'], 'minLength': 0}, **NOTE, **SHA,
             'expected_version': {'type': 'integer', 'title': '当前内容版本（与修订同时提交）', 'minimum': 1},
             'expected_modified': text('当前文件修订（与版本同时提交）', 40)}, ['file', 'content_base64'])),
    ('files.update_meta', '修改文件信息', ROLES,
     schema({**REF, 'file_name': text('文件名', 200), **DIRECTORY, **DIRECTORY_ID, **TAGS, **NOTE,
             'expected_modified': text('文件修订（可选）', 40)}, ['file'])),
    ('files.recycle', '移入回收站', ROLES, schema({**REF}, ['file'])),
    ('files.restore', '从回收站恢复', ROLES, schema({**REF,
        'keep_relations': {'type': 'boolean', 'title': '保留原业务关联（省略沿用旧行为）'},
        'expected_modified': text('文件修订（可选）', 40)}, ['file'])),
    ('files.directory_create', '新建目录', ['System Manager'],
     schema({'parent': text('父目录编号', 140), 'title': text('目录名', 100)}, ['title'])),
    ('files.directory_rename', '重命名目录', ['System Manager'],
     schema({'directory': text('目录编号', 140), 'title': text('目录名', 100),
             'expected_modified': text('目录修订', 40)}, ['directory', 'title', 'expected_modified'])),
    ('files.directory_access', '设置目录访问范围', ['System Manager'],
     schema({'directory': text('目录编号', 140), 'expected_modified': text('目录修订', 40),
             'mode': {'type': 'string', 'enum': ['inherit', 'restricted']},
             'identities': {'type': 'array', 'maxItems': 100, 'uniqueItems': True, 'items': text('身份ID', 100)},
             'groups': {'type': 'array', 'maxItems': 100, 'uniqueItems': True, 'items': text('协作分组', 100)}},
            ['directory', 'expected_modified', 'mode', 'identities', 'groups'])),
    ('files.sheet_input_write', '输入表格单元格（按需扩展）', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'op_id': text('操作编号', 140),
             'append_at_end': {'type': 'boolean'},
             'target_row_ids': {'type':'array','maxItems':20000,'items':{'type':['string','null'],'maxLength':140}},
             'target_headers': {'type':'array','minItems':1,'maxItems':16384,'items':{'type':['string','null'],'maxLength':500}},
             'start_row': {'type': 'integer', 'minimum': 0},
             'start_col': {'type': 'integer', 'minimum': 0},
             'value': schema({'type': {'type': 'string', 'enum': ['text','number','boolean','empty','date','formula']},
                              'value': {'type': ['string','number','boolean','null']},
                              'formula': text('公式', 500)}, ['type'])},
            ['table','expected_content_version','expected_structure_version','op_id','start_row','start_col','value'])),
    ('files.sheet_cell_write', '修改表格单元格', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             # 合并说明：fast 那边给 row_id 加了**格式闸**（^r-[0-9]{6,}$）——
             # 挡「把 Excel 可见行号当固定行ID传进来」。两边的行ID都是 r-%06d，取并集。
             'row_id': {**text('固定行ID', 140), 'pattern': '^r-[0-9]{6,}$',
                        'description': '复制files.sheet_read返回的row_id；不是Excel可见行号'},
             'header': text('表头名', 200),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             # **`op_id` 必须能传**（B 2026-10-18 核出 b01 第 5 条根因）：单写路径没这个字段
             # → schema 拒「动作包含未声明字段：payload.op_id」→ 撤回查无此单 417。
             # 跟 `sheet_cells_write`（line 140）同一个口径：客户端编号，撤回定位用。
             'op_id': text('原操作编号（撤回定位用）', 140),
             # **受管记录的版本**（读那一行时回的 `record_version`）：带了才校验。
             # 带了但记录被别人改过 ⇒ 当场拒（陈旧写），不是后写覆盖先写。
             'expected_record_version': text('读到的受管记录版本', 64),
             # 合并说明：值类型本分支用**自由文本**（含 formula），fast 那边用枚举
             # （text/number/boolean/date/empty，没有 formula）—— 取本分支的，
             # 否则公式格写不进去（sheet.py 的 typed 值分支认 formula）。
             'value': schema({'type': text('值类型', 20), 'value': {'type': ['string', 'number', 'boolean', 'null']},
                              'formula': text('公式', 500)}, ['type'])},
            ['table', 'row_id', 'header', 'expected_content_version', 'expected_structure_version', 'value'])),
    # B4 一次范围写入：一请求 N 格、全成或全不成、一次落盘（content_version 恰 +1）。
    # 不许用「每格一个请求」实现批量（A4 硬判据）；逐格 before/after 快照供 B5 撤回核验。
    ('files.sheet_cells_write', '批量写表格单元格', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'op_id': text('原操作编号（撤回定位用）', 140),
             # **逐行受管记录版本**（PKG-004-T03 第 5 批）：行 ID → 读回来的那一版。
             # 带了才校验：那一行被别人改过 ⇒ **整包被拒**（不是后写覆盖先写）。
             # **可选** ⇒ 老客户端（不带）照旧能写。
             'expected_record_versions': {
                 'type': 'object', 'title': '逐行受管记录版本（行ID → 版本）',
                 'additionalProperties': {'type': 'string', 'maxLength': 64}},
             'cells': {'type': 'array', 'minItems': 1, 'maxItems': 20000,
                       # 合并说明：同 files.sheet_cell_write —— 取 fast 的 row_id 格式闸，
                       # 值类型取本分支的（含 formula）。
                       'items': schema({'row_id': {**text('固定行ID', 140), 'pattern': '^r-[0-9]{6,}$',
                                                    'description': '复制files.sheet_read返回的row_id；不是Excel可见行号'},
                                        'header': text('表头名', 200),
                                        'value': schema({'type': text('值类型', 20),
                                                         'value': {'type': ['string', 'number', 'boolean', 'null']},
                                                         'formula': text('公式', 500)}, ['type'])},
                                       ['row_id', 'header', 'value'])}},
            ['table', 'expected_content_version', 'expected_structure_version', 'cells'])),
    ('files.sheet_style_write', '设置表格格式', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'op_id': text('格式操作编号', 140),
             'cells': {'type': 'array', 'minItems': 1, 'maxItems': 20000,
                       'items': schema({'row_id': text('固定行ID', 140), 'header': text('表头名', 200)}, ['row_id', 'header'])},
             'style': {'type': 'object', 'additionalProperties': False,
                       'properties': {'font_size': {'type': 'number', 'minimum': 1, 'maximum': 409},
                                      'font_color': {'type': 'string', 'pattern': '^#[0-9A-Fa-f]{6}$'},
                                      'bold': {'type': 'boolean'},
                                      'wrap_text': {'type': 'boolean'},
                                      # 边框两种形态：旧口径字符串（none/all）与预设对象。
                                      # 平台的 schema 子集不支持 oneOf，所以用「类型列表 + 对象属性」：
                                      # 传对象时逐项校验；传字符串时由后端归一时给中文报错。
                                      'border': {'type': ['string', 'object'], 'additionalProperties': False,
                                                 'properties': {
                                                     'preset': {'type': 'string', 'enum': list(BORDER_PRESETS)},
                                                     'style': {'type': 'string', 'enum': list(BORDER_STYLE_CODES)},
                                                     'color': {'type': 'string', 'pattern': '^#[0-9A-Fa-f]{6}$'}}},
                                      'number_format': {'type': 'string', 'enum': ['General', '0', '0.00', '#,##0', '#,##0.00', '0%', '0.00%', 'yyyy-mm-dd', 'yyyy-mm-dd hh:mm:ss']},
                                      # 扩展格式（FIX-18）：填充色 / 斜体 / 下划线 / 对齐 / 清除格式。
                                      # 「清掉」用字符串 'none' 表达（平台的 schema 子集不收 oneOf，
                                      # 用 'none' 也比 null 好读：界面传的就是这个词）。
                                      # 平台的 pattern 安全子集禁 ()|，所以「#RRGGBB 或 none」
                                      # 写不成一条正则；这里只管类型，**格式由域内校验**
                                      # （域内给中文提示），与边框同一个口径。
                                      'fill_color': {'type': 'string'},
                                      'italic': {'type': 'boolean'},
                                      'underline': {'type': 'boolean'},
                                      'horizontal_align': {'type': 'string', 'enum': ['left', 'center', 'right', 'none']},
                                      'vertical_align': {'type': 'string', 'enum': ['top', 'center', 'bottom', 'none']},
                                      'clear_format': {'type': 'boolean'}}}},
            ['table', 'expected_content_version', 'expected_structure_version', 'op_id', 'cells', 'style'])),
    # B5 受管撤回：按服务端操作台账逐格核验后反向写回；不收客户端自报快照。
    # 门槛=当前写权；被人改过的格不覆盖（skipped 报告）；一次落盘（applied>0 时版本 +1）。
    ('files.sheet_cells_undo', '撤回表格写入', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'op_id': text('原写入操作编号', 140)}, ['table', 'op_id'])),
    ('files.sheet_layout_update', '修改表格列宽', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'column_widths': {'type': 'object', 'title': '列宽（键=列序号，单位 excel-char）',
                               'additionalProperties': {'type': 'number', 'minimum': 0, 'maximum': 255}},
             # FIX-18「自动适应尺寸」：按内容自动算宽，**走同一条 layout 写入口**（不新开口）。
             'auto_fit_columns': {'type': 'array', 'title': '要按内容自动算宽的列（1 起的列序号）',
                                  'maxItems': 64, 'items': {'type': 'integer', 'minimum': 1, 'maximum': 16384}}},
            ['table', 'expected_content_version', 'expected_structure_version'])),
    # ── 第四批：成包编辑（查找替换 / 填充序列 / 选择性粘贴） ──────────────────
    # 三条都是「一次成包写 + 一步撤回」：一次落盘 = content_version 恰 +1，
    # 台账逐格有 before/after，撤回走既有那条受管撤回路径。
    ('files.sheet_find_replace', '查找替换表格内容', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'op_id': text('操作编号（撤回定位用）', 140),
             'find': text('要查找的内容', 500),
             'replace': text('替换成的内容（留空=删掉命中内容）', 500),
             'match_case': {'type': 'boolean', 'title': '区分大小写'},
             'whole_cell': {'type': 'boolean', 'title': '只替换整个单元格内容一致的那些格'}},
            ['table', 'expected_content_version', 'expected_structure_version', 'op_id', 'find'])),
    ('files.sheet_fill_series', '按序列填充表格', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'op_id': text('操作编号（撤回定位用）', 140),
             'start_row': {'type': 'integer', 'title': '起始行（0 基，数据行）', 'minimum': 0},
             'start_col': {'type': 'integer', 'title': '起始列（0 基）', 'minimum': 0},
             'end_row': {'type': 'integer', 'title': '结束行（0 基，含）', 'minimum': 0},
             'end_col': {'type': 'integer', 'title': '结束列（0 基，含）', 'minimum': 0},
             'series_type': {'type': 'string', 'enum': ['linear', 'date', 'list', 'copy']},
             'step': {'type': ['number', 'null'], 'title': '步长（不给就从第二个格推导）'},
             'unit': {'type': 'string', 'enum': ['day', 'week', 'month', 'year']},
             'stop_value': {'type': ['number', 'string', 'null'], 'title': '终止值（到它为止）'},
             'start_value': {'type': ['number', 'string', 'null'], 'title': '起始值（起始格是空时用）'},
             'values': {'type': 'array', 'maxItems': 64, 'items': text('候选项', 200)}},
            ['table', 'expected_content_version', 'expected_structure_version', 'op_id',
             'start_row', 'start_col', 'end_row', 'end_col', 'series_type'])),
    ('files.sheet_paste_special', '选择性粘贴表格内容', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'op_id': text('操作编号（撤回定位用）', 140),
             'mode': {'type': 'string', 'enum': ['values', 'formulas', 'formats']},
             'source_row': {'type': 'integer', 'title': '源区域起始行（0 基）', 'minimum': 0},
             'source_col': {'type': 'integer', 'title': '源区域起始列（0 基）', 'minimum': 0},
             'source_rows': {'type': 'integer', 'minimum': 1},
             'source_cols': {'type': 'integer', 'minimum': 1},
             'target_row': {'type': 'integer', 'title': '目标区域起始行（0 基）', 'minimum': 0},
             'target_col': {'type': 'integer', 'title': '目标区域起始列（0 基）', 'minimum': 0},
             'skip_empty': {'type': 'boolean', 'title': '源格为空就不动目标格'}},
            ['table', 'expected_content_version', 'expected_structure_version', 'op_id', 'mode',
             'source_row', 'source_col', 'target_row', 'target_col'])),
    ('files.sheet_row_heights_write', '修改表格行高', ROLES,
     schema({'table':text('表身份',140),'sheet':text('工作表身份',140),
             'expected_content_version':{'type':'integer','minimum':0},
             'expected_structure_version':{'type':'integer','minimum':1},
             # 2026-10-29：**0 ＝ 恢复自动行高**（「再点一次自动行高」的回头路）。
             # 行高存在 xlsx 文件里 ⇒ 全表共享 ⇒ 恢复自动也得写回文件 ⇒ 文件里那一行
             # 不写 ht／customHeight（打开就是自动行高）。⇒ 下限从 1 放宽到 0。
             'row_heights':{'type':'object','title':'行高（键为含表头的Excel行号，单位pt；0＝恢复自动行高）',
                            'additionalProperties':{'type':'number','minimum':0,'maximum':409}}},
            ['table','expected_content_version','expected_structure_version','row_heights'])),
    ('files.sheet_row_append', '表格末尾加行', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'count': {'type': 'integer', 'title': '加行数（1-50，默认 1）', 'minimum': 1, 'maximum': 50},
             'op_id': text('原操作编号（审计/对账/撤回定位用，不重复建靠幂等键）', 140),},
            ['table', 'expected_content_version', 'expected_structure_version'])),
    ('files.sheet_column_append', '表格末尾加列', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'header': text('新列表头', 200),
             'op_id': text('原操作编号（审计/对账/撤回定位用，不重复建靠幂等键）', 140),},
            ['table', 'expected_content_version', 'expected_structure_version', 'header'])),
    # ── BASE967-19 插入/删除（2026-10-17 用户拍板：行软删、列拒晋升）──
    ('files.sheet_row_move', '移动行', ROLES, schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140), 'expected_content_version': {'type':'integer','minimum':0}, 'expected_structure_version': {'type':'integer','minimum':1}, 'op_id': text('操作编号',140), 'row_id':text('目标身份',200), 'before_row_id':text('插入位置前身份；省略为末尾',200)}, ['table', 'row_id', 'expected_content_version', 'expected_structure_version'])),
    ('files.sheet_column_move', '移动列', ROLES, schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140), 'expected_content_version': {'type':'integer','minimum':0}, 'expected_structure_version': {'type':'integer','minimum':1}, 'op_id': text('操作编号',140), 'header':text('目标身份',200), 'before_header':text('插入位置前身份；省略为末尾',200)}, ['table', 'header', 'expected_content_version', 'expected_structure_version'])),
    ('files.sheet_row_restore', '恢复软删除行', ROLES, schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140), 'expected_content_version': {'type':'integer','minimum':0}, 'expected_structure_version': {'type':'integer','minimum':1}, 'op_id': text('操作编号',140), 'row_id':text('目标身份',200)}, ['table', 'row_id', 'expected_content_version', 'expected_structure_version'])),
    ('files.sheet_structure_undo', '撤回本人结构操作', ROLES, schema({'table':text('表身份',140), 'undo_of':text('原结构操作编号',140), 'op_id':text('本次操作编号',140), 'expected_content_version':{'type':'integer','minimum':0}, 'expected_structure_version':{'type':'integer','minimum':1}}, ['table','undo_of','expected_content_version','expected_structure_version'])),
    ('files.sheet_row_insert', '指定行前插行', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'before_row_id': text('在哪行前插（空=末尾）', 140),
             'count': {'type': 'integer', 'title': '插几行（默认 1）', 'minimum': 1},
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'op_id': text('原操作编号', 140),},
            ['table', 'expected_content_version', 'expected_structure_version'])),
    ('files.sheet_column_insert', '指定列前插列', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'before_header': text('在哪列前插（空=末尾）', 200),
             'header': text('新列表头', 200),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'op_id': text('原操作编号', 140),},
            ['table', 'expected_content_version', 'expected_structure_version', 'header'])),
    ('files.sheet_row_delete', '删除行（软删：隐藏不显示、DB 正式值保留）', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'row_id': text('固定行ID', 140),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'op_id': text('原操作编号', 140),},
            ['table', 'row_id', 'expected_content_version', 'expected_structure_version'])),
    ('files.sheet_column_delete', '删除列（已晋升的拒：先撤晋升再删）', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'header': text('列表头', 200),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'op_id': text('原操作编号', 140),},
            ['table', 'header', 'expected_content_version', 'expected_structure_version'])),
    ('files.sheet_header_rename', '修改表格表头', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'from_header': text('原表头', 200), 'to_header': text('新表头', 200),
             'op_id': text('原操作编号（审计/对账/撤回定位用，不重复建靠幂等键）', 140),},
            ['table', 'expected_content_version', 'expected_structure_version', 'from_header', 'to_header'])),
    ('files.sheet_rename', '修改表名', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'title': text('新表名（扩展名固定落 .xlsx）', 200),
             'op_id': text('原操作编号（审计/对账/撤回定位用，不重复建靠幂等键）', 140),},
            ['table', 'expected_content_version', 'expected_structure_version', 'title'])),

    # G3 越界粘贴：扩展与写值打包成**一次受管动作**（计划 PKG-003-T03）。
    # 角色门槛=文件写权限；扩展自由文件不等同于业务字段/DDL，禁止混用业务结构授权。
    # 表头区按非空唯一校验：重复拒、空表头按规则生成（不用 `列N` 占位）。
    # 容量上限与 sheet_cells_write 一致（20000 格）。
    # BASE967-15（2026-10-17 E 定口径）：表格**固定引用快照** —— 把当前版本复制成
    # 新的文件中心快照，返回稳定 File 引用（邮件附件/文件选择器用）。
    # 权限只调 `file_detail.can_download`（与下载按钮同一口径，不另算字段 ACL）；
    # 归属=发起人个人；必须写 relations 指向原表（撤权后语义待用户拍）。
    ('files.sheet_snapshot', '表格快照（固定引用导出）', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'op_id': text('原操作编号（重放不重复建快照）', 140)},
            ['table', 'op_id'])),
    ('files.sheet_paste_apply', '越界粘贴（扩展与写值一个动作包）', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'op_id': text('原操作编号（审计/对账/撤回定位用）', 140),
             'append_at_end': {'type': 'boolean'},
             'target_row_ids': {'type':'array','maxItems':20000,'items':{'type':['string','null'],'maxLength':140}},
             'target_headers': {'type':'array','minItems':1,'maxItems':16384,'items':{'type':['string','null'],'maxLength':500}},
             'start_row': {'type': 'integer', 'title': '粘贴起始行（0 基，数据行）', 'minimum': 0},
             'start_col': {'type': 'integer', 'title': '粘贴起始列（0 基）', 'minimum': 0},
             'matrix': {'type': 'array', 'minItems': 1, 'maxItems': 20000,
                        'items': {'type': 'array'}},
             'matrix_types': {'type': 'array', 'title': '与 matrix 同形的类型矩阵（可省）',
                              'items': {'type': 'array'}},
             'header_row': {'type': 'boolean', 'title': '表头区粘贴（按表头非空唯一校验）'},
             'extend': {'type': 'boolean', 'title': '是否允许自动扩展（默认 true）'}},
            ['table', 'expected_content_version', 'expected_structure_version', 'op_id',
             'start_row', 'start_col', 'matrix'])),

    # T07 range_read 工具：内核「AI Tool 必须投影已注册 Action」，而 files.sheet_read 是
    # **服务**投影不了。开一个只读动作壳，处理器就是那个服务实现（不新增读逻辑）。
    # effect=read / confirm=none：读不需要幂等键、不需要确认卡。
    ('files.sheet_range_read', '表格范围读取', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
             'row_ids': {'type': 'array', 'maxItems': 500, 'items': text('固定行ID', 140)},
             'headers': {'type': 'array', 'items': text('读取列的表头', 32767)},
             'page': {'type': 'integer', 'minimum': 1},
             'page_length': {'type': 'integer', 'minimum': 1, 'maximum': 500},
             'search': text('全表搜索词（不区分大小写的包含匹配）', 200)},
            ['table'])),

    # PKG-018-T06 第一阶段：**表格分析**（普通 XLSX／数据库绑定表）。
    # 与受管记录的 `platform.object.aggregate` **同一套统计口径**
    # （口径只有一份：`shangshu_core.analysis`），但**多带一段来源说明**：
    # 每一列的值来自**数据库正式值**还是**工作簿**，以及数据版本是哪一版。
    # ⚠️ 只读动作（effect=read / confirm=none）：读不需要幂等键、不需要确认卡。
    ('files.table_aggregate', '统计表格（XLSX／绑定表）', ROLES,
     schema({'table': text('表身份', 140), 'sheet': text('工作表身份（只接受主工作表）', 140),
             'filters': schema({}, []),
             'metrics': {'type': 'array', 'maxItems': 3, 'items': schema({
                 'op': {'type': 'string', 'enum': ['count_rows', 'count_distinct', 'sum']},
                 'field': text('按哪个列（列名）', 200)}, ['op'])},
             'group_by': text('按哪个列分组（列名，最多 1 个）', 200),
             'include_total_rows': {'type': 'boolean',
                                    'title': '是否保留合计行（默认剔除合计行并报出剔了哪几行）'}},
            ['table'],
            description=('统计一张表（普通 XLSX 或已绑定数据库的表）：行数／去重计数／求和，最多 1 个分组。'
                         '受管列的值取数据库正式值，普通列取工作簿里的值，回包逐列标明来源与数据版本。'
                         '默认剔除合计行；表头不成立（标题行当表头／合并表头）会当场拒绝并说明怎么改。'))),

    # BASE967-50/51（2026-10-19 主控转 A 定契约）：**全表按列服务端排序**。
    # 客户端排只能排当前页，100/10000 = 静默给错结果（A 的 G1 反例）。
    # **必传 expected_content_version + expected_structure_version**（乐观锁）——
    # 结构版本前进期间排序会**让 row_id 映射错位**（行号重排），那是 silent bug。
    # **只读**：不写文件、不 bump 版本、不写 op 台账（A 也不消费 op_id 字段）。
    # A 按 `row_id` 重排视图；**不要按 index 重排**（index 是当前未排前位置，会变）。
    ('files.sheet_view_save', '保存本人表格视图', ROLES,
     schema({'table': text('表身份', 140),
             'expected_revision': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             'view': schema({
                 'filters': {'type': 'array', 'maxItems': 20, 'items': schema({
                     'column': text('列', 200),
                     # `in`（FIX-49）：值在这几个里 —— 列头筛选面板勾值清单产生的。
                     'operator': {'type': 'string', 'enum': ['contains', 'equals', 'empty', 'not_empty', 'in']},
                     # 老四个 operator 的 value 是**字符串**（≤1000 字，一个字没改）；
                     # `in` 的 value 是**字符串数组**（≤500 项，每项 ≤32767 字）。
                     'value': {'type': ['string', 'array'], 'maxLength': 1000, 'maxItems': 500,
                               'items': text('筛选值', 32767)}}, ['column', 'operator'])},
                 'freeze': schema({'rows': {'type': 'integer', 'minimum': 0, 'maximum': 1000},
                                   'columns': {'type': 'integer', 'minimum': 0, 'maximum': 1000}}, ['rows', 'columns']),
                 'sort': schema({'column': text('排序列', 200),
                                 'direction': {'type': 'string', 'enum': ['asc', 'desc']}}, ['column', 'direction']),
                 # 列序（2026-10-29 用户口径）：按这个顺序显示。
                 # **可选** ⇒ 老载荷（不带它）照旧合法 ⇒ 动作版本按小版本进位。
                 'columns': {'type': 'array', 'title': '个人视图的列序（按这个顺序显示）',
                             'maxItems': 1000, 'items': text('列名', 200)}
             }, ['filters', 'freeze'])},
            ['table', 'expected_revision', 'expected_structure_version', 'view'])),

    ('files.sheet_sort', '表格按列全表排序', ROLES,
     # 合并说明（2026-10-21）：**两种载荷形状都收** ——
     #   `column`（我们线的前端 excel-univer 发它，另带 `identity_only`）：服务端只算排序后的视图，
     #     **不移动文件行**、不 bump 版本；
     #   `header`（fast 那条线）：**同一个意思**（排序列的**表头名**），但那条线要**整表落盘**
     #     （移动整行、生成新版本）。
     # 两者指的是同一个东西 —— **排序列的表头名**；发哪个形状就走哪条线自己的语义。
     # `column` 因此**不再必填**（否则 fast 那条线的载荷会被 schema 挡在门外）；
     # 「`column` 与 `header` 至少给一个」由处理器判（schema 校验器只支持基本规则，
     # 没有 oneOf/anyOf —— 见 `shangshu_core/schema_validation.py`）。
     # 老载荷（发 `column`）照旧合法 ⇒ **小版本进位** 1.1.0 → 1.2.0（见 install.py）。
     schema({'table': text('表身份', 140),
             'identity_only': {'type': 'boolean'},
             'column': text('排序列表头（与 header 同义，二选一）', 200),
             'header': text('排序列的表头名（与 column 同义，二选一）', 200),
             'direction': {'type': 'string', 'enum': ['asc', 'desc'], 'default': 'asc'},
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1}},
            ['table', 'expected_content_version', 'expected_structure_version'])),


    # T08 动作事实（PKG-001-T08）：UI 观察到的事件上报给权威事实。
    # **来源由服务端认证**，不接受调用方自报身份/部门。op_id 与 idempotency_key 分开。
    # 回包是服务端认定的事实（op_id/server_time/identity/summary，零 LLM）。
    ('files.action_fact', '动作事实上报', ROLES,
     schema({'op_id': text('稳定操作号（业务对账/审计/撤回）', 140),
             'action': text('观察到的动作名', 80),
             'target': text('目标（表头/范围/表 key 等）', 200),
             'detail': {'type': 'object', 'title': '业务明细（如 rowId、cells 前后值）'},
             'client_timestamp': {'type': 'integer', 'title': '客户端时间（参考，以服务端为准）',
                                  'ss_role': 'audit'}},
            ['op_id', 'action'])),

    # 查询本身不留痕；越权查询拒并可查。明确授权内查询（本人/管理者），完整矩阵接 PKG-010。
    ('files.action_fact_query', '动作事实查询', ROLES,
     schema({'op_id': text('按操作号查', 140), 'user': text('按员工查', 140),
             'action': text('按动作名查', 80), 'target': text('按目标查', 200),
             'page_length': {'type': 'integer', 'minimum': 1, 'maximum': 200}},
            [])),

    # PKG-004 / D-a：晋升定义 —— 某列 → 数据库字段的映射。
    # **角色卡死 System Manager**：契约写的是「首次晋升仅 FDE 受管工程入口」，
    # FDE 是人不是角色，可执行的最紧代理就是它（directory_create 同口径）。
    # 普通员工 / Agent 不得自己晋升 —— 也不能借公共资料读权获得晋升权。
    # `expected_structure_version` 必填：绑定钉的是「绑定那一刻」的结构版本，
    # 表头改过还拿旧结构来绑就是冒充，当场拒。
    ('files.promotion_define', '定义晋升列（FDE 受管工程入口）', ['System Manager'],
     schema({'table': text('表身份', 140),
             'expected_definition_sha': text('读取时的字段定义指纹', 64),
             'expected_structure_version': {'type': 'integer', 'minimum': 1,
                                            'title': '绑定那一刻的结构版本'},
             'definition': {'type': 'object', 'title': '晋升定义',
                            'additionalProperties': True,
                            'properties': {
                                'definition_version': {'type': 'integer'},
                                # **表级主体范围**（PKG-117-T01）：三个操作 × 全局/部门/个人。
                                # **独立声明** —— 不再由各列并集推导。
                                'access': {'type': 'object',
                                           'title': '表级权限主体范围（读/写/下载必填，筛/助手可省）',
                                           'additionalProperties': True},
                                'columns': {'type': 'array', 'minItems': 1,
                                            'items': {'type': 'object',
                                                      'additionalProperties': True}}}},
             # **UI-027 分阶段通道**：`dry_run`=只检查留状态（回 `check_token`，不落库）；
             # `check_token`=启用前核对期间变化（漂移拒「检查后源表有改动，请重新检查」）。
             # 两个都不传 = 现行原子路径（UI-023 四步），行为不变。
             'dry_run': {'type': 'boolean', 'title': '分阶段检查（预检+留状态，不启用）'},
             'check_token': text('分阶段检查回的 token（启用前核对期间变化）', 140)},
            ['table', 'expected_structure_version', 'definition'])),
    # ---------- PKG-117-T01：**存量表按新模型整体重写** ----------
    # **为什么另开一条口**（契约 2026-10-25 22:4x）：`files.promotion_define` 那条路
    # 只认 `expected_definition_sha` / `expected_structure_version`，**没有整体重写的口**；
    # 而「存量表按新规则重写」是**已生效**定义的**声明**升级，不是新晋升。
    # **重写的是声明，不是效果**（示例企业总表：重写前后都是「全员可读可写」）。
    ('files.promotion_rewrite', '按新模型整体重写已生效的晋升权限声明', ['System Manager'],
     schema({'table': text('表身份（文件编号）', 140),
             'table_name_contains': text('按名字指认（没有 table 时用）', 200),
             'expected_definition_sha': text('读取时的字段定义指纹（防覆盖他人改动）', 64),
             'access': {'type': 'object', 'title': '表级权限主体范围（读/写/下载必填）',
                        'additionalProperties': True},
             'columns': {'type': 'object',
                         'title': '逐列权限主体范围（表头 → 声明）',
                         'additionalProperties': True},
             'default_column_access': {'type': 'object',
                                        'title': '没单独指定的列用这一份',
                                        'additionalProperties': True}},
            ['access'])),
    # PKG-004 / D-c/D-d 前置：晋升列的**数据库侧正式值**写入（D-b 的写那一半）。
    # 只写晋升列；普通列的值在表里，走表保存那条路。喂非晋升列字段当场拒。
    # 写完**一律仅值回填**原表那格（D-d），没有「只写数据库不动表」的后门。
    ('files.formal_value_write', '写晋升列正式值（数据库侧）', ['System Manager'],
     schema({'table': text('表身份', 140), 'row_id': text('固定行ID', 140),
             'values': {'type': 'object', 'title': '数据库字段名 → 值',
                        'additionalProperties': True},
             # **受管记录的版本**（读那一行时回的 `record_version`）：带了才校验。
             # 带了但记录被别人改过 ⇒ 当场拒（陈旧写），不是后写覆盖先写。
             'expected_record_version': text('读到的受管记录版本', 64),
             # **`op_id` 必须能传**（B 2026-10-18）：写入路径要客户端编号，撤回/审计定位用。
             # 跟 `cell_write`/`sheet_cells_write` 同一口径。
             'op_id': text('原操作编号（撤回定位用）', 140)},
            ['table', 'row_id', 'values'])),
    # **唯一写入口**（用户 2026-10-15「合成吧，这样后面好维护」）——
    # `files.cell_write` 与 `files.sheet_cell_write` **同一个实现**（`promotion.cell_write`）。
    #
    # **角色面：`ROLES`（Desk User），不是 System Manager** —— 这是用户那句的直接后果：
    # > 「要区分的是：**晋升字段这个动作和写入这个动作**」
    # **晋升**（把列变成字段、定规矩）= 管理员、偶尔做、改结构 → `files.promotion_define` 保持不动。
    # **写入**（往格子里填值）= 有写权的人、天天做、改内容 → 本动作。
    # 「普通员工填一个数字 ≠ 把一列变成字段」—— **写入不该被晋升的权限拖累**。
    #
    # **谁能改这张表由资源级闸说了算**（上传人 / 归属人 / 获编辑共享，`promotion._require_resource_write`），
    # 不是本处的文档级角色。本处只保证「这个身份能调到这个动作」。
    #
    # 分流仍按「**这一格背后有没有数据库字段**」（不看谁改、不看走哪个口）：
    # 有字段 → 字段规则 + 正式值 + 仅值回填；没字段 → 原表保存。**喂非法值校验全过前
    # 一个字节都不动**（不是清空、也不是写进去）。
    # **不是唯一路径**：`sheet.write_cell`（存进表的机械动作）照旧能单独用。
    ('files.cell_write', '写一格（有字段的列走数据库校验与正式值、没字段的走表）', ROLES,
     schema({'table': text('表身份', 140), 'row_id': text('固定行ID', 140),
             'header': text('表头', 200),
             'value': {'type': 'object', 'title': '格值 {type, value}'},
             'expected_content_version': {'type': 'integer', 'minimum': 0},
             'expected_structure_version': {'type': 'integer', 'minimum': 1},
             # **受管记录的版本**（读那一行时回的 `record_version`）：带了才校验。
             # 带了但记录被别人改过 ⇒ 当场拒（陈旧写），不是后写覆盖先写。
             'expected_record_version': text('读到的受管记录版本', 64),
             # **`op_id` 必须能传**（B 2026-10-18 核出 b01 第 5 条根因）：写入路径没这个字段
             # → schema 拒「动作包含未声明字段：payload.op_id」→ 台账落的不是客户端那个号
             # → 按客户端编号撤回查无此单 417。跟 `sheet_cells_write` 同一口径。
             'op_id': text('原操作编号（撤回定位用）', 140)},
            ['table', 'row_id', 'header', 'value'])),
    # ---------- **文件 ↔ 文件附件绑定口**（PKG-047-T01 · 契约 §8 第 13 项 ＋ §7 第 7 条缺口） ----------
    # 内核**没有**「附件绑定到某件但前端不显示」的口；`platform.object.companion_bind` 是
    # **受管对象 ↔ 伴随表**的绑定（且限 System Manager）⇒ **不是**文件 ↔ 文件的附件绑定。
    # ⇒ 这两个口放在**文件域**（公共件，长期存在；域与域之间只走公开 Action ⇒ 别的域能挂派生件）。
    #
    # **父件侧零改动**（抄老项目 `example_xml_to_pdf.py:660-673`）：关系记在**附件侧**那一行 ⇒
    # 父件那一行一个字都没动 ⇒ 不用给父件加字段、不用 migrate 改父件。
    ('files.attachment.bind', '把一件文件挂成另一件的附件（附件不是版本；派生件带血缘）', ROLES,
     schema({'parent_file': text('父件编号（挂在谁下面）', 140),
             'child_file': text('附件编号（这件自己已经在文件中心里）', 140),
             'relation': {'type': 'string', 'title': '关系种类', 'enum': ['attachment', 'derived']},
             # **给不给前端显示**（契约 §8 待拍点 2：「单独存一件但不显示」⇒ 不显示 ≠ 查不到）。
             'visible': {'type': 'boolean', 'title': '给不给前端显示（默认给）'},
             # **派生件专有**（血缘五元组的其余四元；`sources` 缺省＝父件当前字节摘要）。
             'rule_version': text('规则版本（派生件用）', 64),
             'action_ref': text('哪个动作产出的（派生件用）', 140),
             'order': {'type': 'integer', 'title': '第几份派生（顺序进幂等键）', 'minimum': 1},
             'sources': {'type': 'array', 'title': '原件字节摘要（派生件用；缺省＝父件当前字节摘要）',
                         'maxItems': 20, 'items': text('摘要', 64)}},
            ['parent_file', 'child_file'])),
    ('files.attachment.list', '列出挂在某件文件下面的附件', ROLES,
     schema({'parent_file': text('父件编号', 140),
             'relation': {'type': 'string', 'title': '只看某一种关系', 'enum': ['attachment', 'derived']}},
            ['parent_file'])),
]

OBJECT_FIELDS = [
    ('name', '文件编号', 'string'), ('file_name', '文件名', 'string'), ('directory', '目录', 'string'),
    ('directory_id', '目录编号', 'string'),
    ('tags', '标签', 'string'), ('status', '状态', 'enum'), ('version_count', '下一版本序号', 'integer'),
    ('current_size', '大小（字节）', 'integer'), ('note', '备注', 'string'), ('owner', '上传人', 'string'),
    # C10 两个系统字段 + 关联邮件 —— 必须**在投影里**，否则服务端筛得了、前端拿不到，
    # 列表上没法显示（A 联调时实测 API 里这三个键是 MISSING，就是这里漏的）。
    # 三个都是**只读**：所有人/关联邮件由服务端按邮箱归属推导，员工不能改。
    ('owner_subject_kind', '所有人类型', 'enum'),
    ('owner_subject', '所有人', 'string'),
    ('related_mail', '关联邮件', 'string'),
    ('modified', '更新时间', 'string'),
    # D-11 目录三列之二·三 —— **列声明**（缺了前端表头就不显示，虽然行里一直有值）
    # · 归属：真实组织归属；**无归属明说「无归属（按旧目录授权）」**，不留 None、不写「未知归属」
    # · 权限摘要：**三态对象**，**不是单个 can_edit 布尔**（执行计划：「返回布尔字段不等于
    #   已经实现逐字段鉴权」）。逐列判定**走内核的主体范围判定**
    #   （`access_scope.capabilities` → 内核 `field_subject_allows`，**五个维度**：
    #   读／写／筛／下载／助手），
    #   本处只做**行级合成**，不写第二套判定。
    #   ⚠️ **订正（PKG-117-T01，2026-10-26）**：原来这里写的是「复用内核
    #   `field_access.field_capabilities`」—— **那是建模对象链那套角色键三维**，
    #   **受管表链早就不走它了**（角色键那三个维度留给建模对象链，**口径一字未改**）。
    ('attribution_label', '归属', 'string'),
    ('capability', '权限摘要', 'string'),
    ('review_status', '审核状态', 'string'),
    # **内容修订号**（数据库列）—— 内容真变没变的凭据（两条血脉共用这一个进位号）。
    # **不是 `modified`**：那个是记录修改时间，改名/备注也会推进它 ⇒ 假过期。
    ('content_revision', '当前内容修订号（改单元格填 expected_content_revision 用这个）', 'integer'),
    # **血缘**（2026-10-22 第 1 步：包件交接）：这份字节来自哪个**原包**。
    # 成员靠它溯源到原包（`files.file` 数据集可按它筛 ⇒ 血缘可查）；
    # 原包只作备份与血缘凭证，**不进成员清单**。
    ('container_sha256', '原包摘要（血缘）', 'string'),
    # **附件绑定**（2026-10-23 PKG-047-T01 · 契约 §8 第 13 项）：这一件挂在哪一件下面。
    # · **父件侧零字段**（关系记在附件这一行，父件只被反查）；
    # · **附件不是版本**：不占父件版本号、不顶替父件当前内容；
    # · `attachment_visible` ＝ 0 ⇒ **单独存一件但不显示**（契约 §8 待拍点 2），
    #   **不显示 ≠ 查不到**（父件侧照样查得到）。
    ('attachment_of', '挂在哪件文件下面', 'string'),
    ('attachment_relation', '附件关系种类（attachment／derived）', 'string'),
    ('attachment_visible', '给不给前端显示', 'boolean'),
]

# **派生字段**（不是数据库列，算出来给读方）——
# 2026-10-21 用户在 3850 站失败的那条：助手读到 `version_count`（**下一个可分配号**）
# 当成版本号传 ⇒ 差一 ⇒ 提案永远被判过期。⇒ 把「写入路径要的那一对值」
# **明确命名**给读方，不许再靠猜 `version_count` 的含义。
COMPUTED_FILE_FIELDS = [
    ('upload_version', '当前上传版本号（改单元格填 expected_version 用这个）', 'integer'),
    ('working_copy', '是否有工作副本（页面里改过；为真表示活内容是工作副本那份）', 'boolean'),
]
# —— **这些字段**不是这张表的**物理列** ⇒ **不许进对象声明**（内核通用读照声明去 SELECT
#    ⇒ 声明了非物理列就当场炸「Unknown column 'tags'」）。
#    · `tags`：物理列叫 `tags_json`（**人话那一层是域自己的读口给的**）；
#    · `upload_version`／`working_copy`：**算出来的**（也不是物理列）。
#    ⇒ 域自己的读口（`files.list`／`files.versions`）**照旧给它们**。
DERIVED_OBJECT_FIELDS = {'tags', 'attribution_label', 'capability', 'upload_version', 'working_copy'}
STATUS = {'Active': '在库', 'Recycled': '已回收'}
FILE_KINDS = {
    '文档': {'pdf', 'doc', 'docx', 'txt', 'md'},
    '表格': {'xls', 'xlsx', 'csv'},
    '图片': {'png', 'jpg', 'jpeg', 'webp', 'gif'},
}


def file_kind(name):
    extension = str(name or '').rsplit('.', 1)[-1].lower()
    return next((kind for kind, extensions in FILE_KINDS.items() if extension in extensions), '其他')


# ---------- 公共事件：文件审核完成（T07/第二步的接缝） ----------
# 公共文件审核保存成功后**要通知系统**「谁确认了哪份文件、采用了哪些信息」——
# 之前只有 example 自己的官文审核动作在发通知，**公共审核入口是哑的**：
# 员工用公共审核能力完成 ⇒ 自动化不知道该接什么。
#
# ⚠️ 这个事件**只说明「刚才发生了什么」** —— 不代表「要发邮件」：
# 是不是官文、属于哪个案件、要不要通知客户，是**业务域的判断**（example 的事）。
FILE_REVIEW_COMPLETED_EVENT = 'files.review.completed'
# 成员清单事件（**文件域声明**）：「这个包收了哪些成员」。
# ⚠️ **声明者必须是长期存在的公共件**（文件域）—— 事件由声明者的生死挂着
# （内核 `publish_event` 对声明者做 `assert_domain_enabled`），
# **不由业务域声明**；业务域停用时事件声明留着（降级，不是拔除）。
FILE_PACKAGE_STORED_EVENT = 'files.package.stored'
EVENTS = [
    {'id': FILE_REVIEW_COMPLETED_EVENT, 'version': '1.1.0',
     # 发布权限由**审核动作本身**把着（谁能改这份文件才能审这份文件）⇒ 事件不再另设角色闸。
     'roles': [], 'sensitivity': 'internal', 'delivery': 'at_least_once',
     # 载荷形状（**只有事实**）：哪份文件、什么版本、采用了哪些记录的哪些字段、
     # 谁做的、什么时候、哪一次操作（trace）。**没有**「要不要发邮件」这类结论。
     # 1.1.0 ＝ 补上 operator/occurred_at/trace_id 三个事实字段（1.0.0 的字段一个没删）。
     'payload_schema': {'type': 'object', 'additionalProperties': False,
                        'required': ['file', 'adopted'],
                        'properties': {'file': {'type': 'string'},
                                       'adopted': {'type': 'array'},
                                       'file_version': {'type': 'string'},
                                       'operator': {'type': 'string'},
                                       'occurred_at': {'type': 'string'},
                                       'trace_id': {'type': 'string'}}}},
    # ---------- 成员清单事件（第 1 步：包件交接） ----------
    # 「这个包收了哪些**成员**」（成员清单 ＋ 每个成员的血缘）。
    # · **原包不在成员清单里** —— 原包只作备份与血缘凭证，业务域不取它；
    # · 载荷**只有事实**：谁、什么种类、什么摘要、多大、属于哪个包；
    #   **没有**「要不要处理」「是不是通知书」这类结论（那是业务域的判断）。
    {'id': FILE_PACKAGE_STORED_EVENT, 'version': '1.1.0',
     'roles': [], 'sensitivity': 'internal', 'delivery': 'at_least_once',
     # 1.1.0 ＝ **每个成员多带 `file`（它在文件中心的编号）**：
     #   业务域要按这份清单认领件，而**原包也带同一个血缘** ⇒ 只按血缘查会把原包一起认领
     #   ⇒ 载荷直接说清「这一件的编号是谁」，认领不再靠名字猜（1.0.0 的字段一个没删）。
     'payload_schema': {'type': 'object', 'additionalProperties': False,
                        'required': ['container_sha256', 'members'],
                        'properties': {'container_sha256': {'type': 'string'},
                                       'members': {'type': 'array', 'items': {
                                           'type': 'object', 'additionalProperties': False,
                                           'required': ['name', 'kind', 'sha256', 'size_bytes',
                                                        'container_sha256', 'file'],
                                           'properties': {'name': {'type': 'string'},
                                                          'kind': {'type': 'string'},
                                                          'sha256': {'type': 'string'},
                                                          'size_bytes': {'type': 'integer'},
                                                          'container_sha256': {'type': 'string'},
                                                          'file': {'type': 'string'}}}}}}},
]


def get_contribution():
    obj = {
        'id': 'files.file', 'name': '企业文件', 'doctype': 'Shangshu File Center File',
        # 2026-10-21：新增三个读方字段（upload_version / content_revision / working_copy）
        # ⇒ 对象定义变了 ⇒ 小版本进位 1.0.0 → 1.1.0（老字段一个没删、没改）。
        # 2026-10-22（包件交接第 1 步）：新增**血缘**字段 `container_sha256`
        # （这份字节来自哪个原包）⇒ 又一次小版本进位 1.1.0 → 1.2.0。
        # 2026-10-23（PKG-047-T01 · 契约 §8 第 13 项）：新增**附件绑定**三格
        # （`attachment_of`／`attachment_relation`／`attachment_visible`）
        # ⇒ 又一次小版本进位 1.2.0 → **1.3.0**（老字段一个没删、没改）。
        # 2026-10-28（PKG-132 收尾 · 必登记缺陷「Unknown column 'tags'」）：
        # **声明里只留「物理列」** ⇒ 又一次小版本进位 1.3.0 → **1.4.0**。
        # ⚠️ **为什么**：内核的**通用对象读**照声明去 SELECT（内核口径：「表格读取沿声明字段」）
        #   ⇒ 声明了**非物理列**就当场炸：
        #   · `tags` —— 物理列叫 `tags_json`（人话那一层是**域自己的读口**给的）；
        #   · `upload_version`／`working_copy` —— **算出来的**（也不是物理列）。
        #   ⇒ 站上实测（通用读 `files.file`）：
        #   `OperationalError (1054, "Unknown column 'tags' in 'SELECT'")`。
        # ⇒ 这几个**不进对象声明**（**域自己的读口照旧给它们** —— `files.list`／`files.versions` 那条）。
        'version': '1.4.0', 'schema_version': 1, 'operations': ['read'],
        'filter_fields': ['file_name', 'directory', 'status',
                          # C10：按所有人 / 关联邮件筛，**在服务端筛**（不是前端把别人藏起来）
                          'owner_subject_kind', 'owner_subject', 'related_mail',
                          # **血缘**：按原包摘要筛 ⇒ 「这个包里有哪些件」查得到。
                          'container_sha256',
                          # **附件绑定**（PKG-047-T01）：按「挂在谁下面」筛 ⇒
                          # 「这件东西下面挂着哪些附件」查得到（父件侧零字段，靠这个反查）。
                          'attachment_of', 'attachment_relation'],
        'fields': [{'id': key, 'label': label, 'type': type_,
                    **({'description': '历史内部游标，不是版本数；当前固定版本读取 files.versions 的 file.version，固定内容引用读取 versions[].source。'
                                     '⚠️ **别把它当版本号用** —— 当前上传版本号是 `upload_version`（= 这个值 − 1）。'} if key == 'version_count' else {}),
                    **({'value_labels': STATUS} if key == 'status' else {})} for key, label, type_ in OBJECT_FIELDS
                   if key not in DERIVED_OBJECT_FIELDS],
        'record_actions': [],
    }
    columns = [
        {'field': 'file_name', 'label': '文件名'},
        {'field': 'directory', 'label': '目录'},
        {'field': 'tags', 'label': '标签'},
        {'field': 'current_size', 'label': '大小'},
        {'field': 'owner', 'label': '上传人'},
        {'field': 'modified', 'label': '更新时间'},
    ]
    return {
        # 合并说明：版本与 platform_api 取**更高**的一边（fast 的 0.8.0 / >=1.11）。
        # 2026-10-21（版本口径修复）：域版本 0.8.0 → 0.9.0 ——
        # ① `files.edit_cells` 前置条件换字段（动作版本 1.0.1 → 2.0.0）；
        # ② 读方新增「写入路径要的那一对值」（`upload_version` / `content_revision` / `working_copy`）。
        # 2026-10-21（接缝）：域版本 0.9.0 → **0.10.0** ——
        # ③ 公共文件审核完成的事件载荷补上「谁做的／什么时候／哪一次操作」（`files.review.completed` 1.0.0 → 1.1.0），
        #    载荷形状抽成纯函数层（`events.py`，零 import frappe）。
        # 2026-10-22（包件交接第 1 步）：域版本 0.10.0 → **0.11.0** ——
        # ④ 新增动作 `files.package.store`（按包存成员 ＋ 广播成员清单）；
        # ⑤ 新增事件 `files.package.stored`（**由文件域声明**：谁声明，谁的生死挂在事件上）；
        # ⑥ `files.file` 加**血缘**字段 `container_sha256`（可筛）；
        # ⑦ 声明本域在文件中心的那块路径（`file_paths`，根目录）。
        # 2026-10-22（包件交接第 2 步）：域版本 0.11.0 → **0.12.0** ——
        # ⑧ 新增公共服务 `files.content`（读一份受管文件的**原始字节**，限大小 ＋ 走既有读权/导出闸）
        #    ⇒ 业务域要按 XML 的**结构**解析清单（example 按 `list.xml` 分组）时不必再要一个口。
        # 2026-10-22（PKG-036-T04）：域版本 0.12.0 → **0.13.0** ——
        # 新增动作 `files.upload_attached`（放字节 ＋ 挂到指定记录上）
        # ⇒ 收掉「收信附件自己建 File」那处限期豁免。
        # 2026-10-23（PKG-047-T01 · 契约 §8 第 13 项 ＋ §7 第 7 条缺口）：域版本 0.13.0 → **0.14.0** ——
        # ① 新增动作 `files.attachment.bind`（把一件挂成另一件的附件）＋ `files.attachment.list`
        #    （父件侧列附件）—— **内核没有**这个口（`platform.object.companion_bind` 是
        #    受管对象↔伴随表的绑定，不是文件↔文件）；放在**文件域**（公共件、长期存在）；
        # ② `files.file` 加**附件绑定**三格（`attachment_of`／`attachment_relation`／
        #    `attachment_visible`）—— **父件侧零字段**（关系记在附件那一行）；
        # ③ `files.file` 加 `attachment_of`／`attachment_relation` 两个**可筛**字段。
        # 2026-10-25（PKG-116-T08 · **长文本这一档**）：域版本 0.14.0 → **0.15.0** ——
        # 晋升列的类型得**内核与文件域两边都认**才走得通：内核的 `TYPE_MAP` 上一轮已加，
        # **文件域 `_check_rules`（值规则那道闸）这一轮补上** ⇒ 以前报「类型不受支持：'long_text'」。
        # 为什么需要这一档：客户示例企业总表的「联系人信息」有 63 处超 140 字符（最长 580）
        # ⇒ **是真业务内容**（多个联系人＋流程联系人＋邮箱）、不是脏数据 ⇒ 清掉＝丢真信息；
        # 而短文本那一档的物理列容量就是 140（Frappe Data）⇒ 装不下。
        # **动作定义（输入/输出 schema）一个字没改** ⇒ 动作版本不动。
        'id': DOMAIN, 'name': '文件中心', 'owner_app': 'shangshu_files', 'version': '0.19.0',
        'platform_api': '>=1.19 <2.0', 'default_enabled': True,
        # migrate 时内核逐个调用域的刷新入口（`shangshu_core.domains.refresh_domain_contributions`）
        # ⇒ **新装一个域、它声明了路径 ⇒ 下次 migrate 它的路径就在了**（不用人去建目录）。
        'refresh': 'shangshu_files.install.refresh',
        # **本域在文件中心的那块路径**（用户 2026-10-22 15:52：「每一个新业务域的注册都要注册一个新的路径」）。
        # 文件中心本体就是根目录 ⇒ 声明 `/`。
        # ⚠️ **路径的形状由文件中心定、内容由域定**：文件中心只要求「以域 id 开头的一段 ＋ 域自己挑的子目录」；
        # **文件中心不许硬编码任何域 id**（`scripts/check-style-rules.mjs` 的 FC-01 解耦检查会扫）。
        'file_paths': [{'path': '/', 'note': '文件中心本体 —— 根目录。'}],
        'applications': [{'id': DOMAIN + '.center', 'title': '文件中心', 'icon': '夹', 'roles': ROLES,
                          'home': 'file-center', 'processes_ids': []}],
        'objects': [obj],
        'datasets': [{'id': 'files.file', 'object_id': 'files.file', 'name': '企业文件',
                      'query': 'shangshu_files.domain.query', 'roles': ROLES, 'columns': columns,
                      'filters': [{'field': 'file_name', 'label': '文件名', 'type': 'text'},
                                  {'field': 'directory', 'label': '目录', 'type': 'text'},
                                  {'field': 'status', 'label': '状态', 'type': 'enum', 'value_labels': STATUS},
                                  {'field': 'owner_subject_kind', 'label': '所有人类型', 'type': 'enum',
                                   'value_labels': {'Employee': '员工', 'Department': '部门'}},
                                  {'field': 'owner_subject', 'label': '所有人', 'type': 'text'},
                                  {'field': 'related_mail', 'label': '关联邮件', 'type': 'text'},
                                  # **血缘**：按原包摘要筛（成员可溯源到原包）。
                                  {'field': 'container_sha256', 'label': '原包摘要（血缘）', 'type': 'text'}]}],
        'actions': [{'id': a[0], 'handler': 'shangshu_files.service.execute',
                     **({'transaction': 'atomic_package',
                         'transaction_versions': [PACKAGE_ACTION_VERSIONS[a[0]]],
                         'package_actions': ['platform.object.update_many', 'platform.object.create']}
                        if a[0] in PACKAGE_ACTION_VERSIONS else {}),
                     **({'review_handler':'shangshu_files.proposal_review.review'}
                        # 合并说明：fast 那边还把 `files.edit_cells`（自由文件逐格审核）也接上
                        # review_handler —— 本分支的 proposal_review.py 已实现这一支，取并集。
                        # 2026-10-21（agent 建表一线）：`files.create` 也接上 ——
                        # **建表确认卡上要看得见表名/每个表头/占位文字/归属，且逐项能改**
                        # （没挂 review_handler 时确认卡里只有一个空动作＝表名）。
                        if a[0] in ('files.sheet_cell_write','files.sheet_cells_write','files.edit_cells',
                                    'files.create') else {}),
                     **({'proposal_guard': 'shangshu_files.service.proposal_guard',
                         'proposal_snapshot': 'shangshu_files.service.proposal_snapshot',
                         'proposal_projection': 'shangshu_files.proposal_projection.project'}
                        if a[0].startswith('files.sheet_') or a[0] in (
                            'files.review', 'files.update_meta', 'files.import_attachment', 'files.create',
                            'files.recycle', 'files.restore', 'files.cell_write', 'files.formal_value_write',
                            'files.promotion_define', 'files.promotion_rewrite', 'files.edit_cells') else {}),
                     # 格值写入/撤回的结果带值：同键重放前按当前读权复核（B5 重放守卫）
                     **({'replay_guard': 'shangshu_files.service.replay_guard'}
                        if a[0] in ('files.sheet_cell_write', 'files.sheet_cells_write', 'files.sheet_cells_undo',
                                    'files.sheet_style_write', 'files.sheet_input_write', 'files.sheet_paste_apply',
                                    # 第四批成包编辑：回包也带格值 → 同样要按当前读权复核
                                    'files.sheet_find_replace', 'files.sheet_fill_series',
                                    'files.sheet_paste_special',
                                    # 合并说明：fast 那边还把这几个新动作接上重放守卫，取并集
                                    'files.sheet_structure', 'files.sheet_sort', 'files.sheet_style',
                                    'files.edit_cells') else {})}
                    for a in ACTIONS],
        # T07 assistant 工具（A 的审核面板）：**AI Tool 必须投影已注册 Action**
        # （内核 domains.py 的硬约束），所以这里只放动作，不放服务。
        #   create_table → files.create；add_column → files.sheet_column_append；
        #   add_row → files.sheet_row_append；copy_values / batch_fill →
        #   files.sheet_paste_apply / files.sheet_cells_write。
        # `range_read` 暂不在此列：`files.sheet_read` 是**服务不是动作**，按上面那条
        # 硬约束不能投影成工具。要给它开工具得先有一个只读 Action —— 那是新开公共
        # 接口面，不在本次改动里定。
        # PKG-008-T01 B 侧（2026-10-14）：把**原行列生命周期 / 改名 / 回收恢复 /
        # 安全逆向**这四样补进助手工具面。它们的动作一直在（`header_rename` /
        # `sheet_rename` / `recycle` / `restore` / `sheet_cells_undo`），缺的只是
        # 这一行投影 —— 不投影，助手就只能建表/加列/加行/粘贴/批量写/范围读，
        # **改名、撤回、回收、恢复一律碰不到**。
        # `files.upload` 有意不开（Base64 上传不给 Agent），别顺手加。
        'tools': [{'id': key} for key in (
            'files.edit_cells', 'files.edit_paragraphs', 'files.review', 'files.update_meta', 'files.import_attachment',
            'files.create', 'files.sheet_column_append', 'files.sheet_row_append',
            'files.sheet_paste_apply', 'files.sheet_cells_write', 'files.sheet_range_read',
            'files.sheet_header_rename', 'files.sheet_rename',
            'files.recycle', 'files.restore', 'files.sheet_cells_undo',
            # PKG-018-T06 第一阶段：**表格分析**（普通 XLSX／绑定表）——
            # 与受管记录的 `platform.object.aggregate` 同一套口径；
            # 助手问「这张表多少钱／多少行」时该走它，而不是自己逐行数。
            'files.table_aggregate')],
        'processes': [],
        'roles': [],
        'services': [
                     {'id':'files.table_relation_export','handler':'shangshu_files.table_relations.export','roles':ROLES,'purpose':'detail','effect':'read','input_schema':schema({'table':text('表',140)},['table'])},
                     {'id':'files.table_relation_read','handler':'shangshu_files.table_relations.read','roles':ROLES,'purpose':'detail','effect':'read',
                      'input_schema':schema({'table':text('表',140),'row_ids':{'type':'array','maxItems':500,'items':text('固定行',140)},'headers':{'type':'array','maxItems':100,'items':text('关联列',140)}},['table'])},
                     # 合并说明：fast 那边的自由文件读侧服务（段落/正文/单元格/工作簿）也留
                     # —— 两边的服务清单取并集。
                     {'id':'files.paragraphs','handler':'shangshu_files.paragraphs.read','roles':ROLES,
                      'purpose':'detail','effect':'read',
                      'input_schema':schema({**REF,'version':{'type':'integer','minimum':1},
                          'start':{'type':'integer','minimum':1}, 'limit':{'type':'integer','minimum':1,'maximum':20},
                          'changes':PARAGRAPH_CHANGES},['file','version'])},
                     {'id':'files.document','handler':'shangshu_files.document.invoke','roles':ROLES,
                      'purpose':'file_editor','effect':'read',
                      'input_schema':schema({**REF,'version':{'type':'integer','minimum':1},
                          'operation':{'type':'string','enum':['open','encode']},
                          'changes':{'type':'array','maxItems':1000,'items':schema({'key':text('段落编号',20),'text':text('正文',20000)},['key','text'])}},['file','version','operation'])},
                     {'id': 'files.cells', 'handler': 'shangshu_files.cells.read', 'roles': ROLES,
                      'purpose':'detail','effect':'read',
                      'input_schema': schema({**REF, 'version':{'type':'integer','minimum':1},
                          'sheet':text('工作表名称',31), 'row':{'type':'integer','minimum':1,'maximum':1000},
                          'column':{'type':'integer','minimum':1,'maximum':100},
                          'rows':{'type':'integer','minimum':1,'maximum':50},'columns':{'type':'integer','minimum':1,'maximum':20},
                          'changes':CELL_CHANGES},['file','version'])},
                     {'id': 'files.workbook', 'handler': 'shangshu_files.workbook.invoke', 'roles': ROLES,
                      'purpose': 'file_editor', 'effect': 'read',
                      'input_schema': schema({'operation': {'type': 'string', 'enum': ['blank', 'open', 'import', 'encode']},
                                              'file': text('文件编号', 140), 'version': {'type':'integer','minimum':1},
                                              'filename': text('文件名称', 200),
                                              'content_base64': {'type':'string','maxLength':14000000},
                                              'workbook': {'type':'object'}, 'operations': {'type':'array','maxItems':200}}, ['operation'])},
                     {'id': 'files.review', 'handler': 'shangshu_files.review.read', 'roles': ROLES,
                      'purpose': 'detail', 'effect': 'read',
                      'input_schema': schema(REF, ['file'])},
                     {'id': 'files.directories', 'handler': 'shangshu_files.directories.listing', 'roles': ROLES,
                      'purpose': 'directory', 'effect': 'read', 'input_schema': schema({}, []),
                      'output_schema': {'type': 'object', 'required': ['directories', 'can_manage'],
                                        'properties': {'directories': {'type': 'array'}, 'can_manage': {'type': 'boolean'}}}},
                     {'id': 'files.versions', 'handler': 'shangshu_files.domain.versions', 'roles': ROLES,
                      'purpose': 'detail', 'effect': 'read',
                      'input_schema': {**schema({'file': {**text('文件编号', 140), 'minLength': 1},
                                                'attachment': {**text('固定 Frappe File 附件编号', 140), 'minLength': 1}}, []),
                                       'description': 'file 与 attachment 严格二选一。file 返回文件版本历史；attachment 只返回该固定附件对应的版本，不按名称查找或改取最新版。'},
                      'output_schema': {'type': 'object', 'required': ['versions'],
                                        'properties': {'versions': {'type': 'array'}}}},
                     # PKG-004-T03：读**受管文件的正文分段**（官文正文从哪来 —— 公共口）。
                     # 口径：PDF 抽**文字层**（不 OCR、不截图、不给模型看）⇒ 按坐标还原成行/段
                     # （分栏先左栏后右栏）⇒ 每段带页码；没有文字层的页**明说抽不出、请人工填**。
                     {'id': 'files.document_text', 'handler': 'shangshu_files.document_text.read_text',
                      'roles': ROLES, 'purpose': 'detail', 'effect': 'read',
                      'description': '读受管文件的正文分段（PDF 文字层 / DOCX 段落 / 文本行 / 图片无字）。'
                                     '读的是**当前固定版本**；每段带页码与段号；'
                                     '没有文字层的页在 unreadable_pages 里明说，不当空内容。',
                      'input_schema': schema({'file': {**text('文件编号', 140), 'minLength': 1},
                                              'start': {'type': 'integer', 'minimum': 1},
                                              'limit': {'type': 'integer', 'minimum': 1, 'maximum': 200}}, ['file'])},
                     # ---------- 2026-10-22（第 2 步）：读一份受管文件的**原始字节** ----------
                     # **为什么要有**：`files.document_text` 只给**文字节点**（标记被丢掉了），
                     # 而业务域要按 XML 的**结构**解析它（example 按 `list.xml` 分组）⇒ 分不了组。
                     # ⇒ 给一个**受控**的字节读口：限大小、走既有读权与导出闸、只读受管私有原件。
                     {'id': 'files.content', 'handler': 'shangshu_files.content.read_content',
                      'roles': ROLES, 'purpose': 'detail', 'effect': 'read',
                      'description': '读受管文件的**原始字节**（base64 回包）。'
                                     '只读当前固定版本的受管私有原件；限大小（默认 1 MiB，最多 4 MiB）；'
                                     '读权与导出闸都走既有那条口（files.versions）；哈希对不上当场拒。',
                      'input_schema': schema({'file': {**text('文件编号', 140), 'minLength': 1},
                                              'max_bytes': {'type': 'integer', 'minimum': 1,
                                                            'maximum': 4194304}}, ['file']),
                      'output_schema': {'type': 'object', 'required': ['file', 'size_bytes', 'sha256',
                                                                     'content_base64'],
                                        'properties': {'file': {'type': 'string'},
                                                       'name': {'type': 'string'},
                                                       'size_bytes': {'type': 'integer'},
                                                       'sha256': {'type': 'string'},
                                                       'content_base64': {'type': 'string'}}}},
                     {'id': 'files.sheet_input_constraints', 'handler': 'shangshu_files.input_constraints.read',
                      'roles': ROLES, 'purpose': 'detail', 'effect': 'read',
                      'description': '只读指定表头已有正式声明的输入约束；未声明列不出现在columns，不据此确认列存在。',
                      'input_schema': schema({'table': {**text('表身份', 140), 'minLength': 1},
                                              'headers': {'type': 'array', 'minItems': 1, 'maxItems': 64,
                                                          'uniqueItems': True,
                                                          'items': {**text('表头', 32767), 'minLength': 1}},
                                              'search': text('选项原值搜索词', 200),
                                              'page': {'type': 'integer', 'minimum': 1},
                                              'page_length': {'type': 'integer', 'minimum': 1, 'maximum': 50}},
                                             ['table', 'headers'])},
                     {'id': 'files.sheet_read', 'handler': 'shangshu_files.sheet.read_payload', 'roles': ROLES,
                      'purpose': 'detail', 'effect': 'read',
                      'input_schema': schema({'table': text('表身份', 140), 'sheet': text('工作表身份', 140),
                                              'row_ids': {'type': 'array', 'maxItems': 500, 'items': text('固定行ID', 140)},
                                              'headers': {'type': 'array', 'items': text('读取列的表头', 32767)},
                                              'page': {'type': 'integer', 'minimum': 1},
                                              'page_length': {'type': 'integer', 'minimum': 1, 'maximum': 500},
                                              'search': text('全表搜索词（不区分大小写的包含匹配）', 200),
                                              # B02-7 复制日志：客户端带原操作号 → 本次读取的
                                              # 范围/逐值快照/身份落操作台账（不带就不记，不假装）。
                                              'op_id': text('原操作编号（复制/读取日志用）', 140)},
                                             ['table']),
                      'output_schema': {'type': 'object', 'required': ['table', 'headers', 'rows'],
                                        'properties': {'rows': {'type': 'array'}}}},
                     # PKG-004 / X3-②③：操作台账读口。台账以前**只写不读**
                     # （`undo_cells` 内部按 op_id 查，对外没有口），
                     # 于是「当时按哪一版定义解释」查不到、也验不了。
                     # **只读台账本身，不回文件内容** —— 要内容走 files.versions + 下载
                     # （那条受内容闸管）。
                     {'id': 'files.op_history', 'handler': 'shangshu_files.sheet.read_ops', 'roles': ROLES,
                      'purpose': 'detail', 'effect': 'read',
                      'input_schema': schema({'file': text('表身份', 140),
                                              'limit': {'type': 'integer', 'minimum': 1, 'maximum': 200}},
                                             ['file']),
                      'output_schema': {'type': 'object', 'required': ['file', 'ops'],
                                        'properties': {'ops': {'type': 'array'}}}},
                     # PKG-004 / D-a：读晋升定义（列 → 数据库字段映射 + 晋升标记）。
                     # 读侧不卡 System Manager —— 能读这张表就能知道「哪几列是正式值」；
                     # **写**定义才卡（见 files.promotion_define）。
                     {'id': 'files.promotion_definition', 'handler': 'shangshu_files.promotion.read',
                      'roles': ROLES, 'purpose': 'detail', 'effect': 'read',
                      'input_schema': schema({'table': text('表身份', 140)}, ['table']),
                      'output_schema': {'type': 'object', 'required': ['table', 'columns'],
                                        'properties': {
                                            'columns': {'type': 'array'},
                                            # **表级主体范围**（PKG-117-T01）—— 前端「字段权限」面板要用
                                            'access': {'type': ['object', 'null']},
                                            'definition_version': {'type': ['integer', 'null']},
                                            'structure_version': {'type': ['integer', 'null']},
                                            'bound_structure_version': {'type': ['integer', 'null']},
                                            'binding_current': {'type': ['boolean', 'null']}}}},
                     # BASE967-27 / R967 §五 B 节 B02（2026-10-19 主控转 A 定口径）：
                     # **启用期间修改 → 旧提案重验**。A 的审核面板拿这个标「需重验」。
                     # **触发 = 定义或结构版本前进**（**值改动不影响提案有效性**）。
                     # `reason` 是**五值枚举**（E 契约 §十），`unknown` 兜底 fail-closed。
                     # **B 只出公共判定，不管 A 怎么渲染**。
                     {'id': 'files.promotion_status',
                      'handler': 'shangshu_files.promotion.promotion_status',
                      'roles': ROLES, 'purpose': 'detail', 'effect': 'read',
                      'input_schema': schema({'table': text('表身份', 140)}, ['table']),
                      'output_schema': {'type': 'object',
                                        'required': ['table', 'proposals_needing_revalidation'],
                                        'properties': {
                                            'proposals_needing_revalidation': {
                                                'type': 'array',
                                                'items': schema({
                                                    'id': text('提案号', 140),
                                                    'reason': {'type': 'string', 'enum': list(
                                                        REVALIDATION_REASONS)}},
                                                    ['id', 'reason'])},
                                            'structure_version': {'type': 'integer'},
                                            'definition_sha': {'type': ['string', 'null']}}}},


                     # PKG-004 / D-b：**读路径合并** —— 晋升列取数据库正式值、
                     # 普通列取表数据，拼成一行；两边不互相覆盖。表数据本身不动。
                     {'id': 'files.row_require_ready', 'handler': 'shangshu_files.promotion.row_require_ready',
                      'roles': ROLES, 'purpose': 'detail', 'effect': 'read',
                      'input_schema': schema({'table': text('表身份', 140),
                                              'row_id': text('固定行ID', 140)}, ['table', 'row_id']),
                      'output_schema': {'type': 'object', 'required': ['table', 'row_id', 'ready'],
                                        'properties': {'ready': {'type': 'boolean'}}}},
                     # 按**受管列的正式值**精确找行（业务行身份＝业务编号，如示例企业内部编号）。
                     # 编号 ↔ 工作簿行 ID 的映射在文件域手里 ⇒ 这个口只能在这里。
                     {'id': 'files.row_find_by_value', 'handler': 'shangshu_files.promotion.row_find_by_value',
                      'roles': ROLES, 'purpose': 'detail', 'effect': 'read',
                      'input_schema': schema({'table': text('表身份', 140),
                                              'field': text('受管字段名', 140),
                                              'value': {'type': ['string', 'number', 'boolean']}}, ['table', 'field', 'value']),
                      'output_schema': {'type': 'object', 'required': ['table', 'field', 'matched', 'rows'],
                                        'properties': {'table': {'type': 'string'}, 'field': {'type': 'string'},
                                                       'matched': {'type': 'boolean'}, 'exact': {'type': 'boolean'},
                                                       'count': {'type': 'integer'},
                                                       'object_id': {'type': 'string'},
                                                       'rows': {'type': 'array'},
                                                       'hint': {'type': 'string'}}}},
                     # 按**工作簿行 ID** 解析出那条受管记录（2026-10-22 第四段）。
                     # 「行 ID → 受管记录名」的映射在文件域手里（晋升绑定）⇒ 这个口只能在这里；
                     # 有了它，动作审计与事件才能挂到受管记录上 ⇒ 日志能**按案件看**。
                     {'id': 'files.row_resolve', 'handler': 'shangshu_files.promotion.row_resolve',
                      'roles': ROLES, 'purpose': 'detail', 'effect': 'read',
                      'input_schema': schema({'table': text('表身份', 140),
                                              'row_id': text('工作簿行 ID', 140)}, ['table', 'row_id']),
                      'output_schema': {'type': 'object', 'required': ['table', 'row_id', 'found'],
                                        'properties': {'table': {'type': 'string'}, 'row_id': {'type': 'string'},
                                                       'found': {'type': 'boolean'},
                                                       'object_id': {'type': 'string'},
                                                       'record': {'type': 'string'},
                                                       'hint': {'type': 'string'}}}},
                     {'id': 'files.sheet_view_read', 'handler': 'shangshu_files.sheet_view.read_view',
                      'roles': ROLES, 'purpose': 'detail', 'effect': 'read',
                      'input_schema': schema({'table': text('表身份', 140)}, ['table']),
                      'output_schema': {'type': 'object'}},
                     # 列头筛选面板的「值清单」：整列去重值（只读）。
                     # 与 files.sheet_view_read 同一件东西的另一个读口 —— 同一张表、同一套权限。
                     {'id': 'files.sheet_column_values', 'handler': 'shangshu_files.sheet_view.column_values',
                      'roles': ROLES, 'purpose': 'detail', 'effect': 'read',
                      'input_schema': schema({'table': text('表身份', 140),
                                              'column': text('列名', 140)}, ['table', 'column']),
                      'output_schema': {'type': 'object'}},
                     {'id': 'files.row_read', 'handler': 'shangshu_files.promotion.row_read',
                      'roles': ROLES, 'purpose': 'detail', 'effect': 'read',
                      'input_schema': schema({'table': text('表身份', 140),
                                              'row_id': text('固定行ID', 140),
                                              'headers': {'type': 'array', 'title': '只读这些表头（可省；全受管列无需解析工作簿）',
                                                          'minItems': 1, 'maxItems': 256, 'uniqueItems': True,
                                                          'items': {**text('表头', 140), 'minLength': 1}}}, ['table', 'row_id']),
                      'output_schema': {'type': 'object', 'required': ['table', 'row_id', 'cells'],
                                        'properties': {'table': {'type': 'string'}, 'row_id': {'type': 'string'},
                                                       'cells': {'type': 'object'}, 'source': {'type': 'object'},
                                                       'record_version': {'type': 'string'},
                                                       'content_version': {'type': 'integer'},
                                                       'structure_version': {'type': 'integer'},
                                                       'sheet': {'type': 'string'},
                                                       'row_status': {'type': 'string'},
                                                       'promoted': {'type': 'boolean'},
                                                       'bound': {'type': ['boolean', 'null']}}}},
                     # PKG-010-T01 前置（2026-10-14）：A 的审核面板按**表**取待审提案。
                     # 现有内核口 `/api/confirmations` 是全库按状态取的、且不在 files. 命名空间，
                     # A 调 `files.action_proposals` 回 404，5 条判据全卡住。
                     # 回包必须是 `{proposals:[…]}` —— 回裸数组会被 BFF 摊成 `{ok:true,"0":…}`，
                     # 前端 `d.result?.proposals || d.proposals` 取不到（identity 那单的教训）。
                     {'id': 'files.action_proposals', 'handler': 'shangshu_files.proposals.listing',
                      'roles': ROLES, 'purpose': 'detail', 'effect': 'read',
                      'input_schema': schema({'table': text('表身份', 140)}, ['table']),
                      'output_schema': {'type': 'object', 'required': ['proposals'],
                                        'properties': {'proposals': {'type': 'array'}}}},
                     {'id': 'files.action_proposal_resolve', 'handler': 'shangshu_files.proposals.resolve',
                      'roles': ROLES, 'purpose': 'detail', 'effect': 'write',
                      'input_schema': schema(
                          {'proposal_id': text('提案编号', 140),
                           'decision': {**text('决定', 20), 'enum': ['confirmed', 'rejected']},
                           'edited_value': {'type': 'object', 'title': '修改建议的编辑值（可省）',
                                            'required': ['type'],
                                            'properties': {'type': text('值类型', 20),
                                                           'value': {'type': ['string', 'number', 'boolean', 'null']}}}},
                          ['proposal_id', 'decision']),
                      'output_schema': {'type': 'object', 'required': ['proposal'],
                                        'properties': {'proposal': {'type': 'object'}}}},
                     # 合并门禁（用户 2026-10-14）：邮件侧要判「这附件进过文件中心没有」，
                     # 原先直查本域内部表 `Shangshu File Center Version`。改走这个只读口，
                     # 跨域耦合就从「读对方的表」变成「调对方公开声明的服务」——
                     # 后者能被 `assert_declared_call` + 插件依赖声明管住，前者管不住。
                     # **只给批量读开这个口**：幂等/取 id 那两处改用 `files.import_attachment`
                     # 的回包（本来就带 `file` 与 `already_imported`），不必再开查询口。
                     {'id': 'files.imported_of', 'handler': 'shangshu_files.imported.imported_of',
                      'roles': ROLES, 'purpose': 'detail', 'effect': 'read',
                      'input_schema': schema(
                          {'source_files': {'type': 'array', 'title': '来源附件编号（Frappe File id）',
                                            'minItems': 1, 'maxItems': 100, 'uniqueItems': True,
                                            'items': text('来源附件编号', 140)}},
                          ['source_files']),
                      'output_schema': {'type': 'object', 'required': ['items'],
                                        'properties': {'items': {'type': 'array'},
                                                       'count': {'type': 'integer'}}}}],
        'events': list(EVENTS), 'subscriptions': [], 'navigation': [], 'pages': [], 'workbench': [],
    }


def _owner_subject_aliases(value, kind=''):
    """员工的「所有人」**两种写法互认**：员工ID（`Shangshu Identity.identity_id`，schema 口径）
    ↔ 登录名/邮箱（受管收信路径实际写入的值）。

    **部门不分派**：`kind='Department'` 时两种写法本就是同一个部门 ID，原样返回。

    **为什么要有**（C 16 收口实测）：schema 声明员工ID、筛选下拉给 identity_id、
    受管路径写登录名，三方打架 → 纯等值筛选对存量行必然 0 条。
    **这是读侧别名解析，不是第二套权限判定**——不改存储、不改授权、每次现算不缓存。
    """
    out = [str(value or '').strip()]
    if not out[0] or str(kind or '').strip() == 'Department':
        return out
    from shangshu_core.public_api import identity_aliases
    return identity_aliases(out[0])


def query(dataset_id, filters=None, page=1, page_length=30):
    # 域自有数据集查询：复用 Frappe 权限钩，不用客户端首百条模拟搜索。
    raw = filters or {}
    allowed = {'q', 'scope', 'kind', 'order', 'file_name', 'directory', 'directory_id', 'tags', 'status', 'related_object', 'related_record',
               # **归属层级**（2026-10-28 · PKG-132 · R11）：目录页的归属筛选
               # **在服务端做** ⇒ 分页与总数随之正确（以前是前端筛，只对「手头那批」成立）。
               'attribution_level',
               # C10 两个系统字段筛选（字段字典#file-mail-system-fields）。
               # **在服务端筛** —— 契约原话：「字段是判断依据，不是只在浏览器隐藏其他文件」。
               'owner_subject_kind', 'owner_subject', 'related_mail',
               # **血缘**：按原包摘要筛（包件交接第 1 步）。
               'container_sha256',
               # **附件绑定**（PKG-047-T01）：按「挂在谁下面」「哪一种关系」筛。
               'attachment_of', 'attachment_relation'}
    if not isinstance(raw, dict) or set(raw) - allowed or any(not isinstance(v, str) or len(v) > 200 for v in raw.values()):
        frappe.throw('文件筛选参数无效', frappe.ValidationError)
    scope = raw.get('scope', '')
    if scope not in ('', 'all', 'mine', 'trash', 'review', 'reviewed', 'sheet', 'attachable') or raw.get('order', 'desc') not in ('asc', 'desc') or raw.get('kind', '') not in ('', *FILE_KINDS, '其他'):
        frappe.throw('文件范围或排序无效', frappe.ValidationError)
    conditions = [[key, '=', raw[key]] for key in ('file_name', 'directory', 'directory_id', 'status',
                                                   'owner_subject_kind', 'related_mail',
                                                   'container_sha256',
                                                   # **附件绑定**（PKG-047-T01）
                                                   'attachment_of', 'attachment_relation') if raw.get(key)]
    # **「所有人」两种写法互认**（C 16 收口实测的三方差）：schema 声明「所有人ID（员工ID）」、
    # 筛选下拉给 `identity_id`，而**受管收信路径实际写的是登录名**（`files.import_attachment`
    # 的 mail_system 字段）—— 存量行写登录名，纯等值筛选下**按员工ID筛必然 0 条**。
    # 这里是**读侧别名解析**：不改存储、不改授权判定、不碰已注册动作的 schema。
    if raw.get('owner_subject'):
        conditions.append(['owner_subject', 'in',
                           _owner_subject_aliases(raw['owner_subject'], raw.get('owner_subject_kind'))])
    # Excel 资源分类：普通文件列表/搜索/计数一致排除 xlsx（不只前端隐藏），附件引用和旧链接不受影响。
    # Excel 工作面取数用 scope=sheet（仅 xlsx、在库）；其他文件格式行为不变。
    from shangshu_core.public_api import list_object_companion_files
    companion_files = list_object_companion_files()
    if companion_files:
        conditions.append(['name', 'not in', companion_files])
    # **归属层级筛选**（服务端）：先按层级把资源编号圈出来，再当条件用。
    # ⚠️ 归属在**权威表**里（`Shangshu Org Attribution`），不在文件记录上 ⇒ 这一步是必要的。
    attribution_level = str(raw.get('attribution_level') or '').strip()
    if attribution_level:
        if attribution_level not in ('personal', 'department', 'enterprise'):
            frappe.throw('归属层级筛选无效', frappe.ValidationError)
        from shangshu_core.public_api import organization as org_admin
        scoped = org_admin.resources_by_level(attribution_level)
        if not scoped:
            frappe.throw('该归属层级下没有可列的文件', frappe.ValidationError)
        conditions.append(['name', 'in', scoped])
    if scope == 'sheet':
        conditions.append(['file_kind', '=', '表格'])
        conditions.append(['file_name', 'like', '%.xlsx'])
        conditions.append(['status', '=', 'Active'])
    elif scope == 'attachable':
        # **统一可作附件的文件范围**（MAIL-NEXT-02 / FIX-16）：
        # 用户明确「Excel 是文件的一个分支」——附件选择要**一份列表**，
        # 普通文件与 Excel 表格一起列，不再要求在「普通文件 / Excel」之间切换。
        # 这里**只做范围口径**，不复制两套文件记录：同一条 files.file 记录。
        # 「在库」由下面统一的 status 条件兜住（任何 scope 都只列 Active，回收站另算）。
        # ⚠️ 不在这里做「能不能作附件」的判定 —— 那是逐文件的读/导出口径，
        #    由 files.versions 与 files.sheet_snapshot 各自判权并回报（403 给中文原因）。
        pass
    else:
        # FIX-44（用户 2026-10-20 12:57「文件中心也列表格」）：
        # 改之前「普通文件列表/搜索/计数」**排除 .xlsx**（只有 Excel 工作面 `scope='sheet'` 列表格）。
        # 实况：库里 Active 的 16 个文件**全是 .xlsx** ⇒ **文件中心这一页在真实数据下永远是空的**，
        # 用户上传一张表格后回列表**看不到它** —— 像「上传没生效」。
        # ⚠️ 原来的顾虑（F04 反例 `afc69nlvm6`）是「**两处都查不到、却还读得到**」
        # （在库没有、回收站也没有）—— 那时表格在回收站被排掉造成的。
        # 现在**在库也列** ⇒ 变成「**两处都查得到**」，
        # 与 G1 数据可见性线（**查到的地方要一致**）方向一致，不再有「查不到却读得到」的问题。
        # 回收站一直就列表格（这里不排）；`scope='sheet'`（Excel 工作面）**只列 .xlsx**，互不干扰。
        pass
    if 'related_object' in raw or 'related_record' in raw:
        if not raw.get('related_object') or not raw.get('related_record'):
            frappe.throw('请选择完整的关联记录', frappe.ValidationError)
        from shangshu_core.public_api import get_object_record
        get_object_record(raw['related_object'], raw['related_record'])
        # 只检索本域的关联键；正式结果与计数仍由下方 get_list 应用文件ACL。
        # JSON结构匹配不依赖Frappe保存时的缩进、键序或名称中的通配符。
        reference = json.dumps({'object_id': raw['related_object'], 'name': raw['related_record']})
        names = frappe.db.sql('SELECT name FROM `tabShangshu File Center File` '
                              'WHERE JSON_CONTAINS(relations_json, %s)', (reference,), pluck=True)
        conditions.append(['name', 'in', names or ['']])
    if scope:
        conditions.append(['status', '=', 'Recycled' if scope == 'trash' else 'Active'])
    if scope == 'mine':
        conditions.append(['owner', '=', frappe.session.user])
    if scope in ('review', 'reviewed'):
        conditions.append(['review_status', '=', 'Pending' if scope == 'review' else 'Reviewed'])
    if raw.get('kind'):
        conditions.append(['file_kind', '=', raw['kind']])
    def contains(value):
        # 与 Frappe 文本筛选一致：参数化 LIKE，% / _ 为通配符；不拼 SQL。
        return '%' + value + '%'
    if raw.get('tags'):
        conditions.append(['tags_json', 'like', contains(raw['tags'])])
    matches = [[key, 'like', contains(raw['q'])] for key in ('file_name', 'tags_json')] if raw.get('q') else []
    length, current_page = min(max(int(page_length), 1), 100), max(int(page), 1)
    # 归属和能力是后文生成的投影，不能当作物理列 SELECT。
    fields = [key for key, *_ in OBJECT_FIELDS if key not in DERIVED_OBJECT_FIELDS] + ['tags_json']
    doctype = 'Shangshu File Center File'
    rows = business_get_list(doctype, fields=fields, filters=conditions, or_filters=matches,
                           order_by='modified ' + raw.get('order', 'desc') + ', name asc',
                           limit_start=(current_page - 1) * length, limit_page_length=length)
    total = business_get_list(doctype, fields=['count(name) as count'], filters=conditions, or_filters=matches)[0]['count']
    # D-11：权限摘要要「字段那一路」，需要晋升定义。**一次批量取 meta**，
    # 不逐表 `get_doc`（执行计划：「目录批量取元数据，不逐表打开整个工作簿或全量扫描记录」）。
    meta_by_name = {}
    if rows:
        for m in business_get_list(doctype, fields=['name', 'sheet_meta_json'],
                                 filters=[['name', 'in', [r['name'] for r in rows]]],
                                 limit_page_length=len(rows)):
            meta_by_name[m.get('name')] = m.get('sheet_meta_json')
    # ⚠️ **正式定义优先**（用户 2026-10-26 23:0x 决定二）：受管对象的 compiled 定义才是权威，
    # 文件侧那份只当输入。**一次批量取**（不逐表查）—— 取不到的**回落文件侧**（不静默收紧）。
    _authoritative = {}
    if rows:
        from shangshu_files import promotion as _promotion_mod
        _object_ids = []
        for _raw in meta_by_name.values():
            try:
                _meta = json.loads(_raw) if isinstance(_raw, str) else (_raw or {})
            except (TypeError, ValueError):
                continue
            _oid = ((_meta.get('promotion_binding') or {}).get('object_id')) or None
            if _oid:
                _object_ids.append(_oid)
        _authoritative = _promotion_mod.authoritative_definitions(_object_ids)
    # ⚠️ **主体判定的组织事实算一次就够**（PKG-117-T01）——
    # `org_context` 每次现取（撤权/调岗要立刻生效），**但同一批列表里是同一个人**
    # ⇒ **每行重算就是白查库**（一页 100 行 ⇒ 200 次多余查询）。
    _subject_ctx = None
    if rows:
        from shangshu_files import access_scope
        _subject_ctx = access_scope.context()
    for row in rows:
        # A 契约 §7.1.4：清单行直接带归属与操作能力（归属列/权限列/按钮显隐）
        detail = file_detail(row)
        row['can_edit'] = detail['can_edit']
        row['can_download'] = detail['can_download']
        row['can_share'] = detail['can_share']
        row['can_assign'] = detail['can_assign']
        row['can_structure'] = detail['can_structure']
        row['attribution'] = detail['attribution']
        # D-11 目录三列：归属（给人看的一句话）+ 权限摘要（三态，非布尔）
        row['attribution_label'] = _attribution_label(detail['attribution'])
        # **写入路径要的那一对值**（2026-10-21）：读方一次读到，不许再猜 `version_count`。
        row['upload_version'] = detail['upload_version']
        row['content_revision'] = detail['content_revision']
        # 工作副本看**表元信息**（批量取回的那份）：`file_detail` 拿到的行里没有这一列。
        row['working_copy'] = bool(json.loads(meta_by_name.get(row['name']) or '{}').get('working_file_id'))
        definition = _definition_from_meta(meta_by_name.get(row['name']))
        # ⚠️ **正式定义优先**（决定二）：这一行绑的受管对象有正式定义 ⇒ 用它
        # （列清单 ＋ 表级 access 一起换）；没有 ⇒ 沿用文件侧那份（输入）。
        _oid = (definition or {}).get('object_id')
        # 仅目录展示兼容：保留缺失模型的条目，并明确其权威定义不可用。
        # 旧列名/展示摘要不构成受管写入或正式值规则依据；运行读写仍经绑定/内核严格闸。
        row['definition_authority'] = ('available' if _authoritative.get(_oid) else 'unavailable') if _oid else 'unmanaged'
        row['definition_authority_reason'] = '权威定义不可用，当前仅显示原有表格信息' if _oid and not _authoritative.get(_oid) else ''
        if _oid and _authoritative.get(_oid):
            definition = dict(definition)
            definition.update(_authoritative[_oid])
        row['capability'] = _capability_summary(row, detail, definition, ctx=_subject_ctx)
        # ---------- E01.5 / UI-002：目录三列的「权限」列 ----------
        # 契约（已与 A 定稿）：**五键**，不是一个 `can_edit` 布尔 ——
        # 「**不能只增加 `can_edit` 布尔值就声称字段鉴权完成**」。
        # **服务端算、前端不推导**（产品边界 #4「不在浏览器推导权限」）。
        #
        # · `read`     能看条目 —— 行在列表里就说明查询已按 ACL 过滤过（含来源那一路）
        # · `preview`  能看内容 —— `org_admin.preview_allows`（跟「读」走，**不跟下载走**；
        #              BASE967-22 的病根就是错用下载权判预览）
        # · `download` 能拿原件 —— `file_detail` 已按「导出权 AND 来源内容读权」算好
        # · `write`    能改 —— `can_edit`
        # · `review`   指定审核人资格 —— ⚠️ **审核人模型不存在**（全仓只有 `review_status`，
        #              没有「指定审核人」字段，E01.4 的缺口）。**fail-closed 回 False**
        #              —— 没有人是指定审核人 = 没人收得到候选。**不是假默认值**，
        #              是「今天确实没人有这个资格」。
        # · `structure` 改结构（加行/加列/改名/删列……）——
        #              ⚠️ **用户 2026-10-17 校正：「结构权不是一个独立的结构，它属于权限的一部分」**
        #              且「表主对自己建的表**当然有**」。
        #              ⚠️ **`file_detail.can_structure` 现在对表主是 `False`** ——
        #              `domain.py:801` 是 `structure_ok = manager or 'Sheet Structure Editor'
        #              in frappe.get_roles()`，**owner 没进这个式子**（B 2026-10-17 实测：
        #              boss 账号拥有 3 张 xlsx，`can_edit=True` 但 `can_structure=False`）。
        #              **所以不能直接复用那个值** —— 直接复用就把用户要的「表主有」判成没有。
        #              **本处按用户口径算：表主 OR 原角色闸**。
        #              **过渡实现**：等内核 `structure_allows(user, resource, attribution)`
        #              落地后换成调它（语义已与 B 对好：owner→True / SM或角色→True /
        #              无归属→None / 其余→False）。**两位并存不矛盾** ——
        #              这里给的是**权限维度的结论**，动作侧的角色闸仍在。
        _user = frappe.session.user
        from shangshu_core import org_admin as _org_admin
        _pv_raw = _org_admin.preview_allows(_user, row['name'], attribution=detail['attribution'])
        # **结构权走内核权威判定**（B 2026-10-17 动作侧已接 `82e4ebd0`，过渡实现换成这个）。
        # `structure_allows` 回 True / False / **None** —— `None` 的含义是
        # 「归属那半判不了」，**动作侧回落 SM 或 `Sheet Structure Editor`**（B 的定法），
        # 这里**投影侧回落同一套**，两边才对得上（否则「看得见能改」和「点了能改」不一致）。
        _st_raw = _org_admin.structure_allows(_user, row['name'], attribution=detail['attribution'])
        if _st_raw is None:
            _roles = set(frappe.get_roles(_user))
            _st_raw = ('System Manager' in _roles) or ('Sheet Structure Editor' in _roles)
        row['my_access'] = {
            'read': True,
            # `None` = 无归属（走旧目录授权）→ 能看见条目就能看内容
            'preview': True if _pv_raw is None else bool(_pv_raw),
            'download': bool(detail.get('can_download')),
            'write': bool(detail.get('can_edit')),
            'review': False,
            'structure': bool(_st_raw),
            # ---------- **降维（用户 2026-10-27 06:2x 口径）** ----------
            # 权限只有**三个操作**：读（筛）／写／下载 ⇒
            # 「可筛」「可给助手」这两个维度**不再存在**（筛并进了「读」；
            # 助手跟着账号走，账号能读它就能读）。
            # ⇒ 这里**不再**多投影一维「filter」：**能读就能筛**。
            # **判法**：读／写／下载沿用既有投影（按**表级主体范围**判）；
            # **没定义过晋升的表没有列级限制 ⇒ 跟「读」走**（True）。
        }
        # ---------- 三个时间字段（契约已与 A 定稿：都要）----------
        # · `content_modified`  值最后改的时间 —— = 记录 `modified`
        # · `structure_modified` 表结构最后改的时间 —— **没有单独的时间戳**
        #   （`sheet_meta_json` 只有 `structure_version` 版本号，不记时间）。
        #   **如实回 `None`，不编**（口径「目录三列展示资源事实，**不填假默认值**」）。
        # · `modified` = 两者较晚者 —— 结构时间为空时即内容时间（服务端算好，前端不推导）
        row['content_modified'] = row.get('modified')
        row['structure_modified'] = None
        row['modified'] = row.get('modified')
        # ---------- G0 资源事实（0.4 特派）：`ownership` / `updated_at` ----------
        # **操作权限**在 `my_access`（六维），**资源事实**在行上，**分开返回**
        # （G0 原文「区分操作权限…与资源归属 ownership/更新时间 updated_at。沿已有契约
        # 决定嵌套或分开返回」）。**语义只定义一份**：
        #   · `ownership`  ≡ `attribution`（同一份归属投影，dict {level,department,owner_user}）
        #     —— `attribution` 是旧名，兼容期保留，消费方迁完只留 `ownership`（见契约文档）
        #   · `updated_at` ≡ `modified`（同一个「最后更新」时刻）
        # **不为 records 数据集再写一套语义** —— 那侧要对齐时消费本投影（跨域交接项）。
        row['ownership'] = row['attribution']
        row['updated_at'] = row.get('modified')
        row['restore_relations'] = 1
        row['tags'] = '；'.join(_load_tags(row.get('tags_json')))
        row.pop('tags_json', None)
    return {'object_id': dataset_id, 'domain_id': DOMAIN, 'rows': rows, 'total': total,
            'page': current_page, 'page_length': length}


def _load_tags(raw):
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
        return [str(item) for item in value][:10] if isinstance(value, list) else []
    except Exception:
        return []


def versions(_service, payload, _context):
    """文件版本历史：读取挂在文件记录上的各版本（含旧版本），供详情与回退展示。"""
    if not isinstance(payload, dict) or len(payload) != 1 or not set(payload) <= {'file', 'attachment'} \
            or any(not isinstance(value, str) or not 0 < len(value) <= 140 for value in payload.values()):
        frappe.throw('file 与 attachment 必须且只能指定一个有效编号', frappe.ValidationError)
    attachment = payload.get('attachment')
    file_name = payload.get('file')
    if attachment:
        file_name = frappe.db.get_value('Shangshu File Center Version', {'frappe_file': attachment}, 'file')
        if not file_name:
            # Current working files deliberately have no per-edit history row.
            file_name = frappe.db.get_value('Shangshu File Center File', {'current_file': attachment}, 'name')
        if not file_name:
            frappe.throw('附件不存在或不属于文件中心', frappe.PermissionError)
    if not frappe.db.exists('Shangshu File Center File', file_name):
        frappe.throw('文件不存在', frappe.DoesNotExistError)
    doc = frappe.get_doc('Shangshu File Center File', file_name)
    doc.check_permission('read')
    # **导出闸（文件域这半）**：有待恢复的回填就**不交出下载 ref** ——
    # 契约 `开发计划.md:191`「旧文件不能假装最新下载」/ `执行计划.md:283`「不导出旧文件」。
    #
    # **为什么装在这儿**：文件域里「交出文件字节」的入口就是本口（`source.file` 就是
    # 下载 ref）。装在这里 = 拿不到 ref = 导不出。
    #
    # ⚠️ **两点如实说，不糊**：
    #   1. **看版本历史也被一起挡了** —— 列表和下载 ref 目前同一个口。「待恢复时还能看历史」
    #      这半个需求**登记待议**，等内核钩子落地后把「列」和「拿」分开。
    #   2. **裸 `file-content` URL 绕过本闸** —— 那道闸在内核（`file_content` 只查权限+挂载，
    #      不知内容新旧），按分工交 B 补钩子。**已知缺口，按挡验收准备**（RT-④③ ⑧）。
    from shangshu_files import promotion as _promo
    _promo.require_no_pending_writeback(doc)
    version_filters = {'file': file_name}
    if attachment:
        if doc.status != 'Active':
            frappe.throw('回收站文件不能作为附件使用', frappe.PermissionError)
        from shangshu_core.public_api import get_record_attachments
        get_record_attachments(doc.doctype, doc.name, [attachment])
        version_filters['frappe_file'] = attachment
    rows = frappe.get_all('Shangshu File Center Version', filters=version_filters,
                          fields=['version_no', 'size', 'sha256', 'note', 'uploaded_by', 'uploaded_at', 'frappe_file'],
                          order_by='version_no desc', limit_page_length=100)
    for row in rows:
        row['source'] = {'ref_doctype': 'Shangshu File Center File', 'ref_name': file_name, 'file': row['frappe_file']}
    current = None
    if not attachment or attachment == doc.current_file:
        current = {'frappe_file': doc.current_file, 'content_revision': content_revision(doc),
                   'sha256': doc.current_sha256, 'size': doc.current_size,
                   'mutable': bool(json.loads(doc.sheet_meta_json or '{}').get('working_file_id')),
                   'source': {'ref_doctype': doc.doctype, 'ref_name': doc.name, 'file': doc.current_file}}
    from shangshu_files.table_relations import definitions
    return {'versions': rows, 'current': current, 'file': {**file_detail(doc), 'has_table_relations':bool(definitions(doc.name))}}


def _definition_from_meta(raw):
    """从批量取回的 `sheet_meta_json` 提晋升定义。**只解析，不重复口径**。

    ⚠️ **口径以 `promotion.load_definition` 为准**（那是唯一读定义的家）。
    这里不加工 `columns` —— 已核过 `load_definition` 对它就是
    `list(raw.get('columns') or [])`，零加工，取的是同一个东西。

    **回值区分两件事**（别混，混了 `fields_known` 就错了）：
      · `None` = **没取到 meta**（批量取漏了）→ 调用方当「字段级未知」，
        **不宣称「部分可编辑」**
      · `{'columns': [...], 'access': ...}` = 取到了（`columns` 可能是空的 = 这表没定义过晋升；
        `access` 是**表级主体范围**，没定义过就是 `None`）
        → 调用方当「已确认」
    """
    if raw is None:
        return None
    try:
        meta = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return None
    if not isinstance(meta, dict):
        return None
    promo = meta.get('promotion')
    cols = list(promo.get('columns') or []) if isinstance(promo, dict) else []
    # **表级主体范围也一起取**（PKG-117-T01）—— 判定要靠它。
    table_access = promo.get('access') if isinstance(promo, dict) else None
    # ⚠️ **文件侧那份只当输入**（决定二）：这里只取「这张文件是哪个受管对象」这一件事，
    # **判定**由调用方换成**受管对象的正式定义**（compiled）。
    object_id = ((meta.get('promotion_binding') or {}).get('object_id')) or None
    return {'columns': cols, 'access': table_access, 'object_id': object_id}


def _scope_allows(definition, operation, user):
    """表级主体范围里，**这个操作**这个人有没有资格。

    · **没定义过晋升的表**（没有表级声明）⇒ 没有列级限制 ⇒ **跟「读」走**（True）；
    · 有表级声明 ⇒ 按**表级**声明判（继承链本体在内核，域**不自己写一套**）。

    ⚠️ **这里读到的 `definition['access']` 已是「生效的那份」** ——
    调用方在列表那条路上**先换成受管对象的正式定义**（决定二），再传进来。
    """
    from shangshu_files import access_scope
    return bool(access_scope.table_allows((definition or {}).get('access'),
                                          operation, user=user))


def _attribution_label(att):
    """归属 → 给列表看的一句话（D-11）。**无归属要明说**，这是 B 2026-10-15 的口径。

    ⚠️ **不许写「未知归属」** —— 那会被读成权限问题。`None` 的真实含义是
    「**无归属 = 存量/普通文件走旧目录授权（B6 兼容）**」，是「按老规矩走」，
    不是「没权限」、也不是「查不到」。

    ⚠️ **`level` 只可能是 `personal` / `department`**（用户 2026-10-15
    「尚书是单例，没有企业归属」—— 内核 `attribution_level()` 已收紧）。
    这里**不翻译 `enterprise`**：真出现了就是上游没拦住，**如实标出来**比糊过去强。
    """
    if not att:
        return '无归属（按旧目录授权）'
    level = str(att.get('level') or '')
    if level == 'personal':
        return '个人（%s）' % (att.get('owner_user') or '—')
    if level == 'department':
        return '部门（%s）' % (att.get('department_title') or att.get('department') or '—')
    return '%s（%s）' % (level or '未知', att.get('owner_user') or att.get('department') or '—')


def _capability_summary(doc, detail, definition=None, ctx=None):
    """行级权限摘要（D-11）：**三态** + 局部读取范围。**不是单个 `can_edit` 布尔**。

    执行计划原话：「权限摘要反映**只读/部分可编辑/可编辑**及必要的局部读取范围；
    **返回布尔字段不等于已经实现逐字段鉴权**。」

    **三路合起来才叫「有效权限」**（B 2026-10-15 提醒的要害）：
      · **字段能力** —— 复用内核的**主体范围**判定（`field_subject_allows`），
        **不写第二套判定**（写了就是两套判定源，撤权时一边新一边旧）
      · **资源级归属** —— `file_detail` 已算好（`write_allows`/`download_allows` + 无归属回落）
      · **行范围** —— 文件列表的行可见性已由 `frappe.get_list` 的 ACL 覆盖
    ⚠️ **只用字段那一路就会假绿** —— 撤了行范围/归属之后摘要还是「可编辑」，
    而实际动作已经拒了。所以 `access` 这一档**以资源级结论为门槛**。

    **三态怎么推**（B 建议，已认）：
      · **只读** = 资源级不能改，或**无一列**可写
      · **可编辑** = 资源级能改 且 **所有字段列**都可写
      · **部分可编辑** = 中间态 —— 这时 `editable_fields` 才有意义（说清**哪几列**能改，
        不是「大部分能改」这种糊话）

    ⚠️ **`definition` 不给时只给资源级两态** —— 没取到字段信息就**不宣称「部分可编辑」**，
    那是瞎说。列表场景由调用方**一次批量取 meta** 后传进来（不逐表 `get_doc`）。
    """
    # --- 字段那一路（复用内核判定，只做合成）---
    from shangshu_files import access_scope
    cols = (definition or {}).get('columns') or []
    # 只有**字段列**（真的绑定数据库字段）才进逐列判定；普通列不进
    # （用户 2026-10-15：普通列「不是有意义的字段，只在 xlsx 上体现」）。
    field_cols = [c for c in cols if isinstance(c, dict) and c.get('promoted') and c.get('field')]
    # ⚠️ **判定取的是 `field.get("id")`**，而晋升定义里的列键叫 **`field`**
    # （`{'header','promoted','field','type','rules','access'}`）。**键名对不上 → `fid=None` →
    # 取不到 → `editable_fields=[]` → 摘要错判「只读」**（D-11 ⑤ 实测：摘要说只读、实改 200）。
    # 这里**补 `id` 键**喂给内核判定，不改内核、不重写判定。
    # ⚠️ **PKG-117-T01**：判据从旧的角色键（`field_access.field_capabilities`）换成
    # **主体范围**（`field_subject_allows`）—— 受管表链上已没有角色键了，
    # 旧判定会走「未声明 = 不限」⇒ **fail-open**（闸形同虚设）。
    per_field = (access_scope.capabilities([{**c, 'id': c.get('field')} for c in field_cols],
                                           table_access=(definition or {}).get('access'),
                                           ctx=ctx)
                 if field_cols else {})

    readable = [c.get('header') for c in field_cols if (per_field.get(c.get('field')) or {}).get('read')]
    writable_fields = [c.get('header') for c in field_cols if (per_field.get(c.get('field')) or {}).get('write')]
    downloadable = [c.get('header') for c in field_cols if (per_field.get(c.get('field')) or {}).get('download')]

    # --- 资源级那一路（复用 file_detail 已算好的结论，不重算）---
    can_edit = bool(detail.get('can_edit'))
    can_download = bool(detail.get('can_download'))

    # --- 合成三态（资源级是门槛）---
    # ⚠️ **「这张表没有字段列」和「没取到定义」不是一回事** ——
    # 前者是确认过的事实（全普通列，能改的都能改），后者是**不知道**。
    # 混了就会在没取到定义时瞎说「可编辑」。所以 `fields_known` 单列出来。
    fields_known = definition is not None
    if not can_edit:
        access = '只读'
    elif not fields_known:
        # 资源级能改，但字段级没核 —— **不宣称「部分可编辑」**，那是瞎说。
        access = '可编辑'
    elif not field_cols:
        access = '可编辑'          # 确认过定义：这张表没有字段列
    elif len(writable_fields) == len(field_cols):
        access = '可编辑'
    elif writable_fields:
        access = '部分可编辑'
    else:
        access = '只读'            # 资源级能改，但一个字段列都不许写

    return {
        'access': access,
        'fields_known': fields_known,
        # ⚠️ **`None` = 没算；`[]` = 算了、一列都不许改。两个含义不同，别混。**
        'editable_fields': writable_fields if fields_known else None,
        'readable_fields': readable if fields_known else None,
        'downloadable_fields': downloadable if fields_known else None,
        # 保留布尔给**按钮显隐**用（合理用途）—— 但**权限摘要以 `access` 为准**，
        # 别把这四个当成「已经实现了逐字段鉴权」的证明。
        'can_edit': can_edit,
        'can_download': can_download,
    }


def file_detail(doc):
    """已授权调用者的详情投影；不暴露路径密钥或私有存储地址。

    顺带给出 A 契约要的归属与操作能力（可选归属/操作能力/授权设置判据）：
    can_edit=改值；can_download=导出（管理读不带下载）；can_share=可转授权（仅归属人）；
    can_structure=改结构（改值之上另要结构角色）。归属资源走组织判定，无归属保持旧口径。
    """
    # 合并说明：fast 那边改走公共面 `shangshu_core.public_api.organization`（域不摸私有模块），
    # 本分支直接 `from shangshu_core import org_admin`。
    # ⚠️ 公共面**没有导出 `assign_allows`**（本函数下面要用），所以这里仍取私有模块；
    # 两者导出的那几个函数（resource_attribution / write_allows / download_allows /
    # department_title）是**同一个函数**（公共面只是 re-export），语义一致。
    from shangshu_core import org_admin
    from shangshu_files.service import _source_read_allows, upload_version
    user = frappe.session.user
    manager = 'System Manager' in frappe.get_roles()
    att = org_admin.resource_attribution(doc.name)
    # **收信附件（有来源）的下载**（BASE967-38 / E01.1）：
    # 口径 `账号与权限.md:100`「导出的硬条件」—— 必须**同时**具备导出权
    # **和**本次导出全部实际内容的读取权。所以：
    #   **下载 = 归属下载资格 AND 来源当前读权**
    # 只有部门下载资格、没有来源读权 → **拒**（「部门内默认下载资格不豁免字段读权」
    # 同族：默认资格 ≠ 实际权限）。
    src = _source_read_allows(user, doc)
    if att:
        writable = bool(org_admin.write_allows(user, doc.name, att))
        can_share = (att.owner_user or '').lower() == user.lower()
        can_download = bool(org_admin.download_allows(user, doc.name, att))
        if src is not None:
            can_download = bool(can_download) and bool(src)
        attribution = {'level': att.level, 'department': att.department,
                       'department_title': org_admin.department_title(att.department),
                       'owner_user': att.owner_user}
    else:
        writable = manager or doc.owner == user
        can_share = writable
        can_download = True  # 无归属存量口径：可读即可下载
        attribution = None
    trial = business_access.resource_decision(doc.name, user, owner=doc.owner)
    if trial is not None:
        writable = can_share = can_download = trial
    # 合并说明：fast 那边是 `structure_ok = writable`（能改值就能改结构）；
    # 本分支按 2026-10-17 的定法走**动作侧同一道**（表主对自建表当然有结构权）——
    # 两边不冲突：返回值最后仍与 `writable` 取与（见下面的 can_structure）。
    # **结构权跟动作侧同一道**（`sheet._require_structure`，B 2026-10-17 的定法）。
    #
    # 老式子是 `structure_ok = manager or 'Sheet Structure Editor' in roles` ——
    # **表主不在里面**，而且最后还乘了 `writable`。后果是「投影说不能改结构，
    # 点了却真能改」（B 在 3820 实测 boss 拥有 3 张 xlsx、`can_edit=True` 但
    # `can_structure=False`）。用户 2026-10-17 校正：「**表主对自己建的表当然有**」。
    #
    # 这里**原样复用动作侧的判法与回落**（含 `None` 时把表主也算进旧口径），
    # 不再另写一套 —— 两条口必须同源，否则按钮显隐与点击结果打架。
    from shangshu_core import org_admin as _oa_structure
    structure_ok = _oa_structure.structure_allows(
        frappe.session.user, doc.name, attribution=attribution)
    if structure_ok is None:
        structure_ok = (doc.owner == frappe.session.user
                        or 'System Manager' in frappe.get_roles()
                        or 'Sheet Structure Editor' in frappe.get_roles())
    # **导出硬条件也要进 `can_download`**（计划 §五 E01.3 / 口径 `:100`）：
    # 「**任一内容无读权时拒绝完整 A 下载**，**不能先下发整份文件再由前端遮挡**」
    # + `:122`「**不能由可见按钮直接推导可批量导出**」。
    #
    # ⚠️ 不做这一步的话，**按钮会显示、点了才被内容闸拒** ——
    # 「可见按钮」和「真能不能导」对不上，正是 `:122` 禁止的那件事。
    # 所以 `can_download` 必须**跟下载闸同一口径**：字段那道不过，这里就是 False。
    if can_download:
        try:
            from shangshu_files.promotion import _require_all_columns_exportable
            _require_all_columns_exportable(doc)
        except frappe.PermissionError:
            can_download = False
    return {**{key: doc.get(key) for key in ('name', 'file_name', 'directory', 'directory_id', 'note', 'owner', 'status', 'current_size',
                                             # C10 系统字段也进详情 —— A 做「详情来源/跳转」要用
                                             'owner_subject_kind', 'owner_subject', 'related_mail')},
            'tags': _load_tags(doc.tags_json), 'modified': str(doc.modified),
            # **写入路径要的那一对值**（2026-10-21）：一次读到，不许再猜 `version_count` 的含义。
            # · `upload_version`   ＝ 当前上传版本号（＝ `version_count` − 1）→ `expected_version`
            # · `content_revision` ＝ 当前内容修订号（内容真变没变的凭据）→ `expected_content_revision`
            # · `working_copy`     ＝ 有没有工作副本（页面里改过）→ 活内容是哪一份
            'upload_version': upload_version(doc),
            'content_revision': content_revision(doc),
            'working_copy': has_working_copy(doc),
            'can_edit': writable and doc.status == 'Active', 'can_restore': writable and doc.status == 'Recycled',
            'can_download': bool(can_download) and doc.status == 'Active',
            'can_share': bool(can_share) and doc.status == 'Active',
            'can_structure': bool(structure_ok and writable and doc.status == 'Active'),
            'can_assign': bool(doc.status == 'Active' and org_admin.assign_allows(user,doc.name,att)),
            'attribution': attribution,
            'metadata_revision': True,
            'content_edit_revision': 1,
            'workbook_edit_revision': 1,
            'document_edit_revision': 1,
            'restore_relations': 1,
            'version': content_revision(doc),
            'review_pending': int(doc.reviewed_version or 0) < content_revision(doc)}
