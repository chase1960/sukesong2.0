import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

it('可选目标不可用仍可启用来源域，强依赖不可用继续阻断',async()=>{
  const dom=new JSDOM('<main></main>',{url:'http://test.local',runScripts:'outside-only'}),w=dom.window as any;
  let form:any,body:any;
  const rows=[true,false].map(optional=>({id:optional?'com.shangshu.optional':'com.shangshu.required',name:optional?'可选来源':'强依赖来源',version:'1.0',enabled:false,execution_stopped:true,contribution:{},lifecycle:{disable_blockers:[],stop_blockers:[],requirements:[{id:'com.shangshu.mail',version:'>=0.2',installed_version:null,enabled:false,compatible:false,available:false,optional}]}}));
  Object.assign(w,{RENDER:{},currentUserInfo:{role:'admin'},mainBox:()=>w.document.querySelector('main'),$:(s:string,r=w.document)=>r.querySelector(s),$$:(s:string,r=w.document)=>[...r.querySelectorAll(s)],esc:(s:any)=>String(s??''),
    api:async()=>({ok:true,json:async()=>({list:rows})}),openSchemaForm:(value:any)=>form=value,submitJSON:async(_path:string,value:any)=>{body=value;},go:()=>{},renderChrome:()=>{}});
  w.eval(readFileSync(new URL('../../../shangshu-web/js/real-apps.js',import.meta.url),'utf8'));
  try{
    await w.RENDER.apps();
    const optional=w.document.querySelector('[data-domain="com.shangshu.optional"]') as HTMLButtonElement;
    assert.equal(optional.disabled,false);
    assert.equal((w.document.querySelector('[data-domain="com.shangshu.required"]') as HTMLButtonElement).disabled,true);
    assert.match(w.document.body.textContent,/可选集成/);
    assert.match(w.document.body.textContent,/不可用，不阻止本域启用/);
    optional.click();await form.onSubmit({reason:'可选依赖回归'});assert.equal(body.enabled,true);
  }finally{dom.window.close();}
});

it('管理后台显示真实阻断、保护核心，重试沿现有确认接口且员工不能读取',async()=>{
  const dom=new JSDOM('<main></main>',{url:'http://test.local',runScripts:'outside-only'}),w=dom.window as any;
  let form:any,submitted='';let reads=0;
  const rows=[{id:'com.shangshu.core',name:'核心',version:'0.1',enabled:true,contribution:{},lifecycle:{disable_blockers:['系统必需']}},
    {id:'com.shangshu.finance',name:'财务',version:'0.3',enabled:true,contribution:{},lifecycle:{disable_blockers:['订单仍在办理'],events:[{id:'EVT-1',status:'Failed'}]}}];
  Object.assign(w,{RENDER:{},currentUserInfo:{role:'admin'},mainBox:()=>w.document.querySelector('main'),$:(s:string,r=w.document)=>r.querySelector(s),$$:(s:string,r=w.document)=>[...r.querySelectorAll(s)],esc:(s:any)=>String(s??''),
    api:async()=>{reads++;return {ok:true,json:async()=>({list:rows})};},openSchemaForm:(value:any)=>form=value,submitJSON:async(path:string)=>{submitted=path;},go:()=>{},renderChrome:()=>{}});
  w.eval(readFileSync(new URL('../../../shangshu-web/js/real-apps.js',import.meta.url),'utf8'));
  try{
    await w.RENDER.apps();assert.equal(w.document.querySelectorAll('[data-domain]:disabled').length,2);
    assert.match(w.document.body.textContent,/订单仍在办理/);
    w.document.querySelector('[data-retry-event]').click();assert.equal(submitted,'');
    await form.onSubmit();assert.equal(submitted,'/api/platform/event-deliveries/EVT-1/retry');
    w.currentUserInfo.role='staff';const previous=reads;await w.RENDER.apps();assert.equal(reads,previous);
    assert.match(w.document.body.textContent,/只有系统管理员/);
  }finally{dom.window.close();}
});

it('完整停用与旧续办状态区分，管理按钮显式请求 complete',async()=>{
  const dom=new JSDOM('<main></main>',{url:'http://test.local',runScripts:'outside-only'}),w=dom.window as any;
  let form:any,body:any;
  Object.assign(w,{RENDER:{},currentUserInfo:{role:'admin'},mainBox:()=>w.document.querySelector('main'),$:(s:string,r=w.document)=>r.querySelector(s),$$:(s:string,r=w.document)=>[...r.querySelectorAll(s)],esc:(s:any)=>String(s??''),
    api:async()=>({ok:true,json:async()=>({list:[{id:'com.shangshu.finance',name:'财务',version:'0.3',enabled:false,execution_stopped:false,contribution:{},lifecycle:{disable_blockers:[],stop_blockers:[],requirements:[]}}]})}),
    openSchemaForm:(value:any)=>form=value,submitJSON:async(_path:string,value:any)=>{body=value;},go:()=>{},renderChrome:()=>{}});
  w.eval(readFileSync(new URL('../../../shangshu-web/js/real-apps.js',import.meta.url),'utf8'));
  try{
    await w.RENDER.apps();
    assert.match(w.document.body.textContent,/停止新业务/);
    const stop=[...w.document.querySelectorAll('[data-domain]')].find((item:any)=>item.textContent==='完全停用') as any;
    assert.ok(stop);stop.click();await form.onSubmit({reason:'回归'});
    assert.equal(body.stop_mode,'complete');assert.equal(body.enabled,false);
    assert.match(w.document.body.textContent,/重新启用/);
  }finally{dom.window.close();}
});
