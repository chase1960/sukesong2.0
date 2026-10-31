/** Production inline controller; one actual accepted HTTP response is deliberately lost. */
import assert from 'node:assert/strict';
import {createInlineReviewController,fetchReviewDescriptor} from '../../../shangshu-web/js/domains/excel-univer/src/inline-review.ts';
let raw='';for await(const c of process.stdin)raw+=c;const cfg=JSON.parse(raw),base='http://127.0.0.1:3000';
const login=await fetch(base+'/api/platform/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:cfg.user,password:cfg.password})});assert.equal(login.status,200);
const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),calls:any[]=[];
let drop=true,readbacks=0;
const fetcher:typeof fetch=async(url:any,options:any={})=>{
 const response=await fetch(base+String(url),{...options,headers:{...options.headers,cookie}});
 if(String(url).endsWith('/accept')){calls.push(JSON.parse(options.body));if(drop){assert.equal(response.status,200);await response.json();drop=false;throw Error('controlled lost successful HTTP receipt')}}
 return response;
};
const descriptor=await fetchReviewDescriptor(cfg.proposal,cfg.table,{fetcher});
const controller=createInlineReviewController({descriptor,fetcher,newKey:()=>crypto.randomUUID(),blocking:()=>false,coerce:(_u,text)=>({type:'text',value:text}),change:()=>{},progress:()=>{},readback:async(_d,expected)=>{
 const response=await fetcher('/api/platform/services/files.sheet_read/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload:{table:cfg.table}})});const body=await response.json();const sheet=body.result??body;
 for(const item of expected){const actual=sheet.rows.find((r:any)=>r.row_id===item.unit.target.row_id).values[item.unit.target.header];assert.deepEqual(actual,item.value)}readbacks++;
}});
assert.equal(await controller.acceptRemaining(),null);assert.match(controller.error,/结果尚未核实/);assert.equal(controller.descriptor.status,'proposed');
const recovered=await controller.acceptRemaining();assert.ok(recovered);assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.equal(readbacks,1);assert.equal(recovered.status,'confirmed');
console.log(JSON.stringify({checks:['lost success retained candidate','same original operation and body retried','production controller recovered receipt','independent authoritative values match'],operation:calls[0].op_id,receipt:recovered}));
