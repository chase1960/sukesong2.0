"""R15：不同文件的冷解析**不共用一把长时间互斥锁**（按「文件 ＋ 内容版本」单飞 ＋ 上限）。

**问题是什么**（2026-10-26 全仓审查 R15）：
`shangshu_files/sheet.py` 里 `_PARSE_LOCK = threading.Lock()` 是**全文件唯一一把**，
而 `_parsed` **在锁内**做流式解析（失败再整簿回落）⇒
**A 文件冷读没解析完，B 文件的冷读只能排队**（互不相关的两个表互相拖慢）；
缓存 `_PARSE_CACHE_MAX = 2` 也太小（来回切两张表就又冷一次）。

**测试通过 = 下面每一条都成立**（编号 R15-01～R15-04）：

- **R15-01** 同一份文件（同一内容版本）**并发**冷读 ⇒ **只解析一次**（单飞合流，
  不许把同一份内容解析好几遍）。
- **R15-02** **两个不同文件**并发冷读 ⇒ **两份解析重叠**（互不阻塞）。
  改之前：全进程一把锁 ⇒ 第二份解析**必须**等第一份解析完（串行）⇒ 这条会红。
- **R15-03** 缓存**有上限**：条数不超过上限、估算内存不超过预算；
  且**不再是 2 份**（改之前 `_PARSE_CACHE_MAX = 2` ⇒ 连开三张表就掉出去一份）。
- **R15-04** 内容版本变了 ⇒ 键变了 ⇒ **重新解析**（不许拿旧版本的值当新的）。

**替的是什么**：框架（`frappe`）用**公共那一份拟真替身**
（`scripts/shangshu_testkit/frappe_stub.py`，全仓只许有那一份）；
跑的是**真模块**（`shangshu_files.sheet`）。解析本体（`_entry_streaming`）
在这一份里被换成**慢一点的替身** —— 判据要量的是**编排**（谁跟谁串行），
不是 xlsx 解析本身。

跑法（**离线可跑**，不带 bench）：

    cd frappe_apps/shangshu_files && python3 -m unittest shangshu_files.tests.test_parse_cache_singleflight
"""
import threading
import time
import unittest
import datetime
import copy
import gc
import os
from io import BytesIO
from unittest import mock

from openpyxl import Workbook
from openpyxl.styles import Font

from shangshu_files.tests import offline_env


def _workbook(rows=3):
    """一份**非空**工作簿字节（`rows` 行数据 ⇒ 不同行数 ⇒ 字节不同）。"""
    book = Workbook()
    sheet = book.active
    sheet.title = 'S-1'
    sheet.append(['名称', '金额'])
    for index in range(rows):
        sheet.append(['名称%d' % index, index])
    out = BytesIO()
    book.save(out)
    return out.getvalue()


class _Doc:
    """文件记录那一行的替身（`_parsed` 只认这几个属性）。"""

    def __init__(self, name, revision=1):
        self.name = name
        self.content_revision = revision
        self.version_count = 1
        self.sheet_meta_json = '{}'
        self.current_sha256 = ''


def _entry():
    """一份**能用的**解析结果（`_parsed` 只用到这几个键）。"""
    return {'headers': ['名称', '金额'], 'rows_raw': [('名称1', 1)],
            'sheet_title': 'S-1', 'sheet_titles': ['S-1']}


