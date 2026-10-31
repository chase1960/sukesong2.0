"""公共混合表夹具：`seed_mixed_table` 造 / `seed_cleanup` 清 / 清完**回读确认**。

**给谁用**：所有要测「混合表」（既有晋升列、又有普通列）的用例。**不是给某一次用完就扔**
（E 2026-10-15 派活原话）。今天三个窗口都撞上「测试把环境搞脏了」（B6 归属残留、
A 测试列覆盖原列名、C 造一万封信）—— **C 是唯一收干净的**，因为它有 `seed_cleanup`。
本模块照那个形状：**造 + 清 + 回读确认**。

---
**边界（照守，一条不放宽）**

- **不动 `hkt3bcago8`** —— 那张表上有历史证据（RT 组 25 条、004C 前几轮），
  改库就说不清什么时间发生什么了。夹具**只造自己的一次性表**。
- **不直接改数据库** —— 全走产品自己的动作口。绕过产品能力，将来产品一改就废。
- **不假设列永远在** —— 产品现在**没有删列能力**（全仓无 `column_delete`），
  「清干净」对**列**是做不到的。所以夹具不往共享表上加列。

---
⚠️ **回执只写到「产品做得到的那一步」，不许写「清空了」**

**产品没有硬删口**（2026-10-15 查过：动作面只有 `files.recycle` / `files.restore`，
`files.delete` / 归档 / 停用都不存在）。`files.recycle` 是把 `status` 改成 `'Recycled'`
—— **进回收站，本人仍可见**（`test_pkg008_structure_tools` P8-④ ② 钉着这个既定语义）。

所以 `seed_cleanup` 的回执写「活跃列表里没了、回收站里还留着」，**不写「删了/清空了」**。
E 2026-10-15：「**不许写一个「清空了」但其实只是看不见**。回执要让人一眼看懂**到底做到了哪一步**。」

---
**为什么用 `files.upload` 而不是 `files.create`**（E 原话点的是 `files.create`，这里是偏差，说明理由）

`files.create` 造的是**空簿**（`_empty_workbook_bytes`：单工作表、无数据行、无表头）。
要出「项目名称/金额/备注」得再走加列加行 —— 那是 8+ 次结构动作，而且**每次 `column_append`
都 bump 结构版本**，把夹具变成一堆结构工具的测试。夹具的活是「给一张干净的表」，
不该顺带测结构工具。上传一份**自己生成的**干净 xlsx 一步到位，同样是产品自己的口
（`files.upload`），同样不碰数据库。若口径要求必须 `files.create`，说一声，一行改。

---
用法：

    import _ss_seed
    h = _ss_seed.seed_mixed_table(admin, run='x1')          # 造
    try:
        ...                                                  # 测别的东西
    finally:
        receipt = _ss_seed.seed_cleanup(admin, h)            # 清 + 回读确认
        assert receipt['active_left'] == []                  # 真的不在活跃列表了

`promotion_define` 是 `System Manager` 的活，所以造表那步要么用管理员客户端，
要么把管理员传进 `promote_with`。归属默认落**调用者本人**（复用 `_ss_fixture` 那份，
**不造第二个默认**）。
"""
import base64
import importlib.util
import json
import os
import urllib.parse
from io import BytesIO

ROOT = os.environ.get('SS_ROOT',
                      '/path/to/workspace')
_spec = importlib.util.spec_from_file_location(
    't', ROOT + '/shangshu-server/scripts/test-n2-structure.py')
t = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(t)
# 归属默认值 —— **只此一份**，在 `_ss_fixture`（§13）。本模块不另造一个。
_spec_f = importlib.util.spec_from_file_location(
    '_ss_fixture', ROOT + '/shangshu-server/scripts/tests/_ss_fixture.py')
_ss_fixture = importlib.util.module_from_spec(_spec_f)
_spec_f.loader.exec_module(_ss_fixture)

