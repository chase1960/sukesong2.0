"""独立解析下载的 xlsx，核验单格修改往返：新值生效、未改内容/样式/列宽/其他工作表保留、前导零与长编号不变。

用法：
  python3 scripts/tests/verify_xlsx_roundtrip.py <下载文件.xlsx> <期望JSON>

期望 JSON 形状：
{
  "sheet": "费用明细",
  "changed": {"cell": "C2", "type": "number", "value": 999.5},
  "unchanged": {"A2": {"type": "text", "value": "00123"},
                "F2": {"type": "text", "value": "202610101234567890"},
                "E2": {"type": "text", "value": "南京→上海\n高铁往返"}},
  "other_sheet": {"name": "汇总说明", "cells": {"A2": 12345}},
  "column_widths": {"B": 22, "E": 30},
  "styles": [{"cell": "A1", "bold": true}]
}

核验通过 = 新值确实写进文件、00123 与 18 位长编号原样、未改单元格值/换行、列宽、未编辑工作表、指定样式全部保持。
本脚本只读文件独立解析（openpyxl + 原始 XML 双路径），不调用被测后端代码。
退出码 0=全部通过，1=有失败（逐项打印）。
"""
import json
import sys
import zipfile
from pathlib import Path

from openpyxl import load_workbook


def cell_typed(cell):
    value = cell.value
    if value is None:
        return {"type": "empty", "value": None}
    if isinstance(value, bool):
        return {"type": "boolean", "value": value}
    if isinstance(value, (int, float)):
        return {"type": "number", "value": value}
    # 日期/时间统一 ISO；文本原样（含 00123、长编号、换行）
    if hasattr(value, "isoformat"):
        return {"type": "date", "value": value.isoformat()}
    return {"type": "text", "value": str(value)}


def values_equal(typed, expected):
    if typed["type"] == "number" and expected.get("type") == "number":
        return abs(float(typed["value"]) - float(expected["value"])) < 1e-9
    if typed["type"] == "date" and expected.get("type") == "date":
        return str(typed["value"]).startswith(str(expected["value"])[:10])
    return typed["value"] == expected["value"]


