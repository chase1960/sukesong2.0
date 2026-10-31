"""R967-E · BASE967-41：**表主能预览/转移自己表的归属**（不是只有管理员能）。

**测试通过 = 下面每条成立**：

1. ★ **表主对自己建的表调 `resource_assign`（dry_run）→ 放行并回影响预览**。
2. ★ **表主真转移 → `applied=True`**，且**归属确实落了**（回读权威表，不信回执）。
3. **非表主、非管理员 → 拒**（不能因为放宽粗闸就全放）。
4. **管理员照旧能**（对照：不是把管理员那条拆了）。
5. **敏感度**：**同一份资源、两个身份**给**两种不同答案**（不恒同）。

---
**缺陷原文**（UI-104 实测，`现行基线-105项验收总表-2026-10-16.md`）：

> 「BASE967-41：**普通表主 qa-a2 经真实注册 resource_assign dry_run 被拒，管理员相同参数可预览**。
> 现行权限仅 System Manager，**与清单允许表主/管理范围内负责人不符**。归属前后相同，无实际转移。」

**代码事实**（D 2026-10-17 读代码）：

| 层 | 现在 | 问题 |
|---|---|---|
| 动作注册 `install.py:178` | `['System Manager']` | **粗闸只放管理员** |
| 函数体 `org_admin.resource_assign` | 第一行 `_manager()` | **第二道也只放管理员** |

**计划 §五 E01.5 原话**：「表主归属预览/转移**使用受管公共动作**」——
所以**动作口不变**（还是 `resource_assign`），改的是**谁能调**。

**⚠️ 修法要跟 B 的结构权那套同一形状**（`82e4ebd0`）：
**粗闸放宽到登录用户 + 函数内资源级真判**，两层都在。**只放宽粗闸不放真判 = 全放行**。

**⚠️ 本组只判「谁能调」**，不判「归属改了之后谁看得到」——
那半是 BASE967-31 / 归属投影，另判。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_e01_owner_can_assign.py
"""
import importlib.util
import json
import os
import sys

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


