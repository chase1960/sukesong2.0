"""Current-rule readiness and actual action execution guard, without a private business domain."""
import json
import time
import unittest
import sys
from unittest.mock import patch
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment, load_module_functions  # noqa: E402 —— 路径要先装好

ROOT=Path(__file__).resolve().parents[2]
PROMOTION=ROOT/'frappe_apps/shangshu_files/shangshu_files/promotion.py'
ACTIONS=ROOT/'frappe_apps/shangshu_core/shangshu_core/actions.py'

install_real_environment()

class Invalid(Exception):pass
def reject(message,kind=Invalid):raise kind(message)
def audit_stub(**kwargs):return SimpleNamespace(name='audit')

class Readiness(unittest.TestCase):
    def setUp(self):
        self.definition={'columns':[
            {'field':'number','header':'编号','type':'text','promoted':True,'rules':{'required':True}},
            {'field':'amount','header':'金额','type':'number','promoted':True,'rules':{'required':True,'min':0}}]}
        self.formal={};self.meta={'rows':['r1']};self.doc=SimpleNamespace()
        # 真模块装载：`_check_rules`／`_reject` 这些**同文件兄弟函数自动跟着进来**，
        # 顶层 `import frappe` 由桩顶着 —— 不再手抄一份 exec 上下文。
        ctx=load_module_functions(PROMOTION,{'row_readiness','require_complete_row'},
            stubs={'frappe':SimpleNamespace(throw=reject,ValidationError=Invalid,DoesNotExistError=Invalid)})
        # 本支自己控制的几处（读定义／正式值／元数据）优先于模块里的同名实现。
        ctx.update({'promoted_columns':lambda definition:definition['columns'],
                    'load_definition':lambda doc:self.definition,'_load_formal':lambda doc:self.formal,
                    '_load_meta':lambda doc:self.meta})
        self.ctx=ctx
    def test_note_then_each_field_then_ready(self):
        ready=self.ctx['row_readiness']
        self.assertEqual(ready(self.definition,{})['status'],'draft')
        self.assertEqual(ready(self.definition,{'number':'A'})['status'],'draft')
        self.assertEqual(ready(self.definition,{'number':'A','amount':20})['status'],'ready')
    def test_rule_upgrade_rechecks_existing_formal_facts(self):
        self.formal={'r1':{'number':'A','amount':20}}
        self.assertEqual(self.ctx['require_complete_row'](self.doc,'r1')['amount'],20)
        self.definition['columns'][1]['rules']['min']=30
        with self.assertRaises(Invalid):self.ctx['require_complete_row'](self.doc,'r1')
        self.definition['columns'][1]['rules']['min']=0
        self.definition['columns'].append({'field':'decision','header':'决定','type':'text','promoted':True,'rules':{'required':True}})
        with self.assertRaises(Invalid):self.ctx['require_complete_row'](self.doc,'r1')
    def test_unknown_row_or_no_formal_row_is_not_ready(self):
        with self.assertRaises(Invalid):self.ctx['require_complete_row'](self.doc,'r1')
        self.formal={'ghost':{'number':'A','amount':20}}
        with self.assertRaises(Invalid):self.ctx['require_complete_row'](self.doc,'ghost')

class ExecutionGuard(unittest.TestCase):
    def setUp(self):
        provenance=SimpleNamespace(current_action_provenance=lambda action_id,version: {}, action_origin_scope=lambda *args,**kwargs:nullcontext())
        scoped=patch.dict(sys.modules,{'shangshu_core.action_provenance':provenance}); scoped.start(); self.addCleanup(scoped.stop)
        self.calls=[];self.ready=False;self.guard_value=True
        self.resource={'handler':'consumer.run','execution_guard':'consumer.guard'}
        self.domain={'id':'com.example.consumer','owner_app':'consumer'}
        self.action=SimpleNamespace(action_version='1.0.0',output_schema_json='{}')
        self.identity=SimpleNamespace(name='i',identity_id='i',enterprise_id='e')
        def guard(*args):
            self.calls.append('guard')
            if not self.ready:raise Invalid('draft')
            return self.guard_value
        def handler(*args):self.calls.append('handler');return {'done':True}
        self.f=SimpleNamespace(throw=reject,ValidationError=Invalid,PermissionError=Invalid,
            session=SimpleNamespace(user='u'),flags=SimpleNamespace(),
            db=SimpleNamespace(get_value=lambda *a:None),
            get_attr=lambda name:{'consumer.guard':guard,'consumer.run':handler}.get(name),
            get_doc=lambda values:SimpleNamespace(insert=lambda **k:SimpleNamespace(name='audit')))
        # 真模块装载：`_trim_result_summary`（结果摘要裁剪）这类**同文件兄弟函数自动跟着进来**。
        # 两个控制点仍由本支自己给：结果摘要校验不做（`_validate_schema`）、
        # 统一日志写入口不接库（`unified_log.write_log` 只回一个行名）。
        ctx=load_module_functions(ACTIONS,{'_execute_action_handler'},
            stubs={'frappe':self.f},
            overrides={'_validate_schema':lambda *a:None,'unified_log':SimpleNamespace(write_log=audit_stub)})
        ctx.update({'time':time,'_json':lambda value,default:json.loads(value),
                    '_canonical':json.dumps,'_summary':lambda value:value})
        self.ctx=ctx
        self.execute=ctx['_execute_action_handler']
    def run_action(self):return self.execute('consumer.use',self.action,self.domain,self.resource,self.identity,['Employee'],{},'key','user',False)
    def test_declared_guard_blocks_handler_when_draft(self):
        with self.assertRaises(Invalid):self.run_action()
        self.assertEqual(self.calls,['guard'])
        self.assertIsNone(self.f.flags.shangshu_action_pin)
    def test_ready_calls_guard_before_handler(self):
        self.ready=True;self.assertTrue(self.run_action()['result']['done'])
        self.assertEqual(self.calls,['guard','handler'])
    def test_ordinary_edit_without_declaration_is_not_blocked(self):
        self.resource.pop('execution_guard')
        self.assertTrue(self.run_action()['result']['done']);self.assertEqual(self.calls,['handler'])
    def test_foreign_guard_and_non_true_fail_closed(self):
        self.resource['execution_guard']='other.guard'
        with self.assertRaises(Invalid):self.run_action()
        self.assertEqual(self.calls,[])
        self.resource['execution_guard']='consumer.guard';self.ready=True;self.guard_value=None
        with self.assertRaises(Invalid):self.run_action()
        self.assertEqual(self.calls,['guard'])
if __name__=='__main__':unittest.main()
