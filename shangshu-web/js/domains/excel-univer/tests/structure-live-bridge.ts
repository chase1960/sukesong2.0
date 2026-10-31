/** Real frontend adapter -> real 3850 HTTP. fetch wrapper supplies browser URL/cookies only. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openTable} from '../src/backend.ts';
import {exportCurrentTable} from '../src/export-helper.ts';
const root=resolve(import.meta.dirname,'../../../../..');
const base='http://127.0.0.1:3850';


const nativeFetch=globalThis.fetch;const cookies=new Map<string,string>();const requests:{path:string;status:number}[]=[];
function python(args:string[]){return execFileSync('python3',args,{cwd:root,encoding:'utf8',maxBuffer:2e6});}
// The existing credentials helper reads this dedicated runtime; never print the secret.
const password=python(['-c',"import sys;sys.path.insert(0,'shangshu-server/scripts/tests');from _ss_cred import admin_pw_for;print(admin_pw_for('http://127.0.0.1:3850'),end='')"]);
globalThis.fetch=async(input:any,init:any={})=>{
 const url=new URL(typeof input==='string'?input:input.url,base);assert.equal(url.origin,base);
 const headers=new Headers(init.headers);if(cookies.size)headers.set('cookie',[...cookies].map(([k,v])=>k+'='+v).join('; '));
 const response=await nativeFetch(url,{...init,headers});
 for(const raw of response.headers.getSetCookie()){const pair=raw.split(';')[0];const split=pair.indexOf('=');cookies.set(pair.slice(0,split),pair.slice(split+1));}
 requests.push({path:url.pathname,status:response.status});return response;
};
let file='';
async function action(id:string,payload:any,key=randomUUID()) {
 const response=await fetch('/api/platform/actions/'+id+'/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload,confirmed:true,idempotency_key:key,source:'user'})});
 const body:any=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.result??body.receipt?.result;
}
try {
 const login=await fetch('/api/platform/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'Administrator',password})});assert.equal(login.status,200);
 const content=python(['-c',"from openpyxl import Workbook;from openpyxl.styles import Font;from io import BytesIO;import base64;w=Workbook();s=w.active;s.append(['项目','金额','公式','备注']);s.append(['甲',10,'=SUM(B2:B3)','a']);s.append(['乙',20,None,'b']);s['D2'].font=Font(bold=True);s.column_dimensions['D'].width=27;b=BytesIO();w.save(b);print(base64.b64encode(b.getvalue()).decode(),end='')"]);
 file=(await action('files.upload',{file_name:'UI030-'+randomUUID()+'.xlsx',directory:'/',content_base64:content,attribution:{level:'personal',owner_user:'Administrator'}})).file;
 console.log('FIXTURE',file);
 const table=await openTable(file);const initial=await table.loadPage(1,100);const ids=initial.rows.map(r=>r.name);assert.equal(ids.length,2);
 const inserted=await table.insertRows(ids[1],1,randomUUID());assert.equal(inserted.rowIds.length,1);
 let page=await table.loadPage(1,100);assert.deepEqual(page.rows.map(r=>r.name),[ids[0],inserted.rowIds[0],ids[1]]);assert.equal(page.rows[0]['公式'],30);
 await table.structureAction('row_move',ids[1],randomUUID(),ids[0]);page=await table.loadPage(1,100);assert.equal(page.rows[0].name,ids[1]);assert.equal(page.rows.find(r=>r.name===ids[0])?.['公式'],30);
 await table.deleteRow(ids[1],randomUUID());page=await table.loadPage(1,100);assert.ok(!page.rows.some(r=>r.name===ids[1]));assert.ok((await openTable(file)).deletedRows?.some(r=>r.rowId===ids[1]));
 await table.structureAction('row_restore',ids[1],randomUUID());page=await table.loadPage(1,100);assert.equal(page.rows[0].name,ids[1]);
 await table.insertColumn('金额','新列',randomUUID());await table.refreshMeta();assert.equal(table.columns[1].fieldId,'新列');
 await table.structureAction('column_move','备注',randomUUID(),'项目');await table.refreshMeta();assert.equal(table.columns[0].fieldId,'备注');
 const op=randomUUID();await table.deleteColumn('新列',op);await table.refreshMeta();assert.ok(!table.columns.some(c=>c.fieldId==='新列'));
 await table.structureAction('structure_undo',op,randomUUID());await table.refreshMeta();assert.ok(table.columns.some(c=>c.fieldId==='新列'));
 await assert.rejects(()=>table.deleteColumn('金额',randomUUID()),/公式引用/);
 const current=await table.loadPage(1,100);assert.equal(current.rows.find(r=>r.name===ids[0])?.['公式'],30);
 const structural=randomUUID();await table.insertColumn(null,'逆向检查',structural);await table.refreshMeta();
 writeFileSync(resolve(root,'docs/reports/r967-20261019/structure-before-values.xlsx'),Buffer.from((await exportCurrentTable(file,'xlsx')).bytes));
 const cellOp=randomUUID();await action('files.sheet_cells_write',{table:file,cells:[{row_id:ids[0],header:'备注',value:{type:'text',value:'临时修改'}}],op_id:cellOp,expected_content_version:table.contentVersion,expected_structure_version:table.structureVersion});
 await action('files.sheet_cells_undo',{table:file,op_id:cellOp});await table.refreshMeta();
 writeFileSync(resolve(root,'docs/reports/r967-20261019/structure-after-values-undo.xlsx'),Buffer.from((await exportCurrentTable(file,'xlsx')).bytes));
 await table.structureAction('structure_undo',structural,randomUUID());await table.refreshMeta();assert.ok(!table.columns.some(c=>c.fieldId==='逆向检查'));
 python(['-c',"from openpyxl import load_workbook;from pathlib import Path;p=Path('docs/reports/r967-20261019');a=load_workbook(p/'structure-before-values.xlsx').active;b=load_workbook(p/'structure-after-values-undo.xlsx').active;assert a['A3'].value==b['A3'].value=='a';assert a['A3'].number_format==b['A3'].number_format=='General';assert a['A3'].font.bold and b['A3'].font.bold"]);
 console.log('PASS UI030 actual frontend adapter / HTTP insert move soft-delete restore column-delete undo formula dependency',requests.length);
} catch(error) {console.error('PRIMARY_FAILURE',error);throw error;} finally {
 if(file){await action('files.recycle',{file});console.log('RECYCLED',file);}
 globalThis.fetch=nativeFetch;
}
