"""保存路径净化器核对：service.html_body（bleach）与接收净化器（transport.sanitize_html）对齐。

测试通过 = 草稿保存时的 bleach 净化：
1. 保留表格结构、横向/纵向合并格（colspan/rowspan）、受管 cid: 图引用；
2. 剥掉脚本、事件属性、外链图片，不放开任意外部图片请求；
3. 与接收净化器 transport.sanitize_html 对同一样本的结果一致（两套净化器不打架，
   不会一个保留合并格另一个又剥掉，否则保存就把表格改没了）；
4. 签名里的**文字、格式（内联样式含分隔线）、链接**存得住，危险协议仍被拒；
5. 签名守卫标记 `data-mail-signature` **不进正文**，且**净化器一行没动**
   （用户 2026-10-15 选 (a)：标记挪出正文 HTML 放草稿元数据，净化器不放开白名单）。

说明：service.py 依赖 frappe，此处只取其 html_body 净化函数的行为做核对。
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'frappe_apps/shangshu_mail'))

from shangshu_mail import transport


def service_html_body(value):
    """抽出 service.html_body 的净化语义（与 service.py 保持一致，用于核对）。

    service.py 依赖 frappe 不能直接 import，此处镜像其净化函数体；
    任何对 service.html_body 的改动都要同步这里，否则本核对会失真。

    2026-10-14 夜：**这里曾经漂了** —— 真身后来加了 `font` 标签、`border-top`/
    `border-bottom`/`border-left`/`border-right`/`border-color`/`border-style`/
    `border-width`/`margin-left`/`margin-right`/`min-width`/`text-indent`/
    `text-transform`/`white-space` 和 `tr`/`bgcolor` 等属性，镜像没跟，
    于是「签名分隔线」这类判据会打在过期镜像上得出假红。已按 service.py 逐项对齐。
    """
    import bleach
    from bleach.css_sanitizer import CSSSanitizer

    def _drop_script_content(value):
        # bleach strip=True 只剥标签、会漏内容；先连内容删掉，与接收净化器对齐。
        return re.sub(
            r'<\s*(script|style|iframe|object|embed|form|base|link|meta|title)\b[^>]*>.*?<\s*/\s*\1\s*>',
            '', value or '', flags=re.I | re.S)

    def _img_attrs(tag, name, value):
        if name in ('alt', 'width', 'height'):
            return True
        if name == 'src':
            return bool(re.match(r'^cid:[A-Za-z0-9._@+-]{1,200}$', (value or '').strip()))
        return False

    _CSS_DANGER = re.compile(r'(?:expression|javascript:|url\s*\(|@import|behavior\s*:)', re.I)

    def _attr_filter(allow):
        # 与 service.py:280 的 _attr_filter 同一口径：先认白名单，再挡 style 的危险值。
        def decide(tag, name, value):
            if name == 'style' and _CSS_DANGER.search(str(value or '')):
                return False
            for key in (tag, '*'):
                rule = allow.get(key)
                if callable(rule):
                    if rule(tag, name, value):
                        return True
                elif isinstance(rule, (list, set, tuple)) and name in rule:
                    return True
                elif rule is True:
                    return True
            return False
        return decide

    return bleach.clean(_drop_script_content(value),
        tags={'a','b','blockquote','br','div','em','font','li','ol','p','span','strong',
              'table','tbody','td','tfoot','th','thead','tr','u','ul','img'},
        attributes=_attr_filter({'*':['style'],'a':['href','title'],
                    'font':['color','face','size'],
                    'table':['border','cellpadding','cellspacing','width','role','align','valign','bgcolor'],
                    'tr':['align','valign','bgcolor'],
                    'td':['colspan','rowspan','align','valign','width','nowrap','height','bgcolor'],
                    'th':['colspan','rowspan','align','valign','width','nowrap','height','bgcolor'],
                    'img':_img_attrs}),
        protocols={'http','https','mailto','cid'},strip=True,
        css_sanitizer=CSSSanitizer(allowed_css_properties=[
            'background','background-color','border','border-collapse','border-color',
            'border-style','border-width','border-top','border-bottom','border-left','border-right',
            'color','font-family','font-size','font-style','font-weight','height','line-height',
            'margin','margin-top','margin-bottom','margin-left','margin-right',
            'max-width','min-width','padding','padding-bottom','padding-left','padding-right','padding-top',
            'text-align','text-decoration','text-indent','text-transform','vertical-align','white-space','width']))


CID = 'logo-sample@shangshu.local'
SAMPLE = (
    '<p>客户您好，本期核对如下。</p>'
    '<table border="1" cellpadding="4" cellspacing="0">'
    '<thead><tr><th colspan="2">案件汇总</th><th>金额</th></tr></thead>'
    '<tbody><tr><td rowspan="2">A001</td><td>年费已核对</td><td>150.00</td></tr>'
    '<tr><td>滞纳金</td><td>0.00</td></tr>'
    '<tr><td>B002</td><td>年费</td><td>220.00</td></tr></tbody></table>'
    f'<p>详见附图 <img src="cid:{CID}" alt="样例图">。</p>'
)
DANGEROUS = (
    '<p onclick="steal()">核对</p>'
    f'<table><tr><td colspan="2">保留合并</td></tr>'
    f'<tr><td>A001</td><td><img src="cid:{CID}"></td></tr></table>'
    '<script>steal()</script>'
    '<img src="https://tracker.invalid/pixel">'
)


class SaveSanitizeTests(unittest.TestCase):
    def test_保存净化保留表格合并格与受管CID(self):
        """测试通过 = 保存时 bleach 不丢表格、合并格、cid: 图、被改单元格值。"""
        out = service_html_body(SAMPLE)
        self.assertIn('<table', out, '保存净化剥掉了表格')
        self.assertIn('colspan="2"', out, '保存净化剥掉了横向合并')
        self.assertIn('rowspan="2"', out, '保存净化剥掉了纵向合并')
        self.assertIn('年费已核对', out, '保存净化丢掉了单元格值')
        self.assertIn(f'cid:{CID}', out, '保存净化剥掉了受管 CID 引用')
        self.assertIn('A001', out)
        self.assertIn('220.00', out)

    def test_保存净化剥危险内容但不误伤合并格(self):
        """测试通过 = script/事件/外链图片被剥，合并格与 cid: 图保留。"""
        out = service_html_body(DANGEROUS)
        self.assertNotIn('steal', out, 'script 未被剥')
        self.assertNotIn('onclick', out, '事件属性未被剥')
        self.assertNotIn('tracker.invalid', out, '外链图片未被拒')
        self.assertIn('colspan="2"', out, '剥危险内容时误伤了合并格')
        self.assertIn(f'cid:{CID}', out, '剥危险内容时误伤了受管 CID')

    def test_两套净化器对合并不打架(self):
        """测试通过 = 接收净化与保存净化对合并格/CID 的处理一致，不会一个留一个剥。"""
        a = transport.sanitize_html(SAMPLE)
        b = service_html_body(SAMPLE)
        for token in ('<table', 'colspan="2"', 'rowspan="2"', f'cid:{CID}', '年费已核对'):
            self.assertIn(token, a, f'接收净化丢了 {token}')
            self.assertIn(token, b, f'保存净化丢了 {token}')

    def test_签名的文字格式链接过净化后仍在(self):
        """测试通过 = 主包「签名支持**文字、格式、链接**」在**存信那一侧**也成立：
        签名里写的文字、内联样式（含常见的分隔线 border-top）、`<a href>`
        经保存净化后都原样在；而且危险协议（javascript:）**照旧被拒** ——
        放行链接不等于放开脚本。
        """
        sig = ('<div data-mail-signature="1">'
               '<p class="mail-signature" style="color:#666;border-top:1px solid #ddd;padding-top:8px">'
               '—— 张三<br><a href="https://lingeringtek.cn">银聆科技</a></p></div>')
        out = service_html_body(sig)
        self.assertIn('张三', out, f'保存净化丢了签名文字：{out[:220]}')
        self.assertIn('href="https://lingeringtek.cn"', out,
                      f'保存净化剥掉了签名里的链接地址：{out[:220]}')
        self.assertIn('银聆科技', out, f'保存净化丢掉了链接文字：{out[:220]}')
        self.assertIn('border-top', out,
                      f'保存净化剥掉了签名分隔线（格式）：{out[:220]}')

        evil = '<a href="javascript:steal()">点我</a>'
        out2 = service_html_body(evil)
        self.assertNotIn('javascript:', out2,
                         f'javascript: 协议没被拒，放行链接等于放开脚本：{out2[:220]}')

    def test_签名守卫标记不进正文且净化器一行没动(self):
        """测试通过 = 守卫标记**不进正文**，且**净化器一行没动**。

        口径变更（用户 2026-10-15 原话「**签名守卫 a**」）：
        旧口径验「`data-mail-signature` 在正文里存得住」—— **红**，因为 bleach 剥它。
        三条出路里用户选 (a)：**把标记挪出正文 HTML**（放草稿元数据），
        **净化器一行不动**。不选 (c)：放开 bleach 属性白名单的代价是**全局的**
        （所有信的正文都多放一类属性）。

        所以这条改成**两件**：
        ① 净化器**仍然剥掉** `data-mail-signature` —— 证明**白名单没被改宽**，
           (c) 那条路没走。这是**回归闸**：将来谁要是把白名单放开，这条当场红。
        ② 签名**内容**（落款文字）仍存得住 —— 挪走的是守卫，不是签名本身。
           「旧草稿不随默认设置漂移」靠的就是这份正文里的快照。

        真正的「守卫在正文外存得住 + 重开不重复插入」在前端判据
        `mail-signature.test.ts` 的 SIG-P（守卫落在草稿元数据上）。
        """
        sig = '<div data-mail-signature="1"><p class="mail-signature">—— 张三</p></div>'
        out = service_html_body(sig)
        # ① 白名单没改宽 —— data-* 仍被剥
        self.assertNotIn('data-mail-signature', out,
                         f'净化器被改宽了（data-* 放行）—— (c) 那条路不许走：{out[:220]}')
        # ② 签名内容还在
        self.assertIn('—— 张三', out,
                      f'签名内容被剥了（挪走的是守卫，不是签名本身）：{out[:220]}')


if __name__ == '__main__':
    unittest.main()
