import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
 MAIL-08 写稿审核的**界面那一半** —— 用户 2026-10-13 给 C 的表第 8 行：

   「Assistant 起草、改写邮件及整理表格；人查看差异、**修改**、采用或拒绝，
     **写稿与发送分别确认**」

 后端语义那一半已经测过（`test-mail-m08-draft-review.py` 15/15）：
 拒绝零写、改后采用存的是人的那份、旧版本失效、写稿与发送分开、来源可辨。
 原聊天确认卡进入真实写信页；人工编辑按正式契约 edited_value
 与原候选一起确认，成功后独立读回，失败保留输入。

   测试通过 = 下面全部成立：

   R1. 原聊天卡有**待审候选**入口，列出助手提的写稿候选，并标得出来源是助手
   R2. 每条候选看得见**差异**（原值 → 建议值），不是只给一句摘要
   R3. 候选内容**可以改** —— 主题/正文是可编辑的，不是只读
   R4. **拒绝零写** —— 点拒绝，只调正式 proposal resolve 的 rejected，
       不发任何写请求，邮件正文不动
   R5. **改后采用** —— 改过内容再采用，存进去的是**改过的那份**，
       不是助手原稿；同一候选原子 confirmed，不另发 execute 再 reject
   R6. **写稿与发送分开** —— 候选卡上明写「不发送」，采用只写草稿
*/

const tick = () => new Promise(r => setTimeout(r, 20));

const MAIL = {
  name: 'mail-1', subject: '人工原稿', body: '人工正文', body_format: 'Text',
  to: ['对方 <o@x.example>'], cc: [], record_version: 3, status: 'Draft',
  attachments: [], mailbox_id: 'box-personal',
};

/** 助手提的一条写稿候选：把正文改成「助手写的正文」。 */
const PROPOSAL = {
  id: 'APROP-1', capability: 'mail.save_draft', action_version: '1.4.0',
  entity_type: 'mail', entity_id: 'APROP-1',
  payload: {mail: MAIL.name, expected_version: 3, subject: '人工原稿',
            body: '助手写的正文', to: ['对方 <o@x.example>'], cc: []},
  summary: {}, status: 'proposed', created_via: 'ai-chat',
  decision_by: null, decision_at: null, execution_audit: null,
};

