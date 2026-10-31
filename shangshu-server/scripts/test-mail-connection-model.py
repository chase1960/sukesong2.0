"""BASE967-46 / req 7 后半：SMTP 连接复用必须**跨实际 worker 模型**验证。

用户 2026-10-17 req 7 原话：
  「**连接复用必须跨实际 worker 模型验证**；若需改生命周期，另交窄设计，
   不以进程内假单例称完成。」

工作日志（`docs/worklog/2026-10-17.md` BASE967-46）已记下两个根因：
  1. `send_message` 的 `finally` **无条件** `close(connection)`，而 `smtp_session`
     把连接留在 `_SESSIONS` —— 缓存里是条**已经 QUIT 的死连接**，下次靠 NOOP 失败重连。
     **缓存不等于复用**。
  2. 实际部署是 `rq.worker.Worker`，`execute_job` **每任务 fork 一个 work horse**；
     子进程退出后模块级缓存消失。**子进程内缓存跨不了作业**。

本测试不碰网络：只替换 `transport._open_smtp`（传输边界），
在**真 fork** 与**同进程**两种模型下数「打开了几条连接 / 登录了几次」。

测试通过 = 下面全部成立：
  A. 同进程连续两次发信 → **只开 1 条连接、只登录 1 次**（进程长驻才有复用）。
  B. 发信失败 → 那条连接被逐出；下次重新开一条（不拿死连接凑复用）。
  C. fork 出来的子进程 **不继承** 父进程的 SMTP 会话（同一个 socket 被两个进程写会串话）。
  D. 两个作业各 fork 一次 → **各开各的连接**（fork-per-job 下没有跨作业复用）——
     这不是 bug，是进程模型；要真复用必须换长驻执行器（另交窄设计）。
  E. 源码层面：`send_message` 成功时不再无条件 `close`，失败时会 `drop_session`。
"""
import importlib.util
import os
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TRANSPORT = ROOT / 'frappe_apps/shangshu_mail/shangshu_mail/transport.py'


