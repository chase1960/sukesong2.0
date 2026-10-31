"""真模块装载夹具的判据。

测试通过 = 五件事同时成立：

 ① **真 app 包能 import** —— 三个 app 根装进 sys.path 后，
    `import shangshu_files.style_border` 拿到的是**真**模块（有 build_border_xml），
    不是伪模块（规矩：能真加载就真加载，不伪造所有依赖使测试失去意义）。

 ② **真实依赖链不被桩挡在门外** —— frappe / pypika 桩装上后，
    `import shangshu_core.public_api`（有 WorkingFileTransaction）、
    `import shangshu_mail.domain`（有 DOMAIN）都能加载。

 ③ **桩属性能当基类用** —— `class X(frappe.model.document.Document)` 不炸
    （真模块里有这种写法，桩不支持就等于把真模块挡在门外）。

 ④ **桩属性能当装饰器用，而且 throw 会抛** —— `@frappe.whitelist()` 把原函数还回来；
    `frappe.throw('x')` **必须抛**（桩要是把「本该报错」变成「悄悄继续」，
    判据就会假绿）。

 ⑤ **抽函数时同文件的兄弟函数自动跟着进来** —— sheet.py 的 `_entry_streaming_openpyxl`
    用到 `_assert_table_headers`，以前靠人手抄上下文，漏一个就 NameError；
    现在抽函数工具要自动把它带上。

为什么有这个（2026-10-23 夜班清因时栽过）：
  scripts/tests/ 里 20 个文件红了，根因分四类，其中最大的一类是
  「真 app 包根本没进 sys.path」——`import shangshu_files` 直接 ModuleNotFoundError，
  只能靠手抄伪模块顶上去，源码一改就红。本文件把这套装载办法收成**一份**。

本文件只测夹具本身，不测产品行为。
"""
import importlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import (  # noqa: E402  —— 路径要先装好
    install_app_paths,
    install_real_environment,
    install_stub_package,
    load_module_functions,
)

ROOT = Path(__file__).resolve().parents[2]
SHEET = ROOT / 'frappe_apps/shangshu_files/shangshu_files/sheet.py'


class RealAppPackageTests(unittest.TestCase):
    """① 真 app 包能 import。"""

    def test_style_border_is_the_real_module_not_a_fake(self):
        # 测试通过 = shangshu_files.style_border 是**真**模块（有 build_border_xml），
        # 不是伪模块 —— 真包里这个函数是纯函数，只依赖 re。
        install_app_paths()
        module = importlib.import_module('shangshu_files.style_border')
        self.assertTrue(callable(module.build_border_xml))
        self.assertIn('build_border_xml', module.__dict__)
        self.assertTrue(module.__file__.endswith('style_border.py'), module.__file__)

    def test_app_paths_are_installed_once(self):
        # 测试通过 = 装两次不会把路径塞两遍（sys.path 里只出现一次）。
        install_app_paths()
        before = [p for p in sys.path if p.endswith('frappe_apps/shangshu_files')]
        install_app_paths()
        after = [p for p in sys.path if p.endswith('frappe_apps/shangshu_files')]
        self.assertEqual(len(after), len(before))
        self.assertGreaterEqual(len(after), 1)


class RealDependencyChainTests(unittest.TestCase):
    """② 真实依赖链不被桩挡在门外。"""

    def test_core_public_api_loads_under_framework_stub(self):
        # 测试通过 = shangshu_core.public_api 真能 import（有 WorkingFileTransaction）——
        # 它底下拖着几十个子模块（含 pypika），桩挡一层就断。
        install_real_environment()
        module = importlib.import_module('shangshu_core.public_api')
        self.assertTrue(hasattr(module, 'WorkingFileTransaction'))

    def test_mail_domain_loads_under_framework_stub(self):
        # 测试通过 = shangshu_mail.domain 真能 import（有 DOMAIN / DOCTYPE）。
        install_real_environment()
        module = importlib.import_module('shangshu_mail.domain')
        self.assertTrue(hasattr(module, 'DOMAIN'))
        self.assertTrue(hasattr(module, 'DOCTYPE'))


class StubShapeTests(unittest.TestCase):
    """③ 桩能当基类；④ 桩能当装饰器，throw 会抛。"""

    def test_stub_attribute_can_be_used_as_base_class(self):
        # 测试通过 = `class X(frappe.model.document.Document)` 不炸 ——
        # 真模块里有这种写法，桩不支持就等于把真模块挡在门外。
        install_real_environment()
        frappe = importlib.import_module('frappe')
        document = importlib.import_module('frappe.model.document')

        class Sample(document.Document):
            pass

        self.assertTrue(issubclass(Sample, document.Document))

    def test_stub_attribute_can_be_used_as_decorator(self):
        # 测试通过 = `@frappe.whitelist()` 把原函数还回来（装饰器语义不丢）。
        install_real_environment()
        frappe = importlib.import_module('frappe')

        @frappe.whitelist()
        def sample():
            return 'kept'

        self.assertTrue(callable(sample))
        self.assertEqual(sample(), 'kept')

    def test_stub_throw_actually_raises(self):
        # 测试通过 = frappe.throw('x') **真的抛** ——
        # 桩要是把「本该报错」变成「悄悄继续」，判据就会假绿。
        install_real_environment()
        frappe = importlib.import_module('frappe')
        with self.assertRaises(Exception):
            frappe.throw('boom')
        with self.assertRaises(Exception):
            frappe.throw('boom', frappe.ValidationError)

    def test_stub_package_attributes_can_be_overridden(self):
        # 测试通过 = 调用方给的属性覆盖生效（frappe.ValidationError = ValueError 之后
        # isinstance 认它）—— 桩要能按测试的形状调。
        install_stub_package('frappe', ValidationError=ValueError)
        frappe = importlib.import_module('frappe')
        self.assertIs(frappe.ValidationError, ValueError)
        self.assertTrue(issubclass(ValueError, Exception))


class TransitiveExtractTests(unittest.TestCase):
    """⑤ 抽函数时同文件的兄弟函数自动跟着进来。"""

    def test_extracted_function_brings_its_sibling_helper(self):
        # 测试通过 = 抽 sheet.py 的 `_entry_streaming_openpyxl`，
        # 它用到的 `_assert_table_headers` **自动跟着进来** ——
        # 以前靠人手抄上下文，漏一个就 NameError（2026-10-15 栽过 time 那次）。
        install_real_environment()
        ctx = load_module_functions(SHEET, ['_entry_streaming_openpyxl'])
        self.assertIn('_entry_streaming_openpyxl', ctx)
        self.assertIn('_assert_table_headers', ctx)
        self.assertTrue(callable(ctx['_assert_table_headers']))

    def test_extracted_function_carries_module_constants(self):
        # 测试通过 = 模块级常量也一起进来（META_FIELD 这种），
        # 不然抽出来的函数用到常量就 NameError。
        install_real_environment()
        ctx = load_module_functions(SHEET, ['_entry_streaming_openpyxl'])
        self.assertIn('META_FIELD', ctx)

    def test_unknown_function_name_is_reported(self):
        # 测试通过 = 要抽的名字不存在就点名报错，不静默给个空上下文。
        install_real_environment()
        with self.assertRaises(Exception):
            load_module_functions(SHEET, ['_definitely_not_there'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
