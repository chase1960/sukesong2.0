#!/usr/bin/env python3
"""两个未读点能不能从**列表接口**上拿到 —— 按前端那套调法走一遍。

用户 2026-10-14 批注 5-1：「没有看到两个点，建议你截图给我」

排查到一半我先下过一次错结论：拿 `?scope=all&mailbox=dot-demo-box` 去打
`/api/platform/datasets/mail.message/records`，回了两封不相干的草稿，于是我
疑心「mailbox 过滤没被认」。**那是我调错了，不是产品坏了**：

  路由只读 `filters`（JSON 串）+ `page` + `page_length`，顶层参数被静默丢掉。
  前端是把 mailbox **塞进 filters 里**的（mail-center.js 的 load()）：
      filterParams = {scope: box, q: …, order: …, mailbox: currentBox.id}
      ?page=1&page_length=30&filters=<上面那坨 JSON>

所以这条测试只做一件事：**用前端同一套调法**去问 `query()`，
看两个点的数据到底出不出来。

测试通过 = 下面全部成立：

 1. 按前端调法查部门箱，那封信**真的在返回行里**
 2. 那一行上**两个未读点都是 True**（我的 + 部门的）
 3. `unread_counts` 两套数分开报，都是 1
 4. 两个人（甲乙）各自查，**各看得见自己的两个点**
 5. **反例**：不指定 mailbox（默认本人个人箱）时，部门箱那封**不该冒出来**
 6. **反例**：无读权的人查这个箱，被拒，不是回空列表糊弄

跑在容器里（依赖 frappe）。**用公共跑具**，它会把公共件 `mail_fixture.py`
连着这份一起喂进容器（`require`/`hard_delete`/`ensure_user` 只留一份定义）：

  sh shangshu-server/scripts/run-mail-test.sh shangshu-server/scripts/test-mail-dot-via-query.py

⚠️ 不要再用旧的 `docker exec … python - < 本文件` 单喂 ——
   那样那几个函数找不到，跑不起来。迁过的脚本一律走跑具。
"""
import json
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

PASS, FAIL = [], []


TAG = 'DOTQ'
BOX = f'{TAG}-box'
A = 'dotq-a@shangshu.local'
B = 'dotq-b@shangshu.local'
OUT = 'dotq-out@shangshu.local'


def cleanup():
    frappe.set_user('Administrator')
    # 每张表开它自己那个写开关，别串着开 —— 串了会在硬删时被守卫挡下，
    # 退化成 frappe.db.delete 绕钩子。
    with account_mod.access_writing():
        for row in frappe.get_all('Shangshu Mail Access', filters={'mailbox': BOX}, pluck='name'):
            hard_delete('Shangshu Mail Access', row)
    with account_mod.writing():
        for row in frappe.get_all('Shangshu Mail Account', filters={'display_name': TAG}, pluck='name'):
            hard_delete('Shangshu Mail Account', row)
    tag_mails = [r for r in frappe.get_all('Shangshu Mail Message',
                                           filters={'subject': ('like', f'{TAG}%')}, pluck='name')]
    # 只清本测试这几封的已读行 —— 不再 db.delete 全表，那会把整站别人的已读状态抹掉。
    if tag_mails:
        frappe.db.delete('Shangshu Mail Read', {'mail': ('in', tag_mails)})
    if tag_mails:
        with service.writing():
            for row in tag_mails:
                hard_delete('Shangshu Mail Message', row)
    frappe.db.commit()


# ---- 夹具：一个部门箱，甲乙都有读权，一封信谁都没读 ----
for u in (A, B, OUT):
    ensure_user(u)

cleanup()
frappe.set_user('Administrator')
with account_mod.writing():
    frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': BOX,
                    'kind': 'department', 'provider': 'qq', 'email_address': 'dotq@shangshu.local',
                    'display_name': TAG, 'enabled': 1, 'connection_status': 'connected',
                    'binding_generation': 'gen-dotq'}).insert(ignore_permissions=True)
# 授权表有守卫：必须走授权管理动作（N5-2），不许直接插库冒充。
# 建箱的人是属主 → 自带 manage 权，能替甲乙开。
for u in (A, B):
    account_mod.grant(payload={'mailbox': BOX, 'user': u,
                               'rights': {'read': 1, 'edit_draft': 1, 'send': 1,
                                          'manage': 0, 'signature': 0}})
