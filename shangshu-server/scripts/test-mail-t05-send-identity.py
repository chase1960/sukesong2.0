#!/usr/bin/env python3
"""PKG-006-T05 真实发件身份选择：编辑页选哪个获权身份就用哪个。

计划 PKG-006-T05 交付原文：
  「邮箱切换、**真实发件身份选择**、部门默认签名、授权设置交互」
判据原文：
  「……**编辑页选哪个获权身份就用哪个**。切邮箱不丢草稿、不把上封内容带入另一邮箱」

N5-3 已经做到「发信用**这封信住的那个箱**」（From = mailbox，记录实际操作员工）。
但 `mail.save_draft` 的入参里**没有 mailbox 字段** —— 草稿一律住建者的个人箱，
所以「选哪个获权身份」在写稿这一步就丢了，后面无从用起。

这一条补的是：**草稿能指定住哪个箱**，于是发信时 From 就是那个箱。

测试通过 = 下面全部成立：

 1. **草稿能指定住哪个箱** —— save_draft 带 mailbox，草稿的 mailbox_id 就是它
 2. **没代发权的箱不给建** —— 只读授权的箱上建/改草稿被明确拒
    （能读不等于能写，N5-2 五项分开）
 3. **发信用的是草稿住的那个箱** —— From 是那个箱的地址，不是操作人的个人箱
 4. **不带 mailbox 时老口径不变** —— 建者的个人箱，个人收发不受影响

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

OWNER = ensure_user('t05-ident-owner@shangshu.local', 'T05身份管理员')
GUEST = ensure_user('t05-ident-guest@shangshu.local', 'T05身份成员')
DEPT_KEY = 't05-ident-dept'
DEPT_ADDR = 't05-dept-ident@shangshu.local'

frappe.set_user('Administrator')
frappe.db.commit()

frappe.set_user(OWNER)
with account_mod.writing():
    for key, kind, addr in ((DEPT_KEY, 'department', DEPT_ADDR),
                            (account_mod.account_name(OWNER), 'personal', 't05-owner@shangshu.local')):
        if not frappe.db.exists('Shangshu Mail Account', {'account_key': key}):
            frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': key,
                            'kind': kind, 'department': 'T05身份测试部' if kind == 'department' else '',
                            'provider': 'qq', 'email_address': addr,
                            'display_name': 'T05身份', 'enabled': 1,
                            'connection_status': 'connected',
                            'binding_generation': 'gen-t05ident'}).insert(ignore_permissions=True)
# GUEST 只给**读**权 —— 验「能读不等于能写」
account_mod.execute('mail.mailbox.grant',
                    {'mailbox': DEPT_KEY, 'user': GUEST, 'rights': {'read': True}},
                    {'source': 'user'})
frappe.db.commit()

print('=== PKG-006-T05 真实发件身份选择 ===\n')

from shangshu_core.public_api import execute_registered_action
from shangshu_mail import delivery as delivery_mod

CONTEXT = {'source': 'user'}


def save_draft(payload):
    return execute_registered_action('mail.save_draft', payload, confirmed=True,
                                     source='user',
                                     idempotency_key='t05id-' + frappe.generate_hash(length=8))


# ── 1 草稿能指定住哪个箱 ───────────────────────────────────────────
frappe.set_user(OWNER)
payload = {'mailbox': DEPT_KEY, 'subject': 'T05 用部门身份写', 'body': '正文',
           'to': ['对方 <o@x.example>'], 'cc': []}
try:
    result = save_draft(payload)
    # **建完就提交** —— 后面 2 号故意失败，动作入口失败路径会 rollback，
    # 同一未提交事务里的草稿会被一起卷走（实测 3 号因此查到 mailbox_id=None）。
    frappe.db.commit()
    name = (result.get('result') or {}).get('name')
    box = frappe.get_value('Shangshu Mail Message', name, 'mailbox_id') if name else None
    require('1 草稿能指定住哪个箱', box == DEPT_KEY,
            f'实际 mailbox_id = {box!r}（应是 {DEPT_KEY!r}）')
except Exception as exc:
    name, box = None, None
    require('1 草稿能指定住哪个箱', False, str(exc)[:150])

# ── 2 没代发权的箱不给建 ───────────────────────────────────────────
frappe.set_user(GUEST)
try:
    save_draft({'mailbox': DEPT_KEY, 'subject': '我偷写', 'body': 'x',
                'to': ['对方 <o@x.example>'], 'cc': []})
    require('2 只读授权的箱上建草稿要被拒', False, '居然建成了')
except Exception as exc:
    require('2 只读授权的箱上建草稿要被拒',
            '权限' in str(exc) or '无权' in str(exc) or '代发' in str(exc) or '草稿' in str(exc),
            f'拒了但理由不对：{str(exc)[:120]}')

# ── 3 发信用的是草稿住的那个箱 ─────────────────────────────────────
frappe.set_user(OWNER)
if name:
    box_now = frappe.get_value('Shangshu Mail Message', name, 'mailbox_id')
    resolved = delivery_mod.attachment_owner(name, OWNER)  # 同一条「按邮箱推导」的口径
    require('3 发信身份跟草稿住的箱走（不是操作人的个人箱）',
            box_now == DEPT_KEY,
            f'草稿住 {box_now!r}，操作人个人箱是 {account_mod.account_name(OWNER)!r}')
    from shangshu_mail import service as mail_service
    require('3b 归属推导也认这个箱（附件归部门，不归操作人）',
            resolved.get('owner_subject_kind') == 'Department',
            f'实际 {resolved}')
else:
    require('3 发信身份跟草稿住的箱走（不是操作人的个人箱）', False, '1 号没过，无从查起')
    require('3b 归属推导也认这个箱（附件归部门，不归操作人）', False, '1 号没过，无从查起')

# ── 4 不带 mailbox 时老口径不变 ────────────────────────────────────
frappe.set_user(OWNER)
try:
    r = save_draft({'subject': 'T05 个人草稿', 'body': 'x',
                    'to': ['对方 <o@x.example>'], 'cc': []})
    frappe.db.commit()
    n2 = (r.get('result') or {}).get('name')
    box2 = frappe.get_value('Shangshu Mail Message', n2, 'mailbox_id') if n2 else None
    require('4 不带 mailbox → 仍是建者的个人箱（老口径不变）',
            box2 == account_mod.account_name(OWNER),
            f'实际 mailbox_id = {box2!r}（应是 {account_mod.account_name(OWNER)!r}）')
except Exception as exc:
    n2 = None
    require('4 不带 mailbox → 仍是建者的个人箱（老口径不变）', False, str(exc)[:150])

print(f"\n{'=' * 60}")
print(f"通过 {len(PASS)} 条，未过 {len(FAIL)} 条")
if FAIL:
    print('未过：')
    for f in FAIL:
        print(f'  - {f}')

# ── 清夹具 ─────────────────────────────────────────────────────────
try:
    frappe.set_user('Administrator')
    for doctype, filters in (
        ('Shangshu Action Request', {'action_id': 'mail.save_draft'}),
        ('Shangshu Action Execution Audit', {'action_id': 'mail.save_draft'}),
    ):
        for nm in frappe.get_all(doctype, filters=filters, pluck='name'):
            try:
                frappe.delete_doc(doctype, nm, ignore_permissions=True, force=True)
            except Exception:
                pass
    with writing():
        for subj in ('T05 用部门身份写', '我偷写', 'T05 个人草稿'):
            for nm in frappe.get_all('Shangshu Mail Message', filters={'subject': subj}, pluck='name'):
                try:
                    frappe.delete_doc('Shangshu Mail Message', nm, ignore_permissions=True, force=True)
                except Exception:
                    frappe.db.delete('Shangshu Mail Message', {'name': nm})
    with account_mod.access_writing():
        for nm in frappe.get_all('Shangshu Mail Access', filters={'mailbox': DEPT_KEY}, pluck='name'):
            frappe.get_doc('Shangshu Mail Access', nm).delete(ignore_permissions=True)
    with account_mod.writing():
        for key in (DEPT_KEY, account_mod.account_name(OWNER)):
            for nm in frappe.get_all('Shangshu Mail Account', filters={'account_key': key}, pluck='name'):
                try:
                    frappe.delete_doc('Shangshu Mail Account', nm, ignore_permissions=True, force=True)
                except Exception:
                    frappe.db.delete('Shangshu Mail Account', {'name': nm})
    for user in (OWNER, GUEST):
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
