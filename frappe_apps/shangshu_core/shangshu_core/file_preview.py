"""基础附件的只读 DOCX 预览；不存第二份文件、不执行 Office 内容。"""
from io import BytesIO
from zipfile import ZipFile, BadZipFile
from xml.etree import ElementTree as ET
from xml.parsers import expat

MAX_BYTES = 20 * 1024 * 1024
MAX_TEXT = 200000


def parse_docx(content):
    if not isinstance(content, bytes) or not content or len(content) > MAX_BYTES:
        raise ValueError('文件为空或超过20MB，请下载原件核对')
    try:
        with ZipFile(BytesIO(content)) as archive:
            members=archive.infolist();names=[m.filename for m in members]
            if len(members)>1000 or len(set(names))!=len(names) or sum(m.file_size for m in members)>50*1024*1024:
                raise ValueError('文档解压结构超限，请下载原件核对')
            if any(m.flag_bits&1 or 'vbaproject' in m.filename.lower() for m in members):
                raise ValueError('不支持加密或宏文档预览')
            entry=archive.getinfo('word/document.xml')
            if entry.file_size>MAX_BYTES:raise ValueError('文档正文过大，请下载原件核对')
            xml=archive.read(entry)
        parser=expat.ParserCreate()
        def reject(*args):raise ValueError('文档包含不支持的 XML 实体声明')
        parser.StartDoctypeDeclHandler=reject;parser.EntityDeclHandler=reject;parser.ExternalEntityRefHandler=reject
        nodes=0
        def start(*args):
            nonlocal nodes
            nodes+=1
            if nodes>100000:raise ValueError('文档结构过于复杂，请下载原件核对')
        parser.StartElementHandler=start
        parser.Parse(xml,True)
        root=ET.fromstring(xml)
        local=lambda el:el.tag.rsplit('}',1)[-1]
        body=next((el for el in root if local(el)=='body'),None)
        if body is None:raise ValueError('未找到文档正文')
        def text(el):
            return ''.join(n.text or '' if local(n)=='t' else '\n' if local(n) in ('br','cr') else '\t' if local(n)=='tab' else '' for n in el.iter())
        blocks=[];length=0;cell_count=0
        for el in body:
            if local(el)=='p':
                value=text(el);length+=len(value)
                if value:blocks.append({'type':'paragraph','text':value})
            elif local(el)=='tbl':
                rows=[]
                for row in el:
                    if local(row)!='tr':continue
                    cells=['\n'.join(text(p) for p in cell if local(p)=='p') for cell in row if local(cell)=='tc']
                    cell_count+=len(cells)
                    if cell_count>10000:raise ValueError('表格超过预览范围，请下载原件核对')
                    rows.append(cells);length+=sum(map(len,cells))
                blocks.append({'type':'table','rows':rows})
            if length>MAX_TEXT or len(blocks)>3000:raise ValueError('正文超过预览范围，请下载原件核对，未截断显示')
        warnings=['此为正文和表格预览，版式以原件为准。']
        if any(local(el) in ('drawing','pict','object','altChunk') for el in body.iter()):
            warnings.append('图片、图形及嵌入对象未显示，请下载原件核对。')
        return {'blocks':blocks,'warnings':warnings}
    except (BadZipFile,KeyError,ET.ParseError,expat.ExpatError,RuntimeError,OSError,NotImplementedError) as error:
        raise ValueError('DOCX 文件损坏或结构不支持，请重新上传或下载原件核对') from error


def preview(_service,payload,_context):
    import frappe
    from shangshu_core.attachments import get_record_attachments
    get_record_attachments(payload['ref_doctype'],payload['ref_name'],[payload['file']])
    file=frappe.get_doc('File',payload['file'])
    if not (file.file_name or '').lower().endswith('.docx'):
        frappe.throw('该附件不是 DOCX 文档',frappe.ValidationError)
    try:return parse_docx(file.get_content())
    except ValueError as error:frappe.throw(str(error),frappe.ValidationError)
