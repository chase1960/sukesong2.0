// 通用数据页只消费领域数据集契约：不暴露内部对象 ID，窄屏使用目录抽屉。
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

it('领域集合动作直接复用确认表单，失败保留输入与幂等键，不跳流程',async()=>{
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only',url:'https://shangshu.local/'}),w=dom.window as any;
  const writes:any[]=[];let loads=0;
  const action={id:'orders.create',title:'新建订单',input_schema:{properties:{title:{type:'string',title:'订单事项'}},required:['title']}};
  Object.assign(w,{RENDER:{},mainBox:()=>w.document.querySelector('main'),$:(s:string,r?:any)=>(r||w.document).querySelector(s),$$:(s:string,r?:any)=>[...(r||w.document).querySelectorAll(s)],esc:(v:any)=>String(v??''),ICONS:{spark:''},currentUserInfo:{role:'staff'},go:()=>{throw Error('不应跳转流程');},chatAssist:()=>{},toast:(_a:any,b:any)=>{throw Error(b);}});
  w.api=async(path:string,options?:any)=>{
    // ⚠️ **「是不是写」不能只看「有没有第二个参数」**：产品给**读**请求也挂了这一页的取消信号
    //   （real-objects.js 的 `readInit()`：读请求带 `{signal}`）⇒ 以前那个 `if(options)`
    //   会把读请求当成写 ⇒ `JSON.parse(options.body)` 报「undefined is not valid JSON」。
    //   ⇒ 改成按「有没有请求体」判断（写请求才有 body）。
    if(options&&options.body){writes.push(JSON.parse(options.body));return{ok:writes.length>1,json:async()=>writes.length>1?{ok:true}:{ok:false,error:'模拟失败'}};}
    if(path==='/api/platform/datasets')return{ok:true,json:async()=>({list:[{id:'orders.order',name:'订单',columns:[]} ]})};
    loads++;return{ok:true,json:async()=>({rows:[],total:0,actions:[action]})};
  };
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/forms.js',import.meta.url),'utf8'));
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-objects.js',import.meta.url),'utf8'));
    await w.RENDER.objects();w.document.querySelector('.dataset-head .btn-pri').click();
    w.document.querySelector('[name="title"]').value='办公配件';
    const form=w.document.querySelector('.schema-dialog form');
    await form.onsubmit({preventDefault(){},target:form});
    assert.equal(w.document.querySelector('[name="title"]').value,'办公配件');
    await form.onsubmit({preventDefault(){},target:form});
    assert.equal(writes.length,2);assert.equal(writes[0].idempotency_key,writes[1].idempotency_key);
    assert.equal(writes[1].confirmed,true);assert.equal(loads,2);assert.equal(w.document.querySelector('.schema-dialog'),null);
  }finally{w.close();}
});

it('受管对象的数据页不再渲染可编辑表格（这一批改走 Excel 工作面），域自己的数据集留在原来的表格形态',async()=>{
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only',url:'https://shangshu.local/'}),w=dom.window as any;
  const writes:any[]=[];
  const object={id:'suppliers',title:'供应商',source:'managed',revision:2,operations:['create','update'],input_schema:{properties:{title:{type:'string',title:'公司名称'},phone:{type:'string',title:'电话'}},required:['title']}};
  const record={name:'S1',modified:'v1',title:'办公店',phone:'123'};
  const domainDataset={id:'vendors',name:'厂商',columns:[{field:'title',label:'公司名称'}]};
  Object.assign(w,{RENDER:{},mainBox:()=>w.document.querySelector('main'),$:(s:string,r?:any)=>(r||w.document).querySelector(s),$$:(s:string,r?:any)=>[...(r||w.document).querySelectorAll(s)],esc:(s:any)=>String(s??''),ICONS:{spark:''},currentUserInfo:{role:'admin'},go:()=>{},chatAssist:()=>{},toast:(_a:any,b:any)=>{throw Error(b);}});
  w.api=async(path:string,options?:any)=>{
    // ⚠️ 同上：**读**请求也带取消信号 ⇒ 「是不是写」要看有没有 body，不能看有没有第二个参数。
    if(options&&options.body){writes.push(JSON.parse(options.body));return{ok:true,json:async()=>({ok:true})};}
    return{ok:true,json:async()=>path==='/api/platform/datasets'?{list:[{id:'suppliers',object_id:'suppliers',name:'供应商',columns:[{field:'title',label:'公司名称'},{field:'phone',label:'电话'}]},domainDataset]}:path.includes('/objects/')?{object,record}:{object,rows:[record],total:1}};
  };
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/forms.js',import.meta.url),'utf8'));
    w.eval(readFileSync(new URL('../../../shangshu-web/js/schema-lookups.js',import.meta.url),'utf8'));
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-objects.js',import.meta.url),'utf8'));
    await w.RENDER.objects();
    // 受管对象（suppliers）⇒ 整页交给 Excel 工作面：数据页**不再渲染可编辑表格**。
    assert.equal(w.document.querySelector('.dataset-table'),null,'受管对象还在数据页里渲染可编辑表格 —— 旧形态没走干净');
    assert.equal(w.document.querySelector('.schema-inline'),null);
    assert.equal(writes.length,0,'还没动手就不许写');
    // 域自己的数据集（vendors）⇒ 留在原来的表格形态（不误用可编辑通用网格）。
    await w.document.querySelector('[data-dataset="vendors"]').onclick();
    assert.equal(w.document.querySelector('.dataset-table')!==null,true,'域自己的数据集没有留在原来的表格形态');
    assert.equal(w.document.querySelector('.dataset-head h2').textContent,'厂商');
  }finally{w.close();}
});

