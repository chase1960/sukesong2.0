/* ============ 模块：对话（P4 实装 · SSE + 能力调用 + 写操作确认）
   同一个对话 DOM 支持悬浮 / 业务分栏 / 全屏三种形态；切换不重建会话。
   查询工具通过 ui_navigate 联动业务页面；写操作确认与 ui_patch 草稿落在业务卡片。 ============ */

const CHAT_ICONS = {
  route: ic('<circle cx="6" cy="18.5" r="2.3"/><circle cx="18" cy="5.5" r="2.3"/><path d="M8.3 17.2C13 14.5 11 9.8 15.8 6.9" stroke-dasharray="2.5 2.2"/>'),
  tag: ic('<path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="9" cy="9" r="1.5"/>'),
  receipt: ic('<path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z"/><path d="M9 8h6M9 12h6"/>'),
  doc: ic('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12.5h6M9 16.5h6"/>'),
  float: ic('<rect x="10" y="11" width="10" height="9" rx="1.5"/><path d="M4 4h16v4"/>'),
  split: ic('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14 4.5v15"/>'),
  full: ic('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/>'),
  min: ic('<path d="M5 12h14"/>'),
  target: ic('<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
};

/* —— **加载态＝骨架**（契约 `loading-state-v1.json`）：对话里凡是要「等一回」的地方，
 *   **不写看得见的字** ⇒ 换成会呼吸的灰条（形状照最终那块内容：几行就是几行）。
 *   `aria-busy` 标在这一块上（读屏的人知道它在等，**不靠一个字**）。
 *   ⚠️ 骨架**套在自己的容器里** ⇒ 数据到了把**内层**换掉就行（外层不动 ⇒ 不跳版）。
 *   ⚠️ 骨架里**不写假内容**：没有假标题、没有假项数、没有假数字。 */
const chatSkeleton = shape => '<div class="platform-skeleton" data-skeleton="'+shape+'" aria-busy="true">'
  +'<span class="platform-skeleton-bar platform-skeleton-panel-line"></span>'
  +'<span class="platform-skeleton-bar platform-skeleton-panel-line short"></span></div>';

/* 历史对话的加载态：照**真的对话流**搭（自己说的靠右、对方说的靠左带个头像位）。
   ⚠️ 宽度用**定宽**的公共灰条（百分比宽度的条在这种气泡里会算不出宽度）。
   ⚠️ 类名 `chat-loading` 留着 —— 后头那句「把 .chat-loading 撤掉」按它找。 */
const chatHistorySkeleton = () => {
  const long='<span class="platform-skeleton-bar platform-skeleton-app-desc"></span>';
  const mid='<span class="platform-skeleton-bar platform-skeleton-app-title"></span>';
  const short='<span class="platform-skeleton-bar platform-skeleton-label"></span>';
  /* 两行字之间留一道缝（真消息的行距）⇒ 两根灰条不粘成一块。 */
  const lines='<span style="display:flex;flex-direction:column;gap:8px">'+long+short+'</span>';
  return '<div class="chat-loading platform-skeleton" data-skeleton="chat-history" aria-busy="true" style="display:flex;flex-direction:column;gap:16px">'
    +'<div class="m-user"><div class="bub">'+mid+'</div></div>'
    +'<div class="m-ai"><span class="ava"></span><div class="body">'+lines+'</div></div>'
    +'<div class="m-user"><div class="bub">'+mid+'</div></div>'
    +'</div>';
};

let chatRunning = false;
let chatBooted = false;
let chatLiveTouched = false;   // R967-D01（BASE967-29）：用户已在本页交互（发消息/新建/切换会话），迟到历史不得覆盖当轮内容
let chatRunningConv = '';      // R967-D01（BASE967-23）：运行中任务的会话标识（结果路由/删除守卫用）
let chatEl = null, chatScroll = null, chatInput = null;
let chatMode = 'hidden';       // hidden | float | split | full
let chatLastMode = localStorage.getItem('shangshu.ai.last-mode') || 'float';
let chatRunNotice = '';        // FIX-10：面板收起期间跑完了 → 浮动入口留一句「已完成」；打开面板看过即清
let chatContext = null;        // 页面弱上下文；事实仍由工具重查
let chatDrafts = [];           // 前端草稿投影；正式写入仍必须走 confirmation
let chatEngine = 'classic';    // 服务端运行时选择，不占用员工的模型位置
let chatEngines = [];         // 可选的 harness 清单（服务端给：原引擎／Pi 等）

async function chatLoadEngines() {
  try {
    const response = await api('api/chat/engines');
    if (!response.ok) return;
    const { engines, default_engine, model } = await response.json();
    if (!Array.isArray(engines)) return;
    // **清单要存下来**（不然页面无从让人选）——2026-10-22 用户要求「把 pi agent
    // 变成可选项，在这里可以选择 harness」。
    chatEngines = engines.filter(e => e && e.id && ['classic','pi'].includes(e.id));
    chatEngine = chatEngines.some(e => e.id === default_engine) ? default_engine : 'classic';
    chatMountEnginePicker();
    chatRenderEnginePicker();
    // 当前模型显示在**引擎栏的第二层**（不再是独立胶囊）。
    const label=$('#engine-model-label');
    if(label){label.textContent=model||'模型未配置';label.title=model||'请联系管理员配置模型';}
  } catch { /* 发现服务失败时保留原引擎，不能伪装 Pi 可用 */ }
}

function chatModeButton(mode, title, icon) {
  return `<button class="copilot-mode ${chatMode === mode ? 'on' : ''}" data-ai-mode="${mode}" type="button" title="${title}" onclick="chatSetMode('${mode}')">${icon}</button>`;
}

let chatHistoryReady = null;
function chatEnsureMounted() {
  const host = $('#ai-copilot');
  if (!host) return false;
  if (!host.querySelector('.chat-main')) {
    host.innerHTML = chatMarkup();
    chatEl = $('#chat'); chatScroll = $('#chat-scroll'); chatInput = $('#input');
    chatInput.addEventListener('keydown', e => {
      /* 输入法组字中（isComposing / keyCode 229）：Enter 是选字不是发送，也不当 Esc 关浮窗。
         ours 的条件是 `!e.isComposing && e.keyCode !== 229`，fast 的是提前 return —— 同义。 */
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSendInput(); }
      if (e.key === 'Escape') { chatHideSlash(); chatCloseFloat(); }
    });
    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
      if (chatInput.value === '/') chatShowSlash(); else chatHideSlash();
    });
    chatInitAbilities();
    chatLoadEngines();
    if (!chatBooted) { chatBooted = true; chatHistoryReady = chatLoadHistory(); }
  } else {
    chatEl = $('#chat'); chatScroll = $('#chat-scroll'); chatInput = $('#input');
  }
  chatUpdateContextBar();
  return true;
}
function chatSetMode(mode) {
  if (!chatEnsureMounted()) return;
  if (!['hidden', 'float', 'split', 'full'].includes(mode)) return;
  const opening = chatMode === 'hidden' && mode !== 'hidden';
  if (mode !== 'hidden') {
    chatLastMode = mode;
    localStorage.setItem('shangshu.ai.last-mode', mode);
  }
  chatMode = mode;
  const host = $('#ai-copilot');
  host.className = `ai-copilot workspace-card${mode === 'hidden' ? '' : ' mode-' + mode}`;
  $$('[data-ai-mode]', host).forEach(b => b.classList.toggle('on', b.dataset.aiMode === mode));
  const fab = $('#ai-fab');
  if (fab) {
    fab.classList.toggle('show', mode === 'hidden');
    chatUpdateFab();
  }
  // 从全屏切成悬浮/分栏时，恢复上一次业务页面；同一 chat DOM 不重建。
  if (mode !== 'full' && mode !== 'hidden' && curMod === 'chat') {
    const target = RENDER[lastBusinessMod] ? lastBusinessMod : 'dash';
    go(target);
  }
  // AI 形态改变会重排业务卡宽度；让流程图在过渡结束后重新完整适配。
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
    if (typeof flowEditorFit === 'function') flowEditorFit();
  }, 220);
  chatScrollBottom();
  if (opening) {
    // 看过结果了，就把浮动入口上的「已完成」撤掉（别一直挂着）。
    if (chatRunNotice) { chatRunNotice = ''; chatUpdateFab(); }
    void chatEnsurePendingCue(true);
  }
}
function chatToggle() { chatSetMode(chatMode === 'hidden' ? chatLastMode : 'hidden'); }
function chatRevealBusiness() {
  // 用户从全屏对话点业务导航时，自动转为分栏，保证目标页面立刻可见。
  if (chatMode === 'full') chatSetMode('split');
}

function chatUpdateContextBar() {
  const bar = $('#copilot-context');
  if (!bar) return;
  bar.classList.toggle('show', !!chatContext);
  const text = bar.querySelector('.text');
  if (text) text.textContent = chatContext ? `正在看：${chatContext.label}` : '';
  if (chatInput) chatInput.placeholder = chatContext
    ? `针对「${chatContext.label}」提问…`
    : '吩咐工作，或输入 / 查看可用能力…';
}
/**
 * 「当前上下文」上报给服务端（**内核机制**，2026-10-21）。
 *
 * 为什么要有这条通道：以前上下文只在**发消息那一刻**随请求带上去 ——
 * 用户中途切页/切信/改选区，下一轮模型看到的还是旧的。
 * 现在服务端存着**这个会话的一份权威份**，前端**每次变化**就推一份过去（后到的覆盖先到的），
 * 下一轮直接用服务端那份 —— agent 不用等用户再开口才知道用户换了页面。
 *
 * ⚠️ 别做成高频洪水：选区一动就报 ⇒ 用**短延迟合并 + 值没真变不报**两道闸。
 * 推的内容**只有用户屏幕上已经看得到的那部分**，且有上限；服务端还会按当前身份再核一遍读权。
 */
/* —— **上下文推送的合并窗口**（2026-10-30 性能：开表时白发一次）。
   开表那一刻会**连着推两次**（业务上下文变了 ＋ 第一次选中变化）
   ⇒ 400ms 的窗口**挡不住**（两次相隔 420ms）⇒ 白白发一次 `chat/context`。
   ⇒ 放大到 1200ms ⇒ **合成一次**。
   ⚠️ **放大不会丢上下文**：**发消息前有一道「立刻冲刷」**
   （`chatContextPushPending` ⇒ 发信前先推出去）⇒ 人问话时那份上下文一定在。 */
const CHAT_CONTEXT_PUSH_DELAY_MS = 1200;
let chatContextPushTimer = null;
let chatContextPushed = '';        // 上一份**已经推出去**的上下文（用来判「值真的变了」）
let chatContextPushedFor = '';     // 上面那份是**哪个会话**的（换会话要重推）
let chatContextPushPending = false;

function chatCurrentConversationId() {
  const session = chatSessions && chatCurSession >= 0 ? chatSessions[chatCurSession] : null;
  return session && session.id ? String(session.id) : '';
}
/** 上下文里**参与比较**的字段（**不含** updated_at —— 那是时间戳，不是业务变化）。 */
function chatContextFingerprint(context) {
  if (!context) return '';
  try {
    const { updated_at, ...rest } = context;
    void updated_at;
    return JSON.stringify(rest);
  } catch { return ''; }
}
function chatPushContextNow() {
  chatContextPushTimer = null;
  chatContextPushPending = false;
  const context = chatContext;
  const conversationId = chatCurrentConversationId();
  const fingerprint = chatContextFingerprint(context);
  // 值没真变（且还是同一个会话）⇒ 不报 —— 这是**防洪水**的第二道闸。
  if (fingerprint === chatContextPushed && conversationId === chatContextPushedFor) return Promise.resolve(false);
  chatContextPushed = fingerprint;
  chatContextPushedFor = conversationId;
  if (typeof api !== 'function') return Promise.resolve(false);
  try {
    // 不 await：上报是**后台**的，不许挡住用户界面。
    return Promise.resolve(api('api/chat/context', {
      method: 'POST',
      // 没有上下文时推一份**空的** —— 服务端那份要作废，不能留着上一页的旧上下文。
      body: JSON.stringify({ conversation_id: conversationId, ui_context: context || { label: '' } }),
    })).then(() => true).catch(() => false);
  } catch { return Promise.resolve(false); }
}
/** 合并短时间内的多次变化（选区连点、连续切页）—— 只推最后那一份。 */
function chatScheduleContextPush() {
  chatContextPushPending = true;
  if (chatContextPushTimer) return;
  chatContextPushTimer = setTimeout(() => { void chatPushContextNow(); }, CHAT_CONTEXT_PUSH_DELAY_MS);
}
function chatSetBusinessContext(context) {
  // updated_at = 这一份上下文是**什么时候**产生的 ——
  // 服务端靠它判断「后来的那份」才覆盖先来的那份（防「旧的推送晚到，把新的覆盖掉」）。
  chatContext = context && context.label ? { ...context, updated_at: Date.now() } : null;
  chatUpdateContextBar();
  chatScheduleContextPush();
}
// 通用页面 → AI：把当前对象/元数据/选中节点交给助手，再由助手调用 object_* / metadata_* 重查。
// 这里只负责打开副驾驶和组织意图，不允许页面直接让 AI 写库。
function chatAssist(context, prompt) {
  chatSetBusinessContext(context);
  chatSetMode('split');
  chatGuardFlow(() => chatRunMessage(prompt));
}
window.chatAssist = chatAssist;
function chatClearContext() {
  chatContext = null;
  chatUpdateContextBar();
  // 服务端那份也要作废 —— 不然 agent 还拿着上一页的旧上下文。
  chatScheduleContextPush();
}
const CHAT_PAGE_CONTEXTS = Object.freeze({
  dash:{label:'工作台',view:'overview',editable_scope:'查看我的待办、任务、常用应用和最近事项'},
  applications:{label:'应用',view:'application-list',editable_scope:'查看已启用应用并进入业务办理；写操作仍需确认'},
  objects:{label:'数据',view:'dataset-list',editable_scope:'查询当前权限范围内的业务记录；修改必须走确认提案'},
  flowdesign:{label:'待办',view:'pending',editable_scope:'查看可发起流程、待办和实例；办理动作仍需确认'},
  'task-mgmt':{label:'任务',view:'list',editable_scope:'查询和处理当前权限范围内的任务；写操作仍需确认'},
  im:{label:'消息',view:'conversation-list',editable_scope:'查看会话；发送消息或转任务须遵守确认契约'},
  'app-design':{label:'应用设计',view:'design',editable_scope:'设计应用资源；保存、启停和发布必须明确确认'},
  apps:{label:'应用管理',view:'management',editable_scope:'查看和管理业务应用；核心系统组件不可停用'},
  'ai-tools':{label:'AI 工具',view:'catalog',editable_scope:'查看当前企业和账号实际可用的受管工具'},
  modules:{label:'模块管理',view:'management',editable_scope:'管理正式注册且当前角色可访问的模块'},
  config:{label:'系统设置',view:'settings',editable_scope:'查看集成配置；密钥和写操作必须明确确认'},
});
function chatDefaultPageContext(moduleId = curMod) {
  if (!moduleId || moduleId === 'chat') return null;
  const preset = CHAT_PAGE_CONTEXTS[moduleId] || {};
  const title = $('#main .page-hd h1, #main h1')?.textContent?.trim();
  const navName = typeof findWorkspaceItem === 'function' ? findWorkspaceItem(moduleId)?.name : '';
  return {
    module:moduleId,
    entity_type:'page',
    entity_id:moduleId,
    label:title || preset.label || navName || '当前页面',
    view:preset.view || 'page',
    editable_scope:preset.editable_scope || '解释当前页面并按权限查询；写操作仍需确认',
  };
}
function chatRefreshContext() {
  void chatEnsurePendingCue();
  // 同一页已经上报了应用、实例、任务或会话等更具体上下文时保留它；
  // 首次进入页面或跨页导航则由产品壳自动补齐页面级上下文。
  if (chatContext?.module === curMod && chatContext.entity_type !== 'page') return;
  chatSetBusinessContext(chatDefaultPageContext(curMod));
}

/* 分栏拖拽：24%~60%，宽度写在 workspace CSS 变量中。 */
function chatBindSplitter() {
  const sp = $('#ai-splitter'), shell = $('#workspace-shell');
  if (!sp || !shell || sp.dataset.bound) return;
  sp.dataset.bound = '1';
  let dragging = false;
  sp.addEventListener('pointerdown', e => {
    dragging = true; sp.classList.add('dragging'); sp.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
  });
  sp.addEventListener('pointermove', e => {
    if (!dragging) return;
    const r = shell.getBoundingClientRect();
    const pct = Math.min(60, Math.max(24, (r.right - e.clientX) / r.width * 100));
    shell.style.setProperty('--ai-panel-width', pct.toFixed(1) + '%');
  });
  const stop = () => {
    dragging = false; sp.classList.remove('dragging');
    document.body.style.cursor = ''; document.body.style.userSelect = '';
  };
  sp.addEventListener('pointerup', stop);
  sp.addEventListener('pointercancel', stop);
}

/* 业务对象 → 对话上下文：模块可提供 data-ai-*；没有标注时退化为当前行文本。 */
function chatBindBusinessContext() {
  const main = $('#main');
  if (!main || main.dataset.aiContextBound) return;
  main.dataset.aiContextBound = '1';
  main.addEventListener('click', e => {
    const target = e.target.closest('[data-ai-label],tr.row-link');
    if (!target) return;
    const label = target.dataset.aiLabel
      || target.querySelector('b')?.textContent?.trim()
      || target.textContent.replace(/\s+/g, ' ').trim().slice(0, 48);
    chatSetBusinessContext({
      module:curMod,
      entity_type:target.dataset.aiEntity || '',
      entity_id:target.dataset.aiId || '',
      label,
    });
  });
}
function chatHeaderHtml() {
  return `<div class="copilot-head">
    <div class="copilot-title"><span class="wave"><i></i><i></i><i></i></span>尚书 AI</div>
    <div class="copilot-modes">
      <button class="copilot-mode" type="button" title="新建对话" aria-label="新建对话" onclick="chatNewSession()">＋</button>
      <button class="copilot-mode js-chat-float-btn" type="button" title="对话历史 · 可用能力" onclick="chatToggleFloat()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg></button>
      ${chatModeButton('float', '悬浮', CHAT_ICONS.float)}
      ${chatModeButton('split', '左右分栏', CHAT_ICONS.split)}
      ${chatModeButton('full', '全屏对话', CHAT_ICONS.full)}
      ${chatModeButton('hidden', '最小化（任务继续）', CHAT_ICONS.min)}
    </div>
  </div>
  <div class="copilot-context" id="copilot-context">
    ${CHAT_ICONS.target}<span class="text"></span>
    <button class="close" type="button" title="清除业务上下文" onclick="chatClearContext()">×</button>
  </div>`;
}
function chatMarkup() {
  const adminCanSwitch = (typeof currentRole === 'function') && currentRole() === 'admin';
  return `<div class="chat-main">
    ${chatHeaderHtml()}
    <div class="chat-float-panel" id="chat-float-panel" style="display:none">
      <button class="chat-float-new" onclick="chatNewSession()">＋ 新建对话</button>
      <div class="chat-float-hd">最近对话</div>
      <div class="chat-float-sess" id="chat-float-sess"></div>
      <div class="chat-float-hd">可用能力</div>
      <div class="chat-float-abs" id="chat-float-abs"></div>
    </div>
    <div class="chat-scroll" id="chat-scroll"><div class="chat-inner" id="chat"></div></div>
    <div class="chat-input-wrap">
      <div class="chat-status" id="chat-status"><span class="st-dot"></span><span id="chat-status-text">数字分身 · 思考中…</span></div>
      <div class="slash-menu" id="slash-menu" style="display:none"><div class="slash-hd">可用能力</div><div id="slash-list"></div></div>
      <div class="input-box">
        <textarea id="input" rows="1" placeholder="吩咐工作，或输入 / 查看可用能力…"></textarea>
        <div class="chat-attach-list" id="chat-attach-list" hidden></div>
        <div class="input-bar">
          <button class="ib-btn" id="chat-upload-btn" hidden title="上传附件给助手" onclick="document.getElementById('chat-inv-file').click()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.2-9.19a4 4 0 015.65 5.66l-9.2 9.19a2 2 0 01-2.82-2.83l8.49-8.48"/></svg></button>
          <input type="file" id="chat-inv-file" accept=".pdf,.docx,.xlsx,.txt,.md,.csv,.zip,.xml,image/*" style="display:none" onchange="chatAttachFile(this)">
          <button class="ib-btn" title="使用建议" onclick="chatSendChip(CHAT_CHIPS[0]?.text || '说明你现在能协助我做什么')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></button>
          <button class="ib-btn" title="输入 / 查看可用能力" onclick="chatShowSlash()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
          <span class="ib-hint"><b>Enter</b> 发送 · <b>/</b> 能力</span>
          ${chatEnginePickerMarkup()}
          <button class="send-btn" id="send-btn" title="发送" onclick="chatSendInput()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3L3 10.3l7.2 2.7L12.9 21z"/><path d="M21 3L10.2 13"/></svg></button>
        </div>
      </div>
    </div>
  </div>`;
}

/* —— 会话模型（前端按时间间隔近似分组，无后端会话概念） —— */