# ---------- 一张标准混合表的形状（显式常量，不散落字面量）----------
# 两列**晋升**（绑数据库字段）+ 一列**普通**。这就是「混合」的意思。
#
# ⚠️ **PKG-117-T01**：受管列必须带**主体范围**（`access`：五个操作 × 全局/部门/个人）——
# 受管表链上**不再有角色键**（`read_roles`／`write_roles`／`download_roles`）。
# 这里用**全局**（全员可读可写）—— 与改造前「未声明 = 不限」的**效果**一致。
GLOBAL_ACCESS = {'read': {'scope': 'global'},
                 'write': {'scope': 'global'},
                 'download': {'scope': 'global'}}
#: **表级**主体范围（独立声明；不从各列推导）。
TABLE_ACCESS = dict(GLOBAL_ACCESS, record_scope='all')

MIXED_COLUMNS = [
    {'header': '项目名称', 'promoted': True, 'field': 'project_name', 'type': 'text',
     'access': dict(GLOBAL_ACCESS)},
    {'header': '金额', 'promoted': True, 'field': 'amount', 'type': 'number',
     'rules': {'min': 0}, 'access': dict(GLOBAL_ACCESS)},
    {'header': '备注', 'promoted': False},
]
MIXED_HEADERS = [c['header'] for c in MIXED_COLUMNS]

# 默认造几行数据行。**≥1** —— 空壳表测不了「改一格」。
DEFAULT_ROWS = [
    {'项目名称': '夹具甲', '金额': 10.5, '备注': 'A-1'},
    {'项目名称': '夹具乙', '金额': 20.0, '备注': 'B-1'},
]

# 回执里那句「到底做到了哪一步」—— **常量，不许各处自己编一句**。
CLEANUP_NOTE = ('产品**没有硬删口**（动作面只有 files.recycle / files.restore）：'
                '`files.recycle` 是把状态改成 Recycled = **进回收站、本人仍可见**。'
                '本回执只到这一步，**不是「删了」也不是「清空了」**。'
                '⚠️ **回收站里的表格列不出来**（`files.file` 的 `scope=trash` 排除 xlsx）—— '
                '所以「真进了回收站」是靠**写被拒**回读的，不是靠列表。'
                '（**受管对象/应用**那部分走**内核退役口**：下线 ＋ DROP 物理表 ＋ 删 DocType '
                '＋ 留退役记录 ⇒ 那部分是真收工，回执里单列 `retired_objects`/'
                '`retired_applications`。）')


# ---------- 小工具 ----------
def _result(st, body):
    """取业务结果体。**跟 `test_d_promotion_chain.result_of` 同一个形状**（§13 只留一份）。

    ⚠️ **服务口的回包不一定有 `result` 信封** —— 没有时**回整个 body**。
    第一版写成 `body.get('result') or {}`，`files.sheet_read` 的表头直接读成 `[]`，
    夹具当场报「表头对不上」。**信封有两种，取值要两种都认。**
    """
    b = body if isinstance(body, dict) else {}
    if st != 200:
        return {}
    r = b.get('result')
    return r if isinstance(r, dict) else b


def _err(body):
    return str((body or {}).get('error') or '') if isinstance(body, dict) else str(body)


def _dl_err(st, body):
    """**下载口**的拒因 —— 跟普通回包不一样，收口在这里（§13 只留一份）。

    ⚠️ `t.download` 对 `file-content` 这条路一律回 `{'_bytes': raw}`
    （`test-n2-structure` 的 `request` 特判）—— **失败时那串字节就是拒因正文**，
    `error` 字段是空的。用 `_err()` 读一律 `''`，「拒因说人话」会假红（栽过）。
    **回包形状分两种，取值要两种都认。**
    """
    if isinstance(body, dict):
        e = _err(body)
        if e:
            return e
        raw = body.get('_bytes')
        if raw and st != 200:
            return raw.decode('utf-8', 'replace') if isinstance(raw, bytes) else str(raw)
    return ''