function mount(opts: {proposals?: any[]; mail?: any; resolveError?:number; badRead?:boolean;url?:string;mailboxes?:any[];datasetDelay?:number;detailDelay?:number;resolveShape?:'public'|'proposal'|'result'|'foreign'|'unknown'|'missing-id';persistBody?:(html:string)=>string;inlineReview?:any;reviews?:Record<string,any>;acceptShape?:'foreign'|'unknown'|'missing-id';acceptError?:number;acceptBusinessError?:boolean;acceptDelay?:number;saveDelay?:number;saveError?:number}) {
  const dom = new JSDOM('<div id="host"></div><div id="toast-zone"></div>',
      {url: opts.url||'http://localhost/index.html#/mail', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  const calls: {url: string; body: any;cache?:string}[] = [];
  const resolved: any[] = [];
  const executed: any[] = [];
  const reviewEvents:any[]=[];w.addEventListener('shangshu:review-resolved',(event:any)=>reviewEvents.push(event.detail));
  let mail = {...MAIL, ...(opts.mail || {})};
  const accepts:any[]=[];let inline=opts.inlineReview?JSON.parse(JSON.stringify(opts.inlineReview)):null;
  const reviews=opts.reviews?JSON.parse(JSON.stringify(opts.reviews)):null;
  if(inline?.target.mail===null)mail={...mail,subject:'',body:'',to:[],cc:[]};
  const respond = (payload: any) => ({ok: true, status: 200, json: async () => payload,
                                      text: async () => JSON.stringify(payload)});
  w.fetch = async (url: string, options: any = {}) => {
    const body = options && options.body ? JSON.parse(options.body) : {};
    calls.push({url: String(url), body,cache:options.cache});
    const delay=url.includes('/datasets/')?opts.datasetDelay:url.includes('/services/mail.detail/')?opts.detailDelay:0;
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    const currentValue=(key:string)=>key==='attachments'?(mail.attachments||[]).map((a:any)=>a.file):key==='mailbox'?mail.mailbox_id:mail[key];
    if(url.endsWith('/review')){
      if(reviews)inline=reviews[String(url).split('/').at(-2)!]||null;
      if(!inline)return respond({unsupported:true,reason:'旧审核兼容夹具未提供分项协议'});
      for(const unit of inline.units)unit.current_value=currentValue(unit.unit_id);
      return respond(inline);
    }
    if(url.endsWith('/accept')){
      accepts.push(body);if(opts.acceptDelay)await new Promise(resolve=>setTimeout(resolve,opts.acceptDelay));if(opts.acceptError)return {ok:false,status:opts.acceptError,json:async()=>({ok:false,error:'分项确认结果待核实'})};
      if(opts.acceptBusinessError)return respond({ok:false,error:'候选字段 body 不允许修改'});
      const ids=body.units||inline.units.filter((u:any)=>u.status==='pending').map((u:any)=>u.unit_id);
      for(const id of ids){const unit=inline.units.find((u:any)=>u.unit_id===id);const value=body.edited_value?.[id]??unit.value;mail={...mail,[id]:value,...(id==='body'?{body_format:unit.kind==='html'?'HTML':'Text'}:{})};if(id==='body'&&opts.persistBody)mail.body=opts.persistBody(mail.body);unit.status='accepted';unit.value=value;}
      mail.record_version++;inline.target.mail=mail.name;inline.review_revision=String(Number(inline.review_revision)+1);inline.remaining=inline.units.filter((u:any)=>u.status==='pending').length;inline.accepted_count=inline.units.length-inline.remaining;inline.status=inline.remaining?'proposed':'confirmed';for(const unit of inline.units)unit.current_value=currentValue(unit.unit_id);
      const receipt={...inline,accepted_units:ids,result:{name:mail.name,status:'Draft',record_version:mail.record_version},audit:'ACT-TEST'};
      if(opts.acceptShape==='foreign')receipt.id='APROP-OTHER';if(opts.acceptShape==='unknown')receipt.status='unknown';if(opts.acceptShape==='missing-id')delete receipt.id;return respond(receipt);
    }
    if (url.includes('/api/platform/action-proposals') && !options?.method) {
      return respond({list: opts.proposals || []});
    }
    if (url.includes('/api/platform/action-proposals/') && String(options?.method).toUpperCase() === 'POST') {
      if(opts.resolveError)return {ok:false,status:opts.resolveError,json:async()=>({ok:false,error:'本次确认被拒绝或结果未知'})};
      const id=String(url).split('/').slice(-2)[0];resolved.push({id,decision:body.decision,edited_value:body.edited_value});
      const proposal=(opts.proposals||[]).find(p=>p.id===id)!;
      if(body.decision==='confirmed'){
       const edited=Object.fromEntries(Object.entries(body.edited_value||{}).map(([key,typed]:any)=>[key,typed.value]));
       mail={...mail,...proposal.payload,...edited,record_version:mail.record_version+1};
       if(opts.persistBody)mail.body=opts.persistBody(mail.body);
      }
      // 与正式 core/BFF 一致：根是提案状态，result.status 是邮件自身的 Draft。
      const receipt={id,status:body.decision==='rejected'?'rejected':'confirmed',result:{name:mail.name,status:'Draft'},payload:proposal.payload};
      if(opts.resolveShape==='proposal')return respond({ok:true,proposal:receipt});
      if(opts.resolveShape==='result')return respond({ok:true,result:receipt});
      if(opts.resolveShape==='foreign')return respond({ok:true,proposal:{...receipt,id:'APROP-OTHER'}});
      if(opts.resolveShape==='unknown')return respond({ok:true,...receipt,status:'unknown'});
      if(opts.resolveShape==='missing-id'){const {id:_,...noIdentity}=receipt;return respond({ok:true,proposal:noIdentity});}
      return respond({ok:true,...receipt});
    }
    if (url.includes('/services/mail.detail/')) {
      return respond({result: {mail:opts.badRead?{...mail,body:'错误正文'}:mail}});
    }
    if (url.includes('/services/mail.account.status/')) {
      return respond({result: {account: {bound: true, enabled: true, connection_status: 'connected',
        email: 'me@qq.com', display_name: '我', signature: {enabled: false, html: '', resources: []}}}});
    }
    if (url.includes('/services/mail.mailboxes/')) {
      return respond({result: {mailboxes: opts.mailboxes || [{
        id: 'box-personal', kind: 'personal', department: '', email: 'me@qq.com', display_name: '我',
        enabled: true, connection_status: 'connected',
        rights: {read: true, edit_draft: true, send: true, manage: true, signature: true}}]}});
    }
    if (url.includes('/datasets/')) {
      return respond({rows: [], total: 0, page: 1, page_length: 30});
    }
    if (url.includes('/actions/mail.save_draft/execute')) {
      executed.push(body);
      if(opts.saveDelay)await new Promise(resolve=>setTimeout(resolve,opts.saveDelay));
      if(opts.saveError)return {ok:false,status:opts.saveError,json:async()=>({ok:false,error:'草稿保存冲突或结果待核实'})};
      mail = {...mail, ...body.payload, record_version: (mail.record_version || 0) + 1};
      return respond({result: {...mail,name:mail.name,record_version:mail.record_version}});
    }
    return respond({result: {}});
  };
  installToast(w);
  for (const rel of ['tool-workspace.js', 'file-reference-picker.js', 'chip-input.js',
                     'domains/mail/mail-editor.js', 'mail-center.js']) {
    w.eval(readFileSync(new URL(`../../../shangshu-web/js/${rel}`, import.meta.url), 'utf8'));
  }
  const dispose = w.mountMailCenter(w.document.querySelector('#host'), {});
  return {w, calls, resolved, executed, accepts,reviewEvents, getMail: () => mail,
          doc: () => w.document,
          dispose: () => { dispose(); dom.window.close(); }};
}

const settle = async () => { await tick(); await tick(); await tick(); await tick(); };

function reviewBtn(t: ReturnType<typeof mount>) {
  return t.doc().querySelector('#review-btn, [data-review-btn]') as any;
}

// 2026-10-15: migrate legacy modal cases to the original chat card + real composer.
// R1/R3/R4/R5/R6, source, failure, HTML safety/readback remain below or in the
// inline/controller cases. Old before/after tabs, multi-card draft editors and
// modal footer geometry are replaced by one work surface; no fake modal fixture.
const HTML_BEFORE='<p>原正文</p><table><tr><td>00123</td><td>原值</td></tr></table><table><tr><td>费用</td><td>800</td></tr></table><blockquote>长引用邮件</blockquote>';
const HTML_NEXT=HTML_BEFORE.replace('原正文','建议正文').replace('原值','建议值');
const HTML_STYLE_NEXT='<p>最终确认正文</p><table><tr><td style="padding:6px;color:red;color:blue">00123</td><td>800</td></tr></table><table><tr><td>第二张表</td></tr></table><blockquote>引用原文</blockquote>';
async function openPublicReview(opts:any={}) {
 const review=opts.inlineReview||{...INLINE_REVIEW,units:[{...INLINE_REVIEW.units[1],value:opts.html||HTML_NEXT}],remaining:1};
 const t=mount({...opts,proposals:[PROPOSAL],inlineReview:review,url:'http://localhost/index.html?proposal=APROP-1#/mail'});
 await settle();await settle();const chat=attachRealChatCard(t);await settle();
 return {...t,chat};
}
it('R1/R3/R6 公共聊天卡是唯一确认入口，原位可编辑，确认只保存不发送',async()=>{
 const t=await openPublicReview();try{
  assert.equal(reviewBtn(t),null);assert.equal(t.doc().querySelector('.mail-review-dialog'),null);
  assert.match(t.chat.card().textContent,/助手|Assistant/);assert.equal(t.chat.button().textContent,'全部确认');
  const body=t.doc().querySelector('[data-mail-review-unit="body"]') as HTMLElement;
  body.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true,detail:2}));
  const editor=body.querySelector('[contenteditable=true]') as HTMLElement;assert.ok(editor);
  editor.querySelector('td')!.textContent='人改值';editor.dispatchEvent(new t.w.Event('input',{bubbles:true}));
  t.chat.button().click();await settle();await settle();
  assert.match(t.getMail().body,/人改值/);assert.equal(new JSDOM(t.getMail().body).window.document.querySelectorAll('table').length,2);
  assert.equal(t.executed.length,0);assert.equal(t.calls.filter(c=>/mail\.send/.test(c.url)).length,0);
  assert.match(t.chat.card().textContent,/草稿已保存.*未发送/);
 }finally{t.dispose();}
});
it('R4 原聊天卡拒绝零写，正式草稿不变',async()=>{
 const t=await openPublicReview();try{
  (t.chat.card().querySelector('.no') as HTMLButtonElement).click();await settle();await settle();
  assert.equal(t.resolved.length,1);assert.equal(t.resolved[0].decision,'rejected');
  assert.equal(t.accepts.length,0);assert.equal(t.executed.length,0);assert.equal(t.getMail().body,MAIL.body);
 }finally{t.dispose();}
});
it('原聊天卡确认403/503均保留原位人工改稿与剩余项',async()=>{
 for(const acceptError of [403,503]){const t=await openPublicReview({acceptError});try{
  const body=t.doc().querySelector('[data-mail-review-unit="body"]') as HTMLElement;body.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true,detail:2}));
  const editor=body.querySelector('[contenteditable=true]') as HTMLElement;editor.querySelector('p')!.textContent='失败保留人工稿';editor.dispatchEvent(new t.w.Event('input',{bubbles:true}));
  t.chat.button().click();await settle();await settle();
  assert.match(editor.textContent||'',/失败保留人工稿/);assert.equal(t.getMail().body,MAIL.body);assert.equal(t.reviewEvents.length,0);assert.equal(t.chat.card().classList.contains('resolved'),false);assert.equal(t.chat.button().disabled,false);
 }finally{t.dispose();}}
});
it('HTML原位安全预览无脚本外链，双击编辑仍保留两张表',async()=>{
 const t=await openPublicReview({html:HTML_NEXT+'<script>window.bad=true</script><img src="https://tracking.example/pixel" onerror="alert(1)">'});try{
  const body=t.doc().querySelector('[data-mail-review-unit="body"]') as HTMLElement;
  assert.equal(body.querySelectorAll('script,img[src^="https:"],[onerror]').length,0);assert.equal(body.querySelectorAll('table').length,2);assert.equal(t.w.bad,undefined);
  body.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true,detail:2}));assert.equal(body.querySelector('[contenteditable=true]')!.querySelectorAll('table').length,2);assert.equal(t.accepts.length,0);
 }finally{t.dispose();}
});
it('HTML只查看不产生人工覆盖；确认仍按原候选且独立读回',async()=>{
 const t=await openPublicReview();try{t.chat.button().click();await settle();await settle();assert.equal(t.accepts.length,1);assert.equal(t.accepts[0].edited_value,undefined);assert.equal(t.getMail().body,HTML_NEXT);assert.equal(t.reviewEvents.at(-1)?.status,'confirmed');assert.ok(t.calls.some(c=>c.url.includes('/services/mail.detail/')));}finally{t.dispose();}
});
it('HTML确定性CSS规范化不假失败，真实缺表/改色/缺正文不假成功',async()=>{
 for(const [success,persistBody] of [
  [true,(html:string)=>html.replace('padding:6px;color:red;color:blue','padding: 6px; color: blue;')],
  [false,(html:string)=>html.replace('<table><tr><td>第二张表</td></tr></table>','')],
  [false,(html:string)=>html.replace('color:blue','color:green')],
  [false,(html:string)=>html.replace('最终确认正文','')],
 ] as const){const t=await openPublicReview({html:HTML_STYLE_NEXT,persistBody});try{
  t.chat.button().click();await settle();await settle();assert.equal(t.chat.card().classList.contains('resolved'),success);
  if(!success){assert.equal(t.reviewEvents.length,0);assert.ok(t.doc().querySelector('[data-mail-review-unit="body"].is-pending'));assert.match(t.doc().querySelector('.mail-inline-review-status')?.textContent||'',/核实/);}
 }finally{t.dispose();}}
});
it('邮件定位按真实邮箱权限，不借个人箱编辑只读部门草稿',async()=>{
 const personal={id:'box-personal',kind:'personal',email:'me@qq.com',enabled:true,rights:{read:true,edit_draft:true,send:true,manage:true,signature:true}};
 const dept={id:'box-dept',kind:'department',email:'dept@example.com',enabled:true,department:'交付部',rights:{read:true,edit_draft:false,send:false,manage:false,signature:false}};
 const t=mount({proposals:[],mail:{mailbox_id:'box-dept'},mailboxes:[personal,dept]});try{await settle();t.w.dispatchEvent(new t.w.CustomEvent('shangshu:review-focus',{detail:{module:'mail',mail:'mail-1'}}));await settle();assert.equal((t.doc().querySelector('#mailbox-switch') as any).value,'box-dept');assert.equal(t.doc().querySelector('#c-editor-host'),null);assert.match(t.doc().querySelector('#detail')?.textContent||'',/没有编辑草稿权限/);}finally{t.dispose();}
});

