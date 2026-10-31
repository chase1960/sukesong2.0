#!/usr/bin/env python3
"""AC-M3 发送故障反例 —— 重复点发送 / 结果未知 / 发送失败。

验收单 AC-M3 判据：「重复点击/未知结果/失败等反例…独立留证」。
这三条都是**不好的结果**，产品必须如实说，不许谎报成功。

跑在容器里（依赖 frappe）。**只生成邮件内容，不触发真实发送** ——
传输层整段换成隔离捕获器，连的不是任何真实服务商。

测试通过 = 下面全部成立：

 1. **重复点发送被拒**：一封已经开始发送（或已结束）的信再点发送，
    被明确拒绝，理由说清「不要重复发送」—— 不许再发一封出去。
 2. **发送失败要说原因**：SMTP 还没开始发送就断 → 状态「失败」，
    且**失败原因非空**（不是「失败」两个字完事，人要知道为什么）。
 3. **结果未知不谎报成功**：SMTP **已经把信交出去**之后连接断了 →
    状态「结果未知」，**不是「已发送」**。因为这时候谁也不知道到底出去没有 ——
    说「已发送」是骗人，说「失败」也可能不对（对方可能已经收到了）。
 4. **结果未知的说明要劝人去原邮箱核对**，不叫人重复发（重复发会让对方收两封）。
 5. **该拦下的场景，捕获器里零封**（第 4 段，PKG-014「错误发信」判据缺口）：
    每个不该发的场景点发送，除了要拦住，**信本身一封都不许出去** ——
    闸口说「拒了」但信还是发了，是「错误发信」最坏的形态（人以为拦住了）。
    含一条**真缺口**：排队之后被撤「代发权」，后台不许把信发出去。
"""
import os
import sys
from pathlib import Path

# 可选：MAIL_CODE_STAGED 指向**含 shangshu_mail/ 应用根的那层目录**（不是包目录本身，
# 也不是仓根 —— 是 `…/shangshu_mail/shangshu_mail/` 的上一层），用来在**不碰共享运行面**
# 的前提下验改动。这是**暂存验证，不是部署验证**：验完代码还是没进 bench，真页面另算。
# ★顺序要紧：bench 先插、staged 后插 —— 都用 insert(0)，**后插的赢**。
#   （反了的话 bench 顶在前面，看着「验了暂存」其实跑的是 bench，又是空过。）
_roots = [Path('/home/frappe/frappe-bench/apps')]
_staged = os.environ.get('MAIL_CODE_STAGED')
if _staged:
    _roots.append(Path(_staged))

for _a in ('shangshu_mail', 'shangshu_core', 'shangshu_files'):
    for _r in _roots:
        _p = _r / _a
        if _p.exists() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))

import frappe
import shangshu_mail.transport as transport
from shangshu_mail.service import writing

SITE = 'shangshu.localhost'
frappe.init(site=SITE, sites_path='/home/frappe/frappe-bench/sites')
frappe.connect()

USER = 'ac-m3@shangshu.local'
if not frappe.db.exists('User', USER):
    frappe.get_doc({'doctype': 'User', 'email': USER, 'first_name': 'AC-M3',
                    'send_welcome_email': 0, 'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
frappe.set_user(USER)
frappe.db.commit()   # 夹具先落定：动作入口失败时会 rollback

from shangshu_core.public_api import execute_registered_action
from shangshu_mail import account, delivery


def make_draft(tag):
    with writing():
        doc = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Draft',
            'subject': f'AC-M3 {tag}', 'body': f'AC-M3 反例 {tag} 正文',
            'body_format': 'Text', 'to_json': '["自己 <me@x.example>"]', 'cc_json': '[]',
            'from_address': '', 'record_version': 1}).insert(ignore_permissions=True)
    # 草稿也得**落定** —— 后面故意失败的动作入口会 rollback，
    # 没提交的草稿会被那把回滚卷走（实测 DoesNotExistError）。
    frappe.db.commit()
    return doc.name


