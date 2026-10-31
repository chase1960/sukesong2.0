import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';
const pause=()=>new Promise(r=>setTimeout(r,30));
const reply=(data:any,status=200)=>({ok:status<400,status,json:async()=>data});
// 公共关联选择器直接装载生产代码，断言请求边界及最终选择。
function mountPicker(fetcher:(url:string,init:any)=>Promise<any>){
  const dom=new JSDOM('<div id="picker"></div>',{url:'http://localhost',runScripts:'outside-only'}),w=dom.window as any;
  const calls:any[]=[],picked:any[]=[],notices:string[]=[],controller=new w.AbortController();let catalogCalls=0,cancelled=0;
  w.fetch=(url:string,init:any)=>{calls.push({url,init});return fetcher(url,init);};
  w.shangshuPlatformCatalog={objects:()=>{catalogCalls++;return Promise.resolve({list:[object]});}};
  w.eval(readFileSync(new URL('../../../shangshu-web/js/record-reference-picker.js',import.meta.url),'utf8'));
  const node=w.document.querySelector('#picker'),ui={signal:controller.signal,disposed:false,escape:(s:any)=>String(s??''),notify:(s:string)=>notices.push(s)};
  const picker=w.mountRecordReferencePicker({ui,node,onPick:(value:any)=>picked.push(value),onCancel:()=>cancelled++});
  return {w,node,calls,picked,notices,controller,picker,get catalogCalls(){return catalogCalls;},get cancelled(){return cancelled;},close(){picker.dispose();w.close();}};
}
const pickerSummary=(id='object-1',title='采购单')=>({id,title,source:'managed',operations:['read']});
const pickerDefinition=(id='object-1')=>({...object,id,query:{version:1}});
const pickerPage=(list:any[],total=list.length,page=1)=>reply({list,total,page,page_length:20});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

it('关联选择只读分页摘要与选中定义，记录只取显示字段，翻页总数沿服务端回执',async()=>{
  const t=mountPicker(async url=>{
    const u=new URL(url,'http://localhost');
    if(u.pathname==='/api/platform/objects')return pickerPage([pickerSummary(),pickerSummary('object-2')],43);
    if(u.pathname.endsWith('/records'))return reply({rows:[{name:'r1',title:'采购一'}],total:41});
    return reply({object:pickerDefinition()});
  });
  try{await tick();
    assert.equal(t.catalogCalls,0,'不得先读全量 catalog.objects 再筛');
    const directory=new URL(t.calls[0].url,'http://localhost');
    assert.equal(directory.searchParams.get('summary'),'1');assert.equal(directory.searchParams.get('page'),'1');assert.equal(directory.searchParams.get('page_length'),'20');
    assert.deepEqual(t.calls.filter(c=>/objects\/[^/]+$/.test(c.url)).map(c=>c.url),['/api/platform/objects/object-1']);
    const query=new URL(t.calls.find(c=>c.url.includes('/records?')).url,'http://localhost');
    assert.deepEqual(JSON.parse(query.searchParams.get('fields')!),['title']);assert.equal(query.searchParams.get('include_definition'),'0');
    assert.match(t.node.querySelector('[data-object-page]').textContent,/43/);
    assert.match(t.node.querySelector('[data-record-page]').textContent,/41/);
    t.node.querySelector('[data-record-next]').click();await tick();
    assert.equal(new URL(t.calls.at(-1).url,'http://localhost').searchParams.get('page'),'2');
    assert.equal(t.calls.filter(c=>/objects\/[^/]+$/.test(c.url)).length,1,'记录翻页不重复读定义');
    t.node.querySelector('[data-record-next]').click();await tick();assert.equal(t.node.querySelector('[data-record-next]').disabled,true);
  }finally{t.close();}
});

