"""真实模块测试接缝 —— 公共夹具，**只留这一份**（计划 §五 F-2）。

解决什么：
  scripts/tests/ 里一批测试用 ast 把 sheet.py 的几个函数抠出来 exec，上下文 dict 是手写的。
  源文件每加一个顶层名字就断一次。2026-10-15 sheet.py 加 `import time`（R1 冷开计时），
  test_row_append_extent.py 手拼的上下文没跟上，`_entry_streaming` 第一行
  `time.perf_counter()` 就 NameError。同病：test_file_restore.py 把整个 `shangshu_files`
  伪造成裸模块，service.py 顶层 `from shangshu_files.facts import ...` 直接 ModuleNotFoundError。

三条规矩：
  1. **上下文按源文件真 import 自动配齐** —— 不靠人手抄，手抄就会漏
  2. **能真加载就真加载** —— stdlib / 第三方直接 import
  3. **本夹具不伪造任何东西** —— 伪多少、伪什么，由调用的测试自己决定并自己负责
     （计划 §五 F-2「不伪造所有依赖使测试失去意义」）

用法：
    from _f_module_seam import import_context, package_with_real_path
    ctx = import_context(SHEET, stubs={'frappe': fake_frappe},
                         overrides={'_style_read_cache': lambda *a: {...}})
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SHEET), 'exec'), ctx)
"""
import ast
import importlib
import importlib.abc
import importlib.machinery
import sys
import types
from pathlib import Path

__all__ = ['SeamError', 'top_level_import_names', 'import_context', 'package_with_real_path',
           'placeholder_module', 'install_app_paths', 'install_stub_package',
           'install_real_environment', 'load_module_functions', 'StubThrow']

APP_ROOTS = Path(__file__).resolve().parents[2] / 'frappe_apps'


class SeamError(Exception):
    """接缝配不齐。**点名缺哪个、怎么给** —— 不静默丢名字（丢了就是后面的 NameError）。"""


def top_level_import_names(py_path):
    """源文件顶层 import 绑定到的名字集合。纯 AST，不执行、不 import。

    `import time`            -> {'time'}
    `import a.b as c`        -> {'c'}
    `from io import BytesIO` -> {'BytesIO'}
    `from x import y as z`   -> {'z'}
    """
    tree = ast.parse(Path(py_path).read_text(encoding='utf-8'))
    names = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.asname or alias.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == '*':
                    continue
                names.add(alias.asname or alias.name)
    return names


def _bind_from_import(node):
    """把一条顶层 import 拆成 (绑定名, 要的模块路径, 要的属性名或 None)。"""
    out = []
    if isinstance(node, ast.Import):
        for alias in node.names:
            out.append((alias.asname or alias.name.split('.')[0], alias.name, None))
    elif isinstance(node, ast.ImportFrom):
        mod = ('.' * node.level) + (node.module or '')
        for alias in node.names:
            if alias.name == '*':
                continue
            out.append((alias.asname or alias.name, mod, alias.name))
    return out


def _lookup(binding, mod_path, attr, stubs):
    """stubs / 真 import 的解析。返回 (命中值, 是否命中)。"""
    if stubs and binding in stubs:
        return stubs[binding], True
    if stubs and mod_path in stubs:
        holder = stubs[mod_path]
        if attr is None:
            return holder, True
        if hasattr(holder, attr):
            return getattr(holder, attr), True
        raise SeamError(
            f"stub 模块 {mod_path!r} 上没有属性 {attr!r}（源文件要 `{binding}`）。\n"
            f"  补法二选一：\n"
            f"    · 在 stubs[{mod_path!r}] 上把 {attr!r} 挂上，或\n"
            f"    · 用 overrides={{{binding!r}: <你想要的那份>}} 顶掉。\n"
            f"  **本夹具不替你伪造** —— 伪多少由你的测试自己决定。")
    # 真 import。按 Python 的 `from 包 import 名字` 语义来：
    #   先看包上有没有这个属性；没有才把它当**子模块**导入。
    # （`from shangshu_files import zipedit` 绑的是 zipedit 这个**模块**本身。）
    if attr is not None:
        parent = None
        try:
            parent = importlib.import_module(mod_path)
        except Exception:
            parent = None
        if parent is not None and hasattr(parent, attr):
            return getattr(parent, attr), True
        try:
            submodule = importlib.import_module(mod_path + '.' + attr)
        except Exception:
            submodule = None
        if submodule is not None:
            return submodule, True
    try:
        module = importlib.import_module(mod_path)
    except Exception:
        return None, False
    if attr is None:
        return module, True
    if hasattr(module, attr):
        return getattr(module, attr), True
    raise SeamError(
        f"模块 {mod_path!r} 里没有 {attr!r}（源文件要 `{binding}`）—— "
        f"源文件变了或依赖装的不是这版，查清再补，别糊过去。")


