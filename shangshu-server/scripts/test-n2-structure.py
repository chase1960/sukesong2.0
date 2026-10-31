"""N2-B1/B2 结构动作行为测试（真实 API 链）。

测试通过 = 什么成立（逐项）：
  N2B-01 末尾加行：content+1/结构版本不变；新 row_id 全新不复用；旧行值不变；下载解析多出 N 行。
  N2B-02 末尾加列：content+1/structure+1；新列表头在下载解析里；空表头/重名表头被拒且文件字节不漂。
  N2B-03 改表头：structure+1；改名后带旧结构版本的写被拒（旧结构不命中新含义）；按新表头写成功。
  N2B-04 改表名：table_title 变（.xlsx 固定）、sheet 身份与内容/结构版本都不变、xlsx 未动。
  N2B-05 版本/幂等/失败一致：同编号重试只生效一次；注入 file-write/post-save 失败无半次成功、版本不漂、回执可查。
  N2B-06 加列不建 DDL（反例）：结构操作前后业务对象/字段清单不变。
  N2B-07 三身份授权矩阵：可改结构/仅改值/只读各自放行与拒绝面，直接调接口同样拦。
  N2B-08 搜索完整定位：命中行带 row_index+matches，超一页可翻完，界外唯一命中可到。
  N2B-09 外部覆盖边界：new_version 对 xlsx 拒收、同名上传恒新资源、内部受管写照旧。
  N2B-10 解析缓存 O(1)：写后首读命中预热（D4）、同版本翻 10 页解析次数不涨，
    解析次数/耗时从 diagnostics 可读。〔2026-10-12 随 D4 改判据：原「新版本首读必
    miss」是写后不预热时代的见证；D4 写后用验证门重开的那份簿直接把新版本焐进缓存，
    首读应 hit 不应 miss。失效的真见证（读回必新值）在 N2B-11。〕
  N2B-11 缓存键含内容版本：改一格后读回必是新值（不吐旧缓存），写后首读 hit 且
    重读解析次数不动。〔同上改判据：原「miss、解析+1」随 D4 撤掉——值新 + 键含版本
    才是「没按文件名蒙混」的见证。〕
  N2B-12 缓存不跨身份泄漏：缓存热了无权身份照样 403 且不带表内容。
  N2B-13 病态已用区域：样式/列宽把 dimension 撑到 XFD/几万行的表仍能打开，解析裁到真实数据范围。
用法：python3 test-n2-structure.py --base http://127.0.0.1:3820 --fixture <样本.xlsx> \
        --verifier scripts/tests/verify_xlsx_roundtrip.py [--compose-project shangshu-local-b]
口令只从 --password/--admin-password 或环境变量来，不设默认值。
"""
import argparse
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'tests'))
import _ss_fixture  # noqa: E402  测试夹具默认归属（不是产品默认）
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

CHECKS = []
RUN = str(int(time.time()))


def check(item, label, valid):
    CHECKS.append((item, label, bool(valid)))
    print(('  ✓ ' if valid else '  ✗ ') + label)
    return bool(valid)


def receipt_key(key):
    return f'{key}-{RUN}'


class Client:
    def __init__(self, base):
        self.base = base.rstrip('/')
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.user = None

    def request(self, method, path, body=None):
        data = json.dumps(body).encode('utf-8') if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header('accept', 'application/json')
        if data is not None:
            req.add_header('content-type', 'application/json')
        try:
            with self.opener.open(req, timeout=60) as resp:
                raw = resp.read()
                status = resp.status
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            status = exc.code
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            return 0, {'_transport_error': f'{type(exc).__name__}: {exc}'}
        if path.startswith('/api/platform/file-content'):
            return status, {'_bytes': raw}
        try:
            parsed = json.loads(raw.decode('utf-8')) if raw else {}
        except json.JSONDecodeError:
            parsed = {'_raw': raw.decode('utf-8', 'replace')}
        return status, parsed

    def login(self, username, password):
        status, body = self.request('POST', '/api/platform/login',
                                    {'username': username, 'password': password})
        if status != 200 or not body.get('ok'):
            raise SystemExit(f'登录失败 {username}: HTTP {status} {body}')
        self.user = username
        return body


def action(client, action_id, payload, key):
    # **测试夹具补归属**（不是产品默认值，见 scripts/tests/_ss_fixture.py 顶部）：
    # 产品侧已「新建不传归属就拒」（ATT-⑨ 钉着），而测版本/权限/结构工具的用例
    # **本不该各讲一个归属故事**（§13 按层测试）。这里统一补一个夹具归属。
    # **谁要测归属/权限，自己显式传** —— fill() 不覆盖已传的值。
    # ⚠️ ATT-⑨ 自带 `_act9` 绕开本函数，**够不着这个夹具**（靠约定隔离不够）。
    payload = _ss_fixture.fill(action_id, payload)
    return client.request('POST', f'/api/platform/actions/{action_id}/execute',
                          {'payload': payload, 'confirmed': True, 'idempotency_key': receipt_key(key)})


def service(client, service_id, payload):
    return client.request('POST', f'/api/platform/services/{service_id}/invoke', {'payload': payload})


