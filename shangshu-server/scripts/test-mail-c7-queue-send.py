"""C7 发送摘出请求、真排队 —— 行为测试（frappe 打桩，不碰真实发送）。

用户 2026-10-12 报：「点发送要很久才发出去」。
病根（已查实带行号）：delivery.py:47 把 process_send 挂在 frappe.db.after_commit 钩子上，
而 after_commit **仍在同一个请求里跑完** —— 界面写着「发送中」，实际是浏览器在等 SMTP 走完，
transport.py:25 TIMEOUT = 20 就是「要很久」的天花板。

测试通过 = 下面全部成立：
  A. 点发送这一趟**碰不到 SMTP** —— 隔离捕获器计数为 0（不是「发得快」，是「压根没发」）
  B. SMTP 那段被丢进**后台任务**（排队接口），不是同请求直调、也不是同请求钩子
  C. 立刻返回**「已排队」**（status = Queued），不等 SMTP

反例（= 没做）：queue_send 里出现同请求直调 process_send，或 after_commit 钩子里跑它。
"""
import sys
import types
import importlib
import contextlib
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]  # 本文件在 <root>/shangshu-server/scripts/ 下
MAIL = REPO / 'frappe_apps' / 'shangshu_mail'

# ── 隔离捕获器：谁碰 SMTP 都记一笔 ────────────────────────────────────────────
SMTP_CALLS = []


class FakeSMTP:
    def __init__(self, *a, **k):
        SMTP_CALLS.append(('connect', a, k))

    def login(self, *a, **k):
        SMTP_CALLS.append(('login', a, k))

    def sendmail(self, *a, **k):
        SMTP_CALLS.append(('sendmail', a, k))
        return {}

    def quit(self):
        SMTP_CALLS.append(('quit', (), {}))

    def close(self):
        SMTP_CALLS.append(('close', (), {}))


# ── 打桩 frappe ──────────────────────────────────────────────────────────────
class _Throw(Exception):
    pass


class _Errors:
    ValidationError = _Throw
    TimestampMismatchError = _Throw
    PermissionError = _Throw


ENQUEUED = []          # 后台任务进这里
AFTER_COMMIT = []      # 同请求钩子进这里（C7 之后这里必须是空的）


class _DB:
    class after_commit:
        @staticmethod
        def add(fn):
            AFTER_COMMIT.append(fn)


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
frappe.get_doc = lambda *a, **k: (_ for _ in ()).throw(_Throw('本测试不该取 File'))
frappe.utils = types.ModuleType('frappe.utils')
frappe.utils.now_datetime = lambda: '2026-10-12 12:00:00'
sys.modules['frappe'] = frappe
sys.modules['frappe.utils'] = frappe.utils

# ── 打桩 shangshu_core.public_api ────────────────────────────────────────────
core = types.ModuleType('shangshu_core')
core_api = types.ModuleType('shangshu_core.public_api')
core_api.domain_execution = lambda *a, **k: contextlib.nullcontext()
core_api.get_request_context = lambda: True
core_api.require_roles = lambda *a, **k: True
core_api.get_record_attachments = lambda *a, **k: []
sys.modules['shangshu_core'] = core
sys.modules['shangshu_core.public_api'] = core_api

sys.path.insert(0, str(MAIL))

# ── 打桩 shangshu_mail 的兄弟模块（只留 queue_send 要用的）────────────────────
account = types.ModuleType('shangshu_mail.account')
_binding = types.SimpleNamespace(binding_generation=1, display_name='我',
                                 email_address='me@example.invalid')
account.get_account = lambda **k: _binding
account.credentials = lambda b: ('me@example.invalid', 'pw')
# queue_send 现在要判代发权（N5-2「能读不等于能发」）。本测的是**排队行为**，
# 不是权限面 —— 权限那条由 test-mail-n5-shared-mailbox.py 单独钉，这里放行。
account.require_right = lambda mailbox, right, user=None: None
account.account_name = lambda user=None: 'stub-personal-box'

