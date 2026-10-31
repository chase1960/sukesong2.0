"""r967-only mixed transaction fault checks; restores site config and recycles its own fixture."""
import importlib.util
import json
import os
import subprocess
import uuid
from pathlib import Path
from datetime import datetime, timezone

ROOT=Path(__file__).resolve().parents[3]
os.environ['SS_ROOT']=str(ROOT)
os.environ['SS_BASE']='http://127.0.0.1:3850'
os.environ['SS_CONTAINER']='shangshu-local-r967-frappe-1'
BASE=os.environ['SS_BASE']; CONTAINER=os.environ['SS_CONTAINER']
BENCH='/home/frappe/frappe-bench'; CONFIG=BENCH+'/sites/shangshu.localhost/site_config.json'

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

t=load('fault_api','shangshu-server/scripts/test-n2-structure.py')
seed=load('fault_seed','shangshu-server/scripts/tests/_ss_seed.py')
cred=load('fault_cred','shangshu-server/scripts/tests/_ss_cred.py')
fault=load('fault_points','shangshu-server/scripts/tests/_ss_fault.py')
console=load('fault_console','shangshu-server/scripts/tests/_ss_console.py')
compose=fault.compose_of(BASE)
assert compose=='shangshu-local-r967' and console.CONTAINER==CONTAINER

# Print only this one non-secret config key, never the site config/credentials.
def config(change=None):
    code='''import json,os,stat,tempfile
p=%r
d=json.load(open(p)); prior={'present':'ss_fault_file' in d,'value':d.get('ss_fault_file')}
change=json.loads(%r)
if change is not None:
 if change['present']:d['ss_fault_file']=change['value']
 else:d.pop('ss_fault_file',None)
 fd,name=tempfile.mkstemp(dir=os.path.dirname(p))
 os.fchmod(fd,stat.S_IMODE(os.stat(p).st_mode))
 with os.fdopen(fd,'w') as stream:json.dump(d,stream,indent=1);stream.flush();os.fsync(stream.fileno())
 os.replace(name,p)
print(json.dumps(prior))
'''%(CONFIG,json.dumps(change))
    proc=subprocess.run(['docker','exec','-i',CONTAINER,BENCH+'/env/bin/python','-'],input=code,capture_output=True,text=True,timeout=30)
    assert proc.returncode==0,'site config operation failed'
    return json.loads(proc.stdout)

def checked_console(code):
    result=console.run(code)
    assert '__error__' not in result,result
    return result

def snapshot(table):
    return checked_console('''import hashlib,json
from shangshu_files.working_file import content_revision
from shangshu_files.sheet import _content
doc=frappe.get_doc('Shangshu File Center File',%r)
content=_content(doc)
meta=json.loads(doc.sheet_meta_json or '{}')
RESULT.update(formal=json.loads(doc.formal_values_json or '{}'),sha=hashlib.sha256(content).hexdigest(),
 stored_sha=doc.current_sha256,revision=content_revision(doc),rows=meta.get('rows'),
 structure=meta.get('structure_version'),file=doc.current_file,compat=meta.get('formula_compat_ready'),formula_results=meta.get('formula_results'),
 op_count=frappe.db.count('Shangshu File Center Sheet Op',{'file':doc.name}))
'''%table)

def read(client,table):
    st,b=t.service(client,'files.sheet_read',{'table':table});assert st==200,(st,b)
    return seed._result(st,b)

import base64,zipfile,re
from io import BytesIO
from openpyxl import Workbook,load_workbook
client=t.Client(BASE);client.login('Administrator',cred.admin_pw_for(BASE))
w=Workbook();w.active.title='Main';w.active.append(['Value','Date','Calc']);w.active.append([8,2,'=TEXT(A2,"0")']);w.active['B2'].number_format='yyyy-mm-dd';w.create_sheet('Other')['A1']='=Main!C2'
b=BytesIO();w.save(b);out=BytesIO()
with zipfile.ZipFile(b) as z,zipfile.ZipFile(out,'w') as target:
 for info in z.infolist():target.writestr(info,z.read(info.filename).replace(b'<v></v>',b'<v>999999</v>') if info.filename.startswith('xl/worksheets/') else z.read(info.filename))
