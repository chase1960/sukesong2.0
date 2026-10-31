#!/usr/bin/env python3
"""N2-C4 受控收件与查询 —— 合成 MIME 从**传输边界**进真实 sync/解析/授权/存储。

计划原文（N2-C-执行计划 §四）：
「合成 MIME 从传输边界进入真实 sync → 解析 → 授权 → 存储。列表/搜索/详情/线程/HTML/附件正确。
  重复 UID 不重复；不同账号与 UIDVALIDITY 不串信；单封失败及重试不漏掉其他信。」

⚠️ 夹具只允许出现在**传输边界**：唯一被换掉的是 `transport.imap_session` 返回的那个
   假 IMAP 会话对象（鸭子类型，只实现 sync 用到的 4 个方法 + logout）。
   合成 MIME 字节就从 `uid('fetch', uid, '(BODY.PEEK[])')` 的 `tuple[1]` 进去，
   之后 **全是生产代码**：`inbox_uids` → `fetch_message` → `parse_message`（生产解析器）
   → `writing()` 受管写入 → `incoming_key` 去重 → File 挂载 → 存储。
   **不直接插库冒充收件** —— 直接插库造 Received 会绕开解析、去重、受管写入三道，
   测出来的绿是假的。

反例钉的是这两条：
| 可能「看似完成」 | 反证 |
|---|---|
| 为了测试收件直接插库 | 证据必须追到真实 sync 和生产解析路径；夹具只允许出现在传输边界 |
| 只验「能读到」 | UID 去重、账号隔离、失败重试各有独立用例 |

测试通过 = 下面全部成立：
 1. 一封合成 MIME（HTML 正文含**合并表格** + **cid: 内联图** + **附件**）从传输边界灌进去，
    走完真实 sync/解析/授权/存储：列表里出现，详情正文/HTML/合并格/附件/内联图引用都对。
 2. **同一 UID 重放一次** → 列表里仍只有 **1 封**（skipped 计 1，不重复建）。
 3. **两个账号**（两个用户各绑各的邮箱）与 **UIDVALIDITY 变化** → 信**不串**到对方/新周期去。
 4. 制造**单封解析失败**（附件超 20 个 → parse_message 抛 ValueError）+ 重试：
    失败那封在结果里有**明确 uid 与原因**，其余信一封不少；修好后重试那封补进来，
    之前成功的**不重复**。
    —— 另钉**另一类单封失败**：附件本身坏了（.pdf 但不是合法 PDF，Frappe 存附件时去解析 PDF
       查 JS 会炸）。这类异常不是 ValueError，实测会把**整批**拖垮、连好信都进不去。
       「不漏掉其他信」对这一类同样成立。
 5. 搜索、线程聚合结果与内容一致（回复串按 message_id 关联，线程只含本人的信）。
"""
import hashlib
import json
import sys
import traceback
from email.message import EmailMessage
from email.mime.base import MIMEBase
from email import encoders
from pathlib import Path

# 容器里 bench 已把 apps 装进环境，import 直接通；
# 在本机跑时补上仓库里的 app 路径。两处都允许失败。
_here = Path(__file__).resolve() if '__file__' in dir() else Path.cwd()
for _app in ('shangshu_mail', 'shangshu_core'):
    for _root in (_here.parents[2] if len(_here.parents) > 2 else Path.cwd(),
                  Path('/home/frappe/frappe-bench/apps')):
        _p = _root / _app
        if _p.exists() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))

import frappe  # noqa: E402

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
if not Path(SITES_PATH).exists():          # 本机没有 bench 布局时，交给容器跑
    SITES_PATH = str(Path(__file__).resolve().parents[2] / 'sites')
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

from shangshu_mail import account, delivery, transport  # noqa: E402
from shangshu_core.public_api import (  # noqa: E402
    execute_registered_action, invoke_domain_service, query_dataset,
)

_passed, _failed = [], []


def check(label, ok, detail=''):
    (_passed if ok else _failed).append(label)
    print(('PASS|' if ok else 'FAIL|') + label + ((' | ' + str(detail)) if detail and not ok else ''))


def require(label, ok, detail=''):
    check(label, ok, detail)
    return bool(ok)


