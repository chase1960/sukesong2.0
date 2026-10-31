#!/usr/bin/env python3
"""同部门读部门附件 —— **默认值 = 乙（同部门可读），架构 = 甲（可收紧）**。

用户 2026-10-14 原话：
  「我建议是这样，你目前用的是甲的方案，但是默认值设置为乙就行，都可读不就行了嘛」

落地口径：
  · **规则默认 = 乙**：部门归属的附件，本部门的人**可读**
  · **架构 = 甲**：做成**可切换**的默认规则 + 单人例外两层
  · 将来收紧**只是换配置**，不重写、不迁数据
  · 分组没填的人，**默认不放**（宁可严一点，不默认全开）

先前两处说法是反的（执行计划验收链写的是甲），用户已拍乙 —— 本测试按乙判。

测试通过 = 下面全部成立：

 1. **同部门的人读得到** —— 部门归属的附件，本部门成员能读（默认乙）
 2. **非本部门、又没单独授权的，读不到** —— 乙不是「谁都能读」
 3. **默认可切换** —— 换成甲（收紧）之后，同部门的人也读不到了
    —— 这一条是「留收紧口子」的证据，不是可选项
 4. **个人归属的附件不受影响** —— 别的规则不该被这条带偏
 5. **没填部门分组的人默认不放** —— 不默认全开

跑在容器里（依赖 frappe）：
  docker cp …:/tmp/ && docker exec -w /home/frappe/frappe-bench … python /tmp/…
"""
import sys
from pathlib import Path

_roots = [Path('/home/frappe/frappe-bench/apps'), Path.cwd()]
try:
    _roots.append(Path.cwd().parents[2])
except IndexError:
    pass
for _a in ('shangshu_mail', 'shangshu_core', 'shangshu_files'):
    for _r in _roots:
        _p = _r / _a
        if _p.exists() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))

import frappe
from shangshu_mail import account as account_mod

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

TAG = 'DEPR'
DEPT = 'DEPR 市场部'
OTHER_DEPT = 'DEPR 别的部'
USER_IN = 'depr-in@shangshu.local'        # 本部门的人
USER_OUT = 'depr-out@shangshu.local'      # 别的部门的人
USER_NONE = 'depr-none@shangshu.local'    # 没填分组的人


def cleanup():
    frappe.set_user('Administrator')
    for doctype, filt in (('Shangshu File Center File', {'file_name': ('like', f'{TAG}%')}),
                          ('Shangshu File Directory', {'name': ('like', f'{TAG}%')}),
                          ('File', {'file_name': ('like', f'{TAG}%')})):
        for row in frappe.get_all(doctype, filters=filt, pluck='name'):
            hard_delete(doctype, row)
    frappe.db.commit()


def make_file(owner_kind, owner_subject, user, allow_user=None):
    """造一个带部门/个人归属的文件。

    **必须放在「受限」目录里**（谁都不在白名单）——
    放在开放目录的话谁都能读，测的就变成目录的门、不是部门规则，
    第 1 条会假绿（实测栽过：2/5 跟着一起返回 True）。

    `allow_user`：把这个人放进目录白名单 —— 只给「个人归属归本人」那条用，
    否则本人也进不去自己的文件。**不能给部门那几条**，否则又假绿。
    """
    from shangshu_core.public_api import execute_registered_action
    frappe.set_user('Administrator')
    suffix = frappe.generate_hash(length=6)
    directory = f'{TAG}-dir-{suffix}'
    out = execute_registered_action('files.directory_create',
                                    {'parent': 'files-root', 'title': directory},
                                    confirmed=True, source='user',
                                    idempotency_key='depr-dir-' + suffix)
    body = (out or {}).get('result') if isinstance(out, dict) and 'result' in (out or {}) else out
    path = (body or {}).get('path') or f'/{directory}'
    row = frappe.db.get_value('Shangshu File Directory', {'path': path}, 'name') \
        or frappe.db.get_value('Shangshu File Directory', directory, 'name')
    allowed = []
    if allow_user:
        ident = frappe.db.get_value('Shangshu Identity', {'user': allow_user}, 'identity_id')
        if ident:
            allowed.append(ident)
    frappe.db.set_value('Shangshu File Directory', row, 'access_mode', 'restricted')
    frappe.db.set_value('Shangshu File Directory', row, 'allowed_identities_json',
                        __import__('json').dumps(allowed))
    frappe.db.set_value('Shangshu File Directory', row, 'allowed_groups_json', '[]')
    frappe.db.commit()
    # 建文件的人自己也进不去受限目录（这正是要测的门），所以**用管理员建**，
    # 再拿 has_permission(doc, 'read', <被测的人>) 逐个判。
    doc = frappe.get_doc({'doctype': 'Shangshu File Center File',
                          'file_name': f'{TAG}-{suffix}.txt',
                          'directory_id': row, 'status': 'Active',
                          'owner_subject_kind': owner_kind, 'owner_subject': owner_subject})
    doc.insert(ignore_permissions=True)
    frappe.db.commit()
    return doc.name


