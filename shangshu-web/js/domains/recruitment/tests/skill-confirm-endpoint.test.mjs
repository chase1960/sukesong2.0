// 判据：「激活（HR 确认）」「驳回」按钮必须调用招聘域已存在的确认端点。
//
// 现场故障（2026-10-31 用户实测）：点「驳回/激活」无反应。
// 根因：按钮走 POST /api/confirmations —— 该创建端点在 server.ts 不存在（404），
// 而 act() finally 里 refreshAll() 成功后把 state.error 清掉，错误一闪而过 = 视觉无反应。
// 服务端真正可用的是 POST /api/recruitment/skills/:id/activate|dismiss
// （内部走 requestConfirmation → resolveConfirmation 完整确认链 + 审计）。
// 修法：skill-activate/skill-dismiss 与全页其他按钮一致走 post() 直调该端点。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(new URL('../recruitment.js', import.meta.url), 'utf8');

const API = '/api/recruitment';
const SKILL_ID = 'skill-1';
const skill = {
  id: SKILL_ID, rule_type: 'jd_style', pattern: JSON.stringify({ remove_section: '我们提供' }),
  description: 'HR 多次删除「我们提供」段落', evidence_ids: JSON.stringify(['e1', 'e2']),
  status: 'draft', created_at: '', updated_at: '',
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
      // 旧故障根因：全局创建确认卡端点不存在，必须 404。
      if (path === '/api/confirmations') return response({ error: 'Cannot POST /api/confirmations' }, 404);
      if (path === API + '/skills/' + SKILL_ID + '/activate') return response({ ok: true, id: SKILL_ID, status: 'active' });
      if (path === API + '/skills/' + SKILL_ID + '/dismiss') return response({ ok: true, id: SKILL_ID, status: 'dismissed' });
      return response({ ok: true });
    }
    if (path === API + '/overview') return response({ jobs_open: 0, inbox_new: 0, screening: 0 });
    if (path === API + '/jobs') return response([]);
    if (path === API + '/inbox') return response([]);
    if (path === API + '/applications') return response([]);
    if (path === API + '/events') return response([]);
    if (path === API + '/skills') return response([skill]);
    if (path === API + '/episodes') return response([]);
    return response({ error: '判据未建模的路径：' + path }, 404);
  };
  w.eval(source);

  const main = w.document.getElementById('main');
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

async function flushUntil(predicate, label, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('等待超时：' + label);
}

test('「激活」按钮调招聘域激活端点，不打不存在的 /api/confirmations', async () => {
  const h = mount();
  try {
    await h.renderPage();
    h.w.document.querySelector('[data-rec-action="tab"][data-rec-arg="learn"]').click();
    const btn = h.w.document.querySelector('[data-rec-action="skill-activate"]');
    assert.ok(btn, '草稿规则应渲染「激活（HR 确认）」按钮');
    btn.click();
    await flushUntil(() => h.posted.some(p => p.includes('/skills/' + SKILL_ID)), '激活请求发出');
    assert.ok(h.posted.includes(API + '/skills/' + SKILL_ID + '/activate'),
      '应 POST /api/recruitment/skills/' + SKILL_ID + '/activate，实际：' + h.posted.join(', '));
    assert.ok(!h.posted.includes('/api/confirmations'),
      '不得再打全局创建确认卡端点（服务端不存在，404 = 现场无反应根因）');
    assert.ok(!h.w.document.querySelector('.rec-error'), '不应报错：' + (h.w.document.querySelector('.rec-error')?.textContent || ''));
  } finally { h.close(); }
});

test('「驳回」按钮调招聘域驳回端点', async () => {
  const h = mount();
  try {
    await h.renderPage();
    h.w.document.querySelector('[data-rec-action="tab"][data-rec-arg="learn"]').click();
    h.w.document.querySelector('[data-rec-action="skill-dismiss"]').click();
    await flushUntil(() => h.posted.includes(API + '/skills/' + SKILL_ID + '/dismiss'), '驳回请求发出');
    assert.ok(!h.posted.includes('/api/confirmations'), '不得打 /api/confirmations');
  } finally { h.close(); }
});
