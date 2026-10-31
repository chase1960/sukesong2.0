"""批注提取夹具：带「便签（单元格批注）+ 批注锚框 VML」的小表。

夹具 A（新备注列）：表头 名称/数量/产地；批注 B2='注意单位'、C2='已核对'、A3='待补资料'。
  期望提取后新增 D 列「备注」（每表只允许一个备注列）：D2='注意单位；已核对'（同行多条
  用「；」连、直接进字段值不带列名前缀），D3='待补资料'。
夹具 B（已有备注列）：表头 名称/数量/备注，C2='旧值'；批注 B2='新批注'。
  期望提取后 C2='旧值；新批注'（已有内容在前、新条在后追加，不覆盖、不新增列）。
部件注入走原样 zip 重打；批注数据在 xl/comments1.xml，锚框 xl/drawings/vmlDrawing1.vml。
"""
import re
import zipfile
from io import BytesIO

from openpyxl import Workbook

NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
COMMENTS_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml'
VML_CT = 'application/vnd.openxmlformats-officedocument.vmlDrawing'

COMMENTS_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    '<authors><author>审阅人</author></authors><commentList>%s</commentList></comments>'
)
COMMENT_ITEM = ('<comment ref="%s" authorId="0"><text><t>%s</t></text></comment>')

VML_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"'
    ' xmlns:x="urn:schemas-microsoft-com:office:excel">'
    '<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout>'
    '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202"'
    ' path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/>'
    '<v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>%s</xml>'
)
VML_SHAPE = (
    '<v:shape id="_x0000_s%d" type="#_x0000_t202" style="position:absolute"'
    ' fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/>'
    '<v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto">'
    '<div style="text-align:left"/></v:textbox>'
    '<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/>'
    '<x:Anchor>1, 15, 1, 2, 3, 15, 5, 4</x:Anchor><x:AutoFill>False</x:AutoFill>'
    '<x:Row>%d</x:Row><x:Column>%d</x:Column></x:ClientData></v:shape>'
)

SHEET_RELS_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="%s">'
    '<Relationship Id="rIdCmt1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
    'relationships/comments" Target="../comments1.xml"/>'
    '<Relationship Id="rIdVml1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
    'relationships/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/>'
    '</Relationships>' % NS_REL
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


def _inject_comments(raw, comments):
    """comments: [(cell_ref, row0, col0, text)]。写批注部件 + 锚框 + 关联 + 类型声明。"""
    z = zipfile.ZipFile(BytesIO(raw))
    sheet_xml = z.read('xl/worksheets/sheet1.xml').decode('utf-8')
    if 'xmlns:r=' not in sheet_xml.split('>', 1)[0]:
        sheet_xml = sheet_xml.replace('<worksheet',
                                      '<worksheet xmlns:r="http://schemas.openxmlformats.org/'
                                      'officeDocument/2006/relationships"', 1)
    sheet_xml = sheet_xml.replace('</worksheet>',
                                  '<legacyDrawing r:id="rIdCmt1"/></worksheet>')
    ctypes = z.read('[Content_Types].xml').decode('utf-8')
    ctypes = ctypes.replace('</Types>',
                            '<Override PartName="/xl/comments1.xml" ContentType="%s"/>'
                            '<Default Extension="vml" ContentType="%s"/></Types>'
                            % (COMMENTS_CT, VML_CT))
    items = ''.join(COMMENT_ITEM % (ref, text) for ref, _r, _c, text in comments)
    shapes = ''.join(VML_SHAPE % (1026 + i, r, c) for i, (_ref, r, c, _t) in enumerate(comments))
    return _repack(raw,
                   updates={
                       'xl/worksheets/sheet1.xml': sheet_xml.encode('utf-8'),
                       '[Content_Types].xml': ctypes.encode('utf-8'),
                   },
                   adds={
                       'xl/comments1.xml': (COMMENTS_XML % items).encode('utf-8'),
                       'xl/drawings/vmlDrawing1.vml': (VML_XML % shapes).encode('utf-8'),
                       'xl/worksheets/_rels/sheet1.xml.rels': SHEET_RELS_XML.encode('utf-8'),
                   })


def build_comment_fixture():
    """夹具 A：新备注列。批注 B2/C2（同第 2 行两条）、A3。"""
    wb = Workbook()
    ws = wb.active
    ws.title = 'Sheet1'
    ws['A1'] = '名称'
    ws['B1'] = '数量'
    ws['C1'] = '产地'
    ws['A2'] = '甲'
    ws['B2'] = 5
    ws['C2'] = '苏'
    ws['A3'] = '乙'
    ws['B3'] = 7
    ws['C3'] = '浙'
    buf = BytesIO()
    wb.save(buf)
    return _inject_comments(buf.getvalue(), [
        ('B2', 1, 1, '注意单位'),
        ('C2', 1, 2, '已核对'),
        ('A3', 2, 0, '待补资料'),
    ])


