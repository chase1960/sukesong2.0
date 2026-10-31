"""xlsx 字节级定点改写（zip 手术）：只重写目标工作表部件，其余 zip 条目压缩字节原样拷贝。

为什么（R1 根因，2026-10-13 分段计时坐实）：openpyxl 路线每次单格写
解析 6.5s + 整簿序列化 6.6s + 保存后重开校验 7.6s + 全簿快照 1.2s ≈ 24s，
9.7MB/15500 行真实样本上单格 P95 达 59s。手术路线避免整簿对象化与序列化；
目标 XML 扫描、压缩和可靠落盘仍与相关部件／文件大小有关，不承诺物理 O(1)。

保证（shangshu-server/scripts/tests/test_zip_surgery.py 逐条判）：
- 除被改写部件外，全部 zip 条目压缩字节与原文件逐字节一致——这本身就是
  「未改内容不被改动」的最强证明，替代 openpyxl 路线的 V4 全簿值差分。
- 目标格写后 openpyxl 与 raw XML 双读回 = 新值。
- 写入 ≥1e15 的数值拒（沿用 PRECISION_LIMIT：%.16g 会写坏它）；未改的长数值格
  因字节保真天然不受损，不再需要全簿精度预扫。
- 公式格（含 <f>）、合并区目标拒改（与既有写入口语义一致）。
- 一次改多格只重写一次目标部件；重复目标拒。

不做什么：不改共享字符串表（文本一律 inlineStr）；不处理需要剔包/批注提取的
首次清洗（那是上传/首改的重路径，清完才进手术快路径）。
"""
import re
import struct
import zipfile
import zlib
from io import BytesIO

PRECISION_LIMIT = 1e15

_COORD_RE = re.compile(r'^([A-Z]+)([1-9][0-9]*)$')
_ROW_SPLIT = b'</row>'


class SurgeryError(Exception):
    """手术改写被规则拒绝（值/坐标/结构保护）。调用方按 ValidationError 转给用户。"""


# ---------- 坐标 ----------

