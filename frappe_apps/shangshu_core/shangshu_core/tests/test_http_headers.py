"""原件名的 HTTP 头怎么写才不出事（PKG-024-T01，2026-10-22）。

**测试通过 = 什么成立**（一句话）：
「给一个**中文**原件名，生成的 `Content-Disposition` **全是 ASCII 字节**
  （HTTP 头只吃 ASCII），
  并且里面**找得到**按 UTF-8 还原后的原名（RFC 5987 的 `filename*=`），
  同时还有一个**纯 ASCII 的兜底名**给不认 RFC 5987 的老客户端。」

为什么要有这条：中文名直接进 `Content-Disposition` ⇒ 线上是 UTF-8 字节 ⇒
Node（`fetch`/undici 与 `node:http` 都一样）的 HTTP 解析器判**整条响应非法**
（`Invalid header value char`）⇒ **字节根本读不回来** ——
实测 30 个真实中文文件名里有 8 个读不回来（助手看图、浏览器下载都中招）。
"""
import unittest

from shangshu_core.http_headers import ascii_fallback_name, content_disposition


class TestContentDisposition(unittest.TestCase):
    def test_中文名_头部全是ASCII(self):
        header = content_disposition('合同.pdf')
        self.assertTrue(header.isascii(), 'HTTP 头只吃 ASCII：中文名不能原样进去')
        self.assertIn("filename*=UTF-8''", header, '要走 RFC 5987（客户端据此还原中文名）')

    def test_中文名_能还原出原名(self):
        header = content_disposition('合同.pdf')
        encoded = header.split("filename*=UTF-8''")[1].split(';')[0]
        from urllib.parse import unquote
        self.assertEqual(unquote(encoded), '合同.pdf', '客户端要能还原出原件名')

    def test_兜底名是纯ASCII且保住扩展名(self):
        header = content_disposition('合同.pdf')
        fallback = header.split('filename="')[1].split('"')[0]
        self.assertTrue(fallback.isascii())
        self.assertTrue(fallback.endswith('.pdf'), '兜底名要保住扩展名')
        self.assertEqual(ascii_fallback_name('合同.pdf'), 'file.pdf')

    def test_纯ASCII名_兜底名就是它自己(self):
        self.assertEqual(ascii_fallback_name('photo.png'), 'photo.png')
        self.assertIn('filename="photo.png"', content_disposition('photo.png'))

    def test_危险字符不进头(self):
        # 引号/分号/换行会把 header 拆坏 ⇒ 兜底名里必须清掉。
        header = content_disposition('a";b\r\nX-Injected: 1.pdf')
        self.assertNotIn('\r', header)
        self.assertNotIn('\n', header)
        self.assertEqual(header.count('"'), 2, '只留兜底名那一对引号')

    def test_空名有兜底(self):
        self.assertEqual(ascii_fallback_name(''), 'file')
        self.assertIn('filename="file"', content_disposition(''))


if __name__ == '__main__':
    unittest.main()
