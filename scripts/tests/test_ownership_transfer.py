"""UI104 actual transfer handler and file permission functions, controlled Frappe I/O."""
import ast,importlib.util,sys,unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parent))
from _f_module_seam import install_real_environment
# 真 app 包进 sys.path —— service.py 里有函数级
# `from shangshu_core.public_api import organization as org_admin`，
# 包不在路径上（或者 shangshu_core 被换成非包的裸模块）就直接 ModuleNotFoundError。
install_real_environment()
# 真内核包在**装好路径之后、测试替换 sys.modules 之前**先 import：
# public_api 的 import 链要真 shangshu_core.identity 等模块，
# 等 setUp 把 identity 换成替身就来不及了。
import shangshu_core
import shangshu_core.public_api
from _f_business_access_stub import make_business_access_stub
ROOT=Path(__file__).resolve().parents[2]
class Denied(Exception):pass
class Invalid(Exception):pass
class Conflict(Exception):pass
class Doc(dict):
 def __getattr__(self,k):return self.get(k)
 def save(self,**kw):self['modified']=str(int(self['modified'])+1);return self
class Tests(unittest.TestCase):
 def setUp(self):
  self.att=Doc(name='att',resource='file',level='personal',owner_user='creator',department=None,modified='1')
  self.file=Doc(name='file',owner='creator',status='Active',modified='1')
  self.users={u:Doc(name=u,enterprise_id='e',enabled=True) for u in ('creator','next','head','peer','admin')};self.users['foreign']=Doc(name='foreign',enterprise_id='x',enabled=True)
  self.roles={'admin':['System Manager']};self.heads={'head':['a','child']};self.members={'creator':['a'],'next':['child'],'peer':['b']}
  self.depts={d:Doc(name=d,enabled=True,enterprise_id='e') for d in ('a','child','b')};self.depts['foreign']=Doc(name='foreign',enabled=True,enterprise_id='x')
  self.locks=[]
  def throw(m,e):raise e(m)
  def value(kind,filters,field,*a,**kw):
   if kind=='Shangshu Org Attribution':return 'att'
   if kind=='Shangshu Department':return self.depts.get(filters,{}).get(field)
   if kind=='Shangshu Identity':return self.users.get(filters['user'],{}).get(field)
   raise AssertionError((kind,filters,field))
  def doc(kind,name,**kw):
   self.locks.append((kind,name,kw.get('for_update')))
   return self.file if kind=='Shangshu File Center File' else self.att
  self.fr=SimpleNamespace(session=SimpleNamespace(user='creator'),_dict=Doc,throw=throw,PermissionError=Denied,ValidationError=Invalid,TimestampMismatchError=Conflict,
   local=SimpleNamespace(),
   db=SimpleNamespace(get_value=value),get_doc=doc,get_roles=lambda user=None:self.roles.get(user or self.fr.session.user,[]),
   get_all=lambda kind,**kw:self.members.get(kw['filters']['user'],[]))
  def identity(user=None):
   u=self.users.get(user or self.fr.session.user)
   if not u or not u.enabled:raise Denied('inactive')
   return u
  sys.modules['frappe']=self.fr
  sys.modules['shangshu_core.identity_admin']=SimpleNamespace(_manager=lambda:None)
  sys.modules['shangshu_core.identity']=SimpleNamespace(get_identity=identity)
  def level(value,department=None,owner_user=None):
   if value not in ('personal','department'):raise ValueError('level')
   return value
  sys.modules['shangshu_core.field_access']=SimpleNamespace(attribution_level=level)
  # 归属转移这套判据属于**关闭开放策略时**的规则 ⇒ 这里把公共策略桩装成关闭态；
  # 开放口径（试用期间全体已登录账号可用）由 test_open_policy_keeps_business_capabilities 单测覆盖。
  self.access_stub=make_business_access_stub(open_policy=False)
  sys.modules['shangshu_core.business_access']=self.access_stub
  import shangshu_core as _core_pkg
  _core_pkg.business_access=self.access_stub
  path=ROOT/'frappe_apps/shangshu_core/shangshu_core/org_admin.py';spec=importlib.util.spec_from_file_location('ownership_actual',path);self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
  self.m.resource_owner=lambda r:'creator';self.m.resource_attribution=lambda r:self.att
  self.m.org_context=lambda u:{'head_departments':self.heads.get(u,[])}
  self.m._dept_row=lambda d:self.depts[d]
  self.m.create_grant_allows=lambda u,d:d in self.members.get(u,[])
  self.real_effects=self.m._attribution_effects
  self.m._attribution_effects=lambda *a:[{'verified':'same-policy'}]
  # 归属判定的那一面（org_admin）由这个测试自己控：把**真内核包**上的两个入口
  # 指到这份被测模块上 —— `from shangshu_core import org_admin` 与
  # `from shangshu_core.public_api import organization` 都拿到它。
  shangshu_core.org_admin=self.m
  shangshu_core.public_api.organization=self.m
 def assign(self,**kw):return self.m.resource_assign('platform.org.resource_assign',{'resource':'file','level':'personal','owner_user':'next',**kw},{})
 def test_transfer_revokes_creator_but_keeps_original_created_by(self):
  preview=self.assign(dry_run=True);self.assertEqual(self.att.modified,'1')
  done=self.assign(expected_modified=preview['expected_modified'])
  self.assertTrue(done['applied']);self.assertEqual(self.att.owner_user,'next');self.assertEqual(self.file.owner,'creator')
  with self.assertRaises(Denied):self.assign(owner_user='creator',dry_run=True)
  self.fr.session.user='next';self.assertTrue(self.m.assign_allows('next','file'))
 def test_head_includes_child_but_not_peer_and_revocation_immediate(self):
  self.fr.session.user='head';self.att.update(level='department',department='child',owner_user=None)
  self.assertFalse(self.assign(level='department',department='a',owner_user='',dry_run=True)['applied'])
  self.att['department']='b'
  with self.assertRaises(Denied):self.assign(dry_run=True)
  self.att['department']='a';self.heads['head']=[]
  with self.assertRaises(Denied):self.assign(dry_run=True)
 def test_invalid_inactive_and_foreign_target_rejected(self):
  for target in ('missing','foreign',''):
   with self.assertRaises((Denied,Invalid)):self.assign(owner_user=target,dry_run=True)
  self.users['next']['enabled']=False
  with self.assertRaises(Denied):self.assign(dry_run=True)
  self.assertEqual(self.att.owner_user,'creator')
 def test_department_requires_explicit_custodian_and_enabled_same_enterprise(self):
  for department in ('', 'foreign'):
   with self.assertRaises((Denied,Invalid)):self.assign(level='department',department=department,owner_user='',dry_run=True)
  self.depts['a']['enabled']=False
  with self.assertRaises(Denied):self.assign(level='department',department='a',owner_user='',dry_run=True)
  self.depts['a']['enabled']=True
  payload={'resource':'file','level':'department','department':'a','dry_run':True}
  with self.assertRaises(Invalid):self.m.resource_assign('x',payload,{})
 def test_old_preview_cannot_overwrite_new_assignment(self):
  preview=self.assign(level='department',department='a',owner_user='creator',dry_run=True)
  self.assign(level='department',department='a',owner_user='creator',expected_modified=preview['expected_modified'])
  with self.assertRaises(Conflict):self.assign(expected_modified=preview['expected_modified'])
  self.assertEqual(self.att.department,'a')
 def test_confirmation_without_preview_version_rejected(self):
  with self.assertRaises(Conflict):self.assign()
  self.assertEqual(self.att.modified,'1')
 def test_peer_cannot_transfer_and_admin_still_can_in_same_enterprise(self):
  self.fr.session.user='peer'
  with self.assertRaises(Denied):self.assign(dry_run=True)
  self.fr.session.user='admin';self.assertFalse(self.assign(dry_run=True)['applied'])
 def test_historical_creator_not_structure_owner_after_transfer(self):
  self.att['owner_user']='next'
  self.assertFalse(self.m.structure_allows('creator','file'))
  self.assertTrue(self.m.structure_allows('next','file'))
 def test_files_permissions_keep_explicit_edit_but_not_creator_authority(self):
  self.att['owner_user']='next';shared={'edit':False}
  self.m.write_allows=lambda *a:shared['edit'] or self.att.owner_user==self.fr.session.user
  self.m.download_allows=self.m.write_allows
  self.m.share_right_allows=lambda *a:self.att.owner_user==self.fr.session.user
  path=ROOT/'frappe_apps/shangshu_files/shangshu_files/service.py'
  names={'_owns','_manager','_can_write','_can_structure','_can_download','_can_share'}
  nodes=[n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name in names]
  env={'frappe':self.fr,'business_access':self.access_stub};exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),env)
  for name in names-{'_owns','_manager'}:self.assertFalse(env[name](self.file),name)
  shared['edit']=True;self.assertTrue(env['_can_write'](self.file));self.assertTrue(env['_can_download'](self.file))
  self.assertFalse(env['_can_structure'](self.file));self.assertFalse(env['_can_share'](self.file))
 def test_document_permission_has_no_creator_bypass_after_transfer(self):
  from types import SimpleNamespace
  self.m.resource_attribution=lambda r:self.att
  self.m.read_allows=lambda *a:False
  self.m.write_allows=lambda *a:False
  path=ROOT/'frappe_apps/shangshu_files/shangshu_files/service.py'
  nodes=[n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='has_permission']
  env={'frappe':self.fr,'business_access':self.access_stub,'_source_read_allows':lambda *a:None,'_management_read_only':lambda *a:False}
  exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),env)
  for ptype in ('read','write'):
   self.assertFalse(env['has_permission'](self.file,ptype,'creator'))
  env['_source_read_allows']=lambda *a:False
  self.assertFalse(env['has_permission'](self.file,'read','creator'))
  env['_source_read_allows']=lambda *a:True
  self.assertTrue(env['has_permission'](self.file,'read','creator'))
 def test_actual_preview_reports_same_write_structure_share_loss(self):
  old=Doc(self.att);new=Doc(resource='file',level='personal',owner_user='next',department=None)
  def allrows(kind,**kw):
   if kind=='User':return list(self.users)
   if kind=='Shangshu Org Member' and kw.get('filters'):return self.members.get(kw['filters']['user'],[])
   return []
  self.fr.get_all=allrows
  self.m.read_allows=lambda u,r,attribution=None:(attribution or self.att).owner_user==u
  self.m.write_allows=self.m.read_allows
  self.m.download_allows=self.m.read_allows
  self.m.share_right_allows=self.m.read_allows
  effects=self.real_effects('file',old,new)
  creator=next(e for e in effects if e['user']=='creator')
  for key in ('write','structure','share','assign','download'):
   self.assertEqual(creator[key],{'before':True,'after':False})
 def test_department_new_custodian_is_creator_but_mail_system_stays_unassigned(self):
  self.m.department_row=lambda d:self.depts[d]
  captured=[];self.m.attribution_record=lambda *a:captured.append(a)
  path=ROOT/'frappe_apps/shangshu_files/shangshu_files/service.py'
  nodes=[n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='_apply_attribution']
  env={'frappe':self.fr,'business_access':self.access_stub,'_manager':lambda:False,'NO_ATTRIBUTION':'missing','NO_ENTERPRISE':'bad'}
  exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),env)
  payload={'attribution':{'level':'department','department':'a'}}
  env['_apply_attribution'](payload,self.file);self.assertEqual(captured[-1],('file','department','a','creator'))
  env['_apply_attribution']({**payload,'mail_system':{'mail':'source'}},self.file)
  self.assertEqual(captured[-1],('file','department','a',None))
if __name__=='__main__':unittest.main()
