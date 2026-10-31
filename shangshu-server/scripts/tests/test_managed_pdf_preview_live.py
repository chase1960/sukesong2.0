"""UI017 real raster preview for management reader, original download remains denied."""
import os,sys,base64,io,json
if '--execute-live' not in sys.argv or os.environ.get('SS_BASE')!='http://127.0.0.1:3850' or os.environ.get('SS_CONTAINER')!='shangshu-local-r967-frappe-1':raise SystemExit('Explicit exclusive QA required')
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject,NameObject
from test_e01_role_matrix import Fixture,result,successful
f=Fixture('pdfpage',('owner','head','peer'))
def check(label,ok):f.check(label,ok);assert ok,label
try:
 f.setup();w=PdfWriter();p=w.add_blank_page(width=240,height=120);stream=DecodedStreamObject();stream.set_data(b'1 0 0 rg 20 20 80 50 re f');p[NameObject('/Contents')]=w._add_object(stream);w.add_blank_page(width=120,height=240);out=io.BytesIO();w.write(out)
 r=f.action(f.clients['owner'],'files.upload',{'file_name':f.prefix+'.pdf','content_base64':base64.b64encode(out.getvalue()).decode(),'attribution':{'level':'personal','owner_user':f.users['owner']}});assert successful(r),r;file=result(r)['file']
 info=f.console_module.run("d=frappe.get_doc('Shangshu File Center File',%r)\nf=frappe.get_doc('File',d.current_file)\nRESULT['file']=f.name\nRESULT['url']=f.file_url"%file);assert '__error__' not in info,info
 payload={'ref_doctype':'Shangshu File Center File','ref_name':file,'file':info['file'],'page':1}
 r=f.service(f.clients['head'],'platform.file.pdf_page',payload);print('PAGE1',r[0],{k:v for k,v in result(r).items() if k!='image_base64'})
 v=result(r);png=base64.b64decode(v.get('image_base64',''));check('management current reader gets actual PNG page preserving landscape layout',r[0]==200 and png[:8]==b'\x89PNG\r\n\x1a\n' and v['page_count']==2 and v['width']>v['height'])
 from PIL import Image
 image=Image.open(io.BytesIO(png));check('real rendered page retains original red layout block',any(pixel[:3]==(255,0,0) for pixel in image.getdata()));image.close()
 r=f.service(f.clients['head'],'platform.file.pdf_page',{**payload,'page':2});v=result(r);check('page two retains portrait layout',r[0]==200 and v['page']==2 and v['height']>v['width'])
 check('management preview does not grant original download',f.t.download(f.clients['head'],file,info['file'])[0]==403)
 check('unrelated identity cannot render page',f.service(f.clients['peer'],'platform.file.pdf_page',payload)[0]==403)
 check('file binding cannot be forged',f.service(f.clients['head'],'platform.file.pdf_page',{**payload,'ref_name':'not-this-resource'})[0] in (403,404))
 r=f.action(f.admin,'platform.org.head_remove',{'user':f.users['head'],'department':f.departments['a']});assert successful(r),r
 check('same session after management revoke cannot obtain another page',f.service(f.clients['head'],'platform.file.pdf_page',{**payload,'page':2})[0]==403)
 check('authorized owner retains page preview',f.service(f.clients['owner'],'platform.file.pdf_page',payload)[0]==200)
finally:f.cleanup()
raise SystemExit(f.finish())