print('== R967-E / BASE967-41 表主能预览/转移自己表的归属 ==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)
RUN = str(os.getpid())
OWNER = 'e41-owner-%s@example.invalid' % RUN
OTHER = 'e41-other-%s@example.invalid' % RUN
PWD = 'E41-test-%s' % RUN

SEED = r'''
import frappe, json, base64, io as _io
import shangshu_files.hooks  # noqa: F401  ← console 不加载 hooks
from openpyxl import Workbook
from shangshu_core.public_api import execute_registered_action
from shangshu_core import org_admin as oa
run = __RUN__
owner, other, pwd = __OWNER__, __OTHER__, __PWD__
RESULT = {}
for em, fn in ((owner, 'E41表主'), (other, 'E41路人')):
    if not frappe.db.exists('User', em):
        frappe.get_doc({'doctype': 'User', 'email': em, 'first_name': fn,
                        'send_welcome_email': 0,
                        'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
    u = frappe.get_doc('User', em); u.new_password = pwd; u.save(ignore_permissions=True)
frappe.db.commit()
# **建完立刻核实落库** —— 建用户那步没提交时，后面登录会是 401，
# 看起来像「权限被拒」，其实是账号根本没落库（B 2026-10-17 在 3820 查出来）。
RESULT['users_landed'] = bool(frappe.db.exists('User', owner) and frappe.db.exists('User', other))
RESULT['owner_roles'] = sorted(set(frappe.get_roles(owner)))
# 表主自己上传一张表（owner=他）
wb = Workbook(); ws = wb.active; ws.title='E41'; ws.append(['a']); ws.append(['1'])
_b=_io.BytesIO(); wb.save(_b)
b64=base64.b64encode(_b.getvalue()).decode()
frappe.set_user(owner)
try:
    up = execute_registered_action('files.upload', {
        'file_name': 'E41表主表-%s.xlsx' % run, 'content_base64': b64, 'directory': '/',
        'attribution': {'level': 'personal'}},
        confirmed=True, idempotency_key='e41-up-' + run)
finally:
    frappe.set_user('Administrator')
frappe.db.commit()
RESULT['file'] = (up.get('result') or {}).get('file') or ''
RESULT['file_owner'] = frappe.db.get_value('Shangshu File Center File', RESULT['file'], 'owner') if RESULT['file'] else ''
RESULT['old_att'] = dict(oa.resource_attribution(RESULT['file'])) if RESULT['file'] else None
'''
# **开跑先清历史残留**（只删本判据前缀，保留本轮要建的）—— 靠 `finally` 不够，
# 中途失败时它跑不到，留下的账号会害下一轮 401（B 2026-10-17 在 3820 实撞）。
_purged = _ss_console.purge_users('e41-', keep=(OWNER, OTHER))
if _purged:
    print('  （清掉历史残留账号 %d 个）' % len(_purged))

out = _ss_console.run(SEED.replace('__RUN__', repr(RUN))
                       .replace('__OWNER__', repr(OWNER))
                       .replace('__OTHER__', repr(OTHER))
                       .replace('__PWD__', repr(PWD)))
TABLE = out.get('file') or ''
print('  表主=%s 角色=%r 表=%r 现归属=%r err=%r'
      % (OWNER, out.get('owner_roles'), TABLE, out.get('old_att'), out.get('__error__')))

owner_cli = other_cli = None
try:
    try:
        owner_cli = t.Client(BASE); owner_cli.login(OWNER, PWD)
        other_cli = t.Client(BASE); other_cli.login(OTHER, PWD)
    except Exception as e:
        print('  （合成账号登录失败：%s）' % str(e)[:80])

    ok_seed = (bool(TABLE) and out.get('file_owner') == OWNER
               and out.get('users_landed') is True)
    check('0 前置·真表主（只有 Desk User）建了自己的表', ok_seed,
          'err=%r file_owner=%r users_landed=%r owner_roles=%r'
          % (out.get('__error__'), out.get('file_owner'),
             out.get('users_landed'), out.get('owner_roles')))

    if not ok_seed or owner_cli is None:
        for lab in ('1 ★ 表主 dry_run 放行并回预览',
                    '2 ★ 表主真转移 → applied=True 且归属落库',
                    '3 非表主、非管理员 → 拒',
                    '4 对照·管理员照旧能',
                    '5 敏感度：同一资源两身份两种答案'):
            check(lab, None, '前置没造出来 —— 不判')
    else:
        # ---------- 1 表主 dry_run ----------
        st1, b1 = t.action(owner_cli, 'platform.org.resource_assign', {
            'resource': TABLE, 'level': 'department', 'department': '',
            'dry_run': True}, 'e41-dry-%s' % RUN)
        r1 = _ss_seed._result(st1, b1)
        check('1 ★ **表主 dry_run 放行并回影响预览**（UI-104 的原始反例）',
              st1 == 200 and bool(r1.get('effects') is not None or r1),
              'HTTP %s %s' % (st1, _ss_seed._err(b1)[:120]))

        # ---------- 3 非表主、非管理员 → 拒（**必须在 ② 转移之前**）----------
        # ⚠️ **判据顺序栽过**：② 会把表转给 `OTHER`，**他就成了归属人**，
        # 再拿他测「非表主」自然放行 —— **红的是判据顺序，不是产品**。
        st3, b3 = t.action(other_cli, 'platform.org.resource_assign', {
            'resource': TABLE, 'level': 'personal', 'owner_user': OTHER}, 'e41-deny-%s' % RUN)
        rej3, msg3 = _ss_seed.rejected(st3, b3)
        check('3 **非表主、非管理员 → 拒**（放宽粗闸不等于全放；**在转移之前测**）', rej3,
              'HTTP %s %s' % (st3, msg3[:120]))

        # ---------- 2 表主真转移 ----------
        # **转移到「个人：路人」** —— 回读权威表坐实，不信回执。
        st2, b2 = t.action(owner_cli, 'platform.org.resource_assign', {
            'resource': TABLE, 'level': 'personal', 'owner_user': OTHER}, 'e41-move-%s' % RUN)
        r2 = _ss_seed._result(st2, b2)
        landed = _ss_console.run(
            'import frappe\n'
            'from shangshu_core import org_admin as oa\n'
            'RESULT["att"] = dict(oa.resource_attribution(%r) or {})\n' % TABLE)
        att_now = (landed or {}).get('att') or {}
        check('2 ★ **表主真转移 → `applied=True` 且归属确实落库**（回读权威表，不信回执）',
              st2 == 200 and r2.get('applied') is True
              and str(att_now.get('owner_user') or '').lower() == OTHER.lower(),
              'HTTP %s applied=%r 回读=%r %s'
              % (st2, r2.get('applied'), att_now, _ss_seed._err(b2)[:90]))

        # ---------- 4 对照·管理员 ----------
        st4, b4 = t.action(c, 'platform.org.resource_assign', {
            'resource': TABLE, 'level': 'personal', 'owner_user': OWNER, 'dry_run': True},
            'e41-admin-%s' % RUN)
        check('4 **对照·管理员照旧能**（不是把管理员那条拆了）', st4 == 200,
              'HTTP %s %s' % (st4, _ss_seed._err(b4)[:110]))

        # ---------- 5 敏感度 ----------
        check('5 敏感度：**同一资源、两个身份**给**两种不同答案**（不恒同）',
              (st1 == 200) and rej3,
              '表主 HTTP %s　路人 HTTP %s' % (st1, st3))
finally:
    _ss_console.run(
        'import frappe\n'
        'for _em in (__OWNER__, __OTHER__):\n'
        '    try:\n'
        '        frappe.db.sql("delete from `tabUser` where email=%s", _em)\n'
        '    except Exception:\n'
        '        pass\n'
        'try:\n'
        '    frappe.db.sql("delete from `tabShangshu Org Attribution` where resource=%s", __TBL__)\n'
        '    frappe.db.sql("delete from `tabShangshu File Center File` where name=%s", __TBL__)\n'
        'except Exception:\n'
        '    pass\n'
        'frappe.db.commit()\n'
        'RESULT["cleaned"] = True\n'
        .replace('__OWNER__', repr(OWNER)).replace('__OTHER__', repr(OTHER))
        .replace('__TBL__', repr(TABLE)))

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet:
    print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  (('PASS R967-E / BASE967-41（%d 条）—— 表主能预览/转移，非表主仍拒' % len(checks))
                   if not not_yet else
                   ('**未判** R967-E / BASE967-41（断言 %d 条，**未跑 %d 条**）'
                    % (len(checks), len(not_yet))))))
print('⚠️ 本组只判**谁能调**；「归属改了之后谁看得到」另判（BASE967-31）。')
sys.exit(1 if (fails or not_yet) else 0)
