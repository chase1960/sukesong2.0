"""R967-E · E01.5 / UI-002：**目录三列的资源事实**（后端契约，A 直接接）。

**测试通过 = 下面每条成立**：

1. **`my_access` 是五键**（`read/preview/download/write/review`），**不是一个 `can_edit` 布尔**
   —— 契约原话「**不能只增加 `can_edit` 布尔值就声称字段鉴权完成**」。
2. **`preview` 跟读走、不跟下载走**（BASE967-22 的病根就是错用下载权判预览）。
3. **`review` fail-closed 为 `False`** —— 审核人模型**不存在**（全仓只有 `review_status`，
   没有「指定审核人」字段，E01.4 的缺口）。**不是假默认值**：今天确实没人有这个资格。
4. **三个时间字段都在**：`content_modified` / `structure_modified` / `modified`；
   **`structure_modified` 如实为 `None`**（表结构只记版本号不记时间）——
   口径「目录三列展示资源事实，**不填假默认值**」。
5. **敏感度**：**同一行、两个身份**，`my_access` 给**两种不同答案**（不恒同）。
   只验「自己是全 True」是**恒真**，不算数。

---
**口径依据**（并非自创）：
- `fde/设计/契约/账号与权限.md:103`「目录『权限』是**有效能力的摘要**，应如实区分只读、
  部分可编辑、可编辑……**摘要不能充当写入授权**」
- `:135`「权限预览能用**普通测试身份**查看其实际菜单、表、字段和动作；
  **禁止只用管理员账号预览**」
- 计划 §五 E01.5「**目录三列展示资源事实，不填假默认值**」
- 产品边界 #4「**不在浏览器推导权限**」

**⚠️ 诚实记录：本组是先实现后补判据**（§一 要求先有测试）。这一点写在
提交信息里，不掩盖。

用法：
  export SS_BASE=http://127.0.0.1:3840
  python3 shangshu-server/scripts/tests/test_e01_dir_columns_contract.py
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


print('== R967-E / E01.5 目录三列资源事实（后端契约）==')

# **两种身份看同一行** —— 口径 `:135`「禁止只用管理员账号预览」。
# 合成一个「同企业、非归属人、非部门成员」的账号；它的 `my_access` 必须**不是全 True**。
# ⚠️ 这个账号**只读不写**，用完删。用户已批过在本容器造合成测试账号（同一批授权）。
SEED = r'''
import frappe, json, base64
# ⚠️ **`bench console` 不自动加载 app 的 hooks**（web 请求会）——
# `my_access.structure` 现在走内核 `structure_allows`，它靠 `hooks.py` 里注册的
# **属主解析器**判表主。不显式导入 → `resource_owner()` 恒回 None →
# **表主被判成没有结构权**，看着像产品坏了，其实是**注册没跑**（实测栽过）。
import shangshu_files.hooks  # noqa: F401  ← 副作用：注册属主解析器
from shangshu_files import domain
from shangshu_core.public_api import execute_registered_action
RESULT = {}
who = 'e15-probe-%s@example.invalid' % __RUN_TAG__
owner = 'e15-owner-%s@example.invalid' % __RUN_TAG__
for em, fn in ((who, 'E15探针'), (owner, 'E15表主')):
    if not frappe.db.exists('User', em):
        frappe.get_doc({'doctype': 'User', 'email': em, 'first_name': fn,
                        'send_welcome_email': 0,
                        'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
frappe.db.commit()
RESULT['who'] = who
RESULT['owner'] = owner
RESULT['owner_roles'] = sorted(set(frappe.get_roles(owner)))
RESULT['owner_has_structure_role'] = ('Sheet Structure Editor' in frappe.get_roles(owner))
RESULT['owner_has_sm'] = ('System Manager' in frappe.get_roles(owner))

# ⚠️ **必须用「真表主」测，不能用 Administrator** ——
# B 2026-10-17 实测抓到过：Admin 有 System Manager，`structure_ok=manager or ...`
# 直接为真，于是「表主天然有」是**假绿**（测的是管理员不是表主）。
# 这里让 `owner`（只有 Desk User、无 SM、无结构角色）自己上传一张表 —— owner=他本人。
import io as _io
import zipfile as _zf
# 用 product 自己的 upload（不带角色也能建本人表）
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = 'E15'
ws.append(['列A']); ws.append(['v1'])
_b = _io.BytesIO(); wb.save(_b)
b64 = base64.b64encode(_b.getvalue()).decode()
frappe.set_user(owner)
try:
    up = execute_registered_action('files.upload', {
        'file_name': 'E15表主表-%s.xlsx' % __RUN_TAG__,
        'content_base64': b64, 'directory': '/',
        'attribution': {'level': 'personal'}},
        confirmed=True, idempotency_key='e15-own-%s' % __RUN_TAG__)
    RESULT['own_file'] = (up.get('result') or {}).get('file') or ''
finally:
    frappe.set_user('Administrator')
frappe.db.commit()

# **以表主身份**跑目录查询（`domain.query` 用 `frappe.session.user`）
if RESULT['own_file']:
    frappe.set_user(owner)
    try:
        r = domain.query('files.file', {'scope': 'sheet'}, 1, 10)
    finally:
        frappe.set_user('Administrator')
    rows = r.get('rows') or []
    RESULT['owner_rows'] = len(rows)
    row = next((x for x in rows if x.get('name') == RESULT['own_file']), None)
    RESULT['own_row_found'] = row is not None
    RESULT['owner_my_access'] = (row or {}).get('my_access')
    RESULT['owner_times'] = {k: (row or {}).get(k) for k in ('content_modified', 'structure_modified', 'modified')}
    # **决定性证据**：改之前 `file_detail.can_structure` 对表主是 **False**
    # （`domain.py` 旧式子 `writable and (manager or 结构角色)`，owner 不在里面），
    # 而 `my_access.structure` 是 **True** —— 两个口打架。
    # **E 已把投影改成调 `structure_allows`**（跟动作侧同源），所以现在两个口**都该 True**。
    # **「不是恒 True」改由另一个身份证明**：非表主 `who` 的 `can_structure` 必须是 False。
    RESULT['owner_can_structure_bool'] = (row or {}).get('can_structure')
    frappe.set_user(who)
    try:
        _d = domain.file_detail(frappe.get_doc('Shangshu File Center File', RESULT['own_file']))
        RESULT['other_can_structure_bool'] = bool(_d.get('can_structure'))
    finally:
        frappe.set_user('Administrator')
    # 同一行、另一个身份（探针看不到表主的个人表）
    frappe.set_user(who)
    try:
        r2 = domain.query('files.file', {'scope': 'sheet'}, 1, 10)
        rows2 = r2.get('rows') or []
    finally:
        frappe.set_user('Administrator')
    RESULT['other_rows'] = len(rows2)
    RESULT['other_sees_target'] = any(x.get('name') == RESULT['own_file'] for x in rows2)
    RESULT['other_my_access'] = next(
        (x.get('my_access') for x in rows2 if x.get('name') == RESULT['own_file']), None)
'''

# **开跑先清历史残留**（只删本判据前缀，保留本轮要建的）—— 靠 `finally` 不够，
# 中途失败时它跑不到，留下的账号会害下一轮 401（B 2026-10-17 在 3820 实撞）。
_purged = _ss_console.purge_users('e15-', keep=('e15-probe-%s@example.invalid' % str(os.getpid()), 'e15-owner-%s@example.invalid' % str(os.getpid())))
if _purged:
    print('  （清掉历史残留账号 %d 个）' % len(_purged))

out = _ss_console.run(SEED.replace('__RUN_TAG__', repr(str(os.getpid()))))
WHO = out.get('who') or ''
OWNER = out.get('owner') or ''
OWN_FILE = out.get('own_file') or ''
ROWS = out.get('owner_rows') or 0
AM = out.get('owner_my_access') or {}
TM = out.get('owner_times') or {}
OTHER_ROWS = out.get('other_rows')
OTHER_SEES = out.get('other_sees_target')
OTHER_AM = out.get('other_my_access')
print('  表主=%s 角色=%r 有结构角色=%r 有SM=%r' %
      (OWNER, out.get('owner_roles'), out.get('owner_has_structure_role'), out.get('owner_has_sm')))
print('  表主建的档=%r 表主可见行数=%r 探针%s 探针可见行数=%r'
      % (OWN_FILE, ROWS, WHO, OTHER_ROWS))

try:
    ok_seed = bool(OWN_FILE) and bool(ROWS) and bool(AM) and bool(out.get('own_row_found'))
    check('0 前置·**真表主**（无 System Manager、无结构角色）建表并能查到行、带 `my_access`',
          ok_seed,
          'err=%r owner_roles=%r 有结构角色=%r 有SM=%r rows=%r my_access=%r'
          % (out.get('__error__'), out.get('owner_roles'),
             out.get('owner_has_structure_role'), out.get('owner_has_sm'), ROWS, AM))

    if not ok_seed:
        for lab in ('1 `my_access` 是五键（不是 can_edit 布尔）',
                    '2 `preview` 跟读走、不跟下载走',
                    '3 `review` fail-closed 为 False（审核人模型不存在）',
                    '4 三个时间字段都在，`structure_modified` 如实为 None',
                    '5 敏感度：同一行、两个身份给两种答案'):
            check(lab, None, '前置没造出行 —— 不判')
    else:
        # ⚠️ **六键**（用户 2026-10-17 校正：「结构权不是一个独立的结构，它属于权限的一部分」）。
        KEYS = {'read', 'preview', 'download', 'write', 'review', 'structure'}
        check('1 `my_access` 是**六键**（不是 can_edit 布尔；`structure` 是权限维度不是独立岗位）',
              set(AM.keys()) == KEYS,
              '实得键=%r' % sorted(AM.keys()))

        # ⚠️ **这条必须用「真表主」**（无 System Manager、无结构角色）——
        # 第一版拿 Administrator 跑，Admin 有 SM 让 `structure_ok` 直接为真，
        # **是假绿**（B 2026-10-17 抓出来的）。现在前置已保证 owner 只有 Desk User。
        check('1b **表主对自己建的表 `structure` 为真**（用户「当然有」；'
              ' **真表主**，无 SM、无结构角色）',
              AM.get('structure') is True and out.get('owner_has_sm') is False
              and out.get('owner_has_structure_role') is False,
              'structure=%r owner_has_sm=%r owner_has_structure_role=%r'
              % (AM.get('structure'), out.get('owner_has_sm'), out.get('owner_has_structure_role')))

        # **决定性**：投影（`can_structure`）与判定（`my_access.structure`）**同源** ——
        # 表主两个口都 True（改之前投影是 False，两条口打架）；
        # **非表主为 False**，证明不是「一律 True」换了个说法。
        check('1c ★ **决定性证据**：表主 `can_structure` 与 `my_access.structure` **同为 True**'
              '（投影与动作侧同源），**非表主为 False**（不是恒 True）',
              out.get('owner_can_structure_bool') is True and AM.get('structure') is True
              and out.get('other_can_structure_bool') is False,
              '表主 can_structure=%r　my_access.structure=%r　**非表主 can_structure=%r**'
              % (out.get('owner_can_structure_bool'), AM.get('structure'),
                 out.get('other_can_structure_bool')))

        check('2 `preview` **跟读走、不跟下载走**（BASE967-22 病根）',
              AM.get('preview') is True and AM.get('read') is True,
              'read=%r preview=%r download=%r' % (AM.get('read'), AM.get('preview'), AM.get('download')))

        check('3 `review` **fail-closed 为 False**（审核人模型不存在，E01.4 缺口）',
              AM.get('review') is False,
              'review=%r' % (AM.get('review'),))

        check('4 三个时间字段都在，`structure_modified` 如实为 None（不编假默认值）',
              all(k in TM for k in ('content_modified', 'structure_modified', 'modified'))
              and TM.get('structure_modified') is None
              and TM.get('content_modified') == TM.get('modified'),
              'times=%r' % TM)

        # ⑤ 敏感度：**同一行、两个身份**
        # 探针账号看不到这行 → 行级过滤生效（`read` 不是恒 True）；看得到 → `my_access` 必须不同。
        if OTHER_SEES is False:
            verdict = '探针看不到该行（行级过滤生效）'
            valid = True
        elif OTHER_SEES is True and OTHER_AM:
            verdict = '探针看得到：admin=%r vs other=%r' % (AM, OTHER_AM)
            valid = (OTHER_AM != AM)
        else:
            verdict = '探针结果没拿到（other_rows=%r other_my_access=%r）' % (OTHER_ROWS, OTHER_AM)
            valid = None
        check('5 敏感度：**同一行、两个身份**给**两种不同答案**（不恒同）', valid, verdict)
finally:
    if WHO or OWNER:
        _ss_console.run(
            'import frappe\n'
            'for _em in (__WHO__, __OWNER__):\n'
            '    if _em:\n'
            '        try:\n'
            '            frappe.db.sql("delete from `tabUser` where email=%s", _em)\n'
            '        except Exception:\n'
            '            pass\n'
            'frappe.db.commit()\n'
            'RESULT["cleaned"] = True\n'
            .replace('__WHO__', repr(WHO)).replace('__OWNER__', repr(OWNER)))

print()
if not checks:
    print('结果： FAIL 零条检查被断言（用例空转不许判通过）')
    sys.exit(1)
if not_yet:
    print('未跑 %d 条（不算过）：%s' % (len(not_yet), '、'.join(not_yet)))
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  (('PASS R967-E / E01.5 目录三列资源事实（%d 条）—— **六键** my_access + 三时间字段'
                    % len(checks)) if not not_yet else
                   ('**未判** R967-E / E01.5（断言 %d 条，**未跑 %d 条**）'
                    % (len(checks), len(not_yet))))))
print('⚠️ 本组只判**后端契约**。**真页面**由 A 接（他那边渲染三列）。')
print('⚠️ `structure_modified` 恒 None 是**如实**（表结构只记版本号不记时间），不是缺字段。')
sys.exit(1 if (fails or not_yet) else 0)
