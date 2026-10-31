# -*- coding: utf-8 -*-
"""**拟真 `frappe` 替身 —— 全仓只许这一份**（仓库约定 §13「公共工具只留一份」）。

**这一份是谁的**：example 域的判据（`example_extension/tests/frappe_stub.py` 现在只是**转发**到这里）
与 device_client 域的判据（引导包那个）**共用同一份实现** ⇒ 改一处，两个域一起跟上。

**为什么要有它**（2026-10-25 实测撞出来的，PKG-109／PKG-110）：
域判据要在**没有站点的机器上**把 `frappe` 装上，好让域代码在导入期就能 import 它
（域声明 → `shangshu_core.public_api` → 一串内核模块在**导入期**要
`from frappe.utils import now_datetime`、`from frappe.utils.password import encrypt, decrypt`、
`from frappe.core.doctype.file.file import File`、`from frappe.model.naming import make_autoname`……
`from pypika import Criterion, Order`……）。

**它必须「能当包用」**（`__path__` 有）⇒ 否则 `frappe.utils.password` 挂不上
⇒ 实测 device_client 那 10 条判据就是这么炸的：`No module named 'frappe.utils'; 'frappe' is not a package`。

**它故意不提供 `frappe.tests.*`** —— 理由见 `shangshu_testkit/__init__.py` 的说明
（提供了 ⇒ example 那 **141 条「站上才跑」的判据会假装能跑** ⇒ 假绿）。

**基座＝example 域原来那份替身，一个字不多**（多给一个名字就可能改掉 example 的行为）
⇒ device_client 额外要的那几样（`session`／`conf`／`local`／`get_app_path` 等）
**由调用方用 `**attributes` 覆盖** ⇒ 各域要自己的值，不互相污染。

**用法**（域判据里的样子）：

    from shangshu_testkit import frappe_stub

    installed = frappe_stub.install_minimal_frappe()          # 装
    self.addCleanup(frappe_stub.uninstall_minimal_frappe, installed)   # 撤（谁装谁撤）
"""
import ast
import datetime
import sys
import types

# —— **替身装的是哪些模块**（撤的时候照这个撤，一样都不留残骸）——
STUB_MODULES = (
    "frappe",
    "frappe.utils",
    "frappe.utils.password",
    "frappe.utils.file_manager",
    "frappe.utils.response",
    "frappe.model",
    "frappe.model.naming",
    "frappe.model.document",
    "frappe.model.workflow",
    "frappe.core",
    "frappe.core.doctype",
    "frappe.core.doctype.file",
    "frappe.core.doctype.file.file",
    "frappe.sessions",
)

# —— **被顶掉的那份**（`force=True` 时是**真 frappe**；撤的时候要还回去）——
_previous = {}


def real_frappe_present():
    """这台机器上**有真 frappe**吗？（站上有；离线没有）

    ⚠️ **判别方式**：**真 frappe 是磁盘上的真包**（有 `__file__`）；
    离线上装的是**内存里的替身**（`types.ModuleType`，没有 `__file__`）。
    ⚠️ **不能用 `hasattr`** —— 替身给 `frappe` 挂了 `__getattr__` 兜底 ⇒ 什么属性都「有」。
    ⚠️ **不主动 import** —— 只看**已经在** `sys.modules` 里的那个：
    否则「探一下有没有真 frappe」这个动作本身就会把替身装上（副作用）。
    """
    module = sys.modules.get("frappe")
    if module is None:
        return False
    return bool(vars(module).get("__file__"))


def frappe_present():
    """这台机器上**有没有 frappe**（不管是真的还是替身）？

    ⚠️ **为什么要有这一口**（2026-10-25 实测撞出来的）：
    **站上布局**（bench）里**没有仓库的 tools 区** ⇒ 公共件那一份**够不着**
    ⇒ 域判据那层「转发」就**造不出替身**了。
    ⇒ 那时它只能问这一句：「frappe 在不这儿？」
    —— 在（站上有真 frappe／模拟站上时装上了替身）⇒ **什么都不用做**
    （返回 False ＝ 本进程没装 ⇒ 不该撤）；
    —— 不在 ⇒ **明说取不到**（见转发件里的报错），**不许假装有**。

    ⚠️ **只查 `sys.modules`** —— 不主动 import（理由同 `real_frappe_present`）。
    """
    return sys.modules.get("frappe") is not None


