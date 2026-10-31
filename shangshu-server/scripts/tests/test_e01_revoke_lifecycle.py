"""R967-E · Goal 第 4 条后半 + 第 3 条「计数」维度：**撤权生命周期**与**计数不漏**。

**测试通过 = 下面每条成立**：

1. **正对照**：同一客户端、同一会话，撤权前 `files.review` 200、下载旧 ref 拿得到字节。
2. ★ **撤权后·同一会话立刻拒** —— **不重新登录**，同一个 cookie 会话再读：
   被拒。**这是「旧会话不沿旧权限」的运行时证据**（不是读代码推断「每请求现算」）。
3. ★ **撤权前拿到的下载 ref 撤权后不能用** —— 同一个 `ref` 字符串再请求：
   被拒。**证明 ref 不是「已签能力凭证」**（产品没有 token/过期，撤权即失效）。
4. **计数按权限走** —— 同一筛选下，只能看到 1 份文件的人拿到的 `total` 是 **1**，
   管理员是 **2**。**计数不能比可见行多**（口径 `账号与权限.md:152`
   「计数与摘要同样检查」）。

---

**为什么单独一组**：交付文档原先对「撤权后旧会话/缓存/已签引用」只写了**读代码的结论**
（`http.file_content` 每请求调 `can_download_reference`）。按本窗纪律，
**源码核对不算运行复测** —— 本组把结论变成可重跑的观测。

**⚠️ 本组不验「流式结果」**：文件域没有流式出口；Assistant 的 SSE 属 D 域，另判。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_e01_revoke_lifecycle.py
"""
import base64
import importlib.util
import os
import sys
from io import BytesIO


ROOT = os.environ.get('SS_ROOT',
                      '/path/to/workspace')


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT + path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


t = _load('t', '/shangshu-server/scripts/test-n2-structure.py')
_ss_seed = _load('_ss_seed', '/shangshu-server/scripts/tests/_ss_seed.py')
_ss_cred = _load('_ss_cred', '/shangshu-server/scripts/tests/_ss_cred.py')
_ss_console = _load('_ss_console', '/shangshu-server/scripts/tests/_ss_console.py')

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3840')
USER = os.environ.get('SS_D_USER', 'Administrator')
PW = os.environ.get('SS_D_PW') or _ss_cred.admin_pw_for(BASE)

checks, fails, not_yet = [], [], []


def check(label, valid, detail=''):
    checks.append(label)
    if valid is None:
        not_yet.append(label)
        print('  ~ %s%s' % (label, ('　—　' + str(detail)[:200]) if detail else ''))
        return False
    if not valid:
        fails.append(label)
    print('  %s %s%s' % ('✓' if valid else '✗', label,
                         ('　—　' + str(detail)[:200]) if detail else ''))
    return bool(valid)