def load_transport():
    spec = importlib.util.spec_from_file_location('base967_transport_conn', TRANSPORT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeConnection:
    """假 SMTP 连接：记录状态，'关闭后再 NOOP' 要像真连接一样失败。

    长驻执行器那半（BASE967-46 2026-10-19 补）：同一条连接**同时**只能被一个作业用 ——
    SMTP 是命令流，两个线程交错写同一条 socket 会串话。假连接自己盯这件事：
    进入 send 时若这条连接已在被用，记一次「共用」；退出一条脏记录。
    """
    def __init__(self, log):
        self.log = log
        self.log['opens'] += 1
        self.closed = False
        self.in_flight = 0

    def login(self, address, password):
        self.log['logins'] += 1

    def noop(self):
        if self.closed:
            raise OSError('连接已关闭')
        self.log['noops'] += 1
        return 250, b'OK'

    def send_message(self, message, from_addr=None, to_addrs=None):
        if self.closed:
            raise OSError('连接已关闭')
        if self.in_flight:
            self.log['concurrent_same_connection'] = self.log.get('concurrent_same_connection', 0) + 1
        self.in_flight += 1
        try:
            # 让并发窗口真的存在：另一线程要能挤进来
            time.sleep(0.02)
            self.log['sends'] += 1
            return {}
        finally:
            self.in_flight -= 1

    def quit(self):
        self.closed = True

    def close(self):
        self.closed = True


def mail():
    return {'subject': '连接模型', 'body': '正文', 'body_format': 'Text',
            'to': ['to@example.invalid'], 'cc': [],
            'message_id': '<conn@example.invalid>', 'in_reply_to': ''}


class ConnectionModelTests(unittest.TestCase):
    def setUp(self):
        self.transport = load_transport()

    def _install(self):
        log = {'opens': 0, 'logins': 0, 'noops': 0, 'sends': 0}
        self.transport._open_smtp = lambda server: FakeConnection(log)
        return log

    def _send(self):
        return self.transport.send_message(
            'me@example.invalid', 'synthetic', '我', mail(), [], 'netease-enterprise',
            inline_resources=[], credential_version=1)

    def test_A_同进程连续两次只开一条连接(self):
        """测试通过 = 进程长驻时，第二次发信复用第一条连接（AUTH 只做一次）。"""
        log = self._install()
        try:
            first = self._send()
            second = self._send()
            self.assertEqual(first['status'], 'Sent')
            self.assertEqual(second['status'], 'Sent')
            self.assertEqual(log['opens'], 1, f"开了 {log['opens']} 条连接，进程内没复用")
            self.assertEqual(log['logins'], 1, f"登录了 {log['logins']} 次，复用没生效")
        finally:
            self.transport._SESSIONS.clear()

    def test_B_发信失败逐出连接下次重开(self):
        """测试通过 = 失败后不把死连接留在缓存里；下次重新开一条。"""
        log = self._install()
        try:
            first = self._send()
            self.assertEqual(first['status'], 'Sent')
            # 让缓存里那条连接变成「坏的」
            for conn in self.transport._SESSIONS.values():
                conn.closed = True
            second = self._send()
            self.assertEqual(second['status'], 'Sent', f"第二次失败：{second}")
            self.assertEqual(log['opens'], 2, '坏连接没被逐出，第二次没重开')
        finally:
            self.transport._SESSIONS.clear()

    def test_C_fork出的子进程不继承父进程会话(self):
        """测试通过 = 子进程里 `_SESSIONS` 为空（不会拿父进程的 socket 写）。"""
        sentinel = FakeConnection({'opens': 0, 'logins': 0, 'noops': 0, 'sends': 0})
        self.transport._SESSIONS[('sentinel',)] = sentinel
        read_fd, write_fd = os.pipe()
        try:
            pid = os.fork()
            if pid == 0:  # 子进程
                try:
                    os.write(write_fd, str(len(self.transport._SESSIONS)).encode())
                finally:
                    os._exit(0)
            os.close(write_fd)
            data = os.read(read_fd, 64).decode() or '?'
            os.waitpid(pid, 0)
            self.assertEqual(data, '0',
                             f'子进程继承了 {data} 条父进程 SMTP 会话 —— 同一个 socket 会被两个进程写')
        finally:
            os.close(read_fd)
            self.transport._SESSIONS.clear()

    def test_D_每作业fork一次各开各的连接(self):
        """测试通过 = 两个 fork 作业各开 1 条（fork-per-job 下没有跨作业复用）。"""
        read_fd, write_fd = os.pipe()
        try:
            for _ in range(2):
                pid = os.fork()
                if pid == 0:
                    try:
                        log = {'opens': 0, 'logins': 0, 'noops': 0, 'sends': 0}
                        self.transport._open_smtp = lambda server: FakeConnection(log)
                        self.transport.send_message(
                            'me@example.invalid', 'synthetic', '我', mail(), [],
                            'netease-enterprise', inline_resources=[], credential_version=1)
                        os.write(write_fd, str(log['opens']).encode())
                    finally:
                        os._exit(0)
                os.waitpid(pid, 0)
            os.close(write_fd)
            data = os.read(read_fd, 64).decode()
            self.assertEqual(data, '11', f'两个作业开的连接数不是各 1 条：{data}')
        finally:
            try: os.close(read_fd)
            except OSError: pass
            self.transport._SESSIONS.clear()

    def test_E_源码成功不关连接失败逐出(self):
        """测试通过 = `send_message` 的 finally 不再无条件 close；失败路径调 drop_session。

        ★ 只核**代码行**，跳过注释 —— 判据不许把自己的说明文字当证据
        （第一版就因为注释里写了 `close(connection)` 而误报）。
        """
        src = TRANSPORT.read_text(encoding='utf-8')
        body = src.split('def send_message')[1].split('class _Text')[0]
        finally_block = body.split('finally:')[-1]
        code = '\n'.join(line for line in finally_block.splitlines()
                         if not line.strip().startswith('#'))
        self.assertNotRegex(code, r'(?m)^\s*close\(connection\)\s*$',
                            'finally 还在无条件 close —— 缓存里会留下已经 QUIT 的死连接')
        self.assertIn('drop_session', code,
                      '失败时没有把坏连接逐出')
        self.assertIn('register_at_fork', src,
                      '没有 fork 钩子：子进程会继承父进程的 SMTP 会话')

    # ── 长驻执行器那半（2026-10-19 补，主控派）──────────────────────────
    # fork-per-job 之下「缓存跨不了作业」是模型决定的；换成**长驻 worker** 后
    # 作业在**同一个进程里前后跑**，复用才成立 —— 但同一进程也带来两个新风险：
    #   ① 并发作业**共用同一条连接**会串话（SMTP 是命令流）；
    #   ② 凭据在作业之间轮换时，缓存里那条旧凭据的连接不能再用。
    # 下面 F/G/H/I 分别钉这三条 + 作业边界本身。

    def _job(self, credential_version=1):
        """一个「作业」= 走真实发信入口（长驻 worker 里作业调的就是它）。"""
        return self.transport.send_message(
            'me@example.invalid', 'synthetic', '我', mail(), [], 'netease-enterprise',
            inline_resources=[], credential_version=credential_version)

    def test_F_长驻进程里两个作业前后跑只开一条连接(self):
        """测试通过 = 进程长驻、两个作业先后跑：开 1 条连接、登录 1 次、两次都成功。"""
        log = self._install()
        try:
            first, second = self._job(), self._job()
            self.assertEqual(first['status'], 'Sent', f'作业一失败：{first}')
            self.assertEqual(second['status'], 'Sent', f'作业二失败：{second}')
            self.assertEqual(log['opens'], 1,
                             f"两个作业开了 {log['opens']} 条连接 —— 长驻进程里没复用")
            self.assertEqual(log['logins'], 1,
                             f"登录了 {log['logins']} 次 —— 复用没生效")
            self.assertGreaterEqual(log['noops'], 1,
                                    '复用前没有探活（NOOP），坏连接会被当成好的用')
            self.assertEqual(len(self.transport._SESSIONS), 1,
                             f"作业边界不该堆会话：{list(self.transport._SESSIONS)}")
        finally:
            self.transport._SESSIONS.clear()

    def test_G_作业之间凭据轮换必须换连接(self):
        """测试通过 = 凭据版本变了就不能复用旧连接（否则拿旧凭据的会话发信）。"""
        log = self._install()
        try:
            self._job(credential_version=1)
            self._job(credential_version=2)
            self.assertEqual(log['opens'], 2,
                             f"凭据版本从 1 变 2 仍复用了旧连接（开了 {log['opens']} 条）")
            self.assertEqual(log['logins'], 2, '换凭据后没有重新登录')
        finally:
            self.transport._SESSIONS.clear()

    def test_H_并发两个作业不共用同一条连接(self):
        """测试通过 = 两个作业并发发信时，**没有一条连接被同时用着**（SMTP 命令流会串话）。"""
        import threading
        log = self._install()
        results = []
        try:
            def run():
                try:
                    results.append(self._job()['status'])
                except Exception as error:                      # noqa: BLE001
                    results.append(f'EXC:{error}')
            threads = [threading.Thread(target=run) for _ in range(2)]
            for t in threads: t.start()
            for t in threads: t.join()
            self.assertEqual(sorted(results), ['Sent', 'Sent'],
                             f'并发作业没都发出去：{results}')
            self.assertEqual(log.get('concurrent_same_connection', 0), 0,
                             '同一条 SMTP 连接被两个作业同时用了 —— 命令流会串话'
                             '（长驻 worker 特有：并发作业共用进程内缓存的连接）')
        finally:
            self.transport._SESSIONS.clear()

    def test_I_fork时正持锁子进程不死锁(self):
        """测试通过 = 父进程**正持锁**时 fork 出的子进程，能拿到一把没被锁死的锁。

        ⚠ 诚实口径：Python 的 `threading.Lock` 在 fork 后会被 `threading._after_fork`
        **重建**（所以今天就过）；这条钉的是**不变量** —— 哪天有人把锁换成
        multiprocessing.Lock / 自实现锁，fork 那一刻正被持有的锁会被子进程继承成
        「永远锁着」的那一份，之后这个进程里每一次发信都卡死。判据盯住不变量。
        """
        if not hasattr(self.transport, '_session_lock'):
            self.skipTest('产品还没有会话锁（长驻执行器那半未落），本条随它一起生效')
        log = self._install()
        key = self.transport._session_key(
            'me@example.invalid', 'netease-enterprise', 1,
            self.transport.provider_for('me@example.invalid', 'netease-enterprise'))
        try:
            self.transport.smtp_session('me@example.invalid', 'synthetic',
                                        'netease-enterprise', credential_version=1)
            lock = self.transport._session_lock(key)
            self.assertTrue(lock.acquire(timeout=1), '测试自己没拿到锁，后续断言无意义')
            try:
                read_fd, write_fd = os.pipe()
                try:
                    pid = os.fork()
                    if not pid:
                        got = b'0'
                        try:
                            child_lock = self.transport._session_lock(key)
                            if child_lock.acquire(timeout=2):
                                child_lock.release()
                                got = b'1'
                        except Exception:                            # noqa: BLE001
                            got = b'0'
                        try:
                            os.write(write_fd, got)
                        finally:
                            os._exit(0)
                    os.close(write_fd)
                    write_fd = None
                    answer = os.read(read_fd, 1)
                finally:
                    os.close(read_fd)
                    if write_fd is not None:
                        os.close(write_fd)
                self.assertEqual(os.waitpid(pid, 0)[1], 0, '子进程异常退出')
                self.assertEqual(answer, b'1',
                                 'fork 出的子进程拿到的是一把**锁死**的锁 —— 之后每次发信都会卡死')
            finally:
                if lock.locked():
                    lock.release()
            self.assertEqual(log.get('opens'), 1, '父进程只应开一条连接')
        finally:
            self.transport._SESSIONS.clear()


if __name__ == '__main__':
    unittest.main()