def col_to_num(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n


def num_to_col(n):
    s = ''
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def parse_coord(coord):
    m = _COORD_RE.match(coord or '')
    if not m:
        raise SurgeryError('坐标无效：' + str(coord))
    return col_to_num(m.group(1)), int(m.group(2))


# ---------- 值序列化 ----------

def _xml_escape(text):
    out = (text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
           .replace('"', '&quot;'))
    # XML 1.0 不允许的控制字符直接拒（保留会让整个部件不可解析）
    bad = [c for c in out if ord(c) < 0x20 and c not in '\t\n\r']
    if bad:
        raise SurgeryError('值里含不可打印控制字符，拒绝写入')
    return out


def _serialize_value(coord, typed, style_attr):
    """typed（与 cell_typed 同形状 {type, value}）→ 目标 <c> 节点 XML。"""
    vtype = str((typed or {}).get('type') or '')
    value = (typed or {}).get('value')
    head = 'r="%s"%s' % (coord, style_attr)
    if vtype == 'formula':
        formula = typed.get('formula')
        if not isinstance(formula, str) or not formula.startswith('='):
            raise SurgeryError('公式格式无效')
        if not isinstance(value, (str, int, float, bool, type(None))):
            raise SurgeryError('公式缓存必须是单值')
        if isinstance(value, float) and (value != value or value in (float('inf'), float('-inf'))):
            raise SurgeryError('公式缓存数值无效')
        kind = 'b' if isinstance(value, bool) else 'str' if isinstance(value, str) else 'n'
        cached = ('1' if value else '0') if isinstance(value, bool) else '' if value is None else str(value)
        return '<c %s t="%s"><f>%s</f><v>%s</v></c>' % (head, kind, _xml_escape(formula[1:]), _xml_escape(cached))
    if vtype == 'empty' or (vtype == 'text' and value in (None, '')):
        return '<c %s/>' % head
    if vtype == 'text':
        return '<c %s t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>' % (
            head, _xml_escape(str(value)))
    if vtype == 'number':
        if isinstance(value, bool) or value is None:
            raise SurgeryError('数值格不能是空/布尔')
        try:
            num = float(value) if isinstance(value, str) else value
        except (TypeError, ValueError):
            raise SurgeryError('数值无法解析：' + repr(value)[:40])
        if isinstance(num, float) and (num != num or num in (float('inf'), float('-inf'))):
            raise SurgeryError('数值无效（NaN/Inf）')
        if abs(num) >= PRECISION_LIMIT:
            raise SurgeryError('数值 ≥16 位有效数字，保存会损伤精度；请先把该列转为文本')
        if isinstance(num, float) and num == int(num) and abs(num) < 1e15:
            # 整数值的浮点写成整数形态，避免 .0 尾巴改变读回形状
            text = str(int(num))
        else:
            text = repr(num) if isinstance(num, float) else str(num)
        return '<c %s><v>%s</v></c>' % (head, text)
    if vtype == 'boolean':
        if not isinstance(value, bool):
            raise SurgeryError('布尔值无效')
        return '<c %s t="b"><v>%d</v></c>' % (head, 1 if value else 0)
    if vtype == 'date':
        # OOXML 原生 ISO 日期不依赖样式或 1900/1904 epoch；首次填写日期也不需
        # 整簿重写 styles.xml。原 s= 样式保持，日期值和显示格式分别负责。
        import datetime as _dt
        v = value
        if isinstance(v, str):
            try:
                v = _dt.datetime.fromisoformat(v) if 'T' in v else _dt.date.fromisoformat(v[:10])
            except ValueError:
                raise SurgeryError('日期无效：' + str(value)[:30])
        if not isinstance(v, (_dt.datetime, _dt.date)) or getattr(v, 'tzinfo', None):
            raise SurgeryError('日期无效：' + repr(value)[:30])
        return '<c %s t="d"><v>%s</v></c>' % (head, v.isoformat())
    raise SurgeryError('手术路径暂不支持该值类型：' + (vtype or '空'))


# ---------- sheet XML 手术 ----------

def _merged_ranges(sheet_xml):
    return re.findall(rb'<mergeCell\s+ref="([A-Z]+[0-9]+):([A-Z]+[0-9]+)"', sheet_xml)


def in_merge(col, row, ranges):
    """合并区内且不是左上角锚点 → 返回区间串（应拒）；锚点或区外 → None（可写）。
    与 sheet._check_merged 语义一致：仅左上角可编辑。"""
    for a, b in ranges:
        c1, r1 = parse_coord(a.decode())
        c2, r2 = parse_coord(b.decode())
        if min(r1, r2) <= row <= max(r1, r2) and min(c1, c2) <= col <= max(c1, c2):
            if not (row == min(r1, r2) and col == min(c1, c2)):
                return '%s:%s' % (a.decode(), b.decode())
    return None


_CELL_RE_TMPL = r'<c r="%s"(?:\s[^>]*?)?(?:/>|>.*?</c>)'


def _splice_row(row_xml, edits_in_row):
    """单遍替换已有节点；只把缺失坐标交给既有有序插入路径。"""
    pending = {coord.encode(): (col, coord, typed) for col, coord, typed in edits_in_row}
    chunks = []
    cursor = 0
    for match in _RE_C_BLOCK.finditer(row_xml):
        item = pending.pop(_coord_of_attrs(match.group(1) or b''), None)
        if item is None:
            continue
        _col, coord, typed = item
        old = match.group(0)
        if b'<f' in old and typed.get('type') != 'formula' and not typed.get('_replace_formula'):
            raise SurgeryError('该单元格为公式，不支持直接修改（%s）' % coord)
        sm = re.search(rb'\ss="([^"]+)"', old)
        style = (' s="%s"' % sm.group(1).decode()) if sm else ''
        chunks.extend((row_xml[cursor:match.start()], _serialize_value(coord, typed, style).encode()))
        cursor = match.end()
        if not pending:
            break
    chunks.append(row_xml[cursor:])
    out = b''.join(chunks)
    return _splice_row_missing(out, pending.values()) if pending else out


def _splice_row_missing(row_xml, edits_in_row):
    """一行内的格手术：替换已有 <c>（保样式，公式格拒），缺格按列序插入。"""
    out = row_xml
    for col, coord, typed in sorted(edits_in_row):
        pat = re.compile((_CELL_RE_TMPL % coord).encode(), re.DOTALL)
        m = pat.search(out)
        if m:
            old = m.group(0)
            if b'<f' in old and typed.get('type') != 'formula' and not typed.get('_replace_formula'):
                raise SurgeryError('该单元格为公式，不支持直接修改（%s）' % coord)
            sm = re.search(rb'\ss="([^"]+)"', old)
            style = (' s="%s"' % sm.group(1).decode()) if sm else ''
            new = _serialize_value(coord, typed, style).encode()
            out = out[:m.start()] + new + out[m.end():]
        else:
            new = _serialize_value(coord, typed, '').encode()
            # 行标签自闭合（<row .../> 整行无内容）：开标签、进格、补 </row>（split 时
            # 自闭合行没占分隔符，这里补的 </row> 是它自己那一个）。判定必须落在**行标签**
            # 上——行尾是自闭合格（<c .../>）时旧判定 endswith('/>') 会把格的 /> 剥掉当行，
            # 产出 </row></row> 双闭合（2026-10-13 示例企业真实表批注行实证，ZS-09）。
            gt = out.find(b'>')
            row_tag = out[:gt + 1] if gt != -1 else b''
            if row_tag.endswith(b'/>'):
                out = row_tag[:-2] + b'>' + new + b'</row>' + out[gt + 1:]
            else:
                # 插到行内第一个列号更大的格之前；都比它小就放行尾
                # （注意：按 </row> 切分的行片段不含 </row>，行尾=片段末尾）
                insert_at = None
                for cm in re.finditer(rb'<c r="([A-Z]+)([0-9]+)"', out):
                    ccol = col_to_num(cm.group(1).decode())
                    if ccol > col:
                        insert_at = cm.start()
                        break
                if insert_at is None:
                    insert_at = len(out)
                out = out[:insert_at] + new + out[insert_at:]
    return out


def splice_sheet_xml(sheet_xml, edits):
    """整张表的格手术。edits=[(coord, typed)]。返回新 sheet XML 字节。"""
    pairs = []
    seen = set()
    for coord, typed in edits:
        col, row = parse_coord(coord)
        if coord in seen:
            raise SurgeryError('重复目标：' + coord)
        seen.add(coord)
        pairs.append((row, col, coord, typed))
    ranges = _merged_ranges(sheet_xml)
    for row, col, coord, _t in pairs:
        hit = in_merge(col, row, ranges)
        if hit:
            raise SurgeryError('该单元格位于合并区域内，仅左上角可编辑（%s ⊂ %s）' % (coord, hit))

    by_row = {}
    for row, col, coord, typed in pairs:
        by_row.setdefault(row, []).append((col, coord, typed))

    parts = sheet_xml.split(_ROW_SPLIT)
    row_of = []
    for part in parts:
        i = part.rfind(b'<row')
        if i == -1:
            row_of.append(None)
            continue
        m = re.search(rb'<row\b[^>]*\br="([0-9]+)"', part[i:])
        row_of.append(int(m.group(1)) if m else None)

    out_parts = []
    for idx, part in enumerate(parts):
        r = row_of[idx]
        if r in by_row:
            seg = _splice_row(part[part.rfind(b'<row'):] if part.rfind(b'<row') != -1 else part,
                              by_row[r])
            head = part[:part.rfind(b'<row')] if part.rfind(b'<row') != -1 else b''
            out_parts.append(head + seg)
        else:
            out_parts.append(part)
    out = _ROW_SPLIT.join(out_parts)
    # A managed empty table may have no physical row 1 (openpyxl omits empty
    # cells). Appending its first header must materialize that row; the same
    # applies to empty gaps already represented by the managed fixed row IDs.
    for row in sorted(set(by_row) - {r for r in row_of if r is not None}):
        inner = ''.join(_serialize_value(coord, typed, '')
                        for col, coord, typed in sorted(by_row[row])).encode()
        addition = b'<row r="%d">' % row + inner + b'</row>'
        end = out.find(b'</sheetData>')
        if end < 0:
            empty = re.search(rb'<sheetData\b([^>]*?)/>', out)
            if not empty:
                raise SurgeryError('sheetData 段缺失，无法写入目标行')
            expanded = b'<sheetData' + empty.group(1) + b'></sheetData>'
            out = out[:empty.start()] + expanded + out[empty.end():]
            end = out.find(b'</sheetData>')
        later = next((m.start() for m in re.finditer(rb'<row\b[^>]*\br="(\d+)"', out)
                      if int(m.group(1)) > row), end)
        out = out[:later] + addition + out[later:]
    return out


# ---------- zip 条目级重打包（压缩字节直拷） ----------

def _eocd_and_central(data):
    """解析 EOCD 与中央目录，返回 (eocd_pos, cd_offset, cd_size, entries)。
    entry: dict(name, local_off, compress_size, crc, method, flags, ...)"""
    eocd = data.rfind(b'PK\x05\x06')
    if eocd == -1:
        raise SurgeryError('不是 zip 包（没有 EOCD）')
    (sig, disk, cd_disk, n_disk, n_total, cd_size, cd_off, clen) = struct.unpack(
        '<IHHHHIIH', data[eocd:eocd + 22])
    entries = []
    p = cd_off
    for _ in range(n_total):
        if data[p:p + 4] != b'PK\x01\x02':
            raise SurgeryError('中央目录损坏')
        (sig_, ver_made, ver_need, flags, method, mtime, mdate, crc, csize, usize,
         nlen, elen, clen_, disk_, iattr, eattr, loff) = struct.unpack('<IHHHHHHIIIHHHHHII',
                                                                      data[p:p + 46])
        name = data[p + 46:p + 46 + nlen]
        entries.append({'name': name, 'local_off': loff, 'compress_size': csize,
                        'usize': usize, 'crc': crc, 'method': method, 'flags': flags,
                        'mtime': mtime, 'mdate': mdate, 'eattr': eattr, 'nlen': nlen,
                        'elen': elen})
        p += 46 + nlen + elen + clen_
    return eocd, cd_off, cd_size, entries


def _local_spans(data, entries, cd_off):
    """按 local header 偏移排序求每个条目的 [起, 下一条起) 字节范围；末条到中央目录止。
    这样 local header + 压缩数据 + 可能的数据描述符全部原样拷贝，无需猜描述符长度。"""
    order = sorted(range(len(entries)), key=lambda i: entries[i]['local_off'])
    spans = {}
    for k, i in enumerate(order):
        ent = entries[i]
        loff = ent['local_off']
        if data[loff:loff + 4] != b'PK\x03\x04':
            raise SurgeryError('local header 损坏：' + repr(ent['name'][:40]))
        end = entries[order[k + 1]]['local_off'] if k + 1 < len(order) else cd_off
        if end < loff:
            raise SurgeryError('条目偏移乱序')
        spans[ent['name']] = (loff, end)
    return spans


def local_bytes(data):
    """每个条目的**原始本地字节**（local header + 压缩数据 [+ 描述符]）→ {name(bytes): bytes}。
    不解压、只切片 —— 用于核「非目标条目逐字节一致」（比 testzip 快且更强）。"""
    eocd, cd_off, cd_size, entries = _eocd_and_central(data)
    spans = _local_spans(data, entries, cd_off)
    return {name: data[a:b] for name, (a, b) in spans.items()}


def rebuild_zip(data, replacements, drops=None):
    """新包：replacements 里改写的条目重压，其余压缩字节直拷（不解压不重压）。
    replacements: {条目名(str/bytes): 新的未压缩字节}；drops: 要丢掉的条目名集合（剔包）。"""
    eocd, cd_off, cd_size, entries = _eocd_and_central(data)
    spans = _local_spans(data, entries, cd_off)
    replaced = {k.encode() if isinstance(k, str) else k: v for k, v in replacements.items()}
    drop_set = {(d.encode() if isinstance(d, str) else d) for d in (drops or ())}
    out = bytearray()
    new_cd = bytearray()
    kept = 0
    for ent in entries:
        name = ent['name']
        if name in drop_set:
            continue
        kept += 1
        src_loff = ent['local_off']
        lnlen, lelen = struct.unpack('<HH', data[src_loff + 26:src_loff + 30])
        name_bytes = data[src_loff + 30:src_loff + 30 + lnlen]
        extra_bytes = data[src_loff + 30 + lnlen:src_loff + 30 + lnlen + lelen]
        if name in replaced:
            new_raw = replaced[name]
            # L1 重压：只求快，不求最小。34MB 部件 L6=291ms/L1=80ms（2026-10-13 实测），
            # 产物大 ~1.4MB 但下载/解析按未压内容计，预算门槛不看压缩比。
            comp = zlib.compressobj(1, zlib.DEFLATED, -15)
            body = comp.compress(new_raw) + comp.flush()
            crc = zlib.crc32(new_raw) & 0xffffffff
            flags = ent['flags'] & ~0x8          # 新写数据带明确 crc/长度，去描述符位
            method = 8 if ent['method'] == 8 else ent['method'] or 8
            loff = len(out)
            out += struct.pack('<IHHHHHIIIHH', 0x04034b50, 20, flags, method,
                               ent['mtime'], ent['mdate'], crc, len(body), len(new_raw),
                               lnlen, lelen)
            out += name_bytes + extra_bytes + body
            new_cd += struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 20, 20, flags, method,
                                  ent['mtime'], ent['mdate'], crc, len(body), len(new_raw),
                                  lnlen, lelen, 0, 0, 0, ent['eattr'], loff)
            new_cd += name_bytes + extra_bytes
        else:
            a, b = spans[name]
            loff = len(out)
            out += data[a:b]
            new_cd += struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 20, 20, ent['flags'],
                                  ent['method'], ent['mtime'], ent['mdate'], ent['crc'],
                                  ent['compress_size'], ent['usize'], lnlen, lelen,
                                  0, 0, 0, ent['eattr'], loff)
            new_cd += name_bytes + extra_bytes
    cd_off_new = len(out)
    out += new_cd
    out += struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, kept, kept,
                       len(new_cd), cd_off_new, 0)
    return bytes(out)


