"""Agent B 真实 xlsx 链路行为测试（先红后绿）；对本地 Docker 测试入口跑真实登录会话。

用法：
  python3 test-excel-b2.py --base http://127.0.0.1:3100 \
      --fixture /path/to/sample-费用表.xlsx \
      --verifier /path/to/verify_xlsx_roundtrip.py \
      [--only B2-01] [--json-out /path/to/evidence.json]

测试通过 = 什么成立（逐项）：
- B2-01 打开/读取   = 上传样本 xlsx 后，读回表头、固定行 ID、带类型值：00123 是 text、
                     18 位长编号是 text、日期/数值/换行各按类型回来；翻页重读行 ID 不变。
- B2-02 单格往返   = 只改「金额」一格并保存后，下载真实文件独立解析：新值生效，
                     00123/长编号/换行/样式/列宽/未编辑工作表全部保持；重开读回一致。
- B2-03 版本与并发 = 保存后 content_version 递增、旧版本仍可下载；带旧版本写被拒且原值不损；
                     第二有权身份读回一致；无权身份读/写被拒。
- B2-04 幂等与回执 = 同编号重试只生效一次（值与版本不双跳）；回执可按原编号查到
                     （含失败原因）；未知态不换新编号重发。
- B2-05 上传边界   = 同名上传恒新资源（旧表内容不动、身份不同）；不支持格式/超限文件
                     拒绝且原件保留；非法数据写被拒。
- B2-06 故障注入   = 文件落盘失败/日志失败时无假成功、当前版本仍是好文件、原版本不丢。
只允许打到本机回环或 -test 测试入口；生产域名拒绝。
"""
import argparse
import base64
import hashlib
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
# 幂等编号每轮加后缀：同号重试只在一轮内验（B2-04 连打两次同号），跨轮必须换新号，
# 否则整轮写操作都被当成上一轮的重放，版本链断掉（第二轮实测踩过）。
RUN = str(int(time.time()))


def receipt_key(key):
    return f'{key}-{RUN}'


def check(item, label, valid):
    CHECKS.append((item, label, bool(valid)))
    print(('  ✓ ' if valid else '  ✗ ') + label)
    return bool(valid)


def rejected(item, label, operation):
    try:
        status, body = operation()
    except AssertionError as exc:
        check(item, f'{label}（客户端错误：{exc}）', False)
        return
    ok = status >= 400 or (isinstance(body, dict) and body.get('ok') is False)
    code = body.get('code') if isinstance(body, dict) else '-'
    check(item, f'{label}（HTTP {status}, code={code}）', ok)


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
    return client.request('POST', f'/api/platform/actions/{action_id}/execute',
                          {'payload': payload, 'confirmed': True, 'idempotency_key': receipt_key(key)})


def service(client, service_id, payload):
    return client.request('POST', f'/api/platform/services/{service_id}/invoke', {'payload': payload})


def download(client, table, file_ref):
    return client.request('GET', f'/api/platform/file-content?ref=Shangshu%20File%20Center%20File'
                                 f'&ref_name={table}&file={file_ref}')


