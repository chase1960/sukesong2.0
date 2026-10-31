"""BASE967-15：表格固定引用快照（`files.sheet_snapshot`）。

**测试通过 = 下面每条成立**：
1. 表主对**自己的表**导出快照 → 200，返回稳定 File 引用（`file` + `lib`）；
2. 快照字节 sha256 == 源表当前版本字节 sha256（是当前内容的冻结副本，不是新解析）；
3. `relations` 指向**原表**（`{object_id:'files.file', name:<源表>}`）；
4. 归属是**发起人个人**（`level=personal`、`owner_user=发起人`），不沿用原表归属；
5. 无下载权的另一个账号 → **明确拒**（403，不产生快照）；
6. 过期 `expected_content_version` → 明确拒（417），不建快照；
7. 同一原操作号重放 → 返回**同一个**快照 File，不重复建。

用法：
  export SS_BASE=http://127.0.0.1:3820
  python3 shangshu-server/scripts/tests/test_sheet_snapshot.py
"""
import hashlib
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


def _download(client, lib, file_ref):
    st, body = client.request(
        'GET',
        '/api/platform/file-content?ref=Shangshu%%20File%%20Center%%20File'
        '&ref_name=%s&file=%s' % (lib, file_ref))
    if isinstance(body, dict) and '_bytes' in body:
        return body['_bytes']
    return None


print('== BASE967-15 表格固定引用快照 ==')
if not PW:
    print('\n结果： FAIL 取不到管理员口令')
    sys.exit(2)

adm = t.Client(BASE)
adm.login('Administrator', PW)
owner = t.Client(BASE)
owner.login('ss-owner@example.invalid', 'b2-user-pw-2026')

handle = _ss_seed.seed_mixed_table(owner, run=t.RUN, promote_with=adm)
TABLE = handle['table']
st_r, b_r = t.service(owner, 'files.sheet_read', {'table': TABLE, 'page': 1, 'page_length': 1})
rr = result_of(st_r, b_r)
CV = rr.get('content_version')

# 源当前版本字节（用 files.versions 的固定引用）
st_v, b_v = t.service(owner, 'files.versions', {'file': TABLE})
versions = (result_of(st_v, b_v) or {}).get('versions') or []
src_ref = ((versions[0] or {}).get('source') or {}).get('file')
src_bytes = _download(owner, TABLE, src_ref)
src_sha = hashlib.sha256(src_bytes).hexdigest() if src_bytes else None
check('前置：源表与当前版本字节可得', bool(TABLE) and bool(src_sha),
      'table=%r cv=%r src_sha=%s' % (TABLE, CV, (src_sha or '')[:12]))

try:
    # ---------- 1/2/3/4 正常导出 ----------
    op = 'snap-%s' % t.RUN
    st_s, b_s = t.action(owner, 'files.sheet_snapshot', {
        'table': TABLE, 'expected_content_version': CV, 'op_id': op}, 'snap-ok-%s' % t.RUN)
    res = result_of(st_s, b_s) or {}
    check('1 表主导出自己的表 → 200 且返回稳定 File 引用',
          st_s == 200 and bool(res.get('file')) and bool(res.get('lib')),
          'HTTP %s file=%r lib=%r %s' % (st_s, res.get('file'), res.get('lib'), _err(b_s)))
    snap_bytes = _download(owner, res.get('lib'), res.get('file')) if res.get('file') else None
    check('2 快照字节 == 源表当前版本字节（冻结副本）',
          bool(snap_bytes) and hashlib.sha256(snap_bytes).hexdigest() == src_sha,
          'snap_sha=%s src_sha=%s' % ((hashlib.sha256(snap_bytes).hexdigest()[:12] if snap_bytes else None),
                                      (src_sha or '')[:12]))
    rels = res.get('relations') or []
    check('3 relations 指向原表',
          any(r.get('object_id') == 'files.file' and r.get('name') == TABLE for r in rels),
          'relations=%r' % (rels,))
    att = res.get('attribution') or {}
    check('4 归属是发起人个人',
          att.get('level') == 'personal'
          and str(att.get('owner_user') or '').lower() == 'ss-owner@example.invalid',
          'attribution=%r' % (att,))

    # ---------- 5 无下载权的另一个账号 → 403 ----------
    outsider_email = 'snap-outsider-%s@example.invalid' % str(t.RUN)[-6:]
    st_c, b_c = t.action(adm, 'platform.identity.create', {
        'email': outsider_email,
        'display_name': '快照外人', 'role': 'staff', 'initial_password': PW},
        'snap-id-%s' % t.RUN)
    outsider = t.Client(BASE)
    try:
        outsider.login(outsider_email, PW)
    except SystemExit:
        outsider = None
        check('5 前置：合成账号可登录', False,
              'HTTP %s %s' % (st_c, _err(b_c)))
    if outsider is not None:
        st_o, b_o = t.action(outsider, 'files.sheet_snapshot', {
            'table': TABLE, 'op_id': 'snap-out-%s' % t.RUN}, 'snap-out-%s' % t.RUN)
        check('5 无下载权账号导出 → 明确拒（403）',
              st_o == 403 or '权限' in _err(b_o),
              'HTTP %s %s' % (st_o, _err(b_o)))
    else:
        print('  ~ 5 未测：合成账号登录失败（不冒充通过）')

    # ---------- 6 过期版本 → 拒 ----------
    st_x, b_x = t.action(owner, 'files.sheet_snapshot', {
        'table': TABLE, 'expected_content_version': 999999,
        'op_id': 'snap-stale-%s' % t.RUN}, 'snap-stale-%s' % t.RUN)
    check('6 过期 expected_content_version → 明确拒（417）',
          st_x == 417 or '版本' in _err(b_x), 'HTTP %s %s' % (st_x, _err(b_x)))

    # ---------- 7 同操作号重放 → 同一快照 ----------
    st_r2, b_r2 = t.action(owner, 'files.sheet_snapshot', {
        'table': TABLE, 'expected_content_version': CV, 'op_id': op}, 'snap-ok-%s' % t.RUN)
    res2 = result_of(st_r2, b_r2) or {}
    check('7 同一原操作号重放 → 同一个 File（不重复建）',
          st_r2 == 200 and res2.get('file') == res.get('file'),
          '重放 file=%r 首次=%r idempotent=%r' % (res2.get('file'), res.get('file'),
                                                  (b_r2.get('result') or {}).get('idempotent')))
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
                  'PASS 表格快照（%d 条）—— 冻结当前版本、relations、个人归属、越权/过期/重放' % len(checks)))
sys.exit(1 if fails else 0)
