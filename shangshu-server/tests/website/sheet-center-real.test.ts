import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, toastText} from '../helpers/toast.ts';

const object={id:'com.shangshu.app.test.object.items',owner:'com.shangshu.app.test',source:'managed',title:'采购清单',revision:2,operations:['read','create','update'],fields:[
  {id:'title',label:'物品名称',type:'text',required:true},{id:'quantity',label:'数量',type:'integer'},{id:'secret',label:'只读说明',type:'text'}],
  input_schema:{type:'object',properties:{title:{type:'string',title:'物品名称'},quantity:{type:'integer',title:'数量'}},required:['title']}};
const rows=[{name:'row.with.dot',modified:'m1',title:'纸张',quantity:3,secret:'不可改'}];
const response=(value:unknown,status=200)=>({ok:status<400,status,json:async()=>value});
const settle=()=>new Promise(resolve=>setTimeout(resolve,20));

it('领域行编辑回原记录表单，不把列表摘要当完整明细；未保存单元格仍阻断',async()=>{
  const t=mount();const opened:any[]=[];
  try{t.controller.abort();t.w.schemaWithLookups=(schema:any)=>schema;t.w.openSchemaForm=()=>{throw Error('不能用列表摘要打开通用写表单');};
    t.w.mountSheetCenter(t.w.document.querySelector('#host'),{objectId:object.id,
      onEditRecord:(id:string,name:string)=>opened.push({id,name})});await settle();
    t.w.document.querySelector('[data-form]').click();assert.deepEqual(opened,[{id:object.id,name:rows[0].name}]);
    t.w.document.querySelector('#edit-mode').click();t.edit('quantity','9');
    t.w.document.querySelector('[data-form]').click();assert.equal(opened.length,1);
    assert.match(toastText(t.w),/未保存/);assert.equal(t.calls.length,0);
  }finally{t.dom.window.close();}
});

it('共享表格沿现有展示schema区分列名，无新增权限时收起按钮与新增空态提示',async()=>{
  const t=mount(undefined,true,{objectId:object.id,read:(_url,definition)=>response({object:{...definition,operations:['read','update']},rows:[],total:0})});
  try{t.controller.abort();t.w.mountSheetCenter(t.w.document.querySelector('#host'),{objectId:object.id,recordSchema:{properties:{quantity:{type:'integer'}},displayProperties:{title:{title:'正式名称'}}}});await settle();
    assert.match(t.w.document.querySelector('[data-sort="title"]').textContent,/正式名称/);
    assert.equal(t.w.document.querySelector('#add-row').hidden,true);
    assert.doesNotMatch(t.w.document.querySelector('#sheet-rows').textContent,/新增记录/);
    assert.equal(t.calls.length,0);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('中文选项显示与Excel粘贴可往返，保存仍用原代码',async()=>{
  const t=mount(undefined,true,{objectId:object.id,read:(_url,definition)=>response({object:{...definition,fields:definition.fields.map((field:any)=>field.id==='quantity'?{...field,type:'choice',options:['open','closed']}:field)},rows:[{...rows[0],quantity:'open'}],total:1})});
  try{t.controller.abort();t.w.mountSheetCenter(t.w.document.querySelector('#host'),{objectId:object.id,recordSchema:{properties:{quantity:{type:'string',enum:['open','closed'],enumNames:['未结案','已结案']}}}});await settle();
    t.w.document.querySelector('#edit-mode').click();const td=t.w.document.querySelector('td[data-field="quantity"]');
    const event=new t.w.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:()=> '已结案'}});td.dispatchEvent(event);
    assert.match(t.w.document.querySelector('td[data-field="quantity"]').textContent,/已结案/);
    await t.w.document.querySelector('#save-edits').onclick();await settle();assert.equal(t.calls[0].payload.values.quantity,'closed');
  }finally{t.dom.window.close();}
});

it('原生列沿公共动作schema收窄编辑并展示中文/多值，不改底层代码或稳定编号',async()=>{
  const t=mount(undefined,true,{objectId:object.id,read:(_url,definition)=>response({object:{...definition,fields:[...definition.fields,{id:'checked',type:'boolean',label:'已核实'}]},rows:[{...rows[0],title:'[{"id":"stable","value":"申请人甲"}]',secret:'invention',checked:0}],total:1})});
  try{t.controller.abort();t.w.mountSheetCenter(t.w.document.querySelector('#host'),{objectId:object.id,
    recordSchema:{properties:{quantity:{type:'integer'},title:{type:'array',items:{type:'object',properties:{id:{type:'string'},value:{type:'string'}}}}},
      displayProperties:{secret:{enum:['invention'],enumNames:['发明']},checked:{type:'boolean'}}}});await settle();
    assert.equal(t.w.document.querySelector('td[data-field="title"]').textContent,'申请人甲');
    assert.equal(t.w.document.querySelector('td[data-field="secret"]').textContent,'发明');
    assert.equal(t.w.document.querySelector('td[data-field="checked"]').textContent,'否');
    t.w.document.querySelector('#edit-mode').click();
    for(const field of ['secret','title']){const td=t.w.document.querySelector(`td[data-field="${field}"]`);assert.equal(td.dataset.editable,'');td.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true}));assert.equal(t.w.document.querySelector('.cell-input'),null);}
    t.edit('quantity','8');assert.equal(t.calls.length,0);t.w.document.querySelector('#discard-edits').click();
    let form:any;t.w.schemaWithLookups=(value:any)=>value;t.w.openSchemaForm=(options:any)=>{form=options;return t.w.document.createElement('dialog');};
    t.w.document.querySelector('[data-form]').click();assert.equal(form.properties.secret,undefined);
    assert.equal(form.values.title[0].id,'stable');assert.equal(form.values.title[0].value,'申请人甲');assert.equal(t.calls.length,0);
  }finally{t.dom.window.close();}
});

it('员工已获导入导出声明时显示入口；行详情可复用领域详情且脏格不可绕过',async()=>{
  const t=mount(undefined,true,{objectId:object.id,read:(_url,definition)=>response({object:{...definition,
    export:{available:true,service:'platform.object.export'},
    import:{version:1,available:true,service:'platform.object.import_preview',action:'platform.object.import'}},rows,total:1})});
  try{t.controller.abort();t.w.currentRole=()=> 'staff';const opened:any[]=[];
    t.w.mountSheetCenter(t.w.document.querySelector('#host'),{objectId:object.id,onOpenRecord:(id:string,name:string)=>opened.push({id,name})});await settle();
    assert.equal(t.w.document.querySelector('#export-sheet').hidden,false);
    assert.equal(t.w.document.querySelector('#import-sheet').hidden,false);
    t.w.document.querySelector('[data-open]').click();assert.deepEqual(opened,[{id:object.id,name:rows[0].name}]);
    assert.equal(t.w.document.querySelector('#row-detail').hidden,true);
    t.w.document.querySelector('#edit-mode').click();t.edit('title','未保存');t.w.document.querySelector('[data-open]').click();
    assert.equal(opened.length,1);assert.equal(t.calls.length,0);
  }finally{t.dom.window.close();}
});

it('真实矩形粘贴经原对象动作保存；只读格和关闭编辑模式整次拒绝',async()=>{
  const t=mount();try{await settle();
    const paste=(field:string,text:string)=>{const event=new t.w.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:()=>text}});t.w.document.querySelector(`td[data-field="${field}"]`).dispatchEvent(event);};
    paste('title','打印纸\t12');assert.equal(t.w.document.querySelectorAll('.is-dirty').length,2);assert.equal(t.calls.length,0);
    await t.w.document.querySelector('#save-edits').onclick();await settle();assert.equal(t.calls.length,1);assert.equal(t.calls[0].payload.values.quantity,12);assert.equal(t.calls[0].payload.values.title,'打印纸');assert.equal(t.calls[0].payload.expected_modified,'m1');
    paste('quantity','16\t不能修改');assert.equal(t.w.document.querySelectorAll('.is-dirty').length,0);assert.match(toastText(t.w),/只读/);
  }finally{t.controller.abort();t.dom.window.close();}
  const scoped=mount(undefined,true,{objectId:object.id});try{await settle();const event=new scoped.w.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:()=> '不可绕过模式'}});scoped.w.document.querySelector('td[data-field="title"]').dispatchEvent(event);assert.equal(scoped.w.document.querySelectorAll('.is-dirty').length,0);assert.equal(scoped.calls.length,0);}finally{scoped.controller.abort();scoped.dom.window.close();}
});

