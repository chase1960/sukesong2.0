/* ============ 模块：领域中立工作台
   工作台只回答“我现在要做什么”：待办、本人事项、常用应用和协作入口。
   领域指标仍由 workbench_api 贡献，前端不写死业务数字。

   2026-10-28（用户上午在真页面上用浏览器批注「骨架」，圈了工作台这三块）：
   **顶部三块统计卡 / 常用应用 / 最近流程** 三块在**数据到达之前**先显示**骨架占位**，
   数据回来后**原位替换**（同一个容器里换掉骨架，不整页重画、不跳版）。
   —— 观感照**表格工作面**（`css/domains/excel-univer/excel-univer.css` 的 `.excel-loading*`）：
      只画静态结构（灰底块/条），不伪装成已加载数据，也不循环扫光。
   —— 骨架**只表示「正在取数」** ⇒ 不写假数字、假条目、假标题。
   —— 取数失败 ⇒ **原因 ＋ 重试入口**（产品既有的 `.platform-error` 那套写法）：
      既不停在骨架上装样子，也不留空白。
*/
RENDER.dash = async page => {
  const main = mainBox();
  const isAdmin = currentUserInfo?.role === 'admin';

  /* ── 骨架块（**只**表示「正在取数」）——
     **直接用真页面的结构**：真页面上是什么壳（`.workbench-status>button`／`.workbench-app-list>button`／
     `.workbench-recent-list>button`），骨架就是什么壳，**只把「字」换成灰底块**
     ⇒ 数据到了原位替换，版式与 padding 一格不差。 */
  const bar = cls => `<span class="platform-skeleton-bar ${cls}"></span>`;
  const skeletonNote = text => `<p class="platform-skeleton-status" role="status" aria-live="polite">${esc(text)}</p>`;
  /* 顶部三块统计卡：**就是那三张卡**（同一个按钮结构），字换灰底块。 */
  const skeletonStat = () => `<button type="button" class="platform-skeleton" data-skeleton="stat"><span class="platform-skeleton-bar platform-skeleton-label"></span><b class="platform-skeleton-bar platform-skeleton-value"></b><small class="platform-skeleton-bar platform-skeleton-desc"></small></button>`;
  /* 「常用应用」一行：**就是那一行**（同一个按钮结构）。 */
  const skeletonApp = () => `<button type="button"><span class="application-mark"><i class="platform-skeleton-bar platform-skeleton-mark-bar"></i></span><span><b class="platform-skeleton-bar platform-skeleton-app-title"></b><small class="platform-skeleton-bar platform-skeleton-app-desc"></small></span><i class="platform-skeleton-bar platform-skeleton-enter"></i></button>`;
  /* 「最近流程」一行：**就是那一行**。 */
  const skeletonRecent = () => `<button type="button"><span><b class="platform-skeleton-bar platform-skeleton-recent-title"></b><small class="platform-skeleton-bar platform-skeleton-recent-desc"></small></span><i class="platform-skeleton-bar platform-skeleton-enter"></i></button>`;
  const skeletonRows = (row, count) => Array.from({ length: count }, () => row()).join('');

  main.innerHTML = `<section class="platform-page workbench-page">
    <header class="page-hd platform-page-head page-heading"><h1>工作台</h1></header>
    <div class="workbench-status">${skeletonNote('正在读取工作…')}${skeletonRows(skeletonStat, 3)}</div>
    <div class="workbench-layout">
      <section class="platform-section workbench-apps"><div class="platform-section-head"><div><h2>常用应用</h2></div><button class="btn btn-ghost btn-sm" type="button" data-all-apps>全部应用</button></div><div data-app-list>${skeletonNote('正在读取常用应用…')}<div class="workbench-app-list platform-skeleton" data-skeleton="apps">${skeletonRows(skeletonApp, 4)}</div></div></section>
      <section class="platform-section workbench-recent"><div class="platform-section-head"><div><h2>最近流程</h2></div><button class="btn btn-ghost btn-sm" type="button" data-all-work>全部待办</button></div><div data-recent-list>${skeletonNote('正在读取最近流程…')}<div class="workbench-recent-list platform-skeleton" data-skeleton="recent">${skeletonRows(skeletonRecent, 4)}</div></div></section>
    </div>
    <section class="platform-section workbench-domain" data-domain-section hidden><div class="platform-section-head"><div><h2>业务概览</h2></div></div><div class="platform-kpis" data-domain-cards></div></section>
    <section class="platform-section workbench-collaboration"><div class="platform-section-head"><div><h2>协作</h2></div></div><div class="platform-quick-actions"><button class="platform-quick" type="button" data-route="task-mgmt"><span>${ICONS.gantt}</span><b>任务</b><small>反馈进度和验收结果</small></button><button class="platform-quick" type="button" data-route="im"><span>${ICONS.chat}</span><b>消息</b><small>与同事继续沟通</small></button></div></section>
  </section>`;

  const goWork = view => { sessionStorage.setItem('shangshu.process.view', view); go('flowdesign'); };
  $('[data-all-apps]', main).onclick = () => go('applications');
  $('[data-all-work]', main).onclick = () => goWork('pending');
  $$('[data-route]', main).forEach(button => button.onclick = () => go(button.dataset.route));

  /* ⚠️ **这一页的读要带上这一页的取消信号**（审查报告 R06 · PKG-128-T02）：
     人切页以后，公共壳会 abort 这一页的信号 ⇒ 旧页那些还在飞的读**当场被上游掐掉**。
     为什么必须挂：上游（Node 侧）主要靠**固定超时**收尾，**不消费客户端断开**
     ⇒ 不挂信号 ⇒ 旧页那 5 个读照旧跑到底（白占资源），回来时还会去改已经没人看的旧页面。
     ⚠️ **只有读挂**：写（发起/发布/停用）**不挂** ——
     已发出的写必须保留**核验与恢复**语义，不能因为人切了页就被盲目撤销。 */
  const read = async path => {
    const response = await api(path, page?.signal ? { signal: page.signal } : undefined);
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || '读取失败');
    return data;
  };
  /* —— **应用清单走公共清单口**（2026-10-28 15:3x · 站上实测）——
     改之前这一页**自己又拉一遍** ⇒ 同一份清单一页里读两遍（每次 252KB，
     服务端排队 ⇒ 第三遍到 2.4 秒才回来）⇒ 侧栏那一遍还没回来，这里又发一次。
     ⇒ 走 `shangshuPlatformCatalog` ⇒ 跟侧栏**共用同一遍**。 */
  const readApplications = async () => {
    const catalog = window.shangshuPlatformCatalog;
    if (catalog && typeof catalog.applications === 'function') {
      const shared = await catalog.applications();
      return shared && typeof shared === 'object' ? shared : { ok: true, list: [] };
    }
    return await read('/api/platform/applications?summary=1');
  };
  const results = await Promise.allSettled([
    readApplications(),
    read('/api/platform/process-instances?view=pending'),
    read('/api/platform/process-instances?view=started'),
    read('/api/tasks'),
    read('/api/platform/workbench'),
  ]);
  if (page && !page.isActive()) return;
  const value = index => results[index].status === 'fulfilled' ? results[index].value : {};
  /* 「常用应用」只列**真正的应用**（`source!=='managed'`）——
     受管对象是**数据库**，不是应用（用户 2026-10-22 12:3x 口径）：
     改前这里画的是「文件中心／订单管理／费用管理／外采拨款／**各域的受管对象**」，
     后两条是数据库占了应用的位置 ⇒ 一条都不该进这条快捷条。
     判定与**应用中心同一处**（`js/app-center-cards.js` 的 `shangshuRealAppEntries`），不另造一套。 */
  if (!window.shangshuRealAppEntries) console.warn('[工作台] js/app-center-cards.js 没挂上 ⇒ 受管对象会混进「常用应用」');

  /* ── 三块各自的「画」：数据回来 ⇒ **原位替换**；读失败 ⇒ **原因 ＋ 重试** ── */
  const drawStats = () => {
    const box = $('.workbench-status', main);
    if (!box) return;
    const pending = value(1).list || [];
    const started = value(2).list || [];
    const tasks = (value(3).list || []).filter(task => task.assignee_id === currentUserInfo?.username);
    const count = (index, rows) => results[index].status === 'fulfilled' ? rows.length : '—';
    box.innerHTML = `
      <button type="button" data-work-view="pending"><span>流程待办</span><b>${count(1,pending)}</b><small>需要我办理的流程</small></button>
      <button type="button" data-work-view="started"><span>我发起的流程</span><b>${count(2,started)}</b><small>查看流程进度</small></button>
      <button type="button" data-route="task-mgmt"><span>我的任务</span><b>${count(3,tasks)}</b><small>分配给我的协作任务</small></button>`;
    $$('[data-work-view]', box).forEach(button => button.onclick = () => goWork(button.dataset.workView));
    $$('[data-route]', box).forEach(button => button.onclick = () => go(button.dataset.route));
  };

  const drawApps = () => {
    const box = $('[data-app-list]', main);
    if (!box) return;
    if (results[0].status === 'rejected') {
      const reason = results[0].reason && results[0].reason.message ? results[0].reason.message : '服务没有回话';
      box.innerHTML = `<div class="platform-error" role="alert"><div><b>常用应用暂时无法读取</b><p>${esc(reason)}</p><button class="btn btn-ghost btn-sm" type="button" data-retry-apps>重试</button></div></div>`;
      const retry = $('[data-retry-apps]', box);
      if (retry) retry.onclick = () => retryApps();
      return;
    }
    const rawApps = value(0).list || [];
    const apps = window.shangshuRealAppEntries ? window.shangshuRealAppEntries(rawApps) : rawApps;
    box.innerHTML = apps.length ? `<div class="workbench-app-list">${apps.slice(0, 6).map(app => `<button type="button" data-open-app="${esc(app.id)}"><span class="application-mark">${esc(app.icon || String(app.title || '应').slice(0, 1))}</span><span><b>${esc(app.title || app.domain_name)}</b><small>${esc(app.description || '业务应用')}</small></span><i>进入</i></button>`).join('')}</div>` : `<div class="workbench-empty"><b>${isAdmin ? '还没有启用的业务应用' : '还没有可使用的应用'}</b>${isAdmin ? '<button class="btn btn-ghost btn-sm" type="button" data-manage-apps>管理应用</button>' : ''}</div>`;
    $$('[data-open-app]', box).forEach(button => button.onclick = () => { sessionStorage.setItem('shangshu.application.open', button.dataset.openApp); go('applications'); });
    const manageApps = $('[data-manage-apps]', box); if (manageApps) manageApps.onclick = () => go('apps');
  };

  const drawRecent = () => {
    const box = $('[data-recent-list]', main);
    if (!box) return;
    if (results[1].status === 'rejected' && results[2].status === 'rejected') {
      const reason = (results[1].reason && results[1].reason.message) || (results[2].reason && results[2].reason.message) || '服务没有回话';
      box.innerHTML = `<div class="platform-error" role="alert"><div><b>最近流程暂时无法读取</b><p>${esc(reason)}</p><button class="btn btn-ghost btn-sm" type="button" data-retry-recent>重试</button></div></div>`;
      const retry = $('[data-retry-recent]', box);
      if (retry) retry.onclick = () => retryRecent();
      return;
    }
    const started = value(2).list || [];
    const pending = value(1).list || [];
    const recent = [...new Map([...started.map(item => ({...item, source:'我发起的'})), ...pending.map(item => ({...item, source:'待我处理'}))].map(item=>[item.name,item])).values()]
      .sort((a, b) => String(b.modified || '').localeCompare(String(a.modified || ''))).slice(0, 6);
    box.innerHTML = recent.length ? `<div class="workbench-recent-list">${recent.map(item => `<button type="button" data-open-work="${esc(item.name || '')}"><span><b>${esc(item.definition_title || item.business_name || '业务事项')}</b><small>${esc(item.current_node_title || item.source)}</small></span><i>${esc(item.source)}</i></button>`).join('')}</div>` : '<div class="workbench-empty"><b>暂时没有进行中的事项</b></div>';
    $$('[data-open-work]', box).forEach(button => button.onclick = () => {
      sessionStorage.setItem('shangshu.process.intent', JSON.stringify({mode:'instance', instance:recent.find(item=>item.name===button.dataset.openWork)}));
      go('flowdesign');
    });
  };

  /* 失败清单：**没在自己那一块里报过**的失败才在这里报一遍（不重复报两遍）。 */
  const renderWarning = () => {
    const names = ['常用应用', '流程待办', '我发起的流程', '我的任务', '业务概览'];
    const reported = results[0].status === 'rejected' ? new Set([0]) : new Set();
    const failures = results.map((result, index) => result.status === 'rejected' && !reported.has(index) ? names[index] : '').filter(Boolean);
    let warning = $('.workbench-warning', main);
    if (!failures.length) { warning?.remove?.(); return; }
    if (!warning) {
      warning = document.createElement('div');
      warning.className = 'platform-error workbench-warning';
      warning.setAttribute('role', 'alert');
      $('.workbench-status', main)?.before?.(warning);
    }
    warning.innerHTML = `<span>${esc(failures.join('、'))}暂时无法读取，未显示为零。</span> <button class="btn btn-ghost btn-sm" type="button">重试</button>`;
    const retry = warning.querySelector('button');
    if (retry) retry.onclick = () => go('dash');
  };

  /* ── 「重试」：只重读**这一块**的那条口，原位换回内容（不整页重画、不跳版）── */
  const retryApps = async () => {
    const button = $('[data-retry-apps]', main);
    if (button) button.disabled = true;
    try {
      results[0] = { status: 'fulfilled', value: await read('/api/platform/applications?summary=1') };
    } catch (error) {
      results[0] = { status: 'rejected', reason: error };
    }
    if (page && !page.isActive()) return;
    drawApps();
    renderWarning();
  };

  const retryRecent = async () => {
    const button = $('[data-retry-recent]', main);
    if (button) button.disabled = true;
    const paths = ['/api/platform/process-instances?view=pending', '/api/platform/process-instances?view=started'];
    const settled = await Promise.allSettled(paths.map(path => read(path)));
    settled.forEach((result, index) => { results[index + 1] = result; });
    if (page && !page.isActive()) return;
    drawStats();
    drawRecent();
    renderWarning();
  };

  drawStats();
  drawApps();
  drawRecent();
  renderWarning();

  const cards = value(4).cards || [];
  if (cards.length) {
    $('[data-domain-section]', main).hidden = false;
    $('[data-domain-cards]', main).innerHTML = cards.map(card => `<button class="platform-kpi" type="button" data-card-route="${esc(card.route || 'objects')}" data-dataset="${esc(card.dataset || '')}"><span class="platform-kpi-domain">${esc(card.domain_name || '业务应用')}</span><b>${esc(card.title)}</b><strong>${esc(String(card.value ?? '—'))}<small>${esc(card.unit || '')}</small></strong><p>${esc(card.description || '')}</p></button>`).join('');
    $$('[data-card-route]', main).forEach(button => button.onclick = () => { if (button.dataset.dataset) sessionStorage.setItem('shangshu.dataset.open', button.dataset.dataset); go(button.dataset.cardRoute); });
  }
};