it('关联目录空资格页仍可翻页，搜索传服务端，重名选择保持对象 ID 和最终完整记录',async()=>{
  const t=mountPicker(async url=>{
    const u=new URL(url,'http://localhost');
    if(u.pathname==='/api/platform/objects')return u.searchParams.get('page')==='1'&&!u.searchParams.get('search')
      ?pickerPage([{...pickerSummary('native-1'),source:'native'}],21)
      :pickerPage([pickerSummary('object-A','同名表'),pickerSummary('object-B','同名表')],2,Number(u.searchParams.get('page')));
    const id=decodeURIComponent(u.pathname.split('/')[4]);
    if(u.pathname.endsWith('/records'))return reply({rows:[{name:'record-'+id,title:'同名记录'}],total:1});
    if(u.pathname.includes('/records/'))return reply({object:pickerDefinition(id),record:{name:'record-'+id,title:'同名记录',date:'2026-10-28',modified:'m2'}});
    return reply({object:pickerDefinition(id)});
  });
  try{await tick();assert.equal(t.node.querySelector('[data-object-next]').disabled,false);assert.equal(t.calls.length,1);
    t.node.querySelector('[data-object-next]').click();await tick();
    const select=t.node.querySelector('select');select.value='object-B';select.dispatchEvent(new t.w.Event('change'));await tick();
    t.node.querySelector('[data-record-pick]').click();await tick();
    assert.equal(t.picked[0].object_id,'object-B');assert.equal(t.picked[0].name,'record-object-B');assert.equal(t.picked[0].record.date,'2026-10-28');assert.equal(t.picked[0].object.id,'object-B');
    t.node.querySelector('[data-object-search]').value='同名表';t.node.querySelector('[data-object-find]').click();await tick();
    const searches=t.calls.filter(c=>c.url.startsWith('/api/platform/objects?'));
    const last=new URL(searches.at(-1).url,'http://localhost');assert.equal(last.searchParams.get('search'),'同名表');assert.equal(last.searchParams.get('page'),'1');
    t.node.querySelector('[aria-label="搜索关联记录"]').value='记录甲';t.node.querySelector('[data-record-find]').click();await tick();
    const records=new URL(t.calls.at(-1).url,'http://localhost');assert.deepEqual(JSON.parse(records.searchParams.get('filters')!),{$search:'记录甲'});
  }finally{t.close();}
});

it('切换目标和搜索中止旧读，迟到定义及记录不覆盖当前选择，销毁中止详情',async()=>{
  const pending:any[]=[];
  const t=mountPicker(async(url,init)=>{
    if(url.startsWith('/api/platform/objects?'))return pickerPage([pickerSummary('object-A'),pickerSummary('object-B')]);
    return new Promise(resolve=>pending.push({url,signal:init.signal,resolve}));
  });
  try{await tick();assert.equal(pending.length,1);
    const select=t.node.querySelector('select');select.value='object-B';select.dispatchEvent(new t.w.Event('change'));await tick();assert.equal(pending[0].signal.aborted,true);
    pending[0].resolve(reply({object:pickerDefinition('object-A')}));pending[1].resolve(reply({object:pickerDefinition('object-B')}));await tick();
    assert.equal(pending.filter(p=>p.url.includes('/object-A/records?')).length,0);
    const oldRecords=pending.at(-1);t.node.querySelector('[aria-label="搜索关联记录"]').value='新条件';t.node.querySelector('[data-record-find]').click();await tick();assert.equal(oldRecords.signal.aborted,true);
    pending.at(-1).resolve(reply({rows:[{name:'new',title:'当前结果'}],total:1}));oldRecords.resolve(reply({rows:[{name:'old',title:'迟到旧结果'}],total:900}));await tick();
    assert.equal(t.node.querySelector('[data-record-pick]').textContent,'当前结果');assert.match(t.node.querySelector('[data-record-page]').textContent,/1 条/);
    t.node.querySelector('[data-record-pick]').click();await tick();const detail=pending.at(-1);t.picker.dispose();assert.equal(detail.signal.aborted,true);detail.resolve(reply({object:pickerDefinition('object-B'),record:{name:'new'}}));await tick();assert.equal(t.picked.length,0);assert.equal(t.notices.length,0);
  }finally{t.close();}
});

