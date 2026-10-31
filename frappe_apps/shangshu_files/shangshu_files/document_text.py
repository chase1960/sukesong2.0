"""受管文件的**正文分段**读取：PDF 抽文字层 / DOCX 段落 / 文本行。

**口径**（2026-10-21 父线定；见 `fde/开发/计划/执行计划.md` 第二步补充口径）：
· **读 PDF ＝ 抽它的文字层** —— **不是 OCR、不是截图、不是拿模型去看**；
· **没有文字层的页（扫描件／图片页）⇒ 明说「这一页抽不出文字，请人工填」** ——
  **不猜、不编、不把空当内容**；
· **按坐标还原成行/段**：PDF 给的是一堆带坐标的字块，**直接拼会乱序**
  （分栏通知书尤其明显：先左栏后右栏，**不是先上后下**）
  ⇒ 先**聚行** → **聚栏（按 x 聚簇）** → **按栏序（左栏先）还原** → **聚段**；
· **每段带页码**（页内序号也要有）⇒ **依据能指到「第几页第几段」**；
· **不做 OCR、不渲染图片、不调任何模型、不把官文外发**（外发要单独授权）。

**读权照旧**：本口住在文件域里 —— **谁能读这个文件，才能读它的正文**
（走 `files.versions` 那条既有的读权判定，**不另设一套**）。
**固定版本**：读的是文件的**当前固定版本**（回包说清取到的是哪一版）。
**原件哈希变了要拒**：读到的字节摘要与台账对不上 ⇒ 当场拒，**不给正文**。

**从旧 example 实现（`example_artifact_reader.py`，commit `d8a492c5`）借鉴的**：
PDF/DOCX/文本/图片四类分流、**每段带页码**、**编码兜底**（`utf-8-sig` → `gb18030`）、
**只读受管私有原件**、**原件 sha256 核对**、**内容哈希做缓存键**（1 小时）、
**按需分段返回**（大文件不一次全给）。
**没搬的**：旧实现的 **OCR 通道**（口径明确不做 OCR）、旧实现自建的**受管附件表**
（新内核不建这份事实：正文从文件域的**文件**读）。
"""
import hashlib

import frappe

# 缓存键里的版本号：解析口径变了就换号（老缓存自然作废）。
PARSER_VERSION = 'v1'
CACHE_TTL = 3600            # 1 小时（同旧实现）
DEFAULT_LIMIT = 20          # 一次最多回多少段
MAX_LIMIT = 200
MAX_SEGMENT_CHARS = 4000    # 单段最多回多少字（超了截断并标出来）
MAX_FILE_BYTES = 20 * 1024 * 1024

# 加 .xml：Host 批量上传会带 **.xml 回执**（上传白名单已放行它）⇒
# 能上传就要能读出来；XML 走**安全解析取文本**（不解析外部实体）。
TEXT_EXTENSIONS = {'.txt', '.md', '.csv', '.xml'}
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.tif', '.tiff'}
PDF_EXTENSIONS = {'.pdf'}
DOCX_EXTENSIONS = {'.docx'}


# ---------- PDF：按坐标还原成行/栏/段 ----------

def _join(left, right):
    """两块文字之间要不要补空格：**只有两侧都是西文才补**（中文不补）。"""
    if not left or not right:
        return left + right
    if ord(left[-1]) < 128 and ord(right[0]) < 128:
        return left + ' ' + right
    return left + right


