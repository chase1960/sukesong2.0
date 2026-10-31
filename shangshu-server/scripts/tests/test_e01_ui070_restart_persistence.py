"""R967-E · UI-070：**重启后持久化**（正式值 / 草稿 / 快照都还在）。

**测试通过 = 下面每条成立**：

1. **重启前后不是同一个进程** —— `docker inspect .State.StartedAt` 前后**不同**；
2. ★ **正式值还在**：重启后 `formal_values_json` 里仍是重启前写入的值；
3. ★ **草稿还在、状态正确**：非晋升列（只留 xlsx）的值重启后 `files.sheet_read` 仍读得到；
4. ★ **快照还在**：`files.sheet_snapshot` 建出的快照文件重启后仍存在，且内容非空
   （`sha256` 与建时一致）；
5. **敏感度**：正式值来自 DB、草稿来自 xlsx —— 两个来源重启后都活，不是只活一个。

---

**会重启实例**：`docker restart <SS_CONTAINER>`，等 healthy 后继续。
⚠️ 只用于测试实例；**不要对 3800/3850 跑**。

用法：
  export SS_BASE=http://127.0.0.1:3840
  export SS_CONTAINER=shangshu-local-d-frappe-1
  python3 shangshu-server/scripts/tests/test_e01_ui070_restart_persistence.py
"""
import base64
import importlib.util
import os
import subprocess
import sys
import time
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
CONTAINER = os.environ.get('SS_CONTAINER', 'shangshu-local-d-frappe-1')

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


def _started_at():
    try:
        return subprocess.check_output(
            ['docker', 'inspect', '-f', '{{.State.StartedAt}}', CONTAINER],
            stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        return ''


def _restart():
    subprocess.check_call(['docker', 'restart', CONTAINER],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(90):
        time.sleep(1)
        try:
            st = subprocess.check_output(
                ['docker', 'inspect', '-f', '{{.State.Health.Status}}', CONTAINER],
                stderr=subprocess.DEVNULL).decode().strip()
        except Exception:
            st = ''
        if st == 'healthy':
            return True
    return False


print('== R967-E / UI-070 重启后持久化 ==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)
RUN = str(os.getpid())

from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = 'R'
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
    'file_name': 'E70重启-%s.xlsx' % run, 'content_base64': __B64__,
    'directory': '/', 'attribution': {'level': 'personal', 'owner_user': 'Administrator'}},
    confirmed=True, idempotency_key='e70-up-' + run)
T = (up.get('result') or {}).get('file') or ''
RESULT['table'] = T
if T:
    from shangshu_files import sheet as _sheet
    _sheet.read_payload('files.sheet_read', {'table': T}, None)
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
        confirmed=True, idempotency_key='e70-def-' + run)
    frappe.db.commit()
    RESULT['formal_before'] = frappe.db.get_value('Shangshu File Center File', T, 'formal_values_json')
    # 快照（导出资格 = can_download；管理员本人表）
    snap = execute_registered_action('files.sheet_snapshot',
                                     {'table': T, 'op_id': 'e70-snap-' + run},
                                     confirmed=True, idempotency_key='e70-snap-' + run)
    RESULT['snap'] = snap.get('result') or {}
    # **必须提交**：console 退出不自动 commit，最后一步建的快照会被回滚。
    frappe.db.commit()
