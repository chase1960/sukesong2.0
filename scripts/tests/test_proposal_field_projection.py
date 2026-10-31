"""Read actual candidate projection/public functions; authorization I/O is isolated."""
import copy,importlib,importlib.util,json,sys,unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment,load_module_functions
# These suites isolate unrelated persistence; actual provenance has its own tests.
sys.modules['shangshu_core.action_provenance']=SimpleNamespace(
    current_action_provenance=lambda action_id,action_version=None:None,
    process_action_version=lambda action_id:None,
    project_action_provenance=lambda raw:{'status':'not_linked','trusted':False})
ROOT=Path(__file__).resolve().parents[2]
ACTIONS=ROOT/'frappe_apps/shangshu_core/shangshu_core/actions.py'
install_real_environment()
# 预热桩的 frappe 子模块：`setUp` 里 `sys.modules['frappe']` 会被换成测试自己的假 frappe
# （那不是个包）⇒ 内核模块 import `frappe.utils` / `frappe.utils.password` 时只能命中缓存。
importlib.import_module('frappe.utils')
importlib.import_module('frappe.utils.password')
class Denied(Exception):pass
class Invalid(Exception):pass
class Doc(dict):
 def __getattr__(self,key):return self.get(key)
 def check_permission(self,*a):pass
def throw(m,e):raise e(m)
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
class Tests(unittest.TestCase):
 def setUp(self):
  self.hidden=True
  self.fr=SimpleNamespace(throw=throw,PermissionError=Denied,ValidationError=Invalid,DoesNotExistError=Invalid,get_doc=lambda *a,**k:Doc(name='t'))
  sys.modules['frappe']=self.fr
  self.review=module('review_projection_test',ROOT/'frappe_apps/shangshu_files/shangshu_files/proposal_review.py')
  sys.modules['shangshu_files.proposal_review']=self.review
  promo=SimpleNamespace(load_definition=lambda d:{},_field_caps=lambda d,**k:({'secret':{'read':not self.hidden}},[{'header':'秘密','field':'secret','promoted':True}]))
  sys.modules['shangshu_files']=SimpleNamespace(promotion=promo)
  self.pj=module('projection_actual',ROOT/'frappe_apps/shangshu_files/shangshu_files/proposal_projection.py')
  sys.modules['shangshu_files.proposal_projection']=self.pj
  self.visible={'row_id':'r1','header':'名称','value':{'type':'text','value':'OK'}}
  self.secret={'row_id':'r1','header':'秘密','value':{'type':'text','value':'DO-NOT-LEAK'}}
  self.payload={'table':'t','cells':[self.visible,self.secret]}
  def projection(a,p):return self.pj.project(a,p)
  self.doc=Doc(name='p',action_id='files.sheet_cells_write',action_version='1',payload_json=json.dumps(self.payload),payload_summary_json=json.dumps(self.payload),original_payload_json=json.dumps(self.payload),edited_value_json=json.dumps({'秘密':'DO-NOT-LEAK'}),status='Proposed',review_state_json=json.dumps({'accepted':{self.review._id(self.secret):{}}}))
  ctx={'frappe':self.fr,'_project_proposal_payload':projection,'_json':lambda s,d:json.loads(s) if s else d,'_canonical':json.dumps,'_summary':lambda v:v,'_INLINE_PAYLOAD_LIMIT':100000,'json':json}
  # 真模块装载：顶层 import 按真包解析，用到的**同文件兄弟函数自动跟着进来**。
  # `raw_resource`（域有没有声明这个动作）走的是库表，这一支不接库 ⇒ 顶成「没声明」
  # （真实现找不到资源时返回的也是 `(None, None)`）。
  loaded=load_module_functions(ACTIONS,{'_payload_bytes','_proposal_public','list_action_proposal_units','count_action_proposals','_proposal_visible'},
      stubs={'frappe':self.fr},overrides={'raw_resource':lambda *a,**k:(None,None)})
  loaded.update(ctx)   # 本支自己控制的几处优先于模块里的同名实现
  self.ctx=loaded
  self.ctx.update(_proposal_eligible=lambda *a:True,_assert_proposal_target=lambda *a:None,get_identity=lambda:SimpleNamespace(enterprise_id='e'))
  self.fr.get_roles=lambda:[]
  self.fr.get_doc=lambda *a,**k:self.doc
 def test_payload_summary_original_edit_and_counts_have_no_hidden_value(self):
  data=self.ctx['_proposal_public'](self.doc)
  self.assertNotIn('DO-NOT-LEAK',json.dumps(data))
  self.assertEqual(len(data['payload']['cells']),1)
  self.assertEqual(data['summary']['cells'][0]['value']['value'],'OK')
  self.assertEqual(data['review']['accepted_count'],0)
  self.assertFalse(data['review']['partial'])
 def test_direct_units_filters_before_total_and_pagination(self):
  data=self.ctx['list_action_proposal_units']('p')
  self.assertEqual(data['total'],1)
  self.assertEqual(data['items'][0]['value']['value'],'OK')
  self.assertNotIn('DO-NOT-LEAK',json.dumps(data))
 def test_all_hidden_is_not_visible_or_counted(self):
  self.doc.payload_json=json.dumps({'table':'t','cells':[self.secret]})
  self.assertFalse(self.ctx['_proposal_visible'](self.doc,[]))
  self.fr.get_all=lambda *a,**k:[SimpleNamespace(name='p')]
  self.assertEqual(self.ctx['count_action_proposals'](),{'Proposed':0,'Confirmed':0,'Rejected':0})
  with self.assertRaises(Denied):self.ctx['list_action_proposal_units']('p')
 def test_same_proposal_privileged_reader_retains_both_values(self):
  self.hidden=False
  data=self.ctx['_proposal_public'](self.doc)
  self.assertEqual(len(data['payload']['cells']),2)
  self.assertIn('DO-NOT-LEAK',json.dumps(data))
 def test_formal_values_projection_preserves_authorized_field(self):
  data=self.pj.project('files.formal_value_write',{'table':'t','values':{'secret':'DO-NOT-LEAK','name':'OK'}})
  self.assertEqual(data['payload']['values'],{'name':'OK'})
  self.assertTrue(data['redacted'])
 def test_partial_descriptor_visible_only_but_tracks_all_completion_internally(self):
  sys.modules['shangshu_files.service']=SimpleNamespace(proposal_guard=lambda *a:None)
  sys.modules['shangshu_files.sheet']=SimpleNamespace(read_payload=lambda *a:{'rows':[{'row_id':'r1','values':{'名称':{'type':'text','value':'old'},'秘密':{'type':'hidden','hidden':True}}}],'writable':True,'content_version':1,'structure_version':1})
  out=self.review.review('files.sheet_cells_write',self.payload,{}, {'operation':'describe'},'owner')
  self.assertEqual(len(out['units']),1)
  self.assertEqual(len(out['all_unit_ids']),2)
  self.assertNotIn('DO-NOT-LEAK',json.dumps(out))
if __name__=='__main__':unittest.main()
