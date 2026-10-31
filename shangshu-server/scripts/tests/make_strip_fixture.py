"""合成夹具：一张带「外链 + 自定义XML」的小表（可编辑目标）和一张带图表的表（仍只读）。

外链公式格 B2 带缓存值 42（[1] 外部源.xlsx）；B4 外链公式缓存值是 18 位长编号
（考验「固化不丢位」）；C3 是内部公式 =B3*2（不该被动）。部件注入走原样 zip 重打，
不依赖 Excel。
"""
import re
import zipfile
from io import BytesIO

from openpyxl import Workbook

NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
EXT_REL_TYPE = ('http://schemas.openxmlformats.org/officeDocument/2006/'
                'relationships/externalLink')
EXT_CT = ('application/vnd.openxmlformats-officedocument.'
          'spreadsheetml.externalXml' .replace('externalXml', 'externalLink+xml'))
CUSTOM_CT = ('application/vnd.openxmlformats-officedocument.'
             'customXmlProperties+xml')

EXTERNAL_LINK_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    '<externalBook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/'
    'relationships" r:id="rId1"><sheetNames><sheetName val="外部源"/></sheetNames>'
    '<sheetDataSet><sheetData sheetId="0"><row r="1"><cell r="A1"><v>42</v></cell>'
    '</row></sheetData></sheetDataSet></externalBook></externalLink>'
)
EXTERNAL_LINK_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="%s"><Relationship Id="rId1" Type="%s" Target="外部源.xlsx" '
    'TargetMode="External"/></Relationships>' % (NS_REL, EXT_REL_TYPE.replace('externalLink', 'externalLinkPath'))
)
CUSTOM_ITEM = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><root><data>meta</data></root>'
CUSTOM_PROPS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<ds:datastoreItem ds:itemID="{12345678-1234-1234-1234-1234567890AB}" '
    'xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml">'
    '<ds:schemaRefs/></ds:datastoreItem>'
)


def _repack(raw, updates, adds):
    zin = zipfile.ZipFile(BytesIO(raw))
    items = [(n, updates.get(n, zin.read(n))) for n in zin.namelist()]
    zin.close()
    out = BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for n, data in items:
            z.writestr(n, data)
        for n, data in adds.items():
            z.writestr(n, data)
    return out.getvalue()


def _inject_cached_value(sheet_xml, coord, cached_xml):
    """把 openpyxl 写出的公式格 <c r="COORD"><f>…</f></c> 改成带缓存值 <v>。"""
    pattern = re.compile(r'<c r="%s"[^>]*>.*?</c>' % re.escape(coord), re.S)
    m = pattern.search(sheet_xml)
    assert m, '夹具里找不到格 ' + coord
    inner = re.search(r'(<f>.*?</f>)', m.group(0), re.S).group(1)
    return pattern.sub('<c r="%s">%s%s</c>' % (coord, inner, cached_xml), sheet_xml, count=1)


def build_external_fixture():
    wb = Workbook()
    ws = wb.active
    ws.title = 'Sheet1'
    ws['A1'] = '名称'
    ws['B1'] = '引用值'
    ws['C1'] = '备注'
    ws['A2'] = '甲'
    ws['B2'] = "='[1]外部源'!$A$1"        # 外链公式 → 缓存值 42
    ws['C2'] = '本地'
    ws['A3'] = '乙'
    ws['B3'] = 7
    ws['C3'] = '=B3*2'                     # 内部公式，不许被动
    ws['A4'] = '丙'
    ws['B4'] = "='[1]外部源'!$A$2"        # 外链公式 → 18 位长编号缓存值
    ws['C4'] = '=IF(A4="图[1]",1,2)'   # 内部公式带 [1] 字样：不是外链，不许固化
    ws['A5'] = '丁'
    ws['C5'] = '=SUM(甲[乙])'          # 结构化引用样式（无 [[）：不是外链，不许固化
    buf = BytesIO()
    wb.save(buf)
    raw = buf.getvalue()

    sheet_xml = zipfile.ZipFile(BytesIO(raw)).read('xl/worksheets/sheet1.xml').decode('utf-8')
    sheet_xml = _inject_cached_value(sheet_xml, 'B2', '<v>42</v>')
    sheet_xml = _inject_cached_value(sheet_xml, 'B4', '<v>202412345678901234</v>')

    book = zipfile.ZipFile(BytesIO(raw)).read('xl/workbook.xml').decode('utf-8')
    book = book.replace('</sheets>', '</sheets><externalReferences>'
                        '<externalReference xmlns:r="http://schemas.openxmlformats.org/'
                        'officeDocument/2006/relationships" r:id="rIdExt1"/></externalReferences>')
    rels = zipfile.ZipFile(BytesIO(raw)).read('xl/_rels/workbook.xml.rels').decode('utf-8')
    rels = rels.replace('</Relationships>',
                        '<Relationship Id="rIdExt1" Type="%s" '
                        'Target="externalLinks/externalLink1.xml"/></Relationships>' % EXT_REL_TYPE)
    ctypes = zipfile.ZipFile(BytesIO(raw)).read('[Content_Types].xml').decode('utf-8')
    ctypes = ctypes.replace('</Types>',
                            '<Override PartName="/xl/externalLinks/externalLink1.xml" '
                            'ContentType="%s"/>'
                            '<Override PartName="/customXml/itemProps1.xml" '
                            'ContentType="%s"/></Types>' % (EXT_CT, CUSTOM_CT))

    return _repack(raw,
                   updates={
                       'xl/worksheets/sheet1.xml': sheet_xml.encode('utf-8'),
                       'xl/workbook.xml': book.encode('utf-8'),
                       'xl/_rels/workbook.xml.rels': rels.encode('utf-8'),
                       '[Content_Types].xml': ctypes.encode('utf-8'),
                   },
                   adds={
                       'xl/externalLinks/externalLink1.xml': EXTERNAL_LINK_XML.encode('utf-8'),
                       'xl/externalLinks/_rels/externalLink1.xml.rels': EXTERNAL_LINK_RELS.encode('utf-8'),
                       'customXml/item1.xml': CUSTOM_ITEM.encode('utf-8'),
                       'customXml/itemProps1.xml': CUSTOM_PROPS.encode('utf-8'),
                   })


