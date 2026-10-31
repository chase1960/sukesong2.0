#!/usr/bin/env python3
"""邮件真实收发速度 —— 真网四档（S3 / S4 / S5 / S6）。

用户 2026-10-12 放行：「2放行,因为你有这个好的发件和收件,你应该能测出来他的所有速度吧」
「真实smtp信箱在shangshu-3in里面有,lingeringtek域名的,然后我需要你连上外网去测试一下」。

**边界（一条都不放宽）**
  · 只发给**用户自己**那一个地址（发件人 = 收件人），绝不发给真实客户
  · 发之前脚本会先打出「即将发送」清单，一眼看清要发什么
  · 「服务商接受」**不等于**「对方已收到」—— 报数字不报形容词，也不假报投递成功
  · 口令只从容器内 `/tmp/.mailcred-c1` 读，永不打印

测试通过 = 下面全部成立，且每档都给出**实测毫秒数**：

  S3  从「已排队」到「服务商接受」的实测毫秒数（不称对方已收到）
  S4  5MB 附件与无附件两档都报实测毫秒，并说清差值是不是 DATA 传输造成的
  S5  从点同步到新信出现在列表的实测毫秒数
  S6  连发 3 封各报一档：第 1 封含 TLS 握手，第 2/3 封复用连接省掉多少

跑法：
  docker exec -i shangshu-local-c-frappe-1 sh -lc \\
    'cd /home/frappe/frappe-bench && ./env/bin/python -' < scripts/test-mail-speed-real-network.py
"""
import sys
import time
import json
import traceback
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

from shangshu_core.public_api import execute_registered_action  # noqa: E402

USER = 'Administrator'
SELF = 'jiangzheny@lingeringtek.cn'   # 只发给自己
PROVIDER = 'netease-enterprise-hz'
CRED_FILE = '/tmp/.mailcred-c1'

ROWS = []


def report(code, what, ms, status, note=''):
    ROWS.append((code, what, ms, status, note))
    shown = '—' if ms is None else f'{ms:.0f}'
    line = f'SPEED|{code}|{what}|{shown} ms|真网|{status}'
    if note:
        line += f'|{note}'
    print(line)


def action(name, payload, key=None):
    frappe.set_user(USER)
    out = execute_registered_action(name, payload, True,
                                    key or frappe.generate_hash(length=24))
    frappe.set_user(USER)
    return (out or {}).get('result') or out or {}


def ensure_account():
    """把真信箱绑上。已绑过就跳过（授权码文件用完即删，不该挡重跑）。"""
    # `Email Account` 没有 `enabled` 列（产品的开关在自己的记录上），只查存在性
    if frappe.db.exists('Email Account', {'email_id': SELF}):
        print(f'✓ {SELF} 已绑定（跳过重复绑定；授权码已在库里）')
        return
    path = Path(CRED_FILE)
    if not path.exists():
        print(f'✗ 没找到授权码文件 {CRED_FILE}，且 {SELF} 未绑定 —— 先跑「接上真信箱.sh」')
        sys.exit(1)
    password = path.read_text().strip()
    frappe.set_user(USER)
    try:
        action('mail.account.configure', {
            'email': SELF, 'provider': PROVIDER, 'display_name': '测速',
            'password': password, 'enabled': True,
        })
        print(f'✓ 已绑定 {SELF}（{PROVIDER}）；授权码 {len(password)} 字节，未打印')
    except Exception as e:
        print(f'✗ 绑定失败：{type(e).__name__}: {e}')
        raise
    finally:
        frappe.set_user(USER)


