"""Protocol-boundary controlled IMAP; production parser/sync/queue/import unchanged."""
import json,sys
from test_process_provenance_live import console
r=json.load(sys.stdin);f=r['fixture']
code='USER='+repr(f['user'])+'\nPREFIX='+repr(f['prefix'])+'\n'+'''
import io,json,hashlib,base64
from email.message import EmailMessage
from shangshu_core.public_api import execute_registered_action
from shangshu_mail import account,transport
from openpyxl import Workbook
frappe.set_user(USER)
with account.writing():
 key=account.account_name()
 if not frappe.db.exists('Shangshu Mail Account',key):
  frappe.get_doc({'doctype':'Shangshu Mail Account','account_key':key,'kind':'personal','email_address':USER,'enabled':1,'connection_status':'connected'}).insert(ignore_permissions=True)
original_binding=frappe.db.get_value('Shangshu Mail Account',key,'email_account')
credential_fixture=frappe.get_doc({'doctype':'Email Account','email_account_name':PREFIX,'email_id':USER,'enable_incoming':0,'enable_outgoing':0}).insert(ignore_permissions=True)
with account.writing():frappe.db.set_value('Shangshu Mail Account',key,'email_account',credential_fixture.name)
frappe.db.commit()
w=Workbook();w.active.append(['项目','金额']);w.active.append(['合成甲',731.25]);buffer=io.BytesIO();w.save(buffer)
small=buffer.getvalue()
from zipfile import ZipFile,ZIP_STORED
def docx(padding):
 b=io.BytesIO()
 with ZipFile(b,'w',ZIP_STORED) as z:
  z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>UI066 synthetic preview 731.25</w:t></w:r></w:p></w:body></w:document>')
  z.writestr('padding.bin',padding)
 return b.getvalue()
large=docx(b'x'*(10*1024*1024-len(docx(b''))));assert len(large)==10*1024*1024
m=EmailMessage();m['From']='synthetic.sender@example.invalid';m['To']=USER;m['Subject']=PREFIX+' IMAP attachment continuity';m['Message-ID']='<'+PREFIX+'@example.invalid>'
m.set_content('来信核对结论：合成甲金额应更新为862.40。请保留附件原始金额供核对，不要发送。')
m.add_alternative('<p>合成来信核对金额 <b>862.40</b></p><table><tr><td>合成甲</td><td>862.40</td></tr></table>','html')
m.add_attachment(small,maintype='application',subtype='vnd.openxmlformats-officedocument.spreadsheetml.sheet',filename=PREFIX+'.xlsx')
m.add_attachment(large,maintype='application',subtype='vnd.openxmlformats-officedocument.wordprocessingml.document',filename=PREFIX+'-10MiB.docx')
raw=m.as_bytes();assert len(raw)<transport.MAX_MESSAGE_BYTES
commands=[]
class Connection:
 def uid(self,command,*args):
  commands.append([command,*args])
  if command=='search':return 'OK',[b'101']
  if command=='fetch' and args[1]=='(RFC822.SIZE)':return 'OK',[('101 (RFC822.SIZE '+str(len(raw))+')').encode()]
  if command=='fetch' and args[1]=='(BODY.PEEK[])':return 'OK',[(b'101',raw)]
  raise AssertionError('unexpected mutating IMAP command')
 def response(self,key):assert key=='UIDVALIDITY';return key,[b'1001']
 def close(self):pass
 def logout(self):pass
old_session=transport.imap_session;old_credentials=account.credentials
try:
 transport.imap_session=lambda *a:Connection()
 account.credentials=lambda binding:(USER,'controlled-not-a-credential')
 first=execute_registered_action('mail.sync',{},confirmed=True,idempotency_key=PREFIX+'-sync-first')['result'];frappe.db.commit()
 second=execute_registered_action('mail.sync',{},confirmed=True,idempotency_key=PREFIX+'-sync-repeat')['result'];frappe.db.commit()
 assert first['added']==1 and not first['errors'],first
 assert second['added']==0 and second['skipped']==1 and not second['errors'],second
 assert sum(1 for c in commands if c[0]=='fetch' and c[2]=='(BODY.PEEK[])')==1
 rows=frappe.get_all('Shangshu Mail Message',filters={'owner':USER,'message_id':m['Message-ID']},fields=['name','attachment_ids_json'])
 assert len(rows)==1
 ids=json.loads(rows[0].attachment_ids_json);assert len(ids)==2
 RESULT.update({'mail':rows[0].name,'attachments':ids,'first':first['added'],'repeat_skipped':second['skipped'],'body_fetches':1,'large_bytes':len(large),'large_sha256':hashlib.sha256(large).hexdigest(),'small_sha256':hashlib.sha256(small).hexdigest()})
finally:
 transport.imap_session=old_session;account.credentials=old_credentials
 with account.writing():frappe.db.set_value('Shangshu Mail Account',key,'email_account',original_binding)
 frappe.delete_doc('Email Account',credential_fixture.name,ignore_permissions=True)
 frappe.db.commit()
'''
print(json.dumps(console(code)))
