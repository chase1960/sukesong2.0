"""R967-E01 · BASE967-22：**预览跟「读」走，不跟「下载」走**（三个独立的位）。

**测试通过 = 下面每条成立**：

1. **前置·造出「管理默认读权但没有下载权」的人**：部门负责人看辖内资源，
   `read_allows` 为真、`download_allows` 为假 —— 这正是 UI-017 实测卡住的那个身份。
2. ★ **`preview_allows` 为真**（能看内容）—— **BASE967-22 本体**。
3. ★ **`preview_allows` 不等于 `download_allows`** —— 下不了原件 ≠ 看不了内容。
4. **对照**：归属人本人三样都真（证明判据不是「一律拒」）。
5. **敏感度**：同一个人，`preview` 与 `download` 给**两种不同答案**（不恒同）。

---
**口径不是我编的**（`fde/设计/契约/账号与权限.md`，用户已确认）：

> `:53` 修改资料、删除/恢复、修改规则、共享转授权、**导出/外发**、代员工发信及审核批准
> **分别配置；不能通过「默认可读」自动获得这些动作**。普通读取、表内搜索和
> **授权预览均应体现该默认读权**。
>
> `:83` 公开范围只扩展读取和使用引用的资格，**不自动扩展**改值、改结构、晋升、
> 发布到公共空间、撤出公共空间、共享转授权、**导出**或代发权。
>
> `:152` 搜索、关联标签、**预览**、复制/导出、候选和日志 | 各入口**不返回无权字段或记录**，
> 计数与摘要同样检查

**关键那句是 `:53` 的「授权预览均应体现该默认读权」** —— 预览**跟读走**。
而导出/下载是「**分别配置**、不因默认可读自动获得」的那一批。

---
**病根**（UI-017 实测）：「老板四类 PDF 及 A 负责人 A/Child PDF **正文**全部 403，
BASE967-22（**预览错用下载权限**）」。

**不是判错了，是判的维度就错了** —— 预览拿 `download_allows` 判，
而老板有管理默认读、没有下载权 → 正文 403。

**代码事实**：`shangshu_core/org_admin.py` 只有 `read_allows` / `write_allows` /
`download_allows` 三个，**没有 `preview_allows`**（`grep -rn "preview" org_admin.py` 零命中）
—— 所以调用方**无处可判**，只能错用下载。这是**结构性缺口**，不是调错参数。

---
**为什么不在 `test_field_access.py` 里补**：那个文件的立身前提是
「**纯判定规则**，脱离 frappe 运行时直接测」。`org_admin` 用 `frappe.db`，
塞进去就破了那个前提。本组走 `_ss_console`（受管运行时，§13 公共件）。

**⚠️ 本组用 `_ss_console` 造组织样本**（部门/负责人/归属），**不写第二套造样工具**。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_e01_preview_allows.py
"""
import importlib.util
import json
import os
import sys

ROOT = os.environ.get('SS_ROOT',
                      '/path/to/workspace')


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT + path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_ss_console = _load('_ss_console', '/shangshu-server/scripts/tests/_ss_console.py')

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


print('== R967-E01 / BASE967-22：预览跟「读」走，不跟「下载」走 ==')

RUN = str(os.environ.get('SS_RUN') or os.getpid())
OWNER = 'e22-owner-%s@example.invalid' % RUN      # 归属人本人（对照）
HEAD = 'e22-head-%s@example.invalid' % RUN        # 部门负责人（管理默认读、无下载权）

