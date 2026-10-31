// 应用是一级业务容器：员工看到业务语言，管理员才展开资源与技术信息。
//
// **测试通过 =**（一句话）
//   「应用总览、搜索、应用设计这三件事连起来跑得通：搜不到时卡片格里出现『没有匹配』、
//     点开应用进到它自己的工作面、管理员能新建／编辑／发布受管应用并把授权绑上、
//     员工看不到管理按钮 —— 而设计页仍能正常打开。」
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

it('应用选择列表、当前工作面和应用设计共享同一份领域资源契约',async()=>{
  const dom=new JSDOM('<main id="main"></main>',{runScripts:'outside-only',url:'https://shangshu.local/'});
  const w=dom.window as any;
  const routes:string[]=[];
  const resources={
    datasets:[{id:'finance.invoice',name:'发票',description:'票据核对记录',icon:'发'}],
    processes:[{id:'com.shangshu.finance.expense_approval',title:'费用报销与付款',journey:'上传票据 → 审批 → 付款'}],
    actions:[{id:'finance.expense.submit'}],tools:[{id:'document.ocr_extract'}],
    roles:[{role:'Expense Approver',label:'费用审批人'}],pages:[{id:'finance.settings',label:'财务设置'}],
  };
  const application={id:'com.shangshu.finance.expense_management',title:'费用管理',description:'从票据识别到过账付款',icon:'费',domain_name:'财务',domain_version:'0.2.0',enabled:true,home:'generated.overview',journey:'上传票据 → 填写报销 → 审批 → 付款',help:'员工从申请报销开始',primary_action:{type:'process',label:'申请报销',target:'com.shangshu.finance.expense_approval'},datasets:resources.datasets,processes:resources.processes,resources,resource_counts:{datasets:1,processes:1,actions:1,tools:1,roles:1,pages:1},setup_steps:['data','page','process','permission','publish'].map(id=>({id,label:id,complete:true}))};
  Object.assign(w,{RENDER:{},ICONS:{flow:'<i>flow</i>',grid:'<i>grid</i>'},mainBox:()=>w.document.querySelector('#main'),$:(s:string,root?:any)=>(root||w.document).querySelector(s),$$:(s:string,root?:any)=>[...(root||w.document).querySelectorAll(s)],esc:(s:any)=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),currentUserInfo:{role:'admin'},go:(route:string)=>routes.push(route)});
  w.api=async(path:string)=>({ok:true,json:async()=>path.includes('/api/platform/applications/')?{ok:true,application}:{ok:true,list:[application]}});
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-applications.js',import.meta.url),'utf8'));
    await w.RENDER.applications();
    assert.equal(w.document.querySelector('.application-index'),null);
    assert.match(w.document.querySelector('.application-detail h1')?.textContent||'',/全部应用/);
    assert.equal(w.document.querySelectorAll('.application-list-item.on').length,0);
    assert.equal(w.document.querySelector('.application-shell').classList.contains('is-overview'),true);
    const aiLayer=w.document.createElement('div');aiLayer.id='ai-business-layer';
    w.document.querySelector('#main').prepend(aiLayer); // 真实壳会在首次渲染完成后插入确认区。
    const search=w.document.querySelector('.application-search');
    search.value='不存在的应用';search.dispatchEvent(new w.Event('input'));
    /* ⚠️ **2026-10-22 起（提交 3f6e035b1 · 应用中心改卡片式并砍掉受管对象）**：
       应用中心总览的卡片格容器从 `.application-overview-grid` 改成了
       `<div class="application-grid" data-app-center-grid>`（`js/real-applications.js`）
       ⇒ 原来这条取 `.application-overview-grid` 会取到 null 直接 TypeError。
       ⇒ 改用**产品现在用的那个标记**（`[data-app-center-grid]`）取元素，并加 `?.`／`||''` 防空。
       （设计页那处仍用旧类 `.application-overview-grid`，不是总览，别混。）
       配套判据（卡片式本身）：shangshu-web/js/tests/app-center-cards.test.mjs。 */
    assert.match(w.document.querySelector('[data-app-center-grid]')?.textContent||'',/没有匹配/);
    search.value='费用';search.dispatchEvent(new w.Event('input'));
    const openApplication=w.document.querySelector('[data-application]');
    await openApplication.onclick();
    const detailNode=w.document.querySelector('.application-detail').firstElementChild;
    await openApplication.onclick();
    assert.equal(w.document.querySelector('.application-detail').firstElementChild,detailNode);
    assert.equal(routes.at(-1),'objects');
    assert.doesNotMatch(w.document.querySelector('.application-detail')?.textContent||'',/业务记录/);
    assert.equal(w.document.querySelector('.application-index'),null);
    assert.equal(w.document.querySelector('.application-shell').classList.contains('is-overview'),false);
    assert.equal(new URL(w.location.href).searchParams.get('application'),application.id);
    assert.equal(new URL(w.location.href).searchParams.get('dataset'),'finance.invoice');
    assert.equal(w.document.querySelector('.application-detail-head p'),null);
    assert.equal(w.document.querySelector('.application-detail-journey'),null);
    w.sessionStorage.setItem('shangshu.application.open',application.id);

    await w.RENDER['app-design']();
    assert.match(w.document.querySelector('#main')?.textContent||'',/数据对象与视图/);
    assert.match(w.document.querySelector('#main')?.textContent||'',/办理角色与权限/);
    assert.match(w.document.querySelector('#main')?.textContent||'',/尚不支持拖放编辑/);
    assert.equal(w.document.querySelector('details')?.open,false);
    const panels=[...w.document.querySelectorAll('.application-design-workspace > [id^="app-design-"]')];
    assert.equal(panels.filter((p:any)=>!p.hidden).length,1);
    w.document.querySelector('a[href="#app-design-process"]').click();
    assert.equal(w.document.querySelector('#app-design-process').hidden,false);
    assert.equal(w.document.querySelector('#app-design-data').hidden,true);
    w.document.querySelector('[data-preview-current]').onclick();
    assert.equal(routes.at(-1),'application');
    await w.RENDER.applications();
    assert.equal(routes.at(-1),'objects');
    await w.RENDER.applications();
    assert.match(w.document.querySelector('.application-detail h1').textContent,/全部应用/);

    application.enabled=false;
    w.sessionStorage.setItem('shangshu.application.open',application.id);
    await w.RENDER['app-design']();
    const preview=w.document.querySelector('[data-preview-current]') as HTMLButtonElement;
    assert.equal(preview.disabled,true);
    assert.match(preview.textContent||'',/应用已停用/);
    assert.match(w.document.querySelector('#app-design-data')?.textContent||'',/启用后可查看/);

    w.currentUserInfo={role:'staff'};
    await w.RENDER['app-design']();
    assert.match(w.document.querySelector('#main').textContent,/没有访问权限/);
    application.enabled=true;
    await w.RENDER.applications();
    // 上次配置返回意图仍可进入应用，但员工不显示管理按钮。
    assert.equal(w.document.querySelector('[data-configure-app]'),null);
    assert.equal(w.document.querySelector('[data-overview-manage]'),null);

    let release:any;
    w.currentUserInfo={role:'admin'};
    w.api=async(path:string)=>path.includes('/api/platform/applications/')
      ? await new Promise(resolve=>{release=resolve;})
      : {ok:true,json:async()=>({ok:true,list:[application]})};
    await w.RENDER.applications();
    const pendingDetail=w.document.querySelector('[data-application]').onclick();
    await w.RENDER.applications();
    release({ok:true,json:async()=>({ok:true,application})});
    await pendingDetail;
    assert.match(w.document.querySelector('.application-detail h1').textContent,/全部应用/);

    w.api=()=>new Promise(resolve=>{release=resolve;});
    const late=w.RENDER.applications();
    w.document.querySelector('#main').innerHTML='<div id="other-page">其他页面</div>';
    release({ok:true,json:async()=>({ok:true,list:[application]})});
    await late;
    assert.equal(w.document.querySelector('#main').textContent,'其他页面');
    w.api=(path:string)=>path.includes('application-definitions')?Promise.resolve({ok:true,json:async()=>({ok:true,list:[]})}):new Promise(resolve=>{release=resolve;});
    const lateDesign=w.RENDER['app-design']();
    w.document.querySelector('#main').innerHTML='<div>离开配置页</div>';
    release({ok:true,json:async()=>({ok:true,list:[application]})});
    await lateDesign;
    assert.equal(w.document.querySelector('#main').textContent,'离开配置页');
  }finally{dom.window.close();}
});

