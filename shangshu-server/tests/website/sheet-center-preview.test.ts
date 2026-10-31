import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast, toastText} from '../helpers/toast.ts';

it('表格弹层打开时 AI 浮钮不遮挡确认操作',()=>{
  const css=readFileSync(new URL('../../../shangshu-web/css/sheet-center.css',import.meta.url),'utf8');
  assert.match(css,/body:has\(\.sheet-center-page \.sheet-overlay\)>\.ai-fab\{visibility:hidden\}/);
});

/* 表格工作面建设页：显式编辑模式 + 脏格 + 撤销重做 + 行回收站，不访问业务接口、不假写入。 */
function mount() {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost/index.html#/sheets', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.fetch = () => { throw new Error('建设页不得访问业务接口'); };
  w.RENDER = {}; w.currentRole = () => 'admin';
  installToast(w);
  w.eval(readFileSync(new URL('../../../shangshu-web/js/tool-workspace.js', import.meta.url), 'utf8'));
  w.eval(readFileSync(new URL('../../../shangshu-web/js/sheet-center.js', import.meta.url), 'utf8'));
  const controller = new w.AbortController();
  w.mountSheetCenter(w.document.querySelector('#host'), {signal: controller.signal});
  return {dom, w, controller};
}

it('默认空态禁用新增与编辑；样例开启后出现记录与列类型标识', () => {
  const {dom, w, controller} = mount();
  try {
    assert.equal(w.document.querySelectorAll('tr[data-row]').length, 0);
    assert.equal(w.document.querySelector('#add-row').disabled, true);
    assert.equal(w.document.querySelector('#edit-mode').disabled, true);
    w.document.querySelector('#examples-toggle').click();
    assert.equal(w.document.querySelectorAll('tr[data-row]').length, 12);
    const head = w.document.querySelector('#sheet-head').textContent;
    assert.match(head, /案号/); assert.match(head, /多值/); assert.match(head, /日期/); assert.match(head, /选项/);
    // 浏览模式单击打开详情
    w.document.querySelector('[data-open]').click();
    assert.equal(w.document.querySelector('#row-detail').hidden, false);
    assert.match(w.document.querySelector('#row-detail').textContent, /挡雨板连接结构/);
  } finally { controller.abort(); dom.window.close(); }
});

it('对齐最新 3in：双击直接编格，改值出脏格与保存操作条', () => {
  const {dom, w, controller} = mount();
  try {
    w.document.querySelector('#examples-toggle').click();
    const firstCell = w.document.querySelector('tr[data-row] td[data-field="note"]');
    firstCell.dispatchEvent(new w.MouseEvent('dblclick', {bubbles: true}));
    assert.ok(w.document.querySelector('.cell-input'), '双击直接编辑');
    assert.equal(w.document.querySelector('#edit-mode').getAttribute('aria-pressed'), 'true');
    const input = w.document.querySelector('.cell-input');
    assert.ok(input, '编辑模式双击应出现输入框');
    input.value = '第一次审查意见答复中（改）';
    input.dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    assert.match(w.document.querySelector('#edit-summary').textContent, /有 1 处未保存修改/);
    const dirtyCell = w.document.querySelector('tr[data-row] td[data-field="note"] .cell-text');
    assert.match(dirtyCell.getAttribute('title'), /未保存：/);
    assert.equal(w.document.querySelector('#save-edits').disabled, false);
  } finally { controller.abort(); dom.window.close(); }
});

it('撤销/重做按格子时间线：撤销回基线清脏格，重做恢复', () => {
  const {dom, w, controller} = mount();
  try {
    w.document.querySelector('#examples-toggle').click();
    w.document.querySelector('#edit-mode').click();
    const cell = w.document.querySelector('tr[data-row] td[data-field="title"]');
    cell.dispatchEvent(new w.MouseEvent('dblclick', {bubbles: true}));
    const input = w.document.querySelector('.cell-input');
    input.value = '挡雨板连接结构（修改稿）';
    input.dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    assert.equal(w.document.querySelectorAll('[data-row] .is-dirty').length, 1);
    w.document.querySelector('#undo').click();
    assert.equal(w.document.querySelectorAll('[data-row] .is-dirty').length, 0, '撤销回基线等于无修改');
    assert.match(w.document.querySelector('#edit-summary').textContent, /尚未修改字段/);
    w.document.querySelector('#redo').click();
    assert.equal(w.document.querySelectorAll('[data-row] .is-dirty').length, 1, '重做恢复编辑值');
    assert.match(w.document.querySelector('tr[data-row] td[data-field="title"]').textContent, /修改稿/);
  } finally { controller.abort(); dom.window.close(); }
});

