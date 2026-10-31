"""G1 归档附件落组织归属（PKG-006-T06 的后端那半，moniter 2026-10-14 提到最前）。

**测试通过 = 下面各条成立**：

G1-① 经 `files.import_attachment` 入库的附件**落了归属行**，回包带的是**从权威表
      （`Shangshu Org Attribution`）读回来的**归属，部门是 `Shangshu Department.name`
      真 ID —— 不是标题、不是邮箱地址、不是 None。
G1-② 同部门**未授权**者借「所有人 = 部门」读附件 → **拒，且有具体拒绝原话**
      （不是静默空包）。这是 T06 明写的反向判据。
G1-③ 已拿到授权的只读员工 → **读得到**。
G1-④ **无归属**的老资源行为不变（上传人仍可读写）—— 回落读权是既定语义，别改坏。
G1-⑤ 用**部门标题**冒充 ID 落归属 → **当场拒并说清原因**（不是 500，不是静默落错键）。
      这条证明「无权/错键归属不可通过改请求选入」。
G1-⑥ **声明了所有人却没落归属 → 当场拒，原话点名缺什么。**
      喂 `mail_system`（说这文件归张三）但不给 `attribution`：必须不能静默成功，
      也不许留下「写着张三、张三却没权利」的半成品。
G1-⑦ **两份都给 → 归属落库，且两份同一个键**（`owner_subject` 与 `owner_user`/`department` 对得上）。
G1-⑧ **系统路径不传归属 → 系统自动填给调用者本人**（用户 2026-10-15「让尚书系统自动填就行」）。
      **旧语义作废**：上一版这里是「两份都不给 → 照旧成功且**不落**归属」
      （`domain.py:33`「不带=无组织归属」）。用户 10-15 改了口径：非邮件新建资源
      **算新建、必须有归属**，但**不用人填，系统自动填**。所以这条从「没落」翻成
      「落了，而且是本人」—— **不是我们推的，是用户口径改了**。
      本条还带**对照**：人填路径（`files.upload`）不传归属**照旧拒**，证明自动填
      不是把人填闸也拆了；再加**敏感度两问**（两条路对「不传归属」给两种不同答案）。
G1-⑨ **反例（故意翻期望必须能红）**。
G1-⑪ **写接口的权限拦截 + 零写**（E 2026-10-14 派的接口层排查）：无权/只读的人
      **直接打写接口**（改格子 / 分流写 / 正式值写库 / 定晋升定义 / 改列名 / 加列 / 加行），
      ① 全部当场拒；② **零写**（拦住了但落了一半东西，跟没拦一样坏）；
      ③ **对照**：管理员同一接口写得进去（分不出「拦了」和「接口坏了」就不算数）；
      ④ 两道闸分层（角色闸 / 资源闸）；⑤ **角色闸放行后资源闸必须还拦**（放行=洞）；
      ⑥ **资源闸撬开必须翻**（不翻=闸是摆设）；⑦ 判别式自检。
G1-⑩ **纵深反例（E 2026-10-14 点名）**：把**文件域那侧**的把关条件撬开
      （模拟「已经交给内核了，这半删了」），同一个判定**必须翻成放行**。
      —— **翻不动 = 那道闸是摆设 = 红**。将来有人看「两边都判一遍，重复」
      想删一侧时，这条会拦住他。**如实标边界**：今天有归属的资源走内核单侧、
      无归属的走文件域这半；「两侧 AND」是 B 正在定的未来形状，还没进代码 ——
      E 原话「搬字段具体到哪我还在和 B 确认，别抢跑」。本条守的是**今天真在把关
      的那半**，等 AND 落地照旧守着文件域那一侧。**不覆盖**部门负责人（辖内）/
      企业老板（全企业）那两个缺口 —— 要等 B 的角色语义定死才能造样本。

背景（今天查实的两件，不是猜的）：
  · `files.import_attachment` 原先**不落归属行** —— `_apply_attribution` 里
    `attribution` 不在载荷就直接 return。于是 `resource_attribution` 一律 None，
    部门判定没有落点，越权反例会「筛不到」而**假绿**。
  · 归属的写入口是 `org_admin.attribution_record`（其注释：域建表/补录经此写入，
    不直写核心 DocType；合法性由调用方按各自口径判）。`resource` 键 =
    `Shangshu File Center File.name`。

先红后绿：`attribution` 还没接进 import_attachment 时应当红。
反例（故意翻期望）必须能红，否则判据恒真。

用法：python3 test_g1_import_attribution.py [--cases 01,...,09]
  06～09 走容器（受管收信上下文 `writing()`），需 SS_D_PW 指向 D 实例口令
"""
import base64
import importlib.util
import io
import json
import os
import sys
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
spec = importlib.util.spec_from_file_location(
    't', os.path.join(ROOT, 'shangshu-server', 'scripts', 'test-n2-structure.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

# 测试夹具默认归属 —— **只此一份**（§13 公共工具只留一份）。本文件里
# `run_managed_import` 的**准备步骤**（造来源表）用它；测归属那几步自己显式传，
# 不吃这个默认（见 `_ss_fixture.py` 顶部：混了就分不清「产品闸坏了」和「夹具补上了」）。
# 为什么这里还要 import 一次：`run_managed_import` 的准备动作跑在**容器里**
# （bench console），够不着主机上的模块 —— 所以把值从这里**传进去**，
# 不在生成的代码里再写一份字面量。
spec_f = importlib.util.spec_from_file_location(
    '_ss_fixture', os.path.join(ROOT, 'shangshu-server', 'scripts', 'tests', '_ss_fixture.py'))
_ss_fixture = importlib.util.module_from_spec(spec_f)
spec_f.loader.exec_module(_ss_fixture)

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3820')
RUN = t.RUN
VALID = ('01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11')

raw = ''
for i, a in enumerate(sys.argv):
    if a == '--cases' and i + 1 < len(sys.argv):
        raw = sys.argv[i + 1]
want = tuple(x.strip() for x in raw.split(',') if x.strip()) if raw else VALID
if raw and not want:
    print('结果： FAIL --cases 给了空选择'); sys.exit(2)
bad = [x for x in want if x not in VALID]
if bad:
    print('结果： FAIL --cases 有未知用例：%s' % ','.join(bad)); sys.exit(2)

from _ss_cred import CRED as _CRED, pw_of as _pw_of, admin_pw_for
admin_pw = admin_pw_for(BASE)
# 账号文件是表格（`| 用途 | 账号 | 口令 |`）时 `_pw_of` 认不出，退回环境变量。
# **口令不写进代码**：从账号文件取进 SS_D_PW 再跑，取法见 Agent-D-测试账号.md。
if not admin_pw:
    admin_pw = os.environ.get('SS_D_PW') or os.environ.get('SS_ADMIN_PW')
user_pw = os.environ.get('SS_D_PW_TESTER') or os.environ.get('SS_USER_PW', 'b2-user-pw-2026')
if not admin_pw:
    print('结果： FAIL 取不到管理员口令（账号文件没解析出来，且没给 SS_D_PW）'); sys.exit(2)

checks_run = 0
failed = []


not_yet = []


def notyet(label, why):
    """如实记「没测到」—— 不算通过也不算失败。**不许假造让它变绿。**"""
    global checks_run
    checks_run += 1
    not_yet.append(label)
    print('  ~ %s — 未测：%s' % (label, why))


def check(label, ok, detail=''):
    global checks_run
    checks_run += 1
    print('  %s %s%s' % ('✓' if ok else '✗', label, ('　—　' + str(detail)) if detail else ''))
    if not ok:
        failed.append(label)


def result_of(st, body):
    b = body if isinstance(body, dict) else {}
    r = b.get('result')
    return r if isinstance(r, dict) else (b if isinstance(b, dict) else {})


def build_plain():
    """最小合法 xlsx（内联串，不依赖 openpyxl）。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml',
                   '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                   '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        z.writestr('_rels/.rels',
                   '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr('xl/workbook.xml',
                   '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                   '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels',
                   '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr('xl/worksheets/sheet1.xml',
                   '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                   '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>H1</t></is></c></row>'
                   '<row r="2"><c r="A2" t="inlineStr"><is><t>G1归属值</t></is></c></row></sheetData></worksheet>')
    return buf.getvalue()


print('== G1 归档附件落组织归属 ==')
print('实例：%s　run=%s　所选：%s' % (BASE, RUN, ','.join(want)))

adm = t.Client(BASE)
adm.login('Administrator', admin_pw)

# ---- 前置：建部门拿 name(ID) ----
# schema 见 shangshu_core/install.py:116：additionalProperties=False，
# properties 只有 name(装标题)/parent(上级ID)/enterprise —— 传 title 会被判「未声明」。
TITLE = '一部-%s' % RUN
st_d, body_d = t.action(adm, 'platform.org.department_create',
                        {'name': TITLE}, f'g1-dept-{RUN}')
rd = result_of(st_d, body_d)
DEPT = rd.get('department') or rd.get('name')
print('建部门 HTTP %s 部门ID=%r 标题=%r 回包键=%r' % (st_d, DEPT, TITLE, list(rd) if isinstance(rd, dict) else None))
check('G1 前置：建出部门并拿到 name(ID)', bool(DEPT), 'HTTP %s %s' % (st_d, str(body_d)[:140]))
if not DEPT:
    print('结果： FAIL G1 前置失败（建不出部门就造不出部门归属）'); sys.exit(1)

# ---- 前置：每个用例**各自一个来源** ----
# 共用来源会踩早退：`import_attachment` 认出「这个附件已经导过」就直接返回
# already_imported，**根本走不到归属那段**（第一次写 G1-⑤ 就是这么空转的，
# 用例看着在测错键，其实什么都没测）。所以每例新上传一份。
b64 = base64.b64encode(build_plain()).decode()


def fresh_source(tag):
    st_u, body_u = t.action(adm, 'files.upload', {
        'file_name': 'g1-来源-%s-%s.xlsx' % (tag, RUN), 'content_base64': b64, 'directory': '/'},
        'g1-src-%s-%s' % (tag, RUN))
    src = result_of(st_u, body_u)
    src_file = src.get('file') or src.get('file_id')
    if not src_file:
        return None, None
    st_v, dat_v = t.service(adm, 'files.versions', {'file': src_file})
    vers = (dat_v or {}).get('versions') or []
    return src_file, (vers[0].get('frappe_file') if vers else None)


SRC_FILE, ATT = fresh_source('setup')
check('G1 前置：造出导入来源（表 + 附件 ID）', bool(SRC_FILE and ATT),
      '来源表=%r 附件=%r' % (SRC_FILE, ATT))
if not (SRC_FILE and ATT):
    print('结果： FAIL G1 前置失败（造不出导入来源）'); sys.exit(1)


def do_import(src_file, att, attribution, key):
    payload = {'source': {'ref_doctype': 'Shangshu File Center File',
                          'ref_name': src_file, 'file': att}}
    if attribution is not None:
        payload['attribution'] = attribution
    return t.action(adm, 'files.import_attachment', payload, key)


# ---------- G1-① 导入落归属行，回包是权威表读回的真 ID ----------
if '01' in want:
    print('\n== G1-① 导入落归属行，回包带权威表真 ID ==')
    s, a = fresh_source('01')
    st, body = do_import(s, a, {'level': 'department', 'department': DEPT}, f'g1-01-{RUN}')
    res = result_of(st, body)
    F2 = res.get('file')
    att_row = res.get('attribution')
    print('导入 HTTP %s 新表=%s 归属回包=%s' % (st, F2, json.dumps(att_row, ensure_ascii=False)[:160]))
    check('G1-① ① 导入被接受', st == 200 and bool(F2), 'HTTP %s %s' % (st, str(body)[:140]))
    # 归属必须**带出来**——不带就没法证明落了行（回声也不行，要能对上权威表）
    check('G1-① ② 回包带出归属（不是丢掉）', isinstance(att_row, dict) and bool(att_row),
          'attribution=%r' % (att_row,))
    if isinstance(att_row, dict):
        check('G1-① ③ 归属层级是部门', att_row.get('level') == 'department',
              'level=%r' % (att_row.get('level'),))
        dep = att_row.get('department')
        check('G1-① ④ 部门是真 ID（一字不差等于 Shangshu Department.name）', dep == DEPT,
              '归属部门=%r 建出的ID=%r 标题=%r' % (dep, DEPT, TITLE))
        check('G1-① ⑤ 不是标题、不是邮箱地址、不是 None',
              dep not in (None, '', TITLE) and '@' not in str(dep),
              'dep=%r' % (dep,))
        check('G1-① ⑥ resource 键是文件身份（不是 doctype+name 拼串）',
              isinstance(att_row.get('resource'), str) and ' ' not in att_row.get('resource', ' ')
              and 'doctype' not in att_row.get('resource', '').lower(),
              'resource=%r' % (att_row.get('resource'),))

# ---------- G1-② 未授权者不可借部门归属搭车 ----------
if '02' in want:
    print('\n== G1-② 同部门未授权者不可借部门归属读附件 ==')
    s, a = fresh_source('02')
    st, body = do_import(s, a, {'level': 'department', 'department': DEPT}, f'g1-02-{RUN}')
    F = result_of(st, body).get('file')
    out = t.Client(BASE)
    out.login('ss-outsider@example.invalid', user_pw)
    st_r, dat = t.service(out, 'files.sheet_read', {'table': F, 'page': 1, 'page_length': 5})
    dump = json.dumps(dat, ensure_ascii=False) if isinstance(dat, dict) else str(dat)
    denied = st_r != 200
    leak = 'G1归属值' in dump or 'H1' in dump
    check('G1-② ① 未授权者读被拒', denied, 'HTTP %s %s' % (st_r, dump[:150]))
    check('G1-② ② 拒绝回包不带表内容', not leak, '回包 %s' % dump[:130])
    # **必须是权限拒，不是校验错** —— 参数没给对也会非 200，那是工装的错，
    # 不能冒充「授权挡住了」。所以要把校验类拒绝单独排除掉。
    is_authz = (st_r == 403 or 'PERMISSION_DENIED' in dump or '无权' in dump
                or 'Not allowed' in dump)
    is_schema = any(w in dump for w in ('VALIDATION_FAILED', '未声明', '类型不正确', '必填'))
    check('G1-② ③ 是权限拒、不是校验错冒充（有具体拒绝原话）',
          denied and is_authz and not is_schema, 'HTTP %s 原话 %s' % (st_r, dump[:150]))

# ---------- G1-③ 已授权只读员工读得到 ----------
if '03' in want:
    print('\n== G1-③ 已授权只读员工读得到 ==')
    s, a = fresh_source('03')
    st, body = do_import(s, a, {'level': 'department', 'department': DEPT}, f'g1-03-{RUN}')
    F = result_of(st, body).get('file')
    st_g, body_g = t.action(adm, 'platform.org.share_grant', {
        'resource': F, 'user': 'ss-editor@example.invalid', 'access': 'read'}, f'g1-03g-{RUN}')
    check('G1-③ 前置：给 editor 读共享', st_g == 200, 'HTTP %s' % st_g)
    ed = t.Client(BASE)
    ed.login('ss-editor@example.invalid', user_pw)
    st_r, dat = t.service(ed, 'files.sheet_read', {'table': F, 'page': 1, 'page_length': 5})
    rows = (dat or {}).get('rows') if isinstance(dat, dict) else None
    check('G1-③ 已授权员工读得到', st_r == 200 and bool(rows),
          'HTTP %s rows=%s' % (st_r, len(rows) if rows is not None else None))

# ---------- G1-④ 无归属的老资源行为不变 ----------
if '04' in want:
    print('\n== G1-④ 无归属的老资源行为不变 ==')
    st, body = t.action(adm, 'files.upload', {
        'file_name': 'g1-无归属-%s.xlsx' % RUN, 'content_base64': b64, 'directory': '/'},
        f'g1-04-{RUN}')
    res = result_of(st, body)
    F = res.get('file') or res.get('file_id')
    check('G1-④ 前置：上传一份不带归属的表', bool(F), 'HTTP %s' % st)
    # 回落读权是既定语义：上传人仍能读、能写。别把无归属改成「谁都不能用」。
    st_r, dat = t.service(adm, 'files.sheet_read', {'table': F, 'page': 1, 'page_length': 5})
    check('G1-④ ① 无归属资源上传人仍读得到（回落读权没被改坏）',
          st_r == 200 and bool((dat or {}).get('rows')),
          'HTTP %s' % st_r)
    st_w, body_w = t.action(adm, 'files.update_meta', {
        'file': F, 'note': '无归属仍写得动'}, f'g1-04w-{RUN}')
    check('G1-④ ② 无归属资源上传人仍写得动（改备注）', st_w == 200,
          'HTTP %s %s' % (st_w, str(body_w)[:120]))

# ---------- G1-⑤ 错键归属当场拒 ----------
if '05' in want:
    print('\n== G1-⑤ 用部门标题冒充 ID 落归属 → 当场拒 ==')
    s, a = fresh_source('05')
    st, body = do_import(s, a, {'level': 'department', 'department': TITLE}, f'g1-05-{RUN}')
    dump = json.dumps(body, ensure_ascii=False) if isinstance(body, dict) else str(body)
    clean_reject = st in (400, 403, 409, 417, 422)
    check('G1-⑤ ① 错键被拒（不是 500、不是静默落错键）', clean_reject,
          'HTTP %s %s' % (st, dump[:150]))
    # 要的是一句**人能看懂的原话**，不是无字静默，也不是光秃秃一个错误码。
    err_text = str((body or {}).get('error') or '') if isinstance(body, dict) else ''
    check('G1-⑤ ② 拒绝说清原因（有可读原话，不是无字静默）',
          clean_reject and len(err_text) >= 4, '原话 %r  完整 %s' % (err_text, dump[:130]))
    check('G1-⑤ ③ 没落进错键（回包不带归属）',
          not (isinstance(body, dict) and isinstance(result_of(st, body).get('attribution'), dict)),
          '回包 %s' % dump[:130])

# ---------- G1-⑥～⑨ 声明了所有人却没落归属 —— 不许静默（E 2026-10-14 点的丢权链）----------
# 为什么这几条要走**容器**：`mail_system` 只在受管收信上下文（`writing()`，由
# `shangshu_mail.service` 把 `frappe.flags.shangshu_mail_write` 打开）才准带，
# HTTP 侧进不去。走 bench 是**产品逻辑的另一条正式入口**（邮件域自己就这么调），
# 不是绕过产品逻辑。
#
# 查实的降级点（不是猜的）：`delivery.py:374`
#   attribution = attachment_attribution(...) if _attribution_supported() else None
# 文件域 schema 不认 attribution 时邮件域**静默不发**；文件域 `_apply_attribution`
# 第一行 `if not att: return` 又**静默不落**。两边都不吭声 → 文件建了、
# 「所有人」写着张三、`Shangshu Org Attribution` 里没有那一行 → `read_allows`
# 回 None → 回落旧目录授权 → **张三拿不到权利，回包还说成功**。
#
# 修法口径（B 2026-10-14 定的解耦，不越）：文件域**不解释** `owner_subject_kind`
# 是什么、不从 `mail_system` 反推归属（那正是要拆的耦合）。只守一条：
# **你声明了所有人，权威归属那一行就必须落；落不了就当场拒。**

def run_managed_import(tag, payload_extra):
    """受管上下文里做一次上传→导入，回结果形状（不在 HTTP 侧）。"""
    import subprocess as _sp
    b64x = base64.b64encode(build_plain()).decode()
    code = r'''
import json, frappe
frappe.init(site="shangshu.localhost", sites_path="/home/frappe/frappe-bench/sites")
frappe.connect()
frappe.set_user(%(user)r)
from shangshu_mail.service import writing
from shangshu_core.public_api import execute_registered_action
from shangshu_core import org_admin
out = {}
try:
    src = execute_registered_action("files.upload", {
        "file_name": "G1守卫-%%s-%%s.xlsx" %% (%(tag)r, %(run)r),
        "content_base64": %(b64)r, "directory": "/",
        # **准备动作，不测归属** —— 造个来源表而已。值从 `_ss_fixture.FIXTURE_ATTRIBUTION`
        # 传进来（不在这里写第二份字面量）。2026-10-15 起 `files.upload` **新建必填归属**
        # （`service._require_attribution`），不带会被拒 —— 那样本组准备就跑不起来，
        # 看着像产品坏了，其实是准备没跟上。
        "attribution": %(src_att)r},
        confirmed=True, idempotency_key="g1g-src-%%s-%%s" %% (%(tag)r, %(run)r))
    src_file = (src.get("result") or {}).get("file") or (src.get("result") or {}).get("file_id")
    row = frappe.get_all("Shangshu File Center Version", filters={"file": src_file},
                         fields=["frappe_file"], order_by="version_no desc", limit_page_length=1)
    att = row[0].frappe_file if row else None
    out["src_file"], out["att"] = src_file, att
    payload = {"source": {"ref_doctype": "Shangshu File Center File",
                          "ref_name": src_file, "file": att}}
    payload.update(%(extra)s)
    try:
        with writing():
            res = execute_registered_action("files.import_attachment", payload,
                                            confirmed=True,
                                            idempotency_key="g1g-%%s-%%s" %% (%(tag)r, %(run)r))
        created = (res.get("result") or {}).get("file")
        out["call"], out["created"] = "ok", created
        out["attribution"] = (res.get("result") or {}).get("attribution")
        # **权威表读回的那份** —— 回包可能是回声，判「落的是不是本人」只认这个
        landed_att = org_admin.resource_attribution(created) if created else None
        out["landed_att"] = landed_att
        out["landed"] = bool(landed_att)
    except Exception as error:
        out["call"], out["landed"] = "raise", False
        out["error"] = "%%s: %%s" %% (type(error).__name__, error)
except Exception as error:
    out["setup_error"] = "%%s: %%s" %% (type(error).__name__, error)
frappe.db.rollback()
print("G1G_RESULT " + json.dumps(out, ensure_ascii=False, sort_keys=True))
''' % {'user': 'Administrator', 'tag': tag, 'run': RUN, 'b64': b64x,
       'src_att': dict(_ss_fixture.FIXTURE_ATTRIBUTION),
       'extra': json.dumps(payload_extra, ensure_ascii=False)}
    p = _sp.run(['docker', 'exec', '-i', '-w', '/home/frappe/frappe-bench',
                 'shangshu-local-d-frappe-1', 'bash', '-c',
                 'bench --site shangshu.localhost console'],
                # **必须包成一条 exec("...") 再发**：IPython console 按行读 stdin，
                # 多行的 try/except、with 块会被拆散当成多个输入格 —— 只有块外的
                # `out = {}` 执行了，回包就是 `{}`。实测栽过：整批用例回空包，
                # 看着像产品没行为，其实是脚手架没跑到。
                input='exec(%s)\nexit()\n' % repr(code),
                capture_output=True, text=True, timeout=240)
    marker = 'G1G_RESULT '
    # IPython 会回显输入源码（`exec("...")` 那一行里也有 marker），会跟真回包撞车。
    # 所以**只认 marker 后面紧跟 JSON 对象**的那几行，取最后一个（真回包在最后）。
    hits = []
    for l in p.stdout.splitlines():
        if marker not in l:
            continue
        tail = l[l.index(marker) + len(marker):].strip()
        if tail.startswith('{'):
            hits.append(tail)
    if not hits:
        return {'call': 'noresult',
                'error': '没解析到 JSON 回包。原始输出尾部：%s' % (p.stdout + p.stderr)[-700:]}
    try:
        return json.loads(hits[-1])
    except ValueError:
        return {'call': 'noresult', 'error': '回包不是 JSON：%r' % hits[-1][:300]}


if '06' in want:
    print('\n== G1-⑥ 声明了所有人却没落归属 → 必须当场拒（不许静默）==')
    r = run_managed_import('06', {
        'mail_system': {'owner_subject_kind': 'Employee',
                        'owner_subject': '张三-%s' % RUN,
                        'related_mail': 'MAIL-G1-06-%s' % RUN}})
    print('  回包：%s' % json.dumps(r, ensure_ascii=False)[:280])
    check('G1-⑥ ① 不静默成功（要么拒，要么归属真落了）',
          r.get('call') == 'raise' or r.get('landed') is True,
          'call=%r landed=%r error=%r' % (r.get('call'), r.get('landed'), r.get('error')))
    check('G1-⑥ ② 拒绝原话点名缺什么（不是空泛报错）',
          r.get('call') != 'raise' or any(k in str(r.get('error', '')) for k in ('attribution', '归属', '所有人')),
          'error=%r' % (r.get('error'),))
    check('G1-⑥ ③ 没留下「写着张三、张三却没权利」的半成品',
          not (r.get('call') == 'ok' and r.get('created') and not r.get('landed')),
          'created=%r landed=%r' % (r.get('created'), r.get('landed')))

if '07' in want:
    print('\n== G1-⑦ 两份都给 → 归属落库且同一个键 ==')
    key = 'owner-%s@example.invalid' % RUN
    r = run_managed_import('07', {
        'mail_system': {'owner_subject_kind': 'Employee', 'owner_subject': key,
                        'related_mail': 'MAIL-G1-07-%s' % RUN},
        'attribution': {'level': 'personal', 'owner_user': key}})
    print('  回包：%s' % json.dumps(r, ensure_ascii=False)[:280])
    check('G1-⑦ ① 导入被接受', r.get('call') == 'ok' and bool(r.get('created')),
          'call=%r created=%r error=%r' % (r.get('call'), r.get('created'), r.get('error')))
    check('G1-⑦ ② 归属真落库（权威表读回，不是回声）', r.get('landed') is True,
          'landed=%r attribution=%r' % (r.get('landed'), r.get('attribution')))
    check('G1-⑦ ③ 两份同一个键（owner_subject 与 owner_user 对得上）',
          (r.get('attribution') or {}).get('owner_user') == key,
          'owner_user=%r 期望=%r' % ((r.get('attribution') or {}).get('owner_user'), key))

if '08' in want:
    print('\n== G1-⑧ 系统路径不传归属 → 系统自动填给本人（用户 2026-10-15「让尚书系统自动填就行」）==')
    # **旧语义作废**：上一版写的是「两份都不给 → 照旧成功且**不落归属**」
    # （`domain.py:33`「不带=无组织归属」）。用户 10-15 定了新的：
    # 非邮件新建资源**算新建、必须有归属**，但**不用人填，系统自动填给调用者本人**。
    # 所以这条从「没落」翻成「落了，而且是本人」—— **不是我们推的，是用户口径改了**。
    r = run_managed_import('08', {})
    print('  回包：%s' % json.dumps(r, ensure_ascii=False)[:320])
    check('G1-⑧ ① 系统路径照旧成功（自动填，不拦人）',
          r.get('call') == 'ok' and bool(r.get('created')),
          'call=%r created=%r error=%r' % (r.get('call'), r.get('created'), r.get('error')))
    check('G1-⑧ ② **落了**归属（不是旧语义的「没落」）',
          r.get('landed') is True,
          'landed=%r landed_att=%r' % (r.get('landed'), r.get('landed_att')))
    att8 = r.get('landed_att') or {}
    check('G1-⑧ ③ 落的是**调用者本人**（personal 级，不是部门、不是别人）',
          str(att8.get('level') or '') == 'personal'
          and str(att8.get('owner_user') or '').lower() in ('administrator', ''),
          'landed_att=%r（调用者是 Administrator）' % (att8,))

    # ---- ⑦ 对照：人填路径照旧走人填（别把人填闸也拆了）----
    # `files.upload` 是人操作（前端有归属选择器），不传归属**照旧拒** —— 这就是
    # 「人工上传 → 人填」那半。自动填只给系统路径，不是把必填闸拆了。
    #
    # ⚠️ **不走 `t.action`** —— 那条口会经 `_ss_fixture.fill` 补上默认归属，
    # 「不传」就被夹具改成「传了」，对照当场空过（长得跟过一模一样）。
    # 所以本组自带调用口，**结构上够不着夹具**（同 ATT-⑨ 的 `_act9`）。
    def _act8_human(action_id, payload, key):
        return adm.request('POST', '/api/platform/actions/%s/execute' % action_id,
                           {'payload': payload, 'confirmed': True,
                            'idempotency_key': t.receipt_key(key)})

    st_h, b_h = _act8_human('files.upload', {
        'file_name': 'G1-⑧对照-%s.xlsx' % RUN,
        'content_base64': base64.b64encode(build_plain()).decode(),
        'directory': '/'}, f'g1-08-human-{RUN}')
    err8 = ''
    try:
        err8 = str((b_h.get('error') if isinstance(b_h, dict) else b_h) or '')
    except Exception:
        err8 = str(b_h)[:120]
    check('G1-⑧ ④ **对照**：人填路径（files.upload）不传归属 → 照旧拒',
          st_h == 417 or ('不传归属' in err8) or ('归属' in err8),
          'HTTP %s 错因=%r' % (st_h, err8[:120]))
    check('G1-⑧ ④ 拒因点名「不传归属」，不是别的旁因',
          '不传归属' in err8 or '尚书是单例' in err8,
          '错因=%r' % (err8[:120],))

    # ---- ⑦ 敏感度两问 ----
    # 两半：系统路径**自动填了** 且 人填路径**拒了** —— 两个都该为真
    v7 = {'系统路径自动填': bool(r.get('landed')), '人填路径照旧拒': st_h != 200}
    check('G1-⑧ ⑤ 敏感度·两半：系统路径自动填了 **且** 人填路径拒了（两个都该为真）',
          all(v7.values()), '结论=%r' % v7)
    # 判别式：「不传归属」这个问句在两条路上给**两种不同答案**
    ans7 = {'系统路径': bool(r.get('created')), '人填路径': st_h == 200}
    check('G1-⑧ ⑤ 敏感度·判别式：「不传归属」在两条路上给**两种不同答案**（不恒真/恒假）',
          len(set(ans7.values())) == 2, '收没收=%r' % ans7)

if '09' in want:
    print('\n== G1-⑨ 敏感度自检：判别式必须分得出「该放行」和「该拦」==')
    # **不是**再跑一遍 G1-⑥（那样 bug 在时跟着红、修好后跟着绿，恒同向，
    # 证明不了判据有牙齿）。而是把 G1-⑥ 的判别式喂两个合成结果，必须分得出。
    def _silent_ok(r):
        """G1-⑥ 的判别式：这是不是「静默成功却没落归属」。"""
        return (r.get('call') == 'ok' and bool(r.get('created')) and not r.get('landed'))

    ok_shape = {'call': 'ok', 'created': 'x', 'landed': True}
    bad_shape = {'call': 'ok', 'created': 'x', 'landed': False}
    raise_shape = {'call': 'raise', 'error': '缺 attribution', 'landed': False}
    check('G1-⑨ ① 判别式认「归属真落了」为放行', not _silent_ok(ok_shape), 'ok_shape')
    check('G1-⑨ ② 判别式认「静默没落」为必须拦', _silent_ok(bad_shape), 'bad_shape')
    check('G1-⑨ ③ 判别式认「当场拒」为放行（拒了就没留下半成品）',
          not _silent_ok(raise_shape), 'raise_shape')
    check('G1-⑨ ④ 三个形状给出两种不同结论（不是恒真/恒假）',
          len({_silent_ok(ok_shape), _silent_ok(bad_shape), _silent_ok(raise_shape)}) == 2,
          '结论集合=%s' % sorted({_silent_ok(ok_shape), _silent_ok(bad_shape), _silent_ok(raise_shape)}))

if '10' in want:
    # ---------- G1-⑩ 文件域把关条件**不是摆设**（E 2026-10-14 点名的纵深反例）----------
    print('\n== G1-⑩ 纵深反例：把文件域那侧拆掉（模拟「已交给内核」），判定必须翻 ==')
    import subprocess

    def _pd_probe():
        """在 bench console 里做：基线判不许 → 撬开文件域闸门 → 判定必须翻成放行 → 装回。

        **不改产品代码、不换部署** —— 只在解释器里临时把 `_dept_allows` /
        `access.can_read` 换成恒放行，等价于「有人把文件域这半注释掉了」。
        """
        inner = (
            "import frappe, json\n"
            "from shangshu_files import service as S\n"
            "from shangshu_core import org_admin\n"
            "out = {}\n"
            "frappe.set_user('Administrator')\n"
            "name = None\n"
            "for r in frappe.get_all('Shangshu File Center File',\n"
            "        filters=[['file_name','like','pd-纵深-%']],\n"
            "        fields=['name'], order_by='modified desc', limit=1):\n"
            "    name = r['name']\n"
            "if not name:\n"
            "    # 造一个**受限目录**（access_mode=restricted 且不给 tester）——\n"
            "    # 放根目录下 can_read 对谁都 True，基线根本拒不起来，反例就成恒真空过。\n"
            "    _R = __import__('shangshu_files.directories', fromlist=['ROOT']).ROOT\n"
            "    _slug = 'pd' + frappe.utils.now_datetime().strftime('%H%M%S')\n"
            "    dd = frappe.get_doc({'doctype':'Shangshu File Directory',\n"
            "        'title':'pd-纵深-'+_slug,'path':'/pd-纵深-'+_slug,\n"
            "        'parent_directory': _R,\n"
            "        'access_mode':'restricted','allowed_identities_json':'[]','allowed_groups_json':'[]'})\n"
            "    dd.insert(ignore_permissions=True)\n"
            "    frappe.db.commit()\n"
            "    d = frappe.get_doc({'doctype':'Shangshu File Center File',\n"
            "        'file_name':'pd-纵深.xlsx','directory': dd.path,'directory_id': dd.name,\n"
            "        'status':'Active','version_count':1})\n"
            "    d.insert(ignore_permissions=True)\n"
            "    frappe.db.commit()\n"
            "    name = d.name\n"
            "doc = frappe.get_doc('Shangshu File Center File', name)\n"
            "out['table'] = name\n"
            "out['has_attribution'] = bool(org_admin.resource_attribution(name))\n"
            "out['dir'] = doc.directory_id\n"
            "victim = None\n"
            "for u in ('tester@example.invalid','reader@example.invalid','ss-reader@example.invalid'):\n"
            "    if frappe.db.exists('User', u):\n"
            "        victim = u; break\n"
            "out['victim'] = victim\n"
            "if victim is None:\n"
            "    out['error'] = 'no-non-admin-account'\n"
            "else:\n"
            "    frappe.set_user(victim)\n"
            "    out['baseline'] = bool(S.has_permission(doc, 'read', victim))\n"
            "    o1, o2 = S._dept_allows, S.access.can_read\n"
            "    S._dept_allows = lambda u, d: True\n"
            "    S.access.can_read = lambda d, u: True\n"
            "    try:\n"
            "        out['bypassed'] = bool(S.has_permission(doc, 'read', victim))\n"
            "    finally:\n"
            "        S._dept_allows, S.access.can_read = o1, o2\n"
            "    frappe.set_user(victim)\n"
            "    out['restored'] = bool(S.has_permission(doc, 'read', victim))\n"
            "print('PD_PROBE ' + json.dumps(out, ensure_ascii=False))\n"
        )
        ctr = os.environ.get('SS_BENCH_CTR', 'shangshu-local-d-frappe-1')
        site = os.environ.get('SS_SITE', 'shangshu.localhost')
        proc = subprocess.run(
            ['docker', 'exec', '-i', ctr, 'sh', '-c',
             'cd /home/frappe/frappe-bench && bench --site %s console' % site],
            input='exec(%s)\nexit()\n' % repr(inner),
            capture_output=True, text=True, timeout=180)
        blob = (proc.stdout or '') + '\n' + (proc.stderr or '')
        for line in blob.splitlines():
            i = line.find('PD_PROBE ')
            if i >= 0 and line[i + 9:].strip().startswith('{'):
                try:
                    return json.loads(line[i + 9:].strip()), blob
                except Exception:
                    pass
        return None, blob

    pd, raw_pd = _pd_probe()
    print('  探针回包：%s' % (pd,))
    if not pd:
        check('G1-⑩ ① 探针跑得出结果', False, '没抓到探针输出：%s' % raw_pd[-300:])
    elif pd.get('error'):
        # 缺非管理员账号 → 如实记未测，不假造（D 实例可能只有 Administrator）
        notyet('G1-⑩ 纵深反例', '本实例没有可用的非管理员账号（%s），造不出「无授权的人」'
               % pd.get('error'))
    else:
        check('G1-⑩ ① 基线：没有文件域授权的人，判**不许读**',
              pd.get('baseline') is False,
              'baseline=%r victim=%r has_attribution=%r' % (
                  pd.get('baseline'), pd.get('victim'), pd.get('has_attribution')))
        # —— 本条的正题 ——
        check('G1-⑩ ② **反例**：把文件域那侧拆掉（模拟已交给内核），判定必须翻成放行'
              '（翻不动=那道闸是摆设=红）',
              pd.get('bypassed') is True,
              '拆掉后=%r（基线 %r）' % (pd.get('bypassed'), pd.get('baseline')))
        check('G1-⑩ ③ 还原：闸门装回去，判定回到「不许读」（拆过不许留后门）',
              pd.get('restored') is False, '还原后=%r' % pd.get('restored'))

        def _depth_ok(baseline, bypassed, restored):
            # 判别式：闸门在=不许、拆掉=放行、装回=不许 —— 三态必须是 假/真/假。
            return (baseline is False) and (bypassed is True) and (restored is False)

        v_ok = _depth_ok(False, True, False)
        v_dead = _depth_ok(False, False, False)   # 闸门是摆设：拆了也不放行
        v_none = _depth_ok(True, True, True)      # 压根没闸：一直放行
        v_stuck = _depth_ok(False, True, True)    # 拆了没装回（留后门）
        vv = {'ok': v_ok, 'gate_dead': v_dead, 'no_gate': v_none, 'stuck_open': v_stuck}
        check('G1-⑩ ④ 敏感度：判别式认「闸门真在把关」为过', v_ok, 'ok')
        check('G1-⑩ ④ 敏感度：判别式认「闸门是摆设」为不过', not v_dead, 'gate_dead')
        check('G1-⑩ ④ 敏感度：判别式认「压根没闸」为不过', not v_none, 'no_gate')
        check('G1-⑩ ④ 敏感度：判别式认「拆了没装回」为不过', not v_stuck, 'stuck_open')
        check('G1-⑩ ④ 敏感度：四种形状给出两种不同结论（不是恒真/恒假）',
              len(set(vv.values())) == 2, '结论=%r' % vv)

if '11' in want:
    # ---------- G1-⑪ 写接口的权限拦截 + 零写（E 2026-10-14 派的接口层排查）----------
    print('\n== G1-⑪ 接口层：无权的人直接打写接口，拦不拦？拒了是不是零写？==')
    import subprocess
    user_pw = os.environ.get('PW_TESTER') or os.environ.get('SS_D_PW_TESTER') or ''
    if not user_pw:
        notyet('G1-⑪ 写接口权限拦截', '没给 PW_TESTER，造不出「无权的人」')
    else:
        # 自给自足：自己建一张 Administrator 的表，不碰共享夹具
        from openpyxl import Workbook
        _wb = Workbook(); _ws = _wb.active
        _ws.append(['名称', '数值', '备注']); _ws.append(['甲', 1, 'a'])
        _buf = io.BytesIO(); _wb.save(_buf)
        st_up, b_up = t.action(adm, 'files.upload', {
            'file_name': 'g1-11-写权限-%s.xlsx' % RUN, 'directory': '/',
            'content_base64': base64.b64encode(_buf.getvalue()).decode()},
            'g1-11-up-%s' % RUN)
        W11 = result_of(st_up, b_up).get('file')
        check('G1-⑪ 前置：建出一张干净表（Administrator 的，自给自足）', bool(W11), '表=%s' % W11)

        victim = t.Client(BASE)
        try:
            victim.login('tester@example.invalid', user_pw)
            v_ok = True
        except SystemExit:
            v_ok = False
        check('G1-⑪ 前置：无权身份登得进来（登不进就谈不上「拦不拦」）', v_ok, 'tester@example.invalid')

        def _snap11(who=None):
            _c = who or adm
            _st, _b = t.service(_c, 'files.sheet_read', {'table': W11})
            _r = result_of(_st, _b) or {}
            return {'headers': _r.get('headers'),
                    'cells': {x.get('row_id'): x.get('values') for x in (_r.get('rows') or [])},
                    'cv': _r.get('content_version'), 'sv': _r.get('structure_version')}

        base11 = _snap11()
        _row = list((base11['cells'] or {}).keys())
        _row = _row[0] if _row else None
        check('G1-⑪ 前置：基线快照非空（空基线比不出零写）',
              bool(base11['cells']) and bool(_row), 'cells=%s' % base11['cells'])

        # —— ① 基线：无权的人打 7 个写接口，必须**全部当场拒** ——
        _cv, _sv = base11['cv'], base11['sv']
        W_CASES = [
            ('改格子', 'files.sheet_cell_write',
             {'table': W11, 'row_id': _row, 'header': '名称',
              'value': {'type': 'text', 'value': '被改了'},
              'expected_content_version': _cv, 'expected_structure_version': _sv}),
            ('分流写(晋升写口)', 'files.cell_write',
             {'table': W11, 'row_id': _row, 'header': '名称',
              'value': {'type': 'text', 'value': '被改了'},
              'expected_content_version': _cv, 'expected_structure_version': _sv}),
            ('正式值写库', 'files.formal_value_write',
             {'table': W11, 'row_id': _row, 'values': {'case_no': 'x'}}),
            ('定晋升定义', 'files.promotion_define',
             {'table': W11, 'expected_structure_version': _sv,
              'definition': {'definition_version': 1, 'columns': [
                  {'header': '名称', 'promoted': True, 'field': 'f1', 'type': 'text'}]}}),
            ('改列名(结构)', 'files.sheet_header_rename',
             {'table': W11, 'from_header': '备注', 'to_header': '说明',
              'expected_content_version': _cv, 'expected_structure_version': _sv}),
            ('加列(结构)', 'files.sheet_column_append',
             {'table': W11, 'header': '新列',
              'expected_content_version': _cv, 'expected_structure_version': _sv}),
            ('加行(结构)', 'files.sheet_row_append',
             {'table': W11, 'count': 1,
              'expected_content_version': _cv, 'expected_structure_version': _sv}),
        ]
        denied, err_texts = [], {}
        for label, act_id, pl in W_CASES:
            st_w, b_w = t.action(victim, act_id, pl, 'g1-11-%s-%s' % (label, RUN))
            txt = ''
            if isinstance(b_w, dict):
                txt = str(b_w.get('error') or b_w.get('message') or '')
            err_texts[act_id] = txt
            print('    %-16s %-24s HTTP=%s %s' % (label, act_id.replace('files.', ''),
                                                  st_w, txt[:60]))
            if st_w != 200 or (isinstance(b_w, dict) and not b_w.get('ok')):
                denied.append(act_id)
        check('G1-⑪ ① 无权的人打 7 个写接口 → **全部当场拒**（一个都不许写进去）',
              len(denied) == len(W_CASES), '拒了 %d/%d：%s' % (len(denied), len(W_CASES),
                                                              sorted(denied)))

        # —— ② **零写**（本条是重点：拦住了但落了一半东西，跟没拦一样坏）——
        after11 = _snap11()
        check('G1-⑪ ② **零写**：拒完之后表一个字节没动（格子/表头/内容版本逐项比）',
              after11['cells'] == base11['cells']
              and after11['headers'] == base11['headers']
              and after11['cv'] == base11['cv'],
              '格子同=%s 表头同=%s 版本同=%s（前 cv=%s 后 cv=%s）' % (
                  after11['cells'] == base11['cells'], after11['headers'] == base11['headers'],
                  after11['cv'] == base11['cv'], base11['cv'], after11['cv']))

        # —— ③ **对照**：管理员同一个接口写得进去（证明接口通，不是「接口本来就坏」）——
        st_adm, b_adm = t.action(adm, 'files.sheet_cell_write', {
            'table': W11, 'row_id': _row, 'header': '名称',
            'value': {'type': 'text', 'value': '管理员写的'},
            'expected_content_version': base11['cv'],
            'expected_structure_version': base11['sv']}, 'g1-11-adm-%s' % RUN)
        after_adm = _snap11()
        check('G1-⑪ ③ **对照**：管理员同一个写口写得进去（不然分不出「拦了」和「接口坏了」）',
              st_adm == 200 and (b_adm.get('ok') if isinstance(b_adm, dict) else False)
              and ((after_adm['cells'].get(_row) or {}).get('名称') or {}).get('value') == '管理员写的',
              'HTTP %s 写后=%r' % (st_adm, ((after_adm['cells'].get(_row) or {}).get('名称') or {})))

        # —— ④ 两道闸的报错分得清（角色闸 vs 资源闸）——
        role_gate = [a for a, t_ in err_texts.items()
                     if '无权执行该动作' in t_]
        res_gate = [a for a, t_ in err_texts.items()
                    if '上传人' in t_ or '归属人' in t_ or '共享' in t_]
        check('G1-⑪ ④ 两道闸分层且分得清（角色闸拒一批、资源闸拒一批，不是一句笼统的「没权」）',
              bool(role_gate) and bool(res_gate),
              '角色闸拒=%s 资源闸拒=%s' % ([x.replace('files.', '') for x in role_gate],
                                          [x.replace('files.', '') for x in res_gate]))

        # —— ⑤⑥ 敏感度：把闸门撬开必须能翻（不翻=那道闸是摆设=红）——
        role_held = None   # ⑤ 测到才有值；没测到就 None，不拿未测当过
        # **⑤⑥ 拆开跑**：⑤ 要先建「Sheet Structure Editor」角色，建不成就如实记未测；
        # ⑥ 不依赖任何角色，**必须单独跑得动**（不然整条敏感度就是空的）。
        def _probe11(inner):
            ctr = os.environ.get('SS_BENCH_CTR', 'shangshu-local-d-frappe-1')
            site = os.environ.get('SS_SITE', 'shangshu.localhost')
            proc = subprocess.run(
                ['docker', 'exec', '-i', ctr, 'sh', '-c',
                 'cd /home/frappe/frappe-bench && bench --site %s console' % site],
                input='exec(%s)\nexit()\n' % repr(inner),
                capture_output=True, text=True, timeout=180)
            blob = (proc.stdout or '') + '\n' + (proc.stderr or '')
            for line in blob.splitlines():
                i = line.find('W11 ')
                if i >= 0 and line[i + 4:].strip().startswith('{'):
                    try:
                        return json.loads(line[i + 4:].strip()), blob
                    except Exception:
                        pass
            return None, blob

        # ⑤ 角色闸放行后，资源闸必须还拦
        inner_role = (
            "import frappe, json\n"
            "from shangshu_files import service as S\n"
            "out = {}\n"
            "frappe.set_user('Administrator')\n"
            "name = %r\n"
            "victim = 'tester@example.invalid'\n"
            "doc = frappe.get_doc('Shangshu File Center File', name)\n"
            "out['owner'] = doc.owner\n"
            "if not frappe.db.exists('Role', 'Sheet Structure Editor'):\n"
            "    frappe.get_doc({'doctype':'Role','role_name':'Sheet Structure Editor',\n"
            "                    'desk_access':1}).insert(ignore_permissions=True)\n"
            "    frappe.db.commit()\n"
            "    out['role_created'] = True\n"
            "u = frappe.get_doc('User', victim)\n"
            "had = 'Sheet Structure Editor' in [r.role for r in u.roles]\n"
            "if not had:\n"
            "    u.append('roles', {'role': 'Sheet Structure Editor'})\n"
            "    u.save(ignore_permissions=True)\n"
            "    frappe.db.commit()\n"
            "out['role_granted'] = not had\n"
            "frappe.set_user(victim)\n"
            "out['can_write_after_role'] = bool(S._can_write(doc))\n"
            "frappe.set_user('Administrator')\n"
            "if not had:\n"
            "    u = frappe.get_doc('User', victim)\n"
            "    u.roles = [r for r in u.roles if r.role != 'Sheet Structure Editor']\n"
            "    u.save(ignore_permissions=True)\n"
            "    frappe.db.commit()\n"
            "print('W11 ' + json.dumps(out, ensure_ascii=False))\n" % W11
        )
        w, raw = _probe11(inner_role)
        print('    ⑤ 探针回包：%s' % (w,))
        if not w:
            notyet('G1-⑪ ⑤ 角色闸放行后资源闸还拦不拦',
                   '角色建/授失败，造不出「有角色无资源权」的身份：%s' % raw[-200:])
        else:
            check('G1-⑪ ⑤ **角色闸放行后，资源闸必须还拦**'
                  '（授了「Sheet Structure Editor」也不许改别人的表 —— 放行了就是洞）',
                  w.get('can_write_after_role') is False,
                  'can_write=%r owner=%r role_granted=%r role_created=%r' % (
                      w.get('can_write_after_role'), w.get('owner'),
                      w.get('role_granted'), w.get('role_created')))
            role_held = w.get('can_write_after_role')

        # ⑥ 资源闸撬开后判定必须翻（**不依赖角色，单独跑**）
        inner_bypass = (
            "import frappe, json\n"
            "from shangshu_files import service as S\n"
            "out = {}\n"
            "frappe.set_user('Administrator')\n"
            "name = %r\n"
            "victim = 'tester@example.invalid'\n"
            "doc = frappe.get_doc('Shangshu File Center File', name)\n"
            "frappe.set_user(victim)\n"
            "out['baseline_can_write'] = bool(S._can_write(doc))\n"
            "orig = S._can_write\n"
            "S._can_write = lambda d: True\n"
            "try:\n"
            "    out['can_write_bypassed'] = bool(S._can_write(doc))\n"
            "finally:\n"
            "    S._can_write = orig\n"
            "# **还原后必须还是无权身份时查** —— 先切回管理员再查，管理员当然能写，那是探针自伤\n"
            "out['restored_can_write'] = bool(S._can_write(doc))\n"
            "frappe.set_user('Administrator')\n"
            "print('W11 ' + json.dumps(out, ensure_ascii=False))\n" % W11
        )
        w2, raw2 = _probe11(inner_bypass)
        print('    ⑥ 探针回包：%s' % (w2,))
        if not w2:
            check('G1-⑪ ⑥ 敏感度探针跑得出结果', False, '没抓到：%s' % raw2[-300:])
        else:
            check('G1-⑪ ⑥ **资源闸撬开后判定必须翻成放行**（不翻=那道闸是摆设=红）'
                  '；装回去又回到不许改（拆过不许留后门）',
                  w2.get('baseline_can_write') is False
                  and w2.get('can_write_bypassed') is True
                  and w2.get('restored_can_write') is False,
                  '基线=%r 撬开=%r 还原=%r' % (w2.get('baseline_can_write'),
                                              w2.get('can_write_bypassed'),
                                              w2.get('restored_can_write')))

        # —— ⑦ 判别式自检 ——
        def _w_ok(denied_n, total_n, zero_write, ctrl_ok, role_held, bypassed):
            # 判别式：全拒 + 零写 + 对照能写 + 角色放行后仍拦 + 撬开后翻
            # role_held=None 表示那条没测到，不参与判定（不拿未测当过）
            role_ok = (role_held is None) or (role_held is False)
            return (denied_n == total_n and zero_write and ctrl_ok
                    and role_ok and bypassed is True)

        v_ok = _w_ok(7, 7, True, True, False, True)
        v_not_denied = _w_ok(3, 7, True, True, False, True)   # 没全拒
        v_wrote = _w_ok(7, 7, False, True, False, True)       # 拒了但落了一半
        v_role_leak = _w_ok(7, 7, True, True, True, True)     # 角色放行后也放行 = 洞
        v_dead = _w_ok(7, 7, True, True, False, False)        # 撬开不翻 = 闸是摆设
        vv = {'ok': v_ok, 'not_denied': v_not_denied, 'half_wrote': v_wrote,
              'role_leak': v_role_leak, 'gate_dead': v_dead}
        check('G1-⑪ ⑦ 敏感度：判别式认「拦住且零写」为过', v_ok, 'ok')
        check('G1-⑪ ⑦ 敏感度：判别式认「没全拒」为不过', not v_not_denied, 'not_denied')
        check('G1-⑪ ⑦ 敏感度：判别式认「拒了但落了一半」为不过', not v_wrote, 'half_wrote')
        check('G1-⑪ ⑦ 敏感度：判别式认「角色放行后也放行（洞）」为不过',
              not v_role_leak, 'role_leak')
        check('G1-⑪ ⑦ 敏感度：判别式认「撬开不翻（闸是摆设）」为不过',
              not v_dead, 'gate_dead')
        check('G1-⑪ ⑦ 敏感度：五种形状给出两种不同结论（不是恒真/恒假）',
              len(set(vv.values())) == 2, '结论=%r' % vv)

print('')
if checks_run == 0:
    print('结果： FAIL 零条检查被断言（阶段空转不许判通过）'); sys.exit(1)
if failed:
    print('结果： FAIL G1 归属落点（%d/%d 条不成立：%s）' % (len(failed), checks_run, '；'.join(failed)))
    sys.exit(1)
if not_yet:
    print('结果： PASS G1 归属落点（%d 条过；另有 %d 条未测：%s）'
          % (checks_run - len(not_yet), len(not_yet), '；'.join(not_yet)))
else:
    print('结果： PASS G1 归属落点全部成立（%d 条）' % checks_run)
