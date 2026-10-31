"""Real PDF raster page output plus current authority gates before byte rendering."""
import base64,importlib.util,json,os,sys,unittest
from pathlib import Path
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import patch
from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject,NameObject
ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/'frappe_apps/shangshu_core/shangshu_core/pdf_preview.py'
spec=importlib.util.spec_from_file_location('pdf_preview',SOURCE);pdf=importlib.util.module_from_spec(spec);spec.loader.exec_module(pdf)
def content():
 w=PdfWriter();p=w.add_blank_page(width=240,height=120);stream=DecodedStreamObject();stream.set_data(b'1 0 0 rg 20 20 80 50 re f');p[NameObject('/Contents')]=w._add_object(stream);w.add_blank_page(width=120,height=240);out=BytesIO();w.write(out);return out.getvalue()
class Raster(unittest.TestCase):
 def test_real_page_image_retains_layout_color_and_page_count(self):
  result=pdf.render_page(content(),1);self.assertEqual((result['page'],result['page_count']),(1,2))
  im=Image.open(BytesIO(base64.b64decode(result['image_base64'])));self.assertGreater(im.width,im.height);self.assertTrue(any(pixel[:3]==(255,0,0) for pixel in im.getdata()));self.assertLessEqual(im.width*im.height,pdf.MAX_PIXELS)
  second=pdf.render_page(content(),2);self.assertGreater(second['height'],second['width'])
 def test_real_isolated_worker_returns_png_only(self):
  with patch.dict(os.environ,{'PYTHONPATH':str(ROOT/'frappe_apps/shangshu_core')}):result=pdf.isolated_page(content(),1)
  self.assertEqual(base64.b64decode(result['image_base64'])[:8],b'\x89PNG\r\n\x1a\n');self.assertNotIn('path',result)
 def test_bad_page_and_malformed_pdf_reject(self):
  for page in (True,0,3):
   with self.subTest(page=page),self.assertRaises(ValueError):pdf.render_page(content(),page)
  with self.assertRaises(Exception):pdf.render_page(b'not PDF',1)
class Denied(Exception):pass
class Gates(unittest.TestCase):
 def setUp(self):
  self.read=True;self.preview=True;self.field=True;self.ready=True;self.renders=[]
  def deny():raise Denied('denied')
  self.file=SimpleNamespace(file_name='test.pdf',get_content=lambda:content())
  self.frappe=SimpleNamespace(session=SimpleNamespace(user='manager'),PermissionError=Denied,ValidationError=ValueError,get_doc=lambda *a:self.file,throw=lambda m,e:(_ for _ in ()).throw(e(m)))
  self.modules=patch.dict(sys.modules,{'frappe':self.frappe,
   'shangshu_core.attachments':SimpleNamespace(get_record_attachments=lambda *a:None if self.read else deny()),
   'shangshu_core.org_admin':SimpleNamespace(preview_allows=lambda *a:self.preview),
   'shangshu_core.public_api.http':SimpleNamespace(_field_acl_gate=lambda *a:None if self.field else deny()),
   'shangshu_core.field_access':SimpleNamespace(check_content_ready=lambda *a:None if self.ready else deny())});self.modules.start();self.addCleanup(self.modules.stop)
  mock=patch.object(pdf,'isolated_page',lambda data,page:self.renders.append(page) or {'page':page});mock.start();self.addCleanup(mock.stop)
  self.payload={'ref_doctype':'Managed','ref_name':'one','file':'bound','page':1}
 def test_management_preview_does_not_require_download_permission(self):
  self.assertEqual(pdf.preview(None,self.payload,None),{'page':1});self.assertEqual(self.renders,[1])
 def test_every_page_rechecks_revoked_reference_preview_field_and_ready(self):
  for gate in ('read','preview','field','ready'):
   setattr(self,gate,False)
   with self.subTest(gate=gate),self.assertRaises(Denied):pdf.preview(None,self.payload,None)
   setattr(self,gate,True)
  self.assertEqual(self.renders,[])
if __name__=='__main__':unittest.main()