def build_comment_existing_fixture():
    """夹具 B：已有备注列，追加不覆盖。"""
    wb = Workbook()
    ws = wb.active
    ws.title = 'Sheet1'
    ws['A1'] = '名称'
    ws['B1'] = '数量'
    ws['C1'] = '备注'
    ws['A2'] = '甲'
    ws['B2'] = 5
    ws['C2'] = '旧值'
    buf = BytesIO()
    wb.save(buf)
    return _inject_comments(buf.getvalue(), [('B2', 1, 1, '新批注')])




def build_comment_formula_remark_fixture():
    """夹具 C（审查发现的反例）：备注列**既有内容是公式**——提取追加后必须落成文本，
    不许拼成非法公式（'=CONCAT(\"x\",\"y\")；新批注' 当公式必坏）。"""
    wb = Workbook()
    ws = wb.active
    ws.title = 'Sheet1'
    ws['A1'] = '名称'
    ws['B1'] = '备注'
    ws['A2'] = '甲'
    ws['B2'] = '=CONCAT("x","y")'
    buf = BytesIO()
    wb.save(buf)
    return _inject_comments(buf.getvalue(), [('A2', 1, 0, '新批注')])



def build_merged_anchor_fixture():
    """案例1：批注挂在合并区**非锚点**格（openpyxl 载入即弃）——提取不许丢，走 XML 兜底。
    D2:E2 合并（锚点 D2='合计'），批注挂 E2；备注列 C。期望 C2='非锚点便签'。"""
    wb = Workbook()
    ws = wb.active
    ws.title = 'Sheet1'
    ws['A1'] = '名称'
    ws['B1'] = '数量'
    ws['C1'] = '备注'
    ws['A2'] = '甲'
    ws['B2'] = 5
    ws['D2'] = '合计'
    ws.merge_cells('D2:E2')
    buf = BytesIO()
    wb.save(buf)
    return _inject_comments(buf.getvalue(), [('E2', 1, 4, '非锚点便签')])


def build_merged_remark_target_fixture():
    """案例2：备注列落点（D2）在合并区非锚点——不许 500，跳过并留原批注。
    C2:D2 合并（锚点 C2='苏'）；批注挂 A2。期望：保存 200、D2 空、批注部件还在。"""
    wb = Workbook()
    ws = wb.active
    ws.title = 'Sheet1'
    ws['A1'] = '名称'
    ws['B1'] = '数量'
    ws['C1'] = '产地'
    ws['A2'] = '甲'
    ws['B2'] = 5
    ws['C2'] = '苏'
    ws.merge_cells('C2:D2')
    buf = BytesIO()
    wb.save(buf)
    return _inject_comments(buf.getvalue(), [('A2', 1, 0, '甲的便签')])


def build_header_only_comment_fixture():
    """案例5：只有表头行、批注挂表头——不许先加空备注列再丢批注。
    期望：无「备注」列、结构版本不涨、批注部件还在（留原处）。"""
    wb = Workbook()
    ws = wb.active
    ws.title = 'Sheet1'
    ws['A1'] = '名称'
    ws['B1'] = '数量'
    buf = BytesIO()
    wb.save(buf)
    return _inject_comments(buf.getvalue(), [('A1', 0, 0, '列说明')])


def build_out_of_extent_comment_fixture():
    """案例6：批注挂数据范围外的孤行（A10 带样式空格）——不许撑爆行表。
    期望：总行数不变、批注部件还在。"""
    wb = Workbook()
    ws = wb.active
    ws.title = 'Sheet1'
    ws['A1'] = '名称'
    ws['B1'] = '数量'
    ws['A2'] = '甲'
    ws['B2'] = 5
    from openpyxl.styles import Font
    ws['A10'].font = Font(bold=True)   # 带样式的空格：撑格式不撑数据范围
    buf = BytesIO()
    wb.save(buf)
    return _inject_comments(buf.getvalue(), [('A10', 9, 0, '远处便签')])


def build_overflow_remark_fixture():
    """案例7：追加会超 32767 字——不许静默截断。既有内容原样、批注留原处并计数。"""
    wb = Workbook()
    ws = wb.active
    ws.title = 'Sheet1'
    ws['A1'] = '名称'
    ws['B1'] = '备注'
    ws['A2'] = '甲'
    ws['B2'] = 'x' * 32000
    buf = BytesIO()
    wb.save(buf)
    return _inject_comments(buf.getvalue(), [('A2', 1, 0, 'y' * 2000)])


