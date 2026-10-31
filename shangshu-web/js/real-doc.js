/* ============ 模块：模板管理 ============ */
RENDER['doc-templates'] = async function () {
  const res = await apiJSON('/api/doc-gen/template-sets');
  const list = Array.isArray(res) ? res : (res?.data || []);
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>模板管理</h1>
      <div class="acts"><button class="btn btn-pri" onclick="createTemplateSet()">${ICONS.template} 新建模板集</button></div></div>
    <div id="tpl-set-list" class="grid-2"></div>`;
  const container = $('#tpl-set-list');
  if (!list.length) {
    container.innerHTML = `<div class="card" style="grid-column:1/-1"><div class="card-bd" style="text-align:center;padding:40px;color:var(--fg3)">暂无模板集，点击上方按钮新建</div></div>`;
    return;
  }
  list.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.animationDelay = `${i * .05}s`;
    card.style.animation = 'rise .25s var(--ease) both';
    card.innerHTML = `
      <div class="card-hd"><span class="t">${esc(s.name)}</span><span class="tag">${esc(s.status || 'active')}</span></div>
      <div class="card-bd">
        <p style="color:var(--fg3);font-size:12.5px;margin:0 0 10px">${esc(s.description || '无描述')}</p>
        <button class="btn btn-ghost" onclick="manageTemplateSet('${esc(s.id)}')">管理文档类型</button>
      </div>`;
    container.appendChild(card);
  });
};

async function createTemplateSet() {
  const name = prompt('模板集名称');
  if (!name) return;
  const description = prompt('描述（可选）') || '';
  try {
    await apiJSON('/api/doc-gen/template-sets', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    });
    toast('模板集已创建');
    RENDER['doc-templates']();
  } catch (e) {
    toast('创建失败', esc(e.message || '未知错误'));
  }
}

let _curManageSetId = null;
async function manageTemplateSet(id) {
  _curManageSetId = id;
  const set = await apiJSON(`/api/doc-gen/template-sets/${id}`);
  const dts = set.doc_types || [];
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>${esc(set.name)}</h1><div class="sub">${esc(set.description || '')}</div>
      <div class="acts"><button class="btn btn-ghost" onclick="RENDER['doc-templates']()">${ICONS.back} 返回</button></div></div>
    <div class="card"><div class="card-hd"><span class="t">文档类型</span><span class="tag">${dts.length} 个</span></div>
      <div class="card-bd">
        ${dts.length ? dts.map(dt => `
          <div class="appr" style="align-items:flex-start">
            <div style="flex:1">
              <div class="tt">${esc(dt.name)}</div>
              <div class="mt">${esc(dt.doc_key)}${dt.template_file_token ? ' · <span style="color:var(--green2)">已上传模板</span>' : ' · <span style="color:var(--amber)">未上传模板</span>'}</div>
            </div>
            <div class="ops">
              <input type="file" accept=".docx" id="tpl-file-${dt.id}" style="display:none" onchange="uploadTemplate('${esc(dt.id)}', this)">
              <button class="btn btn-ghost" onclick="$('#tpl-file-${dt.id}').click()">${dt.template_file_token ? '替换模板' : '上传模板'}</button>
            </div>
          </div>`).join('') : '<p style="color:var(--fg3);font-size:12.5px">暂无文档类型</p>'}
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn btn-pri" onclick="createDocType('${esc(set.id)}')">新建文档类型</button>
        </div>
      </div></div>`;
}

async function createDocType(setId) {
  const doc_key = prompt('文档类型标识（如 contract）');
  if (!doc_key) return;
  const name = prompt('显示名称（如 合同）');
  if (!name) return;
  try {
    await apiJSON(`/api/doc-gen/template-sets/${setId}/doc-types`, {
      method: 'POST',
      body: JSON.stringify({ doc_key, name }),
    });
    toast('文档类型已创建');
    manageTemplateSet(setId);
  } catch (e) {
    toast('创建失败', esc(e.message || '未知错误'));
  }
}

async function uploadTemplate(id, input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const base64 = reader.result.split(',')[1];
      await apiJSON(`/api/doc-gen/doc-types/${id}/upload-template`, {
        method: 'POST',
        body: JSON.stringify({ base64, filename: file.name }),
      });
      toast('模板已上传');
      if (_curManageSetId) manageTemplateSet(_curManageSetId);
    } catch (e) {
      toast('上传失败', esc(e.message || '未知错误'));
    }
  };
  reader.readAsDataURL(file);
}