print('\n=== 1 重复点发送被拒 ===')
name1 = make_draft('重复发送')
# 绑一个可用的邮箱账号（凭据是假的，传输层下面整段换掉，不连真网）
account_mod = account
orig_creds = account_mod.credentials
orig_get_account = account_mod.get_account
# queue_send **先查邮箱绑定**再查状态 —— 不桩绑定的话，拒的理由会变成
# 「请先在邮箱设置中绑定自己的邮箱」，测的就不是「重复发送」这条了。
class _FakeBinding:
    name = 'fake-binding'
    # 字段是 varchar，库里读回来是字符串 —— 整数 1 存进去读成 '1'，'1' != 1 判不等
    binding_generation = 'gen-1'
    display_name = 'AC-M3'
    email_address = 'me@x.example'
    provider = 'qq'
account_mod.get_account = lambda **k: _FakeBinding()
account_mod.credentials = lambda binding, **k: ('me@x.example', 'fake-auth-code')
try:
    transport.imap_session = lambda *a, **k: None
    transport.test_connection = lambda *a, **k: True
    # 第一次：把信推进「发送中」
    outcome_sent = {'status': 'Sending', 'error': '占位', 'rejected': []}
    # 直接把状态推到「已开始发送」，模拟「第一次点发送已经出去了」
    with writing():
        doc = frappe.get_doc('Shangshu Mail Message', name1)
        doc.status = 'Sending'
        doc.record_version += 1
        doc.save(ignore_permissions=True)
    # 第二次点发送 —— 必须被拒
    try:
        execute_registered_action('mail.send', {'mail': name1, 'expected_version': doc.record_version},
                                  True, frappe.generate_hash(length=24))
        require('1-1 已在发送中的信再点发送要被拒', False, '居然又发了一次')
    except Exception as exc:
        text = str(exc)
        require('1-1 已在发送中的信再点发送要被拒', True)
        require('1-2 拒绝理由要说清「不要重复发送」', '重复发送' in text or '已开始发送' in text,
                f'理由没说清：{text[:100]}')

    # 已结束的信（失败）再点发送也要被拒
    with writing():
        doc = frappe.get_doc('Shangshu Mail Message', name1)
        doc.status = 'Failed'
        doc.delivery_error = '上一次失败了'
        doc.record_version += 1
        doc.save(ignore_permissions=True)
    try:
        execute_registered_action('mail.send', {'mail': name1, 'expected_version': doc.record_version},
                                  True, frappe.generate_hash(length=24))
        require('1-3 已失败的信再点发送也要被拒（不许悄悄重发）', False, '居然又发了一次')
    except Exception as exc:
        require('1-3 已失败的信再点发送也要被拒（不许悄悄重发）', True,
                f'拒了：{str(exc)[:60]}')

    print('\n=== 2 发送失败要说原因 ===')
    name2 = make_draft('失败有原因')
    # 只桩 **SMTP 连接**这一层，不顶替 send_message 本身 ——
    # 顶替了的话，状态和文案都是我编的，测的是测具不是产品。
    # 这里让真的 send_message 走它的异常分支，产品原话由它自己产出。
    # 「还没开始发送就断」= smtp_session 直接抛 → sending 还是 False。
    def boom_before(address, password, provider=None, credential_version=None):
        raise OSError('模拟：连不上服务商')
    transport.smtp_session = boom_before
    # 走真实的后台发送入口
    with writing():
        doc = frappe.get_doc('Shangshu Mail Message', name2)
        doc.status = 'Queued'
        # 绑定代号要和桩对上 —— 不对上会走「邮箱绑定已改变」那条，
        # 根本不调 transport.send_message，测的就不是传输层结果（2-1/2-2 曾因此假绿）。
        doc.binding_generation = 'gen-1'
        doc.record_version += 1
        doc.save(ignore_permissions=True)
    delivery.process_send(name2, USER)
    doc = frappe.get_doc('Shangshu Mail Message', name2)
    require('2-1 还没开始发送就断 → 状态是「失败」', doc.status == 'Failed',
            f'实际 status={doc.status!r}')
    require('2-2 失败原因非空，人要知道为什么',
            bool((doc.delivery_error or '').strip()),
            f'失败原因是空的 —— 界面上只剩「失败」两个字，不知道为什么')
    # 失败 vs 结果未知，分界就在「有没有把信交出去」——
    # 说明里必须说清这一点，否则人不知道该重发还是该去核对。
    err2 = doc.delivery_error or ''
    require('2-3 说明要说清「还没开始发送」，和「结果未知」是两回事',
            ('未开始发送' in err2) or ('没开始' in err2) or ('未发送' in err2),
            f'没说清交没交出去：{err2[:100]}')

    print('\n=== 3 结果未知不谎报成功 ===')
    name3 = make_draft('结果未知')
    # 「**已经把信交出去之后**断」= 连接建立成功（sending 已置真），
    # 但真去投递那一下炸了。同样不顶替 send_message ——
    # 产品原话「发送结果不明，请在原邮箱核对，不能直接重发」由它的 except 产出。
    class _FakeConn:
        def send_message(self, message, from_addr=None, to_addrs=None):
            raise OSError('模拟：服务商收下了之后连接断了')
        def quit(self): pass
        def close(self): pass
    def boom_after(address, password, provider=None, credential_version=None):
        return _FakeConn()
    transport.smtp_session = boom_after
    with writing():
        doc = frappe.get_doc('Shangshu Mail Message', name3)
        doc.status = 'Queued'
        doc.binding_generation = 'gen-1'
        doc.record_version += 1
        doc.save(ignore_permissions=True)
    delivery.process_send(name3, USER)
    doc = frappe.get_doc('Shangshu Mail Message', name3)
    require('3-1 已交出去之后断 → 状态是「结果未知」，不是「已发送」',
            doc.status == 'Unknown', f'实际 status={doc.status!r} —— 谎报了结果')
    require('3-2 「结果未知」不等于成功',
            doc.status not in ('Sent', 'Partial'),
            f'状态 {doc.status!r} 被当成了成功')
    err = doc.delivery_error or ''
    # 这句是**产品自己**产的（transport.send_message 的 except 分支），
    # 不是测具编的 —— 所以这里钉的是「两个关键词都在」这个行为：
    # 既说清去哪核对（原邮箱），又说清核对（不是重发）。
    require('3-3 说明要劝人去原邮箱核对，不叫人重复发',
            ('原邮箱' in err) and ('核对' in err),
            f'说明没劝人去原邮箱核对：{err[:100]}')
    require('3-4 说明里不许叫人重复发送（会让对方收两封）',
            '重复发送' not in err or '勿' in err or '不要' in err,
            f'说明可能叫人重发：{err[:100]}')

