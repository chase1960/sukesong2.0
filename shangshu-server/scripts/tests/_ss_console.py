"""在容器里跑一段 Frappe 代码（`bench console`）—— **公共件，§13 只留一份**。

**给谁用**：要在**受管上下文**里造样本的用例。有些事**产品故意不让 HTTP 做**，
比如 `files.import_attachment` 带 `mail_system`（所有人/关联邮件）——
`service._mail_sys_fields` 明写「只有受管收信路径能带进来 —— 普通用户动作带上一律拒」。
那类样本只能在 `shangshu_mail.service.writing()` 里造，**不是测试偷懒**。

---
⚠️ **三个坑，都是实测栽过的**（`test_g1_import_attribution.py` 原注释，抄过来一起守）：

1. **必须包成一条 `exec("...")` 再发** —— IPython console 按行读 stdin，
   多行的 `try/except`、`with` 块会被拆散当成多个输入格，只有块外的 `out = {}` 执行了，
   回包就是 `{}`。看着像「产品没行为」，其实是脚手架没跑到。
2. **只认 marker 后面紧跟 JSON 对象的那几行，取最后一个** —— IPython 会回显输入源码，
   `exec("...")` 那一行里也有 marker，会跟真回包撞车。
3. **夹具先 `frappe.db.commit()`** —— 公共动作在失败路径上会 `frappe.db.rollback()`
   再落一行失败记账并提交（那是动作自己的事务边界，是对的）。测试整段跑在未提交事务里时，
   夹具会被那把回滚一起卷走，随后报「找不到执行身份」这种**次生错误**，把真正要验的盖住。

---
⚠️ **已知重复（待折叠，本轮不动）**：`test_g1_import_attribution.py` 里有一份内联的
`run_managed_import` 用的就是这套（同一台容器、同一个 marker 套路）。按 §13 该折到本模块，
但它跑起来是「导入即执行」的脚本，**import 它会顺手把它的用例跑一遍**，不好收。
先立这份，下次谁动那个文件时一起收（同 `names_in` 对 `catalog_contains` 那条同族）。

用法：

    import _ss_console
    out = _ss_console.run('''
        from shangshu_mail.service import writing
        with writing():
            ...
        RESULT['x'] = 1
    ''')
    out['x']
"""
import json
import os
import subprocess

# ⚠️ **容器不能写死一个实例**（F 2026-10-19 修）：
# 原来写死 `shangshu-local-d-frappe-1`。d 实例一停，**凡是用本模块造样本的用例
# 全部前置不成立**，而且报出来的是 `container ... is not running`——
# 看着像「产品没行为/判据不成立」，真因是**脚手架指向一台不运行的机器**（栽过）。
# 现在按 **BASE 端口推容器**（与 `_ss_cred` 同一套路），并留 `SS_CONTAINER` 显式覆盖。
# 端口没有登记时**退回 d**（保持旧行为，不让没登记的用例突然换机器）。
#
# BASE 端口 → frappe 容器名。**新增实例先在这里登记**，否则退回默认。
CONTAINER_BY_PORT = {
    '3850': 'shangshu-local-r967-frappe-1',
    '3852': 'shangshu-local-green-frappe-1',
    '3840': 'shangshu-local-d-frappe-1',
    '3830': 'shangshu-local-c-frappe-1',
    '3820': 'shangshu-local-b-frappe-1',
}


def _container_for(base_url, default):
    port = str(base_url or '').rsplit(':', 1)[-1].strip('/')
    return CONTAINER_BY_PORT.get(port, default)


CONTAINER = os.environ.get('SS_CONTAINER') or _container_for(
    os.environ.get('SS_BASE') or '', 'shangshu-local-d-frappe-1')
BENCH_DIR = '/home/frappe/frappe-bench'
SITE = 'shangshu.localhost'
_MARKER = 'SSC_RESULT '


