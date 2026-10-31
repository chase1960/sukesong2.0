#!/usr/bin/env python3
"""ocr_server.py provider 分支测试（无需真 key / 网络）。"""
import asyncio
import io
import os
import sys

import httpx

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'scripts'))
sys.path.insert(0, SCRIPTS_DIR)

from ocr_server import app  # noqa: E402


async def _extract(provider: str, api_key: str = '', content: bytes = b'fake', filename: str = 'invoice.png', force_path: str = '', doc_type: str = 'invoice') -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        return await client.post('/extract', data={
            'provider': provider,
            'api_key': api_key,
            'base_url': 'http://127.0.0.1:9/v1',  # 测试不向外部模型发送数据
            'model': 'qwen-vl-ocr',
            'force_path': force_path,
            'doc_type': doc_type,
        }, files={'file': (filename, io.BytesIO(content), 'application/pdf' if filename.endswith('.pdf') else 'image/png')})


def test_qwen_ocr_empty_key_rejected():
    """qwen-ocr provider 未填 key → 400（与 dashscope 同语义）。"""
    resp = asyncio.run(_extract('qwen-ocr'))
    assert resp.status_code == 400, f'期望 400，实际 {resp.status_code}: {resp.text}'
    assert 'api_key' in resp.text, f'错误信息应提示 key：{resp.text}'
    print('PASS: test_qwen_ocr_empty_key_rejected')


def test_unknown_provider_rejected():
    """未知 provider → 400。"""
    resp = asyncio.run(_extract('some-mystery-provider'))
    assert resp.status_code == 400, f'期望 400，实际 {resp.status_code}: {resp.text}'
    print('PASS: test_unknown_provider_rejected')


def test_mock_ok():
    """mock 仍正常（回归，provider 分支扩展不破坏原行为）。"""
    resp = asyncio.run(_extract('mock'))
    assert resp.status_code == 200, f'期望 200，实际 {resp.status_code}: {resp.text}'
    print('PASS: test_mock_ok')


def test_mock_attribution():
    resp = asyncio.run(_extract('mock', force_path='text-rule'))
    assert resp.status_code == 200
    assert resp.json()['ocr_path'] == 'mock', '模拟数据不能伪装成真实抽取路径'
    print('PASS: test_mock_attribution')


def _railway_pdf():
    import fitz
    import re
    doc = fitz.open()
    page = doc.new_page()
    text = '测试样例，非真实发票，仅用于软件解析测试\n铁路电子客票\n发票号码：00000000000000000001\n票价：123.45\n开票日期：2026年08月26日\n测试样例有限公司\n统一社会信用代码\n中国铁路\n测试数据不代表实际交易，不可用于报销或记账'
    # 中文字体的 ASCII 字宽可能产生人为字间空格，数字使用 PDF 标准拉丁字体。
    for i, line in enumerate(text.split('\n')):
        x = 50
        for part in re.findall(r'[^\x00-\x7f]+|[\x00-\x7f]+', line):
            font = 'helv' if part.isascii() else 'china-s'
            page.insert_text((x, 50 + i * 20), part, fontname=font, fontsize=12)
            x += fitz.get_text_length(part, fontname=font, fontsize=12)
    content = doc.tobytes()
    doc.close()
    return content


def test_real_pdf_text_rule():
    resp = asyncio.run(_extract('vllm', content=_railway_pdf(), filename='fixture.pdf', force_path='text-rule'))
    assert resp.status_code == 200, resp.text
    result = resp.json()
    assert result['ocr_path'] == 'text-rule'
    assert result['fields']['total_amount'] == 123.45
    assert result['fields']['invoice_no'] == '00000000000000000001'
    print('PASS: test_real_pdf_text_rule')


