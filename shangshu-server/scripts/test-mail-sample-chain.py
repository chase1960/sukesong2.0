#!/usr/bin/env python3
"""邮件固定样本验收链：阅读→编辑→实际保存草稿→重开→预览→生成MIME并独立解析核对。

只打本地回环 BFF，只生成邮件内容不外发（SMTP 用隔离捕获器拦下，一封都不出网）。
口令从环境文件读，全程不打印、不入状态文件。

测试通过 = 下面全部成立：
 1. 固定样本（正文＋表格＋合并单元格＋一张受管内联图片）实际存成草稿并落库。
 2. 阅读读回：表格、横/纵合并、内联图引用与正文逐字一致。
 3. 编辑一个表格值后实际保存，重开读回是改后的值，且结构与图一条不丢。
 4. 预览路径不丢表格与图（净化后仍可渲染）。
 5. 生成的 MIME 用独立解析器读回：正文、正文类型、Content-ID 及引用一致。
 6. 保存失败（旧版本冲突）不假成功，且不覆盖已存内容。
"""
import base64
import hashlib
import io
import json
import re
import sys
import unittest.mock
import urllib.error
import urllib.parse
import urllib.request
import http.cookiejar
from email import policy
from email.parser import BytesParser
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
for app in ('shangshu_core', 'shangshu_finance', 'shangshu_orders', 'shangshu_warehouse', 'shangshu_files', 'shangshu_mail'):
    sys.path.insert(0, str(REPO / 'frappe_apps' / app))
from shangshu_mail import transport  # noqa: E402  生产 MIME 生成代码，必须走真实这条

ENV = Path('/path/to/workspace')
BASE = 'http://127.0.0.1:3830'

# —— 固定样本：正文＋表格＋合并单元格（横跨 2、纵跨 2）＋一张受管内联图片 ——
CID = 'sample-inline-1'
SAMPLE_BODY = (
    '<p>年费核对通知</p>'
    '<table border="1"><tbody>'
    '<tr><th colspan="2">案件汇总</th></tr>'
    '<tr><td rowspan="2">A001</td><td>1,234,567.89</td></tr>'
    '<tr><td>2026-10-24</td></tr>'
    '<tr><td>B002</td><td><img src="cid:' + CID + '" alt="签章"></td></tr>'
    '</tbody></table>'
)


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode('utf-8')).hexdigest()


def fail(message):
    print('FAIL ' + message, flush=True)
    raise SystemExit(1)


def passed(message):
    print('PASS ' + message, flush=True)


def require(condition, message):
    if not condition:
        fail(message)


def load_password():
    for line in ENV.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line.startswith('export '):
            line = line[7:].lstrip()
        if line.startswith('ADMIN_PASSWORD='):
            return line.split('=', 1)[1].strip().strip('"').strip("'")
    fail('环境文件里找不到 ADMIN_PASSWORD')


def tiny_png():
    """1x1 透明 PNG，作为受管内联图片字节。"""
    import struct
    import zlib
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)
    raw = zlib.compress(b'\x00\x00\x00\x00')
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', raw) + chunk(b'IEND', b'')


class Client:
    def __init__(self, base, password):
        self.base = base.rstrip('/')
        self.password = password
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, path, body=None, binary=False):
        encoded = None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
        req = urllib.request.Request(self.base + path, data=encoded,
                                     headers={'Content-Type': 'application/json', 'Accept': '*/*'})
        try:
            with self.opener.open(req, timeout=45) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            detail = error.read()
            try:
                message = str(json.loads(detail).get('error') or 'HTTP rejected')
            except Exception:
                message = 'Non-JSON HTTP response'
            # 口令永不落进输出
            message = message.replace(self.password, '[redacted]')
            raise RuntimeError(f'HTTP {error.code}: {message[:300]}') from None
        if binary:
            return raw
        result = json.loads(raw)
        require(isinstance(result, dict) and result.get('ok') is True, f'{path}: 平台响应不是成功')
        return result

    def login(self):
        self.request('/api/platform/login', {'username': 'Administrator', 'password': self.password})
        session = self.request('/api/platform/session')
        require(session.get('user_name') == 'Administrator', '登录没有拿到真实管理员身份')
        passed('登录并拿到真实身份')

    def service(self, name, payload):
        # 有的服务把结果包在 result 里，有的直接摊在顶层（files.versions 就是后者），
        # 两边都要认，不然会取到空对象还以为「没数据」。
        response = self.request(f'/api/platform/services/{name}/invoke', {'payload': payload})
        return response.get('result', response)

    def action(self, name, payload, key):
        response = self.request(f'/api/platform/actions/{name}/execute',
                                {'payload': payload, 'confirmed': True, 'idempotency_key': key})
        require(response.get('action_id') == name and response.get('audit'),
                f'{name}: 回执不完整')
        return response


