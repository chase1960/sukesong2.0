import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const source = readFileSync(new URL('../../../shangshu-web/js/real-chat.js', import.meta.url), 'utf8');

/* FIX-10 / CHAT-NEXT-11：收起应用内 Assistant 面板**不得**中止正在进行的回答。
   这一组用例把「面板可见状态」与「请求生命周期」彻底分开：
     · 收起只改可见状态，不 abort、不停工具循环；
     · 收起期间任务还在跑，浮动入口必须看得出「正在处理」；
     · 收起期间生成结束，浮动入口必须留一个看得见的信号（不能悄悄结束）；
     · 只有显式「停止」才 abort；
     · 收起/重开期间不产生任何额外写请求（不自动确认、不自动发邮件）。 */

function slice(from: string, to: string) {
  const a = source.indexOf(from);
  const b = source.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `源码切片定位失败：${from} → ${to}`);
  // 顶层 let/const 在 eval 里只活在这一次 eval 的词法作用域里，
  // 跨切片互相看不见 —— 改成 var 挂到 window 上，各切片才能共用同一份状态。
  return source.slice(a, b).replace(/^(let|const)\s+/gm, 'var ');
}

function mount() {
  const dom = new JSDOM(
    `<div id="ai-copilot"></div>
     <button class="ai-fab" id="ai-fab" type="button"></button>
     <div class="toast-zone" id="toast-zone"></div>
     <button id="send-btn"></button>
     <textarea id="input"></textarea>
     <div id="chat"></div>`,
    {runScripts: 'outside-only', url: 'https://shangshu.localhost/'},
  );
  const w = dom.window as any;
  Object.assign(w, {
    AbortController,
    TextDecoder,
    TextEncoder,
    ic: (body: string) => `<svg viewBox="0 0 24 24">${body}</svg>`,
    ICONS: {spark: '<svg class="spark"></svg>'},
    $: (s: string) => w.document.querySelector(s),
    $$: (s: string, r?: any) => [...(r || w.document).querySelectorAll(s)],
    RENDER: {},
    lastBusinessMod: 'dash',
    curMod: 'dash',
    go: () => {},
    flowEditorFit: () => {},
    currentRole: () => 'user',
    currentUserInfo: {username: 'trial-jia@trial.invalid'},
    chatInitAbilities: () => {},
    chatLoadHistory: () => Promise.resolve(),
    chatLoadPendingConfirmations: () => {},
    chatEnsurePendingCue: () => Promise.resolve(),
    shangshuReviewSource: () => ({kind: 'assistant'}),
    chatScrollBottom: () => {},
    chatSetStatus: () => {},
    chatHideSlash: () => {},
    chatCloseFloat: () => {},
    chatWelcome: () => {},
    chatRender: (x: any) => x,
    chatRenderSessions: () => {},
    esc: (x: any) => String(x),
    chatSessionTitle: () => '',
    chatTimeLabel: () => '',
    chatAddUserMsg: (text: string, layer?: any) => {
      const d = w.document.createElement('div');
      d.className = 'm-user';
      d.textContent = text;
      (layer || w.chatEl).append(d);
    },
    chatAiShell: (thinking: boolean, layer?: any) => {
      const el = w.document.createElement('div');
      el.className = 'm-ai';
      el.innerHTML = '<i class="ava"></i><div class="body"></div>';
      (layer || w.chatEl).append(el);
      return el.querySelector('.body');
    },
    chatSessions: [{id: 'one', msgs: []}, {id: 'two', msgs: []}],
    chatCurSession: 0,
    chatContext: {},
    toast: (title: string, sub?: string) => { w.__toasts.push({title, sub}); },
  });
  w.__toasts = [];
  w.__apiCalls = [];

  // —— 真实实现切片 ——
  w.eval('var CHAT_CHIPS = [{label:"你现在能做什么",text:"说明你现在能协助我做什么"}];');
  w.eval(slice('const CHAT_ICONS = {', 'function chatToggle()'));          // 状态变量 + chatModeButton/chatEnsureMounted/chatSetMode
  w.eval(slice('function chatToggle()', 'const CHAT_PAGE_CONTEXTS'));    // chatUpdateContextBar/chatSetBusinessContext
  w.eval(slice('function chatHeaderHtml()', 'let chatSessions = []'));  // 面板骨架（真实挂载要用）
  w.eval(slice('let chatPendingReviews = new Map()', 'function chatTrackPendingReview'));
  w.eval(slice('function chatUpdateFab()', '/* —— 终止对话'));           // 浮动入口文案与状态
  w.eval(slice('const CHAT_SEND_ICON', '/* —— 模型选择'));               // chatSetStopMode/chatStopGeneration/chatGuardFlow
  // ⚠️ 2026-10-24 12:5x（PKG-085）：产品 2026-10-22（`c83556c2a`）把「引擎 ＋ 模型」**合成一个栏**，
  // `chatModelName()` 里读模块级兄弟 `chatModelState`（`chatModelState?.model`），
  // 而 `chatModelState` 声明在**后面的**「模型选择」块里（real-chat.js:583）
  // ⇒ 判据切片里它不存在 ⇒ `ReferenceError: chatModelState is not defined`
  // ⇒ 凡是挂对话面板的用例一起炸（实测 5 条全红）⇒ 把「模型选择」这一块切进来。
  // ⚠️ 切片只取**这一块**（不取整段 harness 区）：整段会把 `chatScrollBottom` 的真身
  // 一起带进来（它用 `requestAnimationFrame`，沙箱没有）⇒ 又炸一层，且会盖掉沙箱里的桩。
  w.eval(slice('/* —— 模型选择（**并进引擎栏的第二层**', '/* —— 工具卡')); // chatModelState/chatModelSources/chatModelInit/chatRenderModelPicker
  w.eval(slice('function chatAddToSession', 'function chatReplaySession')); // 会话分层与消息落位
  w.eval(slice('async function chatRunMessage', '// 思考过程折叠块'));    // 一轮对话的完整生命周期
  // 合并补注（2026-10-21）：fast 那条线给对话加了「本轮执行记录」，
  // `chatRunMessage` 里会调 `chatRunProgress`/`chatFinishRun` —— 这两个函数定义在
  // real-chat.js 的第 617/638 行，**在「chatRunMessage → 思考过程折叠块」那段切片之外**
  // ⇒ 一跑就 ReferenceError（实测 5 条全红）。把这段实现也切进来。
  w.eval(slice('/* —— fast：本轮执行记录', 'function chatAddToolCard('));  // chatRunProgress / chatFinishRun
  w.eval(slice('function chatSendInput', '/* —— slash'));               // 发送入口（停止键切回发送要用）

  // 真实挂载：对话 DOM 挂一次，形态切换只换 CSS
  w.chatEnsureMounted();

  return {w, close: () => dom.window.close()};
}