def test_acceptance_pdf_railway_fields_complete():
    """仓库验收票的 PDF 文字层会在日期数字间插空格，不能漏日期或截断销售方。"""
    fixture = os.path.abspath(os.path.join(SCRIPTS_DIR, 'fixtures', 'sme-acceptance-invoice.pdf'))
    with open(fixture, 'rb') as f:
        content = f.read()
    resp = asyncio.run(_extract('vllm', content=content, filename='acceptance.pdf', force_path='text-rule'))
    assert resp.status_code == 200, resp.text
    fields = resp.json()['fields']
    assert fields['issued_at'] == '2026-08-24', fields
    assert fields['seller_name'] == '中国铁路南京局集团有限公司', fields
    assert fields['buyer_name'] == '南京建工集团有限公司', fields
    print('PASS: test_acceptance_pdf_railway_fields_complete')


def test_sales_invoice_not_swapped():
    from ocr_server import _review_rules
    fields = {'seller_name': '测试本企业有限公司', 'buyer_name': '其他客户有限公司', 'total_amount': 100, 'amount_ex_tax': 100, 'tax_amount': 0}
    warnings = {}
    out = _review_rules(dict(fields), warnings, '测试本企业有限公司')
    assert out == fields, '我方为销售方属于正常销项，不能自动交换购销方'
    assert '出项' in warnings['seller_buyer']
    print('PASS: test_sales_invoice_not_swapped')


def _document_pdf(pages):
    import fitz
    with fitz.open() as doc:
        for text in pages:
            page = doc.new_page()
            if text:
                page.insert_textbox((36, 36, 560, 810), text, fontsize=10)
        return doc.tobytes()


def test_document_text_reads_all_pages_without_invoice_or_cjk_heuristics():
    content = _document_pdf(['First page.', 'Second page.', 'Third page with order PO-123.'])
    resp = asyncio.run(_extract('mock', content=content, filename='short.pdf', doc_type='document_text'))
    assert resp.status_code == 200, resp.text
    result = resp.json()
    assert result['ocr_path'] == 'document-text', result
    assert result['fields'] == {} and result['validation_warnings'] == {}, result
    assert result['raw_text'].splitlines() == ['First page.', 'Second page.', 'Third page with order PO-123.'], result
    print('PASS: test_document_text_reads_all_pages_without_invoice_or_cjk_heuristics')


def test_document_text_rejects_scans_images_and_damaged_pdf():
    for content, filename in [(_document_pdf(['']), 'scan.pdf'), (b'fake image', 'image.png'), (b'damaged', 'broken.pdf')]:
        resp = asyncio.run(_extract('mock', content=content, filename=filename, doc_type='document_text'))
        assert resp.status_code in (400, 422), (filename, resp.text)
        assert 'raw_text' not in resp.json(), resp.text
    print('PASS: test_document_text_rejects_scans_images_and_damaged_pdf')


def test_document_text_rejects_oversized_text_instead_of_silently_truncating():
    content = _document_pdf(['Plain text ' * 250] * 10)
    resp = asyncio.run(_extract('mock', content=content, filename='long.pdf', doc_type='document_text'))
    assert resp.status_code == 413, resp.text
    assert '20000' in resp.text, resp.text
    print('PASS: test_document_text_rejects_oversized_text_instead_of_silently_truncating')


if __name__ == '__main__':
    tests = [test_qwen_ocr_empty_key_rejected, test_unknown_provider_rejected, test_mock_ok, test_mock_attribution, test_real_pdf_text_rule, test_acceptance_pdf_railway_fields_complete, test_sales_invoice_not_swapped, test_document_text_reads_all_pages_without_invoice_or_cjk_heuristics, test_document_text_rejects_scans_images_and_damaged_pdf, test_document_text_rejects_oversized_text_instead_of_silently_truncating]
    passed = failed = 0
    for fn in tests:
        try:
            fn()
            passed += 1
        except Exception as e:
            print(f'FAIL: {fn.__name__} - {e}')
            failed += 1
    print(f'\n{passed} passed, {failed} failed out of {len(tests)} tests')
    sys.exit(1 if failed else 0)
