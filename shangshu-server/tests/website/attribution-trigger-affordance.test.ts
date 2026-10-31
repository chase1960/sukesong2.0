import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {mountResourceAttribution} from '../../../shangshu-web/js/resource-attribution.mjs';

/*
  FIX-52（用户 2026-10-20 16:04 的反馈：「**还是有啊**」＋ 一张「文件归属：本人 ▼」的截图，
  随后补「**他甚至都不是弹窗啊**」）：

  根因当时是：触发按钮用 CSS 三角形冒充原生 <select> 的箭头 ⇒ 用户看不出来这是个
  「能点开选择的入口」。

  PKG-016（用户 2026-10-21：「**不要用重叠弹窗，直接摊出来**」）之后，
  那个触发按钮**整个不存在了** —— 归属的两张选项卡就是界面本身。
  ⇒ 原来那套「怎么让用户看出这能选」的问题，换了个问法：
     **选中态必须看得见**（真实文本，不是 CSS 画的图形），
     而且**不许再有 CSS 三角形冒充原生下拉箭头**。

  测试通过 = 下面全部成立：
  1. 当前选中的那一档**看得见**（aria-selected + 真实文本），
     提示必须是**真实文本**（能被读屏软件读到、能被复制），
     **不是 CSS 画出来的图形**（CSS 伪元素的内容不在 textContent 里）；
  2. CSS 里**不再有**那个「点开才展开的入口」类（连带 border-top 拼出来的三角一并没了）；
  3. 宿主里**没有原生 `<select>`**；
  4. 挂上组件**不弹窗** —— 归属就是摊在宿主里的两张选项卡。
*/

const ROOT = new URL('../../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');

function boot(html = '<div id="host"></div>') {
  const dom = new JSDOM(html, {url: 'http://localhost/', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.eval(read('shangshu-web/js/tool-workspace.js'));
  return {dom, w, host: w.document.querySelector('#host')};
}

function mountIn(t: ReturnType<typeof boot>, options: any = {}) {
  const ui = t.w.createToolWorkspace(t.host);
  const picker = mountResourceAttribution(t.host, {ui, ...options});
  return {ui, picker};
}

it('当前选中的那一档看得见，而且提示是真实文本（不是 CSS 画出来的图形）', () => {
  const t = boot();
  try {
    mountIn(t, {defaultLevel: 'personal'});
    const tabs = [...t.host.querySelectorAll('[data-attribution-tab]')] as any[];
    assert.equal(tabs.length, 2, `应当有两张选项卡，实际 ${tabs.length} 张`);
    const selected = tabs.filter(tab => tab.getAttribute('aria-selected') === 'true');
    assert.equal(selected.length, 1, '没有且仅有一个选中档');
    assert.match(selected[0].textContent || '', /本人/, `选中档不是「本人」，实际「${selected[0].textContent}」`);

    // 选中态除了 aria-selected，还得**看得见**：真实文本（CSS 伪元素的内容不在 textContent 里）。
    const visible = String(selected[0].textContent || '');
    assert.ok(visible.includes('本人'), `选中档上应当看得见「本人」，实际「${visible}」`);
    assert.ok(
      /本人|获权部门|个人|部门/.test(visible),
      `选中档上只有空壳，实际「${visible.trim()}」—— 用户看不出当前选的是哪一档。`,
    );

    // 换档之后，选中态要跟着换（不是画死的）。
    const other = tabs.find(tab => tab.getAttribute('aria-selected') !== 'true')!;
    other.click();
    const after = [...t.host.querySelectorAll('[data-attribution-tab]')] as any[];
    assert.equal(after.filter(tab => tab.getAttribute('aria-selected') === 'true').length, 1,
      '换档之后选中档不唯一');
    assert.equal(after.find(tab => tab.getAttribute('aria-selected') === 'true')!.textContent,
      other.textContent, '换档之后选中态没跟着换');
  } finally { t.dom.window.close(); }
});

it('CSS 里不再有那个「点开才展开的入口」类（连带 CSS 三角形一并没了）', () => {
  const css = read('shangshu-web/css/workbench.css');
  assert.doesNotMatch(css, /\.attribution-picker-trigger/,
    '`.attribution-picker-trigger` 这个类（点开才展开的入口）应当整个删掉 —— '
    + '摊开式之后那行按钮已经不存在了，留着就是半截壳。');
  assert.doesNotMatch(css, /\.attribution-picker-trigger::after/,
    '`.attribution-picker-trigger::after`（画三角用的）应当删掉。');
  /* 就算哪天又出现这个类，也不许用 border-top 拼实心三角冒充原生 <select> 箭头。 */
  const blocks = css.split('}').filter(block => block.includes('.attribution-picker-trigger'));
  const joined = blocks.join('}');
  assert.equal(
    /border-top\s*:\s*\d+px\s+solid\s+transparent/.test(joined),
    false,
    '`.attribution-picker-trigger` 还在用 border-top 拼实心三角 —— '
    + '那和原生 <select> 的箭头一模一样，用户看不出这是个能点开选择的入口。',
  );
});

it('宿主里没有原生 <select>，挂上组件也不弹窗（归属就摊在宿主里）', () => {
  const t = boot('<div id="host"></div><dialog class="os-dialog" open></dialog>');
  try {
    mountIn(t, {defaultLevel: 'personal'});
    assert.equal(t.host.querySelectorAll('select').length, 0, '宿主里不该再有原生 <select>');
    assert.equal(t.host.querySelectorAll('[data-attribution-trigger]').length, 0,
      '不该再有「点开才展开」的触发按钮');
    assert.equal(t.w.document.querySelectorAll('dialog.os-dialog').length, 1,
      '挂上组件就自己弹了一扇窗（那还是叠窗）');
  } finally { t.dom.window.close(); }
});
