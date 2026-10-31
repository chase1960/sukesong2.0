import * as attributionModule from '../../../shangshu-web/js/resource-attribution.mjs';
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, toastText} from '../helpers/toast.ts';
import {browserModuleSource} from '../helpers/browser-module-fixtures.ts';

const row=(name:string)=>({name,file_name:`${name}.txt`,status:'Active',owner:'worker@example.invalid',directory:'/',current_size:2,modified:'2026-09-22',version_count:3});
const response=(value:unknown,status=200)=>({ok:status<400,status,json:async()=>value,text:async()=>String(value)});
const settle=()=>new Promise(resolve=>setTimeout(resolve,25));
it('搜索防抖，新条件中止旧读取；筛选立即读取且取消不报失败',async()=>{
  const queries:Array<{q:string;signal:AbortSignal;resolve:(value:any)=>void}>=[];
  let first=true;
  const t=mount(async(url,options)=>{
    if(!url.includes('/datasets/'))return response({directories:[],can_manage:false});
    if(first){first=false;return response({rows:[],total:0});}
    return await new Promise((resolve,reject)=>{
      const q=JSON.parse(new URL(url,'http://localhost').searchParams.get('filters')||'{}').q;
      queries.push({q,signal:options.signal,resolve});
      options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
    });
  });
  try{
    await settle();
    const input=t.w.document.querySelector('#search');
    for(const value of ['甲','甲乙']){input.value=value;input.dispatchEvent(new t.w.Event('input'));}
    await new Promise(resolve=>setTimeout(resolve,280));
    assert.equal(queries.length,1);
    assert.equal(queries[0].q,'甲乙');
    input.value='丙';input.dispatchEvent(new t.w.Event('input'));
    assert.equal(queries[0].signal.aborted,true,'新输入应立即中止旧读，不等防抖结束');
    const kind=t.w.document.querySelector('#type');kind.value='文档';kind.dispatchEvent(new t.w.Event('change'));
    await settle();
    assert.equal(queries.length,2,'筛选立即执行且取消待触发搜索，避免额外请求');
    queries[1].resolve(response({rows:[],total:0}));await settle();
    assert.doesNotMatch(toastText(t.w),/读取失败|aborted|取消/);
  }finally{t.controller.abort();t.dom.window.close();}
});
it('首次连接时禁止切换范围和筛选，避免全部文件响应被当成回收站',async()=>{
  let release:(v:any)=>void=()=>{};
  const t=mount(async url=>url.includes('/datasets/')?new Promise(resolve=>release=resolve):response({directories:[],can_manage:false}));
  try{
    const trash=t.w.document.querySelector('[data-view="trash"]');assert.equal(trash.disabled,true);
    trash.click();assert.equal(t.w.document.querySelector('[data-view="all"]').getAttribute('aria-current'),'page');
    assert.equal(t.w.document.querySelector('#search').disabled,true);
    await new Promise(resolve=>setImmediate(resolve));
    release(response({rows:[row('甲')],total:1}));await settle();
    assert.equal(trash.disabled,false);assert.equal(t.w.document.querySelector('#search').disabled,false);
  }finally{t.controller.abort();t.dom.window.close();}
});

/* 2026-10-12 用户要求「把你的劣等品全部(不止刚刚提到的)改成 toast」。
   邮件/表格/邮箱设置三个页面的自造 #notice 删干净之后，文件中心这份一度漏删 ——
   host.innerHTML 里还挂着 `<div id="notice" role="status" hidden></div>`，
   没有任何代码再读它，file-center.css 的 #notice 样式也已删，只剩一具空壳。
   已修，这里钉成回归线：**文件中心不许再自造 #notice**。
   点什么：进文件中心 → 控制台看 #host。
   看到什么：一个 #notice 都没有，提示只从右下角 toast 出。
   应该是：和另外三个页面一样，提示全走 js/toast.js 的公共件。 */
