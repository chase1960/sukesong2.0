#!/usr/bin/env python3
"""生成 SME 验收用铁路电子客票 PDF（text-rule 可解析，无 LLM 依赖）。"""
from pathlib import Path

import fitz  # pymupdf

OUT = Path(__file__).resolve().parent / 'fixtures' / 'sme-acceptance-invoice.pdf'


def line_cn(page: fitz.Page, y: float, label: str, value: str = '', *, value_font: str = 'helv') -> None:
    """中文标签 + 可选值（同基线），避免 CJK 字体拆散 ASCII 数字。"""
    x = 48
    page.insert_text((x, y), label, fontsize=11, fontname='china-s')
    if value:
        # 标签宽约 5–6 字 × 11pt，留固定偏移足够验收 PDF
        page.insert_text((x + len(label) * 11 + 8, y), value, fontsize=11, fontname=value_font)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    y = 72
    for text in (
        '铁路电子客票',
        '电子发票（铁路电子客票）',
    ):
        page.insert_text((48, y), text, fontsize=11, fontname='china-s')
        y += 22
    y += 8
    line_cn(page, y, '发票号码：', '12345678901234567890')
    y += 22
    page.insert_text((48, y), '开票日期：2026年08月24日', fontsize=11, fontname='china-s')
    y += 22
    line_cn(page, y, '票价：', '¥106.00')
    y += 28
    page.insert_text((48, y), '购买方', fontsize=11, fontname='china-s')
    y += 22
    page.insert_text((48, y), '南京建工集团有限公司', fontsize=11, fontname='china-s')
    y += 22
    line_cn(page, y, '统一社会信用代码：', '91320100MA0000001X')
    y += 28
    page.insert_text((48, y), '销售方', fontsize=11, fontname='china-s')
    y += 22
    page.insert_text((48, y), '中国铁路南京局集团有限公司', fontsize=11, fontname='china-s')
    y += 28
    page.insert_text(
        (48, y),
        '备注：尚书 SME 验收专用测试票，请勿用于真实入账。',
        fontsize=10,
        fontname='china-s',
    )
    doc.save(str(OUT))
    doc.close()
    print('wrote', OUT, OUT.stat().st_size, 'bytes')


if __name__ == '__main__':
    main()
