"""Real XLSX + managed-record integration. Run only on an isolated test site."""
import uuid
from contextlib import ExitStack
from unittest import mock

import frappe
from frappe.tests.utils import FrappeTestCase
from shangshu_files import cells, promotion, service, sheet
from shangshu_files.tests import promotion_fixture as fixture
from shangshu_files.tests.test_promotion_managed import TestPromotionWriteChain


class TestIncrementalWritePath(FrappeTestCase):
    _upload = TestPromotionWriteChain._upload
    _promote = TestPromotionWriteChain._promote
    _cleanup = fixture.cleanup_created_models

    def setUp(self):
        frappe.set_user('Administrator')
        self.key='incremental-'+uuid.uuid4().hex;self.table=None;self.created=[]
        self._upload();self._promote(fixture.PROMOTED + fixture.ORDINARY)

    def tearDown(self):
        frappe.set_user('Administrator');frappe.db.rollback();self._cleanup()
        super().tearDown()

    def doc(self):return frappe.get_doc(promotion.FILE,self.table)
    def pin(self,**updates):
        doc=self.doc();meta=sheet._load_meta(doc)
        return {'table':self.table,'op_id':self.key+':'+uuid.uuid4().hex,
                'expected_content_version':sheet.content_revision(doc),
                'expected_structure_version':int(meta.get('structure_version') or 1),**updates}
    def guard(self):
        stack=ExitStack()
        stack.enter_context(mock.patch.object(sheet,'safe_open',side_effect=AssertionError('daily full open')))
        stack.enter_context(mock.patch.object(sheet,'_save_with_gates',side_effect=AssertionError('daily full save')))
        return stack
    def formal(self,rid):return promotion._load_formal(self.doc(),row_ids=[rid],fields=promotion.declared_fields(self.doc())).get(rid,{})

    def test_append_first_managed_value_mapping_and_minimal_protocol_undo(self):
        from openpyxl import load_workbook
        from io import BytesIO
        before=sheet._load_meta(self.doc());existing=dict(before['promotion_binding']['records'])
        with self.guard():
            result=sheet.row_append(self.pin(count=1));frappe.db.commit();rid=result['row_ids'][0]
            self.assertIn(rid,sheet._load_meta(self.doc())['promotion_pending_rows'])
            written=sheet.write_cells(self.pin(cells=[{'row_id':rid,'header':'金额','value':{'type':'number','value':42.5}},
                                                       {'row_id':rid,'header':'名称','value':{'type':'text','value':'new row'}}]))
            frappe.db.commit()
            self.assertEqual(self.formal(rid)['amount'],42.5)
            mapping=sheet._load_meta(self.doc())['promotion_binding']['records']
            self.assertEqual({r:mapping[r] for r in existing},existing);self.assertIn(rid,mapping)
            self.assertNotIn(rid,sheet._load_meta(self.doc()).get('promotion_pending_rows',{}))
            # Public undo schema requires only table+op_id, never a new required version field.
            undone=sheet.undo_cells({'table':self.table,'op_id':written['op_id']});frappe.db.commit()
            self.assertEqual(undone['applied'],2);self.assertIsNone(self.formal(rid).get('amount'))
            self.assertEqual(sheet._load_meta(self.doc())['promotion_row_states'][rid]['status'],'draft')
            self.assertEqual(promotion.row_readiness(promotion.load_definition(self.doc()),self.formal(rid))['status'],'draft')
        ws=load_workbook(BytesIO(sheet._content(self.doc()))).active
        self.assertIsNone(ws.cell(len(before['rows'])+2,1).value)

    def test_new_empty_row_shows_blank_managed_cells_and_can_be_filled(self):
        """**新建的空行**：受管列显示**空格子**（不是「无权查看」），而且能直接写进去。

        **为什么要有这一条**（2026-10-29 站上实测撞出来的死循环）：
        分页读把「**没有受管记录的行**」的受管列一律盖住（不回落旧 xlsx 值，这条规矩要留），
        可**新建的空行天生就没有受管记录** ⇒ 受管列全被盖成「无权查看」
        ⇒ 人**写不进去** ⇒ 受管记录也就永远建不出来 ⇒ 自己把自己锁住。

        **这次改的就是这一句口径**：
        · 行**没有受管记录** ＋ **工作簿里那格本来就是空的** ⇒ 显示空格子、许写；
        · 行**没有受管记录** ＋ **工作簿里那格有残留旧值** ⇒ 仍然盖住（另一条判据守着）。

        **测试通过 = 什么成立**：在末尾加一个空行，网格读回来那一行的受管列**是空的**、
        **不是「无权查看」**；往里写第一个值就**建出了受管记录**。
        """
        with self.guard():
            receipt = sheet.row_append(self.pin(count=1));frappe.db.commit()
            rid = receipt['row_ids'][0]
        rows = {r['row_id']: r for r in
                sheet.read_payload('files.sheet_read', {'table': self.table}, None)['rows']}
        cell = rows[rid]['values']['金额']
        self.assertNotEqual(cell.get('hidden'), True,
                            '新建空行的受管列不该被盖成「无权查看」（盖了就写不进去）')
        self.assertIn(cell.get('value'), (None, ''), '新建空行的受管列该是空的')
        self.assertNotEqual(rows[rid]['values']['名称'].get('hidden'), True,
                            '普通列不受这次改动影响')
        # —— 能写进去：第一次写就建受管记录 ——
        with self.guard():
            sheet.write_cells(self.pin(cells=[{'row_id': rid, 'header': '金额',
                                               'value': {'type': 'number', 'value': 42.5}}]))
            frappe.db.commit()
        self.assertEqual(self.formal(rid)['amount'], 42.5, '第一次写就建了受管记录')
        rows = {r['row_id']: r for r in
                sheet.read_payload('files.sheet_read', {'table': self.table}, None)['rows']}
        self.assertEqual(rows[rid]['values']['金额'].get('value'), 42.5,
                         '写完之后读回来是正式值')

    def test_row_with_stale_workbook_value_and_no_record_stays_hidden(self):
        """**护栏**：工作簿里**残留旧值**、又没有受管记录的行 ⇒ 仍然盖住，**不回落旧值**。

        （客户那张总表历史缺映射的两行就是这个形状 —— 盖住是对的。
        **不许**因为上一条判据就把旧值放出来。）

        **测试通过 = 什么成立**：把一行的受管记录映射摘掉（模拟历史缺映射），
        读回来那一行的受管列**仍然是「无权查看」**、**没有旧值**。
        """
        meta = sheet._load_meta(self.doc())
        rid = meta['rows'][0]
        binding = meta['promotion_binding']
        self.assertIn(rid, binding['records'])
        binding['records'] = {k: v for k, v in binding['records'].items() if k != rid}
        promotion._save_meta(self.doc(), meta)
        frappe.db.commit()
        rows = {r['row_id']: r for r in
                sheet.read_payload('files.sheet_read', {'table': self.table}, None)['rows']}
        cell = rows[rid]['values']['金额']
        self.assertEqual(cell.get('hidden'), True, '有残留旧值又没有受管记录 ⇒ 仍然盖住')
        self.assertIsNone(cell.get('value'), '不许回落工作簿里的旧值')

    def _record_version(self, rid):
        """这一行**现在**的受管记录版本（写完之后的那个）。"""
        doc = self.doc()
        state = promotion.formal_state(doc, row_ids=[rid], fields=promotion.declared_fields(doc))
        return (state.get('versions') or {}).get(rid) or ''

    def test_write_receipt_carries_the_fresh_record_version(self):
        """**写回执带上「写完之后这一行新的受管记录版本」**。

        **为什么要有这条**（2026-10-29 站上实测撞出来的连锁故障）：
        客户端手里那份「行 → 受管记录版本」**只在读的时候更新**
        ⇒ **自己写完一格，版本就旧了** ⇒ **下一笔被内核的乐观锁拒**
        （人话：「**记录已被修改，请刷新后重试**」）
        ⇒ 那笔失败卡在**输入队列的队首** ⇒ **整队停** ⇒ 页面永远「有未保存」
        ⇒ **列宽／拖列／撤回／导出全被禁** ⇒ 人以为那些功能坏了（刷新一下又好了，更迷惑）。

        **测试通过 = 什么成立**（三条都要成立）：
        ① 单格写完，回执里有这一行**新的** `record_version`（不是空、不是旧的）；
        ② 成包写完，回执里有 `record_versions`（行 id → 新版本）；
        ③ **拿回执里那个版本去写下一格** ⇒ **写成功**
           （这就是客户端那条真实路径：按回执带版本 ⇒ 不会撞自己）。

        **改之前**：① 拿不到版本（回执里没有这个键）⇒ 这条判据**红**。
        """
        with self.guard():
            receipt = sheet.row_append(self.pin(count=1));frappe.db.commit()
            rid = receipt['row_ids'][0]
            # —— ① 单格写 ——
            written = promotion.cell_write({'table': self.table, 'row_id': rid, 'header': '金额',
                                            'value': {'type': 'number', 'value': 11.5}})
            frappe.db.commit()
            version = (written or {}).get('record_version')
            self.assertTrue(version,
                            '单格写回执必须带这一行新的受管记录版本'
                            '（不带 ⇒ 客户端下一次写会撞自己的旧版本 ⇒ 整队卡住）')
            self.assertEqual(version, self._record_version(rid),
                             '回执带的版本必须是这一行**现在**那个版本')
            # —— ③ 拿回执里那个版本去写下一格 ⇒ 必须成功（不许撞「记录已被修改」）——
            again = promotion.cell_write({'table': self.table, 'row_id': rid, 'header': '金额',
                                          'value': {'type': 'number', 'value': 12.5},
                                          'expected_record_version': version})
            frappe.db.commit()
            self.assertTrue((again or {}).get('applied'),
                            '拿回执里的版本写下一格必须成功（客户端按回执带版本这条路是通的）')
            # —— ② 成包写 ——
            batch = sheet.write_cells(self.pin(cells=[{'row_id': rid, 'header': '日期',
                                                       'value': {'type': 'text', 'value': '2026-10-29'}}]))
            frappe.db.commit()
            versions = (batch or {}).get('record_versions') or {}
            self.assertIn(rid, versions, '成包写回执必须带逐行受管记录版本')
            self.assertEqual(versions[rid], self._record_version(rid),
                             '成包回执带的版本必须是这一行现在的版本')

    def test_a_stale_record_version_does_not_silently_drop_the_write(self):
        """**过期版本的那一笔**：**不许静默丢**（内核的口径是「**重读最新版本再写**」）。

        ⚠️ **为什么不是「当场拒」**：受管记录那侧内核**撞了并发会重读最新版本再写**
        （`shangshu_core/model_records.py` 的写入口注释写明了这条）⇒ 拿过期版本写
        **不会丢**、也不会报错，而是**按最新版本重写一遍**。

        ⇒ 所以客户端那侧**必须自己把版本跟住**（回执带新版本），
        **不许靠服务端替它兜**（兜了就是「后写覆盖先写」）。

        **测试通过 = 什么成立**：拿过期版本写 ⇒ **值照样写进去**（没有静默丢），
        且写完之后**这一行的版本是最新的那个**。
        """
        with self.guard():
            receipt = sheet.row_append(self.pin(count=1));frappe.db.commit()
            rid = receipt['row_ids'][0]
            promotion.cell_write({'table': self.table, 'row_id': rid, 'header': '金额',
                                  'value': {'type': 'number', 'value': 11.5}})
            frappe.db.commit()
            stale = self._record_version(rid)
            promotion.cell_write({'table': self.table, 'row_id': rid, 'header': '金额',
                                  'value': {'type': 'number', 'value': 12.5}})
            frappe.db.commit()
            self.assertNotEqual(stale, self._record_version(rid), '写过一次后版本应当变了')
            again = promotion.cell_write({'table': self.table, 'row_id': rid, 'header': '金额',
                                          'value': {'type': 'number', 'value': 13.5},
                                          'expected_record_version': stale})
            frappe.db.commit()
            self.assertTrue((again or {}).get('applied'),
                            '过期版本的那一笔不许静默丢（内核会重读最新版本再写）')
            self.assertEqual(self.formal(rid).get('amount'), 13.5, '值写进去了')

    def test_insert_one_and_ten_preserves_existing_row_record_mapping(self):
        before=sheet._load_meta(self.doc());ids=list(before['rows']);mapping=dict(before['promotion_binding']['records'])
        with self.guard():
            for count in (1,10):
                current=sheet._load_meta(self.doc())['rows']
                receipt=sheet.row_insert(self.pin(before_row_id=ids[1],count=count));frappe.db.commit()
                after=sheet._load_meta(self.doc());position=current.index(ids[1])
                self.assertEqual(after['rows'],current[:position]+receipt['row_ids']+current[position:])
                self.assertEqual(after['promotion_binding']['records'],mapping)
                for rid in receipt['row_ids']:self.assertIn(rid,after['promotion_pending_rows'])
        self.assertEqual(self.formal(ids[1])['amount'],21.0)

    def test_new_mapping_and_file_restore_after_formal_and_after_file_faults(self):
        baseline_meta=sheet._load_meta(self.doc());baseline_bytes=sheet._content(self.doc())
        for stage in ('mixed-after-formal','post-save'):
            def fault(point):
                if point==stage:raise RuntimeError(stage)
            with self.guard(),mock.patch.object(sheet,'_fault',side_effect=fault):
                with self.assertRaisesRegex(RuntimeError,stage):
                    sheet.paste_apply(self.pin(start_row=len(baseline_meta['rows']),start_col=0,
                        matrix=[[60.5,None,'transient']],matrix_types=[['number','empty','text']]))
            frappe.db.rollback()
            self.assertEqual(sheet._load_meta(self.doc()),baseline_meta)
            self.assertEqual(sheet._content(self.doc()),baseline_bytes)
            self.assertEqual(len(promotion._managed_binding(self.doc())['records']),len(baseline_meta['rows']))

    def test_legacy_alias_and_fifty_cell_illegal_package_share_rules(self):
        before=sheet._content(self.doc());meta=sheet._load_meta(self.doc());rid=meta['rows'][0]
        matrix=[['x']*5 for _ in range(10)];matrix[-1][-1]='x'*32768
        with self.guard():
            with self.assertRaises(frappe.ValidationError):sheet.paste_apply(self.pin(start_row=0,start_col=0,matrix=matrix))
            frappe.db.rollback();self.assertEqual(sheet._content(self.doc()),before)
            payload={'file':self.table,'expected_version':service.upload_version(self.doc()),
                'expected_content_revision':sheet.content_revision(self.doc()),
                'changes':[{'sheet':'S-1','row':2,'column':1,'value':{'t':'n','v':91.5}}]}
            result=cells.edit(payload,{'idempotency_key':self.key+':office'});frappe.db.commit()
            self.assertEqual(result['changed_cells'],1);self.assertEqual(self.formal(rid)['amount'],91.5)
            with self.assertRaises(frappe.TimestampMismatchError):cells.edit(payload)
