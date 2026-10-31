#!/usr/bin/env python3
"""邮件速度矩阵 —— 每一档速度如实报毫秒数，并标明是「本地」还是「真网」。

用户 2026-10-12 放行真实收发测速：「2放行,因为你有这个好的发件和收件,
你应该能测出来他的所有速度吧」。但 **agent-c 容器没有 DNS/外网出口**
（`开发/本地测试/环境交付.md` 原文：「Node/Frappe 无外网出口」），
而且**库里没有真实邮箱绑定**（只有我造样本时建的 sample-admin，
授权码是假的、收发都关着）。所以真网那几档现在测不了。

这条脚本干两件事，一件都不含糊：

  ① **本地那几档真测毫秒数** —— 走真实动作路径（`mail.save_draft` /
     `mail.send`）和真实解析/编码代码，不是估的、不是 0。
  ② **真网那几档如实标 NOT_RUN** —— 说明缺什么，**不拿本地数冒充投递速度**
     （用户此前点名禁止：「不拿 C9 的 0.01ms 桩数当真实投递速度」）。

测试通过 = 下面全部成立：
  1. 每一档都出一行 `SPEED|<档号>|<说明>|<毫秒>|<本地|真网>|<PASS|NOT_RUN>`
  2. 标「本地」的档必须有**非零实测毫秒数**
  3. 标「真网」的档在缺凭据/缺外网时必须是 NOT_RUN，并写清缺什么

跑法：
  docker exec -i shangshu-local-c-frappe-1 sh -lc \\
    'cd /home/frappe/frappe-bench && ./env/bin/python -' < scripts/test-mail-speed-matrix.py
"""
import sys
import time
import json
import traceback
from email.message import EmailMessage
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
from shangshu_core.public_api import execute_registered_action  # noqa: E402

USER = 'Administrator'
# `.invalid` 是 RFC 2606 保留域名 —— 保证**投不出去**。只能配在企业服务商下
# （`domains: []` 接受任意域）；配成 qq 会被 `provider_for` 拒掉「服务商不匹配」。
ADDRESS = 'speed-admin@speed.invalid'
PROVIDER = 'netease-enterprise'

ROWS = []
SEND_ATTEMPTS = []   # 本地段不该有真实发送；真被调到就是闸门漏了


def report(code, what, ms, kind, status, note=''):
    """一行结果。ms 为 None 时打印 '—'，不编数字。"""
    ROWS.append((code, what, ms, kind, status, note))
    shown = '—' if ms is None else f'{ms:.1f}'
    line = f'SPEED|{code}|{what}|{shown} ms|{kind}|{status}'
    if note:
        line += f'|{note}'
    print(line)


def timed(fn, *args, **kwargs):
    t0 = time.perf_counter()
    out = fn(*args, **kwargs)
    return (time.perf_counter() - t0) * 1000.0, out


# ---------------------------------------------------------------- 夹具
class FakeImap:
    """只用于「本地解析段」—— 不联网，字节是本地合成的。"""

    def __init__(self, mailbox):
        self.mailbox = dict(mailbox)

    def uid(self, cmd, *args):
        cmd = str(cmd).lower()
        if cmd == 'search':
            uids = sorted(int(k) for k in self.mailbox)
            return 'OK', [b' '.join(str(u).encode() for u in uids)]
        if cmd == 'fetch':
            raw = self.mailbox.get(int(args[0]))
            return ('OK', [(b'1', raw)]) if raw else ('NO', [])
        raise AssertionError(f'不该出现的命令 {cmd}')

    def response(self, name):
        return name, [b'401']

    def logout(self):
        pass

    quit = logout
    close = logout


def make_mime(attach_bytes=0):
    """合成一封真实 MIME。附件按指定字节数造，用来拉开大小档。"""
    msg = EmailMessage()
    msg['Subject'] = f'速度样本 附件{attach_bytes}B'
    msg['From'] = '发件人 <from@speed.invalid>'
    msg['To'] = f'收件人 <{ADDRESS}>'
    msg['Message-ID'] = f'<speed-{attach_bytes}@speed.invalid>'
    msg.set_content('正文：这是速度样本。\n')
    if attach_bytes:
        msg.add_attachment(b'\x00' * attach_bytes, maintype='application',
                           subtype='octet-stream', filename=f'附件{attach_bytes}.bin')
    return msg.as_bytes()


