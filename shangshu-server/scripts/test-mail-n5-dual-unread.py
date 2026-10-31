#!/usr/bin/env python3
"""N5-4 部门 / 个人双未读点。

执行计划 #mail-next-batch「双未读标记：本轮已确认」原话表：

  | 同一封新来信的演示 | 张三个人点 | 李四个人点 | 部门点及未读数 |
  | 两人都没读        | 有        | 有        | 有；部门未读+1，两人个人未读各+1 |
  | 张三打开正文并成功标读 | 消失，个人未读-1 | 保留，个人数不变 | 消失，部门未读只减1 |
  | 李四随后打开      | 无        | 消失，个人未读-1 | 仍无，**不再次减部门数** |
  | 李四标为个人未读  | 无        | 重新出现，个人未读+1 | 仍无，**不撤销部门已有阅读事实** |

以及：「已读后对应点**消失**，不是换成另一种颜色」
「正文未加载成功不能先清点；列表预取、后台同步及 Assistant 只读检索**不清点**」
「刷新或重新登录后状态保留」
「共享已读**不修改正文/草稿内容版本**，避免别人读信使正在编辑的稿件无故冲突」

用户 2026-10-13 给 C 的表里「部门／个人双未读点」那行：
  「本人阅读消个人点；任一获授权部门成员阅读消部门点，其他人的个人点保留；
    对应未读数同步变化」

**改之前**（查实 service.py / doctype）：
  · 读信状态只有 `Shangshu Mail Message.read_at` **一个字段** —— 是「这封读了没」
  · 张三一读，李四的未读也跟着没了；部门更是没有「有人看过」这回事

**改之后**：读信按**人**记（我读过没有），部门另记一条「有获权成员读过」。
  两条互不牵连：部门已读不撤销别人的个人未读。

---

  测试通过 = 下面全部成立：

  1. **两人都没读** → 两人各有个人未读，部门也有未读；三套计数各 +1
  2. **张三读了** → 只有张三的个人点消失；**李四的还在**；部门点消失且部门未读只减 1
  3. **李四再读** → 李四的个人点消失；**部门数不再减**（不重复扣）
  4. **李四标回未读** → 李四个人点回来；**部门点不回来**（不撤销部门已读事实）
  5. **标读不改内容版本** —— 别人读信不会让正在编辑的稿件冒出冲突
  6. **读信失败不清点** —— 正文没加载成功时不能先清
  7. **个人箱行为不变** —— 自己的信读没读，还是只看自己那一条
"""
import sys
from pathlib import Path

_roots = [Path('/home/frappe/frappe-bench/apps'), Path.cwd()]
try:
    _roots.append(Path.cwd().parents[2])
except IndexError:
    pass
for _a in ('shangshu_mail', 'shangshu_core'):
    for _r in _roots:
        _p = _r / _a
        if _p.exists() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))

import frappe
from shangshu_mail import account, service
from shangshu_mail.service import writing

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

def make_user(tag):
    email = f'n5-read-{tag}@shangshu.local'
    if not frappe.db.exists('User', email):
        frappe.get_doc({'doctype': 'User', 'email': email, 'first_name': f'未读{tag}',
                        'send_welcome_email': 0, 'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
    return email


def make_personal(owner):
    key = account.account_name(owner)
    if not frappe.db.exists('Shangshu Mail Account', {'account_key': key}):
        frappe.set_user(owner)
        with account.writing():
            frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': key,
                            'kind': 'personal', 'provider': 'qq',
                            'email_address': f'{owner.split("@")[0]}@qq.com',
                            'display_name': owner, 'enabled': 1,
                            'connection_status': 'connected',
                            'binding_generation': 'gen-fixture'}).insert(ignore_permissions=True)
    return key


def make_dept(owner, dept='交付部'):
    key = 'dept-' + frappe.generate_hash(length=24)
    frappe.set_user(owner)
    with account.writing():
        frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': key,
                        'kind': 'department', 'department': dept, 'provider': 'qq',
                        'email_address': f'{dept}-read@qq.com', 'display_name': dept,
                        'enabled': 1, 'connection_status': 'connected',
                        'binding_generation': 'gen-fixture'}).insert(ignore_permissions=True)
    return key


def make_inbox(owner, mailbox_id, subject):
    frappe.set_user(owner)
    with writing():
        doc = frappe.get_doc({
            'doctype': 'Shangshu Mail Message', 'status': 'Received',
            'subject': subject, 'body': '正文', 'body_format': 'Text',
            'to_json': '["我们 <dept@qq.com>"]', 'cc_json': '[]',
            'from_address': '对方 <o@x.example>', 'record_version': 1,
            'mailbox_id': mailbox_id,
            'received_at': frappe.utils.now_datetime(),
        }).insert(ignore_permissions=True)
    return doc.name


def version_of(name):
    return frappe.get_value('Shangshu Mail Message', name, 'record_version')


