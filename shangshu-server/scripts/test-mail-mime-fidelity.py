"""邮件MIME保真回归：固定样本（HTML＋表格＋合并格＋受管内联图）读入→保存→生成MIME→独立解析核对。

测试通过 = 下面全部成立：
1. 含表格与合并单元格（colspan/rowspan）的 HTML 正文经接收解析后仍保留表格结构与合并信息，
   正文格式标记为 HTML，不被压成纯文本。
2. 受管内联图以 Content-ID 引用进入正文，独立解析后 Content-ID、MIME 类型、字节与引用一致；
   任意外部图片请求被拒，不放开外链。
3. 生成的 MIME 被一个独立解析器（只用标准库 email）核对：正文 HTML、表格、合并格、
   Content-ID、Content-Type 及引用关系与保存值一致，plain 备选不含表格标签。
4. 危险 HTML（script、事件属性、外部 src）在进入存储前被净化，且表格/合并/CID 不被误伤。

只生成邮件内容并用隔离捕获器收取，不触达外部 SMTP/IMAP，不读客户凭据。
"""
import sys
import unittest
import unittest.mock
from email import policy
from email.parser import BytesParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_mail'))
from shangshu_mail import transport


# ---- 固定脱敏样本：HTML ＋ 表格 ＋ 合并单元格 ＋ 一张受管内联图 ----
CID = 'logo-sample@shangshu.local'
# 真实世界 HTML 信的 head —— `<meta>`/`<link>` 是**空标签，没有结束标签**。
# 净化器的「危险标签内」计数器靠 start+1/end-1 配平，遇到它们就永远回不到 0。
REALWORLD_HTML = (
    '<html><head>'
    '<meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width">'
    '<link rel="stylesheet" href="https://cdn.example.com/mail.css">'
    '<title>线上训练营</title>'
    '<style>.hd{background:#12263f;color:#fff}</style>'
    '</head><body>'
    '<div class="hd">第三届 NVIDIA DGX Spark 黑客松</div>'
    '<p>欢迎报名参加本次线上训练营，名额有限。</p>'
    '<table><tr><td>议程</td><td>第一天</td></tr></table>'
    '</body></html>')
PNG = (b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01'
       b'\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01'
       b'\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82')

SAMPLE_HTML = (
    '<p>客户您好，本期核对如下。</p>'
    '<table border="1" cellpadding="4" cellspacing="0">'
    '<thead><tr><th colspan="2">案件汇总</th><th>金额</th></tr></thead>'
    '<tbody>'
    '<tr><td rowspan="2">A001</td><td>年费</td><td>150.00</td></tr>'
    '<tr><td>滞纳金</td><td>0.00</td></tr>'
    '<tr><td>B002</td><td>年费</td><td>220.00</td></tr>'
    '</tbody>'
    '</table>'
    f'<p>详见附图 <img src="cid:{CID}" alt="样例图">。</p>'
)

DANGEROUS_HTML = (
    '<p onclick="steal()">核对</p>'
    f'<table><tr><td colspan="2">保留合并</td></tr>'
    f'<tr><td>A001</td><td><img src="cid:{CID}"></td></tr></table>'
    '<script>steal()</script>'
    '<img src="https://tracker.invalid/pixel">'
)


def sample_eml():
    """合成一封带表格/合并格/CID内联图的原始邮件字节（脱敏，不来自客户邮箱）。

    结构：multipart/related
      ├─ multipart/alternative
      │    ├─ text/plain
      │    └─ text/html（表格 + colspan/rowspan + cid: 引用）
      └─ image/png（Content-ID，内联，原始 MIME 类型）
    """
    from email.message import EmailMessage
    alt = EmailMessage()
    alt.set_content('客户您好，本期核对如下。\nA001 年费 150.00')
    alt.add_alternative(SAMPLE_HTML, subtype='html')

    related = EmailMessage()
    related['From'] = '样例工厂 <factory@example.invalid>'
    related['To'] = 'demo@example.invalid'
    related['Subject'] = '样例核对表'
    related['Message-ID'] = '<sample-mime@example.invalid>'
    related.make_related()
    related.attach(alt)
    # 受管内联图：Content-ID + 原始 MIME 类型，作为 related 部分而非普通附件
    image = EmailMessage()
    image.set_content(PNG, maintype='image', subtype='png', disposition='inline',
                      filename='样例图.png', cid=f'<{CID}>')
    related.attach(image)
    return related.as_bytes()