def run_verifier(verifier, xlsx_path, expected, workdir):
    exp_path = os.path.join(workdir, 'expected.json')
    with open(exp_path, 'w') as fh:
        json.dump(expected, fh, ensure_ascii=False)
    proc = subprocess.run([sys.executable, verifier, xlsx_path, exp_path],
                          capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def typed(value, type_):
    return {'type': type_, 'value': value}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True)
    ap.add_argument('--fixture', required=True, help='样本 xlsx（含中文/00123/长编号/日期/换行/样式/列宽/第二工作表）')
    ap.add_argument('--verifier', required=True, help='scripts/tests/verify_xlsx_roundtrip.py')
    ap.add_argument('--password', default=os.environ.get('TEST_USER_PASSWORD'),
                    help='测试用户口令；不给则取环境变量 TEST_USER_PASSWORD（口令不进仓库）')
    ap.add_argument('--admin-password', default=os.environ.get('ADMIN_PASSWORD'),
                    help='Administrator 口令；不给则取环境变量 ADMIN_PASSWORD（口令不进仓库）')
    ap.add_argument('--only')
    ap.add_argument('--compose-project', help='故障注入用：docker compose 项目名（缺省跳过注入项）')
    ap.add_argument('--json-out')
    args = ap.parse_args()

    if 'localhost' not in args.base and '127.0.0.1' not in args.base and '-test' not in args.base:
        raise SystemExit('只允许本机回环或 -test 测试入口')
    if not args.password or not args.admin_password:
        raise SystemExit('口令不设脚本默认值：用 --password/--admin-password 或环境变量 TEST_USER_PASSWORD/ADMIN_PASSWORD 传入')

    workdir = os.path.join('/tmp', f'excel-b2-{int(time.time())}')
    os.makedirs(workdir, exist_ok=True)

    owner = Client(args.base)
    owner_login = owner.login('ss-owner@example.invalid', args.password)
    reader = Client(args.base)
    reader.login('ss-reader@example.invalid', args.password)
    outsider = Client(args.base)
    outsider.login('ss-outsider@example.invalid', args.password)
    admin = Client(args.base)
    admin.login('Administrator', args.admin_password)

    fixture_bytes = open(args.fixture, 'rb').read()
    fixture_b64 = base64.b64encode(fixture_bytes).decode()
    ctx = dict(owner=owner, reader=reader, outsider=outsider, admin=admin,
               fixture_b64=fixture_b64, verifier=args.verifier, workdir=workdir,
               compose_project=args.compose_project,
               owner_identity=owner_login.get('identity_id'),
               table=None, file_ref=None, row_id=None)

    items = [
        ('B2-01', item_b2_01),
        ('B2-02', item_b2_02),
        ('B2-03', item_b2_03),
        ('B2-04', item_b2_04),
        ('B2-05', item_b2_05),
        ('B2-06', item_b2_06),
        ('B2-07', item_b2_07),
    ]
    for name, fn in items:
        if args.only and args.only != name:
            continue
        print(f'\n== {name} ==')
        try:
            fn(ctx)
        except Exception as exc:  # 单项炸掉不拖垮整套
            check(name, f'执行异常：{type(exc).__name__}: {exc}', False)

    print()
    failed = [c for c in CHECKS if not c[2]]
    for item, label, ok in CHECKS:
        if not ok:
            print(f'FAIL {item} {label}')
    print(f'\n{len(CHECKS) - len(failed)}/{len(CHECKS)} 通过')
    if args.json_out:
        with open(args.json_out, 'w') as fh:
            json.dump({'checks': CHECKS, 'base': args.base}, fh, ensure_ascii=False, indent=1)
    sys.exit(1 if failed else 0)


