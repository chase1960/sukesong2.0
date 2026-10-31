"""R967-E · 内核 `structure_allows`（**注意：本函数在候选运行面上未接线**） —— 结构权是**权限维度**，不是一个专门角色。

**用户 2026-10-17 原话**：
> 「**当然有,但这个不是一个结构,这个属于权限的一部分**」

**测试通过 = 下面每条成立**：

1. **真表主（无 System Manager、无 `Sheet Structure Editor`）→ `True`**
   —— 用户「当然有」。**本函数存在的理由**：现在的 `can_structure` 把他判成 False。
2. ★ **存量表（`attribution` 为 `None`）的表主也 → `True`**
   —— **B 2026-10-17 审出的次序问题**：若「无归属 → None」排在 owner 之前，
   存量表主**根本走不到 owner 那条**，会**丢结构权**。这条就是钉这个次序。
3. **非表主、但有 `Sheet Structure Editor` → `True`**（**保留现有角色**，不收紧）
4. **非表主、无角色、`attribution` 为 `None` → `None`**
   —— `None` 的意思是「**归属依赖那一部分**回落旧口径」，**不是**「整条判不了」。
   **函数原样返回 `None`，不擅自当 False**。
5. **非表主、无角色、有归属但不在管理人范围 → `False`**
6. **敏感度**：**同一张表、两个身份**给**两种不同答案**（不恒真/恒假）。

---
**次序（B 审定，必须照这个写）**：

```
1. 表主（resource 的 owner == user）→ True     ← 不看 attribution，存量表也成立
2. System Manager 或 Sheet Structure Editor → True
3. attribution 为 None → None                  ← 只回落「归属那半」
4. 其余 → False
```

**签名只留一个**：`structure_allows(user, resource, attribution=None)`，内部 `get_doc` 取 owner。
**不要 doc 版** —— B 原话「两套签名就是两套判法，迟早漂」。

**⚠️ 动作侧不用本组验**：`sheet.py` 的 `_require_structure(doc)` 和 12 个动作归 B；
本组**只判内核这个函数**。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_e01_structure_allows.py
"""
import importlib.util
import os
import sys

ROOT = os.environ.get('SS_ROOT',
                      '/path/to/workspace')


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT + path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_ss_console = _load('_ss_console', '/shangshu-server/scripts/tests/_ss_console.py')

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


print('== R967-E / 内核 structure_allows：结构权是权限维度 ==')

