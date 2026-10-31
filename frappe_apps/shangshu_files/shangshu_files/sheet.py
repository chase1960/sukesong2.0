"""受管 xlsx 工作表。普通值只存真实 xlsx，晋升值以受管记录为权威。

日常单格、范围、撤回及追加/插行使用唯一 ZIP 增量计划与提交；不能安全处理时
明确拒绝且不切换存储。完整解析保留给读取、显式上传/迁移及尚未收敛的结构操作。
目标值、精度、规则、版本、日志与 WorkingFileTransaction 恢复边界照常验证。
"""
import datetime
import contextlib
import copy
import hashlib
import json
import os
import pickle
import re
import sys
import threading
import time
import weakref
import zipfile
import zlib
from collections import OrderedDict
from io import BytesIO

import frappe
from openpyxl import load_workbook
from openpyxl.cell.cell import MergedCell
from openpyxl.utils import column_index_from_string, get_column_letter

from shangshu_files import zipedit
from shangshu_files.sheet_search import search_positions
from shangshu_files.service import DOCTYPE, MAX_FILE_BYTES, _can_write, _writable, _require_structure
from shangshu_files.style_border import (
    build_border_xml,
    edges_for_cell,
    normalize_border,
    verify_border_after,
)
from shangshu_files.working_file import content_revision, save_current, recover_current

META_FIELD = 'sheet_meta_json'
# 故障注入断点文件；SS_FAULT_FILE 环境变量或站点配置 ss_fault_file 都没设时钩子完全关闭。
# 仓库内 ops/docker 模板已注入 SS_FAULT_FILE；外置实例模板（如交付的 shangshu-local）未必有，
# 那种情况用 bench set-config ss_fault_file /tmp/ss-fault-point 开同一断点。
FAULT_ENV = 'SS_FAULT_FILE'
# 写路径 denylist（评审扩充）：命中即拒绝编辑，读取放行并标只读。
# 2026-10-12 用户拍板「要改，但是直接把外链排除掉」后，外链/自定义XML 挪去 STRIP_PARTS
# （可剔除，不再锁只读）；宏/图表/透视/图片等仍是硬拒——剔了会真丢功能，不是外链那一类。
# xl/drawings/ 不在此表：批注锚框与真图形分开判（见 _drawings_verdict）。
WRITE_DENY_PARTS = ('xl/vbaProject.bin', 'xl/charts/', 'xl/media/',
                    'xl/pivotCache/', 'xl/pivotTables/', 'xl/activeX/', 'xl/ctrlProps/',
                    'xl/embeddings/', 'xl/slicers/', 'xl/threadedComments/', 'xl/webextensions/',
                    'xl/richData/')
# 可剔除特性：命中只这些时放行编辑；落盘前剔掉部件（keep_links=False 不写回外链）、
# 引用外链的公式固化成当时的数（用户看过的数还在，链接没了）。
STRIP_PARTS = ('xl/externalLinks/', 'customXml/')
MAX_ZIP_UNCOMPRESSED = 200 * 1024 * 1024
PRECISION_LIMIT = 1e15  # openpyxl 写出走 %.16g，≥16 位有效数字的数值必丢精度


class _Seg:
    """分段计时（R1 根因定位）：一次请求内各阶段累计毫秒，随写/读结果 timing 返回。

    这是可观测性不是遮罩：预算判定看客户端墙钟，timing 只解释慢在哪。"""
    __slots__ = ('marks', 'notes', 't0', 'last')

    def __init__(self):
        self.marks = {}
        self.notes = {}
        self.t0 = self.last = time.perf_counter()

    def mark(self, name):
        now = time.perf_counter()
        self.marks[name] = self.marks.get(name, 0.0) + (now - self.last) * 1000.0
        self.last = now

    def note(self, key, value):
        """非耗时注记（如手术快路径为何没接上）——随 timing 返回，只解释不遮罩。"""
        self.notes[key] = value

    def out(self):
        d = {k: round(v, 1) for k, v in self.marks.items()}
        d.update(self.notes)
        d['total_ms'] = round((time.perf_counter() - self.t0) * 1000.0, 1)
        return d



def _fault(point):
    path = os.environ.get(FAULT_ENV)
    if not path:
        conf = getattr(frappe, 'conf', None) or {}
        path = conf.get('ss_fault_file') or None
    if not path or not os.path.exists(path):
        return
    try:
        with open(path) as fh:
            if fh.read().strip() == point:
                raise RuntimeError('注入故障：' + point)
    except OSError:
        return


def _corrupt(point, obj):
    """注入**静默篡改**（对比 `_fault` 的**大声失败**）。回篡改后的对象，**不抛**。

    **为什么要有第二种**：`_fault` 造的是「失败」，造不出「**写错了但没人发现**」——
    那才是要验的。

    **默认关闭**：断点文件不存在 / 文件名对不上 → **原样返回，一个字节不动**
    （跟 `_fault` 同族，产品默认路径碰不到）。

    **只用于造反例**验「值写错会被抓住」（`test_fast_path_value_check`）。

    ⚠️ **第一版改的是「字节流最后一个字节」** —— 那在 xlsx 里是 **zip 尾部**，
    **不影响任何单元格的值**，所以「篡改」等于没篡改（实测 `值还是对的`）。
    **改成篡改 `intended`**（判定用的「打算写的值」）——
    语义等价（都是「落盘的 ≠ 打算写的」），而且**可靠地落在值上**。
    """
    path = os.environ.get(FAULT_ENV)
    if not path:
        conf = getattr(frappe, 'conf', None) or {}
        path = conf.get('ss_fault_file') or None
    if not path or not os.path.exists(path):
        return obj
    try:
        with open(path) as fh:
            if fh.read().strip() != point:
                return obj
    except OSError:
        return obj
    if isinstance(obj, dict):
        out = dict(obj)
        for k, v in list(out.items()):
            if isinstance(v, dict) and 'value' in v:
                out[k] = dict(v, value=str(v.get('value') or '') + '-被篡改')
                break
            out[k] = (str(v) + '-被篡改') if v is not None else v
            break
        return out
    return obj


def _load_meta(doc):
    try:
        meta = json.loads(getattr(doc, META_FIELD, None) or '{}')
    except Exception:
        meta = {}
    return meta if isinstance(meta, dict) else {}


def _save_meta(doc, meta):
    from shangshu_files.binding_metadata import save_meta
    save_meta(doc, meta)


# ---- 解析缓存（N2-B6）：同一（表, 内容版本）只解析一次，翻页/搜索/定位复用 ----
# 键必须含内容版本：改一格即新版本、旧缓存自然失效（反例：按文件名缓存会读到旧值）。
# 权限核验在进缓存之前（read_payload 先 check_permission），缓存不跨身份泄漏。
# 进程内 LRU（**条数上限** _PARSE_CACHE_MAX ＋ **内存预算** _PARSE_CACHE_MAX_BYTES）；
# 写路径落盘成功后主动失效。
_PARSE_CACHE = OrderedDict()
_PARSE_CACHE_SIZES = {}   # 键 → 那份解析结果的估算字节（预算闸用）
_PARSE_CACHE_MAX = 8      # 条数上限（改之前只有 2 ⇒ 来回切两张表就冷一次）
_PARSE_CACHE_MAX_BYTES = 64 * 1024 * 1024   # 内存预算上限（估算字节；64MB）
_PARSE_DELTA_MAX_BYTES = 4 * 1024 * 1024
_PARSE_DELTA_MAX_CELLS = 20000
_PARSE_CACHE_GUARD = threading.RLock()
_PARSE_STATS = {}  # 表身份 → {'parse_count': 累计解析次数, 'last_parse_ms': 最近解析耗时}
# 解析段单飞锁（2026-10-11 用户「大表根本打不开」实测定性）：缓存 miss 时若并发来 N 个读，
# 会各自把整表解析一遍（实测 5 并发 → parse_count 一跳到 5；GIL 串行穿插、每份都变慢，
# 9.7MB 上就是穿 BFF 15 秒上限 → 全 abort、缓存一个存不上 → 下次打开还是冷）。加锁后
# 并发冷读共享同一次解析。命中路径不进锁（微秒级）；解析本身吃满 CPU，串行无损失。
#
# ★ **R15（2026-10-26 全仓审查）**：原来是**全进程一把** `_PARSE_LOCK`
#   ⇒ **不同文件**的冷读也要排队（A 文件没解析完，B 文件只能等）；
#   而且解析是在**锁内**做的（流式解析失败还要整簿回落）⇒ 锁 held 的时间＝整份解析时间。
# ⇒ 改成**按「文件 ＋ 内容版本」一把**（`_parse_key_lock`）：
#   · 同一把内容 ⇒ 并发冷读**合并成一次**解析（拿锁后复查缓存）；
#   · **不同内容互不阻塞**（互不相关的两个表不再互相拖慢）。
#   另加**全局并发闸**（`_PARSE_SLOTS`）：解析吃满 CPU ⇒ 同时解析的份数有上限。
_PARSE_KEY_LOCKS = {}            # 键 → {'lock': 单飞锁, 'users': 正在用这把锁的人数}
_PARSE_KEY_LOCKS_GUARD = threading.Lock()
_PARSE_CONCURRENCY = 4           # 同时解析的份数上限（不许一开就并发十几张大表）
_PARSE_SLOTS = threading.BoundedSemaphore(_PARSE_CONCURRENCY)


class _ActiveParseEntry(dict):
    """允许缓存弱引用：活跃请求结束后，不继续强留解码后的大表。"""


class _PackedParseEntry:
    """仅保存本进程自产的压缩快照；不接受文件/请求提供的 pickle。"""
    __slots__ = ('data', 'cells', 'metadata', 'structure', '_active', '_lock')

    def __init__(self, data, entry, cells=None, metadata=None):
        self.data = data
        self.cells = cells or {}
        self.metadata = metadata or {}
        self.structure = (entry.get('sheet_title'), tuple(entry.get('headers') or []), len(entry['rows_raw']))
        self._active = weakref.ref(entry)
        self._lock = threading.Lock()

    def read(self):
        with self._lock:
            entry = self._active()
            if entry is None:
                # 不同大表的解码也沿用并发闸；同内容并发请求只还原一次。
                with _PARSE_SLOTS:
                    entry = _ActiveParseEntry(pickle.loads(zlib.decompress(self.data)))
                    rows = list(entry['rows_raw'])
                    for pos, values in self.cells.items():
                        row = list(rows[pos])
                        for col, value in values.items():
                            while len(row) <= col:
                                row.append(None)
                            row[col] = value
                        rows[pos] = tuple(row)
                    entry['rows_raw'] = rows
                    entry.update(copy.deepcopy(self.metadata))
                self._active = weakref.ref(entry)
            return entry


def _parse_entry_bytes(entry):
    """强持有内存的保守估算，覆盖行容器与格式索引，不漏算大份元数据。"""
    if isinstance(entry, _PackedParseEntry):
        return (sys.getsizeof(entry.data) + 512 + _parse_entry_bytes(entry.cells) +
                _parse_entry_bytes(entry.metadata) + _parse_entry_bytes(entry.structure))
    if entry is None:
        return 0
    size = sys.getsizeof(entry)
    if isinstance(entry, dict):
        size += sum(_parse_entry_bytes(k) + _parse_entry_bytes(v) for k, v in entry.items())
    elif isinstance(entry, (tuple, list, set, frozenset)):
        size += sum(_parse_entry_bytes(value) for value in entry)
    return size


def _parse_cache_bytes():
    """缓存里现在占了多少（**估算**字节）。"""
    # ★ 有人**直接**清空了 `_PARSE_CACHE`（判据里有几处这么干）⇒ 那几份估算
    #   也得一起扔掉，否则预算闸会**误判**「占了太多」而多挤掉几份。
    with _PARSE_CACHE_GUARD:
        for key in [k for k in _PARSE_CACHE_SIZES if k not in _PARSE_CACHE]:
            _PARSE_CACHE_SIZES.pop(key, None)
        return sum(_PARSE_CACHE_SIZES.values())


def _parse_cache_drop(key):
    """把**一份**解析结果从缓存里拿掉（连它那份估算字节一起）。"""
    with _PARSE_CACHE_GUARD:
        _PARSE_CACHE.pop(key, None)
        _PARSE_CACHE_SIZES.pop(key, None)


def _parse_cache_get(key):
    with _PARSE_CACHE_GUARD:
        stored = _PARSE_CACHE.get(key)
        if stored is not None:
            _PARSE_CACHE.move_to_end(key)
    if isinstance(stored, _PackedParseEntry):
        try:
            return stored.read()
        except Exception:
            # 缓存只是加速；坏快照作废后重新解析已核验的当前文件。
            with _PARSE_CACHE_GUARD:
                if _PARSE_CACHE.get(key) is stored:
                    _parse_cache_drop(key)
            return None
    return stored


def _parse_cache_trim():
    """缓存**有上限**：条数超了或估算字节超了 ⇒ 从**最旧**那份开始挤掉。"""
    with _PARSE_CACHE_GUARD:
        while len(_PARSE_CACHE) > _PARSE_CACHE_MAX:
            _parse_cache_drop(next(iter(_PARSE_CACHE)))
        while _PARSE_CACHE and _parse_cache_bytes() > _PARSE_CACHE_MAX_BYTES:
            _parse_cache_drop(next(iter(_PARSE_CACHE)))


def _parse_cache_store(key, entry):
    """大表压缩后参与同一预算，不能因裸条目超限而每页重解析 xlsx。"""
    stored = entry
    size = _parse_entry_bytes(entry)
    if size > _PARSE_CACHE_MAX_BYTES // 4:
        try:
            active = _ActiveParseEntry(entry)
            packed = _PackedParseEntry(zlib.compress(pickle.dumps(dict(entry), protocol=5), 1), active)
            if _parse_entry_bytes(packed) < size:
                stored, entry, size = packed, active, _parse_entry_bytes(packed)
        except Exception:
            pass  # 加速失败不能改变读写结果；超预算仍不留存。
    if size > _PARSE_CACHE_MAX_BYTES:
        _parse_cache_drop(key)
        return entry  # 不可缓存的大条目不能先逐走其他热表再逐走自己。
    with _PARSE_CACHE_GUARD:
        _PARSE_CACHE[key] = stored
        _PARSE_CACHE.move_to_end(key)
        _PARSE_CACHE_SIZES[key] = size
        _parse_cache_trim()
    return entry


def _parse_cache_clear():
    """把解析缓存**整个清空**（判据与运维用；写路径走 `_invalidate_parse`）。"""
    with _PARSE_CACHE_GUARD:
        _PARSE_CACHE.clear()
        _PARSE_CACHE_SIZES.clear()