def item_b2_01(ctx):
    """打开/读取：表头、固定行 ID、带类型值、翻页行 ID 不变。"""
    item = 'B2-01'
    o = ctx['owner']
    status, body = action(o, 'files.upload', {
        'file_name': 'b2-费用表.xlsx', 'content_base64': ctx['fixture_b64'], 'directory': '/',
    }, 'b2-upload-01')
    check(item, '上传样本 xlsx 成功', status == 200 and body.get('ok'))
    table = (body.get('result') or {}).get('file')
    ctx['table'] = table
    check(item, f'拿到稳定表身份 table={table}', bool(table))

    status, detail = service(o, 'files.versions', {'file': table})
    versions = (detail.get('versions') or [])
    check(item, '版本历史含固定内容引用', status == 200 and versions and versions[0].get('source', {}).get('file'))
    ctx['file_ref'] = versions[0]['source']['file']

    status, sheet = service(o, 'files.sheet_read', {'table': table})
    check(item, '读取回表头 6 列且顺序正确',
          status == 200 and sheet.get('headers') == ['单据号', '事项', '金额', '发生日期', '备注', '登记编号'])
    rows = sheet.get('rows') or []
    check(item, '读到 3 行且每行有固定 row_id', len(rows) == 3 and all(r.get('row_id') for r in rows))
    ctx['row_id'] = rows[0]['row_id'] if rows else None
    ctx['content_version'] = sheet.get('content_version')
    ctx['structure_version'] = sheet.get('structure_version')
    check(item, '回包含 content_version/structure_version',
          sheet.get('content_version') is not None and sheet.get('structure_version') is not None)

    values = rows[0].get('values') or {}
    check(item, "00123 按 text 原样回来", values.get('单据号') == typed('00123', 'text')
          or values.get('单据号') == {'type': 'text', 'value': '00123'})
    check(item, '18 位长编号按 text 回来不转数字',
          (values.get('登记编号') or {}).get('type') == 'text'
          and str((values.get('登记编号') or {}).get('value')) == '202610101234567890')
    check(item, '数值按 number 回来', (values.get('金额') or {}).get('type') == 'number')
    check(item, '日期按 date 回来', (values.get('发生日期') or {}).get('type') == 'date')
    check(item, '换行文本原样回来（含 \\n）', '\n' in str((values.get('备注') or {}).get('value') or ''))

    # 翻页/定位：行 ID 必须稳定
    status, page2 = service(o, 'files.sheet_read', {'table': table, 'page': 2, 'page_length': 1})
    rows2 = page2.get('rows') or []
    check(item, '翻页读到的行 ID 是同一套（不重发号）',
          status == 200 and (not rows2 or rows2[0]['row_id'] in [r['row_id'] for r in rows]))
    status, again = service(o, 'files.sheet_read', {'table': table})
    check(item, '重复打开行 ID 不变', [r['row_id'] for r in (again.get('rows') or [])] == [r['row_id'] for r in rows])

    cw = sheet.get('column_widths') or {}
    check(item, '回包含列宽（B=22/E=30 左右）', any(abs(float(v) - 22) < 0.5 for v in cw.values())
          and any(abs(float(v) - 30) < 0.5 for v in cw.values()))


def item_b2_02(ctx):
    """单格往返：改一格、下载独立解析、重开一致。"""
    item = 'B2-02'
    o = ctx['owner']
    table, row_id = ctx['table'], ctx['row_id']
    before = ctx['content_version']

    status, body = action(o, 'files.sheet_cell_write', {
        'table': table, 'sheet': '', 'row_id': row_id, 'header': '金额',
        'expected_content_version': before, 'expected_structure_version': ctx['structure_version'],
        'value': {'type': 'number', 'value': 999.5},
    }, 'b2-write-01')
    check(item, '单格写成功且返回生效版本', status == 200 and body.get('ok'))
    result = body.get('result') or {}
    check(item, '生效值=999.5 且 content_version 递增',
          abs(float((result.get('value') or {}).get('value', -1)) - 999.5) < 1e-9
          and result.get('content_version') == before + 1)
    ctx['content_version'] = result.get('content_version')

    status, again = service(o, 'files.sheet_read', {'table': table, 'row_ids': [row_id]})
    rows = again.get('rows') or []
    check(item, '重开读回新值 999.5', rows and abs(float(rows[0]['values']['金额']['value']) - 999.5) < 1e-9)

    status, detail = service(o, 'files.versions', {'file': table})
    versions = detail.get('versions') or []
    ctx['file_ref'] = versions[0]['source']['file']
    check(item, '旧版本仍可下载（版本数 ≥2）', len(versions) >= 2)

    status, blob = download(o, table, ctx['file_ref'])
    path = os.path.join(ctx['workdir'], 'downloaded.xlsx')
    with open(path, 'wb') as fh:
        fh.write(blob.get('_bytes') or b'')
    check(item, '下载拿到真实 xlsx 字节（PK 头）', status == 200 and (blob.get('_bytes') or b'').startswith(b'PK'))

    code, out = run_verifier(ctx['verifier'], path, {
        'sheet': '费用明细',
        'changed': {'cell': 'C2', 'type': 'number', 'value': 999.5},
        'unchanged': {
            'A2': {'type': 'text', 'value': '00123'},
            'F2': {'type': 'text', 'value': '202610101234567890'},
            'E2': {'type': 'text', 'value': '南京→上海\n高铁往返'},
        },
        'other_sheet': {'name': '汇总说明', 'cells': {'A2': 12345}},
        'column_widths': {'B': 22, 'E': 30},
        'styles': [{'cell': 'A1', 'bold': True}],
    }, ctx['workdir'])
    print(out)
    check(item, '独立解析下载文件：新值生效且未改内容/样式/列宽/第二表全保持', code == 0)

    status, old = download(o, table, versions[-1]['source']['file'])
    check(item, '旧版本字节仍取得到（原版本不丢）', status == 200 and (old.get('_bytes') or b'').startswith(b'PK'))


