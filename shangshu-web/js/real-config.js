/* ============ 模块：系统配置 ============ */
let CFG = null;
const PROV = { ocr: ['mock', 'dashscope', 'vllm', 'qwen-ocr'], mail: ['folder', 'agently'], store: ['sqlite'], file: ['local'], llm: ['ollama', 'dashscope', 'deepseek'] };
// AI 对话模型一键预设：点一下自动填 provider/base_url/model，再补 API Key 即可。
const LLM_PRESETS = {
  ollama:   { name: '本地 Ollama',   desc: '宿主 · 内网直连', provider: 'ollama',    base_url: 'http://172.30.0.1:11434/v1',          model: 'qwen3:8b' },
  qwen38:   { name: '百炼 qwen3.8-27b', desc: '全精度稠密', provider: 'dashscope', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-27b' },
  qwen36:   { name: '百炼 qwen3.6-35B·A3B', desc: 'MoE · 更快', provider: 'dashscope', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.6-35b-a3b' },
  qwenplus: { name: '百炼 qwen-plus', desc: '轻量', provider: 'dashscope', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  deepseek: { name: 'DeepSeek',      desc: 'DeepSeek API', provider: 'deepseek', base_url: 'https://api.deepseek.com',           model: 'deepseek-chat' },
};
const PROV_ORDER = [['ollama', '本地 Ollama'], ['dashscope', '百炼 DashScope'], ['deepseek', 'DeepSeek']];
RENDER.config = async function () {
  CFG = await apiJSON('api/config');
  const seg = (section) => `<div class="seg" id="seg-${section}">${PROV[section].map(v => `<button class="on" data-v="${v}" onclick="pickProv('${section}','${v}')">${v}</button>`).join('')}</div>`;
  const fld = (s, k, label, type, span) => `<div class="fld" ${span ? 'style="grid-column:1/-1"' : ''}><label>${label}</label><input data-s="${s}" data-k="${k}" type="${type || 'text'}" ${type === 'password' ? 'placeholder="留空不修改"' : ''}></div>`;
  const setSeg = (s, v) => { $$(`#seg-${s} button`).forEach(b => b.classList.toggle('on', b.dataset.v === v)); };

  /* 卡片按组拆分：左子导航分组，不再一屏堆到底 */
  const llmGroups = PROV_ORDER
    .map(([prov, label]) => ({ prov, label, items: Object.entries(LLM_PRESETS).filter(([id, p]) => p.provider === prov) }))
    .filter(g => g.items.length);
  const cardLlm = `<div class="card" id="card-llm"><div class="card-hd"><span class="t">AI 对话模型</span><span class="tag">数字分身</span></div><div class="card-bd">
      <div class="llm-cur" id="llm-cur">当前：</div>
      <div class="llm-sources" id="llm-sources"></div>
      <div class="cell-sub" style="margin:2px 0 12px">来源 = 名称 + 地址 + 模型 + 密钥；点「切换」整条套用（含密钥），聊天框里也能一键切换。云端模型会把对话与单据内容发送给所选供应商，请先确认数据授权。</div>
      <button class="btn btn-ghost" onclick="llmSrcFormToggle(true)">＋ 新增来源</button>
      <div id="llm-src-form" style="display:none;margin-top:14px">
        <div class="llm-presets" id="llm-presets">
          ${llmGroups.map(g => `<div class="llm-preset-grp"><div class="llm-preset-grp-lbl">${esc(g.label)}</div><div class="llm-preset-row">${g.items.map(([id,p]) => `<button type="button" class="llm-preset" data-preset="${id}" onclick="applyLlmPreset('${id}')" title="${esc(p.base_url)}"><b>${esc(p.model)}</b><i>${esc(p.desc)}</i></button>`).join('')}</div></div>`).join('')}
        </div>
        <div class="cell-sub" id="llm-preset-hint" style="margin:-2px 0 12px">点上方预设一键填好 provider / 地址 / 模型，再补名称和 API Key；自定义来源直接手填四件套。</div>
        <div class="fgrid">
          <div class="fld"><label>名称</label><input data-s="llmsrc" data-k="name" placeholder="如：租用 GPU · 快车道"></div>
          <div class="fld"><label>provider</label><div class="seg" id="seg-llmsrc">${PROV.llm.map(v => `<button type="button" data-v="${v}" onclick="pickLlmSrcProv('${v}')">${v}</button>`).join('')}</div></div>
          ${fld('llmsrc','model','model')}
          ${fld('llmsrc','base_url','base_url（OpenAI 兼容）','',true)}
          ${fld('llmsrc','api_key','API Key','password',true)}
          ${fld('llmsrc','desc','说明（可选）','',true)}
        </div>
        <div class="admin-actions"><button class="btn btn-ghost" onclick="llmSrcFormToggle(false)">收起</button><button class="btn btn-pri" onclick="saveLlmSource()" id="llm-src-save">保存来源</button><span class="testr" id="llm-src-msg"></span></div>
      </div>
    </div></div>`;

  const cardOcr = `<div class="card"><div class="card-hd"><span class="t">OCR / 视觉模型</span><span class="tag">发票抽取</span></div><div class="card-bd">
      <div class="fgrid">
        <div class="fld"><label>provider</label>${seg('ocr')}</div>
        ${fld('ocr','endpoint_url','ocr-service 地址')}
        ${fld('ocr','base_url','base_url')}
        ${fld('ocr','model','model')}
        ${fld('ocr','api_key','API Key','password',true)}
      </div>
      <div class="cell-sub" style="margin:-4px 0 10px">抽取结果必须人工核对；入库和入账均受动作契约约束，不按置信度自动记账。云模型会将相关单据内容发送给所选供应商；本地部署不等于模型完全离线。</div>
      <div class="admin-actions"><span class="testr admin-note" id="test-ocr"></span><button class="btn btn-pri" onclick="saveCfg('ocr')">保存</button><button class="btn btn-ghost" onclick="testCfg('ocr')">测试连接</button></div>
    </div></div>`;

  const cardEnterprise = `<div class="card"><div class="card-hd"><span class="t">本企业资料</span></div><div class="card-bd"><div class="fgrid">${fld('enterprise','name','企业名称')}</div><p class="cell-sub">当前实例只服务一家企业。名称用于单据复核提示，不会自动交换购销方，不是多企业切换入口。</p><div class="admin-actions"><button class="btn btn-pri" onclick="saveCfg('enterprise')">保存</button></div></div></div>`;

  const cardInstance = `<div class="card"><div class="card-hd"><span class="t">本地实例</span><span class="tag">单企业</span></div><div class="card-bd">
      <p class="cell-sub">业务主库：SQLite 事务存储；附件：本地目录。数据源和附件目录只允许在维护窗口迁移，不能在页面在线切换。</p>
      <p class="cell-sub">端口调整需要重启；账号密码在「用户管理」修改。这里不再提供不生效的旧管理密码字段。</p>
      <div class="admin-actions"><button class="btn btn-ghost" onclick="checkInstanceHealth()">检查实例状态</button></div>
      <pre id="instance-health"></pre>
    </div></div>`;

  const cardMail = `<div class="card"><div class="card-hd"><span class="t">邮件源</span><span class="tag">发票入口</span></div><div class="card-bd">
      <div class="fgrid">
        <div class="fld"><label>provider</label>${seg('mail')}</div>
        ${fld('mail','agently_mailbox','agently 邮箱')}
        ${fld('mail','folder','folder 路径（folder 模式）','',true)}
      </div>
      <div class="admin-actions"><span class="testr admin-note" id="test-mail"></span><button class="btn btn-pri" onclick="saveCfg('mail')">保存</button><button class="btn btn-ghost" onclick="testCfg('mail')">测试</button></div>
    </div></div>`;

  const cardFeishu = `<div class="card"><div class="card-hd"><span class="t">飞书</span><span class="tag">多维表格 + 云空间</span></div><div class="card-bd">
      <div class="fgrid">
        ${fld('feishu','app_id','App ID')}
        ${fld('feishu','app_secret','App Secret','password')}
        ${fld('feishu','bitable_app_token','多维表格 app_token')}
        ${fld('feishu','invoices_table_id','发票表 table_id')}
      </div>
      <div class="admin-actions"><span class="testr admin-note" id="test-feishu"></span><button class="btn btn-pri" onclick="saveCfg('feishu')">保存</button><button class="btn btn-ghost" onclick="testCfg('feishu')">检查凭证</button></div>
    </div></div>`;

  const cardWebsite = `<div class="card"><div class="card-hd"><span class="t">官网</span><span class="tag">嵌入后台</span></div><div class="card-bd">
      <div class="fgrid">
        ${fld('website','base_url','官网地址')}
        ${fld('website','api_key','API Key','password')}
        ${fld('website','panel_path','管理后台路径')}
        ${fld('website','panel_key','后台密钥','password')}
      </div>
      <div class="admin-actions"><span class="testr admin-note" id="test-website"></span><button class="btn btn-pri" onclick="saveCfg('website')">保存</button><button class="btn btn-ghost" onclick="testWebsite()">测试连接</button></div>
    </div></div>`;

  const cfgGroups = [
    { id: 'ai', name: 'AI 与模型', html: cardLlm + cardOcr },
    { id: 'general', name: '通用', html: cardEnterprise + cardInstance },
    { id: 'integ', name: '集成', html: cardMail + cardFeishu + cardWebsite },
  ];
  const activeGrp = (window.__cfgTab && cfgGroups.some(g => g.id === window.__cfgTab)) ? window.__cfgTab : 'ai';
  window.__cfgTab = undefined;

  mainBox().innerHTML = `
    <section class="admin-page admin-config-page">
    <div class="page-hd page-heading"><h1>系统配置</h1></div>
    <nav class="admin-destinations" data-admin-destinations></nav>
    <div class="cfg-layout">
      <div class="cfg-nav">
        ${cfgGroups.map(g => `<button type="button" class="cfg-nav-item ${g.id === activeGrp ? 'on' : ''}" data-grp="${g.id}" onclick="cfgShowGroup('${g.id}')">${g.name}</button>`).join('')}
      </div>
      <div class="cfg-content">
        ${cfgGroups.map(g => `<div class="cfg-group" data-grp="${g.id}" ${g.id === activeGrp ? '' : 'style="display:none"'}>${g.html}</div>`).join('')}
      </div>
    </div>
    </section>`;
  if(typeof window.shangshuRenderAdminDestinations==='function')window.shangshuRenderAdminDestinations(mainBox(),'config');
  // 回填值
  $$('input[data-s]').forEach(el => {
    const v = CFG[el.dataset.s]?.[el.dataset.k];
    if (v != null && v !== '' && !String(v).includes('••••')) el.value = v;
    else if (String(v || '').includes('••••')) el.placeholder = '已配置（留空不修改）';
  });
  setSeg('ocr', CFG.ocr.provider); setSeg('mail', CFG.mail.provider); setSeg('store', CFG.store.provider); setSeg('file', CFG.file.provider);
  pickLlmSrcProv(CFG.llm?.provider || 'ollama');
  LLM_SRC_EDITING = null;
  renderLlmSources();
  markActiveLlmPreset();
};

/* 配置页分组切换 */
function cfgShowGroup(grp) {
  $$('.cfg-group').forEach(g => { g.style.display = g.dataset.grp === grp ? '' : 'none'; });
  $$('.cfg-nav-item').forEach(b => b.classList.toggle('on', b.dataset.grp === grp));
}

/* ============ 模块：模块管理（独立页） ============ */
RENDER['modules'] = function () {
  const isAdmin = typeof currentRole === 'function' && currentRole() === 'admin';
  mainBox().innerHTML = `
    <section class="admin-page admin-modules-page">
    <div class="page-hd page-heading"><h1>模块管理</h1></div>
    <nav class="admin-destinations" data-admin-destinations></nav>

    <div class="card"><div class="card-hd"><span class="t">模块开关</span><span class="tag">侧栏显示</span></div><div class="card-bd">
      <div class="cell-sub" style="margin:-2px 0 10px" id="mod-mgr-hint"></div>
      <div id="mod-mgr"></div>
    </div></div>

    <div class="card"><div class="card-hd"><span class="t">侧栏布局</span><span class="tag">拖拽定制</span></div><div class="card-bd">
      <div class="cell-sub" style="margin:-2px 0 10px" id="sb-ed-hint"></div>
      <div id="sb-ed-root"></div>
    </div></div>
    </section>`;
  if(typeof window.shangshuRenderAdminDestinations==='function')window.shangshuRenderAdminDestinations(mainBox(),'modules');

  const hint = $('#mod-mgr-hint');
  if (hint) {
    hint.textContent = isAdmin
      ? '这里只管理已注册且当前可用的平台入口；隐藏仅影响侧栏，服务端仍会独立校验权限。'
      : '侧栏 = 顶部核心入口 + 岗位预设（标记「预设」，不可关）+ 你额外打开的模块。开关即时生效。';
  }
  renderModuleMgr();

  const sbHint = $('#sb-ed-hint');
  if (sbHint) {
    sbHint.textContent = isAdmin
      ? '拖拽分组与模块：拖进「我的侧栏」即可显示；拖出移除；锁定为岗位预设（不可移除，可排序）。'
      : '拖拽调整分组与顺序：锁定为岗位预设模块；从右侧模块库拖入添加其他模块。';
  }
  renderSidebarEditor();
};
/* —— 侧栏布局编辑器：拖拽分组 / 模块，替代勾选开关 —— */
let sbEdDrag = null;
let sbEdEventsBound = false;

function sbEdItemHtml(m, { locked = false, sec, idx } = {}) {
  // 点按兜底（拖拽之外的稳妥操作）：模块库「＋」= 添加；侧栏项「×」= 移除（锁定预设仍不可移除）
  const act = sec === '__lib__'
    ? `<button type="button" class="sb-ed-act" title="添加到侧栏" onclick="event.stopPropagation();sidebarLayoutAddMod('${esc(m.id)}')">＋</button>`
    : locked
      ? `<span class="sb-ed-lock" title="岗位预设">🔒</span>`
      : `<button type="button" class="sb-ed-act" title="移出侧栏" onclick="event.stopPropagation();sidebarLayoutRemoveMod('${esc(m.id)}')">×</button>`;
  return `<div class="sb-ed-item" draggable="true" data-mod="${esc(m.id)}" data-sec="${esc(sec)}" data-idx="${idx}">
    <span class="sb-ed-grip" aria-hidden="true">${ICONS.grip}</span>
    <span class="ico">${ICONS[m.ico] || ''}</span>
    <span class="sb-ed-name">${esc(m.name)}</span>${act}
  </div>`;
}

function bindSidebarEditorEvents() {
  if (sbEdEventsBound) return;
  sbEdEventsBound = true;
  document.addEventListener('dragstart', e => {
    const item = e.target.closest('.sb-ed-item');
    const grp = e.target.closest('.sb-ed-grp-hd');
    if (item) {
      sbEdDrag = {
        kind: 'mod',
        id: item.dataset.mod,
        sec: item.dataset.sec || '',
        idx: Number(item.dataset.idx) || 0,
      };
      e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => item.classList.add('dragging'));
      return;
    }
    if (grp) {
      sbEdDrag = { kind: 'grp', id: grp.dataset.sec, sec: grp.dataset.sec, idx: 0 };
      e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => grp.classList.add('dragging'));
    }
  });
  document.addEventListener('dragend', e => {
    e.target.closest('.sb-ed-item,.sb-ed-grp-hd')?.classList.remove('dragging');
    $$('.sb-ed-drop-over').forEach(el => el.classList.remove('sb-ed-drop-over'));
    $$('.sb-ed-drop-before,.sb-ed-drop-after').forEach(el => el.classList.remove('sb-ed-drop-before', 'sb-ed-drop-after'));
    sbEdDrag = null;
  });
  document.addEventListener('dragover', e => {
    if (!sbEdDrag) return;
    const zone = e.target.closest('.sb-ed-grp-body,.sb-ed-lib');
    if (!zone) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    zone.classList.add('sb-ed-drop-over');
    // 插入位置指示线：悬停项上/下半区分别显示上/下边线
    $$('.sb-ed-drop-before,.sb-ed-drop-after').forEach(el => el.classList.remove('sb-ed-drop-before', 'sb-ed-drop-after'));
    const over = e.target.closest('.sb-ed-item');
    if (over && sbEdDrag.kind === 'mod' && over.dataset.mod !== sbEdDrag.id && zone.classList.contains('sb-ed-grp-body')) {
      const rect = over.getBoundingClientRect();
      over.classList.add(e.clientY < rect.top + rect.height / 2 ? 'sb-ed-drop-before' : 'sb-ed-drop-after');
    }
  });
  document.addEventListener('dragleave', e => {
    const zone = e.target.closest('.sb-ed-grp-body,.sb-ed-lib');
    if (!zone || zone.contains(e.relatedTarget)) return;
    zone.classList.remove('sb-ed-drop-over');
    $$('.sb-ed-drop-before,.sb-ed-drop-after').forEach(el => el.classList.remove('sb-ed-drop-before', 'sb-ed-drop-after'));
  });
  document.addEventListener('drop', e => {
    const lib = e.target.closest('.sb-ed-lib');
    if (lib && sbEdDrag?.kind === 'mod') {
      e.preventDefault();
      lib.classList.remove('sb-ed-drop-over');
      sidebarLayoutRemoveMod(sbEdDrag.id);
      return;
    }
    const body = e.target.closest('.sb-ed-grp-body');
    if (!body || !sbEdDrag) return;
    e.preventDefault();
    body.classList.remove('sb-ed-drop-over');
    const toSec = body.dataset.sec;
    if (sbEdDrag.kind === 'grp') {
      sidebarLayoutReorderGroup(sbEdDrag.id, toSec);
      return;
    }
    if (sbEdDrag.kind !== 'mod') return;
    const items = [...body.querySelectorAll('.sb-ed-item')];
    let toIndex = items.length;
    const after = e.target.closest('.sb-ed-item');
    if (after) {
      const rect = after.getBoundingClientRect();
      toIndex = items.indexOf(after) + (e.clientY < rect.top + rect.height / 2 ? 0 : 1);
    }
    sidebarLayoutMoveMod(sbEdDrag.id, toSec, toIndex);
  });
}

function renderSidebarEditor() {
  bindSidebarEditorEvents();
  const root = $('#sb-ed-root');
  if (!root || typeof sidebarEditorGroups !== 'function') return;
  const groups = sidebarEditorGroups();
  const lib = typeof sidebarLibraryModules === 'function' ? sidebarLibraryModules() : [];
  const locked = typeof isSidebarModLocked === 'function' ? isSidebarModLocked : () => false;
  const showKanban = CORE_ITEMS.some(m => m.id === 'kanban' && canSee(m));

  const groupHtml = groups.map(g => {
    const items = g.items.map((id, i) => {
      const m = findWorkspaceItem(id);
      return m ? sbEdItemHtml(m, { locked: locked(id), sec: g.sec, idx: i }) : '';
    }).join('');
    return `<div class="sb-ed-grp" data-sec="${esc(g.sec)}">
      <div class="sb-ed-grp-hd" draggable="true" data-sec="${esc(g.sec)}">
        <span class="sb-ed-grip" aria-hidden="true">${ICONS.grip}</span>
        <span class="sb-ed-grp-name">${esc(g.sec)}</span>
        <span class="sb-ed-grp-count">${g.items.length}</span>
      </div>
      <div class="sb-ed-grp-body" data-sec="${esc(g.sec)}">
        ${items || '<div class="sb-ed-empty">拖入模块</div>'}
      </div>
    </div>`;
  }).join('');

  const libHtml = lib.length
    ? lib.map(m => sbEdItemHtml(m, { sec: '__lib__', idx: 0 })).join('')
    : '<div class="sb-ed-empty">侧栏已包含全部可用模块</div>';

  root.innerHTML = `
    <div class="sb-ed-toolbar">
      <button type="button" class="btn btn-ghost" onclick="resetSidebarLayout()">恢复岗位默认</button>
    </div>
    <div class="sb-ed-panels">
      <div class="sb-ed-panel">
        <div class="sb-ed-panel-hd">我的侧栏 <span class="tag">即时生效</span></div>
        <div class="sb-ed-core">顶部固定 · 对话 · 工作台${showKanban ? ' · 看板' : ''}</div>
        <div class="sb-ed-canvas" id="sb-ed-canvas">${groupHtml}</div>
      </div>
      <div class="sb-ed-panel sb-ed-lib-panel">
        <div class="sb-ed-panel-hd">模块库</div>
        <div class="sb-ed-hint">拖入左侧添加，点「＋」亦可；从侧栏拖回此处或点「×」移除</div>
        <div class="sb-ed-lib" id="sb-ed-lib" data-sec="__lib__">${libHtml}</div>
      </div>
    </div>`;
}

/* —— 模块管理：分组列出全部可见模块，开关额外模块（预设锁定） —— */
function renderModuleMgr() {
  const wrap = $('#mod-mgr');
  if (!wrap || typeof moduleCatalog !== 'function') return;
  const cat = moduleCatalog();
  wrap.innerHTML = cat.map(g => `
    <div class="mod-grp">
      <div class="side-sec" style="padding:8px 2px 4px">${esc(g.sec)}</div>
      <div class="mod-list">
        ${g.items.map(m => `
          <div class="mod-row" data-mod="${esc(m.id)}">
            <span class="mod-name">${esc(m.name)}${m.real ? '' : '<span class="tag am" style="margin-left:6px">mock</span>'}</span>
            <button class="mod-sw ${m.on ? 'on' : ''} ${m.preset ? 'locked' : ''}" onclick="toggleModule('${esc(m.id)}')">
              ${m.preset ? '预设' : (m.on ? '开' : '关')}${!m.real ? ' · mock' : ''}
            </button>
          </div>`).join('')}
      </div>
    </div>`).join('');
}
function pickProv(s, v) {
  $$(`#seg-${s} button`).forEach(b => b.classList.toggle('on', b.dataset.v === v));
  if (s === 'ocr' && v === 'qwen-ocr') { const el = $('input[data-s="ocr"][data-k="model"]'); if (el) el.value = 'qwen-vl-ocr'; }
}
// —— 模型来源管理（ZCode/DSH 式）：来源自带密钥，切换即整条套用 ——
let LLM_SRC_EDITING = null;
function llmSrcSet(k, v) { const el = $(`input[data-s="llmsrc"][data-k="${k}"]`); if (el) el.value = v ?? ''; }
function llmSrcGet(k) { const el = $(`input[data-s="llmsrc"][data-k="${k}"]`); return el ? el.value.trim() : ''; }
function pickLlmSrcProv(v) {
  $$('#seg-llmsrc button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
}
function llmSrcFormToggle(show) {
  const box = $('#llm-src-form'); if (!box) return;
  box.style.display = show ? 'block' : 'none';
  if (show) { const n = $('input[data-s="llmsrc"][data-k="name"]'); if (n) n.focus(); }
}
// 预设模板：一键填 provider/地址/模型，再补名称与 API Key。
function applyLlmPreset(id) {
  const p = LLM_PRESETS[id]; if (!p) return;
  llmSrcFormToggle(true);
  pickLlmSrcProv(p.provider);
  llmSrcSet('base_url', p.base_url);
  llmSrcSet('model', p.model);
  if (!llmSrcGet('name')) llmSrcSet('name', p.name);
  $$('#llm-presets .llm-preset').forEach(b => b.classList.toggle('on', b.dataset.preset === id));
  const hint = $('#llm-preset-hint');
  if (hint) hint.textContent = p.provider === 'dashscope'
    ? '云端模型会把对话与单据内容发送给所选供应商，请先确认数据授权；API Key 会存服务器，不进前端代码。'
    : '本地/直连模型，不经过第三方供应商；无鉴权可留空 API Key。';
}
function renderLlmSources() {
  const box = $('#llm-sources'); if (!box) return;
  const list = CFG?.llm_sources || [];
  const active = CFG?.llm || {};
  if (!list.length) {
    box.innerHTML = '<div class="admin-empty">还没有保存的模型来源。点上面的「＋ 新增来源」，可以先用预设模板填好地址与模型。</div>';
    return;
  }
  box.innerHTML = list.map(s => {
    const on = s.provider === active.provider && s.base_url === active.base_url && s.model === active.model;
    return `<div class="llm-src${on ? ' on' : ''}">
      <div class="llm-src-main"><b>${esc(s.name)}</b>${on ? '<span class="tag">使用中</span>' : ''}<i>${esc(s.model)}</i><span class="llm-src-url">${esc(s.base_url)}</span><span class="llm-src-key">${s.api_key ? '密钥已设置' : '无密钥'}</span></div>
      <div class="llm-src-ops">${on ? '' : `<button class="btn btn-mini" onclick="applyLlmSource('${esc(s.id)}')">切换</button>`}<button class="btn btn-mini" onclick="testLlmSource('${esc(s.id)}', this)">测试</button><button class="btn btn-mini" onclick="editLlmSource('${esc(s.id)}')">编辑</button><button class="btn btn-mini btn-danger" onclick="deleteLlmSource('${esc(s.id)}')">删除</button></div>
    </div>`;
  }).join('');
}
function editLlmSource(id) {
  const s = (CFG?.llm_sources || []).find(x => x.id === id); if (!s) return;
  LLM_SRC_EDITING = id;
  llmSrcFormToggle(true);
  llmSrcSet('name', s.name); llmSrcSet('model', s.model); llmSrcSet('base_url', s.base_url); llmSrcSet('desc', s.desc || '');
  const bk = $('input[data-s="llmsrc"][data-k="api_key"]');
  if (bk) { bk.value = ''; bk.placeholder = s.api_key ? '已设置（留空不修改）' : '未设置'; }
  pickLlmSrcProv(s.provider);
  const btn = $('#llm-src-save'); if (btn) btn.textContent = '保存修改';
}
async function saveLlmSource() {
  const src = {
    id: LLM_SRC_EDITING || ('src-' + Date.now().toString(36)),
    name: llmSrcGet('name'), desc: llmSrcGet('desc'),
    provider: ($('#seg-llmsrc button.on') || {}).dataset?.v || 'ollama',
    base_url: llmSrcGet('base_url'), model: llmSrcGet('model'),
    api_key: llmSrcGet('api_key'),
  };
  if (!src.name || !src.base_url || !src.model) return toast('保存失败', '名称、地址、模型都要填', 'err');
  const list = (CFG?.llm_sources || []).slice();
  const idx = list.findIndex(s => s.id === src.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...src };
  else list.push(src);
  try {
    await submitJSON('api/config/llm/sources', { sources: list }, 'PUT');
    CFG = await apiJSON('api/config');
    LLM_SRC_EDITING = null; llmSrcFormToggle(false);
    const btn = $('#llm-src-save'); if (btn) btn.textContent = '保存来源';
    renderLlmSources(); markActiveLlmPreset();
    toast('已保存来源', '点「切换」整条生效（含密钥）');
  } catch (e) { toast('保存失败', e.message, 'err'); }
}
async function deleteLlmSource(id) {
  const s = (CFG?.llm_sources || []).find(x => x.id === id); if (!s) return;
  if (!confirm(`删除模型来源「${s.name}」？当前生效配置不受影响。`)) return;
  try {
    await submitJSON('api/config/llm/sources', { sources: (CFG.llm_sources || []).filter(x => x.id !== id) }, 'PUT');
    CFG = await apiJSON('api/config');
    if (LLM_SRC_EDITING === id) { LLM_SRC_EDITING = null; llmSrcFormToggle(false); }
    renderLlmSources(); markActiveLlmPreset();
    toast('已删除来源');
  } catch (e) { toast('删除失败', e.message, 'err'); }
}
// 切换 = 服务端整条套用（含密钥），避免只换地址不换密钥导致 401。
async function applyLlmSource(id) {
  const s = (CFG?.llm_sources || []).find(x => x.id === id); if (!s) return;
  try {
    await submitJSON('api/config/llm/apply', { id }, 'POST');
    CFG = await apiJSON('api/config');
    renderLlmSources(); markActiveLlmPreset();
    toast('已切换模型', `${s.name} · ${s.model}；重新提问生效`);
  } catch (e) { toast('切换失败', e.message, 'err'); }
}
async function testLlmSource(id, btn) {
  if (btn) btn.textContent = '…';
  try {
    const j = await apiJSON('api/config/test/llm', { method: 'POST', body: JSON.stringify({ id }) });
    toast(j.ok ? '连接正常' : '连接失败', j.detail || '');
  } catch (e) { toast('测试失败', e.message, 'err'); }
  finally { if (btn) btn.textContent = '测试'; }
}
// 刷新「当前」行与预设高亮。
function markActiveLlmPreset() {
  const l = CFG?.llm || {};
  const cur = $('#llm-cur');
  if (cur) cur.textContent = `当前：${l.provider || '未配置'} · ${l.model || '未配置'} · ${l.base_url || '未配置'}${l.api_key ? ' · 密钥已设置' : ''}`;
  const hit = Object.keys(LLM_PRESETS).find(k => {
    const p = LLM_PRESETS[k];
    return p.provider === l.provider && p.model === l.model;
  });
  $$('#llm-presets .llm-preset').forEach(b => b.classList.toggle('on', b.dataset.preset === hit));
}
function gatherCfg(s) {
  const out = {};
  $$(`input[data-s="${s}"]`).forEach(el => { const v = el.value; if (v !== '' && v != null) out[el.dataset.k] = el.type === 'number' ? Number(v) : v; });
  const act = $(`#seg-${s} button.active`) || $(`#seg-${s} button.on`);
  if (act) out.provider = act.dataset.v;
  return out;
}
async function saveCfg(s) {
  try {await submitJSON('api/config',{[s]:gatherCfg(s)},'PUT');CFG=await apiJSON('api/config');toast('已保存',s+' 配置已保存；外部服务仍需测试');return true;}
  catch(e){toast('保存失败',e.message);return false;}
}
async function testCfg(s) {
  $('#test-' + s).textContent = '测试中…';
  if(!await saveCfg(s)) return;
  const j = await apiJSON('api/config/test/' + s, { method: 'POST' });
  const el = $('#test-' + s); el.textContent = (j.ok ? '✓ ' : '✗ ') + (j.detail || ''); el.style.color = j.ok ? 'var(--green2)' : 'var(--red)';
}


async function testWebsite() {
  $('#test-website').textContent = '测试中…';
  if(!await saveCfg('website')) return;
  try {
    const r = await apiJSON('/api/website/stats/daily');
    const el = $('#test-website');
    if (r && r.kind) {
      el.textContent = '✗ ' + (r.error || '连接失败'); el.style.color = 'var(--red)';
    } else {
      el.textContent = '✓ 连接成功'; el.style.color = 'var(--green2)';
    }
  } catch (e) {
    const el = $('#test-website');
    el.textContent = '✗ 连接失败'; el.style.color = 'var(--red)';
  }
}

async function checkInstanceHealth() {
  const out=$('#instance-health');out.textContent='检查中…';
  try {const r=await apiJSON('api/instance/health');out.textContent=r.checks.map(c=>(c.ok?'✓ ':'⚠ ')+c.name+'：'+c.detail).join('\n');}
  catch(e){out.textContent=e.message;}
}
