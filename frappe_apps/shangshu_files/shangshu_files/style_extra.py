"""单元格扩展格式：填充色、斜体、下划线、水平/垂直对齐、清除格式。

这里是**纯函数**：不依赖 frappe，也不碰 xlsx 的读写（与 style_border.py 同一口径）。
理由与 style_border 一样：这些是产品口径（用户挑的是「填充黄底」「居中」），
规则必须能被单独读懂、单独测，所以从 sheet.py 里拆出来放在这里，由 sheet.py 调用。

口径：
- 填充色：'#RRGGBB'（写进 xlsx 是 ARGB，前缀 FF）；'none' = 去掉填充。
- 水平对齐：left / center / right；'none' = 回到默认。
- 垂直对齐：top / center / bottom；'none' = 回到默认。
- 斜体 / 下划线：布尔，False = 去掉该属性（与加粗同一口径）。
- 清除格式：整格回到工作簿默认格式（常规、无填充、无边框、无对齐、默认字体）。
"""
import re

# 「没这项设置」与「这项设置清空」是两件事，用哨兵分开。
UNSET = object()

HORIZONTAL_ALIGNS = ('left', 'center', 'right')
VERTICAL_ALIGNS = ('top', 'center', 'bottom')
EXTRA_KEYS = ('fill_color', 'italic', 'underline', 'horizontal_align', 'vertical_align', 'clear_format')
NONE = 'none'


def _element(raw):
    """把带命名空间前缀的片段解析成元素（只读用，不回写原字节）。"""
    import xml.etree.ElementTree as ET
    return ET.fromstring(re.sub(rb'(<\/?)[A-Za-z_][\w.-]*:', rb'\1', raw))


