"""单元格边框：预设 → 每一格各画哪几条边、什么线型、什么颜色。

这里是**纯函数**：不依赖 frappe，也不碰 xlsx 的读写。
理由：外框/内框/单边这套规则是产品口径（用户在界面上挑的是"外框"，
不是"给每格写四条边"），规则必须能被单独读懂、单独测，
所以从 sheet.py 里拆出来放在这里，由 sheet.py 调用。

边序按 OOXML CT_Border 的要求：left, right, top, bottom, diagonal。
"""
import re

BORDER_SIDES = ('left', 'right', 'top', 'bottom')

# 线型名 → xlsx styles.xml 里的 border style 编号（与前端 fontStyleToUniver 同一张表）。
BORDER_STYLE_CODES = {
    'thin': 1, 'hair': 2, 'dotted': 3, 'dashed': 4, 'dashDot': 5, 'dashDotDot': 6,
    'double': 7, 'medium': 8, 'mediumDashed': 9, 'mediumDashDot': 10,
    'mediumDashDotDot': 11, 'slantDashDot': 12, 'thick': 13,
}

# 界面上能挑的预设。'outer'/'inner' 是**按选区**算的，不是按格子算的。
BORDER_PRESETS = ('none', 'all', 'outer', 'inner', 'top', 'bottom', 'left', 'right')

DEFAULT_BORDER_STYLE = 'thin'
DEFAULT_BORDER_COLOR = '#D1D5DB'


def normalize_border(patch):
    """把 border 补丁归一成 {'preset', 'style', 'color'}。

    旧口径 'none' / 'all' 仍然接受（别的调用方可能还在用），但一律归一，
    下游只认 preset。
    """
    if isinstance(patch, str):
        if patch not in ('none', 'all'):
            raise ValueError('边框仅支持 none、all 或边框预设')
        return {'preset': patch, 'style': DEFAULT_BORDER_STYLE, 'color': DEFAULT_BORDER_COLOR}
    if not isinstance(patch, dict) or not patch:
        raise ValueError('边框设置格式无效')
    unknown = set(patch) - {'preset', 'style', 'color'}
    if unknown:
        raise ValueError('边框设置含不支持的项：' + '、'.join(sorted(unknown)))
    preset = patch.get('preset')
    if preset not in BORDER_PRESETS:
        raise ValueError('边框预设须为：' + '、'.join(BORDER_PRESETS))
    style = patch.get('style') or DEFAULT_BORDER_STYLE
    if style not in BORDER_STYLE_CODES:
        raise ValueError('边框线型不受支持：' + str(style))
    color = patch.get('color') or DEFAULT_BORDER_COLOR
    if not isinstance(color, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
        raise ValueError('边框颜色须为 #RRGGBB')
    return {'preset': preset, 'style': style, 'color': color.upper()}


def edges_for_cell(preset, style, color, col, row, bounds):
    """这一格该画哪几条边。

    bounds = (min_col, max_col, min_row, max_row)，即整个选区的包围盒。
    'outer' 只画选区**外围**，'inner' 只画选区**内部**分隔线，
    'all' 给每格都画四边——跟用户在 Excel 里看到的预览一致。
    """
    min_col, max_col, min_row, max_row = bounds
    sides = set()
    if preset == 'none':
        return {}
    if preset == 'all':
        sides = set(BORDER_SIDES)
    elif preset == 'outer':
        if row == min_row:
            sides.add('top')
        if row == max_row:
            sides.add('bottom')
        if col == min_col:
            sides.add('left')
        if col == max_col:
            sides.add('right')
    elif preset == 'inner':
        if row > min_row:
            sides.add('top')
        if row < max_row:
            sides.add('bottom')
        if col > min_col:
            sides.add('left')
        if col < max_col:
            sides.add('right')
    elif preset == 'top':
        if row == min_row:
            sides.add('top')
    elif preset == 'bottom':
        if row == max_row:
            sides.add('bottom')
    elif preset == 'left':
        if col == min_col:
            sides.add('left')
    elif preset == 'right':
        if col == max_col:
            sides.add('right')
    return {side: {'style': style, 'color': color} for side in BORDER_SIDES if side in sides}


def build_border_xml(prefix, edges):
    """按 OOXML 的 CT_Border 顺序拼出边框定义。

    prefix 是命名空间前缀（如 b'' 或 b'x:'），与既有 styles.xml 保持一致。
    """
    prefix = prefix or b''
    parts = []
    for side in BORDER_SIDES:
        edge = (edges or {}).get(side) or {}
        style = edge.get('style')
        if not style:
            parts.append(b'<' + prefix + side.encode() + b'/>')
            continue
        rgb = 'FF' + str(edge.get('color') or DEFAULT_BORDER_COLOR).lstrip('#').upper()
        parts.append(
            b'<' + prefix + side.encode() + b' style="' + style.encode() + b'">'
            b'<' + prefix + b'color rgb="' + rgb.encode() + b'"/>'
            b'</' + prefix + side.encode() + b'>')
    return b'<' + prefix + b'border>' + b''.join(parts) + b'<' + prefix + b'diagonal/></' + prefix + b'border>'


def verify_border_after(actual, expected):
    """写后核验：读回来的边必须和请求一致，否则这一批不保存。

    actual 是从保存后的 xlsx 读回的 {side: {'style','color'}}，
    expected 是请求的 {side: {'style','color'}}（没画的边不出现）。
    """
    for side in BORDER_SIDES:
        want = (expected or {}).get(side) or {}
        got = ((actual or {}).get(side) or {})
        want_style = want.get('style') or None
        got_style = got.get('style') or None
        if want_style != got_style:
            raise ValueError('边框写后核验失败，本批未保存')
        if want_style:
            want_color = str(want.get('color') or '').upper()
            got_color = str(got.get('color') or '').upper()
            if want_color != got_color:
                raise ValueError('边框写后核验失败，本批未保存')