const INLINE_REVIEW={can_accept:true,can_reject:true,id:PROPOSAL.id,capability:'mail.save_draft',status:'proposed',created_via:'ai-chat',review_revision:'1',target:{module:'mail',mail:MAIL.name},remaining:3,accepted_count:0,units:[
 {unit_id:'subject',label:'主题',kind:'text',value:'助手候选主题',current_value:MAIL.subject,status:'pending'},
 {unit_id:'body',label:'正文',kind:'html',value:HTML_NEXT,current_value:MAIL.body,status:'pending'},
 {unit_id:'to',label:'收件人',kind:'list',value:['new@example.invalid'],current_value:MAIL.to,status:'pending'},
]};
it('分项审核直接打开写信页原位呼吸候选，显示和失焦零写且未确认完不能发送',async()=>{
 const t=mount({proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,url:'http://localhost/index.html?proposal=APROP-1#/mail'});try{await settle();await settle();const d=t.doc();assert.ok(d.querySelector('.mail-compose-head'),'审核应直接落在写信页');assert.equal(d.querySelector('.mail-review-dialog'),null);assert.equal((d.querySelector('#c-subject') as HTMLInputElement).value,'助手候选主题');assert.equal(d.querySelectorAll('[data-mail-review-unit].is-pending').length,3);assert.equal((d.querySelector('#c-send') as HTMLButtonElement).disabled,true);
  (d.querySelector('#c-subject') as HTMLInputElement).dispatchEvent(new t.w.FocusEvent('focusout',{bubbles:true}));await new Promise(r=>setTimeout(r,180));assert.equal(t.accepts.length,0);assert.equal(t.executed.length,0,'展示、预览和离开候选不能混入普通自动保存');assert.equal(t.getMail().body,MAIL.body);
 }finally{t.dispose();}
});

it('双击只编辑不先确认，人工改后单项确认仍用原提案，其他待审值不进正式草稿',async()=>{
 const t=mount({proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,url:'http://localhost/index.html?proposal=APROP-1#/mail'});try{await settle();await settle();const d=t.doc(),unit=d.querySelector('[data-mail-review-unit="subject"]') as HTMLElement;assert.ok(unit);unit.dispatchEvent(new t.w.MouseEvent('click',{bubbles:true,detail:1}));unit.dispatchEvent(new t.w.MouseEvent('click',{bubbles:true,detail:2}));unit.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true,detail:2}));await new Promise(r=>setTimeout(r,550));assert.equal(t.accepts.length,0,'双击序列不能先执行一次单击确认');const input=d.querySelector('#c-subject') as HTMLInputElement;assert.equal(input.readOnly,false);input.value='人工确认主题';input.dispatchEvent(new t.w.Event('input',{bubbles:true}));(unit.querySelector('[data-review-accept-unit]') as HTMLButtonElement).click();await settle();await settle();
  assert.equal(t.accepts.length,1);assert.deepEqual(t.accepts[0].units,['subject']);assert.deepEqual(t.accepts[0].edited_value,{subject:'人工确认主题'});assert.equal(t.getMail().subject,'人工确认主题');assert.equal(t.getMail().body,MAIL.body);assert.deepEqual(t.getMail().to,MAIL.to);assert.equal(t.executed.length,0);assert.equal(t.reviewEvents.length,0,'部分确认不能清整个待审');assert.equal(unit.classList.contains('is-pending'),false);assert.ok(d.querySelector('[data-mail-review-unit="body"].is-pending'));
  input.value='已确认字段的普通修改';input.dispatchEvent(new t.w.Event('input',{bubbles:true}));d.querySelector('#detail')!.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'s',metaKey:true,bubbles:true,cancelable:true}));await settle();assert.equal(t.executed.length,1);assert.equal(t.executed[0].payload.body,MAIL.body,'普通保存只能使用正式正文，不能夹带尚未确认的HTML候选');assert.deepEqual(t.executed[0].payload.to,MAIL.to);assert.match((d.querySelector('#c-body') as HTMLTextAreaElement).value,/建议正文/,'其余待审候选继续显示');
 }finally{t.dispose();}
});

it('新稿仅首次单项确认才创建，未知回包保留原项与同一op重试',async()=>{
 const opts={proposals:[PROPOSAL],inlineReview:{...INLINE_REVIEW,target:{module:'mail',mail:null}},acceptError:503,url:'http://localhost/index.html?proposal=APROP-1#/mail'};const t=mount(opts);try{await settle();await settle();const d=t.doc(),unit=d.querySelector('[data-mail-review-unit="subject"]') as HTMLElement;assert.ok(unit);assert.equal(t.calls.filter(call=>call.url.includes('/mail.detail/')).length,0,'未创建的新候选不读取假mail ID');d.querySelector('#detail')!.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'s',metaKey:true,bubbles:true,cancelable:true}));await settle();assert.equal(t.executed.length,0,'普通保存不能替候选提前建稿');unit.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await settle();assert.equal(t.accepts.length,1);assert.ok(unit.classList.contains('is-pending'));assert.equal(t.reviewEvents.length,0);opts.acceptError=0;unit.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await settle();await settle();assert.equal(t.accepts.length,2);assert.deepEqual(t.accepts[1],t.accepts[0],'未知重试沿原op、原修订、原值，不新建确认意图');assert.equal(t.getMail().subject,'助手候选主题');assert.equal(t.getMail().body,'');assert.equal(t.executed.length,0);
 }finally{t.dispose();}
});