def purge_users(prefix, keep=(), tag=None):
    """**开跑先清历史残留的合成账号**（只删给定前缀），回删掉的邮箱列表。

    ⚠️ **为什么需要**：判据靠 `finally` 删账号 —— 但**中途失败/被打断时 `finally` 跑不到**，
    账号留到下一轮：用户已存在、口令不是本次那份 → 后段登录 **401**，
    看起来像「权限被拒」，其实是**上一轮的垃圾**（B 2026-10-17 在 3820 实撞）。

    **靠「跑完删除」不够，要「开跑先清」。**

    `keep`：本次要用的邮箱，**不删**。
    `tag`：拼进删除动作的幂等标记（可省）。
    """
    keep = {str(x).lower() for x in (keep or ()) if x}
    code = (
        'RESULT["gone"] = []\n'
        '_emails = frappe.get_all("User", filters={"email": ["like", __P__]},\n'
        '                         pluck="email", limit_page_length=500)\n'
        '_keep = set(%r)\n'
        'for _em in _emails:\n'
        '    if str(_em).lower() in _keep:\n'
        '        continue\n'
        '    try:\n'
        '        frappe.db.sql("delete from `tabUser` where email=%%s", _em)\n'
        '        RESULT["gone"].append(_em)\n'
        '    except Exception:\n'
        '        pass\n'
        'frappe.db.commit()\n' % (tuple(keep),)
    ).replace('__P__', repr(str(prefix)))
    out = run(code)
    return out.get('gone') or []


def run(code, user='Administrator', timeout=240):
    """在容器里跑 `code`，回它写进 `RESULT` 的字典。**失败时回 `{'error': ...}`，不抛**。

    `code` 里可以随便用 `frappe`；想带出结果就往 **`RESULT`** 里写（本模块预置的空 dict）。
    """
    # ⚠️ **用户代码必须 `exec` 进同一个 `globals()`** —— 否则**嵌套函数看不见顶层赋的名**。
    # 实测最小复现：`pwd='X1'; RESULT['before']=pwd` 成功，但
    # `def f(): RESULT['inside']=pwd` 报 `NameError: pwd is not defined`。
    # 原因是 `exec` 在分家的 globals/locals 下跑：赋值进 locals，而函数的
    # `__globals__` 指的是 globals，闭包捞不着。**看着像代码写错了，其实是架子坑。**
    # 所以显式 `exec(__CODE__, _G)`，`RESULT` 也显式塞进 `_G`。
    wrapped = (
        'import json as _json, traceback as _tb\n'
        '_G = globals()\n'
        "_G['RESULT'] = {}\n"
        'try:\n'
        '    exec(' + repr(code) + ', _G)\n'
        'except Exception as _e:\n'
        '    _G["RESULT"]["__error__"] = "%s: %s" % (type(_e).__name__, _e)\n'
        '    _G["RESULT"]["__trace__"] = _tb.format_exc()[-900:]\n'
        'print(' + repr(_MARKER)
        + ' + _json.dumps(_G["RESULT"], ensure_ascii=False, sort_keys=True, default=str))\n'
    )
    prelude = (
        'import frappe\n'
        'frappe.init(site=%r, sites_path=%r)\n'
        'frappe.connect()\n'
        'frappe.set_user(%r)\n' % (SITE, BENCH_DIR + '/sites', user)
    )
    p = subprocess.run(
        ['docker', 'exec', '-i', '-w', BENCH_DIR, CONTAINER,
         'bash', '-c', 'bench --site %s console' % SITE],
        input='exec(%s)\nexit()\n' % repr(prelude + wrapped),
        capture_output=True, text=True, timeout=timeout)

    # **只认 marker 后紧跟 `{` 的行，取最后一个**（IPython 回显会撞车）。
    hits = []
    for line in p.stdout.splitlines():
        if _MARKER not in line:
            continue
        tail = line[line.index(_MARKER) + len(_MARKER):].strip()
        if tail.startswith('{'):
            hits.append(tail)
    if not hits:
        return {'__error__': '没解析到 JSON 回包。原始输出尾部：%s'
                             % ((p.stdout + p.stderr)[-700:])}
    try:
        return json.loads(hits[-1])
    except ValueError:
        return {'__error__': '回包不是合法 JSON：%s' % hits[-1][:300]}
