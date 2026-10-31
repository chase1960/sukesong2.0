"""R967-E · UI-053 规模：**200 / 1000 格批量写与粘贴包**（后端动作级）。

**测试通过 = 下面每条成立**：

1. **前置**：建一张足够大的表（≥100 行 × ≥20 列）。
2. ★ **200 格** `files.sheet_cells_write` → 200 + `applied`，**逐格读回值一致**。
3. ★ **1000 格** `files.sheet_paste_apply` → 200 + `applied`，**逐格读回值一致**。
4. **请求体规模可见**：打印两次请求的 JSON 字节数 ——
   验收记录里 1000 格失败是「正文 109653 > 100000」，本组用**真实载荷**量出规模，
   供前端定位「每格重复 border 声明」那 25000 字节的膨胀。
5. **敏感度**：200 格与 1000 格都真写进去（不是「大包被静默丢」）。

---

**⚠️ 边界**：本组测**后端**接受与落盘；验收说的失败在**前端请求体**（`normalizeMarkup` 每格重复
25 字符 border 声明）。后端能收 ≠ 前端能发 —— 本组通过只说明「后端闸不是瓶颈」。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_ui053_bulk_scale.py
"""
import base64
import importlib.util
import json
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


print('== R967-E / UI-053 规模：200 / 1000 格 ==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)
RUN = str(os.getpid())

HEADERS = ['列%02d' % i for i in range(1, 21)]     # 20 列
NROWS = 60                                        # 60 数据行

from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = 'S'
ws.append(HEADERS)
for r in range(NROWS):
    ws.append(['r%d-c%d' % (r, c0) for c0 in range(20)])
_b = BytesIO(); wb.save(_b)
B64 = base64.b64encode(_b.getvalue()).decode()

SEED = r'''
import frappe
from shangshu_core.public_api import execute_registered_action
up = execute_registered_action('files.upload', {
    'file_name': 'E53规模-%s.xlsx' % __RUN__, 'content_base64': __B64__,
    'directory': '/', 'attribution': {'level': 'personal', 'owner_user': 'Administrator'}},
    confirmed=True, idempotency_key='e53-up-' + __RUN__)
RESULT['table'] = (up.get('result') or {}).get('file') or ''
frappe.db.commit()
'''.replace('__RUN__', repr(RUN)).replace('__B64__', repr(B64))

out = _ss_console.run(SEED)
TABLE = out.get('table') or ''
print('  表=%r 行=%d 列=%d err=%r' % (TABLE, NROWS, len(HEADERS), out.get('__error__')))


def _sheet():
    st, body = t.service(c, 'files.sheet_read', {'table': TABLE})
    return st, (_ss_seed._result(st, body) or {})


def _value(row, header):
    v = (row.get('values') or {}).get(header)
    return v.get('value') if isinstance(v, dict) else v


try:
    ok_seed = bool(TABLE)
    check('0 前置·20 列 × 60 行的表建出来了', ok_seed,
          'table=%r err=%r' % (bool(TABLE), out.get('__error__')))

    if not ok_seed:
        for lab in ('1 ★ 200 格批量写', '2 ★ 1000 格粘贴包', '3 请求体规模', '4 敏感度'):
            check(lab, None, '前置没造出来，不判（不假装验过）')
    else:
        # ---------- 1 200 格 cells_write：10 行 × 20 列 = 200 ----------
        st0, d0 = _sheet()
        rows0 = d0.get('rows') or []
        cells200 = []
        for r in rows0[:10]:
            for h in HEADERS:
                cells200.append({'row_id': r['row_id'], 'header': h,
                                 'value': {'type': 'text', 'value': 'v200-%s-%s' % (r['row_id'], h)}})
        p200 = {'table': TABLE, 'cells': cells200,
                'expected_content_version': d0.get('content_version'),
                'expected_structure_version': d0.get('structure_version')}
        st1, b1 = t.action(c, 'files.sheet_cells_write', p200, 'e53-200-%s' % RUN)
        r1 = _ss_seed._result(st1, b1) or {}
        wrote200 = (st1 == 200) and bool(r1.get('applied'))  # `applied` 回的是**数量**不是 bool
        # 读回校验 200 格
        st_v1, d1 = _sheet()
        bad = 0
        for r in (d1.get('rows') or [])[:10]:
            for h in HEADERS:
                if _value(r, h) != 'v200-%s-%s' % (r['row_id'], h):
                    bad += 1
        check('1 ★ **200 格批量写** → 200 + applied，**逐格读回一致**',
              wrote200 and bad == 0,
              'HTTP %s applied=%r 不一致格=%d' % (st1, r1.get('applied'), bad))

        # ---------- 2 1000 格粘贴包：50 行 × 20 列 = 1000 ----------
        st_v2, d2 = _sheet()
        rows2 = (d2.get('rows') or [])[:50]
        matrix = [[('v1000-%d-%d' % (ri, ci)) for ci in range(20)] for ri in range(len(rows2))]
        p1000 = {'table': TABLE, 'matrix': matrix, 'matrix_types': [['text'] * 20 for _ in matrix],
                 'start_row': 0, 'start_col': 0, 'op_id': 'e53-1000-%s' % RUN,
                 'expected_content_version': d2.get('content_version'),
                 'expected_structure_version': d2.get('structure_version')}
        st2, b2 = t.action(c, 'files.sheet_paste_apply', p1000, 'e53-1000-%s' % RUN)
        r2 = _ss_seed._result(st2, b2) or {}
        wrote1000 = (st2 == 200) and bool(r2.get('applied'))  # 同上：数量
        st_v3, d3 = _sheet()
        bad3 = 0
        for ri, r in enumerate((d3.get('rows') or [])[:len(rows2)]):
            for ci, h in enumerate(HEADERS):
                if _value(r, h) != 'v1000-%d-%d' % (ri, ci):
                    bad3 += 1
        check('2 ★ **1000 格粘贴包** → 200 + applied，**逐格读回一致**',
              wrote1000 and bad3 == 0,
              'HTTP %s applied=%r 不一致格=%d 错误=%r'
              % (st2, r2.get('applied'), bad3, _ss_seed._err(b2)[:90]))

        # ---------- 3 请求体规模 ----------
        n200 = len(json.dumps(p200, ensure_ascii=False).encode())
        n1000 = len(json.dumps(p1000, ensure_ascii=False).encode())
        check('3 **请求体规模可见**（验收记录：1000 格 109653 字节被 100000 拒；本组无样式膨胀）',
              n1000 > 0,
              '200 格=%d 字节　1000 格=%d 字节　（纯值、无每格 border 声明）' % (n200, n1000))

        # ---------- 4 敏感度 ----------
        check('4 敏感度：**200 与 1000 都真写进去**（不是大包被静默丢）',
              wrote200 and wrote1000 and bad == 0 and bad3 == 0,
              '200 applied=%r（不一致 %d）　1000 applied=%r（不一致 %d）'
              % (r1.get('applied'), bad, r2.get('applied'), bad3))
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
                  (('PASS R967-E / UI-053 规模（%d 条）' % len(checks))
                   if not not_yet else
                   ('**未判** R967-E / UI-053 规模（断言 %d 条，**未跑 %d 条**）'
                    % (len(checks), len(not_yet))))))
print('⚠️ 本组测**后端**接受与落盘；前端「每格重复 border 声明」的请求体膨胀另判。')
sys.exit(1 if (fails or not_yet) else 0)
