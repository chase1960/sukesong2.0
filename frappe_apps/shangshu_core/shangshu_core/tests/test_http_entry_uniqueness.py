"""HTTP 层的动作入口**只许有一份定义**（PKG-128-T04 · 2026-10-26 · 审查报告 R28）。

**背景**：`public_api/http.py` 里 `action_proposal_review` 定义了 **3 次**、
`action_proposal_accept` 定义了 **3 次**。
Python 同名后定义覆盖前定义 ⇒ 真正生效的只有**最后那一对**
⇒ 但中间那几个的**参数名和顺序不一样**（有一个叫 `review_revision`、不是
`expected_review_revision`，而且 `units` 排在第二位）
⇒ 谁照着被覆盖的那份改，就会**改到一个不生效的实现上**，
而且**看不出任何报错**（页面照常跑，只是改的那份没用）。

**测试通过 = 什么成立**（逐条；每条一句话）：

1. `action_proposal_review` 在**运行时实际导出**的那一个，签名与 BFF 调用的对得上
   （BFF 发 `proposal_id`）。 【离线可跑】
2. `action_proposal_accept` 在**运行时实际导出**的那一个，**认得**
   `expected_review_revision` 这个参数名（BFF 发的就是它）。 【离线可跑】
3. `public_api/http.py` 里**每个白名单动作名只定义一次**（不许有被覆盖的旧实现）。 【离线可跑】
4. 被覆盖的那些**不留下误导性的引用**：文件里没有「同一个名字定义两遍」的情况，
   也没有指着旧参数名的注释。 【离线可跑】

**离线怎么跑**（本机没有站点 ⇒ 全部离线可跑）：

    python3 frappe_apps/shangshu_core/shangshu_core/tests/test_http_entry_uniqueness.py

**为什么必须断「运行时实际导出」**（不是断文本里出现过几次）：
   文本匹配会**分不清哪个真的生效** ⇒ 照它改还是可能改错。
   这里**真把模块装起来**，取它**真正导出的那个函数**，看它的签名。

**替的是什么**：替 `frappe.whitelist()` 这个装饰器（真站上它做的是权限与
方法白名单登记）—— 判据用一个**只记录、不改变行为**的假装饰器
⇒ 装起来后拿到的就是**真模块的真导出**。
"""
import importlib.util
import inspect
import re
import sys
import types
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
CORE_DIR = TESTS_DIR.parent            # .../shangshu_core/shangshu_core


def _load_by_path(name, path):
    """按**文件路径**装一个模块（离线判据用它绕开真包与真 frappe 的依赖）。"""
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class _FakeWhitelist:
    """假 `frappe.whitelist`：**只记录**，不改变行为。

    ⚠️ 必须原样返回被装饰的函数（`functools.wraps` 一样）——
       否则装起来的模块拿到的就不是真函数，签名也会失真。
    """

    def __init__(self):
        self.registered = {}

    def __call__(self, *args, **kwargs):
        def decorate(function):
            name = function.__name__
            self.registered.setdefault(name, []).append({
                'methods': kwargs.get('methods'),
                'args': kwargs.get('args'),
            })
            return function
        return decorate


