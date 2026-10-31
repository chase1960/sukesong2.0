"""C9 附件/内联图备料不堵路 —— 行为测试（frappe 打桩，不碰真实发送）。

用户 2026-10-12 报「点发送要很久」，病根之一（已查实）：
`delivery.py` 的 `process_send` 把**所有附件和内联图一次性读进内存**
（`frappe.get_doc('File', …).get_content()`），整封 MIME + base64 都在热路径上干。

C7 已经把 `process_send` 挪进后台任务，所以「请求里不读字节」**随 C7 成立**。
这条测试是**钉死它**：以后谁把读字节挪回请求，这里立刻红。

测试通过 = 下面全部成立：
  A. 点发送这一趟（queue_send）**不读任何附件/内联图字节** —— File.get_content 一次都不调
  B. 读字节只发生在后台那段（process_send 里）
  C. 附件很大时，queue_send 仍然只碰元数据（算总大小用的是 size 字段）

反例（= 没做）：queue_send 里出现 get_content / 把整封 MIME 拼在请求里。

⚠️ 判据原文还有「带 10MB 附件的信，点发送到『已排队』的耗时与无附件的信同量级」——
那是**真实计时**，要连着隔离 SMTP 量毫秒数。本测试钉的是**成因**（请求里不读字节），
**不冒充计时达标**。
"""
import sys
import types
import importlib
import contextlib
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MAIL = REPO / 'frappe_apps' / 'shangshu_mail'

BYTE_READS = []        # 谁在什么时候读了字节
ENQUEUED = []
SLOW_IO = {'ms': 0}    # >0 时取字节故意慢（模拟真从存储拿 10MiB 的代价）


class FakeFile:
    """取字节就记一笔 —— 谁在请求里读它，一眼看得见。
    SLOW_IO 打开时每次取字节真睡 SLOW_IO['ms'] 毫秒：
    请求路径只要敢读字节，耗时立刻拉开数量级。"""
    def __init__(self, name):
        self.name = name

    def get_content(self):
        BYTE_READS.append(('get_content', self.name))
        if SLOW_IO['ms']:
            import time
            time.sleep(SLOW_IO['ms'] / 1000.0)
        return b'x' * 1024


class _Throw(Exception):
    pass


frappe = types.ModuleType('frappe')
frappe.throw = lambda msg, exc=_Throw: (_ for _ in ()).throw(exc(msg))
frappe.db = types.SimpleNamespace(after_commit=types.SimpleNamespace(add=lambda fn: None))
frappe.session = types.SimpleNamespace(user='tester@example.invalid')
frappe.ValidationError = _Throw
frappe.TimestampMismatchError = _Throw
frappe.PermissionError = _Throw
frappe.enqueue = lambda fn, **k: ENQUEUED.append((fn, k))
frappe.get_doc = lambda doctype, name=None, **k: (
    FakeFile(name) if doctype == 'File' else (_ for _ in ()).throw(_Throw(f'意外取 {doctype}')))
frappe.utils = types.ModuleType('frappe.utils')
frappe.utils.now_datetime = lambda: '2026-10-12 12:00:00'
sys.modules['frappe'] = frappe
sys.modules['frappe.utils'] = frappe.utils

core = types.ModuleType('shangshu_core')
core_api = types.ModuleType('shangshu_core.public_api')
core_api.domain_execution = lambda *a, **k: contextlib.nullcontext()
core_api.get_request_context = lambda: True
core_api.require_roles = lambda *a, **k: True


def get_record_attachments(doctype, name, ids):
    """只回**元数据**（含 size），不碰字节 —— 跟产品的真实契约一致。
    大小给 10MiB 一个（判据原文「带 10MB 附件的信」），合计仍在 20MiB 上限内。"""
    return [{'file': fid, 'name': f'{fid}.bin', 'size': 10 * 1024 * 1024} for fid in (ids or [])]


core_api.get_record_attachments = get_record_attachments
sys.modules['shangshu_core'] = core
sys.modules['shangshu_core.public_api'] = core_api

sys.path.insert(0, str(MAIL))

account = types.ModuleType('shangshu_mail.account')
_binding = types.SimpleNamespace(binding_generation=1, display_name='我',
                                 email_address='me@qq.com')
account.get_account = lambda **k: _binding
account.credentials = lambda b: ('me@qq.com', 'pw')
# queue_send 现在要判代发权（N5-2）。本测的是**备料时机**（请求里不读字节），
# 不是权限面 —— 权限由 test-mail-n5-shared-mailbox.py 单独钉，这里放行。
account.require_right = lambda mailbox, right, user=None: None
account.account_name = lambda user=None: 'stub-personal-box'