it('文件中心页面不自造 #notice 空壳（提示只走右下角 toast）',async()=>{
  const src=readFileSync(new URL('../../../shangshu-web/js/file-center.js',import.meta.url),'utf8');
  assert.ok(!/id=\\"notice\\"|id="notice"/.test(src),
      'shangshu-web/js/file-center.js 的 host.innerHTML 里又贴回了 <div id="notice">（自造劣等品，该删）');
  const t=mount(async url=>url.includes('/datasets/')?response({rows:[],total:0}):response({directories:[],can_manage:false}));
  try{await settle();
    assert.equal(t.w.document.querySelector('#notice'),null,
        '文件中心页面里挂着 #notice 空壳（该由右下角 toast 公共件出提示）');
    // 架子要在：toast 公共容器得在，提示才有地方去
    assert.ok(t.w.document.querySelector('#toast-zone'),'没有右下角 toast 容器');
  }finally{t.controller.abort();t.dom.window.close();}
});
it('目录筛选与搜索同属工具栏，不固定单占一行；数量归选择状态条',async()=>{
  const t=mount(async url=>url.includes('/datasets/')?response({rows:[],total:0}):response({directories:[],can_manage:false}));
  try{await settle();assert.ok(t.w.document.querySelector('.file-directory-tools').closest('.file-tools'));assert.ok(t.w.document.querySelector('#result-count').closest('.file-selection'));}
  finally{t.controller.abort();t.dom.window.close();}
});
it('文件筛选和目录维护分组，所有人筛选文案清楚且分页保持独立',async()=>{
  const t=mount(async url=>url.includes('/datasets/')?response({rows:[],total:0}):response({directories:[],can_manage:true}));
  try{await settle();const $=(s:string)=>t.w.document.querySelector(s);
    assert.ok($('#directory-filter').closest('.file-filter-row'),'目录筛选应和搜索放在同一筛选组');
    assert.ok($('#directory-create').closest('.file-directory-actions'),'目录维护需有独立操作组，不能挤进筛选字段');
    assert.equal($('#owner-filter option').textContent,'全部所有人');
    assert.ok($('.file-pagination').closest('.file-table-area'));
  }finally{t.controller.abort();t.dom.window.close();}
});
it('缩略图仅加载可见卡片、并发不超过两项，切换视图取消请求且迟到内容不回写',async()=>{
  const t=mount(async url=>url.includes('/datasets/')?response({rows:['甲','乙','丙'].map(row),total:3}):response({directories:[],can_manage:false}));
  let observer:any;const jobs:any[]=[];
  t.w.IntersectionObserver=class{cb:any;nodes:any[]=[];constructor(cb:any){this.cb=cb;observer=this;}observe(node:any){this.nodes.push(node);}unobserve(){}disconnect(){}};
  t.w.readFileCenterThumbnail=(file:any,signal:any)=>new Promise(resolve=>jobs.push({file,signal,resolve}));
  try{await settle();assert.equal(jobs.length,0);t.w.document.querySelector('[data-layout="grid"]').click();assert.equal(jobs.length,0);
    observer.cb(observer.nodes.map((target:any)=>({target,isIntersecting:true})));assert.equal(jobs.length,2);
    jobs[0].resolve({kind:'text',text:'<img src=x>真实摘要'});await settle();assert.equal(jobs.length,3);assert.match(t.w.document.querySelector('.tile-excerpt').textContent,/真实摘要/);assert.equal(t.w.document.querySelector('.tile-preview img'),null);
    t.w.document.querySelector('[data-layout="list"]').click();assert.ok(jobs.every(j=>j.signal.aborted));jobs[1].resolve({kind:'text',text:'迟到正文'});jobs[2].resolve(null);await settle();assert.equal(t.w.document.querySelector('.tile-excerpt'),null);
  }finally{t.controller.abort();t.dom.window.close();}
});
it('真实目录未返回版本键也有下载入口，点击才读取原版本服务；连接期间不误报未接入',async()=>{
  let release:(v:any)=>void=()=>{};const reads:string[]=[];
  const t=mount(async url=>{reads.push(url);if(url.includes('/datasets/'))return new Promise(resolve=>{release=resolve;});if(url.includes('files.versions'))return response({file:{name:'甲'},versions:[{version_no:3,frappe_file:'pinned-current'}]});return response({directories:[],can_manage:false});});
  try{assert.doesNotMatch(t.w.document.querySelector('#file-rows').textContent,/存储待接入/);assert.equal(t.w.document.querySelector('#upload').textContent,'正在读取…');
    await new Promise(resolve=>setImmediate(resolve));release(response({rows:[row('甲')],total:1}));await settle();assert.equal(reads.some(url=>url.includes('files.versions')),false);
    let downloaded='';t.w.HTMLAnchorElement.prototype.click=function(){downloaded=this.href;};t.w.document.querySelector('[data-download]').click();await settle();assert.match(downloaded,/file=pinned-current/);assert.equal(reads.filter(url=>url.includes('files.versions')).length,1);assert.equal(t.w.document.querySelector('[data-download]').disabled,false);
  }finally{t.controller.abort();t.dom.window.close();}
});
it('列表直接下载当前文件版本，重命名仅限可编辑文件；重新查询保留筛选',async()=>{
  const queries:string[]=[],opened:any[]=[];
  const t=mount(async url=>{if(url.includes('/datasets/')){queries.push(url);return response({rows:[{...row('我的'),can_edit:true,current_file:'bytes-one'},{...row('共享'),can_edit:false,current_file:'bytes-two'}],total:2});}return response({directories:[],can_manage:false});});
  t.w.openFileCenterDetail=async(options:any)=>opened.push(options);
  try{await settle();const $=(s:string)=>t.w.document.querySelector(s),links=t.w.document.querySelectorAll('[data-download]');assert.equal(links.length,2);const href=new URL(links[0].href);assert.equal(href.searchParams.get('ref'),'Shangshu File Center File');assert.equal(href.searchParams.get('ref_name'),'我的');assert.equal(href.searchParams.get('file'),'bytes-one');assert.equal(t.w.document.querySelectorAll('[data-rename]').length,1);$('[data-rename]').click();await settle();assert.equal(opened[0].editField,'file_name');$('#search').value='我的';$('#search').dispatchEvent(new t.w.Event('input'));await settle();const before=queries.length;
    // FIX-42（用户 2026-10-20「文件中心的刷新也删除」）：**「刷新」按钮已去掉** ——
    // 列表打开时会自己查，刷新按钮是多余的一次点击。
    // 这条判据原来的意图是「**重新查询时筛选条件不能丢**」，
    // 现在改钉**换筛选会重新查、且筛选条件仍在**（同一件事的另一个入口）。
    assert.equal($('#refresh-files'),null,'「刷新」按钮还在 —— 用户要求文件中心也去掉');
    $('#type').value='文档';$('#type').dispatchEvent(new t.w.Event('change'));await settle();
    assert.equal(queries.length,before+1,'换筛选后没有重新查');
    assert.equal($('#search').value,'我的','重新查询后筛选条件丢了');
    assert.equal($('#type').value,'文档','重新查询后筛选条件丢了');}finally{t.controller.abort();t.dom.window.close();}
});
it('下载的版本读取被拒不伪造成功，不下载其他文件且可再次尝试',async()=>{
  const t=mount(async url=>url.includes('/datasets/')?response({rows:[row('甲')],total:1}):url.includes('files.versions')?response({error:'文件权限已撤销'},403):response({directories:[],can_manage:false}));
  try{await settle();let clicks=0;t.w.HTMLAnchorElement.prototype.click=()=>{clicks++;};const button=t.w.document.querySelector('[data-download]');button.click();await settle();assert.equal(clicks,0);assert.equal(button.disabled,false);assert.match(toastText(t.w),/下载未开始.*权限已撤销/);}finally{t.controller.abort();t.dom.window.close();}
});
it('批量恢复复用关联选择，取消零写；失败后核实沿用原选择与修订',async()=>{
  const calls:any[]=[];const t=mount(async(url,options)=>{
    if(url.includes('/datasets/'))return response({rows:[{...row('甲'),status:'Recycled',restore_relations:1}],total:1});
    if(url.includes('/actions/')){calls.push(JSON.parse(options.body));return calls.length===1?response({error:'结果未知'},502):response({result:{file:'甲',status:'Active'}});}
    return response({directories:[],can_manage:false});
  });
  try{
    await settle();t.w.document.querySelector('[data-view="trash"]').click();await settle();
    t.w.document.querySelector('#select-page').click();t.w.document.querySelector('#batch-change').click();
    t.w.document.querySelector('[data-restore-cancel]').click();await settle();assert.equal(calls.length,0);
    t.w.document.querySelector('#batch-change').click();t.w.document.querySelector('[data-restore-keep]').checked=false;
    t.w.document.querySelector('[data-restore-confirm]').click();await settle();
    assert.deepEqual(calls[0].payload,{file:'甲',keep_relations:false,expected_modified:'2026-09-22'});
    t.w.document.querySelector('[data-batch-retry]').click();await settle();assert.deepEqual(calls[1],calls[0]);
  }finally{t.controller.abort();t.dom.window.close();}
});
it('只读文件不提供审核写入入口，目录管理权限不足时隐藏管理按钮',async()=>{
  const {w,dom,controller}=mount(async url=>url.includes('files.directories')?response({directories:[],can_manage:false}):response({rows:[{...row('共享'),can_edit:false}],total:1}));
  try{await settle();assert.equal(w.document.querySelector('#directory-create').hidden,true);assert.equal(w.document.querySelector('#directory-rename').hidden,true);assert.doesNotMatch(w.document.querySelector('#file-rows tr td:last-child').textContent,/审核/);}
  finally{controller.abort();dom.window.close();}
});
function mount(fetch:(url:string,options?:any)=>Promise<any>,url='http://localhost',importReplacement="window.attributionModule",withEditor=false, beforeMount?:(w:any)=>void) {
  const dom=new JSDOM('<div id="host"></div>',{url,runScripts:'outside-only'}),w=dom.window as any;
  w.attributionModule=attributionModule;w.RENDER={};w.currentRole=()=> 'admin';w.fetch=fetch;
  installToast(w); // 必须排在 tool-workspace.js 之前：notify 转调 globalThis.toast
  w.TextDecoder=TextDecoder;w.TextEncoder=TextEncoder;
  for(const file of ['tool-workspace','file-detail',...(withEditor?['file-editor']:[]),'record-reference-picker','file-center'])w.eval(browserModuleSource(w,readFileSync(new URL(`../../../shangshu-web/js/${file}.js`,import.meta.url),'utf8').replace("await import('./resource-attribution.mjs')",importReplacement)));  const controller=new w.AbortController();
  beforeMount?.(w);
  w.mountFileCenter(w.document.querySelector('#host'),{signal:controller.signal});
  return {w,dom,controller};
}

