"""重放守卫派发（公共钩）的判据。

**测试通过 = 下面每条都成立**：

RG-01 单参守卫照常可用：守卫只接一个参数时，同键重放以 `fn(payload)` 调它，
  拿到的就是本次重放载荷，不因参数个数报错。
RG-02 双参守卫拿得到请求：守卫接两个参数时，以 `fn(payload, request)` 调它，
  拿到的 request 就是调用方传进来的那一个对象（同引用）——新建类动作的守卫
  要从这份请求缓存里认出「这次才建出来的那个」，才能复核「现在还归不归你」。
RG-03 取不到签名时退回单参：守卫是 C 扩展/builtin、`inspect.signature` 拿不到
  签名时，退回 `fn(payload)` 单参调用，不炸。
RG-04 守卫的拒绝要挡住重放：守卫抛出的异常原样上抛，不被吞掉——吞掉就等于
  撤权后旧回执还能换出带值结果。
RG-05 带默认值的双参守卫按双参调：`def guard(payload, request=None)` 参数个数
  是 2，走双参调用（不是把 request 丢掉）。

为什么要它：守卫签名统一成 `guard(payload, request)` 是为**新建类**动作准备的
——载荷里还没有对象编号（对象是这次才建出来的），守卫得从请求缓存里认出来。
但 shangshu_files 的格值守卫是单参的，一刀切改签名会把它弄坏。这条测试钉住
「双参可用 + 单参不坏」两个方向，谁动派发谁先红。

先红后绿：`shangshu_core/replay_guard.py` 尚不存在时应红（import 失败），
不许先实现再补测。
"""
import importlib.util
import os
import sys
import traceback

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
MOD_PATH = os.path.join(ROOT, 'frappe_apps', 'shangshu_core', 'shangshu_core', 'replay_guard.py')

checks_run = 0
failed = []


def check(label, ok, detail=''):
    global checks_run
    checks_run += 1
    print('  %s %s%s' % ('✓' if ok else '✗', label, ('　—　' + str(detail)) if detail else ''))
    if not ok:
        failed.append(label)


def load():
    spec = importlib.util.spec_from_file_location('shangshu_replay_guard', MOD_PATH)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


print('== 重放守卫派发 ==')
print('模块：%s' % MOD_PATH)

try:
    rg = load()
except Exception as e:
    print('  ✗ 模块加载失败：%s' % e)
    traceback.print_exc()
    print('结果： FAIL 重放守卫派发（模块不存在或加载不了，先红后绿应当如此）')
    sys.exit(1)

invoke = getattr(rg, 'invoke_replay_guard', None)
check('公共钩导出 invoke_replay_guard', callable(invoke), '拿到 %r' % (invoke,))
if not callable(invoke):
    print('结果： FAIL 重放守卫派发')
    sys.exit(1)

# ---------- RG-01 单参守卫照常可用 ----------
print('\n== RG-01 单参守卫照常可用 ==')
seen = {}


def one_arg(payload):
    seen['one'] = payload
    return 'one-ret'


payload_obj = {'table': 't-1', 'cells': [{'row_id': 'r-000001'}]}
request_obj = {'id': 'req-1', 'result': {'file': 't-1'}}
try:
    invoke(one_arg, payload_obj, request_obj)
    check('RG-01 单参守卫被调用且不炸', True)
except Exception as e:
    check('RG-01 单参守卫被调用且不炸', False, '抛了 %r' % (e,))
check('RG-01 拿到的就是重放载荷', seen.get('one') is payload_obj,
      '拿到 %r' % (seen.get('one'),))

# ---------- RG-02 双参守卫拿得到请求 ----------
print('\n== RG-02 双参守卫拿得到请求 ==')


def two_arg(payload, request):
    seen['two'] = (payload, request)
    return 'two-ret'


try:
    invoke(two_arg, payload_obj, request_obj)
    check('RG-02 双参守卫被调用且不炸', True)