def set_read(user, mail, read):
    """走**生产动作**标读/标未读 —— 判据必须落在用户真正用的那条路上。"""
    frappe.set_user(user)
    return service.execute('mail.set_read', {'mail': mail,
                                            'expected_version': version_of(mail),
                                            'read': read}, None)


def dots(user, mail, mailbox_id):
    """从**生产查询**读这一封的两个点 + 两套未读数。"""
    frappe.set_user(user)
    data = service.query(None, {'scope': 'inbox', 'mailbox': mailbox_id}, 1, 50)
    row = next((r for r in data['rows'] if r['name'] == mail), None)
    if row is None:
        return {'visible': False}
    return {'visible': True,
            'my_unread': row.get('my_unread'),
            'dept_unread': row.get('dept_unread'),
            'counts': data.get('unread_counts') or {}}


print('\n=== 0 夹具：张三、李四共用一个部门箱 ===')
ZHANG = make_user('zhang')
LI = make_user('li')
make_personal(ZHANG)
make_personal(LI)
dept = make_dept(ZHANG)
frappe.set_user(ZHANG)
account.execute('mail.mailbox.grant',
                {'mailbox': dept, 'user': LI, 'rights': {'read': True}}, {'source': 'user'})
shared = make_inbox(ZHANG, dept, '双未读样本')
print(f'  部门箱 = {dept}   样本信 = {shared}')

print('\n=== 1 两人都没读：两个个人点 + 一个部门点 ===')
d_z = dots(ZHANG, shared, dept)
d_l = dots(LI, shared, dept)
require('1a. 张三这边有「本人未读」点', d_z.get('my_unread') is True, f'张三 = {d_z}')
require('1b. 李四这边有「本人未读」点', d_l.get('my_unread') is True, f'李四 = {d_l}')
require('1c. 两人都看到「部门未读」点', d_z.get('dept_unread') is True and d_l.get('dept_unread') is True,
        f'张三={d_z} 李四={d_l}')
require('1d. 部门未读数 = 1（不是 2）', (d_z.get('counts') or {}).get('dept') == 1,
        f"张三看到的计数 = {d_z.get('counts')}")
require('1e. 两人各自的个人未读数 = 1',
        (d_z.get('counts') or {}).get('mine') == 1 and (d_l.get('counts') or {}).get('mine') == 1,
        f"张三={d_z.get('counts')} 李四={d_l.get('counts')}")

print('\n=== 2 张三读了：只消自己的点 + 部门点，李四的保留 ===')
set_read(ZHANG, shared, True)
d_z, d_l = dots(ZHANG, shared, dept), dots(LI, shared, dept)
require('2a. 张三的个人点消失', d_z.get('my_unread') is False, f'张三 = {d_z}')
require('2b. **李四的个人点还在**', d_l.get('my_unread') is True,
        f"李四 = {d_l} —— 一个人读了不该清掉别人的未读")
require('2c. 部门点消失', d_z.get('dept_unread') is False and d_l.get('dept_unread') is False,
        f'张三={d_z} 李四={d_l}')
require('2d. 部门未读只减 1（减完是 0）', (d_z.get('counts') or {}).get('dept') == 0,
        f"张三看到的计数 = {d_z.get('counts')}")
require('2e. 李四的个人未读数仍是 1', (d_l.get('counts') or {}).get('mine') == 1,
        f"李四看到的计数 = {d_l.get('counts')}")

print('\n=== 3 李四随后打开：个人点消，**部门数不再减** ===')
before_dept = (dots(ZHANG, shared, dept).get('counts') or {}).get('dept')
set_read(LI, shared, True)
d_z, d_l = dots(ZHANG, shared, dept), dots(LI, shared, dept)
require('3a. 李四的个人点消失', d_l.get('my_unread') is False, f'李四 = {d_l}')
require('3b. **部门数不再减**（仍停在减完的值）',
        (d_z.get('counts') or {}).get('dept') == before_dept == 0,
        f"改前={before_dept} 改后={(d_z.get('counts') or {}).get('dept')}")
require('3c. 部门点仍是「无」，不会反复出现', d_l.get('dept_unread') is False, f'李四 = {d_l}')

print('\n=== 4 李四标回个人未读：个人点回来，部门点不回来 ===')
set_read(LI, shared, False)
d_z, d_l = dots(ZHANG, shared, dept), dots(LI, shared, dept)
require('4a. 李四的个人点重新出现', d_l.get('my_unread') is True, f'李四 = {d_l}')
require('4b. 李四个人未读数 +1 回到 1', (d_l.get('counts') or {}).get('mine') == 1,
        f"李四看到的计数 = {d_l.get('counts')}")
require('4c. **部门点不回来**（不撤销部门已有阅读事实）',
        d_l.get('dept_unread') is False and d_z.get('dept_unread') is False,
        f'张三={d_z} 李四={d_l}')
require('4d. 部门未读数仍是 0', (d_l.get('counts') or {}).get('dept') == 0,
        f"李四看到的计数 = {d_l.get('counts')}")