/*
 FIX-09 / MAIL-NEXT-03：「上传文件按钮无法上传」。
 根因（读代码定位）：`#file-picker` 的 change 处理里是
   `addFiles(e.target.files); e.target.value='';`
 而 `input.files` 是**活的对象**（浏览器里清空 input 会把已选文件清掉），
 `realUpload` 又是 `async`、先 `await import(...)` 才 `Array.from(list)` ——
 于是文件列表在读之前就被清空了 → `items` 为空 → 弹窗都不弹。
 （Excel 工作区的上传没这问题：它先取 `input.files[0]` 这个**文件对象**再清 input。）

 判据：选完文件后，上传弹窗**要真的打开**并列出那个文件。
 ⚠️ 默认测试台把动态 import 换成了同步表达式，时序跟生产不一样 —— 所以这里
 特意把 import 换成一个**异步**表达式，还原生产的时序。
*/
it('FIX-09 文件中心「上传文件」真能打开上传弹窗：测试通过 = 选完文件后弹窗出现并列出该文件',async()=>{
  const t=mount(async url=>url.includes('/datasets/')?response({rows:[],total:0}):response({directories:[],can_manage:false}),
    'http://localhost','await Promise.resolve().then(()=>window.attributionModule)');
  try{
    await settle();
    const picker=t.w.document.querySelector('#file-picker') as HTMLInputElement;
    const file={name:'说明.txt',size:10,type:'text/plain'};
    const files:any={0:file,length:1,item:(i:number)=>i===0?file:null};
    files[Symbol.iterator]=function*(){for(let i=0;i<files.length;i++)yield files[i];};
    Object.defineProperty(picker,'files',{value:files,configurable:true});
    let value='';
    Object.defineProperty(picker,'value',{get:()=>value,set:(v:string)=>{value=v;if(v==='')files.length=0;},configurable:true});
    picker.dispatchEvent(new t.w.Event('change',{bubbles:true}));
    await settle();
    const dialog=t.w.document.querySelector('dialog.file-operation-dialog');
    assert.ok(dialog,'选了文件后上传弹窗没打开（用户报「上传按钮无法上传」）');
    assert.match(dialog.textContent||'',/说明\.txt/,'弹窗里没列出选中的文件');  }finally{t.controller.abort();t.dom.window.close();}
});

it('业务记录直达文件页保持关联范围，清除筛选才退出该范围',async()=>{
  const queries:any[]=[];
  const t=mount(async url=>{if(url.includes('/objects/'))return response({object:{title:'采购单',fields:[{id:'title',type:'text'}]},record:{name:'r1',title:'办公用品'}});if(url.includes('/datasets/'))queries.push(JSON.parse(new URL(url,'http://localhost').searchParams.get('filters')||'{}'));return response({rows:[row('已关联文件')],total:1});},'http://localhost/index.html?related_object=app.items&related_record=r1#/file-center');
  try{await settle();assert.equal(queries[0].related_object,'app.items');assert.equal(queries[0].related_record,'r1');assert.match(t.w.document.querySelector('#related-summary').textContent,/采购单.*办公用品/);t.w.document.querySelector('#clear').click();await settle();assert.equal(queries.at(-1).related_record,undefined);assert.equal(new URL(t.w.location.href).searchParams.has('related_record'),false);}
  finally{t.controller.abort();t.dom.window.close();}
});

