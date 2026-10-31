/* 管理后台：运行事实投影；预检与执行共用服务端启停判断。
 *
 * 2026-10-21 版式重做（用户：「admin 设置页还是不够理想，感觉还是很丑」）：
 * · 页头给**总览条**（业务域 / 系统组件 / 已启用 / 动作总数）—— 一眼看完再往下；
 * · 卡片**分两段**：「业务域」与「系统组件」（原来标题写一句、卡片混在一起）；
 * · 卡片**收紧**：标题＋版本＋状态徽标一行，四个数字做成小格，日常入口一行，
 *   **危险操作（完全停用）收进二级菜单（⋯）**并仍走二次确认 —— 不跟日常入口并排；
 * · 「依赖、引用与运行检查」做成**默认收起的可展开控件**（原来像一行死文本）；
 * · 状态徽标**统一词**：已启用 / 始终启用 · 受系统保护 / 已停用；
 * · 管理功能的 **tab 标出当前在哪**；域多了**能搜、能按状态筛**。
 *
 * ⚠️ **业务语义一个字没改**：启停判断、预检口径、二次确认表单、动作口全是原来那套；
 *   这一版只动**版式**（分组、层次、控件形态、危险操作的藏法）。
 */
let appsRequest=0;

/**
 * 管理后台那几页的**页签条清单**（2026-10-21）。
 * 放在这一页：它是「管理后台」自己的那一组页面 —— 加管理页只改这一处；
 * 公共壳（app.js）只负责「画出来 + 标当前 + 绑跳转」（shangshuRenderAdminDestinations）。
 */
const ADMIN_DESTINATIONS=[['apps', '管理后台'], ['accounts', '账号管理'], ['ai-tools', 'AI 工具'],
  ['modules', '导航设置'], ['objects', '跨应用数据'], ['config', '系统设置']];

/** 页签条（当前页标 aria-current="page"）。 */
window.shangshuAdminDestinations = (current) => {
  return `<nav class="admin-destinations" aria-label="管理功能">${ADMIN_DESTINATIONS.map(([route, title]) =>
    `<button type="button" class="admin-dest${route === current ? ' on' : ''}" data-route="${route}"`
    + `${route === current ? ' aria-current="page"' : ''}>${title}</button>`).join('')}</nav>`;
};

/**
 * 平台自带的公共件（所有行业线共用的底座与公共能力）＝「系统组件」；
 * 其余是某个行业线/专项用的「业务域」。
 * ⚠️ 这三个是**平台自己的 app**（core / files / mail）—— 新增平台公共件时补进来。
 */
const PLATFORM_COMPONENT_APPS=['shangshu_core','shangshu_files','shangshu_mail'];