it('保存不假写入：必填案号校验拦空值，确认后明示未接后端且保留修改', () => {
  const {dom, w, controller} = mount();
  try {
    w.document.querySelector('#examples-toggle').click();
    w.document.querySelector('#edit-mode').click();
    const cell = w.document.querySelector('tr[data-row] td[data-field="case_no"]');
    cell.dispatchEvent(new w.MouseEvent('dblclick', {bubbles: true}));
    const input = w.document.querySelector('.cell-input');
    input.value = '';
    input.dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    w.document.querySelector('#save-edits').click();
    assert.match(w.document.querySelector('#edit-result').textContent, /案号不能为空/);
    // 把案号改回原值：等于撤销该处修改，不再阻塞保存
    const cellFix = w.document.querySelector('tr[data-row] td[data-field="case_no"]');
    cellFix.dispatchEvent(new w.MouseEvent('dblclick', {bubbles: true}));
    const inputFix = w.document.querySelector('.cell-input');
    inputFix.value = 'IP-2026-0245';
    inputFix.dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    assert.equal(w.document.querySelectorAll('[data-row] .is-dirty').length, 0, '改回基线值清脏格');
    const cell2 = w.document.querySelector('tr[data-row] td[data-field="note"]');
    cell2.dispatchEvent(new w.MouseEvent('dblclick', {bubbles: true}));
    const input2 = w.document.querySelector('.cell-input');
    input2.value = '合法修改';
    input2.dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    w.document.querySelector('#save-edits').click();
    assert.match(w.document.querySelector('#edit-result').textContent, /未接后端：未写入正式记录/);
    assert.equal(w.document.querySelectorAll('[data-row] .is-dirty').length, 1, '确认后不悄悄清脏格');
    // 有未保存修改时退出编辑模式被拦
    w.document.querySelector('#edit-mode').click();
    assert.match(toastText(w), /先保存或放弃/);
    assert.equal(w.document.querySelector('#edit-mode').getAttribute('aria-pressed'), 'true');
    w.document.querySelector('#discard-edits').click();
    assert.equal(w.document.querySelectorAll('[data-row] .is-dirty').length, 0);
    w.document.querySelector('#edit-mode').click();
    assert.equal(w.document.querySelector('#edit-mode').getAttribute('aria-pressed'), 'false');
  } finally { controller.abort(); dom.window.close(); }
});

it('新增记录校验必填与重复案号；删除行进回收站可恢复', () => {
  const {dom, w, controller} = mount();
  try {
    w.document.querySelector('#examples-toggle').click();
    const before = w.document.querySelectorAll('tr[data-row]').length;
    w.document.querySelector('#add-row').click();
    w.document.querySelector('#n-ok').click();
    assert.match(w.document.querySelector('#n-error').textContent, /案号为必填项/);
    w.document.querySelector('#n-case-no').value = 'IP-2026-0245';
    w.document.querySelector('#n-ok').click();
    assert.match(w.document.querySelector('#n-error').textContent, /案号已存在/);
    w.document.querySelector('#n-case-no').value = 'IP-2026-0300';
    w.document.querySelector('#n-title').value = '测试新增案件';
    w.document.querySelector('#n-applicants').value = '测试甲；测试乙';
    w.document.querySelector('#n-ok').click();
    assert.equal(w.document.querySelectorAll('tr[data-row]').length, before + 1);
    assert.match(w.document.querySelector('tr[data-row]').textContent, /测试新增案件/);
    const chips = w.document.querySelectorAll('tr[data-row] .multi-chip');
    assert.ok([...chips].some(c => c.textContent === '测试甲') && [...chips].some(c => c.textContent === '测试乙'), '多值按；拆分显示');
    w.document.querySelector('[data-del]').click();
    w.document.querySelector('[data-view="trash"]').click();
    assert.equal(w.document.querySelectorAll('tr[data-row]').length, 1);
    w.document.querySelector('[data-restore]').click();
    assert.equal(w.document.querySelectorAll('tr[data-row]').length, before + 1, '恢复回到全部记录');
  } finally { controller.abort(); dom.window.close(); }
});

it('筛选和排序整行一起移动，多值显示不用程序符号', () => {
  const {dom, w, controller} = mount();
  try {
    w.document.querySelector('#examples-toggle').click();
    const filter = w.document.querySelector('#status-filter');
    filter.value = '待补正';
    filter.dispatchEvent(new w.Event('change'));
    const rows = w.document.querySelectorAll('tr[data-row]');
    assert.equal(rows.length, 2);
    for (const row of rows) assert.match(row.textContent, /待补正/);
    assert.match(w.document.querySelector('#result-count').textContent, /2 条记录/);
    filter.value = '';
    filter.dispatchEvent(new w.Event('change'));
    w.document.querySelector('[data-sort="application_date"]').click();
    const first = w.document.querySelector('tr[data-row] td[data-field="application_date"]').textContent.trim();
    assert.equal(first, '—', '升序时空日期排最前且整行稳定');
    w.document.querySelector('[data-sort="application_date"]').click();
    assert.match(w.document.querySelector('tr[data-row] td[data-field="application_date"]').textContent, /2025-03-14/, '降序最新在前');
    const multi = w.document.querySelector('tr[data-row] td[data-field="applicants"]');
    assert.doesNotMatch(multi.textContent, /[\[\]"\\]/, '多值不暴露程序符号');
    const search = w.document.querySelector('#search');
    search.value = '<script>';
    search.dispatchEvent(new w.Event('input'));
    assert.match(w.document.querySelector('#sheet-rows').textContent, /没有匹配的记录/);
    assert.equal(w.document.querySelectorAll('#sheet-rows script').length, 0);
  } finally { controller.abort(); dom.window.close(); }
});