def build_chart_fixture():
    """带图表部件的表：硬黑名单，仍须拒编辑（用户只批了外链这一类）。"""
    wb = Workbook()
    ws = wb.active
    ws['A1'] = '名称'
    ws['B1'] = '数量'
    ws['A2'] = '甲'
    ws['B2'] = 1
    buf = BytesIO()
    wb.save(buf)
    raw = buf.getvalue()
    ctypes = zipfile.ZipFile(BytesIO(raw)).read('[Content_Types].xml').decode('utf-8')
    ctypes = ctypes.replace('</Types>',
                            '<Override PartName="/xl/charts/chart1.xml" '
                            'ContentType="application/vnd.openxmlformats-officedocument.'
                            'drawingml.chart+xml"/></Types>')
    return _repack(raw,
                   updates={'[Content_Types].xml': ctypes.encode('utf-8')},
                   adds={'xl/charts/chart1.xml': b'<chartSpace/>'})



def build_external_nocache_fixture():
    """案例3：外链公式**没有缓存值**（文件从没被 Excel 算过）——固化不许把格清空，
    要落成公式原文文本（数虽没有、线索不丢）。"""
    wb = Workbook()
    ws = wb.active
    ws.title = 'Sheet1'
    ws['A1'] = '名称'
    ws['B1'] = '引用值'
    ws['A2'] = '甲'
    ws['B2'] = "='[1]外部源'!$A$1"        # 无 <v> 缓存
    buf = BytesIO()
    wb.save(buf)
    raw = buf.getvalue()
    book = zipfile.ZipFile(BytesIO(raw)).read('xl/workbook.xml').decode('utf-8')
    book = book.replace('</sheets>', '</sheets><externalReferences>'
                        '<externalReference xmlns:r="http://schemas.openxmlformats.org/'
                        'officeDocument/2006/relationships" r:id="rIdExt1"/></externalReferences>')
    rels = zipfile.ZipFile(BytesIO(raw)).read('xl/_rels/workbook.xml.rels').decode('utf-8')
    rels = rels.replace('</Relationships>',
                        '<Relationship Id="rIdExt1" Type="%s" '
                        'Target="externalLinks/externalLink1.xml"/></Relationships>' % EXT_REL_TYPE)
    ctypes = zipfile.ZipFile(BytesIO(raw)).read('[Content_Types].xml').decode('utf-8')
    ctypes = ctypes.replace('</Types>',
                            '<Override PartName="/xl/externalLinks/externalLink1.xml" '
                            'ContentType="%s"/></Types>' % EXT_CT)
    return _repack(raw,
                   updates={
                       'xl/workbook.xml': book.encode('utf-8'),
                       'xl/_rels/workbook.xml.rels': rels.encode('utf-8'),
                       '[Content_Types].xml': ctypes.encode('utf-8'),
                   },
                   adds={
                       'xl/externalLinks/externalLink1.xml': EXTERNAL_LINK_XML.encode('utf-8'),
                       'xl/externalLinks/_rels/externalLink1.xml.rels': EXTERNAL_LINK_RELS.encode('utf-8'),
                   })


if __name__ == '__main__':
    from openpyxl import load_workbook
    for name, fn in (('external', build_external_fixture), ('chart', build_chart_fixture)):
        data = fn()
        wb = load_workbook(BytesIO(data), data_only=False, keep_links=False)  # 产品同参自检
        parts = [n for n in zipfile.ZipFile(BytesIO(data)).namelist()
                 if n.startswith('xl/externalLinks/') or n.startswith('customXml/')
                 or n.startswith('xl/charts/')]
        print(name, 'OK 构建', len(data), '字节；注入部件：', parts,
              '；B2 公式=', repr(wb.active['B2'].value), '；C3 公式=', repr(wb.active['C3'].value))