frappe.db.commit()

frappe.set_user(A)
# 邮件表的守卫是 `service.writing()`（flags.shangshu_mail_write）——
# account_mod.writing() 开的是**账户表**那个开关（shangshu_mail_account_write），
# 对邮件表不认，直接插会被 validate 挡下「邮件修改必须经过受管动作」。
with service.writing():
    mail = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
                           'subject': f'{TAG} 双点', 'body': 'x', 'body_format': 'Text',
                           'to_json': '["我"]', 'cc_json': '[]',
                           'from_address': '对方 <o@x.example>', 'record_version': 1,
                           'mailbox_id': BOX, 'owner': A,
                           'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
    MAIL = mail.name
frappe.db.commit()

# ---- 前端那套调法：mailbox 在 filters 里 ----
FRONTEND_FILTERS = {'scope': 'all', 'q': '', 'order': 'desc', 'mailbox': BOX}

print('【1】按前端调法查部门箱，那封信真的在返回行里')
frappe.set_user(A)
out = service.query('mail.message', filters=dict(FRONTEND_FILTERS), page=1, page_length=30)
rows = out.get('rows') or []
hit = next((r for r in rows if r.get('name') == MAIL), None)
require('1 那封信回来了', hit is not None,
        f'回来的 names={[r.get("name") for r in rows]} total={out.get("total")}')

print()
print('【2】那一行上两个未读点都是 True')
require('2 my_unread=True', bool(hit and hit.get('my_unread')),
        f'实际={hit.get("my_unread") if hit else "没这行"}')
require('2b dept_unread=True', bool(hit and hit.get('dept_unread')),
        f'实际={hit.get("dept_unread") if hit else "没这行"}')

print()
print('【3】unread_counts 两套数分开报，都是 1')
counts = out.get('unread_counts') or {}
require('3 mine=1 且 dept=1（两套分开、不相加）',
        counts.get('mine') == 1 and counts.get('dept') == 1,
        f'实际={counts}')

print()
print('【4】乙来查，也看得见自己的两个点')
frappe.set_user(B)
outB = service.query('mail.message', filters=dict(FRONTEND_FILTERS), page=1, page_length=30)
hitB = next((r for r in (outB.get('rows') or []) if r.get('name') == MAIL), None)
require('4 乙也拿到那封信', hitB is not None, f'rows={outB.get("rows") and [r.get("name") for r in outB["rows"]]}')
require('4b 乙的两个点也都是 True',
        bool(hitB and hitB.get('my_unread') and hitB.get('dept_unread')),
        f'实际={hitB and (hitB.get("my_unread"), hitB.get("dept_unread"))}')
countsB = outB.get('unread_counts') or {}
require('4c 乙的两套数也是 1/1', countsB.get('mine') == 1 and countsB.get('dept') == 1,
        f'实际={countsB}')

print()
print('【5】反例：不指定 mailbox（默认本人个人箱）时，部门箱那封不该冒出来')
frappe.set_user(A)
outP = service.query('mail.message', filters={'scope': 'all', 'q': '', 'order': 'desc'},
                     page=1, page_length=30)
namesP = [r.get('name') for r in (outP.get('rows') or [])]
require('5 个人箱默认查询里没有那封部门信', MAIL not in namesP,
        f'实际回来了 {namesP}')

print()
print('【6】反例：无读权的人查这个箱，被拒，不是回空列表糊弄')
frappe.set_user(OUT)
try:
    service.query('mail.message', filters=dict(FRONTEND_FILTERS), page=1, page_length=30)
    require('6 无权查部门箱被拒', False, '居然没抛错 —— 变成回空列表糊弄人')
except (frappe.PermissionError, frappe.ValidationError):
    # require_right 抛的是 PermissionError（ValidationError 的子类）——
    # 「没权限」和「参数无效」都算拒，但**回空列表不算**。
    require('6 无权查部门箱被拒', True)
except Exception as e:
    require('6 无权查部门箱被拒', False, f'抛的是别的错：{type(e).__name__} {e}')

print()
print('=' * 50)
print(f'通过 {len(PASS)} 条，失败 {len(FAIL)} 条')
if FAIL:
    print('未过：' + ' | '.join(FAIL))
    cleanup()
    sys.exit(1)
cleanup()
sys.exit(0)