/* ============ 模块：文档生成 ============ */
RENDER['doc-gen'] = async function () {
  const res = await apiJSON('/api/doc-gen/template-sets');
  const list = Array.isArray(res) ? res : (res?.data || []);
  mainBox().innerHTML = `
    <div class="page-hd page-heading"><h1>文档生成</h1></div>
    <div class="card">
      <div class="card-hd"><span class="t">选择模板</span></div>
      <div class="card-bd">
        <div class="fgrid">
          <div class="fld"><label>模板集</label>
            <select id="dg-set-sel"><option value="">请选择模板集</option>${list.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>
          </div>
          <div class="fld"><label>文档类型</label>
            <select id="dg-dt-sel" disabled><option value="">请先选择模板集</option></select>
          </div>
        </div>
      </div>
    </div>
    <div class="card" id="dg-ai-card" style="display:none">
      <div class="card-hd"><span class="t">AI 预填</span><span class="tag">可选</span></div>
      <div class="card-bd">
        <div class="fld"><label>描述要生成的内容</label>
          <input type="text" id="dg-prefill-desc" placeholder="例如：项目为银聆官网重构，总价 30000，工期 30 天">
        </div>
        <button class="btn btn-ghost" onclick="docGenPrefill()">AI 填充</button>
      </div>
    </div>
    <div class="card" id="dg-form-card" style="display:none">
      <div class="card-hd"><span class="t">填写字段</span></div>
      <div class="card-bd" id="dg-form-area"></div>
    </div>
    <div id="dg-actions" style="display:none;text-align:right;margin-top:12px">
      <button class="btn btn-pri" onclick="docGenSubmit()">生成文档</button>
    </div>`;

  let currentDocType = null;

  $('#dg-set-sel').onchange = async (e) => {
    const setId = e.target.value;
    const dtSel = $('#dg-dt-sel');
    dtSel.disabled = !setId;
    dtSel.innerHTML = '<option value="">请选择文档类型</option>';
    $('#dg-form-card').style.display = 'none';
    $('#dg-ai-card').style.display = 'none';
    $('#dg-actions').style.display = 'none';
    currentDocType = null;
    $('#dg-form-area')._docType = null;
    if (!setId) return;
    const set = await apiJSON(`/api/doc-gen/template-sets/${setId}`);
    const dts = set.doc_types || [];
    dtSel.innerHTML = '<option value="">请选择文档类型</option>' +
      dts.map(dt => `<option value="${esc(dt.id)}">${esc(dt.name)}</option>`).join('');
  };

  $('#dg-dt-sel').onchange = async (e) => {
    const dtId = e.target.value;
    if (!dtId) {
      $('#dg-form-card').style.display = 'none';
      $('#dg-ai-card').style.display = 'none';
      $('#dg-actions').style.display = 'none';
      currentDocType = null;
      $('#dg-form-area')._docType = null;
      return;
    }
    const dt = await apiJSON(`/api/doc-gen/doc-types/${dtId}`);
    currentDocType = dt;
    $('#dg-form-area')._docType = dt;
    docGenRenderForm(dt.field_schema || { fields: [] });
    $('#dg-form-card').style.display = '';
    $('#dg-ai-card').style.display = '';
    $('#dg-actions').style.display = '';
  };

  // 保存 currentDocType 到 DOM 元素供其他函数访问
  $('#dg-form-area')._docType = null;
};

function docGenRenderForm(schema) {
  const area = $('#dg-form-area');
  if (!schema.fields || !schema.fields.length) {
    area.innerHTML = '<p style="color:var(--fg3);font-size:12.5px">该文档类型暂无字段，请先在模板管理中上传模板文件。</p>';
    return;
  }
  area.innerHTML = '<div class="fgrid">' + schema.fields.map(f => {
    const req = f.required ? ' <span style="color:var(--red)">*</span>' : '';
    return `<div class="fld"><label>${esc(f.label)}${req}</label>${docGenRenderField(f)}</div>`;
  }).join('') + '</div>';
}

function docGenRenderField(f) {
  if (f.type === 'textarea') return `<textarea data-k="${esc(f.key)}" rows="3" placeholder="${esc(f.placeholder || f.label || '')}"></textarea>`;
  if (f.type === 'number') return `<input type="number" data-k="${esc(f.key)}" placeholder="${esc(f.placeholder || '')}">`;
  if (f.type === 'date') return `<input type="date" data-k="${esc(f.key)}">`;
  if (f.type === 'select' && f.options) return `<select data-k="${esc(f.key)}"><option value="">请选择</option>${f.options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`;
  // table 类型简化为文本提示
  if (f.type === 'table') return `<p style="color:var(--fg3);font-size:11.5px">表格字段：${esc(f.label)}</p><textarea data-k="${esc(f.key)}" rows="4" placeholder="每行一项，用逗号分隔列"></textarea>`;
  return `<input type="text" data-k="${esc(f.key)}" placeholder="${esc(f.placeholder || f.label || '')}">`;
}

function docGenGatherFields() {
  const out = {};
  $$('#dg-form-area [data-k]').forEach(el => { out[el.dataset.k] = el.value; });
  return out;
}

function docGenFillFields(values) {
  for (const [k, v] of Object.entries(values)) {
    const el = $(`#dg-form-area [data-k="${esc(k)}"]`);
    if (el && v != null) el.value = v;
  }
}

async function docGenPrefill() {
  const dt = $('#dg-form-area')._docType;
  const desc = $('#dg-prefill-desc')?.value?.trim();
  if (!dt || !desc) { toast('请先选择文档类型并输入描述'); return; }
  try {
    const result = await apiJSON('/api/doc-gen/prefill', {
      method: 'POST',
      body: JSON.stringify({ doc_type_id: dt.id, description: desc }),
    });
    const fields = result.fields || result.data?.fields || result;
    if (fields && typeof fields === 'object') docGenFillFields(fields);
    toast('AI 预填完成');
  } catch (e) {
    toast('预填失败', esc(e.message || '未知错误'));
  }
}

async function docGenSubmit() {
  const dt = $('#dg-form-area')._docType;
  if (!dt) return;
  const fields = docGenGatherFields();
  try {
    const res = await api('/api/doc-gen/generate', {
      method: 'POST',
      body: JSON.stringify({ doc_type_id: dt.id, fields }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast('生成失败', esc(j.error || ('HTTP ' + res.status)));
      return;
    }
    // 返回 JSON，包含 file_token
    const j = await res.json();
    if (j.file_token) {
      // 下载文件
      const fileRes = await api(`/api/files/${j.file_token}`);
      const blob = await fileRes.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = j.file_name || `${dt.doc_key}_${Date.now()}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    }
    toast('文档已生成', j.file_name || '');
  } catch (e) {
    toast('生成失败', esc(e.message || '未知错误'));
  }
}