finally:
    account_mod.credentials = orig_creds
    account_mod.get_account = orig_get_account


# ─────────────────────────────────────────────────────────────────────────────
# 4 该拦下的场景，捕获器里**零封**（PKG-014 「错误发信」判据缺口）
#
# 夜班清单 2026-10-14-窗口-692c0929.md:41-56 / :107 原话：
#   「现有判据覆盖『不多发/不再发/无权不发/没成不说成』四类，
#     **没有一条专门验「该拦下的场景里捕获器没那封信」**」
#
# 1-3 段验的是**报错文案和状态**。这一段验的是**信到底出没出去** ——
# 闸口说「拒了」但信还是发出去了，是「错误发信」最坏的形态：人以为拦住了。
#
# 测试通过 = 在每个「不该发」的场景里点发送（含「排队后被撤代发权」），
#            回包/异常明确说没发出去，**且隔离捕获器里一封都没有、真实发信通道零调用**。
#
# 边界：整段用隔离捕获器，**一次真实发送都不做**（约束原文「测试只生成邮件内容或
#       使用隔离捕获器，不触发真实发送」）。「错误发信」正是要修的毛病，真发一封收不回。
# ─────────────────────────────────────────────────────────────────────────────
print('\n=== 4 该拦下的场景，捕获器里零封 ===')
import unittest.mock
from shangshu_mail import delivery as delivery_mod

gate_captured = []
gate_real_calls = []