transport = types.ModuleType('shangshu_mail.transport')
transport.MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
transport.MAX_MESSAGE_BYTES = 28 * 1024 * 1024
transport.TIMEOUT = 20
transport.smtp_session = lambda *a, **k: FakeSMTP()   # 碰到就记一笔
transport.provider_for = lambda *a, **k: {'smtp_host': 'smtp.invalid', 'imap_host': 'imap.invalid'}

domain = types.ModuleType('shangshu_mail.domain')
domain.DOMAIN = 'mail'
domain.DOCTYPE = 'Shangshu Mail Message'
sys.modules['shangshu_mail.account'] = account
sys.modules['shangshu_mail.transport'] = transport
sys.modules['shangshu_mail.domain'] = domain

# ── 一封待发的信 ─────────────────────────────────────────────────────────────
DOC = types.SimpleNamespace(
    name='m-1', record_version=1, status='Draft', binding_generation=1,
    to_json='["a@b.example"]', cc_json='[]', subject='排队核对', body='<p>x</p>',
    attachment_ids_json='[]', inline_resources_json='[]', attachment_labels_json='{}',
    from_address='', message_id='', delivery_error='', rejected_json='[]',
    delivery_started_at=None,
    # N5-1 之后邮件挂在邮箱上；queue_send 判代发权要读这两个字段
    owner='tester@example.invalid', mailbox_id='stub-personal-box',
    save=lambda **k: None,
)

service = types.ModuleType('shangshu_mail.service')
service.message = lambda name, lock=False: DOC
service.projection = lambda doc, body=False: {
    'name': doc.name, 'status': doc.status, 'record_version': doc.record_version}
service.writing = lambda: contextlib.nullcontext()
sys.modules['shangshu_mail.service'] = service

delivery = importlib.import_module('shangshu_mail.delivery')

# ── 跑 ───────────────────────────────────────────────────────────────────────
result = delivery.queue_send(
    {'mail': 'm-1', 'expected_version': 1}, context={})

failures = []

# C：立刻返回「已排队」，不等 SMTP
if result.get('status') != 'Queued':
    failures.append(f"C 没有立刻返回「已排队」，实际返回 {result.get('status')!r}")

# A：这一趟碰不到 SMTP
if SMTP_CALLS:
    failures.append(f"A 这一趟碰到了 SMTP（捕获器记了 {len(SMTP_CALLS)} 笔）：{SMTP_CALLS[:3]}")

# B：SMTP 那段进后台任务，不是同请求钩子、不是同请求直调
if not ENQUEUED:
    failures.append('B 没有把发送排进后台任务 —— 说明还是同请求跑 SMTP')
if AFTER_COMMIT:
    failures.append(f'B 发送挂在同请求的 after_commit 钩子上（{len(AFTER_COMMIT)} 个）'
                    ' —— 钩子仍在请求里跑完，浏览器照样等 SMTP')
if ENQUEUED:
    fn, opts = ENQUEUED[0]
    if getattr(fn, '__name__', '') != 'process_send':
        failures.append(f'B 排进后台的不是 process_send，是 {getattr(fn, "__name__", fn)!r}')
    # 必须等提交落库后再排 —— 否则任务可能在草稿还没存上时就开跑
    if not opts.get('enqueue_after_commit'):
        failures.append('B 后台任务没等提交落库就排（缺 enqueue_after_commit）—— 草稿还没存就可能开跑')

if failures:
    print('FAIL —— C7 没做到：')
    for f in failures:
        print('  •', f)
    sys.exit(1)

print('PASS —— C7 成立：')
print(f"  立刻返回状态 = {result.get('status')!r}")
print(f"  同请求碰 SMTP 次数 = {len(SMTP_CALLS)}（必须 0）")
print(f"  同请求 after_commit 钩子里跑发送 = {len(AFTER_COMMIT)}（必须 0）")
print(f"  后台任务 = {ENQUEUED[0][1]} ← {getattr(ENQUEUED[0][0], '__name__', '?')}")
