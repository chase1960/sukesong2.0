"""Real API regression: coordinate input must write formal values, mixed packages update formal values and workbook atomically."""
import importlib.util, os, uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
os.environ['SS_ROOT']=str(ROOT)
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
 def payload(before,**kw):
  return {'table':h['table'],'expected_content_version':before['content_version'],
          'expected_structure_version':before['structure_version'],'op_id':uuid.uuid4().hex,**kw}
 before=read();rid=before['rows'][0]['row_id']
 p=payload(before,start_row=0,start_col=1,value={'type':'number','value':37.5})
 st,b=t.action(c,'files.sheet_input_write',p,p['op_id']);assert st==200,(st,b)
 result=seed._result(st,b);assert result.get('formal_written') and result.get('sheet_written'),result
 after=read();assert after['rows'][0]['values']['金额']['value']==37.5,after
 st,b=t.service(c,'files.row_read',{'table':h['table'],'row_id':rid});row=seed._result(st,b)
 assert row['source']['金额']=='database' and row['cells']['金额']['value']==37.5,row
 assert after['content_version']==before['content_version']+1,(before,after)
 print('PASS coordinate input writes database and XLSX once')
 # A stale coordinate must fail before formal values change.
 st,b=t.action(c,'files.sheet_input_write',{**p,'op_id':uuid.uuid4().hex,'value':{'type':'number','value':99}},uuid.uuid4().hex)
 assert st!=200,(st,b)
 st,b=t.service(c,'files.row_read',{'table':h['table'],'row_id':rid});assert seed._result(st,b)['cells']['金额']['value']==37.5
 print('PASS stale input leaves formal value unchanged')
 p=payload(after,start_row=0,start_col=1,matrix=[[44,'mixed-ok']],matrix_types=[['number','text']],extend=True)
 st,b=t.action(c,'files.sheet_paste_apply',p,p['op_id']);assert st==200,(st,b)
 mixed_op=p['op_id'];mixed=read()
 assert mixed['content_version']==after['content_version']+1
 assert mixed['rows'][0]['values']['备注']['value']=='mixed-ok'
 st,b=t.service(c,'files.row_read',{'table':h['table'],'row_id':rid});assert seed._result(st,b)['cells']['金额']['value']==44
 print('PASS legal mixed matrix updates formal and workbook once')
 p=payload(mixed,start_row=0,start_col=1,matrix=[[-7,'must-not-save']],matrix_types=[['number','text']],extend=True)
 st,b=t.action(c,'files.sheet_paste_apply',p,p['op_id']);assert st!=200,(st,b)
 now=read();assert now['content_version']==mixed['content_version'] and now['rows']==mixed['rows']
 st,b=t.service(c,'files.row_read',{'table':h['table'],'row_id':rid});assert seed._result(st,b)['cells']['金额']['value']==44
 print('PASS invalid mixed matrix leaves both sides unchanged')
 st,b=t.action(c,'files.sheet_cells_undo',{'table':h['table'],'op_id':mixed_op},uuid.uuid4().hex);assert st==200,(st,b)
 after=read()
 st,b=t.service(c,'files.row_read',{'table':h['table'],'row_id':rid});assert seed._result(st,b)['cells']['金额']['value']==37.5
 assert after['rows'][0]['values']['备注']['value']!='mixed-ok'
 print('PASS mixed inverse restores database and workbook')
 for extra in [dict(start_row=0,start_col=1,value={'type':'number','value':-7}),
               dict(start_row=0,start_col=1,value={'type':'formula','formula':'=1+1'})]:
  p=payload(after,**extra)
  st,b=t.action(c,'files.sheet_input_write',p,p['op_id']);assert st!=200,(st,b)
  now=read();assert now['content_version']==after['content_version'] and now['rows']==after['rows']
  st,b=t.service(c,'files.row_read',{'table':h['table'],'row_id':rid});assert seed._result(st,b)['cells']['金额']['value']==37.5
 print('PASS invalid value and formula leave both sides unchanged')
 p=payload(after,start_row=after['total_rows'],start_col=1,value={'type':'number','value':50})
 st,b=t.action(c,'files.sheet_input_write',p,p['op_id']);assert st==200,(st,b)
 result=seed._result(st,b);assert result['rows_added']==1,result
 new_id=result['row_ids'][0]
 st,b=t.service(c,'files.row_read',{'table':h['table'],'row_id':new_id});new_row=seed._result(st,b)
 assert new_row['cells']['金额']['value']==50 and new_row['source']['金额']=='database',new_row
 after=read()
 print('PASS new coordinate row gets one stable identity and formal value')
 p=payload(after,start_row=after['total_rows'],start_col=2,value={'type':'text','value':'draft-note'})
 st,b=t.action(c,'files.sheet_input_write',p,p['op_id']);assert st==200,(st,b)
 new_draft=seed._result(st,b)['row_ids'][0]
 st,b=t.service(c,'files.row_read',{'table':h['table'],'row_id':new_draft});draft=seed._result(st,b)
 assert draft['row_status']=='draft',draft
 st,b=t.service(c,'files.row_require_ready',{'table':h['table'],'row_id':new_draft});assert st in (400,409,417,422) and b.get('detail')=='ValidationError',(st,b)
 after=read()
 p=payload(after,start_row=after['total_rows']-1,start_col=1,value={'type':'number','value':60})
 st,b=t.action(c,'files.sheet_input_write',p,p['op_id']);assert st==200,(st,b)
 st,b=t.service(c,'files.row_require_ready',{'table':h['table'],'row_id':new_draft});assert st==200,(st,b)
 assert seed._result(st,b)['ready'] is True
 after=read()
 print('PASS note-only draft rejects readiness and completed row becomes ready')
 p=payload(after,start_row=0,start_col=2,matrix=[['ordinary-ok'],['ordinary-two']],extend=True)
 st,b=t.action(c,'files.sheet_paste_apply',p,p['op_id']);assert st==200,(st,b)
 now=read();assert now['rows'][0]['values']['备注']['value']=='ordinary-ok',now
 assert now['content_version']==after['content_version']+1
 print('PASS ordinary matrix in mixed table remains writable')
finally:
 if h:seed.seed_cleanup(c,h)
