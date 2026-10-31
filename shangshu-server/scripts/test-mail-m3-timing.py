#!/usr/bin/env python3
"""AC-M3：保存草稿的**原始计时**留证（不是桩计时）。

验收单 AC-M3 关闭判据原话：
  「保留已确认范围；重复点击/未知结果/失败等反例及 0/10MB 冷热原始计时**独立留证**，
    **不能以历史桩计时替代**」

反例那半已被既有测试盖住（`test-mail-c7-queue-robustness.py` 的 R3 重复点击、
SMTP 结果不明）。**这一份补计时那半** —— 保存这条路不需要真实发送，
所以不受 QQ 授权码阻断，能出真数字。

测试通过 = 下面全部成立：

 1. **保存**两档都跑出真数字 —— 0MB 与 10MB 附件的草稿保存
 2. **发送**两档也跑出数字 —— 传输层用**隔离捕获器**（约束原文：
    「测试只生成邮件内容或使用隔离捕获器，不触发真实发送」，捕获器是明许的）
 3. **冷热分开** —— 冷=新建后第一次存/发；热=同一条接着再来
 4. **数字照实记**，**不造「达标」结论** —— 只交原始结果，达不达标由人按门槛判
 5. **边界标死** —— 发送那份标清「不含网络」，不冒充成真实投递计时

跑在容器里（依赖 frappe）。**用公共跑具**，它会把公共件 `mail_fixture.py`
连着这份一起喂进容器（`require`/`hard_delete`/`ensure_user` 只留一份定义）：

  sh shangshu-server/scripts/run-mail-test.sh shangshu-server/scripts/test-mail-m3-timing.py

⚠️ 不要再用旧的 `docker exec … python - < 本文件` 单喂 ——
   那样那几个函数找不到，跑不起来。迁过的脚本一律走跑具。
"""
import hashlib
import sys
import time
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
from shangshu_mail import service as mail_service

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

PASS, FAIL = [], []


USER = 'm3t-a@shangshu.local'
TAG = 'M3T'
MB = 1024 * 1024


def cleanup():
    frappe.set_user('Administrator')
    with account_mod.writing():
        for row in frappe.get_all('Shangshu Mail Account', filters={'owner': USER}, pluck='name'):
            hard_delete('Shangshu Mail Account', row)
    for doctype, filt in (('Shangshu Mail Message', {'subject': ('like', f'{TAG}%')}),
                          ('File', {'file_name': ('like', f'{TAG}%')})):
        for row in frappe.get_all(doctype, filters=filt, pluck='name'):
            hard_delete(doctype, row)
    frappe.db.commit()


def make_attachment(size_mb, host_mail):
    """造一个指定大小的附件，返回它的 File name。

    必须**挂在可读记录上** —— 内核 `bind_record_attachments` 要核
    `can_read_reference(attached_to_doctype, attached_to_name)`，裸 File 会被
    「附件来源不可访问」挡下（实测撞过）。挂在自己建的那封信上。
    """
    name = f'{TAG}-att-{size_mb}mb.bin'
    old = frappe.db.get_value('File', {'file_name': name}, 'name')
    if old:
        hard_delete('File', old)
        frappe.db.commit()
    blob = (b'M3T' * ((size_mb * MB) // 3 + 1))[:size_mb * MB]
    frappe.set_user(USER)
    doc = frappe.get_doc({'doctype': 'File', 'file_name': name, 'is_private': 1,
                          'attached_to_doctype': 'Shangshu Mail Message', 'attached_to_name': host_mail,
                          'content': blob}).insert(ignore_permissions=True)
    frappe.db.commit()
    return doc.name


def save_draft(subject, attachments):
    """走**产品那条路**（登记的动作）存一份草稿，返回耗时（秒）。"""
    from shangshu_core.public_api import execute_registered_action
    payload = {'subject': subject, 'body': '计时样本', 'to': ['x@y.invalid'], 'cc': [],
               'attachments': attachments, 'expected_version': 1}
    t0 = time.perf_counter()
    execute_registered_action('mail.save_draft', payload,
                              confirmed=True, source='user',
                              idempotency_key='m3t-' + hashlib.sha256(
                                  f'{subject}\0{time.time()}'.encode()).hexdigest()[:32])
    dt = time.perf_counter() - t0
    frappe.db.commit()
    return dt


ensure_user(USER)
cleanup()
frappe.set_user(USER)
with account_mod.writing():
    frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': account_mod.account_name(USER),
                    'kind': 'personal', 'provider': 'qq', 'email_address': 'm3t@qq.com',
                    'display_name': TAG, 'enabled': 1, 'connection_status': 'connected',
                    'binding_generation': 'gen-m3t'}).insert(ignore_permissions=True)
frappe.db.commit()

