/* ============ 模块：工作区管理（2026-08-10） ============
   我的工作区（模板启用/停用 + 个人自定义）+ 模块库（含未实装占位，勾选创建自己的工作区）。
   工作区 = 面向岗位的模块集合，modules 按工作流先后顺序；未实装模块收纳在这里供勾选，不进侧栏导航。 */

let wsDraft = [];   // 勾选中的模块 id

async function wsRefreshData() {
  const r = await apiJSON('api/workspaces');
  WS_DATA = r;
  return r;
}

RENDER.workspaces = async function () {
  const d = await wsRefreshData();
  const templates = d.templates || [];
  const custom = d.custom || [];
  const enabled = d.enabled || [];
  const allMods = [...CORE_ITEMS, ...GROUPS.flatMap(g => g.items)];
  const impl = (id) => !!RENDER[id];   // 已实装判断

  // 模块库（按分组显示；已实装/未实装徽标 + 勾选）
  const modCards = (mods) => mods.map(m => {
    const on = wsDraft.includes(m.id);
    return `<label class="ws-mod ${impl(m.id) ? '' : 'ws-mod-mock'}" style="cursor:pointer">
      <input type="checkbox" ${on ? 'checked' : ''} onchange="wsToggleMod('${m.id}')">
      <span class="ws-mod-name">${esc(m.name)}</span>
      ${impl(m.id) ? '<span class="tag ok" style="font-size:11px">已实装</span>' : '<span class="tag" style="font-size:11px;background:var(--amberd);color:var(--amber)">未实装</span>'}
    </label>`;
  }).join('');

  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>工作区</h1></div>

    <div class="card"><div class="card-hd"><span class="t">我的工作区</span><span class="tag">已启用 ${enabled.length + custom.length} 个</span></div><div class="card-bd">
      <div style="display:flex;flex-wrap:wrap;gap:10px">
        ${templates.map(w => {
          const isOn = enabled.includes(w.id);
          return `<div class="ws-tpl ${isOn ? 'on' : ''}" style="border:1px solid ${isOn ? 'var(--acc2)' : 'var(--line2)'};border-radius:10px;padding:12px 14px;width:230px">
            <div style="font-weight:600;display:flex;justify-content:space-between;align-items:center">
              ${esc(w.name)}
              <button class="btn btn-sm ${isOn ? 'btn-ghost' : ''}" onclick="wsToggleTpl('${w.id}', ${isOn})">${isOn ? '停用' : '启用'}</button>
            </div>
            <div style="font-size:12px;color:var(--fg2);margin:4px 0">${esc(w.desc || '')}</div>
            <div style="font-size:12px;color:var(--fg2)">流程：${(w.modules || []).map(id => esc(allMods.find(m => m.id === id)?.name || id)).join(' → ')}</div>
          </div>`;
        }).join('')}
        ${custom.map(w => `
          <div class="ws-tpl on" style="border:1px solid var(--acc2);border-radius:10px;padding:12px 14px;width:230px">
            <div style="font-weight:600;display:flex;justify-content:space-between;align-items:center">
              ${esc(w.name)} <span class="tag" style="font-size:11px">我的</span>
              <button class="btn btn-sm btn-ghost" onclick="wsDelCustom('${w.id}')">删除</button>
            </div>
            <div style="font-size:12px;color:var(--fg2);margin:4px 0">个人自定义（仅自己可见）</div>
            <div style="font-size:12px;color:var(--fg2)">流程：${(w.modules || []).map(id => esc(allMods.find(m => m.id === id)?.name || id)).join(' → ')}</div>
          </div>`).join('')}
      </div>
      <div class="ai-note" style="margin-top:12px"><span class="spark">✦</span><div>侧栏顶部可随时切换已启用的工作区；「全部」查看全量模块（含未实装占位）</div></div>
    </div></div>

    <div class="card"><div class="card-hd"><span class="t">创建我的工作区</span><span class="tag">模块库勾选</span></div><div class="card-bd">
      <div class="fgrid" style="margin-bottom:10px">
        <div class="fld"><label>工作区名称</label><input id="ws-name" placeholder="如：我的日报工作区"></div>
        <div class="fld"><label>已选模块（按勾选顺序 = 工作流顺序）</label><div id="ws-picked" style="min-height:24px;font-size:12px;color:var(--fg2)"></div></div>
      </div>
      ${GROUPS.map(g => `
        <div style="margin:10px 0 4px;font-size:12px;color:var(--fg2)">${esc(g.sec)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${modCards(g.items)}</div>`).join('')}
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
        <button class="btn btn-pri" onclick="wsSaveCustom()">保存为我的工作区</button>
        <span class="cell-sub">保存后出现在侧栏切换器与「我的工作区」；未实装模块勾选后先占位（实装后自动可用）</span>
      </div>
    </div></div>`;
  wsRenderPicked();
};

function wsRenderPicked() {
  const allMods = [...CORE_ITEMS, ...GROUPS.flatMap(g => g.items)];
  $('#ws-picked').textContent = wsDraft.length
    ? wsDraft.map(id => allMods.find(m => m.id === id)?.name || id).join(' → ')
    : '（还未勾选模块）';
}
function wsToggleMod(id) {
  wsDraft = wsDraft.includes(id) ? wsDraft.filter(x => x !== id) : [...wsDraft, id];
  wsRenderPicked();
}
async function wsToggleTpl(id, isOn) {
  const d = WS_DATA;
  const ids = isOn ? (d.enabled || []).filter(x => x !== id) : [...(d.enabled || []), id];
  await api('api/me/workspaces', { method: 'PATCH', body: JSON.stringify({ ids }) }).then(r => r.json());
  toast(isOn ? '已停用' : '已启用', '侧栏切换器已更新');
  RENDER.workspaces(); loadWorkspaces();
}
async function wsSaveCustom() {
  const name = $('#ws-name').value.trim();
  if (!name) return toast('请填写名称', '给工作区起个名字');
  if (!wsDraft.length) return toast('请勾选模块', '从模块库勾选至少一个模块');
  const d = WS_DATA;
  const custom = [...(d.custom || [])];
  const id = 'my-' + Date.now().toString(36);
  custom.push({ id, name, modules: wsDraft });
  await api('api/me/workspaces', { method: 'PATCH', body: JSON.stringify({ ids: d.enabled || [], custom }) }).then(r => r.json());
  toast('已创建', `${name} · ${wsDraft.length} 个模块`);
  wsDraft = [];
  RENDER.workspaces(); loadWorkspaces();
}
async function wsDelCustom(id) {
  const d = WS_DATA;
  const custom = (d.custom || []).filter(w => w.id !== id);
  await api('api/me/workspaces', { method: 'PATCH', body: JSON.stringify({ ids: d.enabled || [], custom }) }).then(r => r.json());
  toast('已删除', '个人工作区');
  RENDER.workspaces(); loadWorkspaces();
}
