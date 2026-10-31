import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const source=readFileSync(new URL('../../../shangshu-web/js/real-chat.js',import.meta.url),'utf8');
/**
 * ⚠️ `chatSkeleton` / `chatHistorySkeleton` 是 real-chat.js **文件靠前的顶层助手**（第 22 行起），
 *   本文件只把几段切片拿进沙箱跑（每段都不含这两个助手）
 *   ⇒ 抽出来的那段用到骨架助手时，window 上没有 ⇒ **ReferenceError: chatHistorySkeleton is not defined**。
 *   （同类先例：`shangshu-web/js/domains/excel-univer/tests/read-scheduler.test.mjs` ——
 *     抽源码片段在沙箱里跑，片段用到的导入件在沙箱 context 里补上，补的是**真的那个**。）
 *   这里把**同一个文件里真的那两个**抽出来补进 window（不造替身）。
 */
const skeletonSource=source.slice(source.indexOf('const chatSkeleton ='),source.indexOf('let chatRunning = false;'));
function mount(){
 const dom=new JSDOM('<button id="send-btn"></button><textarea id="input"></textarea><div id="chat"></div>',{runScripts:'outside-only'}),w=dom.window as any;
 Object.assign(w,{AbortController,TextDecoder,chatRunning:false,chatMode:'float',chatInput:dom.window.document.querySelector('#input'),chatEl:dom.window.document.querySelector('#chat'),chatSessions:[{id:'one',msgs:[]},{id:'two',msgs:[]}],chatCurSession:0,chatContext:{},toast(){},chatUpdateFab(){},chatSetStatus(){},chatHideSlash(){},chatScrollBottom(){},chatAddUserMsg(){},chatRender:(x:any)=>x,esc:(x:any)=>String(x),chatRenderSessions(){},chatCloseFloat(){},chatWelcome(){},chatReplaySession(){},chatSessionTitle:()=>'',chatTimeLabel:()=>'',confirm:()=>true,$:(s:string)=>w.document.querySelector(s),chatAiShell(){const el=w.document.createElement('div');el.className='m-ai';el.innerHTML='<i class="ava thinking"></i><div class="body"></div>';w.chatEl.append(el);return el.querySelector('.body');}});
 // ⚠️ 先把真的骨架助手补进 window（见文件头的说明），再抽片段跑。
 w.eval(skeletonSource+'\nwindow.chatSkeleton=chatSkeleton;window.chatHistorySkeleton=chatHistorySkeleton;');
 w.eval(source.slice(source.indexOf('const CHAT_SEND_ICON'),source.indexOf('/*',source.indexOf('async function chatGuardFlow'))).replace('let chatAbort = null','var chatAbort = null'));
 for(const [a,b] of [['async function chatDeleteSession','function chatReplaySession'],['function chatPickSession','/* —— 右上悬浮栏'],['async function chatRunMessage','// 思考过程折叠块'],['function chatSendInput','/* —— slash']])w.eval(source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a))));
 // 合并补注（2026-10-21）：fast 那条线给对话加了「本轮执行记录」——
 // `chatRunMessage` 里会调 `chatRunProgress`/`chatFinishRun`，这两个函数定义在 real-chat.js
 // 第 617/638 行，**在「chatRunMessage → 思考过程折叠块」那段切片之外**
 // ⇒ 跑起来就 ReferenceError，而且它发生在流式读取**之前**，
 // 异常被 `chatGuardFlow` 兜住 ⇒ 那个 `await run` 永远不落 ⇒ 用例**挂死**（实测 62 秒超时）。
 // 把这段实现也切进来。
 // 合并补注（2026-10-21）：fast 那条线给 `chatAddToolCard` 加了「本轮执行记录」，
 // 里面要读**平台工具目录** `PLATFORM_CHAT_TOOLS`（真实值由服务端带回、挂在 window 上）；
 // 它声明在 real-chat.js 第 2133 行，在所有切片之外 ⇒ 收到 tool 事件时 ReferenceError，