/* —— harness（对话引擎）＋ 模型 —— **合成一个栏** ——
   **为什么要有**（2026-10-22 用户原话）：「**把 pi agent 变成可选项**在这里，
   可以选择 harness，也可以选择模型。」

   **为什么合成一个栏**（同日 12:14 用户指截图说「太丑了」）：
   「agent 图上这两块能不能合并……我建议就合并成一个栏，
     **先选 harness，选完会风琴式下拉出模型**，这样就能保证选择了。」
   ⇒ 之前是两个并排胶囊（引擎 ＋ 模型），挤在一起、且模型那一颗在非管理员那里是死读的。

   **现在的样子**：输入栏**只有一个**胶囊（显示「引擎 · 模型」）⇒ 点开是**两层**：
   · **第一层：引擎**（原引擎／Pi 试用）—— 人人能选（执行环境选择）；
   · **第二层：模型** —— 选中引擎后**在下面展开**（风琴式）；
     模型层**只有管理员能改**（非管理员看到当前模型的只读那一行）。
   ⚠️ **引擎与模型是正交的**（Pi 也能用 mimo）⇒ 模型清单**不按引擎分**，
      只是**位置**并进了引擎栏。
   ⚠️ 复用模型选择器那套观感（`.model-pill` / `.model-picker`）——**不自造一套**。 */
function chatEnginePickerMarkup() {
  const engineLabel = (chatEngines||[]).find(e => e.id === chatEngine);
  const engineText = engineLabel ? (engineLabel.label || engineLabel.id) : '';
  return `<span class="model-ctl engine-ctl">
    <button type="button" class="model-pill engine-pill" id="engine-pill" title="对话引擎（harness）与模型" onclick="toggleEnginePicker()"><span id="engine-pill-label">${esc(engineText||'引擎')}</span><span class="engine-sep">·</span><span id="engine-model-label" class="engine-model-label">${esc(chatModelName()||'模型')}</span><svg class="mp-caret" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>
    <div class="model-picker engine-picker" id="engine-picker" style="display:none">
      <div class="mp-hd">对话引擎（harness）</div>
      <div id="ep-list"></div>
      <div class="engine-models" id="engine-models">
        <div class="mp-hd">模型</div>
        <div id="mp-list"></div>
        <div class="mp-foot"><button type="button" class="mp-manage" onclick="cfgJumpToModel()">⚙ 管理模型配置…</button></div>
      </div>
    </div>
  </span>`;
}

/** 当前模型名（胶囊上显示的那一半）。 */
function chatModelName() {
  if (chatModelState?.model) return chatModelState.model;
  const label = $('#engine-model-label');
  return label ? label.textContent : '';
}

/* —— 风琴：第一层引擎，第二层模型（**模型层默认收起**，选中引擎才展开） —— */
function chatRenderEnginePicker() {
  const list = $('#ep-list');
  if (!list) return;
  const adminCanSwitch = (typeof currentRole === 'function') && currentRole() === 'admin';
  list.innerHTML = (chatEngines||[]).map(e => {
    const on = e.id === chatEngine;
    return `<button type="button" class="mp-item${on ? ' on' : ''}" onclick="chatApplyEngine('${esc(e.id)}')"><b>${esc(e.label||e.id)}</b><i>${esc(e.id)}</i></button>`;
  }).join('');
  // 第二层：**只有管理员能改模型**；非管理员看到当前模型的只读一行。
  const modelList = $('#mp-list');
  if (modelList) {
    if (!adminCanSwitch) {
      modelList.innerHTML = `<div class="mp-item model-readonly-item"><b>${esc(chatModelName()||'读取模型…')}</b><i>由管理员配置</i></div>`;
    } else {
      modelList.innerHTML = (chatModelSources||[]).map(s => {
        const active = chatModelState || {};
        const on = s.provider === active.provider && s.base_url === active.base_url && s.model === active.model;
        return `<button type="button" class="mp-item${on ? ' on' : ''}" onclick="chatApplyModel('${esc(s.id)}')"><b>${esc(s.name)}</b><i>${esc(s.model)}</i></button>`;
      }).join('') || '<div class="mp-empty">还没有保存的模型来源，请在「管理模型配置」里添加。</div>';
    }
  }
  chatSyncEngineModelLayer();
}

/** 第二层（模型）的**风琴展开状态**：默认收起；选完引擎才展开（用户 12:14 原话）。 */
function chatSyncEngineModelLayer(expanded) {
  const layer = $('#engine-models');
  if (!layer) return;
  const open = expanded === undefined ? layer.dataset.open === '1' : !!expanded;
  layer.dataset.open = open ? '1' : '0';
  layer.classList.toggle('open', open);
  layer.classList.toggle('collapsed', !open);
}

/* 引擎清单是**后到的**（`chatLoadEngines()` 不阻塞渲染）⇒ 胶囊得**后补**，
   否则页面先画完、清单才到 ⇒ 选择器永远不出现（2026-10-22 实测踩到）。 */
function chatMountEnginePicker() {
  const host = document.querySelector('.input-bar');
  if (!host) return;
  const existing = $('#engine-pill');
  if (!chatEngines || chatEngines.length < 2) {
    // 只有 ≤1 个引擎 ⇒ **撤掉选择器**（没得选就别装个样子）。
    if (existing) existing.closest('.engine-ctl')?.remove();
    return;
  }
  if (existing) { chatRenderEnginePicker(); return; }
  const tip = host.querySelector('.ib-hint');
  const html = chatEnginePickerMarkup();
  if (!html) return;
  const holder = document.createElement('span');
  holder.innerHTML = html;
  const node = holder.firstElementChild;
  if (tip && tip.nextSibling) host.insertBefore(node, tip.nextSibling);
  else host.appendChild(node);
}

async function chatApplyEngine(id) {
  if (!(chatEngines||[]).some(e => e.id === id)) {
    toast('切换失败', '这个对话引擎当前不可用');
    return;
  }
  chatEngine = id;
  const active = chatEngines.find(e => e.id === id);
  const label = $('#engine-pill-label');
  const icon = $('#engine-pill .mp-ico');
  if (label) label.textContent = active ? (active.label || active.id) : id;
  // 图标也跟着换（⚠️ 2026-10-22 实测：只换文字、图标还是上一个引擎的 ⇒ 看不出来）。
  if (icon) icon.textContent = String((active ? (active.label || active.id) : id)).slice(0, 2);
  // **风琴**：选完引擎 ⇒ 下面展开模型层（用户 12:14 原话：「先选 harness，选完会风琴式下拉出模型」）。
  chatRenderEnginePicker();
  chatSyncEngineModelLayer(true);
  const picker = $('#engine-picker');
  if (picker) picker.style.display = 'block';
  toast('已切换对话引擎', `${active ? (active.label || active.id) : id}；下一条消息生效`);
}

let chatSessions = [];       // [{ title, time, msgs: [{role, content}] }]
let chatCurSession = -1;     // 当前会话下标，-1 = 新会话
const CHAT_SESSION_GAP_MS = 25 * 60 * 1000;   // 超过 25 分钟视为新会话

const wait = ms => new Promise(r => setTimeout(r, ms));
function chatScrollBottom() { requestAnimationFrame(() => { if (chatScroll) chatScroll.scrollTop = chatScroll.scrollHeight; }); }
/* —— 阶段透传：状态行显示「正在做什么 + 已耗时秒数」，让等待可见 —— */
let chatPhaseTimer = null, chatPhaseStart = 0;
function chatSetStatus(thinking, text) {
  const modelButton=$('#engine-pill');if(modelButton)modelButton.disabled=!!thinking;
  const st = $('#chat-status');
  if (!st) return;
  if (chatPhaseTimer) { clearInterval(chatPhaseTimer); chatPhaseTimer = null; }
  st.classList.toggle('show', !!thinking);
  if (thinking) {
    chatPhaseStart = Date.now();
    const tick = () => {
      const el = $('#chat-status-text');
      if (el) el.textContent = (text || '处理中') + ' · ' + ((Date.now() - chatPhaseStart) / 1000).toFixed(1) + 's';
    };
    tick();
    chatPhaseTimer = setInterval(tick, 200);
  } else {
    $('#chat-status-text').textContent = text || '数字分身 · 在线';
  }
}
function chatAddUserMsg(text, layer, attachments) {
  window.chatInteractionGeneration=(window.chatInteractionGeneration||0)+1;
  chatEl.querySelector('[data-chat-welcome]')?.remove();
  const m = document.createElement('div');
  m.className = 'msg m-user';
  // 附件**看得见**（用户 2026-10-22 12:53：要能传图片等附件 ⇒ 传了要看得见传了什么）。
  // 还要看得见它**落在文件中心的哪一条**（文件编号）⇒ 业务域/工具能引用同一份，不重传。
  const names = (attachments||[]).map(a=>`<span class="chat-attach-chip" title="${esc(a.name)}｜文件中心文件编号：${esc(a.file || '')}">📎 ${esc(a.name)}`
    +`<span class="chat-attach-loc">文件中心</span></span>`).join('');
  m.innerHTML = `<div class="bub">${esc(text)}</div>` + (names ? `<div class="chat-attach-list">${names}</div>` : '');
  (layer || chatCurrentLayer()).appendChild(m); chatScrollBottom();
}
// R967-D01（BASE967-11/28）：结构化工具回执驱动执行事实，四态严格区分
// —— **2026-10-19 CHAT-NEXT-01：那张黄色汇总卡整块撤掉**（用户 20:38 截图明确取消）。
// 撤的是**这块界面**，不是执行事实：工具失败仍在对应工具卡上、撤回三态仍在撤回卡上、
// 候选仍在确认卡上、日志仍逐条保留。唯一需要单独留的是「这一轮没得到有效回答」——
// 那要给一条重试入口，但它是**空回答的补救**，不是那张汇总卡。
function chatAddRetryAffordance(body, retryText) {
  if (!body || !retryText) return;
  const row = document.createElement('div');
  row.className = 'chat-retry-row';
  const b = document.createElement('button');
  b.className = 'cf-btn ok';
  b.type = 'button';
  b.textContent = '重试';
  b.onclick = () => { row.remove(); chatGuardFlow(() => chatRunMessage(retryText)); };
  row.appendChild(b);
  body.appendChild(row);
  chatScrollBottom();
}
function chatAiShell(thinking, layer) {
  const m = document.createElement('div');
  m.className = 'msg m-ai';
  // AI 标识：声波三条（--acc，无框无背景）；thinking=流式生成中 → 三条错相位波动
  m.innerHTML = `<div class="ava${thinking ? ' thinking' : ''}"><i></i><i></i><i></i></div><div class="body"></div>`;
  (layer || chatCurrentLayer()).appendChild(m); chatScrollBottom();
  return m.querySelector('.body');
}
function chatUpdateFab() {
  const fab = $('#ai-fab');
  if (!fab) return;
  const total = chatPendingReviews.size;
  fab.dataset.pendingReviews = String(total);
  // BASE967-32：角标只给绿（Assistant）/蓝（自动化）来源计数——不放来源提示点、不放任何候选值；
  // 点击只打开助手（独立待审目录已移除），待办找回走原对话恢复与目标原位。
  const kinds = { assistant: 0, automation: 0 };
  for (const [, item] of chatPendingReviews) if (Object.hasOwn(kinds, item.kind)) kinds[item.kind]++;
  const chip = (kind, name) => kinds[kind] ? `<span data-review-kind="${kind}" title="${name} ${kinds[kind]} 条" aria-label="${name} ${kinds[kind]} 条">${kinds[kind]}</span>` : '';
  // FIX-10（CHAT-NEXT-11）：面板收起后，浮动入口就是用户唯一的「它还在跑吗」线索。
  // 三种可见状态：**运行中**（呼吸点）、**收起期间跑完了**（对勾）、平时那句「问尚书」。
  // 收起只改可见状态、不中止请求（请求生命周期归 chatAbort 管，只有「停止」才 abort）。
  const running = chatRunning;
  const notice = running ? '' : chatRunNotice;
  const state = running
    ? '<i class="running" aria-hidden="true"></i>'
    : (notice ? '<i class="done" aria-hidden="true">✓</i>' : '');
  const label = running ? '正在处理' : (notice || '问尚书');
  fab.innerHTML = `${ICONS.spark}<span>${label}</span>${state}${chip('assistant', 'Assistant')}${chip('automation', '代码自动化')}${chatCueUnavailable ? '<span class="ai-pending-unavailable">待审待核</span>' : ''}`;
  fab.title = running
    ? '尚书助手正在处理中，点开查看进度'
    : (notice
      ? `回答${notice}，点开查看结果`
      : (total ? `已列出的待审核：${total} 条${chatCueCapped ? '（仅列前 200 条）' : ''}` : chatCueUnavailable ? '待审核暂不可读取，打开助手后重试' : '打开尚书助手'));
  fab.setAttribute('aria-label', fab.title);
  fab.onclick = () => { chatSetMode(chatLastMode === 'hidden' ? 'float' : chatLastMode); };
}
/* —— 终止对话（2026-08-28）：运行中发送钮变停止钮；点停止 abort 当前请求，后端同步断 LLM 拉取 —— */
const CHAT_SEND_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3L3 10.3l7.2 2.7L12.9 21z"/><path d="M21 3L10.2 13"/></svg>';
const CHAT_STOP_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="currentColor"/></svg>';
let chatAbort = null;
function chatSetStopMode(on) {
  const b = $('#send-btn');
  if (!b) return;
  b.classList.toggle('stopping', on);
  b.disabled = false;
  b.title = on ? '停止生成' : '发送';
  b.innerHTML = on ? CHAT_STOP_ICON : CHAT_SEND_ICON;
  b.onclick = on ? chatStopGeneration : chatSendInput;
}
function chatStopGeneration() { try { chatAbort?.abort(); } catch { /* already */ } }

async function chatGuardFlow(fn) {
  if (chatRunning) { toast('Agent 正在执行', '当前任务完成后再来吩咐'); return; }
  chatRunning = true; chatSetStopMode(true); chatUpdateFab();
  try { await fn(); } finally {
    // FIX-10：面板收起时这一轮结束了 → 浮动入口留一个看得见的信号，
    // 否则用户收起面板后就再也等不到「好了」这句话。打开面板看过即清。
    const collapsed = chatMode === 'hidden';
    chatRunning = false; chatRunningConv = ''; chatSetStopMode(false); chatSetStatus(false);
    if (collapsed) {
      chatRunNotice = chatAbort?.signal?.aborted ? '已停止' : '已完成';
      toast(chatRunNotice === '已停止' ? '生成已停止' : '回答已完成', '点右下角「尚书」入口查看');
    } else {
      chatRunNotice = '';
    }
    chatUpdateFab();
  }
}

/* —— 模型选择（**并进引擎栏的第二层**；仅管理员可切换全局模型配置） ——
   ⚠️ 2026-10-22 12:14 用户指截图说「这两块太丑」⇒ 模型胶囊**不再单独摆**，
   它落到引擎栏的**第二层**（风琴式：先选引擎，再展开模型）。
   ⇒ 数据源与动作**没变**（还是 `api/config` 的 `llm_sources` ＋ `api/config/llm/apply`），
   只是**位置**变了。 */
let chatModelState = null;   // { provider, base_url, model }
let chatModelSources = [];   // 模型来源：各自带地址与密钥，切换整条套用
async function chatModelInit() {
  try {
    const c = await apiJSON('api/config');
    chatModelState = c?.llm || null;
    chatModelSources = Array.isArray(c?.llm_sources) ? c.llm_sources : [];
    const label = $('#engine-model-label');
    if (label) label.textContent = chatModelState?.model || '模型';
  } catch (e) {
    const label = $('#engine-model-label');
    if (label) label.textContent = '模型';
  }
}
/** 模型层的渲染（在引擎栏的第二层里）——复用同一份 `chatModelSources`。 */
function chatRenderModelPicker() {
  chatRenderEnginePicker();
}
/** 展开/收起引擎栏（连带它的第二层模型）。 */
async function toggleEnginePicker() {
  const picker = $('#engine-picker');
  if (!picker) return;
  const willShow = picker.style.display === 'none';
  picker.style.display = willShow ? 'block' : 'none';
  if (willShow) {
    await chatModelInit();   // 重新同步服务器当前模型，避免胶囊标签与实际配置不一致
    chatRenderEnginePicker();
  }
}
/** 旧入口保留：别处若还在调它，转到引擎栏（不报错）。 */
async function toggleModelPicker() {
  return toggleEnginePicker();
}
async function chatApplyModel(id) {
  const s = chatModelSources.find(x => x.id === id);
  if (!s) return;
  const picker = $('#engine-picker');
  if (picker) picker.style.display = 'none';
  const label = $('#engine-model-label');
  try {
    await submitJSON('api/config/llm/apply', { id }, 'POST');
    chatModelState = { provider: s.provider, base_url: s.base_url, model: s.model };
    if (label) label.textContent = s.model;
    toast('已切换模型', `${s.name} · ${s.model}；重新提问生效`);
  } catch (e) {
    toast('切换失败', e.message);
  }
}
// 模型胶囊 → 配置页 AI 与模型区（deep-link）
function cfgJumpToModel() {
  toggleEnginePicker();
  window.__cfgTab = 'ai';
  if (typeof go === 'function') go('config');
  else location.hash = '#/config';
}

/* —— 工具卡（真实：SSE tool 事件直接渲染结果摘要，不做动画演出） —— */
/* —— 工具显示名（CHAT-NEXT-03）：默认界面只说人话，**不外露内部标识** ——
   用户 2026-10-19 20:38 截图里那串 `platform_platform_object_query` 就是这么来的。
   口径：
     · **已注册工具** → 固定中文动作名；
     · **未知名称回退** → 剥掉 platform_/files_/mail_/editor_ 前缀按尾巴查；查不到给「系统动作」；
       **绝不打印原始标识**（原名只允许出现在「按需展开的详情」里）。
   两个口径**都不得**把原始长标识印在默认态——这是 CHAT-NEXT-03 的验收判据。 */
const CHAT_TOOL_LABELS = Object.freeze({
  platform_resource_read: '读取数据',
  platform_platform_object_query: '查询记录',
  platform_action_call: '执行操作',
  platform_action_schema: '查看操作说明',
  platform_action_propose: '准备操作建议',
  platform_action_execute: '执行操作',
  platform_files_sheet_range_read: '读取表格',
  platform_files_sheet_view_read: '读取表格视图',
  platform_files_sheet_cells_write: '修改表格值',
  platform_files_sheet_input_write: '填写表格',
  platform_files_sheet_paste_apply: '粘贴表格内容',
  platform_files_sheet_cells_undo: '撤回改动',
  platform_files_sheet_column_append: '新增列',
  platform_files_sheet_row_append: '新增行',
  platform_mail_save_draft: '准备邮件草稿',
  platform_mail_send: '提交发信请求',
  editor_undo: '撤回改动',
});
/* 尾巴口径：剥前缀后按这一份查。查不到就走「系统动作」回退，不回退到原始名。 */
const CHAT_TOOL_LABEL_TAILS = Object.freeze({
  resource_read: '读取数据',
  platform_object_query: '查询记录',
  object_query: '查询记录',
  object_list: '列出资料',
  action_call: '执行操作',
  action_schema: '查看操作说明',
  action_propose: '准备操作建议',
  action_execute: '执行操作',
  sheet_range_read: '读取表格',
  sheet_view_read: '读取表格视图',
  sheet_cells_write: '修改表格值',
  sheet_input_write: '填写表格',
  sheet_paste_apply: '粘贴表格内容',
  sheet_cells_undo: '撤回改动',
  sheet_column_append: '新增列',
  sheet_row_append: '新增行',
  mail_save_draft: '准备邮件草稿',
  mail_send: '提交发信请求',
  undo: '撤回改动',
});
/* 只读类：连续调用要折叠成一条「查询过程」（CHAT-NEXT-02）。写类**不**折叠。 */
const CHAT_READ_TOOL_TAILS = new Set([
  'resource_read', 'platform_object_query', 'object_query', 'object_list',
  'sheet_range_read', 'sheet_view_read', 'action_schema',
  'metadata_list', 'metadata_get', 'doc_extract',
  'cashflow_query', 'confirmation_query', 'audit_query', 'brief_query', 'alert_query',
]);
function chatToolTail(name) {
  let tail = String(name || '');
  for (let i = 0; i < 4; i++) {
    const cut = tail.indexOf('_');
    if (cut < 0) break;
    tail = tail.slice(cut + 1);
  }
  return tail;
}
function chatToolLabel(name) {
  const raw = String(name || '');
  if (CHAT_TOOL_LABELS[raw]) return CHAT_TOOL_LABELS[raw];
  let tail = raw;
  for (let i = 0; i < 4; i++) {
    if (CHAT_TOOL_LABEL_TAILS[tail]) return CHAT_TOOL_LABEL_TAILS[tail];
    const cut = tail.indexOf('_');
    if (cut < 0) break;
    tail = tail.slice(cut + 1);
  }
  if (CHAT_TOOL_LABEL_TAILS[tail]) return CHAT_TOOL_LABEL_TAILS[tail];
  return '系统动作';   // 未知名称回退：**不打印原始标识**
}
function chatIsReadTool(name) {
  const raw = String(name || '');
  if (raw === 'platform_resource_read' || raw === 'platform_platform_object_query') return true;
  let tail = raw;
  for (let i = 0; i < 4; i++) {
    if (CHAT_READ_TOOL_TAILS.has(tail)) return true;
    const cut = tail.indexOf('_');
    if (cut < 0) break;
    tail = tail.slice(cut + 1);
  }
  return CHAT_READ_TOOL_TAILS.has(tail);
}

