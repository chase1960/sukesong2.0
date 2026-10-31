import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

test('全部待办只读聚合本人事项，办理回原来源，来源失败不能伪装空列表',async()=>{
  const dom=new JSDOM('<main></main>',{url:'http://test.local',runScripts:'outside-only'}), w=dom.window as any;
  let opened='';let failTasks=false;
  Object.assign(w,{$:(s:string,r=w.document)=>r.querySelector(s),$$:(s:string,r=w.document)=>[...r.querySelectorAll(s)],mainBox:()=>w.document.querySelector('main'),currentUserInfo:{username:'me'},esc:(s:any)=>String(s??''),rtEditTask:(id:string)=>opened=id,
    go:(route:string)=>opened=route,
    apiJSON:async(path:string)=>{if(path.includes('contributions'))return {work_items:[{dataset:'orders.order',name:'O1',title:'领用申请',step:'待仓管',application:'app.orders'}]};if(path.includes('process-instances'))return {list:[{name:'P1',definition_title:'采购审核',current_node_title:'财务审核'}]};if(failTasks)throw new Error('任务服务不可用');return {list:[{id:'T1',title:'整理材料',assignee_id:'me',status:'待办'},{id:'T2',title:'别人的工作',assignee_id:'other',status:'待办'},{id:'T3',title:'已结束',assignee_id:'me',status:'已完成'}]};},
    RENDER:{flowdesign:async(page:any)=>{opened=JSON.parse(w.sessionStorage.getItem('shangshu.process.intent')).instance.name;page.host.textContent='原流程办理';},'task-mgmt':async(page:any)=>{page.host.textContent='原任务办理';}}});
  w.eval(readFileSync(new URL('../../../shangshu-web/js/unified-work.js',import.meta.url),'utf8'));
  try{
    await w.RENDER.flowdesign();
    assert.equal(w.document.querySelectorAll('[data-work-open]').length,3);
    await w.document.querySelector('[data-work-open="2"]').onclick();assert.equal(opened,'objects');
    assert.equal(JSON.parse(w.sessionStorage.getItem('shangshu.record.open')).name,'O1');
    assert.equal(new URL(w.location.href).searchParams.get('application'),'app.orders');
    assert.doesNotMatch(w.document.body.textContent,/别人的工作|已结束/);
    await w.document.querySelector('[data-work-open="1"]').onclick();assert.equal(opened,'T1');
    await w.RENDER.flowdesign();
    await w.document.querySelector('[data-work-open="0"]').onclick();assert.equal(opened,'P1');
    w.sessionStorage.removeItem('shangshu.process.intent');failTasks=true;
    await w.RENDER.flowdesign();
    assert.match(w.document.querySelector('[role="alert"]').textContent,/任务服务不可用/);
    assert.match(w.document.body.textContent,/采购审核/);
  }finally{dom.window.close();}
});

test('统一待办：任务直达、刷新、流程切换与迟到响应隔离',async()=>{
  const dom=new JSDOM('<main></main>',{url:'http://test.local',runScripts:'outside-only'});
  const w=dom.window as any;
  let taskRenders=0;let taskContext:any;
  Object.assign(w,{$:(s:string,r=w.document)=>r.querySelector(s),$$:(s:string,r=w.document)=>[...r.querySelectorAll(s)],mainBox:()=>w.document.querySelector('main'),go:()=>assert.fail('当前任务刷新不应跳走'),RENDER:{
    flowdesign:async(page:any)=>{page.host.textContent='流程办理';},
    'task-mgmt':async(page:any)=>{taskContext=page;taskRenders++;page.host.innerHTML='<div class="platform-hd"><div class="acts"><button>发布任务</button></div></div><p>任务列表</p>';},
  }});
  w.sessionStorage.setItem('shangshu.work.view','tasks');
  w.eval(readFileSync(new URL('../../../shangshu-web/js/unified-work.js',import.meta.url),'utf8'));
  try{
    await w.RENDER.flowdesign({isActive:()=>true});
    assert.equal(w.document.querySelectorAll('h1').length,1);
    assert.match(w.document.body.textContent,/任务列表/);
    assert.equal(w.document.querySelector('.unified-work-header .unified-work-actions button')?.textContent,'发布任务');
    await w.RENDER['task-mgmt']();assert.equal(taskRenders,2);
    assert.equal(w.document.querySelectorAll('.unified-work-actions button').length,1);
    const old=taskContext;
    w.document.querySelector('[data-work-kind="processes"]').click();
    assert.equal(old.isActive(),false);
    assert.match(w.document.body.textContent,/流程办理/);
    w.sessionStorage.setItem('shangshu.work.view','tasks');
    w.sessionStorage.setItem('shangshu.process.intent','{"mode":"instance"}');
    await w.RENDER.flowdesign({isActive:()=>true});
    assert.match(w.document.body.textContent,/流程办理/);
  }finally{dom.window.close();}
});