# ---------------------------------------------------------------- 传输边界夹具
class FakeImap:
    """鸭子类型 IMAP 会话 —— **整个测试里唯一被换掉的东西**。

    sync 只用到 4 个方法 + close（transport.py:314/316/323/328，close 在 :81-89），
    所以假会话就实现这 5 个。合成 MIME 字节从 uid('fetch','(BODY.PEEK[])') 的 tuple[1]
    进真实 fetch_message → parse_message。
    """

    def __init__(self, mailbox, validity='101'):
        self.mailbox = dict(mailbox)      # {uid(int): raw bytes}
        self.validity = str(validity)
        self.commands = []

    def uid(self, cmd, *args):
        self.commands.append(('uid', str(cmd).lower(), args))
        cmd = str(cmd).lower()
        if cmd == 'search':
            uids = sorted(int(k) for k in self.mailbox)
            blob = b' '.join(str(u).encode() for u in uids)
            return 'OK', [blob]
        if cmd == 'fetch':
            uid = int(args[0])
            what = str(args[1])
            raw = self.mailbox.get(uid)
            if raw is None:
                return 'NO', []
            if 'RFC822.SIZE' in what:
                return 'OK', [f'1 (RFC822.SIZE {len(raw)})'.encode()]
            # '(BODY.PEEK[])' —— 生产代码要求 tuple[1] 是 bytes（transport.py:329）
            return 'OK', [(b'1', raw)]
        raise AssertionError(f'传输边界不该出现的命令：{cmd} {args}')

    def response(self, name):
        self.commands.append(('response', name, ()))
        return name, [self.validity.encode()]

    def logout(self):
        self.commands.append(('logout', '', ()))

    def quit(self):
        self.logout()

    def close(self):
        self.logout()


def mime_html(subject, body_html, message_id, in_reply_to=None, attachments=None,
              inline=None, to='client@example.invalid', cc=''):
    """按真实邮件形状合成 MIME 字节。附件/内联走 multipart，与生产解析器的 walk() 对得上。"""
    msg = EmailMessage()
    msg['Subject'] = subject
    msg['From'] = 'sender@example.invalid'
    msg['To'] = to
    if cc:
        msg['Cc'] = cc
    msg['Message-ID'] = message_id
    if in_reply_to:
        msg['In-Reply-To'] = in_reply_to
    msg.set_content('纯文本替代')
    msg.add_alternative(body_html, subtype='html')
    for name, blob in (attachments or []):
        msg.add_attachment(blob, maintype='application', subtype='octet-stream', filename=name)
    # 内联段不能用 add_attachment —— 它写死 Content-Disposition: attachment，
    # 而生产解析器靠「有 Content-ID 且 disposition != 'attachment'」才认成内联资源
    # （transport.py:280）。所以手搓一段 disposition: inline。
    for cid, blob, mime in (inline or []):
        maintype, subtype = (mime or 'image/png').split('/', 1)
        part = MIMEBase(maintype, subtype)
        part.set_payload(blob)
        encoders.encode_base64(part)
        part.add_header('Content-ID', f'<{cid}>')
        part.add_header('Content-Disposition', 'inline', filename=f'{cid}.png')
        msg.attach(part)
    return msg.as_bytes()


def bad_mime(subject, message_id):
    """制造**解析失败**：附件超过 20 个，parse_message 抛 ValueError（transport.py:292-293）。"""
    return mime_html(subject, '<p>待修</p>', message_id,
                     attachments=[(f'附件{i}.bin', b'x') for i in range(21)])


TABLE_HTML = (
    '<table><tr><td colspan="2">案件汇总</td></tr>'
    '<tr><td rowspan="2">A001</td><td>150.00</td></tr><tr><td>0.00</td></tr></table>'
    '<p>年费已核对</p><img src="cid:c4-inline-1">'
)


def bind_account(user, address, provider='qq'):
    """走**受管动作**绑定一个合成邮箱。凭据是假的 —— 假 IMAP 会话下根本不出网，
    也不是客户邮箱凭据（硬边界「不用客户邮箱凭据」）。"""
    frappe.set_user(user)
    execute_registered_action('mail.account.configure', {
        'email': address, 'provider': provider,
        'display_name': 'C4 测试', 'password': 'synthetic-auth-code-not-real',
        'enabled': True,
    }, True, frappe.generate_hash(length=24))


def run_sync():
    frappe.set_user(CUR_USER[0])
    return execute_registered_action('mail.sync', {}, True, frappe.generate_hash(length=24))['result']


CUR_USER = ['tester@example.invalid']