class _GateCapture:
    """隔离捕获器：信进列表，不碰网络。与 three-old-bugs._Capture 同一套路。"""

    def __init__(self, *a, **k):
        pass

    def login(self, *a, **k):
        pass

    def send_message(self, message, **kw):
        gate_captured.append(message)
        return {}

    def quit(self):
        pass

    def close(self):
        pass


class _GateRealGuard:
    """真实通道一旦被碰就记一笔并炸 —— 「零调用」要有证据，不是「应该没调」。"""

    def __init__(self, *a, **k):
        gate_real_calls.append('constructed')
        raise AssertionError('真实发信通道被调用了')


def try_send(name, expected_version):
    """走**生产动作入口**点发送。返回 (是否被拦, 拦下的原话)。"""
    try:
        execute_registered_action('mail.send', {'mail': name, 'expected_version': expected_version},
                                  True, frappe.generate_hash(length=24))
        return False, ''
    except Exception as exc:
        return True, str(exc)


class _GateBinding:
    name = 'gate-binding'
    binding_generation = 'gen-gate-1'
    display_name = 'AC-M3'
    email_address = 'me@x.example'
    provider = 'qq'


orig_get_account2 = account.get_account
orig_credentials2 = account.credentials

with unittest.mock.patch.object(transport.smtplib, 'SMTP_SSL', _GateCapture), \
        unittest.mock.patch.object(transport.smtplib, 'SMTP', _GateRealGuard):
    account.get_account = lambda **k: _GateBinding()
    account.credentials = lambda binding, **k: ('me@x.example', 'fake-auth-code')
    try:
        # —— 4a 网关四道检：每条都要「拦住 + 捕获器零封」——
        gate_cases = []

        # 版本不一致（别人改过了）
        n = make_draft('G版本')
        d = frappe.get_doc('Shangshu Mail Message', n)
        gate_cases.append(('4a-1 版本不一致', n, d.record_version + 99))

        # 无收件人
        n = make_draft('G无收件')
        with writing():
            d = frappe.get_doc('Shangshu Mail Message', n)
            d.to_json, d.cc_json = '[]', '[]'
            d.save(ignore_permissions=True)
        frappe.db.commit()
        d = frappe.get_doc('Shangshu Mail Message', n)
        gate_cases.append(('4a-2 无收件人', n, d.record_version))

        # 无主题
        n = make_draft('G无主题')
        with writing():
            d = frappe.get_doc('Shangshu Mail Message', n)
            d.subject = '   '
            d.save(ignore_permissions=True)
        frappe.db.commit()
        d = frappe.get_doc('Shangshu Mail Message', n)
        gate_cases.append(('4a-3 无主题', n, d.record_version))

        # 主题含控制字符
        n = make_draft('G控制字符')
        with writing():
            d = frappe.get_doc('Shangshu Mail Message', n)
            d.subject = '坏主题\n注入'
            d.save(ignore_permissions=True)
        frappe.db.commit()
        d = frappe.get_doc('Shangshu Mail Message', n)
        gate_cases.append(('4a-4 主题含控制字符', n, d.record_version))

        # 已开始发送（重复点）
        n = make_draft('G重复')
        with writing():
            d = frappe.get_doc('Shangshu Mail Message', n)
            d.status = 'Sending'
            d.record_version += 1
            d.save(ignore_permissions=True)
        frappe.db.commit()
        d = frappe.get_doc('Shangshu Mail Message', n)
        gate_cases.append(('4a-5 已开始发送再点（不多发）', n, d.record_version))

        for label, name, ver in gate_cases:
            gate_captured.clear()
            blocked, why = try_send(name, ver)
            require(f'{label} 被拦住', blocked, '居然放行了')
            require(f'{label} 拦住后捕获器零封',
                    len(gate_captured) == 0,
                    f'拦住了但信出去了 —— 捕获器 {len(gate_captured)} 封')

        # —— 4b 无代发权（只读授权的人点发送）：不只要拒，信也不许出去 ——
        OTHER = 'ac-m3-readonly@shangshu.local'
        if not frappe.db.exists('User', OTHER):
            frappe.get_doc({'doctype': 'User', 'email': OTHER, 'first_name': '只读AC-M3',
                            'send_welcome_email': 0, 'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
        frappe.db.commit()
        BOX = 'gate-box-' + frappe.generate_hash(length=8)
        frappe.set_user('Administrator')
        with account.writing():
            if not frappe.db.exists('Shangshu Mail Account', BOX):
                frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': BOX,
                                'kind': 'personal', 'provider': 'qq',
                                'email_address': 'me@x.example', 'display_name': 'AC-M3',
                                'enabled': 1, 'connection_status': 'connected',
                                'binding_generation': 'gen-gate-1'}).insert(ignore_permissions=True)
        frappe.db.commit()
        # 只给读权 —— 「能读不等于能发」
        account.grant(_action=None, payload={'mailbox': BOX, 'user': OTHER,
                                             'rights': {'read': True, 'send': False}},
                      _context=None)
        frappe.db.commit()
        n = make_draft('G无代发权')
        with writing():
            d = frappe.get_doc('Shangshu Mail Message', n)
            d.mailbox_id = BOX
            d.save(ignore_permissions=True)
        frappe.db.commit()
        d = frappe.get_doc('Shangshu Mail Message', n)
        frappe.set_user(OTHER)
        gate_captured.clear()
        blocked, why = try_send(n, d.record_version)
        require('4b-1 无代发权被拦住（能读不等于能发）', blocked, '只读的人居然发出去了')
        require('4b-2 无代发权拦住后捕获器零封', len(gate_captured) == 0,
                f'拦住了但信出去了 —— 捕获器 {len(gate_captured)} 封')

        # —— 4c ★排队后撤「代发权」（留阅读权）：后台不许把信发出去 ——
        # 这是本条的**真缺口**。queue_send 闸口上有 require_right(home,'send')，
        # 但 process_send（后台真正发信那段）只重判 _validate_actor + binding_generation，
        # **从不重判 require_right(home,'send')**。
        #
        # ★撤权方式是关键：必须**只收 send、留 read**。
        #   探针实测（probe-4c-b）：若用 account.revoke() 把整行授权删光，
        #   process_send:90 的 message() 会先抛「只能访问自己邮箱或已获授权邮箱里的邮件」
        #   —— 那是**读权**拦的，不是代发权拦的，测出来是假绿（空过）。
        #   真实场景是「能读不等于能发」（N5-2）：人还能看这封信，只是不该再代发。
        #   而 account.revoke() 只删 Shangshu Mail Access 行（account.py:183-189），
        #   **不动 binding_generation**（那在 :348/:363 跟账号绑定走），
        #   所以那道检查也拦不住。
        frappe.set_user('Administrator')
        account.grant(_action=None, payload={'mailbox': BOX, 'user': OTHER,
                                             'rights': {'read': True, 'send': True}},
                      _context=None)
        frappe.db.commit()
        n = make_draft('G排队后撤权')
        with writing():
            d = frappe.get_doc('Shangshu Mail Message', n)
            d.mailbox_id = BOX
            d.save(ignore_permissions=True)
        frappe.db.commit()
        d = frappe.get_doc('Shangshu Mail Message', n)
        frappe.set_user(OTHER)
        gate_captured.clear()
        blocked, why = try_send(n, d.record_version)
        queued_ok = (not blocked) and frappe.db.get_value(
            'Shangshu Mail Message', n, 'status') == 'Queued'
        require('4c-0 有权时排队成功（前提要成立，否则本条测空了）',
                queued_ok,
                f'前提没成立 —— blocked={blocked} why={why[:80]} '
                f'状态={frappe.db.get_value("Shangshu Mail Message", n, "status")}')
        # 排上队之后，**只收代发权、留阅读权**（N5-2 的现实场景）
        frappe.set_user('Administrator')
        account.grant(_action=None, payload={'mailbox': BOX, 'user': OTHER,
                                             'rights': {'read': True, 'send': False}},
                      _context=None)
        frappe.db.commit()
        still_read = account.rights_for(BOX, OTHER).get('read')
        still_send = account.rights_for(BOX, OTHER).get('send')
        print(f'      ↳ 撤代发权后：read={still_read!r} send={still_send!r} '
              f'（read 必须还在，否则又是靠读权拦的假绿）')
        require('4c-0b 前提：阅读权还在、代发权已收（不是靠读权拦）',
                bool(still_read) and not still_send,
                f'read={still_read!r} send={still_send!r} ← 前提不成立就是假绿')
        gate_captured.clear()
        # 后台真正发信那一趟。
        # ★判据盯 `transport.send_message` 调用次数，不只盯捕获器 ——
        #   探针实测（probe-4c-b）：部分撤权后 `transport.send_message` **确实被调到**，
        #   只是那次因凭据是假的回了 Failed、字节没真出去。生产里凭据是真的，
        #   「发起发送」这一步就等于信出去了。所以「不该发」的准判据是
        #   **产品压根不许尝试发送**，不是「尝试了但没成功」。
        sm_calls = []
        real_sm = transport.send_message

        def _spy_sm(*a, **k):
            sm_calls.append(1)
            return real_sm(*a, **k)

        transport.send_message = _spy_sm
        try:
            delivery_mod.process_send(n, OTHER)
            frappe.db.commit()
        except Exception as exc:
            print(f'      ↳ process_send 抛了：{str(exc)[:80]}')
        finally:
            transport.send_message = real_sm
        print(f'      ↳ transport.send_message 被调 {len(sm_calls)} 次；'
              f'捕获器 {len(gate_captured)} 封')
        require('4c-1 排队后被撤代发权 → 后台不许把信发出去（不许尝试发送）',
                len(sm_calls) == 0 and len(gate_captured) == 0,
                f'**不该发却发起发送了** —— transport.send_message 被调 {len(sm_calls)} 次，'
                f'捕获器 {len(gate_captured)} 封')
        d = frappe.get_doc('Shangshu Mail Message', n)
        require('4c-2 状态不许变成已发出（要说清没发）',
                d.status not in ('Sent',),
                f'状态={d.status} ← 撤权后还标成发出去了')
    finally:
        account.get_account = orig_get_account2
        account.credentials = orig_credentials2

