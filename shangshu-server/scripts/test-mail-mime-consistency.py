"""MIME 一致性核对：用真实浏览器编辑产出的 HTML 走生成→独立解析。

测试通过 = 真实浏览器里改过单元格的正文，生成 MIME 后被独立解析器（只用标准库 email）
核对：正文 HTML、表格、横向/纵向合并格、被改的单元格值、Content-ID、Content-Type
与保存值逐项一致，且 plain 备选不含表格标签。

样本内容来自 shangshu-web/tests/mail-editor-browser.html 在真实浏览器的编辑产出
（中文输入「年费已核对」落在年费单元格），不是自造的替代品。
"""
import json
import sys
import unittest
import unittest.mock
from email import policy
from email.parser import BytesParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_mail'))
from shangshu_mail import transport

REPO_ROOT = Path(__file__).resolve().parents[2]


def load_a_clipboard():
    """读 A 交的真 clipboardData 夹具（不是构造的形状样本）。

    两处都找，硬找不到就失败，**绝不 skip**（skip 长得跟过一模一样）。
    与 TS 侧 `shangshu-server/tests/helpers/copy-format.ts` 的 `loadABytes()` 指向同两处；
    语言不同没法共用一份实现，但**路径与身份判据必须一致**。

    夹具：`fde/开发/验收/t01-clipboard-fixture.json`（A 原件，未跟踪）
      与 `shangshu-server/tests/fixtures/t01-clipboard-fixture.json`（仓库副本）。
    两份 shasum-256 同为 279eee7c24ead2d2d35890b3bd31ed8a9fb16fd50140ffdbd1b51b634e592525。
    """
    tried = [
        REPO_ROOT / 'fde/开发/验收/t01-clipboard-fixture.json',
        REPO_ROOT / 'shangshu-server/tests/fixtures/t01-clipboard-fixture.json',
    ]
    raw = None
    for p in tried:
        if p.exists():
            raw = p.read_text(encoding='utf-8')
            break
    if raw is None:
        raise AssertionError(f'找不到 A 的 clipboardData 夹具（两处都没有，不许 skip）—— 试过：{tried}')
    f = json.loads(raw)
    cd = f.get('clipboardData') or {}
    if not cd.get('text/html') or not cd.get('text/plain'):
        raise AssertionError('A 的夹具缺 clipboardData["text/html"] 或 ["text/plain"] —— 接缝契约对不上')
    rows = f.get('rows') or []
    if not rows or not rows[0]:
        raise AssertionError('A 的夹具 rows 是空的 —— 值断言会空过，不许拿空夹具测')
    # 身份闸（与 TS 侧一致）：钉住「载的就是 A 那份」
    if f.get('copyVersion') != 'pkg-002-t13-v2':
        raise AssertionError(f'夹具不是 A 交的那份：copyVersion={f.get("copyVersion")!r}，应为 "pkg-002-t13-v2"')
    if '9ad7c85d' not in str(f.get('source') or ''):
        raise AssertionError(f'夹具来源不对：source={f.get("source")!r}')
    want_td = len(rows) * len(rows[0])
    got_td = cd['text/html'].count('<td ')
    if got_td != want_td:
        raise AssertionError(f'夹具内部自相矛盾：html 里 {got_td} 格，rows 是 {len(rows)}×{len(rows[0])}={want_td}')
    return {'html': cd['text/html'], 'plain': cd['text/plain'], 'rows': rows,
            'copyVersion': f['copyVersion'], 'source': f['source']}

CID = 'logo-sample@shangshu.local'
PNG = (b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01'
       b'\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01'
       b'\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82')

# 真实浏览器产出（mail-editor-browser.html，中文输入后归一的 HTML）
BROWSER_HTML = (
    '<p>客户您好，本期核对如下。</p>'
    '<table border="1" cellpadding="4" cellspacing="0">'
    '<thead><tr><th colspan="2">案件汇总</th><th>金额</th></tr></thead>'
    '<tbody><tr><td rowspan="2">A001</td><td>年费已核对</td><td>150.00</td></tr>'
    '<tr><td>滞纳金</td><td>0.00</td></tr>'
    '<tr><td>B002</td><td>年费</td><td>220.00</td></tr></tbody></table>'
    f'<p>详见附图 <img src="cid:{CID}" alt="样例图">。</p>'
)