def _got_bytes(st, body):
    """**拿到可用内容没** —— `st==200 且有字节`。回 `(拿到没, 字节)`。

    ⚠️ **只看字节在不在会误判**：417 时 `_bytes` 里装的是拒因正文（340 字节上下），
    `bool()` 照样真。第一版就这么把敏感度读成恒真、把 ⑧ 的详情写成
    「拿到内容=True，闸没挡住」—— **而那会儿闸明明挡住了**（HTTP 417）。
    **判据自己会撒谎，要专门防**：这里把「拿到内容」定义成「200 + 有字节」，
    两处共用，不许各写各的。
    """
    raw = (body or {}).get('_bytes') if isinstance(body, dict) else None
    return (st == 200 and bool(raw)), raw


def rejected(st, body):
    """**明确拒**没写进去 —— 回 `(拒了没, 说明)`。**公共件（§13 只留一份）**。

    **「明确拒」= 不是 200，或 200 但回执说没写进**（`applied`/`sheet_written`/`ok` 是假）。
    ⚠️ **只看 HTTP 不够**：今天 `promotion.cell_write` 失败时回 **200 + `applied: False`**
    （「如实说两半」），那是**明确拒**，不是成功。
    ⚠️ **跟 `rejected(res, word)` 不同语义** —— 那个判「拒因点名某词」（5 个文件各有一份，
    既有欠账，本轮不动）。本函数只判「写没写进去」。
    """
    if st != 200:
        return True, _err(body)
    res = _result(st, body) or {}
    said_no = (res.get('applied') is False) or (res.get('sheet_written') is False) \
        or (res.get('ok') is False)
    return said_no, (_err(body) or str(res.get('message') or '')[:120])


def locate_cell(client, table, needle):
    """全表找 `needle` 出现在哪些格。回 `[(row_id, header), ...]`。

    **公共件（§13 只留一份）** —— `test_fast_path_coords` / `test_fast_path_value_check`
    都要它。**一次能出多格**（写错坐标时可能同时留在两处）。

    ⚠️ **读口是 `files.row_read`，不是 `files.sheet_read`** ——
    后者的 `rows[].cells` **是空字典**（`{}`），值不在那儿。
    第一版用 `sheet_read` → 恒回 `[]` → 判据恒红，**红因是「读法错」不是「值没落盘」**，
    差点被误报成产品 bug。**取值按回包真实形状，别按名字想当然。**
    """
    rr = _result(*t.service(client, 'files.sheet_read', {'table': table}))
    rids = [x.get('row_id') for x in (rr.get('rows') or []) if x.get('row_id')]
    hits = []
    for rid in rids:
        cells = (_result(*t.service(client, 'files.row_read',
                                    {'table': table, 'row_id': rid})) or {}).get('cells') or {}
        for header, cell in cells.items():
            v = (cell or {}).get('value') if isinstance(cell, dict) else cell
            if str(v or '') == str(needle):
                hits.append((rid, header))
    return hits


def write_plain_cell(client, table, rid, header, value, key, warm=False):
    """写一格**普通列**。回 `(st, body)`。

    `warm=True` 先读表建**解析缓存** → 下一次写走**快路径**（`_fast_write_cells`）；
    `warm=False` 不预热 → 走**慢路径**。**快慢分流看解析缓存在不在**（B 的口径）。

    **版本闩走 `files.sheet_read`**（唯一来源）—— 不带会被 schema 拒，那是**错因通过**。
    """
    if warm:
        locate_cell(client, table, '预热')      # 建缓存，值不重要
    rr = _result(*t.service(client, 'files.sheet_read', {'table': table}))
    return t.action(client, 'files.cell_write', {
        'table': table, 'row_id': rid, 'header': header,
        'value': {'type': 'text', 'value': value},
        'expected_content_version': rr.get('content_version'),
        'expected_structure_version': rr.get('structure_version')}, key)


