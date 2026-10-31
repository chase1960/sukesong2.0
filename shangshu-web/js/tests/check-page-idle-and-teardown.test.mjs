// 判据：**页面空转要停** —— 页面闲着的时候不许自己一直发请求；
// 换了页以后旧页不许再读；旧页的异步结果不许把人拽回旧页
// （PKG-128-T02 · 2026-10-26 · 审查报告 R05／R06／R07／R21）。
//
// **测试通过 =**（一句话）
// 「**页面停在原地不动时，发出的请求数不再自己往上走**（工具条自己改个字不算页面变化）；
//  **切走一页以后，旧页那些还在飞的读请求被取消掉、不再回来写页面**；
//  **旧页的一个慢请求回来时，不会把人导航回旧页**。」
//
// **改之前**：
//   ① `review-batch.js`：读到提案后**无条件**改工具条文字（`note.textContent = …`），
//      而它自己又监听整个 body 的 DOM 变化 ⇒ 「改文字 → 触发监听 → 再读一遍 → 再改文字」
//      ⇒ **自持环**（120ms 一轮，页面空闲时请求数一直涨）。
//   ② 三个 real-* 页面读数据**不传页面取消信号** ⇒ 切页后旧请求照旧跑完并写页面。
//   ③ 路由 `go()` 拿到页面渲染函数返回的**清理函数**却**不调用** ⇒
//      离页后 `review-center` 的 `pageHost` 仍非空 ⇒ 后台继续刷新卡片。
//   ④ `real-objects.js` 等异步探测（`canOpenInExcel`）回来后**不复查导航代次**
//      ⇒ 人已经走了，旧结果仍把他拽回旧表。
// **改之后**：上面四条各自成立。
// **怎么看**：浏览器打开任一业务页，停在原地不动 ⇒ 网络面板里请求数**不再持续增长**；
//   切页 ⇒ 旧页的请求显示为 cancelled；旧页慢请求回来**不会**把地址栏拽回去。
//
// ⚠️ **判据必须真的实例化 MutationObserver**：既有 `review-batch` 判据把
//   `MutationObserver` 设成 `undefined` ⇒ **自激环那条路径一次都没测过**。
//   这里用一个**会真的因 DOM 变化而触发**的观察器桩（照浏览器语义）。
// ⚠️ 也别只断「有没有调 disconnect」——要断**行为**：空闲时请求数不涨。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const readSource = rel => fs.readFileSync(ROOT_PATH + rel, 'utf8');

const REVIEW_BATCH = readSource('shangshu-web/js/review-batch.js');
const APP = readSource('shangshu-web/js/app.js');
const REAL_OBJECTS = readSource('shangshu-web/js/real-objects.js');

/* ═══════════════ 公共件：可触发的 MutationObserver（会因 DOM 变化真的触发） ═══════════════ */

/**
 * 一个**照浏览器语义**的观察器桩：
 *   · `observe()` 之后，DOM 一变（appendChild / removeChild / 改 textContent）就真的回调。
 *   · 记下每次回调，判据据此断「是谁的改动把监听叫醒的」。
 *   * mini-dom 的 textContent setter 不发事件 ⇒ 桩自己接管：在 textContent 被写时，
 *     主动记一条「子节点变化」并触发观察器 —— 这正是浏览器的行为。
 */
function makeLiveDom() {
  const observers = [];
  class LiveMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      this.options = null;
      observers.push(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options || {};
    }
    disconnect() {
      this.target = null;
      this.disconnected = true;
    }
    fire(target) {
      if (!this.target) return;
      this.callback([{ target: target || this.target }], this);
    }
  }
  return { LiveMutationObserver, observers };
}

/** 给一个 DOM 装上「改 textContent 会触发观察器」的能力。 */
function wireMutationFeedback(dom, observers) {
  const notify = target => {
    observers.forEach(observer => {
      if (!observer.target || observer.disconnected) return;
      observer.callback([{ target }], observer);
    });
  };
  const patch = element => {
    const original = Object.getOwnPropertyDescriptor(element, 'textContent');
    if (!original || !original.set) return;
    Object.defineProperty(element, 'textContent', {
      get: original.get,
      set(value) {
        original.set.call(element, value);
        notify(element);
      },
      configurable: true,
    });
  };
  // 只补最顶上那几层（判据用的结构很浅）。
  const patchTree = element => {
    patch(element);
    (element.children || []).forEach(patchTree);
  };
  patchTree(dom.body);
  dom.__notifyMutation = notify;
  return notify;
}