SEED = r'''
import frappe, json
from shangshu_core import org_admin as oa

run = __RUN__
owner, boss = __OWNER__, __HEAD__
RESULT = {}

def _mk_user(email, first):
    if not frappe.db.exists('User', email):
        frappe.get_doc({'doctype': 'User', 'email': email, 'first_name': first,
                        'send_welcome_email': 0,
                        'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
    return email

_mk_user(owner, 'E22归属')
_mk_user(boss, 'E22老板')

# ⚠️ **DocType 名按真名**（`org_admin.py` 里出现的那六个）——
# 第一版猜 `Shangshu Enterprise` / `Shangshu Org Head`，产品里**没有这两个**
# （`ImportError: No module named 'frappe.core.doctype.shangshu_enterprise'`）。
# 企业是 `Shangshu Identity.enterprise_id` / `Shangshu Department.enterprise_id` 上的值，
# 「老板」是 **`Shangshu Org Owner`**（`owned_enterprises`）。
# **用老板比用部门负责人更贴原反例** —— UI-017 卡住的正是「老板四类 PDF 正文 403」。
ent = 'E22企业-' + run
dept = 'E22部门-' + run
# ⚠️ **走产品自己的 `department_create`**，不直插表 ——
# `Shangshu Department` 要「稳定身份」（产品建部门时生成），直插会
# `ValidationError: 部门稳定身份 is required`。**造样走产品口**，不然测的不是产品。
if not frappe.db.exists('Shangshu Department', {'title': dept}):
    # ⚠️ **payload 键是 `name` 不是 `title`**（`org_admin.department_create:52`：
    # `title = str(payload.get("name") or "")`）。第一版传 `title` →
    # `ValidationError: 请填写部门名称`。**按被调函数的签名传参**，别按字段名想当然。
    oa.department_create('platform.org.department_create',
                         {'name': dept, 'enterprise': ent}, None)
dept = (frappe.db.get_value('Shangshu Department', {'title': dept}, 'name') or dept)
for em in (owner, boss):
    if not frappe.db.exists('Shangshu Identity', {'user': em}):
        frappe.get_doc({'doctype': 'Shangshu Identity', 'user': em,
                        'enterprise_id': ent}).insert(ignore_permissions=True)
if not frappe.db.exists('Shangshu Org Member', {'user': owner, 'department': dept}):
    frappe.get_doc({'doctype': 'Shangshu Org Member', 'user': owner,
                    'department': dept}).insert(ignore_permissions=True)
if not frappe.db.exists('Shangshu Org Owner', {'enterprise_id': ent}):
    # ⚠️ **字段是 `enterprise_id`，不是 `enterprise`**（`org_context:563`：
    # `frappe.get_all("Shangshu Org Owner", filters={"user": email}, pluck="enterprise_id")`）。
    # 第一版写 `enterprise` → 老板的 `owned_enterprises` 是空的 → `read_allows` 回 False。
    # **取键要按被调函数真正读的那个，不按名字想当然。**
    frappe.get_doc({'doctype': 'Shangshu Org Owner', 'enterprise_id': ent,
                    'user': boss}).insert(ignore_permissions=True)
frappe.db.commit()
RESULT['dept'] = dept
RESULT['ent'] = ent

# 资源归属落「部门」—— 老板**全企业默认可读**（`default_read_allows`），
# 但**管理读不带下载**（`账号与权限.md:53`/`:83`）。
res = 'E22-res-' + run
oa.attribution_record(res, 'department', department=dept)
RESULT['resource'] = res

out = {}
for tag, u in (('owner', owner), ('head', boss)):
    att = oa.resource_attribution(res)
    out[tag] = {
        'read': oa.read_allows(u, res, attribution=att),
        'download': oa.download_allows(u, res, attribution=att),
    }
    try:
        out[tag]['preview'] = oa.preview_allows(u, res, attribution=att)
        out[tag]['preview_exists'] = True
    except AttributeError:
        out[tag]['preview'] = None
        out[tag]['preview_exists'] = False
    except Exception as e:
        out[tag]['preview'] = '%s: %s' % (type(e).__name__, e)
        out[tag]['preview_exists'] = True
RESULT['verdicts'] = out
'''
SEED = (SEED.replace('__RUN__', json.dumps(RUN))
           .replace('__OWNER__', json.dumps(OWNER))
           .replace('__HEAD__', json.dumps(HEAD)))

