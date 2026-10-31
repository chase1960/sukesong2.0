#!/usr/bin/env python3
"""文档编译器：从 stdin 接收模板和字段，stdout 返回填充后的 docx base64。

stdin:  JSON { doc_type: string, template_base64: string, fields: object }
stdout: base64 编码的 docx 字节

替换模式：
  1. 内联替换：值直接写入 run，保留原有格式
  2. 表格替换：占位符在表格单元格中，值为多行文本 → 按行填入多行
  3. 段落替换：占位符独占段落，值为多行文本 → 保留模板段落格式，逐行填入
"""
import copy
import json
import re
import sys
import base64
import io

from docx import Document
from docx.shared import Pt
from docx.oxml.ns import qn
from lxml import etree


# ── 表格行替换 ────────────────────────────────────────

def _ensure_table_borders(table):
    """确保表格有显式边框。"""
    tblPr = table._tbl.tblPr
    if tblPr.find(qn('w:tblBorders')) is not None:
        return
    tblBorders = etree.SubElement(tblPr, qn('w:tblBorders'))
    for border_name in ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']:
        border = etree.SubElement(tblBorders, qn('w:' + border_name))
        border.set(qn('w:val'), 'single')
        border.set(qn('w:sz'), '4')
        border.set(qn('w:space'), '0')
        border.set(qn('w:color'), 'auto')


def _fill_table_rows(table, value: str, template_row_idx: int):
    """用多行文本填充 Word 表格。"""
    data_rows = []
    for line in value.split('\n'):
        line = line.strip()
        if not line:
            continue
        if '|' in line:
            parts = line.split('|')
            if parts and not parts[0].strip():
                parts = parts[1:]
            if parts and not parts[-1].strip():
                parts = parts[:-1]
            cells = [c.strip() for c in parts]
            if cells:
                data_rows.append(cells)
        else:
            data_rows.append([line])

    if not data_rows:
        return

    template_row = table.rows[template_row_idx]
    num_cols = len(template_row.cells)

    # 获取模板行格式
    template_fmt = []
    for cell in template_row.cells:
        if cell.paragraphs and cell.paragraphs[0].runs:
            r = cell.paragraphs[0].runs[0]
            template_fmt.append({
                'name': r.font.name or 'Futura',
                'size': r.font.size or Pt(10.5),
                'bold': r.bold or False,
            })
        else:
            template_fmt.append({'name': 'Futura', 'size': Pt(10.5), 'bold': False})

    # 删除模板行之后的所有数据行
    tbl_el = table._tbl
    rows_el = tbl_el.findall(qn('w:tr'))
    for ri in range(len(rows_el) - 1, 0, -1):
        tbl_el.remove(rows_el[ri])

    # 为每个数据行创建新行
    for row_data in data_rows:
        new_tr = etree.SubElement(tbl_el, qn('w:tr'))
        trPr = template_row._tr.find(qn('w:trPr'))
        if trPr is not None:
            new_tr.append(copy.deepcopy(trPr))

        for ci in range(num_cols):
            tc = etree.SubElement(new_tr, qn('w:tc'))
            src_tc = template_row.cells[ci]._tc
            tcPr = src_tc.find(qn('w:tcPr'))
            if tcPr is not None:
                tc.append(copy.deepcopy(tcPr))
            new_p = etree.SubElement(tc, qn('w:p'))
            pPr = etree.SubElement(new_p, qn('w:pPr'))
            new_r = etree.SubElement(new_p, qn('w:r'))
            t = etree.SubElement(new_r, qn('w:t'))
            t.set(qn('xml:space'), 'preserve')
            cell_text = row_data[ci] if ci < len(row_data) else ''
            t.text = cell_text
            fmt = template_fmt[ci] if ci < len(template_fmt) else template_fmt[0]
            rPr = etree.SubElement(new_r, qn('w:rPr'))
            rFonts = etree.SubElement(rPr, qn('w:rFonts'))
            rFonts.set(qn('w:ascii'), fmt['name'])
            rFonts.set(qn('w:eastAsia'), 'Taipei Sans TC Beta')
            rFonts.set(qn('w:hAnsi'), fmt['name'])
            sz = etree.SubElement(rPr, qn('w:sz'))
            sz.set(qn('w:val'), str(int(fmt['size'].pt * 2)))
            szCs = etree.SubElement(rPr, qn('w:szCs'))
            szCs.set(qn('w:val'), str(int(fmt['size'].pt * 2)))

    _ensure_table_borders(table)


# ── 段落多行替换 ──────────────────────────────────────

