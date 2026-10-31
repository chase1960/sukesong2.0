/* 轻量注册；11MB 编辑器只在进入工作面时加载，不拖慢消息/文件/邮箱首屏。 */
(function (g) {
  let pending;
  const loadingHosts = new WeakMap();
  const roles = ['admin', 'staff', 'manager', 'finance'];
  g.shangshuRegisterPages?.(['excel'], {owner:'com.shangshu.files',name:'表格',status:'implemented',platform:true,roles});
  g.shangshuRegisterNav?.([{id:'excel',name:'表格',ico:'sheet',sec:'工作',roles}]);
  function load() {
    if (g.shangshuMountExcelPage) return Promise.resolve();
    if (!pending) pending = new Promise((resolve,reject) => {
      const script=document.createElement('script');
      // ⚠️ **产物是打包出来的**（`npm --prefix shangshu-web/js/domains/excel-univer run build`）
      // ⇒ 改了源码**必须重建产物**才生效 ⇒ 这个 `?v=` 就是「产物第几版」，
      // **每次重建产物都要撞一次**（否则浏览器拿旧包）。
      // 2026-10-29：案号候选接进表格（候选层 + 接线）＋ **产物整份包进函数**（修「版本不匹配」事故）。
      script.src='js/domains/excel-univer/excel-univer-entry.js?v=e21f11cd58';
      script.onload=()=>{
        if(g.shangshuMountExcelPage)resolve();
        else {script.remove();pending=null;reject(Error('表格组件版本不匹配，请重试'));}
      };
      script.onerror=()=>{script.remove();pending=null;reject(Error('表格组件加载失败，请重试'));};
      document.head.appendChild(script);
    });
    return pending;
  }
  // app.js 的路由表是全局词法 const，不是 window.RENDER。
  RENDER.excel=async(page)=>{
    if(page.signal.aborted || !page.host.isConnected)return;
    const host=page.host, doc=host.ownerDocument;
    const owner={};loadingHosts.set(host,owner);
    host.classList.add('excel-page');
    host.setAttribute('aria-busy','true');
    // 与重编辑器共用同一份 CSS；只有空结构，不预造业务表头或数据。
    host.innerHTML='<header class="excel-bar"><h1>Excel 表格</h1><div class="excel-loading-toolbar" aria-hidden="true"><span></span><span></span><span></span></div></header>'+
      '<div class="excel-body"><div class="excel-loading" data-open-loading><p class="excel-loading-status" role="status" aria-live="polite">正在加载表格组件…</p>'+
      '<div class="excel-loading-sheet" aria-hidden="true"><div class="excel-loading-headers" data-loading-headers><span></span>'+Array.from({length:8},()=>'<span><i></i></span>').join('')+'</div>'+
      '<div class="excel-loading-grid" data-loading-grid>'+Array.from({length:8},()=>'<div><span></span>'+Array.from({length:8},()=>'<span></span>').join('')+'</div>').join('')+'</div></div></div></div>';
    const onAbort=()=>{if(loadingHosts.get(host)!==owner)return;host.setAttribute('aria-busy','false');const loading=host.querySelector('[data-open-loading]');if(loading)loading.hidden=true;};
    page.signal.addEventListener('abort',onAbort,{once:true});
    try {
      await load();
      if (!page.signal.aborted && page.host.isConnected && loadingHosts.get(host)===owner) g.shangshuMountExcelPage(page.host,page.signal);
    } catch(error) {
      if(page.signal.aborted || !page.host.isConnected || loadingHosts.get(host)!==owner)return;
      host.setAttribute('aria-busy','false');
      const body=host.querySelector('.excel-body');body.replaceChildren();
      const message=doc.createElement('p');message.className='excel-loader-error';message.setAttribute('role','alert');message.textContent=error.message||'表格组件加载失败，请重试';
      const retry=doc.createElement('button');retry.type='button';retry.className='btn';retry.textContent='重新加载';retry.dataset.loaderRetry='';
      retry.onclick=()=>RENDER.excel(page);body.append(message,retry);
    } finally {
      page.signal.removeEventListener('abort',onAbort);
    }
  };
})(window);
