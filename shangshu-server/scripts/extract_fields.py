#!/usr/bin/env python3
"""从 docx 模板中提取 {placeholder} 占位符。

stdin:  JSON { template_base64: string }
stdout: JSON { fields: string[] }  (去重、排序)
"""
import sys
import json
import base64
import io
import re

from docx import Document


def extract(template_bytes: bytes) -> list[str]:
    """Extract all {placeholder} names from a .docx template."""
    doc = Document(io.BytesIO(template_bytes))
    placeholders = set()
    pattern = re.compile(r'\{([a-zA-Z0-9_]+)\}')

    for p in doc.paragraphs:
        for m in pattern.finditer(p.text):
            placeholders.add(m.group(1))

    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                for m in pattern.finditer(cell.text):
                    placeholders.add(m.group(1))

    return sorted(placeholders)


def main():
    data = json.loads(sys.stdin.read())
    template_bytes = base64.b64decode(data['template_base64'])
    print(json.dumps({'fields': extract(template_bytes)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