// 「撤回三态」那条用例就卡在这儿。判据只关心撤回三态的措辞，不需要真实目录，空表即可。
 Object.assign(w,{PLATFORM_CHAT_TOOLS:[]});
 w.eval(source.slice(source.indexOf('/* —— fast：本轮执行记录'),source.indexOf('function chatAddToolCard(')));
 // 合并补注（2026-10-21）：fast 那条线加了「同一对话入口可选 Pi 引擎」——
 // `chatRunMessage` 发的请求体里带 `engine: chatEngine`，而 `chatEngine` 是 real-chat.js
 // 第 27 行的**模块级**变量，**在所有切片之外** ⇒ 发请求前就 ReferenceError，
 // 被 `chatRunMessage` 的 catch 当成「连接失败」⇒ 用例看到的是「（连接失败）」而不是结果。
 // 这里把源码里那行声明原样切进来（用真值，不硬编）。
 // ⚠️ 必须把 `let` 改成 `var`：**直接 eval 里的 `let` 只活在那一次 eval 的词法作用域**，
 // 别的切片看不见（这正是本文件 slice 助手把 `let|const` 统一改成 `var` 的原因）；
 // `var` 才会挂到 window 上。
 w.eval(source.slice(source.indexOf('let chatEngine'),source.indexOf('\n',source.indexOf('let chatEngine'))).replace(/^let /,'var '));
 return {w,close:()=>dom.window.close()};
}
// —— R967-D01（BASE967-23）：运行中会话切换按既定目标正确路由，不能用永久禁用规避 ——
// 测试通过 = 什么成立：生成中可切换/新建会话；结果与工具卡落回原会话（不串会话、不撤销已保存成果）；
// 草稿输入按会话归属；停止控制仍指运行中的任务。
it('运行中切换/新建会话不被挡且结果落回原会话：测试通过 = 切换不丢输入、结果归原会话、草稿按会话保留',async()=>{
  const t=mount();try{
    const w=t.w;
    // DOM 归属层的最小替身：消息进（layer||chatEl），与真实实现同约定
    w.eval('var chatLiveTouched = false;');
    w.eval(source.slice(source.indexOf('function chatLayerFor'),source.indexOf('function chatReplaySession')));
    w.chatAddUserMsg=(text:string,layer?:any)=>{const d=w.document.createElement('div');d.className='m-user';d.textContent=text;(layer||w.chatEl).append(d);};
    w.chatAiShell=(thinking:boolean,layer?:any)=>{const el=w.document.createElement('div');el.className='m-ai';el.innerHTML='<i class="ava"></i><div class="body"></div>';(layer||w.chatEl).append(el);return el.querySelector('.body');};
    let resolveRead:(v:any)=>void;let readDone=false;
    const pending=new Promise(r=>{resolveRead=r;});
    w.api=async()=>({ok:true,body:{getReader:()=>({read:async()=>{
      if(readDone)return {done:true};
      readDone=true;return pending as any;
    }})}});
    const run=w.chatGuardFlow(()=>w.chatRunMessage('会话0任务'));
    // 生成中：Enter 保留输入（沿 UI064 口径）
    w.chatRunning=true;w.chatInput.value='尚未发送';w.chatSendInput();assert.equal(w.chatInput.value,'尚未发送');
    // 生成中切换到会话1：不再被「请先停止生成」挡
    w.chatInput.value='会话0草稿';
    w.chatPickSession(1);
    assert.equal(w.chatCurSession,1,'运行中应可切换会话');
    assert.equal(w.chatInput.value,'','会话1草稿初始为空，不带会话0草稿');
    w.chatInput.value='会话1草稿';
    w.chatPickSession(0);
    assert.equal(w.chatInput.value,'会话0草稿','草稿输入按会话归属');
    // 完成前再切到会话1：结果必须按任务标识落回会话0，不看当前在看谁
    w.chatPickSession(1);
    assert.equal(w.chatInput.value,'会话1草稿','再切回时草稿仍在');
    resolveRead({done:false,value:new TextEncoder().encode('event: text\ndata: {"delta":"会话0结果"}\n\nevent: done\ndata: {"reply":"会话0结果","reasoning":""}\n\n')});
    w.chatRunning=false;
    await run;
    assert.equal(w.chatSessions[0].msgs.at(-1).content,'会话0结果','结果落回原会话');
    assert.equal(w.chatSessions[1].msgs.length,0,'不把结果串进其他会话');
    const layer0=w.document.querySelector('[data-conv="one"]');
    assert.ok(layer0&&layer0.textContent.includes('会话0结果'),'原会话层内可找回结果');
    w.chatPickSession(0);
    assert.equal(w.chatCurSession,0);
    assert.ok((layer0 as any).hidden===false,'切回原会话结果可见');
    w.chatNewSession();
    assert.equal(w.chatCurSession,-1,'运行结束后可新建');
  }finally{t.close();}
});