it('文件页复用记录选择器筛选关联文件，取消不改变当前查询',async()=>{
  const queries:any[]=[];const obj={id:'app.items',source:'managed',title:'采购单',operations:['read'],query:{version:1},fields:[{id:'title',type:'text'}]};
  const t=mount(async url=>{if(url.startsWith('/api/platform/objects?'))return response({list:[obj],total:1,page:1,page_length:20});if(url.includes('/objects/'))return url.includes('/records?')?response({object:obj,rows:[{name:'r1',title:'办公用品'}],total:1}):response({object:obj,record:{name:'r1',title:'办公用品'}});if(url.includes('/datasets/'))queries.push(JSON.parse(new URL(url,'http://localhost').searchParams.get('filters')||'{}'));return response({rows:[row('已关联文件')],total:1});});
  try{await settle();t.w.document.querySelector('#related-filter').click();await settle();const before=queries.length;t.w.document.querySelector('[data-record-close]').click();assert.equal(queries.length,before);t.w.document.querySelector('#related-filter').click();await settle();t.w.document.querySelector('[data-record-pick]').click();await settle();assert.equal(queries.at(-1).related_record,'r1');assert.match(t.w.document.querySelector('#related-summary').textContent,/办公用品/);}
  finally{t.controller.abort();t.dom.window.close();}
});
it('文件页外层关闭关联弹窗会中止选择器目录读，迟到结果不重开弹窗',async()=>{
  let pending:any;
  const t=mount(async(url,init)=>url.startsWith('/api/platform/objects?')?new Promise(resolve=>pending={signal:init.signal,resolve}):response({rows:[],total:0}));
  try{await settle();t.w.document.querySelector('#related-filter').click();await settle();
    t.w.document.querySelector('[data-related-close]').click();assert.equal(pending.signal.aborted,true);
    pending.resolve(response({list:[],total:0,page:1,page_length:20}));await settle();assert.equal(t.w.document.querySelector('[data-related-picker]'),null);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('关联已撤权直达失败不能显示旧标题，清除范围可重新连接文件库',async()=>{
  const t=mount(async url=>url.includes('/datasets/')&&new URL(url,'http://localhost').searchParams.get('filters')?.includes('related_object')?response({error:'关联记录无权访问'},403):response({rows:[row('正常文件')],total:1}),'http://localhost/index.html?related_object=app.items&related_record=r1#/file-center');
  try{await settle();assert.match(t.w.document.querySelector('#related-summary').textContent,/不可访问/);t.w.document.querySelector('#clear').click();await settle();assert.match(t.w.document.querySelector('#file-rows').textContent,/正常文件/);assert.equal(t.w.document.querySelector('#upload').disabled,false);}
  finally{t.controller.abort();t.dom.window.close();}
});

it('真实文件读取被拒必须显示错误，不能伪装存储未接入或切回样例',async()=>{
  const {w,dom,controller}=mount(async url=>url==='/api/session'?response({user:{username:'worker'}}):response({error:'无权访问文件域'},403));
  try{await settle();assert.match(toastText(w),/无权访问文件域/);assert.equal(w.document.querySelector('#upload').disabled,true);assert.equal(w.document.querySelector('#examples-toggle').hidden,true);}
  finally{controller.abort();dom.window.close();}
});

it('批量部分失败只报告成功数，失败项保持选中，重试不重复办理成功项',async()=>{
  const calls:string[]=[];let recovered=false;
  const {w,dom,controller}=mount(async(url,options)=>{
    if(url==='/api/session')return response({user:{username:'worker'}});
    if(url.includes('/datasets/'))return response({rows:[row('甲'),row('乙')],total:2,page:1,page_length:100});
    if(url.includes('files.directories'))return response({directories:[],can_manage:false});
    // 同「批量未知结果…」那条：C10-A 之后 mount 还会发筛选下拉的数据源请求，
    // 不挡就会被当成批次的一发，把 calls 记成 [undefined, 甲, 乙, 乙]。
    if(!url.includes('/api/platform/actions/'))return response({people:[]});
    const file=JSON.parse(options.body).payload.file;calls.push(file);
    return file==='乙'&&!recovered?response({error:'权限已变化'},403):response({result:{file,status:'Recycled'}});
  });
  try{
    await settle();w.document.querySelector('#select-page').click();w.document.querySelector('#batch-change').click();await settle();
    assert.match(toastText(w),/已办理 1.*未完成 1/);
    assert.equal(w.document.querySelector('[data-check="乙"]').checked,true);
    assert.equal(w.document.querySelector('[data-check="甲"]').checked,false);
    recovered=true;w.document.querySelector('#batch-change').click();await settle();
    assert.deepEqual(calls,['甲','乙','乙']);
  }finally{controller.abort();dom.window.close();}
});
it('批量未知结果保留原动作与幂等键；不完整成功回执不清选中',async()=>{
  const calls:any[]=[];
  const {w,dom,controller}=mount(async(url,options)=>{
    if(url==='/api/session')return response({user:{username:'worker'}});
    if(url.includes('files.directories'))return response({directories:[],can_manage:false});
    if(url.includes('/datasets/'))return response({rows:[row('甲')],total:1});
    // 只数**批次动作**那一发发请求。C10-A 之后 mount 还会发筛选下拉的数据源请求
    // （identity.list_collaboration_people）—— 不挡住它就会占掉 1 号位，让 files.recycle
    // 拿到 403 那一发，而 403 是**确定失败**、不弹核实框，这条用例就假红了。
    // 「第几发」这种计数天生脆，将来再加无关请求还会错位，别删这道挡板。
    if(!url.includes('/api/platform/actions/'))return response({people:[]});
    calls.push({url,body:JSON.parse(options.body)});return calls.length===1?response({result:{file:'甲'}}):calls.length===2?response({error:'暂不能核实'},403):response({result:{file:'甲',status:'Recycled'}});
  });
  try{await settle();w.document.querySelector('#select-page').click();w.document.querySelector('#batch-change').click();await settle();
    assert.equal(w.document.querySelector('[data-check="甲"]').checked,true);
    const retry=w.document.querySelector('[data-batch-retry]');assert.ok(retry);
    const leave=new w.CustomEvent('shangshu:before-page-change',{cancelable:true});w.dispatchEvent(leave);assert.equal(leave.defaultPrevented,true);
    retry.click();await settle();assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0]);assert.ok(w.document.querySelector('[data-batch-retry]'));retry.click();await settle();assert.deepEqual(calls[2],calls[0]);assert.equal(w.document.querySelector('[data-batch-retry]'),null);assert.equal(w.document.querySelector('[data-check="甲"]').checked,false);
  }finally{controller.abort();dom.window.close();}
});

it('历史版本分别下载固定文件引用，不能全部指向最新版本',async()=>{
  const {w,dom,controller}=mount(async url=>{
    if(url==='/api/session')return response({user:{username:'worker'}});
    if(url.includes('/datasets/'))return response({rows:[row('甲')],total:1,page:1,page_length:100});
    if(url.includes('/services/'))return response({versions:[{version_no:2,frappe_file:'f-new',size:2},{version_no:1,frappe_file:'f-old',size:1}]});
    return response('text');
  });
  try{await settle();w.document.querySelector('[data-open]').click();await settle();const links=[...w.document.querySelectorAll('[data-version-download]')];assert.equal(links.length,2);assert.match(links[1].href,/file=f-old/);assert.match(links[0].href,/file=f-new/);}
  finally{controller.abort();dom.window.close();}
});

it('真实列表使用后端总数分页，搜索与本人范围提交服务端而非只过滤当前页',async()=>{
  const requests:URL[]=[];
  const {w,dom,controller}=mount(async url=>{
    if(url==='/api/session')return response({user:{username:'协作键并非邮箱'}});
    const u=new URL(url,'http://localhost');requests.push(u);
    const page=Number(u.searchParams.get('page')||1),filters=JSON.parse(u.searchParams.get('filters')||'{}');
    return response({rows:[row(filters.scope==='mine'?'本人文件':`第${page}页`)],total:105,page,page_length:20});
  });
  try{
    await settle();assert.match(w.document.querySelector('#page-info').textContent,/共 105/);
    w.document.querySelector('#next-page').click();await settle();
    assert.equal(requests.at(-1)!.searchParams.get('page'),'2');
    assert.match(w.document.querySelector('#file-rows').textContent,/第2页/);
    const search=w.document.querySelector('#search');search.value='跨页关键词';search.dispatchEvent(new w.Event('input'));await new Promise(resolve=>setTimeout(resolve,280));
    assert.equal(JSON.parse(requests.at(-1)!.searchParams.get('filters')!).q,'跨页关键词');
    assert.equal(requests.at(-1)!.searchParams.get('page'),'1');
    w.document.querySelector('[data-view="mine"]').click();await settle();
    assert.equal(JSON.parse(requests.at(-1)!.searchParams.get('filters')!).scope,'mine');
    assert.match(w.document.querySelector('#file-rows').textContent,/本人文件/);
  }finally{controller.abort();dom.window.close();}
});

it('较慢的旧筛选响应不得覆盖较新的文件查询',async()=>{
  let resolveOld:(value:any)=>void=()=>{};
  const {w,dom,controller}=mount(async url=>{
    if(url==='/api/session')return response({user:{username:'worker'}});
    const filters=JSON.parse(new URL(url,'http://localhost').searchParams.get('filters')||'{}');
    if(filters.q==='旧条件')return new Promise(resolve=>{resolveOld=resolve;});
    return response({rows:[row(filters.q||'初始')],total:1,page:1,page_length:20});
  });
  try{
    await settle();const search=w.document.querySelector('#search');
    search.value='旧条件';search.dispatchEvent(new w.Event('input'));await new Promise(resolve=>setTimeout(resolve,280));
    search.value='新条件';search.dispatchEvent(new w.Event('input'));await new Promise(resolve=>setTimeout(resolve,280));
    resolveOld(response({rows:[row('旧条件')],total:1,page:1,page_length:20}));await settle();
    assert.match(w.document.querySelector('#file-rows').textContent,/新条件/);
    assert.doesNotMatch(w.document.querySelector('#file-rows').textContent,/旧条件/);
  }finally{controller.abort();dom.window.close();}
});

it('目录是显式筛选和上传落点，不得从搜索词猜目录',async()=>{
  const requests:URL[]=[];
  const {w,dom,controller}=mount(async(url,options)=>{
    if(url==='/api/session')return response({user:{username:'worker'}});
    if(url.includes('files.directories')){assert.deepEqual(JSON.parse(options.body).payload,{});return response({directories:[{name:'files-root',path:'/',title:'全部文件'},{name:'folder-a',path:'/采购',title:'采购',parent_directory:'files-root',modified:'2026-09-23'}],can_manage:true});}
    requests.push(new URL(url,'http://localhost'));return response({rows:[],total:0});
  });
  try{
    await settle();const chooser=w.document.querySelector('#directory-filter');assert.ok(chooser,'提供显式目录选择');
    chooser.value='folder-a';chooser.dispatchEvent(new w.Event('change'));await settle();
    assert.equal(JSON.parse(requests.at(-1)!.searchParams.get('filters')!).directory_id,'folder-a');
    assert.equal(w.document.querySelector('#directory-create').disabled,false);
    assert.equal(w.document.querySelector('#directory-rename').disabled,false);
    assert.match(w.document.querySelector('#file-rows').textContent,/当前目录/);
    w.document.querySelector('#clear').click();await settle();assert.equal(chooser.value,'');
  }finally{controller.abort();dom.window.close();}
});

it('目录创建未知回执同键重试，不能改名或关闭后重复创建',async()=>{
  const calls:any[]=[];let saved=false;
  const {w,dom,controller}=mount(async(url,options)=>{
    if(url==='/api/session')return response({user:{username:'worker'}});
    if(url.includes('files.directories'))return response({directories:[{name:'files-root',path:'/',title:'全部文件'},...(saved?[{name:'new-dir',path:'/采购',title:'采购',modified:'2026-09-23'}]:[])],can_manage:true});
    if(url.includes('/actions/')){calls.push(JSON.parse(options.body));if(calls.length===1)return response({error:'网关超时'},503);saved=true;return response({result:{directory:'new-dir',path:'/采购',modified:'2026-09-23'}});}
    return response({rows:[],total:0});
  });
  try{await settle();w.document.querySelector('#directory-create').click();const dialog=w.document.querySelector('.file-operation-dialog');dialog.querySelector('input').value='采购';dialog.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();assert.equal(dialog.querySelector('input').disabled,true);dialog.querySelector('[data-cancel]').click();assert.ok(dialog.isConnected);dialog.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0]);assert.equal(w.document.querySelector('#directory-filter').value,'new-dir');assert.equal(dialog.isConnected,false);}
  finally{controller.abort();dom.window.close();}
});
it('选文件不直接写入；确认上传目标，未知结果仅原键重试',async()=>{
  const calls:any[]=[];
  const {w,dom,controller}=mount(async(url,options)=>{
    if(url==='/api/session')return response({user:{username:'worker'}});
    if(url.includes('files.directories'))return response({directories:[{name:'files-root',path:'/'},{name:'folder-a',path:'/采购'}],can_manage:true});
    if(url.includes('/actions/')){calls.push(JSON.parse(options.body));return calls.length===1?response({error:'超时'},503):response({result:{file:'new-file',version:1}});}
    return response({rows:[],total:0});
  });
  try{
    await settle();const folder=w.document.querySelector('#directory-filter');folder.value='folder-a';folder.dispatchEvent(new w.Event('change'));await settle();
    const picker=w.document.querySelector('#file-picker');Object.defineProperty(picker,'files',{value:[new w.File(['内容'],'验收.txt',{type:'text/plain'})]});picker.dispatchEvent(new w.Event('change'));await settle();
    const dialog=w.document.querySelector('.file-operation-dialog');assert.equal(calls.length,0);assert.equal(dialog.querySelector('select').value,'folder-a');
    dialog.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();assert.equal(calls.length,0);
    dialog.querySelector('[data-attribution-level]').value='personal';
    dialog.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();assert.equal(calls.length,1);assert.equal(calls[0].payload.directory_id,'folder-a');assert.deepEqual(calls[0].payload.attribution,{level:'personal'});assert.equal(dialog.querySelector('select').disabled,true);
    dialog.querySelector('[data-cancel]').click();assert.ok(dialog.isConnected);dialog.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();assert.deepEqual(calls[1],calls[0]);assert.equal(dialog.isConnected,false);
  }finally{controller.abort();dom.window.close();}
});

