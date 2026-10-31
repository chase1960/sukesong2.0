#!/usr/bin/env python3
"""三个老毛病的**复现核查**（照定位草稿的判据重做，如实记）。

定位草稿：`fde/开发/验收/草稿-三个老毛病复现定位-2026-10-13.md`
三句判据**在动代码之前就写死**了，这一份只负责照着验，不改判据。

测试通过 = 下面三条**同时**成立（判据原文照抄，不另造）：

 1. **丢正文** —— 「存草稿再打开，正文（含换行和空行）跟写的时候**逐字一致**，
    不是只留下了标题」
 2. **存错草稿** —— 「从哪个身份写，草稿**只**落进那个身份的草稿箱，
    别的身份的草稿箱里**翻不到**」
 3. **发错人** —— 「捕获器里**恰好一封**、收件人**只有目标那一个**，
    真实发信通道**零调用**」

**边界**：第 3 条一律用隔离捕获器，**一次真实发送都不做**
（约束原文「测试只生成邮件内容或使用隔离捕获器，不触发真实发送」）。

跑在容器里（依赖 frappe）：
  docker cp …:/tmp/ && docker exec -w /home/frappe/frappe-bench … python /tmp/…
"""
import json
import sys
import unittest.mock
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
from shangshu_mail import transport

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

USER = '3bug-a@shangshu.local'
TAG = '3BUG'


def cleanup():
    frappe.set_user('Administrator')
    with account_mod.writing():
        for row in frappe.get_all('Shangshu Mail Account', filters={'display_name': TAG}, pluck='name'):
            hard_delete('Shangshu Mail Account', row)
    for doctype in ('Shangshu Mail Message',):
        for row in frappe.get_all(doctype, filters={'subject': ('like', f'{TAG}%')}, pluck='name'):
            hard_delete(doctype, row)
    frappe.db.commit()


ensure_user(USER)
cleanup()
frappe.set_user(USER)

# 两个箱：一个部门箱（写它的草稿），一个本人个人箱。
BOX = '3bug-dept-box'
with account_mod.writing():
    frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': BOX, 'kind': 'department',
                    'department': '3BUG 未用部门', 'provider': 'qq', 'email_address': '3bugdept@qq.com',
                    'display_name': TAG, 'enabled': 1, 'connection_status': 'connected',
                    'binding_generation': 'gen-3bug'}).insert(ignore_permissions=True)
    frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': account_mod.account_name(USER),
                    'kind': 'personal', 'provider': 'qq', 'email_address': '3buga@qq.com',
                    'display_name': TAG, 'enabled': 1, 'connection_status': 'connected',
                    'binding_generation': 'gen-3bug-a'}).insert(ignore_permissions=True)
frappe.db.commit()

from shangshu_core.public_api import execute_registered_action

BODY = ('你好：\n\n这是第一段。\n\n这是第二段，写长一点，好确认不是只存了个标题。\n\n谢谢')


def save(body, mailbox=None, subject=None):
    payload = {'subject': subject or f'{TAG} 草稿', 'body': body, 'to': ['x@y.invalid'], 'cc': [],
               'attachments': [], 'expected_version': 1}
    if mailbox:
        payload['mailbox'] = mailbox
    out = execute_registered_action('mail.save_draft', payload, confirmed=True, source='user',
                                    idempotency_key='3bug-' + frappe.generate_hash(length=16))
    frappe.db.commit()
    return out


def load(mail_name):
    """按产品那条路读回一封 —— 不直接掏库，走判定链。"""
    frappe.set_user(USER)
    return frappe.get_doc('Shangshu Mail Message', mail_name)


print('【1】丢正文 —— 存草稿再打开，正文逐字一致')
out1 = save(BODY, subject=f'{TAG} 丢正文')
mail1 = (out1 or {}).get('mail') or (out1 or {}).get('result', {}).get('mail') if isinstance(out1, dict) else None
if not mail1:
    # 有的版本回包键不同 —— 按 subject 找回
    mail1 = frappe.db.get_value('Shangshu Mail Message', {'subject': f'{TAG} 丢正文'}, 'name')
doc1 = load(mail1) if mail1 else None
require('1 正文逐字一致（含换行和空行）',
        doc1 is not None and (doc1.body or '') == BODY,
        f'存进去={BODY!r}\n  读回来={(doc1.body if doc1 else None)!r}')
require('1b 不是只留下标题',
        doc1 is not None and len((doc1.body or '').strip()) > 20,
        f'正文长度={len((doc1.body or "")) if doc1 else "无"}')