it('页面controller供聊天确认剩余，携带人工待审改稿且不覆盖已接受字段的新修改',async()=>{
 const t=mount({proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,url:'http://localhost/index.html?proposal=APROP-1#/mail'});try{await settle();await settle();const d=t.doc(),subject=d.querySelector('[data-mail-review-unit="subject"]') as HTMLElement;subject.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await settle();await settle();
  const input=d.querySelector('#c-subject') as HTMLInputElement;input.value='已经接受后的人工新主题';input.dispatchEvent(new t.w.Event('input',{bubbles:true}));
  const body=d.querySelector('[data-mail-review-unit="body"]') as HTMLElement;body.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true,detail:2}));const editor=body.querySelector('[contenteditable=true]') as HTMLElement;editor.querySelector('p')!.textContent='人工待审正文';editor.dispatchEvent(new t.w.Event('input',{bubbles:true}));
  const controller=t.w.shangshuInlineReviews?.get(PROPOSAL.id);assert.ok(controller,'聊天和页面应共用按提案ID登记的controller');assert.equal(controller.module,'mail');assert.equal(controller.hasEdits(),true);const final=await controller.acceptRemaining();await settle();
  assert.ok(final,JSON.stringify({status:d.querySelector('.mail-inline-review-status')?.textContent,writes:t.executed,accepts:t.accepts,mail:t.getMail()}));assert.equal(final.status,'confirmed');assert.equal(final.remaining,0);assert.equal(t.getMail().subject,'已经接受后的人工新主题','接受剩余不能盖掉此前已接受字段的人工新修改');assert.match(t.getMail().body,/人工待审正文/);assert.equal(t.accepts.length,2);assert.deepEqual(t.accepts[1].units,['body','to']);assert.match(t.accepts[1].edited_value.body,/人工待审正文/);assert.equal(t.executed.length,1,'已接受字段先走正常保存，pending仍走原提案');assert.equal(t.executed[0].payload.body,MAIL.body,'正常保存不能夹带pending改稿');assert.equal(t.reviewEvents.length,1);assert.equal(d.querySelectorAll('[data-mail-review-unit].is-pending').length,0);
 }finally{t.dispose();assert.equal(t.w.shangshuInlineReviews?.has(PROPOSAL.id),false,'退出页面移除自己的controller');}
});

it('快速确认两项串行排队，第二项使用第一项后的修订而不是静默丢点击',async()=>{
 const t=mount({proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,url:'http://localhost/index.html?proposal=APROP-1#/mail'});try{await settle();await settle();for(const id of ['subject','body'])(t.doc().querySelector('[data-mail-review-unit="'+id+'"]') as HTMLElement).dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await settle();await settle();assert.equal(t.accepts.length,2);assert.notEqual(t.accepts[0].op_id,t.accepts[1].op_id);assert.notEqual(t.accepts[0].expected_review_revision,t.accepts[1].expected_review_revision);assert.equal(t.getMail().subject,'助手候选主题');assert.match(t.getMail().body,/建议正文/);assert.ok(t.doc().querySelector('[data-mail-review-unit="to"].is-pending'));
 }finally{t.dispose();}
});

it('分项草稿独立读回不一致保持原位候选，同op核实成功后才去色；来源认代码',async()=>{
 const opts={proposals:[{...PROPOSAL,created_via:'automation'}],inlineReview:{...INLINE_REVIEW,created_via:'automation'},badRead:false,url:'http://localhost/index.html?proposal=APROP-1#/mail'};const t=mount(opts);try{await settle();await settle();const unit=t.doc().querySelector('[data-mail-review-unit="body"]') as HTMLElement;assert.ok(unit.classList.contains('is-code'));opts.badRead=true;unit.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await settle();await settle();assert.equal(t.reviewEvents.length,0);assert.ok(unit.classList.contains('is-pending'),'不能因200回执先清颜色');assert.match(t.doc().querySelector('.mail-inline-review-status')?.textContent||'',/待核实/);opts.badRead=false;unit.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await settle();await settle();assert.deepEqual(t.accepts[1],t.accepts[0]);assert.equal(unit.classList.contains('is-pending'),false);assert.equal(t.doc().querySelectorAll('[data-mail-review-unit].is-pending').length,2);
 }finally{t.dispose();}
});

it('分项确认403保留人工改稿，放弃剩余只丢候选并保留已确认草稿',async()=>{
 const opts={proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,acceptError:0,url:'http://localhost/index.html?proposal=APROP-1#/mail'};const t=mount(opts);try{await settle();await settle();const d=t.doc(),subject=d.querySelector('[data-mail-review-unit="subject"]') as HTMLElement;subject.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await settle();await settle();const unit=d.querySelector('[data-mail-review-unit="body"]') as HTMLElement;unit.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true,detail:2}));const editor=unit.querySelector('[contenteditable=true]') as HTMLElement;editor.querySelector('p')!.textContent='403保留人工稿';editor.dispatchEvent(new t.w.Event('input',{bubbles:true}));opts.acceptError=403;(unit.querySelector('[data-review-accept-unit]') as HTMLButtonElement).click();await settle();assert.ok(unit.classList.contains('is-pending'));assert.match(editor.textContent||'',/403保留人工稿/);assert.equal(t.getMail().body,MAIL.body);opts.acceptError=0;await t.w.shangshuInlineReviews.get(PROPOSAL.id).rejectRemaining();await settle();await settle();assert.equal(t.getMail().subject,'助手候选主题');assert.equal(t.getMail().body,MAIL.body);assert.equal(t.executed.length,0);assert.equal(t.resolved[0].decision,'rejected');assert.equal(t.w.shangshuInlineReviews.has(PROPOSAL.id),false);assert.equal(t.reviewEvents.at(-1).status,'rejected');
 }finally{t.dispose();}
});

it('同稿正式变动刷新descriptor仍保留待审位置，另起普通邮件会移除旧controller',async()=>{
 const t=mount({proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,url:'http://localhost/index.html?proposal=APROP-1#/mail'});try{await settle();await settle();const controller=t.w.shangshuInlineReviews.get(PROPOSAL.id),body=t.doc().querySelector('[data-mail-review-unit="body"]');t.w.dispatchEvent(new t.w.CustomEvent('shangshu:object-changed',{detail:{object_id:'mail.message',name:MAIL.name}}));await settle();await settle();assert.equal(t.w.shangshuInlineReviews.get(PROPOSAL.id),controller);assert.equal(t.doc().querySelector('[data-mail-review-unit="body"]'),body,'不能把还未确认的建议刷新成普通值');assert.equal(t.doc().querySelectorAll('[data-mail-review-unit].is-pending').length,3);(t.doc().querySelector('#compose') as HTMLButtonElement).click();assert.equal(t.w.shangshuInlineReviews.has(PROPOSAL.id),false);assert.equal(t.doc().querySelector('[data-mail-review-unit]'),null);
 }finally{t.dispose();}
});

it('双击收件人后回车只是补齐地址胶囊，确认本项才提交完整新名单',async()=>{
 const t=mount({proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,url:'http://localhost/index.html?proposal=APROP-1#/mail'});try{await settle();await settle();const unit=t.doc().querySelector('[data-mail-review-unit="to"]') as HTMLElement;unit.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true,detail:2}));const input=unit.querySelector('[data-chip-field]') as HTMLInputElement;assert.ok(input);input.value='第二位 <second@example.invalid>';input.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await settle();assert.equal(t.accepts.length,0,'Enter应先收成地址胶囊，不能在捕获阶段误确认旧名单');(unit.querySelector('[data-review-accept-unit]') as HTMLButtonElement).click();await settle();await settle();assert.equal(t.accepts.length,1);assert.deepEqual(t.accepts[0].edited_value.to,['new@example.invalid','第二位 <second@example.invalid>']);assert.deepEqual(t.getMail().to,t.accepts[0].edited_value.to);
 }finally{t.dispose();}
});

it('正式记录和descriptor同时变错也不能冒充已保存，必须比对本次确认的原始值',async()=>{
 const t=mount({proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,persistBody:html=>html.replace('建议正文','错误保存的正文'),url:'http://localhost/index.html?proposal=APROP-1#/mail'});try{await settle();await settle();const unit=t.doc().querySelector('[data-mail-review-unit="body"]') as HTMLElement;unit.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await settle();await settle();assert.match(t.getMail().body,/错误保存/);assert.ok(unit.classList.contains('is-pending'),'独立读回还须与本次确认快照比，不能只信服务端两份一致的错误值');assert.equal(t.reviewEvents.length,0);assert.match((t.doc().querySelector('#c-body') as HTMLTextAreaElement).value,/建议正文/);assert.match(t.doc().querySelector('.mail-inline-review-status')?.textContent||'',/待核实/);
 }finally{t.dispose();}
});

