"""有界DOCX正文补丁；仅改指定普通段落，不重建包、不写文件或业务数据。"""
import base64
from io import BytesIO
import re
from xml.dom import minidom
from xml.parsers import expat
from zipfile import ZipFile, BadZipFile

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
MAX_BYTES = 10 * 1024 * 1024
REVISION = 1


def _fail(message):
    raise ValueError(message)


def _elements(node):
    return [n for n in node.childNodes if n.nodeType == n.ELEMENT_NODE]


def _is(node, *names):
    return node.namespaceURI == W and node.localName in names


def _read(content):
    if not isinstance(content, bytes) or not content or len(content) > MAX_BYTES:
        _fail('DOCX正文编辑上限10MB，请下载原件')
    try:
        with ZipFile(BytesIO(content)) as archive:
            items = archive.infolist(); names = [i.filename for i in items]
            if len(items)>1000 or len(names)!=len(set(names)) or sum(i.file_size for i in items)>50*1024*1024:
                _fail('DOCX压缩结构重复或超过解压限制')
            if 'word/document.xml' not in names or any(i.flag_bits & 1 for i in items):
                _fail('不是普通DOCX或已加密')
            reason = '含宏或数字签名，保持只读' if any('vba' in n.lower() or n.startswith('_xmlsignatures/') for n in names) else ''
            nodes = 0
            for item in items:
                if not item.filename.endswith(('.xml','.rels')): continue
                if item.file_size>20*1024*1024: _fail('DOCX XML超过解析限制')
                parser = expat.ParserCreate(namespace_separator='}')
                def reject(*_): _fail('DOCX不能包含DTD或实体')
                def start(name, attrs):
                    nonlocal nodes, reason
                    nodes += 1
                    if nodes>100000: _fail('DOCX结构过于复杂，请下载编辑')
                    if name in {W+'}'+tag for tag in ('documentProtection','trackRevisions','ins','del','moveFrom','moveTo')}:
                        reason = '含保护或修订记录，保持只读；请在Word中处理后再上传'
                parser.StartDoctypeDeclHandler=reject;parser.EntityDeclHandler=reject;parser.ExternalEntityRefHandler=reject
                parser.StartElementHandler=start
                parser.Parse(archive.read(item),True)
            doc = minidom.parseString(archive.read('word/document.xml'))
            bodies = doc.getElementsByTagNameNS(W,'body')
            if len(bodies)!=1: _fail('DOCX正文结构无效')
            paragraphs = [p for p in _elements(bodies[0]) if _is(p,'p')]
            if len(paragraphs)>1000: _fail('正文超过1000段，请下载编辑')
            return doc, paragraphs, reason
    except (BadZipFile, expat.ExpatError, KeyError) as error:
        raise ValueError('DOCX结构无效，请下载原件核对') from error


def _paragraph(p, index):
    text = ''.join(''.join(n.data for n in child.childNodes if n.nodeType in (n.TEXT_NODE,n.CDATA_SECTION_NODE)) if _is(child,'t') else '\n' if _is(child,'br') else '\t' if _is(child,'tab') else '' for child in p.getElementsByTagName('*'))
    children = _elements(p); runs = [r for r in children if _is(r,'r')]
    simple = all(_is(c,'pPr','r') for c in children) and all(all(_is(c,'rPr','t','br','tab') for c in _elements(r)) for r in runs)
    styles = {''.join(c.toxml() for c in _elements(r) if _is(c,'rPr')) for r in runs}
    editable = simple and len(styles)<=1
    return {'key':'p'+str(index),'text':text,'editable':editable,
            'reason':'' if editable else '此段含混合格式、引用或嵌入内容，保留原件只读'}


def decode(content):
    doc, paragraphs, reason = _read(content)
    try:
        values = [_paragraph(p,i) for i,p in enumerate(paragraphs)]
        if sum(len(p['text']) for p in values)>200000: _fail('正文超过20万字，请下载编辑')
        return {'revision':REVISION,'editable':not reason and any(p['editable'] for p in values),
                'reason':reason,'paragraphs':values,
                'notice':'仅编辑已有普通正文段落；表格、图片、页眉页脚及复杂段落保持原件，不在此排版。'}
    finally: doc.unlink()


def encode(content, changes):
    opened = decode(content)
    if not opened['editable']: _fail(opened['reason'] or '没有可编辑的正文段落')
    if not isinstance(changes,list) or len(changes)>1000: _fail('正文修改列表无效')
    if not changes: return content
    original = {p['key']:p for p in opened['paragraphs']}; seen=set()
    for change in changes:
        if not isinstance(change,dict) or set(change)!={'key','text'}: _fail('段落补丁结构无效')
        key=change['key'];text=change['text']
        if not isinstance(key,str) or key in seen or key not in original or not original[key]['editable']: _fail('段落不存在、重复或不可编辑')
        if not isinstance(text,str) or len(text)>20000 or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff]',text): _fail('段落文字过长或含非法字符')
        seen.add(key)
    if sum(len(next((c['text'] for c in changes if c['key']==p['key']),p['text'])) for p in opened['paragraphs'])>200000: _fail('正文超过20万字')
    doc, paragraphs, _ = _read(content)
    try:
        for change in changes:
            if change['text']==original[change['key']]['text']: continue
            p=paragraphs[int(change['key'][1:])];runs=[r for r in _elements(p) if _is(r,'r')]
            prefix=(p.prefix+':') if p.prefix else ''
            if not runs:
                run=doc.createElementNS(W,prefix+'r');p.appendChild(run);runs=[run]
            for run in runs:
                for child in list(run.childNodes):
                    if child.nodeType==child.ELEMENT_NODE and not _is(child,'rPr'): run.removeChild(child)
            for part in re.split(r'([\n\t])',change['text']):
                if part in ('\n','\t'): child=doc.createElementNS(W,prefix+('br' if part=='\n' else 'tab'))
                else:
                    child=doc.createElementNS(W,prefix+'t');child.setAttribute('xml:space','preserve');child.appendChild(doc.createTextNode(part))
                runs[0].appendChild(child)
        out=BytesIO()
        with ZipFile(BytesIO(content)) as source, ZipFile(out,'w') as target:
            target.comment=source.comment
            for item in source.infolist(): target.writestr(item,doc.toxml(encoding='utf-8') if item.filename=='word/document.xml' else source.read(item))
        result=out.getvalue()
        if len(result)>MAX_BYTES: _fail('保存结果超过10MB')
        return result
    finally: doc.unlink()


def invoke(_service, payload, context):
    import frappe
    from shangshu_core.public_api import get_record_attachments
    from shangshu_files.domain import versions
    try:
        history=versions('files.versions',{'file':payload['file']},context)
        if not str(history.get('file',{}).get('file_name','')).lower().endswith('.docx'): _fail('请选择DOCX文件')
        selected=next((v for v in history['versions'] if v['version_no']==payload['version']),None)
        if not selected: _fail('所选固定版本不存在或超出历史范围')
        get_record_attachments('Shangshu File Center File',payload['file'],[selected['frappe_file']])
        source=frappe.get_doc('File',selected['frappe_file']).get_content()
        if not isinstance(source,bytes): source=source.encode()
        if payload['operation']=='open': return decode(source)
        if payload['operation']=='encode':
            data=encode(source,payload.get('changes'))
            return {'revision':REVISION,'content_base64':base64.b64encode(data).decode(),'size':len(data)}
        _fail('未知DOCX操作')
    except ValueError as error: frappe.throw(str(error),frappe.ValidationError)