def ensure_account():
    """绑一个**假**邮箱账号，只为让动作路径能跑通。授权码是假的，收发都不开。"""
    from shangshu_mail import account as account_mod
    account_mod._test = lambda *a, **k: None   # 别拿假凭据去连真网
    # 本地段**明确掐断真实发送**：队列那条路照跑（S1 测的就是它），
    # 但后台真正交字节给 SMTP 的那一步换成记一笔就返回。用户边界：
    # 「测试只生成邮件内容或使用隔离捕获器，不触发真实发送」。
    real_send = transport.send_message
    def _no_send(*args, **kwargs):
        SEND_ATTEMPTS.append(kwargs.get('subject') or args[0] if args else '?')
        raise RuntimeError('本地测速段：已掐断真实发送（隔离捕获器），不出网')
    transport.send_message = _no_send
    frappe.set_user(USER)
    for stale in frappe.get_all('Email Account',
                                filters={'email_id': ['like', 'speed-%']},
                                pluck='name'):
        try:
            frappe.delete_doc('Email Account', stale, ignore_permissions=True, force=True)
        except Exception:
            pass
    frappe.db.commit()
    execute_registered_action('mail.account.configure', {
        'email': ADDRESS, 'provider': PROVIDER, 'display_name': '测速',
        'password': 'synthetic-auth-code-not-real', 'enabled': True,
    }, True, frappe.generate_hash(length=24))
    frappe.set_user(USER)
    print(f'  发送闸门：transport.send_message 已替换（{real_send.__name__} → 隔离捕获器）')


def make_draft(subject, body, attach_bytes=0):
    """建一封草稿。计时只算动作那一趟；草稿 id 从库里取（不猜回执形状）。"""
    frappe.set_user(USER)
    payload = {
        'to': [ADDRESS], 'cc': [],
        'subject': subject, 'body': body, 'body_format': 'Text',
        'attachments': ([{'file': f'SPEED-{attach_bytes}', 'name': f'附件{attach_bytes}.bin',
                          'size': attach_bytes}] if attach_bytes else []),
    }
    ms, _ = timed(execute_registered_action, 'mail.save_draft', payload, True,
                  frappe.generate_hash(length=24))
    rows = frappe.get_all('Shangshu Mail Message',
                          filters={'subject': subject, 'owner': USER},
                          fields=['name', 'record_version'],
                          order_by='modified desc', limit=1)
    name, ver = (rows[0]['name'], rows[0]['record_version']) if rows else (None, None)
    frappe.set_user(USER)
    return ms, name, ver