except Exception as e:
    check('RG-02 双参守卫被调用且不炸', False, '抛了 %r' % (e,))
got_p, got_r = seen.get('two', (None, None))
check('RG-02 第一参是重放载荷（同引用）', got_p is payload_obj, '拿到 %r' % (got_p,))
check('RG-02 第二参是请求缓存（同引用）', got_r is request_obj, '拿到 %r' % (got_r,))

# ---------- RG-03 取不到签名时退回单参 ----------
print('\n== RG-03 取不到签名时退回单参 ==')


class Builtinish(object):
    """签名拿不到的可调用对象（C 扩展/builtin 的情形）。"""
    def __call__(self, payload):
        seen['builtinish'] = payload
        return 'ok'


# 让 inspect.signature 抛 ValueError，直接钉住「取不到签名」这条分支本身，
# 不靠某台机器上 builtin 能不能被造出签名。
import inspect as _real_inspect  # noqa: E402

_orig_signature = _real_inspect.signature


def _boom(fn, **kw):
    raise ValueError('no signature for %r' % (fn,))


_real_inspect.signature = _boom
try:
    seen.pop('builtinish', None)
    try:
        invoke(Builtinish(), payload_obj, request_obj)
        check('RG-03 signature 抛错时退回单参不炸', True)
    except Exception as e:
        check('RG-03 signature 抛错时退回单参不炸', False, '抛了 %r' % (e,))
    check('RG-03 退回后按单参调用（拿到的是载荷，不是 request）',
          seen.get('builtinish') is payload_obj, '拿到 %r' % (seen.get('builtinish'),))
finally:
    _real_inspect.signature = _orig_signature

# ---------- RG-04 守卫的拒绝要挡住重放 ----------
print('\n== RG-04 守卫的拒绝要挡住重放 ==')


class Denied(Exception):
    pass


def deny_one(payload):
    raise Denied('撤权后旧回执不能换出值')


def deny_two(payload, request):
    raise Denied('撤权后旧回执不能换出值（双参）')


try:
    invoke(deny_one, payload_obj, request_obj)
    check('RG-04 单参守卫抛的异常原样上抛', False, '没抛，重放被放过去了')
except Denied as e:
    check('RG-04 单参守卫抛的异常原样上抛', True, '异常：%s' % e)
except Exception as e:
    check('RG-04 单参守卫抛的异常原样上抛', False, '被换成了 %r' % (e,))

try:
    invoke(deny_two, payload_obj, request_obj)
    check('RG-04 双参守卫抛的异常原样上抛', False, '没抛，重放被放过去了')
except Denied as e:
    check('RG-04 双参守卫抛的异常原样上抛', True, '异常：%s' % e)
except Exception as e:
    check('RG-04 双参守卫抛的异常原样上抛', False, '被换成了 %r' % (e,))

# ---------- RG-05 带默认值的双参守卫按双参调 ----------
print('\n== RG-05 带默认值的双参守卫按双参调 ==')


def two_with_default(payload, request=None):
    seen['def2'] = (payload, request)


try:
    invoke(two_with_default, payload_obj, request_obj)
    check('RG-05 带默认值的双参守卫不炸', True)
except Exception as e:
    check('RG-05 带默认值的双参守卫不炸', False, '抛了 %r' % (e,))
got_p, got_r = seen.get('def2', (None, None))
check('RG-05 request 被真正传进去（不是吃到默认值 None）', got_r is request_obj,
      '拿到 %r' % (got_r,))
check('RG-05 payload 同引用', got_p is payload_obj, '拿到 %r' % (got_p,))

print('')
if checks_run == 0:
    print('结果： FAIL 零条检查被断言（阶段空转不许判通过）')
    sys.exit(1)
if failed:
    print('结果： FAIL 重放守卫派发（%d/%d 条不成立：%s）' % (len(failed), checks_run, '；'.join(failed)))
    sys.exit(1)
print('结果： PASS 重放守卫派发全部成立（%d 条）' % checks_run)