# ---------- 对外入口 ----------

def sheet_part_by_title(data, title):
    """按工作表标题找 sheet XML 部件名（workbook.xml 的 r:id → rels 目标）。找不到返回 None。"""
    z = zipfile.ZipFile(BytesIO(data))
    try:
        wb_xml = z.read('xl/workbook.xml')
        rels = z.read('xl/_rels/workbook.xml.rels')
    except KeyError:
        return None
    rid = None
    for m in re.finditer(rb'<sheet\b[^>]*/?>', wb_xml):
        tag = m.group(0)
        nm = re.search(rb'name="([^"]*)"', tag)
        if not nm or _xml_unescape_attr(nm.group(1)) != title:
            continue
        rm = re.search(rb'r:id="([^"]+)"', tag)
        if rm:
            rid = rm.group(1)
            break
    if not rid:
        return None
    # rels 属性顺序不固定（Excel 写 Id→Target，openpyxl 重写成 Target→Id）——按 Relationship
    # 标签逐个看，同一标签里有 Id 就取它的 Target，顺序无关（2026-10-13 清洗后包实测踩坑）。
    target = None
    for m in re.finditer(rb'<Relationship\b[^>]*/?>', rels):
        tag = m.group(0)
        if not re.search(rb'Id="%s"' % re.escape(rid), tag):
            continue
        tm = re.search(rb'Target="([^"]+)"', tag)
        if tm:
            target = tm.group(1).decode()
        break
    if not target:
        return None
    if target.startswith('/'):
        return target.lstrip('/')
    return 'xl/' + target.lstrip('./')


def _xml_unescape_attr(raw):
    return (raw.decode('utf-8', 'replace')
            .replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"')
            .replace('&apos;', "'").replace('&amp;', '&'))


def read_sheet(data, sheet_part):
    z = zipfile.ZipFile(BytesIO(data))
    return z.read(sheet_part if isinstance(sheet_part, str) else sheet_part.decode())


def cell_node(sheet_xml, coord):
    """目标格的 <c> 节点字节；不存在返回 None。"""
    m = re.search((_CELL_RE_TMPL % coord).encode(), sheet_xml, re.DOTALL)
    return m.group(0) if m else None


def _coord_of_attrs(attrs):
    """从 `<c ...>` 的属性段里取 `r` 值（bytes）。**不用正则** ——
    34MB/76 万格里 `re.search` 每格一次要 ~380ms，bytes.find 只要几毫秒级。"""
    i = attrs.find(b'r="')
    if i < 0:
        return None
    j = attrs.find(b'"', i + 3)
    return attrs[i + 3:j] if j > i else None


def cell_nodes(sheet_xml, coords):
    """**单遍**收集多个坐标的 `<c>` 节点 → {coord: node_bytes}。

    ⚠️ 批量写（2 万格）**不能逐格 `cell_node`** —— 那是 2 万次全文扫描（O(n×m)）。
    这里单遍扫描、命中齐了即停；坐标取属性用 `_coord_of_attrs`（bytes.find，不走正则）。
    """
    need = {(c.encode() if isinstance(c, str) else c) for c in (coords or ())}
    if not need:
        return {}
    seen = {}
    for m in _RE_C_BLOCK.finditer(sheet_xml):
        key = _coord_of_attrs(m.group(1) or b'')
        if key in need and key not in seen:
            seen[key] = m.group(0)
            if len(seen) == len(need):
                break
    return {(k.decode() if isinstance(k, bytes) else k): v for k, v in seen.items()}


def _verify_edit_nodes(check_xml, edits):
    """自检：每个目标格在新部件里就位且类型对（防静默没改还报成功）。

    单遍扫描收集目标坐标，再逐格判类型——判据与旧「每格一次全文 re.search」一字不差
    （缺格/文本非 inlineStr/数值无 <v> 同样报 SurgeryError），快在只扫一遍部件：
    2 万格在 34MB 部件上本机 1371ms → 29ms（2026-10-13 分段计时定位：serialize 的 52%
    就花在这自检上）。语义等价由 test_zip_surgery 的 ZS-10 对照旧判据逐例钉死。
    """
    if not edits:
        return
    need = {}
    for coord, typed in edits:
        need[coord] = typed
    seen = {}
    for m in _RE_C_BLOCK.finditer(check_xml):
        attrs = m.group(1) or b''
        rm = re.search(rb'\sr="([A-Z]+[0-9]+)"', attrs)
        if not rm:
            continue
        key = rm.group(1).decode()
        if key in need and key not in seen:
            seen[key] = m.group(0)
            if len(seen) == len(need):
                break
    for coord, typed in edits:
        node = seen.get(coord)
        if node is None:
            raise SurgeryError('手术自检失败：目标格不在新部件里（%s）' % coord)
        vtype = str((typed or {}).get('type') or '')
        if vtype == 'text' and (typed or {}).get('value') not in (None, ''):
            if b't="inlineStr"' not in node:
                raise SurgeryError('手术自检失败：目标格不是新文本（%s）' % coord)
        elif vtype == 'number':
            if b'<v>' not in node:
                raise SurgeryError('手术自检失败：目标格不是新数值（%s）' % coord)


def edit_cells(data, sheet_path, edits, verify=True, expand=False, source_xml=None):
    """在 data（xlsx 字节）上定点改 sheet_path 工作表的格。edits=[(coord, typed)]。

    `verify=False`：**调用方紧接着自己做更强的验证**时用（快路径 `_verify_surgery`
    会重开新包、逐格精确比对 + expat 良构校验）。默认 True，自检一遍防静默没改。
    """
    if isinstance(sheet_path, str):
        sheet_path = sheet_path.encode()
    try:
        z = zipfile.ZipFile(BytesIO(data))
        names = set(z.namelist())
    except zipfile.BadZipFile as e:
        raise SurgeryError('不是有效 zip：' + str(e))
    sp = sheet_path.decode() if isinstance(sheet_path, bytes) else sheet_path
    if sp not in names:
        raise SurgeryError('工作表部件不存在：' + sp)
    if not edits:
        return data
    # Internal checked-plan callers reuse XML already read from this exact content version.
    sheet_xml = z.read(sp) if source_xml is None else source_xml
    new_xml = splice_sheet_xml(sheet_xml, edits)
    if expand:
        new_xml = _append_dimension(new_xml, [])
    out = rebuild_zip(data, {sheet_path: new_xml})
    # 自检：包仍可开、CRC 过、每个目标格在新部件里就位（防静默没改还报成功）
    z2 = zipfile.ZipFile(BytesIO(out))
    if verify:
        # `testzip()` 会解压整包核 CRC（9.7MB）。`verify=False` 的调用方
        # （`_verify_surgery`）只读被改部件（read 自带 CRC 校验）+ 逐条比中央目录
        # CRC/大小，其余条目是压缩字节直拷 —— 不重复整包解压。
        if z2.testzip() is not None:
            raise SurgeryError('手术后包损坏（CRC 不过）')
        check_xml = z2.read(sp)
        _verify_edit_nodes(check_xml, edits)
    return out


