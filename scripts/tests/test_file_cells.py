"""单元格变更纯逻辑/权限编排测试，不冒充真实库验收。"""
import base64
import copy
import importlib
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment, install_stub_package
# 真 app 包进 sys.path —— 真包能 import，测试才控得住真模块上的点
# （domain.versions / service._writable / workbook.invoke 都是真模块上的点）。
install_real_environment()
# 框架依赖用**桩包**，并把桩调成这个测试要的形状：ValidationError=ValueError（能 raise 的真异常类）。
frappe = install_stub_package('frappe', ValidationError=ValueError, TimestampMismatchError=RuntimeError)

ROOT = Path(__file__).resolve().parents[2] / 'frappe_apps/shangshu_files/shangshu_files'
workbook = importlib.import_module('shangshu_files.workbook')
cells = importlib.import_module('shangshu_files.cells')
file_domain = importlib.import_module('shangshu_files.domain')
file_service = importlib.import_module('shangshu_files.service')
kernel_schema = importlib.import_module('shangshu_core.schema_validation')


class CellTests(unittest.TestCase):
    def _patch(self, obj, name, value):
        """在**真模块**上换掉一个点（换完自动还原）。"""
        patcher = patch.object(obj, name, value)
        patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def test_declared_payload_uses_actual_kernel_schema_subset(self):
        domain=file_domain
        validator=kernel_schema
        declared=next(a[3] for a in domain.ACTIONS if a[0]=='files.edit_cells')
        # 现行载荷口径（3b130e9db，**动作版本 1.0.1 → 2.0.0**：过期判定改用
        # 「当前上传版本号 ＋ 当前内容修订号」两个值，**不再看 `doc.modified`**）：
        # 必填的那个字段从 `expected_modified` 换成了 `expected_content_revision`。
        for value in ({'t':'n','v':180},{'t':'s','v':'00123'},{'t':'b','v':True},None):
            validator._validate_schema({'file':'f1','expected_version':1,'expected_content_revision':1,'changes':[
                {'sheet':'工作表1','row':2,'column':2,'value':value}]},declared)

    def setUp(self):
        self.draft=workbook.blank();self.draft['sheets'][0]['cells'][0][0]={'t':'s','v':'00123'}
        self.change={'sheet':'工作表1','row':1,'column':2,'value':{'t':'n','v':150}}

    def test_patch_only_selected_cells_preserves_other_values_and_source(self):
        original=copy.deepcopy(self.draft)
        changed,diff=cells.apply_changes(self.draft,[self.change])
        self.assertEqual(self.draft,original)
        self.assertEqual(changed['sheets'][0]['cells'][0][:2],[{'t':'s','v':'00123'},{'t':'n','v':150}])
        self.assertEqual(diff[0]['before'],None);self.assertEqual(diff[0]['after'],self.change['value'])
        decoded=workbook.decode(workbook.encode(changed,workbook.encode(self.draft)))
        self.assertEqual(decoded['sheets'][0]['cells'][0][:2],changed['sheets'][0]['cells'][0][:2])

    def test_readonly_duplicate_outside_unknown_type_and_oversized_rejected(self):
        for changes in [[self.change,self.change],[{**self.change,'row':0}],[{**self.change,'sheet':'未知'}],
                        [{**self.change,'column':999}],[{**self.change,'value':{'t':'f','v':'=1'}}],
                        [self.change]*101,[{**self.change,'value':{'t':'n','v':'150'}}]]:
            with self.assertRaises(ValueError):cells.apply_changes(self.draft,changes)
        self.draft['editable']=False
        with self.assertRaises(ValueError):cells.apply_changes(self.draft,[self.change])

    def test_public_range_and_preview_reuse_authorized_fixed_version_service_no_write(self):
        # 域里的版本读取走**真 domain 模块**上的 `versions`（原来挂在假包上）。
        self._patch(file_domain,'versions',Mock(return_value={'file':{'name':'f1','file_name':'采购.xlsx','version':2,'modified':'m1','can_edit':True,'status':'Active'}}))
        with patch.object(workbook,'invoke',return_value=self.draft) as invoke:
            result=cells.read('files.cells',{'file':'f1','version':2,'sheet':'工作表1','rows':1,'columns':2},{})
            self.assertEqual(result['cells'][0][0]['v'],'00123');self.assertEqual(result['file']['modified'],'m1')
            invoke.assert_called_with('files.workbook',{'operation':'open','file':'f1','version':2},{})
            result=cells.read('files.cells',{'file':'f1','version':2,'changes':[self.change]},{});self.assertEqual(result['changes'][0]['before'],None)
            invoke.side_effect=PermissionError('已撤权')
            with self.assertRaises(PermissionError):cells.read('files.cells',{'file':'f1','version':2},{})

