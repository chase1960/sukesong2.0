#!/usr/bin/env python3
"""PKG-006-T05 部门默认签名：按**邮箱**设签名，不只个人箱。

计划 PKG-006-T05 交付原文：
  「邮箱切换、真实发件身份选择、**部门默认签名**、授权设置交互」
判据原文：
  「设置页由有权者选邮箱和成员、逐项配置权限；收件列表清楚标当前邮箱；
    编辑页选哪个获权身份就用哪个。……已手改签名切身份时明确保留/替换，不暗改正文」

SIG（PKG-005）交的是**个人**默认签名。这一条补**部门**那半：
有签名管理权的人能给**部门箱**设默认签名，写信自动带的是**那个箱**的签名。

测试通过 = 下面全部成立：

 1. **有签名管理权 → 能给部门箱设默认签名**
 2. **签名跟邮箱走** —— 部门箱回的是部门签名，个人箱回的是个人签名，互不串
 3. **没签名管理权 → 明确拒**（不是静默不生效）
 4. **改签名不给发信权** —— 设完签名，代发权仍然是关的（计划 §4.4
    「维护签名不授予发信权」）
 5. **旧草稿不随默认签名变** —— 已有草稿里插过的签名不被改写

跑在容器里（依赖 frappe）。
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
from shangshu_mail.service import writing

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

ADMIN = ensure_user('t05-sig-admin@shangshu.local', 'T05签名管理员')
MEMBER = ensure_user('t05-sig-member@shangshu.local', 'T05签名成员')
DEPT_KEY = 't05-sig-dept'
DEPT_NAME = 'T05签名测试部'

frappe.set_user('Administrator')
frappe.db.commit()

# 账号行由**邮箱属主**建 —— rights_for 认「账号行属主 = 这个邮箱的管理员」
frappe.set_user(ADMIN)
with account_mod.writing():
    if not frappe.db.exists('Shangshu Mail Account', {'account_key': DEPT_KEY}):
        frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': DEPT_KEY,
                        'kind': 'department', 'department': DEPT_NAME,
                        'provider': 'qq', 'email_address': 't05-dept@shangshu.local',
                        'display_name': DEPT_NAME, 'enabled': 1,
                        'connection_status': 'connected',
                        'binding_generation': 'gen-t05sig'}).insert(ignore_permissions=True)
# ADMIN 自己也有个个人箱（拿 get_account 老口径用）
with account_mod.writing():
    pkey = account_mod.account_name(ADMIN)
    if not frappe.db.exists('Shangshu Mail Account', {'account_key': pkey}):
        frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': pkey,
                        'kind': 'personal', 'department': '',
                        'provider': 'qq', 'email_address': 't05-personal@shangshu.local',
                        'display_name': 'T05个人', 'enabled': 1,
                        'connection_status': 'connected',
                        'binding_generation': 'gen-t05sig'}).insert(ignore_permissions=True)

# MEMBER 只给**读**权，不给签名管理权 —— 用来验「没签名管理权改不了」
account_mod.execute('mail.mailbox.grant',
                    {'mailbox': DEPT_KEY, 'user': MEMBER, 'rights': {'read': True}},
                    {'source': 'user'})
frappe.db.commit()

print('=== PKG-006-T05 部门默认签名 ===\n')

CONTEXT = {'source': 'user'}
DEPT_SIG = '<div>客服部签名 · 欢迎来电</div>'
PERSONAL_SIG = '<div>我的个人签名</div>'


# ── 4 先验「改签名不给发信权」：MEMBER 当前只有读权 ─────────────────
rights_before = account_mod.rights_for(DEPT_KEY, MEMBER)
require('4-前置. MEMBER 只有读权、没有签名管理权',
        rights_before.get('read') is True and rights_before.get('signature') is False,
        f'{rights_before}')

# ── 1 有签名管理权 → 能给部门箱设默认签名 ───────────────────────────
frappe.set_user(ADMIN)
try:
    account_mod.execute('mail.account.signature',
                        {'mailbox': DEPT_KEY, 'enabled': True, 'html': DEPT_SIG},
                        CONTEXT)
    require('1 有签名管理权 → 能给部门箱设默认签名', True)
except Exception as exc:
    require('1 有签名管理权 → 能给部门箱设默认签名', False, str(exc)[:150])

# ── 2 签名跟邮箱走 ─────────────────────────────────────────────────
acct_dept = frappe.get_value('Shangshu Mail Account', {'account_key': DEPT_KEY},
                             ['signature_enabled', 'signature_html'], as_dict=True)
require('2 部门箱的默认签名存上了',
        bool(acct_dept) and bool(acct_dept.signature_enabled)
        and acct_dept.signature_html == DEPT_SIG,
        f'{acct_dept}')

# 个人箱再设一个不一样的
try:
    account_mod.execute('mail.account.signature',
                        {'enabled': True, 'html': PERSONAL_SIG}, CONTEXT)
    personal_ok = True
    personal_err = ''
except Exception as exc:
    personal_ok = False
    personal_err = str(exc)[:150]
require('2b 个人箱的默认签名照旧能设', personal_ok, personal_err)

acct_p = frappe.get_value('Shangshu Mail Account', {'account_key': account_mod.account_name(ADMIN)},
                          ['signature_enabled', 'signature_html'], as_dict=True)
require('2c 两个箱各是各的，不串',
        (acct_dept or {}).get('signature_html') == DEPT_SIG
        and (acct_p or {}).get('signature_html') == PERSONAL_SIG,
        f'部门箱 = {(acct_dept or {}).get("signature_html")!r}；'
        f'个人箱 = {(acct_p or {}).get("signature_html")!r}')

# ── 3 没签名管理权 → 明确拒 ────────────────────────────────────────
frappe.set_user(MEMBER)
try:
    account_mod.execute('mail.account.signature',
                        {'mailbox': DEPT_KEY, 'enabled': True, 'html': '<div>我偷改的</div>'},
                        CONTEXT)
    require('3 没签名管理权 → 明确拒', False, '居然改成功了')
except Exception as exc:
    require('3 没签名管理权 → 明确拒',
            '权限' in str(exc) or '签名' in str(exc) or '无权' in str(exc),
            f'拒了但理由不对：{str(exc)[:120]}')
still = frappe.get_value('Shangshu Mail Account', {'account_key': DEPT_KEY}, 'signature_html')
require('3b 部门签名没被偷改', still == DEPT_SIG, f'实际 {still!r}')

# ── 4 改签名不给发信权 ─────────────────────────────────────────────
rights_after = account_mod.rights_for(DEPT_KEY, MEMBER)
require('4 改签名不给发信权（代发权仍是关的）',
        rights_after.get('send') is False,
        f'实际 {rights_after}')
require('4b 签名管理权也没被顺手打开', rights_after.get('signature') is False,
        f'实际 {rights_after}')

# ── 5 旧草稿不随默认签名变 ─────────────────────────────────────────
frappe.set_user(ADMIN)
with writing():
    draft = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Draft',
                            'subject': 'T05 旧草稿', 'body': '正文里已插过旧签名', 'body_format': 'Text',
                            'to_json': '["对方 <o@x.example>"]', 'cc_json': '[]',
                            'from_address': '我 <me@x.example>', 'record_version': 1,
                            'mailbox_id': DEPT_KEY,
                            'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
body_before = frappe.get_value('Shangshu Mail Message', draft.name, 'body')
# 再改一次默认签名
account_mod.execute('mail.account.signature',
                    {'mailbox': DEPT_KEY, 'enabled': True, 'html': '<div>换了个新签名</div>'},
                    CONTEXT)
body_after = frappe.get_value('Shangshu Mail Message', draft.name, 'body')
require('5 旧草稿不随默认签名变', body_before == body_after,
        f'改签名前 {body_before!r} → 改后 {body_after!r}')

print(f"\n{'=' * 60}")
print(f"通过 {len(PASS)} 条，未过 {len(FAIL)} 条")
if FAIL:
    print('未过：')
    for f in FAIL:
        print(f'  - {f}')

# ── 清夹具 ─────────────────────────────────────────────────────────
try:
    frappe.set_user('Administrator')
    with writing():
        for name in frappe.get_all('Shangshu Mail Message',
                                   filters={'subject': 'T05 旧草稿'}, pluck='name'):
            try:
                frappe.delete_doc('Shangshu Mail Message', name, ignore_permissions=True, force=True)
            except Exception:
                frappe.db.delete('Shangshu Mail Message', {'name': name})
    with account_mod.access_writing():
        for name in frappe.get_all('Shangshu Mail Access',
                                   filters={'mailbox': DEPT_KEY}, pluck='name'):
            frappe.get_doc('Shangshu Mail Access', name).delete(ignore_permissions=True)
    with account_mod.writing():
        for key in (DEPT_KEY, account_mod.account_name(ADMIN)):
            for name in frappe.get_all('Shangshu Mail Account',
                                       filters={'account_key': key}, pluck='name'):
                try:
                    frappe.delete_doc('Shangshu Mail Account', name, ignore_permissions=True, force=True)
                except Exception:
                    frappe.db.delete('Shangshu Mail Account', {'name': name})
    for user in (ADMIN, MEMBER):
        for identity in frappe.get_all('Shangshu Identity', filters={'user': user}, pluck='name'):
            try:
                frappe.delete_doc('Shangshu Identity', identity, ignore_permissions=True, force=True)
            except Exception:
                pass
        if frappe.db.exists('User', user):
            frappe.delete_doc('User', user, ignore_permissions=True, force=True)
    frappe.db.commit()
    print(f'夹具已清掉（账号键 {DEPT_KEY}）')
except Exception as cleanup_error:
    frappe.db.rollback()
    print(f'夹具清理失败，需人工清 {DEPT_KEY}：{str(cleanup_error)[:150]}')

sys.exit(1 if FAIL else 0)