def _pdfium_page_chars(page):
    """用 **pdfium**（pypdfium2）取一页的**字 ＋ 坐标**。

    为什么用 pdfium 而不是 pypdf 的 `visitor_text`：
    pypdf 回的 `cm`/`tm` 是它**内部文本流状态**的快照，遇到「上一段文字还没落定」
    就会给**过期**的矩阵（实测同一页里两栏文字，第二栏拿到的是 `(0, 0)`）⇒
    聚栏会整个塌掉。pdfium 给的是**每个字的真实位置框**（左下右上）⇒
    聚行、聚栏、聚段都按真坐标走。
    **不新增依赖**：pypdfium2 已经在 bench venv 里。
    """
    textpage = page.get_textpage()
    count = textpage.count_chars()
    chars = []
    for index in range(count):
        char = textpage.get_text_range(index, 1)
        if not char or char in ('\r', '\n'):
            continue
        box = textpage.get_charbox(index)
        if not box:
            continue
        left, bottom, right, top = box
        chars.append({'text': char, 'left': float(left), 'bottom': float(bottom),
                      'right': float(right), 'top': float(top), 'space': not char.strip()})
    return chars


def _page_rows(chars):
    """把字聚成**行带**（同一基线的一横排）。

    竖向重叠过半 ＝ 同一行带。**行带不等于行** —— 分栏时同一高度上有左右两段，
    切栏在下一步做（这里先把两段并在一行带里，才找得到「中间那道大空隙」）。
    """
    solid = [char for char in chars if not char['space']]
    ordered = sorted(solid, key=lambda char: (-char['bottom'], char['left']))
    rows = []
    for char in ordered:
        target = None
        for row in rows:
            overlap = min(row['top'], char['top']) - max(row['bottom'], char['bottom'])
            smaller = min(row['top'] - row['bottom'], char['top'] - char['bottom'])
            if smaller > 0 and overlap >= smaller * 0.5:
                target = row
                break
        if target is None:
            rows.append({'top': char['top'], 'bottom': char['bottom'], 'chars': [char]})
        else:
            target['top'] = max(target['top'], char['top'])
            target['bottom'] = min(target['bottom'], char['bottom'])
            target['chars'].append(char)
    for row in rows:
        row['chars'].sort(key=lambda char: char['left'])
        row['height'] = max(row['top'] - row['bottom'], 1.0)
    return rows


def _row_gaps(row):
    """行带内部的横向空隙：`[(中点, 宽度), …]`（按 x 从小到大）。"""
    gaps = []
    for previous, current in zip(row['chars'], row['chars'][1:]):
        size = current['left'] - previous['right']
        if size > 0:
            gaps.append(((current['left'] + previous['right']) / 2.0, size))
    return gaps