require('1c 换行还在',
        doc1 is not None and '\n\n' in (doc1.body or ''),
        f'读回来={doc1.body!r}' if doc1 else '没读到')

print()
print('【2】存错草稿 —— 从哪个身份写，只落进那个身份的草稿箱')
out2 = save('从共享箱写的一封', mailbox=BOX, subject=f'{TAG} 存错草稿')
mail2 = frappe.db.get_value('Shangshu Mail Message', {'subject': f'{TAG} 存错草稿'}, 'name')
doc2 = load(mail2) if mail2 else None
require('2 草稿住在共享箱里',
        doc2 is not None and doc2.mailbox_id == BOX,
        f'期望 mailbox_id={BOX}，实际={doc2.mailbox_id if doc2 else "没读到"}')

# 共享箱草稿箱里翻得到
frappe.set_user(USER)
shared_drafts = frappe.get_all('Shangshu Mail Message',
                               filters={'mailbox_id': BOX, 'status': 'Draft', 'subject': ('like', f'{TAG}%')},
                               pluck='name')
require('2b 共享箱草稿箱里翻得到',
        mail2 in shared_drafts, f'共享箱草稿={shared_drafts}，要找的是 {mail2}')

# 个人箱草稿箱里**翻不到** —— 判据的后半句，少了它就不算过
personal = account_mod.account_name(USER)
personal_drafts = frappe.get_all('Shangshu Mail Message',
                                 filters={'mailbox_id': personal, 'owner': USER, 'status': 'Draft',
                                          'subject': ('like', f'{TAG}%')}, pluck='name')
require('2c 个人箱草稿箱里翻不到',
        mail2 not in personal_drafts,
        f'个人箱草稿={personal_drafts}，不该含 {mail2}')

# 走产品查询那条路再验一次（query 不带 mailbox = 本人个人箱）
q = __import__('shangshu_mail.service', fromlist=['query']).query('mail.message', {'scope': 'draft'}, 1, 50)
qrows = (q or {}).get('records') or (q or {}).get('rows') or (q or {}).get('data') or []
qids = [r.get('name') or r.get('id') for r in qrows if isinstance(r, dict)]
require('2d 走查询接口也翻不到',
        mail2 not in qids, f'查询结果={qids}，不该含 {mail2}')

print()
print('【3】发错人 —— 捕获器里恰好一封、收件人只有目标那一个，真实通道零调用')
captured = []
real_smtp_calls = []


class _Capture:
    def __init__(self, *a, **k):
        pass

    def login(self, *a, **k):
        pass

    def send_message(self, message, **kw):
        captured.append(message)
        return {}

    def quit(self):
        pass

    def close(self):
        pass


class _RealGuard:
    """真 SMTP 一旦被碰到就记一笔 —— 「零调用」要有证据，不是「应该没调」。"""

    def __init__(self, *a, **k):
        real_smtp_calls.append('constructed')
        raise AssertionError('真实发信通道被调用了')

TARGET = 'jiangzheny@lingeringtek.cn'   # 只发给用户自己
SENDCFG = {'subject': f'{TAG} 发错人核查', 'body': 'x', 'body_format': 'Text',
           'to': [TARGET], 'cc': [], 'message_id': '<3bug-send@x>'}

with unittest.mock.patch.object(transport.smtplib, 'SMTP_SSL', _Capture), \
        unittest.mock.patch.object(transport.smtplib, 'SMTP', _RealGuard):
    r = transport.send_message('3buga@qq.com', 'synthetic', '核查员', SENDCFG, [])

require('3 捕获器里恰好一封',
        len(captured) == 1, f'捕获器收到 {len(captured)} 封')
if captured:
    to_all = [a.strip() for a in str(captured[0]['To'] or '').split(',') if a.strip()]
    require('3b 收件人只有目标那一个',
            any(TARGET in a for a in to_all) and len(to_all) == 1,
            f'收件人={to_all}，期望只有 {TARGET} 一个')
    require('3c 不多出抄送/密送',
            not captured[0]['Cc'] and not captured[0]['Bcc'],
            f'Cc={captured[0]["Cc"]} Bcc={captured[0]["Bcc"]}')
require('3d 真实发信通道零调用',
        not real_smtp_calls, f'真实通道被调用了：{real_smtp_calls}')
require('3e 回包状态是已发出',
        isinstance(r, dict) and r.get('status') in ('Sent', 'Partial'),
        f'回包={r!r}')

print()
print('=' * 50)
print(f'通过 {len(PASS)} 条，失败 {len(FAIL)} 条')
if FAIL:
    print('未过：' + ' | '.join(FAIL))
    cleanup()
    sys.exit(1)
cleanup()
sys.exit(0)
