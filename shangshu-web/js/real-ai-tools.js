/* ============ 模块：平台能力目录
   与 Agent Runtime、设计器候选工具共用 Frappe public_api 投影；不再读取 Node listChatTools。 */
/* —— 骨架（这一页还没到时的占位）：照**最终那几块的样子**搭 ——
   顶上那排统计＝三个小药丸（真实内容带数字 ⇒ 骨架只给**药丸的形状**，不写假数字）；
   下面那份清单＝一组工具卡（标题位 ＋ 标识位 ＋ 一行说明）。
   ⚠️ 只表示「正在取数」⇒ 不写假工具名、不写假项数。 */
const aiToolsSumSkeleton=()=>Array.from({length:3},()=>'<span class="platform-skeleton-bar" style="width:64px;height:20px;border-radius:6px"></span>').join('');
const aiToolsListSkeleton=()=>{
  const card='<article class="ai-tools-card platform-skeleton" data-skeleton="ai-tools-card">'
    +'<header class="ai-tools-card-hd"><code class="ai-tools-name"><span class="platform-skeleton-bar" style="width:132px;height:13px"></span></code>'
    +'<span class="ai-tools-cap"><span class="platform-skeleton-bar" style="width:92px;height:11px"></span></span>'
    +'<span class="ai-tools-kind"><span class="platform-skeleton-bar" style="width:56px;height:12px;border-radius:4px"></span></span></header>'
    +'<div class="ai-tools-meta"><span class="platform-skeleton-bar" style="width:190px;height:11px"></span></div></article>';
  const group='<section class="ai-tools-group"><h3 class="ai-tools-group-title"><span class="platform-skeleton-bar" style="width:78px;height:13px"></span></h3>'+card.repeat(3)+'</section>';
  return group+group;
};
RENDER['ai-tools'] = async function (page) {
  const main = mainBox();
  main.innerHTML = `
    <section class="admin-page admin-ai-tools-page">
    <div class="page-hd page-heading">
      <h1>能力目录</h1>
    </div>
    <nav class="admin-destinations" data-admin-destinations></nav>

    <h2 class="ai-tools-h2">对话工具</h2>
    <div class="ai-tools-sum platform-skeleton" id="ai-tools-sum" data-skeleton="ai-tools-sum">${aiToolsSumSkeleton()}</div>
    <div class="ai-tools-filter" id="ai-tools-filter" hidden>
      <button type="button" class="tab on" data-k="all">全部</button>
      <button type="button" class="tab" data-k="read">只读/抽取</button>
      <button type="button" class="tab" data-k="write">需确认写入</button>
    </div>
    <div class="ai-tools-list platform-skeleton" id="ai-tools-list" data-skeleton="ai-tools-list">${aiToolsListSkeleton()}</div>
    <p class="ai-tools-foot" id="ai-tools-foot"></p>
    </section>`;

  let tools = [];
  if(typeof window.shangshuRenderAdminDestinations==='function')window.shangshuRenderAdminDestinations(main,'ai-tools');
  try {
    const r = await api('/api/platform/tools').then((x) => x.json());
    if (!r?.ok) throw new Error(r?.error || '加载失败');
    if (page && !page.isActive()) return;
    tools = (r.list || []).map(t => ({
      ...t,
      id: t.id || t.action_id,
      title: t.title || t.label || t.id || t.action_id,
      confirmation: t.confirmation || t.confirmation_policy || 'none',
      input_schema: t.input_schema || { type: 'object', properties: {} },
    }));
    const writes = tools.filter(t => t.confirmation === 'required' || !['read', 'external/read', 'extract'].includes(String(t.effect || '')));
    const sum = main.querySelector('#ai-tools-sum');
    /* 数据到了 ⇒ 骨架在**同一个容器**里被换掉（连 `platform-skeleton` 标记一起撤掉）。 */
    sum.classList.remove('platform-skeleton');
    main.querySelector('#ai-tools-list').classList.remove('platform-skeleton');
    sum.innerHTML = `<span class="ai-tools-pill">可用 <b>${tools.length}</b></span><span class="ai-tools-pill">只读/抽取 <b>${tools.length - writes.length}</b></span><span class="ai-tools-pill">需确认写入 <b>${writes.length}</b></span>`;
    main.querySelector('#ai-tools-foot').textContent = tools.length
      ? '目录由平台内核实时裁剪；停用应用或失去权限后，对应工具会同时从这里和 AI 执行面消失。'
      : '当前没有已启用且授权给你的 AI 工具。AI 仍可解释页面和提供操作建议，但不会声称已查询或修改业务数据。';
    main.querySelector('#ai-tools-filter').hidden = !tools.length;
  } catch (e) {
    if (page && !page.isActive()) return;
    /* 读失败 ⇒ 说人话（不是骨架）；下面那份清单也撤掉（不许停在骨架上装样子）。 */
    const sum = main.querySelector('#ai-tools-sum');
    sum.classList.remove('platform-skeleton');
    sum.textContent = '加载失败：' + ((e && e.message) || e);
    const list = main.querySelector('#ai-tools-list');
    list.classList.remove('platform-skeleton');
    list.innerHTML = '';
    return;
  }

  let filter = 'all';
  const listEl = main.querySelector('#ai-tools-list');
  const render = () => {
    let rows = tools;
    const isWrite = t => t.confirmation === 'required' || !['read', 'external/read', 'extract'].includes(String(t.effect || ''));
    if (filter === 'read') rows = tools.filter(t => !isWrite(t));
    else if (filter === 'write') rows = tools.filter(isWrite);
    if (!rows.length) {
      listEl.innerHTML = `<div class="ai-tools-empty">${tools.length ? '这一类暂时没有工具' : '当前没有可用工具'}</div>`;
      return;
    }
    /* 改前：56 个工具**平铺成一面墙**，每条三行、还都重复着同一句「由应用贡献并受平台权限控制」
       ⇒ 看不出分组、扫不动。改后：按动作命名空间**分组**，每条收成两行；
       那句千篇一律的说明只在它**真有内容**时留（统一放进 title，不丢信息）。 */
    const DEFAULT_DESC='由应用贡献并受平台权限控制';
    const groups=new Map();
    rows.forEach(t=>{
      const ns=String(t.id||'').split('.')[0]||'其它';
      if(!groups.has(ns))groups.set(ns,[]);
      groups.get(ns).push(t);
    });
    listEl.innerHTML=[...groups.entries()].map(([ns,items])=>`<section class="ai-tools-group">
      <h3 class="ai-tools-group-title">${esc(ns)}<span>${items.length}</span></h3>
      ${items.map((t)=>{
        const write=isWrite(t);
        const params=t.input_schema?.properties?Object.keys(t.input_schema.properties).join('、')||'无':'无';
        const desc=String(t.description||'').trim();
        const showDesc=desc&&desc!==DEFAULT_DESC;
        return `<article class="ai-tools-card" data-kind="${write?'write':'read'}" title="${esc(desc||DEFAULT_DESC)}">
        <header class="ai-tools-card-hd">
          <code class="ai-tools-name">${esc(t.title)}</code>
          <span class="ai-tools-cap">${esc(t.id)}</span>
          <span class="ai-tools-kind ${write?'confirm':'query'}">${write?'需确认写入':'只读/抽取'}</span>
        </header>
        ${showDesc?`<p class="ai-tools-desc">${esc(desc)}</p>`:''}
        <div class="ai-tools-meta">效果：${esc(t.effect||'—')} · 参数：${esc(params)}</div>
      </article>`;
      }).join('')}
    </section>`).join('');
  };
  render();

  $$('#ai-tools-filter .tab', main).forEach((btn) => {
    btn.onclick = () => {
      filter = btn.dataset.k || 'all';
      $$('#ai-tools-filter .tab', main).forEach((b) => b.classList.toggle('on', b === btn));
      render();
    };
  });
};