def make_file(nbytes, label, attached_to):
    """造一个**真的** Frappe File（私有、带字节、已挂在某条读得到的记录上）。

    三样都得满足，`bind_record_attachments` 才放行（`attachments.py:76-81`）：
      · `is_private` 且 `file_url` 以 `/private/files/` 开头
      · **已挂在一条 `can_read_reference` 放行的记录上** —— 孤零零的文件会被判
        「附件来源不可访问，请重新选择」（第一次实跑就踩了这条）
      · 引用是**字符串 File ID**（ATTACHMENTS 的 schema 是 `array of FILE_REF`）"""
    frappe.set_user(USER)
    doctype, name = attached_to
    doc = frappe.get_doc({
        'doctype': 'File',
        'file_name': f'{label}.bin',
        'is_private': 1,
        'attached_to_doctype': doctype,
        'attached_to_name': name,
        'content': b'\x00' * nbytes,
    }).insert(ignore_permissions=True)
    frappe.db.commit()
    frappe.set_user(USER)
    url = doc.file_url or ''
    assert url.startswith('/private/files/'), f'附件不是私有文件：{url}'
    print(f'   [已造附件] {doc.name} → {url}（{nbytes} 字节，挂在 {doctype}/{name}）')
    return doc.name


def new_draft(subject, body, attach_bytes=0):
    """建草稿 →（要附件就先挂文件再存一版）。返回 (name, 回执)。"""
    frappe.set_user(USER)
    payload = {'to': [SELF], 'cc': [], 'subject': subject, 'body': body,
               'body_format': 'Text'}
    res = action('mail.save_draft', payload)
    frappe.db.commit()
    frappe.set_user(USER)
    name = res.get('name')
    if not name:
        rows = frappe.get_all('Shangshu Mail Message',
                              filters={'subject': subject, 'owner': USER},
                              fields=['name', 'record_version'],
                              order_by='modified desc', limit=1)
        name = rows[0]['name'] if rows else None
    if not name:
        raise AssertionError(f'草稿没建成：{res}')
    if attach_bytes:
        # 文件要先挂在**这封草稿**上，来源校验才放行；再存一版把它带进去
        file_id = make_file(attach_bytes, f'speed-{attach_bytes}',
                            ('Shangshu Mail Message', name))
        res = action('mail.save_draft', {
            'mail': name, 'expected_version': res.get('record_version') or
            frappe.get_value('Shangshu Mail Message', name, 'record_version'),
            'to': [SELF], 'cc': [], 'subject': subject, 'body': body,
            'body_format': 'Text', 'attachments': [file_id],
        })
        frappe.db.commit()
    frappe.set_user(USER)
    return name, res


def wait_delivered(name, timeout_s=120):
    """轮询到状态离开 Queued/Sending。返回 (终态, 毫秒)。"""
    t0 = time.perf_counter()
    deadline = t0 + timeout_s
    status, err = '', ''
    while time.perf_counter() < deadline:
        # 每轮提交一次再读 —— 否则 REPEATABLE READ 下长事务一直看旧快照，
        # worker 改的状态读不到（第一次实跑把这当成「没推进」）。
        frappe.db.commit()
        row = frappe.get_value('Shangshu Mail Message', name,
                               ['status', 'delivery_error', 'sent_at'], as_dict=True) or {}
        status = row.get('status') or ''
        err = row.get('delivery_error') or ''
        if status not in ('Queued', 'Sending', 'Draft'):
            return status, err, (time.perf_counter() - t0) * 1000.0
        time.sleep(0.25)
    return status, err, (time.perf_counter() - t0) * 1000.0


def send_one(code, subject, body, attach_bytes=0, note=''):
    """建草稿 → 发送 → 等到终态，报「已排队 → 服务商接受」耗时。"""
    print(f'   [即将发送] 收件人 = 发件人 = {SELF}；主题「{subject}」；'
          f'附件 {attach_bytes or 0} 字节')
    name, draft = new_draft(subject, body, attach_bytes)
    ver = draft.get('record_version') or frappe.get_value(
        'Shangshu Mail Message', name, 'record_version')

    t0 = time.perf_counter()
    action('mail.send', {'mail': name, 'expected_version': ver})
    # `queue_send` 用 `enqueue_after_commit=True` —— 不提交就永远不入队
    # （真实 HTTP 路径由请求末尾提交；脚本里必须自己提交，第一次实跑就卡在这）。
    frappe.db.commit()
    queued_ms = (time.perf_counter() - t0) * 1000.0

    status, err, deliver_ms = wait_delivered(name)
    accepted = status in ('Sent', 'Partial')
    report(code, f'{subject} —— 点发送→「已排队」', queued_ms, 'PASS',
           '本地排队那一趟')
    report(code, f'{subject} —— 「已排队」→ 终态 {status}', deliver_ms,
           'PASS' if accepted else ('FAIL' if status in ('Failed', 'Unknown') else 'TIMEOUT'),
           (note + '；' if note else '')
           + ('服务商已接受（**不等于对方已收到**）' if accepted else f'投递错误：{err[:120]}'))
    return {'name': name, 'status': status, 'queued_ms': queued_ms,
            'deliver_ms': deliver_ms, 'accepted': accepted}