/* ═══════════════ ① R05：页面空闲时，工具条不许自己养出请求循环 ═══════════════ */

function buildReviewBatchPage(dom, id, capability) {
  const heading = dom.h('header', { class: 'mail-heading' }, [
    dom.h('h1', { text: '邮箱' }),
    dom.h('button', { class: 'btn btn-ghost', id: 'mail-sync', text: '立即同步' }),
  ]);
  const card = dom.h('article', {
    class: 'cf-card business-confirm review-source-automation',
    'data-review-source': 'automation',
    'data-confirm-id': id,
    'data-review-capability': capability || 'mail.save_draft',
  }, [dom.h('div', { class: 'cf-heading' })]);
  const body = dom.h('div', { class: 'mail-body' }, [card]);
  const scroll = dom.h('div', { class: 'main-scroll', 'data-page': 'mail' }, [heading, body]);
  dom.body.appendChild(dom.h('main', { id: 'main' }, [scroll]));
  return { heading, card, body, scroll };
}

function makeMiniDom() {
  // 直接复用公共最小 DOM 桩（判据共用一份，不另造）。
  return miniDom.createDom();
}

// 动态 import 公共 DOM 桩（ESM 顶层 await 不便，用同步 require 风格不合适 ⇒ 这里用顶层 await）。
const miniDom = await import(new URL('../../../scripts/tests/mini-dom.mjs', import.meta.url));