transport = types.ModuleType('shangshu_mail.transport')
transport.MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
transport.MAX_MESSAGE_BYTES = 28 * 1024 * 1024
transport.TIMEOUT = 20
transport.smtp_session = lambda *a, **k: (_ for _ in ()).throw(_Throw('本测试不该建连'))
transport.provider_for = lambda *a, **k: {'smtp_host': 'smtp.invalid', 'imap_host': 'imap.invalid'}

domain = types.ModuleType('shangshu_mail.domain')
domain.DOMAIN = 'mail'
domain.DOCTYPE = 'Shangshu Mail Message'
sys.modules['shangshu_mail.account'] = account
sys.modules['shangshu_mail.transport'] = transport
sys.modules['shangshu_mail.domain'] = domain

DOC = types.SimpleNamespace(
    name='m-big', record_version=1, status='Draft', binding_generation=1,
    to_json='["a@b.example"]', cc_json='[]', subject='大附件', body='<p>x</p>',
    attachment_ids_json='["F1"]', inline_resources_json='[{"content_id":"c1","file":"F9"}]',
    attachment_labels_json='{}', from_address='', message_id='',
    delivery_error='', rejected_json='[]', delivery_started_at=None,
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

failures = []

# ── A/C：点发送这一趟只碰元数据，不读字节 ────────────────────────────────────
try:
    result = delivery.queue_send({'mail': 'm-big', 'expected_version': 1}, context={})
except Exception as e:
    failures.append(f'点发送就抛错：{type(e).__name__}: {e}')
    result = {}

if BYTE_READS:
    failures.append(f'A 点发送这一趟读了字节 {len(BYTE_READS)} 次：{BYTE_READS[:3]}'
                    ' —— 大附件会把请求堵死（判据：带 10MB 附件与无附件同量级）')
if result.get('status') != 'Queued':
    failures.append(f'点发送没立刻返回「已排队」，实际 {result.get("status")!r}')
if not ENQUEUED:
    failures.append('发送没排进后台 —— 备料只能在后台做')

# ── B：读字节只该发生在后台那段 ──────────────────────────────────────────────
src = (REPO / 'frappe_apps' / 'shangshu_mail' / 'shangshu_mail' / 'delivery.py').read_text(encoding='utf-8')
queue_start = src.index('def queue_send(')
queue_end = src.index('def process_send(')
request_path = src[queue_start:queue_end]
if 'get_content' in request_path:
    failures.append('B 请求路径（queue_send）里出现了 get_content —— 备料被挪回请求了')

# ── D：真实计时 —— 带 10MiB 附件与无附件同量级 ──────────────────────────────
# 判据原文：「带 10MB 附件的信，点发送到『已排队』的耗时与无附件的信同量级」。
# 做法：把取字节做成**故意昂贵**（每次真睡 15ms，模拟从存储拿大文件的 I/O）。
# 请求路径只要读字节，耗时立刻从亚毫秒升到几十毫秒；不读字节则两者都是亚毫秒。
import time

SLOW_IO['ms'] = 15
RUNS = 15


def _median_ms(ids_json):
    DOC.attachment_ids_json = ids_json
    samples = []
    for _ in range(RUNS):
        DOC.status = 'Draft'
        DOC.record_version += 1
        t0 = time.perf_counter()
        delivery.queue_send({'mail': 'm-big', 'expected_version': DOC.record_version}, context={})
        samples.append((time.perf_counter() - t0) * 1000.0)
    samples.sort()
    return samples[len(samples) // 2]


BARE_MS = _median_ms('[]')
BIG_MS = _median_ms('["F1"]')
SLOW_IO['ms'] = 0

if BYTE_READS:
    failures.append(f'D 计时过程中读了字节 {len(BYTE_READS)} 次 —— 计时结果不可信')
# 「同量级」= 不能拉开数量级。留 3 倍 + 2ms 余量（机器抖动），超出即判堵路。
if BIG_MS > BARE_MS * 3 + 2:
    failures.append(f'D 带 10MiB 附件的点发送耗时 {BIG_MS:.2f}ms，是无附件 {BARE_MS:.2f}ms 的 '
                    f'{BIG_MS / max(BARE_MS, 1e-9):.1f}× —— 附件把请求堵住了（判据要求同量级）')

if failures:
    print('FAIL —— C9 没做到：')
    for f in failures:
        print('  •', f)
    sys.exit(1)

print('PASS —— C9 成立（成因层面）：')
print('  A 点发送这一趟读字节次数 = 0（带 10MB 附件与无附件同量级的成因）')
print(f'  B 请求路径 queue_send 里没有 get_content；读字节在后台的 process_send 里')
print(f'  C 点发送仍只碰元数据（1 个 10MiB 附件 + 1 张内联图），立刻返回 {result.get("status")!r}')
print(f'  D 耗时（中位数）：无附件 {BARE_MS:.2f}ms / 带 10MiB 附件 {BIG_MS:.2f}ms'
      f'（比值 {BIG_MS / max(BARE_MS, 1e-9):.2f}×，须同量级）')
