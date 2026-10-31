"""R967-E · UI-041：**谁能读日志**（`files.op_history`）+ 隐藏列不进台账。

**测试通过 = 下面每条成立**：

1. **前置**：建一张有「暗列」（`read_roles: []`）的表，管理员在暗列写一格 → 台账有记录。
2. ★ **无表读权的人调 `files.op_history` → 拒**（不是返回空列表、不是 200）。
3. ★ **有表读权的人读台账 → 200，且台账里暗列的 header/值被抹掉**；
   **正对照**：管理员能看到暗列那条快照 —— 证明「抹掉」不是「本来就没记」。
4. **敏感度**：同一份台账、两个身份（管理员 / 有读权的读者）给**两种不同答案**。

---

**口径原文**（`账号与权限.md:98`）：
> 「列表/详情、搜索与定位、筛选/排序、范围读取/复制、**预览**、Assistant 工具、
> **获准的日志/候选读取**均**不得输出无权字段值**或由它生成的泄露性摘要。」

**⚠️ 本测试会先核「字段 ACL 是否持久化」**：
若候选线 `save_definition` 仍丢 `read_roles`（UI-019 未并入），则 3/4 标「**未判**」
并写明原因 —— **不把 UI-019 的缺口误记成台账过滤失效**。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_e01_op_history_authz.py
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
        print('  ~ %s%s' % (label, ('　—　' + str(detail)[:220]) if detail else ''))
        return False
    if not valid:
        fails.append(label)
    print('  %s %s%s' % ('✓' if valid else '✗', label,
                         ('　—　' + str(detail)[:220]) if detail else ''))
    return bool(valid)


print('== R967-E / UI-041 谁能读日志 + 隐藏列不进台账 ==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)

RUN = str(os.getpid())
READER = 'e41-reader-%s@example.invalid' % RUN
OUTSIDER = 'e41-out-%s@example.invalid' % RUN
PWD = 'E41-test-%s' % RUN

from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = 'E41'
ws.append(['可见列', '暗列'])
ws.append(['v1', 's1'])
_buf = BytesIO(); wb.save(_buf)
B64 = base64.b64encode(_buf.getvalue()).decode()

SEED = r'''
import json, frappe
from shangshu_core.public_api import execute_registered_action
run = __RUN__
RESULT = {}

_prev = frappe.flags.in_import
frappe.flags.in_import = True
try:
    for em, fn in app_users:
        pass
finally:
    frappe.flags.in_import = _prev
'''  # 占位；实际用户建在下面（保持 in_import 显式 enabled）

SEED = SEED.replace('''    for em, fn in app_users:
        pass''', '''    for em, fn in ((__READER__, 'E41读者'), (__OUTSIDER__, 'E41无关')):
        if not frappe.db.exists('User', em):
            frappe.get_doc({'doctype': 'User', 'email': em, 'first_name': fn,
                            'send_welcome_email': 0, 'enabled': 1,
                            'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
        u = frappe.get_doc('User', em); u.new_password = __PWD__; u.save(ignore_permissions=True)''')

SEED += r'''
frappe.db.commit()
RESULT['users_landed'] = {em: bool(frappe.db.exists('User', em))
                          for em in (__READER__, __OUTSIDER__)}

up = execute_registered_action('files.upload', {
    'file_name': 'E41台账-%s.xlsx' % __RUN__, 'content_base64': __B64__,
    'directory': '/', 'attribution': {'level': 'personal', 'owner_user': 'Administrator'}},
    confirmed=True, idempotency_key='e41-up-' + __RUN__)
TABLE = (up.get('result') or {}).get('file') or ''
RESULT['table'] = TABLE

# 定晋升：可见列 Desk User 可读；暗列 read_roles=[] 无人可读
cols = [
    {'header': '可见列', 'promoted': True, 'field': 'vis', 'type': 'text',
     'read_roles': ['Desk User']},
    {'header': '暗列', 'promoted': True, 'field': 'secret', 'type': 'text',
     'read_roles': []},
]
if TABLE:
    cur = json.loads(frappe.db.get_value('Shangshu File Center File', TABLE, 'sheet_meta_json') or '{}')
    sv = int(cur.get('structure_version') or 1)
    execute_registered_action('files.promotion_define', {
        'table': TABLE, 'expected_structure_version': sv,
        'definition': {'definition_version': 1, 'columns': cols}},
        confirmed=True, idempotency_key='e41-def-' + __RUN__)
    frappe.db.commit()

# **核字段 ACL 是否持久化** —— 候选线若仍丢 read_roles，后续台账过滤无从谈起
_meta = json.loads(frappe.db.get_value('Shangshu File Center File', TABLE, 'sheet_meta_json') or '{}')
_d = _meta.get('promotion') or {}
_bys = {c.get('header'): c for c in (_d.get('columns') or []) if isinstance(c, dict)}
RESULT['acl_persisted'] = (
    'read_roles' in (_bys.get('暗列') or {})
    and (_bys.get('暗列') or {}).get('read_roles') == []
)

# 给读者读权（read 共享）
if TABLE:
    execute_registered_action('platform.org.share_grant',
        {'resource': TABLE, 'user': __READER__, 'access': 'read'},
        confirmed=True, idempotency_key='e41-share-' + __RUN__)
    frappe.db.commit()

RESULT['table_ready'] = bool(TABLE)
'''

_purged = _ss_console.purge_users('e41-', keep=(READER, OUTSIDER))
if _purged:
    print('  （清掉历史残留账号 %d 个）' % len(_purged))

out = _ss_console.run(SEED
                      .replace('__RUN__', repr(RUN))
                      .replace('__READER__', repr(READER))
                      .replace('__OUTSIDER__', repr(OUTSIDER))
                      .replace('__PWD__', repr(PWD))
                      .replace('__B64__', repr(B64)))
TABLE = out.get('table') or ''
ACL_OK = out.get('acl_persisted') is True
print('  表=%r ACL持久化=%r users=%r err=%r'
      % (TABLE, ACL_OK, out.get('users_landed'), out.get('__error__')))

# 管理员在暗列写一格 → 台账留记录（用产品自己的写口）
wrote = False
if TABLE:
    rr = _ss_seed._result(*t.service(c, 'files.sheet_read', {'table': TABLE}))
    _row = ((rr.get('rows') or [{}])[0] or {}).get('row_id') or ''
    st_w, b_w = t.action(c, 'files.cell_write', {
        'table': TABLE, 'row_id': _row, 'header': '暗列',
        'value': {'type': 'text', 'value': 'E41暗值'},
        'expected_content_version': rr.get('content_version'),
        'expected_structure_version': rr.get('structure_version')}, 'e41-w-%s' % RUN)
    wrote = (st_w == 200) and ((_ss_seed._result(st_w, b_w) or {}).get('applied') is True)
    # 正对照也必须真实写过：只写暗列再要求台账含可见列，会制造必然失败。
    rr = _ss_seed._result(*t.service(c, 'files.sheet_read', {'table': TABLE}))
    st_public, b_public = t.action(c, 'files.cell_write', {
        'table': TABLE, 'row_id': _row, 'header': '可见列',
        'value': {'type': 'text', 'value': 'E41公开值'},
        'expected_content_version': rr.get('content_version'),
        'expected_structure_version': rr.get('structure_version')}, 'e41-public-%s' % RUN)
    wrote = wrote and st_public == 200 and (_ss_seed._result(st_public, b_public) or {}).get('applied') is True


try:
    ok_seed = bool(TABLE) and all((out.get('users_landed') or {}).values())
    check('0 前置·表 + 两个合成账号 + 暗列写入（台账有记录）都真落库',
          ok_seed and wrote,
          'table=%r users=%r **暗列写=%r** err=%r'
          % (bool(TABLE), out.get('users_landed'), wrote, out.get('__error__')))

    if not ok_seed:
        for lab in ('1 无表读权 → 台账被拒',
                    '2 ★ 有读权者台账抹掉暗列（管理员正对照能看到）',
                    '3 敏感度：同一台账两种身份两种答案'):
            check(lab, None, '前置没造出来，不判（不假装验过）')
    else:
        # ---------- 1 无读权 → 拒 ----------
        outsider = t.Client(BASE)
        outsider.login(OUTSIDER, PWD)
        st_o, b_o = t.service(outsider, 'files.op_history', {'file': TABLE, 'limit': 20})
        ops_o = (_ss_seed._result(st_o, b_o) or {}).get('ops')
        check('1 ★ **无表读权的人调 `files.op_history` → 拒**（不是空列表、不是 200）',
              (st_o != 200),
              'HTTP %s ops=%r 拒因=%r'
              % (st_o, ops_o, _ss_seed._err(b_o)[:120]))

        # ---------- 2/3 有读权者 vs 管理员 ----------
        reader = t.Client(BASE)
        reader.login(READER, PWD)

        def _hdrs(cli):
            st, body = t.service(cli, 'files.op_history', {'file': TABLE, 'limit': 100})
            ops = (_ss_seed._result(st, body) or {}).get('ops') or []
            hs = []
            for o in ops:
                for cell in (o.get('cells') or []):
                    if isinstance(cell, dict) and cell.get('header'):
                        hs.append(cell['header'])
            return st, hs

        st_a, hdr_a = _hdrs(c)
        st_r, hdr_r = _hdrs(reader)
        # 正对照：管理员台账里**有**暗列；反例：读者那里**没有**
        admin_sees = '暗列' in hdr_a
        reader_sees = '暗列' in hdr_r
        # 读者至少看到「可见列」（证明台账本身有内容，不是空表）
        reader_sees_public = '可见列' in hdr_r

        if not ACL_OK:
            for lab in ('2 ★ 有读权者台账抹掉暗列（管理员正对照能看到）',
                        '3 敏感度：同一台账两种身份两种答案'):
                check(lab, None,
                      '**字段 ACL 未持久化**（候选缺 UI-019：`save_definition` 丢 '
                      '`read_roles`）→ 台账过滤的前提不成立，本组不判')
        else:
            check('2 ★ **有读权者台账抹掉暗列**（管理员正对照能看到）',
                  (st_r == 200) and reader_sees_public and (not reader_sees) and admin_sees,
                  '管理员 HTTP %s 有暗列=%r（正对照）　读者 HTTP %s 看到可见列=%r '
                  '**看到暗列=%r**（应 False）'
                  % (st_a, admin_sees, st_r, reader_sees_public, reader_sees))
            check('3 敏感度：同一台账两种身份两种答案',
                  admin_sees and not reader_sees,
                  '管理员看到暗列=%r　读者看到暗列=%r' % (admin_sees, reader_sees))
finally:
    _ss_console.run('''
import frappe
try:
    if __TABLE__:
        frappe.db.sql('delete from `tabShangshu File Center File` where name=%s', __TABLE__)
        frappe.db.sql("delete from `tabShangshu Org Grant` where resource=%s", __TABLE__)
        frappe.db.sql("delete from `tabShangshu Org Attribution` where resource=%s", __TABLE__)
    frappe.db.sql('delete from `tabUser` where email in %(u)s',
                  {'u': (__READER__, __OUTSIDER__)})
except Exception:
    pass
frappe.db.commit()
'''.replace('__TABLE__', repr(TABLE))
    .replace('__READER__', repr(READER)).replace('__OUTSIDER__', repr(OUTSIDER)))

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet:
    print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  (('PASS R967-E / UI-041 谁能读日志（%d 条）' % len(checks))
                   if not not_yet else
                   ('**未判** R967-E / UI-041（断言 %d 条，**未跑 %d 条**）'
                    % (len(checks), len(not_yet))))))
print('⚠️ 本组只判**台账读权与隐藏列过滤**；字段 ACL 持久化本身属 UI-019，另一组。')
sys.exit(1 if (fails or not_yet) else 0)
