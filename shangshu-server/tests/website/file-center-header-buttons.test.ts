import {it} from 'node:test';
import {browserModuleSource} from '../helpers/browser-module-fixtures.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {installToast} from '../helpers/toast.ts';

/*
  用户 2026-10-21 09:50（配图是文件中心标题「文件中心」右边两个灰按钮
  「新建表格」「导入表格」）：
  「把这里的两个按钮也顺便去除掉吧」。

  改之前：文件中心标题右边并排三个按钮 ——「新建表格」「导入表格」「上传文件」。
    前面两个是**重复入口**：建表／导表在「Excel 清单页」里已经有了
    （那边有「新建表格」），文件中心这边再挂一份，看着像两处功能不一样。
  改之后：文件中心标题右边**只剩「上传文件」**。

  测试通过 = 下面全部成立：
  1. 文件中心页面上**没有**「新建表格」／「导入表格」这两个按钮；
  2. 源码里**不再**有那两个按钮的挂载点（连带那个选 csv/xlsx 的隐藏 input）——
     不留「按钮没了、事件还挂着」的半截壳；
  3. **「上传文件」还在** —— 不能顺手把正事也删了。
*/

const ROOT = new URL('../../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');
const settle = () => new Promise(resolve => setTimeout(resolve, 25));
const response = (value: unknown, status = 200) =>
  ({ok: status < 400, status, json: async () => value, text: async () => String(value)});

function mount() {
  const dom = new JSDOM('<div id="host"></div>', {url: 'http://localhost', runScripts: 'outside-only'});
  const w = dom.window as any;
  w.RENDER = {}; w.currentRole = () => 'admin';
  w.fetch = async (url: string) => {
    if (url === '/api/session') return response({user: {username: 'worker'}});
    if (url.includes('files.directories')) return response({directories: [], can_manage: false});
    if (url.includes('/datasets/')) return response({rows: [], total: 0});
    return response({});
  };
  installToast(w);
  w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
  for (const file of ['tool-workspace', 'file-detail', 'record-reference-picker', 'file-center']) {
    w.eval(browserModuleSource(w,read(`shangshu-web/js/${file}.js`)));
  }
  const controller = new w.AbortController();
  w.mountFileCenter(w.document.querySelector('#host'), {signal: controller.signal});
  return {w, dom, controller};
}

it('文件中心标题右边没有「新建表格」「导入表格」，只剩「上传文件」', async () => {
  const t = mount();
  try {
    await settle();
    const heading = t.w.document.querySelector('.file-heading');
    assert.ok(heading, '文件中心没有标题栏');
    const labels = [...heading.querySelectorAll('button')].map((b: any) => String(b.textContent || '').trim());
    assert.equal(labels.filter(text => /新建表格/.test(text)).length, 0,
      `文件中心还挂着「新建表格」：${labels.join('、')}`);
    assert.equal(labels.filter(text => /导入表格/.test(text)).length, 0,
      `文件中心还挂着「导入表格」：${labels.join('、')}`);
    assert.ok(labels.some(text => /上传文件/.test(text)),
      `「上传文件」不该被顺手删掉，标题栏现在是：${labels.join('、') || '一个按钮都没有'}`);
    assert.equal(t.w.document.querySelector('#new-workbook'), null, '还留着 #new-workbook');
    assert.equal(t.w.document.querySelector('#import-workbook'), null, '还留着 #import-workbook');
  } finally { t.controller.abort(); t.dom.window.close(); }
});

it('源码里那两个按钮连同它们的选表 input 一起删干净（不留半截壳）', () => {
  const source = read('shangshu-web/js/file-center.js');
  assert.doesNotMatch(source, /#new-workbook/, 'file-center.js 里还留着 #new-workbook');
  assert.doesNotMatch(source, /#import-workbook/, 'file-center.js 里还留着 #import-workbook');
  assert.doesNotMatch(source, /workbook-picker/, 'file-center.js 里还留着那个选 csv/xlsx 的隐藏 input');
});
