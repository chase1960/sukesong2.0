// BASE967-32（R967-D01）：全局「待审核」按钮/独立目录已移除（用户 2026-10-16 现场纠偏）。
// 确认/修订/拒绝、未知结果恢复保留在原对话和目标原位；原目录的安全断言
// （权限/幂等/不泄漏/不自动执行/失败保留）迁移到新交互，一条不删。
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const source=readFileSync(new URL('../../../shangshu-web/js/real-chat.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
// ⚠️ 2026-10-24 12:5x（PKG-085）：顶层 let/const 在 eval 里只活在**这一次 eval** 的词法作用域里
//   （跨切片互相看不见）⇒ 改成 var 挂到 window 上，各切片才能共用同一份状态。
const slice=(from:string,to:string)=>{
  const a=source.indexOf(from),b=source.indexOf(to,a);
  if(a<0||b<=a)throw Error(`源码切片定位失败：${from} → ${to}`);
  return source.slice(a,b).replace(/^(let|const)\s+/gm,'var ');
};
function mount(read:any){
  const dom=new JSDOM('<button id="ai-fab"></button><div id="ai-copilot"></div>',{runScripts:'outside-only',url:'http://localhost/index.html#/dash'}),w=dom.window as any,requests:any[]=[];
  w.$=(selector:string)=>w.document.querySelector(selector);w.$$=(selector:string,host:any=w.document)=>[...host.querySelectorAll(selector)];
  w.ic=()=>'';w.CHAT_ICONS={};w.ICONS={spark:''};w.chatHistoryReady=null;w.chatMode='hidden';w.chatLastMode='float';w.chatRunning=false;w.chatRunNotice='';
  w.chatModeButton=()=>'';w.currentRole=()=> 'employee';w.currentUserInfo={username:'u1'};
  w.esc=(value:any)=>String(value??'').replace(/[&<>"']/g,(x:string)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
  w.chatScrollBottom=()=>{};w.chatUpdateContextBar=()=>{};w.chatEnsureMounted=()=>true;w.toast=()=>{};w.curMod='dash';w.RENDER={dash:true};w.go=async()=>true;
  w.api=async(path:string,options:any)=>{requests.push({path,options});return typeof read==='function'?read(path,options):{ok:true,json:async()=>read};};
  w.eval(source.slice(source.indexOf('function chatHeaderHtml'),source.indexOf('/* —— 会话模型')));
  // ⚠️ 2026-10-24 12:5x（PKG-085）：产品 2026-10-22（`c83556c2a`）把「引擎 ＋ 模型」**合成一个栏**，
  // `chatMarkup()` 里多了 `${chatEnginePickerMarkup()}`；它读模块级 `chatEngine`／`chatEngines`，
  // `chatModelName()` 又读 `chatModelState` —— 这三样**原来都不在判据切片里**
  // ⇒ `ReferenceError: chatEnginePickerMarkup is not defined` ⇒ 5 条用例一起炸
  // ⇒ 把它们的**真实声明**切进来（切真实代码，不另造桩）。
  w.eval(slice('let chatEngine =','async function chatLoadEngines'));                                          // chatEngine/chatEngines
  w.eval(slice('/* —— harness（对话引擎）＋ 模型','/* —— 风琴'));                                             // chatEnginePickerMarkup/chatModelName
  w.eval(slice('/* —— 模型选择（**并进引擎栏的第二层**','/* —— 工具卡'));                                     // chatModelState/chatModelSources
  w.document.querySelector('#ai-copilot').innerHTML=w.chatMarkup();w.chatEl=w.document.querySelector('#chat');
  w.eval(source.slice(source.indexOf('function chatUpdateFab'),source.indexOf('/* —— 终止对话'))+
    source.slice(source.indexOf('const CHAT_CONFIRM_NAMES'),source.indexOf('/* —— 确认之后'))+
    source.slice(source.indexOf('function chatSetMode'),source.indexOf('function chatToggle()')));
  w.chatBindPendingReviews();
  return {w,requests,close:()=>dom.window.close()};
}
const proposal=(i:number)=>({id:'p'+i,status:'proposed',capability:'files.sheet_cells_write',created_via:i%3===0?'ai-chat':i%3===1?'code':'',payload:{table:'t'+i,secret:'never-on-fab'}});

it('全局待审核入口不存在：测试通过 = 无独立按钮/目录，角标计数不泄候选值，找回走原对话',async()=>{
  const t=mount({ok:true,list:Array.from({length:200},(_,i)=>proposal(i))});
  try{
    t.w.chatSetMode('float');await tick();
    assert.equal(t.w.document.querySelector('#chat-review-btn'),null,'独立待审按钮必须移除');
    assert.equal(t.w.document.querySelector('#chat-review-panel'),null,'独立待审目录必须移除');
    assert.equal(typeof t.w.chatTogglePendingReviews,'undefined','目录开关不复存在');
    // 角标保留计数但不放来源提示点、不放任何候选值（原「never-on-fab」断言）
    assert.equal(t.w.document.querySelector('#ai-fab').dataset.pendingReviews,'200');
    assert.doesNotMatch(t.w.document.querySelector('#ai-fab').outerHTML,/never-on-fab|t199|secret/);
    assert.equal(t.w.document.querySelector('#ai-fab').querySelector('.review-source-dot'),null,'入口不再放来源提示点');
    assert.equal(t.w.chatEl.querySelector('[data-confirm-id]'),null,'角标加载不自动往对话里塞卡');
    assert.ok(t.requests.every((r:any)=>!r.options?.method||r.options.method==='GET'));
  }finally{t.close();}
});

it('恢复待审复用原聊天卡：测试通过 = 同一真实提案定位、未知来源中性、不写确认、重复打开不复制卡',async()=>{
  const p={...proposal(2),id:'id<&',capability:'files.sheet_cells_write',payload:{table:'table &1',source:'ai-chat'},created_via:''};
  const t=mount((path:string,options:any)=>({ok:true,status:200,json:async()=>options?.method==='POST'?{id:p.id,status:'rejected',remaining:0,accepted_count:1}:{ok:true,list:[p]}}));
  try{
    const modes:string[]=[];const focus:any[]=[];t.w.chatSetMode=(mode:string)=>modes.push(mode);
    t.w.addEventListener('shangshu:review-focus',(e:any)=>focus.push(e.detail));
    assert.equal(await t.w.shangshuOpenReviewCard(p),true);
    const cards=t.w.chatEl.querySelectorAll('[data-confirm-id="id<&"]');assert.equal(cards.length,1,'重复打开不复制卡');
    const card=cards[0] as any;
    assert.equal(card.dataset.reviewSource,'unknown','payload.source 不冒充，缺失来源中性');
    assert.match(card.textContent,/来源未确认/);
    assert.equal(card.querySelector('script'),null);
    assert.match(t.w.chatEl.textContent,/恢复的待确认操作/);
    const url=new URL(t.w.location.href);
    assert.equal(url.hash,'#/excel');assert.equal(url.searchParams.get('proposal'),'id<&');assert.equal(url.searchParams.get('object'),'table &1');
    assert.equal(focus[0].table,'table &1');
    await t.w.shangshuOpenReviewCard(p,{navigate:false});
    assert.equal(t.w.chatEl.querySelectorAll('[data-confirm-id="id<&"]').length,1,'重复打开不复制卡');
    assert.ok(t.requests.every((r:any)=>(!r.options?.method||r.options.method==='GET')),'定位/恢复不发确认写');
  }finally{t.close();}
});

it('失效目标只给放弃：测试通过 = 无定位/确认按钮，放弃只发一次 decision=rejected，不读不存在的目标',async()=>{
  const orphan={...proposal(4),id:'missing-mail',capability:'mail.save_draft',payload:{mail:'not-a-mail'},review_access:'reject_only',review_blocked_reason:'目标记录已不存在，仅可放弃剩余建议；已保存内容保留。'};
  const writes:any[]=[];
  const t=mount((path:string,options:any)=>{
    if(options?.method==='POST'){writes.push(JSON.parse(options.body));return {ok:true,status:200,json:async()=>({id:orphan.id,status:'rejected',remaining:0,accepted_count:1})};}
    return {ok:true,status:200,json:async()=>({ok:true,list:[orphan]})};
  });
  try{
    const card=t.w.chatAddConfirmCard(t.w.chatEl,orphan) as any;
    assert.match(card.textContent,/不存在.*放弃剩余/);
    assert.equal(card.querySelector('[data-review-open],.cf-btn.ok'),null,'失效目标不给定位与确认');
    const reject=card.querySelector('.cf-btn.no');assert.ok(reject,'失效候选必须有正常的放弃入口');
    (reject as any).click();(reject as any).click();await tick();await tick();
    assert.equal(writes.length,1,'重复点击只发一次');
    assert.deepEqual(writes[0],{decision:'rejected'});
    assert.ok(t.requests.every((r:any)=>!String(r.path).endsWith('/review')),'放弃无需读取不存在的目标');
  }finally{t.close();}
});

it('放弃失败/错回执保留卡片与可见重试，不发确认：测试通过 = 卡片在、按钮恢复、状态可见',async()=>{
  for(const outcome of [{ok:false,status:403,body:{ok:false,error:'当前无权放弃'}},{ok:false,status:503,body:{ok:false,error:'服务暂不可用'}},{ok:true,status:200,body:{id:'foreign',status:'rejected'}}]){
    const writes:any[]=[];
    const p={...proposal(1),capability:'mail.send',review_access:'reject_only'};
    const t=mount((path:string,options:any)=>options?.method==='POST'?(writes.push(JSON.parse(options.body)),{ok:outcome.ok,status:outcome.status,json:async()=>outcome.body}):{ok:true,json:async()=>({ok:true,list:[p]})});
    try{
      const card=t.w.chatAddConfirmCard(t.w.chatEl,p) as any;
      const reject=card.querySelector('.cf-btn.no');assert.ok(reject);(reject as any).click();await tick();await tick();
      assert.ok(t.w.chatEl.querySelector('[data-confirm-id]'),'失败不移除卡片');
      assert.equal((reject as any).disabled,false,'失败后可重试');
      assert.match(card.textContent,/无权|不可用|回执|未知|未能/);
      assert.equal(writes.length,1);assert.deepEqual(writes[0],{decision:'rejected'});
      assert.doesNotMatch(card.textContent,/已确认|已执行|已发送/,'不发确认不假称成功');
    }finally{t.close();}
  }
});

it('恢复待审定位前退出全屏：测试通过 = 恢复卡在对话内，定位切分栏',async()=>{
  const t=mount({ok:true,list:[proposal(2)]});
  try{
    const modes:string[]=[];t.w.chatSetMode=(mode:string)=>modes.push(mode);
    let release:any;t.w.go=()=>new Promise(r=>release=r);
    const opening=t.w.shangshuOpenReviewCard(proposal(2));
    assert.equal(modes.at(-1),'split','定位前退出全屏到分栏');
    assert.equal(t.w.chatEl.querySelectorAll('[data-confirm-id="p2"]').length,1);
    assert.ok(t.w.chatEl.querySelector('.cf-btn.ok'),'仍待审的可继续确认（原对话内）');
    release(true);await opening;
  }finally{t.close();}
});