it('取消与工作面离开中止目录读取，迟到清单不重开已关闭选择器',async()=>{
  for(const cancel of [false,true]){
    let release:(v:any)=>void=()=>{};
    const t=mountPicker(async()=>new Promise(resolve=>release=resolve));
    try{await tick();
      if(cancel)t.node.querySelector('[data-record-close]').click();else t.controller.abort();
      assert.equal(t.calls[0].init.signal.aborted,true);
      release(pickerPage([pickerSummary()]));await tick();assert.equal(t.calls.length,1);assert.equal(t.picked.length,0);assert.equal(t.cancelled,cancel?1:0);
    }finally{t.close();}
  }
});
it('无文本列只取身份投影，选中定义被拒不改读全目录或继续读记录',async()=>{
  for(const denied of [false,true]){
    const t=mountPicker(async url=>url.startsWith('/api/platform/objects?')?pickerPage([pickerSummary()]):url.includes('/records?')
      ?reply({rows:[{name:'identity-only'}],total:1}):denied?reply({error:'无权读取数据表'},403):reply({object:{...pickerDefinition(),fields:[]}}));
    try{await tick();assert.equal(t.catalogCalls,0);
      if(denied){assert.equal(t.calls.length,2);assert.match(t.node.querySelector('[data-record-options]').textContent,/无权读取/);}
      else{const query=new URL(t.calls.at(-1).url,'http://localhost');assert.deepEqual(JSON.parse(query.searchParams.get('fields')!),[]);assert.equal(t.node.querySelector('[data-record-pick]').textContent,'identity-only');}
    }finally{t.close();}
  }
});
const object={id:'object-1',source:'managed',title:'采购单',revision:1,operations:['read','update'],fields:[{id:'title',label:'名称',type:'text'},{id:'date',label:'日期',type:'date'},{id:'state',label:'只读状态',type:'choice',options:['已登记']}],input_schema:{properties:{title:{type:'string'},date:{type:'string'}}}};
async function mount(save:(body:any)=>Promise<any>){
  const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost',runScripts:'outside-only'}),w=dom.window as any;
  w.fetch=async(url:string,init:any)=>url.includes('/actions/')?save(JSON.parse(init.body)):reply({file:{name:'f1',file_name:'合同.txt',tags:[],note:'',modified:'m1',version:1},can_review:true,relations:[{object_id:object.id,name:'r1',object,record:{name:'r1',modified:'r-m1',title:'原名称',date:'2026-09-01'}}]});
  installToast(w); // 必须排在 tool-workspace.js 之前：notify 转调 globalThis.toast
  for(const name of ['tool-workspace','record-reference-picker','file-review'])w.eval(readFileSync(new URL(`../../../shangshu-web/js/${name}.js`,import.meta.url),'utf8'));
  const ui=w.createToolWorkspace(w.document.querySelector('#host'));ui.guardLeave(()=>ui.canCloseModals());
  await w.openFileReview({ui,file:{id:'f1'}});
  return {w,ui,close(){ui.dispose();w.close();}};
}
it('审核编辑先保留草稿，整份保存仅发送采用字段，不逐字段写正式值',async()=>{
  const calls:any[]=[];const ctx=await mount(async body=>{calls.push(body);return reply({result:{file:'f1',record:{modified:'m2'},relation_count:1}});});
  try{const {w}=ctx;const input=w.document.querySelector('[data-review-field="title"]');input.dispatchEvent(new w.MouseEvent('dblclick'));input.value='修改名称';input.dispatchEvent(new w.Event('input'));input.dispatchEvent(new w.Event('blur'));await pause();assert.equal(calls.length,0);w.document.querySelector('[data-review-save]').click();await pause();assert.deepEqual(calls[0].payload.relations[0].values,{title:'修改名称'});assert.equal(calls[0].payload.expected_version,1);assert.equal(w.document.querySelector('.file-review-dialog'),null);}
  finally{ctx.close();}
});
it('未知保存保留原请求，后续拒绝不准当作未写入后关闭',async()=>{
  const calls:any[]=[];const ctx=await mount(async body=>{calls.push(body);return reply({error:'待核实'},calls.length===1?503:403);});
  try{const {w}=ctx;w.document.querySelector('[data-review-save]').click();await pause();w.document.querySelector('[data-review-save]').click();await pause();assert.deepEqual(calls[0],calls[1]);w.document.querySelector('[data-review-cancel]').click();assert.ok(w.document.querySelector('.file-review-dialog'));assert.match(w.document.querySelector('[data-review-state]').textContent,/核实/);}
  finally{ctx.close();}
});
it('确定失败保留输入，取消不触发第二次写入',async()=>{
  let calls=0;const ctx=await mount(async()=>{calls++;return reply({error:'记录已变化'},409);});
  try{const {w}=ctx,input=w.document.querySelector('[data-review-field="title"]');input.value='草稿名称';input.dispatchEvent(new w.Event('input'));w.document.querySelector('[data-review-save]').click();await pause();assert.equal(input.value,'草稿名称');assert.equal(input.disabled,false);assert.equal(w.document.querySelector('[data-review-field="state"]').disabled,true);w.document.querySelector('[data-review-cancel]').click();assert.equal(calls,1);assert.equal(w.document.querySelector('.file-review-dialog'),null);}
  finally{ctx.close();}
});
it('审核复用记录选择器，选择只改本地关联，整份确认才写入',async()=>{
  const calls:any[]=[];const ctx=await mount(async body=>{calls.push(body);return reply({result:{file:'f1',record:{modified:'m2'},relation_count:2}});});
  try{const {w}=ctx,original=w.fetch;
    w.fetch=async(url:string,init:any)=>url.startsWith('/api/platform/objects?')?reply({list:[object],total:1,page:1,page_length:20}):url.includes('/objects/')?(url.includes('/records?')?reply({object,rows:[{name:'r2',title:'另一条采购'}],total:1}):reply({object,record:{name:'r2',title:'另一条采购',modified:'m2'}})):original(url,init);
    w.document.querySelector('[data-add-relation]').click();await pause();w.document.querySelector('[data-record-pick]').click();await pause();
    assert.match(w.document.querySelector('[data-relations]').textContent,/另一条采购/);assert.equal(calls.length,0);
    w.document.querySelector('[data-review-save]').click();await pause();assert.equal(calls[0].payload.relations.length,2);assert.equal(calls[0].payload.relations[1].name,'r2');assert.deepEqual(calls[0].payload.relations[1].values,{});
  }finally{ctx.close();}
});
it('文件审核重开选择器与关闭审核均中止原目录读取',async()=>{
  const ctx=await mount(async()=>reply({})),pending:any[]=[];
  try{ctx.w.fetch=async(url:string,init:any)=>new Promise(resolve=>pending.push({signal:init.signal,resolve}));
    ctx.w.document.querySelector('[data-add-relation]').click();await tick();
    ctx.w.document.querySelector('[data-add-relation]').click();await tick();assert.equal(pending[0].signal.aborted,true);
    ctx.w.document.querySelector('[data-review-cancel]').click();assert.equal(pending[1].signal.aborted,true);
    pending.forEach(p=>p.resolve(pickerPage([pickerSummary()])));await tick();assert.equal(ctx.w.document.querySelector('.file-review-dialog'),null);
  }finally{ctx.close();}
});

