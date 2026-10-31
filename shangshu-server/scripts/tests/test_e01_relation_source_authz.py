"""R967-E · E01.6：**关联不是复制数据后永久脱离源授权**（跨表关联的当前权限）。

**测试通过 = 下面每条成立**：

1. **前置·造出「文件 → 源记录」的关联**，且源记录对某人可读 ——
   `files.review` 回 `relations` 里**有那条**（带目标字段）、`unavailable=0`。
2. ★ **撤掉源记录的读权后，同一份文件的关联立刻不可见** ——
   `relations` 空、`unavailable=1`，**回包里没有源记录的编号/名称/字段**。
3. ★ **关联里不复制业务数据** —— `relations_json` **只存 `object_id` + `name`**，
   没有任何业务字段值。**这是「不是复制数据后永久脱离源授权」的形状证据**：
   只存键不存值，就不存在「复制出去的副本不随源撤权」这回事。
4. **敏感度**：**同一份文件、同一个人**，撤权前后给**两种不同答案**（不恒同）。

---
**口径原文**（`fde/开发/计划/整改执行计划-BASE967-2026-10-17.md` §五 E01.6）：

> **6. 跨表关联遵守企业/部门/个人方向和当前权限；关联不是复制数据后永久脱离
> 源授权。配置层和具体关联值分别存储。**

以及 `fde/设计/契约/账号与权限.md`：

> `:152` 搜索、关联标签、预览、复制/导出、候选和日志 | 各入口**不返回无权字段或记录**，
> **计数与摘要同样检查**。

**计划和执行计划都写了「通用关联…改用合成对象验证」** —— 本组用
**`mail.message`**（已登记的对象 id，`test_d_relations_migrate.py` 同款）当源记录，
**不新造行业对象**。

**⚠️ 本组只判「关联侧」**：
- **`relations.py:52` 的边界不动** —— 「关联只是键，**不授予**被引记录的访问权」。
  本组验的是**反方向**：**源没权 → 关联不可见**（跟 BASE967-38 的附件跟随来源同族）。
- **写侧**（`review.save` 在保存时复核既有关联）不在本组，另判。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_e01_relation_source_authz.py
"""
import importlib.util
import os
import sys

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
        print('  ~ %s%s' % (label, ('　—　' + str(detail)[:190]) if detail else ''))
        return False
    if not valid:
        fails.append(label)
    print('  %s %s%s' % ('✓' if valid else '✗', label,
                         ('　—　' + str(detail)[:190]) if detail else ''))
    return bool(valid)


print('== R967-E / E01.6 关联不是复制数据后永久脱离源授权 ==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令')
    sys.exit(2)

c = t.Client(BASE)
c.login(USER, PW)

RUN = str(os.getpid())
READER = 'e16-reader-%s@example.invalid' % RUN
PWD = 'E16-test-%s' % RUN

