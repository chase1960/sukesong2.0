import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, toastText, allToastText} from '../helpers/toast.ts';

const tick=()=>new Promise(resolve=>setTimeout(resolve,15));
const account={bound:true,email:'operator@qq.com',provider:'qq',enabled:true,connection_status:'connected'};
const draft={name:'mail-1',status:'Draft',subject:'采购确认',body:'请核对数量和交期',to:['factory@example.invalid'],cc:[],attachments:[],record_version:1};
function mount(handler:(url:string,body:any)=>any){
  const dom=new JSDOM('<div id="host" class="main-scroll"></div>',{url:'http://localhost/#/mail',runScripts:'outside-only'}),w=dom.window as any;
  w.RENDER={};w.fetch=async(url:string,options:any={})=>{
    // 页面现在会读一次「我能进哪些邮箱」（共享邮箱切换器 + 按权限收入口）。
    // 与本文件断言的发送/同步调用无关，预接掉，免得污染每条的调用列表。
    if(url.includes('/services/mail.mailboxes/'))return {ok:true,status:200,json:async()=>({result:{mailboxes:[]}})};
    // 独立待审目录是只读请求，不是保存/发送；不能被各用例的兜底写回桩误写。
    if(url.includes('/api/platform/action-proposals?'))return {ok:true,status:200,json:async()=>({ok:true,list:[]})};
    const value=await handler(url,options.body?JSON.parse(options.body):null);
    return {ok:!value.error,status:value.status||(!value.error?200:400),json:async()=>value};
  };
  installToast(w); // 必须排在 tool-workspace.js 之前：notify 转调 globalThis.toast
  for(const file of ['tool-workspace','file-reference-picker','mail-center'])w.eval(readFileSync(new URL(`../../../shangshu-web/js/${file}.js`,import.meta.url),'utf8'));
  const dispose=w.mountMailCenter(w.document.querySelector('#host'));
  return {w,dispose:()=>{dispose();dom.window.close();}};
}

/* 写信窗已经没有「存草稿」按钮（用户 2026-10-11：只要失焦就保存）。
   输入没动过时失焦不会自动存，所以「点保存按钮」这类动作换成 Ctrl/⌘S 手存
   —— 那是按钮删掉之后产品留下的手存入口，语义一样（都是整封信存一次）。 */
function pressSave(w:any){
  const event=new w.KeyboardEvent('keydown',{key:'s',metaKey:true,bubbles:true,cancelable:true});
  w.document.querySelector('#detail').dispatchEvent(event);
  return event;
}
/* 关闭确认从「按钮原地换字」改成了弹窗（用户 2026-10-11：「这个能不能用一个弹窗」）。 */
function visibleDialogs(w:any){
  return [...w.document.querySelectorAll('[role="dialog"], dialog, .mail-dialog')]
    .filter((d:any)=>d.isConnected&&!d.hidden);
}
function discardViaDialog(w:any){
  const dialogs=visibleDialogs(w);
  assert.equal(dialogs.length,1,`点关闭应弹出 1 个确认弹窗，实际 ${dialogs.length} 个`);
  const text=dialogs.map((d:any)=>d.textContent||'').join(' ');
  assert.ok(/继续编辑/.test(text),`弹窗里没有「继续编辑」出口：${text.slice(0,120)}`);
  assert.ok(/放弃修改并关闭/.test(text),`弹窗里没有「放弃修改并关闭」出口：${text.slice(0,120)}`);
  /* 公共弹窗组件（ui.dialog）的按钮是 footer 里带 data-act 的 <button>，
     不再是旧的 [data-discard]。按文字认出口，顺带钉住「两个出口是两个按钮」。 */
  const buttons=[...dialogs[0].querySelectorAll('footer button, button')];
  const discard=buttons.find((b:any)=>/放弃修改并关闭/.test(b.textContent||''));
  assert.ok(discard,`弹窗里找不到「放弃修改并关闭」按钮：${dialogs[0].innerHTML.slice(0,200)}`);
  discard.click();
}

