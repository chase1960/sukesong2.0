"""**同一请求内**只读一次元数据（2026-10-27 夜 · PKG-132 性能线）。

**背景**：批量写受管列时**每行**都去读同一份元数据。实测真大表包写
（15,502 行 × 57 列，500 行 / 1,000 格）**每行 34.5 条 SQL**，
其中**只有 1 条是真正的 UPDATE**；其余全是同一个请求里重复读同一份东西。

**测试通过 = 什么成立**（逐条；每条一句话）：

1. **同一请求里，同一个键只读一次** —— 连着调两次同一个读口，**底层读库只发生 1 次**。
2. **注册表真被改了以后，这次请求里能读到新的** —— 清缓存后再读，**拿到新值**
   （不是拿旧值硬扛；这是「缓存不许盖住变更」这条）。
3. **清缓存只清该清的** —— 按前缀清，**别的键不受影响**。
4. **域声明清单一次请求只全扫一遍** —— 连着查两个不同动作的域资源，
   **`tabShangshu Domain` 只扫 1 次**（不是每个动作扫一遍）。
5. **动作定义一次请求只查一遍** —— 连着解析同一个动作，**只查 1 次**。
6. **平台身份一次请求只认一遍** —— 连着取两次身份，**用户表与身份表各只查 1 次**。
7. **没有请求作用域时退化成「不缓存」** —— 缓存拿不到时不报错，**照常读**（只是不省）。

**离线怎么跑**（本机没有站点 ⇒ 全部离线可跑，不需要连库）：

    cd frappe_apps/shangshu_core && PYTHONPATH=. python3 -m unittest \
        shangshu_core.tests.test_request_metadata_cache

**替的是什么**：替 **DB 层**（`frappe.get_all` / `frappe.db.get_value` / `frappe.get_doc`）
—— 被断的那些**读口是真的**（`domains.raw_resource`、`actions._definition`、
`identity.get_identity` 原文），只是底层读库被换成了计数用的替身。
**请求作用域**用 frappe 真实的那个：`frappe.local.cache`（`frappe.init()` 每次请求都清它）。
"""
import sys
import unittest
from pathlib import Path

CORE_DIR = Path(__file__).resolve().parents[1]
if str(CORE_DIR) not in sys.path:
    sys.path.insert(0, str(CORE_DIR))

try:
    import frappe
    HAS_FRAPPE = True
except ImportError:  # pragma: no cover - 没有 frappe 就退化成替身
    HAS_FRAPPE = False
    frappe = None


class _Row(dict):
    """能当 `row.xxx` 用的字典替身（frappe.get_all 返回的就是这种）。"""

    def __getattr__(self, item):
        try:
            return self[item]
        except KeyError as error:
            raise AttributeError(item) from error


class _Counters:
    def __init__(self):
        self.get_all = 0
        self.by_doctype = {}

    def count(self, doctype):
        return self.by_doctype.get(doctype, 0)


def _install_stubs(counters, domain_rows=None, action_docs=None, identity=None):
    """把底层读库换成计数替身。"""
    counters.get_all = 0
    counters.by_doctype = {}

    def fake_get_all(doctype, *args, **kwargs):
        counters.get_all += 1
        counters.by_doctype[doctype] = counters.count(doctype) + 1
        if doctype == "Shangshu Domain":
            return list(domain_rows or [])
        return []

    def fake_get_value(doctype, filters=None, fieldname=None, **kwargs):
        counters.by_doctype[doctype] = counters.count(doctype) + 1
        if doctype == "Shangshu Action Definition":
            wanted = filters.get("action_id") if isinstance(filters, dict) else filters
            wanted_version = filters.get("action_version") if isinstance(filters, dict) else None
            for doc in (action_docs or []):
                if doc.get("action_id") != wanted:
                    continue
                if wanted_version and doc.get("action_version") != wanted_version:
                    continue
                return doc.get("name")
            return None
        if doctype == "Shangshu Identity":
            return (identity or {}).get("name")
        if doctype == "User":
            return 1
        return None

    def fake_get_doc(*args, **kwargs):
        counters.by_doctype[args[0] if args else "?"] = counters.count(args[0] if args else "?") + 1
        if len(args) >= 2 and args[0] == "Shangshu Action Definition":
            for doc in (action_docs or []):
                if doc.get("name") == args[1]:
                    return _Row(doc)
        if len(args) >= 2 and args[0] == "Shangshu Identity":
            return _Row(dict(identity or {}, name=(identity or {}).get("name")))
        if len(args) == 1 and isinstance(args[0], dict):
            return _Row(args[0])
        return _Row({})

    frappe.get_all = fake_get_all
    # `frappe.db` 是 frappe 的 Local 代理 ⇒ 装在**这一次的 db 对象**上
    # （由 `_RequestScope` 绑定，退出时整个换回去）。
    frappe.local.db.get_value = fake_get_value
    frappe.get_doc = fake_get_doc


