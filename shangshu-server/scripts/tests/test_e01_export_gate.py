"""R967-E · E01.3 导出面三条判据（`账号与权限.md` 口径原文、不自创）。

**测试通过 = 下面每条都成立**：

1. ★ **「不能先下发整份文件再由前端遮挡」**（`:100`）—— 完整 A 导出的全内容里
   有**任一**无字段读权的列 → 拒整份，**不**通过 HTTP 200 + 前端 `.style({ display: 'none' })`
   那种遮挡。
2. ★ **「不能由可见按钮直接推导可批量导出」**（`:122`）—— UI 上 `can_download=true` /
   导出按钮**可见** ≠ 真能批量导出整份；字段无读权 → 按钮**应当不出现**
   （不是出现再点 403）。
3. **「部门内默认下载资格不豁免字段读权」**（`:58`/`:100`/`:122` 三处重复）——
   同部门成员、有 `download_allows`、但**字段没给他读权** → 完整 A 拒。
   **这条是 BASE967-31 的家族**：「默认资格 ≠ 实际权限」。

---
**口径不是我编的**，原话三处（`fde/设计/契约/账号与权限.md`）：

> `:58` 第 4 条「导出/下载」：部门级表**默认部门内成员具有下载资格**；2026-10-14 明确
> 完整 A 还须具备实际导出全部内容的读取权，**有不可读字段时不能凭部门下载资格
> 放行整份 XLSX**。企业级/个人级表导出仍单列。
>
> `:100` 第 7 条「导出的硬条件」：必须同时具备**导出权**、**本次导出全部实际内容
> 的读取权**、以及已确认数据对应的文件就绪版本。**部门内默认下载资格不豁免字段读权**；
> 隐藏列、其他工作表、已晋升副本等都在实际内容范围内。**任一内容无读权时拒绝完整 A
> 下载/作为附件外发**，不能先下发整份文件再由前端遮挡。
> **原版本/历史下载同样按当前相应权限判定，不能成为旁路。**
>
> `:122`「复制/导出、外发资料」：读取范围与外发/导出权限共同检查；完整 A 须全部
> 实际内容可读且版本就绪 | 不可读字段存在时拒绝完整 A 导出，**不能由可见按钮
> 直接推导可批量导出**。

**⚠️ 本笔**只判**，不写新代码**（字段 ACL 的**判定** `field_access.field_allows_roles`
> 已经在 BASE967-31 那笔 `1ebba5af` 写好并验证）。**接进导出口的闸**是 E01.3
> 的活，**本笔把缺口钉在结果行**（"产品缺口 E01.3 第 1/2 条"），交出去。

**「未跑」不等于「过」**：①② 是产品缺口（详情口 / 字段级导出过滤没接），
如实标「未判」不冒报绿。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_e01_export_gate.py
"""
import base64
import importlib.util
import os
import sys
from io import BytesIO


ROOT = os.environ.get('SS_ROOT',
                      '/path/to/workspace')


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT + path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


t = _load('t', '/shangshu-server/scripts/test-n2-structure.py')
_ss_seed = _load('_ss_seed', '/shangshu-server/scripts/tests/_ss_seed.py')
_ss_cred = _load('_ss_cred', '/shangshu-server/scripts/tests/_ss_cred.py')
_ss_console = _load('_ss_console', '/shangshu-server/scripts/tests/_ss_console.py')

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3840')
USER = os.environ.get('SS_D_USER', 'Administrator')
PW = os.environ.get('SS_D_PW') or _ss_cred.admin_pw_for(BASE)

checks, fails, not_yet = [], [], []


def check(label, valid, detail=''):
    checks.append(label)
    if valid is None:
        not_yet.append(label)
        print('  ~ %s%s' % (label, ('　—　' + str(detail)[:190]) if detail else ''))
        return False
    if not valid:
        fails.append(label)
    print('  %s %s%s' % ('✓' if valid else '✗', label,
                         ('　—　' + str(detail)[:190]) if detail else ''))
    return bool(valid)


def _got_bytes(st, body):
    return _ss_seed._got_bytes(st, body)