/* —— 工具卡（真实：SSE tool 事件直接渲染结果摘要，不做动画演出） —— */
/* —— 工具卡（真实：SSE tool 事件直接渲染结果摘要，不做动画演出） —— */
// R967-D01（BASE967-35）：撤回回执是**三态**不是二值——全撤 / 部分撤 / 同段有助手改动拒撤。
// 三态都说人话：用户要能知道「为什么我的操作没撤掉」，而不是只看到「调用完成/失败」。
const CHAT_UNDO_STATES = Object.freeze({
  withdrawn: '已撤回',
  partial: '部分撤回',
  rejected_conflict: '未撤回',
});
function chatUndoSummary(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const state = String(parsed.undo_state || '');
  const title = CHAT_UNDO_STATES[state];
  if (!title) return null;
  const count = (key) => (Number.isInteger(parsed[key]) ? parsed[key] : null);
  let detail = '';
  if (state === 'partial') {
    const undone = count('undone'), kept = count('kept');
    detail = [undone !== null ? `撤回 ${undone} 处` : '', kept !== null ? `保留 ${kept} 处（助手改动）` : '']
      .filter(Boolean).join('，') || '你的改动已撤回，助手改动的部分保留';
  } else if (state === 'rejected_conflict') {
    detail = '同一段里有助手的改动，没有覆盖它；你的改动仍保留在原处';
  }
  return { state, title, detail };
}
function chatToolResultText(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
  try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {}
  return text.length > 12000 ? text.slice(0, 12000) + '\n…仅展示前 12000 个字符' : text;
}
/* CHAT-NEXT-02：连续只读调用折叠成一条「查询过程」。
   **不合并审计事实**——每次调用（含失败）在展开详情里逐条保留。
   折叠只在**连续**时发生：中间插了写操作就不再并进来。 */
const chatReadGroups = new WeakMap();
function chatFindReadGroup(body) {
  const rec = chatReadGroups.get(body);
  if (!rec || !rec.group) return null;
  if (body.lastElementChild !== rec.group) return null;   // 不连续就不并
  return rec;
}
function chatRenderReadGroup(group, calls) {
  const header = group.querySelector('button.tool-hd');
  const inner = group.querySelector('.tool-bd-in');
  const single = calls.length === 1;
  const failed = calls.some((c) => c.failed);
  group.classList.toggle('failed', failed);
  group.classList.toggle('done', !failed);
  if (single) {
    header.querySelector('.tool-name').textContent = calls[0].label;
    header.querySelector('.tool-summary').textContent = calls[0].summary;
  } else {
    header.querySelector('.tool-name').textContent = `查询过程（${calls.length} 次）`;
    header.querySelector('.tool-summary').textContent = failed ? '其中有失败' : '已完成';
  }
  inner.innerHTML = '';
  for (const call of calls) {
    if (single) {
      for (const [label, value] of [['工具', call.name], ['参数', call.arg], ['结果', call.result]]) {
        const heading = document.createElement('div'); heading.className = 'tool-detail-label'; heading.textContent = label;
        const pre = document.createElement('pre');
        pre.textContent = chatToolResultText(value);
        inner.append(heading, pre);
      }
      continue;
    }
    const box = document.createElement('div'); box.className = 'tool-call';
    const head = document.createElement('div'); head.className = 'tool-call-hd';
    head.textContent = `${call.label} · ${call.summary}`;
    box.appendChild(head);
    for (const [label, value] of [['工具', call.name], ['参数', call.arg], ['结果', call.result]]) {
      const heading = document.createElement('div'); heading.className = 'tool-detail-label'; heading.textContent = label;
      const pre = document.createElement('pre');
      pre.textContent = chatToolResultText(value);
      box.append(heading, pre);
    }
    inner.appendChild(box);
  }
}
/* —— fast：本轮执行记录（只展示真实 SSE 阶段，确认卡独立保留）。 —— */
function chatRunProgress(body, phase) {
  if(phase?.step){
    const labels={llm:'正在思考',first:'正在回复',llm_done:'思考结束',tool:'正在调用工具',tool_done:'工具已返回',save:'正在记录对话',save_done:'对话已记录'};
    phase={...phase,label:labels[phase.step]||phase.label};
  }
  if (!body.chatRun) {
    const box=document.createElement('details');box.className='chat-run';
    box.innerHTML='<summary><span class="chat-run-label"></span><span class="chat-run-meta"></span></summary><div class="chat-run-steps"></div>';
    body.insertBefore(box,body.firstChild);
    body.chatRun={box,started:Date.now(),count:0,errors:0,last:''};
  }
  const run=body.chatRun;
  if(phase?.label && phase.label!==run.last){
    const row=document.createElement('div');row.className='chat-run-phase';row.textContent=phase.label;
    run.box.querySelector('.chat-run-steps').appendChild(row);run.last=phase.label;
  }
  run.box.dataset.status='running';
  run.box.querySelector('.chat-run-label').textContent=phase?.label||run.last||'正在处理';
  run.box.querySelector('.chat-run-meta').textContent=run.count?`${run.count} 次工具调用`:'';
  return run;
}
function chatFinishRun(body,status) {
  const run=body.chatRun;if(!run)return;
  run.finishedAt=run.finishedAt||Date.now();
  if(status==='confirm'&&body.querySelector('[data-confirm-id]')&&!body.querySelector('[data-confirm-id]:not(.resolved)'))status='resolved';
  run.box.dataset.status=status;
  run.box.querySelector('.chat-run-label').textContent=({done:'本轮结束',confirm:'等待确认',resolved:'确认已处理',stopped:'已停止',error:'执行中断'})[status]||'本轮结束';
  run.box.querySelector('.chat-run-meta').textContent=[`${((run.finishedAt-run.started)/1000).toFixed(1)}秒`,run.count?`${run.count} 次工具调用`:'',run.errors?`${run.errors} 次未成功`:''].filter(Boolean).join(' · ');
}
function chatAddToolCard(body, { name, arg, result }) {
  /* fast：这次调用也记进「本轮执行记录」；工具卡本身仍按 ours 的口径渲染
     （撤回三态 / 只读折叠 / 中文动作名）—— 两边都留，不改成两套卡。 */
  const run=chatRunProgress(body);
  let runParsed;try{runParsed=JSON.parse(result);}catch{/* 原始文字仍可展开核对 */}
  const runFailed=runParsed?.ok===false||!!runParsed?.error||/^(工具执行失败|错误|Error[:：])/i.test(String(result));
  const runKnown=PLATFORM_CHAT_TOOLS.find(tool=>[tool.id,tool.name,tool.tool_name].includes(name));
  const runLabels={platform_resource_read:'读取授权资源',platform_action_schema:'查看可用动作',platform_action_call:'调用受管动作'};
  const runLabel=runKnown?.title||runKnown?.label||runLabels[name]||name||'工具调用';
  const runState=runFailed?'未成功':runParsed?.count!==undefined?`返回 ${runParsed.count} 条`:'已返回';
  const runDisplay=value=>typeof value==='string'?value:JSON.stringify(value??null,null,2);
  const runBounded=value=>{const s=runDisplay(value);return s.length>16000?s.slice(0,16000)+'\n…内容过长，仅展示前16000字':s;};
  const runTool=document.createElement('details');runTool.className='chat-run-tool';
  runTool.dataset.status=runFailed?'error':'done';
  runTool.innerHTML=`<summary><span>${esc(runLabel)}</span><span class="chat-tool-result">${esc(runState)}</span></summary><div class="chat-tool-detail"><b>调用参数</b><pre>${esc(runBounded(arg))}</pre><b>返回结果</b><pre>${esc(runBounded(runParsed??result))}</pre></div>`;
  run.box.querySelector('.chat-run-steps').appendChild(runTool);run.count++;if(runFailed)run.errors++;
  chatRunProgress(body);
  let parsed;
  try { parsed = typeof result === 'string' ? JSON.parse(result) : result; } catch {}
  const undo = chatUndoSummary(parsed);
  // 同段冲突拒撤是**产品语义**不是调用失败——回执 ok:true 时不能标红当出错。
  const failed = !undo && (parsed?.ok === false || parsed?.isError === true || !!parsed?.error);
  const label = chatToolLabel(name);
  // 失败且带 reason 时，摘要说人话（用户看到「没有可撤回的本人修改」，不是干巴巴「调用失败」）
  const failNote = failed && parsed && typeof parsed === 'object'
    ? String(parsed.reason || parsed.error || parsed.detail || parsed.message || '').slice(0, 60)
    : '';
  const summary = undo ? undo.title : (failed ? ('调用失败' + (failNote ? '：' + failNote : '')) : '调用完成');
  const call = { name: String(name || ''), arg, result, label, summary, failed: !!failed, undo };

  if (chatIsReadTool(name)) {
    const existing = chatFindReadGroup(body);
    if (existing) {
      existing.calls.push(call);
      chatRenderReadGroup(existing.group, existing.calls);
      chatScrollBottom();
      return;
    }
    const t = document.createElement('div');
    t.className = 'tool ' + (failed ? 'failed' : 'done');
    t.dataset.chatReadGroup = '1';
    const header = document.createElement('button');
    header.type = 'button'; header.className = 'tool-hd'; header.setAttribute('aria-expanded', 'false');
    header.innerHTML = `<span class="tool-st" aria-hidden="true"></span><span class="tool-name">${esc(label)}</span><span class="tool-summary">${esc(summary)}</span><span class="tool-chev" aria-hidden="true">▶</span>`;
    const details = document.createElement('div'); details.className = 'tool-bd'; details.hidden = true;
    const inner = document.createElement('div'); inner.className = 'tool-bd-in';
    details.appendChild(inner);
    header.onclick = () => {
      const open = header.getAttribute('aria-expanded') !== 'true';
      header.setAttribute('aria-expanded', String(open)); details.hidden = !open; t.classList.toggle('open', open);
    };
    t.append(header, details);
    body.appendChild(t);
    chatReadGroups.set(body, { group: t, calls: [call] });
    chatRenderReadGroup(t, [call]);
    chatScrollBottom();
    return;
  }

  const t = document.createElement('div');
  t.className = 'tool ' + (failed ? 'failed' : 'done') + (undo ? ' undo-' + undo.state : '');
  const header = document.createElement('button');
  header.type = 'button'; header.className = 'tool-hd'; header.setAttribute('aria-expanded', 'false');
  header.innerHTML = `<span class="tool-st" aria-hidden="true"></span><span class="tool-name">${esc(label)}</span><span class="tool-summary">${esc(summary)}</span><span class="tool-chev" aria-hidden="true">▶</span>`;
  const details = document.createElement('div'); details.className = 'tool-bd'; details.hidden = true;
  const inner = document.createElement('div'); inner.className = 'tool-bd-in';
  if (undo && undo.detail) {
    const note = document.createElement('p'); note.className = 'tool-undo-note'; note.textContent = undo.detail;
    inner.appendChild(note);
  }
  for (const [labelText, value] of [['工具', name], ['参数', arg], ['结果', result]]) {
    const heading = document.createElement('div'); heading.className = 'tool-detail-label'; heading.textContent = labelText;
    const pre = document.createElement('pre');
    pre.textContent = chatToolResultText(value);
    inner.append(heading, pre);
  }
  details.appendChild(inner);
  header.onclick = () => {
    const open = header.getAttribute('aria-expanded') !== 'true';
    header.setAttribute('aria-expanded', String(open)); details.hidden = !open; t.classList.toggle('open', open);
  };
  t.append(header, details);
  body.appendChild(t); chatScrollBottom();
}

// R967-D01（BASE967-35 · C 的运输口径）：**撤回在编辑器里发起**（工具栏按钮/⌘Z），
// 不是聊天工具调用，所以它不进工具回执通道——C 把回执对象用 window 事件送过来。
// 聊天**用同一套三态渲染上屏**，不另造一套解释：用户在编辑器撤了，聊天里就能看到撤没撤。
function chatRenderExternalUndo(receipt) {
  if (!receipt || typeof receipt !== 'object') return;
  let layer = null;
  try { layer = (typeof chatEnsureMounted === 'function' && chatEnsureMounted()) ? chatCurrentLayer() : null; } catch { /* 对话未挂载 */ }
  if (!layer) return;   // 对话没打开就不硬塞一个浮层——用户打开时会看到历史里的卡片
  chatAddToolCard(layer, { name: 'editor_undo', arg: '', result: JSON.stringify(receipt) });
}
function chatBindUndoReceipts() {
  if (window.chatUndoReceiptsBound) return;
  window.chatUndoReceiptsBound = true;
  window.addEventListener('shangshu:mail-undo', (event) => chatRenderExternalUndo(event && event.detail));
}

/* —— 确认卡（真实：受管写提案 → 公共 action-proposals 口确认或拒绝）
   回执原则（A2）：同意后重查事件链确认 confirmed 事件真实存在，再渲染「已执行」，不做乐观更新。 —— */
