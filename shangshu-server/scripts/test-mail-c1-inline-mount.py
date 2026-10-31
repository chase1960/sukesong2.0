#!/usr/bin/env python3
"""N2-C1 受管内联图必须挂在「这封信」上，不是挂在文件库记录上。

背景（真实产品页 2026-10-11 实测）：写信窗里图停在 cid: 显示不出来。
查下来是取字节被内核拒了 —— `file_content` 的两道校验里第二道说「该文件未挂在此记录上」。
`mail.save_draft` 只把 `file` id 原样存进 `inline_resources_json`，**没把 File 挂到信上**；
而收件路径 `delivery.py` 建 File 时是正确挂到信上的。两条路不一致。
更麻烦的是 `test-mail-sample-chain.py` 取字节时传的是 `ref='Shangshu File Center File'`
（文件库那条挂载），所以它读得到、报全绿 —— **测试验错了面，把缺陷藏住了**。

测试通过 = 下面全部成立：
 1. 保存一封带受管内联图的草稿（资源先落在文件库里）。
 2. 保存后用**信的归属**取字节 —— `/api/platform/file-content?ref=Shangshu Mail Message
    &ref_name=<这封信>&file=<存后返回的 file>` —— 返回 **200 且是图片字节**，不是 403。
 3. 再存一次（同 content_id）：`file` id **不变**（固定版本），归属仍是这封信。
 4. 正文仍是 `cid:` 引用，字节不写进正文。
"""
import base64
import importlib.util
import sys
import urllib.parse
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENV = Path('/path/to/workspace')
BASE = 'http://127.0.0.1:3830'

# 复用样本链的 Client / 小工具，不重复造一套登录与请求。
# 该文件有 `if __name__ == '__main__'` 守卫，按模块加载不会跑它的用例。
_spec = importlib.util.spec_from_file_location('mail_chain', HERE / 'test-mail-sample-chain.py')
_chain = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_chain)
Client, tiny_png, sha, load_password = _chain.Client, _chain.tiny_png, _chain.sha, _chain.load_password

CID = 'c1-mount-inline-1'
PNG = tiny_png()
_failed = []


def passed(msg):
    print(f'PASS|{msg}')


def failed(msg):
    print(f'FAIL|{msg}')
    _failed.append(msg)


def require(cond, msg):
    if cond:
        passed(msg)
    else:
        failed(msg)


def main():
    password = load_password()
    require(bool(password), '拿到测试口令')

    client = Client(BASE, password)
    client.login()

    marker = uuid.uuid4().hex[:8]

    # —— 1. 资源先落文件库（模拟前端从文件库选图）——
    up = client.action('files.upload', {
        'file_name': f'C1挂载核对-{marker}.png',
        'content_base64': base64.b64encode(PNG).decode('ascii'),
        'file_sha256': sha(PNG),
    }, f'c1-mount-file-{marker}')['result']
    versions = client.service('files.versions', {'file': up['file']})
    match = [v for v in versions.get('versions', []) if v.get('version_no') == up['version']]
    require(len(match) == 1 and match[0].get('frappe_file'), '文件库资源已就位')
    source_file = match[0]['frappe_file']

    body = ('<p>挂载核对</p>'
            f'<p><img src="cid:{CID}" alt="图"></p>')

    # —— 2. 保存草稿（资源先挂在文件库上，这是会出问题的那种引用）——
    saved = client.action('mail.save_draft', {
        'subject': f'C1 挂载核对 {marker}',
        'body': body, 'body_format': 'HTML',
        'to': ['核对 <c1@example.invalid>'], 'cc': [],
        'attachments': [],
        'inline_resources': [{'content_id': CID, 'mime_type': 'image/png',
                              'name': '图.png', 'file': source_file}],
    }, f'c1-mount-mail-1-{marker}')['result']
    require(saved.get('name'), '草稿已保存')
    mail_id = saved['name']
    version = saved['record_version']
    inline = saved.get('inline_resources') or []
    require(len(inline) == 1, '保存回执里有 1 条受管内联资源')
    bound_file = inline[0].get('file') if inline else ''
    require(bool(bound_file), '保存回执带回可用的受管文件 id')

    # —— 3. 关键：用**信的归属**取字节，必须放行 ——
    query = urllib.parse.urlencode({'ref': 'Shangshu Mail Message',
                                    'ref_name': mail_id, 'file': bound_file})
    try:
        img_bytes = client.request('/api/platform/file-content?' + query, binary=True)
        ok = isinstance(img_bytes, (bytes, bytearray)) and len(img_bytes) > 8 and img_bytes[:8] == b'\x89PNG\r\n\x1a\n'
        require(ok, f'用信的归属取字节成功（{len(img_bytes) if isinstance(img_bytes,(bytes,bytearray)) else 0} 字节，PNG 头正确）')
    except Exception as error:
        failed(f'用信的归属取字节被拒：{str(error)[:160]}')

    # —— 4. 再存一次，file id 必须不变（固定版本）——
    again = client.action('mail.save_draft', {
        'mail': mail_id, 'expected_version': version,
        'subject': f'C1 挂载核对 {marker}（再存）',
        'body': body, 'body_format': 'HTML',
        'to': ['核对 <c1@example.invalid>'], 'cc': [],
        'attachments': [],
        'inline_resources': [{'content_id': CID, 'mime_type': 'image/png',
                              'name': '图.png', 'file': bound_file}],
    }, f'c1-mount-mail-2-{marker}')['result']
    inline2 = again.get('inline_resources') or []
    require(len(inline2) == 1 and inline2[0].get('file') == bound_file,
            f'再存后 file id 不变（固定版本）：{bound_file}')

    # —— 5. 正文仍是 cid 引用，字节不进正文 ——
    detail = client.service('mail.detail', {'mail': mail_id}).get('mail', {})
    b = detail.get('body') or ''
    require(f'src="cid:{CID}"' in b or f"src='cid:{CID}'" in b, '正文仍是 cid: 引用')
    require('data:image' not in b, '字节没有被写进正文')

    print('SUMMARY|' + ('PASS' if not _failed else 'FAIL'))
    if _failed:
        sys.exit(1)


if __name__ == '__main__':
    main()
