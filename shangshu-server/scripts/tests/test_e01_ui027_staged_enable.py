"""R967-E · UI-027：晋升定义的**分阶段「检查 → 启用」通道**（启用期间修改与旧提案）。

**为什么有这条**（验收总表 UI-027 BLOCKED 原文）：

> 「UI023所需分阶段检查/启用通道在当前入口缺失，定义版本2明确不支持，因此无法安排
> **『检查后改源表→启用重验→旧提案』**的真实UI阶段。既有结构版本检查不替代该链。」

产品契约（`处理契约与状态转换.md:111`）：「首次创建模型、建字段、数据回填、应用发布、
映射启用不是现成的单一数据库事务……**实施必须分阶段留状态，启用前核对期间变化**」。

**测试通过 = 下面每条成立**：

1. ★ **分阶段检查**：`files.promotion_define` 带 `dry_run: true` → 回**预检结论 +
   `check_token`**，且**一个字节不动**（`formal_values_json` 空、`promotion` 未启用）。
2. **预检不过也分阶段拒**：历史值违反规则（`min`）时 dry_run **拒**并点名「预检不过」——
   同整批拒口径（UI-023 四步之一）。
3. ★ **期间改动检测**：检查后**改源表**（写一格）→ 带**旧 `check_token`** 正式启用 →
   **拒**（点名「检查后源表有改动」），**仍未启用**（formal 空、promotion 不在）。
4. ★ **重检后启用**：再检查拿新 token → 正式启用 → **成功**（历史值进
   `formal_values_json`、`promotion` 落库、读回 `promoted: true`）。
5. **旧值不静默套用**：检查/创建时合法的旧值，在**规则收紧后的定义**下走写入 →
   **被字段规则拒**（应用时重验，旧提案不能拿旧结论硬套）。
   （提案侧「版本闩」若缺失属跨域缺口，判据只验写入侧重验这一半。）
6. **敏感度**：同一表「期间改过 / 没改」的 token 给**两种不同答案**（不恒同）。

---
**口径依据**：
- UI-023 首次晋升四步生命周期（预检→迁移→启用→失败恢复）是**原子**那条；
  本组是它前面的**分阶段**通道（先看再改、期间漂移要认出来）。
- `expected_structure_version` 那道闩**不替代**本链（验收原文）——它只对「表头改过」敏感，
  对「检查后写了一格值」不敏感。

用法：
  export SS_BASE=http://127.0.0.1:3850 SS_CONTAINER=shangshu-local-r967-frappe-1
  python3 shangshu-server/scripts/tests/test_e01_ui027_staged_enable.py
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
        print('  ~ %s%s' % (label, ('　—　' + str(detail)[:190]) if detail else ''))
        return False
    if not valid:
        fails.append(label)
    print('  %s %s%s' % ('✓' if valid else '✗', label,
                         ('　—　' + str(detail)[:190]) if detail else ''))
    return bool(valid)


def result_of(st, body):
    return _ss_seed._result(st, body)


def _err(body):
    return _ss_seed._err(body)


print('== R967-E / UI-027 分阶段检查→启用通道 ==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)
RUN = str(os.getpid())

# 带历史值的混合表：金额列晋升（min:0），备注普通列。**首建不带定义** ——
# 定义由本用例的分阶段通道来立（检查 → 启用），不走夹具的一把梭。
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = 'S'
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
    'file_name': 'E27分阶段-%s.xlsx' % run, 'content_base64': __B64__,
    'directory': '/', 'attribution': {'level': 'personal', 'owner_user': 'Administrator'}},
    confirmed=True, idempotency_key='e27-up-' + run)
T = (up.get('result') or {}).get('file') or ''
RESULT['table'] = T
if T:
    # 必须先解析一次：`meta.rows` 由解析填充，没解析预检看不到行（UI-023 同款坑）
    from shangshu_files import sheet as _sheet
    _sheet.read_payload('files.sheet_read', {'table': T}, None)
    meta = json.loads(frappe.db.get_value('Shangshu File Center File', T, 'sheet_meta_json') or '{}')
    RESULT['sv'] = int(meta.get('structure_version') or 1)
    RESULT['cv'] = int(meta.get('content_version') or 0)
    RESULT['formal'] = frappe.db.get_value('Shangshu File Center File', T, 'formal_values_json')
    RESULT['promo'] = bool((meta.get('promotion') or {}).get('columns'))
frappe.db.commit()
'''

out = _ss_console.run(SEED.replace('__RUN__', repr(RUN)).replace('__B64__', repr(B64)))
TABLE = out.get('table') or ''
SV = int(out.get('sv') or 1)
CV = int(out.get('cv') or 0)
print('  表=%r sv=%s cv=%s formal=%r promo=%r err=%r'
      % (TABLE, SV, CV, out.get('formal'), out.get('promo'), out.get('__error__')))

COLS_GOOD = [
    {'header': '名称', 'promoted': True, 'field': 'p_name', 'type': 'text'},
    {'header': '金额', 'promoted': True, 'field': 'amount', 'type': 'number',
     'rules': {'min': 0}},
    {'header': '备注', 'promoted': False},
]
COLS_TIGHT = json.loads(json.dumps(COLS_GOOD))
for _c in COLS_TIGHT:
    if _c.get('header') == '金额':
        _c['rules'] = {'min': 1000}          # 收紧：150 变非法


def _meta_state():
    r = _ss_console.run('''
import json, frappe
m = json.loads(frappe.db.get_value('Shangshu File Center File', __T__, 'sheet_meta_json') or '{}')
RESULT['promo'] = bool((m.get('promotion') or {}).get('columns'))
RESULT['staging'] = bool(m.get('promotion_staging'))
RESULT['formal'] = frappe.db.get_value('Shangshu File Center File', __T__, 'formal_values_json') or ''
'''.replace('__T__', repr(TABLE)))
    return r or {}


try:
    ok_seed = bool(TABLE) and not out.get('promo')
    check('0 前置·**未晋升**的混合表（带历史值 150）建出来了', ok_seed,
          'table=%r promo=%r err=%r' % (bool(TABLE), out.get('promo'), out.get('__error__')))

    if not ok_seed:
        for lab in ('1 ★ dry_run 检查回 check_token 且不落库',
                    '2 预检不过 → dry_run 也拒',
                    '3 ★ 期间改源表 → 旧 token 启用被拒',
                    '4 ★ 重检后启用成功',
                    '5 旧值在收紧规则下写入被字段规则拒',
                    '6 敏感度：改过/没改两种答案'):
            check(lab, None, '前置没造出来 —— 不判')
    else:
        # ---------- 1 分阶段检查（dry_run）----------
        st1, b1 = t.action(c, 'files.promotion_define', {
            'table': TABLE, 'expected_structure_version': SV, 'dry_run': True,
            'definition': {'definition_version': 1, 'columns': COLS_GOOD}}, 'e27-check-%s' % RUN)
        r1 = result_of(st1, b1) or {}
        token = r1.get('check_token') or (r1.get('lifecycle') or {}).get('check_token') or ''
        life1 = r1.get('lifecycle') or {}
        st_after1 = _meta_state()
        untouched = not st_after1.get('promo') and not (st_after1.get('formal') or '').strip().strip('{}')
        check('1 ★ **分阶段检查**：dry_run 回预检结论 + `check_token`，**一个字节不动**',
              st1 == 200 and bool(token) and untouched
              and str(life1.get('precheck') or '') in ('checked', 'staged', 'ok', 'no-new-promoted-columns'),
              'HTTP %s token=%r precheck=%r 启用了吗=%r formal=%r %s'
              % (st1, token[:24], life1.get('precheck'), st_after1.get('promo'),
                 bool((st_after1.get('formal') or '').strip().strip('{}')), _err(b1)[:80]))

        # ---------- 2 预检不过 → dry_run 也拒 ----------
        st2, b2 = t.action(c, 'files.promotion_define', {
            'table': TABLE, 'expected_structure_version': SV, 'dry_run': True,
            'definition': {'definition_version': 1, 'columns': COLS_TIGHT}}, 'e27-check-bad-%s' % RUN)
        rej2, msg2 = _ss_seed.rejected(st2, b2)
        check('2 **预检不过 → 分阶段检查也拒**（点名「预检不过」）',
              rej2 and ('预检不过' in msg2),
              'HTTP %s %s' % (st2, msg2[:140]))

        # ---------- 3 期间改源表 → 旧 token 启用被拒 ----------
        st_w, b_w = t.action(c, 'files.cell_write', {
            'table': TABLE, 'row_id': (result_of(*t.service(c, 'files.sheet_read', {'table': TABLE}))
                                       or {}).get('rows', [{}])[0].get('row_id'),
            'header': '备注', 'value': {'type': 'text', 'value': '期间改过'},
            'expected_content_version': (result_of(*t.service(c, 'files.sheet_read', {'table': TABLE}))
                                         or {}).get('content_version'),
            'expected_structure_version': SV}, 'e27-drift-%s' % RUN)
        drifted_write = (st_w == 200)
        st3, b3 = t.action(c, 'files.promotion_define', {
            'table': TABLE, 'expected_structure_version': SV,
            'check_token': token,
            'definition': {'definition_version': 1, 'columns': COLS_GOOD}}, 'e27-enable-stale-%s' % RUN)
        rej3, msg3 = _ss_seed.rejected(st3, b3)
        st_after3 = _meta_state()
        check('3 ★ **期间改动检测**：改源表后带旧 token 启用 → 拒（点名「检查后源表有改动」）且仍未启用',
              drifted_write and rej3 and ('检查后源表有改动' in msg3)
              and not st_after3.get('promo'),
              '改写=%s HTTP %s %s 启用了吗=%r'
              % (drifted_write, st3, msg3[:120], st_after3.get('promo')))

        # ---------- 4 重检 → 启用 ----------
        st1b, b1b = t.action(c, 'files.promotion_define', {
            'table': TABLE, 'expected_structure_version': SV, 'dry_run': True,
            'definition': {'definition_version': 1, 'columns': COLS_GOOD}}, 'e27-recheck-%s' % RUN)
        r1b = result_of(st1b, b1b) or {}
        token2 = r1b.get('check_token') or (r1b.get('lifecycle') or {}).get('check_token') or ''
        st4, b4 = t.action(c, 'files.promotion_define', {
            'table': TABLE, 'expected_structure_version': SV,
            'check_token': token2,
            'definition': {'definition_version': 1, 'columns': COLS_GOOD}}, 'e27-enable-%s' % RUN)
        r4 = result_of(st4, b4) or {}
        st_after4 = _meta_state()
        readback_ok = False
        try:
            st_pd, b_pd = t.service(c, 'files.promotion_definition', {'table': TABLE})
            readback_ok = bool((result_of(st_pd, b_pd) or {}).get('promoted'))
        except Exception:
            readback_ok = False
        check('4 ★ **重检后启用**：新 token 启用成功（历史值迁移、promotion 落库、promoted:true）',
              st4 == 200 and bool(token2) and st_after4.get('promo') is True and readback_ok
              and bool((st_after4.get('formal') or '').strip().strip('{}')),
              'HTTP %s token=%r promo=%r formal=%r 读回promoted=%r %s'
              % (st4, token2[:24], st_after4.get('promo'),
                 bool((st_after4.get('formal') or '').strip().strip('{}')), readback_ok,
                 _err(b4)[:80]))

        # ---------- 5 旧值在「定义升级（收紧规则）」后写入 → 字段规则拒 ----------
        # UI-027 的第四环「旧提案/旧值不静默套用」：150 在旧定义（min:0）下合法，
        # **定义升级**到 min:1000 后，把旧值再写一遍 → 应用时**重验字段规则**当场拒
        # （b01 第 5 条「撤回写回旧值」同族闸）。先升级定义（原子路径，不需要 token）。
        st_up, b_up = t.action(c, 'files.promotion_define', {
            'table': TABLE, 'expected_structure_version': SV,
            'definition': {'definition_version': 1, 'columns': COLS_TIGHT}}, 'e27-upgrade-%s' % RUN)
        upgraded = (st_up == 200)
        st5, b5 = t.action(c, 'files.cell_write', {
            'table': TABLE, 'row_id': (result_of(*t.service(c, 'files.sheet_read', {'table': TABLE}))
                                       or {}).get('rows', [{}])[0].get('row_id'),
            'header': '金额', 'value': {'type': 'number', 'value': 150},
            'expected_content_version': (result_of(*t.service(c, 'files.sheet_read', {'table': TABLE}))
                                         or {}).get('content_version'),
            'expected_structure_version': SV}, 'e27-oldvalue-%s' % RUN)
        rej5, msg5 = _ss_seed.rejected(st5, b5)
        by_rule = any(w in msg5 for w in ('不能小于', '不能大于', '须为', '无效', '规则', '不符合'))
        check('5 **旧值不静默套用**：定义升级收紧（min:0→1000）后写旧值 150 → **字段规则拒**（应用时重验）',
              upgraded and rej5 and by_rule,
              '升级=%s HTTP %s 拦因=%s %s' % (upgraded, st5, '字段规则' if by_rule else '？', msg5[:110]))

        # ---------- 6 敏感度 ----------
        check('6 敏感度：**同一表**「检查后改过」拒、「重检没改」过（token 两种答案）',
              rej3 and (st4 == 200),
              '旧token=%s　新token=%s' % ('拒' if rej3 else '过', '过' if st4 == 200 else '拒'))
finally:
    if TABLE:
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
                  (('PASS R967-E / UI-027 分阶段检查→启用（%d 条）' % len(checks))
                   if not not_yet else
                   ('**未判** R967-E / UI-027（断言 %d 条，**未跑 %d 条**）'
                    % (len(checks), len(not_yet))))))
print('⚠️ 本组只判**分阶段检查/启用与期间漂移**；提案侧版本闩缺失属跨域交接项。')
sys.exit(1 if (fails or not_yet) else 0)