RENDER.apps=async function(page){
  const main=page?.host||mainBox(), request=++appsRequest;
  const active=()=>request===appsRequest&&main.isConnected&&(!page||page.isActive());
  if(currentUserInfo?.role!=='admin'){main.innerHTML='<div class="platform-empty">只有系统管理员可以管理业务域。</div>';return;}
  main.innerHTML=`<section class="platform-page apps-page admin-page">
  <header class="page-hd platform-page-head page-heading">
    <h1>管理后台</h1>
    <div class="page-actions"><button class="btn btn-ghost" data-back>返回应用</button></div>
  </header>
  <nav class="admin-destinations" aria-label="管理功能" data-admin-destinations></nav>
  <div class="admin-overview" data-overview></div>
  <div class="admin-apps-toolbar">
    <label class="admin-apps-search"><input type="search" data-apps-search placeholder="搜业务域或系统组件" aria-label="搜业务域或系统组件"></label>
    <select data-apps-filter aria-label="按状态筛选">
      <option value="">全部状态</option>
      <option value="on">已启用</option>
      <option value="off">已停用</option>
    </select>
    <span class="admin-apps-count" data-apps-count aria-live="polite"></span>
  </div>
  <section class="admin-apps-section" data-section="domain">
    <div class="admin-apps-section-head">
      <h2 class="admin-apps-section-title">业务域</h2>
      <span class="admin-apps-section-count"></span>
      <span class="admin-apps-section-hint">某个行业线或专项在用的业务能力</span>
    </div>
    <div class="apps-grid" data-apps-grid="domain"></div>
  </section>
  <section class="admin-apps-section" data-section="component">
    <div class="admin-apps-section-head">
      <h2 class="admin-apps-section-title">系统组件</h2>
      <span class="admin-apps-section-count"></span>
      <span class="admin-apps-section-hint">平台底座与公共能力 —— 所有行业线共用</span>
    </div>
    <div class="apps-grid" data-apps-grid="component"></div>
  </section>
  </section>`;
  $('[data-back]',main).onclick=()=>go('applications');
  /* 页签条：公共壳一份实现（app.js），当前页标 aria-current。 */
  if(typeof window.shangshuRenderAdminDestinations==='function')window.shangshuRenderAdminDestinations(main,'apps');
  try{
    const response=await api('/api/platform/domains?include_disabled=1'), data=await response.json();
    if(!response.ok||data.ok===false)throw new Error(data.error||'领域列表加载失败');
    if(active())draw(data.list||[]);
  }catch(error){
    if(!active())return;
    $('.apps-grid',main).innerHTML=`<div class="platform-error" role="alert">${esc(error.message||error)}<button class="btn btn-ghost" data-retry>重试</button></div>`;
    $('[data-retry]',main).onclick=()=>RENDER.apps(page);
  }

  /** 状态徽标：**统一词** —— 已启用 / 始终启用 · 受系统保护 / 已停用。 */
  function stateOf(row,core){
    if(core)return {key:'locked',text:'始终启用 · 受系统保护'};
    if(!row.enabled)return {key:'off',text:'已停用'};
    if(row.execution_stopped)return {key:'off',text:'已停用'};
    return {key:'on',text:'已启用'};
  }

  function diagnostics(row){
    const state=row.lifecycle;
    if(!state)return '<p class="app-diag-note">当前后端未提供启停预检，需升级后检查。</p>';
    const lines=[...(state.requirements||[]).map(item=>[item.optional?'可选集成':'强依赖',item.id,`要求 ${item.version} / 安装 ${item.installed_version||'未知'} · ${item.enabled?'已启用':'未启用'}${item.compatible===false?' · 版本不兼容':''}${item.optional?' · '+(item.available?'可用':'不可用，不阻止本域启用'):''}`]),...(state.applications||[]).map(item=>['应用引用',item.title,item.id]),...(state.instances||[]).map(item=>['在途流程',item.id,'完成后才能完全停用']),...(state.stop_blockers||state.disable_blockers||[]).map(message=>['停用阻断',message,'需先处理'])];
    return `<div class="app-diag-body"><div class="app-diag-scroll"><table class="dtable"><thead><tr><th>类型</th><th>对象</th><th>结果</th></tr></thead><tbody>${lines.map(line=>`<tr>${line.map(value=>`<td>${esc(value)}</td>`).join('')}</tr>`).join('')||'<tr><td colspan="3">当前未发现已注册依赖阻断</td></tr>'}</tbody></table></div>${(state.events||[]).map(event=>`<p class="app-diag-event">${esc(event.id)} · ${esc(event.status)} <button class="btn btn-ghost" data-retry-event="${esc(event.id)}">重试投递</button></p>`).join('')}</div>`;
  }

  function draw(rows){
    const cards=rows.map(row=>cardOf(row)).filter(Boolean);
    const domains=cards.filter(card=>card.section==='domain'), components=cards.filter(card=>card.section==='component');
    $('[data-apps-grid="domain"]',main).innerHTML=domains.map(card=>card.html).join('')||'<p class="admin-empty">还没有业务域。</p>';
    $('[data-apps-grid="component"]',main).innerHTML=components.map(card=>card.html).join('')||'<p class="admin-empty">还没有系统组件。</p>';
    $('[data-section="domain"] .admin-apps-section-count',main).textContent=`${domains.length} 个`;
    $('[data-section="component"] .admin-apps-section-count',main).textContent=`${components.length} 个`;
    /* 总览条：一眼看完再往下。「已启用」＝现在真的在用的域（平台核心一直算在用）。 */
    const enabled=cards.filter(card=>card.enabled).length, actions=cards.reduce((sum,card)=>sum+card.actions,0);
    $('[data-overview]',main).innerHTML=[['业务域',domains.length],['系统组件',components.length],['已启用',enabled],['动作总数',actions]]
      .map(([label,value])=>`<div class="admin-overview-cell"><span class="admin-overview-label">${label}</span><b class="admin-overview-value">${value}</b></div>`).join('');
    bindCards(rows);
    applyFilter();
  }

  function cardOf(row){
    const c=row.contribution||{}, core=row.id==='com.shangshu.core', state=row.lifecycle;
    const unavailable=core||!state||!!state.error;
    const stopBlocked=unavailable||!Array.isArray(state?.stop_blockers)||state.stop_blockers.length>0;
    const enableBlocked=unavailable||state.requirements?.some(item=>!item.optional&&(!item.enabled||item.compatible===false));
    const badge=stateOf(row,core);
    const metrics=[['datasets','数据集'],['processes','流程'],['actions','动作'],['tools','AI 工具']]
      .map(([key,label])=>`<div class="app-metric"><dt>${label}</dt><dd>${(c[key]||[]).length}</dd></div>`).join('');
    /* 日常入口：只是「去看看」，不是危险操作 —— 单独一行、权重轻。 */
    const entries=(c.applications||[]).map(app=>`<button type="button" class="app-entry" data-design-application="${esc(app.id)}">${esc(app.title||'查看应用资源')}</button>`).join('');
    /* 危险操作收进二级菜单（⋯）：不跟日常入口并排。 */
    /* 核心域：停用入口保留但**禁用**（既有契约：核心不可停用，且要看得见为什么）
       —— 原来那是个写着「受系统保护」的禁用按钮；这里仍是禁用按钮，但文案说清「不能停用」。 */
    const menuItems=core
      ? `<button type="button" class="app-menu-item" data-domain="${esc(row.id)}" data-mode="stop" disabled>不能停用（受系统保护）</button>`
      : `${!row.execution_stopped?`<button type="button" class="app-menu-item app-menu-danger" data-domain="${esc(row.id)}" data-mode="stop" ${stopBlocked?'disabled':''}>完全停用</button>`:''}${!row.enabled?`<button type="button" class="app-menu-item" data-domain="${esc(row.id)}" data-mode="enable" ${enableBlocked?'disabled':''}>重新启用</button>`:''}`;
    /* 停用说明：**两种停用不是一回事** —— 完全停用（连存量都不接了）与停止新业务（存量照旧续办）。
       徽标统一说「已停用」，这里把是哪一种说清楚。 */
    const note=row.disabled_reason?`<p class="app-card-note">停用原因：${esc(row.disabled_reason)}</p>`
      :row.execution_stopped?'<p class="app-card-note">已完全停用 · 不再接新业务，存量也不再续办</p>'
      :!row.enabled?'<p class="app-card-note">已停止新业务 · 存量事项照原样续办</p>':'';
    const html=`<article class="app-card ${badge.key==='on'?'on':'off'}" data-domain-card data-name="${esc(row.name)}" data-state="${badge.key}">
      <header class="app-card-head">
        <div class="app-mark">${esc(row.name.slice(0,1))}</div>
        <div class="app-card-title"><h2>${esc(row.name)}</h2><p class="app-card-meta">版本 ${esc(row.version)} · ${esc(row.id)}</p></div>
        <span class="app-state app-state-${badge.key}">${esc(badge.text)}</span>
      </header>
      <dl class="app-metrics">${metrics}</dl>
      ${entries?`<div class="app-entries"><span class="app-entries-label">日常入口</span>${entries}</div>`:''}
      ${note}
      <details class="app-diag">
        <summary>依赖、引用与运行检查</summary>
        ${diagnostics(row)}
      </details>
      <footer class="app-card-foot">
        <details class="app-card-menu">
          <summary class="app-card-menu-toggle" aria-label="更多操作" title="更多操作">⋯</summary>
          <div class="app-card-menu-body">${menuItems}</div>
        </details>
      </footer>
    </article>`;
    return {section:PLATFORM_COMPONENT_APPS.includes(row.owner_app)?'component':'domain',state:badge,enabled:!!row.enabled&&!row.execution_stopped,actions:(c.actions||[]).length,html};
  }

  function bindCards(rows){
    $$('[data-design-application]',main).forEach(button=>button.onclick=()=>{sessionStorage.setItem('shangshu.application.open',button.dataset.designApplication);go('app-design');});
    $$('[data-domain]',main).forEach(button=>button.onclick=()=>{
      const row=rows.find(item=>item.id===button.dataset.domain), enabled=button.dataset.mode==='enable';
      openSchemaForm({title:`${enabled?'启用':'停用'}${row.name}`,description:enabled?`重新启用「${row.name}」后，这块业务能力会重新对所有人开放；服务端会重新检查依赖是否满足。`:`停用「${row.name}」后：保留数据与历史，存量事项照原样续办，但不再接新业务；服务端会重新检查依赖与在途阻断。`,submitLabel:'确认',required:['reason'],properties:{reason:{type:'string',title:'操作原因',minLength:1}},onSubmit:async({reason})=>{
        await submitJSON(`/api/platform/domains/${encodeURIComponent(row.id)}/status`,{enabled,reason,stop_mode:'complete'});
        if(active()){await RENDER.apps(page);renderChrome();}
      }});
    });
    $$('[data-retry-event]',main).forEach(button=>button.onclick=()=>openSchemaForm({title:'重试事件投递',description:'仅重试未成功消费者；沿用原发布身份。外部结果不明时应先对账。',submitLabel:'确认重试',properties:{},onSubmit:async()=>{
      await submitJSON(`/api/platform/event-deliveries/${encodeURIComponent(button.dataset.retryEvent)}/retry`,{});
      if(active())await RENDER.apps(page);
    }}));
  }

  /** 搜索 + 状态筛选：域多了不用自己扫。 */
  function applyFilter(){
    const term=($('[data-apps-search]',main)?.value||'').trim().toLowerCase();
    const filter=$('[data-apps-filter]',main)?.value||'';
    let shown=0,total=0;
    $$('[data-domain-card]',main).forEach(card=>{
      total++;
      const name=(card.dataset.name||'').toLowerCase();
      const match=(!term||name.includes(term))&&(!filter||card.dataset.state===filter);
      card.dataset.hidden=match?'':'true';
      card.hidden=!match;
      if(match)shown++;
    });
    const counter=$('[data-apps-count]',main);
    if(counter)counter.textContent=`显示 ${shown} / ${total}`;
  }

  const search=$('[data-apps-search]',main);
  if(search)search.addEventListener('input',applyFilter);
  const filter=$('[data-apps-filter]',main);
  if(filter)filter.addEventListener('change',applyFilter);
};