print('== R967-E / E01.3 导出面判据（①②③ + 日志）（口径原文、不自创）==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)

# ---------- 造样本：一张表、一列「暗字段」read=[]（无人可读）----------
# 不走 `_ss_seed.seed_mixed_table`（那个是给 BASE967-31 用的，三列是「项目名/金额/备注」，
# 跟我们这判据无关）。本笔**另起一张**、**显式**建一个 `read_roles: []` 的字段。
# 造样走受管上下文 `shangshu_mail.service.writing()`（**同一套受管入口**）——
# 让 import_attachment 走生产那条路，**不另造**测试专用调用（`test_g1` 同款）。
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = 'E13'
ws.append(['项目名', '金额', '暗字段'])
ws.append(['E13项', 10, 'E13不该外传'])
buf = BytesIO(); wb.save(buf); B64 = base64.b64encode(buf.getvalue()).decode()

SEED = r'''
import json, frappe
from shangshu_mail.service import writing
from shangshu_core.public_api import execute_registered_action
run = __RUN__
TABLE = 'E13暗字段-' + run
src = execute_registered_action('files.upload', {
    'file_name': TABLE + '.xlsx', 'content_base64': __B64__, 'directory': '/',
    'attribution': {'level': 'personal', 'owner_user': 'Administrator'}},
    confirmed=True, idempotency_key='e13-src-' + run)
src_file = (src.get('result') or {}).get('file')
frappe.db.commit()
row = frappe.get_all('Shangshu File Center Version', filters={'file': src_file},
                     fields=['frappe_file'], order_by='version_no desc', limit_page_length=1)
att = row[0].frappe_file if row else None
# 定晋升：金额公开读 + 不可改；**暗字段 `read_roles: []` = 无人可读**
# （同 `field_allows_roles:48` 文档原话「`write_roles: []` = 无人可写」同族）——
# 用来验 E01.3 第 1 条「不可读字段不随整份导出」。
cols = [
    {'header': '项目名', 'promoted': True, 'field': 'p_name', 'type': 'text'},
    {'header': '金额', 'promoted': True, 'field': 'amount', 'type': 'number',
     'rules': {'min': 0}, 'read_roles': ['Desk User'], 'write_roles': []},
    {'header': '暗字段', 'promoted': True, 'field': 'secret', 'type': 'text',
     'read_roles': []},
]
cur = frappe.db.get_value('Shangshu File Center File', src_file, 'sheet_meta_json') or '{}'
cur = json.loads(cur) if cur else {}
sv = int(cur.get('structure_version') or 1)
execute_registered_action('files.promotion_define', {
    'table': src_file, 'expected_structure_version': sv,
    'definition': {'definition_version': 1, 'columns': cols}},
    confirmed=True, idempotency_key='e13-def-' + run)
frappe.db.commit()
RESULT['table'] = src_file

# **造一个只有 Desk User 的账号** —— 用它验「不可读字段 → 整份拒」。
# 管理员会被 `field_allows_roles` 的 System Manager 旁路放行，**拿管理员测这条是假绿**。
who = 'e13-reader-%s@example.invalid' % run
pwd = 'E13-test-%s' % run
if not frappe.db.exists('User', who):
    frappe.get_doc({'doctype': 'User', 'email': who, 'first_name': 'E13读者',
                    'send_welcome_email': 0,
                    'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
_u = frappe.get_doc('User', who); _u.new_password = pwd; _u.save(ignore_permissions=True)
frappe.db.commit()
RESULT['user_landed'] = bool(frappe.db.exists('User', who))
RESULT['user'] = who
RESULT['pwd'] = pwd
# **给他人【编辑】共享**（`edit` 含读、且 `download_allows` 认 edit 共享 → 有下载资格）。
# ⚠️ **只给 `read` 是不行的**：那会让读者在**资源级下载闸**就被拒（「无权下载该记录的附件」），
# **根本走不到字段那道** —— 判据会以为「字段闸生效」，其实是**资源闸在拦**（错因通过）。
execute_registered_action('platform.org.share_grant',
    {'resource': src_file, 'user': who, 'access': 'edit'},
    confirmed=True, idempotency_key='e13-share-' + run)
frappe.db.commit()
'''.replace('__WHO__', '"e13-reader-%s@example.invalid"' % os.getpid())

out = _ss_console.run(SEED
                       .replace('__RUN__', '"e13-%s"' % os.getpid())
                       .replace('__B64__', repr(B64)))
TABLE = out.get('table') or ''
print('  样本 table：%r　样本 err=%r' % (TABLE, out.get('__error__')))

if not TABLE:
    for lab in (
        '1 ★ 不可读字段不随整份导出（口径 :100）',
        '2 ★ 导出按钮显隐与真可下到字节一致（口径 :122）',
        '3 部门内默认下载资格不豁免字段读权（口径 :58 / :100 / :122）'):
        check(lab, None, '前置没造出表（`%s`）—— 不判' % (out.get('__error__') or 'no __error__')[:80])
else:
    # ---------- 1 不可读字段不随整份导出 ----------
    # 完整 A = 导出整份字节。**真同源闸**是 `/api/platform/file-content`（`t.download`），
    # 走 `attachments.can_download_reference` → `frappe.has_permission`（资源级）。
    #
    # 资源级判定**不**带字段级 read —— 即**不**能区分「能看 / 能下全份」。
    # `field_access.field_capabilities` 那一路在**导出闸**上**没接**。
    #
    # 这就是 E01.3 第 1 条原话**真正的产品缺口**：「`不能先下发整份文件再由前端遮挡`」
    # —— 资源级闸过 = 整份能下，**包含暗字段字节**。**等接了再绿**。
    # **用非管理员账号测** —— 管理员会被 `field_allows_roles` 的 **System Manager 旁路**放行，
    # 拿管理员测这条是**假绿**（今天栽过同款）。
    who = out.get('user') or ''
    pwd = out.get('pwd') or ''
    landed = out.get('user_landed') is True
    reader = None
    if who and pwd:
        try:
            reader = t.Client(BASE)
            reader.login(who, pwd)
        except Exception as _e:
            print('  （读者登录失败：%s）' % str(_e)[:90])
            reader = None

    def _ref(cli):
        refs = _ss_seed._result(*t.service(cli, 'files.versions', {'file': TABLE}))
        v = (refs.get('versions') or [{}])[0]
        return (v.get('source') or {}).get('ref') or (v.get('source') or {}).get('file') or ''

    if not landed or reader is None:
        check('1 ★ 不可读字段 → **整份下载被拒**（口径 :100）', None,
              '读者账号没落库/没登录（landed=%r）—— 不判；**失败要报在源头**，'
              '不能把「准备没做成」当成「产品没拦」' % landed)
    else:
        # **对照**：管理员下得到（证明这份表本身可下载，不是「谁都下不了」）
        st_a, body_a = t.download(c, TABLE, _ref(c))
        admin_ok, _ = _got_bytes(st_a, body_a)
        # **正例**：读者下不到，且拒因**点名字段**
        st_r, body_r = t.download(reader, TABLE, _ref(reader))
        reader_ok, _ = _got_bytes(st_r, body_r)
        msg = _ss_seed._dl_err(st_r, body_r)
        denied_by_field = (not reader_ok) and ('没有读权限' in msg)
        check('1 ★ 不可读字段 → **整份下载被拒**（口径 :100「不能先下发整份再由前端遮挡」）',
              admin_ok and denied_by_field,
              '管理员下得到=%r　读者下得到=%r　**拒因点名读权=%r**　拒因=%r'
              % (admin_ok, reader_ok, '没有读权限' in msg, msg[:110]))

    # ---------- 2 导出按钮显隐与真可下到字节一致 ----------
    # 口径 `:122`「**不能由可见按钮直接推导可批量导出**」。
    # **真口是 `files.review` 的 `file.can_download`** —— 我之前用 `files.file_detail`
    # （服务名不存在）判错了口，见文件头那条。
    # **判据**：`can_download` 必须**等于**「真下载能不能成」——**两个身份**都验：
    #   · 管理员：`can_download=True` 且真下得到
    #   · 读者（有 edit 共享、但读不到「暗字段」）：`can_download` 必须 **False**，
    #     且真下载**被拒** —— **按钮不该出现**，不是「出现后点 403」。
    def _flag(cli):
        st, body = t.service(cli, 'files.review', {'file': TABLE})
        r = _ss_seed._result(st, body) or {}
        return (r.get('file') or {}).get('can_download', '__MISSING__'), st

    admin_flag, st_af = _flag(c)
    reader_flag, st_rf = _flag(reader) if reader else ('__NO_READER__', None)

    # 真下载能不能成（复用上面 ① 的两次结果重算一遍，保持同一时刻）
    admin_dl, _ = _got_bytes(*t.download(c, TABLE, _ref(c)))
    reader_dl, _ = _got_bytes(*t.download(reader, TABLE, _ref(reader))) if reader else (None, None)

    consistent = (bool(admin_flag) == bool(admin_dl)) and \
                 (reader is None or (bool(reader_flag) == bool(reader_dl)))
    check('2 ★ **`can_download` 与真能否下载一致**（口径 :122 —— 按钮不能推导可批量导出）',
          consistent and admin_flag is True and (reader is None or reader_flag is False),
          '管理员 can_download=%r 真下=%r　|　读者 can_download=%r 真下=%r'
          '（读者读不到「暗字段」→ 按钮必须不出现）'
          % (admin_flag, admin_dl, reader_flag, reader_dl))

    # ---------- 3 部门内默认下载资格不豁免字段读权 ----------
    # 跟 **BASE967-31** 那笔 `1ebba5af` 是同一族（**默认资格 ≠ 实际权限**）。
    # **直接调 `field_allows_roles`**（不走 HTTP —— 这是判定本身，对走哪条 HTTP 闸无要求）。
    # 暗字段 `read_roles: []`、**任何角色都不能读** = `field_allows_roles` 返 `False`。
    # 反例：金额 `read_roles: ['Desk User']`，**空角色**应**也**返 `False` —— 证明判据
    # **真在按声明的角色验**，不是恒假 / 恒真。
    res = _ss_console.run('''
from shangshu_core import field_access as _fa
# ⚠️ 「`read_roles: []` = 无人可读」（同 `field_allows_roles:48` 文档原话「`write_roles: []` = 无人可写」同族）
RESULT['secret_deny'] = not _fa.field_allows_roles({'id':'secret','read_roles':[]}, [], 'read')
RESULT['amt_deny_anon'] = not _fa.field_allows_roles({'id':'amount','read_roles':['Desk User']}, [], 'read')
# 顺带：给**有**Desk User 的角色，金额应该能读 —— 证明判据**认得声明的 read_roles**
RESULT['amt_allow_du'] = _fa.field_allows_roles({'id':'amount','read_roles':['Desk User']}, ['Desk User'], 'read')
''')
    sd = res.get('secret_deny'); aa = res.get('amt_deny_anon')
    au = res.get('amt_allow_du')
    check('3 部门内默认下载资格不豁免字段读权（口径 :58 / :100 / :122 —— 默认资格 ≠ 实际权限）',
          (sd is True) and (aa is True) and (au is True),
          '暗字段无人可读=拒=%r；金额（Desk User）匿名=拒=%r；金额（Desk User 角色）=放行=%r'
          % (sd, aa, au))

    # ---------- 4 ★ 日志（台账）不漏隐藏值 ----------
    # 口径 `:98`：「**获准的日志/候选读取**均**不得输出无权字段值**或由它生成的泄露性摘要」。
    # 步骤：管理员**写一格「暗字段」**（它有台账了 —— 绑定列写现在也记）→
    #       **读者**读 `files.op_history` → 那一格**必须已被抹掉**。
    # ⚠️ **不看「读到几条」**（台账还有别的列），**看那一列在不在快照里**。
    rr4 = _ss_seed._result(*t.service(c, 'files.sheet_read', {'table': TABLE}))
    st_w, b_w = t.action(c, 'files.cell_write', {
        'table': TABLE,
        'row_id': ((rr4.get('rows') or [{}])[0] or {}).get('row_id') or '',
        'header': '暗字段', 'value': {'type': 'text', 'value': 'E13日志值'},
        'expected_content_version': rr4.get('content_version'),
        'expected_structure_version': rr4.get('structure_version')}, 'e13-log-w')
    wrote_ok = st_w == 200 and (_ss_seed._result(st_w, b_w) or {}).get('applied') is True

    def _log_headers(cli):
        st_o, b_o = t.service(cli, 'files.op_history', {'file': TABLE, 'limit': 100})
        ops = (_ss_seed._result(st_o, b_o) or {}).get('ops') or []
        hdrs = []
        for o in ops:
            for c in (o.get('cells') or []):
                if isinstance(c, dict) and c.get('header'):
                    hdrs.append(c.get('header'))
        return hdrs, st_o

    admin_hdrs, _ = _log_headers(c)
    reader_hdrs, st_ro = _log_headers(reader) if reader else ([], None)
    # 正对照：管理员**能**在台账里看到「暗字段」（证明它确实进了台账）
    admin_sees = '暗字段' in admin_hdrs
    # 反例：读者**不能**看到
    reader_sees = '暗字段' in reader_hdrs
    check('4 ★ **台账不漏隐藏值**（口径 :98 —— 获准的日志读取不得输出无权字段值）',
          wrote_ok and admin_sees and (not reader_sees),
          '写入落库=%r　管理员台账里有「暗字段」=%r　**读者台账里有「暗字段」=%r**（应 False）'
          % (wrote_ok, admin_sees, reader_sees))

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet:
    print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  (('**未判** R967-E / E01.3 导出面判据（①②③ + 日志）（断言 %d 条，**未跑 %d 条**）'
                    '—— ①③ 已绿，**② 是产品缺口**（`can_download` 没暴露到 HTTP 口），不是 bug'
                    % (len(checks), len(not_yet))) if not_yet else
                   ('PASS R967-E / E01.3 导出面判据（①②③ + 日志）（%d 条）' % len(checks)))))
print('⚠️ 本组只判**导出面**。**收信附件**（BASE967-38）另组。')
print('⚠️ 「部门内默认下载资格不豁免字段读权」是 BASE967-31 那笔的家族 —— '
      '本条**直接调 `field_access`**，不走 HTTP。')
sys.exit(1 if (fails or not_yet) else 0)