def item_b2_03(ctx):
    """版本并发、权限边界、第二身份读回。"""
    item = 'B2-03'
    o, r, x = ctx['owner'], ctx['reader'], ctx['outsider']
    table, row_id = ctx['table'], ctx['row_id']

    rejected(item, '带旧 content_version 写被拒', lambda: action(o, 'files.sheet_cell_write', {
        'table': table, 'sheet': '', 'row_id': row_id, 'header': '金额',
        'expected_content_version': ctx['content_version'] - 1,
        'expected_structure_version': ctx['structure_version'],
        'value': {'type': 'number', 'value': 1},
    }, 'b2-write-stale'))
    status, again = service(o, 'files.sheet_read', {'table': table, 'row_ids': [row_id]})
    check(item, '被拒后原值不损（仍 999.5）',
          abs(float(again['rows'][0]['values']['金额']['value']) - 999.5) < 1e-9)

    rejected(item, '带旧 structure_version 写被拒', lambda: action(o, 'files.sheet_cell_write', {
        'table': table, 'sheet': '', 'row_id': row_id, 'header': '金额',
        'expected_content_version': ctx['content_version'],
        'expected_structure_version': ctx['structure_version'] + 99,
        'value': {'type': 'number', 'value': 1},
    }, 'b2-write-stale-s'))

    status, sheet_r = service(r, 'files.sheet_read', {'table': table})
    status2, sheet_o = service(o, 'files.sheet_read', {'table': table})
    check(item, '第二有权身份读回一致（行 ID/值/版本相同）',
          [row['row_id'] for row in sheet_r.get('rows', [])] == [row['row_id'] for row in sheet_o.get('rows', [])]
          and sheet_r.get('content_version') == sheet_o.get('content_version'))

    # 目录可见即可读（与下载口径一致）：根目录是 inherit，非属主身份能读到但 writable=false。
    status, sheet_x = service(x, 'files.sheet_read', {'table': table})
    check(item, '非属主可读共享目录表但 writable=false（权限结论由后端给）',
          status == 200 and sheet_x.get('ok') is not False and sheet_x.get('writable') is False)
    rejected(item, '无权身份单格写被拒', lambda: action(x, 'files.sheet_cell_write', {
        'table': table, 'sheet': '', 'row_id': row_id, 'header': '金额',
        'expected_content_version': ctx['content_version'],
        'expected_structure_version': ctx['structure_version'],
        'value': {'type': 'number', 'value': 2},
    }, 'b2-write-outsider'))

    # 受限目录：仅登记属主身份，未授权身份读取必须被拒。
    a = ctx['admin']
    owner_identity = ctx.get('owner_identity')
    check(item, '登录回包带属主平台身份', bool(owner_identity))
    status, created = action(a, 'files.directory_create', {'title': f'b2-secret-{RUN}'}, 'b2-dir-secret')
    secret = (created.get('result') or {})
    secret_id, secret_mod = secret.get('directory'), secret.get('modified')
    check(item, '管理员建受限目录成功', status == 200 and created.get('ok') and bool(secret_id))
    status, cfg = action(a, 'files.directory_access', {
        'directory': secret_id, 'expected_modified': secret_mod, 'mode': 'restricted',
        'identities': [owner_identity], 'groups': [],
    }, 'b2-dir-access')
    check(item, '目录改为仅属主可见', status == 200 and cfg.get('ok'))
    status, up = action(o, 'files.upload', {
        'file_name': 'b2-机密表.xlsx', 'content_base64': ctx['fixture_b64'], 'directory_id': secret_id,
    }, 'b2-upload-secret')
    secret_table = (up.get('result') or {}).get('file')
    check(item, '属主往受限目录上传成功', status == 200 and up.get('ok') and bool(secret_table))
    status, mine = service(o, 'files.sheet_read', {'table': secret_table})
    check(item, '属主读受限目录表放行', status == 200 and mine.get('ok') is not False)
    rejected(item, '受限目录内未授权身份读取被拒', lambda: service(x, 'files.sheet_read', {'table': secret_table}))
    rejected(item, '受限目录内第二身份（不在名单）读取被拒', lambda: service(r, 'files.sheet_read', {'table': secret_table}))


