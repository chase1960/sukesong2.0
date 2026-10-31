/* 正式招聘工作区：原生域页面；所有业务写入走平台受管 Action。 */
(function (global) {
  'use strict';
  const roles = ['admin', 'manager', 'staff'];
  global.shangshuRegisterPages?.(['recruitment'], { owner: 'com.shangshu.recruitment', name: '招聘', status: 'implemented', platform: true, roles });
  global.shangshuRegisterNav?.([{ id: 'recruitment', name: '招聘', ico: 'users', sec: '业务', roles }]);
  const tabs = { tasks: '任务与异常', standards: '岗位标准', intake: '收件与简历', evidence: '候选人证据', decisions: '判断与行动', rules: '案例与经验', retrospective: '结果复盘' };
  const labels = { draft: '待核对', decided: '已确认', shortlist: '通过筛选', hold: '待补证', reject: '淘汰', active: '生效',
    paused: '暂停', retired: '退役', open: '进行中', closed: '已关闭', escalated: '已升级', supported: '材料支持',
    contradictory: '材料冲突', missing: '缺少证据', confirmed: '支持原判断', counterexample: '出现反例', inconclusive: '尚无结论',
    published: '已发布', rejected: '已淘汰', hired: '已入职', withdrawn: '已撤回', proposed: '待确认', scheduled: '已安排', completed: '已完成',
    cancelled: '已取消', approved: '已批准', accepted: '已接受', declined: '已拒绝', in_progress: '办理中' };
  const state = { tab: 'tasks', jobs: [], job: '', workspace: null, actions: [], page: 1, total: 0, error: '', notice: '', context: null, detail: null };
  let host, lifecycle, generation = 0;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const label = value => esc(labels[value] || value || '—');
  const active = token => token === generation && host?.isConnected && !lifecycle?.aborted;
  const list = key => state.workspace?.collections?.[key] || [];
  const button = (title, op, id = '', extra = '') => `<button class="btn btn-ghost btn-sm" type="button" data-rec-op="${op}" data-id="${esc(id)}" ${extra}>${esc(title)}</button>`;
  function can(id) { return state.actions.some(a => a.id === id && a.executable !== false); }
  function actionButton(title, id, values) {
    return can(id) ? `<button class="btn btn-ghost btn-sm" type="button" data-rec-action="${esc(id)}" data-values="${esc(JSON.stringify(values || {}))}">${esc(title)}</button>` : '';
  }
  async function request(path, body, read = true) {
    const response = await global.fetch(path, { credentials: 'include', cache: 'no-store',
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      ...(read && lifecycle ? { signal: lifecycle } : {}) });
    const data = await response.json();
    if (!response.ok || data.ok === false || data.error) throw Object.assign(Error(data.error || data.message || '读取失败'), { status: response.status });
    return data.result || data;
  }
  const service = (id, payload) => request('/api/platform/services/' + id + '/invoke', { payload });
  function table(columns, rows, render) {
    if (!rows.length) return '<p class="rec-empty">暂无记录。创建真实业务记录后将在这里显示。</p>';
    return `<div class="rec-table-wrap dataset-table-wrap"><table class="dataset-table"><thead><tr>${columns.map(x => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${render(row).map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  async function refresh(token = generation) {
    const selection = state.job;
    const workspace = selection ? await service('recruitment.workspace', { job: selection }) : null;
    if (!active(token) || selection !== state.job) return;
    state.workspace = workspace;
    render();
  }
  async function load() {
    const token = generation;
    try {
      const results = await Promise.allSettled([
        request('/api/platform/objects/recruitment.job/records?page=' + state.page + '&page_length=30'),
        request('/api/platform/actions'),
      ]);
      if (!active(token)) return;
      const failure = results.find(r => r.status === 'rejected');
      if (failure) throw failure.reason;
      const [jobs, actions] = results.map(r => r.value);
      state.jobs = jobs.rows || []; state.total = jobs.total || 0;
      state.actions = (actions.list || []).filter(a => a.id.startsWith('recruitment.'));
      if (!state.jobs.some(j => j.name === state.job)) state.job = state.jobs[0]?.name || '';
      await refresh(token);
    } catch (error) {
      if (!active(token)) return;
      state.workspace = null; state.actions = [];
      state.error = error.status === 404 || error.status === 503 ? '正式招聘平台尚未就绪，请完成招聘域安装与迁移后重试。' : error.message;
      render();
    }
  }
  function render() {
    if (!host?.isConnected || lifecycle?.aborted) return;
    const job = state.workspace?.job;
    host.innerHTML = `<header class="rec-head"><h1>招聘工作区</h1><span class="rec-sub">按岗位核对标准、证据、判断与后续结果</span></header>
      <div class="rec-toolbar"><label>岗位 <select data-job aria-label="选择岗位"><option value="">请选择岗位</option>${state.jobs.map(j => `<option value="${esc(j.name)}" ${j.name === state.job ? 'selected' : ''}>${esc(j.title)} · ${label(j.status)}</option>`).join('')}</select></label>
      ${button('上一页', 'previous', '', state.page <= 1 ? 'disabled' : '')}<span>岗位第 ${state.page} 页</span>${button('下一页', 'next', '', state.page * 30 >= state.total ? 'disabled' : '')}
      ${actionButton('新建岗位', 'recruitment.job.save')}${button('刷新', 'refresh')}${button('核查最近回执', 'recover')}</div>
      ${state.error ? `<p class="rec-error" role="alert">${esc(state.error)}</p>` : ''}${state.notice ? `<p class="rec-notice" role="status">${esc(state.notice)}</p>` : ''}
      ${job ? `<div class="rec-stats"><span class="rec-stat">岗位 <b>${esc(job.title)}</b></span><span class="rec-stat">${label(job.status)}</span><span class="rec-stat">标准 ${esc(job.current_rubric_revision || '尚未发布并开放')}</span></div>` : ''}
      <nav class="rec-tabs" aria-label="招聘任务">${Object.entries(tabs).map(([id, title]) => `<button class="rec-tab ${id === state.tab ? 'active' : ''}" type="button" data-rec-tab="${id}" aria-current="${id === state.tab ? 'page' : 'false'}">${title}</button>`).join('')}</nav>
      <div data-rec-panel>${job ? content() : '<p class="rec-empty">请选择或新建岗位。正式数据为空时不会填入演示候选人。</p>'}</div>
      ${state.workspace?.truncated?.length ? '<p class="rec-sub">当前岗位每类最多展示最近 100 条记录；复盘仅覆盖可见样本，请到平台数据页查看完整记录。</p>' : ''}`;
  }
  function content() {
    const job = state.workspace.job;
    if (state.tab === 'intake') return `<p class="rec-sub">展示本岗位收件与尚未分配的收件。先将原文件上传文件中心，再登记其编号；人工转录需另行打开原文件核对。</p>${actionButton('登记收件', 'recruitment.application.intake', { source_type: 'manual', request_id: global.crypto.randomUUID() })}` +
      table(['收件', '分配岗位', '状态 / 异常', '办理'], list('intakes'), r => [esc(r.name), esc(r.matched_job || '待分配'), label(r.status) + '<br>' + esc(r.failure_code),
        !['converted', 'ignored'].includes(r.status) ? actionButton('分配到本岗位', 'recruitment.intake.assign', { intake: r.name, job: state.job }) + actionButton('重试', 'recruitment.intake.retry', { intake: r.name }) + actionButton('忽略', 'recruitment.intake.ignore', { intake: r.name }) : esc(r.candidate || '已处理')]) +
      '<h2>申请与主简历</h2>' + table(['申请 / 候选人', '主简历', '结果', '办理'], list('applications'), r => [esc(r.name) + '<br>' + esc(r.candidate), esc(r.primary_resume), label(r.outcome),
        actionButton('选择主简历', 'recruitment.resume.primary.select', { application: r.name, revision: r.revision }) + actionButton('登记撤回', 'recruitment.application.withdraw', { application: r.name, revision: r.revision })]) +
      table(['简历 / 候选人', '文件中心编号', '解析状态'], list('resumes'), r => [esc(r.name) + '<br>' + esc(r.candidate), esc(r.file_reference), label(r.parser_status)]);
    if (state.tab === 'tasks') {
      const now = Date.now();
      return `<p class="rec-sub">超时仅提示异常；升级和关闭均需责任人确认并留下实际回执。</p>${actionButton('分派异常任务', 'recruitment.task.save', { job: state.job })}` +
        table(['问题', '责任人 / 升级负责人', '期限', '状态与回执', '办理'], list('tasks'), r => [esc(r.title), esc(r.owner_user) + '<br>' + esc(r.escalation_user),
          esc(r.due_at) + (r.state !== 'closed' && new Date(r.due_at.replace(' ', 'T')).getTime() < now ? '<strong class="rec-overdue"> 已超时</strong>' : ''), label(r.state) + '<br>' + esc(r.receipt),
          actionButton('记录回执', 'recruitment.task.resolve', { record: r.name, revision: r.revision }) + actionButton('调整分派', 'recruitment.task.save', { ...r, record: r.name, job: state.job })]);
    }
    if (state.tab === 'standards') return `<div class="rec-toolbar">${actionButton('新建 JD 版本', 'recruitment.jd.save', { job: state.job, source: 'manual' })}${actionButton('新建筛选标准', 'recruitment.rubric.save', { job: state.job })}
      ${job.status !== 'open' ? actionButton('开放岗位并绑定已发布版本', 'recruitment.job.open', { job: state.job, revision: job.revision }) : actionButton('关闭岗位', 'recruitment.job.close', { job: state.job, revision: job.revision })}</div>
      <p class="rec-sub">发布版本不可覆盖。新标准发布后，关闭并重新开放岗位以明确切换；既有证据包保留原标准。</p>` +
      table(['JD 版本', '正文', '状态', '操作'], list('jd'), r => [esc(r.name), `<details><summary>查看正文</summary><pre>${esc(r.content)}</pre></details>`, label(r.status),
        r.status === 'draft' ? actionButton('编辑', 'recruitment.jd.save', { ...r, revision_document: r.name, job: state.job }) + actionButton('发布', 'recruitment.jd.publish', { revision_document: r.name, revision: r.revision }) : '只读']) +
      table(['标准版本', '必要条件', '加分条件', '状态', '操作'], list('standards'), r => [esc(r.name), esc(parseArray(r.required_criteria).join('；')), esc(parseArray(r.preferred_criteria).join('；')), label(r.status),
        r.status === 'draft' ? actionButton('发布', 'recruitment.rubric.publish', { revision_document: r.name, revision: r.revision }) : '只读']);
    if (state.tab === 'evidence') return table(['申请', '候选人', '主简历', '结果', '证据核对'], list('applications'), r => [esc(r.name), esc(r.candidate), esc(r.primary_resume || '待选择'), label(r.outcome),
      r.outcome === 'active' && can('recruitment.review.create') ? button('整理证据', 'prepare', r.name) : '—']) +
      '<h2>已保存的证据包</h2>' + reviewTable();
    if (state.tab === 'decisions') return '<p class="rec-sub">先核对证据并填写独立判断，再确认。待补证不自动推进或淘汰；面试、Offer、入职沿用受管动作。</p>' + reviewTable() + pipeline() +
      `<h2>其他招聘办理</h2><label>选择操作 <select data-action-choice aria-label="招聘操作"><option value="">请选择</option>${state.actions.filter(a => a.executable !== false && !a.id.startsWith('recruitment.review.') && !a.id.startsWith('recruitment.rule.')).map(a => `<option value="${esc(a.id)}">${esc(a.title || a.id)}</option>`).join('')}</select></label>`;
    if (state.tab === 'rules') return `<p class="rec-sub">经验是待验证的建议，不自动改变筛选标准。新版本需另一位招聘管理员审阅；暂停、到期或标准不符时停止引用。回滚通过新版本保留历史。</p>${actionButton('提出经验版本', 'recruitment.rule.create', { job: state.job, rubric: job.current_rubric_revision, counterexamples: '[]' })}` +
      table(['经验 / 版本', '建议与边界', '案例与反例', '状态 / 到期', '操作'], list('rules'), r => [esc(r.title) + '<br>' + esc(r.name) + ' v' + esc(r.version_no), esc(r.guidance) + '<br>' + esc(r.limitations),
        '支持：' + esc(parseArray(r.evidence_reviews).join('、')) + '<br>反例：' + esc(parseArray(r.counterexamples).join('、')),
        label(r.state) + '<br>' + esc(r.expires_on), actionButton('审阅 / 暂停', 'recruitment.rule.transition', { record: r.name, revision: r.revision }) +
        actionButton('修订 / 从此版本回滚', 'recruitment.rule.create', { ...r, previous: r.name, job: state.job })]);
    if (state.tab === 'retrospective') {
      const reviews = list('reviews').filter(r => r.state === 'decided'), followups = list('followups');
      const observed = new Set(followups.map(f => f.review));
      const seconds = list('reviews').reduce((n, r) => n + Number(r.preparation_seconds || 0) + Number(r.review_seconds || 0), 0) + followups.reduce((n, f) => n + Number(f.rework_seconds || 0), 0);
      return `<div class="rec-stats"><span class="rec-stat">已确认判断 <b>${reviews.length}</b></span><span class="rec-stat">有后续观察 <b>${reviews.filter(r => observed.has(r.name)).length} / ${reviews.length}</b></span><span class="rec-stat">登记的整理、复核与返工 <b>${Math.round(seconds / 60)} 分钟</b></span></div>
        <p class="rec-sub">时间为人工登记，仅统计当前可见样本。需另设对照才能判断净提效；后续表现与招聘判断之间不直接构成因果关系。多次观察分别保留。</p>
        ${actionButton('登记后续观察', 'recruitment.followup.record')}` +
        table(['证据包', '观察日期', '结论', '实际观察与来源', '返工（秒）'], followups, r => [esc(r.review), esc(r.observed_on), label(r.outcome), esc(r.observation), esc(r.rework_seconds)]) +
        '<h2>待回收结果</h2>' + table(['证据包', '决定', '理由', '操作'], reviews.filter(r => !observed.has(r.name)), r => [esc(r.name), label(r.decision), esc(r.reason), actionButton('补充观察', 'recruitment.followup.record', { review: r.name })]);
    }
    return '';
  }
  function parseArray(raw) { try { return Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); } catch { return []; } }
  function reviewTable() {
    return table(['证据包 / 申请', '标准与参考经验', '人工判断与理由', '操作'], list('reviews'), r => [esc(r.name) + '<br>' + esc(r.application), esc(r.rubric) + '<br>' + esc(parseArray(r.rule_versions).map(v => v.name + ' v' + v.version_no).join('、')),
      label(r.state === 'draft' ? 'draft' : r.decision) + '<br>' + esc(r.reason) + '<br>' + esc(r.exceptions), button('原文与证据', 'detail', r.name) +
      (r.state === 'draft' ? actionButton('确认独立判断', 'recruitment.review.decide', { record: r.name, revision: r.revision }) : actionButton('登记后续观察', 'recruitment.followup.record', { review: r.name }))]);
  }
  function pipeline() {
    return '<h2>招聘流程记录</h2>' + table(['环节', '记录 / 申请', '状态', '操作'], list('pipeline'), r => [esc(r.kind), esc(r.name) + '<br>' + esc(r.application), label(r.status),
      r.kind === 'interview' ? actionButton('登记完成', 'recruitment.interview.complete', { interview: r.name, revision: r.revision }) + actionButton('提交评价', 'recruitment.evaluation.submit', { interview: r.name }) :
      r.kind === 'offer' ? actionButton('审批', 'recruitment.offer.approve', { offer: r.name, revision: r.revision }) + actionButton('登记回复', 'recruitment.offer.record_reply', { offer: r.name, revision: r.revision }) + actionButton('发起入职', 'recruitment.onboarding.start', { offer: r.name }) :
      r.kind === 'onboarding' ? actionButton('完成入职', 'recruitment.onboarding.complete', { onboarding: r.name, revision: r.revision }) : '—']);
  }

  function runAction(id, preset = {}) {
    const action = state.actions.find(a => a.id === id && a.executable !== false);
    if (!action) throw Error('当前账号没有这项办理权限');
    const token = generation, selection = state.job;
    const properties = structuredClone(action.input_schema?.properties || {});
    const hidden = {};
    for (const key of ['record', 'revision', 'revision_document', 'job', 'context_hash', 'application', 'review', 'offer', 'interview', 'onboarding', 'intake']) {
      if (properties[key] && preset[key] !== undefined) hidden[key] = preset[key];
    }
    const arrays = ['required_criteria', 'preferred_criteria', 'disallowed_criteria', 'evidence_reviews', 'counterexamples'];
    for (const key of arrays) if (properties[key]) {
      properties[key] = { type: 'string', title: (properties[key].title || key).replace('（JSON）', '') + '（每行一项）', multiline: true };
      if (preset[key] !== undefined) preset[key] = parseArray(preset[key]).join('\n');
    }
    // Equal weights are explicit editable defaults, not AI-inferred recruiting standards.
    if (properties.weights) { properties.weights = { type: 'string', title: '权重（留空则各条件等权）', multiline: true }; }
    let key = global.crypto.randomUUID(), sent = '';
    openSchemaForm({ title: action.title || id, description: '核对以下内容后确认执行。' + Object.entries(hidden).map(([k, v]) => `${k}：${v}`).join('；'),
      properties, required: (action.input_schema?.required || []).filter(k => k !== 'weights'), values: preset, hidden, submitLabel: '确认执行',
      onSubmit: async values => {
        if (!active(token) || selection !== state.job) throw Error('岗位或页面已切换，请关闭后重新办理');
        for (const name of arrays) if (name in values) values[name] = JSON.stringify(String(values[name]).split('\n').map(x => x.trim()).filter(Boolean));
        if (properties.weights && !values.weights) {
          const criteria = [...parseArray(values.required_criteria), ...parseArray(values.preferred_criteria)];
          values.weights = JSON.stringify(Object.fromEntries(criteria.map(c => [c, 1])));
        }
        if (sent && sent !== JSON.stringify(values)) throw Error('上次提交的回执尚待核查，请先核查回执；不要修改内容后重复提交。');
        sent = JSON.stringify(values);
        try { await execute(id, values, key); }
        catch (error) { if (error.definitive) { sent = ''; key = global.crypto.randomUUID(); } throw error; }
        if (active(token)) { state.notice = '已取得执行回执，记录已更新。'; await refresh(token); }
      } });
  }
  async function execute(id, payload, key) {
    // Only the receipt key is persisted. Candidate materials remain in the authorized business store.
    let pending;
    try { pending = JSON.parse(global.sessionStorage.getItem('recruitment.pending') || 'null'); } catch (_) { /* storage may be disabled */ }
    if (pending && pending.key !== key) throw Error('还有一笔提交的结果待核查，请先核查最近回执。');
    try { global.sessionStorage.setItem('recruitment.pending', JSON.stringify({ id, key })); } catch (_) { /* storage may be disabled */ }
    try {
      const result = await request('/api/platform/actions/' + encodeURIComponent(id) + '/execute', { payload, confirmed: true, idempotency_key: key }, false);
      try { global.sessionStorage.removeItem('recruitment.pending'); } catch (_) { /* no local storage */ }
      return result;
    } catch (error) {
      const definitive = error.status >= 400 && error.status < 500 && error.status !== 408;
      if (definitive) { try { global.sessionStorage.removeItem('recruitment.pending'); } catch (_) { /* storage disabled */ } }
      throw Object.assign(Error(error.message + (definitive ? '。本次未执行，请修正后重试。' : '。若提交后网络中断，请点击“核查最近回执”；重试将沿用同一提交编号。')), { definitive });
    }
  }
  async function recover() {
    const pending = JSON.parse(global.sessionStorage.getItem('recruitment.pending') || 'null');
    if (!pending) { state.notice = '没有待核查的提交编号。'; render(); return; }
    const token = generation;
    const receipt = await request('/api/platform/action-requests/' + encodeURIComponent(pending.key));
    if (!active(token)) return;
    const known = ['Succeeded', 'Failed'].includes(receipt.status);
    const text = { Succeeded: '平台已确认执行成功。', Failed: '平台已确认执行失败。', Pending: '仍在处理，请稍后再次核查。', NotFound: '暂未查到回执，请核对业务记录后再重试原提交。' }[receipt.status] || '结果仍待确认，请稍后再次核查。';
    const d = dialog('最近提交回执', `<p>${esc(text)}</p><p>${esc(receipt.failure_reason || '')}</p>${known ? button('已核查，返回工作区', 'receipt-confirmed') : ''}`);
    if (known) d.querySelector('[data-rec-op="receipt-confirmed"]').onclick = async () => { global.sessionStorage.removeItem('recruitment.pending'); d.remove(); await refresh(token); };
  }
  function dialog(title, body) {
    const node = global.document.createElement('dialog'); node.className = 'schema-dialog rec-evidence-dialog';
    node.innerHTML = `<h2>${esc(title)}</h2>${body}<div class="schema-actions">${button('关闭', 'close-dialog')}</div>`;
    node.querySelector('[data-rec-op="close-dialog"]').onclick = () => node.remove();
    node.addEventListener('cancel', () => node.remove());
    global.document.body.append(node); node.showModal?.(); if (!node.open) node.setAttribute('open', '');
    return node;
  }
  async function prepare(application) {
    const token = generation, selected = state.job;
    const context = await service('recruitment.evidence.context', { application });
    if (!active(token) || selected !== state.job) return;
    const criteria = context.snapshot.criteria;
    const d = dialog('候选人证据核对', `<p>${esc(context.notice)}</p><p class="rec-sub">主简历 ${esc(context.snapshot.resume)} · 文件引用 ${esc(context.snapshot.file_reference)} · 标准 ${esc(context.snapshot.rubric)}</p>
      <form data-evidence-form><div class="rec-evidence-grid"><section><label class="fld"><span>已核对的原文件转录 *</span><textarea name="source_text" required maxlength="100000" rows="18"></textarea></label>
      <label class="rec-check"><input type="checkbox" name="verified" required>我已打开对应原文件，核对转录内容与来源</label>
      <p class="rec-sub">点击 AI 整理会将此文本交给已配置的模型。引用只证明来自这份转录，真实性仍需后续验证。</p>${button('AI 整理证据（待核对）', 'assist')}</section>
      <section>${criteria.map(c => `<fieldset data-criterion="${esc(c.id)}"><legend>${c.required ? '必要' : '加分'} · ${esc(c.criterion)}</legend>
        <label>材料情况<select name="status"><option value="missing">缺证</option><option value="supported">材料支持</option><option value="contradictory">材料冲突</option></select></label>
        <label>逐字引用<textarea name="quote" rows="2" placeholder="粘贴对应原文片段；缺证留空"></textarea></label>
        <label>需追问或核实<textarea name="question" rows="2" maxlength="1000">${esc('请核实：' + c.criterion)}</textarea></label></fieldset>`).join('')}</section></div>
      <details><summary>本岗位适用的经验版本（主动选择后才记为参考）</summary>${context.snapshot.rule_versions.map(r => `<label class="rec-check"><input type="checkbox" name="rule" value="${esc(r.name)}">${esc(r.name)} v${esc(r.version_no)}：${esc(r.guidance)}；局限：${esc(r.limitations)}</label>`).join('') || '<p>暂无生效经验</p>'}</details>
      <p data-assist-status role="status"></p><button class="btn btn-pri" type="submit">核对完成，保存证据包</button></form>`);
    const form = d.querySelector('form'), source = form.elements.source_text, status = d.querySelector('[data-assist-status]');
    const start = Date.now(); let model = 'human', preparing = false, key = global.crypto.randomUUID(), sent = '';
    source.addEventListener('input', () => { form.elements.verified.checked = false; model = 'human'; });
    d.querySelector('[data-rec-op="assist"]').onclick = async event => {
      if (preparing) return;
      if (!source.value.trim()) { status.textContent = '请先粘贴并核对原文。'; return; }
      const original = source.value; preparing = true; event.target.disabled = true; status.textContent = '正在整理建议，请稍候核对。';
      try {
        const result = await request('/api/platform/recruitment/evidence-assist', { application, source_text: original });
        if (!d.isConnected || !active(token) || selected !== state.job || source.value !== original) return;
        if (result.context_hash !== context.context_hash) throw Error('岗位材料发生变化，请关闭后重新整理');
        for (const row of result.matrix) {
          const box = Array.from(d.querySelectorAll('[data-criterion]')).find(n => n.dataset.criterion === row.criterion_id);
          if (!box) continue;
          box.querySelector('[name="status"]').value = row.status;
          box.querySelector('[name="quote"]').value = row.citations[0]?.quote || '';
          box.querySelector('[name="question"]').value = row.question;
        }
        model = result.model_version; form.elements.verified.checked = false; status.textContent = result.notice;
      } catch (error) { if (d.isConnected && active(token)) status.textContent = error.message; }
      finally { preparing = false; if (d.isConnected) event.target.disabled = false; }
    };
    form.onsubmit = async event => {
      event.preventDefault(); if (preparing || !form.reportValidity()) return;
      if (!active(token) || selected !== state.job) { status.textContent = '页面或岗位已切换，请关闭后重新办理。'; return; }
      const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      try {
        const chars = Array.from(source.value), matrix = Array.from(form.querySelectorAll('[data-criterion]')).map(box => {
          const rowStatus = box.querySelector('[name="status"]').value, quote = box.querySelector('[name="quote"]').value;
          let citations = [];
          if (rowStatus !== 'missing') {
            const at = source.value.indexOf(quote);
            if (!quote.trim() || at < 0 || source.value.indexOf(quote, at + 1) >= 0) throw Error('引用须与原文一致且位置唯一；请扩大引用片段以消除歧义。');
            const startIndex = Array.from(source.value.slice(0, at)).length;
            citations = [{ start: startIndex, end: startIndex + Array.from(quote).length, quote }];
            if (citations[0].end > chars.length) throw Error('引用位置无效');
          } else if (quote.trim()) throw Error('缺证项请清空引用。');
          return { criterion_id: box.dataset.criterion, status: rowStatus, citations, question: box.querySelector('[name="question"]').value };
        });
        const used = Array.from(form.querySelectorAll('[name="rule"]:checked')).map(n => context.snapshot.rule_versions.find(r => r.name === n.value)).map(r => ({ name: r.name, version_no: r.version_no }));
        const payload = { application, context_hash: context.context_hash, source_text: source.value, matrix: JSON.stringify(matrix), rule_versions: JSON.stringify(used), model_version: model,
          preparation_seconds: Math.min(86400, Math.round((Date.now() - start) / 1000)) };
        // Reuse the exact payload after a lost response; elapsed time must not change the request.
        if (sent) { const previous = JSON.parse(sent); payload.preparation_seconds = previous.preparation_seconds; if (JSON.stringify(payload) !== sent) throw Error('回执待核查，请先核查最近回执后再修改证据。'); }
        sent = JSON.stringify(payload);
        await execute('recruitment.review.create', payload, key);
        d.remove(); if (active(token)) { state.notice = '证据包已保存，接下来填写人工判断。'; await refresh(token); }
      } catch (error) { if (error.definitive) { sent = ''; key = global.crypto.randomUUID(); } status.textContent = error.message; }
      finally { if (d.isConnected) submit.disabled = false; }
    };
  }
  async function showDetail(record) {
    const token = generation, selection = state.job;
    const data = await service('recruitment.review.detail', { record });
    if (!active(token) || selection !== state.job) return;
    const r = data.review, snapshot = JSON.parse(r.snapshot_json), matrix = JSON.parse(r.matrix_json);
    dialog('原文与逐项证据', `<p>${esc(r.name)} · ${esc(r.provenance)} · ${esc(r.model_version)}</p><p class="rec-sub">材料指纹 ${esc(r.source_hash)} · 标准 ${esc(r.rubric)}</p>
      <div class="rec-evidence-grid"><pre>${esc(r.source_text)}</pre><section>${matrix.map(row => `<article class="rec-card"><strong>${esc(snapshot.criteria.find(c => c.id === row.criterion_id)?.criterion)}</strong><p>${label(row.status)}</p>${row.citations.map(q => `<blockquote>${esc(q.quote)}<small>字符 ${q.start}–${q.end}</small></blockquote>`).join('')}<p>追问：${esc(row.question)}</p></article>`).join('')}</section></div>`);
  }
  async function click(event) {
    const target = event.target.closest('button'); if (!target || !host.contains(target)) return;
    const token = generation;
    try {
      state.error = '';
      if (target.dataset.recTab) { state.tab = target.dataset.recTab; render(); return; }
      if (target.dataset.recAction) { runAction(target.dataset.recAction, JSON.parse(target.dataset.values)); return; }
      target.disabled = true;
      switch (target.dataset.recOp) {
        case 'refresh': await load(); break;
        case 'previous': state.page--; state.job = ''; await load(); break;
        case 'next': state.page++; state.job = ''; await load(); break;
        case 'prepare': await prepare(target.dataset.id); break;
        case 'detail': await showDetail(target.dataset.id); break;
        case 'recover': await recover(); break;
      }
    } catch (error) { if (active(token)) { state.error = error.message; render(); } }
    finally { if (target.isConnected) target.disabled = false; }
  }
  RENDER.recruitment = async page => {
    generation++; host = page.host; lifecycle = page.signal;
    const mountToken = generation;
    if (!active(mountToken)) return;
    state.error = ''; state.notice = ''; state.workspace = null;
    host.classList.add('recruitment-page'); host.setAttribute('aria-busy', 'true');
    host.innerHTML = '<div class="platform-skeleton-bar" data-skeleton="recruitment-workspace" aria-label="读取招聘工作区"></div>';
    host.onclick = click;
    host.onchange = async event => {
      const token = generation;
      try {
        if (event.target.matches('[data-job]')) { state.job = event.target.value; state.workspace = null; render(); await refresh(token); }
        if (event.target.matches('[data-action-choice]') && event.target.value) runAction(event.target.value, { job: state.job });
      } catch (error) { if (active(token)) { state.error = error.message; render(); } }
    };
    lifecycle?.addEventListener('abort', () => { global.document.querySelectorAll('.rec-evidence-dialog').forEach(d => d.remove()); }, { once: true });
    await load(); if (active(mountToken)) { host.removeAttribute('aria-busy'); }
  };
})(window);