it('全局侧栏只显示授权应用，点击传递应用意图，刷新移除已不可访问入口',async()=>{
  const dom=new JSDOM('<aside id="side"><div class="side-main"><div class="side-item on" data-mod="applications">应用</div></div></aside>',{runScripts:'outside-only',url:'https://shangshu.local/'});
  const w=dom.window as any;let route='';
  Object.assign(w,{RENDER:{},curMod:'applications',ICONS:{},esc:(s:any)=>String(s??''),go:(r:string)=>{route=r;},api:async()=>({ok:true,json:async()=>({list:[{id:'purchase',title:'采购管理'}]})}),
    // ⚠️ `navigationIdentity` 读的是**当前登录人**（real-applications.js 第 65 行：
    //   `JSON.stringify(currentUserInfo)`）——它是「换账号了就不许回填旧响应」那把钥匙。
    //   沙箱里没给这个全局 ⇒ ReferenceError ⇒ 侧栏刷不出来。
    //   （同文件下面那条用例就有：`currentUserInfo:{role:'staff'}`。）
    currentUserInfo:{role:'staff',username:'staff1'}});
  try{
    const source=readFileSync(new URL('../../../shangshu-web/js/app.js',import.meta.url),'utf8');
    w.eval(source.slice(source.indexOf('function sidebarItemHtml('),source.indexOf('function renderBrand(')));
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-applications.js',import.meta.url),'utf8'));
    await w.refreshApplicationNavigation();
    const button=w.document.querySelector('[data-side-application]');button.click();
    await w.refreshApplicationNavigation();
    assert.equal(w.document.querySelector('[data-side-application]'),button);
    assert.equal(route,'applications');assert.equal(w.sessionStorage.getItem('shangshu.application.open'),'purchase');
    w.selectApplicationNavigation('purchase');assert.equal(button.getAttribute('aria-current'),'page');
    assert.ok(button.classList.contains('side-item'));
    assert.equal(w.document.querySelectorAll('#side .side-item.on').length,1);
    await w.refreshApplicationNavigation([]);assert.equal(w.document.querySelectorAll('[data-side-application]').length,0);
  }finally{dom.window.close();}
});