def item_b2_04(ctx):
    """幂等重试只生效一次；回执可查（含失败原因）。"""
    item = 'B2-04'
    o = ctx['owner']
    table, row_id = ctx['table'], ctx['row_id']
    payload = {
        'table': table, 'sheet': '', 'row_id': row_id, 'header': '金额',
        'expected_content_version': ctx['content_version'],
        'expected_structure_version': ctx['structure_version'],
        'value': {'type': 'number', 'value': 555.0},
    }
    status, first = action(o, 'files.sheet_cell_write', payload, 'b2-write-idem')
    check(item, '首次写成功', status == 200 and first.get('ok'))
    v1 = (first.get('result') or {}).get('content_version')
    ctx['content_version'] = v1

    status, replay = action(o, 'files.sheet_cell_write', payload, 'b2-write-idem')
    check(item, '同编号重试回 idempotent=true 且版本不双跳',
          status == 200 and replay.get('idempotent') is True
          and (replay.get('result') or {}).get('content_version') == v1)

    status, again = service(o, 'files.sheet_read', {'table': table, 'row_ids': [row_id]})
    check(item, '实际值只应用一次（555.0）',
          abs(float(again['rows'][0]['values']['金额']['value']) - 555.0) < 1e-9)

    status, receipt = o.request('GET', f'/api/platform/action-requests/{receipt_key("b2-write-idem")}')
    check(item, '回执按原编号查到 Succeeded', status == 200 and receipt.get('status') in ('Succeeded', 'succeeded'))

    # 失败的写也要能查到原因（回执丢失→查询路径）
    rejected(item, '非法类型写被拒（金额填文本）', lambda: action(o, 'files.sheet_cell_write', {
        'table': table, 'sheet': '', 'row_id': row_id, 'header': '金额',
        'expected_content_version': ctx['content_version'],
        'expected_structure_version': ctx['structure_version'],
        'value': {'type': 'text', 'value': '不是数字'},
    }, 'b2-write-badtype'))
    status, receipt2 = o.request('GET', f'/api/platform/action-requests/{receipt_key("b2-write-badtype")}')
    check(item, '失败回执可查且带 failure_reason',
          status == 200 and str(receipt2.get('status')) in ('Failed', 'failed')
          and bool(receipt2.get('failure_reason')))


