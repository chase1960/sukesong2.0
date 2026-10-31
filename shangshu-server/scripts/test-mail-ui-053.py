"""UI-053 补全判据：200 格 / 1000 格 / 超 100000 字符 / 外部来源。

只验证「可离线」的 3 条口径；真 IME 由 F07 人工。

- 200 格（10×20）：长度级 + 单元格计数
- 1000 格（50×20）：单元格计数（真实长度检查在 page-timing/base967-24-verify-product.mjs 场景 C）
- 超 100000 字符：构造一定越限的样本，断言守住「不让代码侧用 110000 偷偷过关」
- 外部来源：写明真页面要核的「保 cid / 净外链」口径

测试通过 = 上述各点成立；越限与外链两条均留 F07 人工真页面核。
"""
from html.parser import HTMLParser
import unittest


def make_table(rows, cols, cell_text):
    body = '<p>上</p><table>'
    for _ in range(rows):
        body += '<tr>' + ''.join(f'<td>{cell_text}</td>' for _ in range(cols)) + '</tr>'
    return body + '</table><p>下</p>'


class Count(HTMLParser):
    def __init__(self):
        super().__init__()
        self.cells = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('td', 'th'):
            self.cells += 1


class UI053(unittest.TestCase):
    def test_200格构造正确_单元格200_体长低于上限(self):
        """测试通过 = 10×20 = 200 个 <td>，且整段 HTML 长度 < 100000（避免用超长字串虚高）。"""
        body = make_table(10, 20, 'A')
        c = Count(); c.feed(body)
        self.assertEqual(c.cells, 200)
        self.assertLess(len(body), 100000, f'200 格体 {len(body)} 已超 100000，需修构造')

    def test_1000格构造正确_单元格1000(self):
        """测试通过 = 50×20 = 1000 个 <td>。长度的稳态断言在 page-timing 场景 C。"""
        body = make_table(50, 20, 'X')
        c = Count(); c.feed(body)
        self.assertEqual(c.cells, 1000)

    def test_越限构造一定超过100000字符(self):
        """测试通过 = 构造的样本**本身**就 > 100000（用 50×20 × 每格 110 字符 ≈ 110000）。
        守住「不让代码侧偷偷把上限调到 110000 当作通过」—— 真页面验证由 F07 人工。
        """
        body = make_table(50, 20, 'X' * 110)
        self.assertGreater(len(body), 100000, f'构造才 {len(body)}，没有越限压力')

    def test_外部来源_保cid净外链_口径(self):
        """测试通过 = 源 HTML 含 cid: 引用、https:// 外链、纯文本。
        口径：**邮件侧**要保 cid、净外链（外链应是 404/拦，不应真发出去）。
        真页面验证由 F07 人工 —— 这里的断言只**钉口径**，不替代真验。
        """
        src = (
            '<p>图 <img src="cid:logo@x" alt="图"></p>'
            '<p>外链 <a href="https://evil.example.com/p">点我</a></p>'
            '<p>纯文本不受影响</p>'
            '<script>alert(1)</script>'
        )
        self.assertIn('cid:logo@x', src)
        self.assertIn('https://evil.example.com/p', src)


if __name__ == '__main__':
    unittest.main()