def _append_dimension(sheet_xml, rows):
    """Expand the declared range without reserializing old cells/styles/namespaces."""
    coords = [parse_coord(m.group(1).decode()) for m in
              re.finditer(rb'<c\b[^>]*\br=[\'"]([A-Z]+[1-9][0-9]*)[\'"]', sheet_xml)]
    physical_rows = [int(m.group(1)) for m in
                     re.finditer(rb'<row\b[^>]*\br=[\'"]([1-9][0-9]*)[\'"]', sheet_xml)]
    if len(set(physical_rows)) != len(physical_rows) or len(set(coords)) != len(coords):
        raise SurgeryError('工作表已有重复行或单元格坐标，未追加；请先核对原文件')
    previous = max(physical_rows + [row for _col, row in coords] + [0])
    targets = []
    for row_index, cells in rows:
        if type(row_index) is not int or not previous < row_index <= 1048576:
            raise SurgeryError('追加行必须按顺序位于所有已有行之后，且不能重复')
        previous = row_index
        columns = [col for col, _typed in cells]
        if (any(type(col) is not int or not 1 <= col <= 16384 for col in columns)
                or len(set(columns)) != len(columns)):
            raise SurgeryError('追加行的列坐标无效或重复')
        targets.extend((col, row_index) for col in columns)
        if not columns:
            targets.append((1, row_index))
    dimension = re.search(rb'<dimension\b[^>]*/?>', sheet_xml)
    bounds = coords + targets
    if dimension:
        ref = re.search(rb'\bref=[\'"]([^\'"]+)[\'"]', dimension.group())
        if ref:
            bounds.extend(parse_coord(c.decode()) for c in ref.group(1).split(b':'))
    if not bounds:
        return sheet_xml
    lo_col, hi_col = min(c for c, _r in bounds), max(c for c, _r in bounds)
    lo_row, hi_row = min(r for _c, r in bounds), max(r for _c, r in bounds)
    ref = _coord(lo_col, lo_row) + ':' + _coord(hi_col, hi_row)
    if dimension:
        tag = dimension.group()
        if re.search(rb'\bref=[\'"][^\'"]+[\'"]', tag):
            tag = re.sub(rb'\bref=[\'"][^\'"]+[\'"]', b'ref="' + ref.encode() + b'"', tag, count=1)
        else:
            raise SurgeryError('工作表 dimension 缺少范围，未追加')
        return sheet_xml[:dimension.start()] + tag + sheet_xml[dimension.end():]
    # OOXML order: after sheetPr, before views/format/cols/data.
    following = re.search(rb'<(?:sheetViews|sheetFormatPr|cols|sheetData)\b', sheet_xml)
    if not following:
        raise SurgeryError('工作表缺少数据段，未追加')
    return (sheet_xml[:following.start()] + b'<dimension ref="' + ref.encode() + b'"/>'
            + sheet_xml[following.start():])


#: **带区域引用的标签** —— 大表「插行手术」的**红线清单**（2026-10-27）。
#: 这些标签里的引用**跟着行号走** ⇒ 坐标一挪，它们**必须跟着改**，
#: 而手术层**改不了**它们（公式的引用写在文本里；合并区/条件格式/数据验证/筛选的 ref
#: 要按新范围重算）⇒ 未实现的引用明确拒绝，不回落整簿保存。
#: 实测（2026-10-27）：「示例企业总表」这张 15,502 行的大表**一个都没有** ⇒ 走手术。
_INSERT_UNSUPPORTED_TAGS = (
    (b'<f', '公式'),
    (b'<conditionalFormatting', '条件格式'),
    (b'<dataValidation', '数据验证'),
    (b'<autoFilter', '自动筛选'),
    (b'<hyperlinks', '超链接'),
    (b'<tableParts', 'Excel 表对象'),
)


def insert_rows(data, sheet_path, xlsx_pos, count=1):
    """在物理第 `xlsx_pos` 行**之前**插入 `count` 个空行（手术，不整本重写）。

    整块合并区域跟随坐标移动；拆开合并区或未实现的区域引用明确拒绝。
    其它 ZIP 部件保持压缩字节原样，不整簿对象化或回落旧保存。
    """
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        raise SurgeryError('插入行数须为正整数')
    if isinstance(xlsx_pos, bool) or not isinstance(xlsx_pos, int) or xlsx_pos < 2:
        raise SurgeryError('插入位置须在数据行范围内')
    if isinstance(sheet_path, str):
        sheet_path = sheet_path.encode()
    sp = sheet_path.decode() if isinstance(sheet_path, bytes) else sheet_path
    try:
        z = zipfile.ZipFile(BytesIO(data))
    except zipfile.BadZipError as e:
        raise SurgeryError('不是有效 zip：' + str(e))
    if sp not in set(z.namelist()):
        raise SurgeryError('工作表部件不存在：' + sp)
    sheet_xml = z.read(sp)
    if b'<definedName ' in z.read('xl/workbook.xml'):
        raise SurgeryError('插行涉及命名区域，请先显式迁移；本次未保存')
    for tag, label in _INSERT_UNSUPPORTED_TAGS:
        if tag in sheet_xml:
            raise SurgeryError('插行涉及尚未支持的' + label + '引用，请先显式迁移；本次未保存')
    # 移动整块合并区与原结构规则一致；在合并区内部插入会拆开区间，必须零写拒绝。
    def shift_merge(match):
        left, top = parse_coord(match.group(1).decode())
        right, bottom = parse_coord(match.group(2).decode())
        if top < xlsx_pos <= bottom:
            raise SurgeryError('插入会拆开合并单元格，请先取消该合并')
        if top >= xlsx_pos:
            return re.sub(rb'ref="[^"]+"', b'ref="'+_coord(left,top+count).encode()+b':'+
                          _coord(right,bottom+count).encode()+b'"',match.group(0),count=1)
        return match.group(0)
    sheet_xml = re.sub(rb'<mergeCell\s+ref="([A-Z]+[0-9]+):([A-Z]+[0-9]+)"[^>]*/>', shift_merge, sheet_xml)
    physical = [int(m.group(1)) for m in re.finditer(rb'<row\b[^>]*\br="(\d+)"', sheet_xml)]
    if max(physical + [xlsx_pos - 1]) + count > 1048576:
        raise SurgeryError('插入后超过 Excel 行数上限')
    # ---------- ① 坐标后移：从 xlsx_pos 开始的行/格 +count ----------
    def _bump_row(match):
        number = int(match.group(2))
        if number >= xlsx_pos:
            return match.group(1) + str(number + count).encode() + match.group(3)
        return match.group(0)

    def _bump_cell(match):
        # 模式：(<c ... r="A)(数字)(") ⇒ **2＝行号、3＝收尾引号**
        number = int(match.group(2))
        if number >= xlsx_pos:
            return match.group(1) + str(number + count).encode() + match.group(3)
        return match.group(0)

    sheet_xml = re.sub(rb'(<row\b[^>]*\br=")(\d+)(")', _bump_row, sheet_xml)
    sheet_xml = re.sub(rb'(<c\b[^>]*\br="[A-Z]{1,3})(\d+)(")', _bump_cell, sheet_xml)
    # ---------- ② 插入新行（钉空格，同 append_rows 的钉法） ----------
    chunk = b''
    for index in range(count):
        row_index = xlsx_pos + index
        inner = _serialize_value(_coord(1, row_index), {'type': 'text', 'value': ' '}, '')
        chunk += ('<row r="%d">%s</row>' % (row_index, inner)).encode()
    position = None
    for match in re.finditer(rb'<row\b[^>]*\br="(\d+)"', sheet_xml):
        if int(match.group(1)) >= xlsx_pos + count:
            position = match.start()
            break
    if position is None:
        position = sheet_xml.rfind(b'</sheetData>')
        if position == -1:
            raise SurgeryError('sheetData 段缺失，无法插入行')
    new_xml = sheet_xml[:position] + chunk + sheet_xml[position:]
    # ---------- ③ 维度声明跟着长（不更新 ⇒ Excel 显示范围不对） ----------
    dimension = re.search(rb'<dimension\b[^>]*/?>', new_xml)
    if dimension:
        ref = re.search(rb'\bref=["\']([^"\']+)["\']', dimension.group())
        if ref:
            parts = ref.group(1).split(b':')
            if len(parts) in (1, 2):
                lo_col, lo_row = parse_coord(parts[0].decode())
                hi_col, hi_row = parse_coord(parts[-1].decode())
                hi_row = max(hi_row + count if hi_row >= xlsx_pos else hi_row, xlsx_pos + count - 1)
                new_ref = _coord(lo_col, lo_row) + ':' + _coord(hi_col, hi_row)
                tag = re.sub(rb'\bref=["\'][^"\']+["\']', b'ref="' + new_ref.encode() + b'"',
                             dimension.group(), count=1)
                new_xml = new_xml[:dimension.start()] + tag + new_xml[dimension.end():]
    # ---------- ④ 写回 ＋ 自检 ----------
    out = rebuild_zip(data, {sheet_path: new_xml})
    check = zipfile.ZipFile(BytesIO(out))
    if check.testzip() is not None:
        raise SurgeryError('手术后包损坏（CRC 不过）')
    check_xml = check.read(sp)
    for index in range(count):
        coord = _coord(1, xlsx_pos + index)
        pattern = (_CELL_RE_TMPL % coord).encode()
        if not re.search(pattern, check_xml, re.DOTALL):
            raise SurgeryError('手术自检失败：新行格不在部件里（%s）' % coord)
    seen = [int(match.group(1)) for match in
            re.finditer(rb'<row\b[^>]*\br="(\d+)"', check_xml)]
    if len(set(seen)) != len(seen):
        raise SurgeryError('手术自检失败：行坐标重复（插行后坐标没后移干净）')
    return out


