/** Independent 1000x8 / 1000x30 mixed-type datasets through actual frontend adapter + HTTP. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {openTable} from '../src/backend.ts';
const root=resolve(import.meta.dirname,'../../../../..'),base='http://127.0.0.1:3850';
const width=Number(process.argv[2]);assert.ok([8,30].includes(width));
const report=resolve(root,`docs/reports/r967-20261019/perf-daily-1000x${width}${process.env.SS_RUN_SUFFIX||''}.json`);
const python=(args:string[])=>execFileSync('python3',args,{cwd:root,encoding:'utf8',maxBuffer:8e6});
const password=python(['-c',"import sys;sys.path.insert(0,'shangshu-server/scripts/tests');from _ss_cred import admin_pw_for;print(admin_pw_for('http://127.0.0.1:3850'),end='')"]);
const nativeFetch=globalThis.fetch,cookies=new Map<string,string>();let requests=0,file='';
const result:any={frontend_commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),backend_commit:process.env.SS_DEPLOYED_REV,shape:{rows:1000,columns:width},samples:20,budget_revision:'2026-10-19 user approved 3000ms save/paste/inverse; search remains 1000ms',metrics:{},started:new Date().toISOString()};
const save=()=>{result.requests=requests;writeFileSync(report,JSON.stringify(result,null,2));};
globalThis.fetch=async(input:any,init:any={})=>{const url=new URL(typeof input==='string'?input:input.url,base);assert.equal(url.origin,base);const headers=new Headers(init.headers);if(cookies.size)headers.set('cookie',[...cookies].map(([k,v])=>k+'='+v).join('; '));const response=await nativeFetch(url,{...init,headers});for(const raw of response.headers.getSetCookie()){const pair=raw.split(';')[0],split=pair.indexOf('=');cookies.set(pair.slice(0,split),pair.slice(split+1));}requests++;return response;};
async function action(id:string,payload:any,key=randomUUID()){const response=await fetch('/api/platform/actions/'+id+'/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload,confirmed:true,idempotency_key:key,source:'user'})});const body:any=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.result??body.receipt?.result;}
async function measure(name:string,budget:number,fn:(i:number)=>Promise<void>){const m:any={budget_ms:budget,samples_ms:[]};result.metrics[name]=m;for(let i=0;i<20;i++){const start=performance.now();await fn(i);m.samples_ms.push(performance.now()-start);save();console.log(name,i+1,Math.round(m.samples_ms.at(-1)));if(m.samples_ms.at(-1)>budget*2){m.pass=false;save();throw Error(name+' exceeds 2x budget');}}const sorted=[...m.samples_ms].sort((a,b)=>a-b);m.p95_ms=sorted[18]+.95*(sorted[19]-sorted[18]);m.max_ms=sorted[19];m.pass=m.p95_ms<=budget&&m.max_ms<=budget*2;save();console.log('SUMMARY',name,m.p95_ms,m.pass);}
try{
 const login=await fetch('/api/platform/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'Administrator',password})});assert.equal(login.status,200);
 const content=python(['-c',`from openpyxl import Workbook\nfrom io import BytesIO\nimport datetime,base64\nw=Workbook(write_only=True);s=w.create_sheet('日常工作');s.append(['C'+str(i+1) for i in range(${width})])\nfor r in range(1000):\n row=['编号-%04d'%r,r+0.25,datetime.date(2026,10,1+r%28),r%2==0]+[('中文业务记录-%04d-字段%d'%(r,c)) if c%2==0 else r+c/100 for c in range(4,${width})]\n s.append(row)\nb=BytesIO();w.save(b);print(base64.b64encode(b.getvalue()).decode(),end='')`]);
 result.fixture_bytes=Buffer.from(content,'base64').length;result.fixture_sha256=createHash('sha256').update(Buffer.from(content,'base64')).digest('hex');result.nonempty_ratio=1;result.fixture_types=['Chinese text identifiers','decimal','date','boolean','Chinese text/decimal'];
 file=(await action('files.upload',{file_name:`PERF-DAILY-1000x${width}-`+randomUUID()+'.xlsx',directory:'/',content_base64:content,attribution:{level:'personal',owner_user:'Administrator'}})).file;result.file=file;save();console.log('FIXTURE',file);
 const start=performance.now(),table=await openTable(file),initial=await table.loadPage(1,100);result.open_ms=performance.now()-start;assert.equal(initial.total,1000);assert.equal(table.columns.length,width);assert.equal(initial.rows[0].C1,'编号-0000');assert.equal(initial.rows[0].C2,.25);assert.equal(initial.rows[0].C4,true);assert.equal(initial.rows[1].C4,false);assert.match(String(initial.rows[0].C3),/^2026-10-01/);
 const initialNumbers=initial.rows.slice(0,50).map(row=>row.C2),singleOps:string[]=[],pasteOps:string[]=[];
 await measure('single_commit',3000,async i=>{const op=singleOps[i]=randomUUID();const r=await table.writeCell({rowId:initial.rows[0].name,fieldId:'C2',fieldType:table.columns[1].type,value:10000+i,text:String(10000+i),idempotencyKey:op});assert.notEqual(r.kind,'rejected',JSON.stringify(r));});
 assert.equal((await table.loadPage(1,100)).rows[0].C2,10019);
 const undo=async(op:string,count:number)=>{const r=await action('files.sheet_cells_undo',{table:file,op_id:op});assert.equal(r.applied,count);table.adoptVersions?.({contentVersion:r.content_version,structureVersion:r.structure_version});};
 await measure('single_undo',3000,i=>undo(singleOps[19-i],1));assert.equal((await table.loadPage(1,100)).rows[0].C2,.25);
 await measure('search_tail',1000,async i=>{const term='编号-'+String(999-i).padStart(4,'0');const r=await table.search(term,100);assert.equal(r.total,1);assert.equal(r.rows[0].C1,term);});
 await measure('search_absent',1000,async i=>assert.equal((await table.search('不存在的编号-'+i,100)).total,0));
 await measure('paste_50',3000,async i=>{const matrix=Array.from({length:50},(_,r)=>[String(20000+i*100+r)]);const r=await table.pasteApply!({startRow:0,startCol:1,matrix,matrixTypes:matrix.map(()=>['number']),extend:false,opId:pasteOps[i]=randomUUID()});assert.equal(r.cells.length,50);});
 assert.deepEqual((await table.loadPage(1,100)).rows.slice(0,50).map(row=>row.C2),Array.from({length:50},(_,r)=>21900+r));
 await measure('undo_50',3000,i=>undo(pasteOps[19-i],50));assert.deepEqual((await table.loadPage(1,100)).rows.slice(0,50).map(row=>row.C2),initialNumbers);
 if(width===30){const beforeVersion=table.contentVersion,before=await table.loadPage(1,100);await assert.rejects(()=>table.pasteApply!({startRow:0,startCol:0,matrix:Array.from({length:1000},()=>Array(30).fill('超限')),matrixTypes:Array.from({length:1000},()=>Array(30).fill('text')),extend:false,opId:randomUUID()}),/20000|20,000|最多/);const fresh=await openTable(file);assert.equal(fresh.contentVersion,beforeVersion);assert.deepEqual((await fresh.loadPage(1,100)).rows,before.rows);result.overlimit_30000='rejected; content version and independent readback unchanged';}
 result.functional_pass=true;result.performance_pass=Object.values(result.metrics).every((m:any)=>m.pass);save();assert.ok(result.performance_pass,'performance budget failed');console.log('PASS independent daily dataset',width);
}catch(error){result.failure=String(error);save();throw error;}finally{try{if(file){await action('files.recycle',{file});result.cleanup='recycled exact fixture';save();console.log('RECYCLED',file);}}finally{globalThis.fetch=nativeFetch;}}
