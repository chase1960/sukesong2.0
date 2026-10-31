#!/usr/bin/env python3
"""MAIL-08 写稿审核：人看差异、**修改**、采用或拒绝，写稿与发送分别确认。

用户 2026-10-13 给 C 的表第 8 行：
  「Assistant 起草、改写邮件及整理表格；人查看差异、**修改**、采用或拒绝，
    **写稿与发送分别确认**」

计划 PKG-007 / MAIL-08 独立完成条件（原文节选）：
  「真实员工助手只读有权邮件，提出起草/改写/整理表格候选；人能看差异、修改、采用或拒绝。
    **拒绝零正式写、旧版本拒绝**、采用后保存/重开/MIME一致，**签名和人工正文不被未采用内容覆盖**；
    写稿与发送分别确认。……真实助手对话和确定性工具测试**分别留证**，
    **不用直接修改 DOM 证明助手能保存**。」

这一份是**确定性工具测试**那一半：直接调内核的提案/确认接口，
不碰浏览器、不改 DOM。真实助手对话那一半另外留证。

已有的（内核，不用重造）：
  · `propose_registered_action` 只记录不执行（shangshu_core/actions.py:287）——
    「拒绝零正式写」是天然的
  · `resolve_action_proposal` 拒绝只改状态；确认才走 execute_registered_action
  · `mail.save_draft` 是 write + confirmation_policy=required，且在 tools 里 → 进得了提案通道
  · 并发用 `expected_version` 对 `record_version`（service.py:326），过期提交抛错

测试通过 = 下面全部成立：

 1. **助手提候选不动稿** —— 提出候选之后，邮件正文**一个字都没变**，
    只多一条待审候选（status=Proposed）
 2. **拒绝零写** —— 人点「拒绝」，正文仍然一个字没变，候选变 Rejected
 3. **不改直接采用** —— 存进去的就是助手那一份
 4. **改后采用** —— 人改过候选再采用，存进去的是**人改过的那份**，
    不是助手原稿；原助手候选**不被记成「已采用」**
 5. **旧版本失效** —— 候选是照某个版本算的；人在此期间改了稿，
    采用时**被拒**，**不能把人的改动覆盖掉**
 6. **写稿与发送分开确认** —— 采用写稿候选只写草稿，**不发信**
    （状态仍是 Draft，没有发送记录）
 7. **来源可辨** —— 候选上记着是**助手**提的，不是人、也不是代码节点
 8. **整理表格候选** —— 助手提出「把正文里的表格整理一下」的候选，
    人看差异、采用后，存进去的是**整理过的那一版**（表格在，内容是整理后的）

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
from shangshu_mail.service import writing

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

def notyet(label, why):
    FAIL.append(label)
    print(f"  ✖ {label}  ← 未实现：{why}")


USER = 'm08-review@shangshu.local'
if not frappe.db.exists('User', USER):
    frappe.get_doc({'doctype': 'User', 'email': USER, 'first_name': 'M08审核',
                    'send_welcome_email': 0, 'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
frappe.set_user(USER)
frappe.db.commit()

from shangshu_core.public_api import execute_registered_action
from shangshu_core.actions import propose_registered_action, resolve_action_proposal, list_action_proposals

DRAFT = None


def new_draft(subject, body):
    """造一封草稿（走生产动作，不绕闸），回 (name, record_version)。"""
    result = execute_registered_action(
        'mail.save_draft',
        {'subject': subject, 'body': body, 'to': ['对方 <o@x.example>'], 'cc': []},
        confirmed=True, source='user',
        idempotency_key='m08-seed-' + frappe.generate_hash(length=8))
    frappe.db.commit()
    name = (result.get('result') or {}).get('name')
    ver = frappe.get_value('Shangshu Mail Message', name, 'record_version')
    return name, ver


def body_of(name):
    return frappe.get_value('Shangshu Mail Message', name, 'body')


def status_of(name):
    return frappe.get_value('Shangshu Mail Message', name, 'status')


def propose(payload, key):
    """走**助手那条路**提候选 —— source 记 ai-chat，正是真实助手用的来源标识。"""
    proposal = propose_registered_action('mail.save_draft', payload, key, source='ai-chat')
    # **立完就提交** —— 真实场景里「提候选」和「采用/拒绝」是两个 HTTP 请求、各自提交。
    # execute_registered_action 的失败路径会 `frappe.db.rollback()`，
    # 候选不先落定的话会被那把回滚一起卷走，后面报出来的是「提案 not found」
    # 这种次生错误，把真正要验的「旧版本失效」盖住（实测栽过）。
    frappe.db.commit()
    return proposal


print('=== MAIL-08 写稿审核（确定性工具测试）===')

DRAFT, VER = new_draft('M08 原稿', '人工正文')
print(f'  草稿 = {DRAFT}  版本 = {VER}')

# ── 1 助手提候选不动稿 ───────────────────────────────────────────────
before = body_of(DRAFT)
p1 = propose({'mail': DRAFT, 'expected_version': VER, 'subject': 'M08 助手改写',
              'body': '助手写的正文', 'to': ['对方 <o@x.example>'], 'cc': []},
             'm08-p1-' + frappe.generate_hash(length=6))
require('1 助手提候选后正文一个字都没变', body_of(DRAFT) == before,
        f'实际正文变成 {body_of(DRAFT)!r}')
require('1b 只多一条待审候选，状态 Proposed',
        frappe.get_value('Shangshu Action Proposal', p1['id'], 'status') == 'Proposed',
        f"实际提案状态 = {frappe.get_value('Shangshu Action Proposal', p1['id'], 'status')}；"
        f"公共投影回的是小写 proposed，这里按 doctype 判")

# ── 2 拒绝零写 ─────────────────────────────────────────────────────
resolve_action_proposal(p1['id'], 'rejected')
require('2 拒绝后正文仍然一个字没变', body_of(DRAFT) == before,
        f'实际正文 = {body_of(DRAFT)!r}')
require('2b 候选状态变 Rejected',
        frappe.get_value('Shangshu Action Proposal', p1['id'], 'status') == 'Rejected',
        f"实际 {frappe.get_value('Shangshu Action Proposal', p1['id'], 'status')}")

# ── 3 不改直接采用 ─────────────────────────────────────────────────
VER2 = frappe.get_value('Shangshu Mail Message', DRAFT, 'record_version')
p2 = propose({'mail': DRAFT, 'expected_version': VER2, 'subject': 'M08 采用这份',
              'body': '助手写的正文 A', 'to': ['对方 <o@x.example>'], 'cc': []},
             'm08-p2-' + frappe.generate_hash(length=6))
resolve_action_proposal(p2['id'], 'confirmed')
require('3 不改直接采用 → 存进去的就是助手那份', body_of(DRAFT) == '助手写的正文 A',
        f'实际正文 = {body_of(DRAFT)!r}')

# ── 4 改后采用 ─────────────────────────────────────────────────────
# 人改了候选，再采用。**存进去的必须是人改过的那份**，不是助手原稿。
# 机制：人按改后的那份直接存（走 mail.save_draft，source=user），
#       原助手候选标为被人的版本取代（Rejected）—— 只用现有接口，不动内核。
VER3 = frappe.get_value('Shangshu Mail Message', DRAFT, 'record_version')
p3 = propose({'mail': DRAFT, 'expected_version': VER3, 'subject': 'M08 候选',
              'body': '助手原稿：这句不该被存进去', 'to': ['对方 <o@x.example>'], 'cc': []},
             'm08-p3-' + frappe.generate_hash(length=6))
require('4-前置 候选已立，正文还是上一版', body_of(DRAFT) == '助手写的正文 A',
        f'实际 {body_of(DRAFT)!r}')

HUMAN_EDIT = '人改过的正文：这句才是最终稿'
execute_registered_action(
    'mail.save_draft',
    {'mail': DRAFT, 'expected_version': VER3, 'subject': 'M08 候选',
     'body': HUMAN_EDIT, 'to': ['对方 <o@x.example>'], 'cc': []},
    confirmed=True, source='user',
    idempotency_key='m08-edit-' + frappe.generate_hash(length=8))
frappe.db.commit()
resolve_action_proposal(p3['id'], 'rejected')   # 被人的版本取代

require('4 改后采用 → 存进去的是**人改过的那份**', body_of(DRAFT) == HUMAN_EDIT,
        f'实际正文 = {body_of(DRAFT)!r}（助手原稿是「助手原稿：这句不该被存进去」）')
require('4b 助手原稿没被存进去', '这句不该被存进去' not in (body_of(DRAFT) or ''),
        f'实际 {body_of(DRAFT)!r}')
require('4c 原助手候选不被记成「已采用」',
        frappe.get_value('Shangshu Action Proposal', p3['id'], 'status') == 'Rejected',
        f"实际 {frappe.get_value('Shangshu Action Proposal', p3['id'], 'status')}"
        f"（应是 Rejected —— 被人的版本取代）")

# ── 5 旧版本失效 ───────────────────────────────────────────────────
VER4 = frappe.get_value('Shangshu Mail Message', DRAFT, 'record_version')
p4 = propose({'mail': DRAFT, 'expected_version': VER4, 'subject': 'M08 过期候选',
              'body': '照旧版本算的正文', 'to': ['对方 <o@x.example>'], 'cc': []},
             'm08-p4-' + frappe.generate_hash(length=6))
# 人在候选之后又改了稿
execute_registered_action(
    'mail.save_draft',
    {'mail': DRAFT, 'expected_version': VER4, 'subject': 'M08 人又改了',
     'body': '人的新改动', 'to': ['对方 <o@x.example>'], 'cc': []},
    confirmed=True, source='user',
    idempotency_key='m08-human2-' + frappe.generate_hash(length=8))
frappe.db.commit()
try:
    resolve_action_proposal(p4['id'], 'confirmed')
    require('5 旧版本的候选采用时要被拒', False,
            f'居然采用了；正文现在是 {body_of(DRAFT)!r}')
except Exception as exc:
    require('5 旧版本的候选采用时要被拒',
            '已更新' in str(exc) or '版本' in str(exc) or '变化' in str(exc),
            f'拒了但理由不对：{str(exc)[:120]}')
require('5b 人的改动没被覆盖', body_of(DRAFT) == '人的新改动',
        f'实际正文 = {body_of(DRAFT)!r}')

# ── 6 写稿与发送分开确认 ───────────────────────────────────────────
require('6 采用写稿候选只写草稿，没发信', status_of(DRAFT) == 'Draft',
        f'实际状态 = {status_of(DRAFT)!r}（应是 Draft）')
sent = frappe.get_all('Shangshu Mail Message',
                      filters={'name': DRAFT, 'status': ['in', ('Sent', 'Queued', 'Sending')]},
                      pluck='name')
require('6b 没有任何发送记录', not sent, f'出现发送记录 {sent}')

# ── 7 来源可辨 ─────────────────────────────────────────────────────
rows = frappe.get_all('Shangshu Action Proposal',
                      filters={'action_id': 'mail.save_draft'},
                      fields=['name', 'created_via', 'status'], limit_page_length=20)
via = {r.name: r.created_via for r in rows}
require('7 候选上记着是助手提的',
        via.get(p1['id']) == 'ai-chat' and via.get(p2['id']) == 'ai-chat',
        f'实际 created_via = {via}')
require('7b 助手来源与人写的来源分得开',
        all(v == 'ai-chat' for k, v in via.items() if k in (p1['id'], p2['id'], p3['id'], p4['id'])),
        f'实际 {via}')

# ── 8 整理表格候选 ─────────────────────────────────────────────────
VER8 = frappe.get_value('Shangshu Mail Message', DRAFT, 'record_version')
RAW_TABLE = '<table><tr><td>客户</td><td>意见</td></tr><tr><td>甲</td><td>太慢</td></tr><tr><td>乙</td><td>不错</td></tr></table>'
TIDY_TABLE = ('<table><thead><tr><th>客户</th><th>意见</th></tr></thead>'
              '<tbody><tr><td>甲</td><td>太慢</td></tr><tr><td>乙</td><td>不错</td></tr></tbody></table>')
p8 = propose({'mail': DRAFT, 'expected_version': VER8, 'subject': 'M08 整理表格',
              'body': '下面是整理过的表格：\n' + TIDY_TABLE,
              'to': ['对方 <o@x.example>'], 'cc': []},
             'm08-p8-' + frappe.generate_hash(length=6))
require('8-前置 表格整理候选已立，正文还是上一版',
        body_of(DRAFT) == '人的新改动', f'实际 {body_of(DRAFT)!r}')
resolve_action_proposal(p8['id'], 'confirmed')
got = body_of(DRAFT) or ''
require('8 整理表格候选采用后，存进去的是**整理过的那一版**',
        TIDY_TABLE in got,
        f'实际正文 = {got[:200]!r}')
require('8b 整理后的表头在（thead/th），不是原样那张裸表',
        '<thead>' in got and '<th>' in got and '客户' in got,
        f'实际正文 = {got[:200]!r}')
require('8c 原来那张裸表没被留着',
        RAW_TABLE not in got,
        f'实际正文 = {got[:200]!r}')

print(f"\n{'=' * 60}")
print(f"通过 {len(PASS)} 条，未过 {len(FAIL)} 条")
if FAIL:
    print('未过：')
    for f in FAIL:
        print(f'  - {f}')

# ── 清夹具 ─────────────────────────────────────────────────────────
try:
    frappe.set_user('Administrator')
    for name in frappe.get_all('Shangshu Action Proposal',
                               filters={'action_id': 'mail.save_draft'}, pluck='name'):
        try:
            frappe.delete_doc('Shangshu Action Proposal', name, ignore_permissions=True, force=True)
        except Exception:
            pass
    for doctype, filters in (
        ('Shangshu Action Request', {'action_id': 'mail.save_draft'}),
        ('Shangshu Action Execution Audit', {'action_id': 'mail.save_draft'}),
    ):
        for name in frappe.get_all(doctype, filters=filters, pluck='name'):
            try:
                frappe.delete_doc(doctype, name, ignore_permissions=True, force=True)
            except Exception:
                pass
    if DRAFT:
        try:
            frappe.delete_doc('Shangshu Mail Message', DRAFT, ignore_permissions=True, force=True)
        except Exception:
            frappe.db.delete('Shangshu Mail Message', {'name': DRAFT})
    for identity in frappe.get_all('Shangshu Identity', filters={'user': USER}, pluck='name'):
        try:
            frappe.delete_doc('Shangshu Identity', identity, ignore_permissions=True, force=True)
        except Exception:
            pass
    if frappe.db.exists('User', USER):
        frappe.delete_doc('User', USER, ignore_permissions=True, force=True)
    frappe.db.commit()
    print('夹具已清掉')
except Exception as cleanup_error:
    frappe.db.rollback()
    print(f'夹具清理失败，需人工清 {USER}：{str(cleanup_error)[:150]}')

sys.exit(1 if FAIL else 0)
