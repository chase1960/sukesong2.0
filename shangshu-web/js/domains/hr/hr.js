/* HR 中台（人在企业里的数据资产层）。
 * 页面：驾驶舱 → 人才资产 → 数字分身 → 培养 → 知识 → 招聘效能 → 人机协同。
 * 契约：所有写操作走服务端确认卡（单跳：UI 点击即人确认），本页不做任何"直写"。
 * 前端只新增本目录 + css/domains/hr/hr.css，不碰 index.html / app.js / page-registry。
 */
(function (global) {
  'use strict';

  const doc = global.document;
  const roles = ['admin', 'manager'];
  global.shangshuRegisterPages?.(['hr'], { owner: 'com.shangshu.hr', name: 'HR 中台', status: 'implemented', platform: true, roles });
  global.shangshuRegisterNav?.([{ id: 'hr', name: 'HR 中台', ico: 'users', sec: '业务', roles }]);

  const API = '/api/hr';

  function fetchJson(path, options) {
    return global.fetch(path, Object.assign({ credentials: 'include', cache: 'no-store' }, options || {}))
      .then(async response => {
        let data = null;
        try { data = await response.json(); } catch (error) { data = null; }
        if (!response.ok) {
          const err = Error((data && (data.error || data.message)) || ('HTTP ' + response.status));
          err.status = response.status;
          throw err;
        }
        return data;
      });
  }

  const get = path => fetchJson(API + path);
  const post = (path, body) => fetchJson(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  const state = { tab: 'dashboard', person: '', twinEmp: '', form: {}, busy: false, error: '' };
  let data = { overview: null, employees: [], twins: null, plans: null, knowledge: null, recruit: null, autonomy: null };

  const esc = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pct = n => String(Math.max(0, Math.min(100, Math.round(Number(n) || 0)))) + '%';
  const money = n => '¥' + Math.round(Number(n) || 0).toLocaleString('zh-CN');
  const num = n => (Number(n) || 0).toLocaleString('zh-CN');
  const monthDay = iso => String(iso || '').slice(0, 10) || '—';

  function bar(value, max, tone) {
    const w = max ? Math.min(100, Math.round((Number(value) || 0) / max * 100)) : 0;
    return `<div class="hr-bar"><span class="hr-bar-fill ${tone || ''}" style="width:${w}%"></span></div>`;
  }

  function levelTag(level) {
    const tone = { L0: 'gray', L1: 'blue', L2: 'green', L3: 'amber', L4: 'red' }[level] || 'gray';
    return `<span class="hr-tag ${tone}">${esc(level)}</span>`;
  }

  function pushText(status) {
    return {
      sent: '已推送到飞书', unconfigured: '未配置推送（配 APPROVAL_WEBHOOK_URL 即生效）',
      failed: '推送失败（可在页面直接审批）', pending: '待推送',
    }[status] || status;
  }

  const TABS = [
    { id: 'dashboard', name: '驾驶舱' },
    { id: 'people', name: '人才资产' },
    { id: 'twins', name: '数字分身' },
    { id: 'learning', name: '培养与能力' },
    { id: 'knowledge', name: '经验沉淀' },
    { id: 'recruit', name: '招聘效能' },
    { id: 'autonomy', name: '人机协同' },
  ];

  function note(msg, isErr) {
    const host = doc.getElementById('hr-note');
    if (!host) return;
    host.textContent = msg || '';
    host.className = 'hr-note' + (isErr ? ' err' : '');
    host.classList.add('on');
    global.clearTimeout(note.timer);
    note.timer = global.setTimeout(() => host.classList.remove('on'), 3200);
  }

  async function loadAll() {
    const safe = promise => promise.catch(error => ({ __error: error.message }));
    const [overview, employees, twins, plans, knowledge, recruit, autonomy] = await Promise.all([
      safe(get('/overview')),
      safe(get('/employees')),
      safe(get('/twins')),
      safe(get('/learning/plans')),
      safe(get('/knowledge')),
      safe(get('/recruiting/efficiency')),
      safe(get('/autonomy')),
    ]);
    data = {
      overview: overview.__error ? null : overview,
      employees: employees.__error ? [] : (employees.employees || []),
      twins: twins.__error ? null : twins,
      plans: plans.__error ? null : plans,
      knowledge: knowledge.__error ? null : knowledge,
      recruit: recruit.__error ? null : recruit,
      autonomy: autonomy.__error ? null : autonomy,
    };
    const firstError = [overview, employees, twins, plans, knowledge, recruit, autonomy].find(x => x && x.__error);
    state.error = firstError ? firstError.__error : '';
  }

  /* —— 页头统计 —— */
  function renderStats() {
    const o = data.overview;
    if (!o) return '<span class="hr-muted">暂无数据</span>';
    const h = o.headline || [];
    return h.map(item => `<span class="hr-stat ${esc(item.tone)}"><span>${esc(item.label)}</span><b>${num(item.value)}${esc(item.unit)}</b></span>`).join('');
  }

  /* —— 驾驶舱 —— */
  function dashboardHtml() {
    const o = data.overview;
    if (!o) return '<div class="hr-card"><p class="hr-empty">驾驶舱数据未加载（登录后刷新，或检查角色权限）。</p></div>';
    const w = o.workforce || {};
    const a = o.assets || {};
    const r = o.recruitment || {};
    const c = o.capability || {};
    const l = o.learning || {};
    const k = o.knowledge || {};
    const au = o.autonomy || {};
    const deptMax = Math.max(1, ...(w.by_dept || []).map(d => d.headcount));
    const gapMax = Math.max(1, ...(c.top_gaps || []).map(g => g.people));

    return `
<div class="hr-grid two">
  <section class="hr-card">
    <div class="hr-card-head"><h3>部门数据资产</h3><span class="hr-muted">覆盖度 × 事实密度</span></div>
    ${(w.by_dept || []).map(d => `
      <div class="hr-row">
        <span class="hr-row-label">${esc(d.dept)} <b>${d.headcount}</b></span>
        <div class="hr-row-body">${bar(d.avg_completeness, 100, d.avg_completeness >= 70 ? 'green' : 'amber')}</div>
        <span class="hr-row-value">${d.avg_completeness} 分 · ${d.facts} 条</span>
      </div>`).join('') || '<p class="hr-empty">暂无部门数据</p>'}
    <div class="hr-divider"></div>
    <div class="hr-chips">
      <span class="hr-chip">A 级 ${w.grade_distribution?.A || 0}</span>
      <span class="hr-chip">B 级 ${w.grade_distribution?.B || 0}</span>
      <span class="hr-chip">C 级 ${w.grade_distribution?.C || 0}</span>
      <span class="hr-chip warn">D 级 ${w.grade_distribution?.D || 0}</span>
    </div>
  </section>

  <section class="hr-card">
    <div class="hr-card-head"><h3>企业能力缺口</h3><span class="hr-muted">按人数排序</span></div>
    ${(c.top_gaps || []).map(g => `
      <div class="hr-row">
        <span class="hr-row-label">${esc(g.skill)}</span>
        <div class="hr-row-body">${bar(g.people, gapMax, 'red')}</div>
        <span class="hr-row-value">${g.people} 人 · 均差 ${g.avg_gap} 级</span>
      </div>`).join('') || '<p class="hr-empty">能力模型未覆盖，先补岗位能力模型</p>'}
  </section>
</div>

<div class="hr-grid two">
  <section class="hr-card">
    <div class="hr-card-head"><h3>招聘漏斗与单位经济</h3><span class="hr-muted">${esc(r.snapshot_at ? '同步于 ' + monthDay(r.snapshot_at) : '未同步招聘域数据')}</span></div>
    <div class="hr-funnel">
      ${(r.stages || []).map(s => `
        <div class="hr-funnel-row">
          <span>${esc(s.label)}</span>
          <div class="hr-funnel-bar"><i style="width:${Math.max(2, Math.round(s.value / Math.max(1, (r.stages[0] || {}).value) * 100))}%"></i></div>
          <b>${num(s.value)}</b>
          <em>${s.rate_from_prev}%</em>
        </div>`).join('')}
    </div>
    <div class="hr-kpis">
      <span><em>单人成本</em><b>${money(r.totals?.cost_per_hire)}</b></span>
      <span><em>AI 抵扣后</em><b>${money(r.totals?.ai_adjusted_cost_per_hire)}</b></span>
      <span><em>质量率</em><b>${pct(r.totals?.quality_rate)}</b></span>
      <span><em>AI 节省</em><b>${money(r.totals?.ai_value_saved)}</b></span>
    </div>
    <p class="hr-muted">${esc(r.quality?.note || '')}</p>
  </section>

  <section class="hr-card">
    <div class="hr-card-head"><h3>人机协同分布</h3><span class="hr-muted">L0 观察 → L4 人主办</span></div>
    ${(au.levels || []).map(lv => `
      <div class="hr-row">
        <span class="hr-row-label">${levelTag(lv.level)} ${esc(lv.name)}</span>
        <div class="hr-row-body">${bar(au.usage?.[lv.level] || 0, Math.max(1, ...Object.values(au.usage || {}).map(Number)), 'blue')}</div>
        <span class="hr-row-value">${num(au.usage?.[lv.level] || 0)} 次</span>
      </div>`).join('')}
    <div class="hr-divider"></div>
    <p class="hr-muted">待人工确认 ${(au.pending || []).length} 条 · 决策台账 ${num(au.decisions_total)} 条 · 只统计本中台动作。</p>
  </section>
</div>

<div class="hr-grid two">
  <section class="hr-card">
    <div class="hr-card-head"><h3>培养与知识资产</h3><span class="hr-muted">效果而非课时</span></div>
    <div class="hr-kpis">
      <span><em>进行中计划</em><b>${num(l.plans_active)}</b></span>
      <span><em>动作完成率</em><b>${pct(l.completion_rate)}</b></span>
      <span><em>学习行为转化</em><b>${pct(l.behavior_rate)}</b></span>
      <span><em>可验证提升</em><b>${num(l.uplift_count)} 项</b></span>
    </div>
    <p class="hr-muted">${esc(l.roi_note || '')}</p>
    <div class="hr-divider"></div>
    <div class="hr-row"><span class="hr-row-label">知识采纳率</span><div class="hr-row-body">${bar(k.adoption_rate, 100, 'green')}</div><span class="hr-row-value">${pct(k.adoption_rate)} · ${num(k.published)} 条</span></div>
    <div class="hr-row"><span class="hr-row-label">分身可用率</span><div class="hr-row-body">${bar(o.twins?.answer_rate, 100, 'blue')}</div><span class="hr-row-value">${pct(o.twins?.answer_rate)} · ${num(o.twins?.answered)} 次</span></div>
  </section>

  <section class="hr-card">
    <div class="hr-card-head"><h3>风险与待处理</h3><span class="hr-muted">只列会改变结论的问题</span></div>
    ${(o.risks || []).map(x => `
      <div class="hr-risk ${esc(x.level)}">
        <b>${esc(x.title)}</b>
        <span>${esc(x.detail)}</span>
        <em>${esc(x.action)}</em>
      </div>`).join('') || '<p class="hr-empty">暂无风险项</p>'}
  </section>
</div>

<section class="hr-card">
  <div class="hr-card-head"><h3>数据健康与资产台账</h3><span class="hr-muted">${num(a.facts_total)} 条事实 · 人均 ${a.facts_per_employee} 条</span></div>
  <div class="hr-grid four">
    <div class="hr-mini"><em>覆盖度均分</em><b>${num(a.avg_completeness)}</b></div>
    <div class="hr-mini"><em>证据过期</em><b>${num(o.risks?.stale_facts)}</b></div>
    <div class="hr-mini"><em>画像偏薄</em><b>${num(o.risks?.thin_profile_count)}</b></div>
    <div class="hr-mini"><em>分身就绪</em><b>${num(o.twins?.ready)}</b></div>
  </div>
  <div class="hr-divider"></div>
  <div class="hr-card-head"><h3>最薄画像</h3><span class="hr-muted">先补这些人的证据</span></div>
  ${(a.thin_profiles || []).map(p => `
    <div class="hr-row">
      <span class="hr-row-label">${esc(p.name)} <small>${esc(p.dept)}</small></span>
      <div class="hr-row-body">${bar(p.score, 100, p.score >= 60 ? 'amber' : 'red')}</div>
      <span class="hr-row-value">${p.score} 分</span>
    </div>
    <div class="hr-hint">${esc((p.hints || []).join(' · '))}</div>`).join('') || '<p class="hr-empty">全员覆盖度达标</p>'}
</section>`;
  }

  /* —— 人才资产 —— */
  function peopleHtml() {
    const rows = data.employees || [];
    if (!rows.length) return '<div class="hr-card"><p class="hr-empty">暂无员工档案。</p></div>';
    const selected = rows.find(p => String(p.id) === String(state.person)) || null;
    return `
<section class="hr-card">
  <div class="hr-card-head"><h3>员工资产清单</h3><span class="hr-muted">${rows.length} 人 · 点击查看 360</span></div>
  <div class="hr-table-wrap">
    <table class="hr-table">
      <thead><tr><th>员工</th><th>部门 / 岗位</th><th>覆盖度</th><th>事实</th><th>能力</th><th>分身</th><th>培养</th></tr></thead>
      <tbody>
      ${rows.map(p => `
        <tr class="${String(p.id) === String(state.person) ? 'on' : ''}" data-person="${esc(p.id)}">
          <td><b>${esc(p.name)}</b><small>${esc(p.emp_no)}</small></td>
          <td>${esc(p.dept)}<small>${esc(p.title)} · ${esc(p.level || '—')}</small></td>
          <td><span class="hr-score ${p.completeness.grade}">${p.completeness.score}</span> ${bar(p.completeness.score, 100, p.completeness.score >= 70 ? 'green' : 'amber')}</td>
          <td>${p.facts.length}</td>
          <td>${p.skills.length}</td>
          <td>${p.twin ? `<span class="hr-tag green">${esc(p.twin.status)}</span>` : '<span class="hr-tag gray">未授权</span>'}</td>
          <td>${p.plans.some(x => x.status === 'active') ? '<span class="hr-tag blue">进行中</span>' : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
</section>
${selected ? personDetailHtml(selected) : '<p class="hr-muted">选一名员工查看档案、证据、能力差距与分身状态。</p>'}`;
  }

  function personDetailHtml(p) {
    const c = p.completeness;
    return `
<section class="hr-card hr-person">
  <div class="hr-card-head">
    <h3>${esc(p.name)} · ${esc(p.title)}</h3>
    <span class="hr-muted">${esc(p.dept)} · ${esc(p.emp_no)} · 入职 ${esc(monthDay(p.join_date))} · 司龄 ${Math.floor((p.tenure_months || 0) / 12)} 年</span>
    <span class="hr-score ${c.grade}">${c.score} 分</span>
  </div>
  <div class="hr-grid two">
    <div>
      <div class="hr-sub">覆盖度分项</div>
      ${c.items.map(i => `
        <div class="hr-row">
          <span class="hr-row-label">${esc(i.label)}</span>
          <div class="hr-row-body">${bar(i.points, i.max, i.points >= i.max ? 'green' : 'amber')}</div>
          <span class="hr-row-value">${i.points}/${i.max}</span>
        </div>`).join('')}
      <div class="hr-hint">${esc(c.hints.join(' · ') || '无缺口')}</div>
    </div>
    <div>
      <div class="hr-sub">能力标签</div>
      <div class="hr-chips">
        ${(p.skills || []).map(s => `<span class="hr-chip">${esc(s.name)} <b>${s.level}</b>/5</span>`).join('') || '<span class="hr-muted">未登记</span>'}
      </div>
      <div class="hr-sub">分身与培养</div>
      <p class="hr-muted">${p.twin ? `分身 ${p.twin.status}，授权范围 ${(p.twin.scope?.topics || []).length} 个主题，互动 ${p.twin.interaction_count} 次。` : '尚未授权数字分身。'}</p>
      <div class="hr-actions">
        <button class="hr-btn" data-plan="${esc(p.id)}">生成 90 天计划</button>
        ${p.twin ? '' : `<button class="hr-btn primary" data-authorize="${esc(p.name)}">开通数字分身</button>`}
        <button class="hr-btn" data-addfact="${esc(p.name)}">登记一条事实</button>
      </div>
    </div>
  </div>
  <div class="hr-divider"></div>
  <div class="hr-sub">事实证据（${p.facts.length} 条）</div>
  <div class="hr-timeline">
    ${(p.facts || []).map(f => `
      <div class="hr-tl-item">
        <span class="hr-tag ${f.status === 'verified' ? 'green' : 'gray'}">${esc(f.kind_label)}</span>
        <b>${esc(f.title)}</b>
        <span class="hr-muted">${esc(monthDay(f.occurred_at))} · 强度 ${f.evidence_strength}/3${f.stale ? ' · 证据已过期' : ''}</span>
        <p>${esc(f.summary)}</p>
      </div>`).join('') || '<p class="hr-empty">暂无事实。事实为空时，AI 的任何结论都不可信。</p>'}
  </div>
</section>`;
  }

  /* —— 数字分身 —— */
  function twinsHtml() {
    const t = data.twins;
    if (!t) return '<div class="hr-card"><p class="hr-empty">分身数据未加载。</p></div>';
    const m = t.metrics || {};
    const list = t.twins || [];
    return `
<div class="hr-grid two">
  <section class="hr-card">
    <div class="hr-card-head"><h3>分身运营指标</h3><span class="hr-muted">答得掉 / 拒得对 / 答不了</span></div>
    <div class="hr-kpis">
      <span><em>在授权</em><b>${num(m.twins_active)}</b></span>
      <span><em>就绪</em><b>${num(m.twins_ready)}</b></span>
      <span><em>可用率</em><b>${pct(m.answer_rate)}</b></span>
      <span><em>平均引用</em><b>${m.avg_citations} 条</b></span>
    </div>
    <div class="hr-row"><span class="hr-row-label">已答</span><div class="hr-row-body">${bar(m.answered, Math.max(1, m.queries_total), 'green')}</div><span class="hr-row-value">${num(m.answered)} / ${num(m.queries_total)}</span></div>
    <div class="hr-row"><span class="hr-row-label">拒答</span><div class="hr-row-body">${bar(m.refused, Math.max(1, m.queries_total), 'red')}</div><span class="hr-row-value">${num(m.refused)} 次</span></div>
    <div class="hr-row"><span class="hr-row-label">无证据</span><div class="hr-row-body">${bar(m.insufficient, Math.max(1, m.queries_total), 'amber')}</div><span class="hr-row-value">${num(m.insufficient)} 次</span></div>
    <div class="hr-divider"></div>
    <div class="hr-sub">拒答主题</div>
    ${(m.refusal_topics || []).map(x => `<span class="hr-chip warn">${esc(x.topic)} ${x.count}</span>`).join('') || '<span class="hr-muted">无</span>'}
    <div class="hr-divider"></div>
    <div class="hr-sub">答不了的问题（正好是要补的数据）</div>
    ${(m.coverage_gap || []).map(g => `<div class="hr-hint">${esc(g.employee)}：${esc(g.question)}</div>`).join('') || '<p class="hr-muted">暂无</p>'}
  </section>

  <section class="hr-card">
    <div class="hr-card-head"><h3>向分身提问</h3><span class="hr-muted">敏感主题会被直接拒答</span></div>
    <form data-form="ask" class="hr-form">
      <label>员工
        <select name="employee">
          ${data.employees.map(e => `<option value="${esc(e.name)}" ${state.twinEmp === e.name ? 'selected' : ''}>${esc(e.name)} · ${esc(e.dept)}</option>`).join('')}
        </select>
      </label>
      <label>问题
        <input name="question" placeholder="例：他负责过哪些稳定性相关的项目？" value="${esc(state.form.ask || '')}" />
      </label>
      <button class="hr-btn primary" type="submit">提问</button>
    </form>
    <div class="hr-divider"></div>
    <div class="hr-sub">最近问答审计</div>
    ${(m.last_queries || []).map(q => `
      <div class="hr-risk ${q.refused ? 'high' : q.insufficient ? 'medium' : 'low'}">
        <b>${esc(q.employee)} · ${esc(q.question)}</b>
        <span>${q.refused ? '拒答：' + esc(q.refused_topic) : q.insufficient ? '无证据，已转本人' : '已答 · 置信度 ' + q.confidence + '%'} · ${esc(monthDay(q.created_at))} · 提问人 ${esc(q.asked_by)}</span>
        <em>${esc(q.refused ? '边界生效' : q.insufficient ? '补事实' : '可溯源')}</em>
      </div>`).join('') || '<p class="hr-empty">还没有问答记录</p>'}
  </section>
</div>

<section class="hr-card">
  <div class="hr-card-head"><h3>分身清单</h3><span class="hr-muted">授权中 / 待补齐</span></div>
  <div class="hr-grid two">
    ${list.map(tw => `
      <div class="hr-twin">
        <div class="hr-card-head">
          <h3>${esc(tw.employee_name)}</h3>
          <span class="hr-tag ${tw.status === 'active' ? 'green' : 'gray'}">${esc(tw.status)}</span>
          ${levelTag(tw.level)}
        </div>
        <p class="hr-muted">${esc(tw.dept)} · ${esc(tw.title)} · 授权人 ${esc(tw.authorized_by || '—')} · 到期 ${esc(monthDay(tw.expires_at))}</p>
        <div class="hr-row"><span class="hr-row-label">就绪度</span><div class="hr-row-body">${bar(tw.readiness.score, 100, tw.readiness.ready ? 'green' : 'amber')}</div><span class="hr-row-value">${tw.readiness.score}%</span></div>
        <div class="hr-chips">
          ${(tw.readiness.checks || []).map(c => `<span class="hr-chip ${c.ok ? '' : 'warn'}">${c.ok ? '✓' : '!'} ${esc(c.label)}</span>`).join('')}
        </div>
        <p class="hr-hint">可见主题：${esc((tw.scope?.topics || []).join('、'))}</p>
        <p class="hr-hint">拒答主题：${esc((tw.scope?.denied || []).join('、'))}</p>
        <div class="hr-actions">
          <button class="hr-btn" data-authorize="${esc(tw.employee_name)}">续期 / 调整范围</button>
          <button class="hr-btn" data-twinask="${esc(tw.employee_name)}">问它一个问题</button>
        </div>
      </div>`).join('') || '<p class="hr-empty">还没有开通任何分身。先选一名数据覆盖度 ≥ 60 的员工授权。</p>'}
  </div>
</section>`;
  }

  /* —— 培养 —— */
  function learningHtml() {
    const p = data.plans;
    if (!p) return '<div class="hr-card"><p class="hr-empty">培养数据未加载。</p></div>';
    const e = p.effect || {};
    const plans = p.plans || [];
    return `
<section class="hr-card">
  <div class="hr-card-head"><h3>培训效果（柯氏四级）</h3><span class="hr-muted">不追课时，追行为与结果</span></div>
  <div class="hr-grid four">
    <div class="hr-mini"><em>计划</em><b>${num(e.plans_total)}</b></div>
    <div class="hr-mini"><em>完成率</em><b>${pct(e.completion_rate)}</b></div>
    <div class="hr-mini"><em>学时</em><b>${num(e.hours_total)}</b></div>
    <div class="hr-mini"><em>能力提升</em><b>${num(e.uplift_count)} 项</b></div>
  </div>
  <div class="hr-divider"></div>
  ${(e.kirkpatrick || []).map(k => `
    <div class="hr-row">
      <span class="hr-row-label">L${k.level} ${esc(k.name)}</span>
      <div class="hr-row-body">${bar(k.count, Math.max(1, ...(e.kirkpatrick || []).map(x => x.count)), 'blue')}</div>
      <span class="hr-row-value">${k.count} 次</span>
    </div>
    <div class="hr-hint">${esc(k.desc)}</div>`).join('')}
  <p class="hr-muted">${esc(e.roi_note || '')}</p>
</section>

${plans.map(pl => `
<section class="hr-card">
  <div class="hr-card-head">
    <h3>${esc(pl.employee_name)} → ${esc(pl.target_role)}</h3>
    <span class="hr-tag ${pl.status === 'active' ? 'blue' : pl.status === 'done' ? 'green' : 'gray'}">${esc(pl.status)}</span>
    <span class="hr-muted">${pl.hours_done}/${pl.hours_planned} 小时 · 完成 ${pl.completion}%</span>
  </div>
  ${(pl.gaps || []).map(g => `
    <div class="hr-row">
      <span class="hr-row-label">${esc(g.skill)}</span>
      <div class="hr-row-body">${bar(g.current, g.required, 'amber')}</div>
      <span class="hr-row-value">${g.current} → ${g.required} 级</span>
    </div>`).join('')}
  <div class="hr-divider"></div>
  <div class="hr-actions-list">
    ${(pl.actions || []).map(a => `
      <div class="hr-action-item ${a.done ? 'done' : ''}">
        <span class="hr-tag ${a.done ? 'green' : 'gray'}">${esc(a.phase)}</span>
        <b>${esc(a.title)}</b>
        <span class="hr-muted">${esc(a.type)} · ${a.hours}h · 第 ${a.due_days} 天</span>
        ${a.done ? '<em>已完成</em>' : `<button class="hr-btn" data-learn="${esc(pl.id)}|${esc(a.id)}|${esc(pl.employee_name)}|${a.hours}">记录完成</button>`}
      </div>`).join('')}
  </div>
  <div class="hr-hint">${esc(pl.events?.map(x => `第 ${x.action_id} 项 · ${x.hours}h · 柯氏 L${x.kirkpatrick}`).join('；') || '尚无学习记录')}</div>
</section>`).join('') || '<section class="hr-card"><p class="hr-empty">还没有培养计划。在「人才资产」里选人，点「生成 90 天计划」。</p></section>'}`;
  }

  /* —— 知识 —— */
  function knowledgeHtml() {
    const k = data.knowledge;
    if (!k) return '<div class="hr-card"><p class="hr-empty">知识数据未加载。</p></div>';
    const h = k.health || {};
    const items = k.items || [];
    const drafts = items.filter(i => i.status === 'draft');
    const published = items.filter(i => i.status === 'published');
    return `
<section class="hr-card">
  <div class="hr-card-head"><h3>知识资产</h3><span class="hr-muted">已发布 ${published.length} · 草稿 ${drafts.length} · 待采集 ${num(k.drafts_available)}</span></div>
  <div class="hr-grid four">
    <div class="hr-mini"><em>采纳率</em><b>${pct(h.adoption_rate)}</b></div>
    <div class="hr-mini"><em>被复用</em><b>${num(h.usage_total)} 次</b></div>
    <div class="hr-mini"><em>覆盖领域</em><b>${num(h.coverage_domains)}</b></div>
    <div class="hr-mini"><em>沉睡条目</em><b>${num((h.dormant || []).length)}</b></div>
  </div>
  <div class="hr-actions">
    <button class="hr-btn primary" data-capture="1">从已核实事实采集草稿</button>
  </div>
  <div class="hr-divider"></div>
  <div class="hr-sub">自进化建议（只提案，人确认）</div>
  ${(h.suggestions || []).map(s => `<div class="hr-hint"><b>${esc(s.kind)}</b> · ${esc(s.title)} —— ${esc(s.why)}</div>`).join('') || '<p class="hr-muted">暂无建议</p>'}
</section>

${items.map(it => `
<section class="hr-card hr-knowledge">
  <div class="hr-card-head">
    <h3>${esc(it.title)}</h3>
    <span class="hr-tag ${it.status === 'published' ? 'green' : 'gray'}">${esc(it.status)}${it.version ? ' v' + it.version : ''}</span>
    <span class="hr-tag blue">${esc(it.domain)}</span>
    <span class="hr-muted">复用 ${it.reuse_count} · 采纳率 ${it.adoption_rate}%</span>
  </div>
  <div class="hr-sro">
    <div><em>情境</em><p>${esc(it.situation)}</p></div>
    <div><em>行动</em><p>${esc(it.action)}</p></div>
    <div><em>结果</em><p>${esc(it.result)}</p></div>
  </div>
  <div class="hr-rules">
    ${(it.reusable_rules || []).map(r => `<span class="hr-chip">${esc(r)}</span>`).join('')}
  </div>
  <div class="hr-actions">
    ${it.status === 'draft' ? `<button class="hr-btn primary" data-publish="${esc(it.id)}">发布（生成新版本）</button>` : ''}
    ${it.status === 'published' ? `<button class="hr-btn" data-usage="${esc(it.id)}">记录一次复用</button>` : ''}
  </div>
</section>`).join('')}`;
  }

  /* —— 招聘效能 —— */
  function recruitHtml() {
    const r = data.recruit;
    if (!r) return '<div class="hr-card"><p class="hr-empty">招聘效能数据未加载。</p></div>';
    const t = r.totals || {};
    const recs = r.recommendations || [];
    const maxSpend = Math.max(1, ...(r.channels || []).map(c => c.spend));
    return `
<section class="hr-card">
  <div class="hr-card-head"><h3>单位经济</h3><span class="hr-muted">${r.snapshot ? '招聘域数据同步于 ' + monthDay(r.snapshot.at) : '尚未同步招聘域'}</span></div>
  <div class="hr-grid four">
    <div class="hr-mini"><em>总投入</em><b>${money(t.total_cost)}</b></div>
    <div class="hr-mini"><em>单人成本</em><b>${money(t.cost_per_hire)}</b></div>
    <div class="hr-mini"><em>AI 抵扣后</em><b>${money(t.ai_adjusted_cost_per_hire)}</b></div>
    <div class="hr-mini"><em>90 天质量率</em><b>${pct(t.quality_rate)}</b></div>
  </div>
  <div class="hr-kpis">
    <span><em>入职</em><b>${num(t.hires)}</b></span>
    <span><em>外部支出</em><b>${money(t.spend)}</b></span>
    <span><em>内部工时</em><b>${num(t.internal_hours)}h / ${money(t.internal_cost)}</b></span>
    <span><em>AI 节省</em><b>${num(t.ai_hours_saved)}h / ${money(t.ai_value_saved)}</b></span>
  </div>
  <div class="hr-actions">
    <button class="hr-btn" data-sync="1">同步招聘域数据</button>
    <button class="hr-btn primary" data-genrec="1">生成降本建议</button>
  </div>
</section>

<div class="hr-grid two">
  <section class="hr-card">
    <div class="hr-card-head"><h3>渠道单位成本</h3><span class="hr-muted">同企业内相对比较</span></div>
    ${(r.channels || []).map(c => `
      <div class="hr-row">
        <span class="hr-row-label">${esc(c.name)}<small>${esc(c.type)}</small></span>
        <div class="hr-row-body">${bar(c.spend, maxSpend, c.quality_rate >= 70 ? 'green' : 'amber')}</div>
        <span class="hr-row-value">${money(c.spend)} · ${c.hired} 人 · ${money(c.cpa)}/人</span>
      </div>
      <div class="hr-hint">初筛 ${c.screen_rate}% · 面试 ${c.interview_rate}% · Offer ${c.offer_rate}% · 到岗 ${c.accept_rate}% · 质量 ${c.quality_rate}%</div>`).join('')}
  </section>

  <section class="hr-card">
    <div class="hr-card-head"><h3>漏斗转化</h3><span class="hr-muted">从触达到入职</span></div>
    ${(r.stages || []).map((s, i) => `
      <div class="hr-row">
        <span class="hr-row-label">${esc(s.label)}</span>
        <div class="hr-row-body">${bar(s.value, Math.max(1, (r.stages[0] || {}).value), 'blue')}</div>
        <span class="hr-row-value">${num(s.value)} · ${i ? s.rate_from_prev + '%' : '100%'}</span>
      </div>`).join('')}
    <div class="hr-divider"></div>
    <div class="hr-sub">内部可转岗（优先内部补位）</div>
    ${(r.internal_matches || []).map(m => `
      <div class="hr-hint"><b>${esc(m.job)}</b>：${(m.candidates || []).map(c => `${esc(c.name)}(${c.score}%)`).join('、')}</div>`).join('') || '<p class="hr-muted">暂无匹配（或招聘域未同步）</p>'}
  </section>
</div>

<section class="hr-card">
  <div class="hr-card-head"><h3>降本建议</h3><span class="hr-muted">采纳 → 改预算 → 回测</span></div>
  ${recs.map(rc => `
    <div class="hr-rec">
      <div class="hr-card-head">
        <h3>${esc(rc.title)}</h3>
        <span class="hr-tag ${rc.status === 'proposed' ? 'amber' : rc.status === 'measured' ? 'green' : rc.status === 'measured_negative' ? 'red' : 'blue'}">${esc(rc.status)}</span>
        <span class="hr-muted">预计节省 ${money(rc.expected_saving)}</span>
      </div>
      <p class="hr-muted">${esc(rc.rationale)}</p>
      ${rc.measured && rc.measured.before_cost_per_hire ? `
        <div class="hr-kpis">
          <span><em>回测前</em><b>${money(rc.measured.before_cost_per_hire)}</b></span>
          <span><em>回测后</em><b>${money(rc.measured.after_cost_per_hire)}</b></span>
          <span><em>变化</em><b>${rc.measured.delta_rate}%</b></span>
          <span><em>结论</em><b>${esc(rc.measured.verdict)}</b></span>
        </div>` : ''}
      <div class="hr-actions">
        ${rc.status === 'proposed' ? `<button class="hr-btn primary" data-adopt="${esc(rc.id)}">按建议调整预算</button>` : ''}
        ${rc.status === 'adopted' ? `<button class="hr-btn" data-measure="${esc(rc.id)}">回测效果</button>` : ''}
      </div>
    </div>`).join('') || '<p class="hr-empty">还没有建议。点上方「生成降本建议」。</p>'}
</section>`;
  }

  /* —— 人机协同 —— */
  function autonomyHtml() {
    const a = data.autonomy;
    if (!a) return '<div class="hr-card"><p class="hr-empty">分级数据未加载。</p></div>';
    const rows = a.rows || [];
    const lv = a.levels || [];
    return `
<section class="hr-card">
  <div class="hr-card-head"><h3>五级介入模型</h3><span class="hr-muted">判断标准：风险 · 可逆性 · 影响面 · 置信度 · 敏感数据</span></div>
  <div class="hr-levels">
    ${lv.map(l => `<div class="hr-level ${esc(l.tone)}">${levelTag(l.level)}<b>${esc(l.name)}</b><span>${esc(l.desc)}</span></div>`).join('')}
  </div>
</section>

<section class="hr-card">
  <div class="hr-card-head"><h3>分级矩阵</h3><span class="hr-muted">默认 / 生效 / 为什么 / 何时升级</span></div>
  <div class="hr-table-wrap">
    <table class="hr-table">
      <thead><tr><th>HR 动作</th><th>生效级别</th><th>默认</th><th>为什么</th><th>升级条件</th><th>已用</th></tr></thead>
      <tbody>
      ${rows.map(r => `
        <tr>
          <td><b>${esc(r.name)}</b><small>${esc(r.action_key)}</small></td>
          <td>${levelTag(r.effective_level)}${r.policy_level ? `<small>策略 ${esc(r.policy_level)}</small>` : ''}</td>
          <td>${levelTag(r.default_level)}</td>
          <td class="hr-cell-text">${esc(r.why)}</td>
          <td class="hr-cell-text">${esc(r.escalate)}</td>
          <td>${r.usage || 0}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
</section>

<section class="hr-card">
  <div class="hr-card-head">
    <h3>待审批卡片</h3>
    <span class="hr-muted">确认卡 / 流程审批 / L3-L4 统一登记${a.push_configured ? ' · 已接飞书推送' : ' · 未配置推送'}</span>
  </div>
  <div class="hr-actions" style="margin-bottom:10px">
    <button class="hr-btn" data-sync-approvals="1">同步并推送审批卡</button>
  </div>
  ${(a.cards || []).map(c => `
    <div class="hr-risk ${c.level === 'L4' ? 'high' : 'medium'}">
      <b>${esc(c.title)}</b>
      <span>${esc(c.capability)} · ${levelTag(c.level)} · 审批人 ${esc(c.role)} · ${esc(c.sla)}</span>
      <em>${esc(pushText(c.push_status))}</em>
      <div class="hr-actions" style="margin-top:6px">
        <button class="hr-btn primary" data-approve="${esc(c.id)}">同意</button>
        <button class="hr-btn" data-reject="${esc(c.id)}">拒绝</button>
      </div>
    </div>`).join('') || '<p class="hr-empty">没有挂起的审批卡。触发一次 L3/L4 动作或 AI 提案后会出现；点「同步并推送」立即刷新。</p>'}
</section>

<div class="hr-grid two">
  <section class="hr-card">
    <div class="hr-card-head"><h3>情境试算</h3><span class="hr-muted">同一动作，不同情境不同级别</span></div>
    <form data-form="decide" class="hr-form">
      <label>动作
        <select name="action_key">
          ${rows.map(r => `<option value="${esc(r.action_key)}">${esc(r.name)}</option>`).join('')}
        </select>
      </label>
      <label>AI 置信度
        <input name="confidence" type="range" min="20" max="99" value="80" oninput="this.nextElementSibling.textContent=this.value+'%'" />
        <span class="hr-muted">80%</span>
      </label>
      <button class="hr-btn primary" type="submit">试算</button>
    </form>
    <div id="hr-decide-out" class="hr-decide-out"></div>
  </section>

  <section class="hr-card">
    <div class="hr-card-head"><h3>最近决策台账</h3><span class="hr-muted">谁在什么级别上放行了什么</span></div>
    ${(a.recent || []).map(d => `
      <div class="hr-hint">${levelTag(d.level)} ${esc(d.action_name || d.action_key)} · ${esc(d.subject)} · ${esc(d.actor)} · ${esc(monthDay(d.created_at))}</div>`).join('') || '<p class="hr-muted">暂无</p>'}
  </section>
</div>`;
  }

  function contentHtml() {
    if (state.error) return `<div class="hr-card"><p class="hr-empty">${esc(state.error)}</p></div>`;
    if (state.tab === 'dashboard') return dashboardHtml();
    if (state.tab === 'people') return peopleHtml();
    if (state.tab === 'twins') return twinsHtml();
    if (state.tab === 'learning') return learningHtml();
    if (state.tab === 'knowledge') return knowledgeHtml();
    if (state.tab === 'recruit') return recruitHtml();
    if (state.tab === 'autonomy') return autonomyHtml();
    return '';
  }

  function renderPage(host) {
    const stats = doc.getElementById('hr-stats');
    if (stats) stats.innerHTML = renderStats();
    doc.querySelectorAll('.hr-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
    const content = doc.getElementById('hr-content');
    if (content) content.innerHTML = contentHtml();
  }

  /* —— 交互 —— */
  async function withBusy(fn) {
    if (state.busy) return;
    state.busy = true;
    try { await fn(); await loadAll(); renderPage(); }
    catch (error) { note(error.message || String(error), true); }
    finally { state.busy = false; }
  }

  function payloadOf(form) {
    const fd = new global.FormData(form);
    const out = {};
    fd.forEach((value, key) => {
      if (key === 'sensitivity') {
        out[key] = out[key] ? [...out[key], String(value)] : [String(value)];
      } else { out[key] = value; }
    });
    form.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (cb.name === 'sensitivity') out.sensitivity = [...(out.sensitivity || []), cb.value];
      if (cb.name === 'adopted') out.adopted = cb.checked;
    });
    return out;
  }

  function onListClick(event) {
    const tab = event.target.closest('[data-tab]');
    if (tab) { state.tab = tab.dataset.tab; renderPage(); return; }
    const person = event.target.closest('[data-person]');
    if (person) {
      state.person = state.person === person.dataset.person ? '' : person.dataset.person;
      renderPage();
      return;
    }
    const cap = event.target.closest('[data-capture]');
    if (cap) { withBusy(async () => { const res = await post('/knowledge/capture'); note('已生成 ' + res.created + ' 条草稿'); }); return; }
    const syncCards = event.target.closest('[data-sync-approvals]');
    if (syncCards) {
      withBusy(async () => {
        const res = await post('/approvals/sync');
        note('新登记 ' + res.created + ' 张 · 推送 ' + res.sent + (res.failed ? ' · 失败 ' + res.failed : ''), res.failed > 0);
      });
      return;
    }
    const approve = event.target.closest('[data-approve]');
    if (approve) { withBusy(async () => { await post('/approvals/' + encodeURIComponent(approve.dataset.approve) + '/decide', { decision: 'confirmed' }); note('已同意，动作已执行并留审计'); }); return; }
    const reject = event.target.closest('[data-reject]');
    if (reject) { withBusy(async () => { await post('/approvals/' + encodeURIComponent(reject.dataset.reject) + '/decide', { decision: 'rejected' }); note('已拒绝，动作不会执行'); }); return; }
    const pub = event.target.closest('[data-publish]');
    if (pub) { withBusy(async () => { const res = await post('/knowledge/' + encodeURIComponent(pub.dataset.publish) + '/publish'); note(res.pending ? '已生成审批卡，确认后才发布' : '已发布并生成新版本'); }); return; }
    const usage = event.target.closest('[data-usage]');
    if (usage) {
      const context = global.prompt('在什么场景引用了这条经验？', '本项目方案评审');
      if (!context) return;
      const adopted = global.confirm('这条经验是否被采纳？\n确定 = 采纳，取消 = 未采纳');
      withBusy(async () => { await post('/knowledge/' + encodeURIComponent(usage.dataset.usage) + '/usage', { context, adopted }); note('已记录复用'); });
      return;
    }
    const plan = event.target.closest('[data-plan]');
    if (plan) {
      const emp = data.employees.find(e => String(e.id) === String(plan.dataset.plan));
      if (!emp) return;
      withBusy(async () => { const res = await post('/learning/plans', { employee: emp.name }); note(res.pending ? '已生成 L3 审批卡，确认后才发布' : (res.summary || '计划已发布')); });
      return;
    }
    const auth = event.target.closest('[data-authorize]');
    if (auth) {
      withBusy(async () => {
        const res = await post('/twins/authorize', { employee: auth.dataset.authorize, expires_days: 180 });
        note(res.pending ? '已生成 L4 审批卡，批准后才授权' : '分身已授权（L4，已留审计）');
      });
      return;
    }
    const learn = event.target.closest('[data-learn]');
    if (learn) {
      const [planId, actionId, employee, hours] = learn.dataset.learn.split('|');
      withBusy(async () => {
        await post('/learning/events', { employee, plan_id: planId, action_id: actionId, kind: 'course', hours: Number(hours), applied: true, kirkpatrick_level: 3 });
        note('已记录学习完成');
      });
      return;
    }
    const sync = event.target.closest('[data-sync]');
    if (sync) {
      withBusy(async () => {
        const res = await post('/recruiting/sync');
        note(res.ok ? '已同步 ' + res.applications_seen + ' 条申请（' + (res.truncated ? '能力上限截断' : '全量') + '）' : (res.error || '同步失败'), !res.ok);
      });
      return;
    }
    const gen = event.target.closest('[data-genrec]');
    if (gen) { withBusy(async () => { const res = await post('/recruiting/recommendations/generate'); note('新生成 ' + res.created + ' 条建议'); }); return; }
    const adopt = event.target.closest('[data-adopt]');
    if (adopt) {
      const rec = (data.recruit?.recommendations || []).find(r => String(r.id) === String(adopt.dataset.adopt));
      const from = global.prompt('从哪个渠道调出？', '招聘网站 A');
      const to = global.prompt('调入哪个渠道？', '员工内推');
      const amount = global.prompt('调整金额（元）', String(rec?.expected_saving || 5000));
      if (!from || !to || !amount) return;
      withBusy(async () => {
        const res = await post('/recruiting/recommendations/' + encodeURIComponent(adopt.dataset.adopt) + '/adopt', { from_channel: from, to_channel: to, amount: Number(amount) });
        note(res.pending ? '已生成 L3 审批卡，批准后才调整预算' : '预算已调整（L3，已留审计）');
      });
      return;
    }
    const measure = event.target.closest('[data-measure]');
    if (measure) {
      withBusy(async () => {
        const res = await post('/recruiting/recommendations/' + encodeURIComponent(measure.dataset.measure) + '/measure', { note: '采纳一个周期后回测' });
        note('回测完成：单人成本 ' + res.delta_rate + '% · ' + res.verdict);
      });
      return;
    }
    const twinAsk = event.target.closest('[data-twinask]');
    if (twinAsk) { state.twinEmp = twinAsk.dataset.twinask; state.tab = 'twins'; renderPage(); return; }
    const addFact = event.target.closest('[data-addfact]');
    if (addFact) {
      const title = global.prompt('一句话标题（如「订单中心灰度发布体系落地」）', '');
      if (!title) return;
      const summary = global.prompt('摘要，建议写成「情境：… 行动：… 结果：…」', '情境：… 行动：… 结果：…');
      if (!summary) return;
      withBusy(async () => {
        const res = await post('/employees/' + encodeURIComponent(addFact.dataset.addfact) + '/facts', {
          kind: 'project', title, summary, tags: ['补充'], evidence_strength: 2,
        });
        note(res.pending ? '已生成 ' + res.level + ' 审批卡，确认后才登记' : '事实已登记（L2，确认人即背书人）');
      });
    }
  }

  async function onSubmit(event) {
    const form = event.target.closest('[data-form]');
    if (!form) return;
    event.preventDefault();
    const kind = form.dataset.form;
    const payload = payloadOf(form);
    if (kind === 'ask') {
      const question = String(payload.question || '').trim();
      if (!question) return;
      state.form.ask = question;
      state.twinEmp = payload.employee;
      withBusy(async () => {
        const res = await post('/twins/' + encodeURIComponent(payload.employee) + '/ask', { question });
        note(res.refused ? '拒答：' + res.refused_reason : res.insufficient ? '暂无证据，已转本人' : '已回答，引用 ' + res.citations.length + ' 条');
        const box = doc.getElementById('hr-answer');
        if (box) {
          box.innerHTML = `<div class="hr-answer"><b>${esc(res.employee.name)} 的分身</b><p>${esc(res.answer).replace(/\n/g, '<br/>')}</p><div class="hr-hint">引用：${(res.citations || []).map(c => esc(c.title)).join(' · ') || '无'} · 置信度 ${res.confidence}%</div></div>`;
        }
      });
      return;
    }
    if (kind === 'decide') {
      withBusy(async () => {
        const res = await post('/autonomy/decide', {
          action_key: payload.action_key,
          confidence: Number(payload.confidence || 80) / 100,
          subject: '情境试算',
        });
        const out = doc.getElementById('hr-decide-out');
        if (out) {
          out.innerHTML = `<div class="hr-decide">
            <div class="hr-card-head">${levelTag(res.level)}<b>${esc(res.action_name)}</b><span class="hr-muted">审批：${esc(res.approver)} · ${esc(res.sla)}</span></div>
            <ul>${res.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
            <p class="hr-hint">护栏：${esc(res.guards.join('；'))}</p>
          </div>`;
        }
      });
      return;
    }
  }

  RENDER.hr = async (page) => {
    if (page.signal.aborted || !page.host.isConnected) return;
    const host = page.host;
    host.classList.add('hr-page');
    host.innerHTML = `
      <header class="hr-head">
        <h1>HR 中台</h1>
        <span class="hr-sub">员工数据资产 · 数字分身 · 能力培养 · 经验沉淀 · 招聘效能 · 人机协同</span>
      </header>
      <div class="hr-stats" id="hr-stats"></div>
      <div class="hr-tabs" role="tablist">
        ${TABS.map(t => `<button class="hr-tab ${state.tab === t.id ? 'active' : ''}" data-tab="${t.id}" role="tab">${t.name}</button>`).join('')}
      </div>
      <div id="hr-answer"></div>
      <div id="hr-content"></div>
      <div id="hr-note" class="hr-note"></div>`;

    if (!host.dataset.hrWired) {
      host.addEventListener('click', onListClick);
      host.addEventListener('submit', onSubmit);
      host.dataset.hrWired = '1';
    }
    if (!state.mounted) {
      Object.assign(state, { tab: 'dashboard', person: '', twinEmp: '', form: {}, error: '' });
      state.mounted = true;
    }
    renderPage(host);
    await loadAll();
    renderPage(host);
  };
})(window);