/* 起一个「流式回答」，读口挂起，由用例决定何时放行。 */
function startRun(w: any, prompt: string) {
  let release: (v: any) => void;
  const pending = new Promise(r => { release = r; });
  let readOnce = false;
  w.api = async (path: string) => {
    w.__apiCalls.push(String(path));
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => (readOnce ? {done: true} : ((readOnce = true), pending)),
        }),
      },
    };
  };
  const run = w.chatGuardFlow(() => w.chatRunMessage(prompt));
  return {run, release};
}

// —— FIX-10 判据 1：收起不中止 ——
// 测试通过 = 什么成立：流式回答进行中把面板收起，请求**不被 abort**，
// 放行后结果仍落回原会话层（没有「已停止」字样、没有连接失败）。
it('FIX-10 收起面板不中止回答：测试通过 = 收起后请求未被 abort，结果仍落回原会话', async () => {
  const t = mount();
  try {
    const w = t.w;
    const {run, release} = startRun(w, '收起测试');
    await new Promise(r => setTimeout(r, 5));

    w.chatSetMode('hidden');
    assert.equal(w.chatAbort.signal.aborted, false, '收起面板不得 abort 当前请求');
    assert.equal(w.chatMode, 'hidden', '面板进入收起形态');

    release({
      done: false,
      value: new TextEncoder().encode('event: text\ndata: {"delta":"收起后仍然答完"}\n\nevent: done\ndata: {"reply":"收起后仍然答完","reasoning":""}\n\n'),
    });
    w.chatRunning = false;
    await run;

    assert.equal(w.chatSessions[0].msgs.at(-1).content, '收起后仍然答完', '结果落回原会话');
    assert.doesNotMatch(w.chatEl.textContent, /已停止/, '收起不等于停止');
    assert.doesNotMatch(w.chatEl.textContent, /连接失败/, '收起不该造成连接失败');
  } finally { t.close(); }
});