def import_context(py_path, stubs=None, overrides=None):
    """按源文件顶层 import 自动配齐 exec 上下文。

    解析顺序：overrides > stubs[绑定名] > stubs[模块路径].属性 > 真 import。
    都拿不到就抛 SeamError 点名 —— **不静默丢名字**。

    参数
      stubs     : dict。键可以是模块路径（'frappe' / 'shangshu_files.zipedit'）
                  或绑定名（'DOCTYPE'）。值是模块或任意对象。
      overrides : dict。要顶掉某个名字时用（比如把 _style_read_cache 换成 stub）。
    """
    py_path = Path(py_path)
    stubs = dict(stubs or {})
    overrides = dict(overrides or {})
    ctx = {}
    tree = ast.parse(py_path.read_text(encoding='utf-8'))
    for node in tree.body:
        if not isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        for binding, mod_path, attr in _bind_from_import(node):
            if binding in overrides:
                ctx[binding] = overrides[binding]
                continue
            value, hit = _lookup(binding, mod_path, attr, stubs)
            if not hit:
                raise SeamError(
                    f"{py_path.name} 顶层 `{binding}`（来自 {mod_path!r}）配不上。\n"
                    f"  补法：stubs={{{mod_path!r}: <模块或 stub>}} "
                    f"或 overrides={{{binding!r}: <值>}}。\n"
                    f"  **不要**把它从上下文里悄悄删掉 —— 那就是下一个 NameError。")
            ctx[binding] = value
    for name, value in overrides.items():
        ctx.setdefault(name, value)
    return ctx


def package_with_real_path(name, real_dir):
    """给伪包补 `__path__` 指向真目录，让**真子模块**能加载进来。

    为什么：test_file_restore.py 把整个 `shangshu_files` 伪造成裸模块，
    service.py 顶层 `from shangshu_files.facts import ...` 就 ModuleNotFoundError。
    补上 __path__ 之后 facts 是**真**那个模块 —— 「不伪造所有依赖使测试失去意义」。

    注意
      · **框架依赖要先在 sys.modules 里备好**（比如 frappe）—— 真子模块会去 import 它
      · 同名包已在 sys.modules 时**只补 __path__**，不冲掉你已挂的 Mock
    """
    real_dir = Path(real_dir)
    if not real_dir.is_dir():
        raise SeamError(f'{name!r} 的真目录不存在：{real_dir}')
    mod = sys.modules.get(name)
    if mod is None:
        mod = types.ModuleType(name)
        sys.modules[name] = mod
    if getattr(mod, '__path__', None) is None:
        mod.__path__ = [str(real_dir)]
    return mod


class _PlaceholderModule(types.ModuleType):
    """属性都给占位的模块。**这是伪造。**"""

    def __getattr__(self, item):
        if item.startswith('__'):
            raise AttributeError(item)
        value = types.SimpleNamespace(__name__=f'{self.__name__}.{item}')
        setattr(self, item, value)
        return value


def placeholder_module(name):
    """返回一个「什么属性都给占位」的 stub 模块。**这是伪造，用的人自己负责。**

    只该用在「这条依赖只是路过、不参与被测行为」的地方。**被测行为依赖的东西必须给真实现**
    —— 「不伪造所有依赖使测试失去意义」（计划 §五 F-2）。

    留一份在这里，是因为每个测试各抄一份这样的 stub 才是真的重复。
    """
    return _PlaceholderModule(name)


