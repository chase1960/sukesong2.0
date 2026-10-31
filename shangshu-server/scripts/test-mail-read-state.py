#!/usr/bin/env python3
"""已读 / 未读 —— 真实邮箱里的读信状态。

用户 2026-10-13 提出：「还有一个已读未读的问题」，并要求「进入到本批赶快修」。

**改之前**（查实 mail-center.js）：已读/未读**只在「交互样例」模式里有** ——
  · 邮件记录上**根本没有读信字段**（doctype 字段表里 read 相关一个都没有）
  · 未读小圆点、「标为未读」按钮、状态里的「已读/未读」全写死在 `showExamples` 分支
  · 更糟：筛选下拉框里有「未读」选项，但 `visible()` 开头是 `if(!showExamples)return mails;`
    —— **真实模式下筛选什么也不做**，这是「看似可用但不落库」的假入口
    （执行计划明令禁止的那种）

**改之后**：收到的信有「读信时间」（空 = 这封还没读过）；打开看自动标已读；
  可以手动标回未读；筛选「未读」真能筛出来；列表里未读有明显标记。

测试通过 = 下面全部成立：

 1. **收到的信默认未读** —— 刚收进来的信读信时间是空的，筛选「未读」能筛到它。
 2. **打开看过 = 已读** —— 标记已读后读信时间有值，筛选「未读」里**不再有它**。
 3. **能标回未读** —— 已读的信标回未读后，筛选「未读」里又有它了（能来回）。
 4. **草稿不参与** —— 自己写的草稿没有已读/未读这回事，标它要明确拒绝。
 5. **别人的信动不了** —— 别人收到的信，我标不了（照旧走本人归属那道闸）。

夹具用产品自己的受管写入（`writing()`）造「收到的信」—— 这条测的是**读信状态与筛选**，
不是收信链路；收信链路另有 test-mail-c4-receive 覆盖，那条才守「不直接插库冒充收件」。
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
from shangshu_mail import service
from shangshu_mail.service import writing

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

def make_user(tag):
    email = f'read-state-{tag}@shangshu.local'
    if not frappe.db.exists('User', email):
        frappe.get_doc({'doctype': 'User', 'email': email, 'first_name': f'读信{tag}',
                        'send_welcome_email': 0, 'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
    return email


def make_inbox_mail(owner, subject):
    """造一封「收到的信」。用产品自己的受管写入开关，不绕过任何闸。
    **必须以本人身份建** —— Frappe 把 owner 记成插入者，换个用户建归属就错了。"""
    frappe.set_user(owner)
    with writing():
        doc = frappe.get_doc({
            'doctype': 'Shangshu Mail Message', 'status': 'Received',
            'subject': subject, 'body': '正文', 'body_format': 'Text',
            'to_json': '["我 <me@x.example>"]', 'cc_json': '[]',
            'from_address': '对方 <other@x.example>', 'record_version': 1,
            'received_at': frappe.utils.now_datetime(),
        }).insert(ignore_permissions=True)
    return doc.name


def make_draft(owner, subject):
    frappe.set_user(owner)
    with writing():
        doc = frappe.get_doc({
            'doctype': 'Shangshu Mail Message', 'status': 'Draft',
            'subject': subject, 'body': '草稿正文', 'body_format': 'Text',
            'to_json': '[]', 'cc_json': '[]', 'record_version': 1,
        }).insert(ignore_permissions=True)
    return doc.name


def version_of(name):
    return frappe.get_value('Shangshu Mail Message', name, 'record_version')


def unread_names(user, scope='inbox'):
    """走**生产查询**取未读列表 —— 判据必须落在用户真正用的那条路上。"""
    frappe.set_user(user)
    data = service.query(None, {'scope': scope, 'unread': '1', 'order': 'desc'}, 1, 30)
    return [row['name'] for row in data['rows']]


print('\n=== 1/2/3 收到的信：默认未读 → 标已读 → 能标回未读 ===')
A = make_user('a')
mail = make_inbox_mail(A, '读信状态样本')
mail2 = make_inbox_mail(A, '另一封样本')
frappe.set_user(A)

require('1. 刚收到的信默认未读（筛选「未读」能筛到）', mail in unread_names(A),
        f'未读列表 = {unread_names(A)}')

# 打开看 = 标已读（前端打开详情时调这个动作）
r = service.execute('mail.set_read', {'mail': mail, 'expected_version': version_of(mail), 'read': True}, None)
require('2a. 标记已读动作能执行', bool(r.get('name') == mail), str(r)[:120])
doc = frappe.get_doc('Shangshu Mail Message', mail)
require('2b. 标已读后读信时间有值', bool(doc.get('read_at')), f"read_at = {doc.get('read_at')!r}")
require('2c. 标已读后筛选「未读」里没有它了', mail not in unread_names(A),
        f'未读列表 = {unread_names(A)}')
require('2d. 另一封没动过的仍是未读', mail2 in unread_names(A),
        f'未读列表 = {unread_names(A)}')

service.execute('mail.set_read', {'mail': mail, 'expected_version': version_of(mail), 'read': False}, None)
doc = frappe.get_doc('Shangshu Mail Message', mail)
require('3a. 标回未读后读信时间又空了', not doc.get('read_at'), f"read_at = {doc.get('read_at')!r}")
require('3b. 标回未读后筛选「未读」里又有它', mail in unread_names(A), f'未读列表 = {unread_names(A)}')

print('\n=== 4 草稿不参与已读/未读 ===')
draft = make_draft(A, '一封草稿')
frappe.set_user(A)
try:
    service.execute('mail.set_read', {'mail': draft, 'expected_version': version_of(draft), 'read': True}, None)
    require('4. 草稿标已读要被明确拒绝', False, '居然成功了 —— 草稿不该有已读/未读')
except Exception as exc:
    require('4. 草稿标已读要被明确拒绝', True)
    print(f'      ↳ 拒绝理由：{str(exc)[:100]}')

print('\n=== 5 别人的信动不了 ===')
B = make_user('b')
other = make_inbox_mail(B, '别人的信')
frappe.set_user(A)
try:
    service.execute('mail.set_read', {'mail': other, 'expected_version': 1, 'read': True}, None)
    require('5. 别人收到的信我标不了', False, '居然成功了 —— 归属闸没拦住')
except Exception as exc:
    require('5. 别人收到的信我标不了', True)
    print(f'      ↳ 拒绝理由：{str(exc)[:100]}')

print(f"\n{'='*60}")
print(f"通过 {len(PASS)} 条，失败 {len(FAIL)} 条")
if FAIL:
    print('失败：')
    for f in FAIL:
        print(f'  - {f}')
frappe.db.rollback()
sys.exit(1 if FAIL else 0)