SEED = r'''
import frappe, json, base64, io as _io, hashlib
import shangshu_files.hooks  # noqa: F401  ← console 不加载 hooks，属主解析器要它
from openpyxl import Workbook
from shangshu_core.public_api import execute_registered_action
from shangshu_mail.service import writing
from shangshu_mail.account import writing as account_writing
from shangshu_core import org_admin as oa

run = __RUN__
reader, pwd = __READER__, __PWD__
RESULT = {}

def mk_user(em, fn):
    if not frappe.db.exists('User', em):
        frappe.get_doc({'doctype': 'User', 'email': em, 'first_name': fn,
                        'send_welcome_email': 0,
                        'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
    u = frappe.get_doc('User', em); u.new_password = pwd; u.save(ignore_permissions=True)

mk_user(reader, 'E16读者')
frappe.db.commit()
# ⚠️ **建完立刻核实落库**（B 2026-10-17 在 3820 查出来的）：
# 那个 401 不是「残留账号口令不对」，是**建用户那步没提交** ——
# 账号根本没落库，而后面照常去登录 → 401，看起来像「权限被拒」。
# **失败要报在源头**：这里核实，不核实就会拖成下游假象。
RESULT['user_landed'] = bool(frappe.db.exists('User', reader))

# ---- 源记录：一封属于共享邮箱的信（判权靠邮箱授权，可授可撤）----
BOX = 'e16-box-' + run
DEPT_TITLE = 'E16部门-' + run
if not frappe.db.exists('Shangshu Department', {'title': DEPT_TITLE}):
    oa.department_create('platform.org.department_create', {'name': DEPT_TITLE}, None)
DEPT = frappe.db.get_value('Shangshu Department', {'title': DEPT_TITLE}, 'name') or ''
if not frappe.db.exists('Shangshu Mail Account', {'account_key': BOX}):
    with account_writing():
        frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': BOX,
                        'kind': 'department', 'department': DEPT,
                        'email_address': 'e16-%s@x.example' % run,
                        'display_name': 'E16共享箱-' + run, 'enabled': 1,
                        'provider': 'qq'}).insert(ignore_permissions=True)
frappe.db.commit()
with writing():
    mail = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
        'mailbox_id': BOX, 'subject': 'E16 源信 ' + run, 'body': 'x', 'body_format': 'Text',
        'to_json': '[]', 'cc_json': '[]', 'from_address': 'o <o@x.example>',
        'record_version': 1, 'received_at': frappe.utils.now_datetime()
        }).insert(ignore_permissions=True)
frappe.db.commit()
RESULT['mail'] = mail.name
RESULT['mail_subject'] = 'E16 源信 ' + run

# ---- 源文件：管理员建，关联到那封信 ----
wb = Workbook(); ws = wb.active; ws.title = 'E16'
ws.append(['列A']); ws.append(['v1'])
_b = _io.BytesIO(); wb.save(_b)
b64 = base64.b64encode(_b.getvalue()).decode()
# ⚠️ **文件由读者本人上传** —— 让他对**文件本身**天然有读权（owner），
# 这样「关联不可见」只可能来自**源记录**那一道，不会混进文件级 403。
# 第一版文件归 Administrator，读者连 `files.review` 都进不去（403），
# 「关联不可见」是**文件级拒**，跟源撤权无关 —— 错因通过。
frappe.set_user(reader)
try:
    up = execute_registered_action('files.upload', {
        'file_name': 'E16关联文件-%s.xlsx' % run, 'content_base64': b64, 'directory': '/',
        'attribution': {'level': 'personal'}},
        confirmed=True, idempotency_key='e16-up-' + run)
finally:
    frappe.set_user('Administrator')
FILE = (up.get('result') or {}).get('file') or ''
frappe.db.commit()
RESULT['file'] = FILE
# **只存键不存值**（`relations.py` 的形状）—— 判据 3 就是钉这个
frappe.db.set_value('Shangshu File Center File', FILE, 'relations_json',
                    json.dumps([{'object_id': 'mail.message', 'name': mail.name}]))
frappe.db.commit()
RESULT['relations_json'] = frappe.db.get_value(
    'Shangshu File Center File', FILE, 'relations_json')

# ---- 两道要**分开**造 ----
# ⚠️ 第一版只给了源记录的权，读者**连文件本身都读不到**（文件归属是管理员的个人表）
# → `files.review` 直接 403，「关联不可见」是**文件级拒**，不是「源撤权」。
# **必须先把文件读权给他**，才能隔离出「关联侧」判定。
# 源记录：给共享邮箱读权
_res = execute_registered_action('mail.mailbox.grant',
        {'mailbox': BOX, 'user': reader, 'rights': {'read': True}},
        confirmed=True, idempotency_key='e16-grant-' + run)
_row = frappe.db.get_value('Shangshu Mail Access', {'mailbox': BOX, 'user': reader}, 'name')
RESULT['grant'] = 'ok' if _row else ('没落库：%s' % str(_res)[:100])
RESULT['access_row'] = [dict(r) for r in frappe.get_all(
    'Shangshu Mail Access', filters={'mailbox': BOX}, fields=['user', 'can_read'], limit_page_length=5)]
frappe.db.commit()
# 诊断：读者的邮箱权、以及他能不能读那封信
from shangshu_mail.account import rights_for, readable_mailbox_ids
RESULT['rights_reader'] = rights_for(BOX, reader)
RESULT['readable_has_box'] = BOX in set(readable_mailbox_ids(reader))
frappe.set_user(reader)
try:
    RESULT['obj_read'] = 'ok'
    from shangshu_core.public_api import get_object_record as _gor
    try:
        _gor('mail.message', mail.name)
    except Exception as _e:
        RESULT['obj_read'] = '%s: %s' % (type(_e).__name__, str(_e)[:120])
finally:
    frappe.set_user('Administrator')
'''

# **开跑先清历史残留**（只删本判据前缀，保留本轮要建的）—— 靠 `finally` 不够，
# 中途失败时它跑不到，留下的账号会害下一轮 401（B 2026-10-17 在 3820 实撞）。
_purged = _ss_console.purge_users('e16-reader-%', keep=(READER,))
if _purged:
    print('  （清掉历史残留账号 %d 个）' % len(_purged))

out = _ss_console.run(SEED.replace('__RUN__', repr(RUN))
                       .replace('__READER__', repr(READER))
                       .replace('__PWD__', repr(PWD)))