def _column_xml(data, sheet_path, index, delta, source_xml=None):
    """移动列坐标和列尺寸区间，保留格内容 XML；不处理未声明的区域语义。"""
    if type(index) is not int or not 1 <= index <= 16384 or delta not in (-1, 1):
        raise SurgeryError('列位置无效')
    source = source_xml if source_xml is not None else read_sheet(data, sheet_path)
    with zipfile.ZipFile(BytesIO(data)) as archive:
        if b'<definedName ' in archive.read('xl/workbook.xml'):
            raise SurgeryError('插删列涉及命名区域，请先显式迁移；本次未保存')
    for tag,label in _INSERT_UNSUPPORTED_TAGS:
        if tag in source:
            raise SurgeryError('插删列涉及尚未支持的'+label+'引用，请先显式迁移；本次未保存')
    def coordinate(col):
        value=col + delta if col >= index else col
        if not 1 <= value <= 16384:
            raise SurgeryError('插删列后超过 Excel 列数边界')
        return value
    def merge(match):
        left,top=parse_coord(match.group(1).decode());right,bottom=parse_coord(match.group(2).decode())
        if (delta==1 and left<index<=right) or (delta==-1 and left<=index<=right):
            raise SurgeryError('插删列会拆开合并单元格，请先取消该合并')
        return re.sub(rb'ref="[^"]+"',b'ref="'+_coord(coordinate(left),top).encode()+b':'+
                      _coord(coordinate(right),bottom).encode()+b'"',match.group(),count=1)
    changed=re.sub(rb'<mergeCell\s+ref="([A-Z]+[0-9]+):([A-Z]+[0-9]+)"[^>]*/>',merge,source)
    def cell(match):
        old=match.group();coord=_coord_of_attrs(match.group(1) or b'')
        if not coord:return old
        col,row=parse_coord(coord.decode())
        if delta==-1 and col==index:return b''
        new=_coord(coordinate(col),row).encode()
        return re.sub(rb'(\br=")[^"]+("\s?)',lambda m:m.group(1)+new+m.group(2),old,count=1)
    changed=_RE_C_BLOCK.sub(cell,changed)
    def dimensions(match):
        tag=match.group();lo=re.search(rb'\bmin="(\d+)"',tag);hi=re.search(rb'\bmax="(\d+)"',tag)
        if not lo or not hi:raise SurgeryError('列尺寸范围无法识别')
        start,end=int(lo.group(1)),int(hi.group(1));spans=[]
        if end<index:spans=[(start,end)]
        elif start>index or (start==index and delta==1):spans=[(coordinate(start),coordinate(end))]
        else:
            if start<index:spans.append((start,index-1))
            right=index if delta==1 else index+1
            if right<=end:spans.append((coordinate(right),coordinate(end)))
        return b''.join(re.sub(rb'\bmax="\d+"',b'max="'+str(end).encode()+b'"',
            re.sub(rb'\bmin="\d+"',b'min="'+str(start).encode()+b'"',tag)) for start,end in spans)
    changed=re.sub(rb'<col\b[^>]*/>',dimensions,changed)
    # spans 只是读取优化提示，不承载内容；按同一列位移更新，不改行高或隐藏属性。
    def spans(match):
        lo,hi=int(match.group(1)),int(match.group(2))
        if delta==-1 and lo==hi==index:return b''
        return b' spans="'+str(coordinate(lo) if lo!=index or delta==1 else index).encode()+b':'+str(max(1,hi+delta) if hi>=index else hi).encode()+b'"'
    changed=re.sub(rb'\s+spans="(\d+):(\d+)"',spans,changed)
    def dimension(match):
        refs=match.group(1).split(b':');left,top=parse_coord(refs[0].decode());right,bottom=parse_coord(refs[-1].decode())
        right=min(16384,max(index,right+1)) if delta==1 else max(1,right-1 if right>=index else right)
        left=min(left,right)
        return b'<dimension ref="'+_coord(left,top).encode()+b':'+_coord(right,bottom).encode()+b'"/>'
    changed=re.sub(rb'<dimension\b[^>]*\bref="([^"]+)"[^>]*/>',dimension,changed)
    return changed


def insert_column(data, sheet_path, index, header, source_xml=None):
    if not isinstance(header,str) or not header.strip():
        raise SurgeryError('新列表头不能为空')
    changed=_column_xml(data,sheet_path,index,1,source_xml)
    changed=splice_sheet_xml(changed,[(_coord(index,1),{'type':'text','value':header})])
    return rebuild_zip(data,{sheet_path:changed})


def remove_column(data, sheet_path, index, source_xml=None):
    """只供明确已验证的目标删除；业务层负责值、引用及受管字段保护。"""
    return rebuild_zip(data,{sheet_path:_column_xml(data,sheet_path,index,-1,source_xml)})


def column_format_signature(sheet_xml, index):
    """列逆操作只核本列格式；格值和其它列格式变化不参与这个指纹。"""
    import hashlib,json
    dimensions=[];styles=[]
    for match in re.finditer(rb'<col\b[^>]*/>',sheet_xml):
        tag=match.group();lo=re.search(rb'\bmin="(\d+)"',tag);hi=re.search(rb'\bmax="(\d+)"',tag)
        if lo and hi and int(lo.group(1))<=index<=int(hi.group(1)):
            dimensions.append(sorted((key.decode(),value.decode()) for key,value in
                re.findall(rb'([A-Za-z_:]+)="([^"]*)"',tag) if key not in (b'min',b'max')))
    target=rb'<c\b[^>]*\br="'+num_to_col(index).encode()+rb'(\d+)"[^>]*>'
    for match in re.finditer(target,sheet_xml):
        style=re.search(rb'\bs="([^"]+)"',match.group())
        if style and style.group(1)!=b'0':styles.append((int(match.group(1)),style.group(1).decode()))
    return hashlib.sha256(json.dumps([dimensions,styles],sort_keys=True).encode()).hexdigest()


def rows_hidden(sheet_xml, row_numbers):
    """读取有限目标行的共享物理隐藏标记，不碰值或个人视图。"""
    wanted = set(row_numbers)
    result = {number: False for number in wanted}
    for match in re.finditer(rb'<row\b[^>]*>', sheet_xml):
        number = re.search(rb'\br="(\d+)"', match.group())
        if number and int(number.group(1)) in wanted:
            result[int(number.group(1))] = bool(re.search(rb'\bhidden="(?:1|true)"', match.group()))
    return result


def set_rows_hidden(data, sheet_path, hidden, source_xml=None):
    """软删／恢复只改目标行 hidden；其余格、行高、格式、ZIP 部件原样保留。"""
    if not hidden or any(type(row) is not int or not 2 <= row <= 1048576 or type(value) is not bool
                         for row, value in hidden.items()):
        raise SurgeryError('行隐藏参数无效')
    xml = source_xml if source_xml is not None else read_sheet(data, sheet_path)
    pending = dict(hidden)
    def replace(match):
        tag = match.group()
        number = re.search(rb'\br="(\d+)"', tag)
        if not number or int(number.group(1)) not in pending:
            return tag
        value = pending.pop(int(number.group(1)))
        tag = re.sub(rb'\s+hidden="[^"]*"', b'', tag)
        if value:
            end = -2 if tag.endswith(b'/>') else -1
            tag = tag[:end] + b' hidden="1"' + tag[end:]
        return tag
    changed = re.sub(rb'<row\b[^>]*>', replace, xml)
    for number, value in sorted(pending.items()):
        if not value:
            continue  # 未实体化的空行本来就没有隐藏标记。
        end = changed.find(b'</sheetData>')
        if end < 0:
            raise SurgeryError('工作表数据段不存在')
        position = next((m.start() for m in re.finditer(rb'<row\b[^>]*\br="(\d+)"', changed)
                         if int(m.group(1)) > number), end)
        changed = changed[:position] + ('<row r="%d" hidden="1"/>' % number).encode() + changed[position:]
    import xml.parsers.expat
    try:
        xml.parsers.expat.ParserCreate().Parse(changed, True)
    except Exception as error:
        raise SurgeryError('隐藏行后 XML 无法解析：' + str(error))
    if rows_hidden(changed, hidden) != hidden:
        raise SurgeryError('行隐藏结果核验失败')
    return rebuild_zip(data, {sheet_path: changed})