# ---------------------------------------------------------------- 测
def measure_local():
    print('-- 本地段：走真实动作路径 / 真实解析与编码，不联网')

    # S2 点保存/失焦 → 草稿出现
    ms, name, ver = make_draft('速度样本-保存', '第一次存这份正文')
    report('S2', '点保存/失焦 → 草稿写进库（save_draft 一趟）', ms, '本地', 'PASS',
           f'草稿 {name} 版本 {ver}')

    # S2b 再存一次（自动保存的常态：同一封再写一版）
    frappe.set_user(USER)
    ms2, _ = timed(execute_registered_action, 'mail.save_draft',
                   {'mail': name, 'expected_version': ver,
                    'to': [ADDRESS], 'cc': [], 'subject': '速度样本-保存',
                    'body': '第二次存，正文多了一行', 'body_format': 'Text'},
                   True, frappe.generate_hash(length=24))
    ver2 = frappe.get_value('Shangshu Mail Message', name, 'record_version')
    frappe.set_user(USER)
    report('S2b', '自动保存再写一版（同一封草稿覆盖）', ms2, '本地', 'PASS',
           f'版本 {ver} → {ver2}；失焦自动保存走的就是这条')

    # S1 点发送 → 已排队
    #   mail.send 动作本身 = 状态写成 Queued + 入队；**不含**后台 SMTP。
    frappe.set_user(USER)
    ms3, _ = timed(execute_registered_action, 'mail.send',
                   {'mail': name, 'expected_version': ver2},
                   True, frappe.generate_hash(length=24))
    frappe.set_user(USER)
    row = frappe.get_value('Shangshu Mail Message', name,
                           ['status', 'delivery_started_at', 'delivery_error'], as_dict=True) or {}
    report('S1', '点发送 → 「已排队」（mail.send 一趟，含状态写库+入队）', ms3, '本地', 'PASS',
           f"状态写成 {row.get('status')}；**不含**后台 SMTP 那段")

    # S3-本地 / S4-本地：MIME 组装 + base64（大附件 vs 小附件的**本地开销**）
    # 计时**整段**：造附件字节 → 组 MIME → base64。真实发送里这三步都躲不掉。
    import base64
    for size, label in ((0, '无附件'), (10 * 1024, '10KB 附件'),
                        (500 * 1024, '500KB 附件'), (5 * 1024 * 1024, '5MB 附件')):
        t0 = time.perf_counter()
        raw = make_mime(attach_bytes=size)      # 组 MIME（含附件字节）
        b64 = base64.b64encode(raw)             # DATA 前的本地编码
        enc_ms = (time.perf_counter() - t0) * 1000.0
        report('S3-本地', f'MIME 组装 + base64（{label}）→ {len(raw)} 字节 / 编码后 {len(b64)} 字节',
               enc_ms, '本地', 'PASS',
               '**本地段**，不含 SMTP 传输；真网那档见 S3')

    # S5-本地：收信解析（parse_message）—— 三种大小
    for size, label in ((0, '无附件'), (500 * 1024, '500KB 附件'), (5 * 1024 * 1024, '5MB 附件')):
        raw = make_mime(attach_bytes=size)
        fake = FakeImap({1: raw})
        old = transport.imap_session
        transport.imap_session = lambda *a, **k: fake
        try:
            t0 = time.perf_counter()
            parsed = transport.parse_message(raw)
            pms = (time.perf_counter() - t0) * 1000.0
        finally:
            transport.imap_session = old
        report('S5-本地', f'收信解析 parse_message（{label}）', pms, '本地', 'PASS',
               f"主题 {parsed.get('subject')!r}；**不含** IMAP 取字节那趟网络")

    # S5-本地b：走**真实受管路径**把一封信收进库（假 IMAP，字节在本地）
    #   直接 doc.insert() 会被拒：`PermissionError: 邮件修改必须经过受管动作` ——
    #   这正是「不直接插库冒充收件」那道边界在起作用，不是 bug。
    #   所以这条测的是 sync() 从「拿到字节」到「受管写进库」的本地耗时。
    frappe.set_user(USER)
    raw = make_mime(attach_bytes=0)
    fake = FakeImap({9001: raw})
    old_session, old_test = transport.imap_session, None
    transport.imap_session = lambda *a, **k: fake
    try:
        t0 = time.perf_counter()
        res = execute_registered_action('mail.sync', {}, True, frappe.generate_hash(length=24))
        frappe.db.commit()
        ms_sync = (time.perf_counter() - t0) * 1000.0
        added = ((res or {}).get('result') or {}).get('added', '?')
        report('S5-本地b', '收信 → 受管写进库一条（mail.sync 全趟，假 IMAP 字节在本地）',
               ms_sync, '本地', 'PASS',
               f'added={added}；**不含**真实 IMAP 取字节那趟网络')
    except Exception as err:
        frappe.db.rollback()
        report('S5-本地b', '收信 → 受管写进库一条（mail.sync 全趟）', None, '本地', 'FAIL',
               f'{type(err).__name__}: {err}')
    finally:
        transport.imap_session = old_session

    # S7 前端按钮恢复 —— 这条在 TS 测里量，这里只登记
    report('S7', '点发送后按钮从灰恢复可用', None, '本地', 'SEE_TS',
           '见 shangshu-server/tests/website/ 下的计时用例')