const CHAT_CONFIRM_NAMES = {
  'platform.object.update_many': '修改表格值', 'platform.object.companion_write': '修改表格值',
  'mail.save_draft':'保存邮件草稿', 'mail.send':'发送邮件',
  'files.sheet_cell_write':'修改表格值', 'files.sheet_cells_write':'修改表格值',
  'files.sheet_paste_apply':'粘贴表格内容', 'files.sheet_header_rename':'修改表头',
  'files.sheet_rows_add':'新增表格行', 'files.sheet_cols_add':'新增表格列',
  // 2026-10-21（agent 建表一线）：建表确认卡不许印内部动作号（CHAT-NEXT-03 同源口径）。
  'files.create':'新建表格',
  'invoice.book': '发票入账',
  'customer.create': '新建客户', 'product.create': '新建产品',
  'order.create': '创建订单', 'order.confirm': '确认订单', 'order.ship': '发货出库', 'order.cancel': '取消订单',
  'purchase.create': '创建采购单', 'purchase.receive': '采购收货', 'purchase.confirm': '确认采购单',
  'receivable.pay': '登记回款', 'payable.pay': '登记付款', 'ledger.post': '记一笔账',
  'invoice.reject': '拒绝发票', 'ledger.reverse': '红冲更正', 'invoice.approve': '发票入库',
  // 2026-10-23（PKG-062-T01 · 用户拍板④）：助手给某域提候选 ⇒ 详情栏印人话，不印动作号。
};
// 来源只认后端提案元数据，不能拿动作实现语言或 payload.source 推断。
window.shangshuReviewSource = function (proposal) {
  const raw = typeof proposal?.created_via === 'string' ? proposal.created_via.trim() : '';
  const kinds = {
    ai: ['assistant', 'Assistant'], 'ai-chat': ['assistant', 'Assistant'], assistant: ['assistant', 'Assistant'],
    code: ['automation', '代码自动化'], automation: ['automation', '代码自动化'], execution: ['automation', '代码自动化'],
    'llm-node': ['automation', 'LLM节点自动化'],
  };
  const entry = Object.hasOwn(kinds, raw) ? kinds[raw] : null;
  const proof = proposal?.source_provenance;
  if(proof?.status==='linked' && proof.trusted===true && proof.kind==='process'){
    const executed=proof.executor_kind==='llm'?'LLM节点自动化':proof.executor_kind==='human_task'?'流程人工节点':'代码自动化';
    const trigger=proof.initiator?.kind==='assistant'&&proof.initiator.trusted===true?'Assistant发起 · ':'';
    const participated=proof.llm_participants?.length?' · 含LLM节点参与':'';
    return {kind:'automation',label:trigger+executed+participated+' · '+String(proof.definition_version||'')+' / '+String(proof.process_instance||'')+' / '+String(proof.node_id||''),raw,trusted:true};
  }
  const suffix=proof?.status==='unavailable'?' · 来源详情不可见':entry?' · 来源证明未核实':'';
  return {kind: entry?.[0] || 'unknown', label: (entry?.[1] || '来源未确认')+suffix, raw,trusted:false};
};
window.shangshuReviewTarget = function (proposal) {
  if (typeof proposal?.id !== 'string' || !proposal.id) return null;
  const p = proposal.payload || {}, capability = String(proposal.capability || '');
  if (capability.startsWith('files.sheet_') || ['files.cell_write', 'files.formal_value_write', 'files.promotion_define'].includes(capability)) {
    if (typeof p.table !== 'string' || !p.table) return null;
    return {module: 'excel', proposal_id: proposal.id, table: p.table};
  }
  if (capability === 'mail.save_draft' || capability === 'mail.send') {
    return {module: 'mail', proposal_id: proposal.id, ...(typeof p.mail === 'string' && p.mail ? {mail:p.mail} : {})};
  }
  return null;
};
window.shangshuNavigateReview = async function (proposal, unit = null) {
  const target = window.shangshuReviewTarget(proposal);
  if (!target || typeof go !== 'function') throw Error('此提案暂不支持页面定位，请在确认卡核对');
  if (typeof resolvePage === 'function' && resolvePage(target.module) !== target.module) throw Error('当前无法进入该审核页面，请核对访问权限');
  const previous = location.href, url = new URL(previous);
  if(unit){target.unit_id=unit.unit_id;target.field=unit.target?.header||unit.unit_id;target.cell_index=unit.cell_index||0;}
  const samePage=location.hash==='#/'+target.module&&(!target.table||url.searchParams.get('object')===target.table);
  for (const key of ['object', 'mail', 'proposal']) url.searchParams.delete(key);
  if (target.table) url.searchParams.set('object', target.table);
  if (target.mail) url.searchParams.set('mail', target.mail);
  url.searchParams.set('proposal', target.proposal_id); url.hash = '#/' + target.module;
  history.replaceState(null, '', url);
  const closeReviewPanel = () => {
    if(typeof chatSetMode==='function')chatSetMode('split');
  };
  closeReviewPanel();
  try {
    if (!samePage && await go(target.module) === false) { history.replaceState(null, '', previous); return false; }
    if (location.hash !== '#/' + target.module) { history.replaceState(null, '', previous); return false; }
    closeReviewPanel();
    window.dispatchEvent(new CustomEvent('shangshu:review-focus', {detail:target}));
    return true;
  } catch (error) { history.replaceState(null, '', previous); throw error; }
};
async function chatReviewJSON(path, options) {
  let response, data;
  try { response = await api(path, { ...options, cache: 'no-store' }); data = await response.json(); }
  catch (error) { throw Object.assign(Error('结果未知，请核对原提案后重试：' + (error?.message || '响应中断')), {uncertain:true}); }
  if (response.ok === false || data?.ok === false || data?.error) {
    // BASE967-44：保留结构化「不支持逐项审核」标记，供卡片回落整笔确认（不靠错误文案猜）。
    const error = Object.assign(Error(data?.error || '审核操作失败'), {uncertain:response.status >= 500 || [408,429].includes(response.status)});
    if (data?.unsupported === true || data?.code === 'UNSUPPORTED') error.unsupported = true;
    throw error;
  }
  return data;
}
// 最小入口仅保留提案身份和来源种类；资源参数/内容不放入全局角标。
let chatPendingReviews = new Map(), chatResolvedReviews = new Set();
let chatCueUser = '', chatCueSequence = 0, chatCueRevision = 0, chatCueUnavailable = false, chatCueCapped = false, chatCueBound = false;
function chatTrackPendingReview(proposal) {
  if (typeof proposal?.id !== 'string' || !proposal.id || chatResolvedReviews.has(proposal.id)) return;
  if (proposal.status && proposal.status !== 'proposed') return;
  chatPendingReviews.set(proposal.id, {kind:window.shangshuReviewSource(proposal).kind, revision:++chatCueRevision});
  chatUpdateFab();
}
function chatReplacePendingReviews(rows, revision = chatCueRevision, hasMore = false) {
  const newer = [...chatPendingReviews].filter(([,item]) => item.revision > revision);
  chatPendingReviews.clear();
  for (const proposal of rows) {
    if (proposal.status !== 'proposed' || typeof proposal.id !== 'string' || !proposal.id || chatResolvedReviews.has(proposal.id)) continue;
    chatPendingReviews.set(proposal.id, {kind:window.shangshuReviewSource(proposal).kind, revision});
  }
  for (const [id,item] of newer) if (!chatResolvedReviews.has(id)) chatPendingReviews.set(id,item);
  // BASE967-44：显式上限 200；服务端说还有更多（has_more）或正好触顶时，不把这一页当全集。
  chatCueUnavailable = false; chatCueCapped = Boolean(hasMore) || rows.length >= 200; chatUpdateFab();
}
function chatResolvePendingReview(id, status) {
  if (typeof id !== 'string' || !['confirmed','rejected','failed'].includes(status)) return;
  chatResolvedReviews.add(id); chatPendingReviews.delete(id); chatCueRevision++; chatUpdateFab();
}
// 确认卡落定（2026-10-21 用户 3850 实测：「确认完后确认卡不能丝滑地变成已确认状态」）：
// **状态点、正文、按钮**一次性到终态 —— 不能只换正文、留着「待确认」和旧按钮。
// 只改显示，不放宽任何权限/校验：终态只由已拿到的回执（confirmed/rejected/failed）驱动，
// 拿不准就不落定（调用方不调它，卡片继续如实显示「待确认」）。
function chatSettleConfirmCard(card, status, note) {
  if (!card) return;
  const label = {confirmed:'已确认', rejected:'已拒绝', failed:'未成功', uncertain:'待核实'}[status] || '已处理';
  card.classList.add('resolved');
  card.dataset.outcome = status === 'confirmed' ? 'success' : status === 'failed' ? 'error' : 'pending';
  const tag = card.querySelector('.cf-heading .cf-tag'); if (tag) tag.textContent = label;
  const source = card.querySelector('.review-status-text'); if (source) source.textContent = label;
  const notice = card.querySelector('.cf-review-availability'); if (notice) notice.textContent = note || '';
  // 「在目标页核对 / 查看目标位置」是结果定位，不是重复提交 —— 不跟着一起禁掉。
  card.querySelectorAll('button:not([data-review-open])').forEach(button => { button.disabled = true; });
}
async function chatEnsurePendingCue(force = false) {
  const user = typeof currentUserInfo === 'undefined' ? '' : currentUserInfo?.username;
  if (!user || (!force && chatCueUser === user)) return;
  if (chatCueUser !== user) {chatPendingReviews.clear(); chatResolvedReviews.clear(); chatCueUnavailable=false; chatCueCapped=false; chatUpdateFab();}
  chatCueUser = user;
  const sequence = ++chatCueSequence, revision = chatCueRevision;
  const current = () => sequence === chatCueSequence && user === (typeof currentUserInfo === 'undefined' ? '' : currentUserInfo?.username);
  try {
    const data = await chatReviewJSON('api/platform/action-proposals?status=Proposed&limit=200');
    if (!current()) return;
    if (!Array.isArray(data?.list)) throw Error('确认目录回执不完整');
    chatReplacePendingReviews(data.list, revision, Boolean(data?.has_more));
  } catch (error) {
    if (!current()) return;
    // BASE967-32：只读失败清空旧计数并标「待审待核」，不复用缓存候选
    chatPendingReviews.clear(); chatCueUnavailable=true; chatUpdateFab();
  }
}
function chatBindPendingReviews() {
  if (chatCueBound) return; chatCueBound=true;
  window.addEventListener('shangshu:review-location',event=>{
    const {proposal_id,reason}=event.detail||{};
    document.querySelectorAll('[data-confirm-id]').forEach(card=>{
      if(card.dataset.confirmId!==proposal_id)return;
      let note=card.querySelector('.cf-location-note');
      if(!note){note=document.createElement('p');note.className='cf-location-note';card.appendChild(note);}
      note.textContent=reason||'';note.hidden=!reason;
    });
  });
  window.addEventListener('shangshu:review-progress', event => {
    const {proposal_id:id, descriptor} = event.detail || {};
    if (descriptor?.id !== id || descriptor.status !== 'proposed' || !Number.isInteger(descriptor.remaining) || descriptor.remaining < 1 || !Number.isInteger(descriptor.accepted_count)) return;
    document.querySelectorAll('[data-confirm-id]').forEach(card => {
      if (card.dataset.confirmId !== id || card.classList.contains('resolved')) return;
      const label = card.querySelector('.review-status-text');
      if (label) label.textContent = `已保存 ${descriptor.accepted_count} 项 · 待确认 ${descriptor.remaining} 项`;
      const reject = card.querySelector('.no'); if (reject) reject.textContent = '放弃剩余';
    });
  });
  window.addEventListener('shangshu:review-resolved', event => {
    const detail=event.detail || {};
    if (!['confirmed','rejected','failed'].includes(detail.status)) return;
    chatResolvePendingReview(detail.proposal_id,detail.status);
    document.querySelectorAll('[data-confirm-id]').forEach(card => {
      if (card.dataset.confirmId !== detail.proposal_id || card.classList.contains('resolved')) return;
      // 「修改审核」面板（proposal-review.js）**自己管自己的回执和按钮** —— 它有「打开原件／重新核对」这些
      // 不是重复提交的按钮，不许在这儿一起禁掉；它自己收到这个事件会重新读回。
      // 历史「提案记录」卡（restored）只是记录，不是待办，也不许动它的「查看目标位置」。
      if (card.classList.contains('office-review') || card.classList.contains('restored')) return;
      // 目标页那边已经落定 → 这张卡也落定（状态点 + 全部按钮），不许还挂着「待确认」和旧按钮。
      chatSettleConfirmCard(card, detail.status, detail.status==='confirmed'?'已在目标页确认完成，本提案已确认':detail.status==='rejected'?'已在目标页放弃，本提案已拒绝':'');
      const link=card.querySelector('.cf-target-link'); if(link)link.textContent='查看目标位置';
    });
  });
}
// 领域仅提供纯文本预览/回执；确认权限和写入仍由唯一确认接口执行。
window.shangshuConfirmationPresenters = window.shangshuConfirmationPresenters || Object.create(null);
function chatConfirmationValue(value, schema = {}) {
  if (value == null || value === '') return '空';
  if (schema.type === 'boolean' || typeof value === 'boolean') return value === true || value === 1 ? '是' : '否';
  const index = schema.enum?.indexOf(value);
  if (index >= 0 && schema.enumNames?.[index]) return schema.enumNames[index];
  return Array.isArray(value) ? value.map(item => chatConfirmationValue(item, schema.items)).join('、')
    : typeof value === 'object' ? JSON.stringify(value) : String(value);
}
// 领域只绑定对象与原Action参数；字段、版本、权限及当前值均来自原公共详情。
// 不复制行业确认UI，也不新增写入或数据权威。
window.createRecordActionConfirmationPresenter = function({objectId, recordParam = 'name', versionParam = 'expected_version'}) {
  async function read(confirm) {
    const name = confirm.payload?.[recordParam];
    if (typeof name !== 'string' || !name) throw Error('目标记录缺失，请重新提案。');
    const data = await api(`api/platform/objects/${encodeURIComponent(objectId)}/records/${encodeURIComponent(name)}`).then(r => r.json());
    if (data.ok === false || !data.object || !data.record) throw Error(data.error || '当前记录无法读取。');
    return {...data, name};
  }
  function contents(confirm, data, checked) {
    const p = confirm.payload || {}, action = data.actions?.find(item => item.id === confirm.capability && item.executable);
    if (!action || !Object.hasOwn(action.hidden || {}, recordParam) || !Object.hasOwn(action.hidden || {}, versionParam)) throw Error('当前动作或版本绑定不可用，请重新提案。');
    if (checked && Object.entries(action.hidden).some(([key, value]) => p[key] !== value)) throw Error('记录版本或绑定已变化，请重新提案。');
    const fields = action.input_schema?.properties || {}, lines = [];
    for (const [key, value] of Object.entries(p)) {
      if (!Object.hasOwn(fields, key)) throw Error('字段定义已变化，请重新提案。');
      if (Object.hasOwn(action.hidden, key)) continue;
      const label = fields[key].title || data.object.fields?.find(field => field.id === key)?.label;
      if (!label) throw Error('修改内容无法核对，请重新提案。');
      const bound = Object.hasOwn(action.values || {}, key);
      if (!checked && !bound) continue;
      const before = action.values?.[key];
      lines.push(label + '：' + (checked && bound ? chatConfirmationValue(before, fields[key]) + ' → ' : '')
        + chatConfirmationValue(checked ? value : before, fields[key]));
    }
    if (!lines.length) throw Error('没有可核对的修改内容。');
    return lines;
  }
  return {
    async prepare(confirm) {
      const data = await read(confirm);
      return {title:'修改 · ' + (data.object.title || data.object.name) + ' · ' + (data.record.internal_case_no || data.name),
        lines:contents(confirm, data, true), objectId, recordName:data.name};
    },
    async afterExecution(confirm) {
      const data = await read(confirm), lines = contents(confirm, data, false);
      window.dispatchEvent(new CustomEvent('shangshu:object-changed', {detail:{object_id:objectId, name:data.name}}));
      return {title:'已保存 · ' + (data.object.title || data.object.name), lines, tone:'success'};
    },
  };
};
async function chatObjectConfirmationData(confirm, name) {
  const p = confirm.payload || {};
  if (typeof p.object_id !== 'string' || !p.object_id) throw Error('数据表引用无效，请重新提案。');
  const path = name ? `api/platform/objects/${encodeURIComponent(p.object_id)}/records/${encodeURIComponent(name)}` : 'api/platform/objects';
  const data = await api(path).then(response => response.json());
  if (data.ok === false) throw Error(data.error || '无法读取数据表');
  const object = name ? data.object : (data.list || []).find(item => item.id === p.object_id);
  if (!object || !Array.isArray(object.fields)) throw Error('当前无权读取数据表字段，请重新提案。');
  return {object, record:data.record};
}
function chatObjectConfirmationLines(object, values, before) {
  if (!values || Array.isArray(values) || !Object.keys(values).length) throw Error('没有可核对的字段值。');
  const display = value => value == null ? '空' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return Object.entries(values).map(([key, value]) => {
    const field = object.fields.find(item => item.id === key);
    if (!field?.label || !Object.hasOwn(object.input_schema?.properties || {}, key)) throw Error('字段已变化或不可编辑，请重新提案。');
    return `${field.label}：${before ? display(before[key]) + ' → ' : ''}${display(value)}`;
  });
}
const chatObjectConfirmationPresenter = {
  async prepare(confirm) {
    const p = confirm.payload || {}, update = confirm.capability === 'platform.object.update';
    if (update && (typeof p.name !== 'string' || !p.name || !p.expected_modified)) throw Error('记录版本缺失，请重新提案。');
    const {object, record} = await chatObjectConfirmationData(confirm, update ? p.name : null);
    if (object.revision !== p.expected_revision || !object.operations?.includes(update ? 'update' : 'create')) throw Error('数据表定义或编辑权限已变化，请重新提案。');
    if (update && record?.modified !== p.expected_modified) throw Error('记录已被修改，请重新提案。');
    return {title:(update ? '修改' : '新建') + ' · ' + (object.title || object.name) + (update ? ' · ' + p.name : ''), objectId:p.object_id, recordName:p.name,
      lines:['字段版本 ' + object.revision, ...chatObjectConfirmationLines(object, p.values, update ? record : null)]};
  },
  async afterExecution(confirm, response) {
    const name = response.result?.name || confirm.payload?.name;
    if (!name) throw Error('未取得已保存记录的引用');
    const {object, record} = await chatObjectConfirmationData(confirm, name);
    if (!record || record.name !== name) throw Error('保存结果暂无法读回');
    const values = Object.fromEntries(Object.keys(confirm.payload.values).map(key => [key, record[key]]));
    const receipt = {title:'已保存 · ' + (object.title || object.name), lines:chatObjectConfirmationLines(object, values), tone:'success'};
    window.dispatchEvent(new CustomEvent('shangshu:object-changed', {detail:{object_id:confirm.payload.object_id,name}}));
    return receipt;
  },
};
['platform.object.create','platform.object.update'].forEach(id => { window.shangshuConfirmationPresenters[id] = chatObjectConfirmationPresenter; });
// 日常批量填值共用整包差异预览；模块加载失败也必须禁确认，不能落成空白通用卡。
Object.assign(window.shangshuConfirmationPresenters,
  typeof window.createTableValueConfirmationPresenters === 'function'
    ? window.createTableValueConfirmationPresenters({request:async(path,init)=>{
        const response=await api(path,init);const data=await response.json();
        if(response.ok===false||data?.ok===false)throw Error(data?.error||'表格核对读取失败');
        return data;
      },changed:detail=>window.dispatchEvent(new CustomEvent('shangshu:object-changed',{detail}))})
    : Object.fromEntries(['platform.object.update_many','platform.object.companion_write'].map(id=>[id,{
        prepare:async()=>{throw Error('表格确认组件加载失败，请刷新后重试');},
      }])));

