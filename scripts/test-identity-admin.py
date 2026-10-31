"""账号生命周期护栏回归；只允许独立自动回归站，不复用用户验收库。

与 shangshu_core/tests/test_identity_admin.py 断言同一组护栏：(1) 平台角色→Frappe 角色映射
与分组落库，(2) 确认必需、重复邮箱与非法输入拒绝，(3) 保底启用管理员与"不能停用/修改自己"，
(4) 账号清单权限与凭据不外泄。本脚本供隔离回归站执行；站点有 bench 环境时用 run-tests 跑同名用例。
"""
import json
import os
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else '').resolve()
if root.parent != Path('/private/tmp') or not root.name.startswith('shangshu-b-tests.') or (root / 'ACCEPTANCE_ONLY').exists():
    raise SystemExit('拒绝非独立自动回归站')
config = json.loads((root / 'sites/b-test.localhost/site_config.json').read_text())
if config.get('db_name') != 'shangshu_b_tests' or config.get('db_socket') != str(root / 'db.sock'):
    raise SystemExit('数据库边界不匹配')

repo = Path(__file__).resolve().parents[1]
for app in ('shangshu_core', 'shangshu_finance', 'shangshu_orders', 'shangshu_warehouse', 'shangshu_files'):
    path = repo / 'frappe_apps' / app
    if path.exists():
        sys.path.insert(0, str(path))
sys.path.insert(0, str(repo / 'frappe_apps' / 'shangshu_core'))

import frappe  # noqa: E402

os.chdir(root / 'sites')
frappe.init(site='b-test.localhost')
frappe.connect()
frappe.set_user('Administrator')

from shangshu_core.identity_admin import GROUPS, PLATFORM_ROLES, _platform_roles  # noqa: E402
from shangshu_core.install import ensure_foundation  # noqa: E402
from shangshu_core.public_api import execute_registered_action, list_identities  # noqa: E402

frappe.reload_doc('shangshu_core', 'doctype', 'shangshu_identity', force=True)
ensure_foundation()
frappe.db.commit()

checks = []


def check(label, condition, detail=''):
    checks.append((label, bool(condition), detail))
    if not condition:
        print(f'  ✗ {label} {detail}')


def act(action, payload, confirmed=True):
    return execute_registered_action(action, payload, confirmed, frappe.generate_hash(length=24))


def live_session(email):
    sid = 'identity-regression-' + frappe.generate_hash(length=24)
    frappe.db.sql('INSERT INTO `tabSessions` (sid, user, lastupdate, sessiondata, status) VALUES (%s,%s,NOW(),%s,%s)',
                  (sid, email, '{}', 'Active'))
    frappe.cache.hset('session', sid, {'user': email, 'sid': sid})
    frappe.db.commit()
    return sid


def has_session(sid):
    return bool(frappe.db.sql('SELECT sid FROM `tabSessions` WHERE sid=%s', (sid,)))


def make(email, role='staff', group='', password='pilot-strong-pw-1', confirmed=True):
    return execute_registered_action(
        'platform.identity.create',
        {'email': email, 'display_name': email.split('@')[0], 'role': role,
         'initial_password': password, 'collaboration_group': group},
        confirmed, frappe.generate_hash(length=24),
    )


