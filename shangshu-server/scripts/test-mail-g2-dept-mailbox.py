#!/usr/bin/env python3
"""G2：部门邮箱**要能通过产品动作建起来**，不是只能测试直插行。

任务范围原话（共享邮箱那一条）：
  「**两个员工用各自账号进入同一个部门邮箱**；能切换个人箱和获授权的部门箱，
    共用邮件，不为每个人复制一份」

N5 交的是**进入**那半（切换器、授权、五项分权）。
**建/绑部门邮箱这半一直没有入口** —— `mail.account.configure` 只收
`provider/email/display_name/password/enabled` 五个字段，前端对 `kind`/`department`
只读不写。结果就是：真实 FDE 无从配置，只能在测试里 `frappe.get_doc(...).insert()` 直插行。
直插行不算产品能力（同 `resource_assign` 那条「不靠测试 SQL 冒充产品能力」的口径）。

测试通过 = 下面全部成立：

 1. **能建部门箱** —— `mail.account.configure` 带 `kind='department'` + `department`，
    建出来的箱 `kind`/`department` 对得上，`mailboxes()` 看得到
 2. **`kind='department'` 但没填部门 → 当场拒**（不许建一个无从归属的部门箱）
 3. **老口径不破** —— 不带 `kind` 的调用仍是个人箱（输入契约加字段，旧调用照旧）
 4. **建箱人自动成为这个箱的管理员** —— 能给别人开权限（`rights_for`：账号行属主 = 管理员）
 5. **部门字段走 `department_key` 校验** —— 空部门当场拒；受管部门表在时按 ID/唯一标题收
 6. **改归属不必重填授权码** —— 已绑定的箱改 `kind`/`department`，不带 password 也能改

跑在容器里（依赖 frappe）。**用公共跑具**，它会把公共件 `mail_fixture.py`
连着这份一起喂进容器（`require`/`hard_delete`/`ensure_user` 只留一份定义）：

  sh shangshu-server/scripts/run-mail-test.sh shangshu-server/scripts/test-mail-g2-dept-mailbox.py

⚠️ 不要再用旧的 `docker exec … python - < 本文件` 单喂 ——
   那样那几个函数找不到，跑不起来。迁过的脚本一律走跑具。

连接测试 `transport.test_connection` **打了桩** —— 本条验的是**入口与校验**，
不是 IMAP/SMTP 连通性（那条另有真凭据的测试，且不触发真实发送）。
"""
import sys
from pathlib import Path

_roots = [Path('/home/frappe/frappe-bench/apps'), Path.cwd()]
try:
    _roots.append(Path.cwd().parents[2])
except IndexError:
    pass
for _a in ('shangshu_mail', 'shangshu_core', 'shangshu_files'):
    for _r in _roots:
        _p = _r / _a
        if _p.exists() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))

import frappe
from shangshu_mail import account as account_mod
from shangshu_mail import transport as transport_mod

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

PASS, FAIL = [], []


USER = 'g2-dept@shangshu.local'
MATE = 'g2-mate@shangshu.local'
TAG = 'G2'
DEPT = 'G2 市场部'
ADDR = 'g2-shared@qq.com'   # provider_for 要求邮箱域名和服务商对得上（qq.com/foxmail.com）

# 连接测试打桩 —— 本条验入口与校验，不验 IMAP/SMTP 连通性。
transport_mod.test_connection = lambda *a, **k: None


def cleanup():
    frappe.set_user('Administrator')
    with account_mod.writing():
        # 本人个人箱的编号是 sha256(登录人)，按属主扫掉
        for row in frappe.get_all('Shangshu Mail Account', filters={'owner': USER}, pluck='name'):
            hard_delete('Shangshu Mail Account', row)
    for row in frappe.get_all('Shangshu Mail Access', filters={'user': ('in', [USER, MATE])}, pluck='name'):
        hard_delete('Shangshu Mail Access', row)
    for name in frappe.get_all('Email Account',
                               filters={'email_account_name': ('like', f'%{account_mod.account_name(USER)}%')},
                               pluck='name'):
        hard_delete('Email Account', name)
    frappe.db.commit()