require('4e. 张三的个人点也没被牵连', d_z.get('my_unread') is False, f'张三 = {d_z}')

print('\n=== 5 标读不改内容版本（不引发草稿冲突）===')
v_before = version_of(shared)
set_read(LI, shared, True)
set_read(ZHANG, shared, True)
v_after = version_of(shared)
require('5. 别人读信不改内容版本', v_before == v_after,
        f'版本 {v_before} → {v_after} —— 读信不该动 record_version')

print('\n=== 6 读信失败不清点（正文没加载成功不能先清）===')
# **前置摆清楚**：先把李四放回未读，再让标读失败，看点有没有被误清。
# （不摆前置的话，上一步刚把李四标成已读，这里断言必然对不上。）
set_read(LI, shared, False)
before = dots(LI, shared, dept)
require('6-前置. 李四此刻是未读', before.get('my_unread') is True, f'{before}')
frappe.set_user(LI)
try:
    service.execute('mail.set_read', {'mail': shared, 'expected_version': 999, 'read': True}, None)
    require('6a. 版本不对的标读要被拒', False, '居然成功了')
except Exception as exc:
    require('6a. 版本不对的标读要被拒', True)
    print(f'      ↳ 拒绝理由：{str(exc)[:80]}')
require('6b. 失败后点没被清掉（读信失败不许先清点）',
        dots(LI, shared, dept).get('my_unread') is True,
        f"李四 = {dots(LI, shared, dept)}")

print('\n=== 7 个人箱行为不变 ===')
mine = make_inbox(ZHANG, account.account_name(ZHANG), '张三自己的信')
d = dots(ZHANG, mine, account.account_name(ZHANG))
require('7a. 自己的个人来信有本人未读点', d.get('my_unread') is True, f'{d}')
require('7b. 个人箱不带「部门未读」这回事', d.get('dept_unread') in (False, None),
        f'{d} —— 个人箱不该有部门点')
set_read(ZHANG, mine, True)
d = dots(ZHANG, mine, account.account_name(ZHANG))
require('7c. 自己读了就消自己的点', d.get('my_unread') is False, f'{d}')

print('\n=== 8 同人重放、刷新重开：不重复减数、不出现负数 ===')
# 计划 N5-4 判据原话：「两人同时读、**同人重放**、个人标未读、刷新重开
# 均**不重复减数或出现负数**」。顺序那几段上面已验，这一段补重放与重开。
mail8 = make_inbox(ZHANG, dept, '双未读 重放样本')
b8 = dots(ZHANG, mail8, dept)
c0 = b8.get('counts') or {}
require('8-前置. 新样本：张三未读、部门未读、部门数=1',
        b8.get('my_unread') is True and b8.get('dept_unread') is True and c0.get('dept') == 1,
        f'{b8}')

# 同人连标两次「已读」—— 第二次就是重放（用户双击、刷新后又点、请求重放都会这样）
set_read(ZHANG, mail8, True)
set_read(ZHANG, mail8, True)
d8 = dots(ZHANG, mail8, dept)
c1 = d8.get('counts') or {}
require('8a. 同人重放标读，个人未读只扣一次', c1.get('mine') == (c0.get('mine') or 1) - 1,
        f"重放两次后个人未读 = {c1.get('mine')}（起点 {c0.get('mine')}，应扣 1 次）")
require('8b. 部门未读也只扣一次，不是两次', c1.get('dept') == (c0.get('dept') or 1) - 1,
        f"重放两次后部门未读 = {c1.get('dept')}（起点 {c0.get('dept')}，应扣 1 次）")
require('8c. 计数不出现负数', c1.get('mine', 0) >= 0 and c1.get('dept', 0) >= 0,
        f'实际 {c1}')
require('8d. 重放后两个点都已消', d8.get('my_unread') is False and d8.get('dept_unread') is False,
        f'{d8}')

# 刷新重开：重新走一遍查询，状态应当保留，不是只在内存里成立
d8b = dots(ZHANG, mail8, dept)
require('8e. 刷新重开后状态保留（点和计数都在）',
        d8b.get('my_unread') == d8.get('my_unread')
        and d8b.get('dept_unread') == d8.get('dept_unread')
        and (d8b.get('counts') or {}).get('mine') == c1.get('mine')
        and (d8b.get('counts') or {}).get('dept') == c1.get('dept'),
        f"重开前 {d8} 重开后 {d8b}")

# 李四那侧不该被张三的重放牵连
d8l = dots(LI, mail8, dept)
require('8f. 李四的个人点没被张三的重放牵连', d8l.get('my_unread') is True,
        f'{d8l}')

print(f"\n{'=' * 60}")
print(f"通过 {len(PASS)} 条，失败 {len(FAIL)} 条")
if FAIL:
    print('失败：')
    for f in FAIL:
        print(f'  - {f}')
frappe.db.rollback()
sys.exit(1 if FAIL else 0)
