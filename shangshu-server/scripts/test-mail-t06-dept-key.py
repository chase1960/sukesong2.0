#!/usr/bin/env python3
"""T06 部门键：附件「所有人」必须是**授权链认得出的受管部门 ID**。

B 实测给的那面墙（原话）：
  `attribution.department` 填**标题** → HTTP 417「部门不存在」
  `attribution.department` 填 `Shangshu Department.name`（ID） → 正确路径

上一版 `attachment_owner` 写的是 `Shangshu Mail Account.department` 的**自由文本**，
还带一个更糟的兜底：部门为空时拿**邮箱地址**冒充部门。
两条都写出一个 `write_allows` / `download_allows` 永远解析不了的键 ——
「共享箱归部门」看着成立，授权那半全是空的。

测试通过 = 下面全部成立：

 1. **部门箱没登记所属部门 → 当场拒** —— 不把邮箱地址冒充部门
    （宁可这条附件不入库、留一条可查的失败，也不写一个假所有人）
 2. **个人箱不受影响** —— 仍然归邮箱所属员工
 3. **受管部门表不存在时只做显示、不落归属行** —— 不假装能授权
    （`Shangshu Org Attribution` 一条都不新增）
 4. **受管部门表存在时，ID 一字不差透传**
 5. **填的是唯一标题 → 收成对应部门 ID**
 6. **同名多个部门 → 当场拒**，提示改成部门编号；不写 owner_subject
 7. **查无此部门 → 当场拒**
 8. **入库同时落一条归属行**（`Shangshu Org Attribution`：
    部门箱 level=department/department=ID，个人箱 level=personal/owner_user=员工）

4～8 依赖 `Shangshu Department` / `Shangshu Org Attribution`（B 的组织层，在
`excel-ab-int`，尚未合入本分支）。**没有就明写 NOT_RUN，不装假部门表让测试变绿。**

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
from shangshu_mail.delivery import (attachment_attribution, attachment_owner,
                                    import_mail_attachments)

# 公共件 helper（require/ensure_user/PASS/FAIL/NOT_RUN）：公共跑具把 mail_fixture.py
# 合进同一文件跑；直接单跑就显式从 scripts/ 引。两用都要成立（同 c10-shared-owner）。
try:
    from mail_fixture import PASS, FAIL, require, ensure_user  # noqa: F401
except ImportError:
    for _p in (Path(__file__).resolve().parent, Path.cwd() / 'scripts', Path.cwd()):
        if (_p / 'mail_fixture.py').exists() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))
    from mail_fixture import PASS, FAIL, require, ensure_user  # noqa: F401

SITE = 'shangshu.localhost'
SITES_PATH = '/home/frappe/frappe-bench/sites'
frappe.init(site=SITE, sites_path=SITES_PATH)
frappe.connect()

NOT_RUN = []   # PASS/FAIL 从公共件 mail_fixture.py 来；这一列是本文件自己多的


def skip(label, why):
    NOT_RUN.append(label)
    print(f'  ○ {label} —— NOT_RUN：{why} **不记为通过**。')


def check(label, fn):
    try:
        detail = fn()
        require(label, True)
        return detail
    except AssertionError as error:
        require(label, False, str(error))
    except frappe.ValidationError as error:
        require(label, False, f'意外 ValidationError：{error}')
    except Exception as error:                      # noqa: BLE001 —— 测试要看到原样报错
        require(label, False, f'{type(error).__name__}: {error}')



USER_A = 't06k-a@shangshu.local'
USER_B = 't06k-b@shangshu.local'
BOX_P = 't06k-box-personal'
BOX_D = 't06k-box-dept'
TAG = 'T06K'


def put_account(key, kind, dept, addr, owner):
    """账号行**由邮箱属主自己建**（`rights_for` 认「账号行属主 = 这个邮箱的管理员」），
    且要套 `writing()` 闸 —— doctype.validate 不认裸插入。"""
    row = frappe.db.get_value('Shangshu Mail Account', {'account_key': key}, 'name')
    if row:
        with account_mod.writing():
            hard_delete('Shangshu Mail Account', row)
        frappe.db.commit()
    frappe.set_user(owner)
    with account_mod.writing():
        frappe.get_doc({'doctype': 'Shangshu Mail Account', 'account_key': key, 'kind': kind,
                        'department': dept, 'provider': 'qq', 'email_address': addr,
                        'display_name': TAG, 'enabled': 1, 'connection_status': 'connected',
                        'binding_generation': f'gen-{key}'}).insert(ignore_permissions=True)
    frappe.db.commit()


def put_mail(key, mailbox, owner):
    """立一封信 + 一个附件。**每步提交** —— 动作失败路径会 rollback 未提交事务。"""
    from shangshu_mail.service import writing
    subject = f'{TAG} {key}'
    old = frappe.db.get_value('Shangshu Mail Message', {'subject': subject}, 'name')
    if old:
        hard_delete('Shangshu Mail Message', old)
    old_f = frappe.db.get_value('File', {'file_name': f'{TAG}-{key}.txt'}, 'name')
    if old_f:
        hard_delete('File', old_f)
    frappe.db.commit()
    frappe.set_user(owner)
    with writing():
        doc = frappe.get_doc({'doctype': 'Shangshu Mail Message', 'status': 'Received',
                              'subject': subject, 'body': 'x', 'body_format': 'Text',
                              'to_json': '["我 <me@x.example>"]', 'cc_json': '[]',
                              'from_address': '对方 <other@x.example>', 'record_version': 1,
                              'mailbox_id': mailbox, 'owner': owner,
                              'received_at': frappe.utils.now_datetime()}).insert(ignore_permissions=True)
        att = frappe.get_doc({'doctype': 'File', 'file_name': f'{TAG}-{key}.txt', 'is_private': 1,
                              'attached_to_doctype': 'Shangshu Mail Message', 'attached_to_name': doc.name,
                              'content': f'attachment {TAG} {key}'.encode()}).insert(ignore_permissions=True)
    frappe.db.commit()
    return doc.name, att.name


def cleanup():
    frappe.set_user('Administrator')
    with account_mod.writing():
        for key in (BOX_P, BOX_D):
            row = frappe.db.get_value('Shangshu Mail Account', {'account_key': key}, 'name')
            if row:
                hard_delete('Shangshu Mail Account', row)
    for row in frappe.get_all('Shangshu Mail Message', filters={'subject': ('like', f'{TAG}%')}, pluck='name'):
        hard_delete('Shangshu Mail Message', row)
    for row in frappe.get_all('Shangshu File Center File',
                              filters={'file_name': ('like', f'{TAG}%')}, pluck='name'):
        hard_delete('Shangshu File Center File', row)
    for row in frappe.get_all('File', filters={'file_name': ('like', f'{TAG}%')}, pluck='name'):
        hard_delete('File', row)
    for row in frappe.get_all('Shangshu Mail Access', filters={'user': ('in', [USER_A, USER_B])}, pluck='name'):
        hard_delete('Shangshu Mail Access', row)
    frappe.db.commit()


HAS_AUTHORITY = bool(frappe.db.exists('DocType', 'Shangshu Department')) \
    and bool(frappe.db.exists('DocType', 'Shangshu Org Attribution'))

print(f'受管部门表在不在：Department={HAS_AUTHORITY} '
      f'（{"在，走 ID 解析那半" if HAS_AUTHORITY else "不在，只验今天能验的那几条"}）')
print()

ensure_user(USER_A)
ensure_user(USER_B)
cleanup()

# ── 1 ～ 3：今天就能验的（不依赖受管部门表）────────────────────────────────

print('【1】部门箱没登记所属部门 → 当场拒，不把邮箱地址冒充部门')
put_account(BOX_D, 'department', '', 't06k-dept@shangshu.local', USER_A)
mail_d, fid_d = put_mail('d-empty', BOX_D, USER_A)
frappe.set_user(USER_A)
try:
    owner = attachment_owner(mail_d, USER_A)
    require('1 部门箱没登记所属部门 → 当场拒',
            False, f'没有拒，反而给了 {owner!r}（邮箱地址冒充部门正是这一条要挡的）')
except frappe.ValidationError as error:
    msg = str(error)
    require('1 部门箱没登记所属部门 → 当场拒',
            ('部门' in msg and 'shangshu.local' not in msg), f'拒了但理由不像：{msg}')
except Exception as error:                       # noqa: BLE001
    require('1 部门箱没登记所属部门 → 当场拒', False, f'抛的不是 ValidationError：{type(error).__name__}: {error}')

print()
print('【2】个人箱不受影响 —— 归邮箱所属员工（键=员工ID，UI-054 统一口径）')
put_account(BOX_P, 'personal', '', 't06k-personal@shangshu.local', USER_A)
mail_p, fid_p = put_mail('p1', BOX_P, USER_A)
frappe.set_user(USER_A)
from shangshu_core.identity import ensure_identity_for_user
EMP_KEY = ensure_identity_for_user(USER_A)
check('2 个人箱附件归邮箱所属员工', lambda: (
    (lambda o: (
        o['owner_subject_kind'] == 'Employee' and o['owner_subject'] == EMP_KEY
    ) or (_ for _ in ()).throw(AssertionError(
        f"实际 {o!r}；期望 owner_subject == 员工ID {EMP_KEY!r}（登录名是老口径，UI-054 会筛出 0）")))(attachment_owner(mail_p, USER_A))
    or 'ok'))

print()
print('【3】受管部门表不在 → 只做显示、不落归属行')
if HAS_AUTHORITY:
    skip('3 受管部门表不在时不落归属行', '受管部门表已经在了，这条不适用')
else:
    put_account(BOX_D, 'department', '市场部', 't06k-dept@shangshu.local', USER_A)
    mail_d2, fid_d2 = put_mail('d-free', BOX_D, USER_A)
    frappe.set_user(USER_A)
    before = frappe.db.count('Shangshu Org Attribution') if frappe.db.exists('DocType', 'Shangshu Org Attribution') else 0
    try:
        import_mail_attachments(mail_d2, USER_A, [fid_d2])
        frappe.db.commit()
    except Exception as error:                   # noqa: BLE001
        require('3 受管部门表不在时只做显示、不落归属行', False, f'导入本身炸了：{type(error).__name__}: {error}')
    else:
        after = frappe.db.count('Shangshu Org Attribution') if frappe.db.exists('DocType', 'Shangshu Org Attribution') else 0
        row = frappe.db.get_value('Shangshu File Center File', {'file_name': f'{TAG}-d-free.txt'},
                                  ['owner_subject_kind', 'owner_subject'], as_dict=True)
        ok = (after == before) and bool(row) and row.owner_subject_kind == 'Department' \
            and row.owner_subject == '市场部'
        require('3 受管部门表不在时只做显示、不落归属行', ok,
                f'归属行 {before}→{after}；owner={row!r}'
                + ('（自应由文本只做显示，授权认不出这个键——这是过渡态，不是通过）' if ok else ''))

# ── 9 ～ 11：归属载荷（给文件域 attribution 入参的那一份）──────────────────
# 「所有人」是显示/筛选字段；这一份是**授权判定**认的那一份。
# 两者同一个键、同一次推导，但落点不同（见 attachment_attribution 的注释）。
print()
print('【9】个人箱的归属载荷 = personal / owner_user=邮箱所属员工')
put_account(BOX_P, 'personal', '', 't06k-personal@shangshu.local', USER_A)
mail_p9, _ = put_mail('p9', BOX_P, USER_A)
frappe.set_user(USER_A)
check('9 个人箱归属载荷 = personal/owner_user', lambda: (
    (lambda a: a == {'level': 'personal', 'owner_user': USER_A} or (_ for _ in ()).throw(
        AssertionError(f'实际 {a!r}')))(attachment_attribution(mail_p9, USER_A)) or 'ok'))

print()
print('【10】部门箱的归属载荷 = department / department=部门键（与「所有人」同一个键）')
put_account(BOX_D, 'department', '市场部', 't06k-dept@shangshu.local', USER_A)
mail_d10, _ = put_mail('d10', BOX_D, USER_A)
frappe.set_user(USER_A)
check('10 部门箱归属载荷与「所有人」同键', lambda: (
    (lambda a, o: (
        a.get('level') == 'department'
        and a.get('department') == o.get('owner_subject')
        and 'owner_user' not in a
    ) or (_ for _ in ()).throw(AssertionError(f'载荷 {a!r} vs 所有人 {o!r}'))
    )(attachment_attribution(mail_d10, USER_A), attachment_owner(mail_d10, USER_A)) or 'ok'))

print()
print('【11】部门箱没登记部门 → 归属载荷也当场拒（不给一个假归属）')
put_account(BOX_D, 'department', '', 't06k-dept@shangshu.local', USER_A)
mail_d11, _ = put_mail('d11', BOX_D, USER_A)
frappe.set_user(USER_A)
try:
    att = attachment_attribution(mail_d11, USER_A)
    require('11 没登记部门时归属载荷也当场拒', False,
            f'没有拒，给了 {att!r} —— 假归属进文件域就是给授权开了条缝')
except frappe.ValidationError as error:
    require('11 没登记部门时归属载荷也当场拒', '部门' in str(error), f'拒了但理由不像：{error}')

print()
print('【12】入库时 attribution **真的传给了文件域**（不是只在内部算了一下）')
# 用捕获桩拦 execute_registered_action —— 验的是**我这一侧**传对了，
# 不是文件域落没落行（那半是 B 的 test_g1_import_attribution.py 19/19 验的）。
# 两支岔开 72/84 笔，不合；桩让这条能独立验。
import shangshu_mail.delivery as delivery_mod
_captured = []
_orig_exec = delivery_mod.import_mail_attachments.__globals__.get('execute_registered_action')


def _capture_exec(action, payload, **kwargs):
    _captured.append((action, payload))
    return {'file': 'stub', 'version': 1, 'created': 1, 'already_imported': False}


put_account(BOX_D, 'department', '市场部', 't06k-dept@shangshu.local', USER_A)
mail_d12, fid_d12 = put_mail('d12', BOX_D, USER_A)
frappe.set_user(USER_A)
try:
    # import_mail_attachments 在函数体内 from ... import，得从源里打桩
    import shangshu_core.public_api as _pa
    _real = _pa.execute_registered_action
    _pa.execute_registered_action = _capture_exec
    try:
        delivery_mod.import_mail_attachments(mail_d12, USER_A, [fid_d12])
    finally:
        _pa.execute_registered_action = _real
    hits = [p for (a, p) in _captured if a == 'files.import_attachment']
    expect = delivery_mod.attachment_attribution(mail_d12, USER_A)
    got = (hits[0].get('attribution') if hits else None)
    supported = delivery_mod._attribution_supported()
    # 文件域认这个入参 → 必须传对；不认 → **故意不传**（硬传会被
    # additionalProperties:False 整条拒掉，附件直接不入库，比不落归属还糟）。
    # 两支合了 supported 变 True，这条自动切到前一种断言。
    if supported:
        require('12 入库时 attribution 真的传给了文件域',
                bool(hits) and got == expect,
                f'调用 {len(hits)} 次；载荷 attribution={got!r} 期望 {expect!r}')
    else:
        require('12 文件域不认 attribution 时故意不传（不硬塞、不整条拒掉导入）',
                bool(hits) and 'attribution' not in (hits[0] if hits else {}),
                f"调用 {len(hits)} 次；载荷键={sorted(hits[0]) if hits else None}"
                f"（_attribution_supported()=False，两支合了自动切到「必须传对」那条）")
        NOT_RUN.append('12 入库时 attribution 真的传给了文件域')
        print('  ○ 12 入库时 attribution 真的传给了文件域 —— NOT_RUN：'
              '文件域还没认这个入参（B 的 a4057290 在 excel-ab-int，两支未合）。'
              '**不记为通过。**')
    require('12b 归属不由请求值改写（mail_system 照旧服务端推）',
            bool(hits) and hits[0].get('mail_system', {}).get('owner_subject') == '市场部',
            f"mail_system={hits[0].get('mail_system') if hits else None}")
except Exception as error:                       # noqa: BLE001
    require('12 入库时 attribution 真的传给了文件域', False,
            f'{type(error).__name__}: {error}')

# ── 4 ～ 8：依赖受管部门表 ────────────────────────────────────────────────

print()
if not HAS_AUTHORITY:
    for code, label in (
        ('4', '4 部门ID一字不差透传'),
        ('5', '5 唯一标题收成部门ID'),
        ('6', '6 同名多个部门当场拒'),
        ('7', '7 查无此部门当场拒'),
        ('8', '8 入库同时落一条归属行'),
    ):
        skip(label, '`Shangshu Department` / `Shangshu Org Attribution` 不在本分支'
                    '（在 excel-ab-int，未合入）。**不装假部门表让测试变绿。**')
else:
    from shangshu_core import org_admin

    dept_id = f't06k-dept-{frappe.generate_hash(length=6)}'
    frappe.get_doc({'doctype': 'Shangshu Department', 'title': '市场部T06K',
                    'enterprise_id': 'default', 'enabled': 1}).insert(ignore_permissions=True)
    # name 由 hash 生成，回读出来当 ID 用
    dept_id = frappe.db.get_value('Shangshu Department', {'title': '市场部T06K'}, 'name')
    frappe.db.commit()

    print('【4】department 填的是部门 ID → 一字不差透传')
    put_account(BOX_D, 'department', dept_id, 't06k-dept@shangshu.local', USER_A)
    mail_d4, fid_d4 = put_mail('d-id', BOX_D, USER_A)
    frappe.set_user(USER_A)
    check('4 部门ID一字不差透传', lambda: (
        (lambda o: o['owner_subject'] == dept_id or (_ for _ in ()).throw(
            AssertionError(f"实际 {o!r} 期望 ID {dept_id!r}")))(attachment_owner(mail_d4, USER_A)) or 'ok'))

    print()
    print('【5】填的是唯一标题 → 收成部门 ID')
    put_account(BOX_D, 'department', '市场部T06K', 't06k-dept@shangshu.local', USER_A)
    mail_d5, fid_d5 = put_mail('d-title', BOX_D, USER_A)
    frappe.set_user(USER_A)
    check('5 唯一标题收成部门ID', lambda: (
        (lambda o: o['owner_subject'] == dept_id or (_ for _ in ()).throw(
            AssertionError(f"实际 {o!r} 期望收成 {dept_id!r}")))(attachment_owner(mail_d5, USER_A)) or 'ok'))

    print()
    print('【6】同名多个部门 → 当场拒')
    dup = frappe.get_doc({'doctype': 'Shangshu Department', 'title': '重名部T06K',
                          'enterprise_id': 'default', 'enabled': 1}).insert(ignore_permissions=True)
    frappe.get_doc({'doctype': 'Shangshu Department', 'title': '重名部T06K',
                    'enterprise_id': 'default', 'enabled': 1}).insert(ignore_permissions=True)
    frappe.db.commit()
    put_account(BOX_D, 'department', '重名部T06K', 't06k-dept@shangshu.local', USER_A)
    mail_d6, fid_d6 = put_mail('d-dup', BOX_D, USER_A)
    frappe.set_user(USER_A)
    try:
        owner = attachment_owner(mail_d6, USER_A)
        require('6 同名多个部门当场拒', False, f'没有拒，给了 {owner!r} —— 消歧不了就该拒，不该挑一个')
    except frappe.ValidationError as error:
        require('6 同名多个部门当场拒', '编号' in str(error) or '部门' in str(error),
                f'拒了但理由不像：{error}')

    print()
    print('【7】查无此部门 → 当场拒')
    put_account(BOX_D, 'department', '根本没有这个部门T06K', 't06k-dept@shangshu.local', USER_A)
    mail_d7, fid_d7 = put_mail('d-none', BOX_D, USER_A)
    frappe.set_user(USER_A)
    try:
        owner = attachment_owner(mail_d7, USER_A)
        require('7 查无此部门当场拒', False, f'没有拒，给了 {owner!r}')
    except frappe.ValidationError as error:
        require('7 查无此部门当场拒', '部门' in str(error), f'拒了但理由不像：{error}')

    print()
    print('【8】入库同时落一条归属行（经 org_admin.attribution_record）')
    put_account(BOX_D, 'department', dept_id, 't06k-dept@shangshu.local', USER_A)
    mail_d8, fid_d8 = put_mail('d-att', BOX_D, USER_A)
    frappe.set_user(USER_A)
    import_mail_attachments(mail_d8, USER_A, [fid_d8])
    frappe.db.commit()
    file_id = frappe.db.get_value('Shangshu File Center File', {'file_name': f'{TAG}-d-att.txt'}, 'name')
    att = frappe.db.get_value('Shangshu Org Attribution', {'resource': file_id},
                              ['level', 'department', 'owner_user'], as_dict=True) if file_id else None
    require('8 入库同时落一条归属行',
            bool(att) and att.level == 'department' and att.department == dept_id,
            f'file={file_id!r} 归属行={att!r}')

print()
print('=' * 50)
print(f'通过 {len(PASS)} 条，失败 {len(FAIL)} 条'
      + (f'，NOT_RUN {len(NOT_RUN)} 条' if NOT_RUN else ''))
if FAIL:
    print('未过：' + ' | '.join(FAIL))
    cleanup()
    sys.exit(1)
cleanup()
sys.exit(0)
