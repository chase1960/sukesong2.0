import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const web = new URL('../../../shangshu-web/', import.meta.url);
const index = readFileSync(new URL('index.html', web), 'utf8');
const css = [...index.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"?]+)(?:\?[^\"]*)?"/g)]
  .map(match => readFileSync(new URL(match[1], web), 'utf8')).join('\n');
const fixture = `<aside class="side" id="side"></aside><main class="main">
  <div class="fld"><input id="text" type="text"><input id="email" type="email"><input id="date" type="date">
    <input id="number" type="number"><input id="password" type="password"><select id="select"><option>选项</option></select><textarea id="textarea"></textarea>
    <input id="disabled" disabled><input id="readonly" readonly><select id="disabled-select" disabled></select><textarea id="readonly-text" readonly></textarea></div>
  <fieldset disabled><input id="fieldset-disabled"></fieldset>
  <div class="objects-page"><div class="dataset-filters"><input id="filter" type="text"><select id="filter-select"></select></div></div>
  <div class="schema-fields"><div class="fld"><input id="schema"><textarea id="schema-text"></textarea></div></div>
  <div class="im-input-box"><input id="im"></div><div class="post-reply-box"><input id="reply"></div>
  <div class="file-center-page"><div class="file-search" id="file-search"><input id="file-query"></div><div class="cr-after"><input id="review-after"></div></div>
  <div class="mail-center-page"><div class="mail-search" id="mail-search"><input id="mail-query"></div><p id="error" class="mail-field-status is-error">错误</p></div>
  <div class="sheet-center-page"><div class="sheet-filterbar"><div class="sheet-search" id="sheet-search"><input></div></div><input id="cell" class="cell-input"><table class="sheet-table"><thead><tr><th id="frozen-head"><button class="col-sort" id="long-header">较长表头不会越过列边界</button><span class="col-type">文本</span></th><th id="scroll-head">滑动列</th></tr></thead><tbody><tr><td id="frozen-cell">冻结案号</td><td>滑动内容</td></tr></tbody></table></div>
  <div class="wf-builder"><div class="fe-row"><input id="flow-input"><select id="flow-select"></select><textarea id="flow-text"></textarea></div></div>
  <input id="checkbox" type="checkbox"><input id="radio" type="radio"><input id="range" type="range">
</main><div class="file-operation-dialog"><input id="file-operation"><select id="file-operation-select"></select><input id="file-operation-disabled" disabled></div>
<div class="file-review-dialog"><input id="review-input"><textarea id="review-text"></textarea><div class="file-property"><input id="review-readonly" data-review-field readonly></div></div>
<div class="file-property"><select id="file-property-select"></select></div>`;

function styles() {
  const raw = new JSDOM(`<style>${css}</style>${fixture}`, { pretendToBeVisual: true });
  const names = [...new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]))];
  const cache = new Map<string, JSDOM>();
  // jsdom 尚不求值 var()。仅展开生产变量，选择器、顺序和普通样式仍由真实 CSS 级联计算。
  // 从被测元素向上读取局部变量，保留 disabled/readonly 对 control-bg 的覆盖。
  function computed(id: string) {
    const values = new Map<string, string>();
    for (let node = raw.window.document.getElementById(id); node; node = node.parentElement) {
      const style = raw.window.getComputedStyle(node);
      for (const name of names) if (!values.has(name) && style.getPropertyValue(name).trim()) values.set(name, style.getPropertyValue(name).trim());
    }
    const expand = (text: string) => {
      for (let n = 0; n < 8; n++) {
        const next = text.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (full, name, fallback) => values.get(name) || fallback || full);
        if (next === text) break;
        text = next;
      }
      return text;
    };
    const resolved = expand(css);
    let dom = cache.get(resolved);
    if (!dom) { dom = new JSDOM(`<style>${resolved}</style>${fixture}`, { pretendToBeVisual: true }); cache.set(resolved, dom); }
    return dom.window.getComputedStyle(dom.window.document.getElementById(id)!);
  }
  return { computed, close() { raw.window.close(); for (const dom of cache.values()) dom.window.close(); } };
}

test('公共表单与业务高特异性控件在生产CSS级联后统一白底', () => {
  const view = styles();
  try {
    const ids = ['text','email','date','number','password','select','textarea','filter','filter-select',
      'schema','schema-text','im','reply','file-search','mail-search','sheet-search','cell','flow-input','flow-select','flow-text',
      'file-operation','file-operation-select','review-input','review-text','file-property-select','review-after'];
    const incorrect = ids.map(id => [id, view.computed(id).backgroundColor]).filter(([, color]) => color !== 'rgb(255, 255, 255)');
    assert.deepEqual(incorrect, [], '可编辑控件或复合搜索容器不能残留灰底');
  } finally { view.close(); }
});
test('复合搜索框只有外层描边，内部输入不再出现第二圈边框',()=>{
  const view=styles();try{for(const id of ['file-query','mail-query']){assert.equal(view.computed(id).borderTopWidth,'0px',id);assert.equal(view.computed(id).boxShadow,'none',id);}}finally{view.close();}
});
test('冻结表头用不透明底层遮住横滚文字，长标题限制在本列',()=>{
  const view=styles();try{
    for(const id of ['frozen-head','scroll-head','frozen-cell'])assert.equal(view.computed(id).backgroundColor,'rgb(255, 255, 255)',id+' 不能透出下层列');
    // jsdom 不绘制渐变；检查生产声明，最终遮挡效果另用真实浏览器横滚验收。
    assert.match(css,/thead th:first-child\{[^}]*background-image:linear-gradient\(var\(--bg-alt\),var\(--bg-alt\)\)/);
    assert.equal(view.computed('long-header').maxWidth,'100%');assert.equal(view.computed('long-header').overflow,'hidden');
    assert.equal(view.computed('long-header').textOverflow,'ellipsis');
  }finally{view.close();}
});

test('禁用和只读保留非编辑态，错误提示不被表单白底规则覆盖', () => {
  const view = styles();
  try {
    for (const id of ['disabled','readonly','disabled-select','readonly-text','fieldset-disabled','file-operation-disabled']) assert.equal(view.computed(id).backgroundColor, 'rgba(0, 0, 0, 0.04)', id);
    assert.equal(view.computed('review-readonly').backgroundColor, 'rgba(0, 0, 0, 0)', '审核只读详情维持透明呈现');
    assert.equal(view.computed('error').color, 'rgb(220, 68, 68)');
  } finally { view.close(); }
});

test('复选框单选框滑块不变成文本框，侧栏画布仍保留中性灰', () => {
  const view = styles();
  try {
    for (const id of ['checkbox','radio','range']) {
      assert.notEqual(view.computed(id).height, '32px', `${id} 不应获得文本框高度`);
      assert.notEqual(view.computed(id).padding, '0px 10px', `${id} 不应获得文本框内边距`);
    }
    assert.equal(view.computed('side').backgroundColor, 'rgb(232, 234, 235)');
  } finally { view.close(); }
});