class PublicWriteAdapter(unittest.TestCase):
    def setUp(self):
        import test_incremental_daily_write as daily
        self.case=daily.DailyEntries();self.case.setUp();self.addCleanup(self.case.doCleanups)
        c=self.case
        def check(doc,payload):
            if payload.get('expected_version') != 2 or payload.get('expected_content_revision') != c.doc.revision:
                raise RuntimeError('版本变化')
        self.service=types.SimpleNamespace(_writable=lambda *_:c.doc,check_live_revision=check,
            upload_version=lambda *_:2,_append_version=lambda *a: self.fail('legacy upload-version write'))
        sheet=types.ModuleType('shangshu_files.sheet');sheet.__dict__.update(c.h)
        package=importlib.import_module('shangshu_files')
        patches=[patch.dict(sys.modules,{'frappe':c.frappe,'shangshu_files.service':self.service,'shangshu_files.sheet':sheet}),
                 patch.object(package,'service',self.service),patch.object(package,'sheet',sheet,create=True),
                 patch.object(workbook,'invoke',side_effect=AssertionError('legacy workbook codec used')),
                 patch.object(workbook,'decode',side_effect=AssertionError('legacy workbook decode used'))]
        for item in patches:item.start();self.addCleanup(item.stop)
    def payload(self,**extra):
        return {'file':'table','expected_version':2,'expected_content_revision':self.case.doc.revision,
                'changes':[{'sheet':'Sheet','row':2,'column':3,'value':{'t':'s','v':'adapter'}}],**extra}
    def test_ordinary_and_promoted_values_use_same_writer_and_context(self):
        c=self.case;c.enabled=True
        result=cells.edit(self.payload(changes=[{'sheet':'Sheet','row':2,'column':2,'value':{'t':'n','v':820}},
                                               {'sheet':'Sheet','row':2,'column':3,'value':{'t':'s','v':'adapter'}}]),
                          {'idempotency_key':'public-request'})
        self.assertEqual(result['op_id'],'public-request');self.assertEqual(result['changed_cells'],2)
        self.assertEqual(result['upload_version'],2);self.assertEqual(result['content_revision'],2)
        self.assertEqual(c.formal['r-000001']['amount'],820);self.assertEqual(c.sheet()['B2'].value,820)
        self.assertEqual(c.sheet()['C2'].value,'adapter');self.assertEqual(len(c.saves),1)
    def test_rules_and_prior_version_still_reject_without_writing(self):
        c=self.case;c.enabled=True
        with self.assertRaises(ValueError):cells.edit(self.payload(changes=[{'sheet':'Sheet','row':2,'column':2,'value':{'t':'n','v':-1}}]))
        with self.assertRaises(RuntimeError):cells.edit(self.payload(expected_content_revision=999))
        self.assertEqual(c.saves,[]);self.assertEqual(c.formal['r-000001']['amount'],800)
    def test_legacy_missing_identity_nonprimary_and_headers_are_explicit_zero_write(self):
        for changes in ([{'sheet':'Other','row':2,'column':3,'value':{'t':'s','v':'bad'}}],
                        [{'sheet':'Sheet','row':1,'column':3,'value':{'t':'s','v':'header'}}]):
            with self.assertRaises(ValueError):cells.edit(self.payload(changes=changes))
        self.case.meta.pop('rows')
        with self.assertRaisesRegex(ValueError,'迁移'):cells.edit(self.payload())
        self.assertEqual(self.case.saves,[])
    def test_legacy_payload_digest_uses_original_version_and_caller(self):
        c=self.case;payload=self.payload();seen=[]
        package=importlib.import_module('shangshu_files')
        package.sheet.write_cells=lambda payload,context:seen.append(payload) or {'applied':1,'content_version':2}
        first=cells.edit(payload);second=cells.edit(payload)
        self.assertEqual(first['op_id'],second['op_id'])
        self.assertEqual(seen[0]['expected_content_version'],payload['expected_content_revision'])
        c.frappe.session.user='different'
        self.assertNotEqual(cells.edit(payload)['op_id'],first['op_id'])

if __name__=='__main__':unittest.main()