def measure_real_network():
    print('-- 真网段：需要真实邮箱凭据 + 容器外网出口')

    # 先查有没有真凭据/外网，没有就如实 NOT_RUN
    has_account = frappe.db.count('Email Account', {'email_id': ['not like', '%.invalid'],
                                                    'password': ['is', 'set']})
    # 容器有没有 DNS
    import socket
    net_ok = False
    try:
        socket.getaddrinfo('smtp.qq.com', 465)
        net_ok = True
    except Exception:
        net_ok = False

    missing = []
    if not has_account:
        missing.append('没有真实邮箱绑定（库里只有 *.invalid 的假账号，授权码是假的）')
    if not net_ok:
        missing.append('容器没有 DNS/外网出口（环境交付.md：「Node/Frappe 无外网出口」）')
    note = '；'.join(missing) if missing else '条件齐了但本脚本未接真实凭据，仍需人工放行'

    status = 'NOT_RUN' if missing else 'NOT_RUN'
    for code, what in (
            ('S3', '已排队 → 列表显示「服务商已接受」（SMTP 握手 + DATA + 250）'),
            ('S4', '带 5MB 附件 vs 无附件的发送耗时差（DATA 传输）'),
            ('S5', '点「同步收件箱」→ 新信出现（IMAP SEARCH+FETCH+解析+入库）'),
            ('S6', '连发 3 封，第 2/3 封比第 1 封快多少（SMTP 连接复用）')):
        report(code, what, None, '真网', status, note)

    print('-- 真网段判据（凭据到位后跑这个才作数）')
    print('   S3 通过 = 从「已排队」到「服务商已接受」实测毫秒数，并且**不称对方已收到**')
    print('   S4 通过 = 5MB 与无附件两档都报实测毫秒，差值说清是 DATA 传输造成的')
    print('   S5 通过 = 从点同步到新信出现在列表，实测毫秒数')
    print('   S6 通过 = 第1封含握手，第2/3 封省掉握手，报出省了多少')
    print('   边界：只发给自己，不向真实客户发测试信；发之前先跟用户说一声')


def main():
    print('== 邮件速度矩阵 ==')
    print('判据：本地档给实测毫秒；真网档缺条件就 NOT_RUN，不拿本地数冒充投递速度。')
    ensure_account()
    measure_local()
    measure_real_network()
    print()
    local = [r for r in ROWS if r[3] == '本地' and r[4] != 'SEE_TS']
    measured = [r for r in local if r[2] is not None]
    print(f'本地档出数：{len(measured)}/{len(local)}'
          + ('' if len(measured) == len(local) else '  ← 有档没测到，看上面 FAIL 行'))
    real = [r for r in ROWS if r[3] == '真网']
    print(f'真网档：{sum(1 for r in real if r[4] == "PASS")}/{len(real)} 已出数'
          + ('  ← NOT_RUN，缺真实凭据/外网出口' if all(r[4] != 'PASS' for r in real) else ''))
    # 闸门自检：真实 send_message 一次都不该被调用。
    # 注意区分两件事 ——
    #   · 后台尝试发送（worker 调到 transport.send_message）= **正常**，队列就是干这个的
    #   · 真实 send_message 被执行 = 闸门漏了，字节出门
    # 我们把 transport.send_message 换成了「记一笔就抛错」，所以 SEND_ATTEMPTS
    # 记的是**被拦下的次数**，不是漏网次数。
    if SEND_ATTEMPTS:
        print(f'发送闸门：拦下 {len(SEND_ATTEMPTS)} 次后台发送尝试 → {SEND_ATTEMPTS}'
              f'；真实 send_message 未执行，0 字节出门')
    else:
        print('发送闸门：后台一次都没尝试发送')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        frappe.db.rollback()
        sys.exit(1)
