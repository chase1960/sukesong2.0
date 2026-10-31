"""C8 SMTP 连接复用的**隔离键** —— 行为测试（隔离捕获器，不碰真实发送）。

用户 2026-10-12 补充要求：
  「SMTP 连接复用必须按**邮箱、凭据版本和安全配置**隔离，不能因同部门而共用连接身份。」

现状（查实 transport.py:51-78）：`_SESSIONS` 的键是 `(address, provider)` ——
  只认邮箱和服务商名。**改密之后旧连接还在池子里**，继续用旧口令登录的那条身份发信；
  安全配置（主机/端口/加密方式）变了也照样复用。这两条都对不上用户的要求。

前一份 test-mail-c8-connection-reuse.py 钉的是「第二次/第三次比第一次快、不重复握手」；
这一份钉的是**隔离**：什么情况下**不许**复用。

测试通过 = 下面全部成立：

  S1 同一邮箱 + 同一凭据版本 + 同一安全配置 → **复用**（发 2 封只握手 1 次）
  S2 同一邮箱、**凭据版本变了**（改密/换授权）→ **不复用**（握手 2 次）
  S3 同一邮箱、**安全配置变了**（换主机/端口/加密方式）→ **不复用**
  S4 **不同邮箱** → 各自一条连接，互不借用
  S5 发信失败后连接被丢掉，下次**重连**（不拿一条死连接接着发）
  S6 **同部门两个邮箱不共用连接身份** —— 部门相同不是复用理由

反例（= 没做）：改密后继续拿旧连接发；按部门/共用账号合并连接；发信失败仍复用死连接。
"""
import sys
import types
import importlib
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MAIL = REPO / 'frappe_apps' / 'shangshu_mail'

CONNECTS = []          # 每次真握手登录记一笔
FAILURES = []


def check(ok, msg):
    if not ok:
        FAILURES.append(msg)


class FakeSMTP:
    """隔离捕获器：谁握手/登录/发信都记一笔。alive=False 时探活失败。"""

    def __init__(self, host, port, **k):
        self.host = host
        self.port = port
        self.alive = True
        self.logged_in_as = None
        CONNECTS.append(self)

    def noop(self):
        if not self.alive:
            raise RuntimeError('连接已死')
        return (220, b'ok')

    def login(self, address, password):
        self.logged_in_as = (address, password)

    def sendmail(self, *a, **k):
        return {}

    def close(self):
        self.alive = False

    def quit(self):
        self.alive = False


# ── 可控的服务商配置：S3 要能改「安全配置」──────────────────────────────────
SECURITY = {'smtp_host': 'smtp.a.invalid', 'smtp_port': 465, 'security': 'SSL'}


def provider_for(address, provider=None):
    return dict(SECURITY)


sys.path.insert(0, str(MAIL))

transport = importlib.import_module('shangshu_mail.transport')
# 用捕获器替换 smtplib 与服务商解析，其余照用产品实现
transport.smtplib.SMTP_SSL = FakeSMTP
transport.provider_for = provider_for
transport.TIMEOUT = 5


def reset(new_security=None):
    """开一个新场景：清空连接池和捕获器，必要时换一套安全配置。"""
    if new_security:
        SECURITY.update(new_security)
    CONNECTS.clear()
    transport._SESSIONS.clear()


def change_security(new_security):
    """只换安全配置，**不清连接池** —— 这才是 S3 要测的场景：
    池子里躺着旧安全域的连接，配置变了之后不许再拿它发信。"""
    SECURITY.update(new_security)


def sends(n, address, password, credential_version, provider='smtp'):
    """连续发 n 封，返回真握手次数。"""
    for _ in range(n):
        try:
            smtp = transport.smtp_session(address, password, provider,
                                          credential_version=credential_version)
            smtp.sendmail(address, ['x@y.example'], b'x')
        except Exception as e:
            FAILURES.append(f'发信意外失败（{type(e).__name__}）：{e}')
            break
    return len(CONNECTS)


# ── S1：同邮箱 + 同凭据版本 + 同安全配置 → 复用 ─────────────────────────────
reset()
n = sends(3, 'me@a.example', 'pw-1', credential_version=1)
check(n == 1, f'S1 同一身份连发 3 封握手了 {n} 次（必须 1 —— 连接该复用）')

# ── S2：凭据版本变了（改密）→ 不复用 ────────────────────────────────────────
reset()
sends(1, 'me@a.example', 'pw-1', credential_version=1)
n = sends(1, 'me@a.example', 'pw-2', credential_version=2)
check(n == 2, f'S2 改密后又握手了 {n - 1} 次（必须 1 次）—— 旧口令的连接被当成同一条用了')
# 且新连接登的是**新**口令
if CONNECTS:
    check(CONNECTS[-1].logged_in_as == ('me@a.example', 'pw-2'),
          f"S2 新连接登的不是新口令：{CONNECTS[-1].logged_in_as}")
else:
    check(False, 'S2 没有任何连接建立（smtp_session 调用失败）')