// —— R967-D01（BASE967-23/UI-091）：工具运行中切应用，不把结果重定向到当前页 ——
// 测试通过 = 生成期间切到另一个应用（hash 改变）后，完成结果仍落回原会话/原对话层；
// 当前应用不被跳回、也不把结果写进当前页或别的会话。
it('UI-091 工具运行中切应用不重定向结果：测试通过 = 结果回原会话层，当前应用不被跳回',async()=>{
  const t=mount();try{
    const w=t.w;
    w.eval('var chatLiveTouched = false;');
    w.eval(source.slice(source.indexOf('function chatLayerFor'),source.indexOf('function chatReplaySession')));
    w.chatAddUserMsg=(text:string,layer?:any)=>{const d=w.document.createElement('div');d.className='m-user';d.textContent=text;(layer||w.chatEl).append(d);};
    w.chatAiShell=(thinking:boolean,layer?:any)=>{const el=w.document.createElement('div');el.className='m-ai';el.innerHTML='<i class="ava"></i><div class="body"></div>';(layer||w.chatEl).append(el);return el.querySelector('.body');};
    let release:(v:any)=>void;const pending=new Promise(r=>{release=r;});let readOnce=false;
    w.api=async()=>({ok:true,body:{getReader:()=>({read:async()=>readOnce?{done:true}:(readOnce=true,pending)})}});
    const run=w.chatGuardFlow(()=>w.chatRunMessage('工具任务-切应用'));
    w.chatRunning=true;
    const convBefore=w.eval('chatRunningConv');
    // 工具执行中切到另一个应用（页面 hash 变化）
    w.location.hash='#/mail';
    assert.equal(w.eval('chatRunningConv'),convBefore,'运行任务标识不因切应用而改');
    release({done:false,value:new TextEncoder().encode('event: text\ndata: {"delta":"工具任务结果"}\n\nevent: done\ndata: {"reply":"工具任务结果","reasoning":""}\n\n')});
    w.chatRunning=false;
    await run;
    assert.equal(w.chatSessions[0].msgs.at(-1).content,'工具任务结果','结果落回原会话');
    assert.equal(w.chatSessions[1].msgs.length,0,'结果不串到其他会话');
    const layer0=w.document.querySelector('[data-conv="one"]');
    assert.ok(layer0&&layer0.textContent.includes('工具任务结果'),'原对话层内可找回结果');
    assert.equal(w.location.hash,'#/mail','当前应用不被结果跳回');
  }finally{t.close();}
});
it('切到不存在的会话不抛错：测试通过 = 空会话表上的越界切换是无操作',async()=>{  const t=mount();try{
    const w=t.w;w.chatSessions.splice(0,w.chatSessions.length);
    assert.doesNotThrow(()=>w.chatPickSession(0));
    assert.doesNotThrow(()=>w.chatPickSession(9));
  }finally{t.close();}
});
it('运行中删除：测试通过 = 删运行中会话被挡且成果不撤销，删其他会话可',async()=>{
  const t=mount();try{
    const w=t.w;
    w.eval('var chatRunningConv = "one";');
    w.chatRunning=true;
    let deletes=0;
    w.api=async()=>{deletes++;return {json:async()=>({ok:true})};};
    await w.chatDeleteSession(0);
    assert.equal(w.chatSessions.length,2,'运行中会话不许删');
    assert.equal(deletes,0);
    await w.chatDeleteSession(1);
    assert.equal(w.chatSessions.length,1,'其他会话可删');
    assert.equal(deletes,1);
  }finally{t.close();}
});