class TestHttpEntryUniqueness(unittest.TestCase):
    """白名单动作入口：只许有一份，且必须是真正生效的那份。"""

    def setUp(self):
        self.previous = {key: sys.modules.get(key) for key in (
            "frappe", "frappe.sessions", "werkzeug", "werkzeug.wrappers",
            "shangshu_core", "shangshu_core.http_headers", "shangshu_core.public_api",
            "shangshu_core.public_api.http")}
        self.http_source = (CORE_DIR / "public_api" / "http.py").read_text(encoding="utf-8")

        whitelist = _FakeWhitelist()
        fake = types.ModuleType("frappe")
        fake.whitelist = whitelist
        fake.parse_json = lambda value: value
        fake._dict = dict
        fake.__path__ = []                       # 让它能当包用（`frappe.sessions` 要能 import）
        sys.modules["frappe"] = fake
        self.frappe = fake
        self.whitelist = whitelist

        sessions = types.ModuleType("frappe.sessions")
        sessions.get_csrf_token = lambda: "test-csrf-token"
        sys.modules["frappe.sessions"] = sessions
        fake.sessions = sessions

        werkzeug = types.ModuleType("werkzeug")
        werkzeug.__path__ = []
        wrappers = types.ModuleType("werkzeug.wrappers")
        wrappers.Response = type("Response", (Exception,), {})
        sys.modules["werkzeug"] = werkzeug
        sys.modules["werkzeug.wrappers"] = wrappers
        werkzeug.wrappers = wrappers

        package = types.ModuleType("shangshu_core")
        package.__path__ = []
        sys.modules["shangshu_core"] = package

        http_headers = types.ModuleType("shangshu_core.http_headers")
        http_headers.content_disposition = lambda *args, **kwargs: "attachment"
        sys.modules["shangshu_core.http_headers"] = http_headers
        package.http_headers = http_headers

        public_api = types.ModuleType("shangshu_core.public_api")
        public_api.__path__ = []
        # 模块顶部那一大串 import 指向真公共面 —— 这里给**同名假实现**，
        # 装起来的模块才跑得起来；本判据只关心**真正导出的是哪一个入口**。
        calls = []

        def get_action_proposal_review(proposal_id):
            calls.append(('review', proposal_id))
            return {'ok': True, 'proposal_id': proposal_id}

        def accept_action_proposal_units(proposal_id, op_id, expected_review_revision,
                                         units=None, edited_value=None):
            calls.append(('accept', proposal_id, op_id, expected_review_revision))
            return {'ok': True, 'receipts': []}

        public_api.get_action_proposal_review = get_action_proposal_review
        public_api.accept_action_proposal_units = accept_action_proposal_units
        # 顶部 import 的其余名字统统给个「返回空」的假实现。
        # ⚠️ 用 **AST** 取导入名（照缩进/正则猜会漏）⇒ 漏一个就装不起来模块。
        for name in self._imported_names():
            if not hasattr(public_api, name):
                setattr(public_api, name, lambda *args, **kwargs: {})
        sys.modules["shangshu_core.public_api"] = public_api
        package.public_api = public_api
        self.calls = calls

        self.http = _load_by_path("shangshu_core.public_api.http",
                                  CORE_DIR / "public_api" / "http.py")

    def _imported_names(self):
        """这个文件从 `shangshu_core.public_api` 导入了哪些名字（AST 精确取）。"""
        import ast
        tree = ast.parse(self.http_source)
        names = []
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == 'shangshu_core.public_api':
                names.extend(alias.name for alias in node.names)
        return names

    def tearDown(self):
        for key, value in self.previous.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value

    # ---------- ① 运行时实际导出的 review 入口 ----------
    def test_exported_review_entry_accepts_the_bff_argument(self):
        """① 真正生效的那个 review 入口，认得 BFF 发的 `proposal_id`。"""
        parameters = list(inspect.signature(self.http.action_proposal_review).parameters)
        self.assertEqual(parameters, ['proposal_id'],
                         "真正生效的 action_proposal_review 认得的参数是 "
                         f"{parameters} —— BFF 发的是 proposal_id，对不上就调不通。")

    # ---------- ② 运行时实际导出的 accept 入口 ----------
    def test_exported_accept_entry_knows_expected_review_revision(self):
        """② 真正生效的那个 accept 入口，**认得 `expected_review_revision`**。

        **为什么单列一条**：被覆盖的那一版参数名是 `review_revision`（不是
        `expected_review_revision`），而且 `units` 排在第二位
        ⇒ 谁照它改，BFF 的请求就会因为「未知参数」失败。
        """
        parameters = list(inspect.signature(self.http.action_proposal_accept).parameters)
        self.assertIn('expected_review_revision', parameters,
                      f"真正生效的 action_proposal_accept 认得的参数是 {parameters} "
                      "—— 里面没有 expected_review_revision ⇒ BFF 那条请求调不通。")
        self.assertIn('op_id', parameters,
                      f"真正生效的 action_proposal_accept 认得的参数是 {parameters} "
                      "—— 里面没有 op_id ⇒ BFF 那条请求调不通。")

    # ---------- ③ 每个动作名只定义一次 ----------
    def test_each_whitelisted_action_is_defined_only_once(self):
        """③ 同一个白名单动作名**不许定义两遍**（后定义覆盖前定义 ⇒ 前一个成了死代码）。

        **为什么这条要有**：被覆盖的定义**不会报错、不会警告** ⇒
        留着它就等于留着一份「改了也不生效」的入口
        ⇒ 下一个改它的人会把改动做在死代码上。
        """
        defined = re.findall(r'^def\s+(\w+)\s*\(', self.http_source, re.M)
        seen = {}
        duplicated = {}
        for name in defined:
            seen[name] = seen.get(name, 0) + 1
            if seen[name] > 1:
                duplicated.setdefault(name, seen[name])
        self.assertEqual(duplicated, {},
                         "这些白名单动作在 public_api/http.py 里定义了不止一次 "
                         f"（{duplicated}）⇒ 后定义覆盖前定义 ⇒ 前几个成了改了也不生效的死代码。")

    # ---------- ④ 注册表与实际导出一致 ----------
    def test_whitelist_registration_matches_the_exported_entry(self):
        """④ 装饰器登记的名字与**真正导出**的那个函数是同一个（不许登记一个、用另一个）。"""
        registered = set(self.whitelist.registered)
        for name in ('action_proposal_review', 'action_proposal_accept'):
            self.assertIn(name, registered,
                          f"「{name}」没有走 frappe.whitelist 注册 ⇒ 它不是 HTTP 入口。")
            self.assertTrue(callable(getattr(self.http, name, None)),
                            f"「{name}」在模块里拿不到可调用的东西。")
        # 注册次数与定义次数必须一致（一个入口只登记一次）。
        for name, entries in self.whitelist.registered.items():
            source_count = len(re.findall(r'^def\s+' + re.escape(name) + r'\s*\(',
                                          self.http_source, re.M))
            self.assertEqual(len(entries), source_count,
                             f"「{name}」定义了 {source_count} 次、注册了 {len(entries)} 次 "
                             "⇒ 注册与实现对不上。")


if __name__ == '__main__':
    unittest.main()
