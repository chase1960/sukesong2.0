#!/usr/bin/env python3
"""N5-3 代发身份：From 用选定的邮箱，日志记实际操作员工。

执行计划 N5-3 原话：
  「From采用选定且当前有发信权的邮箱，日志记录实际员工与人/Assistant/代码来源」
  「张三用部门邮箱发信，收件方看到部门地址，日志仍是张三；
    不能把收信后台任务、邮箱所有人及实际操作人混成同一身份；
    员工/助手得不到授权码」

用户 2026-10-13 给 C 的表里「邮箱权限」那行：
  「分开控制阅读、编辑草稿、代发、邮箱配置及签名管理；能读不等于能发。
    **用部门邮箱发信，仍记录实际操作员工**」

**改之前**（查实 delivery.py / account.py）：
  · `queue_send` / `process_send` 一律 `account.get_account()` —— 取的是
    **本人个人箱**，`doc.from_address` 写成个人地址
  · 收信去重、线程查找一度混用 `frappe.session.user`
  → 张三用部门箱代发，收件方看到的却是**张三的个人邮箱**，
    「部门发的信」这件事在信头上根本不存在。

**改之后**：发信身份 = **这封信住的那个箱**（必须在那个箱上有代发权）；
  实际操作员工另记，两者不混。

---

  测试通过 = 下面全部成立：

  1. **用部门箱代发 → From 是部门地址**，不是操作人的个人地址
  2. **记录里仍是实际操作员工**（张三），不是部门、不是后台任务
  3. **用个人箱发信 → From 是个人地址**（老行为不变）
  4. **没有代发权的箱发不了**（能读≠能发，已在 N5-1 钉过，这里复核不回归）
  5. **凭据不外泄** —— 返回给界面的数据里**不出现授权码**
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
from shangshu_mail import account, delivery, service, transport
from shangshu_mail.service import writing

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

def make_user(tag):
    email = f'n5-send-{tag}@shangshu.local'
    if not frappe.db.exists('User', email):
        frappe.get_doc({'doctype': 'User', 'email': email, 'first_name': f'代发{tag}',
                        'send_welcome_email': 0, 'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
    return email


def make_box(owner, kind, dept='', address=None):
    """造一个邮箱账号行 + 它的加密凭据配置。

    夹具用产品受管写入（建账号要走真实 SMTP/IMAP 连接测试，不该在夹具里打外网），
    但**凭据配置造真的** —— `queue_send` 会取凭据，缺了就卡在「邮箱未连接」，
    测不到 From 这一层。**授权走真实动作**，不绕。
    """
    key = account.account_name(owner) if kind == 'personal' else 'dept-' + frappe.generate_hash(length=24)
    addr = address or (f'{owner.split("@")[0]}@qq.com')
    if frappe.db.exists('Shangshu Mail Account', {'account_key': key}):
        return key
    provider = transport.provider_for(addr, 'qq')
    email_name = 'N5 Send Fixture ' + key[:20]
    if not frappe.db.exists('Email Account', email_name):
        frappe.set_user(owner)
        source = frappe.new_doc('Email Account')
        source.update({'email_account_name': email_name, 'email_id': addr,
                       'password': 'synthetic-auth-code-not-real',
                       'auth_method': 'Basic',
                       'smtp_server': provider['smtp_host'], 'smtp_port': '465',
                       'use_ssl_for_outgoing': 1, 'use_tls': 0,
                       'email_server': provider['imap_host'], 'incoming_port': '993',
                       'use_imap': 1, 'use_ssl': 1, 'use_starttls': 0,
                       'enable_incoming': 0, 'enable_outgoing': 0,
                       'default_incoming': 0, 'default_outgoing': 0})
        source.save(ignore_permissions=True)
    frappe.set_user(owner)
    with account.writing():
        frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': key,
                        'kind': kind, 'department': dept, 'provider': 'qq',
                        'email_address': addr, 'display_name': f'{kind}-{dept or "我"}',
                        'email_account': email_name, 'enabled': 1,
                        'connection_status': 'connected',
                        'binding_generation': 'gen-fixture'}).insert(ignore_permissions=True)
    return key


def make_draft(owner, mailbox_id, subject):
    frappe.set_user(owner)
    with writing():
        doc = frappe.get_doc({
            'doctype': 'Shangshu Mail Message', 'status': 'Draft',
            'subject': subject, 'body': '正文', 'body_format': 'Text',
            'to_json': '["对方 <peer@x.example>"]', 'cc_json': '[]',
            'record_version': 1, 'mailbox_id': mailbox_id,
        }).insert(ignore_permissions=True)
    return doc.name


def version_of(name):
    return frappe.get_value('Shangshu Mail Message', name, 'record_version')


# ── 夹具 ────────────────────────────────────────────────────────────────────
print('\n=== 0 夹具：张三个人箱 + 部门箱（张三建、李四获代发权）===')
ZHANG = make_user('zhang')
LI = make_user('li')
personal = make_box(ZHANG, 'personal', address='zhang-personal@qq.com')
# 夹具地址用服务商认的域名（provider_for 会校验），判据看的是 **From 是谁**，
# 不是域名看起来像不像真的公司。
dept = make_box(ZHANG, 'department', dept='交付部', address='dept-team@qq.com')
# 李四在部门箱上只有**代发**权（不是全权）
frappe.set_user(ZHANG)
account.execute('mail.mailbox.grant',
                {'mailbox': dept, 'user': LI, 'rights': {'read': True, 'send': True}},
                {'source': 'user'})
print(f'  张三个人箱 = {personal}  (zhang-personal@qq.com)')
print(f'  部门箱   = {dept}  (dept-team@qq.com)')

# ── 1/2 用部门箱代发 ───────────────────────────────────────────────────────
print('\n=== 1/2 用部门箱代发：From 是部门地址，记录里是实际操作员工 ===')
draft = make_draft(LI, dept, '李四用部门箱代发')
frappe.set_user(LI)
# 排队这一趟只落库，SMTP 在后台任务里 —— 用隔离捕获器接住，不触发真实发送
enqueued = []
orig_enqueue = frappe.enqueue
frappe.enqueue = lambda fn, **k: enqueued.append((fn, k))
try:
    result = delivery.queue_send({'mail': draft, 'expected_version': version_of(draft)}, {'source': 'user'})
finally:
    frappe.enqueue = orig_enqueue

doc = frappe.get_doc('Shangshu Mail Message', draft)
require('1a. 用部门箱代发 → From 是部门地址',
        (doc.from_address or '').find('dept-team@qq.com') >= 0,
        f'实际 From = {doc.from_address!r}')
require('1b. From 不是操作人的个人地址',
        (doc.from_address or '').find('zhang-personal') < 0
        and (doc.from_address or '').find(LI) < 0,
        f'实际 From = {doc.from_address!r}')
require('2a. 这封信仍挂在部门箱上（不是挪进谁的个人箱）',
        doc.mailbox_id == dept, f'mailbox_id = {doc.mailbox_id!r}')
require('2b. 后台任务带着**实际操作员工**（不是部门、不是收信后台）',
        bool(enqueued) and enqueued[0][1].get('user') == LI,
        f'排队参数 = {enqueued[0][1] if enqueued else None}')
require('2c. 记录里的操作人是李四本人（不是张三，不是邮箱所有人）',
        doc.owner == LI, f'owner = {doc.owner!r}')

# ── 3 个人箱发信：老行为不变 ───────────────────────────────────────────────
print('\n=== 3 用个人箱发信：From 是个人地址 ===')
mine = make_draft(ZHANG, personal, '张三用个人箱发')
frappe.set_user(ZHANG)
enqueued2 = []
frappe.enqueue = lambda fn, **k: enqueued2.append((fn, k))
try:
    delivery.queue_send({'mail': mine, 'expected_version': version_of(mine)}, {'source': 'user'})
finally:
    frappe.enqueue = orig_enqueue
doc2 = frappe.get_doc('Shangshu Mail Message', mine)
require('3a. 用个人箱发信 → From 是个人地址',
        (doc2.from_address or '').find('zhang-personal@qq.com') >= 0,
        f'实际 From = {doc2.from_address!r}')
require('3b. 不是部门地址',
        (doc2.from_address or '').find('dept-team@qq.com') < 0,
        f'实际 From = {doc2.from_address!r}')

# ── 4 没有代发权的箱发不了（复核不回归）─────────────────────────────────────
print('\n=== 4 能读 ≠ 能发（复核 N5-1 那条没被弄坏）===')
frappe.set_user(ZHANG)
account.execute('mail.mailbox.revoke', {'mailbox': dept, 'user': LI}, {'source': 'user'})
account.execute('mail.mailbox.grant',
                {'mailbox': dept, 'user': LI, 'rights': {'read': True, 'send': False}},
                {'source': 'user'})
draft2 = make_draft(LI, dept, '李四只读想代发')
frappe.set_user(LI)
try:
    delivery.queue_send({'mail': draft2, 'expected_version': version_of(draft2)}, {'source': 'user'})
    require('4. 只读授权的人代发要被拒', False, '居然排进队了 —— 能读不等于能发')
except Exception as exc:
    require('4. 只读授权的人代发要被拒', True)
    print(f'      ↳ 拒绝理由：{str(exc)[:100]}')

# ── 5 凭据不外泄 ───────────────────────────────────────────────────────────
print('\n=== 5 凭据不外泄 ===')
frappe.set_user(LI)
status = account.status()
blob = repr(status)
require('5a. 账号状态返回里不出现授权码/密码字段',
        ('password' not in blob.lower()) and ('授权码' not in blob) and ('secret' not in blob.lower()),
        f'返回里出现敏感字样：{blob[:200]}')
require('5b. 能读的人拿到的投影里也没有凭据',
        'password' not in repr(service.projection(frappe.get_doc('Shangshu Mail Message', draft2), True)).lower(),
        '邮件投影里出现了 password 字样')

print(f"\n{'=' * 60}")
print(f"通过 {len(PASS)} 条，失败 {len(FAIL)} 条")
if FAIL:
    print('失败：')
    for f in FAIL:
        print(f'  - {f}')
frappe.db.rollback()
sys.exit(1 if FAIL else 0)
