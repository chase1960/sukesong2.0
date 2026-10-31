/** Real frontend adapter -> real 3850 HTTP. fetch wrapper supplies browser URL/cookies only. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {openTable} from '../src/backend.ts';

const root=resolve(import.meta.dirname,'../../../../..');
const base='http://127.0.0.1:3850';


const timings:any[]=[];const pendingTiming:Promise<void>[]=[];
const nativeFetch=globalThis.fetch;const cookies=new Map<string,string>();const requests:{path:string;status:number}[]=[];
function python(args:string[]){return execFileSync('python3',args,{cwd:root,encoding:'utf8',maxBuffer:16e6});}
// The existing credentials helper reads this dedicated runtime; never print the secret.
const password=python(['-c',"import sys;sys.path.insert(0,'shangshu-server/scripts/tests');from _ss_cred import admin_pw_for;print(admin_pw_for('http://127.0.0.1:3850'),end='')"]);
globalThis.fetch=async(input:any,init:any={})=>{
 const url=new URL(typeof input==='string'?input:input.url,base);assert.equal(url.origin,base);
 const headers=new Headers(init.headers);if(cookies.size)headers.set('cookie',[...cookies].map(([k,v])=>k+'='+v).join('; '));
 const response=await nativeFetch(url,{...init,headers});
 for(const raw of response.headers.getSetCookie()){const pair=raw.split(';')[0];const split=pair.indexOf('=');cookies.set(pair.slice(0,split),pair.slice(split+1));}
 requests.push({path:url.pathname,status:response.status});
 if(url.pathname.includes('sheet_'))pendingTiming.push(response.clone().json().then((body:any)=>{timings.push(body.result?.timing??body.receipt?.result?.timing??body.timing??null);}).catch(()=>{}));
 return response;
};
// 2026-10-19 user explicitly relaxed save/paste/inverse 2s gates to 3s. Search unchanged.
const mode=process.argv[2]||'run';const phase=process.argv[3]||'single-search';
const handle=resolve(root,'docs/reports/r967-20261019/perf-standard-handle.json');
const output=resolve(root,'docs/reports/r967-20261019/perf-standard-'+phase+(process.env.SS_RUN_SUFFIX||'')+'.json');
const result:any={frontend_commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),backend_commit:process.env.SS_DEPLOYED_REV||'coordinator-deployment-window',timestamp:new Date().toISOString(),base,shape:{rows:10000,columns:50},samples:20,phase,budget_revision:'2026-10-19 user approved 3000ms save/paste/inverse',metrics:{},requests:0};
function save(){result.requests=requests.length;writeFileSync(output,JSON.stringify(result,null,2));}
async function action(id:string,payload:any,key=randomUUID()) {
 const response=await fetch('/api/platform/actions/'+id+'/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload,confirmed:true,idempotency_key:key,source:'user'})});const body:any=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.result??body.receipt?.result;
}
async function measure(name:string,budget:number,run:(i:number)=>Promise<void>){
 const metric:any={budget_ms:budget,common_operation_goal_ms:500,samples_ms:[]};result.metrics[name]=metric;
 for(let i=0;i<20;i++){const start=performance.now();try{await run(i);metric.samples_ms.push(performance.now()-start);}catch(error){metric.failure=String(error);save();throw error;}save();console.log(name,i+1,Math.round(metric.samples_ms.at(-1)));if(i===0&&metric.samples_ms[0]>budget*2){await Promise.all(pendingTiming);result.server_timings=timings;metric.stopped_for_profile=true;save();throw Error(name+' first sample exceeds 2x hard budget; retain sample and profile before repeating');}}
 const sorted=[...metric.samples_ms].sort((a,b)=>a-b);metric.p95_ms=sorted[18]+0.95*(sorted[19]-sorted[18]);metric.max_ms=sorted[19];metric.goal_500ms=metric.p95_ms<=500;metric.pass=metric.p95_ms<=budget&&metric.max_ms<=budget*2;console.log('SUMMARY',name,JSON.stringify(metric));save();
}
try{
 const login=await fetch('/api/platform/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'Administrator',password})});assert.equal(login.status,200);
 if(mode==='prepare'){
  assert.ok(!existsSync(handle),'existing handle; reuse or explicitly clean it first');
  const content=python(['-c',"from openpyxl import Workbook;from io import BytesIO;import base64;w=Workbook(write_only=True);s=w.create_sheet('数据');s.append(['C'+str(i+1) for i in range(50)]);[s.append(['record-'+str(r)]+[r+c for c in range(1,50)]) for r in range(10000)];b=BytesIO();w.save(b);print(base64.b64encode(b.getvalue()).decode(),end='')"]);
  const r=await action('files.upload',{file_name:'PERF-10000x50-'+randomUUID()+'.xlsx',directory:'/',content_base64:content,attribution:{level:'personal',owner_user:'Administrator'}});
  writeFileSync(handle,JSON.stringify({file:r.file,bytes:Buffer.from(content,'base64').length,sha256:createHash('sha256').update(Buffer.from(content,'base64')).digest('hex'),rows:10000,columns:50,state:'ready'},null,2));console.log('PREPARED',r.file);}
 else{
  const fixture=JSON.parse(readFileSync(handle,'utf8'));assert.equal(fixture.state,'ready');result.fixture=fixture;
  if(mode==='cleanup'){await action('files.recycle',{file:fixture.file});writeFileSync(handle,JSON.stringify({...fixture,state:'recycled'},null,2));console.log('RECYCLED',fixture.file);}
  else{
   const start=performance.now();const table=await openTable(fixture.file);const initial=await table.loadPage(1,100);result.open_ms=performance.now()-start;assert.equal(initial.total,10000);assert.equal(table.columns.length,50);const rid=initial.rows[0].name;
   if(phase==='single-search'){
    await measure('single_commit',3000,async i=>{const value=100001+i;const r=await table.writeCell({rowId:rid,fieldId:'C2',fieldType:table.columns.find(c=>c.fieldId==='C2')!.type,value,text:String(value),idempotencyKey:randomUUID()});assert.notEqual(r.kind,'rejected',JSON.stringify(r));});
    const reloaded=await openTable(fixture.file);assert.equal((await reloaded.loadPage(1,100)).rows[0]['C2'],100020);
    await measure('search_tail',1000,async i=>{const r=await table.search('record-'+(9999-i),100);assert.equal(r.total,1);assert.equal(r.rows[0]['C1'],'record-'+(9999-i));});
    await measure('search_absent',1000,async i=>{assert.equal((await table.search('absent-'+i,100)).total,0);});
   }else if(phase==='batch'){
    for(const [cells,budget] of [[50,3000],[4000,5000],[20000,10000]]){
     const width=cells===50?10:20,height=cells/width;
     const operations:string[]=[];
     await measure('paste_'+cells,budget,async i=>{const matrix=Array.from({length:height},(_,r)=>Array.from({length:width},(_,c)=>String(200000+i+r*width+c)));const r=await table.pasteApply!({startRow:0,startCol:1,matrix,matrixTypes:matrix.map(row=>row.map(()=>'number')),extend:false,opId:(operations[i]=randomUUID())});assert.equal(r.cells.length,cells);});
     for(let page=1;page<=Math.ceil(height/100);page++){const check=await table.loadPage(page,100);for(let row=0;row<Math.min(check.rows.length,height-(page-1)*100);row++)for(let col=0;col<width;col++)assert.equal(check.rows[row]['C'+(col+2)],200019+((page-1)*100+row)*width+col);}
     await measure('undo_'+cells,budget,async i=>{const r=await action('files.sheet_cells_undo',{table:fixture.file,op_id:operations[19-i]});table.adoptVersions?.({contentVersion:r.content_version,structureVersion:r.structure_version});assert.equal(r.applied,cells);});
    }
   }else if(phase==='formula-graph'){
    const graphCol=Number(process.env.SS_GRAPH_COL||48);const graphField='C'+(graphCol+1);
    const added:string[]=[],replaced:string[]=[],removed:string[]=[];
    const initialValues=initial.rows.slice(0,20).map(row=>row[graphField]);
    const expected=initial.rows.slice(0,10).reduce((n,row)=>n+Number(row['C2']),0);
    const checkValues=async(value:number)=>assert.deepEqual((await table.loadPage(1,100)).rows.slice(0,20).map(row=>row[graphField]),Array(20).fill(value));
    await measure('formula_add',3000,async i=>{await table.inputWrite!({startRow:i,startCol:graphCol,matrix:[['=SUM(B2:B11)']],matrixTypes:[['formula']],extend:false,opId:(added[i]=randomUUID())});});
    await checkValues(expected);
    await measure('formula_replace',3000,async i=>{await table.inputWrite!({startRow:i,startCol:graphCol,matrix:[['=SUM(B2:B11)+1']],matrixTypes:[['formula']],extend:false,opId:(replaced[i]=randomUUID())});});
    await checkValues(expected+1);
    await measure('formula_remove',3000,async i=>{await table.inputWrite!({startRow:i,startCol:graphCol,matrix:[['5']],matrixTypes:[['number']],extend:false,opId:(removed[i]=randomUUID())});});
    await checkValues(5);
    for(const [name,operations] of [['formula_remove_undo',removed],['formula_replace_undo',replaced],['formula_add_undo',added]] as const){
     await measure(name,3000,async i=>{const r=await action('files.sheet_cells_undo',{table:fixture.file,op_id:operations[19-i]});table.adoptVersions?.({contentVersion:r.content_version,structureVersion:r.structure_version});assert.equal(r.applied,1);});
     if(name==='formula_remove_undo')await checkValues(expected+1);
     if(name==='formula_replace_undo')await checkValues(expected);
    }
    const check=await table.loadPage(1,100);assert.deepEqual(check.rows.slice(0,20).map(row=>row[graphField]),initialValues);
   }else if(phase==='formula'){
    const setup=performance.now();
    await table.inputWrite!({startRow:0,startCol:49,matrix:[['=SUM(B2:B11)']],matrixTypes:[['formula']],extend:false,opId:randomUUID()});
    result.formula_setup_ms=performance.now()-setup;save();console.log('formula_setup',Math.round(result.formula_setup_ms));
    await measure('formula_dependency_commit',3000,async i=>{const value=300001+i;const r=await table.writeCell({rowId:rid,fieldId:'C2',fieldType:table.columns.find(c=>c.fieldId==='C2')!.type,value,text:String(value),idempotencyKey:randomUUID()});assert.notEqual(r.kind,'rejected',JSON.stringify(r));});
    const readback=await table.loadPage(1,100);assert.equal(readback.rows[0]['C50'],readback.rows.slice(0,10).reduce((n,row)=>n+Number(row['C2']),0));
   }else throw Error('unknown phase');
   await Promise.all(pendingTiming);result.server_timings=timings;save();console.log('RESULT',output);
  }
 }
}finally{globalThis.fetch=nativeFetch;}
