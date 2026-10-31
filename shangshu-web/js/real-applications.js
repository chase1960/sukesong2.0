/* ============ 模块：应用目录、应用主页与应用设计壳
   应用是普通员工进入业务的一级容器；数据、流程和权限仍由 Frappe 领域贡献提供。
*/
(function () {
  const APP_KEY = 'shangshu.application.open';
  const PROCESS_KEY = 'shangshu.process.intent';
  let selectedApplication = null;
  let applicationWorkspace = null;
  let navigationRequest = 0;
  let datasetApplicationTransfer = null;

  // 只交接这一次导航刚读到的展示定义；不放进持久缓存。
  // 记录读写仍请求服务端，重新检查当前域状态与数据权限。
  window.shangshuTakeApplicationNavigationDetail = (applicationId, datasetId) => {
    const pending = datasetApplicationTransfer;
    datasetApplicationTransfer = null;
    if (!pending || pending.application.id !== applicationId || pending.datasetId !== datasetId
        || pending.user !== currentUserInfo || pending.identity !== JSON.stringify(currentUserInfo)
        || Date.now() > pending.expiresAt) return null;
    return pending.application;
  };

  /* —— 骨架（正在取数时的占位）：**照真页面搭** ——
     应用中心是**一格一卡**（照 `.application-grid`／`.application-card`）；
     应用详情／配置／设计那几处是一整块内容还没到 ⇒ 区块形状。
     ⚠️ **只表示「正在取数」** ⇒ 不写假标题、不写假数字、不写假应用名。 */
  const skeletonPanel=()=>'<div class="platform-skeleton platform-skeleton-panel" data-skeleton="panel"><span class="platform-skeleton-panel-title"></span><span class="platform-skeleton-panel-line"></span><span class="platform-skeleton-panel-line short"></span><span class="platform-skeleton-panel-block"></span></div>';
  /* 应用设计那一页的真版面是「左边一列应用 ＋ 右边工作区」⇒ 骨架照那两栏搭。 */
  const skeletonDesign=()=>{
    const row='<div class="platform-skeleton-row simple"><span class="platform-skeleton-bar"></span></div>';
    return `<div class="platform-skeleton platform-skeleton-design" data-skeleton="design"><div class="platform-skeleton-design-list">${row.repeat(5)}</div><div class="platform-skeleton-design-main">${skeletonPanel()}</div></div>`;
  };
  const skeletonAppCards=()=>{
    /* 骨架就是**那张真卡**（`.application-card`／`.application-mark`／`.application-card-copy`／`.application-enter`），
       只把「字」换成灰底块 ⇒ 卡型、间距、图标位都跟真页面一致。 */
    const card='<button class="application-card platform-skeleton" type="button" data-skeleton="app-card"><span class="application-mark"><i class="platform-skeleton-bar platform-skeleton-mark-bar"></i></span><span class="application-card-copy"><b class="platform-skeleton-bar platform-skeleton-app-title"></b><small class="platform-skeleton-bar platform-skeleton-app-desc"></small></span><span class="application-enter"><i class="platform-skeleton-bar platform-skeleton-enter"></i></span></button>';
    /* ⚠️ 真页面是「`.application-detail-inner` → 页头 → 搜索 → `.application-grid` 卡片格」，
       骨架**逐层用同一批外壳类** ⇒ 限宽／内缩／列数都跟真页面一样（自己另起一套 ⇒ 必歪）。 */
    const actions = (currentUserInfo && currentUserInfo.role === 'admin') ? '<div class="page-actions"><button class="btn btn-ghost" type="button">管理后台</button><button class="btn btn-pri" type="button">设计应用</button></div>' : '';
    return `<div class="application-detail-inner">`
      + `<header class="application-detail-head"><div class="application-detail-title"><h1>全部应用</h1></div>${actions}</header>`
      + '<section class="application-detail-section"><input class="application-search" type="search" aria-label="搜索应用" placeholder="搜索应用" readonly>'
      + `<div class="application-grid platform-skeleton" data-skeleton="app-cards">${card.repeat(6)}</div></section>`
      + '</div>';
  };

  // 领域声明首页，平台只解析已注册、当前角色可进入的工作面。
  const applicationPage=app=>window.shangshuResolvePlatformPage?.(app.home,currentUserInfo?.role)||null;

  /* —— 受管对象（source='managed'）露不露在侧栏：**由域自己声明** ——
     用户 2026-10-22 12:20 原话：
     ·「有些数据库他需要留下，他是一种规则的显现，虽然他不可见，但是他落在了前端的某种交互里面」
     ·「某个域的表绑定……是那个域的数据库，留但不显现」
     ⇒ 受管对象多数是**规则/状态**（数据库），**不是人用的入口**；
       哪些是「人直接用的」，是**域的业务判断** ⇒ 域在 `domain-entry.json` 的 `managedNav`
       里点名，公共壳**只照声明过滤，不替域猜**。
     ⚠️ **没声明的一律不显示**（默认隐藏，符合「数据库不是入口」）。
     ⚠️ 登记口与 `shangshuRegisterNav` / `shangshuRegisterPages` 是同一类「前端领域注册点」：
       域只管**声明**，公共壳只管**照办** —— 域之间不抢、壳不硬编码业务判断。 */
  const managedNavTitles=new Set();
  /** 在飞的那一次读（同时来的调用方共用它 ⇒ 同一个接口不并发发好几次）。 */
  let navigationFetch = null;
  let navigationFetchIdentity = '';
  let navigationSnapshot = null;
  const navigationIdentity = () => JSON.stringify(currentUserInfo);
  window.shangshuInvalidateApplicationNavigation = () => {
    navigationSnapshot = null;
    navigationFetch = null;
    navigationRequest++;
  };
  window.shangshuRegisterManagedNav=titles=>{
    const list=Array.isArray(titles)?titles:[];
    let changed=false;
    list.forEach(title=>{
      const name=typeof title==='string'?title.trim():'';
      if(name&&!managedNavTitles.has(name)){managedNavTitles.add(name);changed=true;}
    });
    /* 声明晚到（域脚本是异步读自己的声明文件）⇒ 侧栏重画一次，
       否则声明到的入口永远不出现。 */
    if(changed&&typeof window.refreshApplicationNavigation==='function')void window.refreshApplicationNavigation(undefined,{reuse:true});
    return {ok:true,titles:Array.from(managedNavTitles)};
  };

  window.selectApplicationNavigation = id => {
    selectedApplication = id;
    document.querySelectorAll('[data-side-application]').forEach(button => {
      const on = button.dataset.sideApplication === id;
      button.classList.toggle('on', on);
      if(on)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
    });
    if(id)document.querySelectorAll('#side .side-item.on:not([data-side-application])').forEach(item=>item.classList.remove('on'));
    if(typeof updateSideGlass==='function')updateSideGlass();
  };
  /**
   * 读**应用清单**（那一个接口）。
   *
   * **在途去重**（PKG-076-T01 · 2026-10-24 夜班站上实测）：
   * `refreshApplicationNavigation()` 被好几个地方叫 —— `app.js` 的 `renderChrome()`
   * （侧栏每重画一次叫一次，**全站有 9 个调用点**）、域声明受管对象到达时、发布之后、
   * 还有「重新加载」那个按钮 ⇒ 原来**每打开一个页面**，那个同一个接口就被**并发发 6～7 次**
   * （站上 frappe 访问日志实测）⇒ 并发排在同一个接口上 ⇒ **每个请求的耗时从 0.5 秒一路涨到 8.5 秒**
   * （浏览器网络面板实测），**页面自己要的那一份也跟着排在后面** ⇒ 页面打开得慢，还偶发失败。
   *
   * ⇒ 同时来的调用方**共用那一次**；**不是缓存** —— 这一轮结束后再叫，**还是会再读一次**
   * （那份清单得能更新，不然新装的应用就上不了侧栏）。
   */
  function fetchApplications() {
    const identity = navigationIdentity();
    if (!navigationFetch || navigationFetchIdentity !== identity) {
      /* ⚠️ **走公共壳的「清单口」**（`shangshuPlatformCatalog`）——
         同一轮里只发一次请求，侧栏、应用中心、域入口共用那一份
         （用户 2026-10-25 问：「为什么总是会把业务域重新加载一遍」）。
         壳的那个口不在（判据假世界）⇒ 照旧自己读。 */
      /* ⚠️ **这一份清单故意不挂页面取消信号**（审查报告 R06 · PKG-128-T02）：
         它是**全站共用**的在途去重请求（`app.js` 的 `renderChrome()` 也叫它，
         侧栏、应用中心、域入口共用同一份；另有判据
         `check-app-list-request-dedup.test.mjs` 钉着这个去重语义）
         ⇒ 挂**某一页**的信号 ⇒ 人切页时会把**侧栏**一起掐掉 ⇒ 侧栏条目永远画不出来。
         ⇒ 页面自己那一份读（`RENDER.applications` 里）才挂 `page.signal`。 */
      const catalog = window.shangshuPlatformCatalog;
      const running = catalog ? catalog.applications() : applicationJSON('/api/platform/applications?summary=1');
      navigationFetch = running;
      navigationFetchIdentity = identity;
      const release = () => { if (navigationFetch === running) navigationFetch = null; };
      running.then(release, release);
    }
    return navigationFetch;
  }

  window.refreshApplicationNavigation = async (available, {reuse=false} = {}) => {
    const entry = document.querySelector('#side .side-main [data-mod="applications"]');
    if(!entry)return;
    const request=++navigationRequest;
    const identity=navigationIdentity();
    /* 放在**业务分组的最末**（原来紧跟在「应用」下面）——
       域自己注册的入口（示例企业总表 / 通知书助手）必须排在应用快捷方式**前面**，
       否则用户要点那个入口得往下翻过几十条内部对象。 */
    const section=entry.closest('.workspace-body')||entry;
    let host=document.querySelector('#side-application-list');
    if(!host){host=document.createElement('div');host.id='side-application-list';section.appendChild(host);}
    try{
      const data=Array.isArray(available)?{list:available}
        :reuse&&navigationSnapshot?.identity===identity?navigationSnapshot.data:await fetchApplications();
      if(!host.isConnected||request!==navigationRequest||identity!==navigationIdentity())return;
      /* ⚠️ **清单没到齐之前，不许先画一遍「少的」**（用户 2026-10-25 原话：
         「我点击示例企业总表的时候会出现短暂的侧栏应用重载（体现来看就是侧栏会少好多个选项）」）。
         病根：这一段是**异步**到达的（应用清单 + 域声明的受管对象入口），
         而侧栏每次重画都按**手上有的**先画一遍 ⇒ 人看到条目「少了几个」再冒出来。
         ⇒ **没到齐就先不画这一段**（留空 ⇒ 上面那些分组照旧在，不闪）。 */
      if(!Array.isArray(data.list))return;
      navigationSnapshot={identity,data};
      const shortcuts=new Set(Array.from(document.querySelectorAll('#side .side-item[data-mod]'),el=>el.dataset.mod));
      const list=data.list.filter(app=>!shortcuts.has(applicationPage(app)));
      /* 受管记录（source='managed'：各域声明的那些、Host 导入批次…）**默认不露**——
         它们多数是**规则/状态**（数据库），不是人用的入口；一次二十来条，
         平铺在侧边栏里会把业务入口压到最底下（用户 2026-10-22 12:20 原话：
         「有些数据库他需要留下……虽然他不可见，但是他落在了前端的某种交互里面」）。
         ⇒ 只显示**域点名要露的**（`shangshuRegisterManagedNav` 登记的），其余一条不露。 */
      const managed=list.filter(app=>app.source==='managed'&&managedNavTitles.has(String(app.title||'').trim()));
      const apps=list.filter(app=>app.source!=='managed');
      const signature=JSON.stringify([...apps.map(app=>[app.id,app.title,app.icon,app.home]),...managed.map(app=>[app.id,app.title])]);
      if(host.dataset.signature===signature)return;
      host.dataset.signature=signature;
      const itemHtml=app=>sidebarItemHtml({id:'application:'+app.id,applicationId:app.id,name:app.title,mark:app.icon||String(app.title||'应').slice(0,1)},{core:true});
      /* 露出来的受管对象**就是普通入口**（和其它域入口同一套：同字号同字色），
         不再套一个「业务域对象（N）」的折叠区 —— 那个标题数的是**数据库**，不是入口。 */
      host.innerHTML=apps.map(itemHtml).join('')+managed.map(itemHtml).join('');
      host.querySelectorAll('[data-side-application]').forEach(button=>{
        button.onclick=()=>selectApplication(button.dataset.sideApplication,'applications');
        button.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();button.click();}};
      });
      window.selectApplicationNavigation(selectedApplication);
      /* ⚠️ **应用项是晚到的** ⇒ 这一刻它才出现在侧栏上 ⇒ 补亮：
         现在开着的那张表若属于这个应用，侧栏该亮的是**它**（不是「表格」）
         （用户 2026-10-25 原话：「还是邮件模版时侧边栏高亮的还是表格！」）。 */
      if (typeof window.shangshuSyncTableNavHighlight === 'function') window.shangshuSyncTableNavHighlight();
    }catch(error){if(host.isConnected&&request===navigationRequest&&!host.dataset.signature){host.innerHTML='<button type="button" class="btn btn-ghost btn-sm">重新加载应用</button>';host.firstElementChild.onclick=window.refreshApplicationNavigation;}}
  };

  async function applicationJSON(path, options) {
    const response = await api(path, options);
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || '应用信息加载失败');
    return data;
  }

  /* ⚠️ **这一页的读要带上这一页的取消信号**（审查报告 R06 · PKG-128-T02）：
     人切页以后，公共壳会 abort 这一页的信号 ⇒ 旧页那些还在飞的读**当场被上游掐掉**。
     为什么必须挂：上游（Node 侧）主要靠**固定超时**收尾，**不消费客户端断开**
     ⇒ 不挂信号 ⇒ 旧页的读照旧跑到底（白占资源），回来时还会去改已经没人看的旧页面。
     ⚠️ **只有读挂**：写（启停／发布／新建）**一律不挂** ——
     已发出的写必须保留**核验与恢复**语义，不能因为人切了页就被盲目撤销。 */
  const readOptions = signal => (signal ? { signal } : undefined);

  function selectApplication(id, route = 'application') {
    if((route==='applications'||route==='application')&&location.hash==='#/objects'&&new URLSearchParams(location.search).get('application')===id)return;
    if((route==='applications'||route==='application')&&applicationWorkspace?.isActive())return applicationWorkspace.activate(id);
    sessionStorage.setItem(APP_KEY, id);
    go(route);
  }

  function openDataset(id, applicationId, application) {
    const url = new URL(location.href);
    if (applicationId) url.searchParams.set('application', applicationId);
    else url.searchParams.delete('application');
    url.searchParams.set('dataset', id);
    history.replaceState(null, '', url);
    sessionStorage.setItem('shangshu.dataset.open', id);
    datasetApplicationTransfer = application?.id === applicationId ? {
      application, datasetId: id, user: currentUserInfo,
      identity: JSON.stringify(currentUserInfo), expiresAt: Date.now() + 5000,
    } : null;
    go('objects');
  }

  function openProcess(id, mode = 'launch') {
    sessionStorage.setItem(PROCESS_KEY, JSON.stringify({ definition_id: id, mode }));
    go('flowdesign');
  }

  function appCard(app, design = false) {
    const counts = app.resource_counts || (app.source === 'managed'
      ? (app.draft?.bindings || []).reduce((result, item) => { result[item.kind] = (result[item.kind] || 0) + 1; return result; }, {})
      : {});
    return `<button class="application-card ${app.enabled ? '' : 'is-disabled'}" type="button" data-application="${esc(app.id)}">
      <span class="application-mark">${esc(app.icon || String(app.title || '应').slice(0, 1))}</span>
      <span class="application-card-copy"><b>${esc(app.title || app.domain_name)}</b><small>${esc(app.description || (app.source === 'managed' ? '自主配置应用' : '已安装业务应用'))}</small></span>
      ${design ? `<span class="application-card-meta">${Number(counts.datasets || 0)} 个数据对象 · ${Number(counts.processes || 0)} 个流程</span>` : '<span class="application-enter">进入</span>'}
      ${app.enabled ? '' : `<i class="application-disabled-badge">${app.source==='managed'&&app.status==='Draft'?'草稿':'已停用'}</i>`}
    </button>`;
  }

  function bindApplicationCards(root, route) {
    $$('[data-application]', root).forEach(button => button.onclick = () => selectApplication(button.dataset.application, route));
  }

  function emptyApplications(isAdmin) {
    return `<div class="platform-empty wide"><b>${isAdmin ? '还没有启用的业务应用' : '还没有可使用的应用'}</b>${isAdmin ? '<button class="btn btn-pri" type="button" data-empty-design>管理应用</button>' : ''}</div>`;
  }

  function applicationDetail(app) {
    const datasets = app.datasets || [];
    const processes = app.processes || [];
    const primary = app.primary_action || {};
    return `<div class="application-detail-inner">
      <header class="application-detail-head">
        <div class="application-detail-title"><h1>${esc(app.title || '应用')}</h1></div>
        ${currentUserInfo?.role === 'admin' ? `<button class="btn btn-ghost" type="button" data-configure-app="${esc(app.id)}">配置应用</button>` : ''}
        <button class="btn btn-ghost" type="button" data-process-center>查看待办</button>
        ${primary.type === 'process' && primary.target ? `<button class="btn btn-pri" type="button" data-primary="${esc(primary.target)}">${esc(primary.label || '开始办理')}</button>` : ''}
      </header>
      ${processes.some(item => item.id !== primary.target) ? `<section class="application-detail-section"><div class="platform-section-head"><div><h2>发起业务</h2></div></div>
        <div class="application-action-grid">
          ${processes.filter(item => item.id !== primary.target).map(item => `<button class="application-action" type="button" data-process="${esc(item.id)}"><span>${ICONS.flow}</span><b>${esc(item.title || item.id)}</b><small>发起流程</small></button>`).join('')}
        </div>
      </section>` : ''}
      ${app.overview ? `<section class="application-detail-section"><h2>数据总览</h2><div class="application-action-grid">${(app.overview.tables||[]).map(item=>`<button class="application-action" data-dataset="${esc(item.id)}"><b>${esc(item.title)}</b><strong>${esc(String(item.total))}</strong></button>`).join('')}</div></section><section class="application-detail-section"><h2>最近待办</h2><table class="application-data-table"><thead><tr><th>事项</th><th>当前步骤</th><th>操作</th></tr></thead><tbody>${(app.overview.recent_pending||[]).map(item=>`<tr><td>${esc(item.definition_title)}</td><td>${esc(item.current_node_title)}</td><td><button class="btn btn-ghost btn-sm" data-pending-instance="${esc(item.name)}">办理</button></td></tr>`).join('')||'<tr><td colspan="3">暂无待处理事项</td></tr>'}</tbody></table></section>`:''}
      ${!app.overview?`<section class="application-detail-section"><div class="platform-section-head"><div><h2>数据表</h2></div></div>
        ${datasets.length ? `<table class="application-data-table"><thead><tr><th>数据表</th><th>说明</th><th>操作</th></tr></thead><tbody>${datasets.map(item => `<tr><td>${esc(item.name || item.id)}</td><td>${esc(item.description || '—')}</td><td><button class="btn btn-ghost btn-sm" type="button" data-dataset="${esc(item.id)}">打开</button></td></tr>`).join('')}</tbody></table>` : '<div class="platform-empty compact">当前应用还没有业务记录入口</div>'}
      </section>`:''}
    </div>`;
  }

  RENDER.applications = async (page) => {
    const main = mainBox();
    const isAdmin = currentUserInfo?.role === 'admin';
    main.innerHTML = `<section class="platform-page applications-page application-shell">
      <section class="application-detail">${skeletonAppCards()}</section>
    </section>`;
    const shell = main.firstElementChild;
    const isActive = () => shell.parentNode === main && (!page || page.isActive());
    try {
      const selectedId = sessionStorage.getItem(APP_KEY);
      sessionStorage.removeItem(APP_KEY);
      let apps = [];
      // 侧栏已经给出应用 ID：直接取该应用，不先遍历整份目录。
      // 只有真正打开“全部应用”时才需要清单；目录失败不阻断单个域。
      if (!selectedId) {
        const data = await applicationJSON('/api/platform/applications?summary=1', readOptions(page?.signal));
        if (!isActive()) return;
        apps = data.list || [];
        window.refreshApplicationNavigation(apps);
        if (!apps.length) {
          $('.application-detail', main).innerHTML = emptyApplications(isAdmin);
          const emptyDesign = $('[data-empty-design]', main); if (emptyDesign) emptyDesign.onclick = () => go('app-design');
          return;
        }
      }
      let activation = 0;
      let currentId = null;
      const showOverview=()=>{
        ++activation;
        currentId=null;
        shell.classList.add('is-overview');
        window.selectApplicationNavigation(null);
        $('.application-detail',main).innerHTML=`<div class="application-detail-inner"><header class="application-detail-head"><div class="application-detail-title"><h1>全部应用</h1></div>${isAdmin?'<div class="page-actions"><button class="btn btn-ghost" data-overview-manage>管理后台</button><button class="btn btn-pri" data-overview-design>设计应用</button></div>':''}</header><section class="application-detail-section"><input class="application-search" type="search" aria-label="搜索应用" placeholder="搜索应用"><div class="application-grid" data-app-center-grid></div></section></div>`;
        const draw=term=>{
          /* 应用中心只列**人用的应用**（卡片式，见 `js/app-center-cards.js`）：
             受管对象（数据库）不是应用 —— 用户 2026-10-22 原话：「受管对象是数据库，不是应用」；
             判定与**工作台同一处**、与**侧栏认受管对象同一个标记**（`source==='managed'`）。 */
          const all=window.shangshuRealAppEntries?window.shangshuRealAppEntries(apps):apps;
          const list=all.filter(app=>String(app.title||app.domain_name||'').includes(term));
          const grid=$('[data-app-center-grid]',main);
          if(window.shangshuAppCenterRender)window.shangshuAppCenterRender(grid,list,id=>activate(id));
          else {console.warn('[应用中心] js/app-center-cards.js 没挂上 ⇒ 退回旧画法（受管对象会多列、不是卡片格）');grid.innerHTML=list.length?list.map(app=>appCard(app)).join(''):'<div class="platform-empty compact">没有匹配的应用</div>';}
          $$('[data-application]',main).forEach(button=>button.onclick=()=>activate(button.dataset.application));
        };
        $('.application-search',main).oninput=event=>draw(event.target.value.trim());
        const manage=$('[data-overview-manage]',main);if(manage)manage.onclick=()=>go('apps');
        const design=$('[data-overview-design]',main);if(design)design.onclick=()=>{sessionStorage.removeItem(APP_KEY);go('app-design');};
        if(typeof chatSetBusinessContext==='function')chatSetBusinessContext({module:'applications',view:'application-overview',label:'全部应用',editable_scope:'查看当前账号可用的应用'});
        draw('');
      };
      const activate = async id => {
        if(currentId===id)return;
        currentId=id;
        const request = ++activation;
        shell.classList.remove('is-overview');
        window.selectApplicationNavigation(id);
        $('.application-detail', main).innerHTML = skeletonPanel();
        try {
          const detail = await applicationJSON(`/api/platform/applications/${encodeURIComponent(id)}`, readOptions(page?.signal));
          if (request !== activation || !isActive()) return;
          const currentApplication = detail.application || {};
          const home=applicationPage(currentApplication);
          if(home&&!['applications','application'].includes(home)){go(home);return;}
          if(currentApplication.datasets?.length&&!currentApplication.overview_enabled){openDataset(currentApplication.datasets[0].id,id,currentApplication);return;}
          $('.application-detail', main).innerHTML = applicationDetail(currentApplication);
          if (typeof chatSetBusinessContext === 'function') chatSetBusinessContext({
            module:'applications', view:'application-home', entity_type:'application', entity_id:id,
            label:`应用 · ${currentApplication.title || currentApplication.domain_name || id}`,
            editable_scope:'查询当前应用的数据、流程和可用动作；发起或修改业务必须经过确认',
          });
          $$('[data-primary]', main).forEach(button => button.onclick = () => openProcess(button.dataset.primary));
          $$('[data-dataset]', main).forEach(button => button.onclick = () => openDataset(button.dataset.dataset, id, currentApplication));
          $$('[data-process]', main).forEach(button => button.onclick = () => openProcess(button.dataset.process));
          $$('[data-pending-instance]',main).forEach(button=>button.onclick=()=>{sessionStorage.setItem('shangshu.process.intent',JSON.stringify({mode:'instance',instance:{name:button.dataset.pendingInstance}}));go('flowdesign');});
          $('[data-process-center]', main).onclick = () => go('flowdesign');
          const configure=$('[data-configure-app]',main);if(configure)configure.onclick=()=>selectApplication(id,'app-design');
        } catch (error) {
          if (request !== activation || !isActive()) return;
          currentId=null;
          $('.application-detail', main).innerHTML = `<div class="platform-error wide"><b>应用无法打开</b><p>${esc(error.message || error)}</p><button class="btn btn-ghost" type="button" data-retry-detail>重新加载</button></div>`;
          $('[data-retry-detail]', main).onclick = () => activate(id);
        }
      };
      applicationWorkspace={isActive,activate};
      if(selectedId)await activate(selectedId);else showOverview();
    } catch (error) {
      if (!isActive()) return;
      $('.application-detail', main).innerHTML = `<div class="platform-error wide"><b>应用暂时无法读取</b><p>${esc(error.message || error)}</p><button class="btn btn-ghost" type="button" data-retry>重新加载</button></div>`;
      $('[data-retry]', main).onclick = () => RENDER.applications(page);
    }
  };

  RENDER.application = () => go('applications');

  function humanResource(section, item) {
    if (section === 'datasets') return item.name || item.label || '未命名数据对象';
    if (section === 'processes') return item.title || item.label || '未命名流程';
    if (section === 'roles') return item.label || item.role || '未命名角色';
    return item.label || item.title || item.name || '已注册资源';
  }

  function resourceSection(section, label, items, app) {
    const rows = items || [];
    const actions = {
      datasets: item => app.enabled
        ? `<button class="btn btn-ghost btn-sm" type="button" data-design-dataset="${esc(item.id)}">查看数据</button>`
        : '<span class="application-resource-ready">启用后可查看</span>',
      processes: item => `<button class="btn btn-ghost btn-sm" type="button" data-design-process="${esc(item.id)}">设计流程</button>`,
    };
    return `<section class="application-design-section" data-resource-section="${section}"><div class="platform-section-head"><div><h3>${label}</h3><p>${rows.length} 项已注册到${esc(app.title || '应用')}</p></div></div>
      ${rows.length ? `<div class="application-resource-list">${rows.map(item => `<article><div><b>${esc(humanResource(section, item))}</b><small>${esc(item.description || item.journey || (section === 'roles' ? '控制应用内的办理权限' : '由应用资源目录统一管理'))}</small><details><summary>技术信息</summary><code>${esc(item.id || item.role || '')}</code></details></div>${actions[section] ? actions[section](item) : '<span class="application-resource-ready">已注册</span>'}</article>`).join('')}</div>` : '<div class="platform-empty compact">尚未配置此类资源</div>'}
    </section>`;
  }


  const DESIGN_VIEWS = [['data','数据'],['page','页面'],['process','流程'],['permission','权限'],['release','发布']];
  function designWorkspace(title, actions, panels, managed=false) {
    const contents=DESIGN_VIEWS.map(([key])=>`<section id="app-design-${key}" data-design-panel>${panels[key]||''}</section>`).join('');
    return `<section class="application-design-workspace"><header><h2>${esc(title)}</h2><div class="page-actions">${actions}</div></header>
      <nav class="application-design-tabs" aria-label="应用配置步骤">${DESIGN_VIEWS.map(([key,label])=>`<a href="#app-design-${key}">${label}</a>`).join('')}</nav>
      ${managed?'<form data-managed-form>'+contents+'</form>':contents}</section>`;
  }
  function bindDesignTabs(main) {
    const links=$$('.application-design-tabs a',main);
    links.forEach(link=>link.onclick=event=>{
      event.preventDefault();
      links.forEach(item=>{item.classList.toggle('on',item===link);item.setAttribute('aria-current',item===link?'page':'false');});
      $$('[data-design-panel]',main).forEach(panel=>panel.hidden='#'+panel.id!==link.getAttribute('href'));
    });
    links[0]?.click();
  }

  async function managedEditor(main, app, isActive, signal) {
    const body = $('.application-design-body', main);
    body.innerHTML = skeletonPanel();
    const loading = body.firstElementChild;
    const detail = await applicationJSON('/api/platform/application-definitions/' + encodeURIComponent(app.id), readOptions(signal));
    if (!isActive() || body.firstElementChild !== loading) return;
    const definition = detail.application;
    const context = definition.design_context;
    if (!context || !Array.isArray(context.resource_options) || !context.release) throw new Error('应用设计服务版本不匹配，请更新服务后重试');
    const release = context.release;
    const draft = definition.draft;
    if(typeof chatSetBusinessContext==='function')chatSetBusinessContext({module:'app-design',view:'application-design',entity_type:'application',entity_id:app.id,
      label:`设计应用 · ${draft.title}`,editable_scope:'先读取最新应用草稿与修订，再提出修改并人工确认；不会自动发布'});
    const labels = {datasets:'数据视图',objects:'数据对象',processes:'流程',actions:'动作',tools:'AI 工具',services:'服务',events:'事件',pages:'页面'};
    const choices = context.resource_options;
    const selected = new Set(draft.bindings.map(item=>item.kind + ':' + item.resource_id));
    const bindingRows = (kinds,owner=null) => choices.map((item,index)=>kinds.includes(item.kind)&&(owner===null||(item.owner_domain===app.id)===owner)?`<label><input type="checkbox" data-binding="${index}" ${selected.has(item.kind+':'+item.resource_id)?'checked':''} ${item.enabled||selected.has(item.kind+':'+item.resource_id)?'':'disabled'}> ${esc(item.label)} <small>${esc(labels[item.kind])} · ${esc(item.domain)}${item.enabled?'':' · 已停用'}</small></label>`:'').join('');
    body.innerHTML = designWorkspace(draft.title,
      '<button class="btn btn-ghost" type="button" data-managed-back>全部应用</button><button class="btn btn-ghost" type="button" data-managed-save>保存草稿</button><button class="btn btn-pri" type="button" data-managed-publish>发布应用</button>', {
      data:`<div class="application-design-section"><h3>展示给使用者的数据</h3><div class="application-resource-list">${bindingRows(['objects','datasets'],true)||'<p>建表后可在这里选择应用的数据入口。</p>'}</div><details><summary>引用已有资源</summary><div class="application-resource-list">${bindingRows(['objects','datasets'],false)||'<p>暂无可引用数据</p>'}</div></details></div>`,
      page:`<div class="application-design-section" data-app-pages></div><div class="application-design-section"><details><summary>引用代码页面</summary><div class="application-resource-list">${bindingRows(['pages'])||'<p>暂无可引用页面</p>'}</div></details></div>`,
      process:`<div class="application-design-section" data-app-flows></div><div class="application-design-section"><h3>引用已有业务流程</h3><div class="application-resource-list">${bindingRows(['processes'])||'<p>暂无可引用流程</p>'}</div><details><summary>动作与集成能力</summary><div class="application-resource-list">${bindingRows(['actions','tools','services','events'])||'<p>暂无可引用能力</p>'}</div></details></div>`,
      permission:'<div class="application-design-section" data-role-panel></div>',
      release:`<div class="application-design-section"><label>应用名称<input name="title" required maxlength="100" value="${esc(draft.title)}"></label><div data-release-panel><h3>发布记录与依赖检查</h3>${(release.issues||[]).map(item=>`<p>${esc(item.resource_id)}：${esc(({domain_missing:'来源域缺失',domain_disabled:'来源域已停用',version_changed:'版本已变化',declaration_changed:'资源声明已变化',resource_missing_or_ambiguous:'资源不存在或归属冲突'})[item.code]||item.code)}</p>`).join('')}${(release.releases||[]).map(item=>`<p>${esc(item.creation)} · ${esc(item.actor_identity)} · ${esc(item.revision)}</p>`).join('') || '<p>暂无发布记录</p>'}</div></div>`
    },true);
    const message=document.createElement('p');
    message.dataset.managedMessage='';message.setAttribute('role','status');
    message.textContent='草稿修订 '+Number(definition.draft_revision)+' · '+(definition.published_revision?'已有发布版本':'尚未发布');
    $('.application-design-workspace > header',body).after(message);
    const unavailable=draft.bindings.filter(item=>!choices.some(choice=>choice.kind===item.kind&&choice.resource_id===item.resource_id));
    if(unavailable.length){
      const warning=document.createElement('div');warning.className='application-design-section';
      warning.innerHTML='<h3>不可用引用</h3>'+unavailable.map(item=>`<label><input type="checkbox" data-unavailable-binding="${esc(item.kind+':'+item.resource_id)}" checked> ${esc(item.resource_id)} · 取消勾选将从草稿移除</label>`).join('');
      $('[data-managed-form]',body).prepend(warning);
    }
    bindDesignTabs(main);
    const form = $('[data-managed-form]', main);
    form.dataset.applicationId=app.id;
    const permissions=document.createElement('fieldset');
    permissions.className='application-role-picker';
    const roleOptions=[...(definition.role_options||[]),...draft.allowed_roles.filter(id=>!(definition.role_options||[]).some(role=>role.id===id)).map(id=>({id,label:id+'（已不可用，请取消选择）'}))];
    permissions.innerHTML=`<legend>谁可以使用这个应用</legend><div>${roleOptions.map(role=>`<label><input type="checkbox" data-app-role="${esc(role.id)}" ${draft.allowed_roles.includes(role.id)?'checked':''}> ${esc(role.label)}</label>`).join('')}</div><small>仅控制应用入口；业务记录仍按原有数据权限检查。</small>`;
    $('[data-role-panel]',form).append(permissions);
    form.onsubmit = event=>event.preventDefault();
    let dirty = false, busy = false;
    $('[data-managed-back]',main).onclick=()=>{
      if(busy||dirty){message.textContent='请先完成当前操作并保存草稿，再返回全部应用。';return;}
      sessionStorage.removeItem(APP_KEY);go('app-design');
    };
    const markDirty=()=>{dirty=true;form.dataset.unsaved='true';};
    const pageDraft=typeof mountApplicationPages==='function'?mountApplicationPages(form,definition,markDirty):()=>({});
    form.oninput=event=>{if(event.target.name!=='lifecycle_reason'&&event.target.type!=='file')markDirty();};
    form.addEventListener('shangshu:application-configured',()=>{
      if(!dirty&&!busy&&isActive()&&form.isConnected)managedEditor(main,app,isActive,signal);
    });
    if(definition.published_revision){
      const lifecycle=document.createElement('fieldset');lifecycle.className='application-role-picker';
      lifecycle.innerHTML=`<legend>应用启停</legend><label>操作原因<input name="lifecycle_reason" maxlength="1000" placeholder="填写启停原因"></label><button class="btn btn-ghost" type="button" data-managed-status>${definition.status==='Disabled'?'重新启用':'停用应用'}</button><small>只改变应用入口，不删除业务记录或修订历史。</small>`;
      $('[data-release-panel]',form).append(lifecycle);
      $('[data-managed-status]',lifecycle).onclick=async()=>{
        const message=$('[data-managed-message]',main),button=$('[data-managed-status]',lifecycle);
        if(busy)return;
        if(dirty){message.textContent='请先保存草稿，避免启停刷新丢失修改。';return;}
        const reason=$('[name=lifecycle_reason]',lifecycle).value.trim();
        if(!reason){message.textContent='请填写启停原因。';return;}
        busy=true;button.disabled=true;
        try{
          await applicationJSON('/api/platform/application-definitions/'+encodeURIComponent(app.id)+'/status',{method:'POST',body:JSON.stringify({enabled:definition.status==='Disabled',reason,expected_revision:definition.draft_revision})});
          if(isActive()&&form.isConnected)await managedEditor(main,app,isActive,signal);
        }catch(error){if(isActive()&&form.isConnected)message.textContent=error.message||String(error);}
        finally{busy=false;button.disabled=false;}
      };
    }
    const run = async publish=>{
      if (busy || !form.reportValidity()) return;
      const message=$('[data-managed-message]',main);
      if(publish&&dirty){message.textContent='请先保存草稿，再发布当前修订。';return;}
      busy=true;
      const buttons=$$('[data-managed-save],[data-managed-publish]',main);buttons.forEach(button=>button.disabled=true);
      try {
        const retained = new Set($$('[data-unavailable-binding]:checked',form).map(input=>input.dataset.unavailableBinding));
        const bindings=draft.bindings.filter(item=>retained.has(item.kind+':'+item.resource_id));
        $$('[data-binding]:checked',form).forEach(input=>{
          const {kind,resource_id,owner_domain,version}=choices[Number(input.dataset.binding)];
          bindings.push({kind,resource_id,owner_domain,version});
        });
        const allowed_roles=definition.role_options ? $$('[data-app-role]:checked',form).map(input=>input.dataset.appRole) : draft.allowed_roles;
        if(!publish&&!allowed_roles.length)throw Error('请至少选择一个应用使用角色。');
        const candidate={...draft,...pageDraft(),title:form.elements.title.value,bindings,allowed_roles};
        if(!publish&&context.delivery_format){
          if(typeof saveApplicationWithPreview!=='function')throw Error('应用交付控件未加载，请刷新页面。');
          const saved=await saveApplicationWithPreview(app.id,definition.draft_revision,candidate,()=>isActive()&&form.isConnected);
          if(!saved)return;
        }else{
          await applicationJSON('/api/platform/application-definitions/'+encodeURIComponent(app.id)+(publish?'/publish':'/draft'),{method:'POST',body:JSON.stringify({expected_revision:definition.draft_revision,...(publish?{}:{definition:candidate})})});
        }
        if(publish&&typeof window.refreshApplicationNavigation==='function')await window.refreshApplicationNavigation();
        if(isActive() && form.isConnected) await managedEditor(main,app,isActive,signal);
      } catch(error) {if(isActive() && form.isConnected)message.textContent=error.message||String(error);}
      finally {busy=false;buttons.forEach(button=>button.disabled=false);}
    };
    $('[data-managed-save]',main).onclick=()=>run(false);
    $('[data-managed-publish]',main).onclick=()=>run(true);
    if(context.delivery_format&&typeof mountApplicationDelivery==='function'){
      mountApplicationDelivery($('[data-release-panel]',form),definition,{
        isDirty:()=>dirty||busy,isActive:()=>isActive()&&form.isConnected,reload:()=>managedEditor(main,app,isActive,signal)
      });
    }
    if(typeof mountModelDesigner==='function'){
      const models=document.createElement('div');models.className='application-design-section';
      $('#app-design-data',main).prepend(models);
      models.addEventListener('click',event=>{if(dirty){event.preventDefault();event.stopImmediatePropagation();$('[data-managed-message]',main).textContent='请先保存应用草稿，再配置数据表。';}},true);
      mountModelDesigner(models,definition,()=>managedEditor(main,app,isActive,signal),isActive);
    }
  }

  RENDER['app-design'] = async (page) => {
    const main = mainBox();
    if (currentUserInfo?.role !== 'admin') { main.innerHTML = '<div class="platform-empty"><b>没有访问权限</b><p>只有系统管理员可以设计应用。</p></div>'; return; }
    const selectedId = sessionStorage.getItem(APP_KEY) || '';
    main.innerHTML = `<section class="platform-page application-design-page"><header class="page-hd platform-page-head page-heading"><h1>应用设计</h1><div class="page-actions"><button class="btn btn-ghost" type="button" data-app-management>应用管理</button><button class="btn btn-ghost" type="button" data-preview-apps>员工视图</button></div></header><div class="application-design-body">${skeletonDesign()}</div></section>`;
    const shell = main.firstElementChild;
    const isActive = () => shell.parentNode === main && (!page || page.isActive());
    $('[data-app-management]', main).onclick = () => go('apps');
    $('[data-preview-apps]', main).onclick = () => go('applications');
    const create = document.createElement('button');
    create.className='btn btn-pri';create.textContent='新建应用';create.dataset.newApplication='';create.disabled=true;
    $('.page-actions',main).append(create);
    create.onclick=()=>{
      if(main.querySelector('[data-managed-form][data-unsaved="true"]')){
        $('[data-managed-message]',main).textContent='请先保存当前应用草稿，再新建应用。';return;
      }
      const body=$('.application-design-body',main);
      body.innerHTML='<form class="application-design-section" data-create-application><label>应用名称<input name="title" required maxlength="100" placeholder="例如：采购协同"></label><div class="page-actions"><button class="btn btn-ghost" type="button" data-create-cancel>取消</button><button class="btn btn-pri" type="submit">创建应用</button></div><p role="status"></p></form>';
      const form=$('[data-create-application]',body), key=crypto.randomUUID();
      $('[data-create-cancel]',body).onclick=()=>RENDER['app-design'](page);
      form.onsubmit=async event=>{
        event.preventDefault();if(!form.reportValidity())return;
        const button=$('[type="submit"]',form);if(button.disabled)return;button.disabled=true;
        try {
          const result=await applicationJSON('/api/platform/application-definitions',{method:'POST',body:JSON.stringify({title:form.elements.title.value,idempotency_key:key})});
          if(isActive())selectApplication(result.application.id,'app-design');
        }catch(error){if(isActive())$('[role="status"]',form).textContent=error.message||String(error);}
        finally{button.disabled=false;}
      };
      form.elements.title.focus();
    };
    try {
      const data = await applicationJSON('/api/platform/applications?include_disabled=1&design=1', readOptions(page?.signal));
      if (!isActive()) return;
      const apps = data.list || [];
      create.disabled=false;
      if(!selectedId){
        $('.application-design-body',main).innerHTML=`<section class="application-design-section"><div class="application-overview-grid">${apps.map(app=>appCard(app,true)).join('')||'<p>尚未创建应用，点击右上角“新建应用”开始。</p>'}</div></section>`;
        bindApplicationCards(main,'app-design');return;
      }
      if (!apps.length) {
        $('.application-design-body', main).innerHTML = `${emptyApplications(true)}<p class="application-design-note">安装领域应用后，它会在这里声明数据、流程、动作、工具和权限资源。</p>`;
        $('[data-empty-design]', main).onclick = () => go('apps');
        return;
      }
      const selected = apps.find(app => app.id === selectedId) || apps[0];
      sessionStorage.setItem(APP_KEY, selected.id);
      if(selected.source==='managed'){await managedEditor(main,selected,isActive,page?.signal);return;}
      const resources = selected.resources || {};
      $('.application-design-body', main).innerHTML = designWorkspace(selected.title || '应用',
        `<button class="btn btn-ghost" type="button" data-managed-back>全部应用</button><button class="btn ${selected.enabled?'btn-pri':'btn-ghost'}" type="button" data-preview-current ${selected.enabled?'':'disabled'}>${selected.enabled?'预览应用':'应用已停用'}</button>`,{
        data:resourceSection('datasets','数据对象与视图',resources.datasets,selected),
        page:resourceSection('pages','应用页面',resources.pages,selected)+'<p class="application-design-hint">代码贡献由领域维护，尚不支持拖放编辑。</p>',
        process:resourceSection('processes','业务流程',resources.processes,selected),
        permission:resourceSection('roles','办理角色与权限',resources.roles,selected),
        release:`<section class="application-design-section"><h3>发布状态</h3><p>由领域版本管理，本页只读。</p><div class="application-release-summary"><span>领域版本 ${esc(selected.domain_version||'—')}</span><span>${selected.enabled?'已启用':'已停用'}</span><button class="btn btn-ghost" type="button" data-manage-release>管理启停</button></div><details class="application-technical-resources"><summary>动作与 AI 工具</summary>${resourceSection('actions','动作',resources.actions,selected)}${resourceSection('tools','AI 工具',resources.tools,selected)}</details></section>`
      });
      $('[data-managed-back]',main).onclick=()=>{sessionStorage.removeItem(APP_KEY);go('app-design');};
      bindDesignTabs(main);
      const previewButton = $('[data-preview-current]', main);
      if (selected.enabled) previewButton.onclick = () => selectApplication(selected.id, 'application');
      $('[data-manage-release]', main).onclick = () => go('apps');
      $$('[data-design-dataset]', main).forEach(button => button.onclick = () => openDataset(button.dataset.designDataset, selected.id));
      $$('[data-design-process]', main).forEach(button => button.onclick = () => openProcess(button.dataset.designProcess, 'design'));
    } catch (error) {
      if (!isActive()) return;
      $('.application-design-body', main).innerHTML = `<div class="platform-error wide"><b>应用设计资源无法读取</b><p>${esc(error.message || error)}</p><button class="btn btn-ghost" type="button" data-retry>重新加载</button></div>`;
      $('[data-retry]', main).onclick = () => RENDER['app-design'](page);
    }
  };
})();
