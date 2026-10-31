"""离线跑**文件域**判据用的脚手架（**替身**那一层，只此一份）。

**为什么有这一份**：文件域的模块在 **import 期**就要三样东西 ——
  · `frappe`（框架）—— 离线上没有；
  · `frappe.query_builder`（`location.py` 那条链）—— 公共替身**缺的那一块**；
  · `shangshu_core.public_api`（跨域那几口）—— 离线上装不上（要真 frappe）。
⇒ 三样都补上，判据才跑得起来；补法收在**这一份**里（仓库约定 §13「公共工具只留一份」）：
  · `frappe` 用**公共那一份拟真替身**（`scripts/shangshu_testkit/frappe_stub.py`，
    全仓只许有那一份）—— **域里不另造**；
  · `frappe.query_builder` **只补缺的那一块**（不改公共那份、不另造替身）；
  · `shangshu_core.public_api` 用**公共那一份的假公共口**（`install_minimal_public_api`）。

**跑法（离线可跑，不带 bench）**：

    cd frappe_apps/shangshu_files && python3 -m unittest shangshu_files.tests.test_xxx

⚠️ **这里不替任何「规则」**：主体范围、伴随授权这些判定都跑**真模块**；
   替身只顶掉**框架**与**跨域边界**那几口（判据自己要盯住的就那几口）。
"""
import pathlib
import sys
import types
import unittest

#: **判据目录**：…/shangshu_files/shangshu_files/tests
TESTS_DIR = pathlib.Path(__file__).resolve().parent
#: **域包根**（域源码根）：…/shangshu_files/shangshu_files
DOMAIN_ROOT = TESTS_DIR.parent


def _find_tools_root():
    """**工具区**在哪儿？（**站上没有** —— bench 形状的树里只有 `apps/` ⇒ 返回 None）"""
    for ancestor in pathlib.Path(__file__).resolve().parents:
        candidate = ancestor / 'scripts' / 'shangshu_testkit'
        if candidate.is_dir():
            return ancestor / 'scripts'
    return None


_TOOLS_ROOT = _find_tools_root()
if _TOOLS_ROOT is not None and str(_TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TOOLS_ROOT))
try:  # **站上布局**：工具区不在站上 ⇒ 公共件 import 不到（下面有站上那条路）
    from shangshu_testkit import frappe_stub as _public
except ImportError:  # pragma: no cover - 只在站上（bench 形状）走这里
    _public = None


class OfflineEnv:
    """离线跑文件域判据的环境：**框架替身 ＋ 假公共口**。

    用法：

        with OfflineEnv() as env:
            env.frappe.get_doc = my_get_doc
            env.api.authorize_companion_cells = my_counter
            from shangshu_files import sheet      # ← 替身装好之后才 import 域模块

    ⚠️ **域模块必须在 `__enter__` 之后 import** —— 否则它们绑到的是**真 frappe**
    （站上）或直接 ImportError（离线）。
    """

    def __init__(self):
        self.frappe = None
        self.api = None
        self._frappe_installed = False
        self._pypika_installed = False
        self._api_installed = False
        self._extra_modules = {}

    # —— 装 ——
    def __enter__(self):
        if _public is None:
            raise unittest.SkipTest(
                '站上布局：工具区不在站上 ⇒ 公共替身够不着 ⇒ 这份离线判据不跑')
        self._pypika_installed = _public.install_minimal_pypika()
        self._frappe_installed = _public.install_minimal_frappe(force=True)
        import frappe
        self.frappe = frappe
        self.frappe.session = types.SimpleNamespace(user='tester@example.invalid')
        self.frappe.local = types.SimpleNamespace()
        self.frappe.conf = {}
        # **公共替身缺的那一个异常类**（域代码在用：`frappe.TimestampMismatchError`
        # ——「你看到的那份已经被别人改了」）⇒ 补上（站上是真 frappe 自带）。
        # ⚠️ 替身给**任何**名字都兜底一个函数 ⇒ 得**按类型**判，不能用 `hasattr`。
        current = getattr(self.frappe, 'TimestampMismatchError', None)
        if not (isinstance(current, type) and issubclass(current, BaseException)):
            self.frappe.TimestampMismatchError = type(
                'TimestampMismatchError', (Exception,), {})
        self._install_missing_frappe_modules()
        names = _public.domain_public_api_names(DOMAIN_ROOT)
        self.api, self._api_installed = _public.install_minimal_public_api(names)
        return self

    # —— 撤 ——
    def __exit__(self, *exc):
        if self._api_installed:
            _public.uninstall_minimal_public_api(self._api_installed)
        for name, module in self._extra_modules.items():
            sys.modules[name] = module
        _public.uninstall_minimal_frappe(self._frappe_installed)
        _public.uninstall_minimal_pypika(self._pypika_installed)
        return False

    def _install_missing_frappe_modules(self):
        """公共替身**缺的那一块**（`frappe.query_builder`）—— 域自己的 `location.py` 要它。

        ⚠️ **只补缺的那一块**（不另造替身、不改公共那份）；退出时原样还回去。
        """
        import frappe
        if 'frappe.query_builder' in sys.modules:
            return
        package = types.ModuleType('frappe.query_builder')
        package.__path__ = []
        functions = types.ModuleType('frappe.query_builder.functions')
        functions.Count = lambda *args, **kwargs: None
        package.functions = functions
        sys.modules['frappe.query_builder'] = package
        sys.modules['frappe.query_builder.functions'] = functions
        frappe.query_builder = package
        self._extra_modules = {'frappe.query_builder': package,
                                'frappe.query_builder.functions': functions}

    def import_domain(self, *names):
        """**重新 import** 域模块（替身装好之后）—— 返回 `{名字: 模块}`。

        ⚠️ **为什么要重新 import**：域模块在 **import 期**就把 `frappe` 绑死了 ⇒
          同一进程里跑**多份判据**时，后一份拿到的是**前一套替身**绑的那份
          （⇒ 判据给 `frappe.get_doc` 装的替身**它看不见**）。
          ⇒ 每份判据在**自己的替身装好之后**重新 import 一次。
        """
        import importlib
        import shangshu_files
        for name in names:
            sys.modules.pop('shangshu_files.%s' % name, None)
            if hasattr(shangshu_files, name):
                delattr(shangshu_files, name)
        modules = {}
        for name in names:
            modules[name] = importlib.import_module('shangshu_files.%s' % name)
        return modules


class FakeFileDoc:
    """`File` 那张（存字节）的替身。"""

    def __init__(self, content=b''):
        self.content = content

    def get_content(self):
        return self.content