def configure(payload, user=USER):
    frappe.set_user(user)
    return account_mod.execute('mail.account.configure', payload, {'source': 'user'})


ensure_user(USER)
ensure_user(MATE)
cleanup()

print('【1】能建部门箱 —— configure 带 kind/department')
try:
    configure({'provider': 'qq', 'email': ADDR, 'display_name': '共享箱',
               'password': 'stub-pass', 'enabled': True,
               'kind': 'department', 'department': DEPT})
    frappe.db.commit()
    key = account_mod.account_name(USER)
    row = frappe.db.get_value('Shangshu Mail Account', {'account_key': key},
                              ['kind', 'department', 'email_address'], as_dict=True)
    require('1 建出部门箱且 kind/department 对得上',
            bool(row) and row.kind == 'department' and row.department == DEPT
            and row.email_address == ADDR,
            f'实际 {row!r}（期望 kind=department department={DEPT!r}）')
except Exception as error:                       # noqa: BLE001
    require('1 建出部门箱且 kind/department 对得上', False, f'{type(error).__name__}: {error}')

print()
print('【2】kind=department 但没填部门 → 当场拒')
cleanup()
try:
    configure({'provider': 'qq', 'email': ADDR, 'display_name': '共享箱',
               'password': 'stub-pass', 'enabled': True, 'kind': 'department'})
    require('2 没填部门当场拒', False, '居然建出来了 —— 无从归属的部门箱就是给授权开洞')
except frappe.ValidationError as error:
    require('2 没填部门当场拒', '部门' in str(error), f'拒了但理由不像：{error}')
except Exception as error:                       # noqa: BLE001
    require('2 没填部门当场拒', False, f'抛的不是 ValidationError：{type(error).__name__}: {error}')

print()
print('【3】老口径不破 —— 不带 kind 仍是个人箱')
cleanup()
try:
    configure({'provider': 'qq', 'email': ADDR, 'display_name': '我自己',
               'password': 'stub-pass', 'enabled': True})
    frappe.db.commit()
    key = account_mod.account_name(USER)
    row = frappe.db.get_value('Shangshu Mail Account', {'account_key': key},
                              ['kind', 'department'], as_dict=True)
    require('3 不带 kind 仍是个人箱（旧调用不破）',
            bool(row) and (row.kind or 'personal') == 'personal' and not row.department,
            f'实际 {row!r}')
except Exception as error:                       # noqa: BLE001
    require('3 不带 kind 仍是个人箱（旧调用不破）', False, f'{type(error).__name__}: {error}')

print()
print('【4】建箱人自动成为管理员 —— 能给别人开权限')
try:
    key = account_mod.account_name(USER)
    rights = account_mod.rights_for(key, USER)
    require('4 建箱人是这个箱的管理员',
            all(rights.get(k) for k in account_mod.RIGHTS),
            f'实际 rights={rights}')
    account_mod.execute('mail.mailbox.grant',
                        {'mailbox': key, 'user': MATE,
                         'rights': {'read': True, 'send': False}}, {'source': 'user'})
    frappe.db.commit()
    mate = account_mod.rights_for(key, MATE)
    require('4b 能给同事开权限，且能读不等于能发',
            mate.get('read') is True and mate.get('send') is False,
            f'实际 mate rights={mate}')
except Exception as error:                       # noqa: BLE001
    require('4 建箱人是这个箱的管理员', False, f'{type(error).__name__}: {error}')

