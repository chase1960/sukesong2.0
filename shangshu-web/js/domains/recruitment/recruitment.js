/* 招聘演示域（纯 Node 演示赛道）。
 * 流水线：建岗位 → AI 生成 JD（提案） → 人工确认发布 → 收件箱简历 → AI 解析（提案） → 人工确认转申请
 *        → AI 筛选建议（提案） → 人工定夺 → 安排面试 → 面试评价 → Offer 审批 → 候选人答复 → 入职完成 → 审计时间线。
 * 契约：AI 只提案、人确认后落库；每个动作在服务端 appendEvent 记审计（hash 链不可变）。
 * 前端只新增本目录（domain-entry.json 声明），不碰 index.html / app.js / page-registry。
 */
(function (global) {
  'use strict';

  const doc = global.document;
  const roles = ['admin', 'manager', 'staff'];
  global.shangshuRegisterPages?.(['recruitment'], { owner: 'com.shangshu.recruitment', name: '招聘', status: 'implemented', platform: true, roles });
  global.shangshuRegisterNav?.([{ id: 'recruitment', name: '招聘', ico: 'users', sec: '业务', roles }]);

  const API = '/api/recruitment';

  function fetchJson(path, options) {
    return global.fetch(path, Object.assign({ credentials: 'include', cache: 'no-store' }, options || {}))
      .then(async response => {
        let data = null;
        try { data = await response.json(); } catch (error) { data = null; }
        if (!response.ok || (data && data.ok === false)) {
          const err = Error((data && (data.error || data.message)) || ('HTTP ' + response.status));
          err.status = response.status;
          throw err;
        }
        return data;
      });
  }

  // —— 人话动作名（审计时间线用） ——
  const CAP_NAMES = {
    'recruitment.job.save': '创建岗位', 'recruitment.jd.ai': 'AI 生成 JD（提案）', 'recruitment.jd.save': '人工修订 JD',
    'recruitment.jd.publish': '发布 JD', 'recruitment.job.close': '关闭岗位',
    'recruitment.mailbox.receive': '收到简历邮件', 'recruitment.resume.parse': 'AI 解析简历（提案）',
    'recruitment.candidate.save': '候选人建档', 'recruitment.application.intake': '简历转申请', 'recruitment.intake.ignore': '忽略邮件',
    'recruitment.screening.propose': 'AI 筛选建议（提案）', 'recruitment.screening.decide': '筛选定夺',
    'recruitment.interview.schedule': '安排面试', 'recruitment.evaluation.submit': '面试评价提交',
    'recruitment.offer.create': '创建 Offer', 'recruitment.offer.approve': '审批 Offer',
    'recruitment.offer.record_reply': 'Offer 答复', 'recruitment.onboarding.complete': '入职完成',
    'recruitment.skill.extract': '提取偏好规则草稿', 'recruitment.skill.activate': '偏好规则 HR 确认（激活/驳回）',
  };
  const INITIATOR_NAMES = { user: '用户', agent: 'AI', trigger: '定时' };
  const STAGES = [
    { key: 'screening', name: '筛选' },
    { key: 'interview', name: '面试' },
    { key: 'offer', name: 'Offer' },
    { key: 'onboarding', name: '入职' },
  ];
  const OUTCOME_TAGS = { hired: { text: '已入职', cls: 'green' }, rejected: { text: '已淘汰', cls: 'red' }, withdrawn: { text: '已放弃', cls: 'gray' } };
  const JOB_STATUS = { draft: { text: '草稿', cls: 'gray' }, open: { text: '招聘中', cls: 'green' }, closed: { text: '已关闭', cls: 'gray' } };
  const OFFER_STATUS = { pending: { text: '待审批', cls: 'amber' }, approved: { text: '已审批', cls: 'blue' }, accepted: { text: '候选人已接受', cls: 'green' }, declined: { text: '候选人婉拒', cls: 'red' } };
  const RECOMMEND_TEXT = { advance: '建议推进', reject: '建议淘汰', review: '建议人工复核' };

  const state = {
    tab: 'jobs', overview: null, jobs: [], inbox: [], apps: [], events: [], skills: [], episodes: [],
    expanded: {},       // 展开的申请卡 id
    parsed: {},         // 收件箱解析结果 mailId → {candidate, fallback, open_jobs}
    error: '', authed: true,
    /* 页内状态只初始化一次：重挂载（换页再回来 / 外部导航）要保留当前 Tab 与在途 AI 提案
       —— 每次挂载都重置会把「AI 已提案、等人确认」的卡片凭空清掉，用户只能再调一次 AI。 */
    mounted: false,
  };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // 安全 Markdown → HTML：先转义全部输入，再只输出受控标签（标题/段落/列表/粗体）。
  function renderJdMarkdown(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    let list = [];
    function inline(s) { return esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'); }
    function flushPara() { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } }
    function flushList() {
      if (list.length) {
        out.push('<ul>' + list.map(function (it) { return '<li>' + inline(it) + '</li>'; }).join('') + '</ul>');
        list = [];
      }
    }
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { flushPara(); flushList(); continue; }
      let m;
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flushPara(); flushList();
        const level = Math.min(m[1].length + 2, 6);
        out.push('<h' + level + '>' + inline(m[2]) + '</h' + level + '>');
      } else if ((m = /^[-*+]\s+(.*)$/.exec(line))) {
        flushPara();
        list.push(m[1]);
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara(); flushList();
    return out.join('');
  }
  function fmtTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return iso; }
  }

  async function refreshAll() {
    try {
      const [overview, jobs, inbox, apps, events] = await Promise.all([
        fetchJson(API + '/overview'), fetchJson(API + '/jobs'),
        fetchJson(API + '/inbox'), fetchJson(API + '/applications'),
        fetchJson(API + '/events'),
      ]);
      Object.assign(state, { overview, jobs, inbox, apps, events, error: '', authed: true });
    } catch (error) {
      state.error = error.status === 401 ? '' : (error.message || String(error));
      state.authed = error.status !== 401;
    }
    // 学习区块端点可能尚未就绪（后端并行开发）：失败不清主数据、不打断刷新链
    try {
      const asList = x => Array.isArray(x) ? x : (x && (x.items || x.list)) || [];
      const [skills, episodes] = await Promise.all([
        fetchJson(API + '/skills'), fetchJson(API + '/episodes'),
      ]);
      state.skills = asList(skills);
      state.episodes = asList(episodes);
    } catch (error) { /* 端点未就绪时保持空列表 */ }
    renderStatsIntoDom();
    render();
  }

  function renderStatsIntoDom() {
    const stats = doc.getElementById('rec-stats');
    if (stats) stats.innerHTML = renderStats();
  }

  async function act(button, fn) {
    if (!button || button.classList.contains('busy')) return;
    button.classList.add('busy');
    const old = button.textContent;
    if (old && old.length <= 6) button.textContent = old + '…';
    let actionError = '';
    try {
      await fn();
      state.error = '';
    } catch (error) {
      state.notice = '';
      actionError = error.status === 401 ? '请先登录（admin / admin），再操作招聘页。' : (error.message || String(error));
    } finally {
      button.classList.remove('busy');
      if (old && button.textContent === old + '…') button.textContent = old;
      await refreshAll();
      state.error = actionError;
      render();
    }
  }

  function post(path, body) { return fetchJson(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); }

  // ================= 渲染 =================

  function render() {
    const content = doc.getElementById('rec-content');
    if (!content) return;
    if (!state.authed) {
      content.innerHTML = '<div class="rec-card"><p class="rec-empty">请先登录（账号 <b>admin</b> / 密码 <b>admin</b>）后刷新本页。</p></div>';
      return;
    }
    const tabs = [
      ['jobs', '岗位与 JD'], ['inbox', '收件箱'], ['board', '申请看板'], ['audit', '审计时间线'], ['learn', 'Agent 学习'],
    ];
    let html = state.error ? '<div class="rec-error" role="alert">' + esc(state.error) + '</div>' : '';
    html += state.notice ? '<div class="rec-evt-note" role="status">' + esc(state.notice) + '</div>' : '';
    html += '<div class="rec-tabs" role="tablist">' + tabs.map(([key, name]) =>
      '<button type="button" class="rec-tab' + (state.tab === key ? ' active' : '') + '" data-rec-action="tab" data-rec-arg="' + key + '" role="tab">' + name + '</button>').join('') + '</div>';
    html += '<div class="rec-body">';
    if (state.tab === 'jobs') html += renderJobs();
    else if (state.tab === 'inbox') html += renderInbox();
    else if (state.tab === 'board') html += renderBoard();
    else if (state.tab === 'learn') html += renderLearn();
    else html += renderAudit();
    html += '</div>';
    content.innerHTML = html;
  }

  function renderStats() {
    const o = state.overview || {};
    const items = [
      ['在招岗位', o.jobs_open], ['新简历', o.inbox_new], ['筛选', o.screening], ['面试', o.interview],
      ['Offer', o.offer], ['入职', o.onboarding], ['已入职', o.hired, true],
    ];
    return items.map(([name, value, hl]) => '<span class="rec-stat' + (hl ? ' hl' : '') + '">' + name + ' <b>' + (value || 0) + '</b></span>').join('');
  }

  // —— 岗位 tab ——
  function renderJobs() {
    let html = '<div class="rec-actions"><button type="button" class="rec-btn primary" data-rec-action="job-new">' +
      (state.jobFormOpen ? '收起表单' : '＋ 新建岗位') + '</button></div>';
    if (state.jobFormOpen) {
      html += '<div class="rec-card"><h3>新建岗位</h3><form class="rec-form" data-rec-form="job">' +
        '<label>岗位名称<input name="title" required placeholder="如：资深前端工程师"></label>' +
        '<label>部门<input name="department" required placeholder="如：平台研发部"></label>' +
        '<label>招聘人数<input name="headcount" type="number" min="1" value="1"></label>' +
        '<label>任职要求（给 AI 的关键输入）<textarea name="requirements" placeholder="如：Node.js / TypeScript，3 年以上经验，有分布式经验加分"></textarea></label>' +
        '<label>亮点与卖点<textarea name="highlights" placeholder="如：核心业务线、技术氛围、薪酬竞争力"></textarea></label>' +
        '<div class="rec-actions"><button type="submit" class="rec-btn primary">创建岗位（草稿）</button></div></form></div>';
    }
    if (!state.jobs.length) html += '<div class="rec-empty">还没有岗位。点「新建岗位」，用 AI 生成 JD 后发布，开始招聘流水线。</div>';
    for (const job of state.jobs) html += renderJobCard(job);
    return html;
  }

  function renderJobCard(job) {
    const st = JOB_STATUS[job.status] || JOB_STATUS.draft;
    let html = '<div class="rec-card" data-rec-job="' + esc(job.id) + '"><div class="rec-card-head">' +
      '<h3>' + esc(job.title) + '</h3><span class="rec-code">' + esc(job.code) + '</span>' +
      '<span class="rec-tag ' + st.cls + '">' + st.text + '</span>' +
      '<span class="rec-muted">' + esc(job.department) + ' · 招 ' + esc(job.headcount) + ' 人</span></div>';
    if (job.status === 'draft') {
      html += '<div class="rec-actions">' +
        '<button type="button" class="rec-btn" data-rec-action="job-ai-jd" data-rec-id="' + esc(job.id) + '">AI 生成 JD</button>' +
        '<button type="button" class="rec-btn primary" data-rec-action="job-publish" data-rec-id="' + esc(job.id) + '">确认发布岗位</button></div>';
      if (job.jd_draft) {
        html += '<form class="rec-form" data-rec-form="jd" data-rec-id="' + esc(job.id) + '">' +
          '<label>JD 草稿（AI 提案，可人工修订后发布）<textarea name="jd" rows="12">' + esc(job.jd_draft) + '</textarea></label></form>';
      }
    } else {
      if (job.jd_published) html += '<div class="jd-view">' + renderJdMarkdown(job.jd_published) + '</div>';
      if (job.status === 'open') {
        html += '<div class="rec-actions"><button type="button" class="rec-btn danger" data-rec-action="job-close" data-rec-id="' + esc(job.id) + '">关闭岗位</button></div>';
      }
    }
    return html + '</div>';
  }

  // —— 收件箱 tab ——
  function renderInbox() {
    if (!state.inbox.length) return '<div class="rec-empty">收件箱是空的。种子演示数据里有 2 封简历邮件；没有的话重启服务即可补种。</div>';
    let html = '';
    for (const mail of state.inbox) {
      html += '<div class="rec-card" data-rec-mail="' + esc(mail.id) + '"><div class="rec-card-head">' +
        '<h3>' + esc(mail.subject) + '</h3>' +
        (mail.status === 'new' ? '<span class="rec-tag blue">待处理</span>' : mail.status === 'converted' ? '<span class="rec-tag green">已转申请</span>' : '<span class="rec-tag gray">已忽略</span>') +
        '</div><p class="rec-muted">' + esc(mail.mail_from) + ' · ' + esc(fmtTime(mail.received_at)) + '</p>';
      if (mail.status === 'new') {
        const parsed = state.parsed[mail.id];
        if (parsed) {
          html += renderParseConfirm(mail, parsed);
        } else {
          html += '<div class="rec-actions"><button type="button" class="rec-btn" data-rec-action="mail-parse" data-rec-id="' + esc(mail.id) + '">AI 解析简历</button>' +
            '<button type="button" class="rec-btn danger" data-rec-action="mail-ignore" data-rec-id="' + esc(mail.id) + '">忽略</button></div>';
        }
        html += '<details class="rec-resume" style="margin-top:10px"><summary>查看简历原文</summary><pre>' + esc(mail.resume_text) + '</pre></details>';
      }
      html += '</div>';
    }
    return html;
  }

  function renderParseConfirm(mail, parsed) {
    const c = parsed.candidate;
    return '<div class="rec-confirm"><div class="rec-confirm-head"><span class="rec-dot"></span>AI 解析提案 · 人工确认后转为申请' +
      (parsed.fallback ? '<span class="rec-fb">预录结果（LLM 不可达）</span>' : '') + '</div>' +
      '<form class="rec-form" data-rec-form="convert" data-rec-id="' + esc(mail.id) + '">' +
      '<div class="rec-kv">' +
      '<dt>姓名</dt><dd><input name="name" value="' + esc(c.name) + '"></dd>' +
      '<dt>邮箱</dt><dd><input name="email" value="' + esc(c.email) + '"></dd>' +
      '<dt>电话</dt><dd><input name="phone" value="' + esc(c.phone) + '"></dd>' +
      '<dt>教育</dt><dd><input name="education" value="' + esc(c.education) + '"></dd>' +
      '<dt>年限</dt><dd><input name="experience_years" type="number" min="0" value="' + esc(c.experience_years) + '"></dd>' +
      '<dt>技能</dt><dd><input name="skills" value="' + esc((c.skills || []).join('、')) + '"></dd>' +
      '<dt>摘要</dt><dd><input name="summary" value="' + esc(c.summary) + '"></dd>' +
      '<dt>投递岗位</dt><dd><select name="job_id">' +
      (parsed.open_jobs || []).map(j => '<option value="' + esc(j.id) + '">' + esc(j.code) + ' · ' + esc(j.title) + '</option>').join('') +
      '</select></dd>' +
      '</div><div class="rec-actions">' +
      '<button type="submit" class="rec-btn primary">确认转为申请</button>' +
      '</div></form></div>';
  }

  // —— 看板 tab ——
  function renderBoard() {
    const active = state.apps.filter(a => a.outcome === 'active');
    let html = '<div class="rec-board">';
    for (const stage of STAGES) {
      const cards = active.filter(a => a.stage === stage.key);
      html += '<div class="rec-col"><div class="rec-col-head">' + stage.name + '<span class="rec-count">' + cards.length + '</span></div>';
      for (const app of cards) html += renderAppCard(app);
      if (!cards.length) html += '<div class="rec-muted" style="padding:4px 6px">暂无</div>';
      html += '</div>';
    }
    html += '</div>';
    const done = state.apps.filter(a => a.outcome !== 'active');
    if (done.length) {
      html += '<div class="rec-terminal">' + done.map(a => {
        const t = OUTCOME_TAGS[a.outcome] || OUTCOME_TAGS.rejected;
        return '<span class="rec-tag ' + t.cls + '">' + esc(a.candidate ? a.candidate.name : a.id) + ' · ' + t.text + '</span>';
      }).join('') + '</div>';
    }
    return html;
  }

  function aiBadge(app) {
    if (!app.ai || !app.ai.recommendation) return '';
    const cls = app.ai.recommendation === 'advance' ? 'green' : app.ai.recommendation === 'reject' ? 'red' : 'amber';
    return '<span class="rec-tag ' + cls + '">AI ' + (RECOMMEND_TEXT[app.ai.recommendation] || app.ai.recommendation) + ' ' + esc(app.ai.score) + '</span>';
  }

  function renderAppCard(app) {
    const expanded = !!state.expanded[app.id];
    let html = '<div class="rec-app' + (expanded ? ' open' : '') + '" data-rec-app="' + esc(app.id) + '" data-rec-action="app-toggle" data-rec-id="' + esc(app.id) + '">' +
      '<div class="rec-app-head"><b>' + esc(app.candidate ? app.candidate.name : '未知候选人') + '</b>' + aiBadge(app) + '</div>' +
      '<div class="rec-app-job">' + esc(app.job ? app.job.code + ' · ' + app.job.title : '') + ' · ' + esc(app.candidate ? app.candidate.experience_years + ' 年' : '') + '</div>';
    if (expanded) html += '<div class="rec-app-detail">' + renderAppDetail(app) + '</div>';
    return html + '</div>';
  }

  function renderAppDetail(app) {
    const c = app.candidate || {};
    let html = '<div class="rec-kv">' +
      '<dt>邮箱</dt><dd>' + esc(c.email || '-') + '</dd>' +
      '<dt>电话</dt><dd>' + esc(c.phone || '-') + '</dd>' +
      '<dt>教育</dt><dd>' + esc(c.education || '-') + '</dd>' +
      '<dt>技能</dt><dd>' + esc((c.skills || []).join('、') || '-') + '</dd>' +
      '</div>';
    if (c.summary) html += '<p class="rec-muted" style="margin:6px 0">' + esc(c.summary) + '</p>';

    // —— 筛选阶段：AI 建议 + 人工定夺 ——
    if (app.stage === 'screening') {
      if (app.ai && app.ai.recommendation) {
        html += '<div class="rec-confirm"><div class="rec-confirm-head"><span class="rec-dot"></span>AI 筛选提案 · 分数 ' + esc(app.ai.score) +
          (app.ai.fallback ? '<span class="rec-fb">预录结果（LLM 不可达）</span>' : '') + '</div>' +
          '<p style="margin:0 0 6px;font-size:12px">' + esc(app.ai.reasoning) + '</p>' +
          '<dl class="rec-kv"><dt>优势</dt><dd>' + esc((app.ai.strengths || []).join('；') || '-') + '</dd>' +
          '<dt>关注</dt><dd>' + esc((app.ai.concerns || []).join('；') || '-') + '</dd></dl></div>';
      } else {
        html += '<div class="rec-actions"><button type="button" class="rec-btn" data-rec-action="app-ai-screen" data-rec-id="' + esc(app.id) + '">生成 AI 筛选建议</button></div>';
      }
      html += '<div class="rec-actions">' +
        '<button type="button" class="rec-btn primary" data-rec-action="app-advance" data-rec-id="' + esc(app.id) + '">推进面试（人工确认）</button>' +
        '<button type="button" class="rec-btn danger" data-rec-action="app-reject" data-rec-id="' + esc(app.id) + '">淘汰</button></div>';
    }

    // —— 面试阶段：安排 + 评价 ——
    if (app.stage === 'interview') {
      for (const iv of app.interviews || []) {
        html += '<div style="margin:6px 0;padding:6px 8px;background:var(--bg-alt);border-radius:var(--r-xs);font-size:12px">' +
          '第 ' + esc(iv.round) + ' 轮 · ' + esc(fmtTime(iv.scheduled_at)) + ' · 面试官 ' + esc(iv.interviewer) +
          (iv.status === 'completed' ? ' · <span class="rec-tag green">已评 ' + esc(iv.rating) + '/5</span>' : ' · <span class="rec-tag amber">待评价</span>') +
          (iv.comment ? '<div class="rec-muted" style="margin-top:3px">' + esc(iv.comment) + '</div>' : '') + '</div>';
        if (iv.status !== 'completed') {
          html += '<form class="rec-mini-form" data-rec-form="evaluate" data-rec-id="' + esc(iv.id) + '">' +
            '<label>面试评分（1-5）<input name="rating" type="number" min="1" max="5" required value="4"></label>' +
            '<label>评价意见<input name="comment" placeholder="技术深度扎实，分布式经验真实……"></label>' +
            '<div class="rec-actions"><button type="submit" class="rec-btn primary">提交面试评价</button></div></form>';
        }
      }
      if (!(app.interviews || []).some(iv => iv.status !== 'completed') || !(app.interviews || []).length) {
        html += '<form class="rec-mini-form" data-rec-form="interview" data-rec-id="' + esc(app.id) + '">' +
          '<label>面试时间<input name="scheduled_at" type="datetime-local" required></label>' +
          '<label>面试官<input name="interviewer" required placeholder="如：李工（平台研发）"></label>' +
          '<div class="rec-actions"><button type="submit" class="rec-btn primary">安排面试</button></div></form>';
      }
      if ((app.interviews || []).some(iv => iv.status === 'completed')) {
        html += '<form class="rec-mini-form" data-rec-form="offer" data-rec-id="' + esc(app.id) + '">' +
          '<label>Offer 薪酬（税前）<input name="salary" required placeholder="如：32K × 14"></label>' +
          '<div class="rec-actions"><button type="submit" class="rec-btn primary">创建 Offer 并进入审批</button></div></form>';
      }
    }

    // —— Offer 阶段：审批 + 答复 ——
    if (app.stage === 'offer' && app.offer) {
      const st = OFFER_STATUS[app.offer.status] || OFFER_STATUS.pending;
      html += '<div style="margin:6px 0;font-size:12px">Offer：' + esc(app.offer.salary) + ' · <span class="rec-tag ' + st.cls + '">' + st.text + '</span></div>';
      if (app.offer.status === 'pending') {
        html += '<div class="rec-actions"><button type="button" class="rec-btn primary" data-rec-action="offer-approve" data-rec-id="' + esc(app.offer.id) + '">审批通过 Offer</button></div>';
      }
      if (app.offer.status === 'approved') {
        html += '<div class="rec-actions">' +
          '<button type="button" class="rec-btn primary" data-rec-action="offer-accept" data-rec-id="' + esc(app.offer.id) + '">候选人接受（进入入职）</button>' +
          '<button type="button" class="rec-btn danger" data-rec-action="offer-decline" data-rec-id="' + esc(app.offer.id) + '">候选人婉拒</button></div>';
      }
    }

    // —— 入职阶段 ——
    if (app.stage === 'onboarding' && app.onboarding) {
      if (app.onboarding.status === 'pending') {
        html += '<div class="rec-actions"><button type="button" class="rec-btn primary" data-rec-action="onboard-complete" data-rec-id="' + esc(app.onboarding.id) + '">完成入职（流程收官）</button></div>';
      } else {
        html += '<div style="margin:6px 0"><span class="rec-tag green">入职完成 ' + esc(fmtTime(app.onboarding.completed_at)) + '</span></div>';
      }
    }
    return html;
  }

  // —— Agent 学习 tab（HR 确认的偏好规则）——
  // 口径：规则由确定性规则从操作证据提取，HR 逐条确认后生效——是「HR 确认的偏好规则」，不称自主进化。
  const RULE_TYPES = { jd_style: 'JD 风格偏好', screening_preference: '筛选偏好' };
  const SKILL_STATUS = {
    draft: { text: '待 HR 确认', cls: 'amber' },
    active: { text: '生效中', cls: 'green' },
    dismissed: { text: '已驳回', cls: 'gray' },
  };
  const EPISODE_KINDS = { jd_edit: 'JD 修订', screening_decision: '筛选定夺', interview_feedback: '面试评价' };
  const DECISION_TEXT = { advance: { text: '推进', cls: 'green' }, reject: { text: '淘汰', cls: 'red' }, review: { text: '复核', cls: 'amber' } };

  function parseMaybeJson(raw) {
    if (raw == null) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)); } catch (e) { return {}; }
  }

  function skillPatternText(ruleType, pattern) {
    const p = parseMaybeJson(pattern);
    if (ruleType === 'jd_style') {
      if (p.remove_section) return '后续 JD 不再包含段落「' + p.remove_section + '」';
      if (p.add_section) return '后续 JD 需包含段落「' + p.add_section + '」';
    } else if (ruleType === 'screening_preference') {
      if (p.min_experience_years) return '经验低于 ' + p.min_experience_years + ' 年的候选人建议谨慎推进';
    }
    return Object.keys(p).length ? JSON.stringify(p) : '—';
  }

  function renderEvidence(ids) {
    if (!ids.length) return '—';
    const parts = ids.map(eid => {
      const ep = state.episodes.find(e => e.id === eid);
      return ep ? (EPISODE_KINDS[ep.kind] || ep.kind) + ' ' + fmtTime(ep.created_at) : '证据 #' + String(eid).slice(0, 8);
    });
    return '×' + ids.length + '：' + esc(parts.join('；'));
  }

  function renderSkillCard(skill) {
    const st = SKILL_STATUS[skill.status] || SKILL_STATUS.draft;
    const evidence = parseMaybeJson(skill.evidence_ids);
    const evidenceIds = Array.isArray(evidence) ? evidence : [];
    let html = '<div class="rec-card" data-rec-skill="' + esc(skill.id) + '"><div class="rec-card-head">' +
      '<h3>' + esc(RULE_TYPES[skill.rule_type] || skill.rule_type) + '</h3>' +
      '<span class="rec-tag ' + st.cls + '">' + st.text + '</span></div>' +
      '<p style="margin:6px 0">' + esc(skill.description || '') + '</p>' +
      '<dl class="rec-kv"><dt>规则</dt><dd>' + esc(skillPatternText(skill.rule_type, skill.pattern)) + '</dd>' +
      '<dt>证据</dt><dd>' + renderEvidence(evidenceIds) + '</dd>';
    if (skill.status === 'active') {
      html += '<dt>生效</dt><dd>' + esc((skill.activated_by ? skill.activated_by + ' · ' : '') + fmtTime(skill.activated_at)) + '，已注入后续 AI 提示词</dd>';
    }
    html += '</dl>';
    if (skill.status === 'draft') {
      html += '<div class="rec-actions">' +
        '<button type="button" class="rec-btn primary" data-rec-action="skill-activate" data-rec-id="' + esc(skill.id) + '">激活（HR 确认）</button>' +
        '<button type="button" class="rec-btn danger" data-rec-action="skill-dismiss" data-rec-id="' + esc(skill.id) + '">驳回</button></div>';
    }
    return html + '</div>';
  }

  function jdHeadings(text) {
    return String(text || '').split('\n').filter(l => /^#{1,6}\s/.test(l.trim())).map(l => l.replace(/^#{1,6}\s+/, '').trim());
  }

  function renderEpisodeCard(ep) {
    const cand = parseMaybeJson(ep.candidate);
    let html = '<div class="rec-card"><div class="rec-card-head"><h3>' + esc(EPISODE_KINDS[ep.kind] || ep.kind) + '</h3>' +
      '<span class="rec-muted">' + esc(fmtTime(ep.created_at)) + (ep.actor ? ' · ' + esc(ep.actor) : '') + '</span></div>';
    if (ep.kind === 'jd_edit') {
      const aiH = jdHeadings(ep.ai_content), humanH = jdHeadings(ep.human_content);
      const removed = aiH.filter(h => !humanH.includes(h));
      const added = humanH.filter(h => !aiH.includes(h));
      html += '<div style="margin:6px 0">' +
        removed.map(h => '<span class="rec-tag red">HR 删除段落「' + esc(h) + '」</span>').join(' ') +
        added.map(h => '<span class="rec-tag green">HR 补充段落「' + esc(h) + '」</span>').join(' ') + '</div>';
      html += '<details style="margin-top:8px"><summary class="rec-muted">AI 原稿 vs HR 终稿</summary>' +
        '<div class="rec-evt-payload" style="margin-top:4px"><b>AI 原稿</b><br>' + esc(ep.ai_content || '') + '</div>' +
        '<div class="rec-evt-payload" style="margin-top:4px"><b>HR 终稿</b><br>' + esc(ep.human_content || '') + '</div></details>';
    } else if (ep.kind === 'screening_decision') {
      const ai = DECISION_TEXT[ep.ai_recommend] || { text: ep.ai_recommend || '-', cls: 'gray' };
      const human = DECISION_TEXT[ep.human_decision] || { text: ep.human_decision || '-', cls: 'gray' };
      const overridden = ep.ai_recommend === 'advance' && ep.human_decision === 'reject';
      html += '<p style="margin:6px 0">' + esc(cand.name || '候选人') +
        (cand.experience_years ? ' · ' + esc(cand.experience_years) + ' 年经验' : '') +
        (Array.isArray(cand.skills) && cand.skills.length ? ' · ' + esc(cand.skills.join('、')) : '') + '</p>' +
        '<div style="margin:6px 0">AI 建议 <span class="rec-tag ' + ai.cls + '">' + ai.text + '</span> → HR 决定 <span class="rec-tag ' + human.cls + '">' + human.text + '</span>' +
        (overridden ? ' <span class="rec-tag amber">HR 否决 AI 建议</span>' : '') + '</div>';
    } else if (ep.kind === 'interview_feedback') {
      html += '<p style="margin:6px 0">面试官 ' + esc(ep.interviewer || '-') + ' · 评分 ' + esc(ep.rating || '-') + '/5' +
        (ep.comment ? ' · ' + esc(ep.comment) : '') + '</p>';
    }
    return html + '</div>';
  }

  function renderLearn() {
    const drafts = state.skills.filter(s => s.status === 'draft');
    const active = state.skills.filter(s => s.status === 'active');
    let html = '<div class="rec-card"><h3>HR 确认的偏好规则</h3>' +
      '<p class="rec-muted" style="margin:4px 0 10px">学习闭环：每次「AI 原稿 vs HR 终稿」的差异都记录为操作证据；' +
      '系统从重复出现的修订模式中提取规则草稿，<b>HR 逐条确认后生效</b>，再注入后续 AI 生成 JD 与筛选建议的提示词。全程审计可查。</p>' +
      '<div class="rec-actions">' +
      '<span class="rec-tag amber">待确认 ' + drafts.length + '</span>' +
      '<span class="rec-tag green">生效中 ' + active.length + '</span>' +
      '<button type="button" class="rec-btn" data-rec-action="skill-extract">从操作证据提取规则草稿</button></div></div>';
    if (!state.skills.length) {
      html += '<div class="rec-empty">还没有偏好规则。演示路径：在「岗位与 JD」用 AI 生成 JD 并人工修订、在「申请看板」对 AI 筛选建议做定夺，再回到本页点「从操作证据提取规则草稿」。</div>';
    }
    // 待确认草稿（HR 逐条确认后才生效）
    if (drafts.length) {
      html += '<div class="rec-card"><h3>待 HR 确认的规则草稿</h3></div>';
      for (const skill of drafts) html += renderSkillCard(skill);
    }
    // 已生效规则单独列出：直接改变后续 AI 提示词
    if (active.length) {
      html += '<div class="rec-card"><h3>已生效规则</h3>' +
        '<p class="rec-muted" style="margin:4px 0 10px"><span class="rec-tag green">已生效——影响后续 AI 筛选建议</span> 以下规则已注入 JD 生成与筛选建议的提示词。</p></div>';
      for (const skill of active) html += renderSkillCard(skill);
    }
    html += '<div class="rec-card"><h3>操作证据（最近 ' + Math.min(20, state.episodes.length) + ' 条）</h3>' +
      '<p class="rec-muted" style="margin:4px 0 10px">AI 提案与 HR 终稿的差异快照，是规则提取的唯一依据。同一模式重复出现才会成为规则草稿。</p></div>';
    if (!state.episodes.length) html += '<div class="rec-empty">暂无操作证据。</div>';
    for (const ep of state.episodes.slice(0, 20)) html += renderEpisodeCard(ep);
    return html;
  }

  // —— 审计 tab ——
  function renderAudit() {
    if (!state.events.length) return '<div class="rec-empty">暂无招聘域事件。</div>';
    let html = '<p class="rec-evt-note">招聘域全部动作的追加式审计（append-only，hash 链防篡改）。AI 动作标「提案」，落库动作均由人工确认。</p>';
    for (const e of state.events) {
      const statusCls = e.status === 'confirmed' ? 'green' : e.status === 'proposed' ? 'blue' : 'red';
      const statusText = e.status === 'confirmed' ? '已确认' : e.status === 'proposed' ? '提案' : e.status;
      html += '<div class="rec-evt"><time>' + esc(fmtTime(e.created_at)) + '</time>' +
        '<div><span class="rec-evt-name">' + esc(CAP_NAMES[e.capability] || e.capability) + '</span> ' +
        '<span class="rec-tag ' + statusCls + '">' + statusText + '</span></div>' +
        '<div class="rec-evt-payload">' + esc((INITIATOR_NAMES[e.initiator] || e.initiator) + ' · ' + JSON.stringify(e.payload)) + '</div></div>';
    }
    return html;
  }

  // ================= 交互 =================

  function formToObject(form) {
    const data = {};
    for (const field of form.querySelectorAll('input[name], select[name], textarea[name]')) {
      data[field.name] = field.type === 'number' ? Number(field.value) : field.value;
    }
    return data;
  }

  function handleClick(event) {
    const button = event.target.closest('[data-rec-action]');
    if (!button || !doc.getElementById('rec-content').contains(button)) return;
    const action = button.dataset.recAction;
    const id = button.dataset.recId;
    if (action === 'tab') { state.tab = button.dataset.recArg; render(); return; }
    if (action === 'job-new') { state.jobFormOpen = !state.jobFormOpen; render(); return; }
    if (action === 'app-toggle') {
      const card = button.closest('[data-rec-app]');
      if (event.target.closest('form, input, select, textarea, button[data-rec-action]:not([data-rec-action="app-toggle"])')) return;
      state.expanded[id] = !state.expanded[id];
      // 展开时刷新该卡（无 fetch，纯本地）
      render();
      return;
    }
    if (action === 'job-ai-jd') return act(button, async () => { await post('/jobs/' + id + '/ai-jd'); });
    if (action === 'job-publish') {
      const form = button.closest('[data-rec-job]').querySelector('[data-rec-form="jd"]');
      const jd = form ? form.querySelector('textarea[name="jd"]').value : '';
      return act(button, async () => {
        if (jd) await post('/jobs/' + id + '/jd', { jd });
        await post('/jobs/' + id + '/publish', {});
      });
    }
    if (action === 'job-close') return act(button, async () => { await post('/jobs/' + id + '/close'); });
    if (action === 'mail-parse') return act(button, async () => {
      const result = await post('/inbox/' + id + '/parse');
      state.parsed[id] = result;
    });
    if (action === 'mail-ignore') return act(button, async () => { await post('/inbox/' + id + '/ignore'); });
    if (action === 'app-ai-screen') return act(button, async () => { await post('/applications/' + id + '/ai-screen'); });
    if (action === 'app-advance') return act(button, async () => { await post('/applications/' + id + '/decide', { action: 'advance' }); });
    if (action === 'app-reject') return act(button, async () => { await post('/applications/' + id + '/decide', { action: 'reject' }); });
    if (action === 'offer-approve') return act(button, async () => { await post('/offers/' + id + '/approve'); });
    if (action === 'offer-accept') return act(button, async () => { await post('/offers/' + id + '/reply', { accept: true }); });
    if (action === 'offer-decline') return act(button, async () => { await post('/offers/' + id + '/reply', { accept: false }); });
    if (action === 'onboard-complete') return act(button, async () => { await post('/onboardings/' + id + '/complete'); });
    // —— Agent 学习：激活/驳回即 HR 确认。走招聘域的 settleSkill：服务端内部
    //    requestConfirmation → resolveConfirmation 原子事务落库，全程审计。
    if (action === 'skill-extract') return act(button, async () => {
      const drafts = await post('/skills/extract').catch(e => {
        throw Error(e.status === 404 ? '提取端点尚未就绪（后端接线中）；规则草稿与证据链仍可查看。' : e.message);
      });
      state.error = '';
      state.notice = '已提取 ' + (Array.isArray(drafts) ? drafts.length : 0) + ' 条规则草稿，请在下方逐条确认。';
    });
    if (action === 'skill-activate' || action === 'skill-dismiss') {
      const skillAction = action === 'skill-activate' ? 'activate' : 'dismiss';
      return act(button, async () => {
        await post('/skills/' + id + '/' + skillAction);
        state.notice = (skillAction === 'activate' ? '已激活' : '已驳回') + '：HR 确认已记录，审计链可查。';
      });
    }
  }

  function handleSubmit(event) {
    const form = event.target.closest('[data-rec-form]');
    if (!form || !doc.getElementById('rec-content').contains(form)) return;
    event.preventDefault();
    const kind = form.dataset.recForm;
    const id = form.dataset.recId;
    const data = formToObject(form);
    const submitButton = form.querySelector('button[type="submit"]');
    if (kind === 'job') {
      act(submitButton, async () => { await post('/jobs', data); state.jobFormOpen = false; state.tab = 'jobs'; });
    } else if (kind === 'convert') {
      const skills = String(data.skills || '').split(/[、,，;；\s]+/).filter(Boolean);
      const candidate = Object.assign({}, data, { skills });
      act(submitButton, async () => {
        await post('/inbox/' + id + '/convert', { job_id: data.job_id, candidate });
        delete state.parsed[id];
        state.tab = 'board';
      });
    } else if (kind === 'interview') {
      act(submitButton, async () => { await post('/applications/' + id + '/interviews', data); });
    } else if (kind === 'evaluate') {
      act(submitButton, async () => { await post('/interviews/' + id + '/evaluate', data); });
    } else if (kind === 'offer') {
      act(submitButton, async () => { await post('/applications/' + id + '/offer', data); });
    }
  }

  // app.js 的路由表是全局词法 const，不是 window.RENDER。
  RENDER.recruitment = async (page) => {
    if (page.signal.aborted || !page.host.isConnected) return;
    const host = page.host;
    host.classList.add('recruitment-page');
    host.innerHTML =
      '<header class="rec-head"><h1>招聘流水线</h1><span class="rec-sub">岗位 → JD → 收简历 → 筛选 → 面试 → Offer → 入职 · AI 提案，人工确认，全程审计</span></header>' +
      '<div class="rec-stats" id="rec-stats"></div>' +
      '<div id="rec-content"></div>';
    if (!host.dataset.recWired) {
      host.addEventListener('click', handleClick);
      host.addEventListener('submit', handleSubmit);
      host.dataset.recWired = '1';
    }
    /* 只在**真首次挂载**时初始化页内状态。重挂载（换页再回来 / AI 对话导航 / 生命周期事件）
       若也重置，会把「AI 已提案、等人确认」的卡片和当前 Tab 凭空清掉 ——
       服务端审计里那条 proposed 事件已经记下，前端却要求人再调一次 AI。 */
    if (!state.mounted) {
      Object.assign(state, { tab: 'jobs', expanded: {}, parsed: {}, jobFormOpen: false, error: '' });
      state.mounted = true;
    }
    render();
    await refreshAll();
  };
})(window);
