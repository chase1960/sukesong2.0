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
 structure=meta.get('structure_version'),file=doc.current_file,
 op_count=frappe.db.count('Shangshu File Center Sheet Op',{'file':doc.name}))
'''%table)

def read(client,table):
    st,b=t.service(client,'files.sheet_read',{'table':table});assert st==200,(st,b)
    return seed._result(st,b)

client=t.Client(BASE);client.login('Administrator',cred.admin_pw_for(BASE))
run=uuid.uuid4().hex[:12];handle=None;old=None;changed=False
print('START',datetime.now(timezone.utc).isoformat(), 'runtime=a1ae9ec7 base='+BASE,flush=True)
try:
    # Refuse to overwrite someone else's active fault injection.
    p=subprocess.run(['docker','exec',CONTAINER,'test','-e',fault.FAULT_PATH],capture_output=True,timeout=10)
    assert p.returncode==1,'fault file already exists; no changes made'
    old=config();assert old['value'] in (None,''),'another fault configuration is active'
    config({'present':True,'value':fault.FAULT_PATH});changed=True
    handle=seed.seed_mixed_table(client,run='mixed-fault-'+run,attribution={'level':'personal','owner_user':'Administrator'})
    table=handle['table']
    print('FIXTURE',table,flush=True)
    for index,point in enumerate(['mixed-after-formal','file-write','post-save','op-record']):
        before=snapshot(table);view=read(client,table);op=uuid.uuid4().hex
        payload={'table':table,'start_row':0,'start_col':1,
                 'matrix':[[101+index,'fault-'+point]],'matrix_types':[['number','text']],
                 'extend':True,'expected_content_version':view['content_version'],
                 'expected_structure_version':view['structure_version'],'op_id':op}
        ok,detail=fault.arm(compose,point);assert ok,detail
        try:
            st,body=t.action(client,'files.sheet_paste_apply',payload,op)
            assert st not in (0,200),(point,st,body)
            # Public 500 deliberately hides exception details. Verify the exact
            # failure reason in this operation's persisted request, not any 500.
            failure=checked_console("from shangshu_core.action_requests import request_name\nRESULT.update(frappe.db.get_value('Shangshu Action Request', {'request_key': request_name(%r)}, ['status','failure_reason'], as_dict=True) or {})" % t.receipt_key(op))
            assert failure.get('status')=='Failed' and ('注入故障：'+point) in failure.get('failure_reason',''),(point,st,failure)
        finally:
            ok,detail=fault.clear(compose);assert ok,detail
        after=snapshot(table)
        assert before==after,{'point':point,'before':before,'after':after}
        unchanged=read(client,table)
        assert unchanged['rows']==view['rows'] and unchanged['content_version']==view['content_version']
        print('PASS',point,'exact fault hit; formal/XLSX SHA/version/row IDs/op count unchanged; HTTP',st,flush=True)
        # New op/key is a new legitimate request after the fault, not replay of failed intent.
        payload['op_id']=uuid.uuid4().hex
        st,body=t.action(client,'files.sheet_paste_apply',payload,payload['op_id']);assert st==200,(st,body)
        result=seed._result(st,body);assert result.get('formal_written') and result.get('sheet_written'),result
        success=snapshot(table)
        assert success['formal'][view['rows'][0]['row_id']]['amount']==101+index,success
        assert success['revision']==before['revision']+1 and success['op_count']==before['op_count']+1,success
        assert success['rows']==before['rows'] and success['sha']!=before['sha']
        st,body=t.action(client,'files.sheet_paste_apply',payload,payload['op_id']);assert st==200,(st,body)
        assert snapshot(table)==success,'successful replay mutated data or ledger'
        print('PASS',point,'cleared -> one successful write; same-key replay zero duplicate change',flush=True)
    print('RESULT 4 fault rollback cases and 4 success/replay cases PASS; process crash NOT TESTED',flush=True)
finally:
    if changed:
        ok,detail=fault.clear(compose)
        config(old)
        assert ok and config()==old,'failed restoring original fault configuration'
        print('CLEANUP fault file absent; original ss_fault_file key/value restored',flush=True)
    if handle:
        cleanup=seed.seed_cleanup(client,handle)
        assert cleanup['active_left']==[],cleanup
        print('CLEANUP fixture recycled through product action, absent active list; retained in trash',flush=True)
