"""成包编辑的**纯规则**：查找替换、填充序列、选择性粘贴。

与 style_extra / column_fit 同一口径 —— **不依赖 frappe、不碰 xlsx 读写**：
这里只回答「要写什么、写成什么样」；写到哪一格、怎么落盘、怎么撤回，
由 sheet.py 接到既有受管写路径上。

拆出来的理由：这几条是**产品口径**（用户挑的是「只贴格式」「步长 2」「区分大小写」），
规则必须能单独读懂、单独测，不能埋在一大段写盘代码里。

口径：
- 查找替换：只改**命中**的格。子串替换 / 整格替换、区分 / 不区分大小写。
  公式格替换的是公式**文本**里的命中片段，写回后仍是公式。
- 填充序列：等差（linear）、日期（date）、列表（list）、复制（copy）。
  给了终止值就到终止值为止（不越界）。
- 选择性粘贴：三种模式互斥 —— 只贴值（values）、只贴公式（formulas）、只贴格式（formats）。
  「跳过空」只对值/公式两种模式有意义：源格为空就不动目标格。
"""
import datetime

PASTE_MODES = ('values', 'formulas', 'formats')
SERIES_TYPES = ('linear', 'date', 'list', 'copy')
DATE_UNITS = ('day', 'week', 'month', 'year')


def replace_in_text(text, find, replace, match_case=False, whole_cell=False):
    """文本里的查找替换。命中返回新文本，**没命中返回 None**（不是原样返回 —— 那是两回事）。

    - whole_cell：只有整格内容等于查找内容才替换（整格换成新内容）。
    - match_case：区分大小写；不区分时**只替换命中的那些**，其余字符原样保留。
    """
    if not isinstance(text, str):
        return None
    if not find:
        raise ValueError('查找内容不能为空')
    if whole_cell:
        hit = (text == find) if match_case else (text.lower() == find.lower())
        return replace if hit else None
    if match_case:
        return text.replace(find, replace) if find in text else None
    low_text, low_find = text.lower(), find.lower()
    out, index, changed = [], 0, False
    while True:
        at = low_text.find(low_find, index)
        if at < 0:
            out.append(text[index:])
            break
        out.append(text[index:at])
        out.append(replace)
        index = at + len(find)
        changed = True
    return ''.join(out) if changed else None


def plan_find_replace(cells, find, replace, match_case=False, whole_cell=False):
    """整表扫描后的命中计划。

    cells: [{'row_id', 'header', 'text', 'kind'}]（kind: text / formula）。
    返回 [{'row_id', 'header', 'kind', ...}]：命中的才有，没命中的不进单子。
    """
    changes = []
    for cell in cells or []:
        new_text = replace_in_text(cell.get('text'), find, replace, match_case, whole_cell)
        if new_text is None:
            continue
        kind = cell.get('kind') or 'text'
        item = {'row_id': cell.get('row_id'), 'header': cell.get('header'), 'kind': kind}
        if kind == 'formula':
            item['formula'] = new_text
        else:
            item['text'] = new_text
        changes.append(item)
    return changes


def _add_months(date_value, months):
    """加月份：目标月没有这一天就落到该月最后一天（1 月 31 日 + 1 月 = 2 月 28 日）。"""
    total = date_value.month - 1 + months
    year = date_value.year + total // 12
    month = total % 12 + 1
    if month == 12:
        next_month = date_value.replace(year=year + 1, month=1, day=1)
    else:
        next_month = date_value.replace(year=year, month=month + 1, day=1)
    last_day = (next_month - datetime.timedelta(days=1)).day
    return date_value.replace(year=year, month=month, day=min(date_value.day, last_day))


def _shift_date(date_value, step, unit):
    if unit == 'day':
        return date_value + datetime.timedelta(days=step)
    if unit == 'week':
        return date_value + datetime.timedelta(days=step * 7)
    if unit == 'month':
        return _add_months(date_value, step)
    if unit == 'year':
        return _add_months(date_value, step * 12)
    raise ValueError('日期步长单位无效（可选：日、周、月、年）')


