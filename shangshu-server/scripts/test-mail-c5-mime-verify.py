#!/usr/bin/env python3
"""C5 第 5 条：预览与生产 MIME **独立解析**核对一致（复用首批核验器的做法）。

计划原文：「预览与生产 MIME 独立解析核对一致（复用首批核验器）」。

做法与 test-mail-sample-chain.py 的 build_mime 同构：
  走**生产** `transport.send_message` 生成 MIME，只把 SMTP 换成隔离捕获器 —— 一封都不出网；
  再用标准库 `BytesParser` **独立**读回来，跟库里保存的正文逐项对。
  「独立」的意思是：核对用的解析器不复用生产解析器的代码，两边各写各的。

状态文件 /tmp/c5-chain-state.json 由 test-mail-c5-product-chain.mjs 写出。

测试通过 = 下面全部成立：
 1. 生成的 MIME 顶层是 multipart/related（内联图走 related 段）。
 2. text/html 正文与保存内容一致：合并表格的 colspan/rowspan、中文、前导零都在。
 3. Content-ID 与正文 cid: 引用一一对应，图字节逐字节一致。
 4. MIME 里零外链图片，纯文本替代里没有表格标签。
"""
import json
import sys
from email import policy
from email.parser import BytesParser
from pathlib import Path

for _app in ('shangshu_mail', 'shangshu_core'):
    for _root in (Path.cwd(), Path('/home/frappe/frappe-bench/apps')):
        _p = _root / _app
        if _p.exists() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))

import frappe  # noqa: E402

SITES_PATH = '/home/frappe/frappe-bench/sites'
if not Path(SITES_PATH).exists():
    SITES_PATH = str(Path(__file__).resolve().parents[2] / 'sites')
frappe.init(site='shangshu.localhost', sites_path=SITES_PATH)
frappe.connect()

from shangshu_mail import transport  # noqa: E402  生产 MIME 生成必须走这条

STATE = '/tmp/c5-chain-state.json'
_passed, _failed = [], []


def check(label, ok, detail=''):
    (_passed if ok else _failed).append(label)
    print(('PASS|' if ok else 'FAIL|') + label + ((' | ' + str(detail)) if detail and not ok else ''))


def build_mime(mail, inline_resources, attachments):
    """走生产 send_message 生成 MIME，但把 SMTP 换成隔离捕获器 —— 一封都不出网。
    与 test-mail-sample-chain.py 的 build_mime 同构（首批核验器）。"""
    import unittest.mock
    captured = []

    class Capture:
        def __init__(self, *a, **k):
            pass

        def login(self, *a, **k):
            pass

        def send_message(self, message, **kw):
            captured.append(message)

        def quit(self):
            pass

        def close(self):
            pass

    # 地址必须过服务商白名单（transport.provider_for）；SMTP 与 SMTP_SSL 都要换掉。
    with unittest.mock.patch.object(transport.smtplib, 'SMTP_SSL', Capture), \
         unittest.mock.patch.object(transport.smtplib, 'SMTP', Capture):
        transport.send_message('sample@qq.com', 'never-used', 'C5 核对', mail, attachments,
                               inline_resources=inline_resources)
    if not captured:
        raise SystemExit('隔离捕获器没收到生成的 MIME')
    return captured[0].as_bytes()


