/* ============ 模块：Skill 同步 ============ */
let skillSyncTab = 'list';

RENDER['skill-sync'] = async function () {
  const main = $('#main');
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>Skill 同步</h1></div>
    <div class="tabbar">
      <button class="tab ${skillSyncTab === 'list' ? 'on' : ''}" onclick="skillSyncTab='list';RENDER['skill-sync']()">Skill 列表</button>
      <button class="tab ${skillSyncTab === 'keys' ? 'on' : ''}" onclick="skillSyncTab='keys';RENDER['skill-sync']()">密钥管理</button>
    </div>
    <div id="skill-sync-body"></div>`;
  if (skillSyncTab === 'list') await renderSkillList();
  else await renderSkillKeys();
};

async function renderSkillList() {
  const body = $('#skill-sync-body');
  const skills = await apiJSON('api/skills');
  body.innerHTML = `
    <div class="card">
      <div class="card-hd"><span class="t">已同步 Skill</span></div>
      <div class="card-bd">
        <div style="margin-bottom:12px"><button class="btn btn-ghost" onclick="window.open('api/skills/download','_blank')">⬇ 下载页 · 分享给消费方(只读)</button></div>
        ${skills.length ? `<table class="dtable"><tr><th>名称</th><th>HEAD</th><th>操作</th></tr>
          ${skills.map(s => `<tr>
            <td><b>${s.name}</b></td>
            <td class="fg3">${(s.head || '').slice(0, 7) || '—'}</td>
            <td><button class="btn btn-ghost" onclick="showSkillHistory('${s.name}')">历史</button></td>
          </tr>`).join('')}</table>`
          : '<p class="fg3">暂无 skill，请使用 shangshu-sync CLI 上传。</p>'}
      </div>
    </div>`;
}

async function renderSkillKeys() {
  const body = $('#skill-sync-body');
  const keys = await apiJSON('api/skill-keys');
  body.innerHTML = `
    <div class="card">
      <div class="card-hd"><span class="t">密钥管理</span></div>
      <div class="card-bd">
        <div class="fgrid">
          <div class="fld"><label>名称</label><input id="key-name" placeholder="例如：我的 Mac"></div>
          <div class="fld"><label>角色</label><select id="key-role"><option value="upload">上传者</option><option value="download">下载者</option></select></div>
        </div>
        <button class="btn btn-pri" onclick="createSkillKey()">生成密钥</button>
        <div id="new-key" class="hint" style="margin-top:8px"></div>
        <hr style="margin:16px 0;border-color:var(--line)">
        ${keys.map(k => `<div class="row" style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)">
          <span><b>${k.name}</b> <span class="tag">${k.role}</span></span>
          <button class="btn btn-ghost" onclick="revokeSkillKey('${k.id}')">撤销</button>
        </div>`).join('')}
      </div>
    </div>`;
}

async function createSkillKey() {
  const name = $('#key-name').value;
  const role = $('#key-role').value;
  const r = await apiJSON('api/skill-keys', { method: 'POST', body: JSON.stringify({ name, role }) });
  $('#new-key').textContent = `请立即复制：${r.key}`;
  await renderSkillKeys();
}

async function revokeSkillKey(id) {
  await apiJSON(`/api/skill-keys/${id}`, { method: 'DELETE' });
  await renderSkillKeys();
}

async function showSkillHistory(skill) {
  const body = $('#skill-sync-body');
  const history = await apiJSON(`/api/skills/${skill}/history`);
  body.innerHTML = `
    <div class="card">
      <div class="card-hd"><span class="t">${skill} 版本历史</span></div>
      <div class="card-bd">
        <div class="fgrid">
          <div class="fld"><label>对比起点</label><select id="diff-from">${history.map(c => `<option value="${c.hash}">${c.hash.slice(0,7)} ${c.message}</option>`).join('')}</select></div>
          <div class="fld"><label>对比终点</label><select id="diff-to">${history.map(c => `<option value="${c.hash}">${c.hash.slice(0,7)} ${c.message}</option>`).join('')}</select></div>
        </div>
        <button class="btn btn-pri" onclick="showSkillDiff('${skill}')">查看 diff</button>
        <pre id="diff-view" style="margin-top:12px;background:var(--bg-alt);padding:12px;border-radius:var(--r);overflow:auto;font-size:12px;"></pre>
      </div>
    </div>`;
}

async function showSkillDiff(skill) {
  const from = $('#diff-from').value;
  const to = $('#diff-to').value;
  const diff = await apiJSON(`/api/skills/${skill}/diff?from=${from}&to=${to}`);
  const view = $('#diff-view');
  if (!diff.length) { view.innerHTML = '<span class="fg3">无差异</span>'; return; }
  let html = `<style>
    .ssdiff{width:100%;border-collapse:collapse;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.55}
    .ssdiff th{position:sticky;top:0;background:var(--bg-alt);text-align:left;padding:6px 8px;color:var(--fg3);font-weight:600;border-bottom:1px solid var(--line);font-family:-apple-system,"PingFang SC",sans-serif;font-size:12px}
    .ssdiff td{vertical-align:top;padding:1px 8px;white-space:pre-wrap;word-break:break-word;border-bottom:1px solid var(--line)}
    .ssdiff td.del{background:rgba(201,60,60,.10)}.ssdiff td.del .lt{color:#b03328}
    .ssdiff td.add{background:rgba(40,140,80,.10)}.ssdiff td.add .lt{color:#1f7a4d}
    .ssdiff td .ln{display:inline-block;min-width:1.5em;margin-right:.6em;color:var(--fg3);opacity:.45;text-align:left;user-select:none}
    .ssdiff td.empty{background:repeating-linear-gradient(45deg,rgba(0,0,0,.03),rgba(0,0,0,.03) 5px,transparent 5px,transparent 10px)}
    .ssdiff-wrap{max-height:520px;overflow:auto;border:1px solid var(--line);border-radius:var(--r);margin-top:6px}
  </style>`;
  html += diff.map(d => {
    const statusZh = d.status === 'added' ? '新增' : d.status === 'deleted' ? '删除' : '修改';
    const sc = d.status === 'added' ? 'var(--green)' : d.status === 'deleted' ? 'var(--red)' : 'var(--amber)';
    // patch 解析成左右对齐行:删除→只在左、新增→只在右、上下文→两边都有
    const rows = [];
    let oldN = 0, newN = 0;
    for (const ln of (d.patch || '').split('\n')) {
      const hm = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?/);
      if (hm) { oldN = +hm[1]; newN = +hm[2]; continue; }
      if (ln.startsWith('diff ') || ln.startsWith('index ') || ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('Binary ')) continue;
      if (ln.startsWith('-')) rows.push({ l: { n: oldN++, t: ln.slice(1), c: 'del' }, r: null });
      else if (ln.startsWith('+')) rows.push({ l: null, r: { n: newN++, t: ln.slice(1), c: 'add' } });
      else rows.push({ l: { n: oldN++, t: ln.slice(1), c: 'ctx' }, r: { n: newN++, t: ln.slice(1), c: 'ctx' } });
    }
    const cell = x => x ? `<td class="${x.c}"><span class="ln">${x.n}</span><span class="lt">${escapeHtml(x.t) || '&nbsp;'}</span></td>` : '<td class="empty"></td>';
    return `<div style="margin-bottom:20px">
      <div style="margin:8px 0 4px"><b style="color:${sc}">${statusZh}</b> <span style="color:var(--fg2)">${escapeHtml(d.path)}</span></div>
      <div class="ssdiff-wrap"><table class="ssdiff"><tr><th style="width:50%">改前</th><th style="width:50%">改后</th></tr>
        ${rows.map(r => `<tr>${cell(r.l)}${cell(r.r)}</tr>`).join('')}
      </table></div>
    </div>`;
  }).join('');
  view.innerHTML = html;
}

/* ---------- 冲突解决 GUI ---------- */
function renderConflict(skill, files) {
  const body = $('#skill-sync-body');
  body.innerHTML = `
    <div class="card">
      <div class="card-hd"><span class="t">${skill} 冲突解决</span></div>
      <div class="card-bd">
        ${files.map((f, i) => `
          <div class="fld" data-path="${f.path}">
            <label>${f.path}</label>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
              <textarea id="conf-base-${i}" readonly placeholder="共同祖先" rows="8" style="font-family:monospace;font-size:12px">${escapeHtml(f.base || '')}</textarea>
              <textarea id="conf-theirs-${i}" readonly placeholder="服务端" rows="8" style="font-family:monospace;font-size:12px">${escapeHtml(f.theirs || '')}</textarea>
              <textarea id="conf-ours-${i}" placeholder="本地（可编辑）" rows="8" style="font-family:monospace;font-size:12px">${escapeHtml(f.ours || '')}</textarea>
            </div>
            <div style="margin-top:6px;display:flex;gap:8px;">
              <button class="btn btn-ghost" onclick="useConflictServer(${i})">保留服务端</button>
              <button class="btn btn-ghost" onclick="useConflictLocal(${i})">保留本地</button>
            </div>
          </div>
        `).join('')}
        <button class="btn btn-pri" onclick="submitConflictResolution('${skill}')">提交解决</button>
      </div>
    </div>`;
}

// 复用更完整的 esc（esc 还转义 "，escapeHtml 漏了 → 统一到 esc，避免双份维护 + 引号属性上下文 XSS）
function escapeHtml(s) { return esc(s); }

function useConflictServer(i) {
  $('#conf-ours-' + i).value = $('#conf-theirs-' + i).value;
}
function useConflictLocal(i) {
  // 本地值已在可编辑 textarea 中，无需操作
}

async function submitConflictResolution(skill) {
  const files = [];
  $$('#skill-sync-body .fld[data-path]').forEach((fld, i) => {
    files.push({
      path: fld.dataset.path,
      content: $('#conf-ours-' + i).value,
    });
  });
  const key = prompt('请输入 upload-key');
  if (!key) return;
  try {
    await apiJSON(`/api/skills/${skill}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ files }),
      headers: { 'X-Shangshu-Key': key },
    });
    toast('冲突已解决');
    await RENDER['skill-sync']();
  } catch (e) {
    toast('冲突解决失败', e.message);
  }
}
