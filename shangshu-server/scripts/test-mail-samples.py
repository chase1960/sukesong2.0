#!/usr/bin/env python3
"""给用户手点验收造**两个样本**（用户 2026-10-12：「我建议你补一个样本，因为我实在不知道
这个全部恢复是是干啥的」、「我没有样本，不知道该怎么测试」）。

走的还是那条正路：**合成 MIME 从传输边界进真实 sync/解析/授权/存储**，不直接插库。
插库造 Received 会绕开解析、去重、受管写入三道 —— C4 的反例表点名禁止。

造两封：

  样本 A「回复 vs 回复全部 对比样本」
      张三发来，收件人 = 本人 + 李四，抄送 = 王五
      → 点「回复」：收件人只有张三
      → 点「回复全部」：收件人 张三 + 李四，抄送 王五
      这样一眼能看出两个按钮的差别。

  样本 B「密送不外泄 样本」
      原始 MIME 里**带 Bcc: 秘密 <secret@…>**，但系统**刻意不解析 Bcc**（transport.py:356）。
      → 打开这封：看不到「秘密」这个人
      → 点回复 / 回复全部：收件人和抄送里都**没有** secret@…
      这条本来「没样本可测」，但与其空口说，不如造一封**原始信里真有 Bcc** 的，
      让用户亲眼看到它进不来。这比断言更硬。

用法：docker exec -i shangshu-local-c-frappe-1 sh -lc \
        'cd /home/frappe/frappe-bench && ./env/bin/python -' < scripts/test-mail-samples.py
输出：每封一行 `SAMPLE|<name>|<subject>|<看点>`。
"""
import sys
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

import json  # noqa: E402
import traceback  # noqa: E402
from shangshu_mail import transport  # noqa: E402
from shangshu_mail.domain import DOCTYPE  # noqa: E402

USER = 'Administrator'   # 产品页验收登录的是 Administrator；列表按 owner 过滤，必须同一个人
ADDRESS = 'sample-admin@qq.com'   # Email Account.email_id 全局唯一，按用户分开，免得撞键

SUBJECT_A = '样本A：回复 vs 回复全部（张三发来，收件人有你和李四，抄送王五）'
SUBJECT_B = '样本B：密送不外泄（原始信里带 Bcc，你应当看不到那个人）'


class FakeImap:
    """鸭子类型 IMAP 会话 —— 整条链里唯一被换掉的东西（传输边界夹具）。"""

    def __init__(self, mailbox, validity='401'):
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


def build_a():
    """样本 A：多收件人 + 抄送 —— 让「回复」和「回复全部」的结果一眼不一样。"""
    msg = EmailMessage()
    msg['Subject'] = SUBJECT_A
    msg['From'] = '张三 <zhangsan@client.example>'
    msg['To'] = f'你 <{ADDRESS}>, 李四 <lisi@client.example>'
    msg['Cc'] = '王五 <wangwu@client.example>'
    msg['Message-ID'] = '<sample-a@client.example>'
    msg.set_content(
        '李四、王五、各位好：\n\n'
        '这封是**回复对比样本**。请在尚书里点「回复」和「回复全部」各看一次：\n'
        '  · 「回复」—— 收件人只有我（张三）一个人\n'
        '  · 「回复全部」—— 收件人是我和李四，抄送是王五\n'
        '（你自己不该出现在收件人里。）\n')
    msg.add_alternative(
        '<p>李四、王五、各位好：</p>'
        '<p>这封是<b>回复对比样本</b>。请在尚书里点「回复」和「回复全部」各看一次：</p>'
        '<ul><li><b>回复</b> —— 收件人只有我（张三）一个人</li>'
        '<li><b>回复全部</b> —— 收件人是我和李四，抄送是王五</li></ul>'
        '<p>（你自己不该出现在收件人里。）</p>', subtype='html')
    return msg.as_bytes()


def build_b():
    """样本 B：原始 MIME 里**真的带 Bcc**。

    正常来信不会把密送给收件人，但有的客户端/转发链路会带。
    系统 transport.py:356 **刻意不解析 Bcc** —— 这封进去之后，
    记录里不该有「秘密」这个人，回复/回复全部也不该把他带出来。
    """
    msg = EmailMessage()
    msg['Subject'] = SUBJECT_B
    msg['From'] = '周助理 <zhou@client.example>'
    msg['To'] = f'你 <{ADDRESS}>'
    msg['Bcc'] = '秘密 <secret@client.example>'   # ← 故意放进去
    msg['Message-ID'] = '<sample-b@client.example>'
    msg.set_content(
        '这封是**密送样本**。\n\n'
        '原始信里有一个密送收件人（秘密 <secret@client.example>）。\n'
        '你应当：\n'
        '  · 打开这封 —— 看不到「秘密」这个人\n'
        '  · 点「回复」/「回复全部」—— 收件人和抄送里都没有 secret@client.example\n'
        '这是设计上的保证：系统收信时**刻意不解析 Bcc**。\n')
    msg.add_alternative(
        '<p>这封是<b>密送样本</b>。</p>'
        '<p>原始信里有一个密送收件人（秘密 <code>secret@client.example</code>）。</p>'
        '<p>你应当：</p><ul>'
        '<li>打开这封 —— <b>看不到「秘密」这个人</b></li>'
        '<li>点「回复」/「回复全部」—— 收件人和抄送里都<b>没有</b> <code>secret@client.example</code></li>'
        '</ul><p>这是设计上的保证：系统收信时<b>刻意不解析 Bcc</b>。</p>', subtype='html')
    return msg.as_bytes()