it('同邮件工作面人工未保存时阻断Agent，保存读回刷新干净原草稿且销毁移除监听',async()=>{
  let stored={...draft};const t=mount(url=>url.includes('mail.account.status')?{result:{account}}:url.includes('/datasets/')?{rows:[stored],total:1}:{result:{mail:stored}});
  try{await tick();t.w.document.querySelector('[data-open]').click();await tick();
    const input=t.w.document.querySelector('#c-body');input.value='人工尚未保存';input.dispatchEvent(new t.w.Event('input',{bubbles:true}));
    const guard=()=>t.w.dispatchEvent(new t.w.CustomEvent('shangshu:before-object-change',{cancelable:true,detail:{object_id:'mail.message'}}));
    assert.equal(guard(),false);assert.equal(input.value,'人工尚未保存');
    stored={...draft,subject:'Agent已保存',record_version:2};
    t.w.dispatchEvent(new t.w.CustomEvent('shangshu:object-changed',{detail:{object_id:'mail.message',name:draft.name}}));await tick();assert.equal(input.value,'人工尚未保存');
    // 有未保存修改 → 点「关闭」先弹确认弹窗（不是按钮原地换字），窗口还留着
    t.w.document.querySelector('#c-cancel').click();
    assert.ok(t.w.document.querySelector('#c-body'),'还没确认，写信窗不能关');
    discardViaDialog(t.w);
    t.w.document.querySelector('[data-open]').click();await tick();
    stored={...stored,subject:'Agent再次保存',record_version:3};
    t.w.dispatchEvent(new t.w.CustomEvent('shangshu:object-changed',{detail:{object_id:'mail.message',name:draft.name}}));await tick();await tick();
    assert.equal(t.w.document.querySelector('#c-subject').value,'Agent再次保存');assert.equal(guard(),true);
    t.dispose();assert.equal(guard(),true);
  }finally{if(!t.w.closed)t.dispose();}
});

it('真实邮箱首次加载只显示读取中，不闪旧建设页或误报未绑定；读取失败明确不可用',async()=>{
  const loading=mount(()=>new Promise(()=>{}));
  try{assert.match(loading.w.document.querySelector('.preview-label').textContent,/正在连接/);
    assert.match(loading.w.document.querySelector('#compose').textContent,/正在读取/);
    assert.doesNotMatch(loading.w.document.body.textContent,/建设中|服务待接入|未接入|未绑定邮箱|尚不可用/);
  }finally{loading.dispose();}
  const failed=mount(()=>({error:'unavailable'}));
  try{await tick();assert.equal(failed.w.document.querySelector('#compose').disabled,true);
    assert.match(failed.w.document.querySelector('#compose').textContent,/暂不可用/);
    assert.match(failed.w.document.querySelector('.preview-label').textContent,/读取失败/);
  }finally{failed.dispose();}
});

it('已绑定邮箱使用真实发件身份，发送前核对正文与附件；确认前零发信，连点只提交一次',async()=>{
  const writes:any[]=[];let stored:any={...draft};let finish:(data:any)=>void=()=>{};
  const t=mount((url,body)=>{
    if(url.includes('/services/mail.account.status'))return {result:{account}};
    if(url.includes('/datasets/'))return {rows:[stored],total:1,attachment_capability:'fixed_references_v2'};
    if(url.includes('/services/mail.detail'))return {result:{mail:stored}};
    writes.push({url,...body});if(url.includes('mail.send'))return new Promise(resolve=>{finish=resolve;});
    stored={...stored,...body.payload,record_version:2,attachment_bindings:{}};return {result:stored};
  });
  try{await tick();t.w.document.querySelector('[data-open]').click();await tick();
    assert.equal(t.w.document.querySelector('#c-send').disabled,false);assert.match(t.w.document.querySelector('#c-from').textContent,/operator@qq.com/);
    t.w.document.querySelector('#c-send').click();await tick();assert.equal(writes.length,0);
    assert.match(t.w.document.querySelector('.mail-dialog').textContent,/请核对数量和交期/);
    const button=t.w.document.querySelector('#send-ok');button.click();button.click();await tick();assert.equal(writes.length,1);assert.equal(writes[0].payload.expected_version,1);
    stored={...stored,status:'Queued',record_version:2};finish({result:stored});await tick();await tick();
    // 反向断言扫**全部** toast：只看最新一条会漏掉中途弹过又叠着的假成功提示
    assert.doesNotMatch(allToastText(t.w),/对方已收到|发送成功/);
    assert.match(t.w.document.body.textContent,/发送中|排队/);
  }finally{t.dispose();}
});

