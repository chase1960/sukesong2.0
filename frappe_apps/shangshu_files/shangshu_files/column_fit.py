"""按内容自动算列宽（纯函数）。

口径：
- 宽度的单位是 xlsx 的 **excel-char**（一个字符宽 ≈ 默认字体的一个字符）。
- 中日韩字符**占两格**（一个汉字在默认字体里比一个拉丁字母宽）。
- 算宽时给内容留 **2 格** 余量（不然最后一个字会贴着边框）。
- 太窄的列不低于 6 格、太宽的不超过 255 格（xlsx 的上限）。
"""


def display_width(text):
    """文本占几格（中日韩字符算两格）。"""
    if text is None:
        return 0
    if not isinstance(text, str):
        text = str(text)
    total = 0
    for char in text:
        total += 2 if _is_wide(char) else 1
    return total


def _is_wide(char):
    code = ord(char)
    return (
        0x1100 <= code <= 0x115F          # 韩文字母
        or 0x2E80 <= code <= 0xA4CF        # 汉字、假名、注音
        or 0xAC00 <= code <= 0xD7A3        # 韩文音节
        or 0xF900 <= code <= 0xFAFF        # 兼容汉字
        or 0xFE30 <= code <= 0xFE6F        # 竖排标点
        or 0xFF00 <= code <= 0xFF60        # 全角字符
        or 0xFFE0 <= code <= 0xFFE6        # 全角符号
    )


def fit_width(texts, padding=2, min_width=6, max_width=255):
    """按一批文本算列宽（excel-char）。空内容也给一个最小宽度。"""
    widest = 0
    for text in texts or []:
        if text is None:
            continue
        width = display_width(text)
        if width > widest:
            widest = width
    result = widest + padding
    if result < min_width:
        result = min_width
    if result > max_width:
        result = max_width
    return result
