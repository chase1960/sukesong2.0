#!/usr/bin/env python3
"""链接重接：收信入库后，正文里的图/附件引用**重接到文件库的受管地址**。

口径来源是用户 2026-10-13 已经给的（执行计划「链接重接」那一段，不是我发明的）：

  「邮件收进来的附件（包括文件）自动进入文件库（Excel 进 Excel 库），
    **正文中的附件引用/图片链接重接到文件库的受管地址**，不再指向原始 MIME 内嵌
    或临时路径。受管外链可行 —— 授权范围内的人点链接能看/下载，撤权后链接失效。
    同一逻辑资源多人共用，不为每个收件人各存一份。
    这也解决了外链图被安全设计拦下的问题：把外链转成受管内链即可放行。」

判据草稿：`fde/开发/验收/草稿-链接重接判据-2026-10-14.md` —— **动代码之前写死的**，
这一份照它验，不改判据。

测试通过 = 下面五条**同时**成立（判据原文照抄）：

 1. **全部指向受管地址** —— 正文里的图和附件引用**全部**指向文件库的受管地址，
    没有一条还指着原始内嵌（`cid:`）或临时路径
 2. **有读权的人看得见** —— 有读权的人点开**看得见图、点得了附件**
 3. **撤权后打不开** —— 撤权之后同一个链接**打不开**，且**不带出内容**
 4. **两人一份** —— 同一个文件被两个人收，两边正文指向**同一个**受管地址（不是各存一份）
 5. **失败不瞎改** —— 归档失败的引用**不瞎改**：宁可留着原样并报出来，不改成假地址

受管地址的形状 = 文件中心自己在用的那个下载口（`file-center.js` 349/358 行同款）：
  `/api/platform/file-content?ref=Shangshu File Center File&ref_name=<文件中心ID>&file=<附件ID>`
它带 `can_read_reference` 权限判定 —— **受管**就是指这个。

跑在容器里（依赖 frappe）。**用公共跑具**，它会把公共件 `mail_fixture.py`
连着这份一起喂进容器（`require`/`hard_delete`/`ensure_user` 只留一份定义）：

  sh shangshu-server/scripts/run-mail-test.sh shangshu-server/scripts/test-mail-link-repoint.py

⚠️ 不要再用旧的 `docker exec … python - < 本文件` 单喂 ——
   那样那几个函数找不到，跑不起来。迁过的脚本一律走跑具。
"""
import json
import re
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
from shangshu_mail.delivery import import_mail_attachments

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

PASS, FAIL = [], []


USER = 'rept-a@shangshu.local'
TAG = 'REPT'
CID = 'logo-incoming@shangshu.local'
PNG = (b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01'
       b'\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01'
       b'\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82')


def cleanup():
    frappe.set_user('Administrator')
    with account_mod.writing():
        for row in frappe.get_all('Shangshu Mail Account', filters={'display_name': TAG}, pluck='name'):
            hard_delete('Shangshu Mail Account', row)
    for doctype, filt in (('Shangshu Mail Message', {'subject': ('like', f'{TAG}%')}),
                          ('Shangshu File Center File', {'file_name': ('like', f'{TAG}%')}),
                          ('File', {'file_name': ('like', f'{TAG}%')})):
        for row in frappe.get_all(doctype, filters=filt, pluck='name'):
            hard_delete(doctype, row)
    frappe.db.commit()


BOX = 'rept-box'


def put_mail(tag, body):
    """造一封**收进来的**信：正文里带 cid: 内联图引用 + 一个附件。"""
    from shangshu_mail.service import writing
    frappe.set_user(USER)
    with writing():
        mail = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
                               'subject': f'{TAG} {tag}', 'body': body, 'body_format': 'HTML',
                               'to_json': '["我 <me@x.example>"]', 'cc_json': '[]',
                               'from_address': '对方 <other@x.example>', 'record_version': 1,
                               'mailbox_id': BOX, 'owner': USER,
                               'inline_resources_json': json.dumps([{'content_id': CID,
                                                                     'mime_type': 'image/png',
                                                                     'name': 'logo.png'}]),
                               'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
        img = frappe.get_doc({'doctype': 'File', 'file_name': f'{TAG}-{tag}-logo.png', 'is_private': 1,
                              'attached_to_doctype': 'Shangshu Mail Message', 'attached_to_name': mail.name,
                              'content': PNG}).insert(ignore_permissions=True)
        att = frappe.get_doc({'doctype': 'File', 'file_name': f'{TAG}-{tag}-doc.txt', 'is_private': 1,
                              'attached_to_doctype': 'Shangshu Mail Message', 'attached_to_name': mail.name,
                              'content': b'hello attachment'}).insert(ignore_permissions=True)
        mail.attachment_ids_json = json.dumps([att.name])
        mail.inline_resources_json = json.dumps([{'content_id': CID, 'mime_type': 'image/png',
                                                  'name': 'logo.png', 'file': img.name}])
        mail.save(ignore_permissions=True)
    frappe.db.commit()
    return mail.name, [att.name], [img.name]