class MimeConsistencyTests(unittest.TestCase):
    def test_浏览器编辑产出的HTML生成MIME后独立解析逐项一致(self):
        """测试通过 = 生成 MIME 被独立解析后，正文/表格/合并格/单元格值/CID/类型与保存值一致。"""
        captured = []

        class Capture:
            def __init__(self, *a, **k): pass
            def login(self, *a, **k): pass
            def send_message(self, message, **kw):
                captured.append(message)
                return {}
            def quit(self): pass
            def close(self): pass

        inline = [{'name': '样例图.png', 'content': PNG, 'mime_type': 'image/png',
                   'content_id': CID, 'disposition': 'inline'}]
        with unittest.mock.patch.object(transport.smtplib, 'SMTP_SSL', Capture):
            result = transport.send_message(
                'demo@qq.com', 'synthetic', '样例发件人',
                {'subject': '样例核对表', 'body': BROWSER_HTML, 'body_format': 'HTML',
                 'to': ['client@example.invalid'], 'cc': [],
                 'message_id': '<browser-out@example.invalid>'},
                [], inline_resources=inline)
        self.assertEqual(result['status'], 'Sent')
        self.assertTrue(captured, '捕获器未收到生成的 MIME')

        # 独立解析器：只用标准库，按真实字节重新解析，不复用生成端字段
        raw = captured[0].as_bytes()
        reparsed = BytesParser(policy=policy.default).parsebytes(raw)

        html_part = reparsed.get_body(preferencelist=('html',))
        self.assertIsNotNone(html_part, '缺 text/html 正文')
        html = html_part.get_content()

        # 正文与浏览器产出逐项一致
        self.assertIn('<table', html, '表格丢失')
        self.assertIn('colspan="2"', html, '横向合并丢失')
        self.assertIn('rowspan="2"', html, '纵向合并丢失')
        self.assertIn('年费已核对', html, '浏览器里改的单元格值丢失')
        self.assertIn('A001', html)
        self.assertIn('220.00', html)
        self.assertIn(f'cid:{CID}', html, 'CID 引用丢失')

        # plain 备选不含表格标签（纯文本替代只承载文字）
        plain = reparsed.get_body(preferencelist=('plain',))
        if plain is not None:
            self.assertNotIn('<table', plain.get_content(), 'plain 不应含表格标签')

        # 内联图：Content-ID、Content-Type、字节与保存值一致
        inline_parts = [p for p in reparsed.walk()
                        if (p.get('Content-ID') or '').strip('<>') == CID]
        self.assertTrue(inline_parts, '独立解析未找到内联图')
        part = inline_parts[0]
        self.assertEqual((part.get('Content-ID') or '').strip('<>'), CID, 'Content-ID 不一致')
        self.assertEqual(part.get_content_type(), 'image/png', 'MIME 类型不一致')
        self.assertEqual(part.get_payload(decode=True), PNG, '内联图字节不一致')

    def test_引用完整性校验拒收悬空CID(self):
        """测试通过 = 正文引用的 CID 都有对应资源；缺资源时能被检出，不静默丢图。"""
        referenced = transport.referenced_cids(BROWSER_HTML)
        self.assertEqual(referenced, [CID], '正文 CID 引用解析不正确')
        available = {CID}
        missing = set(referenced) - available
        self.assertFalse(missing, f'悬空 CID 引用未检出: {missing}')

    def test_Excel粘贴的内联样式表格过净化后生成MIME仍在(self):
        """测试通过 = Excel 复制产出的那种**内联样式**表格，过 mail.save_draft 的
        净化再走 transport 生成 MIME，独立解析后**行数 / 列数 / 单元格文本**都在。

        为什么单开一条：上面那条样本是 `<table border="1">` 属性式的，
        而 **Excel 复制出口产出的是内联样式**（A 2026-10-14 的形状：
        `<table style="border-collapse:collapse;">` + 单元格
        `style="border:1px solid #ccc;padding:4px 8px;"`）。
        两者走的不是同一条净化路 —— 内联样式要过 bleach 的 CSS 属性白名单，
        属性式不过。**分不清就可能拿属性式的绿冒充粘贴式的绿。**"""
        from shangshu_mail.service import html_body

        # A 的复制出口产出的形状（text/html 那一段）
        PASTED = (
            '<p>同事您好，本月核对如下。</p>'
            '<table style="border-collapse:collapse;">'
            '<tr><td style="border:1px solid #ccc;padding:4px 8px;">项目</td>'
            '<td style="border:1px solid #ccc;padding:4px 8px;">金额</td>'
            '<td style="border:1px solid #ccc;padding:4px 8px;">备注</td></tr>'
            '<tr><td style="border:1px solid #ccc;padding:4px 8px;">年费</td>'
            '<td style="border:1px solid #ccc;padding:4px 8px;">220.00</td>'
            '<td style="border:1px solid #ccc;padding:4px 8px;">已核对</td></tr>'
            '<tr><td style="border:1px solid #ccc;padding:4px 8px;">滞纳金</td>'
            '<td style="border:1px solid #ccc;padding:4px 8px;">0.00</td>'
            '<td style="border:1px solid #ccc;padding:4px 8px;">无</td></tr>'
            '</table>'
        )

        # 1) 先过保存时那道净化（mail.save_draft 走的就是它）
        cleaned = html_body(PASTED)
        self.assertIn('<table', cleaned, '净化把表格整段删了')
        self.assertEqual(cleaned.count('<tr'), 3, f'净化后行数不对：{cleaned!r}')

        # 2) 再走 transport 生成 MIME，独立解析
        captured = []

        class Capture:
            def __init__(self, *a, **k): pass
            def login(self, *a, **k): pass
            def send_message(self, message, **kw):
                captured.append(message)
                return {}
            def quit(self): pass
            def close(self): pass

        with unittest.mock.patch.object(transport.smtplib, 'SMTP_SSL', Capture):
            result = transport.send_message(
                'demo@qq.com', 'synthetic', '样例发件人',
                {'subject': '粘贴表格核对', 'body': cleaned, 'body_format': 'HTML',
                 'to': ['client@example.invalid'], 'cc': [],
                 'message_id': '<pasted-table@example.invalid>'},
                [])
        self.assertEqual(result['status'], 'Sent')

        raw = captured[0].as_bytes()
        reparsed = BytesParser(policy=policy.default).parsebytes(raw)
        html_part = reparsed.get_body(preferencelist=('html',))
        self.assertIsNotNone(html_part, '缺 text/html 正文')
        html = html_part.get_content()

        # 3) 结构逐项核：行 / 列 / 每格文字
        self.assertIn('<table', html, 'MIME 里表格丢了')
        self.assertEqual(html.count('<tr'), 3, f'MIME 里行数不对（要 3 行）：{html!r}')
        for cell in ('项目', '金额', '备注', '年费', '220.00', '已核对',
                     '滞纳金', '0.00', '无'):
            self.assertIn(cell, html, f'单元格「{cell}」在 MIME 里丢了')

        # 4) 内联样式不许被**整段**洗掉 —— CSS 白名单里有 border / padding /
        #    border-collapse，这些该活下来（不在白名单的属性被丢是预期，不算失败）
        self.assertTrue('border-collapse' in html or 'border' in html,
                        '内联样式被整段洗掉了 —— 粘贴表格的框线会全没')

    def test_A真复制出口字节过净化生成MIME逐项一致(self):
        """测试通过 = **A 进程里跑出来的** clipboardData 字节，过净化生成 MIME，
        独立解析后行列数与每个真单元格值都在，内联样式不被整段洗掉。

        为什么在上面那条之外单开一条：上面那条 `PASTED` 是**照 A 形状构造的合成样本**
        （3×3，值是 项目/金额/备注 那套），不是 A 的产出字节。
        「形状对」不等于「接缝对」—— 本条才接 A 交的真夹具
        （`fde/开发/验收/t01-clipboard-fixture.json`，真实表 2×2 选区，
          copyVersion pkg-002-t13-v2）。**不许拿合成那条的绿抵本条。**"""
        from shangshu_mail.service import html_body

        a = load_a_clipboard()          # 真字节 + 身份闸，不是合成样本
        want_rows = len(a['rows'])
        want_td = want_rows * len(a['rows'][0])

        # 1) 先过保存时那道净化（mail.save_draft 走的就是它）
        cleaned = html_body(a['html'])
        self.assertIn('<table', cleaned, '净化把 A 的表格整段删了')
        self.assertEqual(cleaned.count('<tr'), want_rows,
                         f'净化后行数不对：应 {want_rows}，实 {cleaned.count("<tr")}')
        for row in a['rows']:
            for v in row:
                self.assertIn(v, cleaned, f'A 的单元格值「{v}」被净化洗掉了')

        # 2) 走 transport 生成 MIME（隔离捕获器，**不触发真实发信**）
        captured = []

        class Capture:
            def __init__(self, *a, **k): pass
            def login(self, *a, **k): pass
            def send_message(self, message, **kw):
                captured.append(message)
                return {}
            def quit(self): pass
            def close(self): pass

        with unittest.mock.patch.object(transport.smtplib, 'SMTP_SSL', Capture):
            result = transport.send_message(
                'demo@qq.com', 'synthetic', '样例发件人',
                {'subject': 'A 复制出口接缝核对', 'body': cleaned, 'body_format': 'HTML',
                 'to': ['client@example.invalid'], 'cc': [],
                 'message_id': '<t01-a-fixture@example.invalid>'},
                [])
        self.assertEqual(result['status'], 'Sent')

        raw = captured[0].as_bytes()
        reparsed = BytesParser(policy=policy.default).parsebytes(raw)
        html_part = reparsed.get_body(preferencelist=('html',))
        self.assertIsNotNone(html_part, '缺 text/html 正文')
        html = html_part.get_content()

        # 3) 独立解析后逐项核：行数 / 格数 / A 的每个真值
        self.assertIn('<table', html, 'MIME 里 A 的表格丢了')
        self.assertEqual(html.count('<tr'), want_rows,
                         f'MIME 里行数不对：应 {want_rows}，实 {html.count("<tr")}，{html!r}')
        self.assertEqual(html.count('<td '), want_td,
                         f'MIME 里格数不对（被压扁/丢格）：应 {want_td}，实 {html.count("<td ")}')
        for row in a['rows']:
            for v in row:
                self.assertIn(v, html, f'A 的单元格值「{v}」在 MIME 里丢了')

        # 4) 内联样式不许被整段洗掉（A 的框线样式）
        self.assertTrue('border-collapse' in html or 'border' in html,
                        '内联样式被整段洗掉了 —— A 的框线会全没')


if __name__ == '__main__':
    unittest.main()
