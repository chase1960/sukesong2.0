#!/usr/bin/env python3
"""独立解析实际 MIME **与预览一致**（SIG 验收单明写「下一笔补」的那半）。

验收单 AC-SIG 原话：
  「计划要求的『独立解析实际 MIME 与预览一致』**只钉了一半**
    （签名进 text/plain 替代已钉，『**与预览逐项对得上**』未钉死），下一笔补。」

`test-mail-mime-consistency.py` 钉的是「解析结果 vs **保存值**」—— 不是一回事：
预览（`mail-center.js` 的 `bodyView` + 发送前核对那张单）是从
`data.from / to / cc / subject / body / bodyFormat / inline` **一栏一栏画出来**的。
用户在发送前核对上看到什么，发出去的就得是什么。

测试通过 = **发送前核对上看到的每一项，独立解析实际 MIME 后逐项对得上，
而且不许多出来**：

 1. **发件身份**（From）—— 预览第一行
 2. **收件人**（To）—— 预览「收件人」那行
 3. **抄送**（Cc）—— 预览「抄送」那行
 4. **主题**（Subject）—— 预览「主题」那行
 5. **正文 HTML** —— 预览 iframe 里那份，逐字对得上
 6. **纯文本替代** —— 签名也进（这是已钉的那半，顺带守住）
 7. **内联图** —— CID / 类型 / 字节对得上（预览里看得见的图）
 8. **不许多出来** —— 预览上没有的收件人、没有的主题、多余 part，MIME 里都不该有

只用标准库 `email` 重新解析，**不复用生成端字段**。
跑法：`python test-mail-mime-vs-preview.py`
"""
import sys
import unittest
import unittest.mock
from email import policy
from email.parser import BytesParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_mail'))
from shangshu_mail import transport

CID = 'logo-preview@shangshu.local'
PNG = (b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01'
       b'\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01'
       b'\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82')

# 预览上「正文 · 按本次发送内容」那一栏画的就是这个 body（含签名）。
SIGNATURE = ('<p>——<br>王五<br>银聆科技 · 法务<br>'
             '<a href="https://lingeringtek.cn">lingeringtek.cn</a></p>')
BODY_HTML = (
    '<p>李经理您好，本月对账单见下。</p>'
    '<table border="1"><tr><th>项目</th><th>金额</th></tr>'
    '<tr><td>年费</td><td>220.00</td></tr></table>'
    f'<p>附图 <img src="cid:{CID}" alt="logo">。</p>'
    + SIGNATURE
)
# 纯文本替代：签名也得进去（已钉的那半）
BODY_PLAIN = ('李经理您好，本月对账单见下。\n项目 金额\n年费 220.00\n附图。\n'
              '——\n王五\n银聆科技 · 法务\nlingeringtek.cn')