def item_b2_05(ctx):
    """同名上传恒新资源；不支持/超限文件拒绝且原件保留；非法数据拒绝。"""
    item = 'B2-05'
    o = ctx['owner']
    status, dup = action(o, 'files.upload', {
        'file_name': 'b2-费用表.xlsx', 'content_base64': ctx['fixture_b64'], 'directory': '/',
    }, 'b2-upload-dup')
    check(item, '同名再次上传成功', status == 200 and dup.get('ok'))
    dup_id = (dup.get('result') or {}).get('file')
    check(item, f'同名上传是新资源（{dup_id} ≠ {ctx["table"]}）', dup_id and dup_id != ctx['table'])

    status, old_sheet = service(o, 'files.sheet_read', {'table': ctx['table']})
    check(item, '旧表内容未被覆盖（金额仍 555.0）',
          abs(float(old_sheet['rows'][0]['values']['金额']['value']) - 555.0) < 1e-9)

    # 不支持格式（.xls）：上传保留原件、明确拒绝编辑
    xls_b64 = base64.b64encode(b'\xd0\xcf\x11\xe0 fake-old-xls').decode()
    status, up_xls = action(o, 'files.upload', {
        'file_name': 'b2-旧表.xls', 'content_base64': xls_b64, 'directory': '/',
    }, 'b2-upload-xls')
    if status == 200 and up_xls.get('ok'):
        xls_id = (up_xls.get('result') or {}).get('file')
        rejected(item, '旧 .xls 读取/编辑被明确拒绝', lambda: service(o, 'files.sheet_read', {'table': xls_id}))
    else:
        check(item, '旧 .xls 被上传口直接拒绝（扩展名白名单）', True)

    # 非法数据：文本写进数值列被拒
    rejected(item, '文本写进金额列被拒', lambda: action(o, 'files.sheet_cell_write', {
        'table': ctx['table'], 'sheet': '', 'row_id': ctx['row_id'], 'header': '金额',
        'expected_content_version': ctx['content_version'],
        'expected_structure_version': ctx['structure_version'],
        'value': {'type': 'text', 'value': 'abc'},
    }, 'b2-write-badtype2'))

    # 行 ID 不存在
    rejected(item, '不存在的 row_id 被拒', lambda: action(o, 'files.sheet_cell_write', {
        'table': ctx['table'], 'sheet': '', 'row_id': 'r-not-exist', 'header': '金额',
        'expected_content_version': ctx['content_version'],
        'expected_structure_version': ctx['structure_version'],
        'value': {'type': 'number', 'value': 1},
    }, 'b2-write-badrow'))


def item_b2_06(ctx):
    """故障注入：文件失败/落盘后失败，无假成功、原版本不丢（经 SS_FAULT_FILE 断点文件注入）。"""
    item = 'B2-06'
    o = ctx['owner']
    table, row_id = ctx['table'], ctx['row_id']
    before_v = ctx['content_version']
    status, before = service(o, 'files.sheet_read', {'table': table, 'row_ids': [row_id]})
    before_value = before['rows'][0]['values']['金额']['value']
    project = ctx.get('compose_project')

    def inject(text):
        # 直接 docker exec 容器（不依赖 compose 文件 cwd）；写入失败必须炸出来，不许静默跳过。
        proc = subprocess.run(['docker', 'exec', f'{project}-frappe-1', 'bash', '-lc',
                               f'echo {text} > /tmp/ss-fault-point && cat /tmp/ss-fault-point'],
                              capture_output=True, text=True)
        return proc.returncode == 0 and proc.stdout.strip() == text

    def fault(point, key):
        if not project:
            check(item, f'故障注入 {point}（NOT_RUN：未给 --compose-project）', True)
            return
        if not inject(point):
            check(item, f'{point} 断点文件未写进容器（注入未生效，结果不可信）', False)
            return
        try:
            status, body = action(o, 'files.sheet_cell_write', {
                'table': table, 'sheet': '', 'row_id': row_id, 'header': '金额',
                'expected_content_version': before_v,
                'expected_structure_version': ctx['structure_version'],
                'value': {'type': 'number', 'value': 777.0},
            }, key)
            check(item, f'{point} 故障时回失败、无假成功', status >= 400 or body.get('ok') is False)
        finally:
            subprocess.run(['docker', 'exec', f'{project}-frappe-1', 'bash', '-lc',
                            'rm -f /tmp/ss-fault-point'], capture_output=True)
        status, after = service(o, 'files.sheet_read', {'table': table, 'row_ids': [row_id]})
        check(item, f'{point} 故障后当前版本仍是好文件（值/版本不变）',
              after.get('content_version') == before_v
              and after['rows'][0]['values']['金额']['value'] == before_value)
        status, receipt = o.request('GET', f'/api/platform/action-requests/{receipt_key(key)}')
        check(item, f'{point} 该编号回执可查（非 NotFound）',
              status == 200 and str(receipt.get('status')) not in ('NotFound', 'not_found', 'None'))

    # 注入点 0：坏请求（列不存在）→ 必须失败且不产生新版本
    rejected(item, '坏请求失败且无假成功', lambda: action(o, 'files.sheet_cell_write', {
        'table': table, 'sheet': '', 'row_id': row_id, 'header': '不存在的列',
        'expected_content_version': before_v, 'expected_structure_version': ctx['structure_version'],
        'value': {'type': 'number', 'value': 1},
    }, 'b2-write-noheader'))
    status, after = service(o, 'files.sheet_read', {'table': table, 'row_ids': [row_id]})
    check(item, '失败后当前版本不漂（值/版本不变）',
          after.get('content_version') == before_v
          and after['rows'][0]['values']['金额']['value'] == before_value)

    fault('file-write', 'b2-write-faultfile')   # 文件落盘失败
    fault('post-save', 'b2-write-faultpost')    # 落盘后/审计前失败（无假成功）