class ParseCacheTests(unittest.TestCase):
    """R15-01～R15-04。"""

    @classmethod
    def setUpClass(cls):
        cls.env = offline_env.OfflineEnv()
        cls.env.__enter__()
        # ★ **在自己的替身装好之后重新 import**（否则拿到的是别的判据那套替身）。
        cls.sheet = cls.env.import_domain('sheet')['sheet']

    @classmethod
    def tearDownClass(cls):
        cls.env.__exit__(None, None, None)

    def setUp(self):
        # 解析缓存是**进程内**的全局 ⇒ 每条用例从干净状态起。
        self.sheet._parse_cache_clear()
        self.sheet._PARSE_STATS.clear()
        self.content = _workbook(3)
        self.other = _workbook(4)

    # ---------- R15-01 ----------

    def test_同一份文件的并发冷读只解析一次(self):
        """4 个线程同时冷读**同一份**内容 ⇒ 解析只跑一遍（四份结果同一份）。"""
        calls = []

        def slow(content, readonly, timing=None):
            calls.append(1)
            time.sleep(0.15)
            return _entry()

        results = []
        errors = []

        def worker():
            try:
                results.append(self.sheet._parsed(_Doc('TBL-A'), self.content))
            except Exception as error:      # pragma: no cover - 判据要看见
                errors.append(error)

        with mock.patch.object(self.sheet, '_entry_streaming', side_effect=slow):
            threads = [threading.Thread(target=worker) for _ in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(10)

        self.assertEqual(errors, [], '并发冷读不该抛错')
        self.assertEqual(len(calls), 1,
                         '同一份内容的并发冷读应当合并成**一次**解析（单飞）')
        self.assertEqual(len(results), 4, '四个线程都要拿到结果')
        self.assertEqual(len({id(entry) for entry, _ in results}), 1,
                         '四个线程拿到的应是**同一份**解析结果')
        self.assertEqual(self.sheet._PARSE_STATS['TBL-A']['parse_count'], 1,
                         '这张表的累计解析次数应当是 1')

    # ---------- R15-02 ----------

    def test_两个不同文件的冷读并行(self):
        """A 文件解析没完时，B 文件的解析**已经在跑**（改之前：B 只能等 A）。"""
        timeline = []
        guard = threading.Lock()

        def slow(content, readonly, timing=None):
            label = 'A' if content == self.content else 'B'
            with guard:
                timeline.append(('start', label))
            time.sleep(0.25)
            with guard:
                timeline.append(('end', label))
            return _entry()

        def worker(doc, content):
            self.sheet._parsed(doc, content)

        with mock.patch.object(self.sheet, '_entry_streaming', side_effect=slow):
            first = threading.Thread(target=worker, args=(_Doc('TBL-A'), self.content))
            second = threading.Thread(target=worker, args=(_Doc('TBL-B'), self.other))
            first.start()
            second.start()
            first.join(10)
            second.join(10)

        labels = sorted(label for _, label in timeline)
        self.assertEqual(labels, ['A', 'A', 'B', 'B'],
                         '两个文件各解析一次（起止各一条）')
        a_end = timeline.index(('end', 'A'))
        b_start = timeline.index(('start', 'B'))
        self.assertLess(b_start, a_end,
                        'B 文件的解析应当在 A 文件解析结束**之前**就开始'
                        '（不同文件不该共用一把锁）')
        self.assertEqual(self.sheet._PARSE_STATS['TBL-A']['parse_count'], 1)
        self.assertEqual(self.sheet._PARSE_STATS['TBL-B']['parse_count'], 1)

    # ---------- R15-03 ----------

    def test_缓存有条数上限和内存预算(self):
        """解析 12 个不同的文件 ⇒ 缓存**留得下几份**（不止 2 份），但**有上限**。"""
        with mock.patch.object(self.sheet, '_entry_streaming',
                               side_effect=lambda content, readonly, timing=None: _entry()):
            for index in range(12):
                self.sheet._parsed(_Doc('TBL-%02d' % index), self.content)

        self.assertGreater(self.sheet._PARSE_CACHE_MAX, 2,
                           '缓存上限改之前只有 2 份（来回切两张表就冷）')
        self.assertLessEqual(len(self.sheet._PARSE_CACHE), self.sheet._PARSE_CACHE_MAX,
                             '缓存条数不许超过上限')
        self.assertLessEqual(self.sheet._parse_cache_bytes(),
                             self.sheet._PARSE_CACHE_MAX_BYTES,
                             '缓存的估算内存不许超过预算')
        self.assertGreaterEqual(len(self.sheet._PARSE_CACHE), 3,
                                '至少留得下三份（改之前只留两份）')

    def test_单份超大结果也进不了预算(self):
        """一份**特别大**的解析结果 ⇒ 缓存**自己把它挤掉**（不许无限占内存）。"""
        huge = {'headers': ['列%d' % i for i in range(50)],
                'rows_raw': [tuple('x' * 200 for _ in range(50)) for _ in range(2000)],
                'sheet_title': 'S-1', 'sheet_titles': ['S-1']}
        with mock.patch.object(self.sheet, '_entry_streaming',
                               side_effect=lambda content, readonly, timing=None: huge):
            self.sheet._parsed(_Doc('TBL-HUGE'), self.content)
        self.assertLessEqual(self.sheet._parse_cache_bytes(),
                             self.sheet._PARSE_CACHE_MAX_BYTES,
                             '一份超大结果不能让缓存超过内存预算')
        self.assertLessEqual(len(self.sheet._PARSE_CACHE), self.sheet._PARSE_CACHE_MAX)

    # ---------- R15-04 ----------

    def test_内容版本变了就重新解析(self):
        """同一张表、内容版本 +1 ⇒ **重新解析**（不许拿旧版本的结果当新的）。"""
        calls = []

        def counted(content, readonly, timing=None):
            calls.append(1)
            return _entry()

        doc = _Doc('TBL-V', revision=1)
        with mock.patch.object(self.sheet, '_entry_streaming', side_effect=counted):
            self.sheet._parsed(doc, self.content)
            doc.content_revision = 2
            self.sheet._parsed(doc, self.content)
        self.assertEqual(len(calls), 2, '内容版本变了 ⇒ 重新解析一次')
        self.assertEqual(self.sheet._PARSE_STATS['TBL-V']['parse_count'], 2)

    def test_large_real_workbook_reuses_parse_under_unchanged_memory_budget(self):
        book = Workbook()
        ws = book.active
        ws.title = '大表'
        ws.append(['列%d' % i for i in range(12)])
        for row in range(800):
            ws.append(['较长业务文本-%04d-%02d' % (row, col) for col in range(12)])
        ws['A2'] = datetime.date(2026, 10, 28)
        ws['B2'] = '=1+1'
        ws['C2'] = '=literal'; ws['C2'].data_type = 's'
        ws['D2'] = False; ws['E2'] = 12.5
        ws['F2'].font = Font(bold=True, color='112233')
        ws.row_dimensions[2].height = 28
        raw = BytesIO(); book.save(raw)
        doc = _Doc('TBL-BIG'); content = raw.getvalue()
        with mock.patch.object(self.sheet, '_PARSE_CACHE_MAX_BYTES', 128 * 1024), \
                mock.patch.object(self.sheet, '_entry_streaming', wraps=self.sheet._entry_streaming) as parser:
            first, _ = self.sheet._parsed(doc, content)
            self.assertGreater(self.sheet._parse_entry_bytes(first), self.sheet._PARSE_CACHE_MAX_BYTES)
            expected = {key: first[key] for key in ('rows_raw', 'style_ids', 'font_styles', 'manual_row_heights')}
            del first
            gc.collect()
            again, diag = self.sheet._parsed(doc, content)
            self.assertEqual(diag['cache'], 'hit')
            self.assertEqual(parser.call_count, 1)
            self.assertEqual({key: again[key] for key in expected}, expected)
            self.assertEqual(self.sheet.value_typed(again['rows_raw'][0][2])['type'], 'text')
            self.assertEqual(self.sheet.value_typed(again['rows_raw'][0][1])['type'], 'formula')
            self.assertLessEqual(self.sheet._parse_cache_bytes(), 128 * 1024)
            self.assertEqual(len(self.sheet._PARSE_CACHE), 1)

    def test_oversized_uncacheable_entry_does_not_evict_other_warm_files(self):
        with mock.patch.object(self.sheet, '_PARSE_CACHE_MAX_BYTES', 8192):
            self.sheet._parse_cache_store('warm', _entry())
            huge = {**_entry(), 'raw_metadata': os.urandom(32768)}
            self.sheet._parse_cache_store('too-big', huge)
            self.assertIn('warm', self.sheet._PARSE_CACHE)
            self.assertTrue('too-big' not in self.sheet._PARSE_CACHE)
            self.assertLessEqual(self.sheet._parse_cache_bytes(), 8192)

    def test_content_hash_and_site_isolate_equal_names_and_revisions(self):
        doc = _Doc('TBL-SAME')
        with mock.patch.object(self.sheet, '_entry_streaming', side_effect=lambda *a, **kw: _entry()) as parser:
            doc.current_sha256 = 'first'
            self.env.frappe.local.site = 'site-a'
            self.sheet._parsed(doc, self.content)
            doc.current_sha256 = 'second'
            self.sheet._parsed(doc, self.other)
            self.env.frappe.local.site = 'site-b'
            self.sheet._parsed(doc, self.other)
            self.assertEqual(parser.call_count, 3)
        self.env.frappe.local.site = ''

    def test_warm_and_write_rekey_paths_keep_budget_and_latest_values(self):
        doc = _Doc('TBL-WRITE')
        entry = {**_entry(), 'rows_raw': [tuple('entry-%04d-%03d' % (r, c) for c in range(20)) for r in range(300)]}
        with mock.patch.object(self.sheet, '_PARSE_CACHE_MAX_BYTES', 32768), \
                mock.patch.object(self.sheet, '_entry_from_wb', return_value=entry):
            self.sheet._warm_parse_from_wb(doc, None)
            self.assertGreater(self.sheet._parse_cache_bytes(), 0)
            self.assertLessEqual(self.sheet._parse_cache_bytes(), 32768)
            entry['rows_raw'][0] = ('changed',)
            doc.content_revision = 2; doc.current_sha256 = 'written'
            self.sheet._rekey_parse(doc, entry, 2)
            del entry
            gc.collect()
            result, diag = self.sheet._parsed(doc, self.content)
            self.assertEqual(diag['cache'], 'hit')
            self.assertEqual(result['rows_raw'][0], ('changed',))
            self.assertEqual(len(self.sheet._PARSE_CACHE), 1)
            self.assertLessEqual(self.sheet._parse_cache_bytes(), 32768)
            self.sheet._invalidate_parse(doc.name)
            self.assertEqual(len(self.sheet._PARSE_CACHE), 0)

    def test_cached_parse_cannot_bypass_current_read_permission(self):
        doc = _Doc('TBL-DENIED')
        doc.check_permission = mock.Mock(side_effect=PermissionError('denied now'))
        with mock.patch.object(self.sheet, '_entry_streaming', return_value=_entry()):
            self.sheet._parsed(doc, self.content)
        with mock.patch.object(self.sheet.frappe, 'get_doc', return_value=doc), \
                mock.patch.object(self.sheet, '_parsed', side_effect=AssertionError('cache touched before permission')):
            with self.assertRaisesRegex(PermissionError, 'denied now'):
                self.sheet.read_payload('files.sheet_read', {'table': doc.name}, {})

    def test_compressed_hit_shares_one_active_decode_and_releases_it_after_requests(self):
        doc = _Doc('TBL-CONCURRENT')
        large = {**_entry(), 'rows_raw': [('repeated-' + str(i),) * 20 for i in range(500)]}
        with mock.patch.object(self.sheet, '_PARSE_CACHE_MAX_BYTES', 32768), \
                mock.patch.object(self.sheet, '_entry_streaming', return_value=large) as parser:
            self.sheet._parsed(doc, self.content)
            stored = self.sheet._PARSE_CACHE[self.sheet._parse_cache_key(doc, 1)]
            self.assertIsInstance(stored, self.sheet._PackedParseEntry)
            gc.collect()
            self.assertIsNone(stored._active())
            decompress = self.sheet.zlib.decompress
            def slow(data):
                time.sleep(0.05)
                return decompress(data)
            results = []; errors = []
            def read():
                try:
                    results.append(self.sheet._parsed(doc, self.content)[0])
                except Exception as error:
                    errors.append(error)
            with mock.patch.object(self.sheet.zlib, 'decompress', side_effect=slow) as decoder:
                threads = [threading.Thread(target=read) for _ in range(4)]
                for thread in threads: thread.start()
                for thread in threads: thread.join(5)
                self.assertEqual(errors, [])
                self.assertEqual(len(results), 4)
                self.assertEqual(len({id(result) for result in results}), 1)
                self.assertEqual(decoder.call_count, 1)
            self.assertEqual(parser.call_count, 1)
            results.clear(); gc.collect()
            self.assertIsNone(stored._active(), '缓存不能强留解码后的整表')

    def test_broken_compressed_snapshot_reparses_current_file(self):
        doc = _Doc('TBL-RECOVER')
        large = {**_entry(), 'rows_raw': [('value-' + str(i),) * 20 for i in range(500)]}
        with mock.patch.object(self.sheet, '_PARSE_CACHE_MAX_BYTES', 32768), \
                mock.patch.object(self.sheet, '_entry_streaming', return_value=large) as parser:
            self.sheet._parsed(doc, self.content)
            stored = self.sheet._PARSE_CACHE[self.sheet._parse_cache_key(doc, 1)]
            stored.data = b'bad snapshot'
            result, diag = self.sheet._parsed(doc, self.content)
            self.assertEqual(result['rows_raw'], large['rows_raw'])
            self.assertEqual(diag['cache'], 'miss')
            self.assertEqual(parser.call_count, 2)

    def test_repeated_cell_writes_and_undo_reuse_packed_base_with_bounded_latest_delta(self):
        doc = _Doc('TBL-DELTA')
        doc.sheet_meta_json = __import__('json').dumps({'rows': ['r%d' % i for i in range(500)],
                                                      'primary_sheet': 'S-1', 'structure_version': 1})
        entry = {**_entry(), 'headers': ['a', 'b'], 'column_types': ['text', 'text'],
                 'rows_raw': [('original-%d' % i, 'note-%d' % i) for i in range(500)]}
        with mock.patch.object(self.sheet, '_PARSE_CACHE_MAX_BYTES', 32768):
            self.sheet._parse_cache_store(self.sheet._parse_cache_key(doc, 1), entry)
            original = self.sheet._PARSE_CACHE[self.sheet._parse_cache_key(doc, 1)]
            old_read = original.read()
            with mock.patch.object(self.sheet.pickle, 'dumps', wraps=self.sheet.pickle.dumps) as serializer:
                for version in range(2, 42):
                    key = self.sheet._parse_cache_key(doc, version - 1)
                    stored = self.sheet._PARSE_CACHE[key]
                    current = stored.read()
                    candidate = dict(current); candidate['rows_raw'] = list(current['rows_raw'])
                    candidate['column_types'] = list(current['column_types'])
                    base = {'entry': stored, 'version': version - 1, 'structure': ('S-1', 1)}
                    doc.content_revision = version; doc.current_sha256 = 'hash-%d' % version
                    value = 'edited' if version % 2 == 0 else 'original-0'
                    mode = self.sheet._update_parse_after_edit(doc, candidate, [('r0', 1, value)], version, cache_base=base)
                    self.assertEqual(mode, 'delta')
                    latest = self.sheet._PARSE_CACHE[self.sheet._parse_cache_key(doc, version)]
                    self.assertIs(latest.data, original.data)
                    self.assertEqual(latest.cells, {0: {0: value}})
                    self.assertEqual(latest.read()['rows_raw'][0], (value, 'note-0'))
                    self.assertLessEqual(self.sheet._parse_cache_bytes(), 32768)
                    self.assertEqual(len(self.sheet._PARSE_CACHE), 1)
                self.assertEqual(serializer.call_count, 0)
            self.assertEqual(old_read['rows_raw'][0], ('original-0', 'note-0'))
            self.assertEqual(original.cells, {})

    def test_delta_threshold_rebuild_and_structure_change_do_not_keep_stale_overlay(self):
        doc = _Doc('TBL-DELTA-LIMIT')
        doc.sheet_meta_json = __import__('json').dumps({'rows': ['r%d' % i for i in range(500)],
                                                      'primary_sheet': 'S-1', 'structure_version': 1})
        entry = {**_entry(), 'column_types': ['text', 'text'],
                 'rows_raw': [('a-%d' % i, 'b-%d' % i) for i in range(500)]}
        with mock.patch.object(self.sheet, '_PARSE_CACHE_MAX_BYTES', 32768):
            self.sheet._parse_cache_store(self.sheet._parse_cache_key(doc, 1), entry)
            stored = self.sheet._PARSE_CACHE[self.sheet._parse_cache_key(doc, 1)]
            base = {'entry': stored, 'version': 1, 'structure': ('S-1', 1)}
            doc.content_revision = 2; doc.current_sha256 = 'hash-2'
            with mock.patch.object(self.sheet, '_PARSE_DELTA_MAX_CELLS', 1), \
                    mock.patch.object(self.sheet.pickle, 'dumps', wraps=self.sheet.pickle.dumps) as serializer:
                mode = self.sheet._update_parse_after_edit(doc, copy.deepcopy(entry), [('r0', 1, 'x'), ('r1', 2, 'y')], 2, cache_base=base)
                self.assertEqual(mode, 'rebuild:delta-limit')
                self.assertEqual(serializer.call_count, 1)
            result = self.sheet._parse_cache_get(self.sheet._parse_cache_key(doc, 2))
            self.assertEqual(result['rows_raw'][:2], [('x', 'b-0'), ('a-1', 'y')])
            self.assertEqual(self.sheet._PARSE_CACHE[self.sheet._parse_cache_key(doc, 2)].cells, {})
            # 后续失败回滚或另一份同版本内容，不能撞上已发布的新 hash 缓存。
            doc.current_sha256 = 'rolled-back-or-other'
            self.assertIsNone(self.sheet._parse_cache_get(self.sheet._parse_cache_key(doc, 2)))


if __name__ == '__main__':
    unittest.main()