def install_fake(mailbox, validity='101'):
    """把传输边界换成假会话 —— 只换这一处。"""
    fake = FakeImap(mailbox, validity)
    transport.imap_session = lambda address, password, provider=None: fake
    transport.test_connection = lambda address, password, provider=None: True
    return fake


# ================================================================= 用例
def main():
    created = []
    # 先把传输边界掐成假的：绑定时 account._test 会连真网验凭据，
    # 假凭据下必然失败。**整份测试里唯一被换掉的就这一处**，
    # 下游 inbox_uids / fetch_message / parse_message / 受管写入 / 去重全是生产代码。
    install_fake({})
    users = ['tester@example.invalid', 'reader@example.invalid']
    for u in users:
        if not frappe.db.exists('User', u):
            frappe.get_doc({'doctype': 'User', 'email': u, 'first_name': u.split('@')[0],
                            'send_welcome_email': 0, 'new_password': frappe.generate_hash(length=12),
                            'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
            created.append(('User', u))

    # 邮箱地址必须跟所选服务商的域名白名单对得上（transport.provider_for），
    # 所以合成地址用 @qq.com 形态。这只是**绑定用的假地址**，从不真正收发。
    addr_a = 'c4a@qq.com'
    addr_b = 'c4b@qq.com'

    # —— 清掉可能残留的来信，让用例从干净状态开始 ——
    # 邮箱绑定**不直接删**：配置历史有受管守卫（「请解除邮箱绑定，不能直接删除配置历史」），
    # 硬删会被拒。绑定本身走 mail.account.configure 是**覆盖式**的，留着不影响重跑。
    for u in users:
        frappe.set_user(u)
        frappe.db.delete('Shangshu Mail Message', {'owner': u})
        frappe.db.commit()

    # ============================================================ 1. 一封走完整链
    print('--- 1. 合成 MIME 从传输边界进真实 sync/解析/授权/存储 ---')
    CUR_USER[0] = users[0]
    bind_account(users[0], addr_a)
    uid1 = 11
    raw1 = mime_html('年费核对 A001', TABLE_HTML, '<c4-1@example.invalid>',
                     attachments=[('核对材料.bin', b'%BIN-c4-synthetic')],
                     inline=[('c4-inline-1', b'\x89PNG-c4', 'image/png')])
    install_fake({uid1: raw1})
    res = run_sync()
    require('1.1 sync 成功，added=1', res.get('added') == 1, res)
    frappe.set_user(users[0])
    rows = query_dataset('mail.message', {'scope': 'inbox'}, 1, 30)['rows']
    if not rows:
        print('   [诊断] 库里这几条：', frappe.get_all('Shangshu Mail Message',
              fields=['name', 'subject', 'owner', 'status'], limit_page_length=10))
    mine = [r for r in rows if r.get('subject') == '年费核对 A001']
    require('1.2 列表里出现这封信', len(mine) == 1, f'列表 {len(rows)} 行，命中 {len(mine)}')
    if not mine:
        return finish(created)
    mail_id = mine[0]['name']
    require('1.3 列表状态是 Received', mine[0].get('status') == 'Received', mine[0])

    detail = invoke_domain_service('mail.detail', {'mail': mail_id})['mail']
    require('1.4 详情正文含合并表格（colspan）', 'colspan' in (detail.get('body') or ''), detail.get('body', '')[:120])
    require('1.5 详情正文含纵向合并（rowspan）', 'rowspan' in (detail.get('body') or ''), '')
    require('1.6 详情正文是 HTML 且保留中文', '年费已核对' in (detail.get('body') or '') and detail.get('body_format') == 'HTML',
            f"format={detail.get('body_format')}")
    require('1.7 内联图引用是 cid: 不是外链', 'cid:c4-inline-1' in (detail.get('body') or '')
            and 'http' not in (detail.get('body') or ''), detail.get('body', '')[:160])
    inline = detail.get('inline_resources') or []
    require('1.8 受管内联资源落库（content_id 对得上）',
            any(i.get('content_id') == 'c4-inline-1' for i in inline), inline)
    atts = detail.get('attachments') or []
    require('1.9 附件落库且名字对', any('核对材料' in (a.get('name') or a.get('file') or '') for a in atts), atts)
    require('1.10 发件人落库', 'sender@example.invalid' in (detail.get('from_address') or ''), detail.get('from_address'))

    # ============================================================ 2. 同一 UID 重放
    print('--- 2. 同一 UID 重放不重复 ---')
    install_fake({uid1: raw1})
    res2 = run_sync()
    total = query_dataset('mail.message', {'scope': 'inbox'}, 1, 100)['total']
    require('2.1 重放后仍只有 1 封', total == 1, f'inbox 共 {total} 封，重放结果 {res2}')
    require('2.2 重放计 skipped=1', res2.get('skipped') == 1 and res2.get('added') == 0, res2)

    # ============================================================ 3. 账号隔离 / UIDVALIDITY
    print('--- 3. 两个账号与 UIDVALIDITY 不串信 ---')
    CUR_USER[0] = users[1]
    bind_account(users[1], addr_b)
    raw_b = mime_html('B 的信', '<p>只属于 B</p>', '<c4-b@example.invalid>')
    install_fake({uid1: raw_b})          # **同一个 UID**，但属于另一个账号
    res_b = run_sync()
    frappe.set_user(users[1])
    rows_b = query_dataset('mail.message', {'scope': 'inbox'}, 1, 30)['rows']
    require('3.1 另一账号的信进了自己的箱', res_b.get('added') == 1 and len(rows_b) == 1, res_b)
    require('3.2 B 的信内容是 B 的', '只属于 B' in (invoke_domain_service('mail.detail', {'mail': rows_b[0]['name']})['mail'].get('body') or ''), rows_b)

    frappe.set_user(users[0])
    rows_a = query_dataset('mail.message', {'scope': 'inbox'}, 1, 30)['rows']
    require('3.3 A 的箱里看不到 B 的信', all('只属于 B' not in (r.get('subject') or '') for r in rows_a)
            and len(rows_a) == 1, [r.get('subject') for r in rows_a])
    require('3.4 同一 UID 在两账号各成一条，不串', len(rows_a) == 1 and len(rows_b) == 1
            and rows_a[0]['name'] != rows_b[0]['name'], (rows_a, rows_b))

    # UIDVALIDITY 变化：同账号、同 UID、VALIDITY 从 101 → 202 → 被当新信
    CUR_USER[0] = users[0]
    raw_new = mime_html('VALIDITY 换代', '<p>新周期</p>', '<c4-v@example.invalid>')
    install_fake({uid1: raw_new}, validity='202')
    res_v = run_sync()
    frappe.set_user(users[0])
    rows_v = query_dataset('mail.message', {'scope': 'inbox'}, 1, 30)['rows']
    require('3.5 UIDVALIDITY 变化后同 UID 被当新信（不与旧周期串）',
            res_v.get('added') == 1 and any(r.get('subject') == 'VALIDITY 换代' for r in rows_v), res_v)
    require('3.6 新周期不覆盖旧信', any(r.get('subject') == '年费核对 A001' for r in rows_v),
            [r.get('subject') for r in rows_v])

    # ============================================================ 4. 单封失败 + 重试
    print('--- 4. 单封解析失败 + 重试不漏其他信 ---')
    uid_good, uid_bad = 21, 22
    raw_good = mime_html('好的那封', '<p>完好</p>', '<c4-good@example.invalid>')
    raw_bad = bad_mime('坏的那封', '<c4-bad@example.invalid>')
    install_fake({uid_good: raw_good, uid_bad: raw_bad})
    res_f = run_sync()
    frappe.set_user(users[0])
    errors = res_f.get('errors') or []
    require('4.1 失败那封有明确 uid', any(str(e.get('uid')) == str(uid_bad) for e in errors), errors)
    require('4.2 失败那封有明确原因（非空）',
            any(str(e.get('uid')) == str(uid_bad) and str(e.get('reason') or '').strip() for e in errors), errors)
    require('4.3 失败那封没被算进 added', res_f.get('added') == 1, res_f)
    rows_f = query_dataset('mail.message', {'scope': 'inbox'}, 1, 100)['rows']
    require('4.4 好的那封一封不少地落库', any(r.get('subject') == '好的那封' for r in rows_f), res_f)
    require('4.5 坏的那封没有假成功入库', not any(r.get('subject') == '坏的那封' for r in rows_f), res_f)

    # 重试：坏的那封修好后重放同一 UID
    raw_fixed = mime_html('坏的那封', '<p>已修好</p>', '<c4-bad@example.invalid>')
    install_fake({uid_good: raw_good, uid_bad: raw_fixed})
    res_r = run_sync()
    frappe.set_user(users[0])
    rows_r = query_dataset('mail.message', {'scope': 'inbox'}, 1, 100)['rows']
    subjects = [r.get('subject') for r in rows_r]
    require('4.6 重试后坏的那封补进来', subjects.count('坏的那封') == 1, subjects)
    require('4.7 重试不重复导入之前成功的', subjects.count('好的那封') == 1, subjects)
    require('4.8 重试结果：只新增 1 封', res_r.get('added') == 1, res_r)

    # ---- 4B. 另一类单封失败：附件本身坏了，不许拖垮整批 ----
    print('--- 4B. 坏附件只坏那一封，不拖垮整批 ---')
    uid_ok2, uid_bad2 = 41, 42
    raw_ok2 = mime_html('存好的那封', '<p>完好</p>', '<c4-ok2@example.invalid>')
    # 附名叫 .pdf 却不是合法 PDF —— Frappe 的 File 存盘时会去解析 PDF 查 JS，直接抛异常
    raw_bad2 = mime_html('坏附件那封', '<p>附件坏</p>', '<c4-bad2@example.invalid>',
                         attachments=[('对账单.pdf', b'%PDF-not-really-a-pdf')])
    install_fake({uid_ok2: raw_ok2, uid_bad2: raw_bad2})
    res_b2 = run_sync()
    frappe.set_user(users[0])
    errors_b2 = res_b2.get('errors') or []
    require('4.9 坏附件那封不拖垮整批（sync 没抛，跑完了）', isinstance(res_b2, dict) and 'added' in res_b2, res_b2)
    require('4.10 坏附件那封有明确 uid 与原因',
            any(str(e.get('uid')) == str(uid_bad2) and str(e.get('reason') or '').strip() for e in errors_b2), errors_b2)
    rows_b2 = query_dataset('mail.message', {'scope': 'inbox'}, 1, 100)['rows']
    subjects_b2 = [r.get('subject') for r in rows_b2]
    require('4.11 同批的好信一封不少', subjects_b2.count('存好的那封') == 1, subjects_b2)
    require('4.12 坏附件那封没半截入库', subjects_b2.count('坏附件那封') == 0, subjects_b2)

    # ============================================================ 5. 搜索与线程
    print('--- 5. 搜索与线程聚合 ---')
    uid_root, uid_reply = 31, 32
    raw_root = mime_html('线程根', '<p>根信内容</p>', '<c4-root@example.invalid>')
    raw_reply = mime_html('Re: 线程根', '<p>回信内容</p>', '<c4-reply@example.invalid>',
                          in_reply_to='<c4-root@example.invalid>')
    install_fake({uid_root: raw_root, uid_reply: raw_reply})
    run_sync()
    frappe.set_user(users[0])
    hit = query_dataset('mail.message', {'scope': 'inbox', 'q': '线程根'}, 1, 30)['rows']
    require('5.1 搜索按内容命中', any(r.get('subject') == '线程根' for r in hit), hit)
    miss = query_dataset('mail.message', {'scope': 'inbox', 'q': '查无此词xyzzy'}, 1, 30)['rows']
    require('5.2 搜索不乱命中', len(miss) == 0, miss)
    root_row = next((r for r in hit if r.get('subject') == '线程根'), None)
    if not require('5.3 线程根存在', root_row is not None, hit):
        return finish(created)
    linked = frappe.get_all('Shangshu Mail Message',
        filters={'subject': ['in', ['线程根', 'Re: 线程根']]},
        fields=['subject', 'message_id', 'in_reply_to', 'reply_to_mail', 'owner'])
    print('   [诊断] 线程字段：', linked)
    thread = invoke_domain_service('mail.thread', {'mail': root_row['name']})
    body = json.dumps(thread, ensure_ascii=False, default=str)
    require('5.4 线程含根与回信', '线程根' in body and 'Re: 线程根' in body, body[:300])
    require('5.5 线程不含别人/别的主题', 'B 的信' not in body and '好的那封' not in body, body[:300])

    return finish(created)


def finish(created):
    print('---')
    print(f'{len(_passed)} PASS / {len(_failed)} FAIL')
    if _failed:
        print('未通过：')
        for f in _failed:
            print('  - ' + f)
    return 0 if not _failed else 1


if __name__ == '__main__':
    try:
        code = main()
    except Exception:
        traceback.print_exc()
        code = 1
    finally:
        try:
            frappe.db.rollback()
        except Exception:
            pass
    sys.exit(code)
