"""事务失效只允许完整回滚；普通业务/文件错误仍由原保存点处理。

仅认真实异常类型和驱动错误号，不从错误文案猜测。连接中断可能结果未知，
本模块不重连、不重试、不宣称 COMMIT 一定未发生，也不改变任何锁。
"""
import frappe

_STATE = '_shangshu_transaction_failure'
_MISSING = object()
_INVALID_CODES = frozenset({1213, 1205, 1020, 2006, 2013})


def _database():
    db = frappe.db
    resolve = getattr(db, '_get_current_object', None)
    return resolve() if callable(resolve) else db


def _invalid_error(error, *, rollback=False):
    native = tuple(cls for cls in (getattr(frappe, 'QueryDeadlockError', None),
                                  getattr(frappe, 'QueryTimeoutError', None))
                   if isinstance(cls, type))
    try:
        from pymysql.err import Error, InterfaceError
    except ImportError:  # 不使用 MariaDB 的离线检查不伪造驱动类型。
        Error = InterfaceError = ()
    pending, seen = [error], set()
    while pending:
        item = pending.pop()
        if not isinstance(item, BaseException) or id(item) in seen:
            continue
        seen.add(id(item))
        if isinstance(item, native) or isinstance(item, InterfaceError):
            return True
        if (isinstance(item, Error) and item.args and type(item.args[0]) is int
                and (item.args[0] in _INVALID_CODES or (rollback and item.args[0] == 1305))):
            return True
        pending.extend((item.__cause__, item.__context__))
    return False


def transaction_failure():
    """内部读取原始错误；状态绑定当前数据库实例，绝不跨请求/连接共享。"""
    state = getattr(_database(), _STATE, None)
    return state['error'] if state is not None else None


def assert_transaction_healthy():
    """已失效事务不得写 pending、成功日志或回执；调用方须完整回滚。"""
    error = transaction_failure()
    if error is not None:
        raise error


def mark_transaction_failed(error, *, force=False, rollback=False):
    """内部不抛出：先保留根错误，让动作边界完成文件补偿及失败描述装配。"""
    db = _database()
    state = getattr(db, _STATE, None)
    if state is not None:
        return state['error']
    if not force and not _invalid_error(error, rollback=rollback):
        return None
    state = {'error': error, 'commit': db.__dict__.get('commit', _MISSING),
             'rollback': db.__dict__.get('rollback', _MISSING)}
    original_rollback = db.rollback
    setattr(db, _STATE, state)

    def guarded_commit(*args, **kwargs):
        # Frappe commit 先清除 rollback 回调，再运行 before_commit；必须在
        # 进入原方法之前拒绝，否则父 catch+commit 会丢失工作文件恢复回调。
        raise state['error']

    def guarded_rollback(*args, **kwargs):
        try:
            result = original_rollback(*args, **kwargs)
        except BaseException:
            if not kwargs.get('save_point'):
                # 回调可能已出队；第二次 rollback 成功不证明首次漏掉的
                # 资源恢复已完成。该实例保持拒提交，交由显式恢复/弃用连接。
                state['rollback_failed'] = True
            raise
        if not kwargs.get('save_point') and not state.get('rollback_failed'):
            # 只在完整 ROLLBACK 及其全部资源恢复回调成功后清除。
            for key, wrapper in (('commit', guarded_commit), ('rollback', guarded_rollback)):
                if db.__dict__.get(key) is wrapper:
                    prior = state[key]
                    if prior is _MISSING:
                        db.__dict__.pop(key, None)
                    else:
                        setattr(db, key, prior)
            if getattr(db, _STATE, None) is state:
                delattr(db, _STATE)
        return result

    def refuse_commit():
        db.before_commit.add(refuse_commit)
        raise state['error']

    db.commit, db.rollback = guarded_commit, guarded_rollback
    db.before_commit.add(refuse_commit)
    return error


def raise_if_transaction_failed(error):
    """吞错边界的第一道检查；普通错误返回，事务失效则保留并抛出首个错误。

    完整回滚是唯一复位操作；保存点回滚、捕获异常或重复提交均不复位。
    """
    failure = mark_transaction_failed(error)
    if failure is not None:
        raise failure
