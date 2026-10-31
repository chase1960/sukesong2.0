#!/usr/bin/env python3
"""来信附件自动入库：**失败必须冒头**，不许静默。

B 2026-10-14 指出的缺陷（他归进「看着像成功、其实没做」那一类，是第四条）：

  `import_mail_attachments` 把单条失败 `frappe.log_error` 一下就吞了，
  函数**不返回任何东西** —— 调用方（收信那条链）拿不到「哪个附件没进去、为什么」，
  看着收信成功，附件其实没进库。吞进失败日志等于把故障藏起来。

同一批里他已经栽过三次这个形状：
  · 审计表没有那列 → `except: return []` → 查询永远回空，和「真没记录」一样
  · 归属不落 → 判定无落点 → 越权反例「筛不到」而假绿
  · 五个用例共用一个来源附件 → 命中 already_imported 早退 → 看着在测，什么都没测

测试通过 = 下面全部成立：

 1. **全部成功时回包逐条记着结果** —— 每个附件一条 `imported`，没有 `failed`
 2. **失败要冒头** —— 回包里**指出是哪个附件 + 为什么**，不是只写内部日志
 3. **一个失败不拖累其它** —— 坏的那条记 failed，好的照样 imported
 4. **已归档过的不谎报失败** —— 记 `already`，共享箱几个人各同步一次是常态
 5. **回包是给调用方的** —— `import_mail_attachments` 有返回值，不是 None

跑在容器里（依赖 frappe）。**用公共跑具**，它会把公共件 `mail_fixture.py`
连着这份一起喂进容器（`require`/`hard_delete`/`ensure_user` 只留一份定义）：

  sh shangshu-server/scripts/run-mail-test.sh shangshu-server/scripts/test-mail-import-failures.py

⚠️ 不要再用旧的 `docker exec … python - < 本文件` 单喂 ——
   那样那几个函数找不到，跑不起来。迁过的脚本一律走跑具。
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
from shangshu_mail.delivery import import_mail_attachments

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

PASS, FAIL = [], []


USER = 'imf-a@shangshu.local'
BOX = 'imf-box'
TAG = 'IMF'


def cleanup():
    frappe.set_user('Administrator')
    with account_mod.writing():
        row = frappe.db.get_value('Shangshu Mail Account', {'account_key': BOX}, 'name')
        if row:
            hard_delete('Shangshu Mail Account', row)
    for doctype, filt in (('Shangshu Mail Message', {'subject': ('like', f'{TAG}%')}),
                          ('Shangshu File Center File', {'file_name': ('like', f'{TAG}%')}),
                          ('File', {'file_name': ('like', f'{TAG}%')})):
        for row in frappe.get_all(doctype, filters=filt, pluck='name'):
            hard_delete(doctype, row)
    frappe.db.commit()


def put_mail(tag):
    from shangshu_mail.service import writing
    frappe.set_user(USER)
    with writing():
        mail = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
                               'subject': f'{TAG} {tag}', 'body': 'x', 'body_format': 'Text',
                               'to_json': '["我 <me@x.example>"]', 'cc_json': '[]',
                               'from_address': '对方 <other@x.example>', 'record_version': 1,
                               'mailbox_id': BOX, 'owner': USER,
                               'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
        atts = []
        for i in range(2):
            atts.append(frappe.get_doc({'doctype': 'File', 'file_name': f'{TAG}-{tag}-{i}.txt',
                                        'is_private': 1, 'attached_to_doctype': 'Shangshu Mail Message',
                                        'attached_to_name': mail.name,
                                        'content': f'{TAG} {tag} {i}'.encode()}).insert(ignore_permissions=True))
    frappe.db.commit()
    return mail.name, [a.name for a in atts]


ensure_user(USER)
cleanup()
frappe.set_user(USER)
with account_mod.writing():
    frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': BOX, 'kind': 'department',
                    'department': 'IMF 市场部', 'provider': 'qq', 'email_address': 'imf@qq.com',
                    'display_name': TAG, 'enabled': 1, 'connection_status': 'connected',
                    'binding_generation': 'gen-imf'}).insert(ignore_permissions=True)
frappe.db.commit()

print('【1】全部成功时回包逐条记着结果')
mail1, atts1 = put_mail('ok')
frappe.set_user(USER)
out1 = import_mail_attachments(mail1, USER, atts1)
frappe.db.commit()
rows1 = out1 if isinstance(out1, list) else (out1 or {}).get('attachments') if isinstance(out1, dict) else None
require('1 回包逐条记着结果，没有 failed',
        isinstance(rows1, list) and len(rows1) == 2
        and all(r.get('status') == 'imported' for r in rows1),
        f'实际回包={out1!r}')
require('1b 回包带每个附件的身份',
        isinstance(rows1, list) and all(r.get('file') in atts1 for r in rows1),
        f'实际回包={rows1!r}；附件={atts1}')

print()
print('【2】失败要冒头 —— 指出是哪个附件 + 为什么')
mail2, atts2 = put_mail('bad')
ghost = 'imf-does-not-exist'
out2 = import_mail_attachments(mail2, USER, [atts2[0], ghost, atts2[1]])
frappe.db.commit()
rows2 = out2 if isinstance(out2, list) else (out2 or {}).get('attachments') if isinstance(out2, dict) else None
failed2 = [r for r in (rows2 or []) if r.get('status') == 'failed'] if isinstance(rows2, list) else []
require('2 失败要冒头，指出是哪个附件',
        isinstance(rows2, list) and any(r.get('file') == ghost for r in rows2)
        and any(r.get('file') == ghost and r.get('status') == 'failed' for r in rows2),
        f'实际回包={rows2!r}')
require('2b 失败要带原因，不是光一个 failed',
        any(r.get('file') == ghost and str(r.get('reason') or '').strip() for r in (rows2 or [])),
        f'实际回包={rows2!r}')

print()
print('【3】一个失败不拖累其它')
good3 = [r for r in (rows2 or []) if r.get('file') in atts2 and r.get('status') == 'imported']
require('3 好的那两条照样 imported',
        len(good3) == 2, f'实际回包={rows2!r}')

print()
print('【4】已归档过的不谎报失败 —— 记 already')
out4 = import_mail_attachments(mail2, USER, atts2)
frappe.db.commit()
rows4 = out4 if isinstance(out4, list) else (out4 or {}).get('attachments') if isinstance(out4, dict) else None
require('4 重导记 already，不谎报 failed',
        isinstance(rows4, list) and len(rows4) == 2
        and all(r.get('status') in ('already', 'already_imported') for r in rows4),
        f'实际回包={rows4!r}')

print()
print('【5】回包是给调用方的 —— 有返回值，不是 None')
require('5 import_mail_attachments 有返回值',
        out1 is not None and out2 is not None and out4 is not None,
        f'out1={out1!r} out2={out2!r} out4={out4!r}')

print()
print('=' * 50)
print(f'通过 {len(PASS)} 条，失败 {len(FAIL)} 条')
if FAIL:
    print('未过：' + ' | '.join(FAIL))
    cleanup()
    sys.exit(1)
cleanup()
sys.exit(0)
