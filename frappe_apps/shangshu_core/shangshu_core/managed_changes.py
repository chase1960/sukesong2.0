"""**受管记录变化**的通知口（通用注册 · 不是给某个域开的专用分支）。

**为什么有这个模块**（原收敛条目 05 · 2026-10-27）：
受管记录的正式值是**唯一权威**，而它所在的那些表（Excel 晋升上来的表）还有一份
**文件投影**（xlsx 里那一格）。⇒ **正式值变了，投影必须跟着变**。

改之前：**只有文件域自己的两条写口会回填**（`cell_write`／`formal_write`）
⇒ **走核心公共动作**（`platform.object.update` —— Assistant／自动化／example 走的就是它）
写进去的正式值**不回填** ⇒ 文件与正式值**分叉**（页面读正式值、下载读文件）。
⇒ 根因是「**每个调用者都得记得补写文件**」。

改之后：**值的写入点只有一个**（`model_records.write_record`）⇒ 写入成功后
**通知一次**「这条受管记录变了」⇒ **已声明**的处理器各自负责自己那份投影。
⇒ 谁写的值不重要了；**投影义务跟着那份投影走**。

**怎么注册**（各域在自己的 `hooks.py` 里声明，**多进程安全**）：
```python
# shangshu_files/hooks.py
shangshu_managed_change_handlers = ["shangshu_files.promotion.on_managed_record_change"]
```
⇒ 内核**不认得**哪个域；它只按 hook 名单逐个调用。
**新域要用**，声明一行即可 —— **不给内核加专用分支**。

普通投影错误由本模块兜住并如实带回；投影侧保留「待恢复」，权威值可照常成功。
数据库事务级错误必须透传：死锁、锁超时、连接失效等使当前外事务必须完整回滚，
不能降为投影待恢复，也不能继续写成功回执或提交。
"""
import copy
import frappe
from shangshu_core.transaction_failure import raise_if_transaction_failed, assert_transaction_healthy

#: 各域在 `hooks.py` 里声明处理器的那个 key（**约定名**，内核不认具体域）。
HOOK_KEY = "shangshu_managed_change_handlers"

#: **批量延迟**用的标志（一次动作里写了多行 ⇒ 攒到最后通知一次 ⇒ 一次落盘）。
_BATCH_FLAG = "shangshu_managed_change_batch"
#: 攒着的变更：`{object_id: {记录名: {字段 id: 新值}}}`。
_PENDING_KEY = "shangshu_managed_change_pending"


def _handlers():
    """已声明的处理器（dotted path 清单）。"""
    try:
        return list(frappe.get_hooks(HOOK_KEY) or [])
    except Exception as error:
        raise_if_transaction_failed(error)
        return []


def in_batch():
    """当前是不是在「批量写」里（批量 ⇒ 攒到最后一次性通知）。"""
    return bool(getattr(frappe.flags, _BATCH_FLAG, None))


def defer_managed_change(*, object_id, record_name, values):
    """**攒着**一条变更（批量写里用）—— 最后由 `flush_managed_changes()` 一次通知。"""
    if not object_id or not record_name or not values:
        return
    pending = getattr(frappe.flags, _PENDING_KEY, None)
    if pending is None:
        pending = {}
        setattr(frappe.flags, _PENDING_KEY, pending)
    records = pending.setdefault(str(object_id), {})
    entry = records.setdefault(str(record_name), {})
    for field, value in (values or {}).items():
        entry[str(field)] = value


def flush_managed_changes(source=""):
    """把攒着的变更**一次**通知出去（批量写的末尾调）。

    ⇒ 一次通知里带**所有行** ⇒ 处理器可以**一次落盘**（不许逐行落盘）。
    """
    pending = getattr(frappe.flags, _PENDING_KEY, None)
    setattr(frappe.flags, _PENDING_KEY, None)
    if not pending:
        return {"handlers": 0, "results": []}
    results = []
    for object_id, records in pending.items():
        results.append(_notify(object_id=object_id, records=records, source=source))
    return {"handlers": sum(int(r.get("handlers") or 0) for r in results), "results": results}


def notify_managed_change(*, object_id, records, source=""):
    """通知「这些受管记录变了」（载荷：`{object_id, records: {记录名: {字段: 新值}}, source}`）。

    普通投影错误在这里如实带回，由投影侧标「待恢复」，权威值可照常成功。
    数据库事务级错误必须透传，并要求整个外事务完整回滚。
    """
    if not object_id or not records:
        return {"handlers": 0, "results": []}
    return _notify(object_id=object_id, records=records, source=source)


def _notify(*, object_id, records, source=""):
    assert_transaction_healthy()
    payload = {"object_id": str(object_id), "records": dict(records or {}), "source": source}
    results = []
    for path in _handlers():
        try:
            handler = frappe.get_attr(path)
        except Exception as error:
            raise_if_transaction_failed(error)
            results.append({"handler": path, "error": "处理器取不到：%s" % str(error)[:200]})
            continue
        try:
            results.append({"handler": path, "result": handler(payload)})
        except Exception as error:
            raise_if_transaction_failed(error)
            # 仅普通投影错误可转成结果；上面的守卫会透传数据库事务级错误。
            results.append({"handler": path, "error": str(error)[:300]})
    assert_transaction_healthy()
    return {"handlers": len(results), "results": results}


class batch(object):
    """**批量写**上下文：期间的逐条变更**攒着**，退出时**一次**通知。

    ```python
    with managed_changes.batch():
        for row in rows:
            ...写...
    ```
    ⇒ 一次落盘（而不是每行一次）。
    """

    def __init__(self, source=""):
        self.source = source
        self._previous = None
        self._pending_before = None
        #: 批末那次通知的结果（调用方要拿它回执里说清「投影成没成」）。
        self.result = {"handlers": 0, "results": []}

    def __enter__(self):
        self._previous = in_batch()
        # 子动作可能失败后由外层捕获；恢复它进入前的待通知值，既不丢外层
        # 已有变更，也不让已回滚的子动作值在外层退出时发送。
        if self._previous:
            self._pending_before = copy.deepcopy(getattr(frappe.flags, _PENDING_KEY, None))
        setattr(frappe.flags, _BATCH_FLAG, True)
        return self

    def __exit__(self, exc_type, exc, tb):
        setattr(frappe.flags, _BATCH_FLAG, self._previous)
        if exc_type is not None:
            setattr(frappe.flags, _PENDING_KEY, self._pending_before if self._previous else None)
        elif not self._previous:
            # 嵌套层只积累；由最外层拥有发送时点、source 与完整回执。
            self.result = flush_managed_changes(source=self.source)
        return False
