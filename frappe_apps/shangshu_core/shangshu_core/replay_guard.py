"""同键重放守卫的调用约定（公共钩）。

守卫签名统一为 `guard(payload, request)`；只接一个参数的守卫继续可用
（shangshu_files 的格值守卫就是单参）。多给一个 request 是为了**新建类**动作：
载荷里还没有对象编号（对象是这次才建出来的），守卫要从请求缓存的结果里认出
刚建的那个，才能复核「现在还归不归你」。

单独成模块是为了能脱离 frappe 运行时直接测这条派发约定本身——判据见
`shangshu-server/scripts/tests/test_guard_dispatch.py`。
"""


def invoke_replay_guard(fn, payload, request):
    """按守卫的参数个数决定传不传 request；单参照常，双参多给 request。

    `inspect.signature` 拿不到签名时（C 扩展 / builtin）退回单参调用，不炸。
    守卫抛出的异常原样上抛——吞掉就等于撤权后旧回执还能换出带值结果。
    """
    import inspect as _inspect
    try:
        wants_request = len(_inspect.signature(fn).parameters) > 1
    except (TypeError, ValueError):
        wants_request = False
    return fn(payload, request) if wants_request else fn(payload)
