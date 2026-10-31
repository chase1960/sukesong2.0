"""真实模块测试接缝的判据。

测试通过 = 两件事成立：
  ① 抠函数 exec 的上下文**按源文件顶层真 import 自动配齐** ——
     源文件新加一个 `import time` 这类名字，上下文自动跟上，不再因为漏配一个名字就 NameError。
  ② 给伪包补 `__path__` 指向真目录后，**真子模块能加载进来**，不是被伪掉的 ——
     「不伪造所有依赖使测试失去意义」（计划 §五 F-2）。

为什么有这个（2026-10-15 栽过）：
  sheet.py 加了 `import time`（R1 冷开计时），test_row_append_extent.py 手拼的 exec 上下文
  没跟上，`_entry_streaming` 第一行 `time.perf_counter()` 就 NameError。
  同病：test_file_restore.py 把整个 `shangshu_files` 伪造成裸模块，
  service.py 顶层 `from shangshu_files.facts import ...` 直接 ModuleNotFoundError。

本文件只测接缝本身，不测产品行为。
"""
import importlib
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import (
    SeamError,
    import_context,
    top_level_import_names,
    package_with_real_path,
    placeholder_module,
    install_app_paths,
)

ROOT = Path(__file__).resolve().parents[2]
SHEET = ROOT / 'frappe_apps/shangshu_files/shangshu_files/sheet.py'
PKG_DIR = ROOT / 'frappe_apps/shangshu_files/shangshu_files'

# 真 app 根进 sys.path —— sheet.py 顶层 `from shangshu_files.style_border import ...`
# 要能**真导入**（style_border 是纯函数模块，只 import re）。
#
# 这里**只装 app 路径、不装 frappe 桩**：frappe 桩一装，
# 下面「配不上就点名抛 SeamError」那条用例就再也配不上了 —— 判据被变弱。
install_app_paths('shangshu_files')


def _stubs():
    """sheet.py 顶层那些**装不进本机**的依赖，一份够用的 stub。

    只 stub 框架与 Frappe 应用内兄弟模块；stdlib / openpyxl 走真 import。
    这些都是**占位伪造**（placeholder_module），只用来验「名字进没进上下文」。

    **不再 stub 'shangshu_files' 这个包本身**：假包会把真子模块挡住
    （`from shangshu_files import zipedit` 会绑到假对象上，而不是真 zipedit）。
    包走上面 `install_app_paths('shangshu_files')` 装的真路径，
    子模块按 Python 真语义导入。
    """
    return {
        'frappe': placeholder_module('frappe'),
        'shangshu_files.sheet_search': placeholder_module('shangshu_files.sheet_search'),
        'shangshu_files.service': placeholder_module('shangshu_files.service'),
        'shangshu_files.working_file': placeholder_module('shangshu_files.working_file'),
    }


class AutoBuildContextTests(unittest.TestCase):
    """① 上下文按真 import 自动配齐。"""

    def test_every_top_level_import_of_sheet_py_lands_in_context(self):
        # 测试通过 = sheet.py 顶层每一个 import 绑定的名字都进了上下文，
        # 没有哪个是靠人手抄的 —— 手抄就会漏（漏的就是 time）。
        names = top_level_import_names(SHEET)
        self.assertIn('time', names, 'sheet.py 顶层应有 import time —— 2026-10-15 加的，就是漏掉的那个')
        ctx = import_context(SHEET, stubs=_stubs())
        missing = sorted(n for n in names if n not in ctx)
        self.assertEqual(missing, [], f'这些 import 绑定没进上下文: {missing}')

    def test_time_specifically_is_present_and_usable(self):
        # 就是这一个名字让 test_row_append_extent.py 红的。
        ctx = import_context(SHEET, stubs=_stubs())
        self.assertIs(ctx['time'], __import__('time'))
        self.assertTrue(hasattr(ctx['time'], 'perf_counter'))

    def test_overrides_win_over_auto_imports(self):
        # 测试要顶掉某个名字（比如 _style_read_cache）时，顶掉的那份生效。
        sentinel = object()
        ctx = import_context(SHEET, stubs=_stubs(), overrides={'time': sentinel})
        self.assertIs(ctx['time'], sentinel)

    def test_stub_is_used_when_real_import_is_unavailable(self):
        # 配不上的（frappe）从 stubs 取，不静默丢掉 —— 丢了就是后面的 NameError。
        fake = placeholder_module('frappe')
        stubs = _stubs()
        stubs['frappe'] = fake
        ctx = import_context(SHEET, stubs=stubs)
        self.assertIs(ctx['frappe'], fake)

    def test_unresolvable_name_raises_instead_of_vanishing(self):
        # 配不上就点名抛错，不许悄悄不放进上下文（悄悄丢 = 下一个 NameError）。
        from _f_module_seam import SeamError
        with self.assertRaises(SeamError):
            import_context(SHEET, stubs={})


class RealSubmoduleLoadTests(unittest.TestCase):
    """② 伪包补 __path__ 后真子模块能加载。"""

    def test_package_with_real_path_exposes_real_facts_submodule(self):
        # 测试通过 = 伪 shangshu_files 包补 __path__ 后，
        # `from shangshu_files.facts import action_fact` 能**真加载**到 facts 模块（有 action_fact），
        # 不是被伪掉的 Mock —— 这就是「不伪造所有依赖使测试失去意义」。
        self._reset_pkg()
        package_with_real_path('shangshu_files', PKG_DIR)
        # 真去 import 一下才触发子模块加载（补 __path__ 本身不加载）。
        facts = importlib.import_module('shangshu_files.facts')
        self.assertIn('shangshu_files.facts', sys.modules)
        self.assertIs(sys.modules['shangshu_files.facts'], facts)
        self.assertTrue(hasattr(facts, 'action_fact'), '真 facts.py 里应有 action_fact')
        self.assertTrue(hasattr(facts, 'action_fact_query'), '真 facts.py 里应有 action_fact_query')

    def test_service_module_facts_import_no_longer_blows_up(self):
        # 当初炸的就是这条：service.py 顶层 `from shangshu_files.facts import ...`。
        # 测试通过 = 伪包补 __path__ 后，这条 import 不再 ModuleNotFoundError。
        self._reset_pkg()
        package_with_real_path('shangshu_files', PKG_DIR)
        for name in ('directories', 'access'):
            setattr(sys.modules['shangshu_files'], name, types.SimpleNamespace())
        namespace = {}
        exec('from shangshu_files.facts import action_fact, action_fact_query', namespace)
        self.assertTrue(callable(namespace['action_fact']))
        self.assertTrue(callable(namespace['action_fact_query']))

    def test_preinstalled_stubs_survive_submodule_load(self):
        # 伪包上先挂的 Mock（directories/access）不被真子模块加载冲掉。
        self._reset_pkg()
        pkg = package_with_real_path('shangshu_files', PKG_DIR)
        pkg.directories = types.SimpleNamespace(marker='kept')
        importlib.import_module('shangshu_files.facts')
        self.assertEqual(sys.modules['shangshu_files'].directories.marker, 'kept')

    def _reset_pkg(self):
        for key in [k for k in sys.modules if k == 'shangshu_files' or k.startswith('shangshu_files.')]:
            sys.modules.pop(key, None)
        if 'frappe' not in sys.modules:
            sys.modules['frappe'] = placeholder_module('frappe')   # 真 facts.py 顶层要 import frappe


if __name__ == '__main__':
    unittest.main()