it('多字段筛选确认才查询，保留数字0且清除不残留',async()=>{
  const t=mount(undefined,true,{query:true});
  const filters=()=>JSON.parse(new URL(t.queries.at(-1)!,'http://localhost').searchParams.get('filters')||'{}');
  try{await settle();t.w.document.querySelector('#filter-fields').click();
    const title=t.w.document.querySelector('[data-filter-field="title"]'),quantity=t.w.document.querySelector('[data-filter-field="quantity"]');
    assert.ok(title);assert.ok(quantity);title.value='打印纸';quantity.value='0';
    const before=t.queries.length;t.w.document.querySelector('[data-filter-cancel]').click();assert.equal(t.queries.length,before);
    t.w.document.querySelector('#filter-fields').click();assert.equal(t.w.document.querySelector('[data-filter-field="title"]').value,'');
    t.w.document.querySelector('[data-filter-field="title"]').value='打印纸';t.w.document.querySelector('[data-filter-field="quantity"]').value='0';
    t.w.document.querySelector('[data-filter-apply]').click();await settle();
    assert.equal(filters().title,'打印纸');assert.equal(filters().quantity,0);
    assert.match(t.w.document.querySelector('#field-filter-summary').textContent,/物品名称.*打印纸.*数量.*0/);
    t.w.document.querySelector('#clear').click();await settle();assert.equal(filters().title,undefined);assert.equal(filters().quantity,undefined);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('筛选弹层拒绝无效数字；未保存的表格修改阻止改变筛选',async()=>{
  const t=mount(undefined,true,{query:true});try{await settle();t.w.document.querySelector('#filter-fields').click();
    const input=t.w.document.querySelector('[data-filter-field="quantity"]');input.value='1.2';
    t.w.document.querySelector('[data-filter-apply]').click();assert.ok(t.w.document.querySelector('[data-filter-apply]'));
    t.w.document.querySelector('[data-filter-cancel]').click();t.edit('title','不能丢');
    t.w.document.querySelector('#filter-fields').click();assert.equal(t.w.document.querySelector('[data-filter-apply]'),null);assert.match(toastText(t.w),/未保存/);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('正式表格加载及空目录不展示行业样例列或后端未接入误报',async()=>{
  const t=mount();try{
    assert.equal(t.w.document.querySelector('#sheet-head').textContent.includes('案件名称'),false);
    assert.equal(t.w.document.querySelector('#status-filter').hidden,true);
    // ⚠️ **加载态的契约变过**（契约 `loading-state-v1.json`，2026-10-30）：
    //   取数期间页头那个徽标**不许有看得见的文字** ⇒ 摆一条会呼吸的灰条。
    //   这条断言原来钉的是旧口径（「读取…」那几个字）⇒ 改盯新口径。
    const label=t.w.document.querySelector('.preview-label');
    assert.equal(label.textContent,'','加载中不许有看得见的文字（那会让人以为卡住了）');
    assert.ok(label.querySelector('[data-skeleton="sheet-status"]'),'加载态要摆会呼吸的灰条');
    assert.doesNotMatch(label.textContent,/未接入/,'不许在加载时误报「后端未接入」');
    await settle();t.w.fetch=async()=>response({list:[]});
    t.w.mountSheetCenter(t.w.document.querySelector('#host'));await settle();
    assert.equal(t.w.document.querySelector('#status-filter').hidden,true);
    assert.equal(t.w.document.querySelector('.sheet-note'),null,'开发说明行已删除，不应再出现');
    assert.equal(t.w.document.querySelector('#add-row').textContent,'新增记录');
  }finally{t.controller.abort();t.dom.window.close();}
});

it('员工使用既有表但不出现建表、字段配置和导入导出入口',async()=>{
  const t=mount();
  try{t.w.currentRole=()=> 'staff';t.w.mountSheetCenter(t.w.document.querySelector('#host'));await settle();
    for(const id of ['new-sheet','configure-sheet','import-sheet','export-sheet','examples-toggle'])assert.equal(t.w.document.getElementById(id).hidden,true,id);
    assert.match(t.w.document.querySelector('#sheet-rows').textContent,/纸张/);
    assert.equal(t.w.document.querySelector('#add-row').disabled,false);
    t.w.document.querySelector('#new-sheet').click();await settle();assert.equal(t.w.document.querySelector('.schema-form'),null);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('重开保留当前账号最近数据表，失效选择回落可见表，不跨账号恢复',async()=>{
  const t=mount();try{await settle();const original=t.w.fetch,second={...object,id:object.id+'.second',title:'另一张表'};
    t.w.fetch=async(url:string,opts:any)=>url==='/api/platform/objects'?response({list:[second,object]}):original(url,opts);
    t.w.mountSheetCenter(t.w.document.querySelector('#host'));await settle();assert.equal(t.w.document.querySelector('#sheet-select').value,object.id);
    t.w.currentUserInfo={username:'另一个人'};t.w.mountSheetCenter(t.w.document.querySelector('#host'));await settle();assert.equal(t.w.document.querySelector('#sheet-select').value,second.id);
    t.w.fetch=async(url:string,opts:any)=>url==='/api/platform/objects'?response({list:[object]}):original(url,opts);
    t.w.mountSheetCenter(t.w.document.querySelector('#host'));await settle();assert.equal(t.w.document.querySelector('#sheet-select').value,object.id);
  }finally{t.controller.abort();t.dom.window.close();}
});

const importCapability={version:1,available:true,service:'platform.object.import_preview',action:'platform.object.import',max_bytes:10485760,max_rows:500};
const importColumns=[{index:1,letter:'A',label:'物品名称'},{index:2,letter:'B',label:'数量'}];
const importPlan={sheets:['采购'],fields:object.fields.slice(0,2),columns:importColumns,errors:[],sample:[],preview_hash:'a'.repeat(64),
  summary:{create:1,update:0,unchanged:0,errors:0},rows:[{row:2,operation:'create',values:{title:'新纸张',quantity:8},changes:[{field:'title',label:'物品名称',before:null,after:'新纸张'}]}]};
function importMount(action?: (body:any)=>Promise<any>){
  const t=mount(action,true,{read:(_url,def)=>response({object:{...def,import:importCapability},rows,total:1})});
  const previews:any[]=[];const original=t.w.fetch;
  t.w.fetch=async(url:string,options:any)=>{if(url.includes('/services/platform.object.import_preview/')){const body=JSON.parse(options.body);previews.push(body);return response(body.payload.mapping?importPlan:{sheets:['采购'],fields:importPlan.fields,...(body.payload.sheet?{columns:importColumns,sample:[],errors:[]}: {})});}return original(url,options);};
  async function choose(){await settle();t.w.document.querySelector('#import-sheet').click();const file=t.w.document.querySelector('[data-import-file]');assert.ok(file);Object.defineProperty(file,'files',{value:[new t.w.File(['PK'], '采购.xlsx')],configurable:true});await file.onchange();t.w.document.querySelector('[data-import-sheet]').value='采购';await t.w.document.querySelector('[data-import-read]').onclick();}
  return {...t,previews,choose};
}

it('建业务表与导入现有表分开，取消导入不创建表或记录',async()=>{
  const t=importMount();
  t.w.openSchemaForm=()=>{throw Error('导入不得进入建表流程');};
  t.w.createModelDesigner=()=>{throw Error('导入不得进入字段设计器');};
  try{await settle();assert.equal(t.w.document.querySelector('#import-new-sheet'),null);
    assert.doesNotMatch(t.w.document.body.textContent,/从 Excel 新建表/);
    await t.choose();assert.equal(t.previews[0].payload.object_id,object.id);assert.equal(t.previews[0].payload.inspect_only,undefined);
    t.w.document.querySelector('[data-import-close]').click();assert.equal(t.w.document.querySelector('[data-import-file]'),null);assert.equal(t.calls.length,0);
    assert.ok(t.w.document.querySelector('#new-sheet'));
  }
  finally{t.controller.abort();t.dom.window.close();}
});

it('文件库导入读取选中版本并沿用预检，取消不写入也不修改原件',async()=>{
  const t=importMount();const original=t.w.fetch,reads:string[]=[];
  t.w.fetch=async(url:string,options:any)=>{
    reads.push(url);
    if(url.includes('/datasets/files.file/'))return response({rows:[{name:'lib-1',file_name:'采购.xlsx'}],total:1});
    if(url.includes('files.versions'))return response({versions:[{version_no:2,frappe_file:'new',size:2},{version_no:1,frappe_file:'old',size:2}]});
    if(url.includes('/file-content?'))return {ok:true,blob:async()=>new t.w.Blob(['PK'])};
    return original(url,options);
  };
  try{await settle();t.w.document.querySelector('#import-sheet').click();const entry=t.w.document.querySelector('[data-import-library]');assert.ok(entry);entry.click();
    t.w.document.querySelector('[data-attachment-value]').dispatchEvent(new t.w.MouseEvent('dblclick'));await settle();
    /* FIX-16：附件选择改走公共居中弹窗（.os-dialog）。 */
    const dlg=t.w.document.querySelector('dialog.os-dialog');assert.ok(dlg,'附件选择应开公共弹窗');
    dlg.querySelector('[data-pick-file]').click();await settle();dlg.querySelector('[data-pick-version="old"]').click();await settle();
    dlg.querySelector('[data-act="1"]').click();await settle();
    await t.w.document.querySelector('[data-import-use-reference]').onclick();
    assert.ok(reads.some(url=>url.includes('file=old')));assert.equal(t.previews[0].payload.filename,'采购.xlsx');assert.equal(t.previews[0].payload.content_base64,'UEs=');
    assert.match(t.w.document.querySelector('[data-import-source]').textContent,/采购.xlsx.*第 1 版/);assert.equal(t.calls.length,0);
    assert.equal(JSON.parse(new URL(reads.find(url=>url.includes('/datasets/files.file/'))!,'http://localhost').searchParams.get('filters')!).kind,'表格');
    t.w.document.querySelector('[data-import-close]').click();assert.equal(t.calls.length,0);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('文件库读取拒绝后清除旧导入内容，不偷换版本也不误用前一个文件',async()=>{
  const t=importMount();
  try{await t.choose();t.w.document.querySelector('[data-import-back]').click();const original=t.w.fetch;
    t.w.fetch=async(url:string,options:any)=>url.includes('/file-content?')?response({error:'已撤权'},403):original(url,options);
    t.w.mountFileReferencePicker=({values,onChange}:any)=>{values.push({file:'forbidden',lib:'lib-1',name:'撤权.xlsx',version:1,tag:'第 1 版'});onChange();return ()=>{};};
    t.w.document.querySelector('[data-import-library]').click();await t.w.document.querySelector('[data-import-use-reference]').onclick();
    assert.match(t.w.document.querySelector('[data-import-error]').textContent,/403/);assert.equal(t.w.document.querySelector('[data-import-read]').disabled,true);assert.equal(t.calls.length,0);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('导入先选工作表/映射并核对范围，取消零写入；确认携带预览指纹',async()=>{
  const t=importMount(async()=>response({result:{create:1,update:0,unchanged:0,errors:0}}));
  try{await t.choose();assert.equal(t.w.document.querySelector('[data-import-map="title"]').value,'1');
    assert.equal(t.w.document.querySelector('[data-import-match]').value,'','不得替用户猜唯一匹配列');
    t.w.document.querySelector('[data-import-match]').value='title';await t.w.document.querySelector('[data-import-check]').onclick();
    assert.match(t.w.document.querySelector('[data-import-result]').textContent,/新增.*1/);assert.match(t.w.document.querySelector('[data-import-result]').textContent,/新纸张/);assert.equal(t.calls.length,0);
    t.w.document.querySelector('[data-import-close]').click();assert.equal(t.calls.length,0);assert.equal(t.w.document.querySelector('[data-import-result]'),null);
    await t.choose();t.w.document.querySelector('[data-import-match]').value='title';await t.w.document.querySelector('[data-import-check]').onclick();await t.w.document.querySelector('[data-import-confirm]').onclick();
    assert.equal(t.calls.length,1);assert.equal(t.calls[0].confirmed,true);assert.equal(t.calls[0].payload.preview_hash,'a'.repeat(64));assert.deepEqual(t.calls[0].payload.mapping,{title:1,quantity:2});
    assert.equal(t.w.document.querySelector('[data-import-result]'),null);assert.match(toastText(t.w),/新增 1/);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('导入结果未知锁住原快照并同键重试，不能换文件或离页重复写',async()=>{
  const writes:any[]=[];const t=importMount(async body=>{writes.push(body);if(writes.length===1)throw Error('网络中断');return response({result:{create:1,update:0,unchanged:0,errors:0}});});
  try{await t.choose();t.w.document.querySelector('[data-import-match]').value='title';await t.w.document.querySelector('[data-import-check]').onclick();await t.w.document.querySelector('[data-import-confirm]').onclick();
    assert.match(t.w.document.querySelector('[data-import-error]').textContent,/结果.*待核实/);assert.equal(t.w.document.querySelector('[data-import-back]').disabled,true);
    assert.equal(t.w.dispatchEvent(new t.w.Event('shangshu:before-page-change',{cancelable:true})),false);
    t.w.document.querySelector('[data-import-close]').click();assert.ok(t.w.document.querySelector('[data-import-result]'));
    await t.w.document.querySelector('[data-import-confirm]').onclick();assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('导入成功回执缺失计数时不解锁或换幂等键',async()=>{
  const writes:any[]=[];const t=importMount(async body=>{writes.push(body);return response({result:writes.length===1?{}:{create:1,update:0,unchanged:0}});});
  try{await t.choose();t.w.document.querySelector('[data-import-match]').value='title';await t.w.document.querySelector('[data-import-check]').onclick();await t.w.document.querySelector('[data-import-confirm]').onclick();
    assert.match(t.w.document.querySelector('[data-import-error]').textContent,/待核实/);assert.equal(t.w.document.querySelector('[data-import-back]').disabled,true);
    await t.w.document.querySelector('[data-import-confirm]').onclick();assert.deepEqual(writes[0],writes[1]);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('导入未知后重试403仍保留原请求，不允许取消或改源文件重复导入',async()=>{
  const writes:any[]=[];const t=importMount(async body=>{writes.push(body);return response({error:writes.length===1?'网关中断':'权限已变'},writes.length===1?503:403);});
  try{await t.choose();t.w.document.querySelector('[data-import-match]').value='title';await t.w.document.querySelector('[data-import-check]').onclick();
    await t.w.document.querySelector('[data-import-confirm]').onclick();await t.w.document.querySelector('[data-import-confirm]').onclick();
    assert.equal(t.w.document.querySelector('[data-import-close]').disabled,true);assert.equal(t.w.document.querySelector('[data-import-library]').disabled,true);
    await t.w.document.querySelector('[data-import-confirm]').onclick();assert.deepEqual(writes[2],writes[0]);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('导入错误按行列展示并禁用确认，回退不丢映射；旧内核/脏格不能导入',async()=>{
  const t=importMount();const original=t.w.fetch;
  t.w.fetch=async(url:string,options:any)=>url.includes('/platform.object.import_preview/')&&JSON.parse(options.body).payload.mapping?response({...importPlan,summary:{...importPlan.summary,errors:1},errors:[{sheet:'采购',row:3,column:2,label:'数量',message:'请填写数字'}]}):original(url,options);
  try{await t.choose();t.w.document.querySelector('[data-import-match]').value='title';await t.w.document.querySelector('[data-import-check]').onclick();
    assert.equal(t.w.document.querySelector('[data-import-confirm]').disabled,true);assert.match(t.w.document.querySelector('[data-import-result]').textContent,/采购.*3.*数量.*请填写数字/s);
    t.w.document.querySelector('[data-import-back]').click();assert.equal(t.w.document.querySelector('[data-import-match]').value,'title');assert.equal(t.w.document.querySelector('[data-import-map="quantity"]').value,'2');
    t.w.document.querySelector('[data-import-close]').click();t.edit('title','未保存');t.w.document.querySelector('#import-sheet').click();assert.equal(t.w.document.querySelector('[data-import-file]'),null);
  }finally{t.controller.abort();t.dom.window.close();}
  const old=mount();try{await settle();assert.equal(old.w.document.querySelector('#import-sheet').disabled,true);}finally{old.controller.abort();old.dom.window.close();}
});

it('真实回收从详情确认，顶部回收站分页恢复；失败保留行与幂等键，不做前端假删除',async()=>{
  let recycled=false,fail=true;const writes:any[]=[];
  const t=mount(async body=>{writes.push(body);if(fail)return response({error:'记录仍被引用'},409);recycled=!recycled;return response({result:{name:rows[0].name,modified:recycled?'m2':'m3'}});},true,{read:(url,def)=>{
    const trash=JSON.parse(new URL(url,'http://localhost').searchParams.get('filters')||'{}').$scope==='trash';
    const shown=trash===recycled?[{...rows[0],modified:recycled?'m2':'m1',_lifecycle:{state:recycled?'trash':'active',recycled_at:'2026-09-22T10:00:00+05:30',recycled_by:'甲员工'}}]:[];
    return response({object:{...def,lifecycle:{version:1,available:true},operations:[...def.operations,'recycle','restore']},rows:shown,total:shown.length});
  }});
  try{await settle();const top=t.w.document.querySelector('#recycle-sheet');assert.ok(top);assert.equal(top.closest('header')!==null,true);assert.equal(top.disabled,false);
    t.w.document.querySelector('[data-open]').click();t.w.document.querySelector('#recycle-this').click();
    assert.equal(writes.length,0);let confirm=t.w.document.querySelector('[data-recycle-confirm]');assert.ok(confirm);await confirm.onclick();
    assert.match(t.w.document.querySelector('[data-recycle-error]').textContent,/仍被引用/);assert.ok(t.w.document.querySelector('[data-open]'));assert.equal(recycled,false);
    fail=false;await confirm.onclick();await settle();assert.equal(writes[0].idempotency_key,writes[1].idempotency_key);assert.equal(writes[1].payload.expected_modified,'m1');assert.equal(writes[1].confirmed,true);assert.equal(t.w.document.querySelector('[data-open]'),null);
    top.click();await settle();const panel=t.w.document.querySelector('[data-record-trash]');assert.ok(panel);assert.match(panel.textContent,/纸张/);assert.match(panel.textContent,/甲员工/);assert.doesNotMatch(panel.textContent,/30 天/);
    assert.equal(panel.querySelector('time').textContent,new Date('2026-09-22T10:00:00+05:30').toLocaleString('sv-SE',{hour12:false}));
    await panel.querySelector('[data-trash-restore]').onclick();await settle();assert.equal(writes.at(-1).payload.expected_modified,'m2');assert.equal(recycled,false);assert.ok(t.w.document.querySelector('[data-open]'));assert.match(panel.textContent,/回收站为空/);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('未接回收能力不展示可用按钮，未保存格阻止打开回收站',async()=>{
  const t=mount();try{await settle();assert.equal(t.w.document.querySelector('#recycle-sheet').disabled,true);t.w.document.querySelector('[data-open]').click();assert.equal(t.w.document.querySelector('#recycle-this'),null);}finally{t.controller.abort();t.dom.window.close();}
  const allowed=mount(undefined,true,{read:(_url,def)=>response({object:{...def,lifecycle:{version:1,available:true},operations:[...def.operations,'recycle','restore']},rows,total:1})});
  try{await settle();allowed.edit('title','未保存');allowed.w.document.querySelector('#recycle-sheet').click();await settle();assert.equal(allowed.w.document.querySelector('[data-record-trash]'),null);assert.match(toastText(allowed.w),/未保存/);}finally{allowed.controller.abort();allowed.dom.window.close();}
});

function mount(action:(body:any)=>Promise<any>=async()=>response({result:{modified:'m2'}}), writable=true, options:{objectId?:string,catalog?:any[],query?:boolean,read?:(url:string,definition:any)=>Promise<any>|any}={}){
  const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost/index.html#/sheets',runScripts:'outside-only'}),w=dom.window as any;
  const definition={...object,operations:writable?object.operations:['read'],...(options.query?{query:{version:1,search_fields:['title','secret'],sort_fields:['title','quantity','secret'],search_max_length:200}}:{})};
  const calls:any[]=[],queries:string[]=[];w.RENDER={};w.currentRole=()=> 'admin';w.currentUserInfo={username:'view-tester'};
  w.fetch=async(url:string,requestOptions:any)=>{
    if(url==='/api/platform/objects')return response({list:options.catalog||[definition,{id:'finance.ledger',source:'domain',operations:['read']}]});
    if(url==='/api/platform/application-definitions')return response({list:[{id:object.owner,draft:{title:'采购应用'},status:'Published'}]});
    if(url==='/api/platform/application-definitions/'+object.owner)return response({application:{id:object.owner,design_context:{models:[{id:object.id,definition:{title:object.title}}]}}});
    if(url.includes('/records')){queries.push(url);return options.read?options.read(url,definition):response({object:definition,rows,total:1,page:1,page_length:30});}
    const body=JSON.parse(requestOptions.body);calls.push(body);return action(body);
  };
  installToast(w);
  for(const file of ['tool-workspace','file-reference-picker','sheet-center'])w.eval(readFileSync(new URL(`../../../shangshu-web/js/${file}.js`,import.meta.url),'utf8'));
  const controller=new w.AbortController();w.mountSheetCenter(w.document.querySelector('#host'),{signal:controller.signal,objectId:options.objectId});
  const edit=(field:string,value:string)=>{const cell=w.document.querySelector(`[data-field="${field}"]`);cell.dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true}));const input=w.document.querySelector('.cell-input');assert.ok(input);input.value=value;input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));};
  return {dom,w,controller,calls,queries,edit};
}

it('应用内数据表限定对象，默认列表，显式启用同一表格编辑且隐藏跨表设计入口',async()=>{
  const t=mount(undefined,true,{objectId:object.id,catalog:[{...object,id:'other.object',title:'其他应用的数据'},object]});
  try{await settle();
    assert.equal(t.w.document.querySelector('h1').textContent,object.title);
    for(const id of ['sheet-select','new-sheet','configure-sheet','quick-sheet','examples-toggle'])assert.equal(t.w.document.getElementById(id).hidden,true,id);
    const cell=t.w.document.querySelector('[data-field="title"]');cell.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true}));
    assert.equal(t.w.document.querySelector('.cell-input'),null,'普通列表不应直接开启单元格编辑');
    assert.ok(t.w.document.querySelector('[data-form]'),'普通列表保留完整表单编辑');
    const mode=t.w.document.querySelector('#edit-mode');assert.equal(mode.hidden,false);assert.equal(mode.textContent,'表格编辑');
    mode.click();t.edit('title','打印纸');mode.click();assert.equal(mode.getAttribute('aria-pressed'),'true','未保存时不能退出');
    t.w.document.querySelector('#discard-edits').click();mode.click();assert.equal(mode.textContent,'表格编辑');
    assert.equal(t.w.document.querySelector('[data-field="title"]').textContent,'纸张');
    assert.ok(t.queries.every(url=>url.includes(encodeURIComponent(object.id))));assert.equal(t.calls.length,0);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('应用内普通列表表单仍经同一对象确认动作写入',async()=>{
  const t=mount(undefined,true,{objectId:object.id});let form:any;
  t.w.schemaWithLookups=(schema:any)=>schema;
  t.w.openSchemaForm=(options:any)=>{form=options;const dialog=t.w.document.createElement('div');t.w.document.body.append(dialog);return dialog;};
  try{await settle();t.w.document.querySelector('[data-form]').click();
    assert.equal(form.title,'编辑 · '+object.title);assert.equal(form.values.id,rows[0].name);
    await form.onSubmit({title:'已确认列表修改',quantity:4});
    assert.equal(t.calls.length,1);assert.deepEqual(t.calls[0].payload,{object_id:object.id,expected_revision:2,name:rows[0].name,expected_modified:'m1',values:{title:'已确认列表修改',quantity:4}});
    assert.equal(t.calls[0].confirmed,true);assert.equal(t.w.document.querySelector('#edit-mode').getAttribute('aria-pressed'),'false');
  }finally{t.controller.abort();t.dom.window.close();}
});

it('应用内对象缺失或服务端回错对象时明确失败，不回落另一张表或显示其记录',async()=>{
  /* ⚠️ **失败怎么显示，盯的是页头徽标 ＋ 提示条**（不是表格那一块）：
     产品把「读失败」摆在**页头徽标**（`setLabel('读取失败')`）和**提示条**上；
     表格那一块（`#sheet-rows`）在 2026-10-30 那次「加载态收成骨架」的改动里
     不再显示这句（`readError` 那一支够不着了）⇒ 这条判据改盯**真正在报失败的那两处**，
     判据要的事（「明确失败」「不回落另一张表」「不显示它的记录」）一条没减。 */
  const missing=mount(undefined,true,{objectId:'missing.object'});
  try{await settle();assert.equal(missing.queries.length,0);
    assert.match(missing.w.document.querySelector('.preview-label').textContent,/读取失败/,'页头徽标没有说「读取失败」');
    assert.match(toastText(missing.w),/不可访问|不存在/,'提示条没有说清为什么打不开');
    assert.doesNotMatch(missing.w.document.querySelector('#sheet-rows').textContent,/采购清单/,'回落显示了另一张表');
    assert.equal(missing.w.document.querySelector('#add-row').disabled,true);}
  finally{missing.controller.abort();missing.dom.window.close();}
  const wrong=mount(undefined,true,{objectId:object.id,read:(_url,definition)=>response({object:{...definition,id:'other.object'},rows:[{name:'secret-row',title:'不该展示'}],total:1})});
  try{await settle();assert.doesNotMatch(wrong.w.document.querySelector('#sheet-rows').textContent,/不该展示/);
    assert.match(wrong.w.document.querySelector('.preview-label').textContent,/读取失败/,'页头徽标没有说「读取失败」');
    assert.match(toastText(wrong.w),/读取失败|不符/,'提示条没有说清为什么失败');
    assert.equal(wrong.w.document.querySelector('#add-row').disabled,true);}
  finally{wrong.controller.abort();wrong.dom.window.close();}
});

it('应用内只读对象仍可查看，不能启用表格编辑',async()=>{
  const t=mount(undefined,false,{objectId:object.id});
  try{await settle();assert.match(t.w.document.querySelector('#sheet-rows').textContent,/纸张/);assert.equal(t.w.document.querySelector('#edit-mode').disabled,true);assert.equal(t.w.document.querySelector('[data-form]'),null);}
  finally{t.controller.abort();t.dom.window.close();}
});

it('对象成功变更只刷新当前对象；脏格或表单未关闭时保留输入并提示手动刷新',async()=>{
  const t=mount(undefined,true,{objectId:object.id});
  const changed=(id:string)=>t.w.dispatchEvent(new t.w.CustomEvent('shangshu:object-changed',{detail:{object_id:id,name:'new-record'}}));
  t.w.schemaWithLookups=(schema:any)=>schema;
  t.w.openSchemaForm=()=>{const dialog=t.w.document.createElement('div');dialog.id='test-edit-dialog';t.w.document.body.append(dialog);return dialog;};
  try{await settle();const initial=t.queries.length;changed('other.object');await settle();assert.equal(t.queries.length,initial);
    changed(object.id);await settle();assert.equal(t.queries.length,initial+1);
    t.w.document.querySelector('#edit-mode').click();t.edit('title','不能覆盖');changed(object.id);await settle();
    assert.equal(t.queries.length,initial+1);assert.equal(t.w.document.querySelector('[data-field="title"]').textContent,'不能覆盖');assert.match(toastText(t.w),/刷新/);
    t.w.document.querySelector('#refresh-sheet').click();await settle();assert.equal(t.queries.length,initial+1);
    t.w.document.querySelector('#discard-edits').click();t.w.document.querySelector('#refresh-sheet').click();await settle();assert.equal(t.queries.length,initial+2);
    t.w.document.querySelector('[data-form]').click();changed(object.id);await settle();assert.equal(t.queries.length,initial+2);assert.ok(t.w.document.querySelector('#test-edit-dialog'));
    t.w.document.querySelector('#test-edit-dialog').remove();t.w.document.querySelector('#refresh-sheet').click();await settle();assert.equal(t.queries.length,initial+3);
    t.controller.abort();changed(object.id);await settle();assert.equal(t.queries.length,initial+3);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('同对象Agent写入前守住人工脏格和表单，异对象与销毁后不受阻',async()=>{
  const t=mount(undefined,true,{objectId:object.id});
  const before=(id:string)=>t.w.dispatchEvent(new t.w.CustomEvent('shangshu:before-object-change',{cancelable:true,detail:{object_id:id}}));
  try{await settle();assert.equal(before(object.id),true);t.w.document.querySelector('#edit-mode').click();t.edit('title','人工未保存');
    assert.equal(before(object.id),false);assert.equal(before('another.object'),true);assert.match(t.w.document.querySelector('[data-field="title"]').textContent,/人工未保存/);
    t.w.document.querySelector('#discard-edits').click();assert.equal(before(object.id),true);
    t.controller.abort();assert.equal(before(object.id),true);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('保存接收服务器派生金额，期间的新单元格修订不被旧回执覆盖',async()=>{
  let release:any;
  const t=mount(()=>new Promise(resolve=>{release=resolve;}),true,{read:(_url,definition)=>response({object:{...definition,fields:[...definition.fields,{id:'amount',label:'金额',type:'decimal'}]},rows:rows.map(row=>({...row,amount:30})),total:1})});
  try{await settle();t.edit('quantity','5');const saving=t.w.document.querySelector('#save-edits').onclick();
    t.edit('quantity','7');t.edit('title','仍未保存');
    release(response({result:{name:rows[0].name,modified:'m2',record:{...rows[0],quantity:5,amount:50,title:'服务器名称',private_value:'不应显示'}}}));await saving;
    assert.equal(t.w.document.querySelector('[data-field="amount"]').textContent,'50');
    assert.equal(t.w.document.querySelector('[data-field="quantity"]').textContent,'7');
    assert.equal(t.w.document.querySelector('[data-field="title"]').textContent,'仍未保存');
    assert.equal(t.w.document.querySelectorAll('.is-dirty').length,2);
    t.w.document.querySelector('#discard-edits').click();
    assert.equal(t.w.document.querySelector('[data-field="quantity"]').textContent,'5');
    assert.equal(t.w.document.querySelector('[data-field="title"]').textContent,'服务器名称');
    assert.doesNotMatch(t.w.document.body.textContent,/不应显示/);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('已声明能力时全表搜索排序分页走原查询入口，不再二次本页过滤',async()=>{
  const t=mount(undefined,true,{query:true,read:(_url,definition)=>response({object:definition,rows,total:61})});
  const filters=()=>JSON.parse(new URL(t.queries.at(-1)!,'http://localhost').searchParams.get('filters')||'{}');
  try{await settle();const search=t.w.document.querySelector('#search');search.value='正文中存在的词';search.dispatchEvent(new t.w.Event('input'));
    await new Promise(r=>setTimeout(r,300));assert.equal(filters().$search,'正文中存在的词');
    assert.match(t.w.document.querySelector('#sheet-rows').textContent,/纸张/,'不得对服务端命中的结果再筛掉');
    t.w.document.querySelector('[data-sort="quantity"]').click();await settle();assert.equal(filters().$sort,'quantity');assert.equal(filters().$direction,'asc');
    t.w.document.querySelector('#sheet-next').click();await settle();assert.equal(new URL(t.queries.at(-1)!,'http://localhost').searchParams.get('page'),'2');
    assert.match(t.w.document.querySelector('#result-count').textContent,/61/);
    assert.doesNotMatch(t.w.document.querySelector('[data-sort]').getAttribute('aria-label'),/当前页/);
    assert.match(t.w.document.querySelector('[data-sort="quantity"]').textContent,/数量/,'列标题本身必须可点击，不能靠空按钮排序');
  }finally{t.controller.abort();t.dom.window.close();}
});

it('导出走声明的 XLSX 服务和当前筛选，只有正式值，不读取当前页拼文件',async()=>{
  const t=mount(undefined,true,{query:true,read:(_url,def)=>response({object:{...def,export:{version:1,service:'platform.object.export',format:'xlsx',available:true}},rows,total:61})});
  const exports:any[]=[],downloads:any[]=[];let released='',fail=false;const original=t.w.fetch;
  t.w.URL.createObjectURL=()=> 'blob:export-test';t.w.URL.revokeObjectURL=(url:string)=>{released=url;};
  t.w.HTMLAnchorElement.prototype.click=function(){downloads.push({filename:this.download,href:this.href});};
  t.w.fetch=async(url:string,options:any)=>{
    if(url==='/api/platform/services/platform.object.export/invoke'){if(fail)throw Error('服务不可用');exports.push(JSON.parse(options.body));return response({content_base64:'UEs=',filename:'采购清单.xlsx',mime_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',total:61});}
    return original(url,options);
  };
  try{await settle();const search=t.w.document.querySelector('#search');search.value='物品';search.dispatchEvent(new t.w.Event('input'));await new Promise(r=>setTimeout(r,300));
    t.w.document.querySelector('#filter-fields').click();t.w.document.querySelector('[data-filter-field="quantity"]').value='0';t.w.document.querySelector('[data-filter-apply]').click();await settle();
    const button=t.w.document.querySelector('#export-sheet');assert.ok(button);assert.equal(button.disabled,false);button.click();await settle();
    assert.deepEqual(exports,[{payload:{object_id:object.id,expected_revision:2,filters:{quantity:0,$search:'物品'}}}]);assert.equal(downloads[0].filename,'采购清单.xlsx');assert.match(toastText(t.w),/61/);
    t.edit('title','未保存的文字');button.click();await settle();assert.equal(exports.length,1);assert.match(t.w.document.querySelector('[data-field="title"]').textContent,/未保存的文字/);
    t.w.document.querySelector('#discard-edits').click();fail=true;button.click();await settle();assert.equal(downloads.length,1);assert.match(toastText(t.w),/导出失败.*服务不可用/);assert.equal(button.disabled,false);
  }finally{t.controller.abort();assert.equal(released,'blob:export-test');t.dom.window.close();}
});

it('未声明导出能力时禁用入口，不伪造下载',async()=>{
  const t=mount();const downloads:any[]=[];t.w.HTMLAnchorElement.prototype.click=function(){downloads.push(this.href);};
  try{await settle();const button=t.w.document.querySelector('#export-sheet');assert.ok(button);assert.equal(button.disabled,true);assert.equal(downloads.length,0);}
  finally{t.controller.abort();t.dom.window.close();}
});

it('记录详情的历史按当前行查询，显示操作者/时间/前后值并分页，HTML 不执行',async()=>{
  const t=mount(undefined,true,{read:(_url,def)=>response({object:{...def,history:{version:1,service:'platform.object.history'}},rows,total:1})});
  const queries:any[]=[];const original=t.w.fetch;
  t.w.fetch=async(url:string,options:any)=>{
    if(url==='/api/platform/services/platform.object.history/invoke'){
      queries.push(JSON.parse(options.body));const page=queries.at(-1).payload.page;
      return response({items:[{actor:'甲员工',time:'2026-09-22T10:20:30+08:00',operation:'update',source:'import',changes:[{label:'数量',type:'integer',before:3,after:8},{label:'名称',type:'text',before:'<img src=x onerror=alert(1)>',after:'纸张'}]}],page,page_length:20,total:21,notice:'接入前历史不可还原'});
    }return original(url,options);
  };
  try{await settle();t.w.document.querySelector('[data-open]').click();const button=t.w.document.querySelector('#record-history');assert.ok(button);button.click();await settle();
    const panel=t.w.document.querySelector('[data-record-history]');assert.ok(panel);assert.match(panel.textContent,/甲员工/);assert.match(panel.textContent,/2026-09-22/);assert.match(panel.textContent,/修改前/);assert.match(panel.textContent,/修改后/);assert.equal(panel.querySelector('img'),null);
    assert.equal(panel.querySelector('time').getAttribute('datetime'),'2026-09-22T10:20:30+08:00');assert.equal(panel.querySelector('time').textContent,new Date('2026-09-22T10:20:30+08:00').toLocaleString('sv-SE',{hour12:false}));
    assert.match(panel.textContent,/Excel 导入 · 修改/);
    assert.deepEqual(queries[0],{payload:{object_id:object.id,name:'row.with.dot',page:1,page_length:20}});
    panel.querySelector('[data-history-next]').click();await settle();assert.equal(queries[1].payload.page,2);assert.equal(t.calls.length,0);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('历史读取失败明确显示，可重试；关闭后的迟到回执不重开弹层',async()=>{
  const t=mount(undefined,true,{read:(_url,def)=>response({object:{...def,history:{version:1,service:'platform.object.history'}},rows,total:1})});
  let fail=true,resolve:any;const original=t.w.fetch;
  t.w.fetch=async(url:string,options:any)=>url==='/api/platform/services/platform.object.history/invoke'?(fail?response({error:'无权查看'},403):new Promise(r=>resolve=r)):original(url,options);
  try{await settle();t.w.document.querySelector('[data-open]').click();t.w.document.querySelector('#record-history').click();await settle();
    assert.match(t.w.document.querySelector('[data-record-history]').textContent,/读取失败.*无权查看/);fail=false;
    t.w.document.querySelector('[data-history-retry]').click();await settle();t.w.document.querySelector('[data-history-close]').click();
    resolve(response({items:[],total:0,page:1,page_length:20}));await settle();assert.equal(t.w.document.querySelector('[data-record-history]'),null);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('列管理只改变当前身份的本地视图，不写 schema，刷新保留且至少留一列',async()=>{
  const t=mount();
  const open=()=>{t.w.document.querySelector('#manage-columns').click();return t.w.document.querySelector('[data-column-options]');};
  try{await settle();let panel=open();assert.ok(panel);
    panel.querySelector('[data-column="secret"]').checked=false;panel.querySelector('[data-columns-apply]').click();
    assert.equal(t.w.document.querySelector('[data-field="secret"]'),null);assert.equal(t.calls.length,0);
    const raw=t.w.localStorage.getItem(t.w.localStorage.key(0));assert.ok(raw);assert.doesNotMatch(raw!,/纸张|不可改/);
    t.controller.abort();t.w.mountSheetCenter(t.w.document.querySelector('#host'),{});await settle();
    assert.equal(t.w.document.querySelector('[data-field="secret"]'),null);
    panel=open();panel.querySelectorAll('[data-column]').forEach((el:any)=>el.checked=false);panel.querySelector('[data-columns-apply]').click();
    assert.match(panel.textContent,/至少保留一列/);assert.ok(t.w.document.querySelector('[data-field="title"]'));
    panel.querySelector('[data-columns-default]').click();assert.ok(t.w.document.querySelector('[data-field="secret"]'));
  }finally{t.w.dispatchEvent(new t.w.Event('pagehide'));t.dom.window.close();}
});

it('列宽支持键盘、双击复位；未保存格不能被视图切换清掉，偏好不跨账号',async()=>{
  const t=mount();
  try{await settle();const handle=t.w.document.querySelector('[data-resize="quantity"]');assert.ok(handle);
    handle.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    assert.equal(handle.getAttribute('aria-valuenow'),'160');assert.equal(t.calls.length,0);
    handle.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true}));assert.equal(handle.getAttribute('aria-valuenow'),'140');
    t.edit('title','视图调整不能丢');t.w.document.querySelector('#manage-columns').click();assert.equal(t.w.document.querySelector('[data-column-options]'),null);
    assert.match(t.w.document.querySelector('[data-field="title"]').textContent,/视图调整不能丢/);
    t.w.document.querySelector('#discard-edits').click();t.w.document.querySelector('#manage-columns').click();
    t.w.document.querySelector('[data-column="secret"]').checked=false;t.w.document.querySelector('[data-columns-apply]').click();
    t.controller.abort();t.w.currentUserInfo={username:'another-user'};t.w.mountSheetCenter(t.w.document.querySelector('#host'),{});await settle();assert.ok(t.w.document.querySelector('[data-field="secret"]'));
  }finally{t.w.dispatchEvent(new t.w.Event('pagehide'));t.dom.window.close();}
});

it('列宽拖动限制范围、取消恢复，旧视图不能恢复当前不可见字段',async()=>{
  let hideSecret=false;
  const t=mount(undefined,true,{read:(_url,def)=>response({object:{...def,fields:hideSecret?def.fields.filter((f:any)=>f.id!=='secret'):def.fields},rows,total:1})});
  try{await settle();let handle=t.w.document.querySelector('[data-resize="quantity"]');
    handle.dispatchEvent(new t.w.MouseEvent('pointerdown',{button:0,clientX:100,bubbles:true}));
    t.w.dispatchEvent(new t.w.MouseEvent('pointermove',{clientX:2000}));assert.equal(handle.getAttribute('aria-valuenow'),'560');
    t.w.dispatchEvent(new t.w.Event('pointercancel'));assert.equal(handle.getAttribute('aria-valuenow'),'140');
    handle.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Home'}));assert.equal(handle.getAttribute('aria-valuenow'),'88');
    hideSecret=true;t.controller.abort();t.w.mountSheetCenter(t.w.document.querySelector('#host'),{});await settle();
    t.w.document.querySelector('#manage-columns').click();assert.equal(t.w.document.querySelector('[data-column="secret"]'),null);assert.equal(t.w.document.querySelector('[data-field="secret"]'),null);
  }finally{t.w.dispatchEvent(new t.w.Event('pagehide'));t.dom.window.close();}
});

it('表格原地建表和配置字段复用建模编辑器，所属应用明确且未关闭前禁止离页',async()=>{
  const t=mount();let created=0,edited='',disposed=0,open=false;let choose:any;
  t.w.openSchemaForm=(spec:any)=>{choose=spec;const dialog=t.w.document.createElement('dialog');dialog.innerHTML='<select name="application"><option value="0">采购应用</option></select><div data-schema-field="title"><input name="title"></div>';t.w.document.body.append(dialog);return dialog;};
  t.w.createModelDesigner=(application:any)=>{assert.equal(application.id,object.owner);return {create(){created++;open=true;},edit(model:any){edited=model.id;open=true;},hasOpenDialog:()=>open,dispose(){disposed++;open=false;}};};
  try{await settle();assert.ok(t.w.document.querySelector('#new-sheet'));assert.ok(t.w.document.querySelector('#configure-sheet'));
    assert.equal(t.w.document.querySelector('#new-sheet').closest('details'),null);assert.equal(t.w.document.querySelector('#configure-sheet').closest('details'),null);
    assert.match(t.w.document.querySelector('#new-sheet').textContent,/业务表/);assert.match(t.w.document.querySelector('#configure-sheet').textContent,/字段/);
    t.w.document.querySelector('#new-sheet').click();await settle();
    assert.equal(choose.values.application,object.owner);assert.equal(choose.properties.application.enum[0],object.owner);assert.equal(choose.properties.application.enumNames[0],'采购应用');
    await choose.onSubmit({application:object.owner});assert.equal(created,1);
    assert.equal(t.w.dispatchEvent(new t.w.Event('shangshu:before-page-change',{cancelable:true})),false);
    t.w.document.querySelector('dialog').remove();open=false;t.w.document.querySelector('#configure-sheet').click();await settle();assert.equal(edited,object.id);
    t.controller.abort();assert.ok(disposed>0);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('无应用时显式创建应用，响应未知重试同一键，不自动发布或绑定权限',async()=>{
  const t=mount();let choose:any,created=0;const writes:any[]=[];const original=t.w.fetch;
  t.w.fetch=async(url:string,options:any)=>{
    if(url==='/api/platform/application-definitions'){
      if(!options?.body)return response({list:[]});
      writes.push(JSON.parse(options.body));if(writes.length===1)throw Error('响应未知');
      return response({application:{id:object.owner}});
    }
    assert.doesNotMatch(url,/publish|\/draft|\/status/);return original(url,options);
  };
  t.w.openSchemaForm=(spec:any)=>{choose=spec;const dialog=t.w.document.createElement('dialog');dialog.innerHTML='<select name="application"><option value="0">新建应用</option></select><div data-schema-field="title"><input name="title"></div>';t.w.document.body.append(dialog);return dialog;};
  t.w.createModelDesigner=()=>({create(){created++;},hasOpenDialog:()=>false,dispose(){}});
  try{await settle();t.w.document.querySelector('#new-sheet').click();await settle();assert.equal(choose.values.application,'__new__');
    await assert.rejects(choose.onSubmit({application:'__new__',title:''}),/新应用名称/);assert.equal(writes.length,0);
    await assert.rejects(choose.onSubmit({application:'__new__',title:'内部采购'}),/响应未知/);
    await choose.onSubmit({application:'__new__',title:'内部采购'});assert.equal(writes.length,2);assert.equal(writes[0].idempotency_key,writes[1].idempotency_key);assert.equal(created,1);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('真实搜索和排序不清掉未保存格，拒绝后恢复筛选条件',async()=>{
  const t=mount(undefined,true,{query:true});
  try{await settle();t.edit('title','必须保留');const before=t.queries.length;
    const search=t.w.document.querySelector('#search');search.value='别的记录';search.dispatchEvent(new t.w.Event('input'));await new Promise(r=>setTimeout(r,300));
    t.w.document.querySelector('[data-sort="quantity"]').click();await settle();
    assert.equal(t.queries.length,before);assert.equal(search.value,'');assert.match(t.w.document.querySelector('[data-field="title"]').textContent,/必须保留/);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('搜索回执乱序不覆盖新查询，真实读取错误不伪装空表',async()=>{
  let old:(v:any)=>void=()=>{},definition:any;
  const t=mount(undefined,true,{query:true,read:(url,def)=>{
    definition=def;const q=JSON.parse(new URL(url,'http://localhost').searchParams.get('filters')||'{}').$search;
    if(q==='旧词')return new Promise(resolve=>{old=resolve;});
    if(q==='出错')return response({error:'读取权限已撤销'},403);
    return response({object:def,rows:[{...rows[0],title:q||'初始'}],total:1});
  }});
  const search=async(value:string)=>{const el=t.w.document.querySelector('#search');el.value=value;el.dispatchEvent(new t.w.Event('input'));await new Promise(r=>setTimeout(r,250));};
  try{await settle();await search('旧词');await search('新词');old(response({object:definition,rows:[{...rows[0],title:'过期结果'}],total:1}));await settle();
    assert.match(t.w.document.querySelector('#sheet-rows').textContent,/新词/);assert.doesNotMatch(t.w.document.querySelector('#sheet-rows').textContent,/过期结果/);
    // ⚠️ 同上：**失败摆在页头徽标 ＋ 提示条**上（表格那一块不再显示这句）⇒ 改盯那两处。
    await search('出错');
    assert.match(t.w.document.querySelector('.preview-label').textContent,/读取失败/,'页头徽标没有说「读取失败」（不许把读失败当成读到了）');
    assert.match(toastText(t.w),/读取权限已撤销/,'提示条没有说清真实读取错误');
    assert.doesNotMatch(t.w.document.querySelector('#sheet-rows').textContent,/过期结果/);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('搜索防抖期间开始编格时取消查询并保留原页码',async()=>{
  const t=mount(undefined,true,{query:true,read:(_url,def)=>response({object:def,rows,total:61})});
  try{await settle();t.w.document.querySelector('#sheet-next').click();await settle();
    const before=t.queries.length,search=t.w.document.querySelector('#search');
    search.value='尚未发出的查询';search.dispatchEvent(new t.w.Event('input'));t.edit('title','第二页的新稿');
    await new Promise(r=>setTimeout(r,300));
    assert.equal(t.queries.length,before);assert.equal(search.value,'');
    assert.match(t.w.document.querySelector('#sheet-page-info').textContent,/第 2 页/);
    assert.match(t.w.document.querySelector('[data-field="title"]').textContent,/第二页的新稿/);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('真实工作面从受管对象声明生成列，不把财务账本放入普通可编辑表',async()=>{
  const {dom,w,controller}=mount();
  try{await settle();assert.match(w.document.querySelector('#sheet-head').textContent,/物品名称/);assert.doesNotMatch(w.document.querySelector('#sheet-head').textContent,/案号/);assert.equal(w.document.querySelectorAll('#sheet-select option').length,1);assert.match(w.document.querySelector('#sheet-rows').textContent,/纸张/);assert.equal(w.document.querySelector('[data-field="secret"]').dataset.editable,'');}
  finally{controller.abort();dom.window.close();}
});

it('双击直接编格，保存走公共确认动作且带定义与记录版本，数值不转字符串',async()=>{
  const {dom,w,controller,calls,edit}=mount();
  try{await settle();edit('quantity','8');w.document.querySelector('#save-edits').click();await settle();assert.equal(calls.length,1);assert.deepEqual(calls[0].payload,{object_id:object.id,expected_revision:2,name:'row.with.dot',expected_modified:'m1',values:{quantity:8}});assert.equal(calls[0].confirmed,true);assert.equal(w.document.querySelectorAll('.is-dirty').length,0);}
  finally{controller.abort();dom.window.close();}
});

it('保存期间继续输入不被迟到回执清掉，新一轮保存用新版本',async()=>{
  let finish:(value:any)=>void=()=>{};let first=true;
  const {dom,w,controller,calls,edit}=mount(async()=>{if(first){first=false;return new Promise(resolve=>{finish=resolve;});}return response({result:{modified:'m3'}});});
  try{await settle();edit('title','第一稿');w.document.querySelector('#save-edits').click();await settle();edit('title','第二稿');finish(response({result:{modified:'m2'}}));await settle();assert.match(w.document.querySelector('[data-field="title"]').textContent,/第二稿/);assert.equal(w.document.querySelectorAll('.is-dirty').length,1);w.document.querySelector('#save-edits').click();await settle();assert.equal(calls[1].payload.expected_modified,'m2');assert.equal(calls[1].payload.values.title,'第二稿');}
  finally{controller.abort();dom.window.close();}
});

it('保存失败保留输入，原载荷重试复用幂等键；只读账号不能编格',async()=>{
  const {dom,w,controller,calls,edit}=mount(async()=>response({error:'记录已被修改'},409));
  try{await settle();edit('title','未保存稿');w.document.querySelector('#save-edits').click();await settle();assert.match(w.document.querySelector('#edit-result').textContent,/记录已被修改/);assert.equal(w.document.querySelectorAll('.is-dirty').length,1);w.document.querySelector('#save-edits').click();await settle();assert.equal(calls[0].idempotency_key,calls[1].idempotency_key);}
  finally{controller.abort();dom.window.close();}
  const readOnly=mount(undefined,false);
  try{await settle();assert.equal(readOnly.w.document.querySelector('#add-row').disabled,true);assert.equal(readOnly.w.document.querySelector('[data-field="title"]').dataset.editable,'');}
  finally{readOnly.controller.abort();readOnly.dom.window.close();}
});

it('记录冲突对照最新值与本次输入，明确选值后才允许带新版本保存',async()=>{
  let first=true;
  const t=mount(async()=>{if(first){first=false;return response({error:'记录已被修改，请刷新后重试'},409);}return response({result:{modified:'m3'}});});
  const original=t.w.fetch;
  t.w.fetch=async(url:string,init:any)=>url.endsWith('/records/row.with.dot')?response({object,record:{...rows[0],modified:'m2',title:'他人新值',quantity:7}}):original(url,init);
  try{await settle();t.edit('title','我的新值');t.w.document.querySelector('#save-edits').click();await settle();
    const compare=t.w.document.querySelector('#compare-conflicts');assert.ok(compare);assert.equal(compare.hidden,false);compare.click();await settle();
    assert.match(t.w.document.querySelector('[data-conflict-values]').textContent,/他人新值/);assert.match(t.w.document.querySelector('[data-conflict-values]').textContent,/我的新值/);
    t.w.document.querySelector('[data-conflict-apply]').click();assert.ok(t.w.document.querySelector('[data-conflict-apply]'),'未选择不得应用');assert.equal(t.calls.length,1);
    t.w.document.querySelector('[data-conflict-choice="title"]').value='mine';t.w.document.querySelector('[data-conflict-apply]').click();assert.equal(t.calls.length,1,'核对不自动提交');
    assert.match(t.w.document.querySelector('[data-field="quantity"]').textContent,/7/);
    t.w.document.querySelector('#save-edits').click();await settle();assert.equal(t.calls[1].payload.expected_modified,'m2');assert.equal(t.calls[1].payload.values.title,'我的新值');assert.notEqual(t.calls[0].idempotency_key,t.calls[1].idempotency_key);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('冲突对照取消不更新基线；采用最新值只清除此行编辑；读取撤权不允许合并',async()=>{
  const t=mount(async()=>response({error:'记录已被修改，请刷新后重试'},409));const original=t.w.fetch;let denied=false;
  t.w.fetch=async(url:string,init:any)=>url.endsWith('/records/row.with.dot')?(denied?response({error:'无权查看'},403):response({object,record:{...rows[0],modified:'m2',title:'别人'}})):original(url,init);
  try{await settle();t.edit('title','我的');t.w.document.querySelector('#save-edits').click();await settle();t.w.document.querySelector('#compare-conflicts').click();await settle();t.w.document.querySelector('[data-conflict-cancel]').click();
    t.w.document.querySelector('#save-edits').click();await settle();assert.equal(t.calls[1].payload.expected_modified,'m1');
    denied=true;t.w.document.querySelector('#compare-conflicts').click();await settle();assert.match(t.w.document.querySelector('[data-conflict-values]').textContent,/无权查看/);assert.equal(t.w.document.querySelector('[data-conflict-apply]').disabled,true);t.w.document.querySelector('[data-conflict-cancel]').click();
    denied=false;t.w.document.querySelector('#compare-conflicts').click();await settle();t.w.document.querySelector('[data-conflict-choice="title"]').value='latest';t.w.document.querySelector('[data-conflict-apply]').click();assert.equal(t.w.document.querySelectorAll('.is-dirty').length,0);assert.match(t.w.document.querySelector('[data-field="title"]').textContent,/别人/);assert.equal(t.calls.length,2);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('修改条位于表格上方，保存后收起且详情仍可打开；少列不强制横向滚动',async()=>{
  const css=readFileSync(new URL('../../../shangshu-web/css/sheet-center.css',import.meta.url),'utf8');
  assert.match(css,/\.sheet-filterbar\{[^}]*flex:0 0 auto/);
  assert.doesNotMatch(css,/\.sheet-center-page \.btn\{[^}]*background:/,'通用按钮尺寸规则不能覆盖主按钮绿色背景');
  const {dom,w,controller,edit}=mount();
  try{
    await settle();
    const bar=w.document.querySelector('#editbar'),table=w.document.querySelector('.sheet-table-scroll');
    assert.ok(bar.compareDocumentPosition(table)&w.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(bar.hidden,true);
    assert.equal(w.document.querySelector('.sheet-table').style.minWidth,'520px');
    edit('title','新名称');assert.equal(bar.hidden,false);
    w.document.querySelector('#save-edits').click();await settle();
    assert.equal(bar.hidden,true);
    w.document.querySelector('[data-open]').click();
    assert.equal(w.document.querySelector('#row-detail').hidden,false);
    const fileLink=new URL(w.document.querySelector('[data-record-files]').href);
    assert.equal(fileLink.searchParams.get('related_object'),object.id);assert.equal(fileLink.searchParams.get('related_record'),rows[0].name);assert.equal(fileLink.hash,'#/file-center');
    assert.match(w.document.querySelector('#row-detail').textContent,/新名称/);
    assert.match(w.document.querySelector('[data-sort]').getAttribute('aria-label'),/当前页/);
  }finally{controller.abort();dom.window.close();}
});

it('尚未失焦的输入、未保存修改和进行中的保存均阻止离页，保存完解除',async()=>{
  let finish:(v:any)=>void=()=>{};
  const {dom,w,controller}=mount(async()=>new Promise(resolve=>{finish=resolve;}));
  const leave=()=>w.dispatchEvent(new w.Event('shangshu:before-page-change',{cancelable:true}));
  try{
    await settle();assert.equal(leave(),true);
    w.document.querySelector('[data-field="title"]').dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true}));
    w.document.querySelector('.cell-input').value='未失焦的新稿';
    assert.equal(leave(),false);assert.match(w.document.querySelector('[data-field="title"]').textContent,/未失焦的新稿/);
    w.document.querySelector('#save-edits').click();assert.equal(leave(),false);
    finish(response({result:{modified:'m2'}}));await settle();assert.equal(leave(),true);
  }finally{controller.abort();dom.window.close();}
});

it('对齐3in：筛选以 chips 呈现可逐个移除，横向导航箭头滚动表格',async()=>{
  const t=mount(undefined,true,{query:true});
  const filters=()=>JSON.parse(new URL(t.queries.at(-1)!,'http://localhost').searchParams.get('filters')||'{}');
  try{await settle();
    t.w.document.querySelector('#filter-fields').click();
    t.w.document.querySelector('[data-filter-field="title"]').value='打印纸';
    t.w.document.querySelector('[data-filter-apply]').click();await settle();
    assert.equal(filters().title,'打印纸');
    const chips=t.w.document.querySelectorAll('#field-filter-summary .filter-chip');
    assert.equal(chips.length,1,'筛选应渲染为 chip');
    assert.match(chips[0].textContent,/物品名称：打印纸/);
    assert.ok(t.w.document.querySelector('#pan-left'),'须有表格左导航箭头');
    assert.ok(t.w.document.querySelector('#pan-right'),'须有表格右导航箭头');
    const scroller=t.w.document.querySelector('.sheet-table-scroll');
    scroller.scrollLeft=300;t.w.document.querySelector('#pan-left').click();
    assert.equal(scroller.scrollLeft,60,'左箭头应横向滚动表格');
    chips[0].click();await settle();
    assert.equal(filters().title,undefined,'移除 chip 后立即重查且条件清除');
    assert.equal(t.w.document.querySelector('#field-filter-summary').hidden,true,'无筛选时 chips 收起');
  }finally{t.controller.abort();t.dom.window.close();}
});

it('对齐3in：表格带视图名 caption；空目录管理员直开台账引导',async()=>{
  const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost/index.html#/sheets',runScripts:'outside-only'}),w=dom.window as any;
  const calls:any[]=[];let designerEdited:any=null;
  w.RENDER={};w.currentRole=()=> 'admin';w.currentUserInfo={username:'hero-tester'};
  w.fetch=async(url:string,requestOptions:any)=>{
    if(url==='/api/platform/objects')return response({list:[]});
    if(url==='/api/platform/application-definitions'){
      // request() 的 GET 也携带 options 对象，只能按 body 区分 POST。
      if(requestOptions?.body){calls.push(JSON.parse(requestOptions.body));return response({application:{id:'app.ledger',draft:{title:'业务台账'}}});}
      return response({list:[]});
    }
    if(url==='/api/platform/application-definitions/app.ledger')return response({application:{id:'app.ledger',design_context:{models:[]}}});
    calls.push({url});return response({list:[]});
  };
  w.createModelDesigner=(application:any,onChange:any,active:any)=>({create(){},dispose(){},hasOpenDialog:()=>false,edit:async(def:any)=>{designerEdited=def;}});
  installToast(w);
  for(const file of ['tool-workspace','file-reference-picker','sheet-center'])w.eval(readFileSync(new URL(`../../../shangshu-web/js/${file}.js`,import.meta.url),'utf8'));
  const controller=new w.AbortController();w.mountSheetCenter(w.document.querySelector('#host'),{signal:controller.signal});
  try{await settle();
    const hero=w.document.querySelector('#sheet-hero');
    assert.equal(hero.hidden,false,'空目录管理员应直开台账引导');
    assert.match(hero.textContent,/第一张业务台账/);
    assert.equal(w.document.querySelector('.sheet-table-scroll').hidden,true,'引导期间收起空表');
    w.document.querySelector('#hero-quick').click();await settle();
    const create=calls.find(c=>c&&c.title==='业务台账'&&c.idempotency_key);
    assert.ok(create,'无台账应用时应自动创建「业务台账」应用');
    assert.ok(designerEdited&&designerEdited.definition,'应带预置模板进入设计器');
    assert.equal(designerEdited.definition.fields.map((f:any)=>f.label).join(','),'名称,日期,状态,金额,备注');
    const ids=designerEdited.definition.fields.map((f:any)=>f.id);
    assert.equal(ids.some((id:string)=>['name','modified'].includes(id)),false,'模板字段 ID 不得使用内核保留字');
    assert.ok(ids.every((id:string)=>/^[a-z][a-z0-9_]{0,47}$/.test(id)),'模板字段 ID 须符合内核规则');
  }finally{controller.abort();dom.window.close();}
});

it('对齐3in：有表时 caption 显示表名，hero 收起',async()=>{
  const t=mount();try{await settle();
    assert.equal(t.w.document.querySelector('#sheet-hero').hidden,true);
    assert.equal(t.w.document.querySelector('#sheet-caption').textContent,'采购清单');
  }finally{t.controller.abort();t.dom.window.close();}
});

it('对齐3in：常用视图↔完整台账两档切换，忽略隐藏列并标注视图名',async()=>{
  const t=mount();try{await settle();
    t.w.document.querySelector('#manage-columns').click();
    t.w.document.querySelector('[data-column="secret"]').checked=false;
    t.w.document.querySelector('[data-columns-apply]').click();await settle();
    assert.equal(t.w.document.querySelectorAll('[data-field="secret"]').length,0,'常用视图应隐藏该列');
    assert.equal(t.w.document.querySelector('#view-mode').textContent,'切换完整台账');
    t.w.document.querySelector('#view-mode').click();await settle();
    assert.equal(t.w.document.querySelectorAll('[data-field="secret"]').length,1,'完整台账应显示全部字段');
    assert.match(t.w.document.querySelector('#sheet-caption').textContent,/完整台账视图/);
    assert.equal(t.w.document.querySelector('#view-mode').textContent,'切换常用视图');
    t.w.document.querySelector('#manage-columns').click();await settle();
    assert.equal(t.w.document.querySelector('[data-columns-apply]'),null,'完整台账下不提供列管理');
    assert.match(toastText(t.w),/切回常用视图/);
    t.w.document.querySelector('#view-mode').click();await settle();
    assert.equal(t.w.document.querySelectorAll('[data-field="secret"]').length,0,'切回常用视图后隐藏列恢复');
    assert.equal(t.w.document.querySelector('#sheet-caption').textContent,'采购清单');
  }finally{t.controller.abort();t.dom.window.close();}
});

it('对齐3in：有未保存修改时拒绝切换视图，修改不丢',async()=>{
  const t=mount();try{await settle();
    t.edit('title','切换前改的稿');
    assert.equal(t.w.document.querySelectorAll('[data-field="secret"]').length,1);
    t.w.document.querySelector('#view-mode').click();await settle();
    assert.match(toastText(t.w),/未保存修改/);
    assert.equal(t.w.document.querySelector('#view-mode').textContent,'切换完整台账','视图未切换');
    assert.match(t.w.document.querySelector('[data-field="title"]').textContent,/切换前改的稿/);
    t.w.document.querySelector('#discard-edits').click();await settle();
    t.w.document.querySelector('#view-mode').click();await settle();
    assert.match(t.w.document.querySelector('#sheet-caption').textContent,/完整台账视图/);
  }finally{t.controller.abort();t.dom.window.close();}
});

it('对齐3in：详情支持常规→宽屏→全页三档展开，关闭后回到常规',async()=>{
  const t=mount();try{await settle();
    t.w.document.querySelector('tr[data-row] [data-open]').click();await settle();
    const box=t.w.document.querySelector('.sheet-content');
    const btn=()=>t.w.document.querySelector('#detail-width');
    assert.equal(box.dataset.detailWidth,'','默认常规宽度');
    assert.equal(btn().textContent,'展开详情');
    btn().click();assert.equal(box.dataset.detailWidth,'wide');
    assert.equal(btn().textContent,'全页详情');
    btn().click();assert.equal(box.dataset.detailWidth,'full');
    assert.equal(btn().textContent,'收起详情');
    btn().click();assert.equal(box.dataset.detailWidth,'');
    btn().click();assert.equal(box.dataset.detailWidth,'wide','可再次展开');
    t.w.document.querySelector('#close-detail').click();await settle();
    assert.equal(box.dataset.detailWidth,'','关闭详情后宽度复位');
    t.w.document.querySelector('tr[data-row] [data-open]').click();await settle();
    assert.equal(box.dataset.detailWidth,'','重开详情从常规开始');
    assert.equal(t.w.document.querySelector('#detail-width').textContent,'展开详情');
  }finally{t.controller.abort();t.dom.window.close();}
});

// —— PKG-133（2026-10-30 · 浏览器走查撞出来的 3 个产品缺陷之一）——
//   缺陷①：表格中心的「加载中」**收不住** ⇒ 空目录（管理员）时那个引导**永远不出现**。
//   缺陷②：读失败时，表格区把错误说成「**没有记录**」⇒ 真读失败被说成空表。
//
// **测试通过 = 什么成立**（一句话）：
//   「管理员打开**空目录**（一张表都没有）⇒
//     ① 「创建你的第一张业务台账」那个引导**要出现**（不是一直转圈）；
//     ② 读失败（403）⇒ 表格区**说清是读失败**（不许说「这里还没有记录」）
//        ⇒ 也不许一直摆着加载骨架（那会让人以为还在取数）。」
//
// ⚠️ **为什么要有这两条**（2026-10-30 站上实测撞出来的）：
//   `loading` 只在 `loadRecords()` 的 finally 里复位（`sheet-center.js`）
//   ⇒ **空目录那条路不走 loadRecords**（它在 `connect()` 里直接 `render()`）
//   ⇒ `loading` 永远为 true ⇒ `heroVisible` 要求 `!loading` ⇒ 引导永远不出现；
//   ⇒ 读失败那条路同样不复位 ⇒ 表格区一直摆着骨架。
it('空目录时引导要出现（不许一直转圈）；读失败时表格区说清是读失败',async()=>{
  const t=mount(undefined,true,{catalog:[]});
  try{
    await settle();
    // —— ① 空目录（管理员）⇒ 引导要出现 ——
    const hero=t.w.document.querySelector('#sheet-hero');
    assert.equal(hero.hidden,false,'空目录管理员应直开台账引导（不许一直转圈）');
    assert.match(hero.textContent,/第一张业务台账/);
    assert.equal(t.w.document.querySelector('.sheet-table-scroll').hidden,true,'引导期间收起空表');
    // —— ② 读失败 ⇒ 表格区说清是读失败，不许说「这里还没有记录」——
    //   ⚠️ **要有表才读得到记录**（空目录那条路压根不读记录 ⇒ 谈不上读失败）
    //   ⇒ 这里给**一张表**，让 `/records` 那个口 403。
    const failing=mount(undefined,true,{read:async()=>response({error:'读取权限已撤销'},403)});
    try{
      await settle();
      const body=failing.w.document.querySelector('#sheet-rows').textContent;
      assert.doesNotMatch(body,/这里还没有记录/,'真读失败不许被说成「没有记录」');
      assert.doesNotMatch(body,/没有匹配的记录/,'真读失败不许被说成「没有匹配的记录」');
      assert.match(body,/读取失败|读取权限已撤销/,'表格区要说清是读失败');
      assert.equal(failing.w.document.querySelectorAll('[data-skeleton-row]').length,0,'读失败后不许还摆着加载骨架');
    }finally{failing.controller.abort();failing.dom.window.close();}
  }finally{t.controller.abort();t.dom.window.close();}
});
