#!/usr/bin/env python3
"""compile_docs / extract_fields / validate_fields 单元测试。"""
import subprocess
import json
import base64
import io
import os
import sys

from docx import Document

SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'scripts')
SCRIPTS_DIR = os.path.abspath(SCRIPTS_DIR)


def _run_script(script_name: str, input_data: dict) -> subprocess.CompletedProcess:
    """Run a Python script from scripts/ with JSON stdin, return CompletedProcess."""
    return subprocess.run(
        [sys.executable, os.path.join(SCRIPTS_DIR, script_name)],
        input=json.dumps(input_data),
        capture_output=True,
        text=True,
    )


def _make_template_b64(paragraphs=None, tables=None) -> str:
    """Create a simple .docx template and return its base64 encoding.

    tables: each element is either:
      - a list of strings → treated as a single row of cell values
      - a list of lists → treated as multiple rows of cell values
    """
    doc = Document()
    if paragraphs:
        for text in paragraphs:
            doc.add_paragraph(text)
    if tables:
        for rows_data in tables:
            # Normalize: if rows_data is a list of strings, treat as single row
            if isinstance(rows_data[0], str):
                rows_data = [rows_data]
            table = doc.add_table(rows=len(rows_data), cols=len(rows_data[0]))
            for ri, row in enumerate(rows_data):
                for ci, cell in enumerate(row):
                    table.cell(ri, ci).text = cell
    buf = io.BytesIO()
    doc.save(buf)
    return base64.b64encode(buf.getvalue()).decode()


# ── compile_docs tests ─────────────────────────────────

def test_compile_replaces_placeholder():
    """compile_docs.py: should replace {placeholder} with field value."""
    template_b64 = _make_template_b64(paragraphs=['项目：{project_name}'])
    result = _run_script('compile_docs.py', {
        'doc_type': 'contract',
        'template_base64': template_b64,
        'fields': {'project_name': '银聆官网重构'},
    })
    assert result.returncode == 0, 'stderr: %s' % result.stderr
    output_bytes = base64.b64decode(result.stdout)
    out_doc = Document(io.BytesIO(output_bytes))
    text = '\n'.join(p.text for p in out_doc.paragraphs)
    assert '项目：银聆官网重构' in text, 'Got: %s' % text
    print('PASS: test_compile_replaces_placeholder')


def test_compile_preserves_format():
    """compile_docs.py: should keep surrounding text intact when replacing."""
    template_b64 = _make_template_b64(paragraphs=['甲方：{party_a_name}，乙方：{party_b_name}'])
    result = _run_script('compile_docs.py', {
        'doc_type': 'contract',
        'template_base64': template_b64,
        'fields': {'party_a_name': '银聆科技', 'party_b_name': '客户公司'},
    })
    assert result.returncode == 0, 'stderr: %s' % result.stderr
    output_bytes = base64.b64decode(result.stdout)
    out_doc = Document(io.BytesIO(output_bytes))
    text = '\n'.join(p.text for p in out_doc.paragraphs)
    assert '甲方：银聆科技' in text, 'Got: %s' % text
    assert '乙方：客户公司' in text, 'Got: %s' % text
    print('PASS: test_compile_preserves_format')


def test_compile_table_fill():
    """compile_docs.py: should fill table with pipe-delimited data."""
    template_b64 = _make_template_b64(
        paragraphs=[],
        tables=[[['序号', '内容', '金额'], ['{table_data}']]],
    )
    result = _run_script('compile_docs.py', {
        'doc_type': 'contract',
        'template_base64': template_b64,
        'fields': {'table_data': '1 | 设计 | 5000\n2 | 开发 | 15000'},
    })
    assert result.returncode == 0, 'stderr: %s' % result.stderr
    output_bytes = base64.b64decode(result.stdout)
    out_doc = Document(io.BytesIO(output_bytes))
    # The table should have been filled
    assert len(out_doc.tables) > 0, 'Expected at least one table'
    table = out_doc.tables[0]
    # Should have at least 3 rows (header + 2 data rows)
    assert len(table.rows) >= 3, 'Expected >= 3 rows, got %d' % len(table.rows)
    print('PASS: test_compile_table_fill')


def test_compile_no_fields():
    """compile_docs.py: should handle empty fields gracefully."""
    template_b64 = _make_template_b64(paragraphs=['Hello {name}'])
    result = _run_script('compile_docs.py', {
        'doc_type': 'contract',
        'template_base64': template_b64,
        'fields': {},
    })
    assert result.returncode == 0, 'stderr: %s' % result.stderr
    output_bytes = base64.b64decode(result.stdout)
    out_doc = Document(io.BytesIO(output_bytes))
    text = '\n'.join(p.text for p in out_doc.paragraphs)
    # Placeholder should remain since no field was provided
    assert '{name}' in text, 'Expected {name} to remain, got: %s' % text
    print('PASS: test_compile_no_fields')


# ── extract_fields tests ───────────────────────────────