raw=out.getvalue();encoded=base64.b64encode(raw).decode();table=None;old=None;changed=False
try:
 p=subprocess.run(['docker','exec',CONTAINER,'test','-e',fault.FAULT_PATH],capture_output=True);assert p.returncode==1
 old=config();assert old['value'] in (None,'');config({'present':True,'value':fault.FAULT_PATH});changed=True
 st,b=t.action(client,'files.upload',{'file_name':'LEGACY-FORMULA-'+uuid.uuid4().hex+'.xlsx','directory':'/','content_base64':encoded,'attribution':{'level':'personal','owner_user':'Administrator'}},uuid.uuid4().hex);assert st==200,(st,b);table=seed._result(st,b)['file'];print('FIXTURE',table,flush=True)
 # Synthetic legacy state only: reconstruct original cached bytes and old metadata.
 checked_console("import base64,json\nfrom shangshu_files import sheet\ndoc=frappe.get_doc(sheet.DOCTYPE,%r)\nsheet._save_current(doc,base64.b64decode(%r),note='synthetic legacy fixture')\nmeta=sheet._load_meta(doc);meta.pop('formula_compat_ready',None);sheet._save_meta(doc,meta);sheet._invalidate_parse(doc.name);frappe.db.commit()"%(table,encoded))
 for point in ['file-write','op-record']:
  view=read(client,table);before=snapshot(table);op=uuid.uuid4().hex
  payload={'table':table,'start_row':0,'start_col':0,'matrix':[['10']],'matrix_types':[['number']],'extend':False,'op_id':op,'expected_content_version':view['content_version'],'expected_structure_version':view['structure_version']}
  ok,detail=fault.arm(compose,point);assert ok,detail
  try:
   st,b=t.action(client,'files.sheet_paste_apply',payload,op);assert st!=200,(point,st,b)
   failed=checked_console("from shangshu_core.action_requests import request_name\nRESULT.update(frappe.db.get_value('Shangshu Action Request', {'request_key': request_name(%r)}, ['status','failure_reason'], as_dict=True) or {})"%t.receipt_key(op))
   assert failed.get('status')=='Failed' and '注入故障：'+point in failed.get('failure_reason',''),(failed,st,b)
  finally:assert fault.clear(compose)[0]
  after_failure=snapshot(table);assert after_failure==before,{'point':point,'before':before,'after':after_failure}
  print('PASS',point,'SHA/version/compat marker/formula metadata/op count rollback',flush=True)
 op=uuid.uuid4().hex;payload['op_id']=op;st,b=t.action(client,'files.sheet_paste_apply',payload,op);assert st==200,(st,b)
 after=snapshot(table);assert after['compat'] is True and after['revision']==before['revision']+1
 st,b=t.action(client,'files.sheet_cells_undo',{'table':table,'op_id':op},uuid.uuid4().hex);assert st==200,(st,b)
 st,v=t.service(client,'files.versions',{'file':table});assert st==200;ref=seed._result(st,v)['current']['frappe_file'];st,d=t.download(client,table,ref);assert st==200
 saved=d['_bytes'];values=load_workbook(BytesIO(saved),data_only=True);formulas=load_workbook(BytesIO(saved),data_only=False)
 assert values['Main']['A2'].value==8 and values['Main']['C2'].value is None and values['Other']['A1'].value is None
 assert formulas['Main']['C2'].value=='=TEXT(A2,"0")' and formulas['Other']['A1'].value=='=Main!C2'
 from sys import path
 path.insert(0,str(ROOT/'frappe_apps/shangshu_files'));from shangshu_files import zipedit
 with zipfile.ZipFile(BytesIO(raw)) as a,zipfile.ZipFile(BytesIO(saved)) as b:assert zipedit.cell_node(a.read('xl/worksheets/sheet1.xml'),'B2')==zipedit.cell_node(b.read('xl/worksheets/sheet1.xml'),'B2')
 print('PASS legacy initialize + undo exact raw date preservation/all-sheet stale caches cleared/formulas retained',flush=True)
finally:
 if changed:
  assert fault.clear(compose)[0];config(old);assert config()==old
 if table:
  st,b=t.action(client,'files.recycle',{'file':table},uuid.uuid4().hex);assert st==200,(st,b);print('RECYCLED',table,flush=True)
