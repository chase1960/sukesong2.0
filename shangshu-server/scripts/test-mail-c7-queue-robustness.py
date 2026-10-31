"""C7 发送队列的**稳态** —— 行为测试（frappe 打桩，不触发真实发送）。

用户 2026-10-12 补充要求：
  「发送队列必须真实持久化后才能显示『已排队』。排队成功不等于已发送；
    发送状态与实际结果一致。重试、重复点击、任务重启和 SMTP 结果不明
    都不能导致盲目重复发送。发送快照固定，后续编辑不能混入已排队邮件。」

前一份 test-mail-c7-queue-send.py 钉的是「发送摘出请求、真排队」（A/B/C）；
这一份钉的是**稳态**：排进去之后的每一条都不许盲目重发。

测试通过 = 下面全部成立：

  R1 真实持久化后才显示「已排队」：
     返回「已排队」之前 doc.status 已写成 Queued **且已落库**（_save 调过）；
     后台任务 `enqueue_after_commit=True` —— 没提交就不排，任务不会在草稿没存上时开跑。
  R2 排队 ≠ 已发送：返回的是 Queued，不是 Sent；这一趟 SMTP 捕获计数 0。
  R3 重复点击：已经 Queued 的信再点发送 → 第二个后台任务跑起来时发现状态已不是
     Queued 就退出，**SMTP 只碰一次**。
  R4 任务重启：Queued 的信把后台任务重跑 → 只发一次；发完状态是
     Sent/Partial/Failed/Unknown 之一，**绝不回到 Queued**（回到 Queued 就意味着能被再发一次）。
  R5 SMTP 结果不明（send_message 抛异常）→ 状态停在 Sending，**不回 Queued**；
     再跑一次后台任务**不重发**（Sending 是可见对账状态，人去原邮箱核对）。
  R6 发送快照固定：已 Queued 的信再存草稿**被拒**，后续编辑进不了这封。

反例（= 没做）：queue_send 对已 Queued 的信再置一次 Queued；process_send 不判状态直接发；
              异常后把状态改回 Queued；save_draft 让已排队的信改内容。
"""
import sys
import types
import importlib
import contextlib
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MAIL = REPO / 'frappe_apps' / 'shangshu_mail'

SMTP_CALLS = []
ENQUEUED = []
FAILURES = []


def check(ok, msg):
    if not ok:
        FAILURES.append(msg)


class FakeSMTP:
    def __init__(self, *a, **k): SMTP_CALLS.append(('connect', a, k))
    def login(self, *a, **k): SMTP_CALLS.append(('login', a, k))
    def sendmail(self, *a, **k): SMTP_CALLS.append(('sendmail', a, k)); return {}
    def quit(self): SMTP_CALLS.append(('quit', (), {}))
    def close(self): SMTP_CALLS.append(('close', (), {}))


class _Throw(Exception):
    pass


class _Errors:
    ValidationError = _Throw
    TimestampMismatchError = _Throw
    PermissionError = _Throw


SAVES = []          # _save 落库记录：(status, 顺序)
COMMITS = []        # 提交边界


class _DB:
    class after_commit:
        @staticmethod
        def add(fn):
            raise AssertionError('C7 之后不许再用 after_commit 跑发送（仍在请求里）')

    @staticmethod
    def commit(): COMMITS.append('commit')

    @staticmethod
    def rollback(): COMMITS.append('rollback')


class _Session:
    user = 'tester@example.invalid'


frappe = types.ModuleType('frappe')
frappe.throw = lambda msg, exc=_Throw: (_ for _ in ()).throw(exc(msg))
frappe.db = _DB()
frappe.session = _Session()
frappe.ValidationError = _Throw
frappe.TimestampMismatchError = _Throw
frappe.PermissionError = _Throw
frappe.enqueue = lambda fn, **k: ENQUEUED.append((fn, k))
frappe.set_user = lambda u: None
frappe.clear_messages = lambda: None
frappe.get_doc = lambda *a, **k: (_ for _ in ()).throw(_Throw('本测试不该取 File'))
frappe.utils = types.ModuleType('frappe.utils')
frappe.utils.now_datetime = lambda: '2026-10-12 12:00:00'
sys.modules['frappe'] = frappe
sys.modules['frappe.utils'] = frappe.utils

core = types.ModuleType('shangshu_core')
core_api = types.ModuleType('shangshu_core.public_api')
core_api.domain_execution = lambda *a, **k: contextlib.nullcontext()
core_api.get_request_context = lambda: True
core_api.require_roles = lambda *a, **k: True
core_api.get_record_attachments = lambda *a, **k: []
sys.modules['shangshu_core'] = core
sys.modules['shangshu_core.public_api'] = core_api

sys.path.insert(0, str(MAIL))

account = types.ModuleType('shangshu_mail.account')
_binding = types.SimpleNamespace(binding_generation=1, display_name='我',
                                 email_address='me@example.invalid', provider='smtp')