// —— R967-D01（BASE967-30）：已处理提案随原对话恢复 ——
// 测试通过 = 什么成立：历史回放把已确认/已拒绝/失败提案按当前状态渲染终态卡（带提案身份），
// 仍待审的接回可操作卡，无权项中性提示不泄露候选。
it('已处理提案随原对话恢复：测试通过 = 终态/待审/无权按当前状态渲染且卡片带提案身份',async()=>{
  const t=mount();try{
    const w=t.w;
    w.eval('var CHAT_SESSION_GAP_MS = 25*60*1000;');
    w.eval('var chatLiveTouched = false;');
    w.eval('var chatRunningConv = "";');
    w.eval(source.slice(source.indexOf('function chatReplaySession'),source.indexOf('function chatPickSession')));
    w.eval(source.slice(source.indexOf('function chatHasLiveContent'),source.indexOf('/* ============ 模块入口')));
    // ⚠️ `chatLayerFor`（历史回放用来起那一层的）在 real-chat.js 里**不在上面两段切片之内**
    //   ⇒ `chatReplaySession` 调它时 ReferenceError ⇒ 整段历史回放直接抛 ⇒ 卡片一张都没画。
    //   （本文件另外几条用例早就切了这一段 —— 这里照同样做法补上。）
    w.eval(source.slice(source.indexOf('function chatLayerFor'),source.indexOf('function chatReplaySession')));
    w.chatLoadPendingConfirmations=()=>{};
    let restoredOpen='';
    w.chatAddConfirmCard=(body:any,proposal:any)=>{restoredOpen=proposal.id;};
    const proposals:{[k:string]:any}={
      'p-conf':{ok:true,id:'p-conf',status:'confirmed',capability:'files.sheet_cells_write',entity_type:'file',entity_id:'f1',payload:{}},
      'p-rej':{ok:true,id:'p-rej',status:'rejected',capability:'mail.save_draft',entity_type:'mail',entity_id:'m1',payload:{}},
      'p-fail':{ok:true,id:'p-fail',status:'failed',capability:'mail.send',entity_type:'mail',entity_id:'m2',payload:{},error:'服务商明确拒绝'},
      'p-open':{ok:true,id:'p-open',status:'proposed',capability:'files.sheet_cells_write',entity_type:'file',entity_id:'f3',payload:{}},
    };
    w.api=async(path:string)=>{
      if(String(path).includes('history'))return {json:async()=>({ok:true,list:[
        {role:'user',content:'请改金额',conversation_id:'me:old',created_at:'2026-10-01T00:00:00Z'},
        {role:'assistant',content:'本轮已生成候选',reasoning:'',conversation_id:'me:old',created_at:'2026-10-01T00:00:01Z',
         cards:{proposals:[{id:'p-conf'},{id:'p-rej'},{id:'p-fail'},{id:'p-open'},{id:'p-denied'}],tools:[]}},
      ]})};
      const m=String(path).match(/action-proposal-get\/(.+)$/);
      if(m){
        const id=decodeURIComponent(m[1]);
        if(id==='p-denied')return {ok:false,json:async()=>({ok:false,error:'无权查看该候选'})};
        return {ok:true,json:async()=>proposals[id]};
      }
      return {ok:true,json:async()=>({ok:true})};
    };
    const historyRun=w.chatLoadHistory();
    await historyRun;
    for(let i=0;i<20&&!/已确认/.test(w.chatEl.textContent);i++)await new Promise(r=>setTimeout(r,5));
    const text=w.chatEl.textContent;
    assert.match(text,/已确认/,'已确认提案恢复终态');
    assert.match(text,/已拒绝/,'已拒绝提案恢复终态');
    assert.match(text,/执行失败/,'失败提案恢复终态');
    assert.match(text,/服务商明确拒绝/,'失败原因可见');
    assert.match(text,/p-conf/,'卡片带提案身份');
    assert.equal(restoredOpen,'p-open','仍待审的接回可操作卡');
    assert.match(text,/无权查看|不可见/,'无权项中性提示');
    assert.doesNotMatch(text,/800/,'无权项不泄露候选值');
  }finally{t.close();}
});
it('初始网络失败显示错误并清思考态，守卫释放允许再发',async()=>{const t=mount();try{const w=t.w;w.api=async()=>{throw Error('synthetic network failure');};await w.chatGuardFlow(()=>w.chatRunMessage('合成问题'));assert.match(w.chatEl.textContent,/连接失败/);assert.equal(w.chatEl.querySelector('.thinking'),null);assert.equal(w.chatRunning,false);assert.equal(w.document.querySelector('#send-btn').title,'发送');assert.equal(w.chatSessions[0].msgs.at(-1).content,'（连接失败）');}finally{t.close();}});
it('响应头前停止清理气泡状态且不误报连接失败',async()=>{const t=mount();try{const w=t.w;w.api=(_p:any,o:any)=>new Promise((_r,j)=>o.signal.addEventListener('abort',()=>j(Error('aborted'))));const run=w.chatGuardFlow(()=>w.chatRunMessage('合成停止'));w.chatStopGeneration();await run;assert.match(w.chatEl.textContent,/已停止/);assert.doesNotMatch(w.chatEl.textContent,/连接失败/);assert.equal(w.chatEl.querySelector('.thinking'),null);assert.equal(w.chatRunning,false);}finally{t.close();}});
it('正常SSE完成回答仍归原会话，结束后可以切换',async()=>{const t=mount();try{const w=t.w;let once=false;w.api=async()=>({ok:true,body:{getReader:()=>({read:async()=>once?{done:true}:(once=true,{done:false,value:new TextEncoder().encode('event: text\ndata: {"delta":"合成回答"}\n\n')})})}});await w.chatGuardFlow(()=>w.chatRunMessage('合成问题'));assert.equal(w.chatSessions[0].msgs.at(-1).content,'合成回答');assert.equal(w.chatSessions[1].msgs.length,0);w.chatPickSession(1);assert.equal(w.chatCurSession,1);}finally{t.close();}});
it('真实键盘处理忽略中文组合提交与229，普通Enter仍发送',()=>{let sent=0,prevented=0;const match=source.match(/chatInput.addEventListener\('keydown', e => \{([\s\S]*?)\n    \}\);/);assert.ok(match);const handler=new Function('e','chatSendInput','chatHideSlash','chatCloseFloat',match[1]);for(const e of [{key:'Enter',isComposing:true},{key:'Enter',keyCode:229},{key:'Enter',shiftKey:true}])handler({...e,preventDefault(){prevented++;}},()=>sent++,()=>{},()=>{});assert.equal(sent,0);handler({key:'Enter',preventDefault(){prevented++;}},()=>sent++,()=>{},()=>{});assert.equal(sent,1);assert.equal(prevented,1);});