it('收件详情可以回复，保存携带原邮件ID；立即同步调用本人动作并返回真实计数',async()=>{
  const writes:any[]=[];const incoming={...draft,status:'Received',from_address:'factory@example.invalid',subject:'报价',message_id:'<in-1>',record_version:3};
  const t=mount((url,body)=>{
    if(url.includes('mail.account.status'))return {result:{account}};
    if(url.includes('/datasets/'))return {rows:[incoming],total:1};
    if(url.includes('mail.detail'))return {result:{mail:incoming}};
    writes.push({url,...body});return {result:url.includes('mail.sync')?{added:1,skipped:2,has_more:false}:{...draft,...body.payload,name:'reply-1',record_version:1}};
  });
  try{await tick();t.w.document.querySelector('#mail-sync').click();await tick();assert.match(writes[0].url,/mail.sync/);assert.match(toastText(t.w),/1/);
    t.w.document.querySelector('[data-open]').click();await tick();assert.match(t.w.document.querySelector('#detail').textContent,/factory@example.invalid/);
    t.w.document.querySelector('#reply').click();
    /* 人点回复现在**调后端动作**（`mail.reply`）—— 写信窗是动作回包之后才开的，
       所以要等它开出来（原来点一下就同步开窗）。 */
    for(let i=0;i<40;i++){if(t.w.document.querySelector('#c-to'))break;await tick();}
    assert.ok(t.w.document.querySelector('#c-to'),'点回复后没开出写信窗');
    assert.match(t.w.document.querySelector('#c-to').value,/factory@example.invalid/);
    pressSave(t.w);await tick();
    /* 改写（不是削弱）：原来按**序号**取 writes[1]。2026-10-13 加了「打开未读的信
       自动标已读」后，打开详情会多发一个 mail.set_read，序号就错位了。
       改成按**请求类型**找保存那一条 —— 判据不变（保存要带原邮件 ID），
       只是不再假设「保存一定是第 2 个请求」。 */
    const save=writes.find(x=>/mail\.save_draft/.test(x.url));
    assert.ok(save, `没有保存请求，实际发出：${writes.map(x=>x.url).join(' | ')}`);
    assert.equal(save.payload.reply_to_mail,'mail-1');
  }finally{t.dispose();}
});

it('未绑定仍可存草稿但真实发送与同步禁用，邮箱设置可达；未知结果不能重发',async()=>{
  const t=mount(url=>url.includes('mail.account.status')?{result:{account:{bound:false}}}:url.includes('/datasets/')?{rows:[{...draft,status:'Unknown'}],total:1}:{result:{mail:{...draft,status:'Unknown'}}});
  try{await tick();assert.equal(t.w.document.querySelector('#examples-toggle').hidden,true,'正式邮箱不显示历史假样例入口');assert.equal(t.w.document.querySelector('#accounts-btn').disabled,false);assert.equal(t.w.document.querySelector('#mail-sync').disabled,true);
    t.w.document.querySelector('[data-open]').click();await tick();assert.match(t.w.document.querySelector('#detail').textContent,/待确认|待核实/);assert.equal(t.w.document.querySelector('#c-send'),null);
  }finally{t.dispose();}
});

it('只有尚未进入SMTP的Queued可人工核对后继续发送，Sending与Unknown不能继续或重发',async()=>{
  for(const status of ['Queued','Sending','Unknown']){
    const queued={...draft,status,record_version:4,from_address:account.email};const writes:any[]=[];
    const t=mount((url,body)=>{
      if(url.includes('mail.account.status'))return {result:{account}};
      if(url.includes('/datasets/'))return {rows:[queued],total:1};
      if(url.includes('mail.detail'))return {result:{mail:queued}};
      writes.push({url,...body});return {result:queued};
    });
    try{await tick();t.w.document.querySelector('[data-open]').click();await tick();const button=t.w.document.querySelector('#continue-mail');
      if(status!=='Queued'){assert.equal(button,null);continue;}
      assert.ok(button);button.click();assert.equal(writes.length,0);assert.match(t.w.document.querySelector('.send-body-view').textContent,/请核对数量和交期/);
      t.w.document.querySelector('#send-ok').click();await tick();assert.equal(writes.length,1);assert.equal(writes[0].payload.expected_version,4);
    }finally{t.dispose();}
  }
});