it('应用声明已注册工作面时复用工具入口，未知或无权页面不吞应用入口',async()=>{
  const dom=new JSDOM('<aside id="side"><div class="side-main"><div class="side-item" data-mod="applications">应用</div><div class="side-item" data-mod="file-center">文件中心</div></div></aside><main id="main"></main>',{runScripts:'outside-only',url:'https://shangshu.local/'});
  const w=dom.window as any,routes:string[]=[];
  const app={id:'any.domain.center',title:'任意名称',home:'file-center',enabled:true,datasets:[{id:'domain.files'}]};
  Object.assign(w,{RENDER:{},ICONS:{},curMod:'applications',currentUserInfo:{role:'staff'},esc:(s:any)=>String(s??''),go:(r:string)=>routes.push(r),mainBox:()=>w.document.querySelector('#main'),$:(s:string,r?:any)=>(r||w.document).querySelector(s),$$:(s:string,r?:any)=>[...(r||w.document).querySelectorAll(s)],api:async(path:string)=>({ok:true,json:async()=>path.includes('/applications/')?{application:app}:{list:[app]}})});
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/page-registry.js',import.meta.url),'utf8'));
    const source=readFileSync(new URL('../../../shangshu-web/js/app.js',import.meta.url),'utf8');
    w.eval(source.slice(source.indexOf('function sidebarItemHtml('),source.indexOf('function renderBrand(')));
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-applications.js',import.meta.url),'utf8'));
    await w.refreshApplicationNavigation();
    assert.equal(w.document.querySelectorAll('[data-side-application]').length,0);
    await w.RENDER.applications();await w.document.querySelector('[data-application]').onclick();
    assert.equal(routes.at(-1),'file-center'); // 总览、工作台的原应用ID继续可达。
    app.home='accounts';await w.refreshApplicationNavigation();
    assert.equal(w.document.querySelectorAll('[data-side-application]').length,1); // 员工不能被跳到管理员页。
    app.home='missing-page';await w.refreshApplicationNavigation();
    assert.equal(w.document.querySelectorAll('[data-side-application]').length,1);
    app.home='file-center';w.document.querySelector('[data-mod="file-center"]').remove();await w.refreshApplicationNavigation();
    assert.equal(w.document.querySelectorAll('[data-side-application]').length,1); // 没有快捷入口时保留应用。
  }finally{dom.window.close();}
});

