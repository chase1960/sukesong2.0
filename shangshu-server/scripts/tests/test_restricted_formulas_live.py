"""Real formula API / downloaded XLSX regression. Coordinator deploys first."""
import importlib.util,os,uuid
from pathlib import Path
from io import BytesIO
from openpyxl import load_workbook
ROOT=Path(__file__).resolve().parents[3];os.environ['SS_ROOT']=str(ROOT)
def load(n,p):
 s=importlib.util.spec_from_file_location(n,ROOT/p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
t=load('formula_api','shangshu-server/scripts/test-n2-structure.py');seed=load('formula_seed','shangshu-server/scripts/tests/_ss_seed.py');cred=load('formula_cred','shangshu-server/scripts/tests/_ss_cred.py')
base=os.environ.get('SS_BASE','http://127.0.0.1:3850');c=t.Client(base);c.login('Administrator',cred.admin_pw_for(base));h=None
try:
 h=seed.seed_mixed_table(c,run='formula-'+uuid.uuid4().hex[:10],rows=[{'项目名称':'甲','金额':800,'备注':''},{'项目名称':'乙','金额':900,'备注':''}],attribution={'level':'personal','owner_user':'Administrator'})
 def read():
  st,b=t.service(c,'files.sheet_read',{'table':h['table']});assert st==200,(st,b);return seed._result(st,b)
 def write(value,col=2):
  r=read();p={'table':h['table'],'start_row':0,'start_col':col,'value':value,'op_id':uuid.uuid4().hex,'expected_content_version':r['content_version'],'expected_structure_version':r['structure_version']}
  st,b=t.action(c,'files.sheet_input_write',p,p['op_id']);return st,b,p
 st,b,p=write({'type':'formula','formula':'=SUM(B2:B3)'});assert st==200,(st,b)
 r=read();v=r['rows'][0]['values']['备注'];assert v['value']==1700 and v['result_version']==r['content_version'],v
 def exported(expected):
  st,v=t.service(c,'files.versions',{'file':h['table']});assert st==200,(st,v)
  file_ref=seed._result(st,v)['current']['frappe_file']
  st,b=t.download(c,h['table'],file_ref);assert st==200,(st,b)
  data=b['_bytes'];assert load_workbook(BytesIO(data),data_only=True).active['C2'].value==expected
  assert load_workbook(BytesIO(data),data_only=False).active['C2'].value=='=SUM(B2:B3)'
 exported(1700)
 print('PASS formula SUM official 800+900=1700; typed result version and exported cache',flush=True)
 st,b,p=write({'type':'number','value':1000},1);assert st==200,(st,b)
 r=read();assert r['rows'][0]['values']['备注']['value']==1900;exported(1900)
 print('PASS formal dependency edit recalculates display and export',flush=True)
 for formula in ['=WEBSERVICE("https://invalid")','=C2','=1/0','=Other!A2']:
  before=read();st,b,p=write({'type':'formula','formula':formula});assert st in (400,417,422),(formula,st,b)
  after=read();assert after['rows']==before['rows'] and after['content_version']==before['content_version']
 print('PASS unsupported/cycle/divzero/crosssheet zero-change rejection',flush=True)
 st,b,p=write({'type':'formula','formula':'=IF(B2>B3,COUNT(B2:B3),0)'});assert st==200,(st,b);assert read()['rows'][0]['values']['备注']['value']==2
 st,b=t.action(c,'files.sheet_cells_undo',{'table':h['table'],'op_id':p['op_id']},uuid.uuid4().hex);assert st==200,(st,b);assert read()['rows'][0]['values']['备注']['value']==1900;exported(1900)
 print('PASS formula IF/COUNT and guarded inverse restore prior formula/cache',flush=True)
 for expression,expected in [('=1+2*3-4/2',5),('=IF(2>=1,7,0)',7),('=DAYS("2026-10-19","2026-10-16")',3),('=DATEDIF("2026-10-16","2026-10-19","D")',3)]:
  st,b,p=write({'type':'formula','formula':expression});assert st==200,(expression,st,b)
  current=read();assert current['rows'][0]['values']['备注']['value']==expected,(expression,current)
  st,versions=t.service(c,'files.versions',{'file':h['table']});assert st==200
  reference=seed._result(st,versions)['current']['frappe_file'];st,download=t.download(c,h['table'],reference);assert st==200
  for data_only,wanted in [(True,expected),(False,expression)]:
   book=load_workbook(BytesIO(download['_bytes']),data_only=data_only,read_only=True)
   try:assert book.active['C2'].value==wanted,(expression,data_only,book.active['C2'].value)
   finally:book.close()
  print('PASS formula arithmetic/comparison/date persisted and exported '+expression,flush=True)
 print('RESULT PASS',flush=True)
finally:
 if h:
  result=seed.seed_cleanup(c,h);assert not result['active_left'];print('CLEANUP fixture recycled',flush=True)