// —— R967-D01（BASE967-29）：迟到历史响应不能覆盖本轮消息 ——
// 测试通过 = 什么成立：历史回包晚到时，当轮用户消息/工具卡/回答仍在 DOM，且会话归属不被劫持。
it('历史加载迟到不覆盖当轮消息：测试通过 = 晚到历史不清单轮DOM、不劫持当前会话',async()=>{
  const t=mount();try{
    const w=t.w;
    // 真实 chatReplaySession / chatLoadHistory（mount 默认把它们桩掉）
    w.eval('var CHAT_SESSION_GAP_MS = 25*60*1000;');
    w.eval('var chatLiveTouched = false;');
    w.eval('var chatRunningConv = "";');
    w.eval(source.slice(source.indexOf('function chatReplaySession'),source.indexOf('function chatPickSession')));
    w.eval(source.slice(source.indexOf('function chatHasLiveContent'),source.indexOf('/* ============ 模块入口')));
    w.chatAddUserMsg=(text:string)=>{const d=w.document.createElement('div');d.className='m-user';d.textContent=text;w.chatEl.append(d);};
    w.chatLoadPendingConfirmations=()=>{};
    let resolveHistory:(v:any)=>void;
    const historyPromise=new Promise(r=>{resolveHistory=r;});
    let chatDone=false;
    w.api=async(path:string)=>{
      if(String(path).includes('history'))return historyPromise;
      return {ok:true,body:{getReader:()=>({read:async()=>chatDone?{done:true}:(chatDone=true,{done:false,value:new TextEncoder().encode('event: text\ndata: {"delta":"合成回答"}\n\n')})})}};
    };
    const liveSessionIndex=w.chatCurSession;
    const historyRun=w.chatLoadHistory();           // 历史加载已发出但未回
    await w.chatGuardFlow(()=>w.chatRunMessage('当轮问题'));   // 历史未回先发消息
    assert.match(w.chatEl.textContent,/当轮问题/);
    assert.match(w.chatEl.textContent,/合成回答/);
    resolveHistory({json:async()=>({ok:true,list:[
      {role:'user',content:'旧消息',conversation_id:'me:old',created_at:'2026-10-01T00:00:00Z'},
      {role:'assistant',content:'旧回答',reasoning:'',conversation_id:'me:old',created_at:'2026-10-01T00:00:01Z'},
    ]})});
    await historyRun;
    assert.match(w.chatEl.textContent,/当轮问题/,'当轮用户消息不得被历史回包抹掉');
    assert.match(w.chatEl.textContent,/合成回答/,'当轮回答不得被历史回包抹掉');
    assert.equal(w.chatCurSession,liveSessionIndex,'迟到历史不得把当前会话切到旧会话');
    assert.ok(w.chatSessions.some((s:any)=>s.id==='me:old'),'旧会话进入历史列表可找回');
  }finally{t.close();}
});