def test_extract_fields():
    """extract_fields.py: should extract {placeholder} from paragraphs."""
    template_b64 = _make_template_b64(paragraphs=['甲方：{party_a_name}，总价：{total_amount}'])
    result = _run_script('extract_fields.py', {
        'template_base64': template_b64,
    })
    assert result.returncode == 0, 'stderr: %s' % result.stderr
    data = json.loads(result.stdout)
    assert 'party_a_name' in data['fields'], data
    assert 'total_amount' in data['fields'], data
    print('PASS: test_extract_fields')


def test_extract_fields_from_table():
    """extract_fields.py: should extract placeholders from table cells."""
    template_b64 = _make_template_b64(
        paragraphs=[],
        tables=[['名称', '金额'], ['{item_name}', '{item_amount}']],
    )
    result = _run_script('extract_fields.py', {
        'template_base64': template_b64,
    })
    assert result.returncode == 0, 'stderr: %s' % result.stderr
    data = json.loads(result.stdout)
    assert 'item_name' in data['fields'], data
    assert 'item_amount' in data['fields'], data
    print('PASS: test_extract_fields_from_table')


def test_extract_fields_dedup_and_sort():
    """extract_fields.py: should deduplicate and sort field names."""
    template_b64 = _make_template_b64(paragraphs=['{b} {a} {b} {c}'])
    result = _run_script('extract_fields.py', {
        'template_base64': template_b64,
    })
    assert result.returncode == 0, 'stderr: %s' % result.stderr
    data = json.loads(result.stdout)
    assert data['fields'] == ['a', 'b', 'c'], 'Expected sorted unique, got: %s' % data['fields']
    print('PASS: test_extract_fields_dedup_and_sort')


# ── validate_fields tests ──────────────────────────────

def test_validate_shared_fields_match():
    """validate_fields.py: should return empty results when shared fields match."""
    result = _run_script('validate_fields.py', {
        'fields_by_doc': {
            'requirements': {'{project_name}': '银聆官网'},
            'contract': {'{project_name}': '银聆官网'},
        },
    })
    assert result.returncode == 0, 'stderr: %s' % result.stderr
    data = json.loads(result.stdout)
    errors = [r for r in data['results'] if r['level'] == 'error']
    assert len(errors) == 0, 'Expected no errors, got: %s' % data['results']
    print('PASS: test_validate_shared_fields_match')


def test_validate_shared_fields_mismatch():
    """validate_fields.py: should flag mismatched shared fields."""
    result = _run_script('validate_fields.py', {
        'fields_by_doc': {
            'requirements': {'{project_name}': '项目A'},
            'contract': {'{project_name}': '项目B'},
        },
    })
    assert result.returncode == 0, 'stderr: %s' % result.stderr
    data = json.loads(result.stdout)
    errors = [r for r in data['results'] if r['level'] == 'error']
    assert len(errors) >= 1, 'Expected at least 1 error for mismatched fields, got: %s' % data['results']
    print('PASS: test_validate_shared_fields_mismatch')


def test_validate_semantic_flow_mismatch():
    """validate_fields.py: should flag semantic flow mismatch (schedule vs contract)."""
    result = _run_script('validate_fields.py', {
        'fields_by_doc': {
            'schedule': {'{quote_amount}': '50000'},
            'contract': {'{total_amount}': '60000'},
        },
    })
    assert result.returncode == 0, 'stderr: %s' % result.stderr
    data = json.loads(result.stdout)
    errors = [r for r in data['results'] if r['level'] == 'error']
    assert len(errors) >= 1, 'Expected error for amount mismatch, got: %s' % data['results']
    print('PASS: test_validate_semantic_flow_mismatch')


def test_validate_contract_amounts():
    """validate_fields.py: should flag contract amounts that don't sum up."""
    result = _run_script('validate_fields.py', {
        'fields_by_doc': {
            'contract': {
                '{total_amount}': '10000',
                '{deposit_amount}': '3000',
                '{mid_amount}': '4000',
                '{final_amount}': '2000',
            },
        },
    })
    assert result.returncode == 0, 'stderr: %s' % result.stderr
    data = json.loads(result.stdout)
    errors = [r for r in data['results'] if r['level'] == 'error']
    assert len(errors) >= 1, 'Expected error for sum mismatch (3000+4000+2000=9000 != 10000), got: %s' % data['results']
    print('PASS: test_validate_contract_amounts')


# ── Main ───────────────────────────────────────────────

if __name__ == '__main__':
    tests = [
        test_compile_replaces_placeholder,
        test_compile_preserves_format,
        test_compile_table_fill,
        test_compile_no_fields,
        test_extract_fields,
        test_extract_fields_from_table,
        test_extract_fields_dedup_and_sort,
        test_validate_shared_fields_match,
        test_validate_shared_fields_mismatch,
        test_validate_semantic_flow_mismatch,
        test_validate_contract_amounts,
    ]

    passed = 0
    failed = 0
    for test_fn in tests:
        try:
            test_fn()
            passed += 1
        except Exception as e:
            print('FAIL: %s - %s' % (test_fn.__name__, e))
            failed += 1

    print('\n%d passed, %d failed out of %d tests' % (passed, failed, len(tests)))
    if failed > 0:
        sys.exit(1)
    print('All tests passed!')
