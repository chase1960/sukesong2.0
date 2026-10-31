"""UI024: inspect real directory before and after engineering promotion."""
import importlib.util,json,os,sys,urllib.parse,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];os.environ.setdefault('SS_ROOT',str(ROOT))
import _ss_seed as seed
from _ss_cred import admin_pw_for
s=importlib.util.spec_from_file_location('directory_promotion_http',ROOT/'shangshu-server/scripts/test-n2-structure.py');t=importlib.util.module_from_spec(s);s.loader.exec_module(t)
def main():
 if '--execute-window' not in sys.argv:raise RuntimeError('explicit QA window required')
 base=os.environ['SS_BASE'];assert base=='http://127.0.0.1:3850'
 c=t.Client(base);c.login('Administrator',admin_pw_for(base));run='directory-promotion-'+uuid.uuid4().hex;handle=None;before={};created=[]
 original=seed.t.action
 def good(response):
  st,b=response;assert st==200 and b.get('ok') is not False,(st,b);return seed._result(st,b)
 def listing():
  query=urllib.parse.urlencode({'filters':json.dumps({'scope':'sheet','q':run}),'page':1,'page_length':20})
  return good(c.request('GET','/api/platform/datasets/files.file/records?'+query))
 def observe(client,name,payload,key):
  result=original(client,name,payload,key)
  if name=='files.upload':
   file=good(result)['file'];created.append(file);before.update(listing())
   assert before['total']==1 and [r['name'] for r in before['rows']]==[file]
   print('PASS before promotion unique original directory entry',flush=True)
  return result
 seed.t.action=observe
 try:
  handle=seed.seed_mixed_table(c,run=run,attribution={'level':'personal','owner_user':'Administrator'})
  after=listing();assert after['total']==1 and [r['name'] for r in after['rows']]==[handle['table']]
  a,b=before['rows'][0],after['rows'][0]
  for key in ['name','file_name','directory','attribution']:assert a.get(key)==b.get(key),key
  print('PASS after promotion original identity name directory and attribution unchanged',flush=True)
  read=good(t.service(c,'files.sheet_read',{'table':a['name']}))
  assert read['rows'][0]['values']['金额']['value']==10.5 and read['rows'][0]['values']['备注']['value']=='A-1'
  print('PASS original table route still reads formal and ordinary cells',flush=True)
  print('RESULT 3/3',flush=True)
 finally:
  seed.t.action=original
  for file in created:good(t.action(c,'files.recycle',{'file':file},uuid.uuid4().hex))
  print('CLEANUP exact resources recycled '+json.dumps(created),flush=True)
if __name__=='__main__':main()