def normalize_fill_color(value):
    """'#rrggbb' → '#RRGGBB'；'none'/None → None（清掉填充）；别的 → ValueError。"""
    if value is None or value == NONE:
        return None
    if not isinstance(value, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', value):
        raise ValueError('填充色须为 #RRGGBB')
    return value.upper()


def normalize_align(key, value):
    """对齐方式归一；'none'/None → None（清掉对齐）。"""
    if value is None or value == NONE:
        return None
    allowed = HORIZONTAL_ALIGNS if key == 'horizontal_align' else VERTICAL_ALIGNS
    if value not in allowed:
        raise ValueError('对齐方式无效（水平：左/中/右；垂直：上/中/下）')
    return value


def build_fill_xml(prefix, color):
    """实心填充色 → <fill> 片段（OOXML：fgColor 是前景实色，bgColor 用 indexed 64）。"""
    rgb = re.fullmatch(r'#[0-9A-F]{6}', color or '')
    if not rgb:
        raise ValueError('填充色须为 #RRGGBB')
    return (b'<' + prefix + b'fill><' + prefix + b'patternFill patternType="solid">'
            b'<' + prefix + b'fgColor rgb="FF' + color[1:].encode() + b'"/>'
            b'<' + prefix + b'bgColor indexed="64"/>'
            b'</' + prefix + b'patternFill></' + prefix + b'fill>')


def fill_color_of(raw):
    """<fill> 片段 → '#RRGGBB' 或 None（没有实心填充）。"""
    try:
        element = _element(raw)
    except Exception:
        return None
    pattern = next((x for x in element if x.tag.rsplit('}', 1)[-1] == 'patternFill'), None)
    if pattern is None or (pattern.get('patternType') or 'none') == 'none':
        return None
    fg = next((x for x in pattern if x.tag.rsplit('}', 1)[-1] == 'fgColor'), None)
    rgb = fg.get('rgb') if fg is not None else None
    if rgb and re.fullmatch(r'[0-9A-Fa-f]{6,8}', rgb):
        return '#' + rgb[-6:].upper()
    return None


def font_flags_of(raw):
    """<font> 片段 → {'italic': bool, 'underline': bool}。"""
    try:
        font = _element(raw)
    except Exception:
        return {'italic': False, 'underline': False}
    find = lambda name: next((node for node in font if node.tag.rsplit('}', 1)[-1] == name), None)
    italic = find('i')
    underline = find('u')
    return {
        'italic': italic is not None and italic.get('val', '1').lower() not in ('0', 'false'),
        'underline': underline is not None and underline.get('val', 'single').lower() not in ('none', 'false'),
    }


def patch_font_flags(raw, italic=UNSET, underline=UNSET):
    """在 <font> 上加/去 <i/> 与 <u/>。False = 整个去掉（与加粗同一口径）。"""
    prefix_match = re.match(rb'<((?:[A-Za-z_][\w.-]*:)?)font\b', raw)
    if not prefix_match:
        raise ValueError('字体定义无法安全修改')
    prefix = prefix_match.group(1)
    if raw.rstrip().endswith(b'/>'):
        raw = raw.rstrip()[:-2] + b'></' + prefix + b'font>'
    for name, value in (('i', italic), ('u', underline)):
        if value is UNSET:
            continue
        pattern = (rb'<(?:[A-Za-z_][\w.-]*:)?' + name.encode() +
                   rb'\b[^>]*?(?:/>|>.*?</(?:[A-Za-z_][\w.-]*:)?' + name.encode() + rb'\s*>)')
        raw = re.sub(pattern, b'', raw, flags=re.S)
        if value:
            node = b'<' + prefix + name.encode() + (b' val="single"/>' if name == 'u' else b'/>')
            closing = raw.rfind(b'</')
            raw = raw[:closing] + node + raw[closing:]
    return raw


def alignment_view(xf):
    """<xf> 片段 → {'horizontal_align': ..., 'vertical_align': ...}（没设置就是 None）。"""
    try:
        element = _element(xf)
    except Exception:
        return {'horizontal_align': None, 'vertical_align': None}
    alignment = next((x for x in element if x.tag.rsplit('}', 1)[-1] == 'alignment'), None)
    if alignment is None:
        return {'horizontal_align': None, 'vertical_align': None}
    horizontal = alignment.get('horizontal')
    vertical = alignment.get('vertical')
    return {
        'horizontal_align': horizontal if horizontal in HORIZONTAL_ALIGNS else None,
        'vertical_align': vertical if vertical in VERTICAL_ALIGNS else None,
    }


def set_alignment(xf, horizontal=UNSET, vertical=UNSET, wrap=UNSET):
    """改 <xf> 上的 alignment：设置或**去掉**某个对齐属性（'none' → 去掉）。

    去掉后如果 alignment 元素空了，整个元素也去掉（回到默认格式的样子）。
    """
    prefix_match = re.match(rb'<((?:[A-Za-z_][\w.-]*:)?)xf\b', xf)
    if not prefix_match:
        raise ValueError('单元格格式无法安全修改')
    prefix = prefix_match.group(1)
    if xf.rstrip().endswith(b'/>'):
        xf = xf.rstrip()[:-2] + b'>' + b'</' + prefix + b'xf>'
    pattern = rb'<(?:[A-Za-z_][\w.-]*:)?alignment\b[^>]*?(?:/>|>.*?</(?:[A-Za-z_][\w.-]*:)?alignment\s*>)'
    found = re.search(pattern, xf, re.S)
    if found:
        block = found.group(0)
        attributes = dict(re.findall(rb'\b([A-Za-z]+)=["\']([^"\']*)["\']', block))
        head, inner = block.split(b'>', 1) if b'>' in block else (block, b'')
        has_close = inner.endswith(b'</' + prefix + b'alignment>')
        if has_close:
            inner = inner[:-(len(b'</' + prefix + b'alignment>'))]
        for name, value in (('horizontal', horizontal), ('vertical', vertical), ('wrapText', wrap)):
            if value is UNSET:
                continue
            attributes.pop(name.encode(), None)
            if value is None:
                continue
            if name == 'wrapText':
                attributes[b'wrapText'] = b'1' if value else b'0'
            else:
                attributes[name.encode()] = value.encode()
        if attributes:
            rendered = b'<' + prefix + b'alignment'
            for key, value in attributes.items():
                rendered += b' ' + key + b'="' + value + b'"'
            rendered += b'/>'
            xf = xf[:found.start()] + rendered + xf[found.end():]
        else:
            xf = xf[:found.start()] + xf[found.end():]
    else:
        attributes = {}
        for name, value in (('horizontal', horizontal), ('vertical', vertical), ('wrapText', wrap)):
            if value is UNSET or value is None:
                continue
            attributes[name.encode()] = b'1' if name == 'wrapText' and value else (b'0' if name == 'wrapText' else value.encode())
        if attributes:
            node = b'<' + prefix + b'alignment'
            for key, value in attributes.items():
                node += b' ' + key + b'="' + value + b'"'
            node += b'/>'
            anchor = re.search(rb'<(?:[A-Za-z_][\w.-]*:)?(?:protection|extLst)\b', xf)
            at = anchor.start() if anchor else xf.rfind(b'</')
            xf = xf[:at] + node + xf[at:]
    if horizontal is not UNSET or vertical is not UNSET or wrap is not UNSET:
        xf = _set_attr(xf, b'applyAlignment', b'1')
    return xf


def _set_attr(xf, name, value):
    head, rest = xf.split(b'>', 1)
    pattern = rb'\s' + name + rb'=[\'"][^\'"]*[\'"]'
    attr = b' ' + name + b'="' + value + b'"'
    if re.search(pattern, head):
        head = re.sub(pattern, lambda _m: attr, head, count=1)
    else:
        at = -1 if head.endswith(b'/') else len(head)
        head = head[:at] + attr + head[at:]
    return head + b'>' + rest


def normalize_extra_patch(patch):
    """校验并归一扩展样式补丁。非法 → ValueError（中文提示）。"""
    if not isinstance(patch, dict):
        raise ValueError('样式设置格式无效')
    result = {}
    if 'fill_color' in patch:
        result['fill_color'] = normalize_fill_color(patch['fill_color'])
    for key in ('italic', 'underline'):
        if key in patch:
            if not isinstance(patch[key], bool):
                raise ValueError('斜体/下划线设置无效')
            result[key] = patch[key]
    for key in ('horizontal_align', 'vertical_align'):
        if key in patch:
            result[key] = normalize_align(key, patch[key])
    if 'clear_format' in patch:
        if not isinstance(patch['clear_format'], bool):
            raise ValueError('清除格式设置无效')
        if not patch['clear_format']:
            raise ValueError('清除格式只能设为「是」')
        others = [key for key in patch if key != 'clear_format']
        if others:
            raise ValueError('清除格式不能与其他设置同时使用，请分两步做')
        result['clear_format'] = True
    return result


def verify_extra_after(after, expected):
    """写后核验：读回来的格式必须与请求一致，不一致就报错（整批不保存）。"""
    for key, value in expected.items():
        if key == 'clear_format':
            continue
        if after.get(key) != value:
            raise ValueError('格式属性写后核验失败，本批未保存')
    return True


def verify_cleared_after(after, default):
    """清除格式的核验：整格回到工作簿默认格式。"""
    for key in ('bold', 'italic', 'underline'):
        if after.get(key):
            raise ValueError('清除格式后仍有字体属性，本批未保存')
    if after.get('fill_color'):
        raise ValueError('清除格式后仍有填充色，本批未保存')
    if after.get('horizontal_align') or after.get('vertical_align'):
        raise ValueError('清除格式后仍有对齐设置，本批未保存')
    if after.get('number_format') not in (None, 'General'):
        raise ValueError('清除格式后仍有数字格式，本批未保存')
    for edge in (after.get('border') or {}).values():
        if edge and edge.get('style'):
            raise ValueError('清除格式后仍有边框，本批未保存')
    if default.get('font_size') is not None and after.get('font_size') != default.get('font_size'):
        raise ValueError('清除格式后字体与默认不一致，本批未保存')
    return True