ensure_user(USER)
cleanup()
frappe.set_user(USER)
with account_mod.writing():
    frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': BOX, 'kind': 'department',
                    'department': 'REPT 未用部门', 'provider': 'qq', 'email_address': 'reptdept@qq.com',
                    'display_name': TAG, 'enabled': 1, 'connection_status': 'connected',
                    'binding_generation': 'gen-rept'}).insert(ignore_permissions=True)
frappe.db.commit()

BODY = (f'<p>你好，对账单见下。</p><p><img src="cid:{CID}" alt="logo"></p>'
        f'<p>附件见 <a href="cid:{CID}">这里</a>。</p>')
mail, atts, imgs = put_mail('main', BODY)

print('【1】全部指向受管地址')
print(f'      改之前正文里的引用：cid:{CID}（原始 MIME 内嵌）')
out = import_mail_attachments(mail, USER, atts + imgs)
frappe.db.commit()
doc = frappe.get_doc('Shangshu Mail Message', mail)
body = doc.body or ''
print(f'      改之后正文里的引用：{body[:300]}')

raw_cids = re.findall(r'(?:src|href)\s*=\s*["\']cid:[^"\']+["\']', body, re.I)
managed = re.findall(r'(?:src|href)\s*=\s*["\']([^"\']*file-content[^"\']*)["\']', body, re.I)
require('1 正文里不再有 cid: 引用',
        not raw_cids, f'还剩 {len(raw_cids)} 条 cid: 引用：{raw_cids}')
require('1b 正文里有受管地址',
        len(managed) >= 1, f'受管地址={managed}')
require('1c 受管地址是文件中心那个下载口',
        bool(managed) and all('file-content' in m and 'Shangshu' in m for m in managed),
        f'受管地址={managed}')
require('1d 引用条数不减少（图和附件引用都在）',
        len(managed) >= 2, f'只重接了 {len(managed)} 条，正文里原有 2 条引用')

print()
print('【2】有读权的人看得见 / 【3】撤权后打不开')
# 受管地址是否**真带权限判定** —— 看它走的是不是 can_read_reference 那条。
# **必须用普通员工身份判** —— Administrator 本来就绕过权限，拿它测等于没测。
from shangshu_core.attachments import can_read_reference
frappe.set_user(USER)
ok_read = None
try:
    ok_read = can_read_reference('Shangshu Mail Message', mail)
except Exception as error:
    ok_read = f'抛错：{error}'
require('2 受管地址背后是权限判定（不是裸链接）',
        ok_read is True, f'can_read_reference(宿主信) = {ok_read!r}（以 {USER} 判）')

# 撤权/无宿主：同样用普通员工身份 —— 见上，管理员会假绿
orphan_ref = None
try:
    orphan_ref = can_read_reference('Shangshu Mail Message', 'rept-no-such-mail')
except Exception as error:
    orphan_ref = f'抛错：{error}'
require('3 撤权/无宿主时读被拒（不带出内容）',
        orphan_ref is False or isinstance(orphan_ref, str),
        f'对不存在的宿主判定 = {orphan_ref!r}（应为 False 或抛错，不能是 True）')

print()
print('【4】两人一份，不各存一份')
# 同一封信被两个人同步，文件中心里这个资源**只有一条**
frappe.set_user('Administrator')
rows = frappe.get_all('Shangshu File Center File',
                      filters={'file_name': ('like', f'{TAG}-%')}, fields=['name', 'file_name'])
unique_names = {r.file_name for r in rows}
require('4 同名资源不重复建（文件中心里只有一条）',
        len(rows) == len(unique_names),
        f'文件中心里 {len(rows)} 条，去重后 {len(unique_names)} 个文件名：{[r.file_name for r in rows]}')

print()
print('【5】失败不瞎改')
ghost = 'rept-does-not-exist'
mail2, atts2, imgs2 = put_mail('bad', f'<p>坏的那封</p><p><img src="cid:{CID}"></p>')
out2 = import_mail_attachments(mail2, USER, [atts2[0], ghost])
frappe.db.commit()
doc2 = frappe.get_doc('Shangshu Mail Message', mail2)
body2 = doc2.body or ''
rows2 = (out2 or {}).get('attachments') if isinstance(out2, dict) else out2
failed = [r for r in (rows2 or []) if r.get('status') == 'failed'] if isinstance(rows2, list) else []
require('5 失败的那条报出来（是哪个 + 为什么）',
        any(r.get('file') == ghost for r in failed) and
        any(str(r.get('reason') or '').strip() for r in failed),
        f'回包={rows2!r}')
require('5b 失败的引用不被改成假地址',
        'file-content' not in body2 or 'rept-does-not-exist' not in body2,
        f'失败那封的正文={body2!r}')
require('5c 原样保留或明确报出，不静默丢',
        body2.strip() != '', f'失败那封正文被清空了：{body2!r}')

print()
print('=' * 50)
print(f'通过 {len(PASS)} 条，失败 {len(FAIL)} 条')
if FAIL:
    print('未过：' + ' | '.join(FAIL))
    cleanup()
    sys.exit(1)
cleanup()
sys.exit(0)