# ─────────────────────────────────────────────────────────────
# 真 app 包 + 框架桩：同一套装载办法**只留这一份**（计划 §十三）
#
# 为什么加这个（2026-10-23 夜班清因时栽过）：
#   scripts/tests/ 里 20 个文件红了，最大的一类根因是「真 app 包根本没进 sys.path」——
#   `import shangshu_files` 直接 ModuleNotFoundError，只能靠手抄伪模块顶上去，
#   源码一改就红（`style_border` / `working_file` / `relations` 全是这样进来的）。
#   下面这三件把「真包能 import ＋ 框架依赖有桩 ＋ 抽函数自动带兄弟」收成一份。
# ─────────────────────────────────────────────────────────────


class StubThrow(Exception):
    """桩 frappe 的 throw 抛出来的错。**会抛** —— 不然「本该报错」就变成「悄悄继续」。"""


def _stub_throw(message, exc=None, *args, **kwargs):
    if exc is None:
        raise StubThrow(message)
    raise exc(message)


class _StubMeta(type):
    """桩类的元类：类上取不到的属性也给占位（`frappe.db.get_value` 这种链式）。"""

    def __getattr__(cls, item):
        if item.startswith('__'):
            raise AttributeError(item)
        return make_stub_class(cls.__name__ + '.' + item)


def make_stub_class(name):
    """造一个「什么都能顶」的桩类。

    能当**基类**用（真模块里有 `class X(frappe.model.document.Document)`），
    也能当**装饰器**用（`@frappe.whitelist()` 把原函数还回来）。
    """
    class _Stub(metaclass=_StubMeta):
        __name__ = name

        def __init__(self, *args, **kwargs):
            pass

        def __call__(self, *args, **kwargs):
            if len(args) == 1 and not kwargs and callable(args[0]):
                return args[0]
            return self

    _Stub.__name__ = name
    _Stub.__qualname__ = name
    return _Stub


class _StubModule(types.ModuleType):
    """像**包**一样的桩模块：子模块自动生成，属性给桩类。"""

    def __init__(self, name, callables=None):
        super().__init__(name)
        self.__path__ = []
        self.__dict__['_stub_callables'] = dict(callables or {})

    def __getattr__(self, item):
        if item.startswith('__'):
            raise AttributeError(item)
        callables = self.__dict__.get('_stub_callables') or {}
        if item in callables:
            value = callables[item]
        else:
            value = make_stub_class(self.__name__ + '.' + item)
        setattr(self, item, value)
        return value


class _StubLoader(importlib.abc.Loader):
    def __init__(self, callables):
        self.callables = callables

    def create_module(self, spec):
        return _StubModule(spec.name, self.callables)

    def exec_module(self, module):
        return None


class _StubFinder(importlib.abc.MetaPathFinder):
    """给指定的根名（frappe / pypika）造一整棵桩子树。"""

    def __init__(self):
        self.roots = {}

    def register(self, root, callables=None):
        self.roots[root] = dict(callables or {})

    def find_spec(self, fullname, path=None, target=None):
        root = fullname.split('.')[0]
        if root not in self.roots:
            return None
        return importlib.machinery.ModuleSpec(fullname, _StubLoader(self.roots[root]), is_package=True)


_stub_finder = None


def _stub_finder_instance():
    global _stub_finder
    if _stub_finder is None:
        _stub_finder = _StubFinder()
        sys.meta_path.insert(0, _stub_finder)
    return _stub_finder


def install_app_paths(*apps):
    """把 `frappe_apps/<app>` 装进 sys.path —— **真 app 包能 import**。

    不给参数就装全部 app 目录。装过的不会装第二遍。

    为什么：以前测试只能手抄伪模块顶住 `import shangshu_files`，
    源码里多一个顶层 import 就断一次（style_border / working_file / relations 都是这么红的）。
    """
    if apps:
        names = list(apps)
    elif APP_ROOTS.is_dir():
        names = sorted(p.name for p in APP_ROOTS.iterdir() if p.is_dir())
    else:
        raise SeamError(f'找不到 app 根目录：{APP_ROOTS}')
    installed = []
    for name in names:
        root = APP_ROOTS / name
        if not root.is_dir():
            raise SeamError(f'app 目录不存在：{root}')
        path = str(root)
        if path not in sys.path:
            sys.path.insert(0, path)
        installed.append(path)
    return installed