created = []
try:
    print('[1] 平台角色 → Frappe 角色映射与分组落库')
    check('历史单项财务/审批角色不显示成员工', _platform_roles(['Desk User', 'Finance Approver']) == ['finance'] and _platform_roles(['Desk User', 'Expense Approver']) == ['manager'])
    email = 'reg-mgr-' + frappe.generate_hash(length=8) + '@example.invalid'
    created.append(email)
    result = make(email, 'manager', '开发')
    check('创建返回平台角色', result['result']['role'] == 'manager', result['result'])
    check('分组落库', frappe.db.get_value('Shangshu Identity', {'user': email}, 'collaboration_group') == '开发')
    check('结果不含口令字段', 'password' not in json.dumps(result, ensure_ascii=False).lower())
    roles = set(frappe.get_all('Has Role', filters={'parent': email, 'parenttype': 'User'}, pluck='role'))
    check('协作管理不借用财务能力', 'Collaboration Manager' in roles and 'Expense Approver' not in roles, sorted(roles))
    check('平台角色集合受限', set(PLATFORM_ROLES) == {'admin', 'manager', 'finance', 'staff'})
    act('platform.identity.role', {'email': email, 'roles': ['manager', 'finance']})
    combined = set(frappe.get_roles(email))
    check('管理兼财务保留两种能力、不授予系统管理员', {'Collaboration Manager', 'Finance Approver', 'Cashier'} <= combined and 'System Manager' not in combined)
    row = next(row for row in list_identities() if row['email'] == email)
    check('清单展示全部业务角色', set(row['platform_roles']) == {'manager', 'finance'})
    check('新账号默认本部门范围', row['collaboration_scope'] == 'department')
    act('platform.identity.group', {'email': email, 'collaboration_group': '管理', 'collaboration_scope': 'company'})
    act('platform.identity.group', {'email': email, 'collaboration_group': ''})
    row = next(row for row in list_identities() if row['email'] == email)
    check('旧分组请求不隐式修改范围', row['collaboration_scope'] == 'company' and row['collaboration_group'] == '')
    act('platform.identity.group', {'email': email, 'collaboration_group': '', 'collaboration_scope': 'department'})
    from shangshu_core.identity import list_collaboration_people
    people = list_collaboration_people()
    key = frappe.db.get_value('Shangshu Identity', {'user': email}, 'collaboration_key')
    check('人员目录传递未分配及范围', any(person['username'] == key and person['group'] == '' and person['scope'] == 'department' for person in people))
    act('platform.identity.group', {'email': email, 'collaboration_group': '', 'collaboration_scope': 'related'})
    row = next(row for row in list_identities() if row['email'] == email)
    check('双角色不依赖部门、关联范围持久化且身份键不变', row['collaboration_scope'] == 'related' and not row['collaboration_group'] and row['collaboration_key'] == key and set(row['platform_roles']) == {'manager', 'finance'})
    for invalid in ([], ['root'], ['manager', 'manager']):
        try:
            act('platform.identity.role', {'email': email, 'roles': invalid})
            check('拒绝非法角色组合 ' + repr(invalid), False)
        except frappe.ValidationError:
            check('拒绝非法角色组合 ' + repr(invalid), True)

    print('[2] 确认必需、重复与非法输入')
    email2 = 'reg-dup-' + frappe.generate_hash(length=8) + '@example.invalid'
    try:
        make(email2, confirmed=False)
        check('未确认不得建号', False, '未抛错')
    except frappe.ValidationError:
        check('未确认不得建号', not frappe.db.exists('User', email2))
    email3 = 'reg-bad-' + frappe.generate_hash(length=8) + '@example.invalid'
    try:
        make(email3, group='人事')
        check('非法分组拒绝', False, '未抛错')
    except frappe.ValidationError:
        check('非法分组拒绝', True)
    try:
        make(email3, password='short')
        check('短口令拒绝', False, '未抛错')
    except frappe.ValidationError:
        check('短口令拒绝', True)
    make(email3)
    created.append(email3)
    try:
        make(email3)
        check('重复邮箱拒绝', False, '未抛错')
    except frappe.ValidationError:
        check('重复邮箱拒绝', True)

    print('[2b] 登录用户名：设置、唯一与格式')
    uname_email = 'reg-uname-' + frappe.generate_hash(length=8) + '@example.invalid'
    created.append(uname_email)
    result = execute_registered_action(
        'platform.identity.create',
        {'email': uname_email, 'display_name': '短名用户', 'roles': ['staff'],
         'initial_password': 'pilot-strong-pw-1', 'username': 'shortname-' + frappe.generate_hash(length=6)},
        True, frappe.generate_hash(length=24),
    )
    check('用户名落库', frappe.db.get_value('User', uname_email, 'username') == result['result']['username'])
    dup_target = frappe.db.get_value('User', uname_email, 'username')
    uname2 = 'reg-uname2-' + frappe.generate_hash(length=8) + '@example.invalid'
    try:
        execute_registered_action(
            'platform.identity.create',
            {'email': uname2, 'display_name': '重名用户', 'roles': ['staff'],
             'initial_password': 'pilot-strong-pw-1', 'username': dup_target},
            True, frappe.generate_hash(length=24),
        )
        check('重复用户名拒绝', False, '未抛错')
    except frappe.ValidationError:
        check('重复用户名拒绝', not frappe.db.exists('User', uname2))
    except Exception:
        check('重复用户名拒绝', not frappe.db.exists('User', uname2))
    uname3 = 'reg-uname3-' + frappe.generate_hash(length=8) + '@example.invalid'
    try:
        execute_registered_action(
            'platform.identity.create',
            {'email': uname3, 'display_name': '坏格式', 'roles': ['staff'],
             'initial_password': 'pilot-strong-pw-1', 'username': 'Bad Name@x'},
            True, frappe.generate_hash(length=24),
        )
        check('非法用户名格式拒绝', False, '未抛错')
    except frappe.ValidationError:
        check('非法用户名格式拒绝', not frappe.db.exists('User', uname3))
    except Exception:
        check('非法用户名格式拒绝', not frappe.db.exists('User', uname3))

    print('[3] 保底管理员与自我护栏')
    admin_email = 'reg-adm-' + frappe.generate_hash(length=8) + '@example.invalid'
    created.append(admin_email)
    make(admin_email, 'admin')
    try:
        act('platform.identity.status', {'email': 'Administrator', 'enabled': False})
        check('不能停用自己', False, '未抛错')
    except frappe.ValidationError:
        check('不能停用自己', True)
    sid = live_session(admin_email)
    act('platform.identity.status', {'email': admin_email, 'enabled': False})
    check('停用关闭 User.enabled', not frappe.db.get_value('User', admin_email, 'enabled'))
    check('停用同步身份状态', frappe.db.get_value('Shangshu Identity', {'user': admin_email}, 'status') == 'Disabled')
    check('停用事务提交前不提前清除会话', has_session(sid))
    frappe.db.rollback()
    check('停用回滚保留账号及会话', bool(frappe.db.get_value('User', admin_email, 'enabled')) and has_session(sid))
    act('platform.identity.status', {'email': admin_email, 'enabled': False})
    frappe.db.commit()
    check('停用提交后撤销数据库与缓存会话', not has_session(sid) and not frappe.cache.hget('session', sid))
    act('platform.identity.status', {'email': admin_email, 'enabled': True})
    try:
        act('platform.identity.role', {'email': 'Administrator', 'role': 'staff'})
        check('不能修改自己的角色', False, '未抛错')
    except frappe.ValidationError:
        check('不能修改自己的角色', True)
    act('platform.identity.role', {'email': admin_email, 'role': 'staff'})
    roles = set(frappe.get_all('Has Role', filters={'parent': admin_email, 'parenttype': 'User'}, pluck='role'))
    check('改角色移除旧管理员角色', 'System Manager' not in roles, sorted(roles))
    check('分组枚举固定', GROUPS == ('管理', '开发', '财务'))

    print('[4] 清单权限与凭据')
    listing = list_identities()
    check('管理员可读账号清单', len(listing) >= 4, len(listing))
    blob = json.dumps(listing, ensure_ascii=False, default=str).lower()
    check('清单不含口令/密钥/会话', not any(word in blob for word in ('password', 'api_key', 'session')))
    # 审计摘要必须脱敏：复合字段名（new_password/initial_password）曾因精确匹配漏过明文。
    probe = 'reg-audit-' + frappe.generate_hash(length=8) + '@example.invalid'
    created.append(probe)
    make(probe, password='plain-pw-probe-1')
    latest = frappe.get_all('Shangshu Action Execution Audit',
                            filters={'action_id': 'platform.identity.create'},
                            order_by='creation desc', limit=1)
    summary = str(frappe.db.get_value('Shangshu Action Execution Audit', latest[0].name, 'input_summary_json'))
    check('审计不落明文初始密码', 'plain-pw-probe-1' not in summary and '已脱敏' in summary, summary[:120])
    password_sid = live_session(probe)
    reset_probe = execute_registered_action('platform.identity.password',
                                            {'email': probe, 'new_password': 'plain-pw-probe-2'},
                                            True, frappe.generate_hash(length=24))
    reset_row = frappe.get_all('Shangshu Action Execution Audit',
                               filters={'action_id': 'platform.identity.password'},
                               order_by='creation desc', limit=1)
    reset_summary = str(frappe.db.get_value('Shangshu Action Execution Audit', reset_row[0].name, 'input_summary_json'))
    check('审计不落明文新密码', 'plain-pw-probe-2' not in reset_summary and '已脱敏' in reset_summary, reset_summary[:120])
    check('重置事务提交前保留会话', has_session(password_sid))
    frappe.db.commit()
    check('重置提交后撤销数据库与缓存会话', not has_session(password_sid) and not frappe.cache.hget('session', password_sid))
    viewer = 'reg-view-' + frappe.generate_hash(length=8) + '@example.invalid'
    created.append(viewer)
    frappe.get_doc({'doctype': 'User', 'email': viewer, 'first_name': 'readonly',
                    'send_welcome_email': 0, 'roles': [{'role': 'Desk User'}]}).insert(ignore_permissions=True)
    frappe.db.commit()
    frappe.set_user(viewer)
    try:
        list_identities()
        check('非管理员拒绝读清单', False, '未抛错')
    except frappe.PermissionError:
        check('非管理员拒绝读清单', True)
    try:
        act('platform.identity.create', {'email': 'x-' + frappe.generate_hash(length=6) + '@example.invalid',
                                         'display_name': '无权限', 'role': 'staff', 'initial_password': 'pilot-pw-12345'})
        check('非管理员无法建号', False)
    except frappe.PermissionError:
        check('非管理员无法建号', True)

finally:
    print('[5] 清理本次创建的回归账号')
    frappe.set_user('Administrator')
    for email in created:
        for row in frappe.get_all('Shangshu Identity', filters={'user': email}, pluck='name'):
            frappe.delete_doc('Shangshu Identity', row, ignore_permissions=True, force=True)
        if frappe.db.exists('User', email):
            frappe.delete_doc('User', email, ignore_permissions=True, force=True)
    frappe.db.commit()
    remaining = [email for email in created if frappe.db.exists('User', email)]
    check('回归账号已清理', not remaining, remaining)
    frappe.destroy()

failed = [label for label, ok, _ in checks if not ok]
print(f'\n结果：{len(checks) - len(failed)}/{len(checks)} 通过')
if failed:
    raise SystemExit('失败项：' + '；'.join(failed))
print('账号生命周期护栏回归通过')