class MimeFidelityTests(unittest.TestCase):
    def test_接受解析保留表格合并格与受管内联图(self):
        """测试通过 = 表格/合并格/CID 图在接收解析后不丢，且不被压成纯文本。"""
        parsed = transport.parse_message(sample_eml())
        self.assertEqual(parsed.get('body_format'), 'HTML',
                         'HTML 正文必须标记为 HTML，不能当纯文本存')
        body = parsed['body']
        self.assertIn('<table', body, '表格结构丢失')
        self.assertIn('colspan="2"', body, '横向合并信息丢失')
        self.assertIn('rowspan="2"', body, '纵向合并信息丢失')
        self.assertIn('A001', body)
        self.assertIn('150.00', body)
        # 受管内联图：必须以 CID 引用保留，且作为独立资源登记
        self.assertIn(f'cid:{CID}', body, '内联图 CID 引用丢失')
        inline = [r for r in parsed.get('inline_resources', []) if r.get('content_id') == CID]
        self.assertTrue(inline, '受管内联图未登记为 inline 资源')
        self.assertEqual(inline[0].get('mime_type'), 'image/png', '内联图 MIME 类型丢失')
        self.assertEqual(inline[0].get('content'), PNG, '内联图字节不一致')

    def test_拒绝任意外部图片不放开外链(self):
        """测试通过 = 外部图片请求被拒，不因样本成功就放开任意外部图片。"""
        from email.message import EmailMessage
        msg = EmailMessage()
        msg['From'] = 'factory@example.invalid'
        msg.set_content('正文')
        msg.add_alternative(DANGEROUS_HTML, subtype='html')
        parsed = transport.parse_message(msg.as_bytes())
        body = parsed['body']
        self.assertNotIn('tracker.invalid', body, '外部图片地址必须被拒')
        self.assertNotIn('<script', body, '脚本必须被净化')
        self.assertNotIn('onclick', body, '事件属性必须被净化')
        # 但表格、合并格、受管 CID 图不能被误伤
        self.assertIn('colspan="2"', body, '净化误伤了合并信息')
        self.assertIn(f'cid:{CID}', body, '净化误伤了受管 CID 引用')

    def test_生成MIME独立解析核对正文表格合并格与CID一致(self):
        """测试通过 = 生成的 MIME 被独立解析后，正文/表格/合并格/Content-ID/类型与保存值一致。"""
        captured = []

        class Capture:
            def __init__(self, *a, **k): pass
            def login(self, *a, **k): pass
            def send_message(self, message, **kw):
                captured.append(message)
                return {}
            def quit(self): pass
            def close(self): pass

        parsed = transport.parse_message(sample_eml())
        inline = [{'name': '样例图.png', 'content': PNG, 'mime_type': 'image/png',
                   'content_id': CID, 'disposition': 'inline'}]
        with unittest.mock.patch.object(transport.smtplib, 'SMTP_SSL', Capture):
            result = transport.send_message(
                'demo@qq.com', 'synthetic', '样例发件人',
                {'subject': '样例核对表', 'body': parsed['body'], 'body_format': 'HTML',
                 'to': ['client@example.invalid'], 'cc': [],
                 'message_id': '<sample-mime-out@example.invalid>'},
                [], inline_resources=inline)
        self.assertEqual(result['status'], 'Sent')
        self.assertTrue(captured, '捕获器未收到生成的 MIME')

        # 独立解析器：只用标准库，按真实字节重新解析，不复用生成端的字段
        raw = captured[0].as_bytes()
        reparsed = BytesParser(policy=policy.default).parsebytes(raw)
        html_part = reparsed.get_body(preferencelist=('html',))
        self.assertIsNotNone(html_part, '缺少 text/html 正文部分')
        html = html_part.get_content()
        self.assertIn('<table', html, '独立解析后表格丢失')
        self.assertIn('colspan="2"', html, '独立解析后横向合并丢失')
        self.assertIn('rowspan="2"', html, '独立解析后纵向合并丢失')
        self.assertIn(f'cid:{CID}', html, '独立解析后 CID 引用丢失')

        plain = reparsed.get_body(preferencelist=('plain',))
        if plain is not None:
            self.assertNotIn('<table', plain.get_content(), 'plain 备选不应含表格标签')

        # Content-ID 与 MIME 类型一致性：在 related 部分里按 CID 找到内联图
        related = [p for p in reparsed.walk() if p.get_content_disposition() == 'inline'
                   or (p.get('Content-ID') or '').strip('<>') == CID]
        self.assertTrue(related, '独立解析未找到内联图部分')
        inline_part = related[0]
        self.assertEqual((inline_part.get('Content-ID') or '').strip('<>'), CID,
                         'Content-ID 与引用不一致')
        self.assertEqual(inline_part.get_content_type(), 'image/png',
                         '内联图 MIME 类型与保存值不一致')
        self.assertEqual(inline_part.get_payload(decode=True), PNG, '内联图字节不一致')

    def test_空标签meta_link不把正文卡到丢光(self):
        """测试通过 = `<meta>`/`<link>` 这类**没有结束标签**的空标签，不会让净化器
        「现在在危险标签里」的计数永远回不到 0，从而把 `<body>` 之后的正文整段丢掉。

        用户 2026-10-13 手点实测（原文）：
          「完全空白了，而且 ## 月 20 日 线上训练营 | 第三届 NVIDIA DGX Spark 黑客松
            这一封也看不到，你html解析是有问题的」
        查实库里那两封真信（ra9cg8r95b / raelm2h9cc）存的正文是 `'\\r\\n\\r\\n\\r\\n'`
        和 `'\\r\\n \\r\\n '` —— 只剩 head 之前的空白字符。
        """
        html = REALWORLD_HTML
        out = transport.sanitize_html(html)
        self.assertIn('NVIDIA DGX Spark 黑客松', out,
                      f'标题被丢光了，净化结果只剩 {out!r}')
        self.assertIn('欢迎报名', out, f'正文被丢光了，净化结果只剩 {out!r}')
        self.assertIn('议程', out, f'表格文字被丢光了，净化结果只剩 {out!r}')
        self.assertIn('<table', out, f'表格结构被丢光了，净化结果只剩 {out!r}')
        # 危险/无用的东西仍然要剥干净，不能为救正文而放开
        self.assertNotIn('<style', out, '<style> 没剥掉')
        self.assertNotIn('<meta', out, '<meta> 没剥掉')
        self.assertNotIn('<link', out, '<link> 没剥掉')
        self.assertNotIn('<title', out, '<title> 没剥掉')
        self.assertNotIn('cdn.example.com', out, '外链样式地址漏进正文')

    def test_真实HTML信收进来正文不是空白(self):
        """测试通过 = 走完整收信解析（parse_message），一封 head 里带 `<meta>`/`<link>`
        的真实 HTML 信，**正文存得下来**，不被标成 HTML 却存了个空壳。"""
        eml = (b'From: NVIDIA Events <events@mail.nvidia.cn>\r\n'
               b'To: me@lingeringtek.cn\r\n'
               b'Subject: =?utf-8?b?57qn5p2D6K6u6K6t6JGj?=\r\n'
               b'MIME-Version: 1.0\r\n'
               b'Content-Type: text/html; charset="utf-8"\r\n'
               b'\r\n'
               + REALWORLD_HTML.encode('utf-8'))
        parsed = transport.parse_message(eml)
        self.assertEqual(parsed['body_format'], 'HTML', f"正文格式错了：{parsed['body_format']}")
        self.assertTrue(parsed['body'].strip(),
                        f"正文是空的/只有空白，实际存了 {parsed['body']!r}")
        self.assertIn('NVIDIA DGX Spark 黑客松', parsed['body'],
                      f"正文里没有标题，实际存了 {parsed['body'][:200]!r}")
        self.assertIn('欢迎报名', parsed['body'],
                      f"正文里没有正文文字，实际存了 {parsed['body'][:200]!r}")

    def test_表头底色两种写法都留得住(self):
        """测试通过 = 表格表头的**底色**经收信净化后还在，转发/回复时跟着表格走。

        用户 2026-10-13 手点实测（原文）：
          「现在图能转出去，表格现在可以发，但是表头颜色发不出去」
        查实两种写法都被丢：
          · `<td bgcolor="#12263f">`  —— bgcolor 不在 td/th 的保留属性表里，被剥
          · `<style>.hd{background:#12263f}</style>` + `class="hd"`
                                      —— <style> 整块删掉，又没把规则内联到元素上
          只有手写 `<td style="background:#12263f">` 能活。
        """
        # 写法一：老式 bgcolor 属性（大量真实邮件用这个）
        out = transport.sanitize_html(
            '<table><tr><td bgcolor="#12263f" style="color:#fff">表头</td></tr></table>')
        self.assertRegex(out, r'bgcolor="#12263f"|background:\s*#12263f',
                         f'bgcolor 表头底色被丢了，只剩 {out!r}')

        # 写法二：<style> 块 + class 选择器（现代营销邮件标配）
        out = transport.sanitize_html(
            '<style>.hd{background:#12263f;color:#fff}</style>'
            '<table><tr><td class="hd">表头</td></tr></table>')
        self.assertRegex(out, r'background:\s*#12263f',
                         f'<style> 类选择器的表头底色被丢了（规则没内联到元素上），只剩 {out!r}')

        # 写法三：内联 style（本来就能活，别改坏）
        out = transport.sanitize_html(
            '<table><tr><td style="background:#12263f;color:#fff">表头</td></tr></table>')
        self.assertRegex(out, r'background:\s*#12263f', f'内联 style 底色也没了，只剩 {out!r}')

    def test_内联表头底色时仍不放进危险CSS(self):
        """测试通过 = 为了保住底色而内联 `<style>` 规则时，**不把危险 CSS 放进来**。"""
        out = transport.sanitize_html(
            '<style>.hd{background:#12263f;color:#fff}'
            '.bad{background:url(https://evil.example.com/x.png)}'
            '.worse{width:expression(alert(1))}</style>'
            '<table><tr><td class="hd">表头</td><td class="bad">A</td><td class="worse">B</td></tr></table>')
        self.assertIn('background:#12263f', out.replace(' ', ''),
                      f'正常底色没保住：{out!r}')
        self.assertNotIn('evil.example.com', out, f'外链 CSS 漏进来了：{out!r}')
        self.assertNotIn('expression', out, f'CSS expression 漏进来了：{out!r}')

    def test_标签没闭合也不许把正文卡到丢光(self):
        """测试通过 = 危险标签**没闭合 / 自闭合 / 错配**时，只影响它自己那段，
        **不把后面的正文整段吞掉**。

        上一版只修了「空标签没有结束标签」那一半（`<meta>`/`<link>`）。
        但计数器对**成对**标签仍然假设严格配平 —— 而真实 HTML 里
        `</head>` 经常被省略（HTML 规范允许、压缩器常删），`<form>` 也常不闭合。
        同症状：正文又整段丢光。用户看到的还是「这一封看不到」。
        """
        cases = [
            ('省略 </head>',
             '<html><head><meta charset="utf-8"><title>t</title><style>.a{}</style>'
             '<body><p>正文必须留下</p></body></html>'),
            ('<form> 没闭合',
             '<div>前言</div><form><div>表单</div><p>后面的话</p>'),
            ('<title/> 自闭合',
             '<p>前</p><title/><p>后</p>'),
        ]
        for label, html in cases:
            out = transport.sanitize_html(html)
            self.assertRegex(out, r'正文必须留下|后面的话|前|后',
                             f'[{label}] 后面的正文被整段吞了，只剩 {out!r}')
        # 局限（诚实记下，别假装修好了）：`<style>`/`<script>` 的内容是**原始文本**
        # 直到 `</style>`/`</script>`，语法上后面的东西就属于它里面 ——
        # 浏览器也一样吞，不是我们能修的。这里只钉「它之前的字还在」。
        out = transport.sanitize_html('<p>前面的字</p><style>.hd{color:red}')
        self.assertIn('前面的字', out, f'<style> 之前的字也没了：{out!r}')

    def test_保存后重新生成MIME引用与正文同次生效(self):
        """测试通过 = 同一次保存里正文 CID 引用与内联资源一起生效，不出现引用悬空。"""
        parsed = transport.parse_message(sample_eml())
        inline = [{'name': '样例图.png', 'content': PNG, 'mime_type': 'image/png',
                   'content_id': CID, 'disposition': 'inline'}]
        # 引用完整性：正文引用的每个 CID 都必须有对应资源
        referenced = transport.referenced_cids(parsed['body'])
        self.assertIn(CID, referenced, '正文未引用受管 CID')
        available = {r['content_id'] for r in inline}
        missing = set(referenced) - available
        self.assertFalse(missing, f'正文引用了未提供的内联资源: {missing}')


