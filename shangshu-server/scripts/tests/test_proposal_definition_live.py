"""Real definition-drift rejection: stale proposal must not write, fresh one can."""
import importlib.util, os, uuid, copy
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
os.environ['SS_ROOT']=str(ROOT)
os.environ.setdefault('SS_BASE','http://127.0.0.1:3850')
def load(name,path):
 s=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
t=load('structure','shangshu-server/scripts/test-n2-structure.py')
seed=load('seed','shangshu-server/scripts/tests/_ss_seed.py')
cred=load('cred','shangshu-server/scripts/tests/_ss_cred.py')
console=load('console','shangshu-server/scripts/tests/_ss_console.py')
c=t.Client(os.environ['SS_BASE']);c.login('Administrator',cred.admin_pw_for(os.environ['SS_BASE']))
h=None;run=uuid.uuid4().hex
try:
 h=seed.seed_mixed_table(c,run=run,attribution={'level':'personal','owner_user':'Administrator'})
 def read():
  st,b=t.service(c,'files.sheet_read',{'table':h['table']});assert st==200,(st,b);return seed._result(st,b)
 def propose(state):
  payload={'table':h['table'],'cells':[{'row_id':state['rows'][0]['row_id'],'header':'备注','value':{'type':'text','value':'new-note-'+run}}], 'expected_content_version':state['content_version'],'expected_structure_version':state['structure_version']}
  out=console.run("import frappe\nfrom shangshu_core.public_api import propose_registered_action\nfrappe.set_user('Administrator')\np=propose_registered_action('files.sheet_cells_write',%r,idempotency_key=%r)\nRESULT['id']=p['id']\nfrappe.db.commit()"%(payload,uuid.uuid4().hex))
  assert not out.get('__error__'),out;return out['id']
 before=read();old=propose(before)
 columns=copy.deepcopy(seed.MIXED_COLUMNS);columns[1]['rules']['max']=10000
 st,b=t.action(c,'files.promotion_define',{'table':h['table'],'expected_structure_version':before['structure_version'],'definition':{'definition_version':1,'columns':columns}},uuid.uuid4().hex)
 assert st==200,(st,b)
 current=read()
 st,b=c.request('POST',f'/api/platform/action-proposals/{old}/resolve',{'decision':'confirmed'})
 assert st in (400,409,417,422),(st,b)
 assert '定义' in str(b) or '结构' in str(b),(st,b)
 after=read();assert after['content_version']==current['content_version'] and after['rows']==current['rows']
 print('PASS stale definition proposal rejected specifically; no values or content version changed')
 fresh=propose(after)
 st,b=c.request('POST',f'/api/platform/action-proposals/{fresh}/resolve',{'decision':'confirmed'})
 assert st==200,(st,b)
 final=read();assert final['rows'][0]['values']['备注']['value']=='new-note-'+run
 print('PASS fresh proposal against current definition confirms and saves actual cell')
finally:
 if h:seed.seed_cleanup(c,h);print('CLEANUP fixture recycled')