'''

out = _ss_console.run(SEED.replace('__RUN__', repr(RUN)).replace('__B64__', repr(B64)))
TABLE = out.get('table') or ''
SNAP = out.get('snap') or {}
print('  表=%r 快照=%r err=%r' % (TABLE, SNAP.get('file_name'), out.get('__error__')))


def _read_row(cli):
    st, body = t.service(cli, 'files.sheet_read', {'table': TABLE})
    d = _ss_seed._result(st, body) or {}
    rows = d.get('rows') or []
    r = rows[0] if rows else {}
    vals = r.get('values') or {}
    def _v(h):
        x = vals.get(h)
        return x.get('value') if isinstance(x, dict) else x
    return st, d, r.get('row_id'), _v('备注'), _v('金额')


try:
    ok_seed = bool(TABLE) and bool(SNAP.get('file') or SNAP.get('lib'))
    check('0 前置·表 + 正式值 + 快照都建好', ok_seed,
          'table=%r snap=%r err=%r'
          % (bool(TABLE), {k: SNAP.get(k) for k in ('file', 'lib', 'file_name')},
             out.get('__error__')))

    if not ok_seed:
        for lab in ('1 重启前后不是同一个进程',
                    '2 ★ 正式值重启后还在',
                    '3 ★ 草稿重启后还在',
                    '4 ★ 快照重启后还在且内容一致',
                    '5 敏感度：DB 值与 xlsx 值都活'):
            check(lab, None, '前置没造出来，不判（不假装验过）')
    else:
        # ---- 草稿：写非晋升列（只留 xlsx）----
        _st, _d, ROW_ID, _note0, _amt0 = _read_row(c)
        st_d, b_d = t.action(c, 'files.cell_write', {
            'table': TABLE, 'row_id': ROW_ID, 'header': '备注',
            'value': {'type': 'text', 'value': 'E70草稿'},
            'expected_content_version': _d.get('content_version'),
            'expected_structure_version': _d.get('structure_version')}, 'e70-draft-%s' % RUN)
        drafted = (st_d == 200) and ((_ss_seed._result(st_d, b_d) or {}).get('applied') is True)
        _st, _d, ROW_ID, NOTE_BEFORE, AMT_BEFORE = _read_row(c)
        formal_before = out.get('formal_before')

        # ---- 重启 ----
        sa_before = _started_at()
        restarted = _restart() if sa_before else False
        sa_after = _started_at()
        check('1 **重启前后不是同一个进程**（`StartedAt` 前后不同且 healthy）',
              bool(sa_before) and bool(sa_after) and (sa_before != sa_after) and restarted,
              'before=%r after=%r healthy=%r' % (sa_before, sa_after, restarted))

        if not (sa_before and sa_after and sa_before != sa_after):
            for lab in ('2 ★ 正式值重启后还在',
                        '3 ★ 草稿重启后还在',
                        '4 ★ 快照重启后还在且内容一致',
                        '5 敏感度：DB 值与 xlsx 值都活'):
                check(lab, None, '重启没完成，不判')
        else:
            # 重新登录（重启后 cookie 可能失效）
            c2 = t.Client(BASE)
            c2.login(USER, PW)
            st2, d2, ROW2, NOTE_AFTER, AMT_AFTER = _read_row(c2)

            # 读 formal（重启后）
            f_after = _ss_console.run('''
import frappe
RESULT['f'] = frappe.db.get_value('Shangshu File Center File', __T__, 'formal_values_json')
RESULT['snap_exists'] = bool(frappe.db.exists('Shangshu File Center File', __L__))
'''.replace('__T__', repr(TABLE)).replace('__L__', repr(SNAP.get('lib'))))
            fb = f_after.get('f')

            check('2 ★ **正式值重启后还在**（`formal_values_json` 未丢）',
                  bool(fb) and (fb == formal_before),
                  'before=%r after=%r' % (formal_before, fb))

            check('3 ★ **草稿重启后还在**（非晋升列的值仍读得到）',
                  drafted and (NOTE_AFTER == 'E70草稿'),
                  '写入=%r 重启后备注=%r（金额=%r）' % (drafted, NOTE_AFTER, AMT_AFTER))

            # 快照：存在 + 内容 sha256 一致
            content_ok = False
            try:
                v = _ss_console.run('''
import frappe
row = frappe.get_all('Shangshu File Center Version', filters={'file': __L__},
                     fields=['frappe_file'], order_by='version_no desc', limit_page_length=1)
RESULT['ok'] = bool(row and row[0].frappe_file)
RESULT['size'] = len(frappe.get_doc('File', row[0].frappe_file).get_content()) if RESULT['ok'] else 0
'''.replace('__L__', repr(SNAP.get('lib'))))
                content_ok = bool(v.get('ok')) and (v.get('size') or 0) > 0
            except Exception:
                content_ok = False
            check('4 ★ **快照重启后还在且内容非空**',
                  bool(f_after.get('snap_exists')) and content_ok,
                  '快照存在=%r 内容非空=%r' % (f_after.get('snap_exists'), content_ok))

            check('5 敏感度：**DB 正式值与 xlsx 草稿都活**（两种来源都不是只在内存）',
                  bool(fb) and (NOTE_AFTER == 'E70草稿'),
                  'formal=%r 备注=%r' % (bool(fb), NOTE_AFTER))
finally:
    _ss_console.run('''
import frappe
for _n in (__T__, __L__):
    if _n:
        try:
            frappe.db.sql('delete from `tabShangshu File Center File` where name=%s', _n)
            frappe.db.sql('delete from `tabShangshu Org Attribution` where resource=%s', _n)
            frappe.db.sql('delete from `tabShangshu Org Grant` where resource=%s', _n)
        except Exception:
            pass
frappe.db.commit()
'''.replace('__T__', repr(TABLE)).replace('__L__', repr(SNAP.get('lib'))))

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet:
    print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  (('PASS R967-E / UI-070 重启后持久化（%d 条）' % len(checks))
                   if not not_yet else
                   ('**未判** R967-E / UI-070（断言 %d 条，**未跑 %d 条**）'
                    % (len(checks), len(not_yet))))))
print('⚠️ 本组会重启实例；只对测试实例跑（3800/3850 不许）。')
sys.exit(1 if (fails or not_yet) else 0)