def build_secondary_sheet_comment_fixture():
    """案例8：只有**附表**有批注——主表表头一字未变，结构版本不许涨。
    Sheet1 主表（无批注）；Sheet2 有数据行+批注、无备注列。"""
    wb = Workbook()
    ws = wb.active
    ws.title = '主表'
    ws['A1'] = '名称'
    ws['B1'] = '数量'
    ws['A2'] = '甲'
    ws['B2'] = 5
    ws2 = wb.create_sheet('附表')
    ws2['A1'] = '品名'
    ws2['A2'] = '笔'
    buf = BytesIO()
    wb.save(buf)
    raw = buf.getvalue()
    # 附表是 sheet2.xml，批注走 sheet2 的 rels
    z = zipfile.ZipFile(BytesIO(raw))
    sheet_xml = z.read('xl/worksheets/sheet2.xml').decode('utf-8')
    if 'xmlns:r=' not in sheet_xml.split('>', 1)[0]:
        sheet_xml = sheet_xml.replace('<worksheet',
                                      '<worksheet xmlns:r="http://schemas.openxmlformats.org/'
                                      'officeDocument/2006/relationships"', 1)
    sheet_xml = sheet_xml.replace('</worksheet>',
                                  '<legacyDrawing r:id="rIdCmt2"/></worksheet>')
    ctypes = z.read('[Content_Types].xml').decode('utf-8')
    ctypes = ctypes.replace('</Types>',
                            '<Override PartName="/xl/comments1.xml" ContentType="%s"/>'
                            '<Default Extension="vml" ContentType="%s"/></Types>'
                            % (COMMENTS_CT, VML_CT))
    items = COMMENT_ITEM % ('A2', '附表便签')
    shapes = VML_SHAPE % (1026, 1, 0)
    sheet_rels = SHEET_RELS_XML.replace('rIdCmt1', 'rIdCmt2').replace('rIdVml1', 'rIdVml2')
    return _repack(raw,
                   updates={
                       'xl/worksheets/sheet2.xml': sheet_xml.encode('utf-8'),
                       '[Content_Types].xml': ctypes.encode('utf-8'),
                   },
                   adds={
                       'xl/comments1.xml': (COMMENTS_XML % items).encode('utf-8'),
                       'xl/drawings/vmlDrawing1.vml': (VML_XML % shapes).encode('utf-8'),
                       'xl/worksheets/_rels/sheet2.xml.rels': sheet_rels.encode('utf-8'),
                   })


def build_date_remark_fixture():
    """案例9：既有备注是真日期——拼接不许带出 00:00:00。期望 B2='2026-10-12；新批注'。"""
    import datetime
    wb = Workbook()
    ws = wb.active
    ws.title = 'Sheet1'
    ws['A1'] = '名称'
    ws['B1'] = '备注'
    ws['A2'] = '甲'
    ws['B2'] = datetime.date(2026, 10, 12)
    buf = BytesIO()
    wb.save(buf)
    return _inject_comments(buf.getvalue(), [('A2', 1, 0, '新批注')])


if __name__ == '__main__':
    from openpyxl import load_workbook
    for name, fn in (('A-新备注列', build_comment_fixture),
                     ('B-已有备注列', build_comment_existing_fixture),
                     ('C-备注列是公式', build_comment_formula_remark_fixture),
                     ('1-合并非锚点批注', build_merged_anchor_fixture),
                     ('2-合并落点跳过', build_merged_remark_target_fixture),
                     ('5-表头孤批注', build_header_only_comment_fixture),
                     ('6-范围外批注', build_out_of_extent_comment_fixture),
                     ('7-超长追加', build_overflow_remark_fixture),
                     ('8-非主表批注', build_secondary_sheet_comment_fixture),
                     ('9-日期拼接', build_date_remark_fixture)):
        data = fn()
        wb = load_workbook(BytesIO(data), data_only=False, keep_links=False)
        ws = wb.active
        cmts = {cell.coordinate: str(cell.comment.text)
                for row in ws.iter_rows() for cell in row if cell.comment}
        parts = [n for n in zipfile.ZipFile(BytesIO(data)).namelist()
                 if 'comment' in n.lower() or n.endswith('.vml')]
        print(name, 'OK', len(data), '字节；openpyxl 读到批注：', cmts, '；部件：', parts)
