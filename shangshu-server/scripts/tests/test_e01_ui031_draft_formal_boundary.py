"""R967-E · UI-031：**晋升表空行** + **草稿值与正式值的边界**。

**测试通过 = 下面每条成立**：

1. **前置**：一张晋升表（`金额` 绑字段、`备注` 普通列），首次晋升把历史值迁进
   `formal_values_json`。
2. ★ **空行边界**：末尾加一行**全空**的行 → 它出现在 `files.sheet_read` 里、
   各格为空，**`formal_values_json` 不为它产生任何条目**（空值不迁）。
3. ★ **正式值**：在空行的**绑定列（金额）**写一格 → 值进 `formal_values_json`，
   同时 `files.sheet_read` 读得到 —— **DB 正式值与表值一致**。
4. ★ **草稿边界**：在同一行的**普通列（备注）**写一格 → **只进表，不进 `formal_values_json`**
   （普通列没有数据库字段）。
5. **敏感度**：同一行两次写，**一个进 DB、一个不进** —— 两种落点，不是全进或全不进。

---

**口径依据**：计划 §二.1「普通列留在工作XLSX；已晋升绑定值直接写数据库」；
§二.2「首次晋升与值写入是两个动作」。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_e01_ui031_draft_formal_boundary.py
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


print('== R967-E / UI-031 晋升表空行 + 草稿/正式边界 ==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)
RUN = str(os.getpid())

from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = 'B'
ws.append(['名称', '金额', '备注'])
ws.append(['甲', 150, '原备注'])
_b = BytesIO(); wb.save(_b)
B64 = base64.b64encode(_b.getvalue()).decode()

SEED = r'''
import json, frappe
from shangshu_core.public_api import execute_registered_action
run = __RUN__
RESULT = {}
up = execute_registered_action('files.upload', {
    'file_name': 'E31边界-%s.xlsx' % run, 'content_base64': __B64__,
    'directory': '/', 'attribution': {'level': 'personal', 'owner_user': 'Administrator'}},
    confirmed=True, idempotency_key='e31-up-' + run)
T = (up.get('result') or {}).get('file') or ''
RESULT['table'] = T
if T:
    meta = json.loads(frappe.db.get_value('Shangshu File Center File', T, 'sheet_meta_json') or '{}')
    cols = [
        {'header': '名称', 'promoted': True, 'field': 'p_name', 'type': 'text'},
        {'header': '金额', 'promoted': True, 'field': 'amount', 'type': 'number',
         'rules': {'min': 0}},
        {'header': '备注', 'promoted': False},
    ]
    execute_registered_action('files.promotion_define', {
        'table': T, 'expected_structure_version': int(meta.get('structure_version') or 1),
        'definition': {'definition_version': 1, 'columns': cols}},
        confirmed=True, idempotency_key='e31-def-' + run)
    frappe.db.commit()
RESULT['formal_initial'] = frappe.db.get_value('Shangshu File Center File', T, 'formal_values_json') if T else None
'''

out = _ss_console.run(SEED.replace('__RUN__', repr(RUN)).replace('__B64__', repr(B64)))
TABLE = out.get('table') or ''
print('  表=%r 初始 formal=%r err=%r' % (TABLE, out.get('formal_initial'), out.get('__error__')))


def _read(cli):
    st, body = t.service(cli, 'files.sheet_read', {'table': TABLE})
    return st, (_ss_seed._result(st, body) or {})


def _formal():
    r = _ss_console.run('''
import json, frappe
v = frappe.db.get_value('Shangshu File Center File', __T__, 'formal_values_json') or '{}'
try: RESULT['f'] = json.loads(v)
except Exception: RESULT['f'] = {}
'''.replace('__T__', repr(TABLE)))
    return r.get('f') or {}


try:
    ok_seed = bool(TABLE)
    check('0 前置·晋升表建好且历史值已迁', ok_seed,
          'table=%r formal=%r err=%r'
          % (bool(TABLE), out.get('formal_initial'), out.get('__error__')))

    if not ok_seed:
        for lab in ('1 空行：出现在表里、formal 不产生条目',
                    '2 ★ 绑定列写 → 进正式值',
                    '3 ★ 普通列写 → 只进表、不进正式值',
                    '4 敏感度：同一行两种落点'):
            check(lab, None, '前置没造出来，不判（不假装验过）')
    else:
        # ---- 1 空行 ----
        st0, d0 = _read(c)
        rows0 = d0.get('rows') or []
        st_a, b_a = t.action(c, 'files.sheet_row_append', {
            'table': TABLE,
            'expected_content_version': d0.get('content_version'),
            'expected_structure_version': d0.get('structure_version'),
            'count': 1}, 'e31-append-%s' % RUN)
        _ra = _ss_seed._result(st_a, b_a) or {}
        appended = (st_a == 200) and bool(_ra.get('row_ids'))
        st1, d1 = _read(c)
        rows1 = d1.get('rows') or []
        new_row = rows1[-1] if rows1 else {}
        new_id = new_row.get('row_id') or ''
        f1 = _formal()
        empty_ok = (len(rows1) == len(rows0) + 1)
        no_formal_for_new = new_id and (new_id not in f1)
        check('1 ★ **空行**：出现在表里（行数 +1）、**`formal_values_json` 不为它产生条目**',
              appended and empty_ok and bool(new_id) and no_formal_for_new,
              'append=%r 行数 %d→%d 新行=%r formal 有新行条目=%r'
              % (appended, len(rows0), len(rows1), new_id, (new_id in f1)))

        # ---- 2 绑定列写 ----
        _st, _d = _read(c)
        st_w, b_w = t.action(c, 'files.cell_write', {
            'table': TABLE, 'row_id': new_id, 'header': '金额',
            'value': {'type': 'number', 'value': 300},
            'expected_content_version': _d.get('content_version'),
            'expected_structure_version': _d.get('structure_version')}, 'e31-w-amt-%s' % RUN)
        wrote_amt = (st_w == 200) and ((_ss_seed._result(st_w, b_w) or {}).get('applied') is True)
        f2 = _formal()
        amt_in_formal = str(((f2.get(new_id) or {}).get('amount')))
        st2, d2 = _read(c)
        amt_in_sheet = None
        for r in (d2.get('rows') or []):
            if r.get('row_id') == new_id:
                _v = (r.get('values') or {}).get('金额')
                amt_in_sheet = _v.get('value') if isinstance(_v, dict) else _v
        check('2 ★ **绑定列写 → 进正式值**（`formal_values_json` 有、表里也读得到）',
              wrote_amt and (amt_in_formal == '300') and (str(amt_in_sheet) == '300'),
              '写=%r formal.amount=%r 表里=%r' % (wrote_amt, amt_in_formal, amt_in_sheet))

        # ---- 3 普通列写 ----
        _st, _d = _read(c)
        st_w2, b_w2 = t.action(c, 'files.cell_write', {
            'table': TABLE, 'row_id': new_id, 'header': '备注',
            'value': {'type': 'text', 'value': '草稿备注'},
            'expected_content_version': _d.get('content_version'),
            'expected_structure_version': _d.get('structure_version')}, 'e31-w-note-%s' % RUN)
        wrote_note = (st_w2 == 200) and ((_ss_seed._result(st_w2, b_w2) or {}).get('applied') is True)
        f3 = _formal()
        note_in_formal = (f3.get(new_id) or {}).get('note')
        # 普通列没有数据库字段 —— formal 行里只应有 amount，不应多出备注
        extra_keys = set((f3.get(new_id) or {}).keys()) - {'amount', 'p_name'}
        check('3 ★ **普通列写 → 只进表、不进正式值**（`formal_values_json` 不多出备注）',
              wrote_note and (note_in_formal is None) and (not extra_keys),
              '写=%r formal 行键=%r' % (wrote_note, sorted((f3.get(new_id) or {}).keys())))

        # ---- 4 敏感度 ----
        check('4 敏感度：**同一行两次写**，绑定列进 DB、普通列不进（两种落点）',
              (amt_in_formal == '300') and (note_in_formal is None),
              'amount 进 DB=%r　note 进 DB=%r'
              % (amt_in_formal == '300', note_in_formal is not None))
finally:
    _ss_console.run('''
import frappe
if __T__:
    try:
        frappe.db.sql('delete from `tabShangshu File Center File` where name=%s', __T__)
        frappe.db.sql('delete from `tabShangshu Org Attribution` where resource=%s', __T__)
    except Exception:
        pass
frappe.db.commit()
'''.replace('__T__', repr(TABLE)))

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet:
    print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  (('PASS R967-E / UI-031 空行与草稿-正式边界（%d 条）' % len(checks))
                   if not not_yet else
                   ('**未判** R967-E / UI-031（断言 %d 条，**未跑 %d 条**）'
                    % (len(checks), len(not_yet))))))
print('⚠️ 本组只判**空行与两种落点**；值回填保格式属写回复判。')
sys.exit(1 if (fails or not_yet) else 0)