it('分项确认期间失焦不能把待审值排进普通保存，成功后状态不能卡在等待',async()=>{
 const t=mount({proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,acceptDelay:100,url:'http://localhost/index.html?proposal=APROP-1#/mail'});
 try{await settle();await settle();const d=t.doc(),unit=d.querySelector('[data-mail-review-unit="subject"]') as HTMLElement;
  unit.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  (d.querySelector('#c-subject') as HTMLInputElement).dispatchEvent(new t.w.FocusEvent('focusout',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,260));
  assert.equal(t.accepts.length,1);assert.equal(t.executed.length,0,'候选只能通过分项确认，不能进入普通保存队列');
  assert.equal(unit.classList.contains('is-pending'),false);assert.match(unit.querySelector('[data-field-status="subject"]')?.textContent||'',/已确认|已保存/);
  assert.doesNotMatch(unit.textContent||'',/等待前一项保存|正在保存/);
 }finally{t.dispose();}
});

it('拒绝剩余建议的提示明确保留已经保存的部分，不宣称整封邮件未改',async()=>{
 const t=mount({proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,url:'http://localhost/index.html?proposal=APROP-1#/mail'});
 try{await settle();await settle();const d=t.doc();(d.querySelector('[data-mail-review-unit="subject"]') as HTMLElement).dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await settle();await settle();
  await t.w.shangshuInlineReviews.get(PROPOSAL.id).rejectRemaining();await settle();await settle();
  assert.equal(t.getMail().subject,'助手候选主题');assert.equal(t.getMail().body,MAIL.body);
  const notice=d.querySelector('#toast-zone')?.textContent||'';assert.match(notice,/剩余建议/);assert.match(notice,/已(?:确认|保存).*保留/);assert.doesNotMatch(notice,/正式邮件未改动|全部零写/);
 }finally{t.dispose();}
});

it('放弃剩余建议之前保存已接受字段的人工新修改，不能一并丢弃',async()=>{
 const t=mount({proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,url:'http://localhost/index.html?proposal=APROP-1#/mail'});
 try{await settle();await settle();const d=t.doc();(d.querySelector('[data-mail-review-unit="subject"]') as HTMLElement).dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await settle();await settle();
  const input=d.querySelector('#c-subject') as HTMLInputElement;input.value='已确认后人工新改主题';input.dispatchEvent(new t.w.Event('input',{bubbles:true}));
  await t.w.shangshuInlineReviews.get(PROPOSAL.id).rejectRemaining();await settle();await settle();
  assert.equal(t.getMail().subject,'已确认后人工新改主题');assert.equal(t.executed.length,1);assert.equal(t.executed[0].payload.body,MAIL.body,'保存正式部分不能夹带尚未确认的正文');assert.equal(t.getMail().body,MAIL.body);assert.equal(t.resolved[0].decision,'rejected');
 }finally{t.dispose();}
});

it('一次点击放弃剩余会等待已触发的失焦保存，双击不会重复拒绝；保存冲突或未知则保留',async()=>{
 for(const saveError of [0,409,503]){
  const t=mount({proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,saveDelay:80,saveError,url:'http://localhost/index.html?proposal=APROP-1#/mail'});
  try{await settle();await settle();const d=t.doc();(d.querySelector('[data-mail-review-unit="subject"]') as HTMLElement).dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await settle();await settle();
   const input=d.querySelector('#c-subject') as HTMLInputElement;input.focus();input.value='失焦保存中的人工主题';input.dispatchEvent(new t.w.Event('input',{bubbles:true}));
   // 原聊天拒绝与已启动的字段失焦保存竞合；重复调用不得重复拒绝。
   input.dispatchEvent(new t.w.FocusEvent('focusout',{bubbles:true}));
   const controller=t.w.shangshuInlineReviews.get(PROPOSAL.id);
   const first=controller.rejectRemaining().catch(()=>null),second=controller.rejectRemaining().catch(()=>null);
   assert.equal(t.resolved.length,0,'失焦保存未返回前不能先拒绝');await Promise.all([first,second]);await new Promise(resolve=>setTimeout(resolve,260));
   if(!saveError){assert.equal(t.resolved.length,1,'同一次点击应在保存成功后继续拒绝，不能再点第二次');assert.equal(t.getMail().subject,'失焦保存中的人工主题');assert.equal(t.getMail().body,MAIL.body);assert.equal(t.executed.length,1);}
   else{assert.equal(t.resolved.length,0,'保存冲突或结果未知不能放弃候选');assert.equal(input.value,'失焦保存中的人工主题');assert.ok(input.isConnected);assert.ok(d.querySelector('[data-mail-review-unit="body"].is-pending'));assert.equal(t.executed.length,1,'失败的保存不得在拒绝流程里暗中自动重试');}
  }finally{t.dispose();}
 }
});

it('全部确认关闭后公共定位打开下一候选，不受URL旧提案或上次等待状态阻断',async()=>{
 const next={...PROPOSAL,id:'APROP-2',payload:{...PROPOSAL.payload,subject:'下一候选主题'}};
 const nextReview={...INLINE_REVIEW,id:next.id,units:[{...INLINE_REVIEW.units[0],value:'下一候选主题'}],remaining:1,accepted_count:0};
 const proposals=[PROPOSAL,next],t=mount({proposals,inlineReview:INLINE_REVIEW,reviews:{[PROPOSAL.id]:INLINE_REVIEW,[next.id]:nextReview},acceptDelay:60,url:'http://localhost/index.html?proposal=APROP-1#/mail'});
 try{await settle();await settle();const d=t.doc(),confirmed=t.w.shangshuInlineReviews.get(PROPOSAL.id).acceptRemaining();
  (d.querySelector('#c-subject') as HTMLInputElement).dispatchEvent(new t.w.FocusEvent('focusout',{bubbles:true}));await confirmed;await settle();
  (d.querySelector('#dlg-close') as HTMLButtonElement).click();assert.equal(d.querySelector('#c-subject'),null);assert.equal(t.w.shangshuInlineReviews.has(PROPOSAL.id),false);
  proposals.splice(0,1);const before=t.calls.length;assert.equal(reviewBtn(t),null);t.w.dispatchEvent(new t.w.CustomEvent('shangshu:review-focus',{detail:{module:'mail',proposal_id:next.id}}));await settle();await settle();
  assert.equal((d.querySelector('#c-subject') as HTMLInputElement)?.value,'下一候选主题');assert.equal(t.w.shangshuInlineReviews.has(next.id),true);
  assert.ok(t.calls.slice(before).some(call=>call.url.endsWith('/APROP-2/review')));assert.ok(!t.calls.slice(before).some(call=>call.url.endsWith('/APROP-1/review')),'顶部入口不能复用地址栏已经完成的proposal');
 }finally{t.dispose();}
});

it('已有和新建候选无草稿编辑权时显示持续原因且零确认，不能因manage权打开编辑',async()=>{
 const box={id:'box-personal',kind:'personal',email:'me@qq.com',enabled:true,rights:{read:true,edit_draft:false,send:false,manage:true,signature:false}};
 for(const target of [MAIL.name,null]){const t=mount({proposals:[PROPOSAL],inlineReview:{...INLINE_REVIEW,target:{module:'mail',mail:target}},mailboxes:[box],url:'http://localhost/index.html?proposal=APROP-1#/mail'});
  try{await settle();await settle();assert.equal(t.doc().querySelector('#c-subject'),null);const alert=t.doc().querySelector('#detail [role=alert]');assert.ok(alert,'不能只依靠短暂toast，页面必须留下未打开的原因');assert.match(alert.textContent||'',/草稿编辑权限/);assert.match(alert.textContent||'',/仍保留/);assert.equal(t.accepts.length,0);assert.equal(t.executed.length,0);
  }finally{t.dispose();}
 }
});