def build_mime(mail, inline_resources, attachments):
    """走生产 send_message 生成 MIME，但把 SMTP 换成隔离捕获器 —— 一封都不出网。"""
    captured = []

    class Capture:
        def __init__(self, *a, **k): pass
        def login(self, *a, **k): pass
        def send_message(self, message, **kw):
            captured.append(message)
        def quit(self): pass
        def close(self): pass

    with unittest.mock.patch.object(transport.smtplib, 'SMTP_SSL', Capture), \
         unittest.mock.patch.object(transport.smtplib, 'SMTP', Capture):
        transport.send_message('sample@qq.com', 'never-used', '验收样本', mail, attachments,
                               inline_resources=inline_resources)
    require(captured, '隔离捕获器没收到生成的 MIME')
    return captured[0].as_bytes()


def main():
    password = load_password()
    client = Client(BASE, password)
    client.login()

    # —— 1. 建受管内联图片 ——
    import uuid
    marker = uuid.uuid4().hex[:8]
    png = tiny_png()
    up = client.action('files.upload', {
        'file_name': f'样本内联图-{marker}.png',
        'content_base64': base64.b64encode(png).decode('ascii'),
        'file_sha256': sha(png),
    }, f'sample-chain-file-{marker}')['result']
    versions = client.service('files.versions', {'file': up['file']})
    match = [v for v in versions.get('versions', []) if v.get('version_no') == up['version']]
    require(len(match) == 1 and match[0].get('frappe_file'), '上传后拿不到固定版本的受管文件引用')
    frappe_file = match[0]['frappe_file']
    passed(f'受管内联图片已就位（文件 {up["file"]}）')

    inline_resources = [{'content_id': CID, 'mime_type': 'image/png', 'name': '样本内联图.png', 'file': frappe_file}]

    # —— 2. 实际保存固定样本草稿 ——
    saved = client.action('mail.save_draft', {
        'subject': '样本：表格＋合并单元格＋内联图',
        'body': SAMPLE_BODY,
        'body_format': 'HTML',
        'to': ['收件人甲 <a@qq.com>'],
        'cc': ['收件人乙 <b@qq.com>'],
        'attachments': [],
        'inline_resources': inline_resources,
    }, f'sample-chain-mail-1-{marker}')['result']
    require(saved.get('name') and saved.get('status') == 'Draft', '固定样本没有落库成草稿')
    mail_id = saved['name']
    version = saved['record_version']
    passed(f'固定样本已实际保存成草稿（{mail_id}，版本 {version}）')

    # —— 3. 阅读：读回结构逐项核对 ——
    read = client.service('mail.detail', {'mail': mail_id}).get('mail', {})
    require(read.get('body') == SAMPLE_BODY, '阅读读回的正文与保存的不一致')
    body = read['body']
    require('colspan="2"' in body or 'colspan=2' in body, '阅读读回丢了横向合并')
    require('rowspan="2"' in body or 'rowspan=2' in body, '阅读读回丢了纵向合并')
    require(f'src="cid:{CID}"' in body or f'src=cid:{CID}' in body, '阅读读回丢了内联图引用')
    require('1,234,567.89' in body, '阅读读回金额格式变了')
    require('2026-10-24' in body, '阅读读回日期格式变了')
    inline = read.get('inline_resources') or []
    require(any(i.get('content_id') == CID for i in inline), '阅读读回没带受管内联资源')
    passed('阅读：正文/表格/横纵合并/内联图引用/金额日期逐字一致')

    # —— 4. 编辑一个表格值 ——
    EDITED = SAMPLE_BODY.replace('1,234,567.89', '2,000,000.00（已核对）')
    require(EDITED != SAMPLE_BODY, '前置：编辑值必须与原值不同')
    edited = client.action('mail.save_draft', {
        'mail': mail_id,
        'expected_version': version,
        'subject': '样本：表格＋合并单元格＋内联图',
        'body': EDITED,
        'body_format': 'HTML',
        'to': ['收件人甲 <a@qq.com>'],
        'cc': ['收件人乙 <b@qq.com>'],
        'attachments': [],
        'inline_resources': inline_resources,
    }, f'sample-chain-mail-2-{marker}')['result']
    require(edited.get('record_version') == version + 1, '编辑后保存没有推进版本')
    passed(f'编辑一个表格值后实际保存（版本 {version} → {edited["record_version"]}）')

    # —— 5. 重开：改后的值在，结构一条不丢 ——
    reopen = client.service('mail.detail', {'mail': mail_id}).get('mail', {})
    require('2,000,000.00（已核对）' in reopen['body'], '重开没读到改后的值')
    require('1,234,567.89' not in reopen['body'], '重开还留着改前的旧值')
    require('colspan="2"' in reopen['body'], '重开丢了横向合并')
    require('rowspan="2"' in reopen['body'], '重开丢了纵向合并')
    require(f'src="cid:{CID}"' in reopen['body'], '重开丢了内联图引用')
    require(any(i.get('content_id') == CID for i in (reopen.get('inline_resources') or [])),
            '重开丢了受管内联资源')
    passed('重开：改后的值在，表格结构与内联图一条不丢')

    # —— 6. 预览：净化后表格与图仍在 ——
    # 用 transport.sanitize_html（生产净化代码）而非 service.html_body —— 后者顶层 import frappe，
    # 独立跑不起来；净化语义两边一致（script/事件/外链剔除，表格结构与 cid: 保留）。
    preview = transport.sanitize_html(reopen['body'])
    require('<table' in preview.lower(), '预览把表格净化没了')
    require('colspan' in preview.lower(), '预览把合并信息净化没了')
    require(f'cid:{CID}' in preview, '预览把内联图引用净化没了')
    require('<script' not in preview.lower(), '预览漏了脚本')
    require('onerror' not in preview.lower() and 'onload' not in preview.lower(), '预览漏了事件属性')
    passed('预览：表格/合并/内联图都在，脚本与事件属性进不去')

    # —— 7. 生成 MIME 并独立解析核对 ——
    # 落库存的是「固定版本文件引用」，生成 MIME 要的是图片字节 —— 按已授权的固定版本取回原字节。
    resources = reopen.get('inline_resources') or []
    wire_resources = []
    for item in resources:
        # 取字节必须走**信的归属** —— 这是产品页走的那条路。
        # 此前这里传的是 ref='Shangshu File Center File'（文件库那条挂载），读得到就报全绿，
        # 于是「mail.save_draft 没把 File 挂到信上」那个真缺陷被测试自己盖住了。
        query = urllib.parse.urlencode({'ref': 'Shangshu Mail Message',
                                        'ref_name': mail_id, 'file': item['file']})
        img_bytes = client.request('/api/platform/file-content?' + query, binary=True)
        require(isinstance(img_bytes, (bytes, bytearray)) and img_bytes[:8] == b'\x89PNG\r\n\x1a\n',
                f'用信的归属取回内联图字节（{len(img_bytes) if isinstance(img_bytes,(bytes,bytearray)) else 0} 字节）')
        wire_resources.append({**item, 'content': img_bytes})
    raw = build_mime({'subject': reopen['subject'], 'body': reopen['body'],
                      'body_format': reopen.get('body_format') or 'HTML',
                      'to': reopen.get('to') or [], 'cc': reopen.get('cc') or [],
                      'message_id': f'<sample-chain-{marker}@localhost>'},
                     wire_resources, [])
    msg = BytesParser(policy=policy.default).parsebytes(raw)
    ctype = msg.get_content_type()
    require(ctype == 'multipart/related', f'MIME 顶层不是 multipart/related，是 {ctype}')
    # 找到 HTML 正文与内联图
    html_part = img_part = None
    for part in msg.walk():
        if part.get_content_type() == 'text/html':
            html_part = part
        if part.get_content_type() == 'image/png':
            img_part = part
    require(html_part is not None, 'MIME 里没有 text/html 正文')
    html_text = html_part.get_content()
    require('2,000,000.00（已核对）' in html_text, 'MIME 正文与保存内容不一致')
    require('colspan="2"' in html_text, 'MIME 正文丢了横向合并')
    require('rowspan="2"' in html_text, 'MIME 正文丢了纵向合并')
    require(f'cid:{CID}' in html_text, 'MIME 正文丢了内联图引用')
    require(img_part is not None, 'MIME 里没有内联图片部件')
    cid_header = (img_part.get('Content-ID') or '').strip().strip('<>')
    require(cid_header == CID, f'MIME 内联图 Content-ID 对不上：{cid_header!r} != {CID!r}')
    img_bytes = img_part.get_payload(decode=True)
    require(hashlib.sha256(img_bytes).hexdigest() == sha(png), 'MIME 内联图字节与上传的不一致')
    passed('生成 MIME 并独立解析核对：正文/类型/Content-ID/图字节逐项一致（未外发）')

    # —— 8. 保存失败不假成功：旧版本冲突 ——
    before = client.service('mail.detail', {'mail': mail_id}).get('mail', {})
    try:
        client.action('mail.save_draft', {
            'mail': mail_id,
            'expected_version': 1,  # 旧版本
            'subject': '冲突尝试',
            'body': '<p>不该写进去</p>',
            'body_format': 'HTML',
            'to': ['收件人甲 <a@qq.com>'],
            'cc': [],
            'attachments': [],
        }, f'sample-chain-mail-3-{marker}')
    except RuntimeError as error:
        require('HTTP' in str(error) or '版本' in str(error) or '冲突' in str(error),
                f'旧版本保存失败但报错不明确：{error}')
        after = client.service('mail.detail', {'mail': mail_id}).get('mail', {})
        require(after.get('body') == before.get('body'), '保存失败却把正文改了')
        require(after.get('record_version') == before.get('record_version'), '保存失败却把版本推了')
        require('冲突尝试' not in (after.get('subject') or ''), '保存失败却改了主题')
        passed('保存失败不假成功：旧版本冲突被拒，已存内容一字未动')
    else:
        fail('旧版本保存竟然成功了 —— 这就是假成功，版本检查没生效')

    print('PASS 样本链全部走通：阅读→编辑→实际保存→重开→预览→MIME独立解析→保存失败；无真实外发', flush=True)


if __name__ == '__main__':
    main()