const accessDirectory={name:'folder-a',path:'/采购',title:'采购',modified:'2026-09-23 10:00:00',access:{mode:'inherit',identities:[],groups:[]}};
const accessOptions={version:1,people:[{identity_id:'person-1',label:'采购同事',group:'财务'}],groups:['财务']};
it('目录权限在原目录工具栏管理，先选范围，明确保存才写入',async()=>{
  const calls:any[]=[];
  const {w,dom,controller}=mount(async(url,options)=>{
    if(url==='/api/session')return response({user:{username:'worker'}});
    if(url.includes('files.directories'))return response({directories:[accessDirectory],can_manage:true,access_options:accessOptions});
    if(url.includes('/actions/')){calls.push({url,...JSON.parse(options.body)});return response({result:{directory:'folder-a',mode:'restricted',modified:'2026-09-23 11:00:00'}});}
    return response({rows:[],total:0});
  });
  try{await settle();const button=w.document.querySelector('#directory-access');assert.ok(button);assert.equal(button.disabled,true);
    const select=w.document.querySelector('#directory-filter');select.value='folder-a';select.dispatchEvent(new w.Event('change'));await settle();button.click();
    const dialog=w.document.querySelector('.file-operation-dialog');assert.match(dialog.textContent,/采购同事/);assert.equal(calls.length,0);
    const mode=dialog.querySelector('[name="access-mode"]');mode.value='restricted';mode.dispatchEvent(new w.Event('change'));
    dialog.querySelector('[data-access-person]').click();dialog.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();
    assert.equal(calls.length,1);assert.match(calls[0].url,/files.directory_access/);
    assert.deepEqual(calls[0].payload,{directory:'folder-a',expected_modified:accessDirectory.modified,mode:'restricted',identities:['person-1'],groups:[]});assert.equal(dialog.isConnected,false);
  }finally{controller.abort();dom.window.close();}
});
it('目录授权结果未知锁定原授权和幂等键；403重试仍不能当作首次未写入',async()=>{
  const calls:any[]=[];
  const {w,dom,controller}=mount(async(url,options)=>{
    if(url==='/api/session')return response({user:{username:'worker'}});
    if(url.includes('files.directories'))return response({directories:[accessDirectory],can_manage:true,access_options:accessOptions});
    if(url.includes('/actions/')){calls.push(JSON.parse(options.body));return calls.length===1?response({error:'超时'},503):calls.length===2?response({error:'无权核实'},403):response({result:{directory:'folder-a',mode:'inherit',modified:'2026-09-23 11:00:00'}});}
    return response({rows:[],total:0});
  });
  try{await settle();const select=w.document.querySelector('#directory-filter');select.value='folder-a';select.dispatchEvent(new w.Event('change'));await settle();w.document.querySelector('#directory-access').click();
    const dialog=w.document.querySelector('.file-operation-dialog'),form=dialog.querySelector('form');form.dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();
    assert.equal(dialog.querySelector('[name="access-mode"]').disabled,true);dialog.querySelector('[data-cancel]').click();assert.ok(dialog.isConnected);
    form.dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();assert.equal(dialog.querySelector('[name="access-mode"]').disabled,true);
    form.dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();assert.deepEqual(calls[1],calls[0]);assert.deepEqual(calls[2],calls[0]);assert.equal(dialog.isConnected,false);
  }finally{controller.abort();dom.window.close();}
});
it('旧后端或员工目录结果不提供授权入口，不自造管理权限',async()=>{
  for(const canManage of [true,false]){
    const {w,dom,controller}=mount(async url=>url==='/api/session'?response({user:{username:'worker'}}):url.includes('files.directories')?response({directories:[accessDirectory],can_manage:canManage}):response({rows:[],total:0}));
    try{await settle();assert.equal(w.document.querySelector('#directory-access').hidden,true);}finally{controller.abort();dom.window.close();}
  }
});
it('同名授权人员必须有区分，不能让管理员盲选',async()=>{
  const {w,dom,controller}=mount(async url=>url==='/api/session'?response({user:{username:'worker'}}):url.includes('files.directories')?response({directories:[accessDirectory],can_manage:true,access_options:{version:1,groups:[],people:[{identity_id:'identity-111111',label:'同名员工'},{identity_id:'identity-222222',label:'同名员工'}]}}):response({rows:[],total:0}));
  try{await settle();const select=w.document.querySelector('#directory-filter');select.value='folder-a';select.dispatchEvent(new w.Event('change'));await settle();w.document.querySelector('#directory-access').click();
    const labels=Array.from(w.document.querySelectorAll('[data-access-person]'),(input:any)=>input.parentElement.textContent);assert.equal(new Set(labels).size,2);assert.ok(labels.every((label:any)=>label.includes('同名员工')));
  }finally{controller.abort();dom.window.close();}
});