def _fill_paragraph_lines(doc, para, value: str):
    """将多行文本填入段落。"""
    lines = [l for l in value.split('\n') if l.strip()]
    if not lines:
        return

    text_lines = []
    table_lines = []
    for line in lines:
        if '|' in line and line.strip().startswith('|'):
            table_lines.append(line)
        else:
            text_lines.append(line)

    # 清空当前段落，填入第一行文本
    for r in para.runs:
        r.text = ''
    if text_lines:
        if para.runs:
            para.runs[0].text = text_lines[0]
        else:
            para.add_run(text_lines[0])
        remaining_lines = text_lines[1:]
    else:
        if para.runs:
            para.runs[0].text = ''
        remaining_lines = []

    # 获取模板段落格式参考
    if para.runs:
        src_run = para.runs[0]
        fmt_name = src_run.font.name or 'Futura'
        fmt_size = src_run.font.size or Pt(10.5)
        fmt_bold = src_run.bold or False
    else:
        fmt_name, fmt_size, fmt_bold = 'Futura', Pt(10.5), False

    anchor = para._element
    body = doc.element.body
    parent = anchor.getparent()
    idx = list(parent).index(anchor)
    insert_offset = 1

    for line in remaining_lines:
        new_p = etree.SubElement(body, qn('w:p'))
        src_pPr = para._element.find(qn('w:pPr'))
        if src_pPr is not None:
            new_p.append(copy.deepcopy(src_pPr))
        new_r = etree.SubElement(new_p, qn('w:r'))
        t = etree.SubElement(new_r, qn('w:t'))
        t.set(qn('xml:space'), 'preserve')
        t.text = line
        rPr = etree.SubElement(new_r, qn('w:rPr'))
        rFonts = etree.SubElement(rPr, qn('w:rFonts'))
        rFonts.set(qn('w:ascii'), fmt_name)
        rFonts.set(qn('w:eastAsia'), 'Taipei Sans TC Beta')
        rFonts.set(qn('w:hAnsi'), fmt_name)
        sz = etree.SubElement(rPr, qn('w:sz'))
        sz.set(qn('w:val'), str(int(fmt_size.pt * 2)))
        szCs = etree.SubElement(rPr, qn('w:szCs'))
        szCs.set(qn('w:val'), str(int(fmt_size.pt * 2)))
        body.remove(new_p)
        parent.insert(idx + insert_offset, new_p)
        insert_offset += 1

    if table_lines:
        rows = []
        for line in table_lines:
            parts = line.split('|')
            if parts and not parts[0].strip():
                parts = parts[1:]
            if parts and not parts[-1].strip():
                parts = parts[:-1]
            cells = [c.strip() for c in parts]
            if cells:
                rows.append(cells)
        if rows:
            cols = max(len(r) for r in rows)
            tbl = doc.add_table(rows=len(rows), cols=cols)
            tbl.style = 'Normal Table'
            tblPr = tbl._tbl.tblPr
            tblBorders = etree.SubElement(tblPr, qn('w:tblBorders'))
            for border_name in ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']:
                border = etree.SubElement(tblBorders, qn('w:' + border_name))
                border.set(qn('w:val'), 'single')
                border.set(qn('w:sz'), '4')
                border.set(qn('w:space'), '0')
                border.set(qn('w:color'), 'auto')
            for ri, row_data in enumerate(rows):
                for ci, cell_text in enumerate(row_data):
                    if ci < cols:
                        cell = tbl.cell(ri, ci)
                        cell.text = cell_text
            body.remove(tbl._tbl)
            parent.insert(idx + insert_offset, tbl._tbl)


# ── 跨 run 内联替换 ───────────────────────────────────

def _inline_replace(para, key: str, value: str) -> bool:
    """在段落 run 中替换 key（所有出现），支持占位符被拆到多个 run 的情况。"""
    replaced = False
    while True:
        runs = para.runs
        full = ''.join(r.text for r in runs)
        pos = full.find(key)
        if pos == -1:
            return replaced
        end = pos + len(key)
        cum = 0
        start_i = end_i = None
        start_off = end_off = 0
        for i, r in enumerate(runs):
            rlen = len(r.text)
            if start_i is None and pos < cum + rlen:
                start_i, start_off = i, pos - cum
            if start_i is not None and end <= cum + rlen:
                end_i, end_off = i, end - cum
                break
            cum += rlen
        if end_i is None:
            return replaced
        if start_i == end_i:
            runs[start_i].text = runs[start_i].text[:start_off] + value + runs[start_i].text[end_off:]
        else:
            runs[start_i].text = runs[start_i].text[:start_off] + value
            for i in range(start_i + 1, end_i):
                runs[i].text = ''
            runs[end_i].text = runs[end_i].text[end_off:]
        replaced = True


# ── 模板填充主逻辑 ────────────────────────────────────

def fill_template(doc: Document, fields: dict):
    """打开 docx 模板，替换所有 {placeholder}（就地修改 Document 对象）。"""
    # 构建 {key} → value 映射
    brace_fields = {f'{{{k}}}': v for k, v in fields.items()}

    # ── Step 1: 表格占位符替换 ──
    for table in doc.tables:
        for ri in range(1, len(table.rows)):  # 跳过表头
            row = table.rows[ri]
            row_text = ''.join(c.text for c in row.cells)
            table_key = None
            for bk, v in brace_fields.items():
                if bk in row_text and '|' in v.strip():
                    table_key = bk
                    _fill_table_rows(table, v, template_row_idx=ri)
                    break
            if table_key:
                continue
            for cell in row.cells:
                for para in cell.paragraphs:
                    for bk, v in brace_fields.items():
                        if bk in para.text and '|' not in v.strip():
                            _inline_replace(para, bk, v)

    # ── Step 2: 段落替换 ──
    for para in doc.paragraphs:
        full_text = ''.join(r.text for r in para.runs)
        if not full_text.strip():
            continue

        for bk, v in brace_fields.items():
            if bk not in full_text:
                continue
            if '\n' in v.strip():
                _fill_paragraph_lines(doc, para, v)
                break
            else:
                _inline_replace(para, bk, v)


# ── 主流程（stdin/stdout CLI） ─────────────────────────

def main():
    input_data = json.loads(sys.stdin.read())
    template_bytes = base64.b64decode(input_data['template_base64'])
    fields = input_data['fields']
    # doc_type is accepted but not used for template lookup (template comes inline)
    # doc_type = input_data.get('doc_type', 'contract')

    doc = Document(io.BytesIO(template_bytes))
    fill_template(doc, fields)

    output = io.BytesIO()
    doc.save(output)
    sys.stdout.buffer.write(base64.b64encode(output.getvalue()))


if __name__ == '__main__':
    main()
