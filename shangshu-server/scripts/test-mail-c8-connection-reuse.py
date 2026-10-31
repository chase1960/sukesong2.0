"""C8 SMTP 连接复用 —— 行为测试（隔离捕获器，不碰真实发送）。

用户 2026-10-12 报「点发送要很久」，病根之一（已查实）：
`transport.py` 的 `smtp_session()` **每次发信新开 SSL 连接 + 握手 + 登录**，
不复用 → DNS + TCP + TLS + 认证，顺利 1～3 秒，网络一抖更久。

测试通过 = 下面全部成立：
  A. 同一发件人连发 3 封，SMTP **建连 + 登录只发生 1 次**（第 2/3 封复用）
  B. 换了发件人**另建连接**——不能把别人的连接拿来发
  C. 连接不是发完就死（否则复用无从谈起）

反例（= 没做）：每发一封就新建一次 SMTP_SSL + login。

这里钉的是**契约**（调发信入口 3 次建连 1 次），不钉实现用什么函数名存连接。
"""
import sys
import types
import importlib
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MAIL = REPO / 'frappe_apps' / 'shangshu_mail'

CONNECTS = []
LOGINS = []
LIVE = []


class FakeSMTP:
    def __init__(self, host, *a, **k):
        self.host = host
        self.closed = False
        CONNECTS.append(host)
        LIVE.append(self)

    def login(self, address, password):
        LOGINS.append(address)

    def noop(self):
        if self.closed:
            raise RuntimeError('连接已关')
        return (250, b'ok')

    def sendmail(self, *a, **k):
        return {}

    def quit(self):
        self.closed = True
        if self in LIVE:
            LIVE.remove(self)

    def close(self):
        self.closed = True
        if self in LIVE:
            LIVE.remove(self)


class _Throw(Exception):
    pass


# transport 只依赖标准库的 smtplib/ssl —— 把建连换成捕获器，其余走真代码
sys.modules['smtplib'] = types.SimpleNamespace(SMTP_SSL=FakeSMTP)
sys.modules['ssl'] = types.SimpleNamespace(create_default_context=lambda: None)

sys.path.insert(0, str(MAIL))
transport = importlib.import_module('shangshu_mail.transport')

failures = []
ME, OTHER, PW = 'me@qq.com', 'other@qq.com', 'pw'


def send_once(address):
    """按产品现在的方式要一条连接并用一次。入口是 smtp_session —— 复用由它负责。"""
    conn = transport.smtp_session(address, PW)
    conn.sendmail(address, ['a@b.example'], 'Subject: x\n\nbody')
    return conn


# ── A：同一发件人连发 3 封，建连只该 1 次 ────────────────────────────────────
try:
    for _ in range(3):
        send_once(ME)
except Exception as e:
    failures.append(f'A 连发 3 封的过程抛错：{type(e).__name__}: {e}')

if len(CONNECTS) != 1:
    failures.append(f'A 连发 3 封建连了 {len(CONNECTS)} 次（应为 1 次）—— 每封都重新握手登录')
if len(LOGINS) != 1:
    failures.append(f'A 连发 3 封登录了 {len(LOGINS)} 次（应为 1 次）')

# ── B：换发件人另建连接 ──────────────────────────────────────────────────────
if not any(f.startswith('A ') for f in failures):
    try:
        send_once(OTHER)
    except Exception as e:
        failures.append(f'B 换发件人建连抛错：{type(e).__name__}: {e}')
    if len(CONNECTS) != 2:
        failures.append(f'B 换发件人后建连总数 {len(CONNECTS)}（应为 2：各建各的，不许拿别人的连接）')

# ── C：连接不是发完就死 ──────────────────────────────────────────────────────
if not any(f.startswith('A ') for f in failures):
    if not LIVE:
        failures.append('C 发完连接就没了 —— 复用无从谈起')

if failures:
    print('FAIL —— C8 没做到：')
    for f in failures:
        print('  •', f)
    print(f'  现场：建连共 {len(CONNECTS)} 次，登录共 {len(LOGINS)} 次，仍开着 {len(LIVE)} 条')
    sys.exit(1)

print('PASS —— C8 成立：')
print(f'  A 同一发件人连发 3 封 → 建连 1 次、登录 1 次（改之前是 3 次 / 3 次）')
print(f'  B 换发件人另建连接 → 建连总数 {len(CONNECTS)}（各建各的，不拿别人的连接）')
print(f'  C 发完仍开着 {len(LIVE)} 条连接可供复用')