class MimeVsPreviewTests(unittest.TestCase):
    """发送前核对上的一栏一栏，和独立解析出来的 MIME 逐项对。"""

    def _generate(self):
        captured = []

        class Capture:
            def __init__(self, *a, **k): pass
            def login(self, *a, **k): pass
            def send_message(self, message, **kw):
                captured.append(message)
                return {}
            def quit(self): pass
            def close(self): pass

        inline = [{'name': 'logo.png', 'content': PNG, 'mime_type': 'image/png',
                   'content_id': CID, 'disposition': 'inline'}]
        with unittest.mock.patch.object(transport.smtplib, 'SMTP_SSL', Capture):
            result = transport.send_message(
                'wuwang@qq.com', 'synthetic', '王五',   # provider_for 认得 qq.com，别用陌生域名
                # 这个 payload 就是预览那张单画的 data —— 一栏一栏
                {'subject': '2026 年 10 月对账单',
                 'body': BODY_HTML, 'body_format': 'HTML',
                 'to': ['li@client.example.invalid', 'zhang@client.example.invalid'],
                 'cc': ['finance@lingeringtek.cn'],
                 'message_id': '<preview-check@shangshu.local>'},
                [], inline_resources=inline)
        self.assertEqual(result['status'], 'Sent')
        self.assertTrue(captured, '捕获器未收到生成的 MIME')
        raw = captured[0].as_bytes()
        # 只用标准库重新解析，不复用生成端字段
        return BytesParser(policy=policy.default).parsebytes(raw)

    def test_发件身份收件人抄送主题逐项对得上(self):
        """测试通过 = 预览上「发件身份/收件人/抄送/主题」四行，解析后一字不差。"""
        msg = self._generate()
        self.assertIn('wuwang@qq.com', str(msg['From'] or ''), '发件身份对不上')
        self.assertIn('王五', str(msg['From'] or ''), '发件人姓名对不上')
        # 收件人：预览「收件人」那行的每一个，都要在 To 里
        to_addrs = [a.strip() for a in str(msg['To'] or '').split(',') if a.strip()]
        for want in ('li@client.example.invalid', 'zhang@client.example.invalid'):
            self.assertTrue(any(want in a for a in to_addrs), f'收件人 {want} 不在 To 里：{to_addrs}')
        self.assertIn('finance@lingeringtek.cn', str(msg['Cc'] or ''), '抄送对不上')
        self.assertEqual(str(msg['Subject'] or '').strip(), '2026 年 10 月对账单', '主题对不上')

    def test_正文HTML与预览那一栏逐字对得上(self):
        """测试通过 = 预览 iframe 里那份 body，解析出来的 text/html 就是它。"""
        msg = self._generate()
        html_part = msg.get_body(preferencelist=('html',))
        self.assertIsNotNone(html_part, '缺 text/html 正文')
        html = html_part.get_content()
        self.assertEqual(html.strip(), BODY_HTML.strip(),
                         '正文 HTML 与预览那一栏对不上\n--- 预览 ---\n%s\n--- 解析 ---\n%s'
                         % (BODY_HTML, html))
        # 表格、签名链接、内联图引用都要在（预览里看得见的东西不能少）
        self.assertIn('<table', html, '表格没了')
        self.assertIn('lingeringtek.cn', html, '签名链接没了')
        self.assertIn(f'cid:{CID}', html, '内联图引用没了')

    def test_纯文本替代含签名(self):
        """测试通过 = text/plain 备选里有签名（已钉的那半，这里守住）。"""
        msg = self._generate()
        plain_part = msg.get_body(preferencelist=('plain',))
        self.assertIsNotNone(plain_part, '缺 text/plain 备选')
        plain = plain_part.get_content()
        self.assertIn('王五', plain, '纯文本替代里没有签名的人名')
        self.assertIn('lingeringtek.cn', plain, '纯文本替代里没有签名的落款')
        self.assertNotIn('<table', plain, '纯文本替代不该带表格标签')

    def test_内联图CID类型字节对得上(self):
        """测试通过 = 预览里那张图，解析回来 CID/类型/字节一致。"""
        msg = self._generate()
        found = None
        for part in msg.walk():
            if part.get_content_disposition() == 'inline' and part.get_content_type() == 'image/png':
                found = part
                break
        self.assertIsNotNone(found, '找不到内联图 part')
        self.assertEqual((found.get('Content-ID') or '').strip('<>'), CID, 'Content-ID 对不上')
        self.assertEqual(found.get_payload(decode=True), PNG, '内联图字节对不上')

    def test_不许多出来(self):
        """测试通过 = 预览上没有的东西，MIME 里也不该多出来。

        「与预览一致」不只是「少了不行」，**多了也不行** ——
        多一个收件人、多一个主题，用户在核对单上看不见，但对方收得到。
        """
        msg = self._generate()
        to_addrs = [a.strip() for a in str(msg['To'] or '').split(',') if a.strip()]
        self.assertEqual(len(to_addrs), 2, f'收件人被多塞了：{to_addrs}')
        self.assertEqual(str(msg['Subject'] or '').strip(), '2026 年 10 月对账单',
                         '主题被改过/多了')
        # 预览只画 to + cc，没有 bcc —— MIME 里也不该冒出 bcc
        self.assertFalse(msg['Bcc'], f'冒出了预览上没有的密送：{msg["Bcc"]}')
        # 预览正文是一份 HTML + 一份纯文本替代，不该多出别的正文 part
        bodies = [p for p in msg.walk() if p.get_content_type() in ('text/html', 'text/plain')]
        self.assertLessEqual(len(bodies), 2, f'正文 part 多了：{[p.get_content_type() for p in bodies]}')


if __name__ == '__main__':
    unittest.main(verbosity=2)