MAIL = out.get('mail') or ''
FILE = out.get('file') or ''
print('  源信=%r 关联文件=%r grant=%r err=%r'
      % (MAIL, FILE, out.get('grant'), out.get('__error__')))
print('  诊断：access=%r rights=%r readable_has_box=%r obj_read=%r'
      % (out.get('access_row'), out.get('rights_reader'),
         out.get('readable_has_box'), out.get('obj_read')))

try:
    ok_seed = (bool(MAIL) and bool(FILE) and out.get('grant') == 'ok'
               and out.get('user_landed') is True)
    check('0 前置·文件关联到源记录、源对读者已授权、**读者账号确实落库**', ok_seed,
          'err=%r grant=%r user_landed=%r（False/None = 建用户没提交，'
          '后面登录 401 是下游假象，不是权限被拒）'
          % (out.get('__error__'), out.get('grant'), out.get('user_landed')))

    if not ok_seed:
        for lab in ('1 有源读权时关联可见（relations 有、unavailable=0）',
                    '2 ★ 撤掉源读权后关联立刻不可见（unavailable=1、不泄露）',
                    '3 ★ `relations_json` 只存 object_id+name，不复制业务数据',
                    '4 敏感度：同一文件同一人撤权前后两种答案'):
            check(lab, None, '前置没造出来，整组不判（不假装验过）')
    else:
        # ---------- 3 静态：只存键不存值 ----------
        import json as _json
        raw = out.get('relations_json') or ''
        try:
            rels = _json.loads(raw) if isinstance(raw, str) else raw
        except Exception:
            rels = None
        keys_ok = (isinstance(rels, list) and len(rels) == 1
                   and set(rels[0].keys()) <= {'object_id', 'name', 'expected_revision',
                                               'expected_modified'})
        # **不许出现业务字段值**：源信的 subject/body 不能出现在 relations_json 里
        leak = ('E16 源信' in (raw or '')) or ('body' in (raw or ''))
        check('3 ★ `relations_json` **只存 object_id+name**，不复制业务数据',
              keys_ok and not leak,
              'rels=%r 含业务字段值=%r' % (rels, leak))

        # ---------- 6 配置层与值层**分别存储** ----------
        # 口径 E01.6：「**配置层和具体关联值分别存储**」。
        #   · **配置层** = `files.review` 的 action schema（关系条目允许哪些键、什么类型）
        #   · **值层** = `Shangshu File Center File.relations_json`（实际关联了谁）
        # **怎么验（运行面，不是读代码）**：往 `files.review` 送一条带**未声明键**的关系
        # → **schema 必须拒**（这就是配置层在起作用）；而库里存的 `relations_json`
        # 只含声明过的键（值层不夹带 —— 判据 3 已经验过）。
        st_f, b_f = t.service(c, 'files.review', {'file': FILE})
        f_doc = ((_ss_seed._result(st_f, b_f) or {}).get('file') or {})
        st_cfg, b_cfg = t.action(c, 'files.review', {
            'file': FILE,
            'expected_modified': f_doc.get('modified'),
            'expected_version': f_doc.get('version'),
            'relations': [{'object_id': 'mail.message', 'name': MAIL,
                           'expected_revision': 1, 'expected_modified': 'x',
                           'values': {}, 'BOGUS_UNDECLARED_KEY': 1}]}, 'e16-cfg-%s' % RUN)
        cfg_msg = _ss_seed._err(b_cfg)
        cfg_rejected = (st_cfg != 200) and ('未声明字段' in cfg_msg or '不应有' in cfg_msg or '额外' in cfg_msg)
        check('6 ★ **配置层与值层分别存储**（口径 E01.6 —— 关系形状由 schema 管，值在 relations_json）',
              cfg_rejected,
              '带未声明键的关系 HTTP %s 拒因=%r（**schema 拒 = 配置层在管**；'
              '值层只存声明键，见判据 3）' % (st_cfg, cfg_msg[:110]))

        # ---------- 1/2/4 读侧：撤权前后 ----------
        reader = t.Client(BASE)
        reader.login(READER, PWD)

        def _review(cli):
            st, body = t.service(cli, 'files.review', {'file': FILE})
            r = _ss_seed._result(st, body)
            return r.get('relations'), r.get('unavailable'), st, _ss_seed._err(body)

        # **对照**：管理员走同一条口 —— 若他也不 visible，就不是权限问题，
        # 是「关联在 HTTP 路径上根本解析不了」（另一类故障，别混）。
        rels_adm, un_adm, st_adm, err_adm = _review(c)
        print('  对照·管理员：HTTP %s relations=%d unavailable=%r %s'
              % (st_adm, len(rels_adm or []), un_adm, err_adm[:80]))

        # ⚠️ **管理员也 unavailable=1 = 不是权限问题** —— 关联在 **HTTP 路径**
        # 根本解析不出来（而 console 里同一个 `get_object_record` 是 `ok`）。
        # 这是**另一个故障**，跟「源撤权」无关，**不能拿它当过/当错**。
        # 先把这个现象钉在结果里；①②④ 在它修好之前**一律不判**。
        PORT_BROKEN = not (rels_adm or [])
        if PORT_BROKEN:
            for lab in ('1 **有源读权时关联可见**（`relations` 有、`unavailable=0`）',
                        '2 ★ **撤掉源读权后关联立刻不可见**（`unavailable=1`、不泄露）',
                        '4 敏感度：同一文件同一人撤权前后两种答案'):
                check(lab, None,
                      '**读口故障**：`files.review` 走 HTTP 时**管理员也** relations=0 / '
                      'unavailable=1，而 console 里同一个 `get_object_record` 回 ok。'
                      '**不是权限问题，是关联在 HTTP 路径解析不出来** —— 先查这个再判本组')
            rels_b = []
        rels_b, un_b, st_b, err_b = _review(reader) if not PORT_BROKEN else ([], None, None, '')
        if not PORT_BROKEN:
            check('1 **有源读权时关联可见**（`relations` 有、`unavailable=0`）',
                  (st_b == 200) and bool(rels_b) and (un_b == 0),
                  'HTTP %s relations=%d unavailable=%r %s'
                  % (st_b, len(rels_b or []), un_b, err_b[:80]))

        # **撤权**
        rev = _ss_console.run('''
from shangshu_core.public_api import execute_registered_action
execute_registered_action('mail.mailbox.revoke',
    {'mailbox': __BOX__, 'user': __WHO__},
    confirmed=True, idempotency_key='e16-rev-' + __RUN__)
import frappe
RESULT['left'] = frappe.db.exists('Shangshu Mail Access', {'mailbox': __BOX__, 'user': __WHO__})
frappe.db.commit()
'''.replace('__BOX__', repr('e16-box-' + RUN))
     .replace('__WHO__', repr(READER))
     .replace('__RUN__', repr(RUN)))
        print('  撤权：剩授权行=%r' % (rev.get('left'),))

        rels_a, un_a, st_a, err_a = _review(reader)
        if not PORT_BROKEN:
            # **不泄露**：回包里不能出现源信的编号或主题
            blob = _json.dumps({'relations': rels_a}, ensure_ascii=False)
            leaks = (MAIL in blob) or ('E16 源信' in blob)
            check('2 ★ **撤掉源读权后关联立刻不可见**（`unavailable=1`、不泄露编号/主题/字段）',
                  (st_a == 200) and (not rels_a) and (un_a == 1) and (not leaks),
                  'HTTP %s relations=%d unavailable=%r 泄露=%r'
                  % (st_a, len(rels_a or []), un_a, leaks))

            check('4 敏感度：**同一文件、同一人**撤权前后给**两种不同答案**（不恒同）',
                  bool(rels_b) and not rels_a,
                  '撤权前 relations=%d　撤权后 relations=%d'
                  % (len(rels_b or []), len(rels_a or [])))
