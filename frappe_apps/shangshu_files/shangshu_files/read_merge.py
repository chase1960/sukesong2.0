"""读路径合并：把晋升列的**数据库正式值**合并进读回的行。

这里是**纯函数**：不依赖 frappe，也不碰 xlsx 的读写。
理由：合并口径是产品口径（"这一格到底以谁为准"），必须能被单独读懂、单独测，
所以从 promotion.py 里拆出来放在这里，由 promotion.py 与 service.py 共同调用。

**口径（与 `files.row_read` 一份，不许两处各写一套）**：
- 晋升列（有数据库字段的那种）：以**数据库正式值**为准；
- 普通列：以**表里的值**为准；
- 两边**不互相覆盖** —— 数据库改了不影响普通列，表里的旧值也盖不掉正式值；
- **无权查看的列**（字段 ACL 挡住）：值一个字节不给，键留着标 `hidden`。
"""


def promoted_by_header(columns):
    """表头 → 晋升列定义。**只认 promoted 且有 field 的列**（普通列不进字段 ACL）。

    表头按**去空格后的名字**对齐（和 `promotion.column_by_header` 同一把尺子），
    找不到就是找不到，不猜最接近的那个。
    """
    out = {}
    for col in columns or []:
        if not isinstance(col, dict):
            continue
        if not (col.get('promoted') and col.get('field')):
            continue
        header = str(col.get('header') or '').strip()
        if header:
            out[header] = col
    return out


def is_hidden(value):
    """这一格是不是**被权限挡住**的（`hidden`）。挡住的格不给值，也不许被合并覆盖。"""
    return isinstance(value, dict) and (value.get('hidden') is True or value.get('type') == 'hidden')


def merge_row_values(values, formal_row, promoted, denied=()):
    """把一行的数据库正式值合并进表里读出来的值。

    `values`     表里读出来的一行：{表头: {type, value}}
    `formal_row` 这一行在数据库侧的事实：{字段 id: 值}
    `promoted`   `promoted_by_header` 的结果
    `denied`     明确读不到的表头集合（字段 ACL 挡住的那几列）

    返回 `(合并后的值, 来源映射)`。来源映射的值是：
    `database`（来自数据库正式值）/ `sheet`（来自表）/ `denied`（无权查看）。
    """
    denied = set(denied or ())
    merged = {}
    source = {}
    for header, value in (values or {}).items():
        if header in denied or is_hidden(value):
            # 无权查看：键留着、值不给，也不许正式值把它顶开。
            merged[header] = {'type': 'hidden', 'value': None, 'hidden': True}
            source[header] = 'denied'
            continue
        col = promoted.get(header)
        field = col.get('field') if col else None
        if field and field in (formal_row or {}):
            merged[header] = {'type': col.get('type') or 'text', 'value': formal_row.get(field)}
            source[header] = 'database'
        else:
            merged[header] = value if value else {'type': 'empty', 'value': None}
            source[header] = 'sheet'
    return merged, source


def merge_rows(rows, formal, promoted, denied=()):
    """批量合并：把每一行的正式值合并进表值。

    `rows`   读回的行：[{row_id, values, ...}]
    `formal` 数据库侧事实：{行 id: {字段 id: 值}}

    返回 `(合并后的行, 每行的来源映射)`。行里**没有**这一行的正式值时，
    那一行的值照旧是表里的（不凭空造值），来源标 `sheet`。
    每一行都带 `source`（表头 → 来源），模型据此知道这一格以谁为准。
    """
    out_rows = []
    sources = {}
    for row in rows or []:
        row_id = str(row.get('row_id') or '')
        formal_row = (formal or {}).get(row_id) or {}
        merged, source = merge_row_values(row.get('values') or {}, formal_row, promoted, denied=denied)
        item = dict(row)
        item['values'] = merged
        item['source'] = source
        out_rows.append(item)
        sources[row_id] = source
    return out_rows, sources
