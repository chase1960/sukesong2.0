"""UI004 HTTP rejection with exact persistence counts and original large XLSX cost."""
import base64, hashlib, json, os, sys, time, zipfile
from io import BytesIO
from pathlib import Path
from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference

SOURCE=Path('/path/to/workspace')
SHA='f52326d845aef21c7f8f20dc3abdae4a67fc58811ba28d909f7e63ec9ee6a6b3'

def main():
 if '--execute-live' not in sys.argv:raise SystemExit('NOT_RUN: --execute-live required')
 if os.environ.get('SS_BASE')!='http://127.0.0.1:3850' or os.environ.get('SS_CONTAINER')!='shangshu-local-r967-frappe-1':raise SystemExit('Explicit QA3850 required')
 from test_e01_role_matrix import Fixture,result,successful
 f=Fixture('uploadcheck',())
 def check(label,ok):f.check(label,ok);assert ok,label
 def counts():
  out=f.console_module.run("RESULT['counts']={dt:frappe.db.count(dt) for dt in ['Shangshu File Center File','File','Shangshu File Center Version']}")
  assert not out.get('__error__'),out
  return out['counts']
 def upload(name,raw):return f.action(f.admin,'files.upload',{'file_name':f.prefix+'-'+name+'.xlsx','directory':'/','content_base64':base64.b64encode(raw).decode(),'attribution':{'level':'personal','owner_user':'Administrator'}})
 try:
  fake=BytesIO()
  with zipfile.ZipFile(fake,'w') as z:z.writestr('xl/workbook.xml','<bad/>');z.writestr('[Content_Types].xml','<bad/>')
  for name,raw in [('text',b'not an xlsx'),('fake-package',fake.getvalue())]:
   before=counts();response=upload(name,raw);after=counts()
   print('REJECTION',json.dumps({'case':name,'status':response[0],'before':before,'after':after}),flush=True)
   check(name+' rejected with zero resource/File/version additions',not successful(response) and response[0] in (400,409,417) and before==after)
  wb=Workbook();ws=wb.active;ws.append(['value','formula']);ws.append([2,'=A2+1']);chart=BarChart();chart.add_data(Reference(ws,min_col=1,min_row=1,max_row=2),titles_from_data=True);ws.add_chart(chart,'D1');ws.merge_cells('A4:B4');ws['A4']='merged';out=BytesIO();wb.save(out)
  response=upload('legal-complex',out.getvalue());check('legal formula/chart/merged workbook accepted',successful(response))
  if '--large' in sys.argv:
   raw=SOURCE.read_bytes();assert hashlib.sha256(raw).hexdigest()==SHA
   started=time.perf_counter();response=upload('original-large',raw);elapsed=(time.perf_counter()-started)*1000
   check('original 9.7MB workbook accepted after full validation',successful(response))
   print('LARGE_UPLOAD',json.dumps({'bytes':len(raw),'sha256':SHA,'http_ms':round(elapsed,1),'result':result(response)}),flush=True)
 finally:f.cleanup()
 return f.finish()
if __name__=='__main__':raise SystemExit(main())