def compute_series(spec, count):
    """按规格算一串填充值。返回 [{'type', 'value'}]，长度 = count（受终止值限制可能更短）。"""
    spec = spec or {}
    kind = str(spec.get('type') or '')
    if kind not in SERIES_TYPES:
        raise ValueError('填充方式无效（可选：等差、日期、列表、复制）')
    try:
        count = int(count)
    except (TypeError, ValueError):
        raise ValueError('填充格数无效')
    if count <= 0:
        return []
    if kind == 'linear':
        start = spec.get('start')
        if isinstance(start, bool) or not isinstance(start, (int, float)):
            raise ValueError('等差填充的起始值须为数字')
        try:
            step = float(spec.get('step') if spec.get('step') is not None else 1)
        except (TypeError, ValueError):
            raise ValueError('等差填充的步长须为数字')
        stop = spec.get('stop')
        stop = float(stop) if isinstance(stop, (int, float)) and not isinstance(stop, bool) else None
        values = []
        for index in range(count):
            value = start + step * index
            if stop is not None and ((step >= 0 and value > stop) or (step < 0 and value < stop)):
                break
            values.append({'type': 'number', 'value': value})
        return values
    if kind == 'date':
        start = spec.get('start')
        try:
            base = datetime.date.fromisoformat(str(start)[:10])
        except (TypeError, ValueError):
            raise ValueError('日期填充的起始日期无效（须为 YYYY-MM-DD）')
        try:
            step = int(spec.get('step') if spec.get('step') is not None else 1)
        except (TypeError, ValueError):
            raise ValueError('日期填充的步长须为整数')
        unit = str(spec.get('unit') or 'day')
        if unit not in DATE_UNITS:
            raise ValueError('日期步长单位无效（可选：日、周、月、年）')
        values = []
        for index in range(count):
            values.append({'type': 'date', 'value': _shift_date(base, step * index, unit).isoformat()})
        return values
    if kind == 'list':
        source = spec.get('values')
        if not isinstance(source, list) or not source:
            raise ValueError('列表填充须给出一个非空的候选清单')
        return [{'type': 'text', 'value': str(source[index % len(source)])} for index in range(count)]
    start = spec.get('start')
    if isinstance(start, bool):
        start = str(start)
    if isinstance(start, (int, float)):
        return [{'type': 'number', 'value': start} for _ in range(count)]
    return [{'type': 'text', 'value': '' if start is None else str(start)} for _ in range(count)]


def _value_of(source, mode):
    """源格 → 要写入的 typed 值。"""
    kind = str(source.get('kind') or 'text')
    if mode == 'formulas' and kind == 'formula':
        return {'type': 'formula', 'formula': source.get('formula') or ''}
    if kind == 'formula':
        # 只贴值：公式格贴它的**显示结果**（不再是公式）。
        return {'type': 'text', 'value': '' if source.get('display') is None else str(source.get('display'))}
    if kind == 'number':
        return {'type': 'number', 'value': source.get('value')}
    if kind == 'date':
        return {'type': 'date', 'value': str(source.get('value') or '')[:10]}
    if kind == 'empty':
        return {'type': 'empty', 'value': None}
    return {'type': 'text', 'value': '' if source.get('value') is None else str(source.get('value'))}


def translate_formula(formula, origin, target):
    """公式从源格挪到目标格：**相对引用跟着挪**（Excel 粘贴公式的语义）。

    不挪的话，贴过去的公式还指着源格 —— 看着像搬了家，其实算的还是老地方。
    挪不了（非法公式、数组公式等）就**原样返回**：不猜，也不静默改坏公式。
    """
    if not isinstance(formula, str) or not formula.startswith('='):
        return formula
    try:
        from openpyxl.formula.translate import Translator
        return Translator(formula, origin=origin).translate_formula(target)
    except Exception:
        return formula


def plan_paste_special(source_cells, mode, skip_empty=False):
    """选择性粘贴的落点计划。

    source_cells: [{'kind', 'value', 'formula', 'display', 'style_id'}]（源区域逐格）。
    返回 [{'index', 'kind': 'value'|'style', ...}]：
    - values/formulas 模式产出 'value' 项（带 typed 值）；
    - formats 模式产出 'style' 项（带源格的样式编号）。
    """
    if mode not in PASTE_MODES:
        raise ValueError('粘贴方式无效（可选：只贴值、只贴公式、只贴格式）')
    plan = []
    for index, source in enumerate(source_cells or []):
        kind = str(source.get('kind') or 'text')
        if mode == 'formats':
            plan.append({'index': index, 'kind': 'style', 'style_id': int(source.get('style_id') or 0)})
            continue
        if kind == 'empty' and skip_empty:
            continue
        plan.append({'index': index, 'kind': 'value', 'value': _value_of(source, mode)})
    return plan