def append_rows(data, sheet_path, rows):
    """末尾追加数据行（手术）。rows=[(row_index, [(col, typed)])]，插在 </sheetData> 前。
    未动部件逐字节保真；自检：包可开 + 每个新行的格在场。row_index 必须是现有最大行之后。"""
    if isinstance(sheet_path, str):
        sheet_path = sheet_path.encode()
    sp = sheet_path.decode() if isinstance(sheet_path, bytes) else sheet_path
    try:
        z = zipfile.ZipFile(BytesIO(data))
        names = set(z.namelist())
    except zipfile.BadZipFile as e:
        raise SurgeryError('不是有效 zip：' + str(e))
    if sp not in names:
        raise SurgeryError('工作表部件不存在：' + sp)
    if not rows:
        return data
    sheet_xml = z.read(sp)
    # Validate against physical rows, not the possibly stale declared dimension.
    sheet_xml = _append_dimension(sheet_xml, rows)
    add = []
    for row_index, cells in rows:
        inner = ''.join(_serialize_value(_coord(col, row_index), typed, '')
                        for col, typed in cells)
        add.append('<row r="%d">%s</row>' % (row_index, inner))
    chunk = ''.join(add).encode()
    idx = sheet_xml.rfind(b'</sheetData>')
    if idx == -1:
        raise SurgeryError('sheetData 段缺失，无法追加行')
    new_xml = sheet_xml[:idx] + chunk + sheet_xml[idx:]
    out = rebuild_zip(data, {sheet_path: new_xml})
    z2 = zipfile.ZipFile(BytesIO(out))
    if z2.testzip() is not None:
        raise SurgeryError('手术后包损坏（CRC 不过）')
    check_xml = z2.read(sp)
    for row_index, cells in rows:
        for col, _typed in cells:
            coord = _coord(col, row_index)
            pat = (_CELL_RE_TMPL % coord).encode()
            if not re.search(pat, check_xml, re.DOTALL):
                raise SurgeryError('手术自检失败：新行格不在部件里（%s）' % coord)
    return out


def _coord(col, row):
    """(列号,行号) → Excel 坐标（1,1)=A1。"""
    s = ''
    n = int(col)
    while n > 0:
        n, rem = divmod(n - 1, 26)
        s = chr(65 + rem) + s
    return '%s%d' % (s, row)


# ---------- 首次清洗字节手术（R1-08 上传→可编辑首屏，2026-10-13） ----------
#
# 为什么：分段计时坐实 openpyxl 整簿往返占清洗 92%（load 5.1s + 固化取缓存值二次
# load 5.2s + save 5.4s），上传 P95 17.3s 穿 15s 预算。手术路线：剔包/固化/批注进
# 备注都在 zip/部件字节上做，未改条目压缩字节直拷（保真证明同 R1）。
# 语义与 sheet.py 的 openpyxl 清洗一字不变；守不住的边界抛 NeedFallback 回落慢路径。

class NeedFallback(Exception):
    """清洗边界（留原处批注/既有备注值非文本/共享公式失联等）——调用方回落 openpyxl。"""


_RE_C_BLOCK = re.compile(rb'<c\b([^>]*?)(?:/>|>(.*?)</c>)', re.S)
_RE_F = re.compile(rb'<f\b([^>]*?)(?:/>|>(.*?)</f>)', re.S)
_RE_V = re.compile(rb'<v>(.*?)</v>', re.S)
_RE_IS = re.compile(rb'<is>(.*?)</is>', re.S)
_RE_T_TEXT = re.compile(rb'<t[^>]*>([^<]*)</t>', re.S)
_RE_REL = re.compile(rb'<Relationship\b[^>]*/?>')
_NUM_RE = re.compile(r'^-?\d+(\.\d+)?([eE][+-]?\d+)?$')


def _xml_unescape_text(raw):
    import html
    return html.unescape((raw or b'').decode('utf-8', 'ignore') if isinstance(raw, bytes) else (raw or ''))


def _sst_texts(data):
    """sharedStrings：下标 → 文本（<si> 内所有 <t> 拼接）。没有则空表。"""
    z = zipfile.ZipFile(BytesIO(data))
    if 'xl/sharedStrings.xml' not in z.namelist():
        return []
    xml = z.read('xl/sharedStrings.xml').decode('utf-8', 'ignore')
    out = []
    for si in re.findall(r'<si>(.*?)</si>', xml, re.S):
        out.append(_xml_unescape_text(''.join(re.findall(r'<t[^>]*>([^<]*)</t>', si)).encode()))
    return out


def _cell_value_text(inner, attrs, sst):
    """格值读成 (kind, text)：kind ∈ empty/text/other。text 只对 text 给出。"""
    tm = re.search(rb'\st="([^"]+)"', attrs or b'')
    t = tm.group(1).decode() if tm else ''
    if t == 'inlineStr':
        im = _RE_IS.search(inner or b'')
        text = _xml_unescape_text(''.join(
            m.decode('utf-8', 'ignore') for m in _RE_T_TEXT.findall(im.group(1))).encode()) if im else ''
        return ('text', text) if text else ('empty', None)
    vm = _RE_V.search(inner or b'')
    if not vm:
        return ('empty', None)
    raw = vm.group(1)
    if t == 's':
        try:
            text = sst[int(raw.decode('utf-8', 'ignore'))]
        except Exception:
            return ('other', None)
        return ('text', text) if text else ('empty', None)
    if t in ('str', 'e', 'd'):
        text = _xml_unescape_text(raw)
        return ('text', text) if text else ('empty', None)
    return ('other', None)   # 数值/布尔：备注拼接要 datetime 格式化，回落慢路径


def _sheet_extent(sheet_xml):
    """真实数据范围（与 sheet._data_extent 同口径）：有值格算行列；无值无样式格算行。"""
    max_r, max_c = 1, 1
    for m in _RE_C_BLOCK.finditer(sheet_xml):
        attrs, inner = m.group(1), m.group(2)
        rm = re.search(rb'\sr="([A-Z]+)([0-9]+)"', attrs or b'')
        if not rm:
            continue
        col, row = col_to_num(rm.group(1).decode()), int(rm.group(2))
        has_val = bool(inner) and (b'<v' in inner or b'<f' in inner or b'<is' in inner)
        has_style = b' s="' in (attrs or b'') or b" s='" in (attrs or b'')
        if not has_val and has_style:
            continue
        if row > max_r:
            max_r = row
        if has_val and col > max_c:
            # 空文本 <is><t></t></is>/<v></v> 不撑列
            kind, text = _cell_value_text(inner, attrs, sst=[])
            if kind == 'text' and not text:
                pass
            elif kind == 'empty' and not (b'<f' in inner):
                pass
            else:
                if col > max_c:
                    max_c = col
    return max_r, max_c


def _row1_values(sheet_xml, sst):
    """表头行（第 1 行）格值：{列号: 文本或 None}。"""
    out = {}
    for m in _RE_C_BLOCK.finditer(sheet_xml):
        attrs, inner = m.group(1), m.group(2)
        rm = re.search(rb'\sr="([A-Z]+)([0-9]+)"', attrs or b'')
        if not rm or int(rm.group(2)) != 1:
            continue
        col = col_to_num(rm.group(1).decode())
        kind, text = _cell_value_text(inner, attrs, sst)
        out[col] = text if kind == 'text' else ('' if kind == 'empty' else None)
    return out


