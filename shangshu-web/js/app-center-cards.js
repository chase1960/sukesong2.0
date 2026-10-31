/* ============ 模块：应用中心（全部应用）的卡片目录 ＋ 工作台「常用应用」的同一处判定
   用户 2026-10-22 12:0x～12:45 原话：
   ·「应用中心最好搞成卡片式」「应用中心不要那么多」
   ·「受管对象是**数据库**，不是应用」
   · 工作台「常用应用」里也不该列受管对象。

   —— 「不要那么多」怎么落实（**全站只有这一处判定**）——
   受管对象（source='managed'）是**数据库**：各域声明的那些受管对象（客户偏好／业务事实／官方状态／
   Host 设备凭据／指令…… 一次二十来条，把真正的人用入口压到最底下。
   ⇒ 应用中心与工作台**共用**下面这一个判定（`source!=='managed'` 才是应用），
     与**侧栏认受管对象用的是同一个标记**（侧栏那一段是 PKG-021 的地盘，本笔没动）。
   ⚠️ 域声明（`js/domains/<域>/domain-entry.json` 的 `managedNav`）管的是**侧栏里露不露**，
     不管应用中心列不列 —— 声明过的那几个（客户偏好／邮件模板／邮件规则表）是**规则型**的
     数据库（用户 12:20 原话：「有些数据库……他是一种规则的显现」），**在侧栏照常能点到**，
     但**不占应用的位置**。

   —— 卡片不是新组件 ——
   卡片样式是现成的（`.application-card` / `.application-mark` / `.application-card-copy` /
   `.application-enter`，见 `css/platform.css`），卡片格是现成的（`.application-grid`）。
   这里**只复用**，不新造一套；说明文字用 `.application-card-copy small`（现成的次级小字）。
*/
(function () {
  const MANAGED_SOURCE = 'managed';

  /* 是不是**真正的应用**（不是数据库）：
     受管对象在应用目录里是 `source='managed'`；真正的应用**没有** source 键。
     ⚠️ 这一条是**全站唯一**的「应用 vs 数据库」判定 —— 应用中心与工作台共用它，
       侧栏认受管对象用的也是同一个标记（`source==='managed'`）。
     ⚠️ 「真应用」**没有** source 键（不是 source==='domain'）—— 按"没有这个键"来判。 */
  const isRealApp = app => !!app && typeof app === 'object' && app.source !== MANAGED_SOURCE;

  /* 只要**真正的应用**（一个受管对象都不带）：
     · 应用中心「全部应用」—— 受管对象是数据库，不是应用；
     · 工作台「常用应用」—— 那是一条**应用快捷条**，数据库不占它的位置。 */
  window.shangshuRealAppEntries = function (apps) {
    const list = Array.isArray(apps) ? apps : [];
    return list.filter(isRealApp);
  };

  /* 一句说明（它是干什么的）：
     ① 域自己写了说明就用域的；② 没写 ⇒ 用它自己登记的数据表名字（事实，不编业务话）；
     ③ 都没有 ⇒ 退回公共壳原有的说法。 */
  function appDescription(app) {
    const text = typeof app.description === 'string' ? app.description.trim() : '';
    if (text) return text;
    const names = (Array.isArray(app.datasets) ? app.datasets : [])
      .map(item => String((item && item.name) || '').trim())
      .filter(Boolean);
    if (names.length) return names.join('、');
    return app.source === MANAGED_SOURCE ? '受管记录' : '已安装业务应用';
  }

  /* 一张卡片：**名字 ＋ 一句说明 ＋ 进入**（复用现成的 application-card 系列类）。 */
  window.shangshuAppCenterCard = function (app) {
    const title = String(app.title || app.domain_name || '应用');
    const mark = String(app.icon || title.slice(0, 1));
    const disabled = app.enabled === false;
    return `<button class="application-card${disabled ? ' is-disabled' : ''}" type="button" data-application="${esc(app.id)}">
      <span class="application-mark">${esc(mark)}</span>
      <span class="application-card-copy"><b>${esc(title)}</b><small>${esc(appDescription(app))}</small></span>
      <span class="application-enter">进入</span>
      ${disabled ? '<i class="application-disabled-badge">已停用</i>' : ''}
    </button>`;
  };

  /* 把卡片画进卡片格（`.application-grid` 是现成的卡片格；空态是现成的 platform-empty）。 */
  window.shangshuAppCenterRender = function (host, apps, onOpen) {
    if (!host) return;
    const list = Array.isArray(apps) ? apps : [];
    host.innerHTML = list.length
      ? list.map(app => window.shangshuAppCenterCard(app)).join('')
      : '<div class="platform-empty compact">没有匹配的应用</div>';
    if (typeof onOpen !== 'function') return;
    host.querySelectorAll('[data-application]').forEach(button => {
      button.onclick = () => onOpen(button.dataset.application);
    });
  };
})();