def _column_boundaries(rows, page_width):
    """找**栏与栏之间那道大空隙**（栏界）。

    判据：行带内部的大空隙（宽度超过页宽的一成）**在半数以上的行带里都出现**
    ⇒ 那是栏界（只在一两行出现的宽空隙多半是表格或标题，不算栏界）。
    """
    threshold = max(20.0, page_width * 0.06)
    rows_with_gap = 0
    buckets = {}
    for row in rows:
        hits = [gap for gap in _row_gaps(row) if gap[1] >= threshold]
        if not hits:
            continue
        rows_with_gap += 1
        for midpoint, _size in hits:
            key = int(midpoint // 5)
            buckets[key] = buckets.get(key, 0) + 1
    if not rows_with_gap:
        return []
    need = max(2, (len(rows) + 1) // 2)
    boundaries = []
    for key, count in buckets.items():
        if count >= need:
            boundaries.append(key * 5.0)
    return sorted(boundaries)


def _line_text(chars, height):
    """一行带的文字。

    **空格以 pdfium 给的空格字符为准**；只有在**空隙大到半个字高**、两侧又都是西文时
    才补一个空格 —— 阈值不能小：PDF 用的字体与 pdfium 替换字体宽度不同，
    字与字之间常有 0.1～0.3 倍字高的**假空隙**（实测会把 `202310123456.7` 拆成
    `20231 01 23456.7` ⇒ 申请号就认不出了）。
    """
    text = ''
    previous = None
    for char in chars:
        if char['space']:
            if text and not text.endswith(' '):
                text += ' '
            previous = char
            continue
        if previous is not None and not previous['space']:
            gap = char['left'] - previous['right']
            if gap > height * 0.5 and text and not text.endswith(' '):
                if ord(text[-1]) < 128 and ord(char['text'][0]) < 128:
                    text += ' '
        text += char['text']
        previous = char
    return text.strip()


def _page_lines(rows, boundaries, page_width):
    """行带 + 栏界 ⇒ **行**（每行属于某一栏）。

    · 行带内部**跨着栏界** ⇒ 这一行**横跨两栏**（比如整幅大标题）⇒ 不切，整行归它起始那一栏；
    · 行带内部**有栏界处的空隙** ⇒ 切成左右两段，各自成行。
    """
    threshold = max(20.0, page_width * 0.06)
    lines = []
    for row in rows:
        cuts = [midpoint for midpoint, size in _row_gaps(row)
                if size >= threshold and any(abs(midpoint - edge) <= 12.0 for edge in boundaries)]
        if not cuts:
            groups = [row['chars']]
        else:
            groups = []
            current = []
            for char in row['chars']:
                if current and any(char['left'] >= cut > current[-1]['right'] for cut in cuts):
                    groups.append(current)
                    current = [char]
                else:
                    current.append(char)
            if current:
                groups.append(current)
        for group in groups:
            text = _line_text(group, row['height'])
            if not text:
                continue
            column = sum(1 for edge in boundaries if group[0]['left'] >= edge)
            lines.append({
                'column': column,
                'y': row['bottom'],
                'x_start': group[0]['left'],
                'x_end': group[-1]['right'],
                'size': row['height'],
                'text': text,
            })
    return lines


def _paragraphs_of_column(lines):
    """一栏里的行**聚成段**：行距突然变大、或者这一行缩进 ⇒ 另起一段。"""
    if not lines:
        return []
    gaps = [lines[index - 1]['y'] - lines[index]['y'] for index in range(1, len(lines))]
    positive = [gap for gap in gaps if gap > 0]
    spacing = min(positive) if positive else 0.0
    threshold = max(spacing * 1.5, spacing + 6.0, 12.0)
    base_x = min(line['x_start'] for line in lines)
    groups = []
    previous = None
    for line in lines:
        indent = line['x_start'] - base_x
        new_group = previous is None
        if previous is not None:
            gap = previous['y'] - line['y']
            new_group = gap > threshold or indent >= max(6.0, 0.8 * line['size'])
        if new_group:
            groups.append([line])
        else:
            groups[-1].append(line)
        previous = line
    texts = []
    for group in groups:
        text = ''
        for line in group:
            text = _join(text, line['text']) if text else line['text']
        texts.append(text.strip())
    return [value for value in texts if value]


def _pdf_parts(content):
    """PDF ⇒ 段落分段（每段带页码 ＋ 页内段号）。

    **没有文字层的页**（扫描件／图片页）⇒ 记进 `unreadable_pages`，
    **不返回空段当内容**（空当内容 ＝ 假装读过了）。
    """
    import pypdfium2 as pdfium

    segments = []
    unreadable = []
    index = 0
    document = pdfium.PdfDocument(input=content)
    try:
        for page_no in range(len(document)):
            page = document[page_no]
            chars = _pdfium_page_chars(page)
            rows = _page_rows(chars)
            if not rows:
                unreadable.append(page_no + 1)
                continue
            width = float(page.get_width())
            boundaries = _column_boundaries(rows, width)
            lines = _page_lines(rows, boundaries, width)
            # 栏序还原：**左栏整栏读完，再读右栏**（不是先上后下）。
            for column in sorted({line['column'] for line in lines}):
                column_lines = sorted([line for line in lines if line['column'] == column],
                                      key=lambda line: (-line['y'], line['x_start']))
                for text in _paragraphs_of_column(column_lines):
                    index += 1
                    page_paragraph = len([item for item in segments if item.get('page') == page_no + 1]) + 1
                    segments.append({'kind': 'paragraph', 'page': page_no + 1,
                                    'paragraph': page_paragraph, 'index': index, 'text': text})
    finally:
        document.close()
    return {'kind': 'pdf', 'segments': segments, 'unreadable_pages': unreadable}


# ---------- DOCX / 文本 / 图片 ----------

def _docx_parts(content):
    """DOCX ⇒ 段落分段（带段号）。

    复用文件域自己的 DOCX 读取器（`document.decode`）—— **不另写一套 DOCX 解析**，
    也顺带继承它的安全处置（不解析 DTD/实体、限长）。
    """
    from shangshu_files import document

    opened = document.decode(content)
    segments = []
    for number, paragraph in enumerate(opened.get('paragraphs') or [], start=1):
        text = str(paragraph.get('text') or '').strip()
        if not text:
            continue
        segments.append({'kind': 'paragraph', 'paragraph': number,
                         'index': len(segments) + 1, 'text': text})
    return {'kind': 'docx', 'segments': segments, 'unreadable_pages': []}


def _xml_text(content):
    """XML ⇒ **取文本节点**（不是把标记当内容）。

    **不许解析外部实体**（XXE）：用禁外部实体的解析器，解析不了就**明说抽不出**。
    """
    from xml.etree import ElementTree

    parser = ElementTree.XMLParser()
    try:
        # 禁外部实体与 DTD（defusedxml 若在则优先用）
        try:
            from defusedxml.ElementTree import fromstring as _safe_fromstring
        except ImportError:
            _safe_fromstring = None
        if _safe_fromstring is not None:
            root = _safe_fromstring(content)
        else:
            root = ElementTree.fromstring(content)
    except Exception as error:  # noqa: BLE001 —— 解析不了就明说，不猜
        raise ValueError('这份 XML 解析不出文字（%s）' % str(error)[:120])
    return '\n'.join(piece.strip() for piece in root.itertext() if piece.strip())


def _text_parts(content, extension=''):
    """文本类 ⇒ 行分段（带行号）。编码兜底：`utf-8-sig` → `gb18030`；XML 取文本节点。"""
    if extension == '.xml':
        text = _xml_text(content)
    else:
        try:
            text = content.decode('utf-8-sig')
        except UnicodeDecodeError:
            text = content.decode('gb18030')
    segments = []
    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        segments.append({'kind': 'line', 'line': number, 'index': len(segments) + 1, 'text': stripped})
    return {'kind': 'text', 'segments': segments, 'unreadable_pages': []}


def _image_parts():
    """图片 ⇒ **没有文字**（明说，不当空内容）。"""
    return {'kind': 'image', 'segments': [], 'unreadable_pages': [1]}


def document_parts(name, content):
    """按扩展名分流：PDF / DOCX / 文本 / 图片。

    回包：`{'kind', 'segments', 'unreadable_pages'}`。
    """
    extension = '.' + str(name or '').rsplit('.', 1)[-1].lower()
    if extension in PDF_EXTENSIONS:
        return _pdf_parts(content)
    if extension in DOCX_EXTENSIONS:
        return _docx_parts(content)
    if extension in TEXT_EXTENSIONS:
        return _text_parts(content, extension)
    if extension in IMAGE_EXTENSIONS:
        return _image_parts()
    raise ValueError('这份文件抽不出正文（当前支持 PDF、DOCX、文本（含 XML）与图片）')


# ---------- 公开服务 ----------

def _note_of(parts):
    """没有文字层的页 ⇒ **明说哪几页抽不出、请人工填**。"""
    pages = parts.get('unreadable_pages') or []
    if not pages:
        return ''
    listed = '、'.join(str(page) for page in pages)
    if parts.get('kind') == 'image':
        return '这份文件是图片，没有文字层 —— 请人工填正文。'
    return ('第 %s 页抽不出文字（这一页没有文字层，可能是扫描件或图片页）'
            '—— 请人工填这几页的原文。本服务不做 OCR，也不把文件外发。' % listed)


def read_text(_service, payload, context):
    """`files.document_text`：读**受管文件**的正文分段。

    读权：走 `files.versions`（谁能读这个文件才能读它的正文）。
    版本：读**当前固定版本**（回包说清取到的是哪一版）。
    原件：只读受管私有原件；**哈希对不上当场拒**。
    """
    from shangshu_files.domain import versions

    file_name = str((payload or {}).get('file') or '').strip()
    if not file_name:
        frappe.throw('请选择要读正文的文件', frappe.ValidationError)
    start = (payload or {}).get('start', 1)
    limit = (payload or {}).get('limit', DEFAULT_LIMIT)
    if type(start) is not int or start < 1:
        frappe.throw('起始段号无效（从 1 起）', frappe.ValidationError)
    if type(limit) is not int or not 1 <= limit <= MAX_LIMIT:
        frappe.throw('每次最多读取 %d 段' % MAX_LIMIT, frappe.ValidationError)

    # 读权 + 当前固定版本都走既有那条口（**不另设一套读权**）。
    history = versions('files.versions', {'file': file_name}, context)
    current = history.get('current') or {}
    frappe_file = current.get('frappe_file')
    if not frappe_file:
        frappe.throw('这份文件还没有可读的固定版本', frappe.ValidationError)
    file_doc = frappe.get_doc('File', frappe_file)
    if not file_doc.get('is_private') or not str(file_doc.get('file_url') or '').startswith('/private/files/'):
        frappe.throw('只读取受管私有原件', frappe.PermissionError)
    content = file_doc.get_content()
    if not isinstance(content, bytes):
        content = str(content).encode('utf-8')
    if len(content) > MAX_FILE_BYTES:
        frappe.throw('文件超过 20MB，请下载原件核对', frappe.ValidationError)
    digest = hashlib.sha256(content).hexdigest()
    expected = str(current.get('sha256') or '')
    if expected and digest != expected:
        frappe.throw('原件哈希已变化，请核对文件', frappe.ValidationError)

    cache_key = 'files:document:text:%s:%s' % (PARSER_VERSION, digest)
    parts = frappe.cache().get_value(cache_key)
    if parts is None:
        try:
            parts = document_parts(history['file']['file_name'], content)
        except Exception as error:  # noqa: BLE001 —— 抽不出就明说
            frappe.throw('正文抽取失败：%s' % error, frappe.ValidationError)
        frappe.cache().set_value(cache_key, parts, expires_in_sec=CACHE_TTL)

    segments = parts.get('segments') or []
    total = len(segments)
    selected = []
    for segment in segments[start - 1:start - 1 + limit]:
        text = str(segment.get('text') or '')
        item = dict(segment)
        if len(text) > MAX_SEGMENT_CHARS:
            item['text'] = text[:MAX_SEGMENT_CHARS]
            item['truncated'] = True
        selected.append(item)
    next_start = start + len(selected) if start + len(selected) < total else None
    version_no = None
    for row in history.get('versions') or []:
        if row.get('frappe_file') == frappe_file:
            version_no = int(row.get('version_no') or 0)
            break
    unreadable = parts.get('unreadable_pages') or []
    return {
        'file': file_name,
        'file_name': history['file']['file_name'],
        'version': version_no,
        'content_revision': current.get('content_revision'),
        'sha256': digest,
        'kind': parts.get('kind'),
        'segments': selected,
        'total_segments': total,
        'start': start,
        'next_start': next_start,
        'truncated': next_start is not None,
        'total_chars': sum(len(str(item.get('text') or '')) for item in segments),
        'unreadable_pages': unreadable,
        'read_state': 'needs_manual' if unreadable else 'read',
        'note': _note_of(parts),
        'llm_calls': 0,
    }