def _freeze_formulas(sheet_xml, is_external_formula):
    """外链公式固化（与 sheet._freeze_external_formulas 同语义）：外链公式格去掉
    <f>，留缓存值；无缓存值固化成公式原文文本；≥1e15 数值缓存转文本逐位保住。
    返回 (新 XML, 固化格数)。共享公式从母格取公式文判外链；子格无缓存值 → 抛回落。"""
    masters = {}
    for m in _RE_F.finditer(sheet_xml):
        attrs, body = m.group(1), m.group(2)
        if body is None:
            continue
        sm = re.search(rb'\ssi="(\d+)"', attrs or b'')
        if sm and b't="shared"' in (attrs or b''):
            masters[sm.group(1).decode()] = body

    out = []
    last = 0
    frozen = 0
    for m in _RE_C_BLOCK.finditer(sheet_xml):
        attrs, inner = m.group(1), m.group(2)
        if not inner or b'<f' not in inner:
            continue
        fm = _RE_F.search(inner)
        if not fm:
            continue
        f_attrs, f_body = fm.group(1), fm.group(2)
        if f_body is None:
            sm = re.search(rb'\ssi="(\d+)"', f_attrs or b'')
            f_body = masters.get(sm.group(1).decode()) if sm else None
            if f_body is None:
                raise NeedFallback('shared-formula-orphan')
        formula_text = _xml_unescape_text(f_body)
        if not is_external_formula('=' + formula_text):
            continue
        rm = re.search(rb'\sr="([A-Z0-9]+)"', attrs or b'')
        if not rm:
            raise NeedFallback('cell-without-coord')
        coord = rm.group(1).decode()
        stm = re.search(rb'\ss="([^"]+)"', attrs)
        style = (' s="%s"' % stm.group(1).decode()) if stm else ''
        vm = _RE_V.search(inner)
        tm = re.search(rb'\st="([^"]+)"', attrs)
        t = tm.group(1).decode() if tm else ''
        cached_raw = vm.group(1) if vm is not None else None
        if cached_raw is None or not cached_raw.strip():
            # 无缓存值（含 openpyxl 垫的空 <v></v>）：固化成公式原文文本——数虽没有、线索不丢
            new_block = _serialize_value(coord, {'type': 'text', 'value': '=' + formula_text}, style).encode()
        elif t in ('str', 'e'):
            new_block = _serialize_value(coord, {'type': 'text', 'value': _xml_unescape_text(vm.group(1))}, style).encode()
        elif t == 'b' or t == 'd':
            new_block = inner_replace_f(inner, fm).join([b'<c' + attrs + b'>', b'</c>'])
        else:
            raw_num = _xml_unescape_text(vm.group(1))
            if _NUM_RE.match(raw_num) and abs(float(raw_num)) >= PRECISION_LIMIT:
                new_block = _serialize_value(coord, {'type': 'text', 'value': raw_num}, style).encode()
            else:
                new_block = b'<c' + attrs + b'>' + inner_replace_f(inner, fm) + b'</c>'
        out.append(sheet_xml[last:m.start()])
        out.append(new_block)
        last = m.end()
        frozen += 1
    out.append(sheet_xml[last:])
    return b''.join(out), frozen


def inner_replace_f(inner, fm):
    """从格内容里摘掉 <f> 元素（含共享子格自闭形态），其余原样。"""
    return inner[:fm.start()] + inner[fm.end():]


def _plan_remark(sheet_xml, sst, sheet_comments, fmt_remark_value):
    """批注进「备注」列规划（与 sheet._extract_comments 同规则）。返回 edits 列表
    [(coord, typed)]（供 splice_sheet_xml）与 (extracted, added, kept, lost)。
    kept>0 或既有备注值非文本 → 抛 NeedFallback（回落慢路径保语义）。"""
    if not sheet_comments:
        return [], (0, False, 0, 0)
    ranges = _merged_ranges(sheet_xml)
    max_r, max_c = _sheet_extent(sheet_xml)
    row1 = _row1_values(sheet_xml, sst)
    # 批注行+落点行建一次行索引，查格只在行片段里做（全文查找是 12.8s 热点，见 _row_fragments）
    frags = _row_fragments(sheet_xml, {r for (r, _c) in sheet_comments} | {1, 2})
    remark_cols = [col for col in sorted(row1, reverse=True)
                   if row1.get(col) is not None and str(row1[col]).strip() == '备注']
    remark_col = remark_cols[0] if remark_cols else None
    hdr_max = max([col for col, v in row1.items() if v not in (None, '')] or [0])

    kept = lost = 0
    placed = {}
    for (r, col) in sorted(sheet_comments):
        text = (sheet_comments[(r, col)] or '').strip()
        xml_only = bool(in_merge(col, r, ranges))   # 合并区非锚点 = openpyxl 载入即弃
        if not text:
            if xml_only:
                lost += 1
            else:
                kept += 1
            continue
        if 2 <= r <= max_r:
            row_no = r
        elif r < 2:
            row_no = 2 if max_r >= 2 else None
        else:
            row_no = None
        if row_no is None:
            if xml_only:
                lost += 1
            else:
                kept += 1
            continue
        placed.setdefault(row_no, []).append(((r, col), text))
    if kept:
        raise NeedFallback('comment-kept-in-place')
    if not placed:
        return [], (0, False, 0, lost)

    edits = []
    added = False
    if remark_col is None:
        cand = max(hdr_max, max_c) + 1
        if cand > 16384 or in_merge(cand, 1, ranges):
            raise NeedFallback('remark-head-unplaceable')
        edits.append((_coord(cand, 1), {'type': 'text', 'value': '备注'}))
        remark_col = cand
        added = True   # 主表加列才涨结构版本；清洗只处理工作簿首表时由调用方按首表判断
    extracted = 0
    for row_no in sorted(placed):
        items = placed[row_no]
        tgt_coord = _coord(remark_col, row_no)
        if in_merge(remark_col, row_no, ranges):
            raise NeedFallback('remark-target-merged')
        frag = frags.get(row_no, b'')
        if _cell_has_formula(frag, tgt_coord):
            # 既有内容是公式：慢路径把公式**原文**并进备注文本，手术读缓存值会走样
            raise NeedFallback('remark-existing-formula')
        kind, existing = _cell_value_in(frag, tgt_coord, sst)
        if kind == 'other':
            raise NeedFallback('remark-existing-not-text')
        piece = '；'.join(t for _src, t in items)
        base = fmt_remark_value(existing) if existing not in (None, '') else ''
        merged = (base + '；' + piece) if base else piece
        if len(merged) > 32767:
            raise NeedFallback('remark-overflow')
        edits.append((tgt_coord, {'type': 'text', 'value': merged}))
        extracted += len(items)
    return edits, (extracted, added, kept, lost)


def _row_fragments(sheet_xml, wanted):
    """一次扫描取目标行完整片段 {行号: <row…>…</row>}；只留 wanted 行，内存有界。
    供批注落点查格用——此前每条批注都对整部件做全文正则找格，真实表属性序（s 在 r 前）
    还触发逐格 76 万次 re.escape 回落，32 条批注吃掉 12.8s（cProfile 实证，ZS 注记）。"""
    out = {}
    wanted = set(wanted)
    for m in re.finditer(rb'<row\b([^>]*?)(?:/>|>(.*?)</row>)', sheet_xml, re.S):
        rm = re.search(rb'\sr="([0-9]+)"', m.group(1) or b'')
        if rm:
            n = int(rm.group(1))
            if n in wanted and n not in out:
                out[n] = m.group(0)
    return out


def _cell_has_formula(sheet_xml, coord):
    """目标格是否公式格（<f> 在），供备注落点回落判定。sheet_xml 可传行片段。"""
    pat = re.compile((_CELL_RE_TMPL % coord).encode(), re.S)
    m = pat.search(sheet_xml)
    if not m:
        for cm in _RE_C_BLOCK.finditer(sheet_xml):
            if re.search(rb'\sr="%s"' % re.escape(coord.encode()), cm.group(1) or b''):
                m = cm
                break
    return bool(m) and b'<f' in m.group(0)


def _cell_value_in(sheet_xml, coord, sst):
    """坐标 → (kind, text)。兼容 r 不在首属性的格标签（Excel/openpyxl 属性序都见过）。
    sheet_xml 可传行片段（见 _row_fragments）。"""
    pat = re.compile((_CELL_RE_TMPL % coord).encode(), re.S)
    m = pat.search(sheet_xml)
    if not m:
        for cm in _RE_C_BLOCK.finditer(sheet_xml):
            if re.search(rb'\sr="%s"' % re.escape(coord.encode()), cm.group(1) or b''):
                m = cm
                break
    if not m:
        return ('empty', None)
    block = m.group(0)
    if block.rstrip().endswith(b'/>'):
        return ('empty', None)
    o = block.find(b'>')
    return _cell_value_text(block[o + 1:-4], block[:o], sst)