// —— FIX-10 判据 2：收起期间任务还在跑，浮动入口要看得见 ——
// 测试通过 = 什么成立：运行中收起面板，浮动入口（FAB）文字变成「正在处理」并带呼吸点，
// 不再是平时那句「问尚书」—— 用户收起面板后仍知道任务在跑。
it('FIX-10 收起期间浮动入口显示正在处理：测试通过 = FAB 文案为正在处理且带呼吸点', async () => {
  const t = mount();
  try {
    const w = t.w;
    const {run, release} = startRun(w, '运行中收起');
    await new Promise(r => setTimeout(r, 5));

    w.chatSetMode('hidden');
    const fab = w.document.querySelector('#ai-fab');
    const text = fab.textContent || '';
    assert.match(text, /正在处理/, '收起期间 FAB 要说明任务还在跑');
    assert.ok(fab.querySelector('.running'), '收起期间 FAB 要有呼吸点');
    assert.doesNotMatch(text, /问尚书/, '运行中不该显示平时那句「问尚书」');

    release({done: true});
    w.chatRunning = false;
    await run;
  } finally { t.close(); }
});

// —— FIX-10 判据 3：收起期间生成结束要留信号 ——
// 测试通过 = 什么成立：面板收起时生成结束，浮动入口显示「已完成」而不是无声无息；
// 用户重新打开面板后，这个提示消失（看过就不再提示）。
it('FIX-10 收起期间生成结束留可见信号：测试通过 = FAB 显示已完成，打开面板后提示消失', async () => {
  const t = mount();
  try {
    const w = t.w;
    const {run, release} = startRun(w, '收起期间完成');
    await new Promise(r => setTimeout(r, 5));

    w.chatSetMode('hidden');
    release({
      done: false,
      value: new TextEncoder().encode('event: text\ndata: {"delta":"好了"}\n\nevent: done\ndata: {"reply":"好了","reasoning":""}\n\n'),
    });
    w.chatRunning = false;
    await run;

    const fab = w.document.querySelector('#ai-fab');
    assert.match(fab.textContent || '', /已完成/, '收起期间结束要留下可见信号');

    w.chatSetMode('float');
    assert.doesNotMatch(fab.textContent || '', /已完成/, '打开面板看过后提示消失');
    assert.match(w.chatEl.textContent, /好了/, '重开面板能直接看到结果');
  } finally { t.close(); }
});

// —— FIX-10 判据 4：只有显式停止才中止 ——
// 测试通过 = 什么成立：点「停止」才 abort，气泡显示「已停止」，不是「连接失败」。
it('FIX-10 只有显式停止才中止：测试通过 = 点停止后请求被 abort 且显示已停止', async () => {
  const t = mount();
  try {
    const w = t.w;
    w.api = async (_p: any, o: any) => new Promise((_r, j) => o.signal.addEventListener('abort', () => j(Error('aborted'))));
    const run = w.chatGuardFlow(() => w.chatRunMessage('显式停止'));
    await new Promise(r => setTimeout(r, 5));
    w.chatStopGeneration();
    await run;
    assert.equal(w.chatAbort.signal.aborted, true, '显式停止会 abort');
    assert.match(w.chatEl.textContent, /已停止/, '显示已停止');
    assert.doesNotMatch(w.chatEl.textContent, /连接失败/, '停止不该说成连接失败');
  } finally { t.close(); }
});

// —— FIX-10 判据 5：收起/重开不产生额外写请求 ——
// 测试通过 = 什么成立：整轮只有一次对话请求；收起与重开不触发任何确认、发送或保存类请求
// （继续回答不等于继续获准写入）。
it('FIX-10 收起与重开不产生额外写请求：测试通过 = 只有一次对话请求，无确认/发送类请求', async () => {
  const t = mount();
  try {
    const w = t.w;
    const {run, release} = startRun(w, '只发一次');
    await new Promise(r => setTimeout(r, 5));
    w.chatSetMode('hidden');
    w.chatSetMode('float');
    release({
      done: false,
      value: new TextEncoder().encode('event: done\ndata: {"reply":"一次就够","reasoning":""}\n\n'),
    });
    w.chatRunning = false;
    await run;

    const writes = w.__apiCalls.filter((p: string) => !/^api\/chat$/.test(p));
    assert.deepEqual(writes, [], `收起/重开不得发出额外写请求，实际：${JSON.stringify(writes)}`);
    assert.equal(w.__apiCalls.filter((p: string) => p === 'api/chat').length, 1, '对话请求只发一次，不重复');
  } finally { t.close(); }
});