it('数据集按贡献契约渲染并把筛选交给平台查询接口',async()=>{
  const dom=new JSDOM('<main id="main"></main>',{runScripts:'outside-only',url:'https://shangshu.local/'});
  const w=dom.window as any;
  const queries:string[]=[];
  const dataset={id:'finance.invoice',name:'发票',description:'票据核对记录',icon:'发',columns:[{field:'invoice_number',label:'发票号码'},{field:'total_amount',label:'价税合计',format:'money'}],filters:[{field:'invoice_number',label:'发票号码',type:'text'}]};
  Object.assign(w,{RENDER:{},mainBox:()=>w.document.querySelector('#main'),$: (s:string,root?:any)=>(root||w.document).querySelector(s),$$:(s:string,root?:any)=>[...(root||w.document).querySelectorAll(s)],esc:(s:any)=>String(s??''),money:(n:any)=>`¥${n}`,ICONS:{spark:'*'},chatAssist:()=>{},go:()=>{},currentUserInfo:{role:'admin'},URLSearchParams});
  w.api=async(path:string,options?:any)=>{
    let result:any;
    if(path==='/api/platform/datasets') result={ok:true,list:[dataset]};
    else if(path.startsWith('/api/platform/datasets/finance.invoice/records')) {queries.push(path);result={ok:true,total:1,page:1,page_length:30,rows:[{name:'INV-1',invoice_number:'001',total_amount:1130}]};}
    else throw new Error(path);
    return {ok:true,json:async()=>result};
  };
  try {
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-objects.js',import.meta.url),'utf8'));
    await w.RENDER.objects();await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(w.document.querySelector('.dataset-item span')?.textContent,'发票');
    assert.match(w.document.querySelector('.dataset-table')?.textContent||'',/001/);
    assert.doesNotMatch(w.document.querySelector('.dataset-list')?.textContent||'',/finance\.invoice/);
    const input=w.document.querySelector('[name=invoice_number]') as HTMLInputElement;input.value='001';
    await w.document.querySelector('[data-filter-form]').onsubmit({preventDefault(){}});await new Promise<void>(resolve=>setImmediate(resolve));
    assert.ok(queries.at(-1)?.includes(encodeURIComponent('"invoice_number":"001"')));
  } finally {dom.window.close();}
});

it('分存储金额在列表和详情按元显示，不改变原始记录值',async()=>{
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only',url:'https://shangshu.local/'}),w=dom.window as any;
  const object={id:'finance.funding_request',name:'外采拨款',fields:[{id:'amount_cents',label:'金额（分）',type:'integer'}]};
  const row={name:'F1',amount_cents:12345};
  Object.assign(w,{RENDER:{},mainBox:()=>w.document.querySelector('main'),$:(s:string,r?:any)=>(r||w.document).querySelector(s),$$:(s:string,r?:any)=>[...(r||w.document).querySelectorAll(s)],esc:(s:any)=>String(s??''),money:(n:any)=>`¥ ${Number(n).toFixed(2)}`,ICONS:{spark:''},currentUserInfo:{role:'staff'},go:()=>{},chatAssist:()=>{},toast:()=>{}});
  w.api=async(path:string)=>{
    // 这个数据集的**对象记录口不通**（域声明的受管对象在本站没装物理表 ⇒ 417）
    // ⇒ 它**留在数据页**上（业务表改走 Excel 工作面后，留下的那类表照旧）
    // ⇒ 列表与详情那套「金额按元显示」的规矩在这儿仍然要守住。
    if(path.includes('/records/F1'))return{ok:true,json:async()=>({object,record:row})};
    if(path.includes('/objects/'))return{ok:false,status:417,json:async()=>({ok:false,error:'对象缺少受管 DocType 或字段定义'})};
    return{ok:true,json:async()=>path==='/api/platform/datasets'?{list:[{id:object.id,object_id:object.id,name:object.name,columns:[{field:'amount_cents',label:'金额（分）'}]}]}:{rows:[row],total:1,object}};
  };
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-objects.js',import.meta.url),'utf8'));
    await w.RENDER.objects();
    assert.match(w.document.querySelector('.dataset-table').textContent,/金额（元）/);
    assert.match(w.document.querySelector('.dataset-table').textContent,/¥ 123\.45/);
    w.document.querySelector('[data-record]').click();await new Promise<void>(resolve=>setImmediate(resolve));
    assert.match(w.document.querySelector('.schema-dialog').textContent,/金额（元）/);
    assert.match(w.document.querySelector('.schema-dialog').textContent,/¥ 123\.45/);
    assert.equal(row.amount_cents,12345);
  }finally{w.close();}
});