account.get_account = lambda **k: _binding
account.credentials = lambda b: ('me@example.invalid', 'pw')
# queue_send 现在要判代发权（N5-2）。本测的是**排队稳健性**，不是权限面 ——
# 权限由 test-mail-n5-shared-mailbox.py 单独钉，这里放行。
account.require_right = lambda mailbox, right, user=None: None
account.account_name = lambda user=None: 'stub-personal-box'

# send_message 可控：默认成功；把 SEND_MODE 改成 'boom' 模拟 SMTP 结果不明
SEND_MODE = {'mode': 'ok'}
transport = types.ModuleType('shangshu_mail.transport')
transport.MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
transport.MAX_MESSAGE_BYTES = 28 * 1024 * 1024
transport.TIMEOUT = 20
transport.smtp_session = lambda *a, **k: FakeSMTP()
transport.provider_for = lambda *a, **k: {'smtp_host': 'smtp.invalid', 'imap_host': 'imap.invalid'}


def _send_message(*a, **k):
    SMTP_CALLS.append(('send_message', a[:1], k))
    if SEND_MODE['mode'] == 'boom':
        raise RuntimeError('SMTP 结果不明（连接中断，不知对方收没收到）')
    return {'status': 'Sent', 'error': '', 'rejected': []}


transport.send_message = _send_message
domain = types.ModuleType('shangshu_mail.domain')
domain.DOMAIN = 'mail'
domain.DOCTYPE = 'Shangshu Mail Message'
sys.modules['shangshu_mail.account'] = account
sys.modules['shangshu_mail.transport'] = transport
sys.modules['shangshu_mail.domain'] = domain


def _save(**k):
    # delivery._save(doc) 最终调 doc.save(ignore_permissions=True) —— 接 **kwargs
    SAVES.append(DOC.status)


DOC = types.SimpleNamespace(
    name='m-1', record_version=1, status='Draft', binding_generation=1,
    to_json='["a@b.example"]', cc_json='[]', subject='稳态核对', body='<p>x</p>',
    body_format='Text', in_reply_to='',
    attachment_ids_json='[]', inline_resources_json='[]', attachment_labels_json='{}',
    from_address='', message_id='', delivery_error='', rejected_json='[]',
    delivery_started_at=None, sent_at=None, previous_status=None,
    owner='tester@example.invalid',
    # N5-1 之后邮件挂在邮箱上；queue_send 判代发权要读它
    mailbox_id='stub-personal-box',
    get=lambda k, d=None: getattr(DOC, k, d),
    save=_save,
)

service = types.ModuleType('shangshu_mail.service')
service.message = lambda name, lock=False: DOC
service.projection = lambda doc, body=False: {
    'name': doc.name, 'status': doc.status, 'record_version': doc.record_version}
service.writing = lambda: contextlib.nullcontext()
sys.modules['shangshu_mail.service'] = service

delivery = importlib.import_module('shangshu_mail.delivery')

# ── R1 + R2：排队 ───────────────────────────────────────────────────────────
result = delivery.queue_send({'mail': 'm-1', 'expected_version': 1}, context={})

check(result.get('status') == 'Queued', f"R2 返回的不是「已排队」，是 {result.get('status')!r}")
check(DOC.status == 'Queued', f"R1 返回时状态还没写成 Queued，是 {DOC.status!r}")
check('Queued' in SAVES, f"R1 「已排队」返回前没落库，_save 记录 = {SAVES}")
check(not SMTP_CALLS, f"R2 排队这一趟碰了 SMTP，计数 {len(SMTP_CALLS)}")
check(len(ENQUEUED) == 1, f"R1 后台任务数不对：{len(ENQUEUED)}")
if ENQUEUED:
    fn, opts = ENQUEUED[0]
    check(getattr(fn, '__name__', '') == 'process_send', f"R1 排的不是 process_send：{getattr(fn,'__name__',fn)!r}")
    check(opts.get('enqueue_after_commit') is True,
          'R1 后台任务没等提交落库就排（缺 enqueue_after_commit=True）—— 任务可能在草稿没存上时开跑')

# ── R3：重复点击 ────────────────────────────────────────────────────────────
# 已 Queued，用户又点了一次发送。两条路都不许导致**多发一次**：
#   ① 时间戳门拦下（expected_version 已过期）→ 直接拒
#   ② 版本对得上 → 再排一个任务，但两个任务合起来只能发一次
# 不管走哪条，**这封信总共只能发出去一次**（第一次点击该发的那一发当然还在）。
before_smtp = len(SMTP_CALLS)
rejected = False
try:
    delivery.queue_send({'mail': 'm-1', 'expected_version': 1}, context={})
except _Throw:
    rejected = True   # 走的是 ①：时间戳门（record_version 已 +1）
check(len(SMTP_CALLS) == before_smtp, f"R3 重复点击当场碰了 SMTP（{len(SMTP_CALLS)-before_smtp} 次）")