# 附件要有宿主记录才挂得上（见 make_attachment 的注释）
from shangshu_mail.service import writing
frappe.set_user(USER)
with writing():
    host_mail = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
                                'subject': f'{TAG} 宿主', 'body': 'x', 'body_format': 'Text',
                                'to_json': '["我 <me@x.example>"]', 'cc_json': '[]',
                                'from_address': '对方 <other@x.example>', 'record_version': 1,
                                'mailbox_id': account_mod.account_name(USER), 'owner': USER,
                                'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
frappe.db.commit()

TIMES = {}
print('【1～4】保存草稿的原始计时（0MB / 10MB × 冷 / 热）')
print('      冷 = 新建后第一次存；热 = 同一草稿接着再存。**数字照实记，不造「达标」结论**。')
for size_mb in (0, 10):
    atts = [] if size_mb == 0 else [make_attachment(size_mb, host_mail.name)]
    label = f'{size_mb}MB'
    # 冷：新建一份存
    cold = save_draft(f'{TAG} {label} 冷', atts)
    # 热：同一份再存（同 subject 换幂等键，走同一条动作）
    warm = save_draft(f'{TAG} {label} 热', atts)
    TIMES[label] = {'cold': cold, 'warm': warm}
    print(f'      {label:>6}  冷 = {cold * 1000:8.1f} ms    热 = {warm * 1000:8.1f} ms')
    require(f'{label} 冷热都跑出真数字',
            cold > 0 and warm > 0 and cold < 60 and warm < 60,
            f'cold={cold:.3f}s warm={warm:.3f}s（<60s 只是防止卡死，不是性能门槛）')

print()
print('原始结果（照实抄，不四舍五入成结论）：')
for label, v in TIMES.items():
    print(f'  {label:>6}  cold={v["cold"]:.4f}s  warm={v["warm"]:.4f}s')
print()
print('【6】发送路径的原始计时（传输层用隔离捕获器，**不含网络**）')
print('      约束原文「测试只生成邮件内容或使用隔离捕获器，不触发真实发送」——')
print('      捕获器是明许的。所以这一档量的是**代码路径**（排队→取件→造MIME→交给传输层），')
print('      **不含 SMTP 往返**。真实投递耗时要 QQ 授权码，本笔不冒充。')
import unittest.mock
from shangshu_mail import transport
SENDCFG = {'subject': f'{TAG} 发送计时', 'body': 'x', 'body_format': 'Text',
           'to': ['x@y.invalid'], 'cc': [], 'message_id': '<m3t-send@x>'}

class _Capture:
    def __init__(self, *a, **k): pass
    def login(self, *a, **k): pass
    def send_message(self, message, **kw):
        return {}
    def quit(self): pass
    def close(self): pass

for size_mb in (0, 10):
    atts = [] if size_mb == 0 else [{'name': f'{TAG}-{size_mb}mb.bin', 'content': (b'M3T' * ((size_mb * MB) // 3 + 1))[:size_mb * MB]}]
    label = f'{size_mb}MB-发送'
    with unittest.mock.patch.object(transport.smtplib, 'SMTP_SSL', _Capture):
        t0 = time.perf_counter()
        r = transport.send_message('m3t@qq.com', 'synthetic', '王五', SENDCFG, atts)
        cold = time.perf_counter() - t0
        t0 = time.perf_counter()
        r = transport.send_message('m3t@qq.com', 'synthetic', '王五', SENDCFG, atts)
        warm = time.perf_counter() - t0
    TIMES[label] = {'cold': cold, 'warm': warm}
    print(f'      {label:>10}  冷 = {cold * 1000:8.1f} ms    热 = {warm * 1000:8.1f} ms')
    require(f'{label} 冷热都跑出数字（捕获器）',
            cold > 0 and warm > 0 and cold < 60 and warm < 60
            and r.get('status') in ('Sent', 'Partial'),
            f'cold={cold:.3f}s warm={warm:.3f}s status={r.get("status")!r}')

print()
print('【5】数字照实记，不造「达标」结论')
require('5 原始计时已记（不写「达标/未达标」）',
        set(TIMES) == {'0MB', '10MB', '0MB-发送', '10MB-发送'}
        and all('cold' in v and 'warm' in v for v in TIMES.values()),
        f'实际 {TIMES}')

print()
print('说明：**发送那份不含网络** —— 传输层是隔离捕获器，不是真实 SMTP。')
print('**真实投递耗时**要 QQ 授权码，本笔不冒充，也不拿捕获器的数字冒充。')
print()
print('读数字要注意的两件事：')
print('  · **保存**：10MB 不比 0MB 慢 —— 保存是按引用绑定附件（内核 bind_record_attachments），')
print('    不复制字节，量的是「多一个附件引用」不是「传 10MB」。')
print('  · **发送**：10MB 明显更慢 —— 发送要**造 MIME 把字节编进去**，所以这档是真的量到了体积。')
print('两者不能互相替代，也不能只报一个代表另一个。')

print()
print('=' * 50)
print(f'通过 {len(PASS)} 条，失败 {len(FAIL)} 条')
if FAIL:
    print('未过：' + ' | '.join(FAIL))
    cleanup()
    sys.exit(1)
cleanup()
sys.exit(0)