it('应用内数据只取已授权绑定；刷新保留表选择，失效应用不回退全局',async()=>{
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only',url:'https://shangshu.local/?application=purchase&dataset=suppliers#/objects'});
  const w=dom.window as any,reads:string[]=[];
  const tables=[{id:'orders',name:'采购单',columns:[]},{id:'suppliers',name:'供应商',columns:[{field:'title',label:'公司名称'}]}];
  Object.assign(w,{RENDER:{},mainBox:()=>w.document.querySelector('main'),$:(s:string,r?:any)=>(r||w.document).querySelector(s),$$:(s:string,r?:any)=>[...(r||w.document).querySelectorAll(s)],esc:(s:any)=>String(s??''),ICONS:{spark:''},currentUserInfo:{role:'admin'},go:()=>{},chatAssist:()=>{}});
  w.api=async(path:string)=>{reads.push(path);return{ok:true,json:async()=>path.includes('/applications/')?{application:{title:'采购管理',datasets:tables}}:{rows:[{title:'办公用品店'}],total:1}};};
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-objects.js',import.meta.url),'utf8'));
    await w.RENDER.objects();
    assert.equal(w.document.querySelector('h1').textContent,'采购管理');
    assert.equal(w.document.querySelectorAll('.dataset-item').length,2);
    assert.equal(w.document.querySelector('.dataset-item.on').textContent,'供应商');
    assert.ok(!reads.includes('/api/platform/datasets'));
    await w.document.querySelector('[data-dataset="orders"]').onclick();
    assert.equal(new URL(w.location.href).searchParams.get('dataset'),'orders');
    await w.RENDER.objects();
    assert.equal(w.document.querySelector('.dataset-item.on').textContent,'采购单');
    const search=w.document.querySelector('.dataset-search');search.value='供应';search.dispatchEvent(new w.Event('input'));
    assert.equal(w.document.querySelectorAll('.dataset-item').length,1);
    w.api=async(path:string)=>{reads.push(path);return{ok:false,json:async()=>({error:'无权访问应用'})};};
    await w.RENDER.objects();
    assert.match(w.document.querySelector('main').textContent,/无权访问应用/);
    assert.ok(!reads.includes('/api/platform/datasets'));
  }finally{dom.window.close();}
});

it('无权读取的深链数据表回落到可见表时同步修正地址',async()=>{
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only',url:'https://shangshu.local/?application=finance&dataset=finance.payable#/objects'});
  const w=dom.window as any;
  Object.assign(w,{RENDER:{},mainBox:()=>w.document.querySelector('main'),$:(s:string,r?:any)=>(r||w.document).querySelector(s),$$:(s:string,r?:any)=>[...(r||w.document).querySelectorAll(s)],esc:(s:any)=>String(s??''),ICONS:{spark:''},currentUserInfo:{role:'manager'},go:()=>{},chatAssist:()=>{}});
  w.api=async(path:string)=>({ok:true,json:async()=>path.includes('/applications/')?{application:{title:'费用管理',datasets:[{id:'finance.invoice',name:'发票',columns:[]}]}}:{rows:[],total:0}});
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-objects.js',import.meta.url),'utf8'));
    await w.RENDER.objects();
    assert.equal(new URL(w.location.href).searchParams.get('dataset'),'finance.invoice');
    assert.equal(w.document.querySelector('.dataset-item.on')?.textContent,'发票');
  }finally{w.close();}
});