print()
print('【5】部门字段走 department_key 校验 —— 空白部门当场拒')
cleanup()
for label, dept, should_pass in (('空白', '   ', False), ('有值', DEPT, True)):
    try:
        configure({'provider': 'qq', 'email': ADDR, 'display_name': '共享箱',
                   'password': 'stub-pass', 'enabled': True,
                   'kind': 'department', 'department': dept})
        frappe.db.commit()
        require(f'5 部门字段「{label}」→ {"接受" if should_pass else "拒绝"}',
                should_pass, f'给了 {dept!r} 却没拒')
    except frappe.ValidationError:
        require(f'5 部门字段「{label}」→ {"接受" if should_pass else "拒绝"}',
                not should_pass, f'给了 {dept!r} 却被拒了')
        if should_pass:
            break
    except Exception as error:                   # noqa: BLE001
        require(f'5 部门字段「{label}」→ {"接受" if should_pass else "拒绝"}',
                False, f'{type(error).__name__}: {error}')
    cleanup()

print()
print('【6】改归属不必重填授权码 —— 已绑定的箱改 kind/department')
cleanup()
try:
    configure({'provider': 'qq', 'email': ADDR, 'display_name': '我自己',
               'password': 'stub-pass', 'enabled': True})   # 先按个人箱绑上
    frappe.db.commit()
    configure({'provider': 'qq', 'email': ADDR, 'display_name': '共享箱',
               'enabled': True,                                # **不带 password**
               'kind': 'department', 'department': DEPT})
    frappe.db.commit()
    key = account_mod.account_name(USER)
    row = frappe.db.get_value('Shangshu Mail Account', {'account_key': key},
                              ['kind', 'department'], as_dict=True)
    require('6 不带授权码也能改成部门箱',
            bool(row) and row.kind == 'department' and row.department == DEPT,
            f'实际 {row!r}')
except Exception as error:                       # noqa: BLE001
    require('6 不带授权码也能改成部门箱', False, f'{type(error).__name__}: {error}')

print()
print('【7】走**登记的动作**建部门箱（产品正门，不是直调 handler）')
# 上面几条是直调 account_mod.execute —— 验的是 handler。
# 这一条走 execute_registered_action，验的是 **schema 真的收 kind/department**
# （登记簿里 mail.account.configure@1.2.0）。不走这条，handler 通了产品那条路还是拒。
cleanup()
try:
    from shangshu_core.public_api import execute_registered_action
    frappe.set_user(USER)
    result = execute_registered_action(
        'mail.account.configure',
        {'provider': 'qq', 'email': ADDR, 'display_name': '共享箱',
         'password': 'stub-pass', 'enabled': True,
         'kind': 'department', 'department': DEPT},
        confirmed=True, source='user',
        # 幂等键要**每轮唯一** —— 动作层对成功的键返回缓存结果不再执行，
        # 而这条开头的 cleanup() 已经把行删了 → 回包 bound:True 但表里空的
        # （实测栽过一次：看着「成功」其实什么都没建）。
        idempotency_key='g2-dept-7-' + frappe.generate_hash(length=8))
    frappe.db.commit()
    key = account_mod.account_name(USER)
    row = frappe.db.get_value('Shangshu Mail Account', {'account_key': key},
                              ['kind', 'department'], as_dict=True)
    require('7 登记的动作收 kind/department，建出部门箱',
            bool(row) and row.kind == 'department' and row.department == DEPT,
            f'实际 {row!r}；result={str(result)[:120]}')
except Exception as error:                       # noqa: BLE001
    require('7 登记的动作收 kind/department，建出部门箱', False,
            f'{type(error).__name__}: {error}')

print()
print('【7b】旧版本 1.1.0 还在 —— 旧契约没被隐式覆盖')
try:
    old = frappe.db.exists('Shangshu Action Definition', 'mail.account.configure@1.1.0')
    new = frappe.db.exists('Shangshu Action Definition', 'mail.account.configure@1.2.0')
    require('7b 新旧版本并存，旧契约没被隐式覆盖', bool(old) and bool(new),
            f'1.1.0={old} 1.2.0={new}')
except Exception as error:                       # noqa: BLE001
    require('7b 新旧版本并存，旧契约没被隐式覆盖', False, f'{type(error).__name__}: {error}')