it('新草稿具备edit_draft但没有send权仍可审核保存，发送保持禁用',async()=>{
 const box={id:'box-personal',kind:'personal',email:'me@qq.com',enabled:true,rights:{read:true,edit_draft:true,send:false,manage:false,signature:false}};
 const t=mount({proposals:[PROPOSAL],inlineReview:{...INLINE_REVIEW,target:{module:'mail',mail:null}},mailboxes:[box],url:'http://localhost/index.html?proposal=APROP-1#/mail'});
 try{await settle();await settle();assert.ok(t.doc().querySelector('#c-subject'));assert.equal((t.doc().querySelector('#c-send') as HTMLButtonElement).disabled,true);(t.doc().querySelector('[data-mail-review-unit="subject"]') as HTMLElement).dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await settle();await settle();assert.equal(t.accepts.length,1);assert.equal(t.getMail().subject,'助手候选主题');assert.equal(t.getMail().body,'');
 }finally{t.dispose();}
});

// 隔离组件联验：真实聊天renderer + 真实邮件controller；合成API，不是3800/LLM端到端。
function attachRealChatCard(t:any){
 const w=t.w,source=readFileSync(new URL('../../../shangshu-web/js/real-chat.js',import.meta.url),'utf8');
 w.esc=(x:any)=>String(x??'').replace(/[&<>"']/g,(c:string)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 w.money=String;w.chatScrollBottom=()=>{};w.chatUpdateFab=()=>{};w.chatConfirmFollowUp=async()=>{};
 w.api=(path:string,options:any={})=>w.fetch('/'+path,options);
 w.eval(source.slice(source.indexOf('const CHAT_CONFIRM_NAMES'),source.indexOf('/* —— 确认之后')));
 w.shangshuNavigateReview=async()=>true;
 const body=w.document.createElement('section');w.document.body.appendChild(body);
 w.chatBindPendingReviews();w.chatAddConfirmCard(body,PROPOSAL);
 return {card:()=>body.querySelector('[data-confirm-id]'),button:()=>body.querySelector('.cf-btn.ok')};
}
it('隔离联验：真实聊天卡全部确认仅保存邮件剩余项及人工改稿，两端一致',async()=>{
 const t=mount({proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,url:'http://localhost/index.html?proposal=APROP-1#/mail'});
 try{await settle();await settle();const chat=attachRealChatCard(t),d=t.doc();
 const subject=d.querySelector('[data-mail-review-unit="subject"]') as HTMLElement;subject.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await settle();await settle();
 assert.deepEqual(t.accepts[0].units,['subject']);assert.match(chat.card().textContent,/已保存 1 项.*待确认 2 项/);assert.equal(t.getMail().body,MAIL.body);
 const body=d.querySelector('[data-mail-review-unit="body"]') as HTMLElement;body.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true,detail:2}));const editor=body.querySelector('[contenteditable=true]') as HTMLElement;editor.querySelector('p')!.textContent='联验人工改稿';editor.dispatchEvent(new t.w.Event('input',{bubbles:true}));
 assert.equal(chat.button().textContent,'全部确认');await settle();chat.button().click();await settle();await settle();await settle();
 assert.equal(t.accepts.length,2);assert.deepEqual(t.accepts[1].units,['body','to']);assert.match(t.accepts[1].edited_value.body,/联验人工改稿/);assert.match(t.getMail().body,/联验人工改稿/);assert.equal(t.getMail().subject,'助手候选主题');assert.equal(d.querySelectorAll('[data-mail-review-unit].is-pending').length,0);assert.equal(chat.card().classList.contains('resolved'),true);assert.match(chat.card().textContent,/草稿已保存.*未发送/);assert.equal(t.reviewEvents.length,1);assert.equal(t.executed.length,0);
 }finally{t.dispose();}
});
it('BASE967-35 采用助手建议不清本人撤回栈：确认后仍是 1/3 且能撤回', async () => {
  /* 用户实测 UI-050：本人先改正文（1/3），真实 Assistant 提案确认后，
     正文正确但本人撤回变成 0/3 且禁用 —— 要求是「Assistant 采用不清本人撤回栈」。 */
  const t = mount({proposals: [PROPOSAL], inlineReview: INLINE_REVIEW,
                   url: 'http://localhost/index.html?proposal=APROP-1#/mail'});
  try {
    await settle(); await settle();
    const chat = attachRealChatCard(t), d = t.doc();
    const body = d.querySelector('[data-mail-review-unit="body"]') as HTMLElement;
    body.dispatchEvent(new t.w.MouseEvent('dblclick', {bubbles: true, detail: 2}));
    const editor = body.querySelector('[contenteditable=true]') as HTMLElement;
    editor.querySelector('p')!.textContent = '本人先改的正文';
    editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await settle();
    const before = d.querySelector('[data-editor-undo-count]')?.textContent;
    assert.equal(before, '1/3', `前置：本人改一次正文应为 1/3，实际 ${before}`);

    chat.button().click();
    await settle(); await settle(); await settle();

    const after = d.querySelector('[data-editor-undo-count]')?.textContent;
    assert.equal(after, '1/3',
      `采用助手建议不能清掉本人的撤回栈（用户 req 5），实际 ${after}`);
    const undo = d.querySelector('[data-editor-undo]') as HTMLButtonElement;
    assert.equal(undo.disabled, false, '采用后撤回按钮不该被禁用');
    undo.click();
    await settle();
    assert.doesNotMatch(editor.textContent || '', /本人先改的正文/,
      `撤回应撤掉本人那一步，实际正文：${(editor.textContent || '').slice(0, 120)}`);
  } finally { t.dispose(); }
});

/* UI050 根因那半：**审核导航重新 openCompose/mountEditor 丢掉原实例历史** ——
   同一草稿再导航（再点一次待审入口/打开原位）会重挂编辑器，本人撤回栈被清成 0/3。
   用户 req 5：「Assistant 采用不清本人撤回栈」；刷新/关闭才清，导航不是关闭。

   测试通过 = 同草稿再导航后，撤回栈仍是本人的 1/3、按钮可用、撤回仍能撤掉本人那步。 */
it('BASE967-35 审核导航重开同一草稿不清本人撤回栈：再导航后仍 1/3 且能撤回', async () => {
  const t = mount({proposals: [PROPOSAL], inlineReview: INLINE_REVIEW,
                   url: 'http://localhost/index.html?proposal=APROP-1#/mail'});
  try {
    await settle(); await settle();
    const d = t.doc();
    const body = d.querySelector('[data-mail-review-unit="body"]') as HTMLElement;
    body.dispatchEvent(new t.w.MouseEvent('dblclick', {bubbles: true, detail: 2}));
    const editor = body.querySelector('[contenteditable=true]') as HTMLElement;
    editor.querySelector('p')!.textContent = '本人先改的正文';
    editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await settle();
    assert.equal(d.querySelector('[data-editor-undo-count]')?.textContent, '1/3', '前置：本人改一次应为 1/3');

    /* 审核导航再来一次（同草稿同提案）—— openReviewDialog 会重新 openCompose */
    t.w.dispatchEvent(new t.w.CustomEvent('shangshu:review-focus', {
      detail: {module: 'mail', mail: MAIL.name, proposal_id: PROPOSAL.id}}));
    await settle(); await settle(); await settle(); await settle();

    const count = d.querySelector('[data-editor-undo-count]')?.textContent;
    assert.equal(count, '1/3',
      `同草稿审核导航不是关闭/刷新，不许清本人撤回栈（UI050 根因），实际 ${count}`);
    const undo = d.querySelector('[data-editor-undo]') as HTMLButtonElement;
    assert.equal(undo.disabled, false, '再导航后撤回按钮该仍可用');
    const editor2 = d.querySelector('[data-mail-review-unit="body"] [contenteditable=true]') as HTMLElement;
    editor2.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    undo.click();
    await settle();
    assert.doesNotMatch(editor2.textContent || '', /本人先改的正文/,
      `撤回仍应能撤掉本人那一步，实际正文：${(editor2.textContent || '').slice(0, 120)}`);
  } finally { t.dispose(); }
});

