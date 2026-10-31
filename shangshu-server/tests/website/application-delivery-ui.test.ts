import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

it('应用变更先展示差异，取消不写入，确认只调用原注册动作',async()=>{
  const dom=new JSDOM('<body></body>',{runScripts:'outside-only',url:'http://localhost'});
  const w=dom.window as any,calls:any[]=[];
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.esc=(v:any)=>String(v??'').replaceAll('<','&lt;');
  w.api=async(path:string,options:any)=>{calls.push([path,JSON.parse(options.body)]);return {ok:true,json:async()=>path.includes('/services/')?{changes:[{label:'名称',before:'旧名称',after:'新名称'}],expected_revision:2,definition:{title:'新名称'},dependency_hash:'hash'}:{result:{draft_revision:3}}};};
  w.eval(readFileSync(new URL('../../../shangshu-web/js/application-delivery.js',import.meta.url),'utf8'));
  try{
    const first=w.saveApplicationWithPreview('app',2,{title:'新名称'});
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.match(w.document.body.textContent,/旧名称/);
    assert.match(w.document.body.textContent,/新名称/);
    w.document.querySelector('[data-delivery-cancel]').click();
    assert.equal(await first,false);assert.equal(calls.length,1);
    const second=w.saveApplicationWithPreview('app',2,{title:'新名称'});
    await new Promise(resolve=>setTimeout(resolve,0));
    w.document.querySelector('[data-delivery-confirm]').click();
    assert.equal(await second,true);
    assert.match(calls.at(-1)[0],/actions\/platform.application.configure\/execute/);
    assert.equal(calls.at(-1)[1].payload.expected_revision,2);
    assert.equal(calls.at(-1)[1].payload.dependency_hash,'hash');
    assert.equal(calls.at(-1)[1].confirmed,true);
    let failed=false;const retries:any[]=[];
    w.api=async(path:string,options:any)=>{
      if(path.includes('/services/'))return {ok:true,json:async()=>({changes:[{label:'名称',before:'旧',after:'新'}],expected_revision:3,definition:{title:'新'}})};
      retries.push(JSON.parse(options.body));const ok=failed;failed=true;
      return {ok,json:async()=>ok?{result:{draft_revision:4}}:{error:'暂时失败'}};
    };
    const retry=w.saveApplicationWithPreview('app',3,{title:'新'});
    await new Promise(resolve=>setTimeout(resolve,0));
    w.document.querySelector('[data-delivery-confirm]').click();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.match(w.document.querySelector('[data-delivery-status]').textContent,/暂时失败/);
    assert.equal(w.document.querySelector('[data-delivery-confirm]').disabled,false);
    w.document.querySelector('[data-delivery-confirm]').click();
    assert.equal(await retry,true);
    assert.equal(retries[0].idempotency_key,retries[1].idempotency_key);
  }finally{dom.window.close();}
});

it('AI 确认卡展示同一差异，失效提案不能确认，未保存表单不被覆盖',async()=>{
  const dom=new JSDOM('<form data-managed-form data-application-id="app" data-unsaved="true"></form><div id="chat"></div>',{runScripts:'outside-only',url:'http://localhost'});
  const w=dom.window as any;let calls=0;const notes:string[]=[];
  Object.assign(w,{RENDER:{},ICONS:{},ic:()=>'',curMod:'app-design',esc:(v:any)=>String(v??'').replaceAll('<','&lt;'),
    $:(s:string,r?:any)=>(r||w.document).querySelector(s),$$:(s:string,r?:any)=>[...(r||w.document).querySelectorAll(s)],
    toast:(_title:string,message:string)=>notes.push(message),api:async()=>{calls++;return {json:async()=>({ok:true})};}});
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-chat.js',import.meta.url),'utf8'));
    w.chatScrollBottom=()=>{};
    const proposal={id:'proposal',capability:'platform.application.configure',payload:{application_id:'app'},
      preview:{status:'checked',expected_revision:2,changes:[{label:'名称',before:'旧',after:'新'}]}};
    const body=w.document.querySelector('#chat');w.chatAddConfirmCard(body,proposal);
    assert.match(body.textContent,/旧 → 新/);
    await body.querySelector('.cf-btn.ok').onclick();
    assert.equal(calls,0);assert.match(notes.at(-1)||'',/未保存/);
    assert.equal(body.querySelector('.cf-btn.ok').disabled,false);
    body.innerHTML='';w.chatAddConfirmCard(body,{...proposal,preview:{status:'blocked',reason:'草稿已变化'}});
    assert.equal(body.querySelector('.cf-btn.ok').disabled,true);
    assert.match(body.textContent,/草稿已变化/);
  }finally{dom.window.close();}
});
