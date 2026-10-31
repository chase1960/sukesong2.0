"""可空受管值持久化：真实数据库 NULL、零值、日志与重复 schema 同步。"""
import json
import uuid
from unittest import mock

import frappe
from frappe.tests.utils import FrappeTestCase

from shangshu_core import managed_nulls, model_records, promotion_records
from shangshu_core.tests import test_promotion_records as fixtures


class TestManagedNulls(FrappeTestCase):
    _provision = fixtures.TestPromotionRecords._provision
    _cleanup = fixtures.TestPromotionRecords._cleanup

    def setUp(self):
        frappe.set_user('Administrator')
        self.key='nullable-'+uuid.uuid4().hex
        self.table=self.key[:30]
        self.created=[]
        self.columns=[{'header':'金额','promoted':True,'field':'amount','type':'number'},
                      {'header':'确认','promoted':True,'field':'flag','type':'boolean'}]
        self.rows=[{'row_id':'r-000001','values':{'amount':0,'flag':False}},
                   {'row_id':'r-000002','values':{'amount':12.5,'flag':True}}]

    def tearDown(self):
        frappe.set_user('Administrator');frappe.db.rollback();self._cleanup()
        super().tearDown()

    def state(self,bound):
        model=frappe.get_doc(model_records.MODEL,bound['object_id'])
        compiled=json.loads(model.active_json)
        columns={f['id']:c['fieldname'] for f,c in zip(compiled['fields'],compiled['doctype']['fields'])}
        return model,compiled,columns

    def write(self,bound,rid,values,suffix):
        return promotion_records.write_promoted_values(object_id=bound['object_id'],records=bound['records'],
            values_by_row={rid:values},idempotency_key=self.key+':'+suffix)

    def test_null_zero_false_unique_index_and_audit_agree(self):
        bound=self._provision(columns=self.columns,rows=self.rows)
        model,compiled,cols=self.state(bound)
        # 真0已存在；如果原生保存先把NULL写0，这个物理唯一键会当场撞错。
        frappe.db.commit()
        frappe.db.add_unique(model.physical_doctype,[cols['amount']],constraint_name='nullable_probe_unique')
        self.write(bound,'r-000002',{'amount':None,'flag':None},'clear')
        second=frappe.get_doc(model.physical_doctype,bound['records']['r-000002'])
        self.assertIsNone(second.get(cols['amount']));self.assertIsNone(second.get(cols['flag']))
        public=promotion_records.read_promoted_values(object_id=bound['object_id'],records=bound['records'],row_ids=['r-000001','r-000002'])['values']
        self.assertEqual(public['r-000001']['amount'],0)
        self.assertIs(public['r-000001']['flag'],False)
        self.assertIsNone(public['r-000002']['amount']);self.assertIsNone(public['r-000002']['flag'])
        audit=frappe.get_all('Shangshu Unified Log',filters={'what_id':'platform.object.update',
            'reference_name':second.name},fields=['detail_json'],order_by='creation desc',limit=1)[0]
        changes=json.loads(audit.detail_json)['record_changes']['changes']
        self.assertEqual({c['field']:c['after'] for c in changes},{'amount':None,'flag':None})
        # 修改另一字段不能让先前的空数值重新变0。
        self.write(bound,'r-000002',{'flag':False},'false')
        fresh=frappe.get_doc(model.physical_doctype,second.name)
        self.assertIsNone(fresh.get(cols['amount']));self.assertEqual(fresh.get(cols['flag']),0)

    def test_required_boolean_none_rejected_false_allowed(self):
        columns=[{**self.columns[0]}, {**self.columns[1],'rules':{'required':True}}]
        bound=self._provision(columns=columns,rows=self.rows)
        with self.assertRaises(frappe.ValidationError):self.write(bound,'r-000002',{'flag':None},'null-required')
        self.write(bound,'r-000002',{'flag':False},'false-required')
        public=promotion_records.read_promoted_values(object_id=bound['object_id'],records=bound['records'],row_ids=['r-000002'])['values']
        self.assertIs(public['r-000002']['flag'],False)

    def test_new_optional_values_stay_empty_without_hidden_zero_defaults(self):
        bound=self._provision(columns=self.columns,rows=[{'row_id':'r-000001','values':{}}])
        model,compiled,cols=self.state(bound)
        fresh=frappe.get_doc(model.physical_doctype,bound['records']['r-000001'])
        self.assertIsNone(fresh.get(cols['amount']));self.assertIsNone(fresh.get(cols['flag']))

    def test_explicit_before_save_output_is_not_erased_by_null_adapter(self):
        bound=self._provision(columns=self.columns,rows=self.rows)
        model,compiled,cols=self.state(bound)
        from frappe.model.document import Document
        original=Document.run_method
        def with_rule(doc,method,*args,**kwargs):
            result=original(doc,method,*args,**kwargs)
            if doc.doctype==model.physical_doctype and method=='before_save':
                doc.set(cols['amount'],7.25);doc.set(cols['flag'],True)
            return result
        with mock.patch.object(Document,'run_method',new=with_rule):
            self.write(bound,'r-000002',{'amount':None,'flag':None},'rule-output')
        fresh=frappe.get_doc(model.physical_doctype,bound['records']['r-000002'])
        self.assertEqual(fresh.get(cols['amount']),7.25);self.assertEqual(fresh.get(cols['flag']),1)
        audit=frappe.get_all('Shangshu Unified Log',filters={'what_id':'platform.object.update',
            'reference_name':fresh.name},fields=['detail_json'],order_by='creation desc',limit=1)[0]
        changes=json.loads(audit.detail_json)['record_changes']['changes']
        self.assertEqual({c['field']:c['after'] for c in changes},{'amount':7.25})

    def test_schema_capability_is_reused_only_in_current_transaction(self):
        bound=self._provision(columns=self.columns,rows=self.rows)
        frappe.db.commit()
        with mock.patch.object(managed_nulls,'_schema',wraps=managed_nulls._schema) as schema_reads:
            self.write(bound,'r-000002',{'amount':None},'cache-1')
            self.write(bound,'r-000001',{'flag':None},'cache-2')
            self.assertEqual(schema_reads.call_count,1)
            frappe.db.commit()
            self.write(bound,'r-000002',{'flag':None},'cache-3')
            self.assertEqual(schema_reads.call_count,2)
            frappe.db.rollback()
            self.write(bound,'r-000002',{'flag':None},'cache-4')
            self.assertEqual(schema_reads.call_count,3)

    def test_later_optional_numeric_columns_do_not_fill_existing_rows_with_zero(self):
        bound=self._provision(columns=[self.columns[0]],rows=[
            {**row,'values':{'amount':row['values']['amount']}} for row in self.rows])
        extended=promotion_records.extend_promoted_records(
            object_id=bound['object_id'],application_id=bound['application_id'],
            title='续晋升空值',columns=self.columns+[
                {'header':'预估','promoted':True,'field':'estimate','type':'number'}],
            rows=[],records=bound['records'],access=fixtures.TABLE_ACCESS,
            idempotency_key=self.key+':extend-nullable')
        model,compiled,cols=self.state(extended)
        for name in extended['records'].values():
            fresh=frappe.get_doc(model.physical_doctype,name)
            self.assertIsNone(fresh.get(cols['flag']));self.assertIsNone(fresh.get(cols['estimate']))
        zero=frappe.get_doc(model.physical_doctype,bound['records']['r-000001'])
        self.assertEqual(zero.get(cols['amount']),0)

    def test_schema_resync_and_permission_save_preserve_existing_null(self):
        bound=self._provision(columns=self.columns,rows=self.rows)
        model,compiled,cols=self.state(bound)
        self.write(bound,'r-000002',{'amount':None,'flag':None},'clear-before-sync')
        frappe.db.commit()
        physical=frappe.get_doc('DocType',model.physical_doctype)
        physical.save(ignore_permissions=True)  # 权限保存也是同一个原生 schema 同步入口。
        frappe.db.updatedb(model.physical_doctype)
        from shangshu_core.record_lifecycle import migrate_record_lifecycle
        migrate_record_lifecycle()
        actual=managed_nulls._schema(model.physical_doctype)
        for column in cols.values():self.assertEqual(actual[column]['Null'],'YES')
        fresh=frappe.get_doc(model.physical_doctype,bound['records']['r-000002'])
        self.assertIsNone(fresh.get(cols['amount']));self.assertIsNone(fresh.get(cols['flag']))

    def test_unmigrated_old_table_refuses_empty_then_explicit_migration_preserves_zeros(self):
        bound=self._provision(columns=self.columns,rows=self.rows)
        model,compiled,cols=self.state(bound)
        frappe.db.commit()
        # 仅本测试夹具模拟旧 NOT NULL 模型，绝不改真实站。
        frappe.db.sql_ddl('ALTER TABLE `tab%s` MODIFY COLUMN `%s` decimal(21,9) NOT NULL DEFAULT 0' %
                          (model.physical_doctype,cols['amount']))
        with self.assertRaisesRegex(frappe.ValidationError,'尚未完成可空数值迁移'):
            self.write(bound,'r-000002',{'amount':None},'old-clear')
        frappe.db.rollback()
        self.assertEqual(frappe.db.get_value(model.physical_doctype,bound['records']['r-000002'],cols['amount']),12.5)
        plan=managed_nulls.preview_migration(model.name)
        self.assertIn('NULL DEFAULT NULL',plan['ddl'])
        self.assertEqual(plan['historical_counts']['amount']['zero_count'],1)
        self.assertFalse(plan['data_conversion'])
        frappe.db.commit()
        result=managed_nulls.execute_migration(model.name,plan['plan_hash'],confirmed=True)
        self.assertTrue(result['changed'])
        self.assertEqual(frappe.db.get_value(model.physical_doctype,bound['records']['r-000001'],cols['amount']),0)
        self.write(bound,'r-000002',{'amount':None},'migrated-clear')
        self.assertIsNone(frappe.db.get_value(model.physical_doctype,bound['records']['r-000002'],cols['amount']))

    def test_migration_audit_failure_reports_durable_ddl_and_requires_new_preview(self):
        bound=self._provision(columns=self.columns,rows=self.rows)
        model,compiled,cols=self.state(bound)
        frappe.db.commit()
        frappe.db.sql_ddl('ALTER TABLE `tab%s` MODIFY COLUMN `%s` decimal(21,9) NOT NULL DEFAULT 0' %
                          (model.physical_doctype,cols['amount']))
        plan=managed_nulls.preview_migration(model.name)
        frappe.db.commit()
        with mock.patch('shangshu_core.unified_log.write_log',side_effect=RuntimeError('audit-probe')):
            with self.assertRaisesRegex(frappe.ValidationError,'DDL 可能已生效'):
                managed_nulls.execute_migration(model.name,plan['plan_hash'],confirmed=True)
        fresh=managed_nulls.preview_migration(model.name)
        self.assertIsNone(fresh['ddl']);self.assertNotEqual(fresh['plan_hash'],plan['plan_hash'])
        with self.assertRaises(frappe.TimestampMismatchError):
            managed_nulls.execute_migration(model.name,plan['plan_hash'],confirmed=True)
        receipt=managed_nulls.execute_migration(model.name,fresh['plan_hash'],confirmed=True)
        self.assertFalse(receipt['changed'])
        self.assertTrue(receipt['audit'])