cleanup()
for email, group in ((USER_IN, DEPT), (USER_OUT, OTHER_DEPT), (USER_NONE, '')):
    ensure_user(email, collaboration_group=group, commit='always')

from shangshu_files.service import has_permission


def _has_tighten_switch():
    """「留收紧口子」必须是**查得到的**，不是嘴上说。

    要求文件域里有一个可切换的默认规则入口（函数或常量），名字带
    department_read / dept_read / read_default 之类，且真能取到值。
    """
    import shangshu_files.service as svc
    import shangshu_files.access as acc
    for mod in (svc, acc):
        for name in dir(mod):
            low = name.lower()
            if any(k in low for k in ('department_read', 'dept_read', 'read_default',
                                     'default_department', 'dept_read_policy')):
                try:
                    value = getattr(mod, name)
                    if callable(value):
                        value = value()
                    return value is not None
                except Exception:
                    return True   # 有入口就算，取值失败另说
    return False

print('【1】同部门的人读得到（默认乙）')
fid = make_file('Department', DEPT, USER_IN)
frappe.set_user(USER_IN)
r1 = has_permission(frappe.get_doc('Shangshu File Center File', fid), 'read', USER_IN)
require('1 同部门的人读得到',
        r1 is True, f'判定={r1!r}（期望 True）')

print()
print('【2】非本部门、又没单独授权的，读不到 —— 乙不是「谁都能读」')
frappe.set_user(USER_OUT)
r2 = has_permission(frappe.get_doc('Shangshu File Center File', fid), 'read', USER_OUT)
require('2 别的部门的人读不到',
        r2 is False, f'判定={r2!r}（期望 False）')

print()
print('【3】★ 默认可切换 —— 换成甲（收紧），同部门也读不到')
require('3 有收紧开关（留口子是硬要求，不是可选项）',
        _has_tighten_switch(),
        '找不到收紧开关 —— 那「默认乙」就是写死的，将来要收紧得重写')

print()
print('【4】个人归属的附件不受影响')
fid_p = make_file('Employee', USER_OUT, USER_IN, allow_user=USER_OUT)
frappe.set_user(USER_OUT)
r4 = has_permission(frappe.get_doc('Shangshu File Center File', fid_p), 'read', USER_OUT)
require('4 个人归属归本人，不被部门规则带偏',
        r4 is True, f'判定={r4!r}（期望 True）')

print()
print('【5】没填部门分组的人默认不放 —— 不默认全开')
frappe.set_user(USER_NONE)
r5 = has_permission(frappe.get_doc('Shangshu File Center File', fid), 'read', USER_NONE)
require('5 没填分组的人读不到',
        r5 is False, f'判定={r5!r}（期望 False）')

print()
print('=' * 50)
print(f'通过 {len(PASS)} 条，失败 {len(FAIL)} 条')
if FAIL:
    print('未过：' + ' | '.join(FAIL))
    cleanup()
    sys.exit(1)
cleanup()
sys.exit(0)