# 排进去的任务合起来跑完，这封信总共只能发出去一次
# 回放要按**真实入参形状**喂回去：name/user 是**顶层摊开**传的，
# 不是包在 `kwargs={...}` 字典里。那种包法正是当初让信永远停在「已排队」的 bug
# （worker 日志：`process_send() got an unexpected keyword argument 'job_timeout'`），
# 契约由 test-mail-enqueue-args.py 钉着。
_ENQUEUE_META = {'queue', 'timeout', 'job_timeout', 'enqueue_after_commit', 'kwargs'}
for fn, opts in list(ENQUEUED):
    fn(**{k: v for k, v in opts.items() if k not in _ENQUEUE_META})
sent_calls = [c for c in SMTP_CALLS if c[0] == 'send_message']
check(len(sent_calls) == 1,
      f"R3 重复点击后这封信总共发了 {len(sent_calls)} 次（必须 1）"
      f"；第二次点击被时间戳门拦下 = {rejected}")
check(DOC.status == 'Sent', f"R3 发完状态不对：{DOC.status!r}")

# ── R4：任务重启（Queued 的信把任务重跑）────────────────────────────────────
DOC.status = 'Queued'; DOC.record_version = 5; DOC.delivery_error = ''
DOC.delivery_started_at = None; DOC.sent_at = None
SAVES.clear(); SMTP_CALLS.clear(); ENQUEUED.clear()
delivery.queue_send({'mail': 'm-1', 'expected_version': 5}, context={})
job_fn, job_opts = ENQUEUED[0]
# 同一个任务跑两遍（模拟 worker 重启后消息被重投）
for _ in range(2):
    job_fn(**{k: v for k, v in job_opts.items() if k not in _ENQUEUE_META})
sent_calls = [c for c in SMTP_CALLS if c[0] == 'send_message']
check(len(sent_calls) == 1, f"R4 任务重启重跑发了 {len(sent_calls)} 次（必须 1）")
check(DOC.status != 'Queued',
      f"R4 发完状态回到了 Queued（{DOC.status!r}）—— 那就意味着这封还能被再发一次")

# ── R5：SMTP 结果不明 ───────────────────────────────────────────────────────
DOC.status = 'Queued'; DOC.record_version = 9; DOC.delivery_error = ''
DOC.delivery_started_at = None; DOC.sent_at = None
SAVES.clear(); SMTP_CALLS.clear(); ENQUEUED.clear()
SEND_MODE['mode'] = 'boom'
delivery.queue_send({'mail': 'm-1', 'expected_version': 9}, context={})
for fn, opts in list(ENQUEUED):
    fn(**{k: v for k, v in opts.items() if k not in _ENQUEUE_META})
ENQUEUED.clear()
check(DOC.status == 'Sending',
      f"R5 SMTP 结果不明时状态被改成了 {DOC.status!r}，该停在 Sending 让人去原邮箱核对")
check(DOC.status != 'Queued', 'R5 SMTP 结果不明却回到了 Queued —— 会被盲目重发')

# 再跑一次任务：状态已不是 Queued/Sending 可发态，不许重发
before = len([c for c in SMTP_CALLS if c[0] == 'send_message'])
DOC.status = 'Sending'
delivery.process_send('m-1', 'tester@example.invalid')
after = len([c for c in SMTP_CALLS if c[0] == 'send_message'])
check(after == before, f"R5 结果不明之后再跑任务又发了一次（{after-before} 次）")
SEND_MODE['mode'] = 'ok'

# ── R6：发送快照固定 ────────────────────────────────────────────────────────
# 已 Queued 的信，mail.save_draft 必须被拒（service.py 的 status 门）。
# 这里直接验那道门的语义：非 Draft 一律拒改。
src = (MAIL / 'shangshu_mail' / 'service.py').read_text(encoding='utf-8')
guard_ok = ("if doc.status != 'Draft':" in src) and ('只有草稿可以编辑' in src)
check(guard_ok, 'R6 没找到「只有 Draft 可以编辑」这道门 —— 已排队的信可能被改内容')

# 更硬的一层：queue_send 自己也不许让非 Draft/Queued 的信进队列
DOC.status = 'Sent'; DOC.record_version = 11
try:
    delivery.queue_send({'mail': 'm-1', 'expected_version': 11}, context={})
    check(False, 'R6 已发送的信还能再排队（会变成可重复发送）')
except _Throw as e:
    check('不要重复发送' in str(e) or '已经开始发送' in str(e),
          f"R6 已发送的信再排队被拒了，但说辞不对：{e}")

# ── 结果 ───────────────────────────────────────────────────────────────────
if FAILURES:
    print('FAIL —— C7 稳态没做到：')
    for f in FAILURES:
        print('  •', f)
    sys.exit(1)

print('PASS —— C7 稳态成立：')
print(f"  R1 「已排队」返回前已落库；后台任务 enqueue_after_commit=True")
print(f"  R2 返回状态 = Queued（≠已发送）；排队这一趟 SMTP 计数 = 0")
print(f"  R3 重复点击：两个后台任务合起来只发 1 次")
print(f"  R4 任务重启重跑：只发 1 次；发完状态 = {DOC.status!r}（绝不回 Queued）")
print(f"  R5 SMTP 结果不明：停在 Sending，再跑任务不重发")
print(f"  R6 快照固定：已排队的信改不了；已发送的信不能再排队")
