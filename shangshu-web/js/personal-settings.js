/* 当前身份只读资料和已有设置入口；不另建账号/权限权威。 */
window.mountPersonalSettings = async function(host,{signal}={}) {
  const ui=window.createToolWorkspace(host,{signal}),esc=ui.escape;
  /* —— **加载态＝骨架**（契约 `loading-state-v1.json`）：这一块照**最终长什么样**搭 ——
   *   「当前账号」那一排字段：**标签是真的**（姓名／登录账号／企业），**值还没到** ⇒ 一条会呼吸的灰条。
   *   ⚠️ **不写看得见的加载文字**（灰条的起伏就是唯一的信号）；`aria-busy` 标在这一块容器上，
   *   读屏的人知道它在等，**不靠一个字**。
   *   ⚠️ 数据到了在**同一个容器**里换掉 ⇒ **不跳版**；读失败 ⇒ 换成人话（不许停在骨架上装样子）。 */
  const bar=cls=>`<span class="platform-skeleton-bar ${cls}"></span>`;
  host.innerHTML='<section class="platform-page"><header class="platform-heading page-heading"><h1>个人设置</h1></header>'
    +'<div class="platform-section" role="status" aria-busy="true"><div class="platform-skeleton" data-skeleton="account">'
    +'<div class="platform-section-head"><h2>当前账号</h2><p>当前登录身份；资料与权限由系统管理员统一维护。</p></div>'
    +'<dl class="pf-facts">'
    +`<div><dt>姓名</dt><dd>${bar('platform-skeleton-desc')}</dd></div>`
    +`<div><dt>登录账号</dt><dd>${bar('platform-skeleton-desc')}</dd></div>`
    +`<div class="wide"><dt>企业</dt><dd>${bar('platform-skeleton-desc')}</dd></div>`
    +'</dl></div></div></section>';
  try{
    const response=await fetch('/api/session',{signal:ui.signal,credentials:'include'}),session=await response.json();
    if(ui.disposed)return ui.dispose;
    if(!response.ok||!session.authed)throw Error('登录已失效，请重新登录。');
    const modules=typeof accountMenuModules==='function'?accountMenuModules().filter(m=>m.id!=='personal-settings'):[];
    host.innerHTML=`<section class="platform-page personal-settings-page"><header class="platform-heading page-heading"><h1>个人设置</h1></header>
      <section class="platform-section"><div class="platform-section-head"><h2>当前账号</h2><p>当前登录身份；资料与权限由系统管理员统一维护。</p></div>
        <dl class="pf-facts"><div><dt>姓名</dt><dd>${esc(session.user?.display_name||'—')}</dd></div><div><dt>登录账号</dt><dd>${esc(session.platform?.user_name||session.user?.username||'—')}</dd></div><div class="wide"><dt>企业</dt><dd>${esc(session.platform?.enterprise?.name||'—')}</dd></div></dl>
      </section><section class="platform-section"><div class="platform-section-head"><h2>设置入口</h2><p>只展示当前账号可使用的设置。</p></div><div class="platform-quick-actions">
        ${modules.map(m=>`<button class="platform-quick" data-setting="${esc(m.id)}"><b>${esc(m.name)}</b><small>打开设置 →</small></button>`).join('')||'<p class="pf-explain">暂无其他可用设置。</p>'}
      </div></section><section class="platform-section"><div class="platform-section-head"><h2>账号安全</h2></div><p class="pf-explain">需要重置登录密码，请联系系统管理员在账号管理中重置。尚书不在此展示密码或邮箱授权码。</p></section></section>`;
    host.querySelectorAll('[data-setting]').forEach(button=>button.onclick=()=>{if(!ui.disposed)go(button.dataset.setting);});
  }catch(error){if(!ui.disposed){const box=host.querySelector('[role="status"]');if(box){box.removeAttribute('aria-busy');box.textContent=error.message;}}}
  return ui.dispose;
};
RENDER['personal-settings']=page=>window.mountPersonalSettings(page.host,{signal:page.signal});
