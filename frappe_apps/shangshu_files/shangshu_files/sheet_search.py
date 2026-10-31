"""只读搜索加速。调用方先检查权限、读取校验当前文件；这里不缓存授权或返回值。

每个内容身份只保存一份规范化行文本，关键词只缓存紧凑行位置。缓存失效完全由
站点/表/修订/hash/结构决定；超出内存预算就按原口径扫描，不改变搜索结果。
"""
from array import array
from collections import OrderedDict
import sys
import threading

_CACHE = OrderedDict()
_LOCK = threading.RLock()
_MAX_ENTRIES = 2
_MAX_BYTES = 24 * 1024 * 1024
_MAX_ENTRY_BYTES = 12 * 1024 * 1024
_MAX_TERMS = 8


def _cell_text(raw, typed_value):
    typed = typed_value(raw)
    return ('%s %s' % (typed.get('value') or '', typed.get('formula') or '')).lower()


def _scan(rows, width, count, term, typed_value):
    return array('I', (pos for pos in range(count)
                      if any(term in _cell_text(rows[pos][col] if pos < len(rows) and col < len(rows[pos]) else None,
                                                typed_value) for col in range(width))))


def _entry_bytes(entry):
    return entry['text_bytes'] + sys.getsizeof(entry['queries']) + sum(
        sys.getsizeof(term) + sys.getsizeof(positions) for term, positions in entry['queries'].items())


def _trim():
    while _CACHE and (len(_CACHE) > _MAX_ENTRIES or sum(_entry_bytes(e) for e in _CACHE.values()) > _MAX_BYTES):
        _CACHE.popitem(last=False)


def search_positions(identity, rows, width, count, term, typed_value):
    # NUL 分隔阻止跨单元格误命中；用户查询本身带 NUL 时按原逐格口径扫描。
    if '\0' in term:
        return _scan(rows, width, count, term, typed_value), 'bypass'
    with _LOCK:
        entry = _CACHE.get(identity)
        status = 'hit'
        if entry is None:
            texts = []
            first_positions = array('I')
            used = 1024  # 容器/键的保守余量；文本实际 Unicode 内存按 getsizeof 计。
            for pos in range(count):
                row = rows[pos] if pos < len(rows) else ()
                text = '\0'.join(_cell_text(row[col] if col < len(row) else None, typed_value)
                                 for col in range(width))
                if term in text:
                    first_positions.append(pos)
                if texts is not None:
                    used += sys.getsizeof(text) + 8
                    if used > _MAX_ENTRY_BYTES:
                        # 大文本只缓存紧凑命中位置；不能先构建失败再把全表重扫一遍。
                        texts = None
                        used = 1024
                    else:
                        texts.append(text)
            entry = {'texts': tuple(texts) if texts is not None else None,
                     'text_bytes': used, 'queries': OrderedDict([(term, first_positions)])}
            _CACHE[identity] = entry
            status = 'miss' if texts is not None else 'positions-only'
        _CACHE.move_to_end(identity)
        positions = entry['queries'].get(term)
        if positions is None:
            positions = (_scan(rows, width, count, term, typed_value) if entry['texts'] is None else
                         array('I', (pos for pos, text in enumerate(entry['texts']) if term in text)))
            if entry['texts'] is None:
                status = 'positions-only'
            entry['queries'][term] = positions
            while len(entry['queries']) > _MAX_TERMS:
                entry['queries'].popitem(last=False)
        else:
            entry['queries'].move_to_end(term)
            if status == 'hit':
                status = 'query-hit'
        _trim()
        return positions, status
