"""**同一请求内**复用同一份元数据（2026-10-27 夜 · PKG-132 性能线）。

**为什么要有它**：批量写受管列时，**每一行**都要去读同一份元数据 ——
域声明清单（连 `contribution_json` 一起全扫）、动作定义、平台身份、
伴随表绑定、DocType 是否存在。

实测（真大表 15,502 行 × 57 列，包写 500 行 / 1,000 格）：
**每行 34.5 条 SQL**，其中**只有 1 条是真正的 UPDATE**，
其余全是**同一个请求里重复读同一份东西** ⇒ 白花的钱。

⚠️ **这里缓存的是什么**：全是**注册表类**事实（域声明、动作定义、身份、
伴随表绑定、DocType 是否存在）。
**业务数据、正式值、权限判定结果一律不缓存** ——
那些必须每次现读现判，否则就是拿旧值硬扛。

**作用域**：**只限当前这一次请求**。
落点用 **frappe 自己的** `frappe.local.cache`（`redis_wrapper.py` 用的就是它）：
`frappe.init()` 每次请求都会 `local.cache = {}` ⇒ 请求结束缓存自然消失，
**不会跨请求、不会跨用户**。
（**没有请求作用域时退化成「不缓存」** —— 例如裸跑脚本，照常读，只是省不下来。）

**什么时候必须清**：任何**写注册表**的地方（域注册/刷新、动作登记、绑定/解绑）
都要调 `clear()`，否则这次请求里会读到旧声明。
"""

try:  # 没有 frappe 的环境（裸跑离线判据）也能 import —— 退化成「不缓存」
    import frappe
except ImportError:  # pragma: no cover - 仅在没有 frappe 的环境里走这里
    frappe = None


# 放在 frappe 自己的本地缓存里的**独立命名空间**（不与 frappe 的键撞名）。
NAMESPACE = "shangshu_request_meta"


def _store():
    """本次请求的缓存字典；**没有请求作用域**时返回 None（⇒ 不缓存）。"""
    if frappe is None:
        return None
    try:
        cache = frappe.local.cache
    except Exception:
        return None
    if not isinstance(cache, dict):
        return None
    store = cache.get(NAMESPACE)
    if not isinstance(store, dict):
        store = {}
        cache[NAMESPACE] = store
    return store


def get(key, loader):
    """同一请求内，同一个 key **只读一次**。

    `loader` 是「真的去读」的那段（读库/读文件）。
    缓存里没有 ⇒ 调 `loader` 一次并记下；有了 ⇒ 直接给。
    """
    store = _store()
    if store is None:
        return loader()
    if key in store:
        return store[key]
    value = loader()
    store[key] = value
    return value


def clear(prefix=None):
    """清掉本次请求的缓存。

    `prefix=None` ⇒ 全清；给了 ⇒ 只清**键以此开头**的。
    **注册表被写之后必须调**：否则这次请求里会拿到旧声明。
    """
    store = _store()
    if store is None:
        return
    if prefix is None:
        store.clear()
        return
    for key in [key for key in list(store.keys()) if _matches(key, prefix)]:
        store.pop(key, None)


def _matches(key, prefix):
    """键是否属于这个前缀。

    键有两类：字符串（`"domains:rows"`）与**元组**（`("domains:doc", 名字)`）。
    元组键要看**第一段** —— `str(("domains:doc", x))` 是 `"('domains:doc', x)"`，
    用字符串前缀去比会永远不匹配（那会让「按前缀清」清不掉东西）。
    """
    if isinstance(key, tuple) and key:
        return key[0] == prefix
    return str(key).startswith(str(prefix))
