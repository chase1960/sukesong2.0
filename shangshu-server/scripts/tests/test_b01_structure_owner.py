"""R967-B01：结构权是权限维度，**表主当然有**（用户 2026-10-17）。

**测试通过 = 下面每条成立**：

1. 造一个新员工（只有 Desk User，**无** System Manager、**无** Sheet Structure Editor），
   他上传一张表 → 他是表主。
2. ★ **表主调用结构动作**（`files.sheet_row_append`）→ **200**，行真的加上。
   （改之前：动作层只放 `Sheet Structure Editor` → 403「无权执行该动作」。）
3. 另一个员工只有 **编辑共享**（能改值）→ 调用同一个结构动作 →
   **明确拒**，且拒因是「没有这张表的结构权」（**不是**「不能改这个文件」）。
   —— 这条证明动作层放宽后，**资源级真判仍在**（不是全放行）。
4. 两个员工的角色集都不含结构角色（用管理端读回认定，不靠假设）。

**为什么要有这条**：用户 2026-10-17「结构权不是一个独立的结构，这个属于权限的一部分」
+「表主对自己建的表当然有」。两层缺一不可：
- 只放宽动作 `roles` → 所有 Desk User 都能改任何表结构（全放行）；
- 只加函数内判定 → 表主过不了动作层角色闸（改之前就是这样）。

用法：
  export SS_BASE=http://127.0.0.1:3820
  python3 shangshu-server/scripts/tests/test_b01_structure_owner.py
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


t = _load('t', '/shangshu-server/scripts/test-n2-structure.py')
_ss_seed = _load('_ss_seed', '/shangshu-server/scripts/tests/_ss_seed.py')
_ss_cred = _load('_ss_cred', '/shangshu-server/scripts/tests/_ss_cred.py')

BASE = os.environ.get('SS_BASE', 'http://127.0.0.1:3820')
PW = os.environ.get('SS_D_PW') or _ss_cred.admin_pw_for(BASE)

checks, fails = [], []


def check(label, valid, detail=''):
    checks.append(label)
    if not valid:
        fails.append(label)
    print('  %s %s%s' % ('✓' if valid else '✗', label,
                         ('　—　' + str(detail)[:220]) if detail else ''))
    return bool(valid)


def result_of(st, body):
    return _ss_seed._result(st, body)


def _err(body):
    return _ss_seed._err(body)


def _rejected(st, body):
    return _ss_seed.rejected(st, body)


print('== R967-B01：表主有结构权；编辑共享不等于结构权 ==')

if not PW:
    print('\n结果： FAIL 取不到管理员口令')
    sys.exit(2)

adm = t.Client(BASE)
adm.login('Administrator', PW)

SUF = str(t.RUN)[-8:]
OWNER = 'struct-owner-%s@example.invalid' % SUF
OTHER = 'struct-other-%s@example.invalid' % SUF

try:
    # ---------- 1. 造人（只有 staff/Desk User）----------
    for email, name in ((OWNER, '结构表主'), (OTHER, '结构他人')):
        st, b = t.action(adm, 'platform.identity.create', {
            'email': email, 'display_name': name, 'role': 'staff',
            'initial_password': PW}, 'struct-id-%s' % email.split('@')[0])
        ok = st == 200 or '已存在' in _err(b)
        check('1 身份就绪 %s' % email, ok, 'HTTP %s %s' % (st, _err(b)))

    owner = t.Client(BASE)
    owner.login(OWNER, PW)
    other = t.Client(BASE)
    other.login(OTHER, PW)

    # ---------- 1b. 角色集认定（不是假设）----------
    def roles_of(c):
        st, b = c.request('GET', '/api/platform/session')
        return (b.get('roles') or b.get('user_roles') or [])

    owner_roles = roles_of(owner)
    other_roles = roles_of(other)
    check('1b 表主无结构角色（也不是管理员）',
          'Sheet Structure Editor' not in owner_roles and 'System Manager' not in owner_roles,
          'roles=%r' % owner_roles)
    check('1b 他人无结构角色（也不是管理员）',
          'Sheet Structure Editor' not in other_roles and 'System Manager' not in other_roles,
          'roles=%r' % other_roles)

    # ---------- 1c. 表主上传（personal 归属）----------
    handle = _ss_seed.seed_mixed_table(owner, run=t.RUN, promote_with=adm)
    TABLE, RID = handle['table'], handle['row_ids'][0]
    check('1c 表主建表成功（上传人=表主）', bool(TABLE), 'table=%r' % TABLE)

    cv, sv = handle['content_version'], handle['structure_version']

    # ---------- 2. ★ 表主调用结构动作 → 200 ----------
    st_o, b_o = t.action(owner, 'files.sheet_row_append', {
        'table': TABLE, 'count': 1,
        'expected_content_version': cv, 'expected_structure_version': sv,
        'op_id': 'struct-owner-append-%s' % t.RUN}, 'struct-owner-append')
    # ⚠️ `_rejected` 回的是 **tuple**（`(拒了没, 说明)`）—— `not tuple` 恒 False，
    # 第一版这么写把「200 成功」判成失败（判据自己撒谎，第 24 次）。显式解包。
    rej_o, msg_o = _rejected(st_o, b_o)
    ok_o = st_o == 200 and not rej_o
    check('2 ★ **表主**（无结构角色）加行 → 放行', ok_o,
          'HTTP %s %s %s' % (st_o, msg_o, _err(b_o)))

    # ---------- 2b. 编辑共享给他人（能改值）----------
    # 形状照 `platform.org.share_grant` 的 schema：`resource` + `access`（read|edit）+ `user`
    st_s, b_s = t.action(owner, 'platform.org.share_grant', {
        'resource': TABLE, 'access': 'edit', 'user': OTHER}, 'struct-share')
    check('2b 表主把编辑共享给他人', st_s == 200, 'HTTP %s %s' % (st_s, _err(b_s)))

    # 读版本（分享后版本可能没变，重新读认定）
    st_r, b_r = t.service(other, 'files.sheet_read', {'table': TABLE})
    rr = result_of(st_r, b_r) or {}
    cv2, sv2 = rr.get('content_version'), rr.get('structure_version')
    other_can_write = bool(rr.get('writable'))

    # ---------- 3. ★ 编辑共享 ≠ 结构权 ----------
    st_x, b_x = t.action(other, 'files.sheet_row_append', {
        'table': TABLE, 'count': 1,
        'expected_content_version': cv2, 'expected_structure_version': sv2,
        'op_id': 'struct-other-append-%s' % t.RUN}, 'struct-other-append')
    rej_x, msg_x = _rejected(st_x, b_x)
    check('3 ★ **编辑共享**用户（能改值）加行 → 明确拒「没有结构权」',
          rej_x and ('结构权' in msg_x),
          'HTTP %s writable=%r %s' % (st_x, other_can_write, msg_x))
finally:
    try:
        _ss_seed.seed_cleanup(adm, handle)
    except Exception:
        pass

print()
if not checks:
    print('结果： FAIL 零条检查被断言')
    sys.exit(1)
print('结果： ' + ('FAIL ' + '; '.join(fails) if fails else
                  'PASS R967-B01 结构权（%d 条）—— 表主放行；编辑共享不自动带结构权' % len(checks)))
sys.exit(1 if fails else 0)
