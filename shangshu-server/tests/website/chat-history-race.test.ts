import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const source=readFileSync(new URL('../../../shangshu-web/js/real-chat.js',import.meta.url),'utf8');
/**
 * ⚠️ `chatSkeleton` / `chatHistorySkeleton` 是 real-chat.js **文件靠前的顶层助手**（第 22 行起），
 *   本文件只把 `chatHasLiveContent()` → `/* ============ 模块入口` 这段切片拿进沙箱跑
 *   ⇒ 抽出来的那段用到骨架助手时，window 上没有 ⇒ **ReferenceError: chatHistorySkeleton is not defined**。
 *   那个异常在**回包之前**就抛了 ⇒ `w.api` 还没被调到 ⇒ `resolve` 还是 undefined
 *   ⇒ 报成「resolve is not a function」（本文件原有的合并补注已经写过这一类连带现象）。
 *   （同类先例：`shangshu-web/js/domains/excel-univer/tests/read-scheduler.test.mjs` ——
 *     抽源码片段在沙箱里跑，片段用到的导入件在沙箱 context 里补上，补的是**真的那个**。）
 */
const skeletonSource=source.slice(source.indexOf('const chatSkeleton ='),source.indexOf('let chatRunning = false;'));
test('迟到历史不冲掉员工已开始的新对话和确认卡',async()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window as any;
 try{
  let resolve:any;w.chatEl=w.document.querySelector('main');w.chatSessions=[];w.chatCurSession=-1;
  w.api=()=>new Promise(r=>resolve=r);w.chatReplaySession=()=>w.chatEl.textContent='旧对话';w.chatRenderSessions=()=>{};
  w.chatWelcome=()=>w.chatEl.textContent='欢迎';w.chatSessionTitle=()=>'';w.chatTimeLabel=()=>'';
  // 合并补注（2026-10-21）：`chatLoadHistory` 在 fast 那条线之后要读两个**模块级**变量，
  // 而它们都声明在切片外面：`chatHasLiveContent`（第 2224 行，刚好落在切片起点之前）、
  // `chatLiveTouched`（第 19 行）、`CHAT_SESSION_GAP_MS`（第 271 行）。
  // 切片只取「chatLoadHistory → 模块入口」 ⇒ 一跑就 ReferenceError（实测 1 条红，
  // 还连累出「resolve is not a function」——那是异常提前抛出、回包没人接的后果）。
  // 补法：切片起点挪到 `chatHasLiveContent`，另外两个用窗口全局补上
  //（`chatLiveTouched` 判据要的就是「用户还没开始交互」这一态）。
  w.eval('var chatLiveTouched=false;var CHAT_SESSION_GAP_MS=25*60*1000;');
  // ⚠️ 先把真的骨架助手补进 window（见文件头的说明），再抽片段跑。
  w.eval(skeletonSource+'\nwindow.chatSkeleton=chatSkeleton;window.chatHistorySkeleton=chatHistorySkeleton;');
  w.eval(source.slice(source.indexOf('function chatHasLiveContent()'),source.indexOf('/* ============ 模块入口')));
  const loading=w.chatLoadHistory();w.chatInteractionGeneration=1;w.chatEl.innerHTML='<div data-confirm-id="new">新提案</div>';
  resolve({json:async()=>({list:[{role:'assistant',content:'旧回复',conversation_id:'old'}]})});await loading;
  assert.ok(w.document.querySelector('[data-confirm-id="new"]'));
 }finally{dom.window.close();}
});