def main():
    state = json.loads(Path(STATE).read_text(encoding='utf-8'))
    name = state['draft']['name']
    frappe.set_user('Administrator')
    doc = frappe.get_doc('Shangshu Mail Message', name)
    print('核对草稿:', name, '| 版本', doc.record_version, '| 主题', doc.subject)

    inline = json.loads(doc.inline_resources_json or '[]')
    att_ids = json.loads(doc.attachment_ids_json or '[]')
    attachments = []
    for fid in att_ids:
        f = frappe.get_doc('File', fid)
        attachments.append({'name': f.file_name, 'content': f.get_content(), 'mime_type': 'application/octet-stream'})
    inline_resources = []
    for item in inline:
        f = frappe.get_doc('File', item['file'])
        inline_resources.append({'content_id': item['content_id'], 'mime_type': item.get('mime_type') or 'image/png',
                                 'name': item.get('name') or 'inline.img', 'content': f.get_content()})

    raw = build_mime({'subject': doc.subject, 'body': doc.body, 'body_format': doc.body_format or 'HTML',
                      'to': ['c5@example.invalid'], 'cc': [],
                      'message_id': '<c5-mime-verify@example.invalid>'},
                     inline_resources, attachments)
    Path('/tmp/c5-mime-raw.eml').write_bytes(raw)
    print('已生成 MIME 字节:', len(raw), '→ /tmp/c5-mime-raw.eml')

    msg = BytesParser(policy=policy.default).parsebytes(raw)
    ctype = msg.get_content_type()
    check('M1 顶层是 multipart/related（内联图走 related 段）', ctype == 'multipart/related', ctype)

    html_part = plain_part = None
    inline_parts = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        if part.get_content_type() == 'text/html':
            html_part = part
        elif part.get_content_type() == 'text/plain':
            plain_part = part
        elif part.get('Content-ID'):
            inline_parts.append(part)
    check('M2 有 text/html 正文', html_part is not None, '没有 text/html 段')
    html_text = html_part.get_content() if html_part else ''
    plain_text = plain_part.get_content() if plain_part else ''

    # 与保存内容逐项对
    check('M3 横向合并在 MIME 里', 'colspan' in html_text, html_text[:120])
    check('M4 纵向合并在 MIME 里', 'rowspan' in html_text, html_text[:120])
    check('M5 中文在 MIME 里', '年费已核对' in html_text, html_text[:120])
    check('M6 前导零在 MIME 里（没被转成数字）', '007' in html_text, html_text[:120])
    check('M7 与保存正文逐字一致', doc.body.strip() == html_text.strip(),
          f'库里 {len(doc.body)} 字 / MIME {len(html_text)} 字')

    # Content-ID 与正文引用一一对应
    body_cids = set()
    for token in (doc.body or '').split('cid:')[1:]:
        body_cids.add(token.split('"')[0].split("'")[0].split('>')[0].strip())
    mime_cids = {(p.get('Content-ID') or '').strip().strip('<>') for p in inline_parts}
    check('M8 正文 cid: 引用与 MIME Content-ID 一一对应', body_cids and body_cids == mime_cids,
          f'正文 {body_cids} / MIME {mime_cids}')

    # 图字节逐字节一致
    same = True
    detail = ''
    for item in inline_resources:
        hit = next((p for p in inline_parts
                    if (p.get('Content-ID') or '').strip().strip('<>') == item['content_id']), None)
        if hit is None or (hit.get_payload(decode=True) or b'') != item['content']:
            same = False
            detail = item['content_id']
            break
    check('M9 内联图字节逐字节一致', same, detail)

    # 安全：零外链图；纯文本替代里没有表格标签
    remote = [t for t in (html_text or '').split('<img') if 'src="http' in t or "src='http" in t]
    check('M10 MIME 里零外链图片', not remote, remote[:1])
    check('M11 纯文本替代没有表格标签', '<table' not in (plain_text or ''), (plain_text or '')[:80])

    # 与 C5 链上「预览」那一步读到的正文一致
    check('M12 与产品页链上保存的正文一致', (state.get('previewBody') or '').strip() == (doc.body or '').strip(),
          f"state {len(state.get('previewBody') or '')} 字 / 库里 {len(doc.body or '')} 字")

    print('---')
    print(f'{len(_passed)} PASS / {len(_failed)} FAIL')
    for f in _failed:
        print('  - ' + f)
    return 0 if not _failed else 1


if __name__ == '__main__':
    sys.exit(main())