def _parse_cache_delta(doc, entry, coordinates, version_no, cache_base, meta):
    """已保存格值的最新覆盖，不留版本链；阈值内不遍历/序列化整表。"""
    base = (cache_base or {}).get('entry')
    if not isinstance(base, _PackedParseEntry):
        return 'rebuild:no-base'
    structure = (entry.get('sheet_title'), tuple(entry.get('headers') or []), len(entry['rows_raw']))
    if (base.structure != structure or cache_base.get('version') != version_no - 1 or
            cache_base.get('structure') != (meta.get('primary_sheet'), int(meta.get('structure_version') or 1))):
        return 'rebuild:structure'
    cells = {pos: dict(values) for pos, values in base.cells.items()}
    for pos, col, value in coordinates:
        cells.setdefault(pos, {})[col] = value
    metadata = copy.deepcopy(base.metadata)
    metadata.update({key: copy.deepcopy(entry[key]) for key in
                     ('column_types', 'formula_positions', 'has_formulas', 'daily_formula_free', 'sheet_part') if key in entry})
    delta_bytes = _parse_entry_bytes(cells) + _parse_entry_bytes(metadata)
    if (sum(map(len, cells.values())) > _PARSE_DELTA_MAX_CELLS or
            delta_bytes > min(_PARSE_DELTA_MAX_BYTES, _PARSE_CACHE_MAX_BYTES // 4)):
        return 'rebuild:delta-limit'
    active = _ActiveParseEntry(entry)
    stored = _PackedParseEntry(base.data, active, cells, metadata)
    size = _parse_entry_bytes(stored)
    if size > _PARSE_CACHE_MAX_BYTES:
        return 'rebuild:cache-budget'
    with _PARSE_CACHE_GUARD:
        _invalidate_parse(doc.name)
        key = _parse_cache_key(doc, version_no)
        _PARSE_CACHE[key] = stored
        _PARSE_CACHE_SIZES[key] = size
        _parse_cache_trim()
    return 'delta'


@contextlib.contextmanager
def _parse_key_lock(key):
    """**按「文件 ＋ 内容版本」的单飞锁**（R15）。

    · 同一把内容 ⇒ 并发冷读**合并成一次**解析（拿到锁后再复查缓存）；
    · **不同内容互不阻塞**（改之前是全进程一把锁 ⇒ 互不相关的两个表互相拖慢）；
    · 没人用的时候这把锁**自己消失**（不许锁表无限长）。
    """
    with _PARSE_KEY_LOCKS_GUARD:
        slot = _PARSE_KEY_LOCKS.get(key)
        if slot is None:
            slot = {'lock': threading.Lock(), 'users': 0}
            _PARSE_KEY_LOCKS[key] = slot
        slot['users'] += 1
    slot['lock'].acquire()
    try:
        yield
    finally:
        slot['lock'].release()
        with _PARSE_KEY_LOCKS_GUARD:
            slot['users'] -= 1
            if slot['users'] <= 0:
                _PARSE_KEY_LOCKS.pop(key, None)


def warm_parse(doc, content):
    """上传后预热：把解析结果焐进缓存，让第一次打开直接命中（0.0x 秒级）。

    预热是提速不是正确性——失败不拦上传，吞掉异常即可。
    """
    try:
        _parsed(doc, content)
    except Exception:
        pass


def _raw_numeric_read_values(content, sheet_title, candidates):
    """只恢复原 XML 数值被日期解析器误读为 #VALUE! 的读回结果；不改文件或样式。

    只扫描候选所在行，真正 t=e 错误、公式与有效日期均不参与恢复。
    数值按原有数值口径解析，不推测日期，也不影响整簿写入的拒绝保护。
    """
    if not candidates:
        return {}
    part = zipedit.sheet_part_by_title(content, sheet_title)
    if not part:
        return {}
    rows = zipedit._row_fragments(zipedit.read_sheet(content, part),
                                 {zipedit.parse_coord(coord)[1] for coord in candidates})
    recovered = {}
    for fragment in rows.values():
        for match in zipedit._RE_C_BLOCK.finditer(fragment):
            attrs, inner = match.group(1) or b'', match.group(2) or b''
            coord = re.search(rb'\sr="([A-Z]+[0-9]+)"', attrs)
            if not coord or coord.group(1).decode() not in candidates:
                continue
            kind = re.search(rb'\st="([^"]+)"', attrs)
            if (kind and kind.group(1) != b'n') or re.search(rb'<f\b', inner):
                continue
            value = zipedit._RE_V.search(inner)
            if value is None:
                continue
            raw = value.group(1).strip()
            if not re.fullmatch(rb'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?', raw):
                continue
            number = float(raw) if b'.' in raw or b'E' in raw or b'e' in raw else int(raw)
            if isinstance(number, float) and (number != number or number in (float('inf'), float('-inf'))):
                continue
            recovered[coord.group(1).decode()] = number
    return recovered


def _entry_from_wb(wb, readonly, content=None):
    """从已打开的工作簿构建解析缓存条目（读路径与写后预热共用同一套抽取口径）。"""
    """从已打开的工作簿构建解析缓存条目（读路径与写后预热共用同一套抽取口径）。"""
    ws = wb.worksheets[0]
    max_r, max_c = _data_extent(ws)
    headers = _headers_of(ws)
    candidates = {cell.coordinate for _key, cell in _iter_real_cells(ws)
                  if cell.data_type == 'e' and cell.value == '#VALUE!'} if content else set()
    recovered = _raw_numeric_read_values(content, ws.title, candidates) if candidates else {}
    grid = {}
    # **样式只走索引形式**（PKG-079-T01）：三条读路径的回包**同键**，谁都不许再给一份
    # 「逐格展开的显示格式」。样式信息由 `style_ids`（按格记样式号）＋`font_styles`
    # （按样式号索引的共享视图）＋行/列继承三件组成，消费方按需自拼
    # （公开读口 `files.sheet_read` 的 `row.styles` 就是这么拼的）。
    # 为什么撤掉逐格那份：真表（9.7MB／15516 数据行）实测**763,491 个格每一个都带样式**
    # ⇒ 逐格展开就是 76 万条字典；放生产默认那条快路径上 = 每次冷读多占一份大字典，
    # 而**全仓没有一处读它**。
    style_ids = {}
    for (r, c), cell in _iter_real_cells(ws):
        if cell.style_id:
            style_ids[(r, c)] = cell.style_id
        v = recovered.get(cell.coordinate, cell.value)
        if r == 1 and cell.coordinate in recovered:
            headers[c - 1] = str(v)
        if isinstance(v, str) and v.startswith('=') and getattr(cell, 'data_type', '') != 'f':
            v = _literal_text(v)  # 文本格内容恰以 = 开头：不许被当公式
        if r >= 2 and v is not None and v != '':
            grid[(r, c)] = v
    rows_raw = [tuple(grid.get((r, c)) for c in range(1, max_c + 1))
                for r in range(2, max_r + 1)]
    return {
        'sheet_title': ws.title,
        'sheet_titles': [w.title for w in wb.worksheets],
        'headers': headers,
        'rows_raw': rows_raw,
        'widths': _widths_of(ws),
        'column_types': [(_dominant_type(row[i] for row in rows_raw) if i < max_c else None)
                         for i in range(max_c)],
        'readonly': readonly,
        **(_style_read_cache(content, ws.title, style_ids) if content else
           _style_views_entry(style_ids, _style_views_from_wb(wb))),
    }


def _entry_fast(content, readonly, scan_cols=512, timing=None):
    """**快解析条目**（B03 冷开）：正则按行/格扫 sheet XML，不走 openpyxl 对象模型。

    为什么要有：openpyxl 解析 9.7MB/347k 格要 3.2–5.3s，冷开预算 5s 被顶穿；
    本函数同一样本约 2.2s，且**与 `_entry_streaming_openpyxl` 逐格相等**
    （3820 实测 347k 格 0 差异，含共享公式/日期/富文本/错误值）。

    语义与 openpyxl `read_only` 逐条对齐：
    - 公式：`data_only=False` → `'=' + 公式`；共享公式用 `Translator` 按锚点平移；
      array/dataTable 或找不到锚点 → **抛错回落** openpyxl（不猜）。
    - 数字：`.`/`E`/`e` → float，否则 int；日期样式走 `from_excel`；
      超范围日期按 openpyxl 语义转 `#VALUE!`。
    - 共享字符串 / inlineStr（富文本 runs 拼接）/ str / b / e / d。
    - 空值但有样式 → 跳过（同 `_entry_streaming`）。
    - 列 >512 不读（同 `iter_rows(max_col=512)`）；若值到 512 列，
      抛错让调用方回落整簿路径（同原「极宽表」判定）。
    - 坐标取属性用 `bytes.find`，不逐格正则。
    """
    import zipfile as _zf
    from io import BytesIO as _BIO
    from openpyxl.styles.numbers import is_date_format, is_timedelta_format, BUILTIN_FORMATS
    from openpyxl.utils.datetime import from_excel, from_ISO8601, WINDOWS_EPOCH
    from openpyxl.formula.translate import Translator

    _ROW_RE = re.compile(rb'<row\b([^>]*)>(.*?)</row>', re.S)
    _CELL_RE = re.compile(rb'<c\b([^>]*?)(?:/>|>(.*?)</c>)', re.S)
    _F_RE = re.compile(rb'<f\b([^>]*?)(?:/>|>(.*?)</f>)', re.S)
    _T_RE = re.compile(rb'<t\b[^>]*>(.*?)</t>', re.S)
    # **单遍解实体** —— 不能先 `unescape` 再解数字引用：`&amp;#10;` 是**字面文本**
    # `&#10;`，二次解码会把它变成换行（边界夹具实测抓到）。
    _ENT = re.compile(r'&(#x?[0-9A-Fa-f]+|amp|lt|gt|quot|apos);')
    _NAMED = {'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', 'apos': "'"}

    def _text(raw):
        if not raw:
            return ''
        text=raw.decode('utf-8')
        if '&' not in text:return text
        def rep(m):
            g = m.group(1)
            if g in _NAMED:
                return _NAMED[g]
            try:
                return chr(int(g[2:], 16) if g[:2] == '#x' else int(g[1:]))
            except (ValueError, IndexError):
                return m.group(0)
        return _ENT.sub(rep, text)

    def _attr(attrs, name):
        i = attrs.find(b' ' + name + b'="')
        if i < 0:
            return None
        i += len(name) + 3
        j = attrs.find(b'"', i)
        return attrs[i:j] if j >= 0 else None

    z = _zf.ZipFile(_BIO(content))
    wb = z.read('xl/workbook.xml').decode('utf-8', 'replace')
    rels = z.read('xl/_rels/workbook.xml.rels').decode('utf-8', 'replace')
    sheets = []
    for tag in re.findall(r'<sheet\b[^>]*>', wb):
        name = re.search(r'name="([^"]*)"', tag).group(1)
        rid = re.search(r'r:id="([^"]+)"', tag).group(1)
        mm = re.search(r'<Relationship[^>]*Id="%s"[^>]*>' % re.escape(rid), rels)
        if not mm:
            raise ValueError('rel missing')
        target = re.search(r'Target="([^"]+)"', mm.group(0)).group(1)
        part = target.lstrip('/') if target.startswith('/') else 'xl/' + target.lstrip('./')
        sheets.append((_text(name.encode('utf-8')), part))
    if not sheets:
        raise ValueError('no sheet')
    title, part = sheets[0]

    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        ss = z.read('xl/sharedStrings.xml')
        shared = [_text(b''.join(re.findall(rb'<t\b[^>]*>(.*?)</t>', si, re.S)))
                  for si in re.findall(rb'<si\b[^>]*>(.*?)</si>', ss, re.S)]

    date_xfs, td_xfs = set(), set()
    styles_raw=None
    if 'xl/styles.xml' in z.namelist():
        styles_raw=z.read('xl/styles.xml')
        styles = styles_raw.decode('utf-8', 'replace')
        numfmts = {}
        nm = re.search(r'<numFmts\b[^>]*>(.*?)</numFmts>', styles, re.S)
        if nm:
            for tag in re.findall(r'<numFmt\b[^>]*/>', nm.group(1)):
                nid = re.search(r'numFmtId="(\d+)"', tag)
                code = re.search(r'formatCode="([^"]*)"', tag)
                if nid and code:
                    numfmts[int(nid.group(1))] = _text(code.group(1).encode('utf-8'))
        xb = re.search(r'<cellXfs\b[^>]*>(.*?)</cellXfs>', styles, re.S)
        xfs = []
        if xb:
            for t in re.findall(rb'<xf\b[^>]*?/?>', xb.group(1).encode()):
                nid = re.search(rb'numFmtId="(\d+)"', t)
                xfs.append(int(nid.group(1)) if nid else 0)
        for i, nid in enumerate(xfs):
            code = numfmts.get(nid, BUILTIN_FORMATS.get(nid))
            if code is None:
                continue
            try:
                if is_date_format(code):
                    date_xfs.add(i)
                if is_timedelta_format(code):
                    td_xfs.add(i)
            except Exception:
                pass

    xml = z.read(part)
    if re.search(rb'<(?:[A-Za-z_][\w.-]*:)(?:worksheet|sheetData|row|c)\b', xml):
        raise ValueError('prefixed worksheet requires XML-aware parser')
    headers_raw, grid = {}, {}
    style_ids = {}
    max_r, max_c = 1, 1
    shared_formulas = {}
    col_cache = {}
    scan_started = time.perf_counter()
    for rm in _ROW_RE.finditer(xml):
        current_grid_row=None;row_values=None
        for cm in _CELL_RE.finditer(rm.group(2)):
            attrs = cm.group(1) or b''
            # **内联取属性**（这里每格调 3 次函数会成为热点：347k 格 × 3 = 230 万次）。
            pi = attrs.find(b' r="')
            if pi < 0:
                continue
            pi += 4
            pj = attrs.find(b'"', pi)
            coord_b = attrs[pi:pj] if pj >= 0 else b''
            if not coord_b:
                continue
            coord = coord_b.decode()
            letters = coord.rstrip('0123456789')
            col = col_cache.get(letters)
            if col is None:
                col = 0
                for ch in letters:
                    col = col * 26 + (ord(ch) - 64)
                col_cache[letters] = col
            ri = int(coord[len(letters):])
            inner = cm.group(2) or b''
            fpos = inner.find(b'<f')
            ti = attrs.find(b' t="')
            if ti >= 0:
                ti += 4
                tj = attrs.find(b'"', ti)
                t = attrs[ti:tj].decode()
            else:
                t = 'n'
            si = attrs.find(b' s="')
            if si >= 0:
                si += 4
                sj = attrs.find(b'"', si)
                style = int(attrs[si:sj])
            else:
                style = 0
            # 样式缓存与 `_entry_from_wb` 同口径：有 style id 的真实格都记（含空值格）。
            if si >= 0 and col <= scan_cols:
                style_ids[(ri, col)] = style
            if fpos >= 0:
                fmat = _F_RE.search(inner, fpos)
                fattrs = fmat.group(1) or b''
                ftext = fmat.group(2) or b''
                if b't="array"' in fattrs or b't="dataTable"' in fattrs:
                    raise ValueError('complex formula')
                if b't="shared"' in fattrs:
                    si = _attr(fattrs, b'si') or b''
                    if ftext:
                        txt = _text(ftext)
                        # **每组只建一次 Translator**：`Translator.__init__` 会解析整条公式，
                        # 2.5 万个共享公式格子逐个重建实测占 1.1s（剖析），复用后只剩平移。
                        shared_formulas[si] = Translator('=' + txt, origin=coord)
                        val = '=' + txt
                    else:
                        anchor = shared_formulas.get(si)
                        if not anchor:
                            raise ValueError('shared formula anchor missing')
                        val = anchor.translate_formula(coord)
                else:
                    val = '=' + _text(ftext)
            else:
                i = inner.find(b'<v')
                if i >= 0:
                    j = inner.find(b'>', i)
                    k = inner.find(b'</v>', j)
                    vraw = inner[j + 1:k] if j >= 0 and k >= 0 else b''
                else:
                    vraw = None
                v = _text(vraw) if vraw is not None else None
                if t == 'inlineStr':
                    val = _text(b''.join(_T_RE.findall(inner)))
                elif v is None:
                    val = None
                elif t == 's':
                    val = shared[int(v)]
                elif t == 'b':
                    val = bool(int(v))
                elif t == 'str':
                    val = v
                elif t == 'e':
                    val = v
                elif t == 'd':
                    val = from_ISO8601(v)
                else:
                    val = float(v) if ('.' in v or 'E' in v or 'e' in v) else int(v)
                    if style in date_xfs:
                        try:
                            val = from_excel(val, WINDOWS_EPOCH, timedelta=style in td_xfs)
                        except (OverflowError, ValueError):
                            # **超范围日期序列保留原始数字**（2026-10-18 P0）：
                            # openpyxl 会把它标成 `#VALUE!`，但旧读路径
                            # `_raw_numeric_read_values` 会从 XML 把原始数字恢复回来。
                            # 快解析直接保留原始数字，与旧结果一致；真正的错误值
                            # （`t="e"`）仍按错误文本返回。
                            pass
            # **以 `=` 开头的文本格**不是公式（openpyxl `data_type != 'f'`）——
            # 用 `_literal_text` 标记，否则 `value_typed` 会把它当公式
            # （外链公式固化后的原文就是这种格；边界夹具实测抓到）。
            if isinstance(val, str) and val.startswith('=') and fpos < 0:
                val = _literal_text(val)
            if col > scan_cols:
                # **极宽表**：旧流式看到上限外**有值**就返回 None（回落整簿），
                # 不能静默把尾列值丢掉（test_sheet_cold_read 实测抓到的语义差）。
                if val not in (None, ''):
                    raise ValueError('wide sheet')
                continue
            if val is None and style:
                continue
            if ri > max_r:
                max_r = ri
            if val not in (None, '') and col > max_c:
                max_c = col
            if ri == 1:
                headers_raw[col] = val
            elif val is not None and val != '':
                if current_grid_row!=ri:
                    row_values=grid.setdefault(ri,{})
                    current_grid_row=ri
                row_values[col] = val
    if max_c >= scan_cols:
        raise ValueError('wide sheet')
    # 合并说明（2026-10-21，合并 fast 之后的语义修复）：**这条快解析路径也要过表头闸** ——
    # 合并时 `_assert_table_headers`（空白/重复表头不算业务表，明确拒绝）只加在了
    # `_headers_of`（整簿路径）和 `_entry_streaming_openpyxl` 上，**快解析这条没加** ⇒
    # 同一个工作簿，走快解析读得到、走另两条路径被拒 —— **三条读路径口径不一致**。
    # 现在三条路径过**同一道闸**（`_assert_table_headers`）。
    headers = _assert_table_headers([str(headers_raw[c]) if headers_raw.get(c) is not None else ''
               for c in range(1, max_c + 1)])
    rows_raw = [tuple(values.get(c) for c in range(1, max_c + 1))
                for r in range(2, max_r + 1) for values in [grid.get(r,{})]]
    widths = {}
    try:
        head = xml[:xml.find(b'<sheetData')]
        for m in re.finditer(rb'<col\b[^>]*/?>', head):
            tag = m.group(0)
            mn = re.search(rb'min="(\d+)"', tag)
            mx = re.search(rb'max="(\d+)"', tag)
            w = re.search(rb'width="([0-9.]+)"', tag)
            if not (mn and w):
                continue
            lo = int(mn.group(1))
            hi = int(mx.group(1)) if mx else lo
            for idx in range(lo, min(hi, max_c) + 1):
                widths[str(idx)] = float(w.group(1))
    except Exception:
        widths = {}
    entry = {'sheet_title': title, 'sheet_part': part,
             'sheet_titles': [s[0] for s in sheets],
             'headers': headers,
             'rows_raw': rows_raw,
             'widths': widths,
             'column_types': [(_dominant_type(row[i] for row in rows_raw) if i < max_c else None)
                              for i in range(max_c)],
             'readonly': readonly}
    # **样式缓存**：三条读路径的回包**同键**（PKG-079-T01）—— 样式一律以索引形式给
    # （`style_ids` 按格记样式号 ＋ `font_styles` 按样式号索引的共享视图 ＋ 行/列继承），
    # 谁都不再另给一份「逐格展开的显示格式」。
    # 缺了它 → 冷读回包少样式面，三条路径的键集合就不一致。
    # **没有样式也要调**：样式表为空时也带 `style_ids/font_styles/row/column` 四个键，
    # 快路径少键就不等（缓存自己会只扫 s="0" 与行/列样式，代价很小）。
    style_cache = globals().get('_style_read_cache')
    if style_cache is not None:
        entry.update(style_cache(content,title,style_ids,sheet_xml=xml,sheet_part=part,
                                 complete_ids=True,styles_xml=styles_raw))
    if timing is not None:
        # 与旧流式同名计时键：调用方（判据/诊断）按同一口径读数。
        timing['iterate_rows_ms'] = round((time.perf_counter() - scan_started) * 1000.0, 1)
    return entry


def _entry_streaming(content, readonly, timing=None):
    """读路径流式建解析条目：**先快解析**（`_entry_fast`），任何不支持/异常回落
    openpyxl `read_only`（语义必须一致时才接受快结果；快解析已逐格对齐，见测试）。
    `timing` 与旧签名兼容：诊断/判据按同一键名（`iterate_rows_ms`）读数。"""
    try:
        return _entry_fast(content, readonly, timing=timing)
    except Exception:
        # 旧分支的 openpyxl 实现没有 `timing` 形参；按签名决定传不传，
        # **不靠捕获 TypeError**（那会把实现内部真正的 TypeError 也吞掉）。
        import inspect
        if 'timing' in inspect.signature(_entry_streaming_openpyxl).parameters:
            return _entry_streaming_openpyxl(content, readonly, timing=timing)
        return _entry_streaming_openpyxl(content, readonly)


def _entry_streaming_openpyxl(content, readonly, timing=None):
    """读路径流式建解析条目（R1 冷开提速，2026-10-13）：read_only 打开（45ms 级）+ 有界
    逐行扫，不物化整簿格对象（9.7MB/347k 格实测整簿 5.2s；流式直奔 2s 内）。
    值/公式/空格规则与 _entry_from_wb 逐字一致（EmptyCell=不在 XML=整簿看不见，跳过；
    =开头文本仍走 _literal_text，公式看 data_type=='f'）。从 openpyxl 实际 XML 单元格流读，避免其行包装器
    按 dimension 或固定 max_col 给每行垫成 512/16384 列。
    扫到上限列仍有值的极宽表返回 None，保守回落整簿路径。宽度从 sheet 部件头部的 <cols>
    取（只解压开头几十 KB，不解整部件）。
    `timing` 保留旧签名：调用方按同一口径传计时字典；本实现不写分段键。"""
    scan_cols = 512
    stage_started = time.perf_counter()
    def mark(name):
        nonlocal stage_started
        now = time.perf_counter()
        if timing is not None:
            timing[name] = round((now - stage_started) * 1000, 1)
        stage_started = now
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        wb = load_workbook(BytesIO(content), data_only=False, keep_links=False, read_only=True)
    mark('open_workbook_ms')
    try:
        ws = wb.worksheets[0]
        # Surgical writes may follow an old under-declared dimension. Iterate
        # actual XML tail rows; max_col below still bounds wide-sheet padding.
        ws.reset_dimensions()
        sheet_title = ws.title
        sheet_titles = [w.title for w in wb.worksheets]
        max_r, max_c = 1, 1
        grid = {}
        style_ids = {}
        headers_raw = {}
        numeric_errors = {}
        # 使用 openpyxl 同一 XML 解析器的实际单元格字典，避免 ReadOnlyWorksheet
        # 为每行补 512/16384 个空槽。公式/共享字符串/日期仍由原解析器处理。
        # 私有解析器接口不兼容会由 _parsed 的原整簿路径回退并留下原因。
        from openpyxl.worksheet._reader import WorkSheetParser
        class ReadPreviewParser(WorkSheetParser):
            def parse_formatting(self, element):
                # 预览仅投影格值与静态字体，从未消费 parser.formatting。
                # 条件格式 XML 留在原文件；safe_open/整簿写仍用原解析器。
                # 避免为真实大表 12,147 段条件格式构建后随即丢弃对象。
                pass
        with warnings.catch_warnings(), ws._get_source() as source:
            warnings.simplefilter('ignore', UserWarning)
            parser = ReadPreviewParser(source, ws._shared_strings, data_only=False,
                                     epoch=wb.epoch, date_formats=wb._date_formats,
                                     timedelta_formats=wb._timedelta_formats)
            for ri, cells in parser.parse():
                for cell in cells:
                    ci = cell['column']
                    v = cell['value']
                    if ci >= scan_cols and v not in (None, ''):
                        mark('iterate_rows_ms')
                        return None  # 真实宽表由原整簿路径处理，不静默截掉尾列值。
                    if ci > scan_cols:
                        continue  # 与原 512 列读取范围一致；尾部纯样式不扩大数据区域。
                    sid = int(cell.get('style_id') or 0)
                    if sid:
                        style_ids[(ri, ci)] = sid
                    if cell.get('data_type') == 'e' and v == '#VALUE!':
                        numeric_errors['%s%d' % (get_column_letter(ci), ri)] = (ri, ci)
                    if isinstance(v, str) and v.startswith('=') and cell.get('data_type') != 'f':
                        v = _literal_text(v)
                    if v is None and sid:
                        continue
                    if ri > max_r:
                        max_r = ri
                    if v not in (None, '') and ci > max_c:
                        max_c = ci
                    if ri == 1:
                        headers_raw[ci] = v
                    elif v is not None and v != '':
                        grid[(ri, ci)] = v
    finally:
        try:
            wb.close()
        except Exception:
            pass
    mark('iterate_rows_ms')
    if max_c >= scan_cols:
        return None   # 极宽表：整簿路径兜底
    for coord, value in _raw_numeric_read_values(content, sheet_title, numeric_errors).items():
        ri, ci = numeric_errors[coord]
        if ri == 1:
            headers_raw[ci] = value
        else:
            grid[(ri, ci)] = value
    mark('recover_numeric_ms')
    # 合并说明：fast 那边在这里也过 `_assert_table_headers`（空白/重复表头不算业务表）——
    # 本分支的 `_headers_of`（整簿路径）已经被合并成同一道闸，两条读路径**口径必须一致**，
    # 所以快路径这里也过同一道。
    headers = _assert_table_headers([str(headers_raw[c]) if headers_raw.get(c) is not None else ''
               for c in range(1, max_c + 1)])
    rows_raw = [tuple(grid.get((r, c)) for c in range(1, max_c + 1)) for r in range(2, max_r + 1)]
    widths = {}
    try:
        zf = zipfile.ZipFile(BytesIO(content))
        part = zipedit.sheet_part_by_title(content, sheet_title)
        if part:
            head = zf.open(part).read(65536)
            for m in re.finditer(rb'<col\b[^>]*/?>', head):
                tag = m.group(0)
                mn = re.search(rb'min="(\d+)"', tag)
                w = re.search(rb'width="([0-9.]+)"', tag)
                if not (mn and w):
                    continue
                lo = int(mn.group(1))
                mx = re.search(rb'max="(\d+)"', tag)
                hi = int(mx.group(1)) if mx else lo
                for idx in range(lo, min(hi, max_c) + 1):
                    widths[str(idx)] = float(w.group(1))
    except Exception:
        widths = {}
    mark('assemble_rows_widths_ms')
    column_types = [_dominant_type([row[i] for row in rows_raw[:50]]) for i in range(max_c)]
    mark('column_types_ms')
    style_view = _style_read_cache(content, sheet_title, style_ids)
    mark('styles_ms')
    # **样式只走索引形式**（PKG-079-T01）：这条路径不物化 Cell 对象（read_only 簿里
    # wb._fonts 等也没装载），样式一律按 `style_ids`（按格记样式号）＋`font_styles`
    # （按样式号索引的共享视图）给；**不再另拼一份逐格的** ——
    # 三条读路径的回包因此同键，消费方自拼即可（公开读口 `files.sheet_read` 的
    # `row.styles` 就是这么拼的）。
    return {
        'sheet_title': sheet_title,
        'sheet_titles': sheet_titles,
        'headers': headers,
        'rows_raw': rows_raw,
        'widths': widths,
        'column_types': column_types,
        'readonly': readonly,
        **style_view,
    }


def _warm_parse_from_wb(doc, wb2):
    """写后预热（D4）：验证门那次重开的簿直接进缓存——写完立刻读即命中，
    免掉 9.7MB 表写后首读 4.3~6.1 秒的冷解析。提速项，失败不拦保存。"""
    try:
        version = content_revision(doc)
        key = _parse_cache_key(doc, version)
        entry = _entry_from_wb(wb2, None)  # 刚写成功=可写版本
        _parse_cache_store(key, entry)
    except Exception:
        pass


def _parse_cache_key(doc, content_version):
    site = getattr(getattr(frappe, 'local', None), 'site', '') or ''
    return '%s@%d@%s@%s' % (doc.name, content_version, site, getattr(doc, 'current_sha256', '') or '')


def process_upload(doc, content, timing=None):
    """上传后首次处理（R1/R4：处理归上传→可编辑首屏的 15s 预算，不占改格预算）。

    需要清洗（外链/自定义XML/批注）时：剔包、外链公式固化、批注进备注，一次性产出
    已清洗新版本（原文件仍是第 1 版，可按版本下载）；不需要清洗就只记 ss_clean。
    此后格值写入走手术快路径。处理失败不拦上传——首次改格回落慢路径做同样的清洗。
    清洗本体优先走字节手术（R1-08：openpyxl 整簿往返实测占清洗 92%）；语义边界
    （留原处批注等）回落 openpyxl 慢路径。版本备注两种路径同一套口径（数字写明）。
    timing（可选）：分段计时落点——只解释慢在哪，不参与预算判定。
    """
    def _mark(key, t_from):
        if timing is not None:
            timing[key] = (time.perf_counter() - t_from) * 1000.0
        return time.perf_counter()

    def _note(stripped, frozen, extracted, added, kept, lost):
        extras = []
        if stripped:
            extras.append('剔除' + '、'.join(stripped))
        if frozen:
            extras.append('外链公式固化 %d 格' % frozen)
        if extracted:
            extras.append('批注提取 %d 条进备注列' % extracted)
        if added:
            extras.append('新增备注列')
        if kept:
            extras.append('%d 条未提取留原处' % kept)
        if lost:
            extras.append('%d 条合并区批注未能保留' % lost)
        return 'sheet-edit·上传后首次处理（剔外链/批注进备注）' + ('，' + '，'.join(extras) if extras else '')

    meta = _load_meta(doc)
    t0 = time.perf_counter()
    try:
        names = set(zipfile.ZipFile(BytesIO(content)).namelist())
    except Exception:
        return False
    _mark('zip_scan', t0)
    t0 = time.perf_counter()
    needs = (any(n.startswith('xl/externalLinks/') or n.startswith('customXml/') for n in names)
             or any('comments' in n for n in names))
    if not needs:
        from shangshu_files.formulas import invalidate_imported_caches
        normalized = invalidate_imported_caches(content) if readonly_reason(content) is None else content
        if normalized != content:
            _save_current(doc, normalized, note='sheet-edit·导入公式缓存失效，保留公式待计算')
            content = normalized
            meta = _load_meta(doc)
        meta['formula_compat_ready'] = True
        meta['ss_clean'] = True
        _save_meta(doc, meta)
        _mark('clean', t0)
        t0 = time.perf_counter()
        # ⚠️ **上传时就把行身份登记好**（2026-10-27 · 大表插行快路）：
        #   以前行身份**只在读的时候算、不落库**（读不写库）⇒ **刚上传的表第一次改结构
        #   手上没有行身份 ⇒ 手术快路接不上（`skip:meta`）⇒ 又走整本老路**
        #   （15,502 行实测 11.5 秒；用户「加一行特别慢」就是这一下）。
        #   **上传本身是写**（上传者拥有这张表）⇒ 在这里登记行身份不违背「读不落库」。
        #   发号跟读路径**同一套**（`_ensure_meta_rows`）⇒ 前后行身份一致，不重发。
        try:
            entry, _diag = _parsed(doc, content)
            meta = _ensure_meta_rows(doc, len(entry['rows_raw']), entry['sheet_title'])
            meta['formula_compat_ready'] = True
            meta['ss_clean'] = True
            _save_meta(doc, meta)
        except Exception:
            pass   # 原件可上传；若未登记好行身份，日常编辑明确要求显式迁移。
        warm_parse(doc, content)   # 不用清洗也预热：上传→可编辑首屏命中缓存（也参与 LRU 挤换）
        _mark('warm', t0)
        return True

    # 手术快路径（硬黑名单/语义边界除外）：字节级剔包/固化/批注进备注
    if readonly_reason(content) is None:
        try:
            from shangshu_files.zipedit import clean_workbook, NeedFallback
            comments = _comments_from_xml(content) if any('comments' in n for n in names) else {}
            saved, rep = clean_workbook(content, comments, _is_external_formula, _fmt_remark_value)
            from shangshu_files.formulas import invalidate_imported_caches
            saved = invalidate_imported_caches(saved)
            _mark('clean', t0)
            t0 = time.perf_counter()
            _save_current(doc, saved,
                          note=_note(rep.get('stripped') or [], rep.get('frozen') or 0,
                                     rep.get('extracted') or 0, rep.get('added'),
                                     rep.get('kept') or 0, rep.get('lost') or 0))
            _mark('clean_version_write', t0)
            t0 = time.perf_counter()
            _invalidate_parse(doc.name)
            entry, _diag = _parsed(doc, saved)   # 流式建条目并预热（语义参照 _entry_from_wb）
            meta = _ensure_meta_rows(doc, len(entry['rows_raw']), entry['sheet_title'])
            meta['ss_clean'] = True
            meta['formula_compat_ready'] = True
            _save_meta(doc, meta)
            _mark('warm', t0)
            return True
        except Exception:
            # 手术遇到语义边界（NeedFallback）或自身出错：不猜，回落慢路径做同样的清洗
            pass

    try:
        wb = safe_open(content, for_write=True)   # 剔包/固化/批注提取在安全打开里发生
        out = BytesIO()
        wb.save(out)
        from shangshu_files.formulas import invalidate_imported_caches
        saved = invalidate_imported_caches(out.getvalue())
        _mark('clean', t0)
        t0 = time.perf_counter()
        _save_current(doc, saved,
                      note=_note(getattr(wb, '_ss_stripped', None) or [],
                                 getattr(wb, '_ss_frozen', 0), getattr(wb, '_ss_extracted', 0),
                                 getattr(wb, '_ss_remark_added', False),
                                 getattr(wb, '_ss_kept', 0), getattr(wb, '_ss_lost', 0)))
        meta = _ensure_meta(doc, wb)
        meta['ss_clean'] = True
        meta['formula_compat_ready'] = True
        _save_meta(doc, meta)
        _mark('clean_version_write', t0)
        t0 = time.perf_counter()
        _invalidate_parse(doc.name)
        _warm_parse_from_wb(doc, wb)
        _mark('warm', t0)
        return True
    except Exception:
        return False


def _invalidate_parse(name):
    with _PARSE_CACHE_GUARD:
        for key in [k for k in list(_PARSE_CACHE) if k.split('@', 1)[0] == name]:
            _parse_cache_drop(key)


def _parsed(doc, content, incremental=False):
    """取解析结果：命中直接复用；未命中解析一次并记耗时/次数（diagnostics 可观测）。

    ★ **单飞按「文件 ＋ 内容版本」一把**（R15）：同一把内容的并发冷读**合并成一次**解析；
      **不同文件互不阻塞**（改之前是全进程一把锁 ⇒ A 文件的冷读把 B 文件的冷读堵住）。
    ★ **并发有上限**（`_PARSE_SLOTS`）：解析吃满 CPU ⇒ 同时解析的份数有上限。
    """
    version = content_revision(doc)
    key = _parse_cache_key(doc, version)
    stats = _PARSE_STATS.setdefault(doc.name, {'parse_count': 0, 'last_parse_ms': 0.0})
    cache_started = time.perf_counter()
    entry = _parse_cache_get(key)
    if entry is not None:
        return entry, {'cache': 'hit', 'parse_ms': 0.0, 'parse_count': stats['parse_count'],
                       'cache_load_ms': round((time.perf_counter() - cache_started) * 1000, 1)}
    with _parse_key_lock(key):  # 单飞：同一把内容共享同一次解析（拿锁后复查，别人可能已解析完）
        cache_started = time.perf_counter()
        entry = _parse_cache_get(key)
        if entry is not None:
            return entry, {'cache': 'hit', 'parse_ms': 0.0, 'parse_count': stats['parse_count'],
                           'cache_load_ms': round((time.perf_counter() - cache_started) * 1000, 1)}
        with _PARSE_SLOTS:      # 全局并发闸（解析吃 CPU，份数有上限）
            t0 = time.perf_counter()
            entry = None
            parse_timing = {}
            parse_path = 'stream'
            fallback_reason = None
            readonly = readonly_reason(content)
            parse_timing['readonly_ms'] = round((time.perf_counter() - t0) * 1000, 1)
            try:
                entry = _entry_streaming(content, readonly, timing=parse_timing)
                if entry is None:
                    fallback_reason = 'wide-sheet'
            except Exception as error:
                fallback_reason = type(error).__name__  # 不回传异常文本中的客户内容
            if entry is None and incremental:
                frappe.throw('工作簿无法建立增量编辑索引，请先显式迁移；本次未保存', frappe.ValidationError)
            if entry is None:
                parse_path = 'full-fallback'
                fallback_started = time.perf_counter()
                wb = safe_open(content)
                entry = _entry_from_wb(wb, readonly, content)
                parse_timing['fallback_ms'] = round((time.perf_counter() - fallback_started) * 1000, 1)
            style_meta = _load_meta(doc)
            if style_meta.get('sheet_name') == entry['sheet_title']:
                floor = min(int(style_meta.get('style_row_floor') or 0), len(style_meta.get('rows') or []))
                if floor > len(entry['rows_raw']):
                    entry['rows_raw'].extend([tuple(None for _ in entry['headers'])
                                              for _ in range(floor - len(entry['rows_raw']))])
            elapsed = round((time.perf_counter() - t0) * 1000, 1)
            stats['parse_count'] += 1
            stats['last_parse_ms'] = elapsed
            cache_started = time.perf_counter()
            entry = _parse_cache_store(key, entry)
            parse_timing['cache_store_ms'] = round((time.perf_counter() - cache_started) * 1000, 1)
        return entry, {'cache': 'miss', 'parse_ms': elapsed, 'parse_count': stats['parse_count'],
                       'parse_path': parse_path, 'fallback_reason': fallback_reason, 'parse_timing': parse_timing}


def _parts_in(names, parts):
    return sorted({p for n in names for p in parts if n == p or n.startswith(p)})


def _drawings_verdict(zf, names):
    """xl/drawings/ 的分层判决：'ok'=全是批注锚框（.vml 且对象全是 Note）——放行，
    批注数据在 xl/comments*.xml 里，openpyxl 保存时自己重写锚框；'bad'=真图形/按钮/图片
    （drawing*.vml 之外的部件，或 VML 里有 Note 之外的对象）——剔了会真丢内容，硬拒；
    None=没有 drawing 部件。锚框文件名不作数（Excel 叫 vmlDrawing*.vml，openpyxl 重写成
    commentsDrawing*.vml），一律按对象类型判。"""
    drawings = [n for n in names if n.startswith('xl/drawings/') and n != 'xl/drawings/']
    if not drawings:
        return None
    for n in drawings:
        if not n.endswith('.vml'):
            return 'bad'
        data = zf.read(n).decode('utf-8', 'ignore')
        if set(re.findall(r'ObjectType="([^"]+)"', data)) - {'Note'}:
            return 'bad'
    return 'ok'


RE_EXT_REF = re.compile(r"'\[[^\]]+\][^']*'!|\[\d+\][^!\"()+\-*/\s]*!")


def _is_external_formula(formula):
    """外链引用判定：[1]Sheet!A1 / '[1]Sheet 名'!A1 / '[路径\book.xlsx]Sheet'!A1——
    共同特征是方括号段之后最终跟着 !（工作表分隔符）。Table[列] 式结构化引用没有 !、
    ="图[1]" 字面量先剥掉——审查实证这两类都会被误判成外链、把活公式固化死。"""
    f = re.sub(r'"[^"]*"', '', formula)
    return bool(RE_EXT_REF.search(f))


def _freeze_external_formulas(wb, content):
    """外链公式固化：把引用外部工作簿的公式换成它当时显示的值（缓存值）。

    用户拍板「外链直接排除掉」——链接剔掉后公式会坏成 #REF，所以先固化：数还在、链接没了。
    ≥16 位有效数字的缓存数值转成文本逐位保住（存成数值会被 %.16g 写坏、精度闸也过不去）；
    没有缓存值的固化成空。返回固化格数。
    """
    targets = [(ws.title, cell.coordinate)
               for ws in wb.worksheets
               for _key, cell in _iter_real_cells(ws)
               if isinstance(cell.value, str) and cell.value.startswith('=')
               and _is_external_formula(cell.value)]
    if not targets:
        return 0
    try:
        wbv = load_workbook(BytesIO(content), data_only=True, keep_links=False)
    except Exception:
        frappe.throw('工作簿无法解析（外链缓存值读取失败），已只读保留原样', frappe.ValidationError)
    for title, coord in targets:
        cell = wb[title][coord]
        formula_text = cell.value
        cached = wbv[title][coord].value
        if cached is None:
            # 无缓存值（文件没被 Excel 算过）：固化成公式**原文文本**——数虽没有、
            # 线索不丢；清成空 = 公式和数一起没（审查实证的双丢）
            cell.value = formula_text
            cell.data_type = 's'
            continue
        if isinstance(cached, bool):
            pass
        elif isinstance(cached, int) and abs(cached) >= PRECISION_LIMIT:
            cached = str(cached)
        elif isinstance(cached, float) and cached == int(cached) and abs(cached) >= PRECISION_LIMIT:
            cached = str(int(cached))
        elif not isinstance(cached, (int, float, str, datetime.datetime, datetime.date)):
            cached = str(cached)
        cell.value = cached
        if isinstance(cached, str) and cached.startswith('='):
            cell.data_type = 's'  # 缓存值恰以 = 开头：按文本落，不变成新公式
    return len(targets)


def _comments_from_xml(content):
    """从包里直读批注：{(表名, 行, 列): 文本}。兜底 openpyxl 载入即弃的合并区非锚点批注
    （实证：那类便签不兜底就随保存无痕消失）。表名→表部件→批注部件全走包内关系图。"""
    out = {}
    try:
        z = zipfile.ZipFile(BytesIO(content))
        names = set(z.namelist())
        wb_xml = z.read('xl/workbook.xml').decode('utf-8', 'ignore')
        rels_xml = z.read('xl/_rels/workbook.xml.rels').decode('utf-8', 'ignore')
        rid_target = {}
        for m in re.finditer(r'<Relationship\b[^>]*>', rels_xml):
            tag = m.group(0)
            rid = re.search(r'Id="([^"]+)"', tag)
            tgt = re.search(r'Target="([^"]+)"', tag)
            if rid and tgt:
                rid_target[rid.group(1)] = tgt.group(1)
        sheet_parts = {}
        for m in re.finditer(r'<sheet\b[^>]*/>', wb_xml):
            tag = m.group(0)
            nm = re.search(r'name="([^"]+)"', tag)
            rid = re.search(r'r:id="([^"]+)"', tag)
            if not (nm and rid):
                continue
            tgt = rid_target.get(rid.group(1)) or ''
            part = tgt.lstrip('/') if tgt.startswith('/') else ('xl/' + tgt.lstrip('./'))
            sheet_parts[_xml_unescape(nm.group(1))] = part
        part_comments = {}
        for n in names:
            mm = re.match(r'xl/worksheets/_rels/([^/]+)\.xml\.rels$', n)
            if not mm:
                continue
            sheet_part = 'xl/worksheets/%s.xml' % mm.group(1)
            body = z.read(n).decode('utf-8', 'ignore')
            for tm in re.finditer(r'<Relationship\b[^>]*>', body):
                tag = tm.group(0)
                rel_type = re.search(r'Type="([^"]+)"', tag)
                tgt = re.search(r'Target="([^"]+)"', tag)
                # VML drawing paths can also contain "comments". Only the
                # comments relationship identifies the actual comment payload.
                if tgt and rel_type and rel_type.group(1).endswith('/comments'):
                    t = tgt.group(1)
                    part_comments[sheet_part] = t.lstrip('/') if t.startswith('/') else 'xl/' + t.replace('../', '')
        for sname, spart in sheet_parts.items():
            cpart = part_comments.get(spart)
            if not cpart or cpart not in names:
                continue
            cxml = z.read(cpart).decode('utf-8', 'ignore')
            for cm in re.finditer(r'<comment\s+ref="([A-Z]+)(\d+)"[^>]*>(.*?)</comment>', cxml, re.S):
                text = _xml_unescape(''.join(re.findall(r'<t[^>]*>([^<]*)</t>', cm.group(3))))
                out[(sname, int(cm.group(2)), column_index_from_string(cm.group(1)))] = text
    except Exception:
        return {}
    return out


def _xml_unescape(text):
    import html
    return html.unescape(text or '')


def _fmt_remark_value(value):
    """备注拼接时给既有值一个干净字面：日期只到日期（不带 00:00:00），其余 str()。"""
    if isinstance(value, datetime.datetime):
        if (value.hour, value.minute, value.second, value.microsecond) == (0, 0, 0, 0):
            return value.date().isoformat()
        return value.isoformat(sep=' ')
    if isinstance(value, datetime.date):
        return value.isoformat()
    return str(value)


def _extract_comments(wb, content):
    """批注提取进『备注』列（2026-10-12 用户拍板；对抗审查后重写边界）。

    规则：每表至多一个「备注」列——已有用**最右**那个（读接口同名键只剩最后一个，
    写最右才看得见），没有才加在表头最后（只有主表加列才涨结构版本）。批注文字按所在
    行进该行备注格，同一行多条用「；」连，已有内容在前、新条在后；表头行批注并进首个
    数据行。只落数据范围内（2..max_r）的行；范围外孤行、空批注、落点撞合并格、拼接将
    超 32767 字的，一律**不删原批注**（计「留原处」）——宁可不动不许弄丢。合并区非锚点
    批注 openpyxl 载入即弃，从包里 XML 兜底补读；兜底又落不了的如实计「未能保留」
    （openpyxl 装不回去，保存会没）。返回 (提取条数, 是否主表新增列, 留原处条数, 未能保留条数)。

    取格一律查稀疏格表、不许 ws.cell() 凭空造格——造出来的无值无样式格会把数据范围
    撑跳（行表整表重发正是这么来的）。
    """
    xml_comments = _comments_from_xml(content)
    xml_only = set(xml_comments)
    total, kept, lost, added = 0, 0, 0, False
    for ws in wb.worksheets:
        cells_map = getattr(ws, '_cells', None) or {}

        def _has_model_comment(r, col):
            cell = cells_map.get((r, col))
            return cell is not None and getattr(cell, 'comment', None) is not None

        def _unplaceable(entries):
            nonlocal kept, lost
            for (r, col), _t in entries:
                src = (ws.title, r, col)
                if src in xml_only and not _has_model_comment(r, col):
                    lost += 1   # 兜底读来又落不了：openpyxl 装不回，保存会没——如实报
                else:
                    kept += 1   # 模型里还有的：原批注不删，留原处

        found = {}
        for (r, col), cell in _iter_real_cells(ws):
            cm = getattr(cell, 'comment', None)
            if cm is not None:
                found[(r, col)] = str(getattr(cm, 'text', '') or '')
        for (sname, r, col), text in xml_comments.items():
            if sname == ws.title and (r, col) not in found:
                found[(r, col)] = text
        if not found:
            continue
        max_r, _max_c = _data_extent(ws)
        row1 = {col: cell.value for (r, col), cell in _iter_real_cells(ws) if r == 1}
        remark_cols = [col for col in sorted(row1, reverse=True)
                       if row1[col] is not None and str(row1[col]).strip() == '备注']
        remark_col = remark_cols[0] if remark_cols else None
        hdr_max = max([col for col, v in row1.items() if v not in (None, '')] or [0])
        placed = {}
        for (r, col) in sorted(found):
            text = (found[(r, col)] or '').strip()
            if not text:
                _unplaceable([((r, col), text)])
                continue
            if 2 <= r <= max_r:
                row_no = r
            elif r < 2:
                row_no = 2 if max_r >= 2 else None
            else:
                row_no = None
            if row_no is None:
                _unplaceable([((r, col), text)])
                continue
            placed.setdefault(row_no, []).append(((r, col), text))
        if not placed:
            continue
        if remark_col is None:
            _max_r, max_c = _data_extent(ws)
            cand = max(hdr_max, max_c) + 1
            head = cells_map.get((1, cand))
            head_ok = cand <= 16384 and (head is None or not isinstance(head, MergedCell))
            if not head_ok:
                for items in placed.values():
                    _unplaceable(items)
                continue
            if head is None:
                head = ws.cell(row=1, column=cand)  # 新列首格：本来就没有，造它不算撑范围
            head.value = '备注'
            remark_col = cand
            if ws is wb.worksheets[0]:
                added = True
        for row_no in sorted(placed):
            items = placed[row_no]
            tgt = cells_map.get((row_no, remark_col))
            tgt_marged = tgt is not None and isinstance(tgt, MergedCell)
            if tgt_marged:
                _unplaceable(items)
                continue
            piece = '；'.join(t for _src, t in items)
            existing = tgt.value if tgt is not None else None
            merged = (_fmt_remark_value(existing) + '；' + piece) if existing not in (None, '') else piece
            if len(merged) > 32767:
                _unplaceable(items)   # 超长不静默截断：既有内容原样
                continue
            if tgt is None:
                tgt = ws.cell(row=row_no, column=remark_col)
            if merged.startswith('='):
                tgt.value = merged
                tgt.data_type = 's'
            else:
                tgt.value = merged
            for (r, col), _t in items:
                src_cell = cells_map.get((r, col))
                if src_cell is not None and not isinstance(src_cell, MergedCell):
                    src_cell.comment = None
            total += len(items)
        # 批注对象清单按格现状重排（写回层的唯一事实源）：留原处的照写回
        ws._comments = [cell.comment for _k, cell in _iter_real_cells(ws)
                        if getattr(cell, 'comment', None) is not None]
    return total, added, kept, lost


class NumericParseLoss(frappe.ValidationError):
    """**整簿保存会损伤原件数值**（原件数值套了无效日期格式，openpyxl 读成 `#VALUE!`）。

    单独一类，是为了让**写路径**能分辨它：
    「这份簿不能整簿保存」与「这份簿不许编辑（宏/图表/外链等特性）」**不是一回事** ——
    前者可以改走**手术式**（只改目标格、别的格逐字节不动），
    后者必须**照旧只读**（剔了会真丢功能）。
    """


def _assert_no_numeric_parse_loss(wb, content):
    """原件数值套了无效日期格式时，openpyxl 会读成 #VALUE!。

    不能把解析器的错误当作原始值再保存。已有格手术不重写其他格；
    需要整簿保存的路径在修改和落盘前拒绝，原件真正的错误值仍可保留。
    """
    import xml.etree.ElementTree as ET
    ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
    for ws in wb.worksheets:
        candidates = {cell.coordinate for cell in getattr(ws, '_cells', {}).values()
                      if cell.data_type == 'e' and cell.value == '#VALUE!'}
        if not candidates:
            continue
        part = zipedit.sheet_part_by_title(content, ws.title)
        if not part:
            frappe.throw('无法核验工作表原始数值，本次操作未保存', frappe.ValidationError)
        with zipfile.ZipFile(BytesIO(content)) as zf, zf.open(part) as source:
            for _event, element in ET.iterparse(source, events=('end',)):
                if element.tag != ns + 'c':
                    continue
                if element.get('r') in candidates and element.get('t', 'n') == 'n' \
                        and element.find(ns + 'f') is None \
                        and element.find(ns + 'v') is not None:
                    frappe.throw('本次操作需要整簿保存，但日期格式会损伤原有数值，已拒绝且未保存；'
                                 '请先核对原文件格式', NumericParseLoss)
                element.clear()


def safe_open(content, for_write=False):
    """打开 xlsx 字节。读：只拒真坏文件；写：额外跑特性 denylist，可剔除特性（外链/自定义XML）
    则剔包 + 外链公式固化后放行。"""
    if not content or len(content) > MAX_FILE_BYTES:
        frappe.throw('文件为空或超过 20MB', frappe.ValidationError)
    try:
        zf = zipfile.ZipFile(BytesIO(content))
        names = zf.namelist()
        encrypted = any(info.flag_bits & 0x1 for info in zf.infolist())
    except zipfile.BadZipFile:
        frappe.throw('该文件不是有效的 xlsx 工作簿，已只读保留原样', frappe.ValidationError)
    if encrypted:
        frappe.throw('该工作簿已加密，已只读保留原样', frappe.ValidationError)
    if 'xl/workbook.xml' not in names or '[Content_Types].xml' not in names:
        frappe.throw('该文件不是有效的工作簿包，已只读保留原样', frappe.ValidationError)
    total = sum(info.file_size for info in zf.infolist())
    if total > MAX_ZIP_UNCOMPRESSED:
        frappe.throw('工作簿解压后过大，拒绝处理', frappe.ValidationError)
    if for_write:
        bad = _parts_in(names, WRITE_DENY_PARTS)
        if not bad and _drawings_verdict(zf, names) == 'bad':
            bad = ['xl/drawings/']
        if bad:
            frappe.throw('该工作簿含不支持的特性（宏/图表/透视/图片等），已只读保留原样，不能编辑',
                         frappe.ValidationError)
    try:
        # keep_links=False：外链部件不进工作簿模型，落盘自然不写回（剔包的那一半）。
        # 警告静音：真实大表里一票「日期格式+编号值」格会刷几千条 UserWarning，
        # 每条都有 Python 开销——静音只去掉噪音，不改变解析结果。
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            wb = load_workbook(BytesIO(content), data_only=False, keep_links=False)
    except Exception:
        frappe.throw('工作簿无法解析（可能损坏），已只读保留原样', frappe.ValidationError)
    if for_write:
        _assert_no_numeric_parse_loss(wb, content)
        stripped = _parts_in(names, STRIP_PARTS)
        frozen = _freeze_external_formulas(wb, content) if stripped else 0
        extracted, remark_added, kept, lost = _extract_comments(wb, content)
        if stripped or extracted or kept or lost or remark_added:
            wb._ss_stripped = stripped
            wb._ss_frozen = frozen
            wb._ss_extracted = extracted
            wb._ss_kept = kept
            wb._ss_lost = lost
            wb._ss_remark_added = remark_added
    return wb


def readonly_reason(content):
    """读路径给前端的只读原因（有则给，A 据此置灰）；不阻断读取。
    2026-10-12 起外链/自定义XML 不再进这里（可剔除、可编辑），只剩真不能动的。"""
    if not content:
        return None
    try:
        zf = zipfile.ZipFile(BytesIO(content))
        names = zf.namelist()
        if any(info.flag_bits & 0x1 for info in zf.infolist()):
            return '工作簿已加密，只读'
        bad = _parts_in(names, WRITE_DENY_PARTS)
        if not bad and _drawings_verdict(zf, names) == 'bad':
            bad = ['xl/drawings/']
        if bad:
            return '工作簿含不支持的特性（' + bad[0] + '），只读'
    except Exception:
        return '工作簿无法解析，只读'
    return None


def strip_notice(content):
    """剔除预告（不拦截）：只预告保存时**真会发生**的事（审查实证旧版预告与实际不符：
    零批注也承诺提取、有批注反而不预告）。只读表（硬拒）不给预告。"""
    if not content:
        return None
    try:
        zf = zipfile.ZipFile(BytesIO(content))
        names = zf.namelist()
        claims = []
        hit = _parts_in(names, STRIP_PARTS)
        if hit:
            claims.append('剔除附属内容（' + '、'.join(hit) + '），引用外链的格子固化为当前数值')
        has_comments = any(re.match(r'xl/comments\d*\.xml$', n) for n in names)
        if has_comments or _drawings_verdict(zf, names) == 'ok':
            claims.append('批注文字提取进「备注」列')
    except Exception:
        return None
    if not claims:
        return None
    return '保存时将' + '；'.join(claims)


class _literal_text(str):
    """字符串文本格：内容可能以 = 开头（批注提取拼接、用户录入），但**不是公式**。
    value_typed 只看「=」打头会误判（审查实证：备注列文本被当成公式、写路径也拒改），
    解析时把这类格标成这个子类，读写两侧都不许再当公式。"""


def cell_typed(cell):
    v = cell.value
    if isinstance(v, str) and v.startswith('=') and getattr(cell, 'data_type', '') != 'f':
        v = _literal_text(v)
    return value_typed(v)


def value_typed(value):
    # 空串/纯空白都算空：加行动作用空白格钉住行（全 None 行保存重载后会消失），读回来
    # 必须当「空」，不能变成 text 型空串去污染列类型判定。
    if value is None or (isinstance(value, str) and not value.strip()):
        return {'type': 'empty', 'value': None}
    if isinstance(value, bool):
        return {'type': 'boolean', 'value': value}
    if isinstance(value, (int, float)):
        return {'type': 'number', 'value': value}
    if isinstance(value, (datetime.datetime, datetime.date)):
        return {'type': 'date', 'value': value.isoformat()}
    text = str(value)
    if text.startswith('=') and not isinstance(value, _literal_text):
        return {'type': 'formula', 'formula': text, 'value': None}
    return {'type': 'text', 'value': text}


TYPE_LABEL = {'text': '文本', 'number': '数字', 'date': '日期', 'boolean': '布尔值'}


def _typed_equal(a, b, ignore_value=False):
    if ignore_value:
        return True
    if a.get('type') != b.get('type'):
        return False
    if a['type'] == 'number':
        try:
            return a['value'] == b['value']
        except (TypeError, ValueError):
            return False
    if a['type'] == 'date':
        try:
            return datetime.datetime.fromisoformat(str(a.get('value'))) == datetime.datetime.fromisoformat(str(b.get('value')))
        except (TypeError, ValueError):
            return a.get('value') == b.get('value')
    if a['type'] == 'formula':
        return a.get('formula') == b.get('formula')
    return a.get('value') == b.get('value')


def _precision_offenders(wb):
    """数值精度闸：任何 ≥16 位有效数字的数值格（含未改的）都会被 %.16g 写坏 → 拒编辑。"""
    hits = []
    for ws in wb.worksheets:
        for _key, cell in _iter_real_cells(ws):
            v = cell.value
            if isinstance(v, bool):
                continue
            if isinstance(v, int) and abs(v) >= PRECISION_LIMIT:
                hits.append(f'{ws.title}!{cell.coordinate}')
            elif isinstance(v, float) and v == int(v) and abs(v) >= PRECISION_LIMIT:
                hits.append(f'{ws.title}!{cell.coordinate}')
            if len(hits) >= 3:
                return hits
    return hits


def _dominant_type(values, max_probe=50):
    seen = {}
    from itertools import islice
    for value in islice(values, max_probe):
        typed = value_typed(value)
        if typed['type'] in ('empty', 'formula'):
            continue
        seen[typed['type']] = seen.get(typed['type'], 0) + 1
    return max(seen, key=seen.get) if seen else None


def _column_type(ws, col, header_row=1, max_probe=50):
    values = [ws.cell(row=r, column=col).value
              for r in range(header_row + 1, min(ws.max_row, header_row + max_probe) + 1)]
    return _dominant_type(values, max_probe=max_probe)


def _widths_of(ws):
    widths = {}
    for letter, dim in (ws.column_dimensions or {}).items():
        if dim and dim.width:
            idx = 0
            for ch in str(letter).upper():
                if not ('A' <= ch <= 'Z'):
                    idx = 0
                    break
                idx = idx * 26 + (ord(ch) - 64)
            if idx:
                widths[str(idx)] = float(dim.width)
    return widths


def _new_row_ids(existing, count):
    """Append identities without renaming or reusing any currently bound row ID."""
    used = set(existing)
    result = []
    number = len(existing) + 1
    while len(result) < count:
        candidate = 'r-%06d' % number
        number += 1
        if candidate not in used:
            result.append(candidate)
            used.add(candidate)
    return result


def _ensure_meta_rows(doc, expected, sheet_name, persist=True):
    """行身份与结构版本映射；行 ID 按位置确定性发号（不信任文件夹带），
    读路径只算不写（第二身份读不落库），写路径持久化。"""
    meta = _load_meta(doc)
    rows = meta.get('rows') or []
    if meta.get('sheet_name') == sheet_name and len(rows) > expected:
        # No row-delete operation exists here. A short parser read must never
        # silently drop fixed identities or make a later append reuse them.
        frappe.throw('读取行数少于已登记行，已停止重建行ID；请核对原文件，当前未修改',
                     frappe.ValidationError)
    if meta.get('sheet_name') != sheet_name:
        rows = ['r-%06d' % i for i in range(1, expected + 1)]
        # **只换它管的这四个键，别的键原样留着。**
        # 原来这里整个 `meta = {...}` 重建，只剩 4 个键 —— 扩展键当场被静默抹掉。
        # **扩展键有两个，丢哪个都是无声的**（2026-10-14 P8-⑥ ⑤ 实测踩到，E 复查补出第二个）：
        #   · `promotion`（晋升定义，promotion.py 写）—— 丢了 → `row_read` 认不出晋升列，
        #     **数据库那份正式值变成看不见的**，表里还留着旧值。**静默丢值。**
        #   · `ss_clean`（清洗已做标记，本文件多处写）—— 丢了 → `_fast_ctx` 的资格检查
        #     `not meta.get('ss_clean')` 不过，**每一次格值写都静默回落慢路径**
        #     （整簿重新清洗一遍再存）。**不报错、界面上看不出来，就是变慢。**
        # 触发条件一样（`sheet_name` 对不上或行数对不上），而且 `read_payload` 每次读都调本函数 ——
        # **读一次就可能抹掉，不一定要动手改结构**。所以别再加第三个扩展键却不看这里。
        meta.setdefault('primary_sheet', 'S-1')
        meta.update({'primary_sheet': meta.get('primary_sheet') or 'S-1',
                     'sheet_name': sheet_name,
                     'structure_version': int(meta.get('structure_version') or 1),
                     'rows': rows})
        if persist:
            _save_meta(doc, meta)
    elif len(rows) < expected:
        meta['rows'] = list(rows) + _new_row_ids(rows, expected - len(rows))
        if persist:
            _save_meta(doc, meta)
    return meta


def _allocate_row_ids(meta, count):
    """只在写动作分配；历史行被删除后编号不复用，不按可视位置重新发号。"""
    maximum=max([int(r[2:]) for r in meta.get('rows',[]) if re.fullmatch(r'r-\d+',r)] or [0])
    start=max(maximum+1,int(meta.get('next_row_id') or 1))
    meta['next_row_id']=start+count
    return ['r-%06d' % number for number in range(start,start+count)]


def _ensure_meta(doc, wb, persist=True):
    ws = wb.worksheets[0]
    expected = max(0, _data_extent(ws)[0] - 1)
    return _ensure_meta_rows(doc, expected, ws.title, persist=persist)


def _resolve_sheet(wb, meta, sheet_param):
    """工作表参数校验：S-N 身份或标题精确匹配；给错即拒，不静默写错表。"""
    ws = wb.worksheets[0]
    if not sheet_param or sheet_param in (meta.get('primary_sheet'), ws.title, ''):
        return ws
    for candidate in wb.worksheets:
        if sheet_param == candidate.title:
            frappe.throw('该工作表为只读（非当前编辑工作表），请选择 ' + str(meta.get('primary_sheet')),
                         frappe.ValidationError)
    frappe.throw('工作表不存在：' + str(sheet_param), frappe.ValidationError)


def _check_merged(ws, row, col):
    for rng in ws.merged_cells.ranges:
        if rng.min_row <= row <= rng.max_row and rng.min_col <= col <= rng.max_col:
            if not (row == rng.min_row and col == rng.min_col):
                frappe.throw('该单元格位于合并区域内，仅左上角可编辑', frappe.ValidationError)
            return  # 左上角锚点可写


def _sheet_row_col(ws, meta, row_id, header):
    if not row_id or row_id not in (meta.get('rows') or []):
        frappe.throw('行不存在或已变化，请重新读取', frappe.ValidationError)
    row_index = meta['rows'].index(row_id) + 2
    headers = _headers_of(ws)
    header = str(header or '')
    if header not in headers:
        frappe.throw('列不存在：' + header, frappe.ValidationError)
    return row_index, headers.index(header) + 1


def _assert_table_headers(headers):
    # 名称定位仅适用于规则表格，不能把自由文件中的同名列合并或写到另一列。
    if not headers or any(not value.strip() for value in headers) or len(set(headers)) != len(headers):
        frappe.throw('此工作簿包含空白或重复表头，请从文件中心使用原始单元格编辑器；文件不会转换为业务表。', frappe.ValidationError)
    return headers


def _headers_of(ws):
    """表头行文本清单（与读取回包 headers 同口径：None 归空串）。"""
    _, max_c = _data_extent(ws)
    return _assert_table_headers([str(ws.cell(row=1, column=c).value) if ws.cell(row=1, column=c).value is not None else ''
            for c in range(1, max_c + 1)])


def _iter_real_cells(ws):
    """按稀疏格表遍历真实存在的格（不按 dimension 物化空格）。"""
    cells = getattr(ws, '_cells', None)
    if cells:
        return list(cells.items())
    return [((cell.row, cell.column), cell) for row in ws.iter_rows() for cell in row]


def _data_extent(ws):
    """真实数据范围（最后有数据的行、列）。

    为什么不用 ws.max_row/max_column：dimension 记录会被列宽/残留样式撑到 XFD 列、
    几十万行（客户 370KB 实测 max_col=16384，按格物化 22 秒，穿 BFF 15 秒超时）。
    算法：有值格算数；无值无样式的格=我们钉住的空行格（重载后值退化为 None），也算；
    无值有样式的格=残留格式，不撑范围。
    """
    max_r, max_c = 1, 1
    for (r, c), cell in _iter_real_cells(ws):
        v = cell.value
        if v is None and getattr(cell, 'has_style', False):
            continue
        if r > max_r:
            max_r = r
        if v not in (None, '') and c > max_c:
            max_c = c
    return max_r, max_c


def _bump_structure(meta):
    """结构版本真自增并返回新值（加列/改表头后调用；加行/改表名不动结构版本）。"""
    meta['structure_version'] = int(meta.get('structure_version') or 1) + 1
    return meta['structure_version']


def _snapshot(wb):
    """全簿 typed 值 + 列宽快照（V4 差分基线）。按稀疏格表取，不物化撑爆的空格。"""
    snap = {}
    for ws in wb.worksheets:
        cells = {}
        for _key, cell in _iter_real_cells(ws):
            if cell.value is not None:
                cells[cell.coordinate] = cell_typed(cell)
        widths = {k: (float(v.width) if v is not None and v.width else None)
                  for k, v in (ws.column_dimensions or {}).items()}
        snap[ws.title] = {'cells': cells, 'widths': widths}
    return snap


def _node_typed(node):
    """从手术后的 `<c>` 节点字节读回值（**只给快路径目标格用**，不整簿重开）。"""
    import re as _re
    from xml.sax.saxutils import unescape as _base_unescape
    def _unescape(value):
        return _base_unescape(value, {'&quot;':'"', '&apos;':"'"})
    if node is None:
        return None
    fm = _re.search(rb'<f[^>]*>(.*?)</f>', node, _re.S)
    if fm:
        return {'type': 'formula', 'formula': _unescape(fm.group(1).decode('utf-8'))}
    tm = _re.search(rb'\st="([^"]+)"', node)
    typ = tm.group(1).decode() if tm else 'n'
    if typ == 'inlineStr':
        parts = _re.findall(rb'<t[^>]*>(.*?)</t>', node, _re.S)
        return {'type': 'text', 'value': _unescape(b''.join(parts).decode('utf-8'))}
    vm = _re.search(rb'<v>(.*?)</v>', node, _re.S)
    if vm is None:
        # **自闭合 `<c .../>` = 写空值**（A 2026-10-17 实测：清空格后
        # 服务端报「目标值不符」，整次回滚）。没有 <v> 就是 empty，
        # 不能落到下面的 `float('')` 失败分支变成 `number:''`。
        return {'type': 'empty', 'value': None}
    raw = vm.group(1).decode('utf-8')
    if typ == 'd':
        return {'type': 'date', 'value': raw}
    if typ == 'b':
        return {'type': 'boolean', 'value': raw == '1'}
    if typ in ('str', 's'):
        return {'type': 'text', 'value': _unescape(raw)}
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return {'type': 'number', 'value': raw}
    if val.is_integer() and '.' not in raw and 'e' not in raw.lower():
        val = int(raw)
    return {'type': 'number', 'value': val}


def _node_typed_as(node, want_type):
    """按**目标型**读回节点（`want_type='date'` 时把序列值还原成 ISO 日期串）。

    与 `value_typed` 的 date 口径同源：读出来是 `datetime`/`date` 对象；
    这里返回 **ISO 串**（跟 `intended` 里 date 的形状对齐，便于 `_typed_equal`）。
    """
    got = _node_typed(node)
    if want_type != 'date' or got is None or got.get('type') != 'number':
        return got
    try:
        import datetime as _dt
        serial = float(got['value'])
        base = _dt.datetime(1899, 12, 30)
        d = base + _dt.timedelta(days=serial)
        # 整数天 → 日期（非整数天 → 含时分秒的 datetime，按 ISO 全串给）
        return {'type': 'date',
                'value': d.date().isoformat() if float(serial).is_integer()
                         else d.isoformat()}
    except (TypeError, ValueError, OverflowError):
        return got



def _verify_surgery(saved, content, sheet_part, edits, intended):
    """**手术快路径的受控增量验证**（B03，2026-10-17 用户要求去掉无用全簿工作）。

    **为什么要换掉 `_verify_saved`**：它为了验 1 格把 9.7MB **整簿 `load_workbook`**
    一遍（3820 实测 `verify_value` 4.94s，占单格保存 5.39s 的 92%）。
    快路径本来就只替换目标 `<c>` 节点、其余 zip 条目**压缩字节直拷** ——
    整簿重开是**无用的全簿工作**，不是保证。

    **四类保证逐条落点（不降级）**：
      1. **目标值**：从新部件里取回目标 `<c>` 节点，精确比对 `intended`（不是只看类型标记）
      2. **可重开**：zip 中央目录可解析 + 被改部件 CRC（`read` 自动核）+ 工作表 XML
         **expat 流式良构解析**（不建全树，避免 34MB XML 的 GC 尖峰）
      3. **精度**：本次写入的整数 ≥16 位在入参已拒；这里再核一遍；其他格字节未动
      4. **非目标不变**：**其余 zip 条目逐字节相同**；被改部件由 `splice_sheet_xml`
         结构性只替换目标节点（再核目标节点就位）
    """
    import zipfile
    from io import BytesIO as _BIO
    import xml.parsers.expat as _expat
    part = sheet_part.decode() if isinstance(sheet_part, bytes) else sheet_part
    try:
        z0 = zipfile.ZipFile(_BIO(content))
        z1 = zipfile.ZipFile(_BIO(saved))
    except zipfile.BadZipFile:
        frappe.throw('保存校验失败：文件无法重新打开，本次未生效', frappe.ValidationError)
    # ⚠️ **不调 `testzip()`** —— 它把整包每条都解压一遍核 CRC（9.7MB，白白 ~0.5s）。
    # 其余条目是 `rebuild_zip` **压缩字节直拷**：中央目录的 CRC/大小与源包一致就足够，
    # 加上下面 `z1.read(part)` 会自动核对**被改部件**的 CRC。
    if set(z0.namelist()) != set(z1.namelist()):
        frappe.throw('保存校验失败：文件结构变化，本次未生效', frappe.ValidationError)
    # **非目标条目逐字节比对**（local header + 压缩数据原样直拷）：比 testzip 快，
    # 也比只看中央目录 CRC/大小更强（截断/错位都能抓住）。不解压。
    raw0 = zipedit.local_bytes(content)
    raw1 = zipedit.local_bytes(saved)
    part_b = part.encode()
    for name, b0 in raw0.items():
        if name == part_b:
            continue
        if raw1.get(name) != b0:
            frappe.throw('保存校验失败：未改内容被改动（' +
                         (name.decode('utf-8', 'replace') if isinstance(name, bytes) else name) +
                         '），本次未生效', frappe.ValidationError)
    xml = z1.read(part)  # read() 内部核对 CRC
    # ⚠️ **用 expat 流式解析，不用 ElementTree 建树** —— 34MB 工作表 XML 建全树
    # 会分配几百 MB、触发 GC，实测 20 次连续写尾部出现 4.5s/6.7s 尖峰；
    # expat 是 C 实现、事件即弃，只验「结构良构」不建树。
    try:
        _expat.ParserCreate().Parse(xml, True)
    except Exception:
        frappe.throw('保存校验失败：工作表 XML 结构损坏，本次未生效', frappe.ValidationError)
    # 1 目标值（精确比对，不只看 t= 标记）—— 单遍收集，**不逐格扫全文**。
    # ⚠️ **不再调 `_verify_edit_nodes`**：它按类型标记粗验；下面 `_node_typed` 的
    # 精确值比对已经同时覆盖「在不在 + 类型 + 值」，再扫一遍 34MB 是白扫（B03）。
    nodes = zipedit.cell_nodes(xml, (intended or {}).keys())
    for coord, want in (intended or {}).items():
        got = _node_typed_as(nodes.get(coord), str((want or {}).get('type') or ''))
        if got is None:
            # 写空值会序列化成自闭合 `<c .../>`；读回来就是 empty（同慢路径的
            # 「空值格退化为无值格」语义）。
            got = {'type': 'empty', 'value': None}
        if not _typed_equal(got, want):
            frappe.throw('保存校验失败：目标值不符（' + str(coord) + '），本次未生效',
                         frappe.ValidationError)
        # 3 精度
        v = (want or {}).get('value')
        if isinstance(v, int) and not isinstance(v, bool) and abs(v) >= PRECISION_LIMIT:
            frappe.throw('保存校验失败：数值精度受损（' + str(coord) + '），本次未生效',
                         frappe.ValidationError)


def _verify_saved(content, intended_sheet, intended, before,
                  allow_width_changes=None, expect=None):
    """落库前四道验证门；任一不过即抛错（事务回滚，坏文件不成为当前版本）。

    按动作白名单放行结构变化（v1.1）：加行/加列/改表头/改表名单独给出 expect
    （min_row=落盘后至少行数；headers=整行表头）。
    intended 是「本批目标格」集合 {坐标: 目标typed}（B4 批量写多格；单格写传单元素），
    V2 逐格核对、V4 仅放行集合内目标格——豁免集合必须与实际改的格完全一致。
    返回重开的 wb2 供写后预热复用（D4：不再多付一次全簿解析）。
    """
    # V1 重开
    try:
        wb2 = load_workbook(BytesIO(content), data_only=False)
    except Exception:
        frappe.throw('保存校验失败：文件无法重新打开，本次未生效', frappe.ValidationError)
    # V2 目标格（列宽写无目标格，跳过）
    if intended_sheet not in wb2.sheetnames:
        frappe.throw('保存校验失败：目标工作表丢失，本次未生效', frappe.ValidationError)
    for ref, ityped in (intended or {}).items():
        got = cell_typed(wb2[intended_sheet][ref])
        if not _typed_equal(got, ityped):
            frappe.throw('保存校验失败：目标值不符（' + intended_sheet + '!' + ref + '），本次未生效',
                         frappe.ValidationError)
    if expect:
        ws2 = wb2[intended_sheet]
        if expect.get('min_row') is not None and _data_extent(ws2)[0] < expect['min_row']:
            frappe.throw('保存校验失败：新增行未落盘，本次未生效', frappe.ValidationError)
        if expect.get('headers') is not None:
            # 表头行按真实数据宽度核对：max_column 会被残留 dimension 撑到 16384 列，
            # 拿它逐格对比永远不等（2026-10-13 大表实测「表头不符」误拦的根因）。
            got_headers = [str(ws2.cell(row=1, column=c).value)
                           if ws2.cell(row=1, column=c).value is not None else ''
                           for c in range(1, _data_extent(ws2)[1] + 1)]
            if got_headers != list(expect['headers']):
                frappe.throw('保存校验失败：表头不符，本次未生效', frappe.ValidationError)
    # V3 精度
    offenders = _precision_offenders(wb2)
    if offenders:
        frappe.throw('保存校验失败：数值精度受损（' + offenders[0] + '），本次未生效',
                     frappe.ValidationError)
    # V4 全簿值差分：仅目标格（及指定列宽）可变
    after = _snapshot(wb2)
    for title, b in before.items():
        a = after.get(title)
        if a is None:
            frappe.throw('保存校验失败：工作表 ' + title + ' 丢失，本次未生效', frappe.ValidationError)
        for ref, btyped in b['cells'].items():
            if title == intended_sheet and ref in (intended or {}):
                continue
            atyped = a['cells'].get(ref)
            if atyped is None:
                # 空值格落盘后可能退化为「无值格」（openpyxl 实测：空字符串重载回 None），
                # 语义同为空——放行；有值内容消失仍拦。
                if btyped.get('type') == 'empty':
                    continue
                frappe.throw('保存校验失败：未改内容被改动（' + title + '!' + ref + '），本次未生效',
                             frappe.ValidationError)
            if not _typed_equal(atyped, btyped):
                frappe.throw('保存校验失败：未改内容被改动（' + title + '!' + ref + '），本次未生效',
                             frappe.ValidationError)
        changed_widths = set(allow_width_changes or set())
        for letter, width in b['widths'].items():
            if letter in changed_widths:
                continue
            if a['widths'].get(letter) != width:
                frappe.throw('保存校验失败：未指定的列宽被改动（' + title + '!' + letter + '），本次未生效',
                             frappe.ValidationError)
    return wb2


def read_payload(_service, payload, _context=None):
    """files.sheet_read：表头、固定行 ID、带类型值、列宽、版本；复杂特性文件只读。

    解析缓存（N2-B6）：同一内容版本只解析一次，翻页/搜索/定位（row_ids）全部复用；
    回包 diagnostics 给 cache 命中、解析耗时与累计解析次数，供性能采样记录。
    """
    if not isinstance(payload, dict) or not payload.get('table'):
        frappe.throw('缺少表身份', frappe.ValidationError)
    seg = _Seg()
    doc = frappe.get_doc(DOCTYPE, str(payload.get('table')))
    doc.check_permission('read')  # 权限先于缓存：无权身份到不了缓存，不跨身份泄漏
    # **回收态不给读内容**（F04 反例 `afc69nlvm6`）：回收站里的东西只有「恢复」权；
    # 还能读内容 = 用户以为删了、实际还在读（数据可见性洞，G1 线）。
    # **只拦 `Recycled`、不写死「只有 Active 能读」** ——「刚上传还在解析中」那些中间态
    # 本来就该读得到（那不是回收）。**恢复后自动放行**（不误伤恢复链）。
    if doc.status == 'Recycled':
        frappe.throw('该表在回收站，恢复后才能读取', frappe.PermissionError)
    from shangshu_files import promotion as _read_promotion
    search = str(payload.get('search') or '').strip().lower()[:200]
    # 全表搜索依赖已经同步的文件索引。已知回填滞后时不能用旧命中装作当前结果，
    # 也不能为了搜索临时读取全部正式记录；恢复后仍使用同一索引缓存。
    if search and _read_promotion.writeback_pending(doc):
        frappe.throw('这份表有正式值尚未回填，搜索暂不可用；请先恢复表格同步后重试', frappe.ValidationError)
    from shangshu_files.table_relation_query import search_payload
    related = search_payload(_service, payload, _context)
    if related is not None:
        return related
    seg.mark('auth')
    content = _content(doc)
    seg.mark('read_file')
    entry, diag = _parsed(doc, content)
    seg.mark('parse')
    # 读侧只投影确定性的文件行定位；首次持久化放在确认写动作中。
    meta = _ensure_meta_rows(doc, len(entry['rows_raw']), entry['sheet_title'], persist=False)
    sheet_param = payload.get('sheet')
    if sheet_param and sheet_param not in (meta.get('primary_sheet'), entry['sheet_title'], ''):
        if sheet_param in (entry.get('sheet_titles') or []):
            frappe.throw('该工作表为只读（非当前编辑工作表），请选择 ' + str(meta.get('primary_sheet')),
                         frappe.ValidationError)
        frappe.throw('工作表不存在：' + str(sheet_param), frappe.ValidationError)
    headers = entry['headers']
    requested_headers = payload.get('headers') if 'headers' in payload else list(headers)
    if 'headers' in payload and (not isinstance(requested_headers, list) or any(not isinstance(h, str) or h not in headers for h in requested_headers)
            or len(set(requested_headers)) != len(requested_headers)):
        frappe.throw('读取字段范围包含不存在或重复的表头', frappe.ValidationError)
    requested_set = set(requested_headers)
    rows_raw = entry['rows_raw']
    want = payload.get('row_ids')
    if 'row_ids' in payload and (not isinstance(want, list) or any(not isinstance(r, str) or r not in meta['rows'] for r in want)):
        frappe.throw('读取行范围包含不存在的固定行身份', frappe.ValidationError)
    page = max(int(payload.get('page') or 1), 1)
    length = min(max(int(payload.get('page_length') or 200), 1), 500)
    all_ids = meta['rows']  # 行定位永远用完整行表，防过滤后索引漂移
    result_ids = all_ids
    # ★ **伴随授权：算一次，两处复用**（R09）。
    #   这一份同时给两处用：
    #     · **行级** —— 哪些行读得到（读不到／已回收的行一行都不许出现）；
    #     · **列级** —— 哪些列读不到（隐藏列判定）。
    #   改之前：行级算一遍（全表），隐藏列那道闸里**又算一遍**（`read_access(doc)`
    #   **不传 record_ids** ⇒ 又按全表算一次）⇒ **一次读跑两轮全表授权**。
    from shangshu_files.object_projection import read_access
    companion_access = read_access(doc, want if want is not None else all_ids)
    allowed_ids = set(companion_access['allowed_record_ids']) if companion_access else set(all_ids)
    allowed_ids -= set(meta.get('deleted_rows') or [])
    result_ids = [rid for rid in all_ids if rid in allowed_ids]
    # ★ **把刚算好的那一份传下去** ⇒ 隐藏列判定**不再触发第二轮全表**。
    hidden_headers = _read_promotion.unreadable_headers(doc, companion_access=companion_access)
    seg.mark('meta')
    if search:
        def _pos_hits(pos):
            hits = []
            for i in range(1, len(headers) + 1):
                if headers[i - 1] in hidden_headers:
                    continue
                raw = rows_raw[pos][i - 1] if pos < len(rows_raw) and i - 1 < len(rows_raw[pos]) else None
                typed = value_typed(raw)
                from shangshu_files.formulas import decorate_values
                typed = decorate_values({headers[i-1]:typed},all_ids[pos],meta,content_revision(doc),hidden_headers)[headers[i-1]]
                hay = '%s %s' % (typed.get('value') or '', typed.get('formula') or '')
                if search in hay.lower():
                    hits.append({'header': headers[i - 1] or ('列%d' % i),
                                 'cell': '%s%d' % (get_column_letter(i), pos + 2)})
            return hits

        # 权限与当前文件校验已在前面执行；缓存只复用该内容身份的搜索位置。
        identity = (str(getattr(frappe.local, 'site', '')), doc.name,
                    content_revision(doc), str(doc.current_sha256),
                    int(meta.get('structure_version') or 1), len(headers), len(all_ids), tuple(sorted(hidden_headers)))
        # 搜索命中数、坐标也属于读结果；隐藏列不能通过命中与否泄露内容。
        search_rows = ([[None if header in hidden_headers else (row[i] if i < len(row) else None)
                         for i, header in enumerate(headers)] for row in rows_raw]
                       if hidden_headers else rows_raw)
        if meta.get('formula_results'):
            # Search current computed results as well as the expression. Hidden
            # dependencies are already excluded by hidden_headers above.
            search_rows = [list(row) for row in search_rows]
            positions_by_id={rid:pos for pos,rid in enumerate(all_ids)}
            columns_by_header={header:col for col,header in enumerate(headers)}
            from shangshu_files.formulas import decorate_values
            for key,result in meta['formula_results'].items():
                rid,header=key.split('\0',1)
                pos,col=positions_by_id.get(rid),columns_by_header.get(header)
                if pos is None or col is None or pos>=len(search_rows):continue
                typed=decorate_values({header:{'type':'formula','formula':result['formula']}},rid,meta,content_revision(doc),hidden_headers)[header]
                while len(search_rows[pos])<=col:search_rows[pos].append(None)
                search_rows[pos][col]=(None if header in hidden_headers or typed.get('hidden') else
                    _literal_text(str(typed.get('value') if typed.get('value') is not None else '')+' '+str(typed.get('formula') or '')))
        positions, search_cache = search_positions(identity, search_rows, len(headers),
                                                   len(all_ids), search, value_typed)
        result_ids = [all_ids[pos] for pos in positions if all_ids[pos] in allowed_ids]
        seg.note('search_cache', search_cache)
    seg.mark('search')
    if want is not None:
        wanted_ids = set(want)
        selected = [r for r in result_ids if r in wanted_ids]
    else:
        selected = result_ids[(page - 1) * length: page * length]
    rows = []
    row_positions = {row_id: pos for pos, row_id in enumerate(all_ids)}
    for row_id in selected:
        pos = row_positions[row_id]
        item = {'row_id': row_id,
                **({'source_modified':(meta.get('companion_source_versions') or {}).get(row_id)} if meta.get('object_companion') else {}),
                # 合并说明（来自 fast 那版）：fast 在行字典里也放了一份 'styles'（表头名 → 显示格式）。
                # 本分支在**行字典建好后**统一赋 `item['styles']`（同一形状，且带行/列样式继承回落，
                # 比 fast 那份更全）—— 两份同键只会互相覆盖，取本分支这一份（fast 的来源在下面注释里保留）。
                # 行定位：工作表行号（表头行=1，首个数据行=2），与 matches[].cell 同一套坐标
                'row_index': pos + 2,
                'values': {
                    headers[i - 1] or ('列%d' % i):
                        value_typed(rows_raw[pos][i - 1] if pos < len(rows_raw) and i - 1 < len(rows_raw[pos]) else None)
                    for i in range(1, len(headers) + 1) if headers[i - 1] in requested_set}}
        # ⚠️ **只带「和默认不一样」的格**（2026-10-30 · 回包瘦身）：默认样式整表只发一次
        #   （顶层 `default_style`）⇒ 逐行不再给每一格发一份一模一样的默认样式
        #   （实测一页 1710 个格 = 1710 份重复，占整页回包 83%）。
        #   **缺项 ＝ 用表级默认** ⇒ 消费方按缺项回落 ⇒ 渲染不变。
        item['styles'] = _row_style_views(entry, pos, headers, requested_set)
        if search:
            item['matches'] = _pos_hits(pos)
        from shangshu_files.formulas import decorate_values
        decorate_values(item['values'],row_id,meta,content_revision(doc),hidden_headers)
        # Formula decoration does not mask scalar fields. Apply the same current
        # source/promoted read ACL to every returned value, not only search/audit.
        for header in hidden_headers:
            if header in item['values']:
                item['values'][header] = {'type': 'hidden', 'hidden': True, 'value': None}
        rows.append(item)
    # 页面、复制、Agent 范围动作共用这一处正式值合并：只读取本页/目标行与请求列。
    # 合并同时带回记录版本，不能以旧 XLSX 值配新数据库版本，也不能先记录旧复制值。
    from shangshu_files import service as _svc
    authority_read = _svc.merge_range_read({'table': doc.name, 'rows': rows, 'headers': headers},
                                          payload, doc=doc)
    rows = authority_read['rows']
    # **B02-7 复制日志补读取范围/值快照/身份**（2026-10-17 用户拍板）：
    # `read` 写不写台账 → **撤销/审计查不到**。**补 `_record_op`**，逐行 cells 记**值快照 + 身份**。
    # **op_id 取自 payload 的 `op_id`**（B02-7：复制/读取操作由客户端编号）；
    # 兼容旧口径再回落到 `_context.idempotency_key`（动作壳 `sheet_range_read` 走这条）。
    # ⚠️ **服务调用上下文里没有 `idempotency_key`**（`invoke_domain_service` 只放身份/角色），
    # 所以**只看 `_context` 等于永不落账** —— 第一版就是这个洞，实测台账 0 条。
    # 客户端不传 → `''` → **不记**（**不假装写了**）。
    op_id = str((payload or {}).get('op_id')
                or (_context or {}).get('idempotency_key') or '').strip()
    if op_id:
        # **逐值事实**（不是摘要）：每行一格一 cell 元素，**不存 `cell_index` 靠回包自己算**
        cells_out = [{'row_id': r['row_id'], 'header': h, 'before': r['values'][h].get('value'),
                       'cell_index': r['row_index'] + i * 0, 'col_index': i}
                      for r in rows for i, h in enumerate(r['values']) if h not in hidden_headers]
        _record_op(doc, 'files.sheet_read', op_id, cells_out, content_revision(doc), _context)
    # 读包里的 writable 标记与写入口同一判定（B3：全入口同一套授权）——
    # 有组织归属走归属/编辑共享，无归属保持旧口径；标记本身不授权，只是提示。
    seg.mark('serialize_rows')
    writable = doc.status == 'Active' and _can_write(doc)
    reason = entry['readonly']
    notice = strip_notice(content) if not reason else None
    seg.mark('capabilities')
    # 2026-10-18 主控修：my_access 五键并入 sheet_read（E01.5 / UI-002 目录契约）。
    # `read` 来自现有 read 判定（read 失败 → 整包早返，不会到这里）；`preview` 跟读走（BASE967-22 病根：错用下载判预览）；
    # `download` 来自 service._can_download（写权才带下载，管理默认读不带下载）；`write` 来自 _can_write；
    # `review` fail-closed=False（E01.4「指定审核人」产品未做，**不**填假默认）。
    # 三个时间字段一并给：A 域取 `content_modified`/`structure_modified`/`modified`，**`structure_modified` 可为 None**（结构只记版本号不记时间）。
    _can_dl = _svc._can_download(doc)
    if _can_dl:
        try:
            _read_promotion._require_all_columns_exportable(doc)
        except (frappe.PermissionError, frappe.ValidationError):
            _can_dl = False

    def _scope_allows(operation):
        """表级主体范围里，这个操作**当前用户**有没有资格。

        ⚠️ **判定按受管对象的正式定义**（决定二）—— 文件侧那份只当输入；
        取不到正式定义 ⇒ 回落文件侧（不静默收紧）。
        """
        from shangshu_files import access_scope
        from shangshu_files import promotion as _promotion_mod
        _columns, _table_access = _promotion_mod.effective_definition(doc)
        return bool(access_scope.table_allows(_table_access, operation))
    _my_access = {
        'read': True,                  # 已经过 doc.check_permission('read')
        'preview': True,               # 预览跟读走
        'download': bool(_can_dl),
        'write': bool(writable and not reason),
        'review': False,               # 审核人模型未实现，fail-closed
        # FIX-40：补上**第六维 `structure`** —— 目录接口（domain.py）一直回这一维，
        # sheet_read 却漏了 ⇒ 前端 `canStructure` 拿到 undefined ⇒ **fail-closed**
        # ⇒ 用户**永远看不到结构入口**（插列 / 插行 / 改表头 / 重命名），
        # 哪怕他就是这张表的**所有者**。
        # ⚠️ 目录那边用的是 `structure_allows`（按归属+角色投影），这边用 `_can_structure(doc)`；
        # 两者都是**既有**判断（下面 `deleted_rows` 那行本来就在用 `_can_structure(doc)`），
        # 这里只是**把已有的判断回给前端**，不改判据本身。
        'structure': bool(_svc._can_structure(doc)),
        # ---------- **降维（用户 2026-10-27 06:2x 口径）** ----------
        # 权限只有**三个操作**：读（筛）／写／下载 ⇒
        # 「可筛」「可给助手」这两个维度**不再存在**（筛并进了「读」；
        # 助手跟着账号走，账号能读它就能读）⇒ 这里**不再**多投影一维「filter」。
        # 判法与目录那边**同一份**（`access_scope.table_allows`）：按**表级主体范围**判；
        # 没定义过晋升的表没有列级限制 ⇒ 跟「读」走。
    }
    if 'manual_row_heights' not in entry:
        entry['manual_row_heights'] = _row_heights_from_xml(content,entry['sheet_title'])
    result = {
        'table': doc.name, 'table_title': doc.file_name,
        'sheet': meta['primary_sheet'], 'sheet_title': entry['sheet_title'],
        'content_version': content_revision(doc),
        'has_formulas': bool(meta.get('formula_results')),
        'structure_version': int(meta.get('structure_version') or 1),
        'headers': headers, 'rows': rows, 'total_rows': len(result_ids),
        # **表级默认样式**（＝工作簿默认 xf 的视图 `font_styles[0]`）：
        # 逐行 `row.styles` 只带「和默认不一样」的格 ⇒ 缺项的消费方回落到这一份。
        'default_style': _default_style_of(entry),
        'deleted_rows': [{'row_id':rid,'row_index':row_positions[rid]+2} for rid in meta.get('deleted_rows',[]) if rid in row_positions and (companion_access is None or rid in companion_access['allowed_record_ids'])] if _my_access['structure'] else [],
        'search': search or None,
        'column_widths': entry['widths'], 'column_width_unit': 'excel-char',
        'row_heights':entry['manual_row_heights'],'row_height_unit':'pt',
        'writable': bool(writable and not reason),
        'readonly_reason': reason, 'readonly_columns': [],
        'my_access': _my_access,
        'content_modified': str(getattr(doc, 'modified', '') or ''),
        'structure_modified': None,  # 表结构只记版本号不记时间，**如实为 None 不填假默认**
        'modified': str(getattr(doc, 'modified', '') or ''),
        # 合并说明（来自 fast 那版）：文件中心侧的可做操作声明（结构/排序/样式）也留。
        'file_operations': {'structure': True, 'sort': True, 'style': True},
        # 剔外链预告（2026-10-12 拍板）：能编辑但保存时会剔外链/自定义XML、外链格固化成当前数
        'strip_notice': notice,
        'column_types': {headers[i - 1] or ('列%d' % (i)): entry['column_types'][i - 1]
                         if i - 1 < len(entry['column_types']) else None
                         for i in range(1, len(headers) + 1)},
        # **列的取值清单**（下拉框／可搜索下拉的选项来源）。
        # 来源＝晋升定义里**逐列留的那份 `rules.options`**（`promotion.column_domains`）——
        # 清单挂在表自己的元数据里 ⇒ 不新建第二套机制，也不用每次读表再问一遍业务域。
        # ⚠️ **没声明清单的列不出现在这份里**（不猜、不编）⇒
        # 前端**只给出现在这里的列**画下拉，其余列照旧自由填写。
        'column_options': _read_promotion.column_domains(_read_promotion.load_definition(doc)),
        # 解析可观测：cache=本请求命中与否；parse_ms=本次解析耗时（hit=0）；
        # parse_count=本进程该表累计解析次数（翻 10 页应只 +1）；cache_entries=当前缓存条目数
        'diagnostics': {'cache': diag['cache'], 'parse_ms': diag['parse_ms'],
                        'parse_count': diag['parse_count'], 'cache_entries': len(_PARSE_CACHE),
                        'cache_load_ms': diag.get('cache_load_ms', 0.0), 'cache_bytes': _parse_cache_bytes(),
                        'parse_path': diag.get('parse_path'), 'fallback_reason': diag.get('fallback_reason'),
                        'parse_timing': diag.get('parse_timing'), 'timing': seg.out()},
    }

    for key in ('merged_read', 'promoted_columns'):
        if key in authority_read:
            result[key] = authority_read[key]
    from shangshu_files.table_relations import decorate_response
    return decorate_response(result)


# ---------- 日常 ZIP 增量写 ----------
# 目标规则/版本/回执统一；公式或尚未准备好的源文件须显式迁移，不自动切换保存路线。
# 日期用 OOXML 原生 ISO 值，原单元格样式保持不变。
SURGICAL_TYPES = ('text', 'number', 'date', 'empty', 'boolean')


def _fast_ctx(doc, content, payload, seg=None, companion_cells=False):
    """日常 ZIP 写的唯一上下文；不能处理时明确拒绝，绝不退到整簿保存。

    清洗／公式固化属于显式上传或迁移。缓存冷启动只建立只读索引，不能改变文件。
    """
    def reject(reason, message):
        if seg is not None:
            seg.note('fast_path', 'rejected:' + reason)
        frappe.throw(message + '；本次未保存', frappe.ValidationError)
    meta = _load_meta(doc)
    if not meta or 'rows' not in meta or not meta.get('primary_sheet') or not meta.get('ss_clean'):
        reject('migration-required', '工作簿尚未完成日常编辑准备，请先显式迁移')
    if meta.get('object_companion') and not companion_cells:
        reject('companion-structure', '原对象伴随表须经受管对象结构入口处理')
    title = meta.get('sheet_name') or ''
    if (payload.get('sheet') or '') not in ('', meta.get('primary_sheet'), title):
        reject('sheet', '工作表身份不匹配，请重新读取')
    version = content_revision(doc)
    entry = _parse_cache_get(_parse_cache_key(doc, version))
    if entry is None:
        entry, diagnostics = _parsed(doc, content, incremental=True)
        if seg is not None:
            seg.note('index_cache', diagnostics.get('cache'))
            seg.mark('load_index')
    if entry.get('readonly'):
        reject('readonly', str(entry['readonly']))
    title = entry.get('sheet_title') or title
    try:
        part = entry.get('sheet_part') or zipedit.sheet_part_by_title(content, title)
        part = part.decode() if isinstance(part, bytes) else part
        if not part:
            reject('part-missing', '工作表部件不存在')
        with zipfile.ZipFile(BytesIO(content)) as archive:
            sheet_xml = archive.read(part)
            names = archive.namelist()
            if any(n.startswith(('xl/externalLinks/', 'customXml/')) for n in names):
                reject('migration-required', '外链／自定义部件须先显式清洗')
            # 本内容版本只检查一次；覆盖其它工作表公式，不能静默保存过期缓存。
            if 'daily_formula_free' not in entry:
                entry['daily_formula_free'] = not any(
                    re.search(rb'<(?:[A-Za-z_][\w.-]*:)?f(?:\s|>|/)', sheet_xml if n == part else archive.read(n))
                    for n in names if n.startswith('xl/worksheets/') and n.endswith('.xml'))
    except (zipfile.BadZipFile, KeyError, zipedit.SurgeryError) as error:
        reject('zip', '工作簿部件无法安全定位：' + str(error))
    if not entry['daily_formula_free']:
        reject('formula-migration-required', '工作簿含公式，请先显式迁移为核实后的值；原公式仍保留')
    if not part:
        reject('part-missing', '工作表部件不存在')
    # 写入计划不能污染旧版本缓存；行元组共享，真正修改行时再复制。
    candidate_entry = dict(entry)
    candidate_entry['sheet_part'] = part
    candidate_entry['rows_raw'] = list(entry['rows_raw'])
    candidate_entry['column_types'] = list(entry.get('column_types') or [])
    with _PARSE_CACHE_GUARD:
        cache_base = {'entry': _PARSE_CACHE.get(_parse_cache_key(doc, version)), 'version': version,
                      'structure': (meta.get('primary_sheet'), int(meta.get('structure_version') or 1))}
    return {'meta': copy.deepcopy(meta), 'entry': candidate_entry, 'part': part, 'version': version,
            'sheet_xml': sheet_xml, 'cache_base': cache_base}




def _cache_raw(typed):
    """回退/写入值进解析缓存的形态：日期按 datetime/date 存（与解析条目同口径，读回才是
    date 型而不是文本），其余存原值。"""
    if (typed or {}).get('type') == 'formula':
        return typed.get('formula')
    if (typed or {}).get('type') == 'text':
        return _literal_text(typed.get('value') or '')
    if (typed or {}).get('type') == 'date':
        v = (typed or {}).get('value')
        if isinstance(v, str):
            try:
                return datetime.datetime.fromisoformat(v) if 'T' in v else datetime.date.fromisoformat(v[:10])
            except ValueError:
                return v
        return v
    return (typed or {}).get('value')


def _update_parse_after_edit(doc, entry, planned, version_no, cache_base=None):
    """手术写后缓存跟随（D4 语义）：目标格改到条目并按新版本重键——
    写后读/搜索立即见新值，绝不回旧值；跟随失败宁可作废缓存。"""
    try:
        meta = _load_meta(doc)
        row_pos = {rid: i for i, rid in enumerate(meta.get('rows') or [])}
        touched_cols = set()
        coordinates = []
        for row_id, col_index, raw_val in planned:
            pos = row_pos.get(row_id)
            if pos is None or pos >= len(entry['rows_raw']):
                continue
            row = list(entry['rows_raw'][pos])
            while len(row) < col_index:
                row.append(None)
            row[col_index - 1] = raw_val
            entry['rows_raw'][pos] = tuple(row)
            touched_cols.add(col_index)
            coordinates.append((pos, col_index - 1, raw_val))
        for ci in touched_cols:
            if ci - 1 < len(entry.get('column_types') or []):
                entry['column_types'][ci - 1] = _dominant_type(
                    (r[ci - 1] for r in entry['rows_raw'] if ci - 1 < len(r)))
        if 'formula_positions' in entry:
            positions=set(entry['formula_positions'])
            for rid,ci,value in planned:
                coordinate=(row_pos[rid]+2,ci)
                if type(value) is str and value.startswith('='):positions.add(coordinate)
                else:positions.discard(coordinate)
            entry['formula_positions']=sorted(positions)
        entry['has_formulas'] = bool(meta.get('formula_results'))
        mode = _parse_cache_delta(doc, entry, coordinates, version_no, cache_base, meta)
        if mode == 'delta':
            return mode
        _invalidate_parse(doc.name)
        _parse_cache_store(_parse_cache_key(doc, version_no), entry)
        return mode
    except Exception:
        _invalidate_parse(doc.name)
        return 'invalidated'


def _fast_write_cells(doc, content, payload, _context, seg, single=False, action_id=None,
                      projection_only=False):
    """普通、受管及混合包共用唯一计划与提交。"""
    plan = _fast_plan_cells(doc, content, payload, _context, seg, single=single, action_id=action_id)
    return _commit_cell_plan(doc, plan, _context, seg, projection_only=projection_only)


def _commit_cell_plan(doc, plan, context, seg, projection_only=False):
    from shangshu_files import promotion
    payload = plan['payload']
    # 新增行身份和 pending 来源只在当前事务中准备；后续任一规则／文件失败统一回滚。
    if plan.get('structure_changed'):
        _save_meta(doc, plan['meta'])
    if not projection_only:
        targets = list(dict.fromkeys(item['row_id'] for item in plan['cells_out']))
        formal = promotion.plan_atomic_values(doc, plan['meta'], plan['cells_out'], row_ids=targets)
        if formal is not None:
            key = str(payload.get('op_id') or (context or {}).get('idempotency_key') or '')
            committed = promotion.commit_atomic_values(doc, formal, key, _expected_record_versions(payload), row_ids=targets)
            # **写完之后的逐行受管记录版本** ⇒ 客户端存下来（它下一次写要带它）。
            # ⚠️ **不给的后果**（2026-10-29 站上实测）：客户端手里的版本变旧
            # ⇒ 下一笔被内核的乐观锁拒（「记录已被修改，请刷新后重试」）
            # ⇒ 那笔卡在输入队列队首 ⇒ 整队停 ⇒ 页面永远「有未保存」
            # ⇒ 列宽／拖列／撤回／导出全被禁 ⇒ 人以为那些功能坏了。
            plan['record_versions'] = (committed or {}).get('record_versions') or {}
            # 首次有效值可能新增绑定；不能让稍后保存的旧 plan.meta 覆盖这份新身份。
            current = _load_meta(doc)
            for name in ('promotion_binding', 'promotion_pending_rows'):
                if name in current:
                    plan['meta'][name] = copy.deepcopy(current[name])
                else:
                    plan['meta'].pop(name, None)
    result = _fast_apply_cells(doc, plan, context, seg)
    # **回执带上写完之后的受管记录版本**（客户端下一次写带它 ⇒ 不会撞自己）。
    if plan.get('record_versions'):
        result = {**result, 'record_versions': plan['record_versions']}
    return result


def _fast_plan_cells(doc, content, payload, _context, seg, single=False, action_id=None, prepared=None, restore=False):
    """计算目标格及其前后值，不落盘；不支持的输入明确拒绝，不回落整簿保存。

    正式值计划必须使用修改前的投影值，以核对受管记录与副本一致。
    """
    raw = payload.get('cells')
    if single:
        raw = [{'row_id': payload.get('row_id'), 'header': payload.get('header'),
                'value': payload.get('value')}]
    if not isinstance(raw, list) or (not raw and prepared is None):
        frappe.throw('请给出要写入的格', frappe.ValidationError)
    if any(str((item.get('value') or {}).get('type') or '') not in SURGICAL_TYPES
           for item in raw if isinstance(item, dict)):
        frappe.throw('日常编辑不支持公式或未知值类型；本次未保存', frappe.ValidationError)
    ctx = prepared if prepared is not None else _fast_ctx(doc, content, payload, seg, companion_cells=True)
    meta, entry, part = ctx['meta'], ctx['entry'], ctx['part']
    from shangshu_files.object_projection import authorize_ordinary_cells
    from shangshu_files.table_relations import guard_cell_write
    authorize_ordinary_cells(doc, raw)
    guard_cell_write(doc.name, raw)
    if prepared is None:
        _check_versions(doc, meta, payload)
    headers = entry['headers']
    rows_raw = entry['rows_raw']
    row_pos = {rid: i for i, rid in enumerate(meta.get('rows') or [])}
    col_pos = {}
    for i, h in enumerate(headers):
        col_pos.setdefault(h, i + 1)
    col_types = list(entry.get('column_types') or [])
    try:
        sheet_xml = ctx['sheet_xml']
        ranges = zipedit._merged_ranges(sheet_xml)
    except Exception:
        frappe.throw('工作表部件无法读取，本次未保存', frappe.ValidationError)
    planned = []
    seen = set()
    edits = []
    try:
        for i, item in enumerate(raw):
            where = '第 %d 格' % (i + 1)
            if not isinstance(item, dict):
                frappe.throw(where + '：格定义无效，本批未保存', frappe.ValidationError)
            row_id = str(item.get('row_id') or '').strip()
            header = str(item.get('header') or '').strip()
            if row_id not in row_pos:
                frappe.throw(where + '（行 %s）：行不存在——请先加行再写，本批未保存' % row_id,
                             frappe.ValidationError)
            if header not in col_pos:
                frappe.throw(where + '（行 %s）：表头不存在——请先加列再写，本批未保存' % row_id,
                             frappe.ValidationError)
            if headers.count(header) != 1:
                frappe.throw(where + '：目标表头重复，无法确定唯一列，本批未保存', frappe.ValidationError)
            if (row_id, header) in seen:
                frappe.throw(where + '（行 %s / 列 %s）：重复目标，本批未保存' % (row_id, header),
                             frappe.ValidationError)
            seen.add((row_id, header))
            value = item.get('value')
            if not isinstance(value, dict) or not value.get('type'):
                frappe.throw(where + '（行 %s / 列 %s）：值定义无效，本批未保存' % (row_id, header),
                             frappe.ValidationError)
            row_index = row_pos[row_id] + 2
            col_index = col_pos[header]
            coord = '%s%d' % (get_column_letter(col_index), row_index)
            hit = zipedit.in_merge(col_index, row_index, ranges)
            if hit:
                frappe.throw('该单元格位于合并区域内，仅左上角可编辑', frappe.ValidationError)
            pos = row_pos[row_id]
            raw_before = rows_raw[pos][col_index - 1] if pos < len(rows_raw) and \
                col_index - 1 < len(rows_raw[pos]) else None
            before_typed = value_typed(raw_before)
            c_type = col_types[col_index - 1] if col_index - 1 < len(col_types) else None
            v_type = str(value.get('type') or '')
            if not restore and c_type and v_type not in (c_type, 'empty', 'formula'):
                frappe.throw(where + '（行 %s / 列 %s）：类型不符——%s 须为%s' % (
                    row_id, header, header, TYPE_LABEL.get(c_type, c_type)), frappe.ValidationError)
            rawv = value.get('value')
            if v_type == 'text':
                if not isinstance(rawv, str):
                    frappe.throw('文本值无效', frappe.ValidationError)
                if len(rawv) > 32767:
                    frappe.throw('单元格文本超过 32767 字符，本批未保存', frappe.ValidationError)
                raw_after = _literal_text(rawv)
            elif v_type == 'number':
                if isinstance(rawv, bool) or not isinstance(rawv, (int, float)):
                    frappe.throw('数值无效', frappe.ValidationError)
                if not __import__('math').isfinite(rawv):
                    frappe.throw('数值无效（NaN/Inf）', frappe.ValidationError)
                if abs(rawv) >= PRECISION_LIMIT:
                    frappe.throw('该数值过长（≥16 位），保存会损伤精度，请改用文本类型', frappe.ValidationError)
                raw_after = rawv
            elif v_type == 'date':
                try:
                    raw_after = (datetime.datetime.fromisoformat(str(rawv)) if 'T' in str(rawv)
                                 else datetime.date.fromisoformat(str(rawv)[:10]))
                except Exception:
                    frappe.throw('日期无效', frappe.ValidationError)
                if getattr(raw_after, 'tzinfo', None):
                    frappe.throw('日期值不能包含时区', frappe.ValidationError)
            elif v_type == 'boolean':
                if not isinstance(rawv, bool):
                    frappe.throw('布尔值无效', frappe.ValidationError)
                raw_after = rawv
            else:
                raw_after = None
            after_typed = value_typed(raw_after)
            planned.append((row_id, header, col_index, coord, before_typed, after_typed, raw_after))
            edits.append((coord, {**value,'_replace_formula':True} if before_typed['type']=='formula' else value))
    except frappe.ValidationError:
        raise
    seg.mark('locate_scan')
    cells_out = [{'row_id': p[0], 'header': p[1], 'before': p[4], 'after': p[5]} for p in planned]
    return {'meta': meta, 'entry': entry, 'part': part, 'content': content,
            'planned': planned, 'edits': edits, 'row_pos': row_pos,
            'cells_out': cells_out, 'single': single, 'action_id': action_id,
            'sheet_xml': sheet_xml, 'payload': payload, 'cache_base': ctx.get('cache_base')}


def _fast_apply_cells(doc, plan, _context, seg):
    """手术快路径的**落盘**段：手术 → 验 → 存 → 记台账。

    **计划段已算好**（`_fast_plan_cells`）——这里只负责把计划落到文件上。
    """
    meta = plan['meta']; entry = plan['entry']; part = plan['part']; content = plan['content']
    planned = plan['planned']; edits = plan['edits']; row_pos = plan['row_pos']
    single = plan['single']; action_id = plan['action_id']
    changed = [p for p in planned if not _typed_equal(p[4], p[5])]
    if not changed and not plan.get('structure_changed'):
        result = {'table': doc.name, 'sheet': meta.get('primary_sheet'),
                  'op_id': str(plan['payload'].get('op_id') or (_context or {}).get('idempotency_key') or ''),
                  'applied': False if single else 0, 'cells': [], 'sheet_written': False,
                  'content_version': content_revision(doc), 'structure_version': int(meta.get('structure_version') or 1),
                  'has_formulas': False, 'timing': seg.out()}
        if single:
            result.update(row_id=planned[0][0], header=planned[0][1], before=planned[0][4], after=planned[0][5], value=plan['payload'].get('value'))
        return result
    changed_coords = {p[3] for p in changed}
    extra_coords = set(plan.get('extra_coords') or [])
    edits = [(coord, value) for coord, value in edits if coord in changed_coords or coord in extra_coords]
    planned = changed
    plan['cells_out'] = [item for item in plan['cells_out']
                         if not _typed_equal(item['before'], item['after'])]
    try:
        # `verify=False`：紧接着 `_verify_surgery` 会做更强验证（重开新包 + 逐格
        # 精确比对 + expat 良构）。这里再自检一遍同一份 34MB 部件是纯重复扫描
        # （B03 实测约 0.6s）。`edit_cells` 的默认自检仍给撤回/结构快路径用。
        saved = zipedit.edit_cells(content, part, edits, verify=False, expand=bool(plan.get('structure_changed')), source_xml=plan['sheet_xml'])
    except zipedit.SurgeryError as e:
        frappe.throw(str(e), frappe.ValidationError)
    seg.mark('serialize')
    # 验目标值、XML 良构及未修改 ZIP 部件；不整簿重开或全簿值快照。
    intended_cells = {p[3]: p[5] for p in planned}      # coord → after_typed
    # **静默篡改注入点**（默认关闭）—— 只用于造反例验「值写错会被抓住」。
    # 造「写错了但没人发现」不能靠 `_fault`（那是大声失败）。
    intended_cells.update({coord: typed for coord, typed in edits if coord in extra_coords})
    intended_cells = _corrupt('value-mismatch', intended_cells)
    # **受控增量验证**（B03）：不整簿重开，四类保证见 `_verify_surgery` 文档。
    # 传 `content`（手术前字节）用于「其余条目逐字节相同」的核对。
    _verify_surgery(saved, content, part, edits, intended_cells)
    seg.mark('verify_value')
    # 2026-10-18 主控修：cell_write 走快路径时**始终**用 payload.op_id（之前 `if not single else ''` 把 single 写当成不记 op_id → undo 用空 op_id 查台账找不到），
    # 单格写也必须用 _context.idempotency_key 兜底。
    payload = plan['payload']
    op_id = str(payload.get('op_id') or '').strip() or ((_context or {}).get('idempotency_key') or '')
    if single:
        note = 'sheet-edit' + ('（操作 %s）' % op_id if op_id else '（未提供 op_id，撤回需补 idempotency_key）')
    else:
        note = 'sheet-edit·批量写 %d 格' % len(planned) + ('（操作 %s）' % op_id if op_id else '（未提供 op_id）')
    _fault('file-write')
    _save_meta(doc, meta)
    version_no = _save_current(doc, saved, note=note)
    seg.mark('write_commit')
    cache_mode = _update_parse_after_edit(doc, entry,
        [(p[0], p[2], p[6]) for p in planned], version_no,
        cache_base=plan.get('cache_base') if not plan.get('structure_changed') and not extra_coords else None)
    seg.note('index_cache_update', cache_mode)
    cells_out = plan.get('audit_cells', plan['cells_out'])
    _record_op(doc, action_id or ('files.sheet_cell_write' if single else 'files.sheet_cells_write'),
               op_id, cells_out, version_no, _context)
    seg.mark('audit')
    seg.note('fast_path', 'surgery')
    _fault('post-save')
    if single:
        p = planned[0]
        return {
            'table': doc.name, 'row_id': p[0], 'header': p[1],
            'value': payload.get('value'), 'applied': True,
            'op_id': op_id, 'before': p[4], 'after': p[5],
            'content_version': version_no, 'has_formulas': bool(meta.get('formula_results')),
            'structure_version': int(meta.get('structure_version') or 1),
            'timing': seg.out(),
        }
    return {
        'table': doc.name,
        'sheet': meta.get('primary_sheet'),
        'op_id': op_id,
        'applied': len(planned),
        'formal_written': any(item.get('formal_field') for item in cells_out),
        'sheet_written': True,
        'content_version': version_no, 'has_formulas': bool(meta.get('formula_results')),
        'structure_version': int(meta.get('structure_version') or 1),
        'cells': cells_out,
        'timing': seg.out(),
    }


def _rekey_parse(doc, entry, version_no):
    """手术写后解析缓存跟随：旧版本条目作废，新版本键下复用（写后读绝不回旧值）。"""
    try:
        _invalidate_parse(doc.name)
        _parse_cache_store(_parse_cache_key(doc, version_no), entry)
    except Exception:
        _invalidate_parse(doc.name)


def _register_pending_rows(meta, row_ids, payload, context=None):
    """合法新增行的明确出处；不把历史缺失映射当作可自动重建的新记录。"""
    binding = meta.get('promotion_binding') or {}
    if not row_ids or not binding.get('object_id'):
        return
    op_id = str(payload.get('op_id') or (context or {}).get('idempotency_key') or '')
    if not op_id:
        frappe.throw('受管表新增行须有操作编号，本次未保存', frappe.ValidationError)
    pending = meta.setdefault('promotion_pending_rows', {})
    for rid in row_ids:
        pending[rid] = {'object_id': binding['object_id'], 'origin_op_id': op_id}


def _shift_layout_cache(entry, axis, index, delta):
    """结构移动后显示索引同步；不修改旧版本缓存或另存一份实际样式。"""
    component=0 if axis=='row' else 1
    def shifted(value):return value+delta if value>=index else value
    if 'style_ids' in entry:
        entry['style_ids']={((shifted(row),col) if axis=='row' else (row,shifted(col))):value
            for (row,col),value in entry['style_ids'].items()
            if not (delta==-1 and (row,col)[component]==index)}
    keys=('row_style_ids','manual_row_heights') if axis=='row' else ('column_style_ids','widths')
    for key in keys:
        if key in entry:
            entry[key]={(str(shifted(int(pos))) if isinstance(pos,str) else shifted(pos)):value
                for pos,value in entry[key].items() if not (delta==-1 and int(pos)==index)}


def _structure_relation_checks(doc, entry, meta, renames=None):
    """复用原引用约束，只装配引用规则确实需要的列，不解析或保存整簿。"""
    from shangshu_files import table_relations
    if not table_relations.has_relations(doc.name):
        return
    from openpyxl import Workbook
    book = Workbook()
    ws = book.active
    ws.append(list(entry['headers']))
    reverse = {new: old for old, new in (renames or {}).items()}
    source_headers = {item.source_header for item in table_relations.definitions(doc.name)}
    for col, header in enumerate(entry['headers'], 1):
        if reverse.get(header, header) not in source_headers:
            continue
        for index, row in enumerate(entry['rows_raw'], 2):
            if col <= len(row) and row[col - 1] is not None:
                ws.cell(index, col).value = row[col - 1]
    table_relations.before_save(doc, ws, meta, renames)


def _fast_structure(doc, content, payload, _context, seg, kind):
    """追加/插行、追加/插列、改表头的唯一 ZIP 路径；不支持的结构零写拒绝。"""
    if kind not in ('row_append', 'row_insert', 'column_append', 'column_insert', 'header_rename'):
        frappe.throw('不支持的增量结构动作', frappe.ValidationError)
    _require_structure(doc)
    ctx = _fast_ctx(doc, content, payload, seg, companion_cells=True)
    meta, entry, part = ctx['meta'], ctx['entry'], ctx['part']
    from shangshu_files.object_projection import binding_for, reject_bound_targets
    companion = binding_for(doc)
    if companion:
        if kind in ('row_append', 'row_insert'):
            frappe.throw('原对象行须经原对象动作新增，不能在伴随表另建记录', frappe.ValidationError)
        reject_bound_targets(doc, [payload.get('from_header')])
        from shangshu_core.public_api import authorize_companion_cells
        authorize_companion_cells(doc.name, [], [], operation='structure')
    _check_versions(doc, meta, payload)
    headers = list(entry['headers'])
    rows_raw = list(entry['rows_raw'])
    try:
        sheet_xml = ctx['sheet_xml']
        ranges = zipedit._merged_ranges(sheet_xml)
    except Exception:
        frappe.throw('工作表部件无法读取，本次未保存', frappe.ValidationError)

    def merged_throw(col):
        if zipedit.in_merge(col, 1, ranges):
            frappe.throw('该单元格位于合并区域内，仅左上角可编辑', frappe.ValidationError)

    if kind == 'header_rename':
        from_header = str(payload.get('from_header') or '')
        to_header = str(payload.get('to_header') or '').strip()
        if not to_header:
            frappe.throw('表头不能为空', frappe.ValidationError)
        if from_header not in headers:
            frappe.throw('列不存在：' + from_header, frappe.ValidationError)
        if to_header == from_header:
            frappe.throw('新表头与原表头相同', frappe.ValidationError)
        if to_header in headers:
            frappe.throw('表头已存在：' + to_header, frappe.ValidationError)
        col = headers.index(from_header) + 1
        merged_throw(col)
        if value_typed(entry['headers'][col - 1])['type'] == 'formula':
            frappe.throw('表头为公式，不支持直接修改', frappe.ValidationError)
        edits = [(coord_of(col, 1), {'type': 'text', 'value': to_header})]
        note = 'sheet-edit·改表头'
    elif kind in ('column_append','column_insert'):
        header = str(payload.get('header') or '').strip()
        if not header:
            frappe.throw('表头不能为空', frappe.ValidationError)
        if header in headers:
            frappe.throw('表头已存在：' + header, frappe.ValidationError)
        before_header = str(payload.get('before_header') or '').strip() if kind=='column_insert' else ''
        if before_header and before_header not in headers:
            frappe.throw('before_header 不存在：'+before_header,frappe.ValidationError)
        col = headers.index(before_header)+1 if before_header else len(headers)+1
        if len(headers) >= 16384:
            frappe.throw('列数已达上限', frappe.ValidationError)
        merged_throw(col)
        edits = [(coord_of(col, 1), {'type': 'text', 'value': header})]
        note = 'sheet-edit·末尾加列' if kind=='column_append' else 'sheet-edit·插列'
    elif kind == 'row_insert':
        # **指定行前插 N 行**（2026-10-27 · 大表手术快路）：
        # 慢路要**整本 openpyxl 往返**（15,502 行的大表实测 11.5 秒），
        # 手术路只改坐标（34 万格 235 毫秒）。
        try:
            count = int(payload.get('count', 1))
        except (TypeError, ValueError):
            frappe.throw('插入行数无效', frappe.ValidationError)
        if not 1 <= count <= MAX_BATCH_CELLS:
            frappe.throw('插入行数须在 1～%d 之间' % MAX_BATCH_CELLS, frappe.ValidationError)
        existing_ids = list(meta.get('rows') or [])
        before = str(payload.get('before_row_id') or '').strip()
        if before:
            if before not in existing_ids:
                frappe.throw('before_row_id 不存在', frappe.ValidationError)
            pos = existing_ids.index(before)
        else:
            pos = len(existing_ids)
        # ⚠️ **落点与慢路一致**：meta 的第 pos 行（0 基）之前插 ⇒ 物理第 pos+2 行之前插
        #   （第 1 行是表头，数据行从第 2 行起）。
        xlsx_pos = pos + 2
        edits = None
        note = 'sheet-edit·插行'
    else:   # row_append
        try:
            count = int(payload.get('count', 1))
        except (TypeError, ValueError):
            frappe.throw('加行数量无效', frappe.ValidationError)
        if not 1 <= count <= 50:
            frappe.throw('加行数量须在 1～50 之间', frappe.ValidationError)
        first_row = len(rows_raw) + 2
        edits = None
        note = 'sheet-edit·末尾加行'

    seg.mark('locate_scan')
    try:
        if kind == 'row_append':
            saved = zipedit.append_rows(content, part,
                                       [(first_row + i, [(1, {'type': 'text', 'value': ' '})])
                                        for i in range(count)])
        elif kind == 'row_insert':
            saved = zipedit.insert_rows(content, part, xlsx_pos, count)
        elif kind == 'column_insert':
            saved = zipedit.insert_column(content,part,col,header,source_xml=ctx['sheet_xml'])
            _verify_surgery(saved,content,part,edits,{coord_of(col,1):{'type':'text','value':header}})
        else:
            saved = zipedit.edit_cells(content, part, edits, expand=kind == 'column_append')
    except zipedit.SurgeryError as e:
        frappe.throw(str(e), frappe.ValidationError)
    seg.mark('serialize')

    existing = list(meta.get('rows') or [])
    if kind == 'row_insert':
        new_ids = _allocate_row_ids(meta, count)
        existing[pos:pos] = new_ids
        meta['rows'] = existing
        _bump_structure(meta)
        pad = (None,) * (len(headers) - 1)
        rows_raw = rows_raw[:pos] + [(' ',) + pad for _ in range(count)] + rows_raw[pos:]
        entry['rows_raw'] = rows_raw
        _shift_layout_cache(entry,'row',xlsx_pos,count)
    elif kind == 'row_append':
        # 合并说明：fast 那边的 `_allocate_row_ids(meta, count)` 从**历史最大号 +1** 接着发号
        # （删过行也不会复用旧号），本分支的 `_new_row_ids(existing, count)` 按当前长度发号
        # （删过行可能撞号）。取 fast 的（更安全）；两个函数都留着，别处仍在用。
        new_ids = _allocate_row_ids(meta, count)
        meta['rows'] = existing + new_ids
        pad = (None,) * (len(headers) - 1)
        rows_raw = rows_raw + [(' ',) + pad for _ in range(count)]
        entry['rows_raw'] = rows_raw
    elif kind in ('column_append','column_insert'):
        _bump_structure(meta)
        headers.insert(col-1,header)
        entry['headers'] = headers
        meta['headers'] = headers
        def insert_empty(row):
            padded=tuple(row)+(None,)*max(0,col-1-len(row))
            return padded[:col-1]+(None,)+padded[col-1:]
        entry['rows_raw'] = [insert_empty(row) for row in rows_raw]
        entry['column_types'] = list(entry.get('column_types') or [])
        entry['column_types'].insert(col-1,None)
        if kind=='column_insert':_shift_layout_cache(entry,'column',col,1)
        # ⚠️ **这里原来会把新列收进晋升定义名单**（标 `promoted: false`）——
        # **已按用户 2026-10-15 口径撤掉**：「**不改，理论上新加的列就是 xlsx 里面的列，
        # 不是有意义的字段，只在 xlsx 上体现**」。
        # `promotion_definition` 回答的是「**哪些列是数据库字段**」，普通列不是字段、不列。
        # **要看表头全集走 `files.sheet_read` 的 `headers`。**
        # ⚠️ **下面这三条从没被这条口径改掉，照旧**：不自动建数据库字段、
        # 不动已有列的晋升标记、不碰绑定结构版本。
    else:
        _bump_structure(meta)
        headers[col - 1] = to_header
        _rename_promoted_header(meta, from_header, to_header)
        entry['headers'] = headers
    if kind in ('row_append', 'row_insert'):
        _register_pending_rows(meta, new_ids, payload, _context)
    _structure_relation_checks(doc, entry, meta, {from_header: to_header} if kind == 'header_rename' else None)
    _fault('file-write')
    meta['ss_clean'] = True
    _save_meta(doc, meta)
    version_no = _save_current(doc, saved, note=note)
    seg.mark('write_commit')
    _rekey_parse(doc, entry, version_no)
    seg.mark('audit')
    seg.note('fast_path', 'surgery')
    _fault('post-save')
    result = {
        'table': doc.name, 'sheet': meta.get('primary_sheet'),
        'content_version': version_no, 'has_formulas': bool(meta.get('formula_results')),
        'structure_version': int(meta.get('structure_version') or 1),
        'timing': seg.out(),
    }
    if kind == 'row_append':
        result['row_ids'] = new_ids
    elif kind == 'row_insert':
        result['row_ids'] = new_ids
        result['before_row_id'] = before or None
        result['count'] = count
    elif kind in ('column_append','column_insert'):
        result.update(header=header,column_index=col,before_header=before_header or None,promoted=False)
        result['_structure_inverse']={'kind':'created_column','header':header,
            'append_only':kind=='column_append',
            'previous':headers[col-2] if col>1 else None,
            'next':headers[col] if col<len(headers) else None,
            'format_signature':zipedit.column_format_signature(ctx['sheet_xml'] if kind=='column_append' else b'',col)}
    else:
        result['from_header'] = str(payload.get('from_header') or '')
        result['to_header'] = to_header
        result['column_index'] = col
    return result





def coord_of(col_index, row_index):
    return '%s%d' % (get_column_letter(col_index), row_index)


def write_cell(payload, _context=None):
    """单格机械写入复用同一 ZIP 计划；受管字段通过同一正式记录规则。"""
    seg = _Seg()
    doc = _writable(payload.get('table'))
    if doc.status != 'Active':
        frappe.throw('回收站中的文件先恢复再改表', frappe.ValidationError)
    from shangshu_files import promotion
    promotion.require_field_rules_ok(doc, payload.get('header'), (payload.get('value') or {}).get('value'))
    seg.mark('auth')
    content = _content(doc, for_write=True)
    seg.mark('read_file')
    return _fast_write_cells(doc, content, payload, _context, seg, single=True)


MAX_BATCH_CELLS = 20000  # 一次范围写入上限（下一批 §5 B4：20,000 格一次受管动作）








def write_cells(payload, _context=None, *, projection_only=False, action_id=None):
    """单包预检／正式值差量／ZIP 仅值回填：一包一次落盘，失败由原事务恢复。"""
    seg = _Seg()
    doc = _writable(payload.get('table'))
    if doc.status != 'Active':
        frappe.throw('回收站中的文件先恢复再改表', frappe.ValidationError)
    raw = payload.get('cells')
    if not isinstance(raw, list) or not raw:
        frappe.throw('请给出要写入的格', frappe.ValidationError)
    if len(raw) > MAX_BATCH_CELLS:
        frappe.throw('一次最多写 %d 格，请按范围拆批后重试' % MAX_BATCH_CELLS, frappe.ValidationError)
    from shangshu_files import promotion
    promotion.require_fields_ok_for_targets(doc, [(item.get('header'), (item.get('value') or {}).get('value'))
                                                for item in raw if isinstance(item, dict)])
    seg.mark('auth')
    content = _content(doc, for_write=True)
    seg.mark('read_file')
    return _fast_write_cells(doc, content, payload, _context, seg,
                             action_id=action_id, projection_only=projection_only)


def _expected_record_versions(payload):
    """客户端带来的**逐行受管记录版本**（`{行 id: modified}`）。

    **没有就不给**（空 dict）——整包路径的陈旧写通常由工作簿的内容版本挡住
    （`expected_content_version`），逐行记录版本是**再加一道**。
    """
    versions = (payload or {}).get('expected_record_versions')
    if not isinstance(versions, dict):
        return {}
    return {str(key): str(value) for key, value in versions.items() if value}


OP_DOCTYPE = 'Shangshu File Center Sheet Op'
# 可受管撤回的动作。用户 2026-10-14 口径：「撤回动作要能留那个"会留下操作痕迹、
# 会查「是不是本人操作」"」—— 粘贴成包本来不在此列，导致批量粘贴既不留痕也撤不了
# （`_record_op` 6 处调用里 `paste_apply` 一处都没有）。补进来之后粘贴与单格/批量写
# 走同一条受管撤回路：查服务端台账、查是不是本人、逐格核验不覆盖别人后改。
OP_ACTIONS = ('files.sheet_cell_write', 'files.sheet_cells_write', 'files.sheet_cells_undo',
              'files.sheet_paste_apply', 'files.sheet_input_write', 'files.sheet_style_write',
              # 成包编辑（第四批）：一次成包写、一步撤回 —— 与上面同一套受管撤回路。
              'files.sheet_find_replace', 'files.sheet_fill_series', 'files.sheet_paste_special')


def _stamp_versions(doc):
    """读这张表**此刻**的定义版本与结构版本，回 `(definition_version, structure_version)`。

    **为什么台账要带这个**（X3-③，PKG-004）：台账记了「谁在什么时候把哪几格从什么改成什么」，
    但**没记「当时是按哪一版晋升定义解释的」**。于是回头读一条旧日志，只能拿**今天的定义**
    套上去解释 —— 那是 X3-③ 明令要禁的「历史日志按新定义重解释旧值」。
    带上了戳，要按旧定义解释就去查那一版。

    **在这读、不在调用点传**：`sheet.py` 本来就有自己的 `_load_meta`（同一个 `META_FIELD`），
    在这里读**不新增读法、不改 `_record_op` 签名、七个调用点一个字不动**。

    ⚠️ **没定义过的表回 `(None, 结构版本)`** —— 不是回 0、更不是回 1。
    回 0 会跟「第 0 版定义」混，回 1 会跟「第 1 版」混，**都是假值冒充真值**。
    """
    meta = _load_meta(doc)
    promo = meta.get('promotion')
    dv = promo.get('definition_version') if isinstance(promo, dict) else None
    return dv, int(meta.get('structure_version') or 1)


def _record_op(doc, action_id, op_id, cells, content_version, _context):
    """写入操作台账（B5 撤回核验源）：逐格 before/after 服务端自记，不信客户端自报。

    台账失败=整次写入失败（B6-04 反例）：内容与台账是一个整体，留半套账比不写更坏。

    **另外戳上「当时的定义/结构版本」**（X3-③）：见 `_stamp_versions`。
    """
    _fault('op-record')
    op_id = str(op_id or '').strip()
    if not op_id:
        return
    def_ver, struct_ver = _stamp_versions(doc)
    frappe.get_doc({
        'doctype': OP_DOCTYPE,
        'file': doc.name,
        'op_id': op_id[:140],
        'action_id': action_id,
        'actor_user': frappe.session.user,
        'request_key': str((_context or {}).get('idempotency_key') or '')[:140],
        'cells_json': json.dumps(cells, ensure_ascii=False, default=str),
        'definition_version': def_ver,
        'structure_version': struct_ver,
        'content_version': int(content_version or 0),
        'undone': 0,
    }).insert(ignore_permissions=True)
    if (_context or {}).get('atomic_package'):
        # The undo ledger remains operational state. The action's single log
        # receives its actual deltas, never a whole-workbook before-image.
        changes = []
        for cell in cells:
            if cell.get('structure_snapshot') or cell.get('before') == cell.get('after'):
                continue
            changes.append({
                'field': cell.get('header') or cell.get('kind') or '',
                'row_id': cell.get('row_id'), 'header': cell.get('header'),
                'kind': cell.get('kind') or 'sheet_cell',
                'before': copy.deepcopy(cell.get('before')),
                'after': copy.deepcopy(cell.get('after')),
            })
        changes.extend(copy.deepcopy(_context.pop('package_structure_changes', [])))
        _context['record_change'] = {'doctype': DOCTYPE, 'name': doc.name,
            'data': {'version': 1, 'object_id': 'files.file',
                     'object_title': str(doc.file_name), 'revision': int(content_version or 0),
                     'changes': changes}}


def read_ops(_service, payload, _context=None):
    """`files.op_history`：读这张表的**操作台账**，含**当时的定义/结构版本戳**。

    **这个口是为了「查得出历史」而开的**（X3-②③）：台账以前只写不读 ——
    `undo_cells` 内部按 `op_id` 查，但**没有任何对外能查的口**，
    于是「这一格当时按哪一版定义解释」既查不到、也验不了。

    **只读、只回台账本身**，不回文件内容 —— 要拿内容走 `files.versions` + 下载
    （那条受内容闸管，见 `promotion.require_no_pending_writeback`）。

    **排序**：`creation desc`（新→旧）。同一秒内多笔靠 `op_id` 收窄定位，
    **不猜**「哪一笔是哪一笔」。

    ⚠️ **老台账这两列是空的** —— 戳章是后加的，之前记的没有。
    **空 = 「那会儿没这个概念」，不是 0、不是「第 0 版」**。读的人分不出来时看 `undone`
    和 `content_version`，别把空当版本号。
    """
    if not isinstance(payload, dict):
        frappe.throw('缺少参数', frappe.ValidationError)
    table = str(payload.get('file') or payload.get('table') or '').strip()
    if not table:
        frappe.throw('缺少表身份', frappe.ValidationError)
    try:
        limit = max(1, min(200, int(payload.get('limit') or 50)))
    except (TypeError, ValueError):
        frappe.throw('limit 须为 1～200 的整数', frappe.ValidationError)
    doc = frappe.get_doc(DOCTYPE, table)          # 权限先于查询，同 read_payload 的口径
    doc.check_permission('read')
    # **字段 ACL 也要管日志**（口径 `:98`「**获准的日志/候选读取**均不得输出
    # 无权字段值或由它生成的泄露性摘要」）—— 台账快照里有格子的前后值，
    # 不滤掉的话「正文挡住了、日志里能翻到」，等于绕过字段权限。
    from shangshu_files import promotion as _promo
    _hidden = _promo.unreadable_headers(doc)
    _columns = _promo.load_definition(doc).get('columns') or []
    _field_headers = {c['field']: c['header'] for c in _columns if c.get('field')}
    _aliases = _load_meta(doc).get('promotion_header_fields') or {}
    def readable_history(cell):
        header = str(cell.get('header') or '')
        field = cell.get('formal_field')
        fields = [field] if field else _aliases.get(header, [])
        # Identity wins over a reused display label. Legacy snapshots without
        # identity fail closed if any recorded binding is missing or unreadable.
        return header not in _hidden and all(
            field in _field_headers and _field_headers[field] not in _hidden
            for field in fields)
    from shangshu_files.object_projection import read_access
    rows = frappe.get_all(
        OP_DOCTYPE,
        filters={'file': table},
        fields=['name', 'op_id', 'action_id', 'actor_user', 'request_key',
                'definition_version', 'structure_version', 'content_version',
                'undone', 'creation', 'cells_json'],
        order_by='creation desc', limit_page_length=limit)
    history_ids = set()
    for item in rows:
        try:
            history_ids.update(str(cell.get('row_id') or '') for cell in json.loads(item.cells_json or '[]') if isinstance(cell, dict))
        except (TypeError, ValueError):
            continue
    current_ids = set(_load_meta(doc).get('rows') or [])
    _access = read_access(doc, sorted(history_ids & current_ids))
    _visible_rows = set(_access['allowed_record_ids']) if _access is not None else None
    for r in rows:
        try:
            r['cells'] = json.loads(r.pop('cells_json') or '[]') or []
        except (TypeError, ValueError):
            # 快照坏掉**不许整条台账读不出来** —— 台账还在，只是这格的快照要不到
            r['cells'] = []
            r['cells_unreadable'] = True
        if any(c.get('structure_snapshot') for c in r['cells']):
            r['cells'] = []
            r['structure_operation'] = True
        # **读不到的晋升列：整格剔除**（含前后值、含行号定位）——
        # 只删「值」，留着 header 也等于告诉他「这列被人改过」，那仍是泄露。
        if _hidden or _aliases or _field_headers or _visible_rows is not None or any(c.get('formal_field') for c in r['cells']):
            kept = [c for c in r['cells']
                    if readable_history(c or {})
                    and (_visible_rows is None or (c or {}).get('row_id') in _visible_rows)]
            if len(kept) != len(r['cells']):
                r['cells_redacted'] = len(r['cells']) - len(kept)
                r['cells'] = kept
    return {'file': table, 'ops': rows, 'limit': limit}


def undo_cells(payload, _context=None):
    """files.sheet_cells_undo：受管撤回（B5）——按服务端台账逐格核验后反向写回。

    规矩（批计划 B5）：不整文件覆盖别人的编辑——现值还等于当时写入值的格
    才回退；被别人改过的格保持人家的新值并进 skipped 报告。**只撤本人**（批计划
    原话「只撤本人、有权、未被后改覆盖的操作」）且本人还要**当前写权**（被撤权后
    本人也撤不动，当时有权不算数）。撤回也是一次落盘（applied>0 时 content_version
    恰 +1）；什么都不用退时不落盘、版本不动。核验源=服务端台账，入参不收客户端
    自报快照。
    """
    doc = _writable(payload.get('table'))
    if doc.status != 'Active':
        frappe.throw('回收站中的文件先恢复再撤回', frappe.ValidationError)
    op_id = str(payload.get('op_id') or '').strip()
    if not op_id:
        frappe.throw('请给出要撤回的操作编号', frappe.ValidationError)
    rows = frappe.get_all(OP_DOCTYPE, filters={'file': doc.name, 'op_id': op_id},
                          fields=['name', 'action_id', 'cells_json', 'actor_user', 'undone'],
                          order_by='creation desc', limit_page_length=1)
    if not rows:
        frappe.throw('找不到该操作的台账记录，无法撤回', frappe.ValidationError)
    record = rows[0]
    if record.action_id not in OP_ACTIONS:
        frappe.throw('该操作不是格值写入，无法撤回', frappe.ValidationError)
    # 只撤本人（批计划 B5 原话「只撤本人、有权、未被后改覆盖的操作」）：
    # 属主也不能代撤别人的 op——别人的改动要纠就直接改值，不走撤回。
    if str(record.actor_user or '').lower() != frappe.session.user.lower():
        frappe.throw('只能撤回本人发起的操作', frappe.PermissionError)
    if record.undone:
        return {'table': doc.name, 'op_id': op_id, 'applied': 0, 'cells': [],
                'content_version': content_revision(doc), 'skipped': [], 'already_undone': True}
    if record.action_id in ('files.sheet_style_write', 'files.sheet_paste_special'):
        # 选择性粘贴的「只贴格式」也是**样式号**的改动（before/after 都是样式号），
        # 走同一条样式撤回路径。
        # ⚠️ 但同一个动作号下的「只贴值 / 只贴公式」是**格值**改动 —— 按录下来的格形状分，
        # 别一律走样式撤回（那会把值当成样式号还原）。
        try:
            recorded = json.loads(record.cells_json or '[]')
        except ValueError:
            recorded = []
        if record.action_id == 'files.sheet_style_write' or (recorded and recorded[0].get('kind') == 'style'):
            return _style_undo(doc, record, payload, _context)
    try:
        original = json.loads(record.cells_json or '[]') or []
    except ValueError:
        original = []
    content = _content(doc, for_write=True)
    from shangshu_files import promotion as _promo
    definition = _promo.load_definition(doc)
    field_headers = {c['field']: c['header'] for c in definition.get('columns', []) if c.get('field')}
    for item in original:
        if item.get('formal_field'):
            if item['formal_field'] not in field_headers:
                frappe.throw('字段绑定已变化，整包未撤回', frappe.ValidationError)
            item['header'] = field_headers[item['formal_field']]
    formal_targets = any(_promo.column_by_header(definition, str(item.get('header') or ''))
                         for item in original)
    seg = _Seg()
    ctx = _fast_ctx(doc, content, payload, seg, companion_cells=True)
    meta, entry = ctx['meta'], ctx['entry']
    # 撤回协议只携带 op_id；在当前文件锁下逐格核验台账后像，不要求客户端补版本。
    row_pos = {rid: index for index, rid in enumerate(meta.get('rows') or [])}
    headers = entry['headers']
    col_pos = {header: index for index, header in enumerate(headers)}
    ranges = zipedit._merged_ranges(ctx['sheet_xml'])
    cells, skipped, originals = [], [], {}
    for item in original:
        rid, header = str(item.get('row_id') or ''), str(item.get('header') or '')
        originals[(rid, header)] = item
        if rid not in row_pos or header not in col_pos or headers.count(header) != 1:
            skipped.append({'row_id': rid, 'header': header, 'reason': 'missing'})
            continue
        row, col = row_pos[rid], col_pos[header]
        if zipedit.in_merge(col + 1, row + 2, ranges):
            skipped.append({'row_id': rid, 'header': header, 'reason': 'missing'})
            continue
        values = entry['rows_raw'][row] if row < len(entry['rows_raw']) else ()
        current = value_typed(values[col] if col < len(values) else None)
        if _typed_equal(current, item.get('after') or {}):
            cells.append({'row_id': rid, 'header': header, 'value': item.get('before') or {}})
        elif _typed_equal(current, item.get('before') or {}):
            skipped.append({'row_id': rid, 'header': header, 'reason': 'already'})
        else:
            skipped.append({'row_id': rid, 'header': header, 'reason': 'changed'})
    targets = list(dict.fromkeys(item['row_id'] for item in cells))
    if formal_targets:
        if skipped:
            frappe.throw('本次操作中的内容已变化或目标不存在，整包未撤回', frappe.ValidationError)
        formal_now = _promo._load_formal(doc, row_ids=targets, fields=_promo.declared_fields(doc))
        for item in original:
            col = _promo.column_by_header(definition, str(item.get('header') or ''))
            if not col or not col.get('promoted') or not col.get('field'):
                continue
            field = col['field']
            if item.get('formal_field') and item['formal_field'] != field:
                frappe.throw('字段绑定已变化，整包未撤回', frappe.ValidationError)
            expected = item.get('formal_after', (item.get('after') or {}).get('value'))
            if (formal_now.get(item.get('row_id')) or {}).get(field) != expected:
                frappe.throw('正式值已被后续操作修改，整包未撤回', frappe.ValidationError)
    # 写之前那两道：**能力按列**过（同一列同一主体，判定结果一样，不必逐格重问）、
    # **值域规则逐格**过（规则看的是值）。
    # ⚠️ 原来这里是**逐格**问能力 ⇒ 真大表 1,000 格撤回时能力投影被调 1,002 次
    #    （≈1.3 秒）。粘贴路径早就按列去过一遍（`plan_atomic_values`），
    #    **撤回路径漏了** ⇒ 这一轮补齐（判定口径一个字没改）。
    _promo.require_package_rules_ok(
        doc,
        [{'header': item['header'],
          'value': (item.get('value') or {}).get('value'),
          'check_rules': originals[(item['row_id'], item['header'])].get('formal_before_present') is not False}
         for item in cells],
        definition=definition)
    if not cells:
        return {'table': doc.name, 'op_id': op_id, 'applied': 0, 'cells': [], 'skipped': skipped,
                'content_version': content_revision(doc), 'structure_version': int(meta.get('structure_version') or 1)}
    plan = _fast_plan_cells(doc, content, {**payload, 'cells': cells, 'op_id': op_id + ':undo'},
                           _context, seg, action_id='files.sheet_cells_undo', prepared=ctx, restore=True)
    restore_versions = {}
    for item in plan['cells_out']:
        previous = originals[(item['row_id'], item['header'])]
        item['restore_formal_absent'] = previous.get('formal_before_present') is False
        item['formal_before_version'] = previous.get('formal_before_version') or ''
        if item['formal_before_version']:
            restore_versions[item['row_id']] = item['formal_before_version']
    formal = _promo.plan_atomic_values(doc, meta, plan['cells_out'], row_ids=targets)
    committed = None
    if formal is not None:
        committed = _promo.commit_atomic_values(doc, formal, op_id, _expected_record_versions(payload),
                                   restore_versions or None, row_ids=targets)
        current_meta = _load_meta(doc)
        for name in ('promotion_binding', 'promotion_pending_rows'):
            if name in current_meta:
                meta[name] = copy.deepcopy(current_meta[name])
            else:
                meta.pop(name, None)
    # 兼容撤回回执：before 是恢复后的值，after 是被撤掉的值；实际写入计划不倒置。
    for item in plan['cells_out']:
        item['before'], item['after'] = item['after'], item['before']
    result = _fast_apply_cells(doc, plan, _context, seg)
    frappe.db.set_value(OP_DOCTYPE, record.name, 'undone', 1, update_modified=False)
    # ⚠️ **撤回必须回传「撤回之后的逐行受管记录版本」**（2026-10-29 站上实测）：
    #   撤回是**逆向写入** ⇒ 值回到上一版、**版本也回到上一版**（受管记录的版本栈）
    #   ⇒ 客户端手里那份版本**当场变新** ⇒ 下一笔会被自己的旧版本拒
    #   （人话：「记录已被修改，请刷新后重试」）⇒ 不回传就必然撞。
    record_versions = (committed or {}).get('record_versions') or {}
    return {**result, 'op_id': op_id, 'skipped': skipped,
            **({'record_versions': record_versions} if record_versions else {})}


def _row_heights_from_xml(content,title):
    """读回文件里**固定了高度**的那些行（键是含表头的 Excel 行号）。

    ⚠️ **「没设高度」的行不返回那个键**（2026-10-29）：「恢复自动行高」写下去的行
      在 xlsx 里**没有** `ht`／`customHeight` ⇒ 这里就**没有**它的键
      ⇒ 上层据此知道「这一行是自动行高」，不会拿旧的手动高盖回去。
    """
    part=zipedit.sheet_part_by_title(content,title)
    xml=zipedit.read_sheet(content,part)
    result={}
    for tag in re.findall(rb'<row\b[^>]*>',xml):
        row=re.search(rb'\br="(\d+)"',tag);height=re.search(rb'\bht="([\d.]+)"',tag)
        if row and height and re.search(rb'\bcustomHeight="1"',tag):
            result[row.group(1).decode()]=float(height.group(1))
    return result


def _row_height_surgery(content,part,heights):
    """改写文件里的行高。**值 0 ＝ 恢复自动行高**（2026-10-29 用户口径：
    「再点一次自动行高」的回头路 —— 手拖过的行要能退回去）。

    ⚠️ **为什么用 0 表示「恢复自动」**：行高**存在 xlsx 文件里** ⇒ 是**全表共享**的
      ⇒ 「恢复自动」也得**写回文件**（否则刷新一下又变回手拖的高度）。
      值域是「行高（pt）」⇒ 正数是高度 ⇒ **0 拿来当「这一行没有固定高度」的记号**
      ⇒ 写下去就是**不写** `ht`／`customHeight` ⇒ 打开就是自动行高。
    """
    import math
    if not isinstance(heights,dict) or not 1<=len(heights)<=1000:
        raise ValueError('一次须修改1到1000行的行高')
    xml=zipedit.read_sheet(content,part)
    xml=re.sub(rb'<sheetData\b([^>]*?)/>',rb'<sheetData\1></sheetData>',xml,count=1)
    for key,value in heights.items():
        if not str(key).isdigit() or not 2<=int(key)<=1048576 or isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not 0<=value<=409:
            raise ValueError('行号或行高无效')
        number=int(key);pattern=re.compile(rb'<row\b[^>]*\br="'+str(number).encode()+rb'"[^>]*>')
        match=pattern.search(xml)
        if not match:
            if float(value)==0:
                # **恢复自动**：那一行本来就没有固定高 ⇒ 不用动（别凭空造一行出来）。
                continue
            # Blank rows still have a physical layout even before a business row exists.
            candidates=list(re.finditer(rb'<row\b[^>]*\br="(\d+)"',xml))
            end=xml.find(b'</sheetData>')
            if end<0:raise ValueError('工作表数据段不支持设置行高')
            pos=next((m.start() for m in candidates if int(m.group(1))>number),end)
            xml=xml[:pos]+b'<row r="'+str(number).encode()+b'" ht="'+str(value).encode()+b'" customHeight="1"></row>'+xml[pos:]
            continue
        tag=re.sub(rb'\s(?:ht|customHeight)="[^"]*"',b'',match.group())
        suffix=b'/>' if tag.endswith(b'/>') else b'>'
        if float(value)>0:
            tag=tag[:-len(suffix)]+b' ht="'+str(value).encode()+b'" customHeight="1"'+suffix
        # **值 0 ⇒ 不写 ht／customHeight** ⇒ 那一行回到自动行高（读回来也没有它的键）。
        xml=xml[:match.start()]+tag+xml[match.end():]
    saved=zipedit.rebuild_zip(content,{part:xml})
    check=_row_heights_from_xml(saved,_title_for_part(content,part))
    for key,value in heights.items():
        row=str(int(key))
        if float(value)==0:
            if row in check:raise ValueError('行高写后核验失败')
        elif check.get(row)!=float(value):raise ValueError('行高写后核验失败')
    return saved


def _title_for_part(content,part):
    # resolve through workbook relationships, without loading any cell values
    import xml.etree.ElementTree as ET
    with zipfile.ZipFile(BytesIO(content)) as archive:
        root=ET.fromstring(archive.read('xl/workbook.xml'))
    for node in root.iter():
        if node.tag.endswith('}sheet') and zipedit.sheet_part_by_title(content,node.attrib['name'])==part:
            return node.attrib['name']
    raise ValueError('无法定位行高工作表')


def update_row_heights(payload,_context=None):
    doc=_writable(payload.get('table'));content=_content(doc,for_write=True)
    meta=_load_meta(doc);_check_versions(doc,meta,payload)
    entry,_diag=_parsed(doc,content)
    if entry.get('readonly'):frappe.throw(entry['readonly'],frappe.PermissionError)
    if payload.get('sheet') not in (None,'',meta.get('primary_sheet'),entry['sheet_title']):
        frappe.throw('工作表不匹配',frappe.ValidationError)
    try:
        saved=_row_height_surgery(content,zipedit.sheet_part_by_title(content,entry['sheet_title']),payload.get('row_heights'))
    except (ValueError,zipedit.SurgeryError) as error:frappe.throw(str(error),frappe.ValidationError)
    revision=_save_current(doc,saved,note='sheet-edit·行高')
    _invalidate_parse(doc.name)
    return {'table':doc.name,'applied':True,'row_heights':payload['row_heights'],
            'content_version':revision,'structure_version':int(meta.get('structure_version') or 1)}


def _auto_fit_widths(content, part, columns, meta, payload):
    """按内容算列宽（excel-char）。**不新开口**：算完并进同一条 layout 写入口。"""
    from shangshu_files.column_fit import fit_width
    limit = 2000
    wb = safe_open(content, for_write=False)
    ws = _resolve_sheet(wb, meta, payload.get('sheet'))
    headers = _headers_of(ws)
    widths, measured = {}, 0
    total_rows = int(ws.max_row or 1)
    last_row = min(total_rows, limit + 1)
    for column in columns:
        if not isinstance(column, int) or isinstance(column, bool) or not 1 <= column <= len(headers):
            frappe.throw('列序号无效：%s' % column, frappe.ValidationError)
        texts = [headers[column - 1]]
        rows_read = 0
        for row in ws.iter_rows(min_row=2, max_row=last_row, min_col=column, max_col=column, values_only=True):
            value = row[0] if row else None
            if value is None:
                continue
            if isinstance(value, (datetime.datetime, datetime.date)):
                texts.append(value.isoformat())
            elif isinstance(value, str):
                texts.append(value)
            else:
                texts.append(str(value))
            rows_read += 1
        widths[str(column)] = fit_width(texts)
        measured = max(measured, rows_read)
    return widths, measured, min(total_rows - 1, limit)


def update_layout(payload, _context=None):
    """files.sheet_layout_update：列宽写（只并入给出的列，结构版本不变；同样过验证门）。

    「按内容自动算宽」也走这一条：先按内容算，再并进同一份 column_widths 落盘，
    不另开一个动作口（口径见 FIX-18 矩阵：自动适应尺寸＝后端算宽 + 同一条 layout 写入口）。
    """
    doc = _writable(payload.get('table'))
    content = _content(doc, for_write=True)
    meta, entry, part = _style_context(doc, content, payload)
    _check_versions(doc, meta, payload)
    widths = dict(payload.get('column_widths') or {})
    auto_columns = payload.get('auto_fit_columns') or []
    measured_rows = 0
    scanned_rows = 0
    if auto_columns:
        if not isinstance(auto_columns, list) or not 1 <= len(auto_columns) <= 64:
            frappe.throw('自动算宽一次最多 64 列', frappe.ValidationError)
        computed, measured_rows, scanned_rows = _auto_fit_widths(content, part, auto_columns, meta, payload)
        widths.update(computed)
    if not widths:
        frappe.throw('请给出要修改的列宽', frappe.ValidationError)
    try:
        saved = zipedit.edit_column_widths(content, part, widths)
    except (zipedit.SurgeryError, ValueError, OverflowError) as error:
        frappe.throw(str(error), frappe.ValidationError)
    version_no = _save_current(doc, saved, 'sheet-column-width')
    # Drop the parsed column metadata only after persistence; do not publish speculative widths.
    _invalidate_parse(doc.name)

    return {
        'table': doc.name, 'column_widths': widths, 'applied': True,
        'content_version': version_no, 'has_formulas': bool(meta.get('formula_results')),
        'structure_version': int(meta.get('structure_version') or 1),
        'auto_fit_rows_measured': measured_rows, 'auto_fit_rows_scanned': scanned_rows,
    }


def _structure_open(payload):
    """结构动作共用入口：可写核验 → **结构权真判** → 开簿 → 版本闩。"""
    doc = _writable(payload.get('table'))
    _require_structure(doc)
    content = _content(doc, for_write=True)
    wb = safe_open(content, for_write=True)
    meta = _ensure_meta(doc, wb)
    _check_versions(doc, meta, payload)
    ws = _resolve_sheet(wb, meta, payload.get('sheet'))
    # ⚠️ **这里不再重算公式**（2026-10-27 · 性能）：
    #   旧实现在这里算**一遍**，紧跟着 `_save_with_gates` 又算**一遍**
    #   （那边会先 `relocate` 再 `recalculate`，**结果覆盖这里那份**）
    #   ⇒ 这一遍是**纯重复**，而在大表上**一遍就要几秒**（公式格扫描 ＋ 依赖重算）
    #   ⇒ 结构动作在大表上「慢一倍」就有它一份。
    #   公式的错误（FormulaError）在**保存前**那次算里照样会报，**校验没松**。
    wb._ss_structure_before = copy.deepcopy(meta)
    return doc, wb, meta, ws


def _gate_precision(wb):
    if _precision_offenders(wb):
        frappe.throw('该工作簿含超长数值编号（≥16 位数值），保存会损伤其精度，已拒绝编辑；请先将该列转为文本',
                     frappe.ValidationError)


def _pin_empty_rows(ws, rows):
    """空行钉住：纯空行在第二次保存会整行消失（openpyxl 两轮实测：一轮在、二轮掉），
    行数一变 _ensure_meta 就整表重新发号、旧行 ID 全体作废。
    每次落盘前把纯空行首列写空格钉住（读回时 value_typed 归为 empty，不污染列类型；
    空串会被 openpyxl 归一成 None，钉不住）。"""
    cols = max(1, _data_extent(ws)[1])
    for i in range(len(rows or [])):
        r = i + 2
        vals = [ws.cell(row=r, column=c).value for c in range(1, cols + 1)]
        if all(v is None or (isinstance(v, str) and not v.strip()) for v in vals):
            ws.cell(row=r, column=1).value = ' '


def _save_with_gates(doc, wb, ws, meta, before=None, intended=None,
                     allow_width_changes=None, expect=None, batch_note=None, seg=None):
    """精度闸 → 钉空行 → 校验快照 → 落盘验证 → 元数据 → 更新当前文件 → 注入点。

    intended：本批目标格集合 {坐标: typed}（B4 批量）；单格/结构动作传单元素或 None。
    batch_note：批量写在版本记录里留「本批改了 N 格」的可核信息（B5 撤回溯源）。
    """
    if seg is None:
        seg = _Seg()
    from shangshu_files import formulas, promotion, object_projection
    previous = getattr(wb, '_ss_structure_before', None)
    if previous and previous.get('formula_results'):
        try:
            formulas.relocate(ws, meta, previous, getattr(wb, '_ss_header_renames', None))
        except formulas.FormulaError as error:
            frappe.throw(str(error), frappe.ValidationError)
    object_projection.before_save(doc,ws,meta)
    from shangshu_files import table_relations
    table_relations.before_save(doc,ws,meta,getattr(wb,'_ss_header_renames',None))
    # ⚠️ **没有公式 ⇒ 整段跳过**（2026-10-27 · 性能）：
    #   重算的**成本大头是「算之前把正式值取出来」**（`_load_formal` ⇒ 整本受管记录读一遍，
    #   15,502 行的大表要好几秒）⇒ 而没有公式的表那些值**一个都用不上** ⇒ 纯浪费。
    #   ⇒ 先问一句有没有公式（只扫不排，约 0.3 秒），没有就不算、**也不去取正式值**。
    formula_values = {}
    if formulas.has_formulas(ws):
        try:
            formula_values = formulas.recalculate(ws, meta, promotion.formula_formal_values(doc, ws, meta),
                                                  meta.get('promotion') or {})
        except formulas.FormulaError as error:
            frappe.throw(str(error), frappe.ValidationError)
    _gate_precision(wb)
    _pin_empty_rows(ws, meta.get('rows'))
    before_snapshot = before if before is not None else _snapshot(wb)
    seg.mark('snapshot_before')
    _fault('file-write')
    out = BytesIO()
    wb.save(out)
    saved = formulas.write_cached_values(out.getvalue(), ws.title, formula_values)
    seg.mark('serialize')
    wb2 = _verify_saved(saved, ws.title, intended, before_snapshot,
                        allow_width_changes=allow_width_changes, expect=expect)
    seg.mark('verify_reopen')
    if getattr(wb, '_ss_remark_added', False):
        # 提取批注新增了「备注」列 = 表结构变化，结构版本 +1（前端列列表按它刷新）
        meta['structure_version'] = int(meta.get('structure_version') or 1) + 1
    meta['formula_compat_ready'] = True
    meta['ss_clean'] = True  # 慢路径保存=清洗已做（剔外链/批注进备注），之后格值写可走手术快路径
    _save_meta(doc, meta)
    # 版本记录留剔除/提取痕迹：用户日后翻版本历史能看出这一版动了什么（拍板的可观察落点）
    extras = []
    if getattr(wb, '_ss_stripped', None):
        extras.append('剔除' + '、'.join(wb._ss_stripped))
    if getattr(wb, '_ss_frozen', 0):
        extras.append('外链公式固化 %d 格' % wb._ss_frozen)
    if getattr(wb, '_ss_extracted', 0):
        extras.append('批注提取 %d 条进备注列' % wb._ss_extracted)
    if getattr(wb, '_ss_remark_added', False):
        extras.append('新增备注列')
    if getattr(wb, '_ss_kept', 0):
        extras.append('%d 条未提取留原处' % wb._ss_kept)
    if getattr(wb, '_ss_lost', 0):
        extras.append('%d 条合并区批注未能保留' % wb._ss_lost)
    if batch_note:
        extras.append(batch_note)
    note = 'sheet-edit' + ('·' + '，'.join(extras) if extras else '')
    version_no = _save_current(doc, saved, note=note)
    seg.mark('write_commit')
    _invalidate_parse(doc.name)  # 内容版本已推进：旧解析结果即刻作废（反例：改一格不命中旧缓存）
    _warm_parse_from_wb(doc, wb2)  # D4 写后预热：复用验证门重开的簿，写完即命中，不再冷解析
    seg.mark('warm')
    _fault('post-save')
    return version_no


def sheet_sort(payload, _context=None):
    """`files.sheet_sort`：**全表按列服务端排序**（A 的 BASE967-50/51 依赖）。

    **为什么必须在服务端排**（A 的 G1 门槛级反例）：
    客户端只排当前页 → 100/10000 = 静默给错结果（页内顺序对、整体顺序错），
    用户看到的"第 N 大"全是错的。**必须服务端拿到全行再排**。

    **入参**（与 A 在 `uds:/tmp/cc-socks/...` 那条定的契约对齐）：
      · `table`                    —— 表身份（必填）
      · `column`                   —— 排序列表头（必填，不在表里 → 拒）
      · `direction`                —— `'asc'` / `'desc'`，**默认 `'asc'`**
      · `expected_content_version` —— 乐观锁，**必填**（缺 = 拒）
      · `expected_structure_version`—— 乐观锁，**必填**（缺 = 拒）

    **出参**：
      · `rows`                  —— **整表排好的行**（不是当前页，**A 按 `row_id` 重排视图**）
      · `row_id`                —— 稳定键（行身份；A 不准按 index 排）
      · `total_rows`             —— 行数
      · `content_version`        —— 当前内容版本
      · `structure_version`      —— 当前结构版本
      · `timing`                 —— 段耗时（sort / parse / serialize）

    **结构版本前进 → 拒**（B 的承诺，row_id 映射错位风险）：
    排序期间任何**结构变化**（加列/改表头/删列）→ 行号重排 → row_id 映射错位。
    **内容变化**（cell_write）不拒（行没移动，row_id 还在）—— 写完回读再排。

    **只读** —— 不写文件、不 bump 版本、不写 op 台账。

    **两种载荷形状（2026-10-21 合并 fast 之后补的兼容）**：
      · `column`（**我们线的前端 excel-univer 发它**，另带 `identity_only`）—— 下面这段原实现：
        **只算排序后的视图**，不移动文件行、不 bump 版本（前端拿回包里的 `row_id` 自己重排视图）。
      · `header`（**fast 那条线发它**）—— **同一个意思**（排序列的**表头名**），
        但那条线要**整表落盘**：移动整行、生成新版本、写 op 台账
        （`sheet_operations.sort_rows`，fast 侧的实现，原样接过来）。
      发哪个形状就走哪条线自己的语义；**前端那一侧一个字都不用改**。
    ⚠️ 这两条语义**不同**（只读视图 vs 落盘移动行），是「两套都在」而不是「合成一个」——
    合成会让前端的结构版本失效（落盘要 bump structure_version），那次改动已记在
    `install.py` 的版本说明里。
    """
    value = dict(payload or {}) if isinstance(payload or {}, dict) else {}
    column = str(value.get('column') or '').strip()
    header = str(value.get('header') or '').strip()
    if not column and header:
        # fast 那条线的载荷形状：整表落盘排序（移动整行、生成新版本）。
        from shangshu_files import sheet_operations
        value.setdefault('direction', 'asc')
        return sheet_operations.sort_rows(value, _context)
    payload = value
    if not isinstance(payload, dict) or not payload.get('table'):
        frappe.throw('缺少表身份', frappe.ValidationError)
    column = str(payload.get('column') or '').strip()
    if not column:
        frappe.throw('column 必填（要排序的列表头；也可用 header，两者是同一个意思）',
                     frappe.ValidationError)
    direction = str(payload.get('direction') or 'asc').strip().lower()
    if direction not in ('asc', 'desc'):
        frappe.throw("direction 必须是 'asc' 或 'desc'：%r" % direction,
                     frappe.ValidationError)
    if 'expected_content_version' not in payload or 'expected_structure_version' not in payload:
        frappe.throw('expected_content_version 与 expected_structure_version 都必填（乐观锁）',
                     frappe.ValidationError)

    doc = frappe.get_doc(DOCTYPE, str(payload.get('table')))
    doc.check_permission('read')
    if doc.status == 'Recycled':
        frappe.throw('该表在回收站，恢复后才能读取', frappe.PermissionError)
    content = _content(doc)
    entry, _diag = _parsed(doc, content)
    meta = _ensure_meta_rows(doc, len(entry['rows_raw']), entry['sheet_title'], persist=False)
    cur_content = content_revision(doc)
    cur_structure = int(meta.get('structure_version') or 1)

    # 乐观锁：**两个版本都核**（结构变化会挪行 → row_id 错位是 silent bug）
    try:
        if int(payload['expected_content_version']) != cur_content:
            frappe.throw('文件已被其他操作修改（版本冲突：当前 content=%d）' % cur_content,
                         frappe.ValidationError)
        if int(payload['expected_structure_version']) != cur_structure:
            frappe.throw('表头已变化（版本冲突：当前 structure=%d）' % cur_structure,
                         frappe.ValidationError)
    except (TypeError, ValueError):
        frappe.throw('expected_content_version/structure_version 必须是整数',
                     frappe.ValidationError)

    seg = _Seg()
    headers = entry['headers']
    rows_raw = entry['rows_raw']
    all_ids = list(meta.get('rows') or [])
    if not all_ids:
        return {'rows': [], 'total_rows': 0,
                'content_version': cur_content, 'structure_version': cur_structure,
                'timing': seg.out()}

    # 列不在表里 → 拒（不猜哪一列排）
    if column not in headers:
        frappe.throw('列不存在：%s' % column, frappe.ValidationError)
    from shangshu_files import promotion
    hidden = promotion.unreadable_headers(doc)
    if column in hidden:
        frappe.throw('无权按该字段排序', frappe.PermissionError)
    col_idx = headers.index(column)
    positions = {rid: pos for pos, rid in enumerate(all_ids)}
    from shangshu_files.object_projection import read_access
    companion_access = read_access(doc, all_ids)
    visible_ids = set(companion_access['allowed_record_ids']) if companion_access is not None else set(all_ids)
    visible_ids -= set(meta.get('deleted_rows') or [])
    seg.mark('sort')

    # 取这一列的 typed 值（**同读路径**的 `value_typed` —— 排序口径跟显示口径一致）
    def _sort_key(rid):
        pos = positions[rid]
        raw = rows_raw[pos][col_idx] if pos < len(rows_raw) and col_idx < len(rows_raw[pos]) else None
        typed = value_typed(raw)
        if typed.get('type') == 'formula':
            from shangshu_files.formulas import decorate_values
            typed = decorate_values({column: typed}, rid, meta, cur_content, hidden)[column]
            typed = value_typed(typed.get('value'))
        return typed

    # **`empty` 排末尾**（升序降序都如此）—— 升序时空放最前会污染"前 N 大"语义
    # Python 3：`None < 任何` 抛 TypeError，必须分桶
    empties, keyed = [], []
    for rid in all_ids:
        if rid not in visible_ids:
            continue
        typed = _sort_key(rid)
        if typed.get('type') == 'empty' or typed.get('value') in (None, ''):
            empties.append(rid)
            continue
        keyed.append((typed, rid))
    # 主键：type 次序（**number < text < date < boolean**）保口径稳定；**同 type 内**按 value
    # 字符串按 Python 默认 str 比较（locale 敏感暂不处理，约定 ASCII）
    _TYPE_ORDER = {'number': 0, 'date': 1, 'text': 2, 'boolean': 3}
    keyed.sort(key=lambda kv: (_TYPE_ORDER.get(kv[0].get('type'), 99), kv[0].get('value')),
               reverse=(direction == 'desc'))
    sorted_ids = [rid for _, rid in keyed] + empties
    seg.mark('sort_done')

    # **回包与 `sheet_read` 同形状**（headers + values + row_id + row_index）——
    # A 端消费路径**不写第二套解析**。
    rows = []
    for rid in sorted_ids:
        pos = positions[rid]
        rows.append({
            'row_id': rid,
            'row_index': pos + 2,  # 1=表头，2=首数据行（**只是当前未排前位置**，A 不要消费）
            **({} if payload.get('identity_only') else {'values': {
                headers[i - 1] or ('列%d' % i):
                    value_typed(rows_raw[pos][i - 1] if pos < len(rows_raw)
                                and i - 1 < len(rows_raw[pos]) else None)
                for i in range(1, len(headers) + 1) if headers[i - 1] not in hidden
            }})
        })
    seg.mark('serialize')
    return {'rows': rows, 'total_rows': len(rows),
            'content_version': cur_content, 'structure_version': cur_structure,
            'timing': seg.out()}



def row_append(payload, _context=None):
    """唯一日常结构路径：先校验，ZIP 增量写；不回落整簿转换。"""
    seg = _Seg()
    doc = _writable(payload.get('table'))
    _require_structure(doc)
    if doc.status != 'Active':
        frappe.throw('回收站中的文件先恢复再改表', frappe.ValidationError)
    seg.mark('auth')
    content = _content(doc, for_write=True)
    seg.mark('read_file')
    return _fast_structure(doc, content, payload, _context, seg, 'row_append')


def row_insert(payload, _context=None):
    """唯一日常结构路径：先校验，ZIP 增量写；不回落整簿转换。"""
    seg = _Seg()
    doc = _writable(payload.get('table'))
    _require_structure(doc)
    if doc.status != 'Active':
        frappe.throw('回收站中的文件先恢复再改表', frappe.ValidationError)
    seg.mark('auth')
    content = _content(doc, for_write=True)
    seg.mark('read_file')
    return _fast_structure(doc, content, payload, _context, seg, 'row_insert')


def _append_blank_tail_row(doc, entry, meta, saved, part, payload, context):
    """末尾补一行**空的**（软删之后用）—— 2026-10-29 用户口径。

    补的这一行是什么：
      · **新的固定行身份**（不复用被删的那一行）＋ **物理行**（表的最后一行之下）；
      · **不是受管记录** —— 没有值就不建（值是空的事实）；
        但留了「可核实的新增来源」，好让受管列以后能往这一行里写
        （promotion 那道闸：没有来源就不许建受管记录）；
      · **一次动作** —— 补在**这次删除**里，不在每次读的时候补
        （那样结构版本会一直涨）。

    末尾已经是「活的空行」时**不补**（不白长一行）。
    身份与物理行对不上（或已经满表）时**不补**：宁可少补一行，也不要补错位置。
    """
    rows = list(meta.get('rows') or [])
    headers = list(entry.get('headers') or [])
    raw = list(entry.get('rows_raw') or [])
    deleted = set(meta.get('deleted_rows') or [])
    if not rows or len(rows) != len(raw) or len(rows) >= 1048575:
        return None
    last = rows[-1]
    if last not in deleted and all(value in (None, '', ' ') for value in raw[-1]):
        return None      # 末尾已经是「活的空行」⇒ 不用补
    new_id = _allocate_row_ids(meta, 1)[0]
    meta['rows'] = rows + [new_id]
    # 文件里那一行第一格写的是一个空格（和「加行」那条路一样）⇒ 解析结果里也是同一个形状。
    entry['rows_raw'] = raw + [(' ',) + (None,) * (len(headers) - 1)]
    # 受管表：这一行以后要能填 ⇒ 留一条新增来源（没有值就不建受管记录）。
    origin = str(payload.get('op_id') or (context or {}).get('idempotency_key') or '').strip()
    _register_pending_rows(meta, [new_id], {**payload, 'op_id': origin or 'soft-delete-blank-tail'},
                           context)
    row_number = len(entry['rows_raw']) + 1   # 表头占第 1 行 ⇒ 数据行从第 2 行起
    try:
        saved = zipedit.append_rows(saved, part, [(row_number, [(1, {'type': 'text', 'value': ' '})])])
    except zipedit.SurgeryError as error:
        frappe.throw(str(error), frappe.ValidationError)
    return saved


def _fast_row_visibility(doc, content, payload, context, changes, prepared=None, blank_tail=False):
    """软删／恢复的同一目标路径；记录、映射、关联和个人视图原样保留。

    `blank_tail=True` ＝ **用户主动删行**那条路：删完之后**末尾留一行空的**
    （2026-10-29 用户口径：「软删后末尾补一行空的」—— 人随时能接着填）。
    撤回（`files.sheet_structure_undo`）与恢复**不补** —— 撤回是把结构还原回去。
    """
    _require_structure(doc)
    seg = _Seg()
    ctx = prepared or _fast_ctx(doc, content, payload, seg, companion_cells=True)
    meta, entry, part = ctx['meta'], ctx['entry'], ctx['part']
    _check_versions(doc, meta, payload)
    rows = list(meta.get('rows') or [])
    positions = {rid: index + 2 for index, rid in enumerate(rows)}
    if not changes or any(item['row_id'] not in positions for item in changes):
        frappe.throw('原行身份不存在，不能重建为另一行', frappe.ValidationError)
    if len({item['row_id'] for item in changes}) != len(changes):
        frappe.throw('同一次操作不能重复修改同一行', frappe.ValidationError)
    deleted = set(meta.get('deleted_rows') or [])
    hidden_before = zipedit.rows_hidden(ctx['sheet_xml'], [positions[item['row_id']] for item in changes])
    inverse = []
    physical = {}
    for item in changes:
        rid = item['row_id']; position = positions[rid]
        to_deleted = bool(item['deleted']); to_hidden = bool(item.get('hidden', to_deleted))
        if (rid in deleted) == to_deleted and hidden_before[position] == to_hidden:
            continue
        inverse.append({'row_id':rid, 'before_deleted':rid in deleted,
                        'before_hidden':hidden_before[position],
                        'after_deleted':to_deleted, 'after_hidden':to_hidden})
        if to_deleted: deleted.add(rid)
        else: deleted.discard(rid)
        physical[position] = to_hidden
    if not inverse:
        return {'table':doc.name,'applied':False,'already':True,'content_version':content_revision(doc),
                'structure_version':int(meta.get('structure_version') or 1),'has_formulas':False}
    meta['deleted_rows'] = [rid for rid in rows if rid in deleted]
    _bump_structure(meta)
    _structure_relation_checks(doc, entry, meta)
    try:
        saved = zipedit.set_rows_hidden(content, part, physical, source_xml=ctx['sheet_xml'])
    except zipedit.SurgeryError as error:
        frappe.throw(str(error), frappe.ValidationError)
    # 末尾补一行空的 —— **同一个动作里**做完（不另起一次保存、不在读的时候补）。
    # 结构版本上面已经推进过一次（行显示状态变了），补行**不再单独推进**。
    if blank_tail and any(item.get('after_deleted') for item in inverse):
        blank = _append_blank_tail_row(doc, entry, meta, saved, part, payload, context)
        if blank is not None:
            saved = blank
    _verify_surgery(saved, content, part, [], {})
    seg.mark('target_patch_verify')
    _fault('file-write')
    _save_meta(doc, meta)
    version = _save_current(doc, saved, note='sheet-edit·行显示状态')
    _rekey_parse(doc, entry, version)
    _fault('post-save')
    seg.mark('write_commit');seg.note('fast_path','surgery')
    return {'table':doc.name,'applied':True,'content_version':version,
            'structure_version':meta['structure_version'],'has_formulas':False,'timing':seg.out(),
            '_structure_inverse':{'kind':'row_visibility','rows':inverse}}


def row_delete(payload, _context=None):
    """软删除仅隐藏本行；固定身份、受管记录与引用保持，不整簿重存。

    **末尾留一行空的**（2026-10-29 用户口径）：删完之后末尾是「活的空行」，
    人随时能接着填 —— 补行是**这一次删除的一部分**（不是在每次读的时候补）。
    """
    doc = _writable(payload.get('table')); _require_structure(doc)
    rid = str(payload.get('row_id') or '').strip()
    if not rid: frappe.throw('row_id 必填', frappe.ValidationError)
    result = _fast_row_visibility(doc, _content(doc, for_write=True), payload, _context,
                                  [{'row_id':rid,'deleted':True}], blank_tail=True)
    return {**result,'row_id':rid,'deleted':True,'soft':True,'xlsx_hidden':True}


def column_insert(payload, _context=None):
    """新普通列只插入工作簿；已有受管字段、正式值和行映射不变。"""
    doc = _writable(payload.get('table')); _require_structure(doc)
    return _fast_structure(doc, _content(doc, for_write=True), payload, _context, _Seg(), 'column_insert')


def column_delete(payload, _context=None):
    """files.sheet_column_delete：删列（**已晋升的拒**，未晋升的删）（用户 2026-10-17 拍板）。

    **用户原话**：「列不行」—— **指已晋升的列删了就断了字段引用**。

    **两分**：
    - **已晋升**（`promoted: true` + 有 `field`）→ **明确拒**「该列已晋升，请先撤晋升再删」
      （**先撤晋升** = `files.promotion_define` 撤掉那列的绑定，**再删列**）
    - **未晋升**（普通列）→ **删**（**没绑定值，删了不断引用**）

    **为什么不软删**（跟行不一样）：**列的「软删除」会留下死列**（表头在、值没了），
    **比拒更混乱**。**行软删**是因为**行有 DB 正式值要保**；**列删 = 列没了**，
    **软删留死列没意义**。
    """
    seg = _Seg()
    doc = _writable(payload.get('table'))
    seg.mark('auth')
    header = str(payload.get('header') or '').strip()
    if not header:
        frappe.throw('header 必填', frappe.ValidationError)
    content = _content(doc, for_write=True)
    seg.mark('read_file')
    doc, wb, meta, ws = _structure_open(payload)
    # **已晋升检查**（「字段引用保护」）—— 用晋升定义判，不看列名
    from shangshu_files import promotion as _promo
    definition = _promo.load_definition(doc)
    col = _promo.column_by_header(definition, header)
    if col and col.get('promoted') and col.get('field'):
        frappe.throw(
            '「%s」已晋升为数据库字段（字段 %s），删了会断字段引用。'
            '请先撤晋升（`files.promotion_define` 撤掉该列绑定）再删列。'
            % (header, col.get('field')), frappe.ValidationError)
    # **未晋升 → 删**。从 `meta['headers']` 移除 + xlsx 删列
    headers = _headers_of(ws)
    if header not in headers:
        frappe.throw('列 %s 不存在' % header, frappe.ValidationError)
    idx = headers.index(header)
    headers.pop(idx)
    meta['headers'] = headers
    # **xlsx 删列**（openpyxl `delete_cols`）—— 1 起索引，表头占第 1 列位置
    try:
        from shangshu_files.sheet_structure import delete_column
        delete_column(ws, idx + 1)
    except Exception as e:
        frappe.throw('删列失败：%s' % str(e)[:120], frappe.ValidationError)
    meta['structure_version'] = int(meta.get('structure_version') or 1) + 1
    version_no = _save_with_gates(doc, wb, ws, meta, None)
    seg.mark('write_commit')
    return {
        'table': doc.name,
        'header': header,
        'deleted': True,
        'promoted': False,
        'content_version': version_no, 'has_formulas': bool(meta.get('formula_results')),
        'structure_version': int(meta.get('structure_version') or 1),
    }


def column_append(payload, _context=None):
    """唯一日常结构路径：先校验，ZIP 增量写；不回落整簿转换。"""
    seg = _Seg()
    doc = _writable(payload.get('table'))
    _require_structure(doc)
    if doc.status != 'Active':
        frappe.throw('回收站中的文件先恢复再改表', frappe.ValidationError)
    seg.mark('auth')
    content = _content(doc, for_write=True)
    seg.mark('read_file')
    return _fast_structure(doc, content, payload, _context, seg, 'column_append')


def _rename_promoted_header(meta, before, after):
    """移动现有字段的显示绑定；不重建字段、不改正式值或历史操作。"""
    definition = meta.get('promotion')
    if not isinstance(definition, dict):
        return
    changed = False
    for column in definition.get('columns') or []:
        if column.get('header') == before:
            field = column.get('field')
            if field:
                aliases = meta.setdefault('promotion_header_fields', {})
                for header in (before, after):
                    aliases[header] = sorted(set(aliases.get(header) or []) | {field})
            column['header'] = after
            changed = True
    if changed:
        definition['structure_version'] = int(meta.get('structure_version') or 1)


def header_rename(payload, _context=None):
    """唯一日常结构路径：先校验，ZIP 增量写；不回落整簿转换。"""
    seg = _Seg()
    doc = _writable(payload.get('table'))
    _require_structure(doc)
    if doc.status != 'Active':
        frappe.throw('回收站中的文件先恢复再改表', frappe.ValidationError)
    seg.mark('auth')
    content = _content(doc, for_write=True)
    seg.mark('read_file')
    return _fast_structure(doc, content, payload, _context, seg, 'header_rename')


def table_rename(payload, _context=None):
    """files.sheet_rename：改表名（table_title=文件区显示名）。

    契约 v1.1：不动 xlsx 字节、内容/结构版本都不动；sheet 身份不变。
    扩展名固定落 .xlsx（表身份所在类目），主名可改——否则 scope=sheet 的表清单会把表弄丢。
    """
    doc = _writable(payload.get('table'))
    _require_structure(doc)
    meta = _load_meta(doc)
    _check_versions(doc, meta, payload)
    raw = str(payload.get('title') or '').strip()
    if not raw:
        frappe.throw('表名不能为空', frappe.ValidationError)
    if os.path.basename(raw) != raw or '/' in raw or '\\' in raw:
        frappe.throw('表名不能包含路径分隔符', frappe.ValidationError)
    name, _ext = os.path.splitext(raw)
    if not name:
        frappe.throw('表名不能为空', frappe.ValidationError)
    doc.file_name = name + '.xlsx'
    doc.save(ignore_permissions=True)
    if meta.get('working_file_id') == doc.current_file:
        # Rename the current file's display metadata, never its stable path or
        # an immutable historical/sent attachment snapshot.
        frappe.get_doc('File', doc.current_file, for_update=True).db_set(
            'file_name', doc.file_name, update_modified=False)
    return {
        'table': doc.name, 'table_title': doc.file_name,
        'content_version': content_revision(doc),
        'structure_version': int(meta.get('structure_version') or 1),
    }


def _generated_header(existing, col_no):
    """空表头按规则生成默认名：非空、唯一、可改。不用 `列N`（那是读侧给空表头的显示兜底，
    不该被写进表头）。命名规则待定稿，这里用 `未命名N`，冲突时递增序号保证唯一。"""
    taken = set(existing)
    base = '未命名%d' % col_no
    name = base
    n = 2
    while name in taken:
        name = '%s-%d' % (base, n)
        n += 1
    return name








def input_write(payload, _context=None):
    """普通单格输入：既有格和空白区域使用同一坐标入口，扩展与值原子提交。"""
    value = payload.get('value') or {}
    kind = value.get('type')
    if kind not in ('text', 'number', 'boolean', 'empty', 'date', 'formula'):
        frappe.throw('不支持的输入值类型', frappe.ValidationError)
    raw = value.get('formula') if kind == 'formula' else value.get('value')
    result = _write_range({**payload, 'matrix': [[raw]], 'matrix_types': [[kind]],
                           'extend': True, 'header_row': False}, _context,
                          action_id='files.sheet_input_write')
    # Expansion receipt carries the authoritative page/schema from this same
    # transaction. The UI need not reopen the workbook or make a second HTTP read.
    if result.get('rows_added') or result.get('cols_added') or result.get('structure_changed'):
        result['saved_view'] = read_payload(None, {'table': payload['table'],
            'page': int(payload['start_row']) // 200 + 1, 'page_length': 200},
            {'review_readonly': True})
    return result


def paste_apply(payload, _context=None):
    return _write_range(payload, _context)


def _mapped_range_rows(existing_rows, start_row, rows_n, target_row_ids, append_at_end=False):
    """把「排序视图里的目标行」换算成**物理行号**（0 基，数据行）。

    `target_row_ids` 里的 `None` ＝「这一格要写进一个**还没有固定行身份的空白行**」
    （网格上看得见的最后一行之下那一段空白）。

    **2026-10-29 用户口径**：这种目标**不再拒**（以前报「已有行缺少固定行身份，本次未保存」）
    ⇒ 本次写入给它**建一个新身份**，新行落在**末尾的空位**：
      · 表里已有的行**不挪位、不改身份**（别人的行不受影响）；
      · 新行在物理上是**末尾**那一行 —— 网格刷新后它正好出现在人点的那个空白处
        （被软删的行看不见，末尾补出来的行排在它后面）。
    末尾之外的空白（看得见的行数 ＝ 物理行数）仍旧按原位置留空行，老口径不变。
    """
    if target_row_ids is None:
        if append_at_end:
            frappe.throw('追加到末尾须携带可见固定行身份', frappe.ValidationError)
        return list(range(start_row, start_row + rows_n))
    if not isinstance(target_row_ids, list) or len(target_row_ids) != rows_n:
        frappe.throw('排序写入的行身份数量不匹配', frappe.ValidationError)
    positions = {rid: i for i, rid in enumerate(existing_rows)}
    seen = set()
    resolved = []
    tail = len(existing_rows)   # 末尾第一个还没占的物理位置
    fresh = 0                   # 本次新建的行数（落在末尾的那些）
    for offset, rid in enumerate(target_row_ids):
        visual = start_row + offset
        if rid is None:
            if append_at_end:
                resolved.append(tail); tail += 1; fresh += 1
                continue
            if visual > tail:
                # 目标在表的末尾之外：按原位置留出中间的空行（老口径，不变）。
                resolved.append(visual); tail = visual + 1
                continue
            # 目标落在已有行之间：那一片没有固定行身份 ⇒ 本次写入给它建一个新身份（落末尾）。
            resolved.append(tail); tail += 1; fresh += 1
            continue
        if fresh or (not append_at_end and visual >= len(existing_rows)) or rid not in positions or rid in seen:
            frappe.throw('排序行身份已变化或重复，请重新排序', frappe.ValidationError)
        seen.add(rid)
        resolved.append(positions[rid])
    return resolved


def _mapped_range_columns(existing_headers, start_col, cols_n, target_headers=None, header_row=False):
    """Resolve personal display columns to stable physical headers before any mutation.

    None is only an uncreated tail column, never a substitute for an existing
    field. Omitting the mapping preserves the original physical-coordinate API.
    """
    if target_headers is None:
        return list(range(start_col, start_col + cols_n))
    if header_row:
        frappe.throw('表头操作不能混用个人视图列映射', frappe.ValidationError)
    if not isinstance(target_headers, list) or len(target_headers) != cols_n:
        frappe.throw('个人视图目标列数与粘贴矩阵不一致，本包未保存', frappe.ValidationError)
    positions = {}
    for index, header in enumerate(existing_headers):
        positions.setdefault(header, []).append(index)
    resolved = []
    for offset, header in enumerate(target_headers):
        if header is None:
            index = start_col + offset
            if index < len(existing_headers):
                frappe.throw('已有列缺少固定表头，本包未保存', frappe.ValidationError)
        elif not isinstance(header, str) or not header or len(positions.get(header, [])) != 1:
            frappe.throw('个人视图目标列已变化或无法唯一定位，本包未保存', frappe.ValidationError)
        else:
            index = positions[header][0]
        if index in resolved:
            frappe.throw('个人视图目标列重复，本包未保存', frappe.ValidationError)
        resolved.append(index)
    return resolved


def _write_range(payload, _context=None, action_id='files.sheet_paste_apply'):
    """files.sheet_paste_apply：越界粘贴「扩展与写值」打包成**一次受管动作**。

    计划 PKG-003-T03：扩展与写值作为一个动作包提交，**不能循环「加一行→加一列→存一格」**；
    任一失败零正式生效、无空结构残留。所以这里：

      ① 先全量预检 —— 范围 / 权限 / 类型 / 容量，任何一项不过就抛错，一个字节不写；
      ② 再在一个内存事务里「加够行 + 加够列 + 写值」；
      ③ **只在最后落一次盘** —— 预检或变更中途任何一步抛错，文件没写过，结构与值都停在粘贴前。

    权限分两层：改值（本动作的角色门槛）；**需要扩展时另要结构角色**
    （`Sheet Structure Editor` 或 System Manager）—— 只可改值者粘贴带结构的包，
    整包拒绝且零写（G3-03 / G4-01 共用这条语义）。

    表头区（header_row=True）按**表头非空唯一**规则校验：重复表头拒；空表头按规则生成
    （非空、唯一、可改，不用 `列N` 占位）。
    """
    seg = _Seg()
    doc = _writable(payload.get('table'))
    if doc.status != 'Active':
        frappe.throw('回收站中的文件先恢复再改表', frappe.ValidationError)
    seg.mark('auth')

    raw = payload.get('matrix')
    if not isinstance(raw, list) or not raw:
        frappe.throw('请给出要粘贴的值矩阵', frappe.ValidationError)
    rows_n = len(raw)
    cols_n = 0
    for i, line in enumerate(raw):
        if not isinstance(line, list):
            frappe.throw('第 %d 行不是数组' % (i + 1), frappe.ValidationError)
        cols_n = max(cols_n, len(line))
    if rows_n * cols_n > MAX_BATCH_CELLS:
        frappe.throw('一次最多粘贴 %d 格（现 %d 格），请按范围拆批后重试'
                     % (MAX_BATCH_CELLS, rows_n * cols_n), frappe.ValidationError)
    if rows_n * cols_n == 0:
        frappe.throw('粘贴范围为空', frappe.ValidationError)

    try:
        start_row = int(payload.get('start_row'))
        start_col = int(payload.get('start_col'))
    except (TypeError, ValueError):
        frappe.throw('粘贴起始行列无效', frappe.ValidationError)
    if start_row < 0 or start_col < 0:
        frappe.throw('粘贴起始行列不能为负', frappe.ValidationError)
    header_row = bool(payload.get('header_row'))
    allow_extend = payload.get('extend')
    allow_extend = True if allow_extend is None else bool(allow_extend)

    types = payload.get('matrix_types')
    if types is not None and (not isinstance(types, list) or len(types) != rows_n):
        frappe.throw('matrix_types 行数与 matrix 不一致', frappe.ValidationError)
    if not str(payload.get('op_id') or '').strip():
        frappe.throw('请给出本包的操作编号（op_id），用于审计与撤回定位', frappe.ValidationError)

    content = _content(doc, for_write=True)
    seg.mark('read_file')
    ctx = _fast_ctx(doc, content, payload, seg, companion_cells=True)
    meta, entry = ctx['meta'], ctx['entry']
    _check_versions(doc, meta, payload)
    headers = list(entry['headers'])
    rows = list(meta.get('rows') or [])
    if header_row and payload.get('target_row_ids') is not None:
        frappe.throw('表头操作不能混用排序行身份', frappe.ValidationError)
    matrix = raw[1:] if header_row else raw
    matrix_types = types[1:] if header_row and types is not None else types
    targets = _mapped_range_rows(rows, start_row, len(matrix), payload.get('target_row_ids'), bool(payload.get('append_at_end')))
    need_rows = max(0, max(targets, default=-1) + 1 - len(rows))
    column_targets = _mapped_range_columns(headers, start_col, cols_n, payload.get('target_headers'), header_row)
    need_cols = max(0, max(column_targets, default=-1) + 1 - len(headers))
    if len(rows) + need_rows > 1048575 or len(headers) + need_cols > 16384:
        frappe.throw('输入范围超过 Excel 行列上限，本次未保存', frappe.ValidationError)
    if (need_rows or need_cols) and not allow_extend:
        frappe.throw('粘贴超出表范围，本次不允许扩展', frappe.ValidationError)
    extra = []
    materialized = False
    old_headers = list(headers)
    for col in range(len(headers), len(headers) + need_cols):
        headers.append(_generated_header(headers, col + 1))
    renames = {}
    for offset, col in enumerate(column_targets):
        proposed = str(raw[0][offset] or '').strip() if header_row and offset < len(raw[0]) else ''
        if proposed:
            if proposed in headers and headers[col] != proposed:
                frappe.throw('表头「%s」重复——表头须非空唯一，本包未保存' % proposed, frappe.ValidationError)
            if col < len(old_headers) and old_headers[col] != proposed:
                renames[old_headers[col]] = proposed
            headers[col] = proposed
        if not str(headers[col] or '').strip():
            headers[col] = _generated_header(headers, col + 1)
            materialized = True
        if col >= len(old_headers) or headers[col] != old_headers[col]:
            extra.append((coord_of(col + 1, 1), {'type': 'text', 'value': headers[col]}))
    touched_headers = [headers[col] for col in column_targets]
    if any(h != str(h).strip() or headers.count(h) != 1 for h in touched_headers):
        frappe.throw('粘贴目标包含空白或重复表头，请先明确表头；本次未保存', frappe.ValidationError)
    structure_changed = bool(need_rows or need_cols or materialized or renames)
    if structure_changed:
        _require_structure(doc)
        from shangshu_files.object_projection import binding_for, reject_bound_targets
        companion = binding_for(doc)
        if companion:
            if need_rows:
                frappe.throw('原对象行须经原对象动作新增，不能在伴随表另建记录', frappe.ValidationError)
            reject_bound_targets(doc, list(renames))
            from shangshu_core.public_api import authorize_companion_cells
            authorize_companion_cells(doc.name, [], [], operation='structure')
        # 晋升字段改名由既有明确结构动作处理，不让矩阵混包暗改绑定定义。
        from shangshu_files import promotion
        definition = promotion.load_definition(doc)
        if any(promotion.column_by_header(definition, old) for old in renames):
            frappe.throw('受管列改名请使用明确的改表头动作，本包未保存', frappe.ValidationError)
    new_ids = _allocate_row_ids(meta, need_rows) if need_rows else []
    old_count = len(rows)
    rows.extend(new_ids)
    meta['rows'] = rows
    _register_pending_rows(meta, new_ids, payload, _context)
    if structure_changed:
        _bump_structure(meta)
    entry['headers'] = headers
    entry['rows_raw'].extend([tuple(None for _ in headers) for _ in new_ids])
    cells = []
    for index, line in enumerate(matrix):
        type_row = matrix_types[index] if matrix_types is not None else []
        if not isinstance(type_row, list):
            frappe.throw('matrix_types 每行须为数组', frappe.ValidationError)
        for offset, value in enumerate(line):
            kind = str(type_row[offset] or 'text') if offset < len(type_row) else 'text'
            if kind == 'text':
                typed = {'type': kind, 'value': '' if value is None else str(value)}
                if len(typed['value']) > 32767:
                    frappe.throw('单元格文本超过 32767 字符，本包未保存', frappe.ValidationError)
            elif kind == 'number':
                try:
                    if isinstance(value, bool):
                        raise ValueError()
                    typed = {'type': kind, 'value': float(value)}
                except (TypeError, ValueError):
                    frappe.throw('数值无效，本包未保存', frappe.ValidationError)
            elif kind == 'boolean':
                literal = str(value).strip().lower()
                if literal not in ('true', 'false', '1', '0'):
                    frappe.throw('布尔值请填写true或false，本包未保存', frappe.ValidationError)
                typed = {'type': kind, 'value': literal in ('true', '1')}
            elif kind == 'date':
                typed = {'type': kind, 'value': str(value)}
            elif kind == 'empty':
                typed = {'type': kind, 'value': None}
            else:
                frappe.throw('日常编辑不支持公式或未知值类型；本包未保存', frappe.ValidationError)
            cells.append({'row_id': rows[targets[index]], 'header': headers[column_targets[offset]], 'value': typed})
    from shangshu_files import promotion
    promotion.require_fields_ok_for_targets(doc, [(item['header'], item['value'].get('value')) for item in cells])
    plan = _fast_plan_cells(doc, content, {**payload, 'cells': cells}, _context, seg,
                           action_id=action_id, prepared=ctx)
    occupied = {coord for coord, _value in plan['edits']}
    for index in range(old_count, len(rows)):
        coord = coord_of(1, index + 2)
        if coord not in occupied:
            extra.append((coord, {'type': 'text', 'value': ' '}))
    plan['edits'].extend(extra)
    plan['extra_coords'] = [coord for coord, _value in extra]
    plan['structure_changed'] = structure_changed
    if structure_changed:
        _structure_relation_checks(doc, entry, meta, renames)
        if (_context or {}).get('atomic_package'):
            _context['package_structure_changes'] = [
                *([{'field': 'rows', 'kind': 'rows_added', 'before': [], 'after': new_ids}] if new_ids else []),
                *[{'field': 'header', 'kind': 'column_header', 'column_index': i,
                   'before': old_headers[i] if i < len(old_headers) else None, 'after': header}
                  for i, header in enumerate(headers)
                  if i >= len(old_headers) or header != old_headers[i]],
            ]
    result = _commit_cell_plan(doc, plan, _context, seg)
    return {**result, 'action_count': 1, 'rows_added': need_rows, 'cols_added': need_cols,
            'structure_changed': structure_changed, 'row_ids': new_ids, 'headers': headers,
            'row_states': {rid: meta.get('promotion_row_states', {}).get(rid) for rid in set(item['row_id'] for item in cells)}}


def _check_versions(doc, meta, payload):
    current = content_revision(doc)
    expected = payload.get('expected_content_version')
    if expected is None or int(expected) != current:
        # 把**当前版本号**带出来给调用方重试（A 的 T07 判据：文案带「版本」+ 当前版本号）。
        # 原文案只说「已被其他操作修改」，调用方不知道该重读到哪个版本。
        frappe.throw('文件已被其他操作修改（版本冲突：当前 content=%d），输入已保留，请重新读取后核对' % current,
                     frappe.ValidationError)
    expected_s = payload.get('expected_structure_version')
    if expected_s is None or int(expected_s) != int(meta.get('structure_version') or 1):
        frappe.throw('表头已变化（版本冲突：当前 structure=%s），请刷新后重试'
                     % (meta.get('structure_version') or 1), frappe.ValidationError)


def _apply_value(cell, value, ws, col_index, column_type=None, restore=False):
    type_ = str(value.get('type') or '')
    raw = value.get('value')
    # 列类型闸只管「新写入」：撤回是把格子里原来就有的值放回去，本来合法，不许被
    # 列的多数类型拒掉（2026-10-13 实测：混合列撤回被「申请官费 须为文本」误拦）。
    if not restore:
        # 列类型可用预计算值（批量写按簿初始态判一次，杜绝「同一批换个顺序结果不同」）
        if column_type is None:
            column_type = _column_type(ws, col_index)
        if column_type and type_ != column_type and type_ not in ('empty','formula'):
            frappe.throw('%s 须为%s' % (ws.cell(row=1, column=col_index).value or '该列',
                                      TYPE_LABEL.get(column_type, column_type)), frappe.ValidationError)
    if type_ == 'text':
        if not isinstance(raw, str):
            frappe.throw('文本值无效', frappe.ValidationError)
        cell.value = raw
        cell.data_type = 's'  # 字符串本身保留前导零；值操作不改原数字格式，也不执行等号文本
    elif type_ == 'number':
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            frappe.throw('数值无效', frappe.ValidationError)
        if isinstance(raw, int) and abs(raw) >= PRECISION_LIMIT:
            frappe.throw('该数值过长（≥16 位），保存会损伤精度，请改用文本类型', frappe.ValidationError)
        cell.value = raw
        if cell.number_format == '@':
            cell.number_format = 'General'
    elif type_ == 'date':
        try:
            cell.value = (datetime.datetime.fromisoformat(str(raw)) if 'T' in str(raw)
                          else datetime.date.fromisoformat(str(raw)[:10]))
        except Exception:
            frappe.throw('日期无效', frappe.ValidationError)
        cell.number_format = 'yyyy-mm-dd'
    elif type_ == 'boolean':
        if not isinstance(raw, bool):
            frappe.throw('布尔值无效', frappe.ValidationError)
        cell.value = raw
    elif type_ == 'formula':
        from shangshu_files.formulas import parse, references, FormulaError
        try: tuple(references(parse(value.get('formula'))))
        except FormulaError as error: frappe.throw(str(error), frappe.ValidationError)
        cell.value = value['formula']
        inputs=getattr(cell.parent,'_ss_formula_inputs',set())
        inputs.add(cell.coordinate)
        cell.parent._ss_formula_inputs=inputs
        if cell.number_format == '@': cell.number_format = 'General'
    elif type_ == 'empty':
        cell.value = None
    else:
        frappe.throw('不支持的值类型：' + type_, frappe.ValidationError)


def _content(doc, for_write=False):
    """取当前版本字节。写路径必须走当前读（for_update）——REPEATABLE READ 陷阱
    （B6-03 撤权并发实测定性）：doc 行是加锁当前读，File 行若走快照读，落后快照下
    会「看得见新指针、看不见新行」（并发写时 File xxx not found 假 404）。
    读路径快照读足够：前后自洽，且不为并发冷读加行锁。"""
    recover_current(doc)
    if for_write:
        file_doc = frappe.get_doc('File', doc.current_file, for_update=True)
    else:
        file_doc = frappe.get_doc('File', doc.current_file)
    content = file_doc.get_content()
    content = content if isinstance(content, bytes) else str(content).encode()
    if hashlib.sha256(content).hexdigest() != doc.current_sha256:
        # A stable working path may have advanced while this read held an old
        # database snapshot. Reload both identities before returning any bytes.
        fresh = frappe.get_doc(DOCTYPE, doc.name, for_update=True)
        fresh.check_permission('read')
        doc.update(fresh.as_dict())
        content = frappe.get_doc('File', doc.current_file, for_update=True).get_content()
        if hashlib.sha256(content).hexdigest() != doc.current_sha256:
            frappe.throw('当前表格保存状态待恢复，请重试', frappe.ValidationError)
    return content


def _save_current(doc, content, note='sheet-edit'):
    _fault('file-write')
    return save_current(doc, content)


# Font formatting uses append-only OOXML font/xf records. Never serialize the workbook or
# the original styles tree: namespace declarations and every old style remain byte exact.
def _style_blocks(xml, name):
    prefix = rb'(?:[A-Za-z_][\w.-]*:)?'
    match = re.search(rb'<(' + prefix + name.encode() + rb')\b[^>]*>(.*?)</\1\s*>', xml, re.S)
    if not match:
        raise zipedit.SurgeryError('样式部件缺少 ' + name)
    child = {'fonts': b'font', 'borders': b'border', 'fills': b'fill', 'numFmts': b'numFmt'}.get(name, b'xf')
    children = re.findall(rb'<' + prefix + child + rb'\b[^>]*?(?:/>|>.*?</' + prefix + child + rb'\s*>)', match.group(2), re.S)
    if not children:
        raise zipedit.SurgeryError('样式定义为空：' + name)
    return match, children


def _style_font_view(raw):
    import xml.etree.ElementTree as ET
    # A copied fragment may use an inherited namespace prefix. Read-only normalization
    # is local to parsing; these bytes are never used as the saved original fragment.
    parsed = re.sub(rb'(<\/?)[A-Za-z_][\w.-]*:', rb'\1', raw)
    font = ET.fromstring(parsed)
    find = lambda name: next((node for node in font if node.tag.rsplit('}', 1)[-1] == name), None)
    size, color, bold = find('sz'), find('color'), find('b')
    view = {'font_size': float(size.get('val')) if size is not None else None,
            'font_color': None,
            'bold': bold is not None and bold.get('val', '1').lower() not in ('0', 'false')}
    from shangshu_files.style_extra import font_flags_of
    view.update(font_flags_of(raw))
    if color is not None:
        kind = next((key for key in ('rgb', 'theme', 'indexed', 'auto') if color.get(key) is not None), 'unknown')
        view['font_color_type'] = kind
        rgb = color.get('rgb')
        if rgb and re.fullmatch(r'[0-9A-Fa-f]{6,8}', rgb):
            view['font_color'] = '#' + rgb[-6:].upper()
        elif kind == 'indexed':
            from openpyxl.styles.colors import COLOR_INDEX
            index = int(color.get('indexed'))
            if 0 <= index < len(COLOR_INDEX):
                view['font_color'] = '#' + COLOR_INDEX[index][-6:]
    return view


def _style_element(raw):
    import xml.etree.ElementTree as ET
    return ET.fromstring(re.sub(rb'(<\/?)[A-Za-z_][\w.-]*:', rb'\1', raw))


def _style_border_view(raw):
    border = _style_element(raw)
    result = {}
    for name in ('top', 'bottom', 'left', 'right'):
        side = next((x for x in border if x.tag.rsplit('}', 1)[-1] == name), None)
        color = next((x for x in side if x.tag.rsplit('}', 1)[-1] == 'color'), None) if side is not None else None
        rgb = color.get('rgb') if color is not None else None
        result[name] = {'style': side.get('style') if side is not None else None,
                        'color': '#' + rgb[-6:].upper() if rgb and re.fullmatch(r'[0-9A-Fa-f]{6,8}', rgb) else None}
        if color is not None:
            result[name]['color_type'] = next((k for k in ('rgb', 'theme', 'indexed', 'auto') if color.get(k) is not None), 'unknown')
    return result


def _style_index(content, styles_xml=None):
    import xml.etree.ElementTree as ET
    from openpyxl.styles.numbers import BUILTIN_FORMATS
    if styles_xml is None:
        with zipfile.ZipFile(BytesIO(content)) as archive:
            xml = archive.read('xl/styles.xml')
    else:xml=styles_xml
    _fonts, fonts = _style_blocks(xml, 'fonts')
    _xfs, xfs = _style_blocks(xml, 'cellXfs')
    _borders, borders = _style_blocks(xml, 'borders')
    try:
        _fills, fills = _style_blocks(xml, 'fills')
    except zipedit.SurgeryError:
        fills = []
    root = ET.fromstring(xml)
    formats = dict(BUILTIN_FORMATS)
    for node in root.iter():
        if node.tag.rsplit('}', 1)[-1] == 'numFmt':
            formats[int(node.get('numFmtId'))] = node.get('formatCode')
    font_views = [_style_font_view(font) for font in fonts]
    border_views = [_style_border_view(border) for border in borders]
    from shangshu_files.style_extra import alignment_view, fill_color_of
    views = []
    for raw in xfs:
        xf = _style_element(raw)
        fid, bid, nid = (int(xf.get(k, '0')) for k in ('fontId', 'borderId', 'numFmtId'))
        if fid >= len(fonts) or bid >= len(borders):
            raise zipedit.SurgeryError('样式引用不存在')
        alignment = next((x for x in xf if x.tag.rsplit('}', 1)[-1] == 'alignment'), None)
        fill_id = int(xf.get('fillId', '0'))
        views.append({**font_views[fid], 'number_format': formats.get(nid, 'General'),
                      'wrap_text': alignment is not None and alignment.get('wrapText', '0').lower() not in ('0', 'false'),
                      'border': border_views[bid],
                      'fill_color': fill_color_of(fills[fill_id]) if fill_id < len(fills) else None,
                      **alignment_view(raw)})
    return {'xml': xml, 'fonts': fonts, 'borders': borders, 'fills': fills, 'formats': formats,
            'xfs': xfs, 'views': views}


def _style_views_from_wb(wb):
    import xml.etree.ElementTree as ET
    from openpyxl.styles.numbers import BUILTIN_FORMATS
    views = []
    for xf in wb._cell_styles:
        font = wb._fonts[xf.fontId]
        color = font.color
        rgb = color.rgb if color is not None and color.type == 'rgb' else None
        alignment = wb._alignments[xf.alignmentId]
        fill = wb._fills[xf.fillId] if xf.fillId < len(wb._fills) else None
        fill_rgb = None
        if fill is not None and getattr(fill, 'patternType', None) == 'solid':
            fg = getattr(fill, 'fgColor', None)
            value = getattr(fg, 'rgb', None) if fg is not None else None
            if isinstance(value, str) and re.fullmatch(r'[0-9A-Fa-f]{6,8}', value):
                fill_rgb = '#' + value[-6:].upper()
        horizontal = getattr(alignment, 'horizontal', None)
        vertical = getattr(alignment, 'vertical', None)
        views.append({'font_size': float(font.sz) if font.sz is not None else None,
                      'font_color': '#' + rgb[-6:].upper() if isinstance(rgb, str) else None,
                      'font_color_type': color.type if color is not None else None,
                      'bold': bool(font.b),
                      'italic': bool(font.i),
                      'underline': bool(font.u),
                      'number_format': BUILTIN_FORMATS.get(xf.numFmtId) if xf.numFmtId < 164 else wb._number_formats[xf.numFmtId - 164],
                      'wrap_text': bool(alignment.wrap_text),
                      'border': _style_border_view(ET.tostring(wb._borders[xf.borderId].to_tree())),
                      'fill_color': fill_rgb,
                      'horizontal_align': horizontal if horizontal in ('left', 'center', 'right') else None,
                      'vertical_align': vertical if vertical in ('top', 'center', 'bottom') else None})
    return views


#: **样式表为空**（工作簿没有 styles 部件）时的兜底视图 —— 与历史口径一致。
_EMPTY_STYLE_VIEW = {'font_size': None, 'font_color': None, 'bold': False}


def _style_views_entry(style_ids, views):
    """样式索引条目：**共享视图 + 表级默认样式**（三条读路径同键）。

    `default_style` ＝ **工作簿默认 xf 的视图**（`font_styles[0]`，不是那份硬编码兜底）。
    为什么要有它：公开读口 `files.sheet_read` 的逐行 `row.styles` 只带
    「和默认不一样」的格 ⇒ 消费方按**缺项**回落到这份表级默认 ⇒ 渲染不变。
    """
    return {'style_ids': style_ids, 'font_styles': views,
            'default_style': views[0] if views else _EMPTY_STYLE_VIEW}


def _style_read_cache(content,title,parsed_ids=None,*,sheet_xml=None,sheet_part=None,complete_ids=False,styles_xml=None):
    """Build once per content-version, then page reads only project their selected cells.

    Raw s= indices also retain explicit zero overrides and row/column inheritance, which
    read-only openpyxl cell objects do not distinguish. Never materialize style objects
    for every page/row; the shared font/xf views are one compact dictionary.
    """
    try:
        views = _style_index(content,styles_xml)['views']
    except KeyError:
        # A standards-valid workbook can omit the optional styles part.
        views=[{'font_size': None, 'font_color': None, 'bold': False}]
    part = sheet_part or zipedit.sheet_part_by_title(content,title)
    xml = sheet_xml if sheet_xml is not None else zipedit.read_sheet(content,part)
    ids, rows, columns = parsed_ids if parsed_ids is not None else {}, {}, {}
    # The normal value parse already visits each actual cell and collects nonzero s.
    # Reuse it; only explicit s=0 needs raw inspection to distinguish inheritance.
    tags = (() if complete_ids else
            re.finditer(rb'<c\b[^>]*\ss=[\'"]0[\'"][^>]*>',xml) if parsed_ids is not None
            else re.finditer(rb'<c\b[^>]*>',xml))
    for match in tags:
        tag = match.group(0)
        sid = re.search(rb'\ss=[\'"](\d+)[\'"]', tag)
        coord = re.search(rb'\br=[\'"]([A-Z]+[0-9]+)[\'"]', tag)
        if sid and coord:
            col, row = zipedit.parse_coord(coord.group(1).decode())
            ids[(row, col)] = int(sid.group(1))
    heights={}
    for tag in re.findall(rb'<row\b[^>]*>', xml):
        sid = re.search(rb'\ss=[\'"](\d+)[\'"]', tag)
        row = re.search(rb'\br=[\'"](\d+)[\'"]', tag)
        if sid and row:
            rows[int(row.group(1))] = int(sid.group(1))
        height=re.search(rb'\bht="([\d.]+)"',tag)
        if row and height and re.search(rb'\bcustomHeight="1"',tag):
            heights[row.group(1).decode()]=float(height.group(1))
    for tag in re.findall(rb'<col\b[^>]*>', xml[:xml.find(b'<sheetData')]):
        attrs = dict(re.findall(rb'\b([A-Za-z]+)=[\'"]([^\'"]*)[\'"]', tag))
        if b'style' in attrs:
            for col in range(int(attrs.get(b'min', b'1')), min(16384, int(attrs.get(b'max', b'1'))) + 1):
                columns[col] = int(attrs[b'style'])
    return {'font_styles': views, 'default_style': views[0] if views else _EMPTY_STYLE_VIEW,
            'style_ids': ids,
            'row_style_ids': rows,'column_style_ids':columns,'manual_row_heights':heights,
            'sheet_part':part.decode() if isinstance(part,bytes) else part}


def _default_style_of(entry):
    """**表级默认样式** ＝ 工作簿默认 xf 的视图（`font_styles[0]`）。

    三条读路径都带 `default_style`；老缓存条目没有这个键时按同一口径回落。
    """
    style = entry.get('default_style')
    if style is not None:
        return style
    views = entry.get('font_styles') or []
    return views[0] if views else _EMPTY_STYLE_VIEW


def _row_style_views(entry, pos, headers, requested_set):
    """一行里**和默认不一样**的那些格的显示格式（表头 → 样式视图）。

    为什么只给「不一样」的：默认样式整表只发一次（回包顶层 `default_style`），
    逐行再给每一格发一份一模一样的默认样式 ⇒ 一页 1710 个格就是 1710 份重复
    （实测占整页回包 **83%**）⇒ 页面越大越卡。
    ⇒ 与默认**按值相等**的格**不带项** ⇒ 消费方按缺项回落到表级默认 ⇒ 渲染不变。

    ⚠️ **解析顺序不许改**：按格（`style_ids`）→ 行（`row_style_ids`）→
    列（`column_style_ids`）→ 0；继承来的样式同样参与比较
    （继承来的等于默认 ⇒ 不带项；不等于 ⇒ 带项）。
    """
    views = entry.get('font_styles') or []
    default_style = _default_style_of(entry)
    style_ids = entry.get('style_ids') or {}
    row_style_ids = entry.get('row_style_ids') or {}
    column_style_ids = entry.get('column_style_ids') or {}
    out = {}
    for i in range(1, len(headers) + 1):
        header = headers[i - 1]
        if header not in requested_set:
            continue
        sid = style_ids.get((pos + 2, i),
                            row_style_ids.get(pos + 2,
                                              column_style_ids.get(i, 0)))
        view = views[sid] if sid < len(views) else _EMPTY_STYLE_VIEW
        if view != default_style:   # **按值比**（不是比对象身份）
            out[header or ('列%d' % i)] = view
    return out


def _style_patch(style):
    import math
    from shangshu_files.style_extra import EXTRA_KEYS, normalize_extra_patch
    if not isinstance(style, dict) or not style or set(style) - ({'font_size', 'font_color', 'bold', 'number_format', 'wrap_text', 'border'} | set(EXTRA_KEYS)):
        raise zipedit.SurgeryError('只支持字体、数字格式、自动换行、边框、填充色、斜体下划线与对齐，样式至少指定一项')
    result = dict(style)
    if 'font_size' in result:
        size = result['font_size']
        if isinstance(size, bool) or not isinstance(size, (float, int)) or not math.isfinite(size) or not 1 <= size <= 409:
            raise zipedit.SurgeryError('字号须为 1 到 409 pt 的有限数值')
    if 'font_color' in result:
        if not isinstance(result['font_color'], str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', result['font_color']):
            raise zipedit.SurgeryError('字色须为 #RRGGBB')
        result['font_color'] = result['font_color'].upper()
    if 'bold' in result and not isinstance(result['bold'], bool):
        raise zipedit.SurgeryError('加粗须为布尔值')
    if 'wrap_text' in result and not isinstance(result['wrap_text'], bool):
        raise zipedit.SurgeryError('自动换行须为布尔值')
    if 'border' in result:
        # 边框可以是旧口径 'none'/'all'，也可以是预设对象 {'preset','style','color'}；
        # 一律归一成预设，下游只按选区算每一格画哪几条边。
        try:
            result['border'] = normalize_border(result['border'])
        except ValueError as error:
            raise zipedit.SurgeryError(str(error))
    if 'number_format' in result and result['number_format'] not in (
            'General', '0', '0.00', '#,##0', '#,##0.00', '0%', '0.00%', 'yyyy-mm-dd', 'yyyy-mm-dd hh:mm:ss'):
        raise zipedit.SurgeryError('不支持此数字格式')
    # 扩展格式（填充色/斜体/下划线/对齐/清除格式）：单独归一，非法值给中文提示。
    try:
        extra = normalize_extra_patch(result)
    except ValueError as error:
        raise zipedit.SurgeryError(str(error))
    result.update(extra)
    return result


def _style_patch_font(raw, patch):
    prefix_match = re.match(rb'<((?:[A-Za-z_][\w.-]*:)?)font\b', raw)
    if not prefix_match:
        raise zipedit.SurgeryError('字体定义无法安全修改')
    prefix = prefix_match.group(1)
    if raw.rstrip().endswith(b'/>'):
        raw = raw.rstrip()[:-2] + b'></' + prefix + b'font>'
    mapping = {'font_size': 'sz', 'font_color': 'color', 'bold': 'b'}
    for key, value in patch.items():
        if key not in mapping:
            continue
        name = mapping[key].encode()
        pattern = rb'<(?:[A-Za-z_][\w.-]*:)?' + name + rb'\b[^>]*?(?:/>|>.*?</(?:[A-Za-z_][\w.-]*:)?' + name + rb'\s*>)'
        raw = re.sub(pattern, b'', raw, flags=re.S)
        if key == 'bold':
            node = b'<' + prefix + b'b/>' if value else b''
        elif key == 'font_color':
            node = b'<' + prefix + b'color rgb="FF' + value[1:].encode() + b'"/>'
        else:
            node = b'<' + prefix + b'sz val="' + ('%.12g' % value).encode() + b'"/>'
        closing = raw.rfind(b'</')
        raw = raw[:closing] + node + raw[closing:]
    # 斜体 / 下划线：与加粗同一口径（不要就整个去掉）。
    from shangshu_files.style_extra import UNSET, patch_font_flags
    raw = patch_font_flags(raw,
                           italic=patch['italic'] if 'italic' in patch else UNSET,
                           underline=patch['underline'] if 'underline' in patch else UNSET)
    return raw


def _style_replace_attr(node, key, value):
    head, rest = node.split(b'>', 1)
    pattern = rb'\s' + key.encode() + rb'=[\'"][^\'"]*[\'"]'
    attr = b' ' + key.encode() + b'="' + str(value).encode() + b'"'
    if re.search(pattern, head):
        head = re.sub(pattern, lambda _m: attr, head, count=1)
    else:
        at = -1 if head.endswith(b'/') else len(head)
        head = head[:at] + attr + head[at:]
    return head + b'>' + rest


def _style_append(xml, name, additions):
    match, old = _style_blocks(xml, name)
    if not additions:
        return xml
    segment = match.group(0)
    head, inner = segment.split(b'>', 1)
    head = _style_replace_attr(head + b'>', 'count', len(old) + len(additions)).split(b'>', 1)[0]
    close = inner.rfind(b'</')
    segment = head + b'>' + inner[:close] + b''.join(additions) + inner[close:]
    return xml[:match.start()] + segment + xml[match.end():]


def _style_append_fills(xml, additions):
    """把填充色写进 <fills> 表。

    OOXML 里 <styleSheet> 的子元素有固定次序（numFmts → fonts → **fills** → borders
    → cellXfs），所以表不在时只能插在 fonts 之后、borders 之前，插错位置 Excel 会报修复。
    """
    if not additions:
        return xml
    try:
        return _style_append(xml, 'fills', additions)
    except zipedit.SurgeryError:
        pass
    found = re.search(rb'.*?<((?:[A-Za-z_][\w.-]*:)?)styleSheet\b', xml, re.S)
    prefix = found.group(1) if found else b''
    block = b'<' + prefix + b'fills count="' + str(len(additions)).encode() + b'">' + b''.join(additions) + b'</' + prefix + b'fills>'
    anchor = re.search(rb'<(?:[A-Za-z_][\w.-]*:)?borders\b', xml)
    if anchor:
        return xml[:anchor.start()] + block + xml[anchor.start():]
    root = re.search(rb'<(?:[A-Za-z_][\w.-]*:)?styleSheet\b[^>]*>', xml)
    return xml[:root.end()] + block + xml[root.end():]


def _style_cell_ids(sheet_xml, coords):
    result = {}
    wanted = set(coords)
    # Column/row style inheritance must survive formatting a previously blank cell.
    columns = []
    for tag in re.findall(rb'<col\b[^>]*>', sheet_xml[:sheet_xml.find(b'<sheetData')]):
        attrs = dict(re.findall(rb'\b([A-Za-z]+)=[\'"]([^\'"]*)[\'"]', tag))
        if b'style' in attrs:
            columns.append((int(attrs.get(b'min', b'1')), int(attrs.get(b'max', b'1')), int(attrs[b'style'])))
    rows = zipedit._row_fragments(sheet_xml, {zipedit.parse_coord(c)[1] for c in wanted})
    for coord in wanted:
        col, row = zipedit.parse_coord(coord)
        fragment = rows.get(row, b'')
        rm = re.match(rb'<row\b[^>]*\ss=[\'"](\d+)[\'"]', fragment)
        sid = int(rm.group(1)) if rm else next((s for lo, hi, s in columns if lo <= col <= hi), 0)
        node = re.search(rb'<c\b(?=[^>]*\br=[\'"]' + coord.encode() + rb'[\'"])[^>]*?(?:/>|>.*?</c>)', fragment, re.S)
        if node:
            attr = re.search(rb'\ss=[\'"](\d+)[\'"]', node.group(0).split(b'>', 1)[0])
            if attr:
                sid = int(attr.group(1))
        result[coord] = sid
    return result


def _style_splice(sheet_xml, replacements):
    by_row = {}
    for coord, sid in replacements:
        col, row = zipedit.parse_coord(coord)
        by_row.setdefault(row, []).append((col, coord, sid))
    parts = sheet_xml.split(b'</row>')
    found = set()
    for i, part in enumerate(parts):
        start = part.rfind(b'<row')
        if start < 0:
            continue
        row = part[start:]
        match = re.match(rb'<row\b[^>]*\br=[\'"](\d+)[\'"]', row)
        if not match or int(match.group(1)) not in by_row:
            continue
        number = int(match.group(1));found.add(number)
        for col, coord, sid in sorted(by_row[number]):
            pattern = rb'<c\b(?=[^>]*\br=[\'"]' + coord.encode() + rb'[\'"])[^>]*?(?:/>|>.*?</c>)'
            node = re.search(pattern, row, re.S)
            if node:
                new = _style_replace_attr(node.group(0), 's', sid)
                row = row[:node.start()] + new + row[node.end():]
            else:
                new = b'<c r="' + coord.encode() + b'" s="' + str(sid).encode() + b'"/>'
                end = row.find(b'>')
                if row[:end + 1].endswith(b'/>'):
                    row = row[:end - 1] + b'>' + new + b'</row>' + row[end + 1:]
                else:
                    later = next((m.start() for m in re.finditer(rb'<c\b[^>]*\br=[\'"]([A-Z]+)[0-9]+[\'"]', row)
                                  if zipedit.col_to_num(m.group(1).decode()) > col), len(row))
                    row = row[:later] + new + row[later:]
        parts[i] = part[:start] + row
    result = b'</row>'.join(parts)
    # Empty rows inside the fixed row map need not have a physical <row> yet.
    # Materialize only selected style-only cells, without changing any value/dimension.
    for number in sorted(set(by_row) - found):
        body = b''.join(b'<c r="' + coord.encode() + b'" s="' + str(sid).encode() + b'"/>'
                        for col, coord, sid in sorted(by_row[number]))
        row = b'<row r="' + str(number).encode() + b'">' + body + b'</row>'
        at = next((m.start() for m in re.finditer(rb'<row\b[^>]*\br=[\'"](\d+)[\'"]', result)
                   if int(m.group(1)) > number), result.find(b'</sheetData>'))
        if at < 0:
            raise zipedit.SurgeryError('工作表结构不支持安全设置格式')
        result = result[:at] + row + result[at:]
    return result


def _style_restore(content, part, replacements):
    xml = _style_splice(zipedit.read_sheet(content, part), replacements)
    return zipedit.rebuild_zip(content, {part: xml})


def _style_wrap(xf, value):
    """设置自动换行（对齐相关属性的统一入口在 shangshu_files.style_extra）。"""
    from shangshu_files.style_extra import set_alignment
    return set_alignment(xf, wrap=bool(value))


def _style_add_number_format(xml, number_id, code):
    # The write whitelist contains no XML metacharacters; keep the original tree intact.
    prefix = re.match(rb'.*?<((?:[A-Za-z_][\w.-]*:)?)styleSheet\b', xml, re.S).group(1)
    node = b'<' + prefix + b'numFmt numFmtId="' + str(number_id).encode() + b'" formatCode="' + code.encode() + b'"/>'
    empty = re.search(rb'<(?:[A-Za-z_][\w.-]*:)?numFmts\b[^>]*/>', xml)
    if empty:
        block = b'<' + prefix + b'numFmts count="1">' + node + b'</' + prefix + b'numFmts>'
        return xml[:empty.start()] + block + xml[empty.end():]
    if re.search(rb'<(?:[A-Za-z_][\w.-]*:)?numFmts\b', xml):
        return _style_append(xml, 'numFmts', [node])
    root = re.search(rb'<(?:[A-Za-z_][\w.-]*:)?styleSheet\b[^>]*>', xml)
    return xml[:root.end()] + b'<' + prefix + b'numFmts count="1">' + node + b'</' + prefix + b'numFmts>' + xml[root.end():]


def _style_surgery(content, part, coords, style):
    from shangshu_files.style_extra import (UNSET, build_fill_xml, set_alignment,
                                            verify_cleared_after, verify_extra_after)
    patch = _style_patch(style)
    if not coords or len(coords) > 20000 or len(set(coords)) != len(coords):
        raise zipedit.SurgeryError('格式目标须为 1 到 20000 个不同单元格')
    index = _style_index(content)
    xml = zipedit.read_sheet(content, part)
    if not re.search(rb'<worksheet\b', xml):
        raise zipedit.SurgeryError('该工作表命名空间写法暂不支持安全设置格式')
    ids = _style_cell_ids(xml, coords)
    ranges = zipedit._merged_ranges(xml)
    fonts, xfs, borders, fills = [], [], [], []
    font_map = {raw: i for i, raw in enumerate(index['fonts'])}
    border_map = {raw: i for i, raw in enumerate(index['borders'])}
    fill_map = {raw: i for i, raw in enumerate(index['fills'])}
    xf_map = {raw: i for i, raw in enumerate(index['xfs'])}
    styles = index['xml']
    number_id = None
    if 'number_format' in patch:
        number_id = next((key for key, value in index['formats'].items() if value == patch['number_format']), None)
        if number_id is None:
            number_id = max(163, *index['formats']) + 1
            styles = _style_add_number_format(styles, number_id, patch['number_format'])
    changes, replacements = [], []
    # 边框按**选区**算：外框只画选区外围、内框只画内部、单边只落一条边，
    # 所以先把整批目标的包围盒算出来，才能逐格决定画哪几条。
    border_bounds = None
    border_prefix = b''
    expected_edges = {}
    if 'border' in patch:
        parsed = [zipedit.parse_coord(coord) for coord in coords]
        border_bounds = (min(c for c, _ in parsed), max(c for c, _ in parsed),
                         min(r for _, r in parsed), max(r for _, r in parsed))
        if index['borders']:
            found = re.match(rb'<((?:[A-Za-z_][\w.-]*:)?)border\b', index['borders'][0])
            border_prefix = found.group(1) if found else b''
    fill_prefix = b''
    if index['fills']:
        found = re.match(rb'<((?:[A-Za-z_][\w.-]*:)?)fill\b', index['fills'][0])
        fill_prefix = found.group(1) if found else b''
    else:
        found = re.match(rb'<((?:[A-Za-z_][\w.-]*:)?)styleSheet\b', styles, re.S)
        fill_prefix = found.group(1) if found else b''
    xf_prefix = b''
    if index['xfs']:
        found = re.match(rb'<((?:[A-Za-z_][\w.-]*:)?)xf\b', index['xfs'][0])
        xf_prefix = found.group(1) if found else b''
    # 清除格式：整格回到工作簿默认（常规、无填充、无边框、无对齐、默认字体）。
    default_xf = None
    if patch.get('clear_format'):
        default_xf = (b'<' + xf_prefix + b'xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>')
    for coord in coords:
        col, row = zipedit.parse_coord(coord)
        if zipedit.in_merge(col, row, ranges):
            raise zipedit.SurgeryError('合并区域非左上角不能设置格式：' + coord)
        old_id = ids[coord]
        if old_id >= len(index['xfs']):
            raise zipedit.SurgeryError('单元格样式引用不存在：' + coord)
        before = index['views'][old_id]
        xf = index['xfs'][old_id]
        clone = xf
        if default_xf is not None:
            clone = default_xf
        else:
            font_patch = {k: v for k, v in patch.items() if k in ('font_size', 'font_color', 'bold', 'italic', 'underline')}
            if font_patch:
                fid = int(_style_element(xf).get('fontId', '0'))
                font = _style_patch_font(index['fonts'][fid], font_patch)
                if font not in font_map:
                    font_map[font] = len(index['fonts']) + len(fonts); fonts.append(font)
                clone = _style_replace_attr(clone, 'fontId', font_map[font])
                clone = _style_replace_attr(clone, 'applyFont', 1)
            if number_id is not None:
                clone = _style_replace_attr(clone, 'numFmtId', number_id)
                clone = _style_replace_attr(clone, 'applyNumberFormat', 1)
            if 'fill_color' in patch:
                color = patch['fill_color']
                if color is None:
                    clone = _style_replace_attr(clone, 'fillId', 0)
                else:
                    fill = build_fill_xml(fill_prefix, color)
                    if fill not in fill_map:
                        fill_map[fill] = len(index['fills']) + len(fills); fills.append(fill)
                    clone = _style_replace_attr(clone, 'fillId', fill_map[fill])
                clone = _style_replace_attr(clone, 'applyFill', 1)
            align_patch = {}
            if 'wrap_text' in patch:
                align_patch['wrap'] = patch['wrap_text']
            if 'horizontal_align' in patch:
                align_patch['horizontal'] = patch['horizontal_align']
            if 'vertical_align' in patch:
                align_patch['vertical'] = patch['vertical_align']
            if align_patch:
                clone = set_alignment(clone, **align_patch)
            if 'border' in patch:
                edges = edges_for_cell(patch['border']['preset'], patch['border']['style'],
                                       patch['border']['color'], col, row, border_bounds)
                border = build_border_xml(border_prefix, edges)
                if border not in border_map:
                    border_map[border] = len(index['borders']) + len(borders); borders.append(border)
                clone = _style_replace_attr(clone, 'borderId', border_map[border])
                clone = _style_replace_attr(clone, 'applyBorder', 1)
                expected_edges[coord] = edges
        if 'border' not in patch and 'clear_format' not in patch and all(before.get(k) == v for k, v in patch.items()):
            continue
        if clone == xf:
            continue
        if clone not in xf_map:
            xf_map[clone] = len(index['xfs']) + len(xfs); xfs.append(clone)
        new_id = xf_map[clone]
        replacements.append((coord, new_id))
        changes.append({'coord': coord, 'before_style_id': old_id, 'after_style_id': new_id, 'before': dict(before)})
    if not changes:
        return content, [], index
    styles = _style_append(_style_append(_style_append(styles, 'fonts', fonts), 'borders', borders), 'cellXfs', xfs)
    if fills:
        styles = _style_append_fills(styles, fills)
    saved = zipedit.rebuild_zip(content, {part: _style_splice(xml, replacements), 'xl/styles.xml': styles})
    after_index = _style_index(saved)
    default_view = None
    if default_xf is not None:
        default_id = next((i for i, raw in enumerate(after_index['xfs']) if raw == default_xf), None)
        if default_id is None:
            raise zipedit.SurgeryError('清除格式所需的默认样式不存在，本批未保存')
        default_view = after_index['views'][default_id]
    for change in changes:
        change['after'] = dict(after_index['views'][change['after_style_id']])
        if default_view is not None:
            try:
                verify_cleared_after(change['after'], default_view)
            except ValueError as error:
                raise zipedit.SurgeryError(str(error))
        else:
            expected = {k: v for k, v in patch.items() if k != 'border'}
            try:
                verify_extra_after(change['after'], expected)
            except ValueError as error:
                raise zipedit.SurgeryError(str(error))
        if 'border' in patch:
            try:
                verify_border_after(change['after'].get('border'), expected_edges.get(change['coord'], {}))
            except ValueError as error:
                raise zipedit.SurgeryError(str(error))
    after_ids = _style_cell_ids(zipedit.read_sheet(saved, part), coords)
    if any(after_ids[c['coord']] != c['after_style_id'] or after_index['views'][c['after_style_id']] != c['after'] for c in changes):
        raise zipedit.SurgeryError('格式写后核验失败，本批未保存')
    return saved, changes, after_index


def _style_context(doc, content, payload):
    reason = readonly_reason(content)
    if reason:
        frappe.throw(reason, frappe.ValidationError)
    entry, _diag = _parsed(doc, content)
    meta = _ensure_meta_rows(doc, len(entry['rows_raw']), entry['sheet_title'])
    if payload.get('sheet') not in (None, '', meta['primary_sheet'], entry['sheet_title']):
        frappe.throw('仅支持当前编辑工作表的格式', frappe.ValidationError)
    part = zipedit.sheet_part_by_title(content, entry['sheet_title'])
    if not part:
        frappe.throw('找不到目标工作表', frappe.ValidationError)
    return meta, entry, part


def _style_update_cache(doc, entry, meta, changes, version_no, index):
    try:
        row_pos = {rid: i + 2 for i, rid in enumerate(meta['rows'])}
        col_pos = {h: i + 1 for i, h in enumerate(entry['headers'])}
        for item in changes:
            entry.setdefault('style_ids', {})[(row_pos[item['row_id']], col_pos[item['header']])] = item['after_style_id']
        entry['font_styles'] = index['views']
        _rekey_parse(doc, entry, version_no)
    except Exception:
        _invalidate_parse(doc.name)


def write_style(payload, _context=None):
    doc = _writable(payload.get('table'))
    if doc.status != 'Active':
        frappe.throw('回收站中的文件先恢复再设置格式', frappe.ValidationError)
    content = _content(doc, for_write=True)
    meta, entry, part = _style_context(doc, content, payload)
    _check_versions(doc, meta, payload)
    raw = payload.get('cells')
    if not isinstance(raw, list) or not 1 <= len(raw) <= 20000:
        frappe.throw('格式操作须包含 1 到 20000 格', frappe.ValidationError)
    op_id = str(payload.get('op_id') or '').strip()
    if not op_id:
        frappe.throw('格式操作缺少操作编号', frappe.ValidationError)
    if frappe.db.exists(OP_DOCTYPE, {'file': doc.name, 'op_id': op_id}):
        frappe.throw('该格式操作编号已使用，请使用原请求重试或新建操作编号', frappe.ValidationError)
    from shangshu_files.object_projection import authorize_rows
    authorize_rows(doc,[item.get('row_id') for item in raw if isinstance(item,dict)])
    rows = {rid: i + 2 for i, rid in enumerate(meta['rows'])}
    headers = entry['headers']
    columns = {h: i + 1 for i, h in enumerate(headers)}
    coords, positions = [], {}
    for item in raw:
        if not isinstance(item, dict) or item.get('row_id') not in rows or item.get('header') not in columns:
            frappe.throw('目标行或表头不存在，格式本批未保存', frappe.ValidationError)
        if headers.count(item['header']) != 1:
            frappe.throw('重复表头不能安全定位，格式本批未保存', frappe.ValidationError)
        coord = coord_of(columns[item['header']], rows[item['row_id']])
        coords.append(coord);positions[coord] = item
    try:
        saved, changes, index = _style_surgery(content, part, coords, payload.get('style'))
    except (zipedit.SurgeryError, ValueError, KeyError) as error:
        frappe.throw(str(error), frappe.ValidationError)
    version = content_revision(doc)
    cells = [{**c, 'row_id': positions[c['coord']]['row_id'], 'header': positions[c['coord']]['header'], 'kind': 'style'} for c in changes]
    if cells:
        version = _save_current(doc, saved, 'sheet-style·%d格（操作%s）' % (len(cells), op_id))
        _record_op(doc, 'files.sheet_style_write', op_id, cells, version, _context)
        # Formatting the last logical blank row must not make it disappear on a cold
        # read (the legacy extent scan deliberately ignores residual styled blanks).
        meta['style_row_floor'] = len(meta['rows'])
        _save_meta(doc, meta)
        _style_update_cache(doc, entry, meta, cells, version, index)
    return {'table': doc.name, 'sheet': meta['primary_sheet'], 'kind': 'style', 'op_id': op_id,
            'applied': len(cells), 'cells': cells, 'content_version': version,
            'structure_version': int(meta.get('structure_version') or 1)}


def _style_undo(doc, record, payload, _context):
    content = _content(doc, for_write=True)
    meta, entry, part = _style_context(doc, content, payload)
    original = json.loads(record.cells_json or '[]')
    from shangshu_files.object_projection import authorize_rows
    authorize_rows(doc,[item['row_id'] for item in original])
    index = _style_index(content)
    row_pos = {rid: i + 2 for i, rid in enumerate(meta['rows'])}
    col_pos = {h: i + 1 for i, h in enumerate(entry['headers'])}
    ids = _style_cell_ids(zipedit.read_sheet(content, part), [coord_of(col_pos[c['header']], row_pos[c['row_id']])
                          for c in original if c['row_id'] in row_pos and c['header'] in col_pos])
    cells, skipped = [], []
    for item in original:
        row, header = item['row_id'], item['header']
        if row not in row_pos or header not in col_pos:
            skipped.append({'row_id': row, 'header': header, 'reason': 'missing'});continue
        coord = coord_of(col_pos[header], row_pos[row])
        current = ids[coord]
        if current != item['after_style_id']:
            skipped.append({'row_id': row, 'header': header, 'reason': 'already' if current == item['before_style_id'] else 'changed'});continue
        cells.append({'row_id': row, 'header': header, 'coord': coord, 'kind': 'style',
                      'before': index['views'][current], 'after': index['views'][item['before_style_id']],
                      'before_style_id': current, 'after_style_id': item['before_style_id']})
    version = content_revision(doc)
    if cells:
        saved = _style_restore(content, part, [(c['coord'], c['after_style_id']) for c in cells])
        saved_ids = _style_cell_ids(zipedit.read_sheet(saved, part), [c['coord'] for c in cells])
        if any(saved_ids[c['coord']] != c['after_style_id'] for c in cells):
            frappe.throw('格式撤回核验失败，本次未保存', frappe.ValidationError)
        version = _save_current(doc, saved, 'sheet-style·撤回操作%s' % payload['op_id'])
        _record_op(doc, 'files.sheet_style_undo', payload['op_id'] + ':undo', cells, version, _context)
        frappe.db.set_value(OP_DOCTYPE, record.name, 'undone', 1, update_modified=False)
        _style_update_cache(doc, entry, meta, cells, version, index)
    return {'table': doc.name, 'sheet': meta['primary_sheet'], 'kind': 'style', 'op_id': payload['op_id'],
            'applied': len(cells), 'cells': cells, 'skipped': skipped, 'content_version': version,
            'structure_version': int(meta.get('structure_version') or 1)}


# ── 第四批：成包编辑（查找替换 / 填充序列 / 选择性粘贴） ──────────────────────
#
# 三条都是「**一次成包写 + 逐格 before/after 快照**」：
#   · 查找替换：服务端扫**全表**找出命中的格 → 一次写完（不受前端分页限制）
#   · 填充序列：按步长算一串值 → 一次写完
#   · 选择性粘贴：只贴值 / 只贴公式 / 只贴格式（三种互斥，各是一次包）
#
# 写都走既有的受管写路径（`write_cells` / 样式手术），所以：
# 一次落盘 = content_version 恰 +1 = 撤回一步；台账里逐格有 before/after。
# 「纯规则」（怎么算、怎么匹配）在 sheet_bulk.py —— 那儿不依赖 frappe，能单独测。


def _bulk_context(doc, content, payload):
    """成包编辑共用的开场：只读原因、元数据、目标工作表部件。

    与 `_style_context` 同一套口径，但**报错文案按动作说** ——
    「仅支持当前编辑工作表的格式」这话放在查找替换上会让人一头雾水。
    """
    reason = readonly_reason(content)
    if reason:
        frappe.throw(reason, frappe.ValidationError)
    entry, _diag = _parsed(doc, content)
    meta = _ensure_meta_rows(doc, len(entry['rows_raw']), entry['sheet_title'])
    if payload.get('sheet') not in (None, '', meta['primary_sheet'], entry['sheet_title']):
        frappe.throw('找不到要操作的工作表：' + str(payload.get('sheet')), frappe.ValidationError)
    part = zipedit.sheet_part_by_title(content, entry['sheet_title'])
    if not part:
        frappe.throw('找不到目标工作表', frappe.ValidationError)
    return meta, entry, part


def _bulk_scan_cells(meta, entry):
    """整表扫描：只列**文本格与公式格**。

    数字/日期格不进替换计划 —— 把数字换成文字会撞列类型闸（写不进去），
    这一格就算「不参与文字替换」，由调用方如实报给用户。
    """
    rows = list(meta.get('rows') or [])
    headers = list(entry.get('headers') or [])
    raw_rows = entry.get('rows_raw') or []
    cells = []
    for pos, row in enumerate(raw_rows):
        if pos >= len(rows):
            break
        for col, raw in enumerate(row):
            if col >= len(headers) or raw is None:
                continue
            typed = value_typed(raw)
            kind = typed.get('type')
            if kind == 'text':
                cells.append({'row_id': rows[pos], 'header': headers[col],
                              'text': typed.get('value'), 'kind': 'text', 'col': col})
            elif kind == 'formula':
                cells.append({'row_id': rows[pos], 'header': headers[col],
                              'text': typed.get('formula'), 'kind': 'formula', 'col': col})
    return cells


def _bulk_header_index(headers, header):
    for index, name in enumerate(headers):
        if name == header:
            return index
    return None


def _bulk_write(payload, _context, cells, action_id):
    """成包写的统一出口：交给受管写路径（一次落盘、逐格快照、台账落账）。"""
    inner = dict(payload)
    inner['cells'] = cells
    return write_cells(inner, _context, action_id=action_id)


def _bulk_cell_style_id(entry, pos, col):
    """源格的样式编号（0 = 默认）。缓存里没有就按行/列继承兜底。"""
    style_ids = entry.get('style_ids') or {}
    row_key, col_key = pos + 2, col + 1
    if (row_key, col_key) in style_ids:
        return int(style_ids[(row_key, col_key)])
    row_styles = entry.get('row_style_ids') or {}
    if row_key in row_styles:
        return int(row_styles[row_key])
    column_styles = entry.get('column_style_ids') or {}
    if col_key in column_styles:
        return int(column_styles[col_key])
    return 0


def _bulk_formula_value(meta, row_id, header, typed, version):
    """公式格的**计算结果**（只贴值时用它）。算不出来就回 None。"""
    try:
        from shangshu_files.formulas import decorate_values
        decorated = decorate_values({header: typed}, row_id, meta, version, set())
    except Exception:
        return None
    result = (decorated or {}).get(header) or {}
    if result.get('hidden') or result.get('calculation_pending'):
        return None
    return result.get('value')


def _bulk_raw_at(entry, row, col):
    raw_rows = entry.get('rows_raw') or []
    if 0 <= row < len(raw_rows) and 0 <= col < len(raw_rows[row]):
        return raw_rows[row][col]
    return None


def _bulk_derive_step(entry, start_row, start_col, vertical):
    """从**第二个格**推导步长（数字差 / 日期差）。推不出来就回 None。"""
    first = value_typed(_bulk_raw_at(entry, start_row, start_col))
    second_row = start_row + 1 if vertical else start_row
    second_col = start_col if vertical else start_col + 1
    second = value_typed(_bulk_raw_at(entry, second_row, second_col))
    if first.get('type') == 'number' and second.get('type') == 'number':
        return ('linear', float(second['value']) - float(first['value']))
    if first.get('type') == 'date' and second.get('type') == 'date':
        try:
            start = datetime.date.fromisoformat(str(first['value'])[:10])
            end = datetime.date.fromisoformat(str(second['value'])[:10])
        except ValueError:
            return None
        return ('date', (end - start).days)
    return None


def find_replace(payload, _context=None):
    """files.sheet_find_replace：整表查找替换。

    - 查找范围是**整张表**（服务端扫全表），不是当前页 —— 不用先翻页。
    - 只改**文本格与公式格**；公式格替换的是公式**文本**里的命中片段，写回后仍是公式。
    - 命中一次成包写完：一个版本、一步撤回；台账逐格有 before/after。
    - **没命中就不落盘**（版本不动）——「没找到」不是一次写入。
    - 数字/日期为主的列里若有文字格，那些格**不参与**替换（如实报 skipped）。
    """
    doc = _writable(payload.get('table'))
    if doc.status != 'Active':
        frappe.throw('回收站中的文件先恢复再替换', frappe.ValidationError)
    find = str(payload.get('find') or '')
    if not find:
        frappe.throw('请填写要查找的内容', frappe.ValidationError)
    replace = '' if payload.get('replace') is None else str(payload.get('replace'))
    op_id = str(payload.get('op_id') or '').strip()
    if not op_id:
        frappe.throw('请给出本包的操作编号（op_id），用于审计与撤回定位', frappe.ValidationError)
    content = _content(doc, for_write=True)
    meta, entry, part = _bulk_context(doc, content, payload)
    _check_versions(doc, meta, payload)
    from shangshu_files.sheet_bulk import plan_find_replace
    headers = list(entry.get('headers') or [])
    col_types = list(entry.get('column_types') or [])
    scanned = _bulk_scan_cells(meta, entry)
    changes = plan_find_replace(scanned, find, replace,
                                bool(payload.get('match_case')), bool(payload.get('whole_cell')))
    skipped, writeable = [], []
    for change in changes:
        col = _bulk_header_index(headers, change.get('header'))
        ctype = col_types[col] if col is not None and col < len(col_types) else None
        if change['kind'] == 'text' and ctype and ctype != 'text':
            skipped.append({'row_id': change.get('row_id'), 'header': change.get('header'),
                            'reason': '该列以%s为主，写入文字会被列类型规则拒' % TYPE_LABEL.get(ctype, ctype)})
            continue
        writeable.append(change)
    version = content_revision(doc)
    if not writeable:
        return {'table': doc.name, 'sheet': meta.get('primary_sheet'), 'op_id': op_id,
                'applied': 0, 'matched': 0, 'scanned': len(scanned), 'skipped': skipped,
                'cells': [], 'content_version': version,
                'structure_version': int(meta.get('structure_version') or 1)}
    if len(writeable) > MAX_BATCH_CELLS:
        frappe.throw('一次最多替换 %d 格（现 %d 格），请缩小查找范围后重试'
                     % (MAX_BATCH_CELLS, len(writeable)), frappe.ValidationError)
    result = _bulk_write(payload, _context, [
        {'row_id': item['row_id'], 'header': item['header'],
         'value': ({'type': 'formula', 'formula': item['formula']} if item['kind'] == 'formula'
                   else {'type': 'text', 'value': item['text']})}
        for item in writeable], 'files.sheet_find_replace')
    result['matched'] = len(writeable)
    result['scanned'] = len(scanned)
    result['skipped'] = skipped
    return result


def fill_series(payload, _context=None):
    """files.sheet_fill_series：按序列填充一段区域。

    口径（说清楚，免得用户猜）：
    - 选区是**一列**就向下填，是**一行**就向右填；跨多行多列一律拒（先选一列或一行）。
    - 起始格是**种子**：它自己不改，从它往下/往右按步长填。
    - **列表**是例外：清单从选区**第一格**开始铺（用户给的是内容，不是种子）。
    - 步长没给就从**第二个格**推导（数字差 / 日期差）；推导不出来按 1 填。
    - 一次成包写完：一个版本、一步撤回。
    """
    doc = _writable(payload.get('table'))
    if doc.status != 'Active':
        frappe.throw('回收站中的文件先恢复再填充', frappe.ValidationError)
    op_id = str(payload.get('op_id') or '').strip()
    if not op_id:
        frappe.throw('请给出本包的操作编号（op_id），用于审计与撤回定位', frappe.ValidationError)
    try:
        start_row = int(payload.get('start_row'))
        start_col = int(payload.get('start_col'))
        end_row = int(payload.get('end_row'))
        end_col = int(payload.get('end_col'))
    except (TypeError, ValueError):
        frappe.throw('填充范围无效', frappe.ValidationError)
    if start_row < 0 or start_col < 0 or end_row < start_row or end_col < start_col:
        frappe.throw('填充范围无效', frappe.ValidationError)
    if end_row > start_row and end_col > start_col:
        frappe.throw('请选择一列或一行来填充（当前选区跨了多行多列）', frappe.ValidationError)
    content = _content(doc, for_write=True)
    meta, entry, part = _bulk_context(doc, content, payload)
    _check_versions(doc, meta, payload)
    rows = list(meta.get('rows') or [])
    headers = list(entry.get('headers') or [])
    vertical = end_row > start_row
    count = (end_row - start_row + 1) if vertical else (end_col - start_col + 1)
    if start_row >= len(rows) or start_col >= len(headers):
        frappe.throw('填充的起始格不在表里，请先选中表内的一格', frappe.ValidationError)
    kind = str(payload.get('series_type') or 'linear')
    start_typed = value_typed(_bulk_raw_at(entry, start_row, start_col))
    override = payload.get('start_value')
    spec = {'type': kind}
    step_given = payload.get('step')
    if kind == 'linear':
        if start_typed.get('type') == 'number':
            spec['start'] = start_typed['value']
        elif override is not None and str(override).strip() != '':
            try:
                spec['start'] = float(override)
            except (TypeError, ValueError):
                frappe.throw('等差填充的起始值须为数字', frappe.ValidationError)
        else:
            frappe.throw('起始格不是数字，等差填充需要一个数字起点', frappe.ValidationError)
        if step_given is None and count > 1:
            derived = _bulk_derive_step(entry, start_row, start_col, vertical)
            spec['step'] = derived[1] if derived and derived[0] == 'linear' else 1
        else:
            spec['step'] = 1 if step_given is None else step_given
    elif kind == 'date':
        if start_typed.get('type') == 'date':
            spec['start'] = start_typed['value']
        elif override is not None and str(override).strip() != '':
            spec['start'] = str(override)
        else:
            frappe.throw('起始格不是日期，日期填充需要一个日期起点', frappe.ValidationError)
        spec['unit'] = str(payload.get('unit') or 'day')
        if step_given is None and count > 1:
            derived = _bulk_derive_step(entry, start_row, start_col, vertical)
            spec['step'] = derived[1] if derived and derived[0] == 'date' else 1
            if derived and derived[0] == 'date':
                spec['unit'] = 'day'
        else:
            spec['step'] = 1 if step_given is None else step_given
    elif kind == 'list':
        spec['values'] = payload.get('values') or []
    elif kind == 'copy':
        if start_typed.get('type') != 'empty':
            spec['start'] = start_typed.get('value')
        elif override is not None:
            spec['start'] = override
        else:
            frappe.throw('起始格是空的，请先填一个要复制的值', frappe.ValidationError)
    else:
        frappe.throw('填充方式无效（可选：等差、日期、列表、复制）', frappe.ValidationError)
    if payload.get('stop_value') not in (None, ''):
        spec['stop'] = payload.get('stop_value')
    from shangshu_files.sheet_bulk import compute_series
    try:
        values = compute_series(spec, count)
    except ValueError as error:
        frappe.throw(str(error), frappe.ValidationError)
    cells = []
    for index, item in enumerate(values):
        if index == 0 and kind != 'list':
            continue  # 起始格是种子（等差/日期/复制），它自己不改
        row_pos = start_row + index if vertical else start_row
        col_pos = start_col if vertical else start_col + index
        if row_pos >= len(rows) or col_pos >= len(headers):
            frappe.throw('填充目标超出表格范围（请先加行加列）', frappe.ValidationError)
        cells.append({'row_id': rows[row_pos], 'header': headers[col_pos], 'value': item})
    version = content_revision(doc)
    if not cells:
        return {'table': doc.name, 'sheet': meta.get('primary_sheet'), 'op_id': op_id,
                'applied': 0, 'filled': 0, 'cells': [], 'content_version': version,
                'structure_version': int(meta.get('structure_version') or 1)}
    result = _bulk_write(payload, _context, cells, 'files.sheet_fill_series')
    result['filled'] = len(cells)
    return result


def _style_assign(content, part, replacements):
    """把目标格的样式编号设成给定值（复制格式用；只改 `s` 属性，不动别的）。"""
    xml = _style_splice(zipedit.read_sheet(content, part), replacements)
    return zipedit.rebuild_zip(content, {part: xml})


def paste_special(payload, _context=None):
    """files.sheet_paste_special：选择性粘贴。

    三种模式互斥（一次包只做一种）：
    - `values`：只贴值（公式格贴它的计算结果）
    - `formulas`：只贴公式（公式格写回公式，别的格按文本写）
    - `formats`：只贴格式（目标格套上源格的样式，值一个不动）

    源区域与目标区域都在**这张表**里（源区域 = 用户复制的那块）。
    「跳过空」：源格是空的就不动目标格。
    """
    doc = _writable(payload.get('table'))
    if doc.status != 'Active':
        frappe.throw('回收站中的文件先恢复再粘贴', frappe.ValidationError)
    op_id = str(payload.get('op_id') or '').strip()
    if not op_id:
        frappe.throw('请给出本包的操作编号（op_id），用于审计与撤回定位', frappe.ValidationError)
    mode = str(payload.get('mode') or '')
    if mode not in ('values', 'formulas', 'formats'):
        frappe.throw('请选择要粘贴什么（只贴值 / 只贴公式 / 只贴格式）', frappe.ValidationError)
    try:
        source_row = int(payload.get('source_row'))
        source_col = int(payload.get('source_col'))
        target_row = int(payload.get('target_row'))
        target_col = int(payload.get('target_col'))
        source_rows = int(payload.get('source_rows') or 1)
        source_cols = int(payload.get('source_cols') or 1)
    except (TypeError, ValueError):
        frappe.throw('粘贴范围无效', frappe.ValidationError)
    if min(source_row, source_col, target_row, target_col) < 0 or source_rows < 1 or source_cols < 1:
        frappe.throw('粘贴范围无效', frappe.ValidationError)
    if source_rows * source_cols > MAX_BATCH_CELLS:
        frappe.throw('一次最多粘贴 %d 格（现 %d 格），请缩小选区' % (MAX_BATCH_CELLS, source_rows * source_cols),
                     frappe.ValidationError)
    content = _content(doc, for_write=True)
    meta, entry, part = _bulk_context(doc, content, payload)
    _check_versions(doc, meta, payload)
    rows = list(meta.get('rows') or [])
    headers = list(entry.get('headers') or [])
    version = content_revision(doc)
    source_cells = []
    for row_offset in range(source_rows):
        for col_offset in range(source_cols):
            pos = source_row + row_offset
            col = source_col + col_offset
            typed = value_typed(_bulk_raw_at(entry, pos, col))
            kind = typed.get('type')
            display = typed.get('value')
            formula = None
            if kind == 'formula':
                formula = typed.get('formula')
                computed = _bulk_formula_value(meta, rows[pos] if pos < len(rows) else '',
                                               headers[col] if col < len(headers) else '',
                                               typed, version)
                display = computed if computed is not None else formula
            source_cells.append({'kind': kind, 'value': typed.get('value'), 'formula': formula,
                                 'display': display, 'style_id': _bulk_cell_style_id(entry, pos, col)})
    from shangshu_files.sheet_bulk import plan_paste_special, translate_formula
    plan = plan_paste_special(source_cells, mode, bool(payload.get('skip_empty')))
    if mode == 'formulas':
        # 贴公式时**相对引用跟着挪**（Excel 的粘贴语义）：不挪的话，贴过去的公式
        # 还指着源格 —— 看着像搬了家，算的还是老地方。
        for item in plan:
            if item.get('kind') != 'value' or (item.get('value') or {}).get('type') != 'formula':
                continue
            index = item['index']
            origin = coord_of(source_col + index % source_cols + 1, source_row + index // source_cols + 2)
            destination = coord_of(target_col + index % source_cols + 1, target_row + index // source_cols + 2)
            item['value'] = {'type': 'formula',
                             'formula': translate_formula(item['value']['formula'], origin, destination)}
    if not plan:
        return {'table': doc.name, 'sheet': meta.get('primary_sheet'), 'op_id': op_id,
                'applied': 0, 'cells': [], 'content_version': version,
                'structure_version': int(meta.get('structure_version') or 1)}
    if mode == 'formats':
        return _paste_special_formats(doc, content, part, meta, entry, payload, _context,
                                       plan, op_id, source_cols, target_row, target_col)
    cells = []
    for item in plan:
        index = item['index']
        row_pos = target_row + index // source_cols
        col_pos = target_col + index % source_cols
        if row_pos >= len(rows) or col_pos >= len(headers):
            frappe.throw('粘贴目标超出表格范围（请先加行加列）', frappe.ValidationError)
        cells.append({'row_id': rows[row_pos], 'header': headers[col_pos], 'value': item['value']})
    result = _bulk_write(payload, _context, cells, 'files.sheet_paste_special')
    return result


def _paste_special_formats(doc, content, part, meta, entry, payload, _context,
                            plan, op_id, source_cols, target_row, target_col):
    """选择性粘贴的「只贴格式」：目标格套上源格的样式号，值一个不动。"""
    rows = list(meta.get('rows') or [])
    headers = list(entry.get('headers') or [])
    replacements, cells = [], []
    for item in plan:
        index = item['index']
        row_pos = target_row + index // source_cols
        col_pos = target_col + index % source_cols
        if row_pos >= len(rows) or col_pos >= len(headers):
            frappe.throw('粘贴目标超出表格范围（请先加行加列）', frappe.ValidationError)
        coord = coord_of(col_pos + 1, row_pos + 2)
        replacements.append((coord, int(item.get('style_id') or 0)))
        cells.append({'row_id': rows[row_pos], 'header': headers[col_pos], 'coord': coord,
                      'kind': 'style', 'before_style_id': 0, 'after_style_id': int(item.get('style_id') or 0)})
    before_ids = _style_cell_ids(zipedit.read_sheet(content, part), [c['coord'] for c in cells])
    for cell in cells:
        cell['before_style_id'] = int(before_ids.get(cell['coord'], 0))
    saved = _style_assign(content, part, replacements)
    after_ids = _style_cell_ids(zipedit.read_sheet(saved, part), [c['coord'] for c in cells])
    for cell in cells:
        if int(after_ids.get(cell['coord'], 0)) != int(cell['after_style_id']):
            frappe.throw('格式粘贴核验失败，本次未保存', frappe.ValidationError)
    version = _save_current(doc, saved, 'sheet-paste-special·格式 %d 格（操作%s）' % (len(cells), op_id))
    _record_op(doc, 'files.sheet_paste_special', op_id, cells, version, _context)
    # 样式写到最后一行的空白格上时，行不能因为「没有值」在冷读时消失。
    meta['style_row_floor'] = len(meta.get('rows') or [])
    _save_meta(doc, meta)
    _style_update_cache(doc, entry, meta, cells, version, _style_index(content))
    return {'table': doc.name, 'sheet': meta.get('primary_sheet'), 'op_id': op_id, 'kind': 'style',
            'applied': len(cells), 'cells': cells, 'content_version': version,
            'structure_version': int(meta.get('structure_version') or 1)}


def row_restore(payload, _context=None):
    """恢复同一固定行身份；不新建记录、不覆盖任何已有单元格。"""
    doc = _writable(payload.get('table')); _require_structure(doc)
    rid = str(payload.get('row_id') or '').strip()
    result = _fast_row_visibility(doc, _content(doc, for_write=True), payload, _context,
                                  [{'row_id':rid,'deleted':False}])
    return {**result,'row_id':rid,'restored':True}


def _move_structure(payload, axis):
    from shangshu_files.sheet_structure import move_order, permute
    doc, wb, meta, ws = _structure_open(payload)
    old = list(meta['rows']) if axis == 'row' else _headers_of(ws)
    identity = payload.get('row_id' if axis == 'row' else 'header')
    before = payload.get('before_row_id' if axis == 'row' else 'before_header')
    try:
        new = move_order(old, identity, before)
        offset = 2 if axis == 'row' else 1
        positions = {value:index+offset for index,value in enumerate(new)}
        permute(ws, axis, {index+offset:positions[value] for index,value in enumerate(old)})
    except ValueError as error:
        frappe.throw(str(error), frappe.ValidationError)
    if axis == 'row':meta['rows'] = new
    else:meta['headers'] = new
    _bump_structure(meta)
    # —— **挪列要把受管绑定带着走**（2026-10-29 · 拖列交互上线后查出来的）——
    #   `bump_structure` 让结构版本 +1；而受管绑定钉的是**绑定那一刻**的结构版本
    #   ⇒ 不管的话**每挪一次列，绑定就废一次** ⇒ `row_read(headers=[受管列])` 当场被拒
    #   （「晋升定义与当前表结构不一致」）⇒ **拖一次就得重新定义一次**，人没法用。
    #   ⚠️ **为什么挪列可以不算「结构变了」**：绑定的作用是「别拿旧绑定乱对新表」，
    #   前提是**列集合变了**（加了列／删了列／改了列名 ⇒ 字段与值的对应要重新核）；
    #   **挪列只换位置**：列集合一字未变、受管字段与列的对应一字未变 ⇒ 绑定该跟着走。
    #   ⚠️ **加列／删列不在这一支**（它们仍会让绑定失效 —— 那道闸不许被拆掉）。
    if axis == 'column':
        _rebind_after_column_move(doc, meta)
    version = _save_with_gates(doc, wb, ws, meta)
    return {'table':doc.name,'moved':identity,'content_version':version,
            'structure_version':meta['structure_version'],'has_formulas':bool(meta.get('formula_results'))}


def _rebind_after_column_move(doc, meta):
    """挪完列 ⇒ **把受管绑定重新钉到当前结构版本**（列集合没变，绑定该跟着走）。

    ⚠️ **只挪位置、不碰受管对象、不碰任何值**：
    受管字段与列的对应**一个字没变**（列名没变、列集合没变）⇒
    这里只是把 `meta['promotion']['structure_version']` 更新成当前的
    ⇒ **下一次读受管列不会被那道闸拒**。

    ⚠️ **没绑定的表**（不是受管表）⇒ **一个字都不动**（别给普通表塞一个绑定）。
    """
    raw = meta.get('promotion')
    if not isinstance(raw, dict) or not raw.get('columns'):
        return
    raw['structure_version'] = int(meta.get('structure_version') or 1)


def row_move(payload, _context=None):
    return _move_structure(payload, 'row')


def column_move(payload, _context=None):
    return _move_structure(payload, 'column')
