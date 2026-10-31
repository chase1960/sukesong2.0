import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

it('待办直接使用主工作面，不再嵌套第二层整页卡片',()=>{
  const source=readFileSync(new URL('../../../shangshu-web/js/real-flowdesign.js',import.meta.url),'utf8');
  const css=readFileSync(new URL('../../../shangshu-web/css/platform.css',import.meta.url),'utf8');
  assert.doesNotMatch(source,/class="todo-shell"/);
  assert.match(source,/surface\.className = 'pf-surface todo-surface'/);
  assert.match(source,/renderGenericInstance[\s\S]*surface\.className = 'pf-surface'/);
  assert.match(source,/renderInstance[\s\S]*surface\.className = 'pf-surface'/);
  assert.match(css,/\.pf-surface\.todo-surface\{display:grid;[^}]*margin:0;border:0;border-radius:0;[^}]*box-shadow:none/);
  assert.match(css,/\.todo-work \.pf-launch-card\{[^}]*border:0;border-bottom:1px solid var\(--line\);border-radius:0/);
});

it('应用发起报销时按贡献中的领域适配打开上传入口，不回退不支持的通用发起',async()=>{
  const dom=new JSDOM('<main id="main"></main>',{runScripts:'outside-only',url:'https://shangshu.local/'});
  const w=dom.window as any;
  let launched=0;
  const requested:string[]=[];
  Object.assign(w,{
    RENDER:{},mainBox:()=>w.document.querySelector('#main'),
    $:(selector:string,root=w.document)=>root.querySelector(selector),
    $$:(selector:string,root=w.document)=>[...root.querySelectorAll(selector)],
    esc:(value:any)=>String(value??''),currentUserInfo:{role:'staff'},toast:()=>{},submitJSON:async()=>({}),
    shangshuProcessAdapters:{'finance.expense':()=>({launch:()=>{launched++;}})},
    api:async(path:string)=>{requested.push(path);return {ok:true,json:async()=>{
      if(path==='/api/platform/contributions')return {processes:[{id:'com.shangshu.finance.expense_approval',launch_adapter:'finance.expense'}],domains:[]};
      if(path==='/api/platform/processes')return {list:[{definition_id:'com.shangshu.finance.expense_approval',title:'费用报销与付款'}]};
      if(path==='/api/platform/process-instances?view=pending')return {list:[]};
      throw Error('unexpected '+path);
    }};},
  });
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-flowdesign.js',import.meta.url),'utf8'));
    w.sessionStorage.setItem('shangshu.process.intent',JSON.stringify({definition_id:'com.shangshu.finance.expense_approval',mode:'launch'}));
    await w.RENDER.flowdesign();
    assert.equal(launched,1);
    assert.ok(!requested.some(path=>path.includes('launch-context')));
  }finally{dom.window.close();}
});

it('原尚书流程页接入 Frappe Graph 可编辑画布，保存使用画布导出图',async()=>{
  const dom=new JSDOM('<main id="main"></main>',{runScripts:'outside-only',url:'https://shangshu.local/'});
  const w=dom.window as any;
  const n='com.shangshu.finance.node.';
  const graph={
    schema_version:2,
    nodes:[
      {id:n+'upload',type:'human_task',title:'上传票据',start:true},
      {id:n+'detect',type:'condition',title:'判断文字层'},
      {id:n+'pdf_extract',type:'action',title:'PDF 文字解析'},
      {id:n+'scan_extract',type:'ai_select',title:'扫描票据识别'},
      {id:n+'complete',type:'human_task',title:'完成',terminal:true},
    ],
    edges:[
      {id:'e1',source:n+'upload',target:n+'detect'},
      {id:'e2',source:n+'detect',target:n+'pdf_extract',label:'有文字层',condition:{kind:'clause',source:{scope:'business_object',object_id:'document_extraction',field_path:'has_text_layer',field_label:'文字层',data_type:'boolean'},operator:'eq',value:true,summary:'有文字层'}},
      {id:'e3',source:n+'detect',target:n+'scan_extract',label:'扫描件',is_default:true},
      {id:'e4',source:n+'pdf_extract',target:n+'complete'},
      {id:'e5',source:n+'scan_extract',target:n+'complete'},
    ]
  };
  let mounted:any;
  let saved:any;
  Object.assign(w,{
    RENDER:{},mainBox:()=>w.document.querySelector('#main'),
    $:(selector:string,root=w.document)=>root.querySelector(selector),
    $$:(selector:string,root=w.document)=>[...root.querySelectorAll(selector)],
    esc:(value:any)=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    money:(value:any)=>String(value??''),currentUserInfo:{role:'admin'},
    ICONS:{spark:''},openSchemaForm:(options:any)=>options.onSubmit?.(options.values||{}),toast:()=>{},structuredClone,
    submitJSON:async(path:string,body:any,method='POST')=>{
      const response=await w.api(path,{method,body:JSON.stringify(body)});return response.json();
    },
    mountPlatformGraphDesigner:(options:any)=>{
      mounted=options;
      options.container.innerHTML='<div class="pfd-shell"><button data-fake-node>可编辑节点</button></div>';
      return {getGraph:()=>({...options.graph,nodes:[...options.graph.nodes,{id:n+'manual',type:'human_task',title:'手动新增'}]}),markSaved:()=>{},destroy:()=>{}};
    }
  });
  w.api=async(path:string,options:any)=>({
    ok:true,
    json:async()=>{
      if(path==='/api/platform/contributions') return {processes:[{id:'com.shangshu.finance.expense_approval',title:'费用报销与付款'}],domains:[{id:'com.shangshu.finance',name:'财务'}]};
      if(path==='/api/platform/processes') return {list:[{definition_id:'com.shangshu.finance.expense_approval',title:'费用报销与付款',domain_name:'财务'}]};
      if(path==='/api/platform/process-definitions') return {list:[{definition_id:'com.shangshu.finance.expense_approval',title:'费用报销与付款',status:'Published'}]};
      if(path.includes('/process-definitions/')&&(!options||options.method==='GET')) return {definition:{title:'费用报销与付款',draft_revision:1,graph},latest_version:{version_id:'v1'},checks:[],actions:[],roles:[]};
      if(options?.method==='PUT'){saved=JSON.parse(options.body);return {draft_revision:2};}
      return {list:[]};
    }
  });
  try {
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-flowdesign.js',import.meta.url),'utf8'));
    w.sessionStorage.setItem('shangshu.process.intent',JSON.stringify({mode:'design',definition_id:'com.shangshu.finance.expense_approval'}));
    await w.RENDER.flowdesign();
    assert.ok(mounted,w.document.body.innerHTML);
    assert.equal(mounted.definitionId,'com.shangshu.finance.expense_approval');
    assert.equal(w.document.querySelectorAll('.pfd-shell').length,1);
    assert.ok(w.document.querySelector('[data-validate-draft]'));
    assert.ok(w.document.querySelector('[data-simulate-draft]'));
    await w.document.querySelector('[data-save-draft]').onclick();
    assert.equal(saved.graph.nodes.at(-1).title,'手动新增');
  } finally {dom.window.close();}
});