def _module(name, **attributes):
    """造一个**能当包用**的替身模块（`__path__` 有 ⇒ 还能挂子模块）。"""
    module = types.ModuleType(name)
    module.__path__ = []
    for key, value in attributes.items():
        setattr(module, key, value)
    return module


def _fallback(name):
    """**没专门定义的名字都给一个能用的替身**（PEP 562 模块级 `__getattr__`）。

    ⚠️ **为什么要有这个兜底**：这个替身是**装进 `sys.modules` 的全局替身** ⇒
    后面跑的判据（按字母序排）也会看到它 ⇒ 别的判据 import 内核模块时
    （例如 `shangshu_core.domains` 要 `frappe.utils.now_datetime`）
    若撞上一个**没有的名字**，那个判据就会**在导入阶段炸掉** ——
    那是**这个替身连累的**，不是那个判据自己的问题。
    ⇒ 兜底给一个通用替身 ⇒ 别人的判据照旧跑自己的路。
    """

    def _stub(*args, **kwargs):
        return None

    return _stub


class _Logger:
    """日志口（域记警告/错误都走它）—— 离线没有日志 ⇒ 收下就算。

    ⚠️ **为什么不能靠那个兜底**（`__getattr__` 给的是个**返回 None 的函数**）
    ⇒ `frappe.logger("x").warning("...")` 会炸在「`NoneType` 没有 `warning`」
    ⇒ 域那条「记一条警告」的路走不通 ⇒ **判据被环境问题带偏**
    （2026-10-24 实测：域绑清单失败后要记一条警告 ⇒ 就是这么炸的）。
    """

    def __getattr__(self, name):
        def _log(*args, **kwargs):
            return None

        return _log


