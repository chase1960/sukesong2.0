import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const source=readFileSync(new URL('../../../shangshu-web/js/real-chat.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,15));
// 条件等待：语义是「最终必须发生」时就等到它发生，不拿固定 15ms 赌时序（并发满核时 tick 先于 1ms 内层定时器）。
const waitFor=async(predicate:()=>boolean,timeoutMs=3000,label='条件')=>{const start=Date.now();while(!predicate()){if(Date.now()-start>timeoutMs)throw new Error('waitFor 超时：'+label+' 未在 '+timeoutMs+'ms 内满足');await new Promise(resolve=>setTimeout(resolve,5));}};
function mount(options:any={}) {
  const dom=new JSDOM('<div id="body"></div>',{runScripts:'outside-only',url:'http://localhost/index.html#/dash'}),w=dom.window as any,requests:any[]=[];
  w.esc=(x:any)=>String(x??'').replace(/[&<>"']/g,(c:string)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  w.money=String;w.toast=()=>{};w.chatScrollBottom=()=>{};w.chatUpdateFab=()=>{};w.chatConfirmFollowUp=async()=>{};
  w.shangshuConfirmationPresenters={'mail.save_draft':{prepare:async()=>{throw Error('stale legacy version must not block partial review');}}};
  const descriptor={id:'p1',status:'proposed',can_accept:true,can_reject:true,remaining:2,accepted_count:1,units:[{unit_id:'subject',label:'主题',status:'pending',value:'候选主题'},{unit_id:'body',label:'正文',status:'pending',value:'候选正文'}],...options.descriptor};
  w.api=async(path:string,request:any)=>{requests.push({path,request});
    // BASE46/44：②b units range 按 offset/limit 回窗口摘要；其余回整包 descriptor（③带可用性头字段）
    if(String(path).includes('/units')){
      const u=new URL(String(path),'http://x');const off=Number(u.searchParams.get('offset')||0);const lim=Number(u.searchParams.get('limit')||20);
      const pending=(descriptor.units||[]).filter((x:any)=>String(x.status||'pending').toLowerCase()==='pending');
      return {ok:true,json:async()=>({ok:true,proposal:descriptor.id,total:pending.length,offset:off,limit:lim,items:pending.slice(off,off+lim)})};
    }
    return {ok:true,json:async()=>descriptor};};
  w.eval(source.slice(source.indexOf('const CHAT_CONFIRM_NAMES'),source.indexOf('/* —— 确认之后')));
  w.shangshuInlineReviews=new w.Map();w.shangshuNavigateReview=options.navigate||(async()=>true);
  if(options.controller)w.shangshuInlineReviews.set('p1',options.controller);
  const proposal={id:'p1',capability:'mail.save_draft',created_via:'ai-chat',payload:{subject:'candidate',body:'candidate body'},...options.proposal};
  options.setup?.(w);
  w.chatBindPendingReviews();w.chatAddConfirmCard(w.document.querySelector('#body'),proposal,{navigate:!!options.autoNavigate,...(options.header?{header:options.header}:{})});
  return {w,requests,button:()=>w.document.querySelector('.cf-btn.ok'),card:()=>w.document.querySelector('[data-confirm-id]'),close:()=>dom.window.close()};
}
it('chat all delegates pending human edits to the page controller and never runs a fresh write or stale presenter',async()=>{
  let calls=0;const t=mount({controller:{id:'p1',acceptRemaining:async()=>{calls++;return {id:'p1',status:'confirmed',remaining:0};}}});
  try{assert.equal(t.button().textContent,'全部确认');await waitFor(()=>!t.button().disabled,3000,'可用性核对完成、确认可用');t.button().click();await waitFor(()=>calls===1&&t.card().classList.contains('resolved'),3000,'页面控制器被调用一次且卡片落定');assert.equal(calls,1);assert.equal(t.card().classList.contains('resolved'),true);assert.match(t.card().textContent,/草稿已保存.*未发送/);assert.ok(t.requests.every(r=>!r.request.method||r.request.method==='GET'));}
  finally{t.close();}
});
it('a failed or unknown page confirmation keeps the original card and inputs available for retry',async()=>{
  for(const result of [null,{id:'other',status:'confirmed',remaining:0},{id:'p1',status:'unknown',remaining:0},{id:'p1',status:'proposed',remaining:1}]){
    const t=mount({controller:{id:'p1',acceptRemaining:async()=>result}});
    try{await waitFor(()=>!t.button().disabled,3000,'可用性核对完成、确认可用');t.button().click();await waitFor(()=>/保留/.test(t.card().textContent),3000,'失败/未知回执后保留原卡');assert.equal(t.card().classList.contains('resolved'),false);assert.equal(t.button().disabled,false);assert.match(t.card().textContent,/保留/);assert.ok(t.requests.every(r=>(!r.request?.method||r.request.method==='GET')&&/(\/review|action-proposal-get|\/units)/.test(r.path)),'只读核对，不写入');}finally{t.close();}
  }
});
it('navigation waits for the matching review controller; an unrelated ready event cannot approve anything',async()=>{
  let calls=0;const t=mount({setup:(w:any)=>{w.shangshuNavigateReview=async()=>{
    w.dispatchEvent(new w.CustomEvent('shangshu:review-ready',{detail:{proposal_id:'other'}}));
    setTimeout(()=>{w.shangshuInlineReviews.set('p1',{id:'p1',acceptRemaining:async()=>{calls++;return {id:'p1',status:'confirmed',remaining:0};}});w.dispatchEvent(new w.CustomEvent('shangshu:review-ready',{detail:{proposal_id:'p1'}}));},1);return true;
  };}});
  try{await waitFor(()=>!t.button().disabled,3000,'可用性核对完成、确认可用');t.button().click();await waitFor(()=>calls===1&&t.card().classList.contains('resolved'),3000,'等匹配控制器就绪后仍只调用一次且卡片落定');assert.equal(calls,1);assert.equal(t.card().classList.contains('resolved'),true);}finally{t.close();}
});
it('a current-page leave guard blocks chat all without any save or approval',async()=>{
  const t=mount({navigate:async()=>false});
  try{await waitFor(()=>!t.button().disabled,3000,'可用性核对完成、确认可用');t.button().click();await waitFor(()=>/尚未保存/.test(t.card().textContent),3000,'离开守卫拦下并提示未保存');assert.equal(t.card().classList.contains('resolved'),false);assert.equal(t.button().disabled,false);assert.match(t.card().textContent,/尚未保存/);assert.equal(t.requests.length,3,'BASE44 后可用性=③头字段+②b窗口两次读，确认前再核一次（读风暴仍不许）');}finally{t.close();}
});
it('partial progress changes the count and rejection label but never resolves the card',()=>{
  const t=mount();try{t.w.dispatchEvent(new t.w.CustomEvent('shangshu:review-progress',{detail:{proposal_id:'p1',descriptor:{id:'p1',status:'proposed',can_accept:true,can_reject:true,remaining:2,accepted_count:1}}}));assert.match(t.card().textContent,/已保存 1 项.*待确认 2 项/);assert.equal(t.card().classList.contains('resolved'),false);assert.equal(t.card().querySelector('.no').textContent,'放弃剩余');}finally{t.close();}
});
it('only a newly streamed supported candidate requests auto-navigation; passive rendering never jumps',async()=>{
  let calls=0;const plain=mount({navigate:async()=>{calls++;return true;}});try{await tick();assert.equal(calls,0);}finally{plain.close();}
  const fresh=mount({autoNavigate:true,navigate:async()=>{calls++;return true;}});try{await waitFor(()=>calls===1&&!fresh.button().disabled,3000,'自动定位一次且可用性核对完成');assert.equal(calls,1);assert.equal(fresh.requests.length,2,'BASE44 后可用性两次读（③+②b），仍是固定步数');}finally{fresh.close();}
});
it('an already confirmed proposal is read-only on retry and cannot call the controller twice',async()=>{
  let calls=0;const t=mount({descriptor:{status:'confirmed',remaining:0},controller:{id:'p1',acceptRemaining:async()=>{calls++;}}});
  try{await waitFor(()=>t.card().classList.contains('resolved')&&/本提案已确认/.test(t.card().textContent),3000,'已确认提案按终态渲染');t.button().click();await tick();assert.equal(calls,0);assert.equal(t.card().classList.contains('resolved'),true);assert.match(t.card().textContent,/本提案已确认/);assert.equal(t.requests.length,1);}finally{t.close();}
});

it('inline confirmation waits for authoritative write preflight and rejects stale/read-only/unknown states',async()=>{
 for(const descriptor of [{can_accept:false,accept_unavailable_reason:'你没有修改此内容的权限'},{status:'expired'},{can_accept:undefined},{status:'confirmed',remaining:0}]){let writes=0;const t=mount({descriptor,controller:{id:'p1',acceptRemaining:async()=>{writes++;}}});try{assert.equal(t.button().disabled,true);await waitFor(()=>!/正在核对是否可以确认/.test(t.card().querySelector('.cf-review-availability').textContent),3000,'可用性核对结束');assert.equal(t.button().disabled,true);t.button().click();await tick();assert.equal(writes,0);assert.ok(t.card().querySelector('.cf-review-availability').textContent);}finally{t.close();}}
});
it('progress refresh rechecks preflight without the removed recheck button or writes',async()=>{
 const t=mount({descriptor:{can_accept:false}});try{await waitFor(()=>!/正在核对是否可以确认/.test(t.card().querySelector('.cf-review-availability').textContent),3000,'首次可用性核对结束');assert.equal(t.button().disabled,true);t.w.api=async()=>({ok:true,json:async()=>({id:'p1',status:'proposed',can_accept:true,can_reject:true,remaining:1,units:[{unit_id:'subject',label:'主题',status:'pending',value:'候选'}]})});assert.ok(![...t.card().querySelectorAll('button')].some((b:any)=>b.textContent==='重新核对'));t.w.dispatchEvent(new t.w.CustomEvent('shangshu:review-progress',{detail:{proposal_id:'p1'}}));await waitFor(()=>!t.button().disabled,3000,'进度刷新重核后确认可用');assert.equal(t.button().disabled,false);assert.equal(t.w.document.querySelectorAll('[data-confirm-id]').length,1);assert.ok(t.requests.every(r=>!r.request?.method||r.request.method==='GET'));}finally{t.close();}
});
it('read-only card cannot reject without independent rejection authority',async()=>{
 const t=mount({descriptor:{can_accept:false,can_reject:false,reject_unavailable_reason:'你没有放弃此建议的权限'}});try{await waitFor(()=>!/正在核对是否可以确认/.test(t.card().querySelector('.cf-review-availability').textContent),3000,'可用性核对结束');const no=t.card().querySelector('.no');assert.equal(no.disabled,true);const count=t.requests.length;no.click();await tick();assert.equal(t.requests.length,count);assert.match(t.card().textContent,/没有放弃/);}finally{t.close();}
});
it('②b 回 unsupported 时回落原确认口：测试通过 = 按钮变「同意并执行」、点击只调一次 POST resolve、不空等页面控制器',async()=>{
  const posts:string[]=[];
  const t=mount({setup:(w:any)=>{
    w.api=async(path:string,request:any)=>{
      const p=String(path);
      if(p.includes('/units'))return {ok:false,status:422,json:async()=>({ok:false,code:'UNSUPPORTED',unsupported:true,error:'该动作暂不支持逐项审核，请使用原确认入口'})};
      if(p.includes('action-proposal-get'))return {ok:true,json:async()=>({ok:true,id:'p1',status:'proposed',can_accept:true,can_reject:true,remaining:1,accepted_count:0})};
      if(request?.method==='POST'){posts.push(p+' '+String(request.body));return {ok:true,json:async()=>({ok:true,id:'p1',status:'confirmed',remaining:0})};}
      return {ok:true,json:async()=>({ok:true,id:'p1',status:'proposed',can_accept:true,can_reject:true,remaining:1,accepted_count:0})};
    };
  }});
  try{
    await waitFor(()=>t.button().textContent==='同意并执行'&&!t.button().disabled,3000,'识别 unsupported 后回落整笔确认');
    t.button().click();
    await waitFor(()=>t.card().classList.contains('resolved'),3000,'原确认口直接完成');
    assert.equal(posts.length,1,'只调一次确认口');
    assert.match(posts[0],/\/resolve/);
    assert.match(posts[0],/"decision":"confirmed"/);
  }finally{t.close();}
});
it('步进把当前单元交给页面定位：测试通过 = navigate 收到 unit_id/字段与目标行，聊天侧不自己猜位置',async()=>{
  const seen:any[]=[];
  const t=mount({descriptor:{units:[
    {unit_id:'subject',label:'主题',status:'pending',value:'候选主题',target:{header:'主题',row_id:'r-000001'}},
    {unit_id:'body',label:'正文',status:'pending',value:'候选正文',target:{header:'正文',row_id:'r-000002'}}]},
  navigate:async(_p:any,u:any)=>{seen.push({id:_p.id,unit:u&&u.unit_id,field:u&&u.target?.header,row:u&&u.target?.row_id});return true;}});
  try{
    await waitFor(()=>{const n=t.card().querySelector('[data-review-step="1"]');return Boolean(n&&!n.disabled);},3000,'可用性核对完成、步进可用');
    t.card().querySelector('[data-review-step="1"]')?.dispatchEvent(new t.w.MouseEvent('click',{bubbles:true}));
    await waitFor(()=>seen.length===1,3000,'步进调用页面定位');
    assert.deepEqual(seen[0],{id:'p1',unit:'body',field:'正文',row:'r-000002'});
  }finally{t.close();}
});
it('restored spreadsheet card has a human title without raw capability',async()=>{
 const t=mount({proposal:{capability:'files.sheet_cells_write',payload:{table:'synthetic'}}});try{assert.equal(t.card().querySelector('.cf-title').textContent,'修改表格值');assert.doesNotMatch(t.card().textContent,/files\.sheet_cells_write/);}finally{t.close();}
});

// —— R967-D01（BASE967-44）：计数/可见分页/单项细节分开，仍受权限检查 ——
// 测试通过 = 什么成立：③带可用性头字段时，可用性核对不拉整包 /review；单元显示与步进走 ②b range（offset/limit）。
it('可用性核对走③头字段、单元走②b窗口：测试通过 = 不拉整包/review，步进带 offset/limit',async()=>{
  const reads:string[]=[];
  const t=mount({proposal:{capability:'files.sheet_cells_write',payload:{table:'t1',cells:[]}},setup:(w:any)=>{
    w.api=async(path:string,request:any)=>{
      reads.push(String(path)+(request?.method?` ${request.method}`:''));
      const p=String(path);
      if(p.includes('/units')){
        const off=Number(new URL(p,'http://x').searchParams.get('offset')||0);
        return {ok:true,json:async()=>({ok:true,proposal:'p1',total:2,offset:off,limit:20,items:[{unit_id:'u'+off,label:'第'+off+'格',target:{header:'金额',row_id:'r-000001'},value:{type:'number',value:800+off},status:'pending',cell_index:off}],reason:''})};
      }
      if(p.includes('action-proposal-get')){
        return {ok:true,json:async()=>({ok:true,id:'p1',status:'proposed',capability:'files.sheet_cells_write',total_units:2,remaining:2,accepted_count:0,can_accept:true,can_reject:true,accept_unavailable_reason:'',reject_unavailable_reason:'',review_access:'',review_blocked_reason:'',review_revision:3})};
      }
      throw Error('不应请求整包 /review：'+p);
    };
  }});
  try{
    await waitFor(()=>/第0格/.test(t.card().textContent)&&reads.some(r=>/\/units\?.*offset=0/.test(r)),3000,'③可用性+②b首窗渲染完成');
    assert.ok(reads.some(r=>r.includes('action-proposal-get')),'可用性走③头字段');
    assert.ok(reads.some(r=>/\/units\?/.test(r)),'单元走②b range');
    assert.ok(reads.every(r=>!r.includes('/review')),'整包 review 不拉');
    assert.match(t.card().textContent,/第0格/);
    const next=t.card().querySelector('[data-review-step="1"]') as any;
    assert.ok(next,'应有步进按钮');next.click();await waitFor(()=>/第1格/.test(t.card().textContent)&&reads.some(r=>/\/units\?offset=1/.test(r)),3000,'步进取到下一项并渲染');
    assert.ok(reads.some(r=>/\/units\?offset=1/.test(r)),'步进按 offset 取下一项');
    assert.match(t.card().textContent,/第1格/);
    assert.ok(reads.every(r=>!r.includes(' ')||r.includes(' GET')),'全程只读');
  }finally{t.close();}
});

// —— R967-D01（BASE967-44）：恢复路径去重 ——
// 测试通过 = 传入预取的可用性头字段时不再重复拉 ③；进度刷新时才重新核一次。
// —— R967-D01（BASE967-44）：大步进在「无定位目标」时仍可推进 ——
// ③ 瘦身后大提案 payload 被省略 → navigate 无法构造目标会抛错；步进卡不得因此停住。
// 测试通过 = 导航失败时位置照常 1→2 并重渲染，失败只以提示告知。
it('步进导航失败不阻断推进：测试通过 = navigate 抛错时位置仍前进并渲染',async()=>{
  const t=mount({setup:(w:any)=>{w.shangshuNavigateReview=async()=>{throw Error('此提案暂不支持页面定位');};}});
  try{
    await waitFor(()=>{const n=t.card().querySelector('[data-review-step="1"]');return Boolean(n&&!n.disabled);},3000,'可用性核对完成、步进可用');
    const card=t.card();
    const before=card.querySelector('.review-position')?.textContent;
    const next=card.querySelector('[data-review-step="1"]') as any;
    assert.ok(next&&!next.disabled,'上一步可用');
    next.click();
    await waitFor(()=>card.querySelector('.review-position')?.textContent==='2 / 2 · 正文',3000,'导航失败也推进并渲染');
    assert.equal(card.querySelector('.review-position')?.textContent,'2 / 2 · 正文','导航失败也要推进并渲染');
  }finally{t.close();}
});

it('预取头字段只消费一次：测试通过 = 恢复不重复拉③，刷新才重核',async()=>{
  const hits:string[]=[];
  const t=mount({header:{id:'p1',status:'proposed',can_accept:true,can_reject:true,remaining:2,accepted_count:0,review_revision:1},setup:(w:any)=>{
    w.api=async(path:string)=>{hits.push(String(path));const p=String(path);return {ok:true,json:async()=>p.includes('/units')?{ok:true,total:2,items:[{unit_id:'u0',label:'主题',status:'pending',value:'候选'}]}:{ok:true,id:'p1',status:'proposed',can_accept:true,can_reject:true,remaining:2,accepted_count:0}};};
  }});
  try{
    await waitFor(()=>hits.some(h=>h.includes('/units')),3000,'预取头字段后按②b取首窗');
    const getCount=()=>hits.filter(h=>h.includes('action-proposal-get')).length;
    assert.equal(getCount(),0,'预取头字段已给，不得再拉③');
    t.w.dispatchEvent(new t.w.CustomEvent('shangshu:review-progress',{detail:{proposal_id:'p1'}}));
    await waitFor(()=>getCount()===1,3000,'进度刷新才重核一次');
    assert.equal(getCount(),1,'进度刷新才重核一次');
  }finally{t.close();}
});

it('新口缺席时回落整包口：测试通过 = ③缺头字段时按旧行为渲染，不回退功能',async()=>{
  const reads:string[]=[];
  const t=mount({setup:(w:any)=>{
    w.api=async(path:string)=>{
      reads.push(String(path));
      const p=String(path);
      if(p.includes('action-proposal-get'))return {ok:true,json:async()=>({ok:true,id:'p1',status:'proposed'})};
      return {ok:true,json:async()=>({id:'p1',status:'proposed',can_accept:true,can_reject:true,remaining:2,accepted_count:1,units:[{unit_id:'subject',label:'主题',status:'pending',value:'候选主题'},{unit_id:'body',label:'正文',status:'pending',value:'候选正文'}]})};
    };
  }});
  try{
    await waitFor(()=>/主题/.test(t.card().textContent),3000,'回落整包口渲染完成');
    assert.ok(reads.some(r=>r.includes('/review')),'回落整包口');
    assert.match(t.card().textContent,/主题/);
    assert.equal(t.button().disabled,false,'确认可用性不回退');
  }finally{t.close();}
});