function chatConfirmName(cap) { return CHAT_CONFIRM_NAMES[cap] || cap; }
// 确认卡文案：要签字的人得看懂「按下去会写什么」。发票入账逐条列出记账 + 台账后果，
// 其余能力沿用「对象 + 金额」摘要（原始 payload 仍可在确认卡页看）。
function chatConfirmSummary(confirm) {
  const p = confirm.payload || {};
  if(['files.sheet_cell_write','files.sheet_cells_write','mail.save_draft'].includes(confirm.capability)) {
    return {title:chatConfirmName(confirm.capability),lines:[confirm.capability==='mail.save_draft'
      ? '在写信页核对内容；全部确认只保存草稿，不发送邮件。'
      : '在表格中核对标记的单元格；全部确认只保存剩余建议。']};
  }
  if(confirm.capability==='platform.application.configure'){
    const preview=confirm.preview;
    const display=value=>esc(typeof value==='string'?value:JSON.stringify(value??null));
    return {title:'修改应用草稿（不发布）',lines:preview?.status==='checked'
      ? ['检查基于草稿修订 '+Number(preview.expected_revision)+'；确认时会重新校验。',...preview.changes.map(item=>`${esc(item.label)}：${display(item.before)} → ${display(item.after)}`)]
      : [esc(preview?.reason||'尚未检查当前草稿，请刷新确认卡。')]};
  }
  if (confirm.capability === 'invoice.book') {
    const dir = p.direction === '出项' ? '出项' : '进项';
    const party = dir === '进项' ? (p.supplier || p.seller_name || '未知供应商') : (p.customer_name || p.buyer_name || '选定客户');
    return {
      title: `发票入账：${party}`,
      lines: [
        `发票号 ${esc(p.invoice_no || '—')} · 价税合计 <b>${money(p.amount)}</b> · ${esc(dir)}`,
        '记账表 append 一条（历史不覆盖）',
        dir === '进项' ? `生成应付台账：${esc(party)}` : '生成应收台账：挂审核页选定的客户',
      ],
    };
  }
  const title = confirm.entity_type === 'ledger'
    ? `记一笔账：${p.summary || ''}`
    : `${chatConfirmName(confirm.capability)}：${p.customer_name || p.supplier || p.order_no || p.purchase_no || p.name || ''}`;
  const amountLine = (p.total_amount || p.amount) ? ` · 金额 <b>${money(p.total_amount ?? p.amount)}</b>` : '';
  // 订单类明细必须可见（否则确认卡只有客户名，没法核对就点同意）
  let itemsLines = [];
  if (Array.isArray(p.items) && p.items.length) {
    itemsLines = p.items.map(it => {
      const q = Number(it.qty) || 0;
      const pr = Number(it.price) || 0;
      return `- ${esc(it.product_name || it.sku || '产品')} × <b>${q}</b>${pr ? `（单价 ${money(pr)}）` : ''}`;
    });
    const total = p.items.reduce((sum, it) => sum + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
    if (total) itemsLines.push(`- 合计 <b>${money(total)}</b>`);
  }
  const lines = [`${esc(p.customer_name || p.supplier || p.counterparty || '')}${amountLine}${p.direction ? ' · ' + esc(p.direction) : ''}`, ...itemsLines];
  // 渐进吸收小字：习惯推荐值必须可见（推荐不是规则，人有权改）
  if (p.habit_suggested) {
    const subj = [p.category, p.account_subject].filter(Boolean).join(' / ');
    if (subj) lines.push(`科目：${esc(subj)}`);
    lines.push(`<span class="cell-sub">✦ 按历史习惯推荐（该单位已沿用 ${Number(p.habit_count) || 0} 次），不同意可先拒绝再让我改</span>`);
  }
  return { title, lines };
}
function chatHasInlineReview(confirm) {
  return ['mail.save_draft', 'files.sheet_cell_write', 'files.sheet_cells_write'].includes(confirm?.capability);
}
// R967-D01（BASE967-44）：计数/可见分页/单项细节分开——可用性核对走③头字段（不带 units），
// 单元窗口走②b range（offset/limit）；新口缺席（旧内核 404/缺字段）回落整包 /review，功能不回退。
// 未知结果（uncertain）不回落，按 pending 分类留给上层恢复。
async function chatReviewAvailability(confirm) {
  try {
    const data = await chatReviewJSON('api/platform/action-proposal-get/' + encodeURIComponent(confirm.id));
    if (data && data.id === confirm.id && Number.isInteger(data.remaining) && typeof data.can_accept === 'boolean') {
      return { header: data, ranged: true };
    }
    throw Object.assign(Error('缺少可用性头字段'), { noHeader: true });
  } catch (error) {
    if (error && (error.uncertain || !error.noHeader)) throw error;
    const review = await chatReviewJSON('api/platform/action-proposals/' + encodeURIComponent(confirm.id) + '/review');
    return { header: review, ranged: false };
  }
}
async function chatReviewUnitsWindow(confirm, offset, limit) {
  try {
    const data = await chatReviewJSON('api/platform/action-proposals/' + encodeURIComponent(confirm.id) + '/units?offset=' + offset + '&limit=' + limit);
    if (data && Array.isArray(data.items)) return { items: data.items, total: Number(data.total || 0), ranged: true };
    throw Object.assign(Error('缺少 units 摘要'), { noHeader: true });
  } catch (error) {
    if (error && (error.uncertain || !error.noHeader)) throw error;
    const review = await chatReviewJSON('api/platform/action-proposals/' + encodeURIComponent(confirm.id) + '/review');
    const pending = (review.units || []).filter((u) => String(u.status || 'pending').toLowerCase() === 'pending').map((u, i) => ({ ...u, cell_index: i }));
    return { items: pending.slice(offset, offset + limit), total: pending.length, ranged: false, full: review };
  }
}
async function chatConfirmInlineRemaining(confirm) {
  const { header: current } = await chatReviewAvailability(confirm);
  if (current?.id !== confirm.id) throw Error('审核信息与原提案不一致，请重新读取');
  const currentStatus = String(current.status || '').toLowerCase();
  if (currentStatus === 'confirmed' && current.remaining === 0) return {...current, already_terminal:true};
  if (currentStatus !== 'proposed' || !Number.isInteger(current.remaining) || current.remaining < 1) throw Error('提案已变化，请核对原位置');
  window.shangshuInlineReviews ||= new Map();
  let controller = window.shangshuInlineReviews.get(confirm.id);
  if (!controller) {
    let timer, listener, cancel;
    const pending = new Promise(resolve => {
      cancel = () => { clearTimeout(timer); window.removeEventListener('shangshu:review-ready', listener); resolve(null); };
      listener = event => {
        if (event.detail?.proposal_id !== confirm.id) return;
        const page = window.shangshuInlineReviews.get(confirm.id);
        if (page) { clearTimeout(timer); window.removeEventListener('shangshu:review-ready', listener); resolve(page); }
      };
      window.addEventListener('shangshu:review-ready', listener);
      timer = setTimeout(cancel, 20000);
    });
    try {
      if (await window.shangshuNavigateReview(confirm) === false) throw Error('请先处理当前页面尚未保存的内容');
      controller = window.shangshuInlineReviews.get(confirm.id);
      if (controller) cancel(); else controller = await pending;
    } catch (error) { cancel(); throw error; }
  }
  if (controller?.id !== confirm.id || typeof controller.acceptRemaining !== 'function') throw Error('审核页面尚未就绪，请在原位置核对后重试');
  // The page owns manual candidate edits and performs an independent formal readback.
  const result = await controller.acceptRemaining();
  if (!result || result.id !== confirm.id || result.status !== 'confirmed' || result.remaining !== 0) throw Object.assign(Error('剩余建议尚未全部核实保存，输入已保留'), {uncertain:true});
  return result;
}
function chatAddConfirmCard(body, confirm, options = {}) {
  if (['read', 'external/read', 'extract'].includes(confirm?.effect)) return;
  // BASE967-32/身份可追溯：自动化来源的提案同样在原对话出卡（蓝色标签），不再只进独立目录
  chatTrackPendingReview(confirm);
  const existing=[...document.querySelectorAll('[data-confirm-id]')].find(card=>card.dataset.confirmId===confirm.id);
  if(existing){if(options.recovered)existing.scrollIntoView?.({block:'nearest'});return existing;}
  const sum = chatConfirmSummary(confirm);
  const presenter = window.shangshuConfirmationPresenters[confirm.capability];
  const inlineReview = chatHasInlineReview(confirm);
  /* fast：域声明了 review_handler 的提案 → 交给 proposal-review.js 画「逐项审核」卡。
     ours 对 mail.save_draft / files.sheet_* 走**页面内联审核**（页面自己拥有改稿与读回）。
     两条路径都在：ours 的先走，fast 的留给别的动作。**两边各有改动，待主控复核选哪条口径。 */
  if(!inlineReview && confirm.review_supported && window.mountProposalReview){window.mountProposalReview(body,confirm);chatScrollBottom();return;}
  let ready = !inlineReview && !presenter, rejectReady = !inlineReview || confirm.review_access==='reject_only', inFlight = false, previewObjectId = null, previewRecordName = null;
  const tableValuePages = ['platform.object.update_many','platform.object.companion_write'].includes(confirm.capability)
    && typeof presenter?.paginate === 'function';
  let tableDiffPage = 0, tableDiffSummary = null;
// 展示模型只接收纯文本，不解析领域文案来猜字段或差异，也不改变确认载荷。
function chatConfirmationContent(summary) {
  if (!summary || typeof summary.title !== 'string' || !Array.isArray(summary.lines)
    || summary.lines.some(line => typeof line !== 'string')) throw Error('确认信息格式无效，请重新提案。');
  const resource = summary.resource;
  // 只有这两个受信presenter可保留完整2000格并本地分页；其余通用卡的100项闸不变。
  const page = tableValuePages ? presenter.paginate(summary,tableDiffPage) : null;
  if(page)tableDiffPage=page.index;
  const changes = page ? page.changes : summary.changes;
  if (resource && (typeof resource.name !== 'string' || !Number.isInteger(resource.version))) throw Error('文件预览信息无效');
  if (changes && (!Array.isArray(changes) || changes.length > 100 || changes.some(row => !row || ['label','before','after'].some(key => typeof row[key] !== 'string')))) throw Error('变更预览信息无效');
  const file = resource ? `<div class="cf-resource"><span class="cf-file-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M8 12h8M8 16h8"/></svg></span><div><div class="cf-resource-name">${esc(resource.name)}</div><div class="cf-resource-version">第 ${resource.version} 版${changes?.length ? ' · '+changes.length+' 处修改' : ''}</div></div></div>` : '';
  const diff = changes?.length ? `<div class="cf-diff"><div class="cf-diff-labels" aria-hidden="true"><span>原值</span><span>修改为</span></div>${changes.map(row => `<div class="cf-change"><div class="cf-change-label">${esc(row.label)}</div><div class="cf-change-values"><del class="cf-before" aria-label="原值">${esc(row.before)}</del><ins class="cf-after" aria-label="修改为">${esc(row.after)}</ins></div></div>`).join('')}</div>` : summary.lines.map(line => `<div>${esc(line)}</div>`).join('');
  /* ours：正文沿用原来的 pre-wrap（长正文不挤成一行），与 deepseek.css 的 .cf-body 同口径。 */
  const pages = page && page.total ? `<div class="cf-diff-pagination" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap" role="group" aria-label="表格修改分页"><button class="cf-btn ghost" type="button" data-diff-page-prev data-table-diff-page="${page.index-1}" ${page.index===0?'disabled':''}>上一页</button><span role="status" aria-live="polite">第 ${page.page} / ${page.pages} 页 · 共 ${page.total} 处修改 · 整组确认</span><button class="cf-btn ghost" type="button" data-diff-page-next data-table-diff-page="${page.index+1}" ${page.page===page.pages?'disabled':''}>下一页</button></div>` : '';
  return `<div class="cf-title">${esc(summary.title)}</div>${file}<div class="cf-body" style="white-space:pre-wrap;overflow-wrap:anywhere">${diff}</div>${pages}`;
}
  const c = document.createElement('div');
  const source = window.shangshuReviewSource(confirm), target = window.shangshuReviewTarget(confirm);
  c.className = 'cf-card business-confirm review-source-' + source.kind;
  c.dataset.confirmId = confirm.id;
  c.dataset.reviewSource = source.kind;
  if(inlineReview)c.classList.add("assistant-review-card");
  /* fast：标题行 + 「详情」折叠（提案编号 / 动作）；ours：来源标签（谁发起的这条建议）。都留。
     合并补注（2026-10-21）：「动作」那一栏**不印内部动作号**。
     fast 原话直接印 `confirm.capability`（如 `files.sheet_cells_write`），
     与我们线的规矩冲突：**界面不外露内部标识**（CHAT-NEXT-03 同源口径）——
     判据 `tests/website/chat-inline-review.test.ts`「restored spreadsheet card has a human
     title without raw capability」钉的就是这个（合并前绿、合并后红）。
     改成人话：走本文件已有的 `chatConfirmName`（动作号 → 中文动作名，和卡片标题同一份口径）。 */
  const details = `<details class="cf-details"><summary>详情</summary><dl><dt>提案编号</dt><dd>${esc(confirm.id)}</dd><dt>动作</dt><dd>${esc(chatConfirmName(confirm.capability))}</dd></dl></details>`;
  const heading = status => `<div class="cf-heading"><span>操作确认</span><span class="cf-tag">${esc(status)}</span></div>`;
  const sourceTag = `<span class="cf-tag"><span class="review-source-dot" aria-hidden="true"></span><span class="review-status-text">待你确认</span> · ${esc(source.label)}</span>`;
  c.innerHTML = `${heading('待确认')}${sourceTag}<div class="cf-summary"><div class="cf-title">${esc(sum.title)}</div>
    <div class="cf-body">${sum.lines.map(l => `<div>${l}</div>`).join('')}</div></div>
    ${details}<div class="cf-actions"></div>`;
  const zone = c.querySelector('.cf-actions');
  if(inlineReview){const title=c.querySelector('.cf-title');title.title=sum.title;title.textContent=Array.from(sum.title).slice(0,10).join('')+(Array.from(sum.title).length>10?'…':'');c.querySelector('.cf-body').textContent=confirm.review_access==='reject_only'&&confirm.review_blocked_reason?String(confirm.review_blocked_reason):'正在核对审核权限…';}
  let reviewUnits=[],reviewIndex=0,reviewLoadedTo=0,reviewRawTotal=0,reviewPendingTotal=0,unitsAllowed=false,reviewTarget=null,reviewUnsupported=false;
  // BASE967-44：恢复路径已拉过 ③ 头字段时直接消费一次，不重复拉（20k 提案一条 2MB）
  let prefetchedHeader=(options&&options.header)||null;
  const REVIEW_UNITS_WINDOW = 20;
  async function ensureUnit(index){
    if(!unitsAllowed)return null;
    while(reviewUnits.length<=index&&(reviewRawTotal===0||reviewLoadedTo<reviewRawTotal)){
      const win=await chatReviewUnitsWindow(confirm,reviewLoadedTo,REVIEW_UNITS_WINDOW);
      reviewRawTotal=win.total||reviewRawTotal;
      if(win.full)reviewTarget=win.full.target||reviewTarget;
      const pending=win.items.filter(u=>String(u.status||'pending').toLowerCase()==='pending');
      reviewUnits.push(...pending);
      reviewLoadedTo+=win.items.length;
      if(!win.items.length)break;
    }
    return reviewUnits[index]||null;
  }
  function renderReviewUnits(){
    if(!inlineReview)return;const content=c.querySelector('.cf-body');if(!content)return;
    content.replaceChildren();reviewUnits=unitsAllowed?reviewUnits:[];
    reviewIndex=Math.min(reviewIndex,Math.max(0,reviewUnits.length-1));
    const fields=document.createElement('div');fields.className='review-fields';
    reviewUnits.forEach((unit,i)=>{const row=document.createElement('div');row.className='review-field'+(i===reviewIndex?' is-current':'');const label=document.createElement('span');label.textContent=unit.target?.header||unit.label||unit.unit_id;const loc=document.createElement('small');loc.textContent=unit.target?.row_id||reviewTarget?.mail||reviewTarget?.table||'邮件草稿';label.appendChild(loc);const value=document.createElement('strong');const raw=unit.value?.type?unit.value.value:unit.value;const text=typeof raw==='string'?raw:JSON.stringify(raw??'');value.textContent=text;row.title=(unit.label||unit.unit_id)+'：'+text;row.append(label,value);fields.appendChild(row);});
    content.appendChild(fields);const pos=document.createElement('div');pos.className='review-position';const total=Math.max(reviewPendingTotal,reviewUnits.length);pos.textContent=reviewUnits.length?(reviewIndex+1)+' / '+total+' · '+reviewUnits[reviewIndex].label:'';content.appendChild(pos);
    zone.querySelectorAll('[data-review-step]').forEach(b=>b.disabled=!ready||inFlight||!reviewUnits.length||(b.dataset.reviewStep==='-1'?reviewIndex===0:reviewIndex>=reviewUnits.length-1&&reviewLoadedTo>=(reviewRawTotal||reviewUnits.length)));
  }
  async function stepReview(delta){
    if(inFlight||!ready)return;
    const targetIndex=reviewIndex+delta;if(targetIndex<0)return;
    const unit=await ensureUnit(targetIndex);if(!unit)return;
    reviewIndex=targetIndex;
    // BASE967-44：③ 瘦身后大提案没有 payload，定位目标可能构造不出——
    // 导航尽力而为，失败只提示，步进位置照常推进并重渲染（不能在卡内停住）。
    try{if(await window.shangshuNavigateReview(confirm,unit)===false)throw Error('当前页面仍有待处理内容');}
    catch(error){toast('无法定位',error.message);}
    renderReviewUnits();
  }

  const navigateToTarget = async () => {
    try { await window.shangshuNavigateReview(confirm); }
    catch (error) { toast('无法打开审核位置', error?.message || '请核对目标'); }
  };
  const addNavigation = parent => {
    if (!target || confirm.review_access==='reject_only') return;
    // CHAT-NEXT-07（用户 2026-10-19 20:42 截图）：确认卡里**不再显示那个审核跳转按钮**。
    // 原位确认不受影响（卡上的同意/拒绝照旧）。**导航能力不取消**，只是不再占一个按钮位：
    //   · 未确认时 → 收进卡片正文末尾的「在目标页核对」链接（不是第二个审核入口）
    //   · 已确认后 → 保留「查看目标位置」按钮（那是结果定位）
    if (c.classList.contains('resolved')) {
      const button = document.createElement('button');
      button.className = 'cf-btn ghost'; button.dataset.reviewOpen = confirm.id; button.type = 'button';
      button.textContent = '查看目标位置';
      button.onclick = navigateToTarget;
      parent.appendChild(button);
      return;
    }
    const link = document.createElement('button');
    link.className = 'cf-target-link'; link.dataset.reviewOpen = confirm.id; link.type = 'button';
    link.textContent = '在目标页核对';
    link.onclick = navigateToTarget;
    // 插在正文与操作区**之间**，不塞进 .cf-body——inline 复核会用 replaceChildren 重写正文，
    // 塞进去会被冲掉（链接会凭空消失）。
    const actions = c.querySelector('.cf-actions');
    if (actions) c.insertBefore(link, actions);
    else c.appendChild(link);
  };
  const plainSummary = summary => {
    if(tableValuePages)tableDiffSummary=summary;
    return chatConfirmationContent(summary);
  };
  const resolvedSummary = summary => heading(summary.tone === 'success' ? '已完成' : summary.tone === 'error' ? '未成功' : '请核对') + (tableValuePages?'<div class="cf-summary">'+plainSummary(summary)+'</div>':plainSummary(summary)) + details;
  if(tableValuePages)c.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-table-diff-page]');
    if(!button||button.disabled||!tableDiffSummary)return;
    event.preventDefault();
    const page=Number(button.getAttribute('data-table-diff-page'));
    if(!Number.isInteger(page))return;
    tableDiffPage=page;
    const summary=c.querySelector('.cf-summary');
    if(summary){
      const direction=button.hasAttribute('data-diff-page-next')?'next':'prev';
      summary.innerHTML=chatConfirmationContent(tableDiffSummary);
      const focus=summary.querySelector('[data-diff-page-'+direction+']:not(:disabled)')
        || summary.querySelector('[data-table-diff-page]:not(:disabled)');
      focus?.focus();
    }
  });
  const refreshPreview = async () => {
    ready = false;
    zone.querySelector('.ok').disabled = true;
    try {
      const summary = await presenter.prepare(confirm);
      const html = plainSummary(summary);
      if (c.classList.contains('resolved')) return false;
      c.querySelector('.cf-summary').innerHTML = html;
      zone.querySelector('.ok').textContent = summary.confirmLabel || '同意并执行';
      ready = true;
      previewObjectId = summary.objectId || null;
      previewRecordName = summary.recordName || null;
      zone.querySelector('.ok').disabled = inFlight;
      return true;
    } catch (error) {
      if (!c.classList.contains('resolved')) {
        c.querySelector('.cf-body').textContent = '无法确认：' + (error?.message || '读取失败，请重新提案。');
      }
      return false;
    }
  };
  const act = (label, kind, decision) => {
    const b = document.createElement('button');
    b.className = 'cf-btn ' + kind;
    b.textContent = label;
    b.onclick = async () => {
      if (inFlight || c.classList.contains('resolved') || (decision === 'confirmed' && !ready) || (decision==='rejected'&&!rejectReady)) return;
      inFlight = true;
      b.disabled = true; zone.querySelectorAll('button').forEach(x => x.disabled = true);
      try {
        if (decision === 'confirmed' && inlineReview && !reviewUnsupported) {
          c.querySelector('.cf-error')?.remove();
          const receipt = await chatConfirmInlineRemaining(confirm);
          c.classList.add('resolved');
          const signalled = chatResolvedReviews.has(confirm.id);
          chatResolvePendingReview(confirm.id, 'confirmed');
          if (!signalled) window.dispatchEvent(new CustomEvent('shangshu:review-resolved', {detail:{proposal_id:confirm.id,status:'confirmed',origin:'chat'}}));
          // 正文换成已确认口径，但**保留卡片头部和按钮区** —— 状态点要跟着变，按钮要留着（禁掉，不许重复提交）。
          const box = c.querySelector('.cf-summary');
          if (box) box.innerHTML = plainSummary({title:receipt.already_terminal ? '本提案已确认' : confirm.capability === 'mail.save_draft' ? '剩余建议已确认，草稿已保存（未发送）' : '剩余建议已确认，正式值已读回',lines:[receipt.already_terminal ? '请到原位置查看当前结果。' : '逐项保存的内容保留，人工修订已一并核对。']});
          c.querySelector('.cf-target-link')?.remove();
          chatSettleConfirmCard(c, 'confirmed');
          addNavigation(c);
          return;
        }
        if (decision === 'rejected' && confirm.capability === 'mail.save_draft') {
          const controller = window.shangshuInlineReviews?.get(confirm.id);
          if (controller?.module === 'mail' && typeof controller.rejectRemaining === 'function') {
            c.querySelector('.cf-error')?.remove();
            const receipt = await controller.rejectRemaining();
            if (receipt?.id !== confirm.id || receipt.status !== 'rejected'
                || receipt.remaining_rejected !== true || receipt.saved_content_preserved !== true) {
              throw Object.assign(Error('放弃结果尚未核实，人工输入与原提案保留'), {uncertain:true});
            }
            c.classList.add('resolved');
            const signalled = chatResolvedReviews.has(confirm.id);
            chatResolvePendingReview(confirm.id, 'rejected');
            if (!signalled) window.dispatchEvent(new CustomEvent('shangshu:review-resolved', {detail:{proposal_id:confirm.id,status:'rejected',origin:'chat'}}));
            // 同上：正文换口径，头部状态点和按钮一起落定。
            const box = c.querySelector('.cf-summary');
            if (box) box.innerHTML = plainSummary({title:'已放弃剩余建议，已保存内容保留',lines:['已确认的草稿内容和人工修改保留，未发送邮件。']});
            c.querySelector('.cf-target-link')?.remove();
            chatSettleConfirmCard(c, 'rejected');
            addNavigation(c);
            return;
          }
        }
        // 预览后草稿仍可能被另一页面改动；提交前再次核对，失败不调用确认接口。
        if (decision === 'confirmed' && !reviewUnsupported && presenter && !await refreshPreview()) return;
        if (decision === 'confirmed' && previewObjectId && !window.dispatchEvent(new CustomEvent('shangshu:before-object-change', {
          cancelable:true, detail:{object_id:previewObjectId,name:previewRecordName}
        }))) throw Error('当前记录有人工编辑，请先保存或放弃，再确认 AI 修改。');
        const applicationForm=confirm.capability==='platform.application.configure'
          ? [...document.querySelectorAll('[data-managed-form]')].find(form=>form.dataset.applicationId===confirm.payload?.application_id):null;
        if(decision==='confirmed'&&applicationForm?.dataset.unsaved==='true')throw Error('当前应用有未保存编辑，请先保存或处理草稿，再确认 AI 提案。');
        c.querySelector('.cf-error')?.remove();
        // 纯 Node 模式没有 Frappe 的 action-proposals 路由（404）：走 Node 自带的 /api/confirmations/:id。
        const resolveUrl = (typeof isPlatformManaged === 'function' && isPlatformManaged())
          ? 'api/platform/action-proposals/' + encodeURIComponent(confirm.id) + '/resolve'
          : 'api/confirmations/' + encodeURIComponent(confirm.id);
        const r = await chatReviewJSON(resolveUrl, {method:'POST',body:JSON.stringify({decision})});
        if (r?.id !== confirm.id || !['confirmed','rejected','failed'].includes(r.status)) throw Object.assign(Error('结果未知，审核回执与原提案不一致，请核对原提案'), {uncertain:true});
        c.classList.add('resolved'); // 写入已得到回执；后续读回失败也不能恢复同意按钮重发。
        chatResolvePendingReview(confirm.id,r.status);
        window.dispatchEvent(new CustomEvent('shangshu:review-resolved',{detail:{proposal_id:confirm.id,status:r.status}}));
        if (r.status && r.status !== decision) {
          const title = {rejected:'提案已拒绝 · 未执行',failed:'提案执行失败',confirmed:'提案此前已确认'}[r.status] || '提案状态已变化';
          /* fast 的 resolvedSummary（状态标题 + 正文 + 详情）＋ ours 的「在目标页核对」入口，都留。 */
          c.innerHTML = resolvedSummary({title,lines:['本次未重复操作，请核对当前业务结果。']});
          addNavigation(c);
          return;
        }
        if (decision === 'confirmed' && !reviewUnsupported && presenter) {
          /* 加载态＝骨架：「已确认」是**已经发生的事**（留着），后面那块还没到 ⇒ 灰条呼吸。 */
          c.innerHTML = '<div class="cf-body">已确认'+chatSkeleton('chat-receipt')+'</div>';
          let receipt;
          try { receipt = await presenter.afterExecution(confirm, r); plainSummary(receipt); }
          catch { receipt = {title:'已确认，当前状态读取失败',lines:['请到对应业务页面核对结果；不要重复确认或重新发送。'],tone:'pending'}; }
          c.innerHTML = resolvedSummary(receipt);
          c.dataset.outcome = ['success','pending','error'].includes(receipt.tone) ? receipt.tone : 'pending';
          addNavigation(c);
          return;
        }
        if(decision==='confirmed')applicationForm?.dispatchEvent(new Event('shangshu:application-configured'));
        // 同意：重查事件链确认 confirmed 真实存在（不乐观更新）
        let evtNote = '';
        if (decision === 'confirmed') {
          const q = new URLSearchParams({ entity_type: confirm.entity_type || '', entity_id: confirm.entity_id || '', capability: confirm.capability || '' });
          const ev = await api('api/events?' + q.toString()).then(x => x.json()).catch(() => null);
          const confirmed = (ev?.list || []).filter(e => e.status === 'confirmed' && e.capability === confirm.capability);
          evtNote = confirmed.length ? ` · 事件链留痕（${confirmed.length} 条 confirmed · ${confirmed[confirmed.length - 1].hash}…）` : '（事件链待查）';
        }
        /* fast：状态标题 + 详情折叠；ours：✓ 标记、「已放弃剩余建议」那句口径 + 目标页入口。都留。 */
        c.innerHTML = heading(decision === 'confirmed' ? '已确认' : '已拒绝') + `<div class="cf-done"><span class="k">✓</span>${decision === 'confirmed' ? '已确认 · ' + esc(chatConfirmName(confirm.capability)) + ' 已执行' + esc(evtNote) : confirm.capability === 'mail.save_draft' ? '已放弃剩余建议，已保存内容保留' : '已拒绝 · 未执行'}</div>` + details;
        chatSettleConfirmCard(c, decision === 'confirmed' ? 'confirmed' : 'rejected');
        addNavigation(c);
        toast(decision === 'confirmed' ? '已同意' : '已拒绝', chatConfirmName(confirm.capability));
        if (decision === 'confirmed') await chatConfirmFollowUp(body, confirm, evtNote);
      } catch (e) {
        if (!c.classList.contains('resolved')) {
          let error = c.querySelector('.cf-error');
          if (!error) { error = document.createElement('div'); error.className = 'cf-error'; error.setAttribute('role','alert'); c.appendChild(error); }
          error.textContent = (e?.uncertain ? '结果未知，请核对原提案，不要重新发信。' : '未完成：') + (e?.message || '操作失败');
        }
        toast('操作失败', (e && e.message) || '未知错误');
      } finally {
        inFlight = false;
        if(body.chatRun?.box.dataset.status==='confirm')chatFinishRun(body,'confirm');
        if(!c.classList.contains('resolved')) {
          zone.querySelectorAll('button').forEach(button=>button.disabled=false);
          const ok=zone.querySelector('.ok');if(ok)ok.disabled = !ready || (confirm.capability==='platform.application.configure'&&confirm.preview?.status!=='checked');
          const reject=c.querySelector('.no');if(reject)reject.disabled=!rejectReady;
        }
        chatScrollBottom();
      }
    };
    zone.appendChild(b);
  };
  if(confirm.review_access!=='reject_only')act(inlineReview ? '全部确认' : '同意并执行', 'ok', 'confirmed');
  if(confirm.capability==='platform.application.configure'&&confirm.preview?.status!=='checked')zone.querySelector('button').disabled=true;
  act(confirm.review_access==='reject_only'?'放弃剩余建议':'拒绝', 'no', 'rejected');
  if(inlineReview){const reject=zone.querySelector('.no');const more=document.createElement('details');more.className='review-more';const summary=document.createElement('summary');summary.textContent='···';summary.setAttribute('aria-label','更多操作');more.appendChild(summary);if(reject)more.appendChild(reject);c.insertBefore(more,c.firstChild);for(const [delta,label] of [[-1,'上一个'],[1,'下一个']]){const b=document.createElement('button');b.type='button';b.className='cf-btn ghost';b.dataset.reviewStep=String(delta);b.textContent=label;b.disabled=true;b.onclick=()=>void stepReview(delta);zone.insertBefore(b,zone.querySelector('.ok'));}}
  addNavigation(zone);
  if(inlineReview){for(const button of zone.querySelectorAll('.cf-btn')){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',button.classList.contains('ok')?'m5 12 4 4L19 6':button.dataset.reviewStep==='-1'?'m14 6-6 6 6 6':'m10 6 6 6-6 6');svg.appendChild(path);button.prepend(svg);}}
  // 确认卡直接渲染在对话流（2026-08-20）：放左侧业务面板会被页面重绘冲掉、用户看不见。
  const wrapper=document.createElement('div');wrapper.className='msg m-ai';const avatar=document.createElement('div');avatar.className='ava';avatar.innerHTML='<i></i><i></i><i></i>';const message=document.createElement('div');message.className='body';message.appendChild(c);wrapper.append(avatar,message);body.appendChild(wrapper);
  if(inlineReview && confirm.review_access!=='reject_only') {
    const ok=zone.querySelector('.ok'),reject=c.querySelector('.no'); ok.disabled=true;reject.disabled=true;
    const notice=document.createElement('div'); notice.className='cf-review-availability';
    notice.setAttribute('role','status'); notice.textContent='正在核对是否可以确认…'; c.appendChild(notice);
    const recheck=document.createElement('button'); recheck.className='cf-btn ghost';recheck.type='button';recheck.textContent='重新核对';
    const checkAvailability=async()=>{
      ready=false;rejectReady=false;ok.disabled=true;reject.disabled=true;recheck.disabled=true;
      try {
        const header=prefetchedHeader;prefetchedHeader=null;
        const { header: review } = header?{header}:await chatReviewAvailability(confirm);
        if(c.classList.contains('resolved'))return;
        const status=String(review?.status||'').toLowerCase();
        ready=review?.id===confirm.id && status==='proposed' && review.can_accept===true && review.remaining>0;
        rejectReady=review?.id===confirm.id && status==='proposed' && review.can_reject===true;
        unitsAllowed=review?.can_accept===true && status==='proposed';
        reviewPendingTotal=Number.isInteger(review?.remaining)?review.remaining:0;
        reviewTarget=review?.target||reviewTarget||((confirm.payload&&confirm.payload.table)?{table:confirm.payload.table}:(confirm.payload&&confirm.payload.mail?{mail:confirm.payload.mail}:null));
        if(unitsAllowed){await ensureUnit(reviewIndex);}
        renderReviewUnits();
        notice.textContent=ready?'':(review?.accept_unavailable_reason || '当前建议无法确认，请重新核对或提出建议');
        if(!rejectReady)notice.textContent+=' '+(review?.reject_unavailable_reason || '当前无法放弃此建议');
        if(review?.id===confirm.id && ['confirmed','rejected'].includes(status)) {
          // 提案已落终态 → 卡片跟着落定（状态点 + 全部按钮），不许还挂着「待确认」和旧按钮。
          chatSettleConfirmCard(c, status, status==='confirmed'?'本提案已确认':'本提案已拒绝');
        }
      }catch(error){
        if(error?.unsupported){
          // BASE967-44：该动作不支持逐项审核 → 回落整笔确认（原确认口 /resolve），不再空等页面控制器。
          reviewUnsupported=true;unitsAllowed=false;reviewUnits=[];reviewLoadedTo=0;reviewRawTotal=0;
          renderReviewUnits();
          zone.querySelectorAll('[data-review-step]').forEach(button=>{button.hidden=true;button.disabled=true;});
          ok.textContent='同意并执行';
          notice.textContent='该动作不支持逐项审核，将按整笔提交确认。';
        }else{notice.textContent='无法核对当前权限，请重新打开建议';ready=false;}
      }
      ok.disabled=!ready || inFlight;
      reject.disabled=!rejectReady || inFlight;
      recheck.disabled=false;recheck.hidden=ready || c.classList.contains('resolved');
    };
    recheck.onclick=()=>void checkAvailability();
    void checkAvailability();
    const refreshCard=event=>{if(!c.isConnected){window.removeEventListener('shangshu:review-progress',refreshCard);return;}if(event.detail?.proposal_id===confirm.id&&!c.classList.contains('resolved'))void checkAvailability();};
    window.addEventListener('shangshu:review-progress',refreshCard);
  }
  if (presenter && !inlineReview && confirm.review_access!=='reject_only') {
    c.querySelector('.cf-body').innerHTML = chatSkeleton('chat-preview');
    refreshPreview();
  }
  if (options.navigate && inlineReview) void window.shangshuNavigateReview(confirm).catch(error => toast('审核页面尚未打开', error?.message || '请从原提案定位'));
  chatScrollBottom();
  return c;
}

window.shangshuOpenReviewCard = async function(proposal,{navigate=true}={}) {
  if(!chatEnsureMounted())return false;
  if(chatHistoryReady)await chatHistoryReady;
  if(typeof chatSetMode==='function')chatSetMode('split');
  const body=typeof chatEl!=='undefined'&&chatEl ? chatEl : document.getElementById('chat');
  if(!body)throw Error('对话尚未打开，请重试');
  const existed=[...document.querySelectorAll('[data-confirm-id]')].some(card=>card.dataset.confirmId===proposal.id);
  // 只有调用方给的是带可用性头字段的 ③ 回包时才预取复用；列表项没有 can_accept/remaining，不能当头字段
  const header=proposal&&Number.isInteger(proposal.remaining)&&typeof proposal.can_accept==='boolean'?proposal:undefined;
  const card=chatAddConfirmCard(body,proposal,{recovered:true,...(header?{header}:{})});
  if(card&&!existed&&!card.querySelector('[data-recovered-review]')){const label=document.createElement('small');label.dataset.recoveredReview='';label.textContent='恢复的待确认操作';card.prepend(label);}
  if(navigate&&proposal.review_access!=='reject_only'&&window.shangshuReviewTarget(proposal))return window.shangshuNavigateReview(proposal);
  return true;
};

// 历史只保存对话文字；未决写入从唯一确认目录恢复，不推断所属会话。
// fast：待处理确认面板（从确认目录把「还没处理」的建议找回来，逐张出卡）。
// ours：另有 chatEnsurePendingCue（只数个数、挂在悬浮入口上）+ 聊天确认卡，两套并存。
let chatPendingLoad = 0;
async function chatLoadPendingConfirmations() {
  const sequence = ++chatPendingLoad, host = chatEl;
  const user = typeof currentUserInfo === 'undefined' ? '' : currentUserInfo?.username;
  host.querySelector('[data-pending-confirmations]')?.remove();
  const section = document.createElement('section');
  section.dataset.pendingConfirmations = '';
  section.className = 'brief'; section.hidden = true;
  host.appendChild(section);
  const current = () => sequence === chatPendingLoad && section.isConnected && host === chatEl
    && user === (typeof currentUserInfo === 'undefined' ? '' : currentUserInfo?.username);
  try {
    const data = await fetchPendingConfirmations();
    if (!current()) { section.remove(); return; }
    if (data.ok === false || !Array.isArray(data.list)) throw Error('无法读取确认目录');
    const seen = new Set([...host.querySelectorAll('[data-confirm-id]')].map(card => card.dataset.confirmId));
    const pending = data.list.filter(item => {
      if (item.status !== 'proposed' || typeof item.id !== 'string' || !item.id || !item.capability || seen.has(item.id)) return false;
      seen.add(item.id); return true;
    });
    if (!pending.length) { section.remove(); return; }
    section.hidden = false;
    section.innerHTML = '<div class="brief-hd"><span class="t">待处理确认 · 当前账号可处理</span></div><p>以下操作尚未执行，不代表来自当前会话；请逐项核对后确认或拒绝。</p>';
    pending.forEach(item => chatAddConfirmCard(section, item));
  } catch {
    if (!current()) { section.remove(); return; }
    section.hidden = false;
    section.textContent = '待处理确认暂不可读取，请重新打开对话后重试。';
  }
}

/* —— 确认之后的闭环：写完了要让人当场看见结果落在哪张表 ——
   追溯卡放在对话流里（左侧 #main 会被重绘，放业务层会被冲掉），
   并把左侧业务页带到结果所在页面高亮新记录；数据一律重查，不做乐观展示。 */
function chatFlashKey(key) {
  if (!key) return null;
  const k = CSS.escape(String(key));
  const el = document.querySelector(`[data-ai-id="${k}"], [data-ai-key="${k}"]`);
  if (!el) return null;
  el.classList.add('ai-target-flash');
  el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  setTimeout(() => el.classList.remove('ai-target-flash'), 2600);
  return el;
}
function chatGoTrace(module, key, tab) {
  if (!RENDER[module]) return;
  if (chatMode === 'full') chatSetMode('split');
  if (tab && module === 'accounting' && typeof accTab === 'string') accTab = tab;
  if (tab && module === 'payables' && typeof erpFinTab === 'string') erpFinTab = tab;
  if (tab && module === 'task-mgmt' && typeof rtTaskTab === 'string') rtTaskTab = tab;
  Promise.resolve(go(module)).then(() => setTimeout(() => chatFlashKey(key), 80));
}
async function chatConfirmFollowUp(body, confirm, evtNote) {
  if (confirm.capability === 'metadata.publish') {
    const kind = confirm.payload?.kind || confirm.entity_type || '';
    const key = confirm.payload?.key || confirm.entity_id || '';
    const card = document.createElement('div');
    card.className = 'cf-card resolved';
    card.innerHTML = `<div class="cf-title">设计已发布</div>
      <div class="cf-body"><div>· ${esc(kind)} · <code>${esc(key)}</code></div><div>· 新页面和新流程实例将读取这个版本</div></div>`;
    body.appendChild(card);
    window.dispatchEvent(new CustomEvent('shangshu:metadata-published', { detail: { kind, key } }));
    if (kind === 'flow' && curMod === 'flowdesign') Promise.resolve(RENDER.flowdesign()).then(() => setTimeout(() => chatFlashKey(key), 80));
    if (kind === 'object' && curMod === 'objects') Promise.resolve(RENDER.objects()).then(() => setTimeout(() => chatFlashKey(key), 80));
    chatScrollBottom();
    return;
  }
  // 订单确认后：刷新左侧订单页并高亮刚操作的订单（原来订单页在侧栏都没入口=幽灵页）
  if (confirm.capability === 'post.create') {
    // 发帖同意后：跳到帖子广场并高亮新帖（与订单同款追踪）
    const posts = await apiJSON('api/posts').catch(() => ({ list: [] }));
    const list = Array.isArray(posts.list) ? posts.list : [];
    const latest = list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
    const card = document.createElement('div');
    card.className = 'cf-card resolved';
    card.innerHTML = `<div class="cf-title">帖子已发布到广场</div>
      <div class="cf-body"><div>· ${esc(latest?.content || '')}</div>
      <div>· 状态：待认领 —— 员工或他的 AI 会看见并认领</div></div>
      <div class="cf-actions"><button class="cf-btn ghost" onclick="chatGoTrace('task-mgmt','${esc(latest?.id || '')}','posts')">去帖子广场</button></div>`;
    body.appendChild(card);
    chatScrollBottom();
    chatGoTrace('task-mgmt', latest?.id || '', 'posts');
    return;
  }
  if (confirm.capability === 'order.create' || confirm.capability === 'order.confirm') {
    const orders = await apiJSON('api/orders').catch(() => ({ list: [] }));
    const list = Array.isArray(orders.list) ? orders.list : [];
    const targetNo = confirm.payload?.order_no || '';
    const latest = (targetNo ? list.filter(o => o.order_no === targetNo) : list)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
    const card = document.createElement('div');
    card.className = 'cf-card resolved';
    card.innerHTML = `<div class="cf-title">${confirm.capability === 'order.create' ? '订单已创建' : '订单已确认'}</div>
      <div class="cf-body"><div>· ${esc(latest?.order_no || targetNo || '—')} · ${esc(latest?.customer_name || '')} · <b>${money(latest?.total_amount || 0)}</b> · ${esc(latest?.status || '')}</div>
      <div>· ${confirm.capability === 'order.confirm' ? '应收台账已自动生成' : '下一步可在对话里说「确认订单」'}</div></div>
      <div class="cf-actions"><button class="cf-btn ghost" onclick="chatGoTrace('orders','${esc(latest?.id || '')}')">查看订单</button></div>`;
    body.appendChild(card);
    chatScrollBottom();
    chatGoTrace('orders', latest?.id || '', '');
    return;
  }
  if (confirm.capability !== 'invoice.book') return;
  const inv = await apiJSON('api/invoices/' + confirm.entity_id).catch(() => null);
  const dir = (inv?.invoice_direction || confirm.payload?.direction) === '出项' ? '出项' : '进项';
  const ledgerId = inv?.ledger_record_id || '';
  const finTab = dir === '进项' ? 'pay' : 'recv';
  // 事件链摘要要跟到这张卡上：原确认卡在业务层，跳转重绘就没了
  const lines = [
    `发票状态：<b>${esc(inv?.status || '已入账')}</b>`,
    ledgerId ? `记账表新记录 <code>${esc(ledgerId)}</code>` : '记账表已 append 一条',
    dir === '进项' ? '应付台账已生成（供应商 = 销方）' : '应收台账已生成（挂选定客户）',
    esc(String(evtNote || '').replace(/^\s*·\s*/, '')) || '事件链待查',
  ];
  const card = document.createElement('div');
  card.className = 'cf-card resolved';
  card.innerHTML = `<div class="cf-title">链路已闭环</div>
    <div class="cf-body">${lines.map(l => `<div>· ${l}</div>`).join('')}</div>
    <div class="cf-actions">
      <button class="cf-btn ghost" onclick="chatGoTrace('accounting','${esc(ledgerId)}','flow')">记账流水</button>
      <button class="cf-btn ghost" onclick="chatGoTrace('payables','${esc(confirm.entity_id)}','${finTab}')">${dir === '进项' ? '应付台账' : '应收台账'}</button>
      <button class="cf-btn ghost" onclick="chatGoTrace('review','${esc(confirm.entity_id)}')">回到发票</button>
    </div>`;
  body.appendChild(card);
  chatScrollBottom();
  chatGoTrace('accounting', ledgerId, 'flow');
}

/* —— 结构化 UI 事件协议 ——
   ui_patch: { id, module, entity_type, entity_id, label, changes:[{field,label,before,after}] }
   ui_navigate: { module, entity_type, entity_id, label }
   Patch 只是草稿投影；“请求应用”重新进入对话并由后端生成 confirmation，不直接改 DOM/数据库。 */
function chatRenderBusinessDraft(draft) {
  const changes = Array.isArray(draft.changes) ? draft.changes : [];
  return `<div class="ai-diff-draft" data-draft-id="${esc(draft.id)}">
    <div class="ai-diff-head">${CHAT_ICONS.target}<span>AI 草稿 · ${changes.length} 个字段有变化，尚未写入</span>
      <span class="actions">
        <button class="btn btn-ghost" onclick="chatRejectDraft('${esc(draft.id)}')">撤销</button>
        <button class="btn btn-pri" onclick="chatRequestDraftApply('${esc(draft.id)}')">请求应用</button>
      </span>
    </div>
    <div class="ai-diff-fields">${changes.map(c => `<div class="ai-diff-field">
      <div class="label">${esc(c.label || c.field || '字段')}</div>
      <div class="ai-diff-line old">− ${esc(c.before ?? '—')}</div>
      <div class="ai-diff-line new">+ ${esc(c.after ?? '—')}</div>
    </div>`).join('')}</div>
  </div>`;
}
function chatRestoreBusinessDrafts(layer = ensureAiBusinessLayer?.()) {
  if (!layer) return;
  const confirmations = [...layer.querySelectorAll('.business-confirm')];
  layer.innerHTML = chatDrafts
    .filter(d => !d.module || d.module === curMod)
    .map(chatRenderBusinessDraft).join('');
  confirmations.forEach(c => layer.appendChild(c));
}
function chatReceivePatch(data) {
  if (!data || !Array.isArray(data.changes) || !data.changes.length) return;
  const draft = {
    id:String(data.id || `draft-${Date.now()}`),
    module:data.module || curMod,
    entity_type:data.entity_type || '',
    entity_id:data.entity_id || '',
    label:data.label || data.entity_id || '业务对象',
    changes:data.changes,
  };
  chatDrafts = [...chatDrafts.filter(d => d.id !== draft.id), draft];
  if (chatMode === 'full') chatSetMode('split');
  if (draft.module && RENDER[draft.module] && draft.module !== curMod) go(draft.module);
  chatSetBusinessContext(draft);
  Promise.resolve().then(() => {
    chatRestoreBusinessDrafts();
    const target = draft.entity_id && document.querySelector(`[data-ai-id="${CSS.escape(draft.entity_id)}"]`);
    if (target) target.classList.add('ai-target-flash');
  });
}
function chatReceiveNavigate(data) {
  if (!data) return;
  chatSetMode('split');
  if (data.module && RENDER[data.module] && data.module !== curMod) go(data.module);
  chatSetBusinessContext({
    module:data.module || curMod, entity_type:data.entity_type || '',
    entity_id:data.entity_id || '', label:data.label || data.entity_id || '业务对象',
  });
  setTimeout(() => chatFlashKey(data.entity_id), 0);
}
function chatRejectDraft(id) {
  chatDrafts = chatDrafts.filter(d => d.id !== id);
  chatRestoreBusinessDrafts();
  toast('已撤销草稿', '正式数据没有变化');
}
function chatRequestDraftApply(id) {
  const draft = chatDrafts.find(d => d.id === id);
  if (!draft) return;
  const fields = draft.changes.map(c => `${c.label || c.field}: ${c.before} → ${c.after}`).join('；');
  chatSetMode(chatMode === 'hidden' ? chatLastMode : chatMode);
  chatGuardFlow(() => chatRunMessage(`请应用「${draft.label}」的这份草稿修改：${fields}`));
}

/* —— 轻量 markdown 渲染（安全子集：**加粗**、`行内码`、- / 1. 列表）——
   模型输出 markdown 时星号不直接展示，渲染成视觉样式；其余一律转义，不引入富文本风险。 */
function chatRender(text) {
  let html = esc(text);
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = html.split('\n');
  let out = '';
  let inList = false;
  for (const line of lines) {
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
    if (ul || ol) {
      if (!inList) { out += '<div class="md-list">'; inList = true; }
      out += `<div class="md-li">${ul ? ul[1] : ol[1]}</div>`;   // 内容已在开头整体 esc + 行内替换，不再二次转义
    } else {
      if (inList) { out += '</div>'; inList = false; }
      out += (line ? `<div class="md-p">${line}</div>` : '');
    }
  }
  if (inList) out += '</div>';
  return out;
}

/* —— 会话记录：发送时记 user 消息，回复完成后记 assistant 消息，刷新左栏 —— */
function chatSessionTitle(msgs) {
  const u = msgs.find(m => m.role === 'user');
  const s = (u ? u.content : '新对话').replace(/\s+/g, ' ').trim();
  return s.length > 18 ? s.slice(0, 18) + '…' : s;
}
function chatTimeLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return '今天 ' + hh;
  if (d.toDateString() === yest.toDateString()) return '昨天 ' + hh;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function chatRenderSessions() {
  const el = $('#chat-float-sess');
  if (!el) return;
  const act = chatSessions.map((s, i) => ({ s, i })).filter(x => !x.s.archived);
  el.innerHTML = act.length ? act.map(({ s, i }) => `
    <div class="chat-float-item ${i === chatCurSession ? 'on' : ''}" onclick="chatPickSession(${i})">
      <span class="t">${esc(s.title)}</span><span class="d">${s.time}</span>
      ${s.id ? `<button type="button" class="cf-del" title="删除此对话（不可恢复）" onclick="event.stopPropagation();chatDeleteSession(${i})">删除</button>` : ''}
    </div>`).join('') : '<div class="chat-float-empty">还没有对话，说点什么开始</div>';
}
/* —— 删除会话（2026-08-28）：物理删除该会话全部消息，confirm 一次，不可恢复 —— */
async function chatDeleteSession(i) {
  const s = chatSessions[i];
  // BASE967-23：只挡「运行中任务所在的会话」（删了结果没处落）；删其他会话不牵连运行中的成果
  //
  // 合并补注（2026-10-21）：合并时 fast 那条线的一刀切守卫
  // （`if(chatRunning){toast('正在执行',…);return;}` —— 运行中一律不许删）
  // 被放在 ours 这条精确守卫**上面**，把后者变成了死代码 ⇒
  // 「删别的会话也被挡」，判据 `tests/website/chat-send-lifecycle.test.ts`
  // 「运行中删除：删运行中会话被挡且成果不撤销，**删其他会话可**」红的就是这个。
  // 口径与 `chatPickSession`/`chatNewSession` 那两处保持一致（那里合并时已按 ours 处理）：
  // 运行中**只挡运行中任务所在的那个会话**，其余会话照常可删。
  if (chatRunning && s && (!chatRunningConv || s.id === chatRunningConv)) { toast('请先停止生成', '当前回答结束后再删除此对话'); return; }
  chatLiveTouched = true;
  if (!s?.id) return;
  if (!confirm(`删除对话「${s.title || '未命名'}」？全部聊天记录将被删除，不可恢复。`)) return;
  try {
    await api(`api/chat/conversation/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    chatSessions.splice(i, 1);
    if (chatCurSession === i) {
      chatCurSession = -1;
      chatEl.querySelectorAll('.chat-layer').forEach((l) => { if (l.dataset.conv === String(s.id || '')) l.remove(); });
      chatWelcome();
    } else if (chatCurSession > i) chatCurSession--;
    chatRenderSessions();
    toast('已删除', '对话与全部消息已删除');
  } catch (e) { toast('删除失败', e.message); }
}
function chatAddToSession(role, content, reasoning, targetSession) {
  if (targetSession) {
    targetSession.msgs.push({ role, content, reasoning: reasoning || '' });
    targetSession.title = chatSessionTitle(targetSession.msgs);
    targetSession.time = chatTimeLabel(Date.now());
    chatRenderSessions();
    return;
  }
  if (chatCurSession < 0 || !chatSessions[chatCurSession]) {
    chatSessions.push({ title: '', time: '', msgs: [] });
    chatCurSession = chatSessions.length - 1;
  }
  const s = chatSessions[chatCurSession];
  s.msgs.push({ role, content, reasoning: reasoning || '' });
  s.title = chatSessionTitle(s.msgs);
  s.time = chatTimeLabel(Date.now());
  chatRenderSessions();
}
// R967-D01（BASE967-23）：每会话一个消息层，运行结果按会话标识路由；切换=切层，不重建运行中的层
function chatLayerFor(convId) {
  const key = String(convId || '');
  let layer = chatEl.querySelector(`.chat-layer[data-conv="${CSS.escape(key)}"]`);
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'chat-layer';
    layer.dataset.conv = key;
    chatEl.appendChild(layer);
  }
  return layer;
}
function chatShowLayer(convId) {
  const key = String(convId || '');
  chatEl.querySelectorAll('.chat-layer').forEach((l) => { l.hidden = l.dataset.conv !== key; });
}
function chatCurrentLayer() {
  return chatEl.querySelector('.chat-layer:not([hidden])') || chatEl;
}
function chatReplaySession(msgs, convId) {
  const key = convId !== undefined ? String(convId || '') : String((chatSessions[chatCurSession] && chatSessions[chatCurSession].id) || '');
  // BASE967-23：运行中会话的层不重建（结果正在路由进来）；已有内容的层不重复渲染
  if (key === chatRunningConv) { chatShowLayer(key); return; }
  const layer = chatLayerFor(key);
  if (layer.childElementCount) {
    // Re-entering a cached history layer is a new read, not a lasting permission grant.
    for(const card of layer.querySelectorAll('.business-confirm.restored[data-confirm-id]'))window.chatRestoreProposalCard?.(card.parentElement,{id:card.dataset.confirmId},card);
    chatShowLayer(key);chatScrollBottom();return;
  }
  for (const m of msgs) {
    if (m.role === 'user') chatAddUserMsg(m.content, layer);
    else {
      const body = chatAiShell(false, layer);
      const txt = document.createElement('div');
      txt.className = 'txt';
      txt.innerHTML = chatRender(m.content);
      body.appendChild(txt);
      if (m.reasoning) chatInsertReasoning(body, txt, m.reasoning);
      // BASE967-30：已处理/拒绝/失败提案随原对话恢复，按当前权限投影；身份可追溯
      chatRestoreHistoryFacts(body, m.cards);
      if (m.cards && Array.isArray(m.cards.proposals)) {
        for (const meta of m.cards.proposals) window.chatRestoreProposalCard?.(body, meta);
      }
    }
  }
  chatShowLayer(key);
  chatScrollBottom();
  void chatEnsurePendingCue();
  void chatLoadPendingConfirmations();   // fast：把「还没处理」的建议从确认目录找回来
}
// Historical execution facts contain no old arguments, values or error text.
function chatRestoreHistoryFacts(body, cards) {
  if(!cards)return;
  const tools=Array.isArray(cards.tools)?cards.tools:[],state=cards.status;
  if(!tools.length&&!state)return;
  const card=document.createElement('div');card.className='cf-card restored history-facts';
  const lines=tools.map((tool,index)=>`工具调用 ${index+1}：${tool.ok===true?'当时调用完成':tool.ok===false?'当时调用失败':'结果未记录'}${tool.proposal_id?'，对应提案状态见下方':''}${({withdrawn:'；当时已撤回',partial:'；当时部分撤回',rejected_conflict:'；当时因冲突未撤回'})[tool.undo_state]||''}`);
  if(state?.kind==='history_status'){
    if(state.error_count)lines.push(`当时记录 ${state.error_count} 次工具错误`);
    if(state.empty_count)lines.push(`当时出现 ${state.empty_count} 次空回答${state.auto_retried?'，已尝试自动重试':''}`);
    if(state.unsupported_claim_count)lines.push(`当时有 ${state.unsupported_claim_count} 项表述缺少执行回执`);
  }
  if(!lines.length)return;
  card.innerHTML='<div class="cf-title">本轮执行记录</div><div class="cf-body">'+lines.map(line=>'<div>'+esc(line)+'</div>').join('')+'<div>历史调用完成不代表已确认、已保存或已发送。业务内容按当前权限重新读取。</div></div>';
  body.appendChild(card);
}
window.chatRestoreProposalCard = async function (body, meta, existing=null) {
  const c=existing||document.createElement('div');c.className='cf-card business-confirm restored';c.dataset.confirmId=String(meta?.id||'');
  c.innerHTML='<span class="cf-tag">◈ 提案记录</span><div class="cf-body">'+chatSkeleton('chat-proposal-state')+'</div>';if(!existing)body.appendChild(c);
  const generation=String(Number(c.dataset.historyGeneration||0)+1);c.dataset.historyGeneration=generation;
  // Detached nodes and superseded permission reads never accept a late response.
  const alive=()=>body.isConnected&&c.isConnected&&c.dataset.historyGeneration===generation;
  let proposal;
  try{
    const response=await api('api/platform/action-proposal-get/'+encodeURIComponent(meta.id),{cache:'no-store'}),data=await response.json();
    if(!alive())return null;
    proposal=data.proposal||data;
    if(response.ok===false||data?.ok===false||proposal?.id!==meta.id)throw Error('不可见');
  }catch{
    if(alive())c.innerHTML='<span class="cf-tag">◈ 提案记录</span><div class="cf-body">当前无权查看或无法核实此记录。</div>';
    return c;
  }
  const status=String(proposal.status||'').toLowerCase();
  if(status==='proposed'){
    c.remove();window.chatAddConfirmCard?.(body,proposal,{recovered:true,...(Number.isInteger(proposal.remaining)&&typeof proposal.can_accept==='boolean'?{header:proposal}:{})});return null;
  }
  const accepted=Number(proposal.review?.accepted_count??proposal.accepted_count??0),mail=proposal.capability==='mail.save_draft';
  const title=status==='rejected'?(accepted>0?`已放弃剩余建议 · 已保存 ${accepted} 项保留`:'提案已拒绝'):status==='confirmed'?(mail?'草稿修改已确认（此操作不发送邮件）':'提案已确认'):status==='failed'?'执行失败':'提案状态待核实';
  const source=window.shangshuReviewSource?.(proposal)?.label||'来源未确认';
  const lines=[`提案：${proposal.id}`,`动作：${proposal.capability||'未记录'}`];
  if(proposal.decision_by)lines.push(`决定人：${proposal.decision_by}`);
  if(proposal.decision_at)lines.push(`决定时间：${proposal.decision_at}`);
  if(proposal.execution_audit)lines.push(`执行记录：${proposal.execution_audit}`);
  // Error detail comes only from the fresh permission-checked response, never stored cards.
  const currentNote=proposal.error||proposal.reason;
  if(typeof currentNote==='string'&&currentNote)lines.push(currentNote);
  c.innerHTML=`<span class="cf-tag">◈ 提案记录 · ${esc(source)}</span><div class="cf-title">${esc(title)}</div><div class="cf-body">${lines.map(line=>'<div>'+esc(line)+'</div>').join('')}</div>`;
  if(window.shangshuReviewTarget?.(proposal)){
    const button=document.createElement('button');button.className='cf-btn ghost';button.textContent='查看目标位置';
    button.onclick=async()=>{button.disabled=true;try{await window.shangshuNavigateReview(proposal);}catch{const note=document.createElement('div');note.textContent='目标当前不可用，请重新核对权限或状态。';c.appendChild(note);}finally{button.disabled=false;}};c.appendChild(button);
  }
  return c;
};
function chatPickSession(i) {
  // BASE967-23：运行中允许切换——结果按会话标识路由回原会话，不用永久禁用规避
  chatLiveTouched = true;
  if (i === chatCurSession || !chatSessions[i]) return;
  const from = chatSessions[chatCurSession];
  if (from) from.draft = chatInput.value;   // 草稿输入按会话归属
  /* fast：切会话时递增交互代号 —— 迟到的历史回包不许覆盖新会话的画布。
     fast 那版还会在运行中弹提示挡住切换（`if(chatRunning){toast(...)}`），
     与 ours 的 BASE967-23「运行中也让切」冲突，这里保留 ours 的口径，待主控复核。 */
  window.chatInteractionGeneration=(window.chatInteractionGeneration||0)+1;
  chatCurSession = i;
  chatInput.value = (chatSessions[i] && chatSessions[i].draft) || '';
  chatReplaySession(chatSessions[i].msgs, chatSessions[i].id || '');
  chatRenderSessions();
  chatCloseFloat();
}
function chatNewSession() {
  chatLiveTouched = true;
  const from = chatSessions[chatCurSession];
  if (from) from.draft = chatInput.value;
  /* fast：新建会话也递增交互代号（迟到的历史回包不许覆盖新画布）。
     fast 那版运行中会弹提示挡住新建，与 ours 的 BASE967-23 口径冲突，保留 ours，待主控复核。 */
  window.chatInteractionGeneration=(window.chatInteractionGeneration||0)+1;
  chatCurSession = -1;
  chatInput.value = '';
  chatWelcome();
  chatRenderSessions();
  chatCloseFloat();
  chatInput.focus();
}
/* —— 右上悬浮栏：对话历史 / 能力入口（不占布局分区） —— */
function chatToggleFloat() {
  const p = $('#chat-float-panel');
  if (!p) return;
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
  if (p.style.display === 'block') chatBindFloatClose();
}
function chatCloseFloat() {
  const p = $('#chat-float-panel');
  if (p) p.style.display = 'none';
}
// 弹窗关不掉的修复：打开后点面板外部 / Esc 即关闭（只绑一次，面板常驻 DOM）
let chatFloatCloseBound = false;
function chatBindFloatClose() {
  if (chatFloatCloseBound) return;
  chatFloatCloseBound = true;
  document.addEventListener('click', (e) => {
    const p = $('#chat-float-panel');
    if (!p || p.style.display === 'none') return;
    if (p.contains(e.target) || (e.target instanceof Element && e.target.closest('.js-chat-float-btn'))) return;
    p.style.display = 'none';
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') chatCloseFloat();
  });
}

/* —— 对话主体：POST /api/chat，SSE 流式读取 —— */
async function chatRunMessage(text, attachments) {
  chatLiveTouched = true;   // BASE967-29：当轮消息一旦开始渲染，迟到历史不得覆盖
  chatAddToSession('user', text);   // 先定归属会话（可能新建），结果与工具卡按它路由（BASE967-23）
  // 会话隔离：给当前会话稳定一个 id 并随请求上送，新建会话=新 id → 服务端历史为空，不再串旧上下文
  const sess = chatSessions[chatCurSession];
  if (sess && !sess.id) sess.id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const conversationId = sess ? sess.id : '';
  const turnLayer = chatLayerFor(conversationId);
  chatShowLayer(conversationId);
  chatRunningConv = conversationId;   // 停止/删除守卫按任务标识，不按「当前在看哪个会话」
  chatAddUserMsg(text, turnLayer, attachments);
  chatSetStatus(true);
  const body = chatAiShell(true, turnLayer);   // 流式生成中：绿点呼吸光晕
  chatRunProgress(body,{label:'正在处理'});
  const txt = document.createElement('div');
  txt.className = 'txt';
  body.appendChild(txt);
  const stopThinking = () => body.closest('.m-ai')?.querySelector('.ava')?.classList.remove('thinking');

  chatAbort = new AbortController();
  let res;
  try {
    // 发消息前**先把待推的上下文推出去**（推的是最新那份；服务端按 updated_at 判新旧）。
    // ⚠️ 不 await：上报是后台的，不许挡住用户界面；
    //   这一次对话用的上下文**不会因此变旧** —— 请求体里那份也带 updated_at，服务端照样取最新的那份。
    // ⚠️ `typeof` 守卫：判据会把 real-chat.js **切片**后单独 eval 某几段，
    //   这套上报函数不在那些切片里 —— 不守卫会 ReferenceError，把用例挂死。
    if (typeof chatPushContextNow === 'function' && typeof chatContextPushPending !== 'undefined' && chatContextPushPending) {
      void chatPushContextNow();
    }
    res = await api('api/chat', {
      method: 'POST',
      signal: chatAbort.signal,
      // 附件（PKG-024-T01）：**只带引用**（文件编号 ＋ 固定版本引用）——
      // 字节由服务端按当前身份的读权去读（图给模型看，其余交给工具读正文）。
      body: JSON.stringify({ message: text, ui_context:chatContext, conversation_id: conversationId, engine:chatEngine,
        ...(attachments && attachments.length ? { attachments } : {}) }),
    });
  } catch (e) {
    if (chatAbort.signal.aborted) {
      txt.innerHTML = '<div class="chat-stopped">⏹ 已停止</div>';
      chatAddToSession('assistant', '（已停止）', '', sess);
      chatFinishRun(body,'stopped');stopThinking();
      return;
    }
    /* ours：连接失败在气泡里明说（不往外抛）；fast：本轮执行记录标 error。
       fast 那版是 `chatFinishRun(...); throw e;`（把错抛给上层）——
       ours 改成气泡里显示原因，两者不能同时成立，这里保留 ours 的口径，待主控复核。 */
    txt.innerHTML = `<div role="alert">连接失败：${esc(String(e?.message || e))}，请重试</div>`;
    chatAddToSession('assistant', '（连接失败）', '', sess);
    chatFinishRun(body,'error');stopThinking();
    return;
  }
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    txt.innerHTML = `<span style="color:var(--red,#d33)">对话失败：${esc(err.error || '未知错误')}</span>`;
    chatAddToSession('assistant', '（对话失败）', '', sess);
    stopThinking();
    chatFinishRun(body,'error');
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let ev = '';
  let acc = '';
  let errShown = false;
  let stopped = false;
  let doneReasoning = '';
  let doneReply = '';      // R967-D01：服务端最终回复（被纠正时为如实状态文本）
  let turnStatus = null;   // R967-D01：本轮结构化执行卡（由工具回执驱动）
  let receivedDone=false,hasConfirmation=false;   // fast：本轮有没有收到 done、有没有确认卡
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('event:')) { ev = line.slice(6).trim(); continue; }
        if (!line.startsWith('data:')) continue;
        let data; try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev === 'text') {
          acc += data.delta || '';
          txt.innerHTML = chatRender(acc);
          chatScrollBottom();
        } else if (ev === 'phase') {
          // 阶段透传：思考中 → 开始回复 → 调用工具 → 记录对话（带实时秒数）
          const run=chatRunProgress(body,data);
          chatSetStatus(true,run.box.querySelector('.chat-run-label').textContent);
        } else if (ev === 'done') {
          receivedDone=true;
          // 以服务端最终核实的回答为准，覆盖中途文本（包括被否决的假确认回执）。
          if (typeof data.reply === 'string') { acc=data.reply;txt.innerHTML=chatRender(acc); }
          // 思考版模型（vLLM reasoning / deepseek reasoning_content）的思考过程：随回答一起回显
          doneReasoning = data.reasoning || '';
          doneReply = typeof data.reply === 'string' ? data.reply : '';
        } else if (ev === 'status') {
          // R967-D01：结构化执行卡——由真实工具回执驱动，不是模型文字的复述
          turnStatus = data;
        } else if (ev === 'tool') {
          chatAddToolCard(body, data);
        } else if (ev === 'confirm') {
          hasConfirmation=true;
          chatAddConfirmCard(body, data, {navigate:true});
        } else if (ev === 'ui_patch') {
          chatReceivePatch(data);
        } else if (ev === 'ui_navigate') {
          chatReceiveNavigate(data);
        } else if (ev === 'error') {
          // 真实错误原因上屏（key 失效/超时等）；不再被兜底「无回答」覆盖
          errShown = true;
          txt.innerHTML += `<div style="color:var(--red,#d33);margin-top:6px">⚠ ${esc(data.message || '出错了')}</div>`;
          chatScrollBottom();
        }
      }
    }
  } catch (e) {
    if (chatAbort?.signal.aborted) {
      // 用户点停止：不算错误
      stopped = true;
      txt.innerHTML += '<div class="chat-stopped">⏹ 已停止生成</div>';
      chatScrollBottom();
    } else if (!errShown) {
      // 断线/代理掐流：reader.read() reject。明示中断而不是空气泡。
      errShown = true;
      txt.innerHTML += `<div style="color:var(--red,#d33);margin-top:6px">⚠ 连接中断（${esc(String(e?.message || e))}），请重试</div>`;
      chatScrollBottom();
    }
  }
  // R967-D01：被纠正的回复以服务端如实状态为准（流式已上屏的文字不冒充结果）；执行卡随轮上屏
  let finalText = acc;
  if (turnStatus && Array.isArray(turnStatus.no_receipt_claims) && turnStatus.no_receipt_claims.length && doneReply) {
    txt.innerHTML = chatRender(doneReply);
    finalText = doneReply;
  }
  const emptyTurn = !!(turnStatus && turnStatus.empty_attempts && turnStatus.empty_attempts.length && /未得到有效回答/.test(doneReply || finalText || ''));
  // CHAT-NEXT-01：黄色汇总卡**整块不再生成**（用户 2026-10-19 20:38 明确取消）。
  // 执行事实不丢：工具失败在对应工具卡上、撤回三态在撤回卡上、候选在确认卡上、日志逐条保留。
  // 只有「这一轮没得到有效回答」要给一条重试入口——那是空回答的补救，不是那张汇总卡。
  if (emptyTurn) chatAddRetryAffordance(body, text);
  /* fast：没收到 done 回执就明示中断（不把半截回答当结果）。放在 ours 的纠正口径之后。 */
  if(!receivedDone&&!errShown&&!stopped){
    stopped=!!chatAbort?.signal.aborted;errShown=!stopped;
    txt.innerHTML+=`<div class="chat-stopped">${stopped?'已停止生成':'连接已结束，未收到完成回执，请核对后重试。'}</div>`;
  }
  if (!finalText && !errShown && !stopped) txt.innerHTML = '（无回答）';
  if (doneReasoning) chatInsertReasoning(body, txt, doneReasoning);
  chatAddToSession('assistant', finalText || (stopped ? '（已停止）' : (errShown ? '（出错）' : '（无回答）')), doneReasoning, sess);
  stopThinking();
  chatFinishRun(body,stopped?'stopped':errShown?'error':hasConfirmation?'confirm':'done');
}
// 思考过程折叠块：默认收起，不挤占回答；点开回看模型推理。
function chatInsertReasoning(body, anchor, reasoning) {
  const box = document.createElement('details');
  box.className = 'chat-reasoning';
  box.innerHTML = `<summary>思考过程</summary><div class="cr-body">${chatRender(reasoning)}</div>`;
  body.insertBefore(box, anchor);
  return box;
}

/* —— 助手附件（PKG-024-T01，2026-10-22 用户 12:53 报「不能看图、不能传图片等附件」）——

   **为什么不是发票那条路**：发票识别口（`/api/platform/finance/documents`）是**财务域**的
   解析＋落文件，图进去也不会「给模型看」。这里走**通用**路径：
   文件域的公共上传口（`files.upload`）⇒ 拿到**受管文件引用**（文件编号 ＋ 固定版本的
   原件引用）⇒ 发消息时**带引用**进对话 ⇒ 服务端按**当前身份的读权**把字节读回来：
     · **图片** ⇒ 直接给模型看（模型自己看像素）；
     · **其它文件** ⇒ **只带引用**（正文由工具去读，不塞提示词）。
   ⇒ 附件要有出处：留在文件中心（个人归属），谁能读它，谁才能从对话里看到它。 */
let chatPendingAttachments = [];
const CHAT_ATTACH_MAX = 5;

/** 待发附件的**小标签**（输入框上方）：看得见、能撤、**看得见落在文件中心的哪一条**。 */
function chatAttachRender() {
  const box = document.getElementById('chat-attach-list');
  if (!box) return;
  box.hidden = !chatPendingAttachments.length;
  box.innerHTML = chatPendingAttachments.map((a, i) =>
    `<span class="chat-attach-chip" title="${esc(a.name)}｜文件中心文件编号：${esc(a.file || '')}">📎 ${esc(a.name)}`
    + `<span class="chat-attach-loc">文件中心</span>`
    + `<button type="button" class="chat-attach-x" onclick="chatAttachRemove(${i})" aria-label="移除附件">×</button></span>`).join('');
}
function chatAttachRemove(index) {
  chatPendingAttachments.splice(index, 1);
  chatAttachRender();
}

/** 调平台公共动作（文件域的上传口）。 */
async function chatPlatformAction(actionId, payload) {
  const r = await api('api/platform/actions/' + encodeURIComponent(actionId) + '/execute', {
    method: 'POST',
    body: JSON.stringify({ payload, confirmed: true, idempotency_key: actionId + '-' + crypto.randomUUID() }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) throw new Error(d.error || ('办理失败：' + actionId));
  return d.result || d;
}
/** 调平台公共服务（取固定版本引用）。 */
async function chatPlatformService(serviceId, payload) {
  const r = await api('api/platform/services/' + encodeURIComponent(serviceId) + '/invoke', {
    method: 'POST', body: JSON.stringify({ payload }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) throw new Error(d.error || ('读取失败：' + serviceId));
  return d.result || d;
}

/** 选一个文件 → 上传到文件域 → 变成一条**待发附件**（不立刻发消息）。 */
async function chatAttachFile(input) {
  const f = (input.files || [])[0];
  input.value = '';
  if (!f) return;
  if (chatPendingAttachments.length >= CHAT_ATTACH_MAX) { toast('附件太多', '一轮最多附 ' + CHAT_ATTACH_MAX + ' 个文件'); return; }
  chatSetStatus(true, '上传附件');
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (!bytes.length) throw new Error('文件是空的，没有上传');
    if (bytes.length > 20 * 1024 * 1024) throw new Error('单个文件不能超过 20MB');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const b64 = btoa(binary);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    const uploaded = await chatPlatformAction('files.upload', {
      file_name: f.name, content_base64: b64, file_sha256: sha, attribution: { level: 'personal' },
    });
    if (!uploaded || !uploaded.file) throw new Error('上传回执不完整');
    // 固定版本的原件引用（下载/读字节都要用它，不是文件名也不是记录号）。
    const versions = await chatPlatformService('files.versions', { file: uploaded.file });
    const list = (versions && (versions.versions || (versions.result && versions.result.versions))) || [];
    const hit = list.find(v => v.version_no === uploaded.version);
    if (!hit || !hit.frappe_file) throw new Error('上传后拿不到固定版本的受管文件引用');
    chatPendingAttachments.push({
      name: f.name,
      mime: f.type || '',
      // **文件中心的文件编号**（`files.upload` 建的是文件中心的受管文件）
      // ⇒ 用户看得见它落在哪；业务域/工具也能引用**同一份**，不用重传一遍。
      file: uploaded.file,
      ref: { ref_doctype: 'Shangshu File Center File', ref_name: uploaded.file, file: hit.frappe_file },
    });
    chatAttachRender();
  } catch (e) {
    toast('附件没加上', String(e && e.message ? e.message : e));
  } finally {
    chatSetStatus(false);
  }
}

/* —— 对话单据上传：入口只在平台实时工具目录声明文档/财务能力时出现。 —— */
let chatUploading = false;
async function chatUploadInvoice(input) {
  const f = (input.files || [])[0];
  input.value = '';
  if (!f || chatUploading) return;
  chatUploading = true;
  chatSetStatus(true, '上传识别发票');
  chatAddUserMsg('📎 上传发票：' + f.name);
  // 「识别中」壳：级联 OCR 规则层是毫秒级，但用户需要看到识别过程（否则像假识别）——给最短识别时长
  const shell = chatAiShell(true);
  shell.innerHTML = '<div class="txt" style="color:var(--fg2)">正在识别发票内容（级联解析：文字层 → 文本模型 → 视觉模型）…</div>';
  const started = Date.now();
  try {
    const buf = await f.arrayBuffer();
    const r = await api('/api/platform/finance/documents', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(f.name) }, body: buf }).then(x => x.json());
    const wait = 2400 - (Date.now() - started);
    if (wait > 0) await new Promise(res => setTimeout(res, wait));
    shell.closest('.msg').remove();
    chatAddUploadCard(r, f.name);
  } catch (e) {
    shell.closest('.msg').remove();
    chatAddUploadCard({ ok: false, error: (e && e.message) || '上传失败' }, f.name);
  } finally {
    chatUploading = false; chatSetStatus(false);
  }
}
function chatExtractAttribution(r) {
  const tool = r.tool_used || '';
  const path = r.extraction_path || '';
  const steps = Array.isArray(r.flow_steps) ? r.flow_steps : [];
  const stepNote = steps.map((s) => s.attribution || s.name).filter(Boolean).join(' → ');
  if (tool || path) return [tool, path].filter(Boolean).join(' · ');
  if (stepNote) return `流程：${stepNote}`;
  return '抽取步骤已留痕（见办事流程）';
}
function chatAddUploadCard(r, filename) {
  const body = chatAiShell(false);
  const c = document.createElement('div');
  c.className = 'cf-card business-confirm';
  const attr = chatExtractAttribution(r);
  if (!r.ok) {
    c.innerHTML = `<span class="cf-tag">◈ 收票 · 失败</span>
      <div class="cf-title">${esc(filename)}</div>
      <div class="cf-body"><div>${esc(r.error || '识别失败，请重试或走审核页上传')}</div></div>`;
  } else if (r.extraction) {
    c.innerHTML = `<span class="cf-tag">◈ 单据抽取 · 已完成</span>
      <div class="cf-title">${esc(filename)}</div>
      <div class="cf-body"><div>抽取记录 ${esc(r.extraction)}${r.invoice ? ` · 发票记录 ${esc(r.invoice)}` : ''} · 工具 ${esc(r.tool?.id || '平台已记录')}</div></div>
      <div class="cf-actions"><button class="cf-btn ok" type="button">去应用查看</button></div>`;
    c.querySelector('button').onclick = () => go('applications');
  } else if (r.status === 'duplicate') {
    c.innerHTML = `<span class="cf-tag">◈ 收票 · 重复</span>
      <div class="cf-title">${esc(filename)}</div>
      <div class="cf-body"><div>这张发票已在库里（${esc(r.invoice_no || '号码未识别')}），不重复入库</div></div>`;
  } else if (r.invoice_status === '已入账') {
    c.innerHTML = `<span class="cf-tag">◈ 收票 · 已入账</span>
      <div class="cf-title">${esc(r.seller_name || filename)} · ${money(r.total_amount)}</div>
      <div class="cf-body"><div>发票号 ${esc(r.invoice_no || '未识别')} · 抽取：${esc(attr)} · 经确认卡入账，记账表已 append</div></div>
      <div class="cf-actions"></div>`;
    const zone = c.querySelector('.cf-actions');
    const b = document.createElement('button');
    b.className = 'cf-btn ok'; b.textContent = '看看资金总览';
    b.onclick = () => chatSendChip('查一下这个月的资金总览');
    zone.appendChild(b);
  } else {
    // 待审：两阶段确认——先确认「这是一张发票」（AI 也会看错票），再展开字段核对
    const renderStage2 = () => {
      c.innerHTML = `<span class="cf-tag">◈ 收票 · 待审</span>
        <div class="cf-title">${esc(r.seller_name || filename)} · ${money(r.total_amount)}</div>
        <div class="cf-body"><div>发票号 ${esc(r.invoice_no || '未识别')} · 购方 ${esc(r.buyer_name || '—')} · 开票日 ${esc(r.issued_at || '—')} · 抽取：${esc(attr)} · 核对无误后入库，才能入账</div></div>
        <div class="cf-actions"></div>`;
      const zone = c.querySelector('.cf-actions');
      const b1 = document.createElement('button');
      b1.className = 'cf-btn ok'; b1.textContent = '核对无误，提案入库';
      b1.onclick = () => chatSendChip(`发票 ${r.invoice_no || r.invoice_id} 审核通过入库`);
      const b2 = document.createElement('button');
      b2.className = 'cf-btn no'; b2.textContent = '去审核页核对';
      b2.onclick = () => go('review');
      zone.appendChild(b1); zone.appendChild(b2);
    };
    c.innerHTML = `<span class="cf-tag">◈ 收票 · 识别完成</span>
      <div class="cf-title">${esc(r.seller_name || filename)} · ${money(r.total_amount)}</div>
      <div class="cf-body"><div>按 ${esc(attr)} 抽取完成——先确认票面对不对，再核对字段</div></div>
      <div class="cf-actions"></div>`;
    const zone = c.querySelector('.cf-actions');
    const bYes = document.createElement('button');
    bYes.className = 'cf-btn ok'; bYes.textContent = '是发票，核对字段';
    bYes.onclick = renderStage2;
    const bNo = document.createElement('button');
    bNo.className = 'cf-btn no'; bNo.textContent = '不是发票';
    bNo.onclick = () => chatSendChip(`发票 ${r.invoice_no || r.invoice_id} 不是发票，帮我拒掉`);
    zone.appendChild(bYes); zone.appendChild(bNo);
  }
  body.appendChild(c);
  chatScrollBottom();
}

function chatSendInput() {  const v = chatInput.value.trim();
  if (!v) return;
  if (chatRunning) { toast('Agent 正在执行', '输入已保留，请等待完成或停止生成'); return; }
  // 附件**跟着这一条消息走**（PKG-024-T01）：发完就清空待发列表。
  const attachments = chatPendingAttachments.slice();
  chatPendingAttachments = [];
  chatAttachRender();
  chatInput.value = ''; chatInput.style.height = 'auto'; chatHideSlash();
  chatGuardFlow(() => chatRunMessage(v, attachments));
}
function chatSendChip(text) { chatGuardFlow(() => chatRunMessage(text)); }

/* —— slash 菜单：只展示 Frappe public_api 实际给 Agent 的工具。 —— */
let PLATFORM_CHAT_TOOLS = [];
let CHAT_TOOL_HINTS = [{ name: '平台助手', hint: '说明你现在能协助我做什么', ico: 'doc' }];
let CHAT_CHIPS = [{ label: '你现在能做什么', text: '说明你现在能协助我做什么' }, { label: '整理当前工作', text: '帮我梳理当前页面和待办，给出下一步建议' }];

function chatToolPrompt(tool) {
  const title = tool.title || tool.label || tool.id || '这项能力';
  const write = (tool.confirmation || tool.confirmation_policy) === 'required';
  return write ? `使用「${title}」协助我生成一份待确认提案` : `使用「${title}」协助我查询当前信息`;
}

async function refreshPlatformChatTools() {
  let tools = [];
  if (typeof isPlatformManaged === 'function' && isPlatformManaged()) {
    const response = await api('/api/platform/tools');
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || '能力目录读取失败');
    tools = data.list || [];
  }
  PLATFORM_CHAT_TOOLS = tools;
  CHAT_TOOL_HINTS = tools.length ? tools.map(tool => ({
    name: tool.title || tool.label || tool.id,
    hint: chatToolPrompt(tool),
    ico: String(tool.effect || '').includes('write') || (tool.confirmation || tool.confirmation_policy) === 'required' ? 'route' : 'doc',
  })) : [{ name: '平台助手', hint: '说明你现在能协助我做什么；没有真实工具时不要声称查询或修改了业务数据', ico: 'doc' }];
  CHAT_CHIPS = tools.length
    ? tools.slice(0, 4).map(tool => ({ label: tool.title || tool.label || tool.id, text: chatToolPrompt(tool) }))
    : [{ label: '你现在能做什么', text: '说明你现在能协助我做什么' }, { label: '整理当前工作', text: '帮我梳理当前页面和待办，给出下一步建议' }];
  // 上传入口**始终可见**（2026-10-22 用户报：「assistant agent 没有办法看图，
  // 没办法上传图片等附件」⇒ 以前它是**按「有没有发票类工具」才露出来**的，
  // 没有那些工具时就**永远藏着**，人根本找不到入口）。
  const upload = $('#chat-upload-btn');
  if (upload) upload.hidden = false;
  const summary = $('#chat-capability-summary');
  if (summary) summary.innerHTML = chatCapabilitySummary();
  if ($('#chat-float-abs')) chatInitAbilities();
  if ($('#chips')) chatInitChips();
  return tools;
}
/** 「/ 查看能力」浮层：**可开可关**（2026-10-22 用户报：点了收不回来，一直卡着）。
 *  ⇒ 用同一个按钮再点一次就收起；输入框里没有 `/` 时也收起。 */
function chatShowSlash() {
  const menu = $('#slash-menu');
  if (!menu) return;
  if (menu.style.display === 'block') { chatHideSlash(); return; }   // 再点一次 ⇒ 收起
  $('#slash-list').innerHTML = CHAT_TOOL_HINTS.map(s => `
    <div class="slash-item" onclick="chatPickTool('${esc(s.hint)}')">
      <span class="si">${CHAT_ICONS[s.ico]}</span><span class="sn">${s.name}</span><span class="sd">${esc(s.hint)}</span>
    </div>`).join('');
  menu.style.display = 'block';
}
function chatHideSlash() { const menu = $('#slash-menu'); if (menu) menu.style.display = 'none'; }
function chatPickTool(hint) {
  chatHideSlash(); chatInput.value = hint;
  chatInput.focus();
}
function chatInitAbilities() {
  const box = $('#chat-float-abs');
  if (!box) return;
  box.innerHTML = CHAT_TOOL_HINTS.map(s => `
    <div class="chat-float-item" onclick="chatPickTool('${esc(s.hint)}')">
      <span class="si">${CHAT_ICONS[s.ico]}</span><span>${esc(s.name)}</span>
    </div>`).join('');
}

function chatInitChips() {
  const zone = $('#chips');
  if (!zone) return;
  zone.innerHTML = CHAT_CHIPS.map((c, i) => `
    <button class="chip" style="animation-delay:${0.4 + i * 0.07}s" onclick="chatSendChip('${esc(c.text)}')">${c.label}<span class="ar">→</span></button>`).join('');
}
function chatCapabilitySummary() {
  return PLATFORM_CHAT_TOOLS.length
    ? `当前有 <b>${PLATFORM_CHAT_TOOLS.length}</b> 项平台能力可用；目录会随应用启停和你的权限实时变化。`
    : '当前没有接入统一内核的业务工具；我可以解释页面和提供操作建议，但不会声称已查询或修改业务数据。';
}
function chatWelcome() {
  const layer = chatLayerFor('__welcome__');
  layer.innerHTML = '';
  chatShowLayer('__welcome__');
  const today = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'][today.getDay()];
  const body = chatAiShell(false, layer);
  body.closest('.msg').dataset.chatWelcome='';   // fast：欢迎块打标记（发第一条消息时整块撤掉）
  const brief = document.createElement('div');
  brief.className = 'brief';
  brief.innerHTML = `
    <div class="brief-hd"><span class="t">早上好，${esc(currentUserInfo?.display_name || '')}</span><span class="d">${today.getMonth() + 1}月${today.getDate()}日 周${week} · 我是你的数字分身，基于系统真实数据回答</span></div>
    <div class="brief-list">
      <div class="brief-item"><span class="lv l2">能力</span><span class="tx" id="chat-capability-summary">${chatCapabilitySummary()}</span></div>
      <div class="brief-item"><span class="lv l3">写入</span><span class="tx"><b>任何高风险写操作仍需人工确认</b><br><span style="font-size:12px;color:var(--fg2)">没有成功工具回执时，AI 不得声称已经提交或生效。</span></span></div>
    </div>
    <div class="chips" id="chips"></div>`;
  body.appendChild(brief);
  chatInitChips();
  chatScrollBottom();
  void chatEnsurePendingCue();
  void chatLoadPendingConfirmations();   // fast：欢迎页也把「还没处理」的建议列出来
}
// R967-D01（BASE967-29）：当轮是否有可见内容（历史回包不许覆盖这些）
// ⚠️ **骨架不算「当轮内容」**（2026-10-30 · PKG-133 · 浏览器走查撞出来的缺陷④）：
//   `chatHistorySkeleton()` **照真的对话流搭**（自己说的靠右 `.m-user`、对方说的靠左 `.m-ai`）
//   ⇒ 而这个函数查的**正是** `.m-user`／`.m-ai`
//   ⇒ 摆上骨架之后 ⇒ 骨架**自己算成「用户已有内容」**
//   ⇒ 回包到了再问一次 ⇒ 还是 true ⇒ 于是把骨架**删掉**、而且**不重放历史**
//   ⇒ **历史一条都没画**（聊天是空的，明明有历史）。
// ⇒ 现在：**骨架里的那些不算**（只认骨架**外面**的）。
function chatHasLiveContent() {
  if (!chatEl) return false;
  // 骨架里的气泡**不算**用户内容（骨架只是「正在取数」的占位）。
  const outside = el => !el.closest('.chat-loading');
  if (chatEl.querySelector('.msg') && outside(chatEl.querySelector('.msg'))) return true;
  for (const el of chatEl.querySelectorAll('.m-user,.m-ai')) if (outside(el)) return true;
  return false;
}
async function chatLoadHistory() {
  // 有当轮内容时不用加载占位清屏；占位只给空画布
  const hadLiveAtStart = chatHasLiveContent() || chatLiveTouched;
  if (!hadLiveAtStart) chatEl.innerHTML = chatHistorySkeleton();
  // fast：记下这一次的交互代号 —— 回包到达时若用户已切会话/新建，历史不许覆盖新画布
  const generation=window.chatInteractionGeneration||0,host=chatEl;
  const current=()=>host===chatEl&&generation===(window.chatInteractionGeneration||0);
  try {
    const r = await api('api/chat/history').then(x => x.json());
    if(!current())return;
    const list = r.list || [];
    // 回包到达时重新判定：这期间用户可能已发出当轮消息——迟到历史不得覆盖、不得劫持会话归属
    const hadLive = chatHasLiveContent() || chatLiveTouched;
    if (hadLive) chatEl.querySelectorAll('.chat-loading').forEach((el) => el.remove());
    if (list.length) {
      // 会话分组：优先按后端 conversation_id（新架构），缺失时退化为按 25 分钟间隔
      const historySessions = [];
      let cur = { title: '', time: '', msgs: [], id: '' };
      let lastTs = 0;
      for (const m of list) {
        const ts = Date.parse(m.created_at || '') || 0;
        const mcid = m.conversation_id || '';
        const boundary = (cur.id && mcid && mcid !== cur.id)
          || (!mcid && cur.msgs.length && ts && lastTs && ts - lastTs > CHAT_SESSION_GAP_MS);
        if (boundary) {
          cur.title = chatSessionTitle(cur.msgs); cur.time = chatTimeLabel(lastTs);
          historySessions.push(cur); cur = { title: '', time: '', msgs: [], id: mcid };
        }
        if (!cur.id && mcid) cur.id = mcid;
        cur.msgs.push({ role: m.role, content: m.content, reasoning: m.reasoning || '', cards: m.cards || null });
        if (ts) lastTs = ts;
      }
      cur.title = chatSessionTitle(cur.msgs); cur.time = chatTimeLabel(lastTs || Date.now());
      historySessions.push(cur);
      // 合并进本地会话表：同 id 取并集（历史顺序打底，本地当轮多出的保留），不同 id 追加。
      for (const hs of historySessions) {
        const local = hs.id ? chatSessions.find((s) => s.id === hs.id) : null;
        if (local) {
          const seen = new Set(local.msgs.map((m) => m.role + ' ' + m.content));
          for (const m of hs.msgs) {
            const key = m.role + ' ' + m.content;
            if (!seen.has(key)) { local.msgs.push(m); seen.add(key); }
          }
          if (hs.title) local.title = hs.title;
          if (hs.time) local.time = hs.time;
        } else {
          chatSessions.push(hs);
        }
      }
      // 只有画布仍空（用户没开始过）才自动打开最近会话；有当轮内容时保持现状，历史在侧栏可找回
      if (!hadLive) {
        for (let i = chatSessions.length - 1; i >= 0; i--) {
          if (chatSessions[i] && chatSessions[i].msgs.length) { chatCurSession = i; break; }
        }
        if (chatCurSession >= 0 && chatSessions[chatCurSession]) chatReplaySession(chatSessions[chatCurSession].msgs);
      }
    } else if (!hadLive) {
      chatWelcome();
    }
    chatRenderSessions();
  } catch { if(current() && !(chatHasLiveContent() || chatLiveTouched)) { chatWelcome(); chatRenderSessions(); } }
}

/* ============ 模块入口 ============
   对话 DOM 只挂载一次到 #ai-copilot；三种形态只是 CSS 布局切换，消息/SSE/输入状态不重建。 */
RENDER.chat = async function () {
  chatEnsureMounted();
  chatSetMode('full');
  chatModelInit();
};

function chatBindFabDrag(fab) {
  if (!fab || fab.dataset.dragBound) return;
  fab.dataset.dragBound = 'true';
  fab.style.touchAction = 'none';
  let start = null, moved = false, suppressClick = false, position = null;
  const place = (x,y) => {
    const r=fab.getBoundingClientRect();
    position={x:Math.max(8,Math.min(x,innerWidth-r.width-8)),y:Math.max(8,Math.min(y,innerHeight-r.height-8))};
    Object.assign(fab.style,{left:position.x+'px',top:position.y+'px',right:'auto',bottom:'auto'});
  };
  try {const p=JSON.parse(localStorage.getItem('shangshu.ai.fab-position'));if(p&&Number.isFinite(p.x)&&Number.isFinite(p.y))place(p.x,p.y);} catch (_) {}
  fab.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;
    const r=fab.getBoundingClientRect();start={id:e.pointerId,x:e.clientX,y:e.clientY,left:r.left,top:r.top};moved=false;
    fab.setPointerCapture(e.pointerId);
  });
  fab.addEventListener('pointermove',e=>{
    if(!start||e.pointerId!==start.id)return;
    const dx=e.clientX-start.x,dy=e.clientY-start.y;
    if(!moved&&Math.hypot(dx,dy)<5)return;
    moved=true;fab.style.cursor='grabbing';place(start.left+dx,start.top+dy);e.preventDefault();
  });
  const finish=e=>{
    if(!start||e.pointerId!==start.id)return;
    if(moved){suppressClick=true;try{localStorage.setItem('shangshu.ai.fab-position',JSON.stringify(position));}catch(_){}setTimeout(()=>{suppressClick=false;},0);}
    start=null;fab.style.cursor='';
  };
  fab.addEventListener('pointerup',finish);fab.addEventListener('pointercancel',finish);
  fab.addEventListener('click',e=>{if(suppressClick){e.preventDefault();e.stopImmediatePropagation();suppressClick=false;}},true);
  window.addEventListener('resize',()=>{if(position)place(position.x,position.y);});
}

document.addEventListener('DOMContentLoaded', () => {
  chatBindSplitter();
  chatBindBusinessContext();
  chatBindPendingReviews();
  chatBindUndoReceipts();   // BASE967-35：编辑器里发起的撤回也要在聊天里看得见三态
  const fab = $('#ai-fab');
  if (fab) {
    chatBindFabDrag(fab);
    fab.classList.add('show');
    chatUpdateFab();
    void chatEnsurePendingCue();
  }
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
      e.preventDefault(); chatToggle();
    }
    if (e.key === 'Escape' && chatMode === 'float') chatSetMode('hidden');
  });
});
