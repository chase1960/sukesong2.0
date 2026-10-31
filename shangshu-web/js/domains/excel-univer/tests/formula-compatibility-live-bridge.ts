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
 const content=python(['-c',"from openpyxl import Workbook;from io import BytesIO;import base64,zipfile,re;w=Workbook();s=w.active;s.title='Main';s.append(['值','旧公式','依赖','新公式','查找','今天']);s.append([8,'=TEXT(A2,\"0\")','=B2',None,'=VLOOKUP(A2,A2:B3,2,FALSE)','=TODAY()']);s.append([9,'=TEXT(A3,\"0\")',None,None,None,None]);o=w.create_sheet('Other');o['A1']='=Main!B2';b=BytesIO();w.save(b);out=BytesIO();z=zipfile.ZipFile(b);d=zipfile.ZipFile(out,'w');[(d.writestr(i,re.sub(rb'<v></v>',b'<v>999999</v>',z.read(i.filename))) if i.filename.startswith('xl/worksheets/') else d.writestr(i,z.read(i.filename))) for i in z.infolist()];d.close();print(base64.b64encode(out.getvalue()).decode(),end='')"]);
 file=(await action('files.upload',{file_name:'FORMULA-COMPAT-'+randomUUID()+'.xlsx',directory:'/',content_base64:content,attribution:{level:'personal',owner_user:'Administrator'}})).file;console.log('FIXTURE',file);
 const table=await openTable(file);const initial=await table.loadPage(1,100);const rowId=initial.rows[0].name;
 const edited=await table.writeCell({rowId,fieldId:'值',fieldType:'decimal',value:10,text:'10',idempotencyKey:randomUUID()});assert.notEqual(edited.kind,'rejected',JSON.stringify(edited));
 let page=await table.loadPage(1,100);assert.equal(page.rows[0]['值'],10);assert.equal(page.rows[0]['旧公式'],'待计算');assert.equal(page.rows[0]['依赖'],'待计算');assert.equal((await table.search('999999',100)).total,0);
 const first=randomUUID();await table.inputWrite!({startRow:0,startCol:3,matrix:[['=SUM(A2:A3)']],matrixTypes:[['formula']],extend:false,opId:first});page=await table.loadPage(1,100);assert.equal(page.rows[0]['新公式'],19);
 const second=randomUUID();await table.inputWrite!({startRow:0,startCol:3,matrix:[['=A2*3']],matrixTypes:[['formula']],extend:false,opId:second});page=await table.loadPage(1,100);assert.equal(page.rows[0]['新公式'],30);
 let inverse=await action('files.sheet_cells_undo',{table:file,op_id:second});table.adoptVersions?.({contentVersion:inverse.content_version,structureVersion:inverse.structure_version});assert.equal((await table.loadPage(1,100)).rows[0]['新公式'],19);
 const third=randomUUID();await table.inputWrite!({startRow:0,startCol:3,matrix:[['5']],matrixTypes:[['number']],extend:false,opId:third});assert.equal((await table.loadPage(1,100)).rows[0]['新公式'],5);
 inverse=await action('files.sheet_cells_undo',{table:file,op_id:third});table.adoptVersions?.({contentVersion:inverse.content_version,structureVersion:inverse.structure_version});assert.equal((await table.loadPage(1,100)).rows[0]['新公式'],19);
 await assert.rejects(()=>table.inputWrite!({startRow:0,startCol:3,matrix:[['=TEXT(A2,"0")']],matrixTypes:[['formula']],extend:false,opId:randomUUID()}),/不支持/);
 await assert.rejects(()=>table.inputWrite!({startRow:0,startCol:3,matrix:[['=D2']],matrixTypes:[['formula']],extend:false,opId:randomUUID()}),/循环/);
 const downloaded=await exportCurrentTable(file,'xlsx');const out=resolve(root,'docs/reports/r967-20261019/formula-compat-export.xlsx');writeFileSync(out,Buffer.from(downloaded.bytes));
 python(['-c',"from openpyxl import load_workbook;p='docs/reports/r967-20261019/formula-compat-export.xlsx';f=load_workbook(p,data_only=False);v=load_workbook(p,data_only=True);assert f['Main']['B2'].value.startswith('=TEXT(');assert f['Other']['A1'].value=='=Main!B2';assert v['Main']['B2'].value is None;assert v['Main']['C2'].value is None;assert v['Other']['A1'].value is None;assert v['Main']['D2'].value==19;assert f.calculation.fullCalcOnLoad"]);
 console.log('PASS imported pending propagation / no stale search-export / actual adapter add replace remove inverse / unsupported new input and cycle zero-write',requests.length);
} catch(error) {console.error('PRIMARY_FAILURE',error);throw error;} finally {
 if(file){await action('files.recycle',{file});console.log('RECYCLED',file);}
 globalThis.fetch=nativeFetch;
}