require('4d 真实发信通道全程零调用',
        not gate_real_calls, f'真实通道被碰了：{gate_real_calls}')

print(f"\n{'=' * 60}")
print(f"通过 {len(PASS)} 条，未过 {len(FAIL)} 条")
if FAIL:
    print('未过：')
    for f in FAIL:
        print(f'  - {f}')

# 夹具落过库，显式清掉
try:
    frappe.set_user('Administrator')
    # 按**前缀**清，不逐个列 subject —— 加用例时忘了同步这行就会漏删，
    # 残留信件下一轮会咬到别人的测试（本文件原有三个 subject 硬编码就是这个坑）。
    for row in frappe.get_all('Shangshu Mail Message', filters={'subject': ('like', 'AC-M3 %')}, pluck='name'):
        try:
            with writing():
                frappe.delete_doc('Shangshu Mail Message', row, ignore_permissions=True, force=True)
        except Exception:
            pass
    # 第 4 段的邮箱与授权行一并清（授权行不清会留成孤儿，下一轮测「这个人没权限」被咬）
    for row in frappe.get_all('Shangshu Mail Account', filters={'account_key': ('like', 'gate-box-%')}, pluck='name'):
        try:
            with account.writing():
                frappe.delete_doc('Shangshu Mail Account', row, ignore_permissions=True, force=True)
        except Exception:
            pass
    for row in frappe.get_all('Shangshu Mail Access', filters={'mailbox': ('like', 'gate-box-%')}, pluck='name'):
        try:
            frappe.delete_doc('Shangshu Mail Access', row, ignore_permissions=True, force=True)
        except Exception:
            pass
    for u in (USER, 'ac-m3-readonly@shangshu.local'):
        if frappe.db.exists('User', u):
            frappe.delete_doc('User', u, ignore_permissions=True, force=True)
    frappe.db.commit()
    print('夹具已清掉')
except Exception as cleanup_error:
    frappe.db.rollback()
    print(f'夹具清理失败，需人工删掉测试账号 {USER}：{str(cleanup_error)[:100]}')

sys.exit(1 if FAIL else 0)