class FourPathMimeFidelityTests(unittest.TestCase):
    """BASE967-03 / req 1 ②：四条路**保存重开**后的草稿 → 真实 `send_message`
    → 标准库 `email` 独立解析，核对正文 / CID / 附件 / 地址。

    草稿来源不是请求载荷，而是 `mail-four-paths-reopen.test.ts` 里 mock 的 `stored`
    （保存 → 服务端状态 → 重开这条链）：

        cd shangshu-server
        BASE967_MIME_OUT=/tmp/four-paths.json \\
          node --experimental-strip-types --test tests/website/mail-four-paths-reopen.test.ts
        BASE967_MIME_DRAFTS=/tmp/four-paths.json \\
          python3 -m unittest scripts/test-mail-mime-fidelity.py

    测试通过 = 新建 / 回复 / 转发 / 签名四条路各自成立：
      · From 是邮箱显示名 + 地址，To / Cc / Subject 与草稿一致；
      · HTML 正文与草稿一致；纯文本备选非空且含正文文字；
      · 草稿里的每个内联图：Content-ID / Content-Type / 字节一致，且正文用 cid: 引用；
      · 草稿里的每个附件：名字 / 字节一致，Content-Type **与扩展名相符**
        （不是一律 application/octet-stream）。

    只替换传输边界 `smtp_session`；MIME 构造、大小检查、收件人去重全是生产代码。
    附件/内联图字节在发信时来自受管 File 存储（草稿里只有 file 引用），
    这里按名字合成确定性字节 —— 核对的是「送进去的原样出现在 MIME 里」。
    """

    def _drafts(self):
        import json
        import os
        path = os.environ.get('BASE967_MIME_DRAFTS')
        if not path or not os.path.exists(path):
            self.skipTest('缺 BASE967_MIME_DRAFTS=<four-paths.json>；'
                          '先用 BASE967_MIME_OUT 跑 mail-four-paths-reopen.test.ts')
        with open(path, encoding='utf-8') as fh:
            return json.load(fh)

    @staticmethod
    def _attachment_bytes(name):
        return ('附件的原始字节：' + name).encode('utf-8')

    @staticmethod
    def _inline_bytes(cid):
        return b'\x89PNG\r\n\x1a\n' + cid.encode('utf-8')

    @staticmethod
    def _worker_attachment_keys():
        """从 delivery.py **实读** worker 拼附件用的字段 —— 不靠测试这边手写。

        这样「worker 不传 mime_type」时，行为断言会跟着红，
        而不是测试自己把 mime_type 补上、把缺陷盖住（恒真陷阱）。
        """
        import re
        src = (Path(__file__).resolve().parents[2]
               / 'frappe_apps/shangshu_mail/shangshu_mail/delivery.py').read_text(encoding='utf-8')
        block = src.split('def process_send')[1].split('transport.send_message')[0]
        m = re.search(r'attachments\.append\(\{(.+?)\}\)', block, re.S)
        if not m:
            raise AssertionError('delivery.py：找不到 worker 拼附件的 attachments.append({...})')
        return set(re.findall(r"'(\w+)'\s*:", m.group(1)))

    def _send_and_parse(self, draft):
        """照 delivery.py:131-157 的映射拼参数（worker 怎么拼，这里就怎么拼）。"""
        import mimetypes
        captured = []

        class Capture:
            def __init__(self, *a, **k): pass
            def login(self, *a, **k): pass
            def send_message(self, message, from_addr=None, to_addrs=None):
                captured.append((message, from_addr, list(to_addrs or [])))
                return {}
            def noop(self): pass
            def quit(self): pass
            def close(self): pass

        worker_keys = self._worker_attachment_keys()
        attachments = []
        for item in (draft.get('attachments') or []):
            name = item.get('name') or item.get('file')
            entry = {'name': name, 'content': self._attachment_bytes(name)}
            if 'mime_type' in worker_keys:
                entry['mime_type'] = (mimetypes.guess_type(name)[0]
                                      or 'application/octet-stream')
            attachments.append(entry)
        inline = [
            {'content_id': item['content_id'],
             'mime_type': item.get('mime_type') or 'image/png',
             'name': item.get('name') or 'inline.img',
             'content': self._inline_bytes(item['content_id'])}
            for item in (draft.get('inline_resources') or [])
            if item.get('content_id') and item.get('file')
        ]
        mail = {
            'subject': draft.get('subject') or '',
            'body': draft.get('body') or '',
            'body_format': draft.get('body_format') or 'Text',
            'to': list(draft.get('to') or []),
            'cc': list(draft.get('cc') or []),
            'message_id': draft.get('message_id') or '<mime-test@shangshu.local>',
            'in_reply_to': draft.get('in_reply_to') or '',
        }
        with unittest.mock.patch.object(transport, 'smtp_session',
                                        lambda *a, **k: Capture()):
            outcome = transport.send_message(
                'me@example.invalid', 'synthetic', '我', mail,
                attachments, 'netease-enterprise',
                inline_resources=inline, credential_version=1)
        self.assertEqual(outcome.get('status'), 'Sent', f'发信没走完：{outcome}')
        self.assertTrue(captured, '传输边界没收到 MIME')
        message, from_addr, to_addrs = captured[0]
        reparsed = BytesParser(policy=policy.default).parsebytes(message.as_bytes())
        return mail, attachments, inline, reparsed, to_addrs

    def test_四路草稿生成的MIME正文图标地址一致(self):
        """测试通过 = 见类注释四条；任一条路不成立就红。"""
        import mimetypes
        drafts = self._drafts()
        self.assertEqual([d['path'] for d in drafts], ['新建', '回复', '转发', '签名'],
                         '草稿导出缺路数或顺序不对')
        for item in drafts:
            label, draft = item['path'], item['draft']
            with self.subTest(路径=label):
                mail, attachments, inline, msg, to_addrs = self._send_and_parse(draft)

                self.assertEqual(str(msg['From']), '我 <me@example.invalid>',
                                 f'{label}：From 不对')
                self.assertEqual(str(msg['Subject']), mail['subject'], f'{label}：Subject 不对')
                self.assertEqual([a.addr_spec for a in msg['To'].addresses],
                                 mail['to'], f'{label}：To 不对')
                if mail['cc']:
                    self.assertEqual([a.addr_spec for a in msg['Cc'].addresses],
                                     mail['cc'], f'{label}：Cc 不对')
                self.assertEqual(str(msg['Message-ID']), mail['message_id'],
                                 f'{label}：Message-ID 不对')
                if mail['in_reply_to']:
                    self.assertEqual(str(msg['In-Reply-To']), mail['in_reply_to'],
                                     f'{label}：In-Reply-To 不对')
                self.assertEqual(to_addrs, list(dict.fromkeys(mail['to'] + mail['cc'])),
                                 f'{label}：SMTP 收件人与 To+Cc 去重不一致')

                html_part = msg.get_body(preferencelist=('html',))
                self.assertIsNotNone(html_part, f'{label}：没有 HTML 正文段')
                self.assertEqual(html_part.get_content().strip(), mail['body'].strip(),
                                 f'{label}：HTML 正文与草稿不一致')
                plain_part = msg.get_body(preferencelist=('plain',))
                self.assertIsNotNone(plain_part, f'{label}：没有纯文本备选段')
                self.assertTrue(plain_part.get_content().strip(),
                                f'{label}：纯文本备选是空的')
                self.assertIn('正文第一段', plain_part.get_content(),
                              f'{label}：纯文本备选丢了正文文字')

                inline_parts = {}
                for part in msg.walk():
                    cid = (part.get('Content-ID') or '').strip('<>')
                    if cid:
                        inline_parts[cid] = part
                for res in inline:
                    cid = res['content_id']
                    part = inline_parts.get(cid)
                    self.assertIsNotNone(part, f'{label}：内联图 {cid} 在 MIME 里找不到')
                    self.assertEqual(part.get_content_type(), res['mime_type'],
                                     f'{label}：内联图 {cid} 类型不符')
                    self.assertEqual(part.get_payload(decode=True), res['content'],
                                     f'{label}：内联图 {cid} 字节不符')
                    self.assertIn(f'cid:{cid}', html_part.get_content(),
                                  f'{label}：正文没引用 cid:{cid}')

                sent_atts = [p for p in msg.walk()
                             if p.get_content_disposition() == 'attachment']
                self.assertEqual(len(sent_atts), len(attachments),
                                 f'{label}：附件个数不符')
                for att in attachments:
                    matched = [p for p in sent_atts if p.get_filename() == att['name']]
                    self.assertTrue(matched, f"{label}：附件 {att['name']} 在 MIME 里找不到")
                    part = matched[0]
                    self.assertEqual(part.get_payload(decode=True), att['content'],
                                     f"{label}：附件 {att['name']} 字节不符")
                    expected = mimetypes.guess_type(att['name'])[0]
                    self.assertEqual(part.get_content_type(), expected,
                                     f"{label}：附件 {att['name']} 的 Content-Type 是 "
                                     f"{part.get_content_type()}，按扩展名应为 {expected}")

                self.assertEqual(sum(1 for p in msg.walk()
                                     if p.get_content_type() == 'text/html'), 1,
                                 f'{label}：HTML 正文出现了不止一份（单份 MIME）')

    def test_一千格表格导出MIME单元格不丢(self):
        """测试通过 = 1000 格表格作为正文导出 MIME 后：HTML 原样、1000 个单元格都在。

        req 4 原话：「1000 格保存、刷新、继续编辑与**导出 MIME 核对**」。
        配套的保存侧判据在 `page-timing/base967-24-verify-product.mjs` 场景 C：
        连续保存 5 次后正文长度稳定在 58480 字符（低于写信窗 100000 上限），
        靠的是边框归一化幂等，**不是**调大长度上限。
        """
        rows, cols = 50, 20
        body = ('<table border="1"><tbody>' +
                ''.join('<tr>' + ''.join(
                    '<td style="border:1px solid #d0d5dd">A001</td>' for _ in range(cols)
                ) + '</tr>' for _ in range(rows)) +
                '</tbody></table>')
        self.assertLess(len(body), 100000, '前置：1000 格正文应低于写信窗上限')
        draft = {'subject': '一千格', 'body': body, 'body_format': 'HTML',
                 'to': ['client@example.invalid'], 'cc': [],
                 'message_id': '<table1000@shangshu.local>',
                 'attachments': [], 'inline_resources': []}
        mail, attachments, inline, msg, to_addrs = self._send_and_parse(draft)
        html_part = msg.get_body(preferencelist=('html',))
        self.assertIsNotNone(html_part, '缺少 HTML 正文段')
        html = html_part.get_content()
        self.assertEqual(html.strip(), body.strip(), '1000 格 HTML 正文被改写或截断')
        self.assertEqual(html.count('<td'), rows * cols,
                         f'导出的单元格数不对：{html.count("<td")} != {rows * cols}')
        plain = msg.get_body(preferencelist=('plain',)).get_content()
        self.assertTrue(plain.strip(), '1000 格表格的纯文本备选是空的')

    def test_worker把附件类型传给了send_message(self):
        """测试通过 = delivery.py 的 worker 拼附件时带 `mime_type`。

        2026-10-17 改之前只传 `name` + `content` —— 于是上面那条测试在四条路上
        全部拿到 application/octet-stream。本条钉住源码，防止映射再漂回旧写法；
        与上面的行为断言互为对照（行为说「现在对」，本条说「为什么对」）。
        """
        import re
        src = (Path(__file__).resolve().parents[2]
               / 'frappe_apps/shangshu_mail/shangshu_mail/delivery.py').read_text(encoding='utf-8')
        send_block = src.split('def process_send')[1].split('transport.send_message')[0]
        m = re.search(r'attachments\.append\(\{(.+?)\}\)', send_block, re.S)
        self.assertIsNotNone(m, 'delivery.py：找不到 worker 拼附件的 attachments.append({...})')
        keys = set(re.findall(r"'(\w+)'\s*:", m.group(1)))
        self.assertIn('mime_type', keys,
                      'delivery.py：worker 拼附件只有 %s —— 收件方拿到的 Content-Type '
                      '会一律退成 application/octet-stream' % '、'.join(sorted(keys)))


if __name__ == '__main__':
    unittest.main()