def main():
    failed = []
    print('传输边界掐成假的（绑定时 account._test 会连真网；假凭据下必然失败）')
    from shangshu_mail import account as account_mod
    account_mod._test = lambda *a, **k: None

    raw_a, raw_b = build_a(), build_b()
    print(f'-- 样本 A 合成 MIME {len(raw_a)} 字节；样本 B 合成 MIME {len(raw_b)} 字节')
    # 两封一起放一个假 IMAP，一次 sync 全收（处理顺序 UID 升序，线程回指不会断）
    fake = FakeImap({55: raw_a, 56: raw_b})
    transport.imap_session = lambda address, password, provider=None: fake
    transport.test_connection = lambda address, password, provider=None: True

    frappe.set_user(USER)
    # 幂等：清掉本批的旧绑定和同主题残留。
    # 删邮件**必须走受管写上下文**（writing()）—— 邮件的 on_trash 闸写着
    # 「请使用邮件回收站，不能直接删除邮件」，不包 writing() 就整段崩在清理上，
    # 后面的断言一条都跑不到（实测踩过）。这是产品拦得对，是测具没走正规口。
    from shangshu_mail.service import writing
    for stale in frappe.get_all('Email Account', filters={'email_id': ['like', 'sample-%']}, pluck='name'):
        try:
            frappe.delete_doc('Email Account', stale, ignore_permissions=True, force=True)
        except Exception:
            pass
    for subj in (SUBJECT_A, SUBJECT_B):
        for row in frappe.get_all('Shangshu Mail Message',
                                  filters={'subject': subj, 'owner': USER}, fields=['name']):
            with writing():
                frappe.delete_doc('Shangshu Mail Message', row['name'], ignore_permissions=True, force=True)
    frappe.db.commit()

    from shangshu_core.public_api import execute_registered_action
    execute_registered_action('mail.account.configure', {
        'email': ADDRESS, 'provider': 'qq', 'display_name': '样本',
        'password': 'synthetic-auth-code-not-real', 'enabled': True,
    }, True, frappe.generate_hash(length=24))
    res = execute_registered_action('mail.sync', {}, True, frappe.generate_hash(length=24))['result']
    print('sync 结果:', json.dumps({k: res.get(k) for k in ('added', 'skipped', 'errors')},
                                  ensure_ascii=False))
    frappe.set_user(USER)

    for tag, subj, hint in (
            ('A', SUBJECT_A,
             '点「回复」收件人只有张三；点「回复全部」收件人张三+李四、抄送王五'),
            ('B', SUBJECT_B,
             '打开看不到「秘密」；回复/回复全部都不该出现 secret@client.example')):
        rows = frappe.get_all('Shangshu Mail Message',
                              filters={'subject': subj, 'owner': USER}, fields=['name'])
        if len(rows) != 1:
            failed.append(f'{tag}：应有 1 封，实际 {len(rows)}')
            print(f'SAMPLE-FAIL|{tag}|应有 1 封，实际 {len(rows)}')
            continue
        doc = frappe.get_doc('Shangshu Mail Message', rows[0]['name'])
        print(f'SAMPLE|{doc.name}|{doc.subject}|{hint}')
        if tag == 'B':
            # 判据只看**收件人字段**。正文里出现那个地址是**故意的**（样本本身要讲清楚
            # 测什么），不算泄露 —— 第一版把正文也算进去，报了假警报。
            recip = ' '.join(str(doc.get(f) or '') for f in ('to_json', 'cc_json'))
            leaked = 'secret@client.example' in recip
            has_bcc_field = any('bcc' in str(getattr(c, 'fieldname', '') or '').lower()
                                for c in frappe.get_meta(DOCTYPE).fields)
            print(f"  收件人字段是否泄露密送：{'是（不该）' if leaked else '否（对）'}")
            print(f"  to={doc.to_json} cc={doc.cc_json}")
            print(f"  系统有没有 bcc 字段：{'有' if has_bcc_field else '没有（收信时刻意不解析 Bcc）'}")
            # 这里**要判成败**，不是打印完就算 —— 只打印不判的测试永远绿，
            # 泄露了也照样「看起来过了」（和「没等到就算没存」同一类假绿）。
            if leaked:
                failed.append('B：收件人字段泄露了密送地址')
            if has_bcc_field:
                failed.append('B：邮件记录上出现了 bcc 字段 —— 收信该刻意不解析 Bcc')
            if '秘密' in ' '.join(str(doc.get(f) or '') for f in ('to_json', 'cc_json', 'from_address')):
                failed.append('B：密送收件人的名字出现在了收发件人字段里')
    frappe.db.commit()
    if failed:
        print('SAMPLE 测试未过：')
        for item in failed:
            print('  ✖', item)
        sys.exit(1)
    print('SAMPLE 测试通过：密送不外泄（收件人字段无泄露、无 bcc 字段）')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        frappe.db.rollback()
        sys.exit(1)