print()
print('【8】两个员工看到**同一个邮箱 ID 和同一封邮件 ID**（任务原话的那条判据）')
# 任务范围共享邮箱那条：「两个员工用各自账号进入同一个部门邮箱……
# 共用邮件，不为每个人复制一份」。计划 PKG-006-T01 的判据原文：
# 「两个员工看到同一个邮箱 ID 和同一封邮件 ID」。
# **不为每个人复制一份** = 两条读出来的 mailbox id 相同、同一封信的 id 相同。
cleanup()
try:
    from shangshu_mail.service import writing
    # ① USER 绑部门箱 → ② 授权给 MATE（只读 + 代发）→ ③ 收一封信 → ④ 两边各读一遍
    configure({'provider': 'qq', 'email': ADDR, 'display_name': '共享箱',
               'password': 'stub-pass', 'enabled': True,
               'kind': 'department', 'department': DEPT})
    frappe.db.commit()
    key = account_mod.account_name(USER)
    account_mod.execute('mail.mailbox.grant',
                        {'mailbox': key, 'user': MATE,
                         'rights': {'read': True, 'send': True}}, {'source': 'user'})
    frappe.db.commit()
    frappe.set_user(USER)
    with writing():
        mail = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
                               'subject': f'{TAG} 共用来信', 'body': 'x', 'body_format': 'Text',
                               'to_json': '["我 <me@x.example>"]', 'cc_json': '[]',
                               'from_address': '对方 <other@x.example>', 'record_version': 1,
                               'mailbox_id': key, 'owner': USER,
                               'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
    frappe.db.commit()

    def seen_by(who):
        frappe.set_user(who)
        boxes = (account_mod.mailboxes() or {}).get('mailboxes') or []
        ids = [b.get('id') for b in boxes]
        rows = frappe.get_all('Shangshu Mail Message',
                              filters={'mailbox_id': key, 'name': mail.name},
                              pluck='name')
        return ids, rows

    ids_a, rows_a = seen_by(USER)
    ids_b, rows_b = seen_by(MATE)
    require('8a 两个人都进得到同一个邮箱 ID',
            key in ids_a and key in ids_b and len({key} & set(ids_a) & set(ids_b)) == 1,
            f'USER 的箱={ids_a}；MATE 的箱={ids_b}；部门箱 key={key}')
    require('8b 两个人看到同一封邮件 ID，不是各一份',
            rows_a == [mail.name] and rows_b == [mail.name],
            f'USER 读到 {rows_a}；MATE 读到 {rows_b}；期望都是 [{mail.name}]')
except Exception as error:                       # noqa: BLE001
    require('8a 两个人都进得到同一个邮箱 ID', False, f'{type(error).__name__}: {error}')

print()
print('【9】mail.account.status 投影带 kind/department（表单要靠它回填）')
# 界面那半（mail-settings.js）要按已保存的归属回填表单 —— 投影不带这两个键，
# 打开设置页永远显示「个人邮箱」，改一次就把部门箱改成个人箱了。
cleanup()
try:
    configure({'provider': 'qq', 'email': ADDR, 'display_name': '共享箱',
               'password': 'stub-pass', 'enabled': True,
               'kind': 'department', 'department': DEPT})
    frappe.db.commit()
    frappe.set_user(USER)
    proj = account_mod.projection()
    require('9 投影带 kind/department',
            proj.get('kind') == 'department' and proj.get('department') == DEPT,
            f"实际 kind={proj.get('kind')!r} department={proj.get('department')!r}")
except Exception as error:                       # noqa: BLE001
    require('9 投影带 kind/department', False, f'{type(error).__name__}: {error}')

print()
print('=' * 50)
print(f'通过 {len(PASS)} 条，失败 {len(FAIL)} 条')
if FAIL:
    print('未过：' + ' | '.join(FAIL))
    cleanup()
    sys.exit(1)
cleanup()
sys.exit(0)