def download(client, table, file_ref):
    return client.request('GET', f'/api/platform/file-content?ref=Shangshu%20File%20Center%20File'
                                 f'&ref_name={table}&file={file_ref}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True)
    ap.add_argument('--fixture', required=True)
    ap.add_argument('--verifier', required=True)
    ap.add_argument('--password', default=os.environ.get('TEST_USER_PASSWORD'))
    ap.add_argument('--admin-password', default=os.environ.get('ADMIN_PASSWORD'))
    ap.add_argument('--compose-project')
    ap.add_argument('--only')
    ap.add_argument('--json-out')
    args = ap.parse_args()
    if 'localhost' not in args.base and '127.0.0.1' not in args.base and '-test' not in args.base:
        raise SystemExit('只允许本机回环或 -test 测试入口')
    if not args.password or not args.admin_password:
        raise SystemExit('口令不设脚本默认值：--password/--admin-password 或 TEST_USER_PASSWORD/ADMIN_PASSWORD')

    owner = Client(args.base)
    owner_login = owner.login('ss-owner@example.invalid', args.password)
    outsider = Client(args.base)
    outsider.login('ss-outsider@example.invalid', args.password)
    admin = Client(args.base)
    admin.login('Administrator', args.admin_password)
    reader = Client(args.base)
    reader.login('ss-reader@example.invalid', args.password)
    editor = Client(args.base)
    try:
        editor.login('ss-editor@example.invalid', args.password)
    except SystemExit:
        editor = None  # 老环境没建 ss-editor：N2B-07 走 NOT_RUN

    fixture_b64 = base64.b64encode(open(args.fixture, 'rb').read()).decode()
    ctx = dict(owner=owner, outsider=outsider, admin=admin, reader=reader, editor=editor,
               owner_identity=owner_login.get('identity_id'),
               fixture_b64=fixture_b64,
               verifier=args.verifier, compose_project=args.compose_project,
               workdir=os.path.join('/tmp', f'n2-structure-{RUN}'))
    os.makedirs(ctx['workdir'], exist_ok=True)

    status, body = action(owner, 'files.upload', {
        'file_name': f'n2-结构样本-{RUN}.xlsx', 'content_base64': fixture_b64, 'directory': '/',
    }, 'n2-upload')
    table = (body.get('result') or {}).get('file')
    ctx['table'] = table
    check('SETUP', f'上传样本得表身份 {table}', status == 200 and body.get('ok') and bool(table))

    status, sheet = service(owner, 'files.sheet_read', {'table': table})
    ctx['sheet'] = sheet.get('sheet')
    ctx['sheet_title'] = sheet.get('sheet_title')
    ctx['table_title'] = sheet.get('table_title')
    ctx['content_version'] = sheet.get('content_version')
    ctx['structure_version'] = sheet.get('structure_version')
    ctx['headers'] = sheet.get('headers') or []
    ctx['row_ids'] = [r['row_id'] for r in (sheet.get('rows') or [])]
    status, detail = service(owner, 'files.versions', {'file': table})
    versions = detail.get('versions') or []
    ctx['version_count'] = len(versions)
    ctx['file_ref'] = versions[0]['source']['file']
    check('SETUP', '读到表头/行/版本', bool(ctx['headers']) and ctx['row_ids'] and ctx['content_version'])

    items = [
        ('N2B-01', item_row_append),
        ('N2B-02', item_column_append),
        ('N2B-03', item_header_rename),
        ('N2B-04', item_sheet_rename),
        ('N2B-05', item_idempotent_failure),
        ('N2B-06', item_no_ddl),
        ('N2B-07', item_auth_matrix),
        ('N2B-08', item_search_locate),
        ('N2B-09', item_external_boundary),
        ('N2B-10', item_cache_pages),
        ('N2B-11', item_cache_invalidate),
        ('N2B-12', item_cache_auth_leak),
        ('N2B-13', item_inflated_dimension),
    ]
    for name, fn in items:
        if args.only and args.only != name:
            continue
        print(f'\n== {name} ==')
        try:
            fn(ctx)
        except Exception as exc:
            check(name, f'执行异常：{type(exc).__name__}: {exc}', False)

    failed = [c for c in CHECKS if not c[2]]
    print()
    for item, label, ok in CHECKS:
        if not ok:
            print(f'FAIL {item} {label}')
    print(f'\n{len(CHECKS) - len(failed)}/{len(CHECKS)} 通过')
    if args.json_out:
        with open(args.json_out, 'w') as fh:
            json.dump({'checks': CHECKS, 'base': args.base}, fh, ensure_ascii=False, indent=1)
    sys.exit(1 if failed else 0)


def _refresh(ctx):
    o = ctx['owner']
    status, sheet = service(o, 'files.sheet_read', {'table': ctx['table']})
    ctx['content_version'] = sheet.get('content_version')
    ctx['structure_version'] = sheet.get('structure_version')
    ctx['headers'] = sheet.get('headers') or []
    return sheet


def item_row_append(ctx):
    """N2B-01：测试通过 = 末尾加行后 content+1/结构不变、新行 ID 全新不复用、旧行值不变、下载多出 N 行。"""
    item = 'N2B-01'
    o = ctx['owner']
    table = ctx['table']
    before_v, before_s = ctx['content_version'], ctx['structure_version']
    old_ids = set(ctx['row_ids'])
    before = service(o, 'files.sheet_read', {'table': table})[1]

    status, body = action(o, 'files.sheet_row_append', {
        'table': table, 'sheet': '', 'expected_content_version': before_v,
        'expected_structure_version': before_s, 'count': 2,
    }, 'n2-row-append')
    result = body.get('result') or {}
    check(item, '加行成功且返回新 row_ids', status == 200 and body.get('ok') and len(result.get('row_ids') or []) == 2)
    new_ids = result.get('row_ids') or []
    check(item, '新行 ID 全新且不与旧行重复', all(r not in old_ids for r in new_ids) and len(set(new_ids)) == 2)
    check(item, 'content_version+1 且 structure_version 不变',
          result.get('content_version') == before_v + 1 and result.get('structure_version') == before_s)
    after = service(o, 'files.sheet_read', {'table': table})[1]
    after_ids = [r['row_id'] for r in (after.get('rows') or [])]
    check(item, '旧行 ID 不变且追加在末尾', after_ids[:len(ctx['row_ids'])] == ctx['row_ids']
          and after_ids[-2:] == new_ids)
    before_vals = {r['row_id']: r['values'] for r in (before.get('rows') or [])}
    unchanged = all(after['rows'][i]['values'] == before_vals.get(ctx['row_ids'][i])
                    for i in range(len(ctx['row_ids'])))
    check(item, '旧行值一字未动', unchanged)
    indexed = [r for r in (after.get('rows') or []) if r['row_id'] in new_ids]
    check(item, '新行带 row_index（工作表行号）且旧行 row_index 不变',
          all(r.get('row_index') == after_ids.index(r['row_id']) + 2 for r in indexed)
          and all(after['rows'][i].get('row_index') == i + 2 for i in range(len(ctx['row_ids']))))
    check(item, '下载独立解析多出 2 行（旧值不变在上一条 API 对照已核）', _verify(ctx, rows_added=2))
    _refresh(ctx)  # 版本已推进，后续项必须用新版本闩


def item_column_append(ctx):
    """N2B-02：测试通过 = 加列后 structure+1、新表头在下载文件里；空/重名表头被拒且文件字节不漂。"""
    item = 'N2B-02'
    o = ctx['owner']
    table = ctx['table']
    before_v, before_s = ctx['content_version'], ctx['structure_version']

    status, body = action(o, 'files.sheet_column_append', {
        'table': table, 'sheet': '', 'expected_content_version': before_v,
        'expected_structure_version': before_s, 'header': f'新列{RUN}',
    }, 'n2-col-append')
    result = body.get('result') or {}
    check(item, '加列成功且 content+1/structure+1',
          status == 200 and body.get('ok')
          and result.get('content_version') == before_v + 1
          and result.get('structure_version') == before_s + 1)
    sheet = _refresh(ctx)
    check(item, '新表头出现在末列', (sheet.get('headers') or [])[-1] == f'新列{RUN}')

    stable_v, stable_s = ctx['content_version'], ctx['structure_version']
    for label, header, key in (('空表头被拒', '   ', 'n2-col-empty'), ('重名表头被拒', ctx['headers'][0], 'n2-col-dup')):
        status, body = action(o, 'files.sheet_column_append', {
            'table': table, 'sheet': '', 'expected_content_version': stable_v,
            'expected_structure_version': stable_s, 'header': header,
        }, key)
        check(item, f'{label}（HTTP {status}, {str(body.get("error") or "")[:30]}）',
              status >= 400 or body.get('ok') is False)
    after = _refresh(ctx)
    check(item, '被拒后版本不漂', after.get('content_version') == stable_v
          and after.get('structure_version') == stable_s)
    check(item, '下载独立解析含新表头且旧内容保持', _verify(ctx, header_added=f'新列{RUN}'))


def item_header_rename(ctx):
    """N2B-03：测试通过 = 改表头 structure+1；改名后旧结构写被拒、新表头写成功；下载表头已变。"""
    item = 'N2B-03'
    o = ctx['owner']
    table = ctx['table']
    old_header = ctx['headers'][0]
    new_header = f'改名{RUN}'
    before_v, before_s = ctx['content_version'], ctx['structure_version']

    status, body = action(o, 'files.sheet_header_rename', {
        'table': table, 'sheet': '', 'expected_content_version': before_v,
        'expected_structure_version': before_s, 'from_header': old_header, 'to_header': new_header,
    }, 'n2-hdr-rename')
    result = body.get('result') or {}
    check(item, '改表头成功且 structure+1',
          status == 200 and body.get('ok') and result.get('structure_version') == before_s + 1
          and result.get('content_version') == before_v + 1)
    sheet = _refresh(ctx)
    check(item, '表头已是新名', sheet.get('headers', [None])[0] == new_header)

    status, body = action(o, 'files.sheet_cell_write', {
        'table': table, 'sheet': '', 'row_id': ctx['row_ids'][0], 'header': new_header,
        'expected_content_version': ctx['content_version'],
        'expected_structure_version': before_s,  # 旧结构版本
        'value': {'type': 'text', 'value': 'x'},
    }, 'n2-hdr-stale')
    check(item, '带旧结构版本的写被拒（旧结构不命中新含义）', status >= 400 or body.get('ok') is False)

    status, body = action(o, 'files.sheet_cell_write', {
        'table': table, 'sheet': '', 'row_id': ctx['row_ids'][0], 'header': new_header,
        'expected_content_version': ctx['content_version'],
        'expected_structure_version': ctx['structure_version'],
        'value': {'type': 'text', 'value': f'新表头可写{RUN}'},
    }, 'n2-hdr-write')
    check(item, '按新表头写成功', status == 200 and body.get('ok'))
    _refresh(ctx)
    check(item, '下载独立解析表头已变且值写进新列', _verify(ctx, header_renamed=(old_header, new_header)))


def item_sheet_rename(ctx):
    """N2B-04：测试通过 = 改表名后 table_title 变（扩展名固定落 .xlsx）、sheet 身份不变、
    内容/结构版本都不动、xlsx 字节不动（下载工作表名不变）。"""
    item = 'N2B-04'
    o = ctx['owner']
    table = ctx['table']
    before_sheet = ctx['sheet']
    before_v, before_s = ctx['content_version'], ctx['structure_version']
    title = f'改名表{RUN}'
    expect_title = title + '.xlsx'

    status, body = action(o, 'files.sheet_rename', {
        'table': table, 'sheet': '', 'expected_content_version': before_v,
        'expected_structure_version': before_s, 'title': title,
    }, 'n2-sheet-rename')
    result = body.get('result') or {}
    check(item, '改表名成功且 content/structure 版本都不动、table_title 带 .xlsx',
          status == 200 and body.get('ok') and result.get('content_version') == before_v
          and result.get('structure_version') == before_s
          and result.get('table_title') == expect_title)
    sheet = _refresh(ctx)
    check(item, 'sheet 身份不变、table_title 已变',
          sheet.get('sheet') == before_sheet and sheet.get('table_title') == expect_title)
    check(item, '下载文件工作表名不变（xlsx 未动）', _verify(ctx, sheet_title=ctx.get('sheet_title')))


def item_idempotent_failure(ctx):
    """N2B-05：测试通过 = 同编号重试只生效一次；注入失败无半次成功、版本不漂、回执可查。"""
    item = 'N2B-05'
    o = ctx['owner']
    table = ctx['table']
    payload = {
        'table': table, 'sheet': '', 'expected_content_version': ctx['content_version'],
        'expected_structure_version': ctx['structure_version'], 'count': 1,
    }
    status, first = action(o, 'files.sheet_row_append', payload, 'n2-idem')
    v1 = (first.get('result') or {}).get('content_version')
    check(item, '首次加行成功', status == 200 and first.get('ok') and v1)
    status, second = action(o, 'files.sheet_row_append', payload, 'n2-idem')
    v2 = (second.get('result') or {}).get('content_version')
    check(item, '同编号重试 idempotent=true 且版本不双跳', second.get('idempotent') is True and v2 == v1)
    _refresh(ctx)

    project = ctx.get('compose_project')
    for point in ('file-write', 'post-save'):
        if not project:
            check(item, f'{point} 注入（NOT_RUN：未给 --compose-project）', True)
            continue
        proc = subprocess.run(['docker', 'exec', f'{project}-frappe-1', 'bash', '-lc',
                               f'echo {point} > /tmp/ss-fault-point && cat /tmp/ss-fault-point'],
                              capture_output=True, text=True)
        if proc.returncode != 0 or proc.stdout.strip() != point:
            check(item, f'{point} 断点未写进容器（结果不可信）', False)
            continue
        fv, fs = ctx['content_version'], ctx['structure_version']
        try:
            status, body = action(o, 'files.sheet_row_append', {
                'table': table, 'sheet': '', 'expected_content_version': fv,
                'expected_structure_version': fs, 'count': 1,
            }, f'n2-fault-{point}')
            check(item, f'{point} 故障时回失败、无假成功', status >= 400 or body.get('ok') is False)
        finally:
            subprocess.run(['docker', 'exec', f'{project}-frappe-1', 'bash', '-lc',
                            'rm -f /tmp/ss-fault-point'], capture_output=True)
        after = _refresh(ctx)
        check(item, f'{point} 故障后版本不漂（无半次成功）',
              after.get('content_version') == fv and after.get('structure_version') == fs)
        status, receipt = o.request('GET', f'/api/platform/action-requests/{receipt_key(f"n2-fault-{point}")}')
        check(item, f'{point} 回执可查', status == 200 and str(receipt.get('status')) not in ('NotFound', 'not_found', 'None'))


def item_auth_matrix(ctx):
    """N2B-07：测试通过 = 三身份授权矩阵成立——可改结构（结构角色属主/管理员）四动作放行；
    仅改值（上传人无结构角色）写格放行但结构动作被拒；只读身份读得到但写/改结构全拒；
    直接调接口同样拦（不是前端藏按钮）。"""
    item = 'N2B-07'
    if not ctx.get('editor'):
        check(item, 'NOT_RUN：缺 ss-editor 身份（create_users.py 未建）', True)
        return
    o, editor, admin = ctx['owner'], ctx['editor'], ctx['admin']
    # editor 自己上传一张表：可写但无结构授权
    status, body = action(editor, 'files.upload', {
        'file_name': f'n2-auth-editor-{RUN}.xlsx', 'content_base64': ctx['fixture_b64'], 'directory': '/',
    }, 'n2-auth-up')
    table2 = (body.get('result') or {}).get('file')
    check(item, '仅改值身份上传得自己的表', status == 200 and body.get('ok') and bool(table2))
    status, sheet2 = service(editor, 'files.sheet_read', {'table': table2})
    ids2 = [r['row_id'] for r in (sheet2.get('rows') or [])]
    v2, s2 = sheet2.get('content_version'), sheet2.get('structure_version')

    status, body = action(editor, 'files.sheet_cell_write', {
        'table': table2, 'sheet': '', 'row_id': ids2[0], 'header': (sheet2.get('headers') or [''])[0],
        'expected_content_version': v2, 'expected_structure_version': s2,
        'value': {'type': 'text', 'value': f'改值{RUN}'},
    }, 'n2-auth-write')
    check(item, '仅改值身份写格成功（上传人可写）', status == 200 and body.get('ok'))
    # 刷新版本再试结构动作：拒绝原因必须是「无权」，不能是版本过期
    status, sheet2 = service(editor, 'files.sheet_read', {'table': table2})
    v2, s2 = sheet2.get('content_version'), sheet2.get('structure_version')

    for label, act_id, key in (('加行', 'files.sheet_row_append', 'n2-auth-append'),
                               ('加列', 'files.sheet_column_append', 'n2-auth-col'),
                               ('改表头', 'files.sheet_header_rename', 'n2-auth-hdr'),
                               ('改表名', 'files.sheet_rename', 'n2-auth-title')):
        payload = {'table': table2, 'sheet': '', 'expected_content_version': v2,
                   'expected_structure_version': s2}
        if act_id == 'files.sheet_row_append':
            payload['count'] = 1
        elif act_id == 'files.sheet_column_append':
            payload['header'] = f'越权列{RUN}'
        elif act_id == 'files.sheet_header_rename':
            payload['from_header'] = (sheet2.get('headers') or [''])[0]
            payload['to_header'] = f'越权改{RUN}'
        else:
            payload['title'] = f'越权表{RUN}'
        status, body = action(editor, act_id, payload, key)
        check(item, f'仅改值身份{label}被拒（HTTP {status}）', status >= 400 or body.get('ok') is False)

    status, body = action(admin, 'files.sheet_row_append', {
        'table': table2, 'sheet': '', 'expected_content_version': sheet2.get('content_version'),
        'expected_structure_version': s2, 'count': 1,
    }, 'n2-auth-admin')
    check(item, '管理员（System Manager）对他人表加行成功', status == 200 and body.get('ok'))

    status, body = action(o, 'files.sheet_row_append', {
        'table': ctx['table'], 'sheet': '',
        'expected_content_version': ctx['content_version'],
        'expected_structure_version': ctx['structure_version'], 'count': 1,
    }, 'n2-auth-owner')
    check(item, '结构角色属主加行成功（可改结构）', status == 200 and body.get('ok'))
    _refresh(ctx)

    # 只读身份：读得到、写与改结构全拒
    status, readback = service(ctx['reader'], 'files.sheet_read', {'table': ctx['table']})
    check(item, '只读身份读得到（writable=false）',
          status == 200 and readback.get('writable') is False and readback.get('rows'))
    status, body = action(ctx['reader'], 'files.sheet_cell_write', {
        'table': ctx['table'], 'sheet': '', 'row_id': ctx['row_ids'][0],
        'header': ctx['headers'][0], 'expected_content_version': ctx['content_version'],
        'expected_structure_version': ctx['structure_version'],
        'value': {'type': 'text', 'value': 'x'},
    }, 'n2-auth-ro-write')
    check(item, '只读身份写格被拒', status >= 400 or body.get('ok') is False)
    status, body = action(ctx['reader'], 'files.sheet_row_append', {
        'table': ctx['table'], 'sheet': '', 'expected_content_version': ctx['content_version'],
        'expected_structure_version': ctx['structure_version'], 'count': 1,
    }, 'n2-auth-ro-append')
    check(item, '只读身份加行被拒', status >= 400 or body.get('ok') is False)


def item_search_locate(ctx):
    """N2B-08：测试通过 = 搜索命中行带 row_index 与 matches（每命中格的表头+格坐标）；
    命中超过一页能翻完且总数准确；界外唯一命中可查可到；无匹配回空集。"""
    item = 'N2B-08'
    o = ctx['owner']
    table = ctx['table']
    marker = f'定位标{RUN}'
    # 加 3 行并各写入同一标记值，命中数可预期
    status, body = action(o, 'files.sheet_row_append', {
        'table': table, 'sheet': '', 'expected_content_version': ctx['content_version'],
        'expected_structure_version': ctx['structure_version'], 'count': 3,
    }, 'n2-search-append')
    new_ids = (body.get('result') or {}).get('row_ids') or []
    check(item, f'加 3 行做搜索样本（HTTP {status}, {str(body.get("error") or "")[:40]}）',
          status == 200 and body.get('ok') and len(new_ids) == 3)
    sheet = _refresh(ctx)
    col_types = sheet.get('column_types') or {}
    # 挑文本列写标记，避开列类型闸（数字列拒收文本）
    header0 = next((h for h in ctx['headers'] if col_types.get(h) in ('text', None) and h),
                   (ctx['headers'] or [''])[0])
    for rid in new_ids:
        status, body = action(o, 'files.sheet_cell_write', {
            'table': table, 'sheet': '', 'row_id': rid, 'header': header0,
            'expected_content_version': ctx['content_version'],
            'expected_structure_version': ctx['structure_version'],
            'value': {'type': 'text', 'value': marker},
        }, f'n2-search-write-{rid}')
        if status != 200 or not body.get('ok'):
            check(item, f'写入标记行 {rid} 失败：{str(body.get("error") or "")[:60]}', False)
        _refresh(ctx)

    status, page1 = service(o, 'files.sheet_read', {
        'table': table, 'search': marker, 'page': 1, 'page_length': 1,
    })
    total = page1.get('total_rows')
    check(item, '搜索命中 3 行且 total_rows=3', total == 3 and len(page1.get('rows') or []) == 1)
    got_ids, matched = [], True
    for p in (1, 2, 3):
        status, body = service(o, 'files.sheet_read', {
            'table': table, 'search': marker, 'page': p, 'page_length': 1,
        })
        for r in (body.get('rows') or []):
            got_ids.append(r['row_id'])
            hits = r.get('matches') or []
            if not hits or not all('header' in h and 'cell' in h for h in hits):
                matched = False
            if hits:
                cell_row = int(''.join(ch for ch in hits[0]['cell'] if ch.isdigit()) or 0)
                if r.get('row_index') != cell_row:
                    matched = False
    check(item, '逐页翻完 3 个命中且 row_id 无重复无遗漏', sorted(got_ids) == sorted(new_ids))
    check(item, '命中行带 row_index 与 matches（表头+格坐标，且行号一致）', matched)

    status, body = service(o, 'files.sheet_read', {'table': table, 'search': f'绝无此词{RUN}', 'page': 1})
    check(item, '无匹配回空集且 total_rows=0', body.get('total_rows') == 0 and not (body.get('rows') or []))


def item_external_boundary(ctx):
    """N2B-09：测试通过 = 外部字节不能覆盖已有表：files.new_version 对 xlsx 拒收、
    同名再上传恒新资源；内部受管写仍写同资源新版本。"""
    item = 'N2B-09'
    o = ctx['owner']
    table = ctx['table']
    status, detail = service(o, 'files.versions', {'file': table})
    versions_before = len(detail.get('versions') or [])
    status, body = action(o, 'files.new_version', {
        'file': table, 'content_base64': ctx['fixture_b64'],
    }, 'n2-ext-newver')
    check(item, f'new_version 对已有 xlsx 表被拒（HTTP {status}, {str(body.get("error") or "")[:40]}）',
          status >= 400 or body.get('ok') is False)
    status, detail = service(o, 'files.versions', {'file': table})
    versions_after = len(detail.get('versions') or [])
    check(item, '被拒后版本数不漂', versions_after == versions_before)

    status, body = action(o, 'files.upload', {
        'file_name': ctx.get('table_title') or f'n2-结构样本-{RUN}.xlsx',
        'content_base64': ctx['fixture_b64'], 'directory': '/',
    }, 'n2-ext-samename')
    twin = (body.get('result') or {}).get('file')
    check(item, '同名再上传是新资源（表身份不同）', status == 200 and twin and twin != table)

    status, body = action(o, 'files.sheet_cell_write', {
        'table': table, 'sheet': '', 'row_id': ctx['row_ids'][0], 'header': ctx['headers'][0],
        'expected_content_version': ctx['content_version'],
        'expected_structure_version': ctx['structure_version'],
        'value': {'type': 'text', 'value': f'内部写{RUN}'},
    }, 'n2-ext-internal')
    check(item, '内部受管写仍成功（同资源新版本）', status == 200 and body.get('ok'))
    _refresh(ctx)


def item_cache_pages(ctx):
    """N2B-10：测试通过 = 加行制造新版本后首读命中写后预热（cache=hit——D4：保存时把
    验证门重开的那份簿的解析结果焐进新版本缓存键，写后打开不再冷解析穿超时）；
    同版本翻 10 页解析次数不涨（O(页数)→O(1)）、其余 9 页全 hit；
    解析次数/耗时从回包 diagnostics 读得到；10 页行集无重复无遗漏。
    〔2026-10-12 判据变更：原「新版本首读必 miss」随 D4 写后预热撤掉。〕"""
    item = 'N2B-10'
    o = ctx['owner']
    table = ctx['table']
    st, cur = service(o, 'files.sheet_read', {'table': table, 'page': 1, 'page_length': 1})
    total = cur.get('total_rows') or 0
    # 总是加行制造新内容版本（顺带补到 ≥12 行够翻 10 页）；加行后第一读就是「新版本首读」
    st, body = action(o, 'files.sheet_row_append', {
        'table': table, 'sheet': '', 'expected_content_version': ctx['content_version'],
        'expected_structure_version': ctx['structure_version'], 'count': max(1, 12 - total),
    }, 'n2-cache-topup')
    check(item, f'加行制造新内容版本（前提, HTTP {st}）', st == 200 and body.get('ok'))
    st, first = service(o, 'files.sheet_read', {'table': table, 'page': 1, 'page_length': 1})
    ctx['content_version'] = first.get('content_version')
    ctx['structure_version'] = first.get('structure_version')
    d1 = first.get('diagnostics') or {}
    check(item, '新版本首读命中写后预热（D4），diagnostics 带 cache/parse_ms/parse_count',
          d1.get('cache') == 'hit' and 'parse_ms' in d1 and 'parse_count' in d1)
    parse0 = d1.get('parse_count')
    seen = [r['row_id'] for r in (first.get('rows') or [])]
    pages_ok, hits = True, 0
    for p in range(2, 11):
        st, body = service(o, 'files.sheet_read', {'table': table, 'page': p, 'page_length': 1})
        d = body.get('diagnostics') or {}
        if d.get('cache') == 'hit':
            hits += 1
        if d.get('parse_count') != parse0:
            pages_ok = False
        seen += [r['row_id'] for r in (body.get('rows') or [])]
    check(item, '再翻 9 页全命中缓存且解析次数不涨（O(页数)→O(1)）', pages_ok and hits == 9)
    check(item, '10 页行集无重复（缓存没砍数据）', len(seen) == 10 and len(set(seen)) == 10)


def item_cache_invalidate(ctx):
    """N2B-11：测试通过 = 改一格后立刻读回必是新值（不吐旧缓存——缓存键含内容版本，
    不按文件名蒙混）；写后首读命中预热（cache=hit，D4：写读共享同一次解析，读不再
    冷解析）；同版本重读仍 hit、解析次数不动、值仍新。
    〔2026-10-12 判据变更：原「miss、解析+1」随 D4 写后预热撤掉——失效的真见证是
    「读回必新值」，不是「必须冷解析一遍」。〕"""
    item = 'N2B-11'
    o = ctx['owner']
    table = ctx['table']
    st, cur = service(o, 'files.sheet_read', {'table': table, 'page': 1, 'page_length': 1})
    rows = cur.get('rows') or []
    if not rows:
        check(item, '前提失败：表里没读到行', False)
        return
    rid = rows[0]['row_id']
    col_types = cur.get('column_types') or {}
    header0 = next((h for h in (cur.get('headers') or []) if col_types.get(h) in ('text', None) and h), '')
    marker = f'缓存新值{RUN}'
    st, body = action(o, 'files.sheet_cell_write', {
        'table': table, 'sheet': '', 'row_id': rid, 'header': header0,
        'expected_content_version': cur.get('content_version'),
        'expected_structure_version': cur.get('structure_version'),
        'value': {'type': 'text', 'value': marker},
    }, 'n2-cache-write')
    check(item, '改一格成功（前提）', st == 200 and body.get('ok'))
    st, after = service(o, 'files.sheet_read', {'table': table, 'row_ids': [rid]})
    d1 = after.get('diagnostics') or {}
    got = ((after.get('rows') or [{}])[0].get('values') or {}).get(header0, {}).get('value')
    check(item, '改后立刻读到新值（没有拿旧缓存糊弄）', got == marker)
    check(item, '写后首读命中预热且读不再解析（D4）',
          d1.get('cache') == 'hit' and 'parse_count' in d1 and 'parse_ms' in d1)
    st, again = service(o, 'files.sheet_read', {'table': table, 'row_ids': [rid]})
    d2 = again.get('diagnostics') or {}
    got2 = ((again.get('rows') or [{}])[0].get('values') or {}).get(header0, {}).get('value')
    check(item, '同版本重读 hit、解析次数不动、值仍新',
          d2.get('cache') == 'hit' and d2.get('parse_count') == d1.get('parse_count') and got2 == marker)
    _refresh(ctx)


def item_cache_auth_leak(ctx):
    """N2B-12：测试通过 = 缓存热了之后，受限目录未授权身份照样 403 且回包不带表内容；
    有权身份读回内容正确（缓存只省解析，不省权限）。"""
    item = 'N2B-12'
    o, a = ctx['owner'], ctx['admin']
    owner_identity = ctx.get('owner_identity')
    if not owner_identity:
        check(item, 'NOT_RUN：登录回包缺 identity_id', True)
        return
    status, created = action(a, 'files.directory_create', {'title': f'n2-secret-{RUN}'}, 'n2-cache-dir')
    secret = created.get('result') or {}
    secret_id, secret_mod = secret.get('directory'), secret.get('modified')
    check(item, '管理员建目录成功（前提）', status == 200 and created.get('ok') and bool(secret_id))
    status, cfg = action(a, 'files.directory_access', {
        'directory': secret_id, 'expected_modified': secret_mod, 'mode': 'restricted',
        'identities': [owner_identity], 'groups': [],
    }, 'n2-cache-access')
    check(item, '目录改为仅属主可见（前提）', status == 200 and cfg.get('ok'))
    status, up = action(o, 'files.upload', {
        'file_name': f'n2-机密表-{RUN}.xlsx', 'content_base64': ctx['fixture_b64'],
        'directory_id': secret_id,
    }, 'n2-cache-up')
    secret_table = (up.get('result') or {}).get('file')
    check(item, '属主往受限目录上传成功（前提）', status == 200 and up.get('ok') and bool(secret_table))
    status, warm = service(o, 'files.sheet_read', {'table': secret_table})
    check(item, '属主读一遍把缓存焐热', status == 200 and (warm.get('rows') or [])
          and (warm.get('diagnostics') or {}).get('cache') in ('hit', 'miss'))
    leaked = False
    for who, client in (('仅改值身份', ctx.get('editor')), ('无权身份', ctx.get('outsider'))):
        if not client:
            continue
        status, body = service(client, 'files.sheet_read', {'table': secret_table})
        if status < 400 or (body.get('rows') or []) or body.get('headers'):
            leaked = True
        check(item, f'缓存焐热后{who}读仍被拒且不带表内容（HTTP {status}）',
              status >= 400 and not (body.get('rows') or []) and not body.get('headers'))
    status, again = service(o, 'files.sheet_read', {'table': secret_table})
    check(item, '有权身份重读 hit 且内容仍在', status == 200
          and (again.get('diagnostics') or {}).get('cache') == 'hit'
          and (again.get('rows') or []) == (warm.get('rows') or []))


def item_inflated_dimension(ctx):
    """N2B-13：测试通过 = 病态已用区域（残留样式把 dimension 撑到 XFD 列/5 万行）的表
    仍能打开：表头只回真实列、行数只算真实行、解析耗时在秒级（不按撑爆的格数物化）。
    客户实测样本（370KB）曾因 max_col=16384 物化 22 秒穿 BFF 15 秒超时。"""
    item = 'N2B-13'
    from io import BytesIO
    from openpyxl import Workbook
    from openpyxl.styles import Font
    o = ctx['owner']
    wb = Workbook()
    ws = wb.active
    ws.append(['单号', '事项', '金额'])
    for i in range(50):
        ws.append([f'NO{i:04d}', f'事项{i}', i])
    ghost = ws.cell(row=50000, column=16384)  # 残留样式格：无值，只刷样式
    ghost.font = Font(bold=True)
    out = BytesIO()
    wb.save(out)
    b64 = base64.b64encode(out.getvalue()).decode()
    status, body = action(o, 'files.upload', {
        'file_name': f'n2-病态范围-{RUN}.xlsx', 'content_base64': b64, 'directory': '/',
    }, 'n2-inflate-up')
    table = (body.get('result') or {}).get('file')
    check(item, f'上传病态样本成功（前提, HTTP {status}）', status == 200 and body.get('ok') and bool(table))
    t0 = time.time()
    status, sheet = service(o, 'files.sheet_read', {'table': table})
    elapsed = time.time() - t0
    diag = sheet.get('diagnostics') or {}
    check(item, f'读取成功且回包正常（HTTP {status}, {elapsed:.1f}s）', status == 200 and sheet.get('rows'))
    check(item, '表头只回真实 3 列（没把 XFD 撑爆的列吐出来）', (sheet.get('headers') or []) == ['单号', '事项', '金额'])
    check(item, '行数只算真实 50 行', sheet.get('total_rows') == 50)
    check(item, f'解析裁到真实范围（parse_ms={diag.get("parse_ms")}，须 <3000）',
          isinstance(diag.get('parse_ms'), (int, float)) and diag.get('parse_ms') < 3000 and elapsed < 8)
    # 真实行上的加行仍按位置续号，不跳到 5 万行去
    status, body = action(o, 'files.sheet_row_append', {
        'table': table, 'sheet': '', 'expected_content_version': sheet.get('content_version'),
        'expected_structure_version': sheet.get('structure_version'), 'count': 1,
    }, 'n2-inflate-append')
    result = body.get('result') or {}
    check(item, '加行落在真实数据末尾（HTTP %s）' % status, status == 200 and body.get('ok')
          and (result.get('row_ids') or [''])[-1] == 'r-000051')
    status, after = service(o, 'files.sheet_read', {'table': table, 'row_ids': [f'r-000051']})
    check(item, '新行读得回（行模型没被残留样式撑爆）',
          status == 200 and [r['row_id'] for r in (after.get('rows') or [])] == ['r-000051'])


def item_no_ddl(ctx):
    """N2B-06 反例：测试通过 = 结构操作前后业务对象/字段清单不变（加列没建 DDL）。"""
    item = 'N2B-06'
    a = ctx['admin']

    def model_snapshot():
        status, objs = a.request('GET', '/api/platform/objects')
        snap = {}
        for o in (objs.get('list') or []):
            snap[o.get('id')] = [f.get('id') for f in (o.get('fields') or [])]
        return snap

    before = model_snapshot()
    o = ctx['owner']
    status, body = action(o, 'files.sheet_column_append', {
        'table': ctx['table'], 'sheet': '', 'expected_content_version': ctx['content_version'],
        'expected_structure_version': ctx['structure_version'], 'header': f'反例列{RUN}',
    }, 'n2-ddl-col')
    check(item, '加列成功（前提）', status == 200 and body.get('ok'))
    _refresh(ctx)
    after = model_snapshot()
    check(item, '业务对象/字段清单一字未变（加列不建 DDL）', before == after)


def _verify(ctx, rows_added=0, header_added=None, header_renamed=None, sheet_title=None):
    """下载文件并用独立解析器核验；期望写进临时 json。"""
    o = ctx['owner']
    status, detail = service(o, 'files.versions', {'file': ctx['table']})
    versions = detail.get('versions') or []
    status, blob = download(o, ctx['table'], versions[0]['source']['file'])
    path = os.path.join(ctx['workdir'], f'check-{len(ctx["workdir"])}.xlsx')
    with open(path, 'wb') as fh:
        fh.write(blob.get('_bytes') or b'')
    expected = {
        'sheet': sheet_title or None,
        'unchanged': {},
    }
    if header_renamed:
        old_header, new_header = header_renamed
        expected['renamed_header'] = {'from': old_header, 'to': new_header}
    if header_added:
        expected['new_header'] = header_added
    if rows_added:
        expected['total_data_rows'] = len(ctx['row_ids']) + rows_added
    exp_path = os.path.join(ctx['workdir'], 'expected.json')
    with open(exp_path, 'w') as fh:
        json.dump(expected, fh, ensure_ascii=False)
    proc = subprocess.run([sys.executable, ctx['verifier'], path, exp_path],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stdout + proc.stderr)
    return proc.returncode == 0


if __name__ == '__main__':
    main()
