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


const serverTimings:any[]=[];
const nativeFetch=globalThis.fetch;const cookies=new Map<string,string>();const requests:{path:string;status:number}[]=[];
function python(args:string[]){return execFileSync('python3',args,{cwd:root,encoding:'utf8',maxBuffer:2e6});}
// The existing credentials helper reads this dedicated runtime; never print the secret.
const password=python(['-c',"import sys;sys.path.insert(0,'shangshu-server/scripts/tests');from _ss_cred import admin_pw_for;print(admin_pw_for('http://127.0.0.1:3850'),end='')"]);
globalThis.fetch=async(input:any,init:any={})=>{
 const url=new URL(typeof input==='string'?input:input.url,base);assert.equal(url.origin,base);
 const headers=new Headers(init.headers);if(cookies.size)headers.set('cookie',[...cookies].map(([k,v])=>k+'='+v).join('; '));
 const response=await nativeFetch(url,{...init,headers});
 for(const raw of response.headers.getSetCookie()){const pair=raw.split(';')[0];const split=pair.indexOf('=');cookies.set(pair.slice(0,split),pair.slice(split+1));}
 requests.push({path:url.pathname,status:response.status});
 if(url.pathname.includes('sheet_')&&response.ok){const body:any=await response.clone().json();serverTimings.push({path:url.pathname,timing:(body.result??body.receipt?.result)?.timing});}
 return response;
};
let file='';
async function action(id:string,payload:any,key=randomUUID()) {
 const response=await fetch('/api/platform/actions/'+id+'/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload,confirmed:true,idempotency_key:key,source:'user'})});
 const body:any=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.result??body.receipt?.result;
}
try {
 const login=await fetch('/api/platform/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'Administrator',password})});assert.equal(login.status,200);
 const standard=JSON.parse(readFileSync(resolve(root,'docs/reports/r967-20261019/perf-standard-handle.json'),'utf8'));
 const exported=await exportCurrentTable(standard.file,'xlsx');
 const exportPath=resolve(root,'docs/reports/r967-20261019/perf-formula-export.xlsx');writeFileSync(exportPath,Buffer.from(exported.bytes));
 python(['-c',"from openpyxl import load_workbook;from pathlib import Path;p=Path('docs/reports/r967-20261019/perf-formula-export.xlsx');v=load_workbook(p,data_only=True,read_only=True).worksheets[0];rows=list(v.iter_rows(min_row=2,max_row=11,max_col=50,values_only=True));assert rows[0][49]==sum(row[1] for row in rows);f=load_workbook(p,data_only=False,read_only=True).worksheets[0];assert f.cell(2,50).value=='=SUM(B2:B11)';print('PASS standard exported formula text and recalculated cache')"]);
 console.log('PASS formula export cache/text');
 const source='/path/to/workspace';
 const bytes=readFileSync(source);const results:any={bytes:bytes.length,source_sha256:(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'),deployed:process.env.SS_DEPLOYED_REV||'coordinator-window',phase:process.env.SS_PHASE||'legacy-initialization',budget_revision:'2026-10-19 user approved 3000ms save/paste/inverse',timings_ms:{}};
 assert.equal(results.source_sha256,'f52326d845aef21c7f8f20dc3abdae4a67fc58811ba28d909f7e63ec9ee6a6b3');
 const measure=async(name:string,fn:()=>Promise<any>)=>{const t=performance.now();const value=await fn();results.timings_ms[name]=performance.now()-t;results.server_timings=serverTimings;console.log(name,Math.round(results.timings_ms[name]));writeFileSync(resolve(root,'docs/reports/r967-20261019/perf-real-chain'+(process.env.SS_RUN_SUFFIX||'-attempt2')+'.json'),JSON.stringify(results,null,2));return value;};
 if(process.env.SS_REUSE_FILE){
  assert.equal(process.env.SS_REUSE_FILE,'19minpu715','only this exact retained fixture may be restored');
  file=process.env.SS_REUSE_FILE;if(process.env.SS_REUSE_ACTIVE!=='1')await measure('restore_existing_fixture',()=>action('files.restore',{file}));results.reused=true;results.previously_active=process.env.SS_REUSE_ACTIVE==='1';
 }else{
 file=(await measure('upload',()=>action('files.upload',{file_name:'PERF-REAL-15517-'+randomUUID()+'.xlsx',directory:'/',content_base64:bytes.toString('base64'),attribution:{level:'personal',owner_user:'Administrator'}}))).file;
 }
 results.file=file;console.log('FIXTURE',file);
 const table=await measure('open',()=>openTable(file));const page=await table.loadPage(1,100);results.rows=page.total;results.columns=table.columns.length;assert.ok(page.total>=15000);
 const column=table.columns.find(c=>!c.readOnly&&c.type==='text');assert.ok(column);const col=table.columns.indexOf(column);const value='PERF-LIVE-'+randomUUID();
 const written=await measure('single_commit',()=>table.writeCell({rowId:page.rows[0].name,fieldId:column.fieldId,fieldType:column.type,value,text:value,idempotencyKey:randomUUID()}));assert.notEqual(written.kind,'rejected',JSON.stringify(written));
 const fresh=await openTable(file);assert.equal((await fresh.loadPage(1,100)).rows[0][column.fieldId],value);
 const search=await measure('search',()=>table.search(value,100));assert.equal(search.total,1);
 const matrix=Array.from({length:50},(_,i)=>['PERF-RANGE-'+i]);
 await measure('paste_50',()=>table.pasteApply!({startRow:0,startCol:col,matrix,matrixTypes:matrix.map(()=>['text']),extend:false,opId:randomUUID()}));
 const readback=await table.loadPage(1,100);for(let i=0;i<50;i++)assert.equal(readback.rows[i][column.fieldId],matrix[i][0]);
 const downloaded=await measure('export',()=>exportCurrentTable(file,'xlsx'));const out=resolve(root,'docs/reports/r967-20261019/perf-real-export.xlsx');writeFileSync(out,Buffer.from(downloaded.bytes));
 python(['-c',"from openpyxl import load_workbook;w=load_workbook('docs/reports/r967-20261019/perf-real-export.xlsx',read_only=True);s=w.worksheets[0];c="+String(col+1)+";assert [s.cell(r,c).value for r in range(2,52)]==['PERF-RANGE-'+str(i) for i in range(50)]"]);
 results.functional_pass=true;results.performance_pass=results.timings_ms.single_commit<=3000&&results.timings_ms.search<=1000&&results.timings_ms.paste_50<=3000;results.budgets_ms={single_commit:3000,search:1000,paste_50:3000};writeFileSync(resolve(root,'docs/reports/r967-20261019/perf-real-chain'+(process.env.SS_RUN_SUFFIX||'-attempt2')+'.json'),JSON.stringify(results,null,2));console.log('PASS real file actual adapter chain');
} catch(error) {const report=resolve(root,'docs/reports/r967-20261019/perf-real-chain'+(process.env.SS_RUN_SUFFIX||'-attempt2')+'.json');if(existsSync(report)){const saved=JSON.parse(readFileSync(report,'utf8'));writeFileSync(report,JSON.stringify({...saved,functional_pass:false,performance_pass:false,failure:String(error)},null,2));}console.error('PRIMARY_FAILURE',error);throw error;} finally {
 if(file){await action('files.recycle',{file});console.log('RECYCLED',file);}
 globalThis.fetch=nativeFetch;
}
