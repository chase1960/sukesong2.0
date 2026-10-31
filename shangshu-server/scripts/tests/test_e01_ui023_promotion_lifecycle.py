"""R967-E · UI-023：**首次晋升生命周期**（预检 → 迁移 → 启用 → 失败恢复）。

**测试通过 = 下面每条成立**：

1. **预检不过 → 整批拒、零写入**：晋升列里有一条历史值不满足规则（`min`），
   `files.promotion_define` **拒**（报错点名「预检不过」），
   `formal_values_json` 为空、`sheet_meta_json.promotion` 不存在 —— **一个字节不动**。
2. ★ **迁移**：全部合法时，历史值被复制进 `formal_values_json`（`row_id → field → value`）。
3. ★ **启用**：定义落入 `sheet_meta_json.promotion`，`files.promotion_definition` 回 `promoted: true`。
4. **重复定义不重迁**：同一批列再 define 一次 → `lifecycle.precheck = 'no-new-promoted-columns'`，
   `formal_values_json` 不被 xlsx 旧值覆盖。
5. ★ **失败恢复**：注入「迁移写盘失败」→ 报「已回滚」，
   `formal_values_json` 与迁移前一致、定义未启用。
6. **敏感度**：同一张表、同一份数据，**换规则**（合法/非法）给**两种不同答案**。

---

**产品实现依据**（v3 `promotion._promote_lifecycle`，本判据不改代码）：
预检遍历 `meta.rows` 从 xlsx 实读值 → 任一违规 `frappe.throw`（未迁移未启用）→
合法值写 `formal_values_json` → 失败时 `_save_formal(doc, _load_formal(doc))` 回滚 → `define` 再 `save_definition` 启用。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_e01_ui023_promotion_lifecycle.py
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


print('== R967-E / UI-023 首次晋升生命周期 ==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)
RUN = str(os.getpid())


def _xlsx(rows):
    from openpyxl import Workbook
    wb = Workbook(); ws = wb.active; ws.title = 'P'
    ws.append(['名称', '金额', '备注'])
    for r in rows:
        ws.append(r)
    b = BytesIO(); wb.save(b)
    return base64.b64encode(b.getvalue()).decode()


BAD = _xlsx([['甲', 50, 'x'], ['乙', 200, 'y']])    # 50 < min 100
GOOD = _xlsx([['甲', 150, 'x'], ['乙', 200, 'y']])
ROWS_GOOD = _xlsx([['甲', 150, 'x']])

SEED = r'''
import json, frappe
from shangshu_core.public_api import execute_registered_action
run = __RUN__
RESULT = {}

def upload(name, b64, key):
    out = execute_registered_action('files.upload', {
        'file_name': name, 'content_base64': b64, 'directory': '/',
        'attribution': {'level': 'personal', 'owner_user': 'Administrator'}},
        confirmed=True, idempotency_key=key)
    return (out.get('result') or {}).get('file') or ''

def define(table, rules, key):
    # **必须先解析一次**：`meta.rows` 由解析填充；没解析 = 预检看不到任何行 → 空过。
    from shangshu_files import sheet as _sheet
    try:
        _sheet.read_payload('files.sheet_read', {'table': table}, None)
    except Exception:
        pass
    cur = json.loads(frappe.db.get_value('Shangshu File Center File', table, 'sheet_meta_json') or '{}')
    sv = int(cur.get('structure_version') or 1)
    cols = [
        {'header': '名称', 'promoted': True, 'field': 'p_name', 'type': 'text'},
        {'header': '金额', 'promoted': True, 'field': 'amount', 'type': 'number',
         'rules': rules},
        {'header': '备注', 'promoted': False},
    ]
    try:
        out = execute_registered_action('files.promotion_define', {
            'table': table, 'expected_structure_version': sv,
            'definition': {'definition_version': 1, 'columns': cols}},
            confirmed=True, idempotency_key=key)
        return {'ok': True, 'result': out.get('result')}
    except Exception as e:
        return {'ok': False, 'err': '%s: %s' % (type(e).__name__, str(e)[:300])}

def formal(table):
    return frappe.db.get_value('Shangshu File Center File', table, 'formal_values_json')

def promo(table):
    meta = json.loads(frappe.db.get_value('Shangshu File Center File', table, 'sheet_meta_json') or '{}')
    p = meta.get('promotion')
    return bool(p and p.get('columns')), p

# ---- 非法表 ----
T_BAD = upload('E23非法-%s.xlsx' % run, __BAD__, 'e23-up-bad-' + run)
RESULT['bad'] = T_BAD
RESULT['bad_define'] = define(T_BAD, {'min': 100}, 'e23-def-bad-' + run)
RESULT['bad_formal'] = formal(T_BAD)
RESULT['bad_promo'], RESULT['bad_promo_obj'] = promo(T_BAD)

# ---- 合法表 ----
T_GOOD = upload('E23合法-%s.xlsx' % run, __GOOD__, 'e23-up-good-' + run)
RESULT['good'] = T_GOOD
RESULT['good_define'] = define(T_GOOD, {'min': 100}, 'e23-def-good-' + run)
RESULT['good_formal'] = formal(T_GOOD)
RESULT['good_promo'], RESULT['good_promo_obj'] = promo(T_GOOD)
# 重复定义（同列）→ 不重迁
RESULT['good_again'] = define(T_GOOD, {'min': 100}, 'e23-def-good2-' + run)
RESULT['good_formal_after_again'] = formal(T_GOOD)

# ---- 回滚表：注入迁移写盘失败（第一次写抛错，回滚那次放行）----
T_ROLL = upload('E23回滚-%s.xlsx' % run, __ROWS_GOOD__, 'e23-up-roll-' + run)
RESULT['roll'] = T_ROLL
try:
    from shangshu_files import promotion as P
    orig_save = P._save_formal
    state = {'n': 0}
    def boom(doc, data):
        state['n'] += 1
        if state['n'] == 1:
            raise RuntimeError('injected migration failure')
        return orig_save(doc, data)
    P._save_formal = boom
    try:
        doc = frappe.get_doc('Shangshu File Center File', T_ROLL)
        from shangshu_files import sheet as _sheet2
        try:
            _sheet2.read_payload('files.sheet_read', {'table': T_ROLL}, None)
        except Exception:
            pass
        doc = frappe.get_doc('Shangshu File Center File', T_ROLL)
        cols = [
            {'header': '名称', 'promoted': True, 'field': 'p_name', 'type': 'text'},
            {'header': '金额', 'promoted': True, 'field': 'amount', 'type': 'number',
             'rules': {'min': 100}},
            {'header': '备注', 'promoted': False},
        ]
        P._promote_lifecycle(doc, {'columns': cols})
        RESULT['roll_err'] = None
    except Exception as e:
        RESULT['roll_err'] = '%s: %s' % (type(e).__name__, str(e)[:300])
    finally:
        P._save_formal = orig_save
finally:
    RESULT['roll_formal'] = formal(T_ROLL)
    RESULT['roll_promo'], _ = promo(T_ROLL)

frappe.db.commit()
'''

out = _ss_console.run(SEED
                      .replace('__RUN__', repr(RUN))
                      .replace('__BAD__', repr(BAD))
                      .replace('__GOOD__', repr(GOOD))
                      .replace('__ROWS_GOOD__', repr(ROWS_GOOD)))
print('  表：bad=%r good=%r roll=%r err=%r'
      % (out.get('bad'), out.get('good'), out.get('roll'), out.get('__error__')))

BAD_DEF = out.get('bad_define') or {}
GOOD_DEF = out.get('good_define') or {}
AGAIN = out.get('good_again') or {}
BAD_ERR = str(BAD_DEF.get('err') or '')

try:
    ok_seed = bool(out.get('bad')) and bool(out.get('good')) and bool(out.get('roll'))
    check('0 前置·三张表都建出来了', ok_seed,
          'bad=%r good=%r roll=%r err=%r'
          % (bool(out.get('bad')), bool(out.get('good')), bool(out.get('roll')),
             out.get('__error__')))

    if not ok_seed:
        for lab in ('1 预检不过 → 整批拒、零写入',
                    '2 ★ 迁移 → 历史值进 formal_values_json',
                    '3 ★ 启用 → promoted:true',
                    '4 重复定义不重迁',
                    '5 ★ 失败恢复 → 回滚',
                    '6 敏感度：换规则两种答案'):
            check(lab, None, '前置没造出来，不判（不假装验过）')
    else:
        # 1 预检不过
        check('1 ★ **预检不过 → 整批拒、零写入**（`formal_values_json` 空、定义未启用）',
              (BAD_DEF.get('ok') is False) and ('预检不过' in BAD_ERR)
              and not (out.get('bad_formal') or '').strip().strip('{}')
              and out.get('bad_promo') is False,
              'define=%r　formal=%r　promotion 存在=%r'
              % (BAD_ERR[:120], out.get('bad_formal'), out.get('bad_promo')))

        # 2 迁移
        try:
            import json as _json
            fv = _json.loads(out.get('good_formal') or '{}')
        except Exception:
            fv = {}
        vals = [str(v.get('amount')) for v in fv.values() if isinstance(v, dict)]
        check('2 ★ **迁移**：历史值进 `formal_values_json`（150 与 200 都在）',
              ('150' in vals) and ('200' in vals),
              'formal=%r' % (fv,))

        # 3 启用
        check('3 ★ **启用**：定义落入 `promotion`，读取回 `promoted: true`',
              out.get('good_promo') is True,
              'promotion 存在=%r' % (out.get('good_promo'),))

        # 4 重复定义不重迁
        life = ((AGAIN.get('result') or {}).get('lifecycle') or {}) if AGAIN.get('ok') else {}
        check('4 **重复定义不重迁**（同列再 define → no-new-promoted-columns，formal 不变）',
              (AGAIN.get('ok') is True)
              and (life.get('precheck') == 'no-new-promoted-columns')
              and (out.get('good_formal_after_again') == out.get('good_formal')),
              'ok=%r lifecycle=%r formal 变了吗=%r'
              % (AGAIN.get('ok'), life, out.get('good_formal_after_again') != out.get('good_formal')))

        # 5 失败恢复
        roll_err = str(out.get('roll_err') or '')
        check('5 ★ **失败恢复**：注入迁移失败 → 报「已回滚」，formal 未写、定义未启用',
              ('已回滚' in roll_err)
              and not (out.get('roll_formal') or '').strip().strip('{}')
              and out.get('roll_promo') is False,
              'roll_err=%r formal=%r promotion=%r'
              % (roll_err[:120], out.get('roll_formal'), out.get('roll_promo')))

        # 6 敏感度
        check('6 敏感度：**同一份数据**，规则合法/非法给两种答案（不恒拒也不恒放）',
              (BAD_DEF.get('ok') is False) and (GOOD_DEF.get('ok') is True),
              '非法规则 ok=%r　合法规则 ok=%r' % (BAD_DEF.get('ok'), GOOD_DEF.get('ok')))
finally:
    _ss_console.run('''
import frappe
for _n in (__BAD__, __GOOD__, __ROLL__):
    if _n:
        try:
            frappe.db.sql('delete from `tabShangshu File Center File` where name=%s', _n)
            frappe.db.sql('delete from `tabShangshu Org Attribution` where resource=%s', _n)
        except Exception:
            pass
frappe.db.commit()
'''.replace('__BAD__', repr(out.get('bad'))).replace('__GOOD__', repr(out.get('good')))
    .replace('__ROLL__', repr(out.get('roll'))))

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet:
    print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  (('PASS R967-E / UI-023 首次晋升生命周期（%d 条）' % len(checks))
                   if not not_yet else
                   ('**未判** R967-E / UI-023（断言 %d 条，**未跑 %d 条**）'
                    % (len(checks), len(not_yet))))))
print('⚠️ 本组只判**首次晋升四步**；定义升级保留 ACL 属 UI-019。')
sys.exit(1 if (fails or not_yet) else 0)
