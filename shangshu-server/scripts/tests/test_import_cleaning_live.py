"""UI099 controlled real workbook: external cache, comments, retained original bytes."""
import base64,hashlib,json,os,re,sys,zipfile
from io import BytesIO
from openpyxl import Workbook,load_workbook
from openpyxl.comments import Comment
from openpyxl.styles import Font
from openpyxl.workbook.external_link.external import ExternalLink,ExternalBook,ExternalSheetNames
from openpyxl.packaging.relationship import Relationship

def workbook_bytes():
 wb=Workbook();ws=wb.active;ws.title='主表';ws.append(['编号','外链金额','备注']);ws.append(['00123',"='[1]Source'!A1",'已有备注']);ws.append(['00999',7,'第二行'])
 ws['A1'].comment=Comment('表头便签','tester');ws['A2'].comment=Comment('首格便签','tester');ws['B2'].comment=Comment('金额便签','tester');ws['A3'].comment=Comment('下一行便签','tester');ws['B2'].number_format='0.00';ws['A2'].font=Font(bold=True)
 other=wb.create_sheet('附表');other.append(['名称','值']);other.append(['other',5]);other['A2'].comment=Comment('附表便签','tester')
 link=ExternalLink(externalBook=ExternalBook(sheetNames=ExternalSheetNames(sheetName=['Source']),id='rId1'));link.file_link=Relationship(Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath',Target='file:///controlled-source.xlsx',TargetMode='External');wb._external_links=[link]
 raw=BytesIO();wb.save(raw);out=BytesIO()
 with zipfile.ZipFile(BytesIO(raw.getvalue())) as src,zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as dst:
  for item in src.infolist():
   data=src.read(item.filename)
   if item.filename=='xl/worksheets/sheet1.xml':data=re.sub(rb'(<c\b[^>]*\br="B2"[^>]*>.*?<v>).*?(</v>)',rb'\g<1>42.5\2',data,flags=re.S)
   dst.writestr(item,data)
 return out.getvalue()

def main():
 if '--execute-live' not in sys.argv:raise SystemExit('NOT_RUN: --execute-live and exclusive QA window required')
 if os.environ.get('SS_BASE')!='http://127.0.0.1:3850' or os.environ.get('SS_CONTAINER')!='shangshu-local-r967-frappe-1':raise SystemExit('Explicit QA3850 required')
 from test_e01_role_matrix import Fixture,result,successful
 f=Fixture('cleaning',());source=workbook_bytes();digest=hashlib.sha256(source).hexdigest()
 def check(label,ok):f.check(label,ok);assert ok,label
 try:
  response=f.action(f.admin,'files.upload',{'file_name':f.prefix+'.xlsx','directory':'/','content_base64':base64.b64encode(source).decode(),'attribution':{'level':'personal','owner_user':'Administrator'}});assert successful(response),response
  table=result(response)['file'];read=f.service(f.admin,'files.sheet_read',{'table':table});assert read[0]==200,read;view=result(read)
  check('external cached numeric value becomes ordinary value',view['rows'][0]['values']['外链金额']['value']==42.5 and view['rows'][0]['values']['外链金额']['type']=='number')
  versions=result(f.service(f.admin,'files.versions',{'file':table}));current_ref=versions['current']['frappe_file'];status,body=f.t.download(f.admin,table,current_ref);assert status==200
  current=body['_bytes'];wb=load_workbook(BytesIO(current));ws=wb['主表'];remark=ws['C2'].value
  check('same-row and header comments append after existing remark',remark.startswith('已有备注；') and all(t in remark for t in ['表头便签','首格便签','金额便签']))
  check('other row comments stay on their own row',ws['C3'].value=='第二行；下一行便签' and '下一行便签' not in remark)
  check('secondary worksheet comment has its own appended remark column',wb['附表']['C1'].value=='备注' and wb['附表']['C2'].value=='附表便签')
  check('cleaned package preserves identifiers and cell formats',ws['A2'].value=='00123' and ws['A2'].font.bold and ws['B2'].number_format=='0.00' and ws['B2'].value==42.5 and ws['B2'].data_type!='f')
  with zipfile.ZipFile(BytesIO(current)) as z:check('external-link parts and extracted comment parts removed',not any(n.startswith('xl/externalLinks/') or 'comments' in n.lower() for n in z.namelist()))
  originals=[v for v in versions['versions'] if v['sha256']==digest];check('original upload has its own immutable historical version',len(originals)==1)
  status,original=f.t.download(f.admin,table,originals[0]['frappe_file']);check('downloaded original is byte-identical to uploaded source',status==200 and original['_bytes']==source)
  # Reuse this controlled workbook for short remaining daily-data checks.
  def read(extra=None):
   response=f.service(f.admin,'files.sheet_read',{'table':table,**(extra or {})});assert response[0]==200;return result(response)
  def act(name,payload):
   response=f.action(f.admin,name,{'table':table,**payload});assert successful(response),(name,response);return result(response)
  def latched():
   current=read();return {'expected_content_version':current['content_version'],'expected_structure_version':current['structure_version']}
  found=read({'search':'00123'});check('leading-zero text search returns exact stable row',len(found['rows'])==1 and found['rows'][0]['row_id']==view['rows'][0]['row_id'] and found['rows'][0]['values']['编号']['value']=='00123')
  before=read()
  for target in ('','备注'):
   response=f.action(f.admin,'files.sheet_header_rename',{'table':table,**latched(),'from_header':'编号','to_header':target,'op_id':f.prefix+'-invalid-'+str(len(target))})
   check('empty or duplicate header rejected without state change '+repr(target),response[0] in (400,409,417) and read()['content_version']==before['content_version'] and read()['headers']==before['headers'])
  for title in ('','../bad'):
   response=f.action(f.admin,'files.sheet_rename',{'table':table,**latched(),'title':title})
   check('invalid table title rejected without content change '+repr(title),response[0] in (400,409,417) and read()['content_version']==before['content_version'])
  renamed=act('files.sheet_rename',{**latched(),'title':f.prefix+'-更名'})
  check('valid table rename keeps resource and content/structure versions',renamed['table']==table and renamed['table_title']==f.prefix+'-更名.xlsx' and renamed['content_version']==before['content_version'] and renamed['structure_version']==before['structure_version'])
  act('files.sheet_column_append',{**latched(),'header':'后续字段','op_id':f.prefix+'-append'})
  definition=result(f.service(f.admin,'files.promotion_definition',{'table':table}));check('ordinary appended column remains outside formal definition',not definition['columns'])
  act('files.sheet_input_write',{**latched(),'start_row':0,'start_col':3,'value':{'type':'text','value':'READY'},'op_id':f.prefix+'-ordinary'})
  rid=read()['rows'][0]['row_id'];prior_row=result(f.service(f.admin,'files.row_read',{'table':table,'row_id':rid}));check('ordinary column value initially reads from sheet',prior_row['source']['后续字段']=='sheet' and prior_row['cells']['后续字段']['value']=='READY')
  definition=result(f.service(f.admin,'files.promotion_definition',{'table':table}))
  act('files.promotion_define',{'expected_structure_version':definition['structure_version'],'expected_definition_sha':definition['definition_sha'],'definition':{'definition_version':1,'columns':[{'header':'后续字段','promoted':True,'field':'later_field','type':'text','rules':{}}]}})
  later=result(f.service(f.admin,'files.row_read',{'table':table,'row_id':rid}));definition=result(f.service(f.admin,'files.promotion_definition',{'table':table}))
  check('later promotion preserves column/value/row identity and changes source to formal database',later['row_id']==rid and later['source']['后续字段']=='database' and later['cells']['后续字段']['value']=='READY' and definition['columns'][0]['field']=='later_field' and read()['headers'][-1]=='后续字段')
  act('files.sheet_column_append',{**latched(),'header':'日期','op_id':f.prefix+'-date-column'})
  act('files.sheet_input_write',{**latched(),'start_row':0,'start_col':4,'value':{'type':'date','value':'2026-10-19'},'op_id':f.prefix+'-date-value'})
  act('files.sheet_style_write',{**latched(),'cells':[{'row_id':rid,'header':'外链金额'}],'style':{'font_size':14,'font_color':'#123ABC','bold':True},'op_id':f.prefix+'-style'})
  act('files.sheet_row_heights_write',{**latched(),'row_heights':{'2':42}})
  act('files.sheet_layout_update',{**latched(),'column_widths':{'2':22}})
  latest=result(f.service(f.admin,'files.versions',{'file':table}));status,downloaded=f.t.download(f.admin,table,latest['current']['frappe_file']);assert status==200
  exported=load_workbook(BytesIO(downloaded['_bytes'])).active
  check('date/font/row-height/column-width persist through independent export read',exported['E2'].value.isoformat().startswith('2026-10-19') and exported['B2'].value==42.5 and exported['B2'].number_format=='0.00' and exported['B2'].font.sz==14 and exported['B2'].font.bold and exported['B2'].font.color.rgb.endswith('123ABC') and exported.row_dimensions[2].height==42 and exported.column_dimensions['B'].width==22)
  status,original=f.t.download(f.admin,table,originals[0]['frappe_file']);check('later ordinary/formal/style writes still leave original version byte-identical',status==200 and original['_bytes']==source)
  print('SOURCE',json.dumps({'sha256':digest,'bytes':len(source),'table':table,'original_ref':originals[0]['frappe_file'],'current_ref':current_ref}),flush=True)
 finally:f.cleanup()
 return f.finish()
if __name__=='__main__':raise SystemExit(main())