/* UI050 的完整序列：**先在普通写信里改正文（1/3），再进审核导航打开助手提案** ——
   openReviewDialog 会重新 openCompose/mountEditor，原实例历史被丢（0/3 且撤回禁用）。
   「刷新/关闭才清栈」是用户拍板口径；进审核导航不是关闭。

   测试通过 = 进审核导航后仍是本人的 1/3、按钮可用、撤回仍能撤掉本人那步。 */
it('BASE967-35 UI050 序列：普通写信改正文后进审核导航，本人撤回栈不清', async () => {
  const t = mount({proposals: [PROPOSAL], inlineReview: INLINE_REVIEW,
                   url: 'http://localhost/index.html?mail=mail-1#/mail'});
  try {
    await settle(); await settle(); await settle();
    const d = t.doc();
    for (let i = 0; i < 30; i++) {
      if (d.querySelector('.mail-body-editor')) break;
      await tick();
    }
    const editor = d.querySelector('.mail-body-editor') as HTMLElement;
    assert.ok(editor, '深链该直接打开草稿写信窗');
    editor.innerHTML = '<p>本人先改的正文</p>';
    editor.dispatchEvent(new t.w.Event('input', {bubbles: true}));
    await settle();
    assert.equal(d.querySelector('[data-editor-undo-count]')?.textContent, '1/3', '前置：本人改一次应为 1/3');
    /* UI050 原文是「本人正文修改**保存后** 1/3」—— 保存后 canLeave 放行，
       导航才会真走 openReviewDialog 重开写信窗（未保存时导航会被挡住，测不到根因）。 */
    (d.querySelector('#c-save') as HTMLButtonElement).click();
    await settle(); await settle();

    /* 进审核导航（助手提案）—— openReviewDialog 重新 openCompose */
    t.w.dispatchEvent(new t.w.CustomEvent('shangshu:review-focus', {
      detail: {module: 'mail', mail: MAIL.name, proposal_id: PROPOSAL.id}}));
    await settle(); await settle(); await settle(); await settle();

    const count = d.querySelector('[data-editor-undo-count]')?.textContent;
    assert.equal(count, '1/3',
      `进审核导航不许清本人撤回栈（UI050 根因：重新 openCompose/mountEditor 丢历史），实际 ${count}`);
    const undo = d.querySelector('[data-editor-undo]') as HTMLButtonElement;
    assert.ok(undo, '导航后该还有撤回按钮');
    assert.equal(undo.disabled, false, '导航后撤回按钮该仍可用');
  } finally { t.dispose(); }
});

it('隔离联验：聊天卡全部确认失败，邮件人工输入和剩余项、卡片均保留',async()=>{
 const opts={proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,acceptError:503,url:'http://localhost/index.html?proposal=APROP-1#/mail'};const t=mount(opts);
 try{await settle();await settle();const chat=attachRealChatCard(t),d=t.doc(),body=d.querySelector('[data-mail-review-unit="body"]') as HTMLElement;body.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true,detail:2}));const editor=body.querySelector('[contenteditable=true]') as HTMLElement;editor.querySelector('p')!.textContent='失败仍保留的人工改稿';editor.dispatchEvent(new t.w.Event('input',{bubbles:true}));await settle();chat.button().click();await settle();await settle();await settle();
 assert.equal(t.accepts.length,1);assert.equal(t.getMail().body,MAIL.body);assert.equal(d.querySelectorAll('[data-mail-review-unit].is-pending').length,3);assert.match(editor.textContent||'',/失败仍保留的人工改稿/);assert.equal(chat.card().classList.contains('resolved'),false);assert.equal(chat.button().disabled,false);assert.equal(t.reviewEvents.length,0);assert.equal(t.executed.length,0);
 }finally{t.dispose();}
});

it('原位确认外来ID、未知状态、缺失ID均不得清原卡或输入',async()=>{
 for(const acceptShape of ['foreign','unknown','missing-id']){const t=await openPublicReview({acceptShape});try{t.chat.button().click();await settle();await settle();assert.equal(t.reviewEvents.length,0);assert.equal(t.chat.card().classList.contains('resolved'),false);assert.ok(t.doc().querySelector('[data-mail-review-unit="body"].is-pending'));}finally{t.dispose();}}
});
it('explicit can_accept false blocks mail inline editing and confirmation',async()=>{
 const t=await openPublicReview({inlineReview:{...INLINE_REVIEW,can_accept:false,accept_unavailable_reason:'无修改权限'}});try{const unit=t.doc().querySelector('[data-mail-review-unit="body"]') as HTMLElement;unit.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true}));unit.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await settle();assert.equal(unit.getAttribute('aria-disabled'),'true');assert.equal(unit.classList.contains('is-editing'),false);assert.equal(await t.w.shangshuInlineReviews.get(PROPOSAL.id).acceptRemaining(),null);assert.equal(t.accepts.length,0);assert.match(unit.title,/无修改权限/);}finally{t.dispose();}
});

it('邮件审核不创建整条建议横条，恢复状态保留在字段内且原聊天可调用拒绝',async()=>{const t=mount({proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,url:'http://localhost/index.html?proposal=APROP-1#/mail'});try{await settle();await settle();assert.equal(t.doc().querySelector('.mail-inline-review-bar'),null);assert.equal(t.doc().querySelector('[data-review-reject]'),null);assert.ok(t.doc().querySelector('.dlg-field .mail-inline-review-status'));assert.equal(typeof t.w.shangshuInlineReviews.get(PROPOSAL.id).rejectRemaining,'function');}finally{t.dispose();}});

it('真实原聊天拒绝经邮件controller保存人工正式字段；保存失败不绕过也不终结卡',async()=>{
 for(const saveError of [0,409,500]){
  const t=mount({proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,saveError,url:'http://localhost/index.html?proposal=APROP-1#/mail'});
  try{await settle();await settle();const d=t.doc();
   (d.querySelector('[data-mail-review-unit="subject"]') as HTMLElement).dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await settle();await settle();
   const input=d.querySelector('#c-subject') as HTMLInputElement;input.value='聊天放弃前的人工作品';input.dispatchEvent(new t.w.Event('input',{bubbles:true}));
   const controller=t.w.shangshuInlineReviews.get(PROPOSAL.id),reject=controller.rejectRemaining;let delegated=0;controller.rejectRemaining=async()=>{delegated++;return reject();};
   const chat=attachRealChatCard(t);await settle();(chat.card().querySelector('.cf-btn.no') as HTMLButtonElement).click();await settle();await settle();await settle();
   assert.equal(delegated,1);assert.equal(t.executed.length,1);assert.equal(t.getMail().body,MAIL.body);
   if(!saveError){assert.equal(t.resolved.length,1);assert.equal(t.getMail().subject,'聊天放弃前的人工作品');assert.equal(chat.card().classList.contains('resolved'),true);assert.match(chat.card().textContent,/已保存.*保留/);assert.doesNotMatch(chat.card().textContent,/未执行/);}
   else{assert.equal(t.resolved.length,0);assert.equal(chat.card().classList.contains('resolved'),false);assert.equal(input.value,'聊天放弃前的人工作品');assert.ok(input.isConnected);assert.ok(d.querySelector('[data-mail-review-unit="body"].is-pending'));}
  }finally{t.dispose();}
 }
});


