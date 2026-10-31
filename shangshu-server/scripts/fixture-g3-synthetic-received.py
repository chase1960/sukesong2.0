"""G3 合成 Received 来信夹具 —— 给 D 在 3820 上跑。

**只产数据，不做断言。** 用途：D 的「读信提表格」G3 场景需要一封**真实 sync 落库**
的合成来信；不要真实外网收信。

⚠️ 做法按仓里明许的边界（test-mail-c4-receive.py 顶部原话）：
   「夹具只允许出现在**传输边界**：唯一被换掉的是 transport.imap_session 返回的那个
     假 IMAP 会话对象…合成 MIME 字节从 uid('fetch',...) 的 tuple[1] 进去，
     之后**全是生产代码**…**不直接插库冒充收件**。」
   所以本夹具走 FakeImap → 真实 sync → parse_message → writing() → 去重 → 落库。

⚠️ 用前先确认：这台实例是**谁的**。建数据属写入，**要实例负责人点头**。
   3820 = `shangshu-local-b-*`（B 的）；D 自己的是 `shangshu-local-d-*`。
   别在没打招呼的实例上造数据。

用法（在目标容器里）：
    cat shangshu-server/scripts/mail_fixture.py \\
        shangshu-server/scripts/fixture-g3-synthetic-received.py \\
      | docker exec -i <container> sh -lc 'cd /home/frappe/frappe-bench && ./env/bin/python -'

  或走跑具：`MAIL_TEST_CONTAINER=<容器> sh run-mail-test.sh fixture-g3-synthetic-received.py`

  同一实例重复投信（同步按 UID 水位去重，重复 UID 会被 skip）：
    `G3_SYN_UID=3 G3_SYN_SUBJECT='UI967-G3 第三封' MAIL_TEST_CONTAINER=<容器> sh run-mail-test.sh ...`

产出：打印 `G3_SAMPLE|account|<邮箱键>|message|<信的 name>|subject|<主题>|status|Received|attachments|<n>|files|<文件 id…>`，
      D 拿 `message` 那一段当来源信 ID 即可；附件是 `客户00123代缴明细.xlsx`（真 xlsx，收信时同步挂到信上，
      后台再自动进文件中心）。
"""
import io
import json
import os
import sys
import zipfile
from email.message import EmailMessage
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

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'

TARGET_USER = 'boss-1792046972@example.invalid'
TAG = 'G3SYN'
# 同一实例可以**反复投**：同步按 IMAP UID 水位去重，重复用同一个 UID 会被 skip（B 在 3820 撞过：
# `skipped=1, added=0`，旧信占着 UID 1）。所以 UID/主题都可从环境变量覆盖：
#   G3_SYN_UID=3 G3_SYN_SUBJECT='UI967-G3 第三封' sh run-mail-test.sh fixture-g3-...
UID = int(os.environ.get('G3_SYN_UID', '1'))
SUBJECT = os.environ.get('G3_SYN_SUBJECT', 'UI967-G3 客户00123同意代缴')
BODY_TEXT = ('客户同意代缴 800 元，尚未付款。\n'
             '请据此更新本季度代缴台账。')

connect(SITE, SITES_PATH)          # 公共件 mail_fixture.py 提供
from shangshu_mail import account as account_mod
from shangshu_mail import transport
from shangshu_mail.service import writing


def _minimal_xlsx():
    """一个**最小但有效**的 xlsx（zip + inlineStr），不依赖 openpyxl。

    D 的 UI-088 要「邮件附件 + 文件中心 + 表格同一对话接续」——
    纯正文跑不了，所以这里带一个真 xlsx 附件：
      · 收信时附件作为私有 File **同步**挂到这封信上（delivery.py 落库那段）；
      · 之后后台再走 `files.import_attachment` 自动进文件中心（异步）。
    单元格：客户=客户00123，代缴金额=800.00。
    """
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '</Types>')
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '</Relationships>')
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="代缴明细" sheetId="1" r:id="rId1"/></sheets></workbook>')
    workbook_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '</Relationships>')
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
        '<row r="1"><c r="A1" t="inlineStr"><is><t>客户</t></is></c>'
        '<c r="B1" t="inlineStr"><is><t>代缴金额</t></is></c></row>'
        '<row r="2"><c r="A2" t="inlineStr"><is><t>客户00123</t></is></c>'
        '<c r="B2" t="inlineStr"><is><t>800.00</t></is></c></row>'
        '</sheetData></worksheet>')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml', content_types)
        zf.writestr('_rels/.rels', root_rels)
        zf.writestr('xl/workbook.xml', workbook)
        zf.writestr('xl/_rels/workbook.xml.rels', workbook_rels)
        zf.writestr('xl/worksheets/sheet1.xml', sheet)
    return buffer.getvalue()


