import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installConfirmationApi} from '../helpers/confirmation-api.ts';

const source=readFileSync(new URL('../../../shangshu-web/js/real-chat.js',import.meta.url),'utf8');
/**
 * ⚠️ `chatSkeleton` / `chatHistorySkeleton` 是 real-chat.js **文件靠前的顶层助手**（第 22 行起），
 *   而下面这些判据只把 `const CHAT_CONFIRM_NAMES` → `/* —— 确认之后` 这一段拿进沙箱跑
 *   ⇒ 抽出来的那段用到这两个名字时，window 上根本没有 ⇒ **ReferenceError: chatSkeleton is not defined**。
 *   （同类先例：`shangshu-web/js/domains/excel-univer/tests/read-scheduler.test.mjs` ——
 *     抽源码片段在沙箱里跑，片段用到的导入件在沙箱 context 里补上，补的是**真的那个**。）
 *   这里把**同一个文件里真的那两个**抽出来补进 window（不造替身 ⇒ 骨架长什么样仍是产品说了算）。
 */
const skeletonSource=source.slice(source.indexOf('const chatSkeleton ='),source.indexOf('let chatRunning = false;'));
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
it('变更卡以结构化差异呈现，纯文本防注入，技术详情折叠且确认后读回新版本',async()=>{
  const t=mount({prepare:async()=>({title:'修改表格',lines:['旧文本备用'],resource:{name:'采购.xlsx',version:4},changes:[{label:'工作表1 · B2',before:'215',after:'230'},{label:'备注',before:'空',after:'<img src=x onerror=alert(1)>'}],confirmLabel:'确认修改'}),
    afterExecution:async()=>({title:'已保存',lines:['读取的新值：230'],resource:{name:'采购.xlsx',version:5},tone:'success'})});
  try{await tick();const doc=t.w.document;
    assert.equal(doc.querySelector('.cf-resource-name')?.textContent,'采购.xlsx');
    assert.equal(doc.querySelectorAll('.cf-change').length,2);
    assert.equal(doc.querySelector('.cf-before')?.textContent,'215');assert.equal(doc.querySelector('.cf-after')?.textContent,'230');
    assert.equal(doc.querySelectorAll('img').length,0);assert.doesNotMatch(doc.querySelector('.cf-body').textContent,/旧文本备用/);
    assert.equal(doc.querySelector('details.cf-details')?.open,false);assert.match(doc.querySelector('.cf-details').textContent,/proposal1/);
    assert.equal(t.buttons()[0].textContent,'确认修改');assert.equal(t.writes.length,0);
    t.buttons()[0].click();await tick();assert.equal(t.writes.length,1);assert.match(doc.body.textContent,/第 5 版/);
    assert.equal(doc.querySelector('[data-confirm-id]').dataset.outcome,'success');assert.equal(t.buttons().length,0);
  }finally{t.close();}
});
function mount(presenter:any,options:any={}){
  const dom=new JSDOM('<div id="body"></div>',{runScripts:'outside-only',url:'http://localhost/index.html#/dash'}),w=dom.window as any,writes:any[]=[],paths:string[]=[];
  w.shangshuConfirmationPresenters={'mail.send':presenter};
  w.esc=(value:any)=>String(value??'').replace(/[&<>"']/g,(x:string)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
  w.money=String;w.toast=()=>{};w.chatScrollBottom=()=>{};w.chatConfirmFollowUp=async()=>{};w.chatUpdateFab=()=>{};
  w.api=async(path:string,request:any)=>{paths.push(path);if(options.request) return options.request(path,request,writes);
    if(request)writes.push(JSON.parse(request.body));return {json:async()=>request?{id:'proposal1',status:JSON.parse(request.body).decision,...(options.response||{ok:true,result:{status:'Queued'}})}:(options.read?options.read(path):{list:[]})};};
  // ⚠️ 先把真的骨架助手补进 window（见文件头的说明），再抽片段跑。
  w.eval(skeletonSource+'\nwindow.chatSkeleton=chatSkeleton;window.chatHistorySkeleton=chatHistorySkeleton;');
  w.eval(source.slice(source.indexOf('const CHAT_CONFIRM_NAMES'),source.indexOf('/* —— 确认之后')));
  options.setup?.(w);
  const confirm={id:'proposal1',capability:'mail.send',payload:{mail:'m1',expected_version:2},entity_type:'mail',entity_id:'m1',...options.confirm};
  w.chatAddConfirmCard(w.document.querySelector('#body'),confirm);
  return {w,writes,paths,buttons:()=>[...w.document.querySelectorAll('.cf-btn.ok,.cf-btn.no')] as HTMLButtonElement[],close:()=>dom.window.close()};
}

// BASE967-32（R967-D01）：独立待审目录已移除，原目录断言迁到角标/原对话恢复上——去重、排终态、不自动执行、正式口。
it('角标按id去重并排终态、不自动执行：测试通过 = 计数只含唯一待审，只走正式审核口，全程不写库',async()=>{
  const p={id:'p1',capability:'mail.send',status:'proposed',created_via:'ai-chat',payload:{mail:'m1',secret:'never-on-fab'}};
  const t=fabMount(()=>({ok:true,list:[p,p,{...p,id:'done',status:'confirmed'},{...p,id:'failed',status:'failed'}]}));
  try{
    let path='';t.w.api=async(p0:string)=>{path=p0;return {ok:true,json:async()=>({ok:true,list:[p,p,{...p,id:'done',status:'confirmed'},{...p,id:'failed',status:'failed'}]})};};
    await t.w.chatEnsurePendingCue(true);
    assert.equal(path,'api/platform/action-proposals?status=Proposed&limit=200','走正式公共审核口，显式分页上限');
    assert.doesNotMatch(path,/api\/confirmations/,'不走旧confirmation路径');
    assert.equal(t.fab().dataset.pendingReviews,'1','同id去重、终态排除');
    assert.equal(t.fab().querySelector('[data-review-kind="assistant"]').textContent,'1');
    assert.equal(t.w.document.querySelector('[data-confirm-id]'),null,'不自动执行、不自动塞卡');
    assert.equal(t.writes.length,0,'只读计数不写库');
    assert.doesNotMatch(t.fab().outerHTML,/secret/,'候选值不上角标');
    assert.match(source,/chatReplaySession[\s\S]*?chatEnsurePendingCue\(\)/,'回放仍刷新恢复入口');
  }finally{t.close();}
});

const nativeObject={id:'test.native',name:'案件总表',fields:[{id:'remark',label:'备注'}]};
it('确认前人工草稿守卫带上具体记录，不能把所有文件一起锁住',async()=>{
  const t=mount({prepare:async()=>({title:'修改文件',lines:[],objectId:'files.file',recordName:'f1'}),afterExecution:async()=>({title:'保存',lines:[]})});
  let name:any;t.w.addEventListener('shangshu:before-object-change',(event:any)=>{name=event.detail.name;if(name==='f2')event.preventDefault();});
  try{await tick();t.buttons()[0].click();await tick();assert.equal(name,'f1');assert.equal(t.writes.length,1);}finally{t.close();}
});
const nativeAction={id:'test.case.update',title:'修改案件',executable:true,hidden:{case:'case1',expected_version:2},values:{case:'case1',expected_version:2,remark:'原值'},input_schema:{properties:{case:{title:'案件'},expected_version:{title:'版本'},remark:{title:'备注'},reason:{title:'修改依据'}}}};
function nativeMount(read:any){
  return mount(null,{confirm:{capability:nativeAction.id,payload:{case:'case1',expected_version:2,remark:'新值',reason:'员工核对'}},read,
    setup:(w:any)=>{w.shangshuConfirmationPresenters[nativeAction.id]=w.createRecordActionConfirmationPresenter({objectId:nativeObject.id,recordParam:'case',versionParam:'expected_version'});}});
}
it('原生Action使用原详情绑定显示目标与前后值，确认后读回并刷新同一对象',async()=>{
  let reads=0;const t=nativeMount(()=>{const remark=++reads>=3?'新值':'原值';return {object:nativeObject,record:{remark},actions:[{...nativeAction,values:{...nativeAction.values,remark}}]};});
  let changed:any;t.w.addEventListener('shangshu:object-changed',(e:any)=>changed=e.detail);
  try{await tick();assert.match(t.w.document.body.textContent,/案件总表.*case1/);assert.match(t.w.document.body.textContent,/备注：原值 → 新值/);
    assert.match(t.w.document.body.textContent,/修改依据：员工核对/);assert.equal(t.writes.length,0);
    t.buttons()[0].click();await tick();assert.equal(t.writes.length,1);assert.match(t.w.document.body.textContent,/备注：新值/);assert.equal(changed.object_id,nativeObject.id);
  }finally{t.close();}
});
it('原生记录版本/绑定/可执行权限或字段变化时不允许确认，但仍可拒绝',async()=>{
  for(const kind of ['version','binding','permission','field']){
    const action=structuredClone(nativeAction);
    if(kind==='version')action.hidden.expected_version=3;
    if(kind==='binding')action.hidden.case='case2';
    if(kind==='permission')action.executable=false;
    if(kind==='field')delete (action.input_schema.properties as any).remark;
    const t=nativeMount(()=>({object:nativeObject,record:{remark:'原值'},actions:[action]}));
    try{await tick();assert.equal(t.buttons()[0].disabled,true,kind);assert.equal(t.buttons()[1].disabled,false);t.buttons()[1].click();await tick();assert.deepEqual(t.writes,[{decision:'rejected'}]);}
    finally{t.close();}
  }
});
it('当前对象有人工未保存编辑时Agent确认零写；其他对象不受牵连',async()=>{
  const t=nativeMount(()=>({object:nativeObject,record:{remark:'原值'},actions:[nativeAction]}));
  const dirty=(e:any)=>{if(e.detail.object_id===nativeObject.id)e.preventDefault();};
  try{await tick();t.w.addEventListener('shangshu:before-object-change',dirty);t.buttons()[0].click();await tick();assert.equal(t.writes.length,0);
    t.w.removeEventListener('shangshu:before-object-change',dirty);t.buttons()[0].click();await tick();assert.equal(t.writes.length,1);
  }finally{t.close();}
});

it('角标迟到响应与账号切换不回填旧候选：测试通过 = 迟到旧响应不入角标',async()=>{
  for(const mode of ['user','race']){
    let resolve:any;
    const t=fabMount(()=>({ok:true,list:[]}));
    try{
      t.w.api=async()=>({ok:true,json:async()=>new Promise(r=>resolve=r)});
      const first=t.w.chatEnsurePendingCue(true);await tick();
      if(mode==='user')t.w.currentUserInfo={username:'u2'};
      t.w.api=async()=>({ok:true,json:async()=>({ok:true,list:[{id:'new',capability:'mail.send',status:'proposed',created_via:'code'}]})});
      await t.w.chatEnsurePendingCue(true);
      resolve({ok:true,list:[{id:'old',capability:'mail.send',status:'proposed',created_via:'ai-chat'}]});await first;
      assert.equal(t.fab().querySelector('[data-review-kind="assistant"]'),null,'迟到旧响应不回填');
      assert.equal(t.fab().querySelector('[data-review-kind="automation"]').textContent,'1');
    }finally{t.close();}
  }
});

it('读取失权清空旧计数不复用缓存卡或执行操作：测试通过 = 计数清零、无缓存卡、无写操作',async()=>{
  let denied=false;const t=fabMount(()=>denied?{ok:false,error:'Permission denied'}:{ok:true,list:[{id:'p1',capability:'mail.send',status:'proposed',created_via:'ai-chat'}]});
  try{
    await t.w.chatEnsurePendingCue(true);assert.equal(t.fab().dataset.pendingReviews,'1');
    denied=true;await t.w.chatEnsurePendingCue(true);
    assert.equal(t.fab().dataset.pendingReviews,'0');
    assert.equal(t.w.document.querySelector('[data-confirm-id]'),null,'不复用缓存卡');
    assert.equal(t.writes.length,0,'不执行任何操作');
    assert.match(t.fab().textContent,/待审待核/);
  }finally{t.close();}
});

it('异步确认预览完成前禁止同意，真实预览纯文本展示，拒绝始终可用',async()=>{
  let resolve:any;const wait=new Promise(r=>resolve=r);
  const t=mount({prepare:async()=>wait,afterExecution:async()=>({title:'等待发送',lines:['尚未发出'],tone:'pending'})});
  try{assert.equal(t.buttons()[0].disabled,true);assert.equal(t.buttons()[1].disabled,false);
    resolve({title:'发送邮件',lines:['收件人：客户 <customer@example.invalid>','正文：<script>bad()</script>\n第二行','附件：合同.pdf · 第 2 版']});await tick();
    assert.equal(t.buttons()[0].disabled,false);assert.match(t.w.document.body.textContent,/customer@example.invalid/);
    assert.match(t.w.document.body.textContent,/第二行/);assert.equal(t.w.document.querySelectorAll('script').length,0);assert.equal(t.writes.length,0);
  }finally{t.close();}
});

const object={id:'test.orders',title:'采购台账',revision:3,operations:['read','create','update'],fields:[{id:'quantity',label:'数量'}],input_schema:{properties:{quantity:{type:'number'}}}};
it('受管对象新建卡展示真实字段名称和值，确认后读回该记录，不展示空卡',async()=>{
  const t=mount(null,{confirm:{capability:'platform.object.create',payload:{object_id:object.id,expected_revision:3,values:{quantity:20}}},
    read:(path:string)=>path.endsWith('/objects')?{ok:true,list:[object]}:{ok:true,object,record:{name:'r1',quantity:20,modified:'m2'}},
    response:{ok:true,result:{name:'r1'}}});
  const changed:any[]=[];t.w.addEventListener('shangshu:object-changed',(event:any)=>changed.push(event.detail));
  try{await tick();assert.equal(changed.length,0);assert.match(t.w.document.body.textContent,/采购台账/);assert.match(t.w.document.body.textContent,/数量：20/);
    t.buttons()[0].click();await tick();assert.deepEqual(t.writes,[{decision:'confirmed'}]);assert.match(t.w.document.body.textContent,/已保存/);
    assert.match(t.w.document.body.textContent,/数量：20/);assert.equal(changed.length,1);assert.equal(changed[0].object_id,object.id);assert.equal(changed[0].name,'r1');
  }finally{t.close();}
});

it('对象提案拒绝、执行失败或保存结果无法读回时不广播记录变更',async()=>{
  for(const kind of ['rejected','failed','unreadable']){
    const t=mount(null,{confirm:{capability:'platform.object.create',payload:{object_id:object.id,expected_revision:3,values:{quantity:20}}},
      read:(path:string)=>path.endsWith('/objects')?{list:[object]}:{object,record:null},
      response:kind==='failed'?{ok:false,error:'写入失败'}:{ok:true,result:{name:'r1'}}});
    let changes=0;t.w.addEventListener('shangshu:object-changed',()=>changes++);
    try{await tick();t.buttons()[kind==='rejected'?1:0].click();await tick();assert.equal(changes,0,kind);}
    finally{t.close();}
  }
});

it('受管对象更新显示前后值；字段不可读、定义修订或行版本变化均禁止确认',async()=>{
  for(const reason of ['valid','missing','revision','modified']){
    const obj=reason==='missing'?{...object,fields:[]}:{...object,revision:reason==='revision'?4:3};
    const t=mount(null,{confirm:{capability:'platform.object.update',payload:{object_id:object.id,name:'r1',expected_revision:3,expected_modified:'m1',values:{quantity:20}}},
      read:()=>({ok:true,object:obj,record:{name:'r1',quantity:10,modified:reason==='modified'?'m2':'m1'}})});
    try{await tick();if(reason==='valid'){assert.match(t.w.document.body.textContent,/数量：10 → 20/);assert.equal(t.buttons()[0].disabled,false);}
      else{assert.equal(t.buttons()[0].disabled,true);t.buttons()[0].click();assert.equal(t.writes.length,0);}
      assert.equal(t.buttons()[1].disabled,false);
    }finally{t.close();}
  }
});

it('读取失败保持禁止同意但可拒绝，拒绝不触发确认执行',async()=>{
  const t=mount({prepare:async()=>{throw Error('草稿无权读取');}});
  try{await tick();assert.equal(t.buttons()[0].disabled,true);assert.match(t.w.document.body.textContent,/草稿无权读取/);
    t.buttons()[1].click();await tick();assert.deepEqual(t.writes,[{decision:'rejected'}]);assert.match(t.w.document.body.textContent,/未执行/);
  }finally{t.close();}
});

it('点击同意前重新核验，草稿版本变化时零确认写入',async()=>{
  let checks=0;const t=mount({prepare:async()=>{if(++checks>1)throw Error('草稿版本已变化，请重新提案');return {title:'发送邮件',lines:['版本 2']};}});
  try{await tick();t.buttons()[0].click();await tick();assert.equal(checks,2);assert.equal(t.writes.length,0);
    assert.equal(t.buttons()[0].disabled,true);assert.equal(t.buttons()[1].disabled,false);assert.match(t.w.document.body.textContent,/版本已变化/);
  }finally{t.close();}
});

it('确认后由领域读取真实状态，不把排队渲染成发送成功，失败读回不能再次执行',async()=>{
  for(const fail of [false,true]){
    let reads=0;const t=mount({prepare:async()=>({title:'发送邮件',lines:['版本 2']}),afterExecution:async()=>{
      reads++;if(fail)throw Error('状态服务暂不可用');return {title:'等待发送',lines:['邮件仍在队列，尚未确认发出'],tone:'pending'};
    }});
    try{await tick();t.buttons()[0].click();await tick();assert.equal(reads,1);assert.deepEqual(t.writes,[{decision:'confirmed'}]);
      assert.equal(t.buttons().length,0);assert.doesNotMatch(t.w.document.body.textContent,/已执行|已发送|已送达/);
      assert.match(t.w.document.body.textContent,fail?/状态.*无法|状态.*失败/:/等待发送/);
    }finally{t.close();}
  }
});

it('预览迟到不能覆盖已经拒绝的卡片',async()=>{
  let resolve:any;const t=mount({prepare:async()=>new Promise(r=>resolve=r)});
  try{t.buttons()[1].click();await tick();resolve({title:'迟到预览',lines:['不该恢复待确认']});await tick();
    assert.match(t.w.document.body.textContent,/已拒绝/);assert.doesNotMatch(t.w.document.body.textContent,/迟到预览/);assert.equal(t.buttons().length,0);
  }finally{t.close();}
});

it('确认接口回放已拒绝或失败状态，不误报成功也不继续发送状态读回',async()=>{
  for(const status of ['rejected','failed']){
    let reads=0;const t=mount({prepare:async()=>({title:'发送邮件',lines:['版本 2']}),afterExecution:async()=>{reads++;return {title:'已发送',lines:[]};}},
      {response:{ok:true,status,idempotent:true}});
    try{await tick();t.buttons()[0].click();await tick();assert.equal(reads,0);assert.equal(t.buttons().length,0);
      assert.doesNotMatch(t.w.document.body.textContent,/已发送|已执行/);assert.match(t.w.document.body.textContent,status==='rejected'?/已拒绝/:/失败/);
    }finally{t.close();}
  }
});

it('真实来源绿色Assistant/蓝色代码，payload伪来源和缺失来源均不冒充',async()=>{
  for(const [created_via,kind,label] of [['ai-chat','assistant','Assistant'],['code','automation','代码自动化'],['execution','automation','代码自动化'],['llm-node','automation','LLM节点'],['','unknown','来源未确认']]){
    const t=mount(null,{confirm:{capability:'files.sheet_cells_write',created_via,payload:{table:'t1',cells:[],source:'ai-chat'}}});
    try{const card=t.w.document.querySelector('[data-confirm-id]');assert.equal(card.dataset.reviewSource,kind);assert.match(card.textContent,new RegExp(label));
      // 来源标签可追溯：卡片带提案身份；payload 伪来源不改变外部来源种类
      assert.equal(card.dataset.confirmId,'proposal1');
      assert.equal(card.classList.contains('review-source-'+kind),true,'来源样式按真实 created_via 着色');
      assert.doesNotMatch(card.textContent,/source:ai-chat|never-on-fab/,'不得把载荷来源字段当来源或泄值');
    }
    finally{t.close();}
  }
});

it('查看并审核定位Excel同提案，查询在hash前且不执行确认；换页被挡不发定位',async()=>{
  for(const blocked of [false,true]){
    const modes:string[]=[];
    const t=mount(null,{confirm:{capability:'files.sheet_cells_write',created_via:'ai-chat',payload:{table:'t 1&x',cells:[]}},
      setup:(w:any)=>{w.go=async()=>!blocked;w.chatSetMode=(mode:string)=>modes.push(mode);}});
    const focus:any[]=[];t.w.addEventListener('shangshu:review-focus',(e:any)=>focus.push(e.detail));
    try{const b=t.w.document.querySelector('[data-review-open]');assert.ok(b);b.click();await tick();
      assert.equal(t.writes.length,0);const url=new URL(t.w.location.href);
      if(blocked){assert.equal(url.hash,'#/dash');assert.equal(focus.length,0);}
      else{assert.equal(url.hash,'#/excel');assert.equal(url.searchParams.get('object'),'t 1&x');assert.equal(url.searchParams.get('proposal'),'proposal1');assert.equal(focus[0].table,'t 1&x');assert.equal(focus[0].proposal_id,'proposal1');}
      assert.deepEqual(modes,blocked?['split']:['split','split']);
    }finally{t.close();}
  }
});

it('邮件查看定位原mail或无mail的新稿提案，不把稿件查看当发送',async()=>{
  for(const mail of ['m1','']){
    const modes:string[]=[];
    const t=mount(null,{confirm:{capability:'mail.save_draft',created_via:'ai-chat',payload:mail?{mail}:{}},setup:(w:any)=>{w.go=async()=>true;w.chatSetMode=(mode:string)=>modes.push(mode);}});
    try{t.w.document.querySelector('[data-review-open]').click();await tick();const url=new URL(t.w.location.href);
      assert.equal(url.hash,'#/mail');assert.equal(url.searchParams.get('mail'),mail||null);assert.equal(url.searchParams.get('proposal'),'proposal1');assert.equal(t.writes.length,0);
      assert.deepEqual(modes,['split','split']);
    }finally{t.close();}
  }
});

it('未支持目标没有跳转按钮，只读操作不创建确认卡',()=>{
  const unsupported=mount(null,{confirm:{capability:'test.unsupported',payload:{table:'t1'}}});
  try{assert.equal(unsupported.w.document.querySelector('[data-review-open]'),null);}finally{unsupported.close();}
  const read=mount(null,{confirm:{capability:'platform.object.query',effect:'read'}});
  try{assert.equal(read.w.document.querySelector('[data-confirm-id]'),null);assert.equal(read.writes.length,0);}finally{read.close();}
});

it('确认拒绝走正式口；未知/403/错提案回包保留原卡与原因，不假称成功',async()=>{
  for(const kind of ['ok','network','permission','wrong']){
    const t=mount(null,{confirm:{created_via:'ai-chat'},request:async(path:string,request:any,writes:any[])=>{
      if(!request)return {json:async()=>({list:[]})};writes.push(JSON.parse(request.body));
      if(kind==='network')throw Error('网络中断');
      return {ok:kind!=='permission',status:kind==='permission'?403:200,json:async()=>kind==='permission'?{ok:false,error:'当前无审核权限'}:{ok:true,id:kind==='wrong'?'other':'proposal1',status:'rejected'}};
    }});
    try{t.buttons()[1].click();await tick();assert.match(t.paths[0],/^api\/platform\/action-proposals\/proposal1\/resolve$/);assert.deepEqual(t.writes,[{decision:'rejected'}]);
      const card=t.w.document.querySelector('[data-confirm-id]');assert.ok(card);
      if(kind==='ok'){assert.equal(card.classList.contains('resolved'),true);assert.match(card.textContent,/已拒绝/);}
      else{assert.equal(card.classList.contains('resolved'),false);assert.ok(card.querySelector('[role="alert"]'));assert.doesNotMatch(card.textContent,/已拒绝|已执行|已发送/);assert.equal(t.buttons().length,2);}
    }finally{t.close();}
  }
});

it('来源跳动有reduce-motion关闭且不让中性未知来源跳动',()=>{
  const css=readFileSync(new URL('../../../shangshu-web/css/chat-module.css',import.meta.url),'utf8');
  assert.match(css,/review-source-assistant[\s\S]*?var\(--green/);assert.match(css,/review-source-automation[\s\S]*?var\(--blue/);
  assert.match(css,/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?review-source-dot[\s\S]*?animation:\s*none/);
});

function fabMount(read:any){
  const t=mount(null,{confirm:{capability:'test.unsupported',id:'ignore'}}),w=t.w;
  w.document.querySelector('#body').innerHTML='';
  w.document.body.insertAdjacentHTML('beforeend','<button id="ai-fab"></button>');
  w.$=(selector:string)=>w.document.querySelector(selector);w.ICONS={spark:''};w.chatRunning=false;w.chatRunNotice='';
  w.currentUserInfo={username:'staff1'};const shown:any[]=[];
  w.chatMode='hidden';w.chatLastMode='float';w.chatSetMode=(mode:string)=>shown.push(mode);
  w.api=async()=>({ok:true,json:async()=>read()});
  const start=source.indexOf('function chatUpdateFab');
  // 同一个脚本词法环境，和产品加载一致；单独eval函数会丢let Map闭包。
  w.eval(source.slice(start,source.indexOf('/* —— 终止对话',start))+
    source.slice(source.indexOf('const CHAT_CONFIRM_NAMES'),source.indexOf('/* —— 确认之后')));
  w.chatBindPendingReviews?.();
  return {...t,shown,fab:()=>w.document.querySelector('#ai-fab')};
}
// BASE967-44（UI-073）：待办发现列表必须显式带分页上限；服务端说还有更多时，角标不得把这页当全集。
it('待办列表显式带分页上限，触顶不当全集：测试通过 = 请求带 limit=200 且 has_more 时角标标注仅列前 200 条',async()=>{
  let path='';
  const t=fabMount(()=>({ok:true,list:[{id:'p1',status:'proposed',created_via:'ai-chat'}],has_more:true}));
  try{
    t.w.api=async(p:string)=>{path=p;return {ok:true,json:async()=>({ok:true,list:[{id:'p1',status:'proposed',created_via:'ai-chat'}],has_more:true})};};
    await t.w.chatEnsurePendingCue(true);
    assert.match(path,/[?&]limit=200(?:&|$)/,'列表请求显式带分页上限');
    assert.equal(t.fab().dataset.pendingReviews,'1');
    assert.match(t.fab().title,/仅列前 200 条/,'has_more 时不把该页当全集');
  }finally{t.close();}
});
it('未调用模型的最小助手入口按授权真提案显示绿蓝计数，无资源摘要；点击只打开助手',async()=>{  const t=fabMount(()=>({ok:true,list:[
    {id:'a',status:'proposed',created_via:'ai-chat',payload:{table:'secret-table',value:'secret-value'}},
    {id:'b',status:'proposed',created_via:'automation'},
    {id:'c',status:'proposed',payload:{source:'ai-chat'}},
    {id:'closed',status:'rejected',created_via:'ai-chat'}]}));
  try{await t.w.chatEnsurePendingCue();assert.equal(t.fab().dataset.pendingReviews,'3');
    assert.equal(t.fab().querySelector('[data-review-kind="assistant"]').textContent,'1');
    assert.equal(t.fab().querySelector('[data-review-kind="automation"]').textContent,'1');
    assert.equal(t.fab().querySelector('.review-source-dot'),null,'入口不再放来源提示点');
    assert.doesNotMatch(t.fab().outerHTML,/secret-table|secret-value|closed/);assert.equal(t.w.document.querySelector('[data-confirm-id]'),null);
    t.fab().click();assert.deepEqual(t.shown,['float']);assert.equal(t.writes.length,0);
  }finally{t.close();}
});
it('新真实SSE候选按ID去重；目标页裁决通知去计数，未知失败不当已完成',async()=>{
  const t=fabMount(()=>({ok:true,list:[]}));
  try{await t.w.chatEnsurePendingCue();const p={id:'new',capability:'files.sheet_cells_write',created_via:'ai-chat',payload:{table:'t1'}};
    t.w.chatAddConfirmCard(t.w.document.querySelector('#body'),p);t.w.chatAddConfirmCard(t.w.document.querySelector('#body'),p);
    assert.equal(t.fab().dataset.pendingReviews,'1');
    t.w.dispatchEvent(new t.w.CustomEvent('shangshu:review-resolved',{detail:{proposal_id:'new',status:'unknown'}}));assert.equal(t.fab().dataset.pendingReviews,'1');
    t.w.dispatchEvent(new t.w.CustomEvent('shangshu:review-resolved',{detail:{proposal_id:'new',status:'rejected'}}));assert.equal(t.fab().dataset.pendingReviews,'0');
    assert.equal(t.writes.length,0);
  }finally{t.close();}
});
it('授权目录只读失败清空旧计数并标待核，迟到旧账号响应不得回填',async()=>{
  let resolve:any;const t=fabMount(()=>({ok:true,list:[]}));
  try{t.w.api=async()=>({ok:true,json:async()=>new Promise(r=>resolve=r)});const old=t.w.chatEnsurePendingCue();await tick();
    t.w.currentUserInfo={username:'staff2'};t.w.api=async()=>({ok:true,json:async()=>({ok:true,list:[{id:'new-user',status:'proposed',created_via:'code'}]})});await t.w.chatEnsurePendingCue();
    resolve({ok:true,list:[{id:'old-user',status:'proposed',created_via:'ai-chat'}]});await old;
    assert.equal(t.fab().querySelector('[data-review-kind="assistant"]'),null);assert.equal(t.fab().querySelector('[data-review-kind="automation"]').textContent,'1');
    t.w.api=async()=>({ok:false,status:403,json:async()=>({ok:false,error:'无权读取'})});await t.w.chatEnsurePendingCue(true);
    assert.equal(t.fab().dataset.pendingReviews,'0');assert.match(t.fab().textContent,/待审待核/);
  }finally{t.close();}
});

it('受管流程来源显示版本/实例/节点及已核实Assistant发起；撤权只显示不可见',()=>{
  const proof={status:'linked',trusted:true,kind:'process',executor_kind:'code',definition_version:'V1',process_instance:'RUN1',node_id:'NODE1',llm_participants:[{node_id:'LLM1'}],initiator:{kind:'assistant',trusted:true}};
  const t=mount(null,{confirm:{capability:'mail.save_draft',created_via:'code',source_provenance:proof,payload:{source_provenance:{trusted:true}}}});
  try{const label=t.w.shangshuReviewSource({created_via:'code',source_provenance:proof});assert.equal(label.trusted,true);assert.match(label.label,/Assistant发起.*代码自动化.*LLM节点参与.*V1.*RUN1.*NODE1/);
    const denied=t.w.shangshuReviewSource({created_via:'ai-chat',source_provenance:{status:'unavailable',trusted:false},payload:{source_provenance:proof}});assert.match(denied.label,/Assistant.*来源详情不可见/);assert.doesNotMatch(denied.label,/RUN1|NODE1|V1/);assert.equal(denied.trusted,false);
    const old=t.w.shangshuReviewSource({created_via:'llm-node'});assert.match(old.label,/LLM节点.*来源证明未核实/);assert.equal(old.trusted,false);
  }finally{t.close();}
});