def _workbook_bytes(rows):
    """生成一份**干净**的混合表 xlsx —— 表头就是 `MIXED_HEADERS`，没被别的列污染。"""
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = '混合表'
    ws.append(MIXED_HEADERS)
    for r in rows:
        ws.append([r.get(h) for h in MIXED_HEADERS])
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def row_ids_of(sheet_read_result):
    """从 `files.sheet_read` 的回包里取**固定行 ID** 列表。

    ⚠️ **回包里没有 `row_ids` 这个键** —— 行在 `rows` 里，每行带 `row_id`。
    第一版写成 `result.get('row_ids')` → 一律 `[]`，判据「表里有数据行」跟着假红。
    **取键要按回包真实形状，不按名字想当然。**
    """
    rows = (sheet_read_result or {}).get('rows') or []
    return [r.get('row_id') for r in rows if isinstance(r, dict) and r.get('row_id')]


def names_in(client, scope, q=None):
    """读回**文件列表**里的名字（`scope=sheet` 活跃表 / `scope=trash` 回收站）。

    ⚠️ **`files.file` 数据集默认排除 xlsx**（`domain.query`：`file_name not like '%.xlsx'`）——
    所以查表格必须带 `scope=sheet`（还顺带锁 `status=Active` + `file_kind=表格`）。
    查回收站用 `scope=trash`。**不带 scope 直接查是查不到表的**，会误判成「清干净了」。

    公共件（§13）：`test_r3_create.py` 里那份 `catalog_contains` 是同一条查询的重复，
    待折叠到本函数（不在本轮做）。
    """
    filters = {'scope': scope}
    if q:
        filters['q'] = q
    enc = urllib.parse.quote(json.dumps(filters))
    st, dat = client.request(
        'GET', '/api/platform/datasets/files.file/records?filters=%s&page=1&page_length=200' % enc)
    rows = (dat or {}).get('rows') or ((dat or {}).get('result') or {}).get('rows') or []
    return [r.get('file_name') or r.get('name') for r in rows]


# ---------- 造 ----------
def seed_mixed_table(client, run=None, name=None, rows=None,
                     attribution=None, promote_with=None):
    """造一张**干净的混合表**：晋升列（绑字段）+ 普通列，表头没被污染。

    回一个 handle，里面是**读回认定的事实**（表头/行 ID/版本），不是调用方要自己去猜的：

        {'table': <id>, 'file_name': <名字>, 'headers': [...], 'row_ids': [...],
         'content_version': n, 'structure_version': n, 'definition': {...}}

    `promote_with`：定晋升的客户端（`files.promotion_define` 是 System Manager 的活）。
    不传就用 `client` —— 那要求 `client` 自己就是管理员。
    """
    run = str(run or t.RUN)
    rows = DEFAULT_ROWS if rows is None else rows
    promote_with = promote_with or client
    file_name = name or ('D04混合表-%s.xlsx' % run)

    # **归属复用 `_ss_fixture` 那份**（§13 不造第二个默认），调用方显式传的不覆盖。
    payload = {
        'file_name': file_name,
        'directory': '/',
        'content_base64': base64.b64encode(_workbook_bytes(rows)).decode(),
    }
    payload['attribution'] = dict(attribution or _ss_fixture.FIXTURE_ATTRIBUTION)
    st, body = t.action(client, 'files.upload', payload, 'seed-up-%s' % run)
    table = _result(st, body).get('file')
    if not table:
        raise RuntimeError('seed_mixed_table：上传没成 HTTP %s %s' % (st, _err(body)[:160]))

    # 读回**认定的事实**：表头/行 ID/版本。不看夹具自己以为的。
    st_r, b_r = t.service(client, 'files.sheet_read', {'table': table})
    rr = _result(st_r, b_r)
    got_headers = rr.get('headers') or []
    if got_headers != MIXED_HEADERS:
        raise RuntimeError('seed_mixed_table：表头对不上（要 %r，实 %r）—— '
                           '夹具造出来的表不干净，别拿去测' % (MIXED_HEADERS, got_headers))

    # 定晋升。**先读当前结构版本**（`expected_structure_version` 不给会被拒，
    # 给错的会拿旧结构冒充新结构）。
    st_d, b_d = t.service(promote_with, 'files.promotion_definition', {'table': table})
    cur_sv = _result(st_d, b_d).get('structure_version')
    st_p, b_p = t.action(promote_with, 'files.promotion_define', {
        'table': table,
        'expected_structure_version': cur_sv,
        'definition': {'definition_version': 1, 'access': dict(TABLE_ACCESS),
                     'columns': MIXED_COLUMNS},
    }, 'seed-def-%s' % run)
    if st_p != 200:
        raise RuntimeError('seed_mixed_table：定晋升没成 HTTP %s %s '
                           '（`promotion_define` 是 System Manager 的活 —— '
                           'client 不是管理员就把管理员传进 `promote_with`）'
                           % (st_p, _err(b_p)[:160]))

    # 再读一次版本（定义写完以**认定的事实**为准）
    st_r2, b_r2 = t.service(client, 'files.sheet_read', {'table': table})
    rr2 = _result(st_r2, b_r2)
    return {
        'table': table,
        'file_name': file_name,
        'headers': list(rr2.get('headers') or MIXED_HEADERS),
        'row_ids': row_ids_of(rr2),
        'content_version': int(rr2.get('content_version') or 0),
        'structure_version': int(rr2.get('structure_version') or 1),
        'definition': _result(st_p, b_p).get('definition') or {},
        'run': run,
    }


