#!/usr/bin/env python3
"""MAIL-08 采用/拒绝两侧 —— **补上批准那侧的反例**。

先前只证了「驳回 = 零写」（`aecc9979`，Rejected 后只剩一份草稿）。
**没有批准那侧的反例，「不变」可能只是恒真** —— 执行失败也「不变」，
把失败当成了驳回的效果，那就白验了。

B 2026-10-14 的四条判据（经 moniter 转达，我采纳）：

  1. 造出且出现在**待审列表**
  2. **驳回后不再挂待审**，状态确实是 Rejected
     （光「数据没变」可能只是执行失败）
  3. 独立读回**逐字节不变**
  4. **反例：批准另一条，数据确实变了**
     —— 没这条，「不变」就是恒真

测试通过 = 上面四条**同时**成立。

走**真内核提案**（`propose_registered_action`，就是 `action_propose` 那个
HTTP 入口包的那一层）—— 造出来的是真的 `Shangshu Action Proposal` 记录，
不是桩、不是直接插库。

跑在容器里（依赖 frappe）：
  docker cp …:/tmp/ && docker exec -w /home/frappe/frappe-bench … python /tmp/…
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

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

USER = 'prop-a@shangshu.local'
TAG = 'PROP'


def cleanup():
    frappe.set_user('Administrator')
    with account_mod.writing():
        for row in frappe.get_all('Shangshu Mail Account', filters={'display_name': TAG}, pluck='name'):
            hard_delete('Shangshu Mail Account', row)
    for doctype, filt in (('Shangshu Mail Message', {'subject': ('like', f'{TAG}%')}),
                          ('Shangshu Action Proposal', {'action_id': 'mail.save_draft'})):
        for row in frappe.get_all(doctype, filters=filt, pluck='name'):
            hard_delete(doctype, row)
    frappe.db.commit()


ensure_user(USER)
cleanup()
frappe.set_user(USER)
with account_mod.writing():
    frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': account_mod.account_name(USER),
                    'kind': 'personal', 'provider': 'qq', 'email_address': 'propa@qq.com',
                    'display_name': TAG, 'enabled': 1, 'connection_status': 'connected',
                    'binding_generation': 'gen-prop'}).insert(ignore_permissions=True)
frappe.db.commit()

from shangshu_core.actions import (propose_registered_action,
                                   list_action_proposals,
                                   resolve_action_proposal)

BODY = '提案核查用的正文'


def propose(subject):
    payload = {'subject': subject, 'body': BODY, 'to': ['x@y.invalid'], 'cc': [],
               'attachments': [], 'expected_version': 1}
    out = propose_registered_action('mail.save_draft', payload,
                                    idempotency_key='prop-' + frappe.generate_hash(length=16),
                                    source='ai')
    frappe.db.commit()
    return out


def drafts_with(subject):
    frappe.set_user(USER)
    return frappe.get_all('Shangshu Mail Message',
                          filters={'subject': subject, 'status': 'Draft'}, pluck='name')


print('【1】造出且出现在待审列表')
p_reject = propose(f'{TAG} 驳回这条')
p_accept = propose(f'{TAG} 批准这条')
pid_reject = (p_reject or {}).get('proposal') or (p_reject or {}).get('id') or (p_reject or {}).get('name')
pid_accept = (p_accept or {}).get('proposal') or (p_accept or {}).get('id') or (p_accept or {}).get('name')
if not pid_reject and isinstance(p_reject, dict):
    pid_reject = p_reject.get('result', {}).get('proposal') if isinstance(p_reject.get('result'), dict) else None
if not pid_accept and isinstance(p_accept, dict):
    pid_accept = p_accept.get('result', {}).get('proposal') if isinstance(p_accept.get('result'), dict) else None
print(f'      驳回那条提案={pid_reject}  批准那条提案={pid_accept}')
require('1 两条提案都造出来了',
        bool(pid_reject) and bool(pid_accept), f'回包 reject={p_reject!r} accept={p_accept!r}')

pending = list_action_proposals('Proposed') or []
pending_ids = [str(r.get('name') or r.get('proposal') or r.get('id')) for r in (pending if isinstance(pending, list) else pending.get('proposals', []))]
require('1b 两条都挂在待审列表里',
        str(pid_reject) in pending_ids and str(pid_accept) in pending_ids,
        f'待审列表={pending_ids}')

print()
print('【2】【3】驳回后不再挂待审、状态确实是 Rejected、独立读回逐字节不变')
# 驳回前先独立读一次「现在有没有这条草稿」
before = drafts_with(f'{TAG} 驳回这条')
resolve_action_proposal(pid_reject, 'rejected')
frappe.db.commit()

row = frappe.get_doc('Shangshu Action Proposal', pid_reject) if frappe.db.exists('Shangshu Action Proposal', pid_reject) else None
status_reject = (row.status if row else None) or (row.docstatus if row else None)
require('2 驳回后状态确实是 Rejected（不是「数据没变」糊过去）',
        str(status_reject).lower() in ('rejected','reject'), f'状态={status_reject!r}')

after_pending = list_action_proposals('Proposed') or []
after_ids = [str(r.get('name') or r.get('proposal') or r.get('id')) for r in (after_pending if isinstance(after_pending, list) else after_pending.get('proposals', []))]
require('2b 驳回后不再挂待审',
        str(pid_reject) not in after_ids, f'待审列表={after_ids}')

after = drafts_with(f'{TAG} 驳回这条')
require('3 独立读回逐字节不变 —— 驳回那条一份草稿都没建',
        before == after == [], f'驳回前={before} 驳回后={after}')

print()
print('【4】★ 反例：批准另一条，数据确实变了')
before_ok = drafts_with(f'{TAG} 批准这条')
resolve_action_proposal(pid_accept, 'confirmed')
frappe.db.commit()
after_ok = drafts_with(f'{TAG} 批准这条')
require('4 批准后草稿真的建出来了（没有这条，驳回的「不变」就是恒真）',
        len(before_ok) == 0 and len(after_ok) >= 1,
        f'批准前={before_ok} 批准后={after_ok}')

if after_ok:
    doc = frappe.get_doc('Shangshu Mail Message', after_ok[0])
    require('4b 批准建出来的草稿内容对得上',
            (doc.body or '') == BODY and (doc.subject or '') == f'{TAG} 批准这条',
            f'主题={doc.subject!r} 正文={doc.body!r}')

row_ok = frappe.get_doc('Shangshu Action Proposal', pid_accept) if frappe.db.exists('Shangshu Action Proposal', pid_accept) else None
require('4c 批准那条状态是 Approved',
        row_ok is not None and str(getattr(row_ok, 'status', '')).lower() in ('confirmed','approved','executed','done'),
        f'状态={getattr(row_ok, "status", None) if row_ok else None!r}')

print()
print('=' * 50)
print(f'通过 {len(PASS)} 条，失败 {len(FAIL)} 条')
if FAIL:
    print('未过：' + ' | '.join(FAIL))
    cleanup()
    sys.exit(1)
cleanup()
sys.exit(0)
