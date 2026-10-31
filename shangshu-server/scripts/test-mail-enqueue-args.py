#!/usr/bin/env python3
"""后台发送任务的入参 —— 钉死「超时当函数参数」这个真 bug。

**怎么发现的**（不是猜的）：用户放行真网测速后实跑 S3，信**永远停在「已排队」**。
查 worker 日志抓到：

    job_name='shangshu_mail.delivery.process_send'
    kwargs={'job_timeout': 300, 'kwargs': {'name': 'dadf540r2m', 'user': '…'}}
    TypeError: process_send() got an unexpected keyword argument 'job_timeout'

**根因**：Frappe 15.118 的 `frappe.enqueue` 签名是

    def enqueue(method, queue='default', timeout=None, …, **kwargs)

超时那个参数叫 **`timeout`**，不叫 `job_timeout`。`delivery.py:50` 写的
`job_timeout=300` 落进 `**kwargs`，被当成**函数参数**传给 `process_send(name, user)`
—— 它只收 `name, user`，于是 TypeError，任务失败，信永远发不出去。

**为什么 C7 测不出来**：C7 把 `frappe.enqueue` 整个 stub 掉了，参数名写错照样绿。
这正是「桩测试不能替代真跑」的活例。

测试通过 = 下面全部成立：

  A. `queue_send` 交给 `frappe.enqueue` 的参数，按 **Frappe 自己的签名**分开后，
     超时那个值落在**选项**里（`timeout`），不落进函数参数
  B. 把剩下的函数参数展开调 `process_send(...)` **不抛 TypeError**（后台那次真能跑）
  C. 后台那次调用带的正是 `{name, user}` 两个参数（不夹带别的）
  D. 超时值确实设上了（不是靠默认值碰巧能跑）

反例（= 没改）：`timeout` 不在选项里、函数参数里出现 `job_timeout` → A 红、B 红。

跑法：
  docker exec -i shangshu-local-c-frappe-1 sh -lc \\
    'cd /home/frappe/frappe-bench && ./env/bin/python -' < scripts/test-mail-enqueue-args.py
"""
import sys
import inspect
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

from frappe.utils.background_jobs import enqueue as real_enqueue  # noqa: E402
from shangshu_mail import account as account_mod, transport  # noqa: E402
from shangshu_core.public_api import execute_registered_action  # noqa: E402

USER = 'Administrator'
ADDRESS = 'enqueue-args@speed.invalid'
PASS = []


def check(label, ok, detail=''):
    PASS.append((label, ok, detail))
    print(f"  {'✓' if ok else '✗'} {label}" + (f" —— {detail}" if detail else ''))
    return ok


def capture_enqueue_call():
    """把 `queue_send` 实际交给 frappe.enqueue 的东西抓下来，不真入队。"""
    captured = {}

    def spy(method, *args, **kwargs):
        captured['method'] = method
        captured['args'] = args
        captured['kwargs'] = kwargs
        return None

    frappe.enqueue = spy
    try:
        frappe.set_user(USER)
        execute_registered_action('mail.send',
                                  {'mail': captured_draft(), 'expected_version': 1},
                                  True, frappe.generate_hash(length=24))
    except Exception as err:
        captured['error'] = f'{type(err).__name__}: {err}'
    finally:
        frappe.enqueue = real_enqueue
        frappe.set_user(USER)
    return captured


def captured_draft():
    """建一封够发的草稿，返回它的 name。"""
    execute_registered_action('mail.account.configure', {
        'email': ADDRESS, 'provider': 'netease-enterprise', 'display_name': '入参',
        'password': 'synthetic-auth-code-not-real', 'enabled': True,
    }, True, frappe.generate_hash(length=24))
    account_mod._test = lambda *a, **k: None
    transport.send_message = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('不发信'))
    res = execute_registered_action('mail.save_draft', {
        'to': [ADDRESS], 'cc': [], 'subject': '入参测试', 'body': '正文',
        'body_format': 'Text',
    }, True, frappe.generate_hash(length=24))
    out = (res or {}).get('result') or res or {}
    name = out.get('name')
    if not name:
        rows = frappe.get_all('Shangshu Mail Message',
                              filters={'subject': '入参测试', 'owner': USER},
                              fields=['name', 'record_version'], order_by='modified desc', limit=1)
        name = rows[0]['name'] if rows else None
        frappe.db.set_value('Shangshu Mail Message', name, 'record_version', 1)
    return name


def split_like_frappe(call):
    """按 frappe.enqueue 自己的签名，把「选项」和「函数参数」分开 —— 跟 worker 同一套分法。"""
    sig = inspect.signature(real_enqueue)
    option_names = {p.name for p in sig.parameters.values()
                    if p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY)}
    takes_var_kw = any(p.kind == p.VAR_KEYWORD for p in sig.parameters.values())
    options, func_kwargs = {}, {}
    for k, v in (call.get('kwargs') or {}).items():
        if k in option_names:
            options[k] = v
        else:
            func_kwargs[k] = v
    return options, func_kwargs, takes_var_kw


def main():
    print('== 后台发送任务的入参 ==')
    print('判据：超时落在 enqueue 选项里；process_send 展开调用不抛 TypeError。')
    account_mod._test = lambda *a, **k: None
    transport.send_message = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('不发信'))

    call = capture_enqueue_call()
    if call.get('error') and not call.get('method'):
        check('取到 queue_send 的入队调用', False, call['error'])
        return

    method = call.get('method')
    options, func_kwargs, takes_var_kw = split_like_frappe(call)
    print(f"   入队方法：{getattr(method, '__name__', method)}")
    print(f"   enqueue 选项：{sorted(options)}")
    print(f"   函数参数：{sorted(func_kwargs)}")

    # A. 超时必须在选项里
    has_timeout_option = 'timeout' in options
    stray = [k for k in func_kwargs if 'timeout' in k.lower()]
    check('A1 超时值落在 enqueue 选项 `timeout` 里', has_timeout_option,
          f'选项里有：{sorted(options)}')
    check('A2 函数参数里没有夹带 timeout 类参数', not stray,
          f'夹带了：{stray}' if stray else '')

    # B. 展开调用不抛 TypeError
    callable_ok, detail = True, ''
    try:
        sig = inspect.signature(method)
        sig.bind(**func_kwargs)
    except TypeError as err:
        callable_ok, detail = False, f'展开调用会 TypeError：{err}'
    except Exception as err:
        callable_ok, detail = False, f'{type(err).__name__}: {err}'
    check('B 展开调用 process_send 不抛 TypeError', callable_ok, detail)

    # C. 只带 name / user
    keys = set(func_kwargs)
    check('C 后台调用只带 {name, user}', keys == {'name', 'user'},
          f'实际带了：{sorted(keys)}')

    # D. 超时确实设上
    to = options.get('timeout')
    check('D 超时值确实设上了（不是靠默认）', to is not None and to > 0,
          f'实际 timeout={to!r}')

    print()
    ok = sum(1 for _, passed, _ in PASS if passed)
    print(f'== {ok}/{len(PASS)} 通过 ==')
    for label, passed, detail in PASS:
        if not passed:
            print(f'  ✗ {label} {detail}')
    if ok != len(PASS):
        sys.exit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        frappe.db.rollback()
        sys.exit(1)