// —— R967-D01（BASE967-35）：撤回三态上屏 ——
// 2026-10-19 FIX-11：黄色「执行状态」汇总卡整块撤掉（用户 20:38 截图明确取消），
// 所以撤回三态**改由撤回工具卡自己说**（BASE967-35 的口径不变：三态要说人话）。
// 测试通过 = 什么成立：撤回被拒（同段有助手改动）时，界面说清「没撤掉、为什么」；
// 三态各有可读行（全撤/部分撤/拒撤），不是只显示「调用完成」。
it('撤回三态在撤回卡上可读：测试通过 = 拒撤/部分撤/全撤各有可读行（BASE967-35）',async()=>{
  const t=mount();try{
    const w=t.w;
    w.eval(source.slice(source.indexOf('/* —— 工具卡'),source.indexOf('/* —— 确认卡')));
    w.chatAddUserMsg=(text:string)=>{const d=w.document.createElement('div');d.className='m-user';d.textContent=text;w.chatEl.append(d);};
    const turn=(undo:any)=>'event: tool\ndata: '+JSON.stringify({name:'platform_files_sheet_cells_undo',arg:'{}',result:JSON.stringify(undo)})+'\n\nevent: done\ndata: {"reply":"撤回结果如上","reasoning":""}\n\n';
    const chunk=(text:string)=>new TextEncoder().encode(text);
    const runWith=async(undo:any)=>{
      w.api=async()=>{
        const payload=turn(undo);
        let read=false;
        return {ok:true,body:{getReader:()=>({read:async()=>read?{done:true}:(read=true,{done:false,value:chunk(payload)})})}};
      };
      w.chatEl.textContent='';
      await w.chatGuardFlow(()=>w.chatRunMessage('撤回刚才那一步'));
      return w.chatEl.textContent;
    };
    const rejected=await runWith({undo_state:'rejected_conflict',undone:0,kept:2});
    assert.match(rejected,/未撤回/,'拒撤要说清没撤掉');
    assert.match(rejected,/助手/,'拒撤原因（助手改动）要写出来');
    const partial=await runWith({undo_state:'partial',undone:2,kept:1});
    assert.match(partial,/部分撤回/);
    const full=await runWith({undo_state:'withdrawn',undone:3,kept:0});
    assert.match(full,/已撤回/);
    assert.doesNotMatch(full,/执行状态/,'黄色执行状态汇总卡不再出现');
  }finally{t.close();}
});