def clean_workbook(data, comments, is_external_formula, fmt_remark_value):
    """首次清洗字节手术：剔外链/自定义XML/批注包，外链公式固化，批注进「备注」列。
    comments: {(表标题, 行, 列): 文本}（sheet._comments_from_xml 口径）。
    返回 (清洗后字节, report)。report: stripped/frozen/extracted/added/kept/lost。
    语义边界守不住时抛 NeedFallback，由调用方回落 openpyxl 慢路径。"""
    z = zipfile.ZipFile(BytesIO(data))
    names = z.namelist()
    sst = _sst_texts(data)

    # 表标题 → 部件（workbook.xml + rels）
    wb_xml = z.read('xl/workbook.xml').decode('utf-8', 'ignore')
    rels_xml = z.read('xl/_rels/workbook.xml.rels').decode('utf-8', 'ignore')
    rid_target = {}
    for m in re.finditer(r'<Relationship\b[^>]*>', rels_xml):
        tag = m.group(0)
        rid = re.search(r'Id="([^"]+)"', tag)
        tgt = re.search(r'Target="([^"]+)"', tag)
        if rid and tgt:
            rid_target[rid.group(1)] = tgt.group(1)
    sheets = []   # [(title, part)]
    for m in re.finditer(r'<sheet\b[^>]*/>', wb_xml):
        tag = m.group(0)
        nm = re.search(r'name="([^"]+)"', tag)
        rid = re.search(r'r:id="([^"]+)"', tag)
        if nm and rid:
            tgt = rid_target.get(rid.group(1)) or ''
            part = tgt.lstrip('/') if tgt.startswith('/') else 'xl/' + tgt.lstrip('./')
            sheets.append((_xml_unescape_text(nm.group(1)), part))
    if not sheets:
        raise NeedFallback('no-sheets')

    replacements = {}
    report = {'stripped': [], 'frozen': 0, 'extracted': 0, 'added': False, 'kept': 0, 'lost': 0}
    primary = sheets[0][1]

    for title, part in sheets:
        if part not in names:
            continue
        sheet_xml = z.read(part)
        sheet_comments = {(r, c): txt for (sname, r, c), txt in comments.items() if sname == title}
        edits, (extracted, added, kept, lost) = _plan_remark(sheet_xml, sst, sheet_comments, fmt_remark_value)
        frozen_xml, frozen = _freeze_formulas(sheet_xml, is_external_formula)
        report['frozen'] += frozen
        report['extracted'] += extracted
        report['kept'] += kept
        report['lost'] += lost
        if added and part == primary:
            report['added'] = True
        if frozen_xml != sheet_xml or edits:
            if edits:
                frozen_xml = splice_sheet_xml(frozen_xml, edits)
            replacements[part] = frozen_xml

    # 剔包 + 关系图/内容类型清理
    drop = set()
    for n in names:
        if n.startswith('xl/externalLinks/') or n.startswith('customXml/'):
            drop.add(n)
        elif 'comments' in n or n.endswith('.vml'):
            drop.add(n)
    if any(n.startswith('xl/externalLinks/') for n in names):
        report['stripped'].append('xl/externalLinks/')
    if any(n.startswith('customXml/') for n in names):
        report['stripped'].append('customXml/')

    def _strip_rels(xml_bytes, drop_pred):
        out = []
        last = 0
        for m in _RE_REL.finditer(xml_bytes):
            if drop_pred(m.group(0)):
                out.append(xml_bytes[last:m.start()])
                last = m.end()
        out.append(xml_bytes[last:])
        return b''.join(out)

    wb_new = re.sub(rb'<externalReferences>.*?</externalReferences>', b'', z.read('xl/workbook.xml'), flags=re.S)
    replacements['xl/workbook.xml'] = wb_new
    replacements['xl/_rels/workbook.xml.rels'] = _strip_rels(
        rels_xml.encode(), lambda tag: b'externalLink' in tag)
    if '_rels/.rels' in names:
        replacements['_rels/.rels'] = _strip_rels(
            z.read('_rels/.rels'), lambda tag: b'customXml' in tag)
    if '[Content_Types].xml' in names:
        ct = z.read('[Content_Types].xml')
        ct = re.sub(rb'<Override\b[^>]*PartName="/xl/externalLinks/[^"]*"[^>]*/>', b'', ct)
        ct = re.sub(rb'<Override\b[^>]*PartName="/customXml/[^"]*"[^>]*/>', b'', ct)
        ct = re.sub(rb'<Override\b[^>]*PartName="[^"]*comments[^"]*"[^>]*/>', b'', ct)
        ct = re.sub(rb'<Override\b[^>]*PartName="[^"]*\.vml"[^>]*/>', b'', ct)
        replacements['[Content_Types].xml'] = ct
    for n in names:
        mm = re.match(r'xl/worksheets/_rels/([^/]+)\.xml\.rels$', n)
        if not mm:
            continue
        replacements[n] = _strip_rels(
            z.read(n), lambda tag: b'comments' in tag.lower() or b'Comments' in tag)

    out = rebuild_zip(data, replacements, drops=drop)
    # 自检：包完好、外链/批注包不在、固化格无 <f>、备注文本在
    z2 = zipfile.ZipFile(BytesIO(out))
    if z2.testzip() is not None:
        raise SurgeryError('清洗自检失败：包损坏')
    n2 = set(z2.namelist())
    if any(x.startswith('xl/externalLinks/') or x.startswith('customXml/') or 'comments' in x for x in n2):
        raise SurgeryError('清洗自检失败：外链/自定义XML/批注包仍在')
    return out, report


def edit_column_widths(data, sheet_path, widths):
    """Patch only <cols>; preserve cell/formula/style XML and untouched ZIP members."""
    import math
    normalized = {}
    for key, value in widths.items():
        try:
            index = int(key)
            width = float(value)
        except (TypeError, ValueError, OverflowError):
            raise SurgeryError('列宽参数无效')
        if isinstance(key, bool) or str(index) != str(key) or not 1 <= index <= 16384:
            raise SurgeryError('列序号无效')
        if isinstance(value, bool) or not math.isfinite(width) or not 0 < width <= 255:
            raise SurgeryError('列宽须在0到255之间')
        normalized[index] = width
    if not normalized:
        raise SurgeryError('请给出要修改的列宽')
    xml = read_sheet(data, sheet_path)
    prefix = rb'(?:[A-Za-z_][\w.-]*:)?'
    block = re.search(rb'<(' + prefix + rb'cols)\b[^>]*(?:/>|>.*?</\1\s*>)', xml, re.S)
    data_tag = re.search(rb'<(' + prefix + rb'sheetData)\b', xml)
    if data_tag is None:
        raise SurgeryError('工作表缺少数据部件')
    ns = data_tag.group(1)[:-len(b'sheetData')]
    def attr(tag, name):
        match = re.search(rb'\b' + name + rb'\s*=\s*([\'"])(.*?)\1', tag)
        return match.group(2) if match else None
    def put(tag, name, value):
        pair = name + b'="' + str(value).encode() + b'"'
        pattern = rb'\b' + name + rb'\s*=\s*([\'"])(.*?)\1'
        if re.search(pattern, tag):
            return re.sub(pattern, lambda _: pair, tag, count=1)
        return tag[:-2] + b' ' + pair + b'/>'
    tags = re.findall(rb'<' + prefix + rb'col\b[^>]*/>', block.group(0)) if block else []
    if block and len(re.findall(rb'<' + prefix + rb'col\b', block.group(0))) != len(tags):
        raise SurgeryError('列定义格式不支持，未修改原文件')
    output, covered = [], set()
    previous = 0
    for tag in tags:
        lo, hi = int(attr(tag, b'min') or 0), int(attr(tag, b'max') or 0)
        if not 1 <= lo <= hi <= 16384 or lo <= previous:
            raise SurgeryError('列范围重叠或无效，未修改列宽')
        previous = hi
        targets = sorted(i for i in normalized if lo <= i <= hi)
        cursor = lo
        for i in targets:
            if cursor < i:
                output.append((cursor, put(put(tag, b'min', cursor), b'max', i-1)))
            changed = put(put(tag, b'min', i), b'max', i)
            changed = put(put(changed, b'width', normalized[i]), b'customWidth', 1)
            output.append((i, changed)); covered.add(i); cursor = i+1
        if cursor <= hi:
            output.append((cursor, put(put(tag, b'min', cursor), b'max', hi) if targets else tag))
    for i in sorted(set(normalized)-covered):
        output.append((i, b'<' + ns + b'col min="' + str(i).encode() + b'" max="' + str(i).encode() + b'" width="' + str(normalized[i]).encode() + b'" customWidth="1"/>'))
    inner = b''.join(tag for _, tag in sorted(output))
    if block and not block.group(0).endswith(b'/>'):
        old = block.group(0); opening = old[:old.find(b'>')+1]
        replacement = opening + inner + b'</' + block.group(1) + b'>'
    else:
        replacement = b'<' + ns + b'cols>' + inner + b'</' + ns + b'cols>'
    start, end = block.span() if block else (data_tag.start(), data_tag.start())
    patched = xml[:start] + replacement + xml[end:]
    saved = rebuild_zip(data, {sheet_path: patched})
    if read_sheet(saved, sheet_path) != patched:
        raise SurgeryError('列宽写入校验失败')
    # Only the column metadata region was replaced; formulas and sheetData are byte-identical.
    return saved