print('== R967-E / 撤权生命周期 + 计数不漏 ==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)

RUN = str(os.getpid())
READER = 'e17-reader-%s@example.invalid' % RUN
PWD = 'E17-test-%s' % RUN
MARK = 'E17计数-%s' % RUN

# ---------- 造样：两张同名前缀的表，只共享其中一张给读者 ----------
# 用**两张**是为了让「计数」有区分度：管理员 total=2、读者 total=1。
# 用**同一前缀**是为了让同一个 `q` 筛选同时命中两张。
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = 'E17'
ws.append(['名称', '金额'])
ws.append(['E17', 1])
_buf = BytesIO(); wb.save(_buf)
B64 = base64.b64encode(_buf.getvalue()).decode()

SEED = r'''
import json, frappe
from shangshu_core.public_api import execute_registered_action
from shangshu_core import field_access  # noqa: F401

run = __RUN__
reader = __READER__
pwd = __PWD__
mark = __MARK__
RESULT = {}

def mk_user(em, fn):
    if not frappe.db.exists('User', em):
        frappe.get_doc({'doctype': 'User', 'email': em, 'first_name': fn,
                        'send_welcome_email': 0,
                        'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
    u = frappe.get_doc('User', em); u.new_password = pwd; u.save(ignore_permissions=True)

mk_user(reader, 'E17读者')
frappe.db.commit()
# **建完立刻核实落库** —— 建用户没提交时下游 401 会被误读成「权限被拒」
RESULT['user_landed'] = bool(frappe.db.exists('User', reader))

def upload(name, key):
    out = execute_registered_action('files.upload', {
        'file_name': name + '.xlsx', 'content_base64': __B64__, 'directory': '/',
        'attribution': {'level': 'personal', 'owner_user': 'Administrator'}},
        confirmed=True, idempotency_key=key)
    return (out.get('result') or {}).get('file') or ''

A = upload(mark + '-A', 'e17-up-a-' + run)   # ← 共享给读者
B = upload(mark + '-B', 'e17-up-b-' + run)   # ← 不共享
frappe.db.commit()
RESULT['a'] = A
RESULT['b'] = B
RESULT['both_landed'] = bool(A) and bool(B) and A != B

# 共享 edit 给读者（有读权，也有下载资格 —— 下载还需字段全可读，本表无暗列）
if A:
    execute_registered_action('platform.org.share_grant',
        {'resource': A, 'user': reader, 'access': 'edit'},
        confirmed=True, idempotency_key='e17-share-' + run)
    frappe.db.commit()
RESULT['share_ok'] = bool(frappe.db.exists('Shangshu Org Grant',
                                           {'kind': 'share', 'resource': A, 'grantee_user': reader}))

# **计数**：同一个筛选 `q=mark`、`scope=sheet`，两种身份各查一次。
# 计数走 `domain.query`（产品自己的数据集口；HTTP 数据集端点未在白名单，
# 但这仍是**运行面**：真实权限钩、真实 SQL，不是读代码）。
from shangshu_files import domain as _dom
def total_as(who):
    frappe.set_user(who)
    try:
        r = _dom.query('files.file', {'q': mark, 'scope': 'sheet'})
        return r.get('total'), [x.get('name') for x in (r.get('rows') or [])]
    finally:
        frappe.set_user('Administrator')

frappe.set_user('Administrator')
RESULT['total_admin'], RESULT['rows_admin'] = total_as('Administrator')
RESULT['total_reader'], RESULT['rows_reader'] = total_as(reader)
frappe.db.commit()
'''

_purged = _ss_console.purge_users('e17-reader-%', keep=(READER,))
if _purged:
    print('  （清掉历史残留账号 %d 个）' % len(_purged))

out = _ss_console.run(SEED
                      .replace('__RUN__', repr(RUN))
                      .replace('__READER__', repr(READER))
                      .replace('__PWD__', repr(PWD))
                      .replace('__MARK__', repr(MARK))
                      .replace('__B64__', repr(B64)))
A = out.get('a') or ''
B = out.get('b') or ''
print('  表A(共享)=%r 表B(不共享)=%r share=%r err=%r'
      % (A, B, out.get('share_ok'), out.get('__error__')))

try:
    ok_seed = (out.get('user_landed') is True and out.get('both_landed') is True
               and out.get('share_ok') is True and bool(A) and bool(B))
    check('0 前置·两张表 + 读者账号 + 共享都真落库', ok_seed,
          'user_landed=%r both_landed=%r share=%r err=%r'
          % (out.get('user_landed'), out.get('both_landed'),
             out.get('share_ok'), out.get('__error__')))

    if not ok_seed:
        for lab in ('1 正对照：撤权前读得到、下得到',
                    '2 ★ 撤权后·同一会话立刻拒（不走缓存）',
                    '3 ★ 撤权前拿到的下载 ref 撤权后不能用',
                    '4 计数按权限走（读者 1 / 管理员 2）'):
            check(lab, None, '前置没造出来，整组不判（不假装验过）')
    else:
        # ---------- 4 计数（不依赖撤权，先判）----------
        ta, tr = out.get('total_admin'), out.get('total_reader')
        rows_r = out.get('rows_reader') or []
        check('4 计数按权限走 —— 同一筛选下读者 total=1、管理员 total=2（计数不比可见行多）',
              (ta == 2) and (tr == 1) and (len(rows_r) == 1),
              '管理员 total=%r（rows=%r）　读者 total=%r（rows=%r）'
              % (ta, out.get('rows_admin'), tr, rows_r))

        reader = t.Client(BASE)
        reader.login(READER, PWD)

        def _read(cli):
            st, body = t.service(cli, 'files.review', {'file': A})
            r = _ss_seed._result(st, body) or {}
            return st, (r.get('file') or {}), _ss_seed._err(body)

        def _ref(cli):
            refs = _ss_seed._result(*t.service(cli, 'files.versions', {'file': A}))
            v = (refs.get('versions') or [{}])[0]
            return (v.get('source') or {}).get('ref') or (v.get('source') or {}).get('file') or ''

        # ---------- 1 正对照（撤权前）----------
        st_b, f_b, err_b = _read(reader)
        REF = _ref(reader)          # ★ **先拿到 ref**，撤权后原样再请求
        st_d1, body_d1 = t.download(reader, A, REF)
        ok_before, _ = _ss_seed._got_bytes(st_d1, body_d1)
        check('1 正对照：撤权前 `files.review` 200 且旧 ref 下得到字节',
              (st_b == 200) and bool(f_b) and ok_before,
              'review HTTP %s file=%r　下载 HTTP %s 拿到字节=%r　ref=%r'
              % (st_b, bool(f_b), st_d1, ok_before, REF[:40]))

        # ---------- 撤权（管理员做，读者会话不动）----------
        rev = _ss_console.run('''
from shangshu_core.public_api import execute_registered_action
import frappe
FLT = {'kind': 'share', 'resource': __A__, 'grantee_user': __WHO__}
# **撤之前先确认那一行真在** —— 否则「撤后没有了」是空判（撤没撤都一样）
RESULT['before'] = bool(frappe.db.exists('Shangshu Org Grant', FLT))
execute_registered_action('platform.org.share_revoke',
    {'resource': __A__, 'user': __WHO__},
    confirmed=True, idempotency_key='e17-revoke-' + __RUN__)
RESULT['left'] = bool(frappe.db.exists('Shangshu Org Grant', FLT))
frappe.db.commit()
'''.replace('__A__', repr(A)).replace('__WHO__', repr(READER))
    .replace('__RUN__', repr(RUN)))
        left = rev.get('left')
        had = rev.get('before')
        print('  撤权：撤前有共享行=%r 剩余共享行=%r err=%r'
              % (had, left, rev.get('__error__')))

        # ---------- 2 同一会话立刻拒 ----------
        st_a, f_a, err_a = _read(reader)
        check('2 ★ 撤权后·**同一个客户端会话**（不重登）再读 → 拒（不走缓存）',
              (had is True) and (left is False) and (st_a != 200),
              '撤前共享行=%r 撤后=%r　撤权后 review HTTP %s file=%r 拒因=%r（撤权前 HTTP %s）'
              % (had, left, st_a, bool(f_a), err_a[:110], st_b))

        # ---------- 3 旧 ref 不能用 ----------
        st_d2, body_d2 = t.download(reader, A, REF)
        ok_after, _ = _ss_seed._got_bytes(st_d2, body_d2)
        msg = _ss_seed._dl_err(st_d2, body_d2)
        check('3 ★ **撤权前拿到的同一个 ref** 撤权后再请求 → 拒（ref 不是已签能力凭证）',
              (not ok_after) and (st_d2 != 200),
              '同一个 ref：撤权前 HTTP %s 拿到字节=True　撤权后 HTTP %s 拿到字节=%r 拒因=%r'
              % (st_d1, st_d2, ok_after, msg[:110]))
finally:
    _ss_console.run('''
import frappe
for _n in (__A__, __B__):
    if _n:
        try:
            frappe.db.sql('delete from `tabShangshu File Center File` where name=%s', _n)
        except Exception:
            pass
try:
    frappe.db.sql("delete from `tabShangshu Org Grant` where grantee_user=%s", __READER__)
    frappe.db.sql('delete from `tabUser` where email=%s', __READER__)
except Exception:
    pass
frappe.db.commit()
'''.replace('__A__', repr(A)).replace('__B__', repr(B))
    .replace('__READER__', repr(READER)))

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet:
    print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  (('PASS R967-E / 撤权生命周期 + 计数不漏（%d 条）' % len(checks))
                   if not not_yet else
                   ('**未判** R967-E / 撤权生命周期（断言 %d 条，**未跑 %d 条**）'
                    % (len(checks), len(not_yet))))))
print('⚠️ 本组只判**文件域**。Assistant 流式属 D 域，另判。')
sys.exit(1 if (fails or not_yet) else 0)
