import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const source=readFileSync(new URL('../../../shangshu-web/js/real-chat.js',import.meta.url),'utf8');
it('开始提问收起欢迎说明，不移除待处理确认卡',()=>{
  const dom=new JSDOM('<main><div data-chat-welcome>欢迎</div><div data-confirm-id="pending">待确认</div></main>',{runScripts:'outside-only'}),w=dom.window as any;
  w.chatEl=w.document.querySelector('main');w.esc=String;w.chatScrollBottom=()=>{};
  try{
    // 合并补注（2026-10-21）：`chatAddUserMsg` 要用 `chatCurrentLayer()`（real-chat.js 第 1730 行），
    // 它在「chatAddUserMsg → chatAiShell」那段切片**之外** ⇒ 一跑就 ReferenceError（实测 4 条红）。
    // 把这个函数的真实现也切进来（别用桩 —— 判据要的就是真实挂载行为）。
    w.eval(source.slice(source.indexOf('function chatCurrentLayer('),source.indexOf('function chatReplaySession(')));
    w.eval(source.slice(source.indexOf('function chatAddUserMsg('),source.indexOf('function chatAiShell(')));
    w.chatAddUserMsg('你好');assert.equal(w.chatEl.querySelector('[data-chat-welcome]'),null);assert.ok(w.chatEl.querySelector('[data-confirm-id]'));}finally{dom.window.close();}
});
it('执行中切换会话：允许切，但运行中任务的会话标识不变 ⇒ 结果仍路由回原会话（BASE967-23）',()=>{
  const dom=new JSDOM('',{runScripts:'outside-only'}),w=dom.window as any;
  w.chatRunning=true;w.chatCurSession=0;w.chatRunningConv='conv-a';w.toast=()=>{};
  w.chatSessions=[{id:'a',msgs:[]},{id:'b',msgs:[]}];
  w.chatInput={value:'',focus:()=>{}};
  w.chatWelcome=()=>{};w.chatRenderSessions=()=>{};w.chatCloseFloat=()=>{};w.chatReplaySession=()=>{};
  try{
    w.eval(source.slice(source.indexOf('function chatPickSession('),source.indexOf('/* —— 右上悬浮栏')));
    w.chatPickSession(1);
    // 合并后的口径（BASE967-23，我们线那条）：**运行中也允许切会话** ——
    // 「回复不串到别的会话」靠的是**结果按会话标识路由回原会话**，不是一刀切禁用切换。
    // fast 那版是运行中弹提示挡住切换，与 ours 冲突；合并时保留 ours（源码里也留了同样注记），
    // 判据按新契约改 —— 断言的是「切换被允许」＋「运行中任务的会话标识没被改」。
    assert.equal(w.chatCurSession,1,'运行中切到目标会话是被允许的（不是禁用切换）');
    assert.equal(w.chatRunningConv,'conv-a','运行中任务的会话标识不变 ⇒ 结果仍路由回原会话，不串');
  }finally{dom.window.close();}
});
function mount(){
  const dom=new JSDOM('<div id="body"><div class="txt"></div></div>',{runScripts:'outside-only'}),w=dom.window as any;
  w.esc=(s:unknown)=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  w.chatScrollBottom=()=>{};w.PLATFORM_CHAT_TOOLS=[{id:'files.read',title:'读取文件'}];
  // 合并补注（2026-10-21）：切片起点从 `chatRunProgress` 往前挪到「工具显示名」——
  // 合并后的 `chatAddToolCard` 还会调 `chatToolLabel`（第 512 行）、`chatIsReadTool`、
  // `chatFindReadGroup`/`chatRenderReadGroup`（撤回三态与只读折叠那几件），
  // 它们都在 `chatRunProgress`（第 617 行）**之前** ⇒ 切片里缺，一跑就 ReferenceError。
  // 整段「工具显示名 → 确认卡」一起切进来，这段全是顶层声明，eval 不会碰别的东西。
  w.eval(source.slice(source.indexOf('/* —— 工具显示名'),source.indexOf('/* —— 确认卡')));
  return {dom,w,body:w.document.querySelector('#body')};
}
it('真实阶段与工具按本轮折叠，详情默认隐藏，未知工具不伪造业务名称',()=>{
  const {dom,w,body}=mount();try{
    w.chatRunProgress(body,{label:'读取文件'});w.chatRunProgress(body,{label:'读取文件'});
    w.chatAddToolCard(body,{name:'files.read',arg:'{"file":"合成.xlsx"}',result:'{"count":2}'});
    w.chatFinishRun(body,'done');
    assert.equal(body.querySelectorAll('.chat-run-phase').length,1);
    assert.equal(body.querySelector('details.chat-run').open,false);
    const tool=body.querySelector('.chat-run-tool');assert.equal(tool.open,false);
    assert.match(tool.querySelector('summary').textContent,/读取文件.*返回 2 条/);
    assert.doesNotMatch(tool.querySelector('summary').textContent,/合计|file|\{/);
    assert.match(tool.querySelector('pre').textContent,/合成.xlsx/);
    assert.ok(body.querySelector('.txt'),'回答与确认区不放进执行折叠内');
  }finally{dom.window.close();}
});
it('失败、等待确认、停止和断流不冒报完成；参数作为纯文字展示',()=>{
  const {dom,w,body}=mount();try{
    w.chatAddToolCard(body,{name:'unknown',arg:'<img src=x onerror=alert(1)>',result:'{"ok":false,"error":"无权读取"}'});
    assert.equal(body.querySelector('.chat-run-tool').dataset.status,'error');
    assert.equal(body.querySelector('img'),null);
    for(const [status,label] of [['confirm','等待确认'],['stopped','已停止'],['error','执行中断']]){
      w.chatFinishRun(body,status);assert.match(body.querySelector('.chat-run>summary').textContent,new RegExp(label));
    }
    assert.match(source,/e\.isComposing/,'中文组合输入回车不能发送');
    assert.match(source,/receivedDone/,'流结束缺少done必须标明中断');
  }finally{dom.window.close();}
});