def build_mime():
    m = EmailMessage()
    m['From'] = '客户00123 <customer00123@example.invalid>'
    m['To'] = f'{TARGET_USER}'
    m['Subject'] = SUBJECT
    m['Message-ID'] = f'<{TAG}-{frappe.generate_hash(length=12)}@example.invalid>'
    m['Date'] = 'Fri, 17 Oct 2026 10:00:00 +0800'
    m.set_content(BODY_TEXT)
    m.add_alternative(
        f'<p>客户同意代缴 <strong>800 元</strong>，尚未付款。</p>'
        f'<p>请据此更新本季度代缴台账。</p>',
        subtype='html')
    # UI-088 要「邮件附件 + 文件中心 + 表格」：带一个真 xlsx 附件（明细见 _minimal_xlsx）。
    m.add_attachment(_minimal_xlsx(), maintype='application',
                     subtype='vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                     filename='客户00123代缴明细.xlsx')
    return m.as_bytes()


class FakeImap:
    """鸭子类型 IMAP 会话 —— **整个夹具里唯一被换掉的东西**（同 c4-receive）。"""
    def __init__(self, mailbox, validity='101'):
        self.mailbox = dict(mailbox)
        self.validity = str(validity)
        self.commands = []

    def uid(self, cmd, *args):
        cmd = str(cmd).lower()
        self.commands.append(('uid', cmd, args))
        if cmd == 'search':
            return 'OK', [b' '.join(str(int(k)).encode() for k in sorted(self.mailbox))]
        if cmd == 'fetch':
            uid = int(args[0])
            raw = self.mailbox.get(uid)
            if raw is None:
                return 'NO', []
            want = str(args[1]) if len(args) > 1 else ''
            # 补丁3（B 在 3820 撞的）：fetch_message **先量大小再取正文**
            # （transport.py:498 `uid('fetch', uid, '(RFC822.SIZE)')` → 再 `(BODY.PEEK[])`）。
            # 只回 BODY 的话第一个 `re.search(rb'RFC822.SIZE')` 找不到 → 「无法核对邮件大小」。
            if 'RFC822.SIZE' in want.upper():
                return 'OK', [b'1 (RFC822.SIZE %d)' % len(raw)]
            return 'OK', [(b'1 (BODY[] {%d}' % len(raw), raw), b')']
        return 'OK', []

    # 补丁2（B 在 3820 撞的）：inbox_uids 会调 `connection.response('UIDVALIDITY')[1]`
    # （transport.py:491），要回 [b'101'] 这样的字节串，且 `.decode().isdigit()` 要成立。
    def response(self, code):
        if str(code).upper() == 'UIDVALIDITY':
            return 'OK', [self.validity.encode()]
        return 'OK', []

    def select(self, mailbox, readonly=False):
        return 'OK', [str(len(self.mailbox)).encode()]

    def list(self, *a, **k):
        return 'OK', [b'(\\HasNoChildren) "." "INBOX"']

    def close(self):
        return 'OK', []

    def logout(self):
        return 'BYE', []


from shangshu_core.public_api import execute_registered_action

frappe.set_user('Administrator')

# 1) 用户（boss 目前可能没有）
if not frappe.db.exists('User', TARGET_USER):
    frappe.get_doc({'doctype': 'User', 'email': TARGET_USER,
                    'first_name': TARGET_USER.split('@')[0],
                    'send_welcome_email': 0,
                    'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
    frappe.db.commit()
    print(f'  [fixture] 建了用户 {TARGET_USER}')
else:
    print(f'  [fixture] 用户已存在 {TARGET_USER}')

# ★ 补丁1（B 在 3820 撞的）：**传输边界补丁必须放在 configure 之前**。
#   `mail.account.configure` 会走真实探测（test_connection / imap 探活），
#   补丁放后面的话 configure 打的是**真网易服务器** —— 3820 上就是这么炸的。
#   所以先在传输边界装好 FakeImap，再做任何会碰邮箱的动作。
mailbox = {UID: build_mime()}
fake = FakeImap(mailbox)
_real_imap_session = transport.imap_session
_real_test_connection = transport.test_connection
transport.imap_session = lambda address, password, provider=None: fake
transport.test_connection = lambda address, password, provider=None: True

# 2) 绑邮箱 —— **走受管动作** mail.account.configure（同 c4-receive:bind_account），不裸插表。
#    凭据是假的：假 IMAP 会话下根本不出网，也不是客户邮箱凭据（硬边界「不用客户邮箱凭据」）。
key = account_mod.account_name(TARGET_USER)
frappe.set_user(TARGET_USER)
existing = frappe.db.exists('Shangshu Mail Account', {'account_key': key})
if existing:
    print(f'  [fixture] 邮箱绑定已存在 {key}，跳过 configure')
else:
    """provider 为什么用 netease-enterprise 而不是 qq（2026-10-17 在 3820 栽过）：
        transport.resolve_provider 的规则是 ——
          · `qq` 的 domains=['qq.com','foxmail.com']，**只认这两个域**；
            拿 `@example.invalid` 配 qq → 直接抛
            「邮箱地址与选择的服务商不匹配」（3820 实报，公共内核转来的原文）。
          · `netease-enterprise` / `netease-enterprise-hz` 的 domains=[]（空），
            条件是「该域不属于某个个人服务商」——`example.invalid` / `shangshu.local`
            都不属于，所以能过。
        下面的 FakeImap + test_connection 补丁保证它**不会真连网易服务器**：
        传输边界两处都换掉了（照 test-mail-c4-receive.py 的 install_fake）。"""
    execute_registered_action('mail.account.configure', {
        'email': TARGET_USER,
        'provider': 'netease-enterprise',
        'display_name': 'BOSS G3',
        'password': 'synthetic-auth-code-not-real',
        'enabled': True,
    }, True, frappe.generate_hash(length=24))
    print(f'  [fixture] 走受管动作绑了邮箱 {key}')
frappe.db.commit()

# 3) 合成 MIME 从传输边界进真实 sync（不插库）—— 照 c4-receive:install_fake / run_sync
try:
    frappe.set_user(TARGET_USER)
    result = execute_registered_action('mail.sync', {}, True,
                                       frappe.generate_hash(length=24))['result']
    print(f'  [fixture] sync 回包 = {json.dumps(result, ensure_ascii=False)}')
finally:
    transport.imap_session = _real_imap_session
    transport.test_connection = _real_test_connection

# ★ 补丁4（B 在 3820 撞的）：**老 schema 没有 `mailbox_id` 列**，用的是 `source_mailbox`
#   （值是**邮箱地址**不是 account key）。新旧两版都兼容：先看 meta 有没有 `mailbox_id`。
def _mail_filter(key):
    fields = {d.fieldname for d in frappe.get_meta('Shangshu Mail Message').fields}
    if 'mailbox_id' in fields:
        return {'subject': SUBJECT, 'mailbox_id': key}
    if 'source_mailbox' in fields:
        email = frappe.db.get_value('Shangshu Mail Account', {'account_key': key}, 'email_address')
        return {'subject': SUBJECT, 'source_mailbox': email or key}
    return {'subject': SUBJECT}


# 3) 找到刚落的信
frappe.db.commit()
rows = frappe.get_all('Shangshu Mail Message',
                      filters=_mail_filter(key),
                      fields=['name', 'subject', 'status', 'record_version'],
                      limit=5)
if not rows:
    print(f'  [fixture] ✖ 没找到刚落的那封 —— 查 sync 入口名对不对')
    sys.exit(1)
row = rows[0]
# 附件在收信事务里**同步**落成私有 File（后台只是再自动入库到文件中心）。
attachment_ids = json.loads(frappe.db.get_value('Shangshu Mail Message', row['name'],
                                                'attachment_ids_json') or '[]')
attachment_names = [frappe.db.get_value('File', fid, 'file_name') or fid for fid in attachment_ids]
print(f'G3_SAMPLE|account|{key}|message|{row["name"]}|subject|{row["subject"]}|status|{row["status"]}'
      f'|attachments|{len(attachment_ids)}|files|{",".join(attachment_ids)}')
if attachment_names:
    print('  [fixture] 附件：' + '；'.join(attachment_names)
          + '（自动入库到文件中心是后台任务，可能需要几秒后刷新）')
else:
    print('  [fixture] ⚠️ 没有附件落库 —— 核对 MIME 里的 add_attachment 是否被 parse_message 收到')