def install_minimal_frappe(force=False, **attributes):
    """装上拟真替身。

    返回 `True` ＝ **这次是本进程装上去的**（该撤）；
    返回 `False` ＝ **本来就有真 frappe**（站点上跑判据）⇒ **不许撤**。

    `force=True` ⇒ **连真 frappe 也替掉**（有些判据要的是「自己那份环境」：
    例如 device_client 引导包要把安装器写进临时目录 ⇒ `frappe.get_app_path` 必须指那里）。
    `**attributes` ⇒ **盖掉替身上的同名属性**（各域要自己的值，不互相污染）。
    """
    global _previous
    if not force:
        try:
            import frappe  # noqa: F401

            return False
        except ImportError:
            pass
    elif not _previous:
        _previous = {name: sys.modules.get(name) for name in STUB_MODULES}

    frappe = _module("frappe")

    class ValidationError(Exception):
        """没有 frappe 时的等价物（站点上跑判据时用 frappe 自己的）。"""

    frappe.ValidationError = ValidationError
    frappe.PermissionError = type("PermissionError", (Exception,), {})
    frappe.DoesNotExistError = type("DoesNotExistError", (Exception,), {})
    # ⚠️ **幂等/版本冲突那一类**（2026-10-30 · PKG-133 · W2）：内核的「同一把键不是同一件事」
    #   走的是 `frappe.DuplicateEntryError` ⇒ 替身里没有它 ⇒ 那一段会退化成
    #   「不是异常类型」⇒ 判据测不到真实行为。站上用 frappe 自己的。
    frappe.DuplicateEntryError = type("DuplicateEntryError", (Exception,), {})

    def throw(message, exc=ValidationError):
        raise exc(message)

    frappe.throw = throw
    utils = _module("frappe.utils")
    utils.nowdate = lambda: "2026-10-23"
    utils.now_datetime = lambda: datetime.datetime(2026, 10, 23, 12, 0, 0)
    utils.nowtime = lambda: "00:00:00"
    utils.__getattr__ = _fallback

    # —— **密码那几个**（域声明 → 内核公开口在导入期就要 `encrypt` / `decrypt`）——
    def _encrypt(value):
        return "enc:" + str(value)

    def _decrypt(value):
        text = str(value)
        return text[4:] if text.startswith("enc:") else text

    password = _module("frappe.utils.password",
                       encrypt=_encrypt,
                       decrypt=_decrypt,
                       check_password=lambda user, pwd: True,
                       update_password=lambda user, pwd: None,
                       delete_all_passwords_for=lambda user: None,
                       remove_encrypted_password=lambda user, name: None)

    file_manager = _module("frappe.utils.file_manager",
                            save_file=lambda *args, **kwargs: "/tmp/fake-file")
    response = _module("frappe.utils.response", json_handler=lambda obj, *a, **k: obj)
    utils.password = password
    utils.file_manager = file_manager
    utils.response = response

    # —— **命名那几件**（`make_autoname` 之类）—— 域里装单据名要它 ——
    model = _module("frappe.model")
    naming = _module("frappe.model.naming", make_autoname=lambda *a, **k: "AUTO")
    model.naming = naming

    class _Document:
        """桩 frappe 的 Document（导入期只要它存在）。"""

    class _FrappeTestCase:
        """桩 frappe 的 FrappeTestCase（导入期只要它存在）。"""

    class _File:
        """桩 frappe 的 File 文档类型（导入期只要它存在）。"""

    model.document = _module("frappe.model.document", Document=_Document)
    model.workflow = _module("frappe.model.workflow",
                              apply_workflow=lambda *a, **k: None,
                              get_transitions=lambda *a, **k: [])

    # —— **文件那几件**（内核的 `attachments` 在导入期要 `frappe.core.doctype.file.file`）——
    core = _module("frappe.core")
    doctype = _module("frappe.core.doctype")
    file_pkg = _module("frappe.core.doctype.file")
    file_mod = _module("frappe.core.doctype.file.file", File=_File)
    file_pkg.file = file_mod
    doctype.file = file_pkg
    core.doctype = doctype

    sessions = _module("frappe.sessions",
                       get_csrf_token=lambda: "test-csrf-token",
                       clear_sessions=lambda *a, **k: None)

    frappe.__getattr__ = _fallback
    frappe.logger = lambda *args, **kwargs: _Logger()
    frappe.model = model
    frappe.flags = types.SimpleNamespace()
    frappe.core = core
    frappe.sessions = sessions
    frappe.utils = utils

    # —— **各域要自己的值，就在这里盖掉**（最后一步 ⇒ 盖得住）——
    for key, value in attributes.items():
        setattr(frappe, key, value)

    modules = {
        "frappe": frappe,
        "frappe.utils": utils,
        "frappe.utils.password": password,
        "frappe.utils.file_manager": file_manager,
        "frappe.utils.response": response,
        "frappe.model": model,
        "frappe.model.naming": naming,
        "frappe.model.document": model.document,
        "frappe.model.workflow": model.workflow,
        "frappe.core": core,
        "frappe.core.doctype": doctype,
        "frappe.core.doctype.file": file_pkg,
        "frappe.core.doctype.file.file": file_mod,
        "frappe.sessions": sessions,
    }
    for name, module in modules.items():
        sys.modules[name] = module
    return True


def uninstall_minimal_frappe(installed):
    """把替身从 `sys.modules` 里撤掉（**只在真装了的时候撤**）。

    ⚠️ **撤干净**：装了几样就撤几样 ⇒ 撤完不留半个残骸给后面的判据。
    """
    if not installed:
        return False
    for name in STUB_MODULES:
        sys.modules.pop(name, None)
    # `force=True` 顶掉的那份**真 frappe**要还回去。
    for name, module in list(_previous.items()):
        if module is not None:
            sys.modules[name] = module
    _previous.clear()
    return True