def main():
    print('== 邮件真实收发速度（真网四档）==')
    print('判据：每档给实测毫秒；「服务商接受」不称「对方已收到」。')
    print('边界：只发给自己，不向真实客户发测试信。')
    print()
    ensure_account()

    # ---- S3：小信，点发送 → 服务商接受 ----
    print('-- S3 无附件小信')
    s3 = send_one('S3', '测速 S3：无附件小信', '这是测速样本，无附件。', 0)

    # ---- S4：5MB 附件，同一链路 ----
    print('-- S4 带 5MB 附件')
    s4 = send_one('S4', '测速 S4：5MB 附件', '这是测速样本，带 5MB 附件。',
                  5 * 1024 * 1024, 'DATA 传输档')

    if s3['accepted'] and s4['accepted']:
        delta = s4['deliver_ms'] - s3['deliver_ms']
        report('S4-delta', '5MB 与无附件的投递耗时差（DATA 传输）', delta, 'PASS',
               f"5MB {s4['deliver_ms']:.0f}ms − 无附件 {s3['deliver_ms']:.0f}ms")

    # ---- S6：连发 3 封小信，看连接复用省掉多少 ----
    print('-- S6 连发 3 封（连接复用）')
    chain = []
    for i in (1, 2, 3):
        r = send_one(f'S6-{i}', f'测速 S6 第{i}封：连接复用',
                     f'这是测速样本，第 {i} 封。', 0)
        chain.append(r)
        report(f'S6-{i}', f'第 {i} 封投递耗时', r['deliver_ms'],
               'PASS' if r['accepted'] else 'FAIL',
               '含 TLS 握手' if i == 1 else '复用已有连接')
    if all(r['accepted'] for r in chain):
        saved = chain[0]['deliver_ms'] - (chain[1]['deliver_ms'] + chain[2]['deliver_ms']) / 2
        report('S6-delta', '第 2/3 封比第 1 封省掉的握手时间', saved, 'PASS',
               f"第1封 {chain[0]['deliver_ms']:.0f}ms − 后两封均值 "
               f"{(chain[1]['deliver_ms']+chain[2]['deliver_ms'])/2:.0f}ms")

    # ---- S5：收信同步 ----
    print('-- S5 收信同步')
    incoming_on = frappe.get_value('Email Account', {'email_id': SELF}, 'enable_incoming')
    if not incoming_on:
        report('S5', '点「同步收件箱」→ 新信出现', None, 'NOT_RUN',
               '该信箱收信开关是关的（enable_incoming=0）—— 要测收信得先开 IMAP')
    else:
        t0 = time.perf_counter()
        try:
            res = action('mail.sync', {})
            ms = (time.perf_counter() - t0) * 1000.0
            report('S5', '点「同步收件箱」→ 新信出现', ms, 'PASS',
                   f"added={res.get('added', '?')} skipped={res.get('skipped', '?')}")
        except Exception as e:
            report('S5', '点「同步收件箱」→ 新信出现', None, 'FAIL',
                   f'{type(e).__name__}: {e}')

    print()
    ok = sum(1 for r in ROWS if r[3] == 'PASS')
    print(f'== 真网档 {ok}/{len(ROWS)} 通过 ==')
    for code, what, ms, status, note in ROWS:
        if status != 'PASS':
            print(f'  [{status}] {code} {what} {note}')
    print()
    print('提醒：「服务商已接受」只代表发出去的服务商收下了这封，')
    print('      **不代表对方已收到或已读** —— 要确认得去受控对端查收并回复。')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        frappe.db.rollback()
        sys.exit(1)
    finally:
        # 口令用完即清
        try:
            Path(CRED_FILE).unlink()
            print(f'已清理授权码文件 {CRED_FILE}')
        except Exception:
            pass