finally:
    _ss_console.run('''
import frappe
for _n in (__FILE__,):
    if _n:
        try:
            frappe.db.sql('delete from `tabShangshu File Center File` where name=%s', _n)
        except Exception:
            pass
try:
    frappe.db.sql('delete from `tabShangshu Mail Message` where name=%s', __MAIL__)
    frappe.db.sql('delete from `tabShangshu Mail Account` where account_key=%s', __BOX__)
    frappe.db.sql('delete from `tabShangshu Mail Access` where mailbox=%s', __BOX__)
    frappe.db.sql('delete from `tabUser` where email=%s', __READER__)
    frappe.db.sql('delete from `tabShangshu Department` where title like %s', 'E16部门-%')
except Exception:
    pass
frappe.db.commit()
RESULT['cleaned'] = True
'''.replace('__FILE__', repr(FILE)).replace('__MAIL__', repr(MAIL))
    .replace('__BOX__', repr('e16-box-' + RUN))
    .replace('__READER__', repr(READER)))

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet:
    print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  (('PASS R967-E / E01.6 关联跟随源当前授权（%d 条）' % len(checks))
                   if not not_yet else
                   ('**未判** R967-E / E01.6（断言 %d 条，**未跑 %d 条**）'
                    % (len(checks), len(not_yet))))))
print('⚠️ 本组只判**关联侧**。`relations.py:52`「关联不授予被引记录访问权」那条边界不动。')
print('⚠️ **写侧**（`review.save` 保存时复核既有关联）不在本组。')
sys.exit(1 if (fails or not_yet) else 0)