// —— R967-D01（BASE967-28）：空回答错误/重试状态与诊断 ——
// 测试通过 = 什么成立：空轮状态卡上屏（含诊断），点重试重发原问题得到新回答。
it('空回答执行卡带诊断与重试入口：测试通过 = 空轮诊断上屏，点重试重发原问题',async()=>{
  const t=mount();try{
    const w=t.w;
    w.eval(source.slice(source.indexOf('function chatAddRetryAffordance'),source.indexOf('function chatAiShell')));
    w.chatAddUserMsg=(text:string)=>{const d=w.document.createElement('div');d.className='m-user';d.textContent=text;w.chatEl.append(d);};
    let sent=0;
    const chunk=(text:string)=>new TextEncoder().encode(text);
    w.api=async()=>{
      sent++;
      const payload=sent===1
        ?'event: status\ndata: {"kind":"turn_status","turn_id":"t1","proposals":[],"reads":[],"errors":[],"states":{"candidate_created":0,"confirmed":0,"draft_saved":0,"mail_sent":0},"empty_attempts":[{"round":0,"finish_reason":null,"has_text":false,"has_tools":false}],"auto_retried":true,"no_receipt_claims":[]}\n\nevent: done\ndata: {"reply":"（未得到有效回答，请换个说法再试）","reasoning":""}\n\n'
        :'event: text\ndata: {"delta":"重试后有效回答"}\n\nevent: done\ndata: {"reply":"重试后有效回答","reasoning":""}\n\n';
      let read=false;
      return {ok:true,body:{getReader:()=>({read:async()=>read?{done:true}:(read=true,{done:false,value:chunk(payload)})})}};
    };
    await w.chatGuardFlow(()=>w.chatRunMessage('首次空回答问题'));
    // 2026-10-19 FIX-11：黄色汇总卡撤掉后，空回答只剩**一条重试入口**；
    // 诊断细节（finish_reason 等）仍在服务端回合记录与会话日志里，界面上不再铺那张卡。
    assert.doesNotMatch(w.chatEl.textContent,/本轮实际查询|执行状态/);
    const btn=[...w.document.querySelectorAll('button')].find((b:any)=>b.textContent==='重试');
    assert.ok(btn,'空回答后应有重试入口');
    (btn as any).click();
    for(let i=0;i<20&&!/重试后有效回答/.test(w.chatEl.textContent);i++)await new Promise(r=>setTimeout(r,5));
    assert.match(w.chatEl.textContent,/重试后有效回答/);
    assert.equal(sent,2,'重试重发原问题');
    assert.match(w.chatEl.textContent,/首次空回答问题/);
  }finally{t.close();}
});

// Real socket/ReadableStream boundary; controlled server replaces the model only.
// This does not claim the production model/SQLite persistence route is exercised.
it('受控真实HTTP流：切会话后迟到正文仍归原会话，停止会断开请求',async()=>{
 const {createServer}=await import('node:http');
 const sockets=new Set<any>();let release:()=>void=()=>{};let openedResolve:()=>void=()=>{};
 let opened=new Promise<void>(r=>{openedResolve=r;});let closedResolve:()=>void=()=>{};
 const closed=new Promise<void>(r=>{closedResolve=r;});let requestCount=0;
 const server=createServer((req,res)=>{
  requestCount++;res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();
  res.on('close',()=>closedResolve());
  release=()=>res.end('event: text\ndata: {"delta":"原会话socket结果"}\n\nevent: done\ndata: {"reply":"原会话socket结果","reasoning":""}\n\n');
  openedResolve();
 });
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address() as any;const base=`http://127.0.0.1:${address.port}/`;
 const t=mount();try{
  const w=t.w;w.eval('var chatLiveTouched=false;');
  w.eval(source.slice(source.indexOf('function chatLayerFor'),source.indexOf('function chatReplaySession')));
  w.chatAddUserMsg=(text:string,layer:any)=>{const el=w.document.createElement('div');el.textContent=text;(layer||w.chatEl).append(el);};
  w.chatAiShell=(_thinking:boolean,layer:any)=>{const el=w.document.createElement('div');el.innerHTML='<div class="body"></div>';(layer||w.chatEl).append(el);return el.firstChild;};
  w.api=(path:string,options:any)=>fetch(new URL(path,base),options);
  const first=w.chatGuardFlow(()=>w.chatRunMessage('socket一'));
  await opened;w.chatPickSession(1);release();await first;
  assert.equal(w.chatSessions[0].msgs.at(-1).content,'原会话socket结果');
  assert.equal(w.chatSessions[1].msgs.length,0);
  opened=new Promise<void>(r=>{openedResolve=r;});
  let stopClosed:()=>void=()=>{};const stopped=new Promise<void>(r=>{stopClosed=r;});closedResolve=stopClosed;
  const second=w.chatGuardFlow(()=>w.chatRunMessage('socket停止'));
  await opened;w.chatStopGeneration();await second;await stopped;
  assert.equal(requestCount,2);assert.equal(w.chatRunning,false);
  assert.ok(!w.chatSessions[1].msgs.some((m:any)=>m.content==='原会话socket结果'));
 }finally{t.close();for(const s of sockets)s.destroy();await new Promise<void>(r=>server.close(()=>r()));}
});