# ---------- 清 ----------
def _console_module():
    """`bench console` 那一份（**公共件，§13 只留一份**）。

    ⚠️ **退役受管对象要在站点上下文里做**（退役口内部走 DDL：MariaDB 的 DDL 隐式提交）
    ⇒ HTTP 动作面**没有**这个口 ⇒ 只能进站点。
    """
    spec = importlib.util.spec_from_file_location(
        '_ss_console', ROOT + '/shangshu-server/scripts/tests/_ss_console.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


#: 在站点上下文里**退役受管对象/应用**并**回读确认**。
#:
#: ⚠️ **为什么走内核退役口**（2026-10-26 治理）：受管对象的幂等键按**表身份**算
#: （**不是文件名、也不是内容哈希**）⇒ 每跑一次判据（每张表晋升一次）就多一个
#: 受管对象 ＋ 一个应用 ＋ 一张物理表 ＋ 一个 DocType ⇒ 站上越跑越淹
#: （用户 2026-10-26 原话：「每次上传不同文件名的 xlsx 就多一个受管对象，改判据」）。
#: ⇒ 夹具的清理**必须**把这两样收掉，**不能只回收文件**。
_RETIRE_CODE = '''
import json
from shangshu_core.public_api import retire_managed_object, retire_application
errors=[]
retired_objects=[]
retired_applications=[]
for table in __TABLES__:
    try:
        raw=frappe.db.get_value('Shangshu File Center File',table,'sheet_meta_json')
        meta=json.loads(raw or '{}')
        binding=meta.get('promotion_binding') or {}
        object_id=binding.get('object_id')
        application_id=binding.get('application_id')
        if object_id:
            receipt=retire_managed_object(object_id,reason='live 判据收尾：退役本次跑造出来的受管对象')
            application_id=(receipt or {}).get('application_id') or application_id
            retired_objects.append(object_id)
        if application_id:
            retire_application(application_id,reason='live 判据收尾：退役本次跑造出来的应用')
            retired_applications.append(application_id)
    except Exception as error:
        errors.append('retire:%s:%s'%(table,str(error)[:120]))
frappe.db.commit()
# —— **回读确认**：三个状态逐个确认（对象已下线、应用已停用、文件在回收站）——
for object_id in retired_objects:
    active=frappe.db.get_value('Shangshu Object Model',object_id,'active_revision')
    if int(active or 0)!=0:errors.append('still-active-object:'+object_id)
    if not frappe.db.exists('Shangshu Object Model Retirement',{'object_id':object_id}):
        errors.append('no-retirement-record:'+object_id)
    physical=frappe.db.get_value('Shangshu Object Model',object_id,'physical_doctype')
    if physical and frappe.db.exists('DocType',physical):
        errors.append('physical-doctype-left:'+str(physical))
for application_id in retired_applications:
    status=frappe.db.get_value('Shangshu Application Definition',application_id,'status')
    if status!='Disabled':errors.append('still-active-application:'+application_id)
for table in __TABLES__:
    status=frappe.db.get_value('Shangshu File Center File',table,'status')
    if status!='Recycled':errors.append('active-file:'+table)
RESULT['retired_objects']=retired_objects
RESULT['retired_applications']=retired_applications
RESULT['errors']=errors
'''


def retire_residue(tables):
    """**退役**这些表带出来的受管对象/应用，并**回读确认**。

    回 `{'retired_objects': [...], 'retired_applications': [...], 'errors': [...]}`。

    ⚠️ **失败要报出来**（不许假装清干净了）—— 退役口有那道闸
    （**还有活着的对象引用着它 ⇒ 当场拒**）⇒ 拒了就如实进 `errors`。
    """
    tables = [str(item) for item in (tables or []) if item]
    result = {'retired_objects': [], 'retired_applications': [], 'errors': []}
    if not tables:
        return result
    try:
        console = _console_module()
    except Exception as error:      # noqa: BLE001 —— 拿不到 console 就如实说
        result['errors'].append('retire-step-unavailable:%s' % str(error)[:160])
        return result
    out = console.run(_RETIRE_CODE.replace('__TABLES__', repr(tables)))
    if out.get('__error__'):
        result['errors'].append('retire-step-failed:%s' % str(out.get('__error__'))[:200])
        return result
    result['retired_objects'] = list(out.get('retired_objects') or [])
    result['retired_applications'] = list(out.get('retired_applications') or [])
    result['errors'] = list(out.get('errors') or [])
    return result


def _is_recycled(client, table):
    """回读确认它**真进了回收站** —— 用**产品自己的话**：往里写一格，看是不是被
    「回收站中的文件先恢复再改表」拒。

    ⚠️ **列表查不出来**：`files.file` 的 `scope=trash` **排除 xlsx**
    （`domain.query`：非 `sheet` 范围一律 `file_name not like '%.xlsx'`）——
    所以**回收站里的表格根本列不出来**。这是产品缺口（登记待补），不是夹具偷懒：
    「回读确认」在这件事上**只能靠写被拒**，不能靠列表。

    ⚠️ **必须带版本闩**（栽过）：不带会被 **schema** 拒
    （「动作缺少必填字段：payload.expected_content_version」）—— 那是**错因通过**，
    认不出回收站，跟「怎么写都被拒」一样空。所以**先读版本再写**，让拒因真的指向回收站。

    回 `(是不是回收站里, 依据)`。**依据必须是产品回的原话**，不是「我调了 recycle 所以是」。
    """
    st_r, b_r = t.service(client, 'files.sheet_read', {'table': table})
    rr = _result(st_r, b_r)
    rid = (row_ids_of(rr) or ['r-000001'])[0]
    st, body = t.action(client, 'files.sheet_cell_write', {
        'table': table, 'row_id': rid, 'header': '备注',
        'value': {'type': 'text', 'value': '回收站核对'},
        'expected_content_version': int(rr.get('content_version') or 0),
        'expected_structure_version': int(rr.get('structure_version') or 1)},
        'seed-recycle-probe-%s' % table)
    err = _err(body)
    # **错因必须点名回收站** —— 只看「不是 200」是空判据（schema/版本错也会不是 200）。
    if st != 200 and '回收站' in err:
        return True, '写被拒且点名回收站：%s' % err[:90]
    return False, 'HTTP %s %s' % (st, err[:90])


def seed_cleanup(client, handle_or_handles):
    """清掉夹具造的表，**清完回读确认**。回一封**如实的回执**。

    收单个 handle 或 list。回执：

        {'seeded': [...], 'recycled': [...], 'active_left': [...],
         'residual': [...], 'retired_objects': [...], 'retired_applications': [...],
         'note': CLEANUP_NOTE}

    · `active_left` **空** = 真的从活跃表列表（`scope=sheet`）里没了
    · `recycled` = 进了回收站（`scope=trash`）的 —— **产品只能到这一步**
    · `retired_objects` / `retired_applications` = **走内核退役口收掉的**
      受管对象/应用（2026-10-26 治理：**只回收文件 ＝ 受管对象行、应用行、
      物理表都还在站上**；停用 ≠ 退役）
    · `residual` = 连回收都没进成的、退役被拒的，如实列出来（不掩盖）
    · `note` 说清「到底做到了哪一步」，**不许写「清空了」**

    ⚠️ 回执里的三个列表都是**回读出来**的，不是「我调了 recycle 所以应该没了」。
    空过长得跟过一模一样 —— 调用成功 ≠ 清掉了。
    """
    handles = handle_or_handles if isinstance(handle_or_handles, (list, tuple)) else [handle_or_handles]
    tables = []
    for h in handles:
        if not h:
            continue
        if isinstance(h, dict):
            tables.append((h.get('table'), h.get('file_name')))
        else:
            tables.append((str(h), None))
    tables = [(t_, n) for t_, n in tables if t_]

    recycled, residual = [], []
    for table, file_name in tables:
        st, body = t.action(client, 'files.recycle', {'file': table},
                            'seed-rec-%s' % table)
        if st == 200:
            recycled.append(file_name or table)
        else:
            residual.append({'table': table, 'file_name': file_name,
                             'error': _err(body)[:160]})

    # —— **回读确认**：不认「我调了 recycle」，从产品现查 ——
    #   · 还在不在**活跃表列表**（`scope=sheet`）—— 列表查得到
    #   · **真进回收站了吗** —— 列表**查不到**（`scope=trash` 排除 xlsx），
    #     只能靠**写被拒**回读（`_is_recycled`），依据是产品回的原话
    active = names_in(client, 'sheet')
    seeded_names = [n for _t, n in tables if n]
    active_left = [n for n in seeded_names if n in active]
    active_left += [t_ for t_, _n in tables if t_ in active and t_ not in active_left]

    recycled_seen, recycle_evidence = [], {}
    for table, file_name in tables:
        ok, why = _is_recycled(client, table)
        recycle_evidence[file_name or table] = why
        if ok:
            recycled_seen.append(file_name or table)
        else:
            residual.append({'table': table, 'file_name': file_name,
                             'error': '没能确认进了回收站：%s' % why})

    # —— **退役受管对象/应用**（2026-10-26 治理）——
    #    只回收文件 ＝ 受管对象行、应用行、物理表**都还在站上**（停用 ≠ 退役）。
    retired = retire_residue([t_ for t_, _n in tables])
    for message in retired['errors']:
        residual.append({'table': None, 'file_name': None, 'error': message})

    return {
        'seeded': seeded_names or [t_ for t_, _n in tables],
        'recycled': recycled_seen,
        'active_left': active_left,
        'residual': residual,
        'recycle_evidence': recycle_evidence,
        'retired_objects': retired['retired_objects'],
        'retired_applications': retired['retired_applications'],
        'note': CLEANUP_NOTE,
    }