# ——————————————————————— **pypika**（frappe 的依赖；离线没装）———————————————————————
PYPIKA_MODULES = ("pypika", "pypika.functions")


def install_minimal_pypika():
    """装上 **pypika 替身**（frappe 的依赖，离线没装 ⇒ 内核的查询构造 import 不到）。

    返回 `True` ＝ **这次是本进程装上去的**（该撤）。
    """
    try:
        import pypika  # noqa: F401

        return False
    except ImportError:
        pass

    class _Criterion:
        """桩 pypika 的 Criterion（查询条件只在真跑查询时才用到 ⇒ 这里只求 import 过）。"""

        @staticmethod
        def all(conditions=None):
            return ("all", conditions)

        @staticmethod
        def any(conditions=None):
            return ("any", conditions)

        @staticmethod
        def equals(field, value):
            return ("equals", field, value)

    class _Order:
        asc = "asc"
        desc = "desc"

    pypika = _module("pypika", Criterion=_Criterion, Order=_Order)
    functions = _module("pypika.functions",
                        Count=lambda *a, **k: "count",
                        Coalesce=lambda *a, **k: "coalesce")
    pypika.functions = functions
    sys.modules["pypika"] = pypika
    sys.modules["pypika.functions"] = functions
    return True


def uninstall_minimal_pypika(installed):
    """把 **pypika 替身**撤掉（**只在真装了的时候撤**）。"""
    if not installed:
        return False
    for name in PYPIKA_MODULES:
        sys.modules.pop(name, None)
    return True


# ——————————————————————— **假公共 API**（域要调跨域动作时用）———————————————————————
def domain_public_api_names(domain_root):
    """域里用到的**公共口**名字（从**域源码**解析 `from shangshu_core.public_api import X`）。

    ⚠️ **为什么解析源码而不是手写清单**：手写就会漏（漏一个 ⇒ 域一调就炸，
    而且报的是「模块没有这个属性」这种**看不出是判据缺件**的错）。
    ⇒ 域加一个口，这里自动跟上。
    """
    names = set()
    for path in sorted(domain_root.glob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (OSError, SyntaxError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "shangshu_core.public_api":
                for alias in node.names:
                    names.add(alias.asname or alias.name)
    return names


def install_minimal_public_api(names):
    """装上**假公共 API**（离线跑那些要调跨域动作的域函数时用）。

    返回 `(module, installed)`：
    · `installed=True` ＝ **这次是本进程装上去的**（该撤）；
    · `installed=False` ＝ **本来就有真的**（站上）⇒ **不许撤**。

    ⚠️ **站上有真 frappe ⇒ 不用假件**（真公共 API 装得上 ⇒ 用真的）；
    离线时**真的那个装不上**（它要 frappe）⇒ 才有假件。
    """
    existing = sys.modules.get("shangshu_core.public_api")
    if existing is not None:
        return existing, False
    if real_frappe_present():
        import shangshu_core.public_api  # noqa: PLC0415

        return sys.modules["shangshu_core.public_api"], False

    # ⚠️ **只换「公共 API」这一个模块，不换整个内核包** ——
    # 整包换成假的 ⇒ 会把真包从 `sys.modules` 里顶掉 ⇒ 别的判据跟着歪。
    # ⚠️ **也不 import 内核包本身**（域只准依赖公开口；域闸也盯着这一条）。
    api = types.ModuleType("shangshu_core.public_api")

    def _stub(*args, **kwargs):
        return {}

    for name in sorted(names):
        setattr(api, name, _stub)
    sys.modules["shangshu_core.public_api"] = api
    return api, True


def uninstall_minimal_public_api(installed):
    """把**假公共 API** 撤掉（**只在真装了的时候撤**）。"""
    if not installed:
        return False
    sys.modules.pop("shangshu_core.public_api", None)
    return True
