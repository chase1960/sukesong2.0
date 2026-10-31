#!/usr/bin/env python3
"""C5 造一封**持久的受控来信**，给正式页全链验收当源信。

走的是 N2-C4 已经验证过的那条路：**合成 MIME 从传输边界进真实 sync/解析/授权/存储**，
不是直接插库。插库造 Received 会绕开解析、去重、受管写入三道 —— C4 的反例表点名禁止。

与 C4 的区别只有两点：
  1. 这里**提交**（C4 测完会 rollback，不留痕）；
  2. 这里只造一封信，输出它的记录名，给 C5 的 .mjs 拿去用。

用法：docker exec -i shangshu-local-c-frappe-1 sh -lc \
        'cd /home/frappe/frappe-bench && ./env/bin/python -' < scripts/test-mail-c5-fixture.py
输出：最后一行 `FIXTURE|<name>|<subject>`，前面是过程行。
"""
import json
import sys
import traceback
from email.message import EmailMessage
from email.mime.base import MIMEBase
from email import encoders
from pathlib import Path

for _app in ('shangshu_mail', 'shangshu_core'):
    for _root in (Path.cwd(), Path('/home/frappe/frappe-bench/apps')):
        _p = _root / _app
        if _p.exists() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))

import frappe  # noqa: E402

SITES_PATH = '/home/frappe/frappe-bench/sites'
if not Path(SITES_PATH).exists():
    SITES_PATH = str(Path(__file__).resolve().parents[2] / 'sites')
frappe.init(site='shangshu.localhost', sites_path=SITES_PATH)
frappe.connect()

from shangshu_mail import transport  # noqa: E402
from shangshu_mail.service import writing  # noqa: E402
from shangshu_core.public_api import execute_registered_action  # noqa: E402

USER = 'Administrator'   # 产品页验收登录的是 Administrator；列表按 owner 过滤，必须同一个人
ADDRESS = 'c5src-admin@qq.com'   # Email Account.email_id 全局唯一，按用户分开，免得撞键
SUBJECT = '受控来信 C5：年费账单与合并表格'
CID = 'c5-src-inline-1'
TABLE_HTML = (
    '<p>客户您好，</p>'
    '<table style="border-collapse:collapse">'
    '<tr><td colspan="2" style="border:1px solid #d0d5dd;background:#002060;color:#fff">案件汇总</td></tr>'
    '<tr><td rowspan="2" style="border:1px solid #d0d5dd">A001</td>'
    '<td style="border:1px solid #d0d5dd">150.00</td></tr>'
    '<tr><td style="border:1px solid #d0d5dd">0.00</td></tr>'
    '</table>'
    f'<p>年费已核对</p><img src="cid:{CID}">'
)


class FakeImap:
    """鸭子类型 IMAP 会话 —— 整条链里唯一被换掉的东西（传输边界夹具）。"""

    def __init__(self, mailbox, validity='301'):
        self.mailbox = dict(mailbox)
        self.validity = str(validity)

    def uid(self, cmd, *args):
        cmd = str(cmd).lower()
        if cmd == 'search':
            uids = sorted(int(k) for k in self.mailbox)
            return 'OK', [b' '.join(str(u).encode() for u in uids)]
        if cmd == 'fetch':
            uid = int(args[0])
            raw = self.mailbox.get(uid)
            if raw is None:
                return 'NO', []
            if 'RFC822.SIZE' in str(args[1]):
                return 'OK', [f'1 (RFC822.SIZE {len(raw)})'.encode()]
            return 'OK', [(b'1', raw)]
        raise AssertionError(f'不该出现的命令 {cmd} {args}')

    def response(self, name):
        return name, [self.validity.encode()]

    def logout(self):
        pass

    quit = logout
    close = logout


def build_mime():
    msg = EmailMessage()
    msg['Subject'] = SUBJECT
    msg['From'] = 'billing@example.invalid'
    msg['To'] = USER
    msg['Message-ID'] = '<c5-src@example.invalid>'
    msg.set_content('纯文本替代：年费已核对')
    msg.add_alternative(TABLE_HTML, subtype='html')
    msg.add_attachment(b'%BIN-c5-attachment', maintype='application', subtype='octet-stream',
                       filename='年费对账单.bin')
    # 内联段必须 disposition=inline（生产解析器 transport.py:280 靠它认受管内联资源）
    part = MIMEBase('image', 'png')
    part.set_payload(b'\x89PNG-c5-source-image')
    encoders.encode_base64(part)
    part.add_header('Content-ID', f'<{CID}>')
    part.add_header('Content-Disposition', 'inline', filename=f'{CID}.png')
    msg.attach(part)
    return msg.as_bytes()


def main():

    # 传输边界掐成假的（绑定时 account._test 会连真网；假凭据下必然失败）
    raw = build_mime()
    fake = FakeImap({55: raw})
    transport.imap_session = lambda address, password, provider=None: fake
    transport.test_connection = lambda address, password, provider=None: True

    frappe.set_user(USER)
    # 清掉可能的历史残留：本封来信 + 本用户的旧绑定，保证幂等可重造
    for stale in frappe.get_all('Email Account', filters={'email_id': ['like', 'c5src%']}, pluck='name'):
        try:
            frappe.delete_doc('Email Account', stale, ignore_permissions=True, force=True)
        except Exception:
            pass
    # 同一封来信重跑也只落一次：先把这封的 incoming_key 痕迹清掉
    existing = frappe.get_all('Shangshu Mail Message',
                              filters={'subject': SUBJECT, 'owner': USER}, fields=['name'])
    for row in existing:
        # 清夹具也得走**受管写入**开关 —— `on_trash` 只认它，
        # 直接 delete_doc 会被「请使用邮件回收站，不能直接删除邮件」拦下。
        # 这是夹具清残留的老毛病（与本次改动无关），不是放宽任何断言。
        with writing():
            frappe.delete_doc('Shangshu Mail Message', row['name'], ignore_permissions=True, force=True)
    frappe.db.commit()

    execute_registered_action('mail.account.configure', {
        'email': ADDRESS, 'provider': 'qq', 'display_name': 'C5 源信',
        'password': 'synthetic-auth-code-not-real', 'enabled': True,
    }, True, frappe.generate_hash(length=24))
    res = execute_registered_action('mail.sync', {}, True, frappe.generate_hash(length=24))['result']
    print('sync 结果:', json.dumps({k: res.get(k) for k in ('added', 'skipped', 'errors')},
                                  ensure_ascii=False))

    frappe.set_user(USER)
    rows = frappe.get_all('Shangshu Mail Message',
                          filters={'subject': SUBJECT, 'owner': USER}, fields=['name'])
    if len(rows) != 1:
        raise SystemExit(f'受控来信应当只有 1 封，实际 {len(rows)}：{rows}')
    name = rows[0]['name']
    doc = frappe.get_doc('Shangshu Mail Message', name)
    print('正文含合并表格:', 'colspan' in (doc.body or ''), '| 含 cid 引用:', f'cid:{CID}' in (doc.body or ''))
    print('inline_resources_json:', (doc.inline_resources_json or '')[:120])
    print('attachment_ids_json:', doc.attachment_ids_json)
    frappe.db.commit()
    print(f'FIXTURE|{name}|{SUBJECT}')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        frappe.db.rollback()
        sys.exit(1)