it('旧C-line仍有效的业务拒绝边界：HTTP200 ok:false保留人工候选且不能报成功',async()=>{
 const opts={acceptBusinessError:true};const t=await openPublicReview(opts);try{
  const body=t.doc().querySelector('[data-mail-review-unit="body"]') as HTMLElement;
  body.dispatchEvent(new t.w.MouseEvent('dblclick',{bubbles:true,detail:2}));
  const editor=body.querySelector('[contenteditable=true]') as HTMLElement;editor.querySelector('p')!.textContent='业务拒绝后保留的人改稿';editor.dispatchEvent(new t.w.Event('input',{bubbles:true}));
  const controller=t.w.shangshuInlineReviews.get(PROPOSAL.id);assert.equal(await controller.acceptRemaining(),null);await settle();
  assert.equal(t.getMail().body,MAIL.body);assert.equal(t.reviewEvents.length,0);assert.ok(body.classList.contains('is-pending'));assert.match(editor.textContent||'',/业务拒绝后保留的人改稿/);
  assert.match(t.doc().querySelector('.mail-inline-review-status')?.textContent||'',/body/);assert.equal(t.calls.filter(c=>c.url.includes('/api/confirmations')).length,0);
 }finally{t.dispose();}
});

/*
 FIX-07 判据（用户 A24 原话「采用建议后人工编辑/撤销失败」）：
 **采用助手写的正文后，编辑器里就是刚采用的内容**，而且这一步**不占本人的三步**。

 现状（查实，3870 试用站同一份代码）：
 采用正文建议后，产品只把内容写进**隐藏 textarea `#c-body`**（存草稿读它），
 **没有写进可见的正文编辑器**。于是：
 ① 屏幕上还是旧正文，用户看不到自己刚采用的内容；
 ② 用户在编辑器里改一个字 → 编辑器的 onChange 把旧正文盖回 `#c-body`
    → 刚采用的内容**被静默丢掉**（这就是「采用建议后人工编辑失败」）；
 ③ 助手的这一步没进编辑器的撤回栈，段归属也不算助手的 ——
    「不同段保留已采用内容、同段冲突不静默覆盖」这条口径就落不了地。

 测试通过 = 下面全部成立：
 · 采用正文建议后，**可见编辑器**里就是刚采用的内容（不是旧正文）；
 · 这一步**不占本人的三步**（撤回计数仍是 0/3）；
 · 采用之后用户再人工编辑，**刚采用的内容仍在**（不会被旧正文盖回去）。
*/
it('FIX-07：采用助手正文建议后，编辑器里就是刚采用的内容，且不占本人的三步',async()=>{
 const t=mount({proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,url:'http://localhost/index.html?proposal=APROP-1#/mail'});
 try{await settle();await settle();
  const d=t.doc();
  const unit=d.querySelector('[data-mail-review-unit="body"]') as HTMLElement;
  assert.ok(unit,'写信页要有正文建议项');
  (unit.querySelector('[data-review-accept-unit]') as HTMLButtonElement).click();
  await settle();await settle();await settle();
  assert.equal(t.accepts.length,1,'正文建议应被采用一次');
  assert.match(t.getMail().body,/建议正文/,'服务端存的是助手建议那份');
  const editor=d.querySelector('#c-editor [contenteditable=true], #c-editor') as HTMLElement;
  assert.ok(editor,'写信页要有可见的正文编辑器');
  assert.match(editor.textContent||'',/建议正文/,'采用后可见编辑器里必须是刚采用的内容（只写隐藏字段 = 用户看到旧正文）');
  assert.doesNotMatch(editor.textContent||'',/原正文/,'可见编辑器不能还停在旧正文');
  const counter=d.querySelector('[data-editor-undo-count]') as HTMLElement;
  assert.match(counter?.textContent||'',/^0\/3$/,'采用助手建议不占本人的三步撤回预算');
 }finally{t.dispose();}
});

it('FIX-07：采用建议后人工再编辑，刚采用的内容不丢',async()=>{
 const t=mount({proposals:[PROPOSAL],inlineReview:INLINE_REVIEW,url:'http://localhost/index.html?proposal=APROP-1#/mail'});
 try{await settle();await settle();
  const d=t.doc();
  const unit=d.querySelector('[data-mail-review-unit="body"]') as HTMLElement;
  (unit.querySelector('[data-review-accept-unit]') as HTMLButtonElement).click();
  await settle();await settle();await settle();
  const editor=d.querySelector('#c-editor [contenteditable=true], #c-editor') as HTMLElement;
  assert.ok(editor);
  /* 人工在编辑器里接着改（模拟用户打字后的 input） */
  editor.innerHTML=(editor.innerHTML||'')+'<p>本人补的一句</p>';
  editor.dispatchEvent(new t.w.Event('input',{bubbles:true}));
  await settle();
  assert.match(editor.textContent||'',/建议正文/,'人工编辑后刚采用的内容仍在');
  assert.match(editor.textContent||'',/本人补的一句/,'人工补的内容也在');
  assert.match((d.querySelector('#c-body') as HTMLTextAreaElement).value,/建议正文/,'存草稿读的那份也得是刚采用的内容');
  assert.match((d.querySelector('#c-body') as HTMLTextAreaElement).value,/本人补的一句/,'人工补的内容也要进存草稿的那份');
 }finally{t.dispose();}
});

/*
 FIX-07 判据（用户 A24 原话「采用邮件建议后，自己改另一段并撤销」——用户勾的是「错误」）：
 采用助手写的正文后，本人改**另一段**再撤销，**已采用的助手段落必须留着**。

 现状（查实）：采用建议时，产品把助手正文渲染成编辑面里的「原位候选」，
 但**没有把这一步记进编辑器的撤回栈**（编辑器只认自己挂载时的初值）。
 于是本人改一段再撤销时，编辑器回到的是**挂载时的初值**（旧正文）——
 刚采用的助手段落被一起撤掉了，这正是 A24 说的「保留已采用的Assistant段落」没做到。

 测试通过 = 采用建议 → 本人改另一段 → 撤销：
 ① 本人那一步被撤掉（回到本人改之前）；
 ② **已采用的助手段落仍然在**（不许跟着被撤成旧正文）；
 ③ 撤回计数回到 0/3（助手那一步本来就不占本人的预算）。
*/
const A24_ORIGINAL='<p>原正文第一段</p><p>原正文第二段</p>';
const A24_CANDIDATE='<p>助手第一段</p><p>助手第二段</p>';
it('FIX-07：采用建议后本人改另一段并撤销，已采用的助手段落仍保留',async()=>{
 const review={...INLINE_REVIEW,units:[
   {...INLINE_REVIEW.units[0]},
   {...INLINE_REVIEW.units[1],value:A24_CANDIDATE,current_value:A24_ORIGINAL},
   {...INLINE_REVIEW.units[2]}]};
 const t=mount({proposals:[PROPOSAL],inlineReview:review,url:'http://localhost/index.html?proposal=APROP-1#/mail'});
 try{await settle();await settle();
  const d=t.doc();
  const unit=d.querySelector('[data-mail-review-unit="body"]') as HTMLElement;
  (unit.querySelector('[data-review-accept-unit]') as HTMLButtonElement).click();
  await settle();await settle();await settle();
  const editor=d.querySelector('#c-editor [contenteditable=true], #c-editor') as HTMLElement;
  assert.ok(editor);
  assert.match(editor.textContent||'',/助手第一段/,'采用后编辑面里有助手的段落');
  /* 本人改「另一段」 */
  const paragraphs=editor.querySelectorAll('p');
  assert.ok(paragraphs.length>=2,'候选正文应有两段，才能测「改另一段」');
  paragraphs[1].textContent='本人改的第二段';
  editor.dispatchEvent(new t.w.Event('input',{bubbles:true}));
  await settle();
  const counter=d.querySelector('[data-editor-undo-count]') as HTMLElement;
  assert.match(counter?.textContent||'',/^1\/3$/,'本人这一步算一步');
  /* 撤销本人那一步 */
  const undo=d.querySelector('[data-editor-undo]') as HTMLButtonElement;
  assert.ok(undo,'编辑器要有可见的撤回按钮');
  undo.click();
  await settle();
  assert.match(editor.textContent||'',/助手第二段/,'撤本人那一步后，助手的段落必须留着');
  assert.doesNotMatch(editor.textContent||'',/原正文第一段/,'撤本人那一步不许把刚采用的助手段落撤成旧正文');
 }finally{t.dispose();}
});