it('修改后发送先保存最新正文与固定附件，核对后只冻结保存回执版本',async()=>{
  let stored:any={...draft,attachments:[{file:'f1',name:'报价.txt',label:'第 1 版',size:10}]};const writes:any[]=[];
  const t=mount((url,body)=>{
    if(url.includes('mail.account.status'))return {result:{account}};
    if(url.includes('/datasets/'))return {rows:[stored],total:1,attachment_capability:'fixed_references_v2'};
    if(url.includes('mail.detail'))return {result:{mail:stored}};
    writes.push({url,...body});
    if(url.includes('mail.save_draft'))stored={...stored,...body.payload,attachments:[{file:'bound1',name:'报价.txt',label:'第 1 版',size:10}],record_version:2,attachment_bindings:{f1:'bound1'}};
    else stored={...stored,status:'Queued',record_version:3};
    return {result:stored};
  });
  try{await tick();t.w.document.querySelector('[data-open]').click();await tick();const body=t.w.document.querySelector('#c-body');body.value='修改后的数量';body.dispatchEvent(new t.w.Event('input'));
    t.w.document.querySelector('#c-send').click();await tick();assert.equal(writes.length,1);assert.match(writes[0].url,/mail.save_draft/);assert.equal(writes[0].payload.body,'修改后的数量');
    assert.match(t.w.document.querySelector('.send-body-view').textContent,/修改后的数量/);assert.match(t.w.document.querySelector('.send-list').textContent,/报价.txt.*第 1 版/);
    t.w.document.querySelector('#send-ok').click();await tick();assert.equal(writes[1].payload.expected_version,2);assert.deepEqual(Object.keys(writes[1].payload).sort(),['expected_version','mail']);
  }finally{t.dispose();}
});

it('发送请求断线后原键核实，不换版本、不放开离页、不创造第二发送意图',async()=>{
  const writes:any[]=[];
  const t=mount((url,body)=>{
    if(url.includes('mail.account.status'))return {result:{account}};
    if(url.includes('/datasets/'))return {rows:[draft],total:1};
    if(url.includes('mail.detail'))return {result:{mail:draft}};
    writes.push({url,...body});if(writes.length===1)throw Error('connection lost');return {result:{...draft,status:'Unknown',record_version:2}};
  });
  try{await tick();t.w.document.querySelector('[data-open]').click();await tick();t.w.document.querySelector('#c-send').click();await tick();
    t.w.document.querySelector('#send-ok').click();await tick();assert.match(t.w.document.querySelector('#send-ok').textContent,/核实/);
    assert.equal(t.w.dispatchEvent(new t.w.Event('shangshu:before-page-change',{cancelable:true})),false);
    t.w.document.querySelector('#send-ok').click();await tick();assert.deepEqual(writes[1],writes[0]);
  }finally{t.dispose();}
});

it('真实来信附件自动入库，未入库状态可见且无手动归档；当前邮件上下文带正文与出处（2026-10-21 起带正文）',async()=>{
  const writes:any[]=[];const incoming={...draft,status:'Received',attachments:[{file:'file-1',name:'工厂报价.txt',size:10,imported:false}]};
  const t=mount((url,body)=>{
    if(url.includes('mail.account.status'))return {result:{account}};
    if(url.includes('/datasets/'))return {rows:[incoming],total:1};
    if(url.includes('mail.detail'))return {result:{mail:incoming}};
    writes.push({url,...body});return {result:{name:'archived-file'}};
  });
  const contexts:any[]=[];t.w.chatSetBusinessContext=(c:any)=>contexts.push(c);
  try{await tick();t.w.document.querySelector('[data-open]').click();await tick();
    assert.equal(contexts.at(-1).entity_id,'mail-1');assert.equal(contexts.at(-1).entity_type,'mail.message');
    /* 2026-10-21 口径更新：上下文**要**带用户正在读的那封信的正文
       （用户原话：把那封信的内容一起交过去）——
       所以「只给邮件ID不给正文」这条老断言改成：
       **带正文（且有上限、带出处）**，但**不带附件字节**、不带整封信的所有字段。 */
    const last=contexts.at(-1);
    assert.ok(last.content,'上下文里要有「当前查看的内容」');
    assert.match(last.content.text,/请核对数量和交期/,'正文要在');
    assert.equal(last.content.truncated,false);
    assert.deepEqual(JSON.parse(JSON.stringify(last.content.refs)),[{via:'record',entity_type:'mail.message',entity_id:'mail-1'}],'要给出处，服务端按当前身份重读核对');
    assert.match(last.content.text,/工厂报价\.txt/,'附件摘要（文件名）要在');
    assert.equal(JSON.stringify(contexts).includes('file-1'),false,'附件本体（文件引用/字节）不许进上下文');
    // 用户已确认自动入库，不再靠员工手动另存建立资源。失败仍明确可见。
    assert.equal(t.w.document.querySelector('[data-real-archive]'),null);
    assert.match(t.w.document.querySelector('.att-block').textContent,/未入库/);
    assert.equal(writes.some(x=>/files\.import_attachment/.test(x.url)),false);
  }finally{t.dispose();}
});