def install_stub_package(name, **attributes):
    """把 name 装成一个**能当包用**的桩（子模块自动生成、属性能当基类/装饰器用）。

    `attributes` 里的键会**盖掉**桩属性（`frappe.ValidationError=ValueError`），
    用来把桩调成测试要的形状。

    frappe 的 `throw` 默认**会抛**（StubThrow）—— 桩要是把「本该报错」变成「悄悄继续」，
    判据就会假绿。
    """
    finder = _stub_finder_instance()
    callables = dict(attributes)
    if name == 'frappe':
        callables.setdefault('throw', _stub_throw)
    finder.register(name, callables)
    module = sys.modules.get(name)
    if module is None:
        module = importlib.import_module(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    return module


def install_real_environment(*apps, stub_roots=('frappe', 'pypika')):
    """一站式：真 app 包装进 sys.path ＋ 框架依赖装上桩。

    返回装好的 app 根列表。**同一套装载办法只留这一份**（计划 §十三）。
    """
    installed = install_app_paths(*apps)
    for root in stub_roots:
        install_stub_package(root)
    return installed


def _definition_name(node):
    """模块级定义的名字（函数／类／常量）。不是模块级定义就返回 None。"""
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return node.name
    if isinstance(node, ast.Assign):
        targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
        return targets[0] if len(targets) == 1 else None
    if isinstance(node, ast.AnnAssign):
        return node.target.id if isinstance(node.target, ast.Name) else None
    return None


def _bound_names(node):
    """这个定义内部**自己绑了**的名字（参数／赋值／循环变量／except 名／嵌套定义名）。"""
    bound = set()
    for child in ast.walk(node):
        if isinstance(child, ast.arg):
            bound.add(child.arg)
        elif isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
            bound.add(child.id)
        elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(child.name)
        elif isinstance(child, ast.Import):
            for alias in child.names:
                bound.add(alias.asname or alias.name.split('.')[0])
        elif isinstance(child, ast.ImportFrom):
            for alias in child.names:
                if alias.name != '*':
                    bound.add(alias.asname or alias.name)
        elif isinstance(child, ast.ExceptHandler) and child.name:
            bound.add(child.name)
        elif isinstance(child, (ast.Global, ast.Nonlocal)):
            bound.update(child.names)
    return bound


def _free_names(node):
    """这个定义用到的、**不是自己绑的**名字 —— 它们得从模块里带进来。"""
    bound = _bound_names(node)
    loads = {child.id for child in ast.walk(node)
             if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load)}
    return loads - bound


def load_module_functions(py_path, names, stubs=None, overrides=None, strip_decorators=True):
    """抠源文件里的几个函数，**连它们用到的同文件兄弟函数一起**抠出来。

    为什么：以前每个测试手抄 exec 上下文，漏一个名字就是 NameError ——
    2026-10-15 漏的是 `time`，2026-10-23 漏的是 `_trim_result_summary`／`_audit_row`／
    `_allocate_row_ids`／`_assert_table_headers`／`raw_resource`。现在按名字递归补齐。

    参数
      names            : 要抠的顶层名字（函数／类／常量）。
      stubs / overrides: 交给 import_context（顶层 import 的绑定怎么给）。
      strip_decorators : 默认**去掉装饰器**（真装饰器会包一层域校验，测试多半只测里面的逻辑；
                         需要真装饰器就传 False）。

    返回 exec 好的上下文 dict。
    """
    py_path = Path(py_path)
    tree = ast.parse(py_path.read_text(encoding='utf-8'))
    definitions = {}
    constants = []
    for node in tree.body:
        name = _definition_name(node)
        if not name:
            continue
        definitions[name] = node
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            constants.append(name)
    for name in names:
        if name not in definitions:
            raise SeamError(
                f'{py_path.name} 里没有顶层定义 {name!r} —— 名字写错了，还是源码改了？查清再改。')
    included = set()
    pending = list(names)
    while pending:
        name = pending.pop()
        if name in included:
            continue
        included.add(name)
        for referenced in _free_names(definitions[name]):
            if referenced in definitions and referenced not in included:
                pending.append(referenced)
    # 模块级常量全带上（它们便宜，而且正是手抄最容易漏的那批）。
    included.update(constants)
    ctx = import_context(py_path, stubs=stubs, overrides=overrides)
    body = []
    for name in sorted(included):
        node = definitions[name]
        if strip_decorators:
            node.decorator_list = []
        body.append(node)
    exec(compile(ast.Module(body=body, type_ignores=[]), str(py_path), 'exec'), ctx)
    return ctx