SEED = r'''
import frappe, json, base64, io as _io
# ⚠️ **`bench console` 不会自动加载 app 的 hooks**（web 请求会）——
# 属主解析器是在 `shangshu_files/hooks.py` 里注册的，console 里得**显式导入**，
# 否则 `resource_owner()` 恒回 None，看着像「次序错了」其实是**注册没跑**（实测栽过）。
import shangshu_files.hooks  # noqa: F401  ← 副作用：注册属主解析器
from openpyxl import Workbook
from shangshu_core.public_api import execute_registered_action
from shangshu_core import org_admin as oa

RESULT = {}
tag = __TAG__
owner = 'e15s-owner-%s@example.invalid' % tag
other = 'e15s-other-%s@example.invalid' % tag
role_user = 'e15s-role-%s@example.invalid' % tag

def mk(em, fn, roles):
    if not frappe.db.exists('User', em):
        frappe.get_doc({'doctype': 'User', 'email': em, 'first_name': fn,
                        'send_welcome_email': 0,
                        'roles': [{'role': r} for r in roles]}).insert(ignore_permissions=True)
    return em

mk(owner, 'E15S表主', ['Desk User'])                      # 无 SM、无结构角色
mk(other, 'E15S路人', ['Desk User'])
mk(role_user, 'E15S结构员', ['Desk User', 'Sheet Structure Editor'])
frappe.db.commit()
RESULT['roles_owner'] = sorted(set(frappe.get_roles(owner)))
RESULT['roles_role_user'] = sorted(set(frappe.get_roles(role_user)))

wb = Workbook(); ws = wb.active; ws.title = 'E15S'
ws.append(['列A']); ws.append(['v1'])
_b = _io.BytesIO(); wb.save(_b)
b64 = base64.b64encode(_b.getvalue()).decode()

# **表 A：有归属**（表主本人）
frappe.set_user(owner)
try:
    up = execute_registered_action('files.upload', {
        'file_name': 'E15S有归属-%s.xlsx' % tag, 'content_base64': b64, 'directory': '/',
        'attribution': {'level': 'personal'}},
        confirmed=True, idempotency_key='e15s-a-%s' % tag)
    RESULT['file_attr'] = (up.get('result') or {}).get('file') or ''
finally:
    frappe.set_user('Administrator')
frappe.db.commit()

# **表 B：无归属**（存量表）—— 直接建一条不带归属行的记录（模拟历史表）。
# ⚠️ 不走产品口：产品现在**新建必填归属**（用户 2026-10-15），造不出「无归属」的新表。
# 存量表是**历史**出来的，这里直插一行**只为造出那个状态**（不写产品代码）。
legacy_label = 'E15S存量无归属-%s' % tag
# ⚠️ **两条都栽过**：
#   1. **必须 `set_user(owner)` 再插** —— Frappe 的 `owner` 按**当前 session** 写，
#      显式传 `'owner': owner` 会被 session（Administrator）覆盖。
#   2. **记录主键是自动名（`rqj2907ed5`），不是 `file_name`** —— 拿 `file_name` 去
#      `get_value` 查不到，`resource_owner()` 就回 None，看着像「次序错了」其实是**查错键**。
#      **取 `insert()` 回的那个 doc 的 `.name`**。
legacy = ''
_doc = frappe.get_doc({'doctype': 'Shangshu File Center File',
                       'file_name': legacy_label + '.xlsx',
                       'directory': '/', 'status': 'Active', 'version_count': 1})
frappe.set_user(owner)
try:
    _doc.insert(ignore_permissions=True)
    legacy = _doc.name
finally:
    frappe.set_user('Administrator')
frappe.db.commit()
RESULT['legacy_owner'] = frappe.db.get_value('Shangshu File Center File', legacy, 'owner')
RESULT['file_legacy'] = legacy

def ask(user, res, att='__MISSING__'):
    try:
        if att == '__MISSING__':
            return oa.structure_allows(user, res)
        return oa.structure_allows(user, res, attribution=att)
    except AttributeError:
        return '__NO_FN__'
    except Exception as e:
        return '%s: %s' % (type(e).__name__, e)

# ---------- 老板/负责人**不自动**带结构权（B 2026-10-17 判的「收紧」）----------
# 让 `other` 成为「表主所属企业」的老板 → `_management_read_only` 会判 **True**；
# 但 `structure_allows` 必须 **False**（结构权比下载更重，管理读不该自动带）。
ent = 'E15S企业-%s' % tag
# ⚠️ **表主的 Identity 行在上传时已经建了**（`enterprise_id='default'`）——
# 用 `db.exists` 判断会**直接跳过**，于是老板的「管理读」永远判不到（实测：
# `ident_owner='default'` → `_management_read_only` 回 False → 5b 前提不成立）。
# **已有的就改，没有的才建。**
_id_name = frappe.db.get_value('Shangshu Identity', {'user': owner}, 'name')
if _id_name:
    frappe.db.set_value('Shangshu Identity', _id_name, 'enterprise_id', ent)
else:
    frappe.get_doc({'doctype': 'Shangshu Identity', 'user': owner,
                    'enterprise_id': ent}).insert(ignore_permissions=True)
if not frappe.db.exists('Shangshu Org Owner', {'enterprise_id': ent}):
    frappe.get_doc({'doctype': 'Shangshu Org Owner', 'enterprise_id': ent,
                    'user': other}).insert(ignore_permissions=True)
frappe.db.commit()
_att = oa.resource_attribution(RESULT['file_attr'])
RESULT['dbg_att'] = dict(_att) if _att else None
RESULT['dbg_owner_rows'] = [(r.user, r.enterprise_id) for r in frappe.get_all(
    'Shangshu Org Owner', fields=['user', 'enterprise_id'], limit_page_length=20)]
RESULT['dbg_ident_owner'] = frappe.db.get_value('Shangshu Identity', {'user': owner}, 'enterprise_id')
RESULT['dbg_ctx_other'] = oa.org_context(other).get('owned_enterprises')
RESULT['boss_management_read'] = bool(oa._management_read_only(other, _att))
RESULT['v_boss_structure'] = ask(other, RESULT['file_attr'])

RESULT['v_owner_attr'] = ask(owner, RESULT['file_attr'])
RESULT['v_owner_legacy'] = ask(owner, legacy)          # ← 次序问题钉在这
RESULT['v_role_user'] = ask(role_user, RESULT['file_attr'])
RESULT['v_other_legacy'] = ask(other, legacy)          # 非表主 + 无归属 → None
RESULT['v_other_attr'] = ask(other, RESULT['file_attr'])  # 非表主 + 有归属 → False
RESULT['v_admin'] = ask('Administrator', legacy)
'''

