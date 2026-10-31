#!/usr/bin/env python3
"""N5-1 共享邮箱：账户身份独立于登录人。

执行计划 #mail-next-batch / N5-1 原话：
  「账户身份独立于登录人；个人归员工、共享归部门；稳定邮箱ID连接邮件、凭据、
    同步游标、草稿、签名和授权」
  「两个员工看到同一个邮箱ID和同一封邮件ID；旧个人邮箱及其原信/附件不丢；
    支持一个人选个人箱和获权部门箱。先核对能否保留现有ID，
    不按地址或登录人临时拼新身份」

用户 2026-10-13 给 C 的表里「共享邮箱」那行：
  「两个员工用各自账号进入同一个部门邮箱；能切换个人箱和获授权的部门箱，
    共用邮件，不为每个人复制一份」

**改之前**（查实 account.py / service.py）：
  · 邮箱账号键 = `sha256(登录人)`（account.py:24 `account_name`）
  · `get_account()` 直接 `if doc.owner != frappe.session.user: throw`（account.py:33）
  · 邮件归属判定 = `doc.owner == session.user`（service.py:25）
  · 列表过滤 = `{'owner': frappe.session.user, ...}`（service.py:325）
  → 张三一同步部门箱，信就变成「张三的信」，李四看不到。共享邮箱不可能只是
    给个人邮箱加个下拉框（执行计划 10/13 只读核对原话）。

**改之后**：邮箱有自己的稳定编号；谁能不能进、能干什么，由授权表说了算；
  邮件挂在邮箱上，不挂在收信人身上。

---

  测试通过 = 下面全部成立：

  1. **稳定邮箱 ID，不跟登录人走** —— 张三和李四查到的部门箱是**同一个编号**
     （不是各自按自己的登录人拼一份）
  2. **同一封邮件同一个编号** —— 部门箱里那封，张三看到的邮件编号 = 李四看到的，
     且库里这封**只有一条**记录（不为每个人复制一份）
  3. **能切换** —— 同一个人能列到「自己的个人箱」+「获授权的部门箱」，
     切到哪箱就只见哪箱的信
  4. **看过不加复制** —— 两人各自看过之后，部门箱仍是原来那几条
  5. **未授权进不去** —— 王五列不到部门箱，也取不到那封信（连标题、编号都拿不到）
  6. **只读授权 ≠ 发信权** —— 只给读权的人，`mail.send` 被明确拒绝
     （执行计划 N5-2「能读不等于能发」）

夹具说明：部门邮箱的**账号行**用产品自己的受管写入（`writing()`）造，
因为建账号要走真实 SMTP/IMAP 连接测试，不该在夹具里打外网。
**授权（grant）走真实动作** `mail.mailbox.grant` —— 那是本条要测的东西，不许绕。
收信夹具同 test-mail-read-state；收信链路另有 test-mail-c4-receive 覆盖。
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
    email = f'n5-shared-{tag}@shangshu.local'
    if not frappe.db.exists('User', email):
        frappe.get_doc({'doctype': 'User', 'email': email, 'first_name': f'共享{tag}',
                        'send_welcome_email': 0, 'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
    return email


def make_personal_box(owner):
    """造一个人的个人邮箱账号行。account_key 保留产品原口径（sha256(登录人)），
    这样**旧个人邮箱及其原信不丢**（N5-1 明写）。"""
    key = account.account_name(owner)
    if not frappe.db.exists('Shangshu Mail Account', key):
        frappe.set_user(owner)
        with account.writing():
            frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': key,
                            'kind': 'personal', 'department': '',
                            'provider': 'qq', 'email_address': f'{owner.split("@")[0]}@qq.com',
                            'display_name': owner, 'enabled': 1,
                            'connection_status': 'connected', 'binding_generation': 'gen-fixture',
                            }).insert(ignore_permissions=True)
    return key


def make_department_box(manager, dept):
    """造一个部门邮箱。**账号键不按登录人拼** —— 用随机稳定串，
    正是 N5-1「不按地址或登录人临时拼新身份」。"""
    key = 'dept-' + frappe.generate_hash(length=24)
    frappe.set_user(manager)
    with account.writing():
        frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': key,
                        'kind': 'department', 'department': dept,
                        'provider': 'qq', 'email_address': f'{dept}@lingeringtek.cn',
                        'display_name': f'{dept}公共邮箱', 'enabled': 1,
                        'connection_status': 'connected', 'binding_generation': 'gen-fixture',
                        }).insert(ignore_permissions=True)
    return key


def make_inbox_mail(owner, mailbox_id, subject, status='Received'):
    """造一封挂在**某个邮箱**上的信。用产品受管写入，不绕闸。

    `status='Draft'` 用来造「想代发的草稿」—— 发送那关只收 Draft/Queued，
    夹具必须停在能发的状态上，否则测到的是状态校验，不是权限校验。
    """
    frappe.set_user(owner)
    fields = {
        'doctype': 'Shangshu Mail Message', 'status': status,
        'subject': subject, 'body': '正文', 'body_format': 'Text',
        'to_json': '["对方 <other@x.example>"]', 'cc_json': '[]',
        'record_version': 1, 'mailbox_id': mailbox_id,
    }
    if status == 'Received':
        fields['from_address'] = '对方 <other@x.example>'
        fields['received_at'] = frappe.utils.now_datetime()
    with writing():
        doc = frappe.get_doc(fields).insert(ignore_permissions=True)
    return doc.name


def visible(user, mailbox_id, scope='inbox'):
    """走**生产查询** —— 判据必须落在用户真正用的那条路上。"""
    frappe.set_user(user)
    data = service.query(None, {'scope': scope, 'mailbox': mailbox_id}, 1, 50)
    return [row['name'] for row in data['rows']]


def mailbox_list(user):
    """走**生产服务**取邮箱清单 —— 判据必须落在用户真正用的那条路上。"""
    frappe.set_user(user)
    return account.mailboxes(None, {}, None)


print('\n=== 0 夹具：张三/李四/王五，各人个人箱 + 一个部门箱 ===')
ZHANG = make_user('zhang')
LI = make_user('li')
WANG = make_user('wang')
personal = make_personal_box(ZHANG)
li_personal = make_personal_box(LI)
dept = make_department_box(ZHANG, '交付部')
print(f'  张三个人箱 = {personal}')
print(f'  李四个人箱 = {li_personal}')
print(f'  部门箱   = {dept}')

print('\n=== 1 稳定邮箱 ID，不跟登录人走 ===')
# 通过**真实授权动作**把李四开进部门箱（只给读权）。
# 走 account.execute + source=user —— 正是平台调它的那条路，不绕。
frappe.set_user(ZHANG)
account.execute('mail.mailbox.grant', {'mailbox': dept, 'user': LI,
                                       'rights': {'read': True}}, {'source': 'user'})
a = [m for m in mailbox_list(ZHANG)['mailboxes'] if m['id'] == dept]
b = [m for m in mailbox_list(LI)['mailboxes'] if m['id'] == dept]
require('1a. 张三能列到部门箱', bool(a), f"张三的邮箱清单 = {[m['id'] for m in mailbox_list(ZHANG)['mailboxes']]}")
require('1b. 李四能列到同一个部门箱', bool(b), f"李四的邮箱清单 = {[m['id'] for m in mailbox_list(LI)['mailboxes']]}")
require('1c. 两人拿到的是**同一个邮箱编号**', a and b and a[0]['id'] == b[0]['id'],
        f"张三={a[0]['id'] if a else None} 李四={b[0]['id'] if b else None}")
require('1d. 部门箱标记为部门箱、带部门归属',
        bool(a) and a[0].get('kind') == 'department' and a[0].get('department'),
        f"实际 = {a[0] if a else None}")

print('\n=== 2 同一封邮件同一个编号，且不复制 ===')
shared = make_inbox_mail(ZHANG, dept, '部门来信样本')
rows_z = visible(ZHANG, dept)
rows_l = visible(LI, dept)
require('2a. 张三在部门箱看得到那封信', shared in rows_z, f'张三看到 = {rows_z}')
require('2b. 李四在部门箱也看得到那封信', shared in rows_l, f'李四看到 = {rows_l}')
require('2c. 两人看到的是**同一个邮件编号**',
        shared in rows_z and shared in rows_l and rows_z.count(shared) == 1 and rows_l.count(shared) == 1)
copies = frappe.db.count('Shangshu Mail Message', {'subject': '部门来信样本', 'mailbox_id': dept})
# ↑ 计数**按本轮部门箱**取，不是全库计数。原先只按 subject 数，那是在赌
# 「库里没有别人/上一轮留下的同名信」—— 一旦赌输（脚本被中断、连接 autocommit、
# 将来产品任一处加了 db.commit 让 rollback 兜不住），下一轮这条就**假红**。
# dept 是每轮随机生成的邮箱键，按它一筛就跟残留无关了。
require('2d. 库里这封只有一条记录（不为每个人复制一份）', copies == 1, f'实际条数 = {copies}')

print('\n=== 3 能切换：个人箱 / 部门箱各见各的 ===')
mine = make_inbox_mail(ZHANG, personal, '张三的个人来信')
in_personal = visible(ZHANG, personal)
in_dept = visible(ZHANG, dept)
require('3a. 切到个人箱只见个人的信', mine in in_personal and shared not in in_personal,
        f'个人箱 = {in_personal}')
require('3b. 切到部门箱只见部门的信', shared in in_dept and mine not in in_dept,
        f'部门箱 = {in_dept}')
li_personal_box = [m for m in mailbox_list(LI)['mailboxes'] if m.get('kind') == 'personal']
require('3c. 李四也列得到自己的个人箱', bool(li_personal_box),
        f"李四的邮箱清单 = {[(m['id'], m.get('kind')) for m in mailbox_list(LI)['mailboxes']]}")
require('3d. 李四在自己的个人箱里看不到部门那封', shared not in visible(LI, li_personal),
        f"李四个人箱 = {visible(LI, li_personal)}")

print('\n=== 4 看过不加复制 ===')
frappe.set_user(LI)
service.execute('mail.set_read', {'mail': shared, 'expected_version': 1, 'read': True}, None)
copies_after = frappe.db.count('Shangshu Mail Message', {'subject': '部门来信样本', 'mailbox_id': dept})
require('4a. 两人各自看过之后仍是原来那几条', copies_after == 1, f'实际条数 = {copies_after}')
require('4b. 李四读过之后张三仍看得到同一封', shared in visible(ZHANG, dept),
        f'张三看到 = {visible(ZHANG, dept)}')

print('\n=== 5 未授权进不去 ===')
wang_boxes = mailbox_list(WANG)['mailboxes']
require('5a. 王五列不到部门箱', all(m['id'] != dept for m in wang_boxes),
        f"王五的邮箱清单 = {[m['id'] for m in wang_boxes]}")
leaked = []
try:
    leaked = visible(WANG, dept)
except Exception:
    leaked = []
require('5b. 王五取不到部门箱的信（连标题/编号都拿不到）', shared not in leaked,
        f'王五查询结果 = {leaked}')
try:
    frappe.set_user(WANG)
    service.detail(None, {'mail': shared}, None)
    require('5c. 王五直接按编号读那封信要被拒', False, '居然读到了 —— 越权')
except Exception as exc:
    require('5c. 王五直接按编号读那封信要被拒', True)
    print(f'      ↳ 拒绝理由：{str(exc)[:100]}')

print('\n=== 6 只读授权 ≠ 发信权 ===')
rights_l = next((m.get('rights') for m in mailbox_list(LI)['mailboxes'] if m['id'] == dept), {})
require('6a. 李四在部门箱只有读权（无发信权）', rights_l.get('read') and not rights_l.get('send'),
        f'李四在部门箱的权限 = {rights_l}')
frappe.set_user(LI)
# 造一封**能发状态**的草稿（Draft）—— 否则会被状态校验挡下，测不到权限那一层
draft = make_inbox_mail(LI, dept, '李四想代发的信', status='Draft')
try:
    service.execute('mail.send', {'mail': draft, 'expected_version': 1}, None)
    require('6b. 只读授权的人 mail.send 要被明确拒绝', False, '居然排进队了 —— 能读不等于能发')
except Exception as exc:
    require('6b. 只读授权的人 mail.send 要被明确拒绝', True)
    print(f'      ↳ 拒绝理由：{str(exc)[:100]}')

print('\n=== 7 撤权后进不去（N5-1「授权」要能收回） ===')
frappe.set_user(ZHANG)
account.execute('mail.mailbox.revoke', {'mailbox': dept, 'user': LI}, {'source': 'user'})
after = mailbox_list(LI)['mailboxes']
require('7a. 撤权后李四列不到部门箱', all(m['id'] != dept for m in after),
        f"撤权后李四的清单 = {[m['id'] for m in after]}")
# 撤权后查询**被拒**和**查到空**都算「取不到」—— 产品现在是明确拒（更好），
# 断言两种都收，免得以后有人把拒改成空列表就误报红。
try:
    after_rows = visible(LI, dept)
    denied = False
except Exception as exc:
    after_rows, denied = [], True
    print(f'      ↳ 撤权后查询被拒：{str(exc)[:80]}')
require('7b. 撤权后李四取不到那封信', shared not in after_rows,
        f'撤权后李四查询 = {after_rows}')

print(f"\n{'=' * 60}")
print(f"通过 {len(PASS)} 条，失败 {len(FAIL)} 条")
if FAIL:
    print('失败：')
    for f in FAIL:
        print(f'  - {f}')
frappe.db.rollback()
sys.exit(1 if FAIL else 0)