def main(path, expected_json):
    expected = json.loads(Path(expected_json).read_text())
    failures = []
    wb = load_workbook(path)
    sheet_name = expected.get("sheet") or wb.sheetnames[0]
    if sheet_name not in wb.sheetnames:
        print(f"FAIL 工作表 {sheet_name!r} 不存在，实际有 {wb.sheetnames}")
        return 1
    ws = wb[sheet_name]

    changed = expected.get("changed") or {}
    if changed:
        got = cell_typed(ws[changed["cell"]])
        if values_equal(got, changed):
            print(f"PASS 改动格 {changed['cell']} = {got['value']!r}")
        else:
            failures.append(f"改动格 {changed['cell']} 期望 {changed} 实际 {got}")

    for ref, exp in (expected.get("unchanged") or {}).items():
        got = cell_typed(ws[ref])
        if values_equal(got, exp):
            print(f"PASS 未改格 {ref} 保持 {got['value']!r} ({got['type']})")
        else:
            failures.append(f"未改格 {ref} 期望 {exp} 实际 {got}")

    # 结构动作预期（N2）：数据行总数、新表头、表头改名
    if "total_data_rows" in expected:
        data_rows = (ws.max_row or 1) - 1
        if data_rows == expected["total_data_rows"]:
            print(f"PASS 数据行总数 = {data_rows}")
        else:
            failures.append(f"数据行总数 期望 {expected['total_data_rows']} 实际 {data_rows}")

    headers = [ws.cell(row=1, column=c).value for c in range(1, (ws.max_column or 1) + 1)]
    headers = [str(h) if h is not None else "" for h in headers]
    if expected.get("new_header"):
        if expected["new_header"] in headers:
            print(f"PASS 新表头 {expected['new_header']!r} 在表头行")
        else:
            failures.append(f"新表头 {expected['new_header']!r} 不在表头行 {headers}")
    renamed = expected.get("renamed_header") or {}
    if renamed:
        old, new = renamed.get("from"), renamed.get("to")
        if new in headers and old not in headers:
            print(f"PASS 表头已改名 {old!r} → {new!r}")
        else:
            failures.append(f"表头改名 期望 {old!r}→{new!r}，实际表头 {headers}")

    # 独立第二路径：直接读 sheet XML，防 openpyxl 掩盖序列化问题
    z = zipfile.ZipFile(path)
    xml_name = None
    # 用 workbook.xml.rels 精确定位工作表 XML
    wb_xml = z.read("xl/workbook.xml").decode("utf-8")
    rels = z.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    import re
    m = re.search(r'<sheet[^>]*name="%s"[^>]*r:id="([^"]+)"' % re.escape(sheet_name), wb_xml)
    if m:
        rid = m.group(1)
        # Relationship 元素里 Id/Target 顺序不固定，两边都匹配；Target 可能是 /xl/... 或 worksheets/...
        m2 = re.search(r'<Relationship[^>]*Id="%s"[^>]*Target="([^"]+)"' % rid, rels) \
            or re.search(r'<Relationship[^>]*Target="([^"]+)"[^>]*Id="%s"' % rid, rels)
        if m2:
            target = m2.group(1).lstrip("/")
            xml_name = target if target.startswith("xl/") else "xl/" + target
    if xml_name and xml_name in z.namelist():
        raw = z.read(xml_name).decode("utf-8")
        # openpyxl 把非 ASCII 写成数字字符引用（&#24046;…），匹配前先解引用，防误报
        import html as _html
        raw = _html.unescape(raw)
        for ref, exp in (expected.get("unchanged") or {}).items():
            if exp.get("type") == "text":
                # inlineStr 或 sharedStrings 两种写法都要能看见原文（含 & 转义宽松处理）
                needle = str(exp["value"]).split("\n")[0][:20]
                if needle and "&#x" not in needle:
                    if needle not in raw and needle.replace("&", "&amp;") not in raw:
                        # 也可能在 sharedStrings.xml
                        blob = raw
                        for name in z.namelist():
                            if name.endswith("sharedStrings.xml"):
                                blob += _html.unescape(z.read(name).decode("utf-8"))
                        if needle not in blob:
                            failures.append(f"XML 独立核验未找到 {ref} 原文 {needle!r}")
                        else:
                            print(f"PASS XML 独立核验 {ref} 原文在包内")
                    else:
                        print(f"PASS XML 独立核验 {ref} 原文在 sheet XML")
    else:
        print("SKIP XML 独立核验（未能定位 sheet XML）")

    for ref, exp in (expected.get("unchanged") or {}).items():
        if exp.get("type") == "text" and "\n" in str(exp["value"]):
            cell = ws[ref]
            if not (cell.alignment and cell.alignment.wrap_text):
                failures.append(f"未改格 {ref} 换行/自动换行样式丢失")
            else:
                print(f"PASS 未改格 {ref} 换行样式保留")

    other = expected.get("other_sheet") or {}
    if other:
        name = other["name"]
        if name not in wb.sheetnames:
            failures.append(f"未编辑工作表 {name!r} 丢失，实际 {wb.sheetnames}")
        else:
            for ref, val in (other.get("cells") or {}).items():
                got = wb[name][ref].value
                ok = (abs(float(got) - float(val)) < 1e-9) if isinstance(val, (int, float)) and isinstance(got, (int, float)) else (str(got) == str(val))
                if ok:
                    print(f"PASS 未编辑工作表 {name}!{ref} = {got!r}")
                else:
                    failures.append(f"未编辑工作表 {name}!{ref} 期望 {val!r} 实际 {got!r}")

    for col, width in (expected.get("column_widths") or {}).items():
        got = ws.column_dimensions[col].width
        if got is not None and abs(float(got) - float(width)) < 0.01:
            print(f"PASS 列宽 {col} = {got}")
        else:
            failures.append(f"列宽 {col} 期望 {width} 实际 {got}")

    for spec in expected.get("styles") or []:
        cell = ws[spec["cell"]]
        if "bold" in spec:
            ok = bool(cell.font and cell.font.bold) == bool(spec["bold"])
            if ok:
                print(f"PASS 样式 {spec['cell']} bold={spec['bold']}")
            else:
                failures.append(f"样式 {spec['cell']} bold 期望 {spec['bold']} 实际 {bool(cell.font and cell.font.bold)}")

    if failures:
        print("\n==== 失败项 ====")
        for f in failures:
            print("FAIL " + f)
        return 1
    print("\n全部核验通过")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1], sys.argv[2]))