it('管理员从总览新建受管应用、选择资源、保存并发布，未保存内容不误发布',async()=>{
  const dom=new JSDOM('<main id="main"></main>',{runScripts:'outside-only',url:'https://shangshu.local/'});
  const w=dom.window as any, writes:any[]=[], reads:string[]=[];
  let app:any=null;
  let designContext:any;
  w.chatSetBusinessContext=(value:any)=>{designContext=value;};
  Object.assign(w,{RENDER:{},ICONS:{},mainBox:()=>w.document.querySelector('#main'),$:(s:string,r?:any)=>(r||w.document).querySelector(s),$$:(s:string,r?:any)=>[...(r||w.document).querySelectorAll(s)],esc:(s:any)=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),currentUserInfo:{role:'admin'},go:()=>{}});
  w.api=async(path:string,options?:any)=>{
    if (!options?.method) reads.push(path);
    let result:any={list:[]};
    if(options?.method==='POST'){
      const payload=JSON.parse(options.body);writes.push({path,payload});
      if(path.endsWith('application-definitions'))app={id:'com.shangshu.app.test',source:'managed',status:'Draft',draft_revision:1,draft:{schema_version:1,title:payload.title,description:'',allowed_roles:['Desk User'],bindings:[]}};
      else if(path.endsWith('/draft')){app.draft=payload.definition;app.draft_revision++;}
      else if(path.endsWith('/publish')){app.status='Published';app.published_revision=app.id+':'+app.draft_revision;}
      else if(path.endsWith('/status')){app.status=payload.enabled?'Published':'Disabled';}
      result={application:app};
    }else if(path.includes('/domains') || path.endsWith('/release-status'))throw new Error('设计页不应再拆分读取');
    else if(path.endsWith('application-definitions'))throw new Error('设计页不应再拼装第二份目录');
    else if(path.includes('/applications?'))result={list:app?[{...app,title:app.draft.title,enabled:app.status==='Published'}]:[]};
    else if(path.includes('application-definitions/'))result={application:{...app,role_options:[{id:'Desk User',label:'普通员工'},{id:'System Manager',label:'系统管理员'}],design_context:{resource_options:[{kind:'datasets',resource_id:'test.records',owner_domain:'com.test',version:'1.0',domain:'测试业务',enabled:true,label:'申请记录'}],release:{issues:[],releases:[]}}}};
    return {ok:true,json:async()=>({ok:true,...result})};
  };
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-applications.js',import.meta.url),'utf8'));
    await w.RENDER['app-design']();
    w.document.querySelector('[data-new-application]').click();
    const form=w.document.querySelector('[data-create-application]');form.elements.title.value='采购协同';
    await form.onsubmit({preventDefault(){}});
    assert.equal(writes.length,1);assert.ok(writes[0].payload.idempotency_key);
    reads.length=0;
    await w.RENDER['app-design']();
    assert.equal(reads.filter(path=>path.includes('application-definitions/')).length,1);
    assert.equal(reads.length,2); // 一次目录、一次当前详情，不再取第二目录或域贡献。
    assert.equal(designContext.module,'app-design');
    assert.equal(designContext.entity_id,app.id);
    assert.equal(designContext.entity_type,'application');
    assert.equal(w.document.querySelectorAll('[data-design-panel]').length,5);
    assert.equal([...w.document.querySelectorAll('[data-design-panel]')].filter((p:any)=>!p.hidden).length,1);
    w.document.querySelector('a[href="#app-design-permission"]').click();
    assert.equal(w.document.querySelector('#app-design-permission').hidden,false);
    assert.equal(w.document.querySelector('#app-design-data').hidden,true);
    w.document.querySelector('a[href="#app-design-data"]').click();
    const checkbox=w.document.querySelector('[data-binding]');checkbox.checked=true;checkbox.dispatchEvent(new w.Event('input',{bubbles:true}));
    assert.equal(w.document.querySelector('[data-app-role="Desk User"]').checked,true);
    w.document.querySelector('[data-app-role="System Manager"]').checked=true;
    await w.document.querySelector('[data-managed-publish]').onclick();
    assert.equal(writes.length,1);assert.match(w.document.querySelector('[role=status]').textContent,/先保存/);
    await w.document.querySelector('[data-managed-save]').onclick();
    assert.equal(writes[1].payload.definition.bindings[0].owner_domain,'com.test');
    assert.deepEqual(writes[1].payload.definition.allowed_roles,['Desk User','System Manager']);
    const upload=w.document.createElement('input');upload.type='file';
    w.document.querySelector('[data-managed-form]').append(upload);
    upload.dispatchEvent(new w.Event('input',{bubbles:true}));
    assert.notEqual(w.document.querySelector('[data-managed-form]').dataset.unsaved,'true');
    await w.document.querySelector('[data-managed-publish]').onclick();
    assert.equal(writes[2].payload.expected_revision,2);assert.equal(app.status,'Published');
    await w.document.querySelector('[data-managed-status]').onclick();assert.equal(writes.length,3);
    w.document.querySelector('[name=lifecycle_reason]').value='暂停使用';
    await w.document.querySelector('[data-managed-status]').onclick();assert.equal(app.status,'Disabled');
    assert.match(w.document.querySelector('[data-managed-status]').textContent,/重新启用/);
    w.document.querySelector('[data-managed-back]').click();assert.equal(w.sessionStorage.getItem('shangshu.application.open'),null);
    await w.RENDER['app-design']();
    assert.match(w.document.querySelector('.application-card-meta').textContent,/1 个数据对象/);
    assert.match(w.document.querySelector('.application-card-copy').textContent,/自主配置应用/);
    app.draft.bindings.push({kind:'datasets',resource_id:'missing.records',owner_domain:'com.missing',version:'1.0'});
    w.sessionStorage.setItem('shangshu.application.open',app.id);
    await w.RENDER['app-design']();
    assert.equal(w.document.querySelector('[data-unavailable-binding]').checked,true);
    await w.document.querySelector('[data-managed-save]').onclick();
    assert.ok(writes.at(-1).payload.definition.bindings.some((item:any)=>item.resource_id==='missing.records'));
    const missing=w.document.querySelector('[data-unavailable-binding]');missing.checked=false;missing.dispatchEvent(new w.Event('input',{bubbles:true}));
    await w.document.querySelector('[data-managed-save]').onclick();
    assert.equal(writes.at(-1).payload.definition.bindings.some((item:any)=>item.resource_id==='missing.records'),false);
  }finally{dom.window.close();}
});