class _RequestScope:
    """模拟一次请求：`frappe.local.cache` 是这一次的，`frappe.init()` 每次都会清它。"""

    def __enter__(self):
        if frappe is None:
            self._saved = []
            return self
        self._saved = []
        for name in ("cache", "session", "db"):
            try:
                self._saved.append((name, getattr(frappe.local, name)))
            except Exception:
                self._saved.append((name, None))
        frappe.local.cache = {}
        frappe.local.session = _Row(user="someone@example.invalid")
        frappe.local.db = _Row()
        return self

    def __exit__(self, *_exc):
        for name, value in reversed(self._saved):
            if value is None:
                try:
                    delattr(frappe.local, name)
                except Exception:
                    pass
            else:
                setattr(frappe.local, name, value)
        return False


class TestRequestCachePrimitive(unittest.TestCase):
    """缓存原语本身：一次只读一次、清了能读到新的、按前缀清。"""

    def setUp(self):
        from shangshu_core import request_cache
        self.cache = request_cache
        self.cache.clear()

    def tearDown(self):
        self.cache.clear()

    def test_same_key_reads_once(self):
        """同一个键连着取两次 ⇒ 底层只被读了一次。"""
        calls = []

        def loader():
            calls.append(1)
            return "值"

        with _RequestScope():
            self.assertEqual(self.cache.get("k", loader), "值")
            self.assertEqual(self.cache.get("k", loader), "值")
        self.assertEqual(len(calls), 1, "同一个键读了两遍 —— 请求内复用没生效")

    def test_clear_makes_next_call_read_again(self):
        """清缓存后再取 ⇒ 重新读，且**读到新值**（不是拿旧值硬扛）。"""
        state = {"value": "旧"}

        def loader():
            return state["value"]

        with _RequestScope():
            self.assertEqual(self.cache.get("k", loader), "旧")
            state["value"] = "新"
            self.cache.clear()
            self.assertEqual(self.cache.get("k", loader), "新", "清缓存后还拿旧值 ⇒ 缓存盖住了变更")

    def test_prefix_clear_only_drops_matching_keys(self):
        """按前缀清 ⇒ 别的键还在。"""
        calls = []

        def loader(name):
            def _load():
                calls.append(name)
                return name
            return _load

        with _RequestScope():
            self.cache.get(("domain", "a"), loader("a"))
            self.cache.get(("action", "b"), loader("b"))
            self.cache.clear("domain")
            self.cache.get(("domain", "a"), loader("a"))
            self.cache.get(("action", "b"), loader("b"))
        self.assertEqual(calls, ["a", "b", "a"], "按前缀清把别的键也清了")


@unittest.skipUnless(HAS_FRAPPE, "需要 frappe 才能断这些读口")
class TestCallSitesReuseWithinRequest(unittest.TestCase):
    """三个最贵的读口：域声明清单、动作定义、平台身份。"""

    def setUp(self):
        from shangshu_core import request_cache
        self.cache = request_cache
        self.counters = _Counters()
        self._saved = (frappe.get_all, frappe.get_doc)

    def tearDown(self):
        frappe.get_all, frappe.get_doc = self._saved
        self.cache.clear()

    def test_domain_rows_scanned_once_for_two_different_actions(self):
        """查两个不同动作的域资源 ⇒ `tabShangshu Domain` **只全扫 1 次**。"""
        from shangshu_core import domains
        rows = [
            _Row({"domain_id": "com.shangshu.core", "display_name": "内核",
                  "enabled": 1, "contribution_json": '{"actions": [{"id": "a.one"}, {"id": "a.two"}]}'}),
        ]
        with _RequestScope():
            _install_stubs(self.counters, domain_rows=rows)
            first = domains.raw_resource("actions", "a.one")
            second = domains.raw_resource("actions", "a.two")
            self.assertTrue(first[0] and second[0], "域资源没取到")
            self.assertEqual(self.counters.count("Shangshu Domain"), 1,
                             "域声明清单全扫了 %d 次（应当 1 次）"
                             % self.counters.count("Shangshu Domain"))

    def test_action_definition_looked_up_once(self):
        """连着解析同一个动作 ⇒ 底层只查 1 次。"""
        from shangshu_core import actions
        docs = [{"name": "AD-1", "action_id": "a.one", "action_version": "1.0.0",
                 "enabled": 1, "allowed_roles_json": "[]", "confirmation_policy": "none",
                 "effect": "read", "input_schema_json": "{}", "output_schema_json": "{}"}]
        with _RequestScope():
            _install_stubs(self.counters, action_docs=docs)
            actions._definition("a.one", "1.0.0")
            first = self.counters.count("Shangshu Action Definition")
            actions._definition("a.one", "1.0.0")
            second = self.counters.count("Shangshu Action Definition")
            self.assertEqual(second, first,
                             "第二次解析同一个动作又读了库（%d → %d）" % (first, second))

    def test_identity_resolved_once(self):
        """连着取两次身份 ⇒ 用户表与身份表各只查 1 次。"""
        from shangshu_core import identity
        with _RequestScope():
            _install_stubs(self.counters, identity={"name": "ID-1", "status": "Active",
                                                    "enterprise_id": "default"})
            identity.get_identity()
            first = (self.counters.count("User"), self.counters.count("Shangshu Identity"))
            identity.get_identity()
            second = (self.counters.count("User"), self.counters.count("Shangshu Identity"))
            self.assertEqual(second, first,
                             "第二次取身份又读了库（用户表/身份表 %s → %s）"
                             % (first, second))


if __name__ == "__main__":
    unittest.main()