it('所有人显示真实归属主体，缺失不退回上传人',async()=>{
 const rows=[{...row('部门'),owner_subject_kind:'Department',owner_subject:'dept-42'},{...row('员工'),owner_subject_kind:'Employee',owner_subject:'employee-7'},{...row('缺失'),owner_subject_kind:'Department'}];
 const t=mount(async url=>url.includes('/datasets/')?response({rows,total:3}):response({directories:[],can_manage:false}));
 try{await settle();const trs=Array.from(t.w.document.querySelectorAll('#file-rows tr')) as any[];assert.deepEqual(trs.map(tr=>tr.children[4].textContent.trim()),['部门 dept-42','员工 employee-7','部门 —']);assert.ok(trs.every(tr=>tr.children[3].textContent==='worker@example.invalid'));}finally{t.controller.abort();t.dom.window.close();}
});

it('人工上传取消零写，部门归属只使用当前获权目录且明确确认后提交',async()=>{
 const calls:any[]=[];const t=mount(async(url,options)=>{
  if(url.includes('platform.department'))return response({rows:[{name:'own-department',title:'本人部门',enabled:true}]});
  if(url.includes('files.directories'))return response({directories:[],can_manage:false});
  if(url.includes('/actions/')){calls.push(JSON.parse(options.body));return response({result:{file:'uploaded',version:1}});}
  return response({rows:[],total:0});
 });
 try{await settle();const picker=t.w.document.querySelector('#file-picker');Object.defineProperty(picker,'files',{value:[new t.w.File(['内容'],'部门.txt')]});
  picker.dispatchEvent(new t.w.Event('change'));await settle();t.w.document.querySelector('[data-cancel]').click();assert.equal(calls.length,0);
  picker.dispatchEvent(new t.w.Event('change'));await settle();const dialog=t.w.document.querySelector('.file-operation-dialog');
  dialog.querySelector('[data-attribution-level]').value='department';dialog.querySelector('form').dispatchEvent(new t.w.Event('submit',{cancelable:true}));await settle();assert.equal(calls.length,0);
  dialog.querySelector('[data-attribution-department]').value='own-department';dialog.querySelector('form').dispatchEvent(new t.w.Event('submit',{cancelable:true}));dialog.querySelector('form').dispatchEvent(new t.w.Event('submit',{cancelable:true}));await settle();
  assert.equal(calls.length,1);assert.deepEqual(calls[0].payload.attribution,{level:'department',department:'own-department'});
 }finally{t.controller.abort();t.dom.window.close();}
});

