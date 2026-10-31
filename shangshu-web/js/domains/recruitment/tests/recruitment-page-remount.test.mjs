// 判据：招聘页**重挂载**不得清掉在途的 AI 提案。
//
// 现场故障（2026-10-31 Chrome + CDP 实测）：收件箱里点「AI 解析简历」→ 提案确认卡出现；
// 换页（go('dash')）再回来（go('recruitment')）→ 页面重挂载 ⇒ 提案卡消失、Tab 跳回「岗位与 JD」。
// 根因：RENDER.recruitment 每次挂载都无条件重置 tab/parsed。而服务端审计里这次 AI 解析
// 已经记过一条 proposed 事件 —— 前端却把提案「凭空丢了」，用户只能再调一次 AI。
// 修法：只在**真首次挂载**时初始化页内状态；重挂载保留 Tab 与在途提案。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(new URL('../recruitment.js', import.meta.url), 'utf8');

const API = '/api/recruitment';
const MAIL_ID = 'mail-1';
const mail = {
  id: MAIL_ID, mail_from: '陈默涵 <chen@example.com>', subject: '应聘高级后端工程师',
  received_at: '2026-10-30T02:00:00Z', resume_text: '陈默涵，Node.js / TypeScript，3 年经验',
  status: 'new', application_id: '',
};
const job = {
  id: 'job-1', code: 'JOB-2026-001', title: '高级后端工程师', department: '平台研发部',
  headcount: 1, requirements: '', highlights: '', status: 'open',
  jd_draft: '', jd_published: '岗位职责……', source: 'demo', created_at: '', updated_at: '',
};
const proposal = {
  candidate: {
    name: '陈默涵', email: 'chen@example.com', phone: '13900002222',
    education: '本科，计算机科学与技术', experience_years: 3,
    skills: ['Node.js', 'TypeScript'], summary: '后端工程师，电商与 SaaS 经验',
  },
  fallback: false,
  open_jobs: [{ id: 'job-1', code: 'JOB-2026-001', title: '高级后端工程师' }],
};

const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function mount() {
  const dom = new JSDOM('<main id="main"></main>', {
    url: 'http://localhost:3000/#/recruitment', runScripts: 'outside-only',
  });
  const w = dom.window;
  const posted = [];
  w.RENDER = {};
  w.shangshuRegisterPages = () => {};
  w.shangshuRegisterNav = () => {};
  w.fetch = async (path, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    if (method === 'POST') {
      posted.push(String(path));
      if (path === API + '/inbox/' + MAIL_ID + '/parse') return response(proposal);
      return response({ ok: true });
    }
    if (path === API + '/overview') {
      return response({ jobs_open: 1, inbox_new: 1, screening: 1, interview: 0, offer: 0, onboarding: 0, hired: 0 });
    }
    if (path === API + '/jobs') return response([job]);
    if (path === API + '/inbox') return response([mail]);
    if (path === API + '/applications') return response([]);
    if (path === API + '/events') return response([]);
    return response({ error: '判据未建模的路径：' + path }, 404);
  };
  w.eval(source);

  const main = w.document.getElementById('main');
  // 照 app.js 的 beginPageRender：旧 host 整个换掉，信号是新的 —— 这就是「重挂载」。
  const renderPage = async () => {
    main.replaceChildren();
    const host = w.document.createElement('div');
    host.className = 'main-scroll';
    main.appendChild(host);
    const page = { mod: 'recruitment', host, signal: new AbortController().signal, isActive: () => true };
    await w.RENDER.recruitment(page);
    return page;
  };
  return { w, posted, renderPage, close: () => w.close() };
}

/** 等异步 act() 链（POST → render → refreshAll）落定。 */
async function flushUntil(predicate, label, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('等待超时：' + label);
}

test('首次挂载进入岗位页（基线）', async () => {
  const h = mount();
  try {
    await h.renderPage();
    assert.equal(h.w.document.querySelector('.rec-tab.active')?.dataset.recArg, 'jobs');
    assert.ok(h.w.document.querySelector('[data-rec-job="job-1"]'), '已发布岗位卡应渲染');
    assert.equal(h.posted.length, 0);
  } finally { h.close(); }
});

test('重挂载不清掉在途 AI 提案与当前 Tab', async () => {
  const h = mount();
  try {
    await h.renderPage();

    // 进收件箱 → AI 解析 → 提案确认卡
    h.w.document.querySelector('[data-rec-action="tab"][data-rec-arg="inbox"]').click();
    assert.ok(h.w.document.querySelector('[data-rec-action="mail-parse"]'), '收件箱应列出待处理邮件');
    h.w.document.querySelector('[data-rec-action="mail-parse"]').click();
    await flushUntil(() => h.w.document.querySelector('[data-rec-form="convert"]'), 'AI 解析提案卡');
    const parseCalls = () => h.posted.filter(path => path === API + '/inbox/' + MAIL_ID + '/parse').length;
    assert.equal(parseCalls(), 1);

    // 换页再回来 = 重挂载：提案与 Tab 都应保留，且不得重复调 AI
    await h.renderPage();
    assert.ok(h.w.document.querySelector('[data-rec-form="convert"]'), '重挂载后 AI 提案卡应保留');
    assert.equal(h.w.document.querySelector('.rec-tab.active')?.dataset.recArg, 'inbox', '重挂载后应停在离开时的收件箱');
    assert.equal(parseCalls(), 1, '重挂载不得重复调用 AI 解析');
  } finally { h.close(); }
});