# **开跑先清历史残留**（只删本判据前缀，保留本轮要建的）—— 靠 `finally` 不够，
# 中途失败时它跑不到，留下的账号会害下一轮 401（B 2026-10-17 在 3820 实撞）。
_purged = _ss_console.purge_users('e15s-', keep=('e15s-owner-%s@example.invalid' % str(os.getpid()), 'e15s-other-%s@example.invalid' % str(os.getpid()), 'e15s-role-%s@example.invalid' % str(os.getpid())))
if _purged:
    print('  （清掉历史残留账号 %d 个）' % len(_purged))

out = _ss_console.run(SEED.replace('__TAG__', repr(str(os.getpid()))))
print('  表主角色=%r 结构员角色=%r' % (out.get('roles_owner'), out.get('roles_role_user')))
print('  存量表属主=%r（应为表主）' % (out.get('legacy_owner'),))
print('  老板诊断：att=%r owners=%r ident_owner=%r ctx_other=%r'
      % (out.get('dbg_att'), out.get('dbg_owner_rows'),
         out.get('dbg_ident_owner'), out.get('dbg_ctx_other')))
print('  判定：owner_attr=%r owner_legacy=%r role_user=%r other_legacy=%r other_attr=%r admin=%r'
      % (out.get('v_owner_attr'), out.get('v_owner_legacy'), out.get('v_role_user'),
         out.get('v_other_legacy'), out.get('v_other_attr'), out.get('v_admin')))

F_ATTR = out.get('file_attr') or ''
F_LEG = out.get('file_legacy') or ''
NO_FN = (out.get('v_owner_attr') == '__NO_FN__')