# ── S3：安全配置变了 → 不复用 ───────────────────────────────────────────────
reset({'smtp_host': 'smtp.a.invalid', 'smtp_port': 465, 'security': 'SSL'})
sends(1, 'me@a.example', 'pw-1', credential_version=1)
n = sends(1, 'me@a.example', 'pw-1', credential_version=1)   # 同版本 → 该复用
check(n == 1, f'S3 安全配置没变却握手了 {n} 次（必须 1）')

reset({'smtp_host': 'smtp.a.invalid', 'smtp_port': 465, 'security': 'SSL'})
sends(1, 'me@a.example', 'pw-1', credential_version=1)     # 池子里留下一条
change_security({'smtp_host': 'smtp.b.invalid', 'smtp_port': 465, 'security': 'SSL'})  # 换主机，不清池
n = sends(1, 'me@a.example', 'pw-1', credential_version=1)
check(n == 2, f'S3 安全配置（主机）变了仍复用旧连接（握手 {n} 次，必须 2）')

reset({'smtp_host': 'smtp.a.invalid', 'smtp_port': 465, 'security': 'SSL'})
sends(1, 'me@a.example', 'pw-1', credential_version=1)
change_security({'smtp_host': 'smtp.a.invalid', 'smtp_port': 587, 'security': 'STARTTLS'})  # 换端口+加密
n = sends(1, 'me@a.example', 'pw-1', credential_version=1)
check(n == 2, f'S3 安全配置（端口/加密）变了仍复用旧连接（握手 {n} 次，必须 2）')

# ── S4：不同邮箱 → 各自一条 ─────────────────────────────────────────────────
reset({'smtp_host': 'smtp.a.invalid', 'smtp_port': 465, 'security': 'SSL'})
sends(1, 'me@a.example', 'pw-1', credential_version=1)
sends(1, 'you@a.example', 'pw-9', credential_version=1)
check(len(CONNECTS) == 2, f'S4 两个邮箱只握手 {len(CONNECTS)} 次（必须 2）')
if len(CONNECTS) >= 2:
    check(CONNECTS[0].logged_in_as[0] != CONNECTS[1].logged_in_as[0],
          'S4 两个邮箱的连接登成了同一个身份')

# ── S5：发信失败丢连接，下次重连 ────────────────────────────────────────────
reset()
smtp = transport.smtp_session('me@a.example', 'pw-1', 'smtp', credential_version=1)
smtp.sendmail('me@a.example', ['x@y.example'], b'x')
check(len(CONNECTS) == 1, f'S5 前置握手次数不对：{len(CONNECTS)}')
transport.drop_session('me@a.example', 'smtp', credential_version=1)
smtp2 = transport.smtp_session('me@a.example', 'pw-1', 'smtp', credential_version=1)
check(len(CONNECTS) == 2,
      f'S5 丢掉连接后没重连（握手 {len(CONNECTS)} 次，必须 2）—— 会拿一条死连接接着发')

# 探活失败也必须换新连接
reset()
dead = transport.smtp_session('me@a.example', 'pw-1', 'smtp', credential_version=1)
dead.alive = False
alive = transport.smtp_session('me@a.example', 'pw-1', 'smtp', credential_version=1)
check(len(CONNECTS) == 2,
      f'S5 死连接探活失败后仍被复用（握手 {len(CONNECTS)} 次，必须 2）')
check(alive is not dead, 'S5 返回了那条死连接')

# ── S6：同部门两个邮箱不共用连接身份 ────────────────────────────────────────
# 「同部门」不是复用理由 —— 复用只看身份三要素（邮箱/凭据版本/安全配置）。
# 这里两个邮箱属于同一部门（同一个 provider、同一套安全配置），仍然各自一条。
reset()
sends(1, 'dept-shared@a.example', 'pw-1', credential_version=1)
sends(1, 'dept-colleague@a.example', 'pw-1', credential_version=1)
check(len(CONNECTS) == 2,
      f'S6 同部门两个邮箱共用了连接（握手 {len(CONNECTS)} 次，必须 2）')
if len(CONNECTS) >= 2:
    check(CONNECTS[0].logged_in_as[0] != CONNECTS[1].logged_in_as[0],
          'S6 同部门两个邮箱登成了同一个身份 —— 共用账号是被禁止的')

# ── 结果 ───────────────────────────────────────────────────────────────────
if FAILURES:
    print('FAIL —— C8 连接隔离没做到：')
    for f in FAILURES:
        print('  •', f)
    sys.exit(1)

print('PASS —— C8 连接隔离成立：')
print('  S1 同邮箱+同凭据版本+同安全配置 → 复用（3 封 1 次握手）')
print('  S2 改密（凭据版本变）→ 不复用，且新连接登新口令')
print('  S3 安全配置（主机 / 端口+加密）变了 → 不复用')
print('  S4 不同邮箱 → 各自一条连接')
print('  S5 丢连接 / 探活失败 → 重连，不拿死连接')
print('  S6 同部门两个邮箱不共用连接身份')