it('文件列表与详情显示权威归属，现代值覆盖旧所有人且旧记录仍回退',async()=>{
 const modern={...row('新上传'),owner_subject_kind:'Employee',owner_subject:'旧归属不得显示',attribution:{level:'department',department:'dept-current',department_title:'当前获权部门'},can_edit:true,metadata_revision:true,tags:[]};
 const t=mount(async(url)=>{
  if(url.includes('files.versions'))return response({file:modern,versions:[{version_no:1,frappe_file:'fixed-bytes'}]});
  if(url.includes('files.directories'))return response({directories:[],can_manage:false});
  if(url.includes('/datasets/'))return response({rows:[modern],total:1});
  if(url.includes('file-content'))return {...response('正文'),blob:async()=>new Blob(['正文'])};
  return response({people:[]});
 });
 try{await settle();const list=t.w.document.querySelector('#file-rows');assert.match(list.textContent,/部门.*当前获权部门/);assert.doesNotMatch(list.textContent,/旧归属不得显示/);
  list.querySelector('[data-open]').click();await settle();const detail=t.w.document.querySelector('.file-detail-dialog');assert.ok(detail);assert.match(detail.textContent,/所有人部门 当前获权部门/);assert.doesNotMatch(detail.textContent,/旧归属不得显示/);
  assert.deepEqual({...t.w.fileCenterOwnership({ownership:{level:'personal',owner_user:'current-owner'},owner_subject:'old'})},{kind:'Employee',subject:'current-owner',label:''});
  assert.deepEqual({...t.w.fileCenterOwnership({owner_subject_kind:'Department',owner_subject:'legacy-dept'})},{kind:'Department',subject:'legacy-dept',label:''});
 }finally{t.controller.abort();t.dom.window.close();}
});
it('关联邮件筛选稳定ID，导航仅当前文件页生效，返回重挂不累计监听',async()=>{
 const filters:any[]=[],navigation:string[]=[];const t=mount(async url=>{if(url.includes('/datasets/')){filters.push(JSON.parse(new URL(url,'http://localhost').searchParams.get('filters')||'{}'));return response({rows:[{...row('source-file'),related_mail:'mail-stable'}],total:1});}return response({directories:[],can_manage:false});});t.w.go=(route:string)=>navigation.push(route);
 try{await settle();const select=t.w.document.querySelector('#mail-filter');select.value='mail-stable';select.dispatchEvent(new t.w.Event('change'));await settle();assert.equal(filters.at(-1).related_mail,'mail-stable');t.w.document.querySelector('[data-mail="mail-stable"]').click();assert.deepEqual(navigation,['mail']);assert.equal(new URL(t.w.location.href).searchParams.get('mail'),'mail-stable');t.controller.abort();const outside=t.w.document.createElement('button');outside.dataset.mail='other-mail';t.w.document.body.append(outside);outside.click();assert.equal(navigation.length,1);const next=new t.w.AbortController();t.w.mountFileCenter(t.w.document.querySelector('#host'),{signal:next.signal});await settle();t.w.document.querySelector('[data-mail="mail-stable"]').click();assert.equal(navigation.length,2);next.abort();outside.click();assert.equal(navigation.length,2);}finally{t.controller.abort();t.dom.window.close();}
});

