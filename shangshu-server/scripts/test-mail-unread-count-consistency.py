#!/usr/bin/env python3
"""未读点和未读数必须是**同一套口径** —— 不许点说没读、数说读了。

用户 2026-10-14 批注 5-1：「没有看到两个点，建议你截图给我」

真页面上截图看过了：**两个点是画出来的**（前三行标题前各有两个绿点）。
但同一个列表的页头计数写 **`9 封 · 本人未读 0 · 部门未读 0`** —— 点和数打架。

真接口回包坐实根因（6 行全是这样）：
    {mine: true, dept: true, unread: true, read_at: true}

两套口径：
  · **点**（`read_state`）认 `Shangshu Mail Read` 表 —— **按人记**，我没读过就是未读
  · **数**（`_unread_counts` 的非部门分支）认 `read_at` —— 「**有人**读过」就算读过

`mark_read` 里 `doc.read_at = now` 是谁读都写，所以**别人一读就把我的未读数抹掉**，
我的点却还在。这正是 N5-4「本人阅读消个人点、别人阅读只消部门点」没落到底。

测试通过 = 下面全部成立：

 1. 部门箱里 N 封都没读 → `mine=N, dept=N`，**不是 0/0**（用户看到的那副样子）
 2. **别人读了、我没读** → 我的计数**还在**，部门计数**消掉**（N5-4 反例）
 3. 我读了 → 我的计数消、部门计数也消（我也是获权成员）
 4. **一致性**：列表行上 `my_unread=True` 的行数 == `unread_counts.mine`；
    `dept_unread=True` 的行数 == `unread_counts.dept` —— 两套数和两套点不许各说各话
 5. 个人箱**没有**部门那套（`dept` 恒 0）

跑在容器里（依赖 frappe）：
  docker cp …:/tmp/ && docker exec -w /home/frappe/frappe-bench … env/bin/python /tmp/…
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
from shangshu_mail import service

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

TAG = 'UCNT'
BOX = f'{TAG}-box'
A = 'ucnt-a@shangshu.local'   # 我
B = 'ucnt-b@shangshu.local'   # 同部门另一个人
MAILS = []


def cleanup():
    frappe.set_user('Administrator')
    names = list(MAILS)
    if not names:
        names = frappe.get_all('Shangshu Mail Message', filters={'subject': ('like', f'{TAG}%')}, pluck='name')
    with service.writing():
        for n in names:
            for row in frappe.get_all('Shangshu Mail Read', filters={'mail': n}, pluck='name'):
                hard_delete('Shangshu Mail Read', row)
        for n in names:
            hard_delete('Shangshu Mail Message', n)
    with account_mod.writing():
        for row in frappe.get_all('Shangshu Mail Access', filters={'mailbox': BOX}, pluck='name'):
            hard_delete('Shangshu Mail Access', row)
        for row in frappe.get_all('Shangshu Mail Account',
                                  filters={'display_name': ('like', f'{TAG}%')}, pluck='name'):
            hard_delete('Shangshu Mail Account', row)
    frappe.db.commit()


def put_mail(n):
    """建一封谁都没读的来信。守卫要求走 service.writing()（邮件表开关），
    不是 account_mod.writing()（那是账户表开关）—— 别调错。"""
    frappe.set_user(A)
    with service.writing():
        mail = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
                               'subject': f'{TAG} {n}', 'body': 'x', 'body_format': 'Text',
                               'to_json': '["我"]', 'cc_json': '[]',
                               'from_address': '对方 <o@x.example>', 'record_version': 1,
                               'mailbox_id': BOX, 'owner': A,
                               'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
    frappe.db.commit()
    MAILS.append(mail.name)
    return mail.name


for u in (A, B):
    ensure_user(u)
cleanup()
frappe.set_user('Administrator')
with account_mod.writing():
    frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': BOX,
                    'kind': 'department', 'provider': 'qq', 'email_address': 'ucnt@shangshu.local',
                    'display_name': TAG, 'enabled': 1, 'connection_status': 'connected',
                    'binding_generation': 'gen-ucnt'}).insert(ignore_permissions=True)
for u in (A, B):
    account_mod.grant(payload={'mailbox': BOX, 'user': u,
                               'rights': {'read': 1, 'edit_draft': 1, 'send': 1,
                                          'manage': 0, 'signature': 0}})
frappe.db.commit()

for i in range(3):
    put_mail(i)

FILTERS = {'scope': 'all', 'q': '', 'order': 'desc', 'mailbox': BOX}


def set_read(user, mail_name):
    """走产品那条 `mail.set_read`。`execute` 要 `expected_version` 对得上才放行 ——
    直接调 `mark_read` 不落库（`dept_read_at` 写在 doc 上就没了），我自己先栽过一次。"""
    frappe.set_user(user)
    ver = frappe.db.get_value('Shangshu Mail Message', mail_name, 'record_version')
    service.execute('mail.set_read', {'mail': mail_name, 'read': 1, 'expected_version': ver}, None)
    frappe.db.commit()


def snapshot(user):
    frappe.set_user(user)
    out = service.query('mail.message', filters=dict(FILTERS), page=1, page_length=30)
    rows = [r for r in (out.get('rows') or []) if r.get('name') in set(MAILS)]
    mine_dots = sum(1 for r in rows if r.get('my_unread'))
    dept_dots = sum(1 for r in rows if r.get('dept_unread'))
    counts = out.get('unread_counts') or {}
    return rows, mine_dots, dept_dots, counts


print('【1】三封都没读 → mine=3, dept=3（不是 0/0）')
rows, mine_dots, dept_dots, counts = snapshot(A)
require('1a 三封都带着我的未读点', mine_dots == 3, f'实际 {mine_dots}')
require('1b 三封都带着部门未读点', dept_dots == 3, f'实际 {dept_dots}')
require('1c 计数是 3/3，不是 0/0',
        counts.get('mine') == 3 and counts.get('dept') == 3,
        f'实际 {counts}  ← 用户在真页面看到的就是这个 0/0')

print()
print('【2】别人读了、我没读 → 我的计数还在，部门计数消掉（N5-4 反例）')
set_read(B, MAILS[0])
rows, mine_dots, dept_dots, counts = snapshot(A)
require('2a 我的点还在（别人读不算我读）',
        any(r.get('my_unread') for r in rows if r.get('name') == MAILS[0]),
        f'实际 rows={[(r.get("name"), r.get("my_unread")) for r in rows]}')
require('2b 那封的部门点消了',
        not next((r.get('dept_unread') for r in rows if r.get('name') == MAILS[0]), None),
        '部门点该消 —— 已有获权成员读过')
require('2c ★我的计数没被别人抹掉', counts.get('mine') == 3,
        f'实际 {counts}  ← 认 read_at 的旧口径在这里会算成 2')
require('2d ★部门计数减一', counts.get('dept') == 2, f'实际 {counts}')

print()
print('【3】我读了 → 我的计数消、部门计数也消')
set_read(A, MAILS[1])
rows, mine_dots, dept_dots, counts = snapshot(A)
require('3a 我的计数减一', counts.get('mine') == 2, f'实际 {counts}')
require('3b 部门计数也减一', counts.get('dept') == 1, f'实际 {counts}')

print()
print('【4】一致性：两套数必须等于两套点（不许各说各话）')
rows, mine_dots, dept_dots, counts = snapshot(A)
require('4a mine 计数 == 行上我的未读点数',
        counts.get('mine') == mine_dots,
        f'计数={counts.get("mine")} 行上点={mine_dots}')
require('4b dept 计数 == 行上部门未读点数',
        counts.get('dept') == dept_dots,
        f'计数={counts.get("dept")} 行上点={dept_dots}')

print()
print('【5】个人箱没有部门那套')
frappe.set_user(A)
mine_box = account_mod.account_name(A)
with service.writing():
    p = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
                        'subject': f'{TAG} personal', 'body': 'x', 'body_format': 'Text',
                        'to_json': '["我"]', 'cc_json': '[]',
                        'from_address': '对方 <o@x.example>', 'record_version': 1,
                        'mailbox_id': mine_box, 'owner': A,
                        'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
frappe.db.commit()
MAILS.append(p.name)
out = service.query('mail.message', filters={'scope': 'all', 'q': '', 'order': 'desc'},
                    page=1, page_length=30)
c = out.get('unread_counts') or {}
require('5a 个人箱 dept 恒 0', c.get('dept') == 0, f'实际 {c}')
require('5b 个人箱 mine=1', c.get('mine') == 1, f'实际 {c}')

print()
print('【6】★真页面那个场景：前端**不送 mailbox**，且信上只有 read_at、没有按人阅读记录')
print('    用户 5-1 实测看到的就是这一路 —— 页头写 0/0，行上却带着点')
# 页面真实请求：filters={"scope":"all","q":"","order":"desc"} —— **没有 mailbox**。
# 因为邮箱列表接口 400、currentBox=null，前端那句
#   if(currentBox&&currentBox.id) filterParams.mailbox=currentBox.id
# 就不送箱。这时候走「不指定箱」分支，而那个分支的计数**认 read_at**。
#
# 历史数据正是这个形状：N5 之前只有 read_at 一个字段，**没有** Shangshu Mail Read 行。
# 于是「有人读过」（read_at 有）被当成「我读过」，计数归零，点却还在。
frappe.set_user(A)
with service.writing():
    legacy = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
                             'subject': f'{TAG} legacy', 'body': 'x', 'body_format': 'Text',
                             'to_json': '["我"]', 'cc_json': '[]',
                             'from_address': '对方 <o@x.example>', 'record_version': 1,
                             'mailbox_id': mine_box, 'owner': A,
                             'read_at': frappe.utils.now_datetime(),   # 只有旧字段
                             'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
frappe.db.commit()
MAILS.append(legacy.name)
# 反证前提：确实**没有**按人阅读记录
has_read_row = frappe.db.exists('Shangshu Mail Read', {'mail': legacy.name, 'user': A})
require('6x 前提：这封信没有按人阅读记录（只有旧 read_at）', not has_read_row,
        f'居然有阅读记录 {has_read_row}，那这条就复现不了')

out = service.query('mail.message', filters={'scope': 'all', 'q': '', 'order': 'desc'},
                    page=1, page_length=30)
row6 = next((r for r in (out.get('rows') or []) if r.get('name') == legacy.name), None)
c6 = out.get('unread_counts') or {}
print(f'    那封信：点 my_unread={row6 and row6.get("my_unread")}；计数回报：{c6}')
require('6a ★行上我的未读点是 True（我没读过）',
        bool(row6 and row6.get('my_unread')),
        f'实际 {row6 and row6.get("my_unread")}')
require('6b ★计数也得算我未读 —— 不许因为 read_at 有就归零',
        c6.get('mine', 0) >= 1,
        f'计数={c6}  ← 用户看到的「本人未读 0」就是这里；认 read_at 的旧口径会算成 0')
require('6c ★计数和点必须同起同落（一致性）',
        (c6.get('mine', 0) >= 1) == bool(row6 and row6.get('my_unread')),
        f'计数={c6.get("mine")} 点={row6 and row6.get("my_unread")}')

print()
print('【7】★真页面的完整形状：本人箱编号被登记成部门箱 + 不送 mailbox')
print('    （线上那 6 封就是这样：mailbox_id 是本人箱编号，但 _is_department 认它是部门箱）')
# 计数那边的分支是**按「有没有传 mailbox」**选的，不是按「这些信实际在什么箱」选的。
# 一错位就退化成认 read_at 的旧口径 —— 行上冒出部门点，计数还停在个人箱那套。
frappe.set_user('Administrator')
with account_mod.writing():
    key = account_mod.account_name(A)
    if not frappe.db.exists('Shangshu Mail Account', {'account_key': key}):
        frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': key,
                        'kind': 'department', 'provider': 'qq',
                        'email_address': 'ucnt-personal@shangshu.local',
                        'display_name': f'{TAG}-mine', 'enabled': 1,
                        'connection_status': 'connected',
                        'binding_generation': 'gen-ucnt-mine'}).insert(ignore_permissions=True)
frappe.db.commit()
service._DEPT_KIND_CACHE.clear()   # 模块级缓存、建了永不失效，手动清

frappe.set_user(A)
out = service.query('mail.message', filters={'scope': 'all', 'q': '', 'order': 'desc'},
                    page=1, page_length=30)
rows7 = [r for r in (out.get('rows') or []) if r.get('name') in set(MAILS)]
mine_dots7 = sum(1 for r in rows7 if r.get('my_unread'))
dept_dots7 = sum(1 for r in rows7 if r.get('dept_unread'))
c7 = out.get('unread_counts') or {}
print(f'    行上点：我的 {mine_dots7} / 部门 {dept_dots7}；计数回报：{c7}')
require('7a 前提：行上带出部门点（箱被登记成部门箱）', dept_dots7 > 0,
        f'部门点 {dept_dots7}，这条复现不了就没在测真问题')
require('7b ★mine 计数 == 行上我的点数', c7.get('mine') == mine_dots7,
        f'计数={c7.get("mine")} 行上点={mine_dots7}  ← 用户看到的 0/0')
require('7c ★dept 计数 == 行上部门点数', c7.get('dept') == dept_dots7,
        f'计数={c7.get("dept")} 行上点={dept_dots7}')

print()
print('=' * 50)
print(f'通过 {len(PASS)} 条，失败 {len(FAIL)} 条')
if FAIL:
    print('未过：' + ' | '.join(FAIL))
    cleanup()
    sys.exit(1)
cleanup()
sys.exit(0)
