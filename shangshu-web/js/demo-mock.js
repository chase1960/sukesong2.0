/* 静态演示的接口垫片：拦截 /api/**，用快照数据回放，保证零后端也能点得通。
 * 只用于 demo.html，不参与真实运行。 */
(function () {
  'use strict';
  var API = window.__DEMO_API__ || {};
  var META = window.__DEMO_META__ || {};

  if (!location.hash) history.replaceState(null, '', '#/hr');

  function json(body, status) {
    return Promise.resolve(new Response(JSON.stringify(body == null ? {} : body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }));
  }

  function demoAnswer(question) {
    var q = String(question || '');
    if (/绩效|工资|薪|评级|离职|跳槽/.test(q)) {
      return {
        employee: { name: '张伟' }, refused: true, refused_reason: '薪酬与绩效评级属于敏感主题，分身不回答',
        citations: [], confidence: 0, answer: '',
      };
    }
    if (/实习|带过几个/.test(q)) {
      return {
        employee: { name: '王芳' }, insufficient: true, citations: [], confidence: 0,
        answer: '现有事实里没有这条记录，已转给本人确认。',
      };
    }
    return {
      employee: { name: '张伟' }, refused: false, insufficient: false, confidence: 82,
      answer: '张伟在 2025 年参与过订单服务的稳定性治理：负责灰度分批与回滚预案，故障恢复时间从 42 分钟降到 11 分钟。这条结论来自项目复盘与主管核实的事实记录。',
      citations: [
        { title: '订单服务稳定性治理复盘（2025-08）' },
        { title: '季度代码评审记录（2025-09）' },
      ],
    };
  }

  function demoPost(path, body) {
    if (/\/twins\/[^/]+\/ask$/.test(path)) return demoAnswer((body || {}).question);
    if (/\/knowledge\/capture$/.test(path)) return { created: 2 };
    if (/\/knowledge\/[^/]+\/publish$/.test(path)) return { published: true, version: 2 };
    if (/\/learning\/plans$/.test(path)) return { summary: '已生成 90 天培养计划（演示）' };
    if (/\/recruiting\/sync$/.test(path)) return { ok: true, applications_seen: 29, truncated: false };
    if (/\/recommendations\/generate$/.test(path)) return { created: 1 };
    if (/\/measure$/.test(path)) return { delta_rate: '-3.2', verdict: '达标' };
    return { ok: true, demo: true };
  }

  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var path;
    try { path = new URL(url, location.href).pathname; } catch (e) { path = url; }
    var apiAt = path.indexOf('/api/');
    if (apiAt > 0) path = path.slice(apiAt);
    if (path.indexOf('/api/') !== 0) {
      return realFetch ? realFetch(input, init) : Promise.reject(new Error('no fetch'));
    }
    var key = method + ' ' + path;
    if (method === 'GET') {
      if (Object.prototype.hasOwnProperty.call(API, key)) return json(API[key]);
      if (/\/api\/session$/.test(path)) {
        return json({ authed: true, user: { username: 'demo', role: 'admin', display_name: '演示管理员' } });
      }
      return json({});
    }
    var payload = {};
    try { payload = init && init.body ? JSON.parse(init.body) : {}; } catch (e) { payload = {}; }
    return json(demoPost(path, payload));
  };

  window.__DEMO__ = META;
})();