it('编辑器回执只更新目标文件，广播不重复取页，其它行保留原DOM',async()=>{
  let callbacks:any,reads=0;
  const rows=[{...row('one'),can_edit:true,modified:'2026-09-22 10:00:00'},{...row('two'),can_edit:true,modified:'2026-09-21 10:00:00'}];
  const t=mount(async url=>{if(url.includes('/datasets/')){reads++;return response({rows,total:2});}return response({directories:[],can_manage:false});},'http://localhost','window.attributionModule',false,w=>{
    w.mountFileEditingWorkspace=(options:any)=>{callbacks=options;return {open:async()=>{},canLeave:()=>true,dispose:()=>{}};};
  });
  try{
    await settle();const unchanged=t.w.document.querySelector('tr[data-file="one"]');
    t.w.dispatchEvent(new t.w.CustomEvent('shangshu:object-changed',{detail:{object_id:'files.file',name:'two',source:'file-editor'}}));
    await callbacks.onChanged({...rows[1],file_name:'已改名.txt',tags:['新','标签'],modified:'2026-09-23 10:00:00'});
    assert.equal(reads,1,'同一编辑器广播和回调不能造成两次全页读取');
    assert.equal(t.w.document.querySelector('tr[data-file="one"]'),unchanged,'无关行不重建');
    assert.match(t.w.document.querySelector('tr[data-file="two"]').textContent,/已改名/);
    assert.equal(t.w.document.querySelector('tr[data-file="two"] .file-tag').textContent,'新');
    assert.equal(t.w.document.querySelector('#file-rows tr').dataset.file,'two','权威修改时间改变时仅移动发生变化的行');
    assert.ok(t.w.document.querySelector('tr[data-file="two"] [data-rename]'),'局部替换后操作仍可用');
    await callbacks.onChanged({...rows[1],file_name:'迟到旧值.txt',modified:'2026-09-22 10:00:00'});
    assert.match(t.w.document.querySelector('tr[data-file="two"]').textContent,/已改名/);
    assert.equal(reads,1,'已持有较新权威回执时不倒退也不额外读全页');
  }finally{t.controller.abort();t.dom.window.close();}
});
it('已核实回收回执只移出目标；无需补页时不重读清单且总数准确',async()=>{
  let callbacks:any,reads=0;
  const rows=['one','two'].map(name=>({...row(name),can_edit:true}));
  const t=mount(async url=>{if(url.includes('/datasets/')){reads++;return response({rows,total:2});}return response({directories:[],can_manage:false});},'http://localhost','window.attributionModule',false,w=>{
    w.mountFileEditingWorkspace=(options:any)=>{callbacks=options;return {open:async()=>{},canLeave:()=>true,dispose:()=>{}};};
  });
  try{
    await settle();const unchanged=t.w.document.querySelector('tr[data-file="two"]');
    await callbacks.onChanged(rows[0],{action:'files.recycle',receipt:{file:'one',status:'Recycled'}});
    assert.equal(reads,1);assert.equal(t.w.document.querySelector('tr[data-file="one"]'),null);
    assert.equal(t.w.document.querySelector('tr[data-file="two"]'),unchanged);
    assert.match(t.w.document.querySelector('#page-info').textContent,/共 1 个/);
  }finally{t.controller.abort();t.dom.window.close();}
});
it('筛选中保存或新建只重读原条件的当前页，不清筛选或猜总数',async()=>{
  let callbacks:any;const calls:URL[]=[];
  const t=mount(async url=>{if(url.includes('/datasets/')){calls.push(new URL(url,'http://localhost'));return response({rows:[{...row('one'),can_edit:true}],total:50});}return response({directories:[],can_manage:false});},'http://localhost','window.attributionModule',false,w=>{
    w.mountFileEditingWorkspace=(options:any)=>{callbacks=options;return {open:async()=>{},canLeave:()=>true,dispose:()=>{}};};
  });
  try{
    await settle();const input=t.w.document.querySelector('#search');input.value='原条件';input.dispatchEvent(new t.w.Event('input'));await new Promise(resolve=>setTimeout(resolve,280));
    t.w.document.querySelector('#next-page').click();await settle();const before=calls.length;
    await callbacks.onChanged({name:'new-file'});
    assert.equal(calls.length,before+1);const query=calls.at(-1)!;
    assert.equal(query.searchParams.get('page'),'2');assert.equal(JSON.parse(query.searchParams.get('filters')!).q,'原条件');
    assert.equal(input.value,'原条件');assert.match(t.w.document.querySelector('#page-info').textContent,/共 50 个/);
  }finally{t.controller.abort();t.dom.window.close();}
});