try:
    check('0 前置·造出「有归属表」与「存量无归属表」', bool(F_ATTR) and bool(F_LEG),
          'file_attr=%r file_legacy=%r err=%r' % (F_ATTR, F_LEG, out.get('__error__')))

    if NO_FN:
        for lab in ('1 真表主 → True',
                    '2 ★ 存量表（无归属）的表主也 → True（次序钉在这）',
                    '3 非表主但有 Sheet Structure Editor → True',
                    '4 非表主、无角色、无归属 → None（原样，不当 False）',
                    '5 非表主、无角色、有归属 → False',
                    '6 敏感度：同一张表两个身份两种答案'):
            check(lab, None, '**产品还没有 `structure_allows`** —— 本组**先红**（函数不存在），不假绿')
    else:
        check('1 **真表主**（无 SM、无结构角色）→ `True`（用户「当然有」）',
              out.get('v_owner_attr') is True,
              'owner_attr=%r owner_roles=%r' % (out.get('v_owner_attr'), out.get('roles_owner')))

        check('2 ★ **存量表（`attribution` 为 None）的表主也 → `True`**'
              '（B 审出的次序：owner 必须在「无归属→None」之前）',
              out.get('v_owner_legacy') is True,
              'owner_legacy=%r ← 若是 None 说明次序错了，存量表主会丢权' % (out.get('v_owner_legacy'),))

        check('3 非表主、但有 `Sheet Structure Editor` → `True`（保留现有角色，不收紧）',
              out.get('v_role_user') is True,
              'role_user=%r roles=%r' % (out.get('v_role_user'), out.get('roles_role_user')))

        check('4 非表主、无角色、`attribution` 为 `None` → **`None`**（原样返回，不当 False）',
              out.get('v_other_legacy') is None,
              'other_legacy=%r（None 语义 = 归属那半回落旧口径，不是整条判不了）'
              % (out.get('v_other_legacy'),))

        check('5 非表主、无角色、有归属 → `False`',
              out.get('v_other_attr') is False,
              'other_attr=%r' % (out.get('v_other_attr'),))

        # ★ **老板不自动带结构权**（B 2026-10-17 判的「收紧」）——
        # **决定性**：同一个人的「管理读」是 **True**，但结构权必须是 **False**。
        # 两个值不一样，才证明第 4 条**真的没走管理读那条分支**。
        check('5b ★ **老板不自动带结构权**（B 判「收紧」）——'
              ' 同一人「管理读」为 True，但 `structure_allows` 必须 False',
              out.get('boss_management_read') is True and out.get('v_boss_structure') is False,
              '管理读=%r　structure_allows=%r（两个值必须不一样）'
              % (out.get('boss_management_read'), out.get('v_boss_structure')))

        check('6 敏感度：**同一张表、两个身份**给两种不同答案（不恒真/恒假）',
              out.get('v_owner_attr') is True and out.get('v_other_attr') is False,
              '同一张表：表主=%r 非表主=%r'
              % (out.get('v_owner_attr'), out.get('v_other_attr')))
finally:
    _ss_console.run(
        'import frappe\n'
        'for _em in (__OWNER__, __OTHER__, __ROLE__):\n'
        '    try:\n'
        '        frappe.db.sql("delete from `tabUser` where email=%s", _em)\n'
        '    except Exception:\n'
        '        pass\n'
        'for _n in (__LEG__, __ATTR__):\n'
        '    if _n:\n'
        '        try:\n'
        '            frappe.db.sql("delete from `tabShangshu File Center File` where name=%s", _n)\n'
        '        except Exception:\n'
        '            pass\n'
        'try:\n'
        '    frappe.db.sql("delete from `tabShangshu Org Owner` where enterprise_id like %s", "E15S企业-%")\n'
        '    frappe.db.sql("delete from `tabShangshu Identity` where enterprise_id like %s", "E15S企业-%")\n'
        'except Exception:\n'
        '    pass\n'
        'frappe.db.commit()\n'
        'RESULT["cleaned"] = True\n'
        .replace('__OWNER__', repr('e15s-owner-%s@example.invalid' % str(os.getpid())))
        .replace('__OTHER__', repr('e15s-other-%s@example.invalid' % str(os.getpid())))
        .replace('__ROLE__', repr('e15s-role-%s@example.invalid' % str(os.getpid())))
        .replace('__LEG__', repr(F_LEG)).replace('__ATTR__', repr(F_ATTR)))

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet:
    print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  (('PASS R967-E / `structure_allows`（%d 条）—— 结构权按权限维度判，存量表主不丢权'
                    % len(checks)) if not not_yet else
                   ('**未判** R967-E / `structure_allows`（断言 %d 条，**未跑 %d 条**）'
                    % (len(checks), len(not_yet))))))
print('⚠️ 本组只判**内核函数**。**动作侧**（12 个结构动作 + `_require_structure`）归 B，本组不判。')
sys.exit(1 if (fails or not_yet) else 0)