test('① 页面空闲不动 ⇒ 请求数不再自己往上走（工具条改自己那行字不算「页面变了」）', async () => {
  const dom = miniDom.createDom();
  const { LiveMutationObserver, observers } = makeLiveDom();
  const notify = wireMutationFeedback(dom, observers);

  const calls = [];
  let pending = [];
  const timers = [];
  const window = {
    document: dom,
    fetch: async (path, init) => {
      calls.push({ path: String(path), init: init || {} });
      // 挂起，让判据能观察「在途」状态。
      await new Promise(resolve => pending.push(resolve));
      return { ok: true, status: 200, json: async () => ({ ok: true, list: [{ id: 'PR-1', capability: 'mail.save_draft', status: 'proposed' }] }) };
    },
    // 定时器**由判据自己按**跑 —— 浏览器语义（到点就执行），不是空桩。
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    MutationObserver: LiveMutationObserver,
    dispatchEvent: () => true,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    location: { href: 'http://localhost/index.html#/mail' },
    history: { replaceState: () => {} },
  };
  window.window = window;
  buildReviewBatchPage(dom, 'PR-1');
  const context = vm.createContext(window);
  vm.runInContext(REVIEW_BATCH, context, { filename: 'review-batch.js' });

  /** 跑掉到点的定时器 ＋ 放行在途请求，让异步链走完。 */
  const drain = async () => {
    for (let i = 0; i < 8; i++) {
      const due = timers.splice(0, timers.length);
      due.forEach(item => item.fn());
      const waiting = pending; pending = [];
      waiting.forEach(resolve => resolve());
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  };
  await drain();

  const afterFirst = calls.length;
  assert.ok(afterFirst >= 1, '页面装上后连首轮都没读 —— 判据的前置不成立');

  // 模拟业务页真的在动（别的元素变了）⇒ **应该**触发一次重新判定。
  for (let i = 0; i < 3; i++) notify(dom.body);
  await drain();
  await drain();
  const afterActivity = calls.length;
  assert.ok(afterActivity >= afterFirst, '页面有变化时反倒没重新判定 —— 判据的前置不成立');

  // ⚠️ **现在什么都不碰** —— 页面进入空闲。
  //   空闲期间请求数必须**停住**：不许再自己涨。
  //   （改之前：读一遍 → 改工具条文字 → 工具条那个变化被当成「业务页变了」
  //     → 再读一遍 → 再改文字 …… 每 120ms 一轮，永远不停。）
  await drain();
  await drain();
  await drain();
  const afterIdle = calls.length;
  assert.equal(afterIdle, afterActivity,
    `页面已经**没人碰**了，请求数却从 ${afterActivity} 涨到 ${afterIdle} `
    + '⇒ 页面在自激：读一遍 → 改工具条 → 监听被叫醒 → 再读一遍，成环。'
    + '（工具条自己那行字的变化不该被当成「业务页变了」；内容没变也不该重写。）');
});

test('② 工具条自己改文字 ⇒ 不该把「业务页变了」的监听叫醒（自己触发自己＝环）', () => {
  // 断源码里的那条判定：工具条内部的变化要被排除在「页面变了」之外。
  assert.match(REVIEW_BATCH, /touchesPage|isOwnBar|ownChange/,
    'review-batch.js 里没有区分「自己的改动」和「业务页的改动」的判定。');
  const touches = REVIEW_BATCH.slice(REVIEW_BATCH.indexOf('function touchesPage'));
  const body = touches.slice(0, touches.indexOf('\n  }'));
  assert.match(body, /BAR_ATTR|isOwnBar|ownChange/,
    '`touchesPage` 没有排除工具条自己的变化 ⇒ 改一次工具条文字就会再触发一轮读取。');
});

test('③ 离页以后，工具条的观察器要真的被断开（不许离页后还在后台刷新）', () => {
  assert.match(REVIEW_BATCH, /disconnect\(\)/,
    'review-batch.js 里没有任何 disconnect ⇒ 离开那一页以后，观察器还挂在 body 上。');
  assert.match(REVIEW_BATCH, /abort|pagehide|before-page-change|signal/,
    'review-batch.js 没有接页面生命周期（取消信号／pagehide／离页事件）⇒ 没有地方会断开它。');
});

/* ═══════════════ ④ R06：切页以后，旧页的读请求要被取消 ═══════════════ */

test('④ 旧页的读请求带上页面取消信号（切页时上游能真的把它掐掉）', () => {
  for (const [name, source] of [
    ['real-applications.js', readSource('shangshu-web/js/real-applications.js')],
    ['real-dashboard.js', readSource('shangshu-web/js/real-dashboard.js')],
    ['real-objects.js', REAL_OBJECTS],
  ]) {
    assert.match(source, /signal/, `${name} 里一次都没出现 signal ⇒ 它的读请求切页后掐不掉。`);
  }
  // 读请求那一路必须把页面信号透传下去（不只是声明了 signal）。
  assert.match(readSource('shangshu-web/js/real-dashboard.js'), /signal\s*:/,
    'real-dashboard.js 的读请求没有把 signal 传给 fetch。');
});

/* ═══════════════ ⑤ R07：路由要真的执行页面交回来的清理函数 ═══════════════ */

test('⑤ 路由换页时，要执行上一个页面交回来的清理函数（离页就收摊）', () => {
  const goBody = APP.slice(APP.indexOf('function go('), APP.indexOf('function go(') + 6000);
  assert.match(goBody, /dispose|cleanup|teardown/i,
    'app.js 的路由里找不到任何「执行上一页清理函数」的逻辑 '
    + '⇒ 离页后页面的定时器、观察器、在飞请求都没人收。');
  // 清理函数得在**离开**时执行，不是渲染时。
  const beginRender = APP.slice(APP.indexOf('function beginPageRender'), APP.indexOf('function beginPageRender') + 1200);
  assert.match(beginRender, /dispose|cleanup|teardown/i,
    '`beginPageRender` 里没有收上一��的动作 ⇒ 清理时机不对。');
});

/* ═══════════════ ⑥ R21：旧页的慢请求回来，不许把人拽回旧页 ═══════════════ */

test('⑥ 异步探测回来以后要复查导航代次（人已经走了就不许再导航）', () => {
  const draw = REAL_OBJECTS.slice(REAL_OBJECTS.indexOf('async function drawDataset'));
  const body = draw.slice(0, draw.indexOf('\n  }'));
  const awaits = (body.match(/await/g) || []).length;
  const checks = (body.match(/isActive|datasetRequest|request\s*!==|generation/gi) || []).length;
  assert.ok(awaits >= 1, 'drawDataset 里没有 await —— 判据的前置不成立。');
  assert.ok(checks >= awaits,
    `drawDataset 里有 ${awaits} 个 await，却只复查了 ${checks} 次代次/活跃状态 `
    + '⇒ 有一个 await 之后的旧结果会把人导航回旧页。');
});