it('原件候选采用或保留只改本地，未核对禁止保存，整份保存不夹带保留字段',async()=>{
  const calls:any[]=[];const ctx=await mount(async body=>{calls.push(body);return reply({result:{file:'f1',record:{modified:'m2'},relation_count:1}});});
  try{const {w}=ctx,original=w.fetch;
    w.fetch=async(url:string,init:any)=>url.includes('/file-suggestions')?reply({source:{file:'original1'},expected_revision:1,expected_modified:'r-m1',candidates:[{field:'title',value:'原件名称',evidence:'名称：原件名称'},{field:'date',value:'2026-09-23',evidence:'日期：2026-09-23'}]}):url.includes('files.versions')?reply({result:{file:{modified:'m1',version:1},versions:[{version_no:1,frappe_file:'original1'}]}}):original(url,init);
    w.document.querySelector('[data-suggest-record]').click();await pause();await pause();
    assert.match(w.document.querySelector('[data-record-fields]').textContent,/名称：原件名称/);
    w.document.querySelector('[data-review-save]').click();await pause();assert.equal(calls.length,0);
    w.document.querySelector('[data-adopt-candidate="title"]').click();
    const candidate=w.document.querySelector('[data-edit-candidate="date"]');candidate.dispatchEvent(new w.MouseEvent('dblclick'));
    assert.equal(w.document.querySelector('[data-review-field="date"]').readOnly,false);
    w.document.querySelector('[data-keep-candidate="date"]').click();
    assert.equal(w.document.querySelector('[data-review-field="date"]').value,'2026-09-01');assert.equal(calls.length,0);
    w.document.querySelector('[data-review-save]').click();await pause();assert.deepEqual(calls[0].payload.relations[0].values,{title:'原件名称'});
  }finally{ctx.close();}
});
it('候选失败或迟到不覆盖手输，文件换版时不调用模型',async()=>{
  const ctx=await mount(async()=>reply({}));
  try{const {w}=ctx,original=w.fetch;let modelCalls=0;
    w.fetch=async(url:string,init:any)=>url.includes('/file-suggestions')?(modelCalls++,reply({error:'AI暂不可用'},422)):url.includes('files.versions')?reply({result:{file:{modified:'m1',version:1},versions:[{version_no:1,frappe_file:'original1'}]}}):original(url,init);
    const input=w.document.querySelector('[data-review-field="title"]');input.value='手工草稿';input.dispatchEvent(new w.Event('input'));
    w.document.querySelector('[data-suggest-record]').click();await pause();await pause();assert.equal(input.value,'手工草稿');assert.match(w.document.querySelector('[data-review-state]').textContent,/AI暂不可用/);assert.equal(modelCalls,1);
    w.fetch=async()=>reply({result:{file:{modified:'m2',version:2},versions:[]}});
    w.document.querySelector('[data-suggest-record]').click();await pause();assert.match(w.document.querySelector('[data-review-state]').textContent,/原件.*变化/);assert.equal(input.value,'手工草稿');
  }finally{ctx.close();}
});
