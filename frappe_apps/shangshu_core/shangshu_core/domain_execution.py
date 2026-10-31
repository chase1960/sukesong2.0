"""业务域唯一执行边界；锁由外层请求/任务事务释放，不在退出时提交。"""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
from inspect import signature

import frappe


# —— 内核「独立迁移」窗口：域围栏里**唯一**能提交的那一小段 ——
#
# 为什么要有它（2026-10-26 内核缺陷修复）：
#   受管对象的物理表由 `model_changes.execute_object_change` 建立 —— 那是 **DDL**
#   （**MariaDB 的 DDL 会隐式提交**），混在动作事务里会毁掉回滚点；
#   但围栏里**不许自行提交**（下面那道守卫）⇒ 晋升这条链（域动作 → 内核
#   `promotion_records`）以前**必红**。
#   ⇒ 这里开一个**受控窗口**：窗内放行这次提交，**出窗立刻把屏障挂回去**。
#
# ⚠️ **窗口是内核内部的**：不在 `public_api` 里、也不对外暴露成上下文管理器
#    ⇒ 域拿不到它 ⇒ 域不能靠它间接提交自己的写。
#
# ⚠️ **放行范围＝当前这一段，不许是整个进程**（审查报告 R02 · PKG-128-T03）：
#   这里以前用**模块全局变量** `_MIGRATION_WINDOW_DEPTH` 记深度
#   ⇒ 线程 A 开着窗口时，**线程 B 的提交守卫也看到「窗口开着」**
#   ⇒ **B 在领域围栏里的自行提交被放行** ⇒ 领域边界形同虚设。
#   ⇒ 现在改用 **`ContextVar`**（作用域局部状态，线程与协程各一份）
#      —— 这正是内核 `action_provenance.py` 已在用的那套做法
#      （`_node` / `_request` 两个 ContextVar ＋ set/reset）。
#   **为什么不用 `frappe.flags`**：它跟域执行深度（`shangshu_domain_execution_depth`）
#   用的是同一个载体，但**迁移窗口要的是「这一段代码」，不是「这个请求」** ——
#   同一个请求里两个独立调用各自开窗时，其中一个的窗口不该影响另一个。
_MIGRATION_WINDOW_DEPTH = ContextVar('shangshu_migration_window_depth', default=0)


def migration_window_open():
    """独立迁移窗口开着吗？（守卫靠它判断这次提交放不放行）"""
    return _MIGRATION_WINDOW_DEPTH.get() > 0


def _assert_outer_commit():
    if getattr(frappe.flags, 'shangshu_domain_execution_depth', 0):
        if not migration_window_open():
            # CallbackManager 调用前会出队；捕获异常重试也不能释放域屏障。
            frappe.db.before_commit.add(_assert_outer_commit)
            frappe.throw('领域执行器不得自行提交事务', frappe.ValidationError)
        # 窗口开着（内核的独立迁移）⇒ 这次提交**放行**。
        # ⚠️ **这里不重挂**：在回调里重挂 ⇒ CallbackManager 会立刻把它再取出来
        #    调用 ⇒ 死循环。重挂由 `independent_migration_window` 的 finally 做
        #    （出窗时挂回去 ⇒ 域的提交闸只在那扇窗里开过）。

@contextmanager
def independent_migration_window():
    """内核独立迁移的**受控提交窗口**（只有 DDL 迁移那一小段用）。

    出窗时**必须把屏障挂回去**：`before_commit` 的回调在提交时可能被
    CallbackManager 出队（`domain_execution` 里那道自重挂就是防这个）
    ⇒ 不重挂 ⇒ 域的提交闸就没了（域就能自己提交了）。

    ⚠️ **别把它当「域可以提交」的牌**：它只给内核的独立迁移口用，
    不进 `public_api`、也不许域直接调。

    ⚠️ **放行范围＝当前这一段**（审查报告 R02 · PKG-128-T03）：
      深度记在 **ContextVar** 里（作用域局部）⇒
      **别的请求/别的执行流看不到这个窗口** ⇒ 它们的提交守卫照旧拦。
      以前记在模块全局变量里 ⇒ 线程 A 一开窗，线程 B 的围栏就被连带放行。
    """
    from shangshu_core.action_packages import reject_migration
    reject_migration()
    token = _MIGRATION_WINDOW_DEPTH.set(_MIGRATION_WINDOW_DEPTH.get() + 1)
    try:
        yield
    finally:
        _MIGRATION_WINDOW_DEPTH.reset(token)
        frappe.db.before_commit.add(_assert_outer_commit)


@contextmanager
def domain_execution(domain_id, allow_disabled=False):
    """进入可信域执行；allow_disabled 仅兼容旧续办，不绕过完全停用或权限。"""
    from shangshu_core.lifecycle import assert_declared_call

    assert_declared_call(domain_id)
    if domain_id != 'com.shangshu.core':
        # 锁定读获取最新状态，不能用事务快照/缓存作启停判断。
        rows = frappe.db.sql(
            'SELECT enabled, execution_stopped, health_status FROM `tabShangshu Domain` '
            'WHERE name=%s LOCK IN SHARE MODE', (domain_id,), as_dict=True,
        )
        if not rows:
            frappe.throw('领域未注册', frappe.DoesNotExistError)
        row = rows[0]
        if row['execution_stopped'] or (not row['enabled'] and not allow_disabled):
            frappe.throw('该领域已停止执行', frappe.PermissionError)
        if row['health_status'] == 'unavailable':
            frappe.throw('该领域当前不可用', frappe.ValidationError)
    previous = getattr(frappe.flags, 'shangshu_call_domain', None)
    depth = getattr(frappe.flags, 'shangshu_domain_execution_depth', 0) or 0
    frappe.flags.shangshu_call_domain = domain_id
    frappe.flags.shangshu_domain_execution_depth = depth + 1
    frappe.db.before_commit.add(_assert_outer_commit)
    try:
        yield
    finally:
        frappe.flags.shangshu_call_domain = previous
        frappe.flags.shangshu_domain_execution_depth = depth


def resource_execution(section, parameter):
    """公共入口按已注册资源归属复用边界；未注册项仍由原入口报错。"""
    def decorate(function):
        parameters = signature(function)

        @wraps(function)
        def execute(*args, **kwargs):
            from shangshu_core.domains import raw_resource
            bound = parameters.bind(*args, **kwargs)
            domain, _ = raw_resource(section, bound.arguments[parameter])
            if not domain:
                return function(*args, **kwargs)
            with domain_execution(domain['id']):
                return function(*args, **kwargs)
        return execute
    return decorate


def instance_execution(parameter, execution=False):
    """存量流程从实例定义解析归属；允许旧续办，但不允许完全停用域执行。"""
    def decorate(function):
        parameters = signature(function)

        @wraps(function)
        def execute(*args, **kwargs):
            from shangshu_core.domains import raw_resource
            name = parameters.bind(*args, **kwargs).arguments[parameter]
            if execution:
                name = frappe.db.get_value('Shangshu Node Execution', name, 'process_instance')
            definition = frappe.db.get_value('Shangshu Process Instance', name, 'definition_id') if name else None
            domain, _ = raw_resource('processes', definition) if definition else (None, None)
            if not domain:
                return function(*args, **kwargs)
            with domain_execution(domain['id'], allow_disabled=True):
                return function(*args, **kwargs)
        return execute
    return decorate