out = _ss_console.run(SEED)
V = out.get('verdicts') or {}
print('  组织样本：%s / %s' % (out.get('ent'), out.get('dept')))
print('  判定：%s' % json.dumps(V, ensure_ascii=False))

try:
    ok_seed = bool(out.get('dept')) and bool(out.get('resource')) and not out.get('__error__')
    check('1 前置·造出「管理默认读权但没有下载权」的负责人',
          ok_seed and (V.get('head') or {}).get('read') is True
          and (V.get('head') or {}).get('download') is False,
          'err=%r head=%r' % (out.get('__error__'), V.get('head')))

    if not ok_seed:
        for lab in ('2 ★ `preview_allows` 为真（能看内容）',
                    '3 ★ `preview_allows` ≠ `download_allows`（下不了 ≠ 看不了）',
                    '4 对照·归属人本人三样都真',
                    '5 敏感度：同一人 `preview` 与 `download` 两种不同答案'):
            check(lab, None, '前置没造出来，整组不判（不假装验过）')
    else:
        hp = (V.get('head') or {})
        # ---------- 2 ★ BASE967-22 本体 ----------
        if hp.get('preview_exists') is False:
            check('2 ★ `preview_allows` 为真（能看内容）', None,
                  '**产品没有 `preview_allows` 这个口** —— 调用方无处可判，'
                  '只能错用下载（BASE967-22 结构性缺口）。本条**待补**。')
        else:
            check('2 ★ `preview_allows` 为真（能看内容）', hp.get('preview') is True,
                  '负责人 preview=%r' % hp.get('preview'))

        # ---------- 3 ★ 预览 ≠ 下载 ----------
        check('3 ★ `preview_allows` **≠** `download_allows`（下不了原件 ≠ 看不了内容）',
              (hp.get('preview') is True) and (hp.get('download') is False),
              '负责人 preview=%r download=%r read=%r'
              % (hp.get('preview'), hp.get('download'), hp.get('read')))

        # ---------- 4 对照 ----------
        op = (V.get('owner') or {})
        check('4 对照·归属人本人三样都真（证明判据不是「一律拒」）',
              op.get('read') is True and op.get('download') is True
              and op.get('preview') is True,
              '归属人 %r' % op)

        # ---------- 5 敏感度 ----------
        check('5 敏感度：同一人 `preview` 与 `download` 给**两种不同答案**（不恒同）',
              hp.get('preview') != hp.get('download'),
              'preview=%r download=%r' % (hp.get('preview'), hp.get('download')))
finally:
    _ss_console.run('''
import frappe
for t, col in (('Shangshu Org Attribution', 'resource'),
               ('Shangshu Org Member', 'department'),
               ('Shangshu Org Owner', 'enterprise_id')):
    try:
        frappe.db.sql('delete from `tab%s` where %s=%%s' % (t, col), __KEY__)
    except Exception:
        pass
try:
    frappe.db.sql('delete from `tabShangshu Org Attribution` where resource=%s', __RES__)
    frappe.db.sql('delete from `tabShangshu Department` where name=%s', __DEPT__)
except Exception:
    pass
frappe.db.commit()
RESULT['cleaned'] = True
'''.replace('__KEY__', json.dumps(out.get('dept') or out.get('ent') or ''))
    .replace('__RES__', json.dumps(out.get('resource') or ''))
    .replace('__DEPT__', json.dumps(out.get('dept') or '')))

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet:
    print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  (('PASS R967-E01 / BASE967-22（%d 条）—— 预览跟读走、不跟下载走'
                    % len(checks)) if not not_yet else
                   ('**未判** R967-E01 / BASE967-22（断言 %d 条，**未跑 %d 条**）'
                    % (len(checks), len(not_yet))))))
print('⚠️ 本组只判**资源级**三个位。**字段级**（`preview = read_allows AND 字段 read`）另判。')
sys.exit(1 if (fails or not_yet) else 0)
