"""Real API: sorted mixed existing/new range is one atomic action; invalid mapping is zero write."""
import importlib.util, os, uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
t=load('t','shangshu-server/scripts/test-n2-structure.py')
seed=load('seed','shangshu-server/scripts/tests/_ss_seed.py')
cred=load('cred','shangshu-server/scripts/tests/_ss_cred.py')
base=os.environ.get('SS_BASE','http://127.0.0.1:3850');c=t.Client(base);c.login('Administrator',cred.admin_pw_for(base))
run=uuid.uuid4().hex[:12];h=None
try:
 h=seed.seed_mixed_table(c,run=run,attribution={'level':'personal','owner_user':'Administrator'})
 def read():
  st,b=t.service(c,'files.sheet_read',{'table':h['table']});assert st==200,(st,b);return seed._result(st,b)
 before=read();ids=[r['row_id'] for r in before['rows']];n=len(ids)
 payload={'table':h['table'],'expected_content_version':before['content_version'],
  'expected_structure_version':before['structure_version'],'op_id':'sorted-expand-'+run,
  'start_row':n-1,'start_col':2,'matrix':[['old-updated','new-column-old'],['new-row','new-column-new']],
  'target_row_ids':[ids[0],None],'extend':True}
 st,b=t.action(c,'files.sheet_paste_apply',payload,'sorted-expand-'+run);assert st==200,(st,b)
 result=seed._result(st,b);after=read();by_id={r['row_id']:r['values'] for r in after['rows']}
 assert result['rows_added']==1 and result['cols_added']==1,result
 assert after['content_version']==before['content_version']+1,(before['content_version'],after['content_version'])
 assert by_id[ids[0]]['备注']['value']=='old-updated',by_id
 assert by_id[ids[-1]]['备注']==before['rows'][-1]['values']['备注'],by_id
 new_id=result['row_ids'][0];new_header=after['headers'][-1]
 assert by_id[new_id]['备注']['value']=='new-row' and by_id[new_id][new_header]['value']=='new-column-new',by_id
 print('PASS sorted existing row plus new row/column committed once')
 bad={**payload,'expected_content_version':after['content_version'],'expected_structure_version':after['structure_version'],
      'target_row_ids':[ids[0],ids[0]],'op_id':'sorted-invalid-'+run}
 st,b=t.action(c,'files.sheet_paste_apply',bad,'sorted-invalid-'+run)
 assert st!=200 and ('重复' in str(b) or '身份' in str(b)),(st,b)
 unchanged=read();assert unchanged['content_version']==after['content_version'] and unchanged['rows']==after['rows']
 print('PASS invalid sorted identity causes zero write and zero expansion')
finally:
 if h:seed.seed_cleanup(c,h)
