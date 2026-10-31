import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const tick=()=>new Promise(r=>setTimeout(r,15));
const snapshot=()=>({id:'p1',status:'proposed',target:{module:'excel',table:'f1',name:'报价.xlsx'},
  review_revision:'v1',accepted_count:0,remaining:2,units:[
    {unit_id:'u1',label:'数量',kind:'cell',current_value:{type:'number',value:1},value:{type:'number',value:2},editable:true,status:'pending'},
    {unit_id:'u2',label:'备注',kind:'cell',current_value:{type:'text',value:'旧'},value:{type:'text',value:'<img onerror=bad()>'},editable:true,status:'pending'}]});
function setup(initialError=false){
 const dom=new JSDOM('<main></main>',{url:'http://localhost/index.html#/dash',runScripts:'outside-only'});
 const w=dom.window as any,calls:any[]=[];let state=snapshot(),fail:any=false;
 w.api=async(url:string,opts:any={})=>{
   if(initialError&&!opts.method)return {ok:false,status:409,json:async()=>({ok:false,error:'原目标已变化'})};
   if(opts.method==='POST'){
     calls.push(JSON.parse(opts.body));if(fail){const mode=fail;fail=false;if(mode==='gateway')return {ok:false,status:502,json:async()=>({ok:false,error:'上游超时'})};throw Error('network');}
     const ids=calls.at(-1).units??['u1','u2'];
     state={...state,review_revision:'v2',accepted_count:ids.length,remaining:2-ids.length,
       units:state.units.map(u=>ids.includes(u.unit_id)?{...u,status:'accepted',current_value:calls.at(-1).edited_value[u.unit_id]??u.value}:u)};
   }
   return {ok:true,json:async()=>({ok:true,...state})};
 };
 w.resolveConfirmation=async()=>({ok:true,status:'rejected'});
 w.eval(readFileSync(new URL('../../../shangshu-web/js/proposal-review.js',import.meta.url),'utf8'));
 w.mountProposalReview(w.document.querySelector('main'),{id:'p1'});
 return {dom,w,calls,setFail:(mode:any=true)=>{fail=mode;}};
}
test('逐项人工修订只提交选中项，回执后显示真实部分状态且不执行HTML',async()=>{
 const {dom,w,calls}=setup();try{await tick();
   assert.equal(w.document.querySelector('img'),null);
   const input=w.document.querySelector('[data-review-unit="u1"] textarea');input.value='3';input.dispatchEvent(new w.Event('input'));
   w.document.querySelector('[data-accept-unit="u1"]').click();await tick();
   assert.deepEqual(calls[0].units,['u1']);assert.deepEqual(calls[0].edited_value.u1,{type:'number',value:3});
   assert.match(w.document.body.textContent,/已保存 1.*待审 1/);
 }finally{dom.window.close();}
});
test('未知结果保持原编号和原内容重试，不允许换建议值',async()=>{
 const {dom,w,calls,setFail}=setup();try{await tick();setFail();
   w.document.querySelector('[data-accept-unit="u1"]').click();await tick();
   assert.match(w.document.body.textContent,/核实/);assert.equal(w.document.querySelector('textarea').disabled,true);
   w.document.querySelector('[data-review-retry]').click();await tick();assert.deepEqual(calls[0],calls[1]);
 }finally{dom.window.close();}
});
test('原页面脏稿阻断写入，不发送确认',async()=>{
 const {dom,w,calls}=setup();try{await tick();w.addEventListener('shangshu:before-object-change',(e:any)=>e.preventDefault());
   w.document.querySelector('[data-accept-unit="u1"]').click();await tick();assert.equal(calls.length,0);assert.match(w.document.body.textContent,/人工编辑/);
 }finally{dom.window.close();}
});
test('原件预览失败仍能通过原裁决口拒绝旧建议，不形成无法清理的死卡',async()=>{
 const {dom,w}=setup(true);try{await tick();
   const button=[...w.document.querySelectorAll('button')].find((b:any)=>b.textContent==='放弃此建议') as any;
   assert.ok(button);button.click();await tick();assert.match(w.document.body.textContent,/已拒绝/);
 }finally{dom.window.close();}
});
test('网关502不能当成明确未执行，仍用原编号核实',async()=>{
 const {dom,w,calls,setFail}=setup();try{await tick();setFail('gateway');
   w.document.querySelector('[data-accept-unit="u1"]').click();await tick();
   assert.ok(w.document.querySelector('[data-review-retry]'));
   w.document.querySelector('[data-review-retry]').click();await tick();assert.deepEqual(calls[0],calls[1]);
 }finally{dom.window.close();}
});
test('未知结果遇到脏稿仍保留原请求，不能误作已拒绝而另发',async()=>{
 const {dom,w,calls,setFail}=setup();try{await tick();setFail();
   w.document.querySelector('[data-accept-unit="u1"]').click();await tick();
   const block=(e:any)=>e.preventDefault();w.addEventListener('shangshu:before-object-change',block);
   w.document.querySelector('[data-review-retry]').click();await tick();assert.ok(w.document.querySelector('[data-review-retry]'));
   w.removeEventListener('shangshu:before-object-change',block);w.document.querySelector('[data-review-retry]').click();await tick();assert.deepEqual(calls[0],calls[1]);
 }finally{dom.window.close();}
});
test('拒绝剩余建议后通知原工作面刷新待审数量，但不再提交采用',async()=>{
 const {dom,w,calls}=setup();try{await tick();
   let changes=0,detail:any;
   w.addEventListener('shangshu:object-changed',(event:any)=>{changes++;detail=event.detail;});
   const reject=[...w.document.querySelectorAll('button')].find((b:any)=>b.textContent==='不采用剩余建议') as any;
   reject.click();await tick();assert.equal(changes,1);
   assert.equal(detail.object_id,'files.file');assert.equal(detail.name,'f1');assert.equal(calls.length,0);
 }finally{dom.window.close();}
});