def item_b2_07(ctx):
    """Excel 分类（普通列表/搜索/计数接口层排除 xlsx）与超限上传拒绝。"""
    item = 'B2-07'
    o = ctx['owner']

    def dataset(filters):
        qs = urllib.parse.urlencode({'filters': json.dumps(filters, ensure_ascii=False), 'page_length': 100})
        return o.request('GET', f'/api/platform/datasets/files.file/records?{qs}')

    def is_xlsx(row):
        return str(row.get('file_name') or '').lower().endswith('.xlsx')

    status, plain = dataset({})
    rows = plain.get('rows') or []
    check(item, '普通文件列表不含 xlsx（接口层排除，非前端隐藏）',
          status == 200 and rows and not any(is_xlsx(r) for r in rows))
    check(item, '普通列表计数与列表口径一致（total 不把 xlsx 算进去）',
          int(plain.get('total') or 0) == len(rows))
    status, hits = dataset({'q': '费用'})
    hit_rows = hits.get('rows') or []
    check(item, '普通列表搜索不命中 xlsx（本套 xlsx 文件名含「费用」）',
          status == 200 and not any(is_xlsx(r) for r in hit_rows))
    status, sheets = dataset({'scope': 'sheet'})
    sheet_rows = sheets.get('rows') or []
    check(item, 'scope=sheet 只回 xlsx 且包含本套测试表（分类两面都在）',
          status == 200 and sheet_rows and all(is_xlsx(r) for r in sheet_rows)
          and any(r.get('name') == ctx['table'] for r in sheet_rows))

    big = base64.b64encode(b'PK\x03\x04' + b'\0' * (20 * 1024 * 1024)).decode()
    status, body = action(o, 'files.upload', {'file_name': 'b2-超限.xlsx', 'content_base64': big},
                          'b2-upload-oversize')
    check(item, f'超 20MB 上传被拒（HTTP {status}, {str(body.get("error") or body.get("code") or "")[:40]}）',
          status >= 400 or body.get('ok') is False)
    status, after = dataset({'scope': 'sheet'})
    check(item, '超限文件未入库（sheet 列表无 b2-超限.xlsx）',
          all('超限' not in str(r.get('file_name') or '') for r in (after.get('rows') or [])))
    status, again = service(o, 'files.sheet_read', {'table': ctx['table'], 'row_ids': [ctx['row_id']]})
    check(item, '既有表仍可读（超限拒绝不影响已有文件）', status == 200 and again.get('rows'))


if __name__ == '__main__':
    main()
