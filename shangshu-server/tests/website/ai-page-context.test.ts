import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { JSDOM } from 'jsdom';

it('产品壳为所有正式页面自动提供 AI 上下文，并保留同页更具体对象', () => {
  const dom = new JSDOM(`
    <main id="main"><div class="main-scroll"><div class="page-hd"><h1>工作台</h1></div></div></main>
    <div id="copilot-context"><span class="text"></span></div>
  `, { runScripts:'outside-only', url:'https://shangshu.local/' });
  const w = dom.window as any;
  Object.assign(w, {
    RENDER:{}, ICONS:{spark:''}, curMod:'dash',
    ic:() => '',
    $:(selector:string, root?:any) => (root || w.document).querySelector(selector),
    $$:(selector:string, root?:any) => [...(root || w.document).querySelectorAll(selector)],
    findWorkspaceItem:(id:string) => ({name:id}),
  });
  try {
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-chat.js', import.meta.url), 'utf8'));
    w.chatRefreshContext();
    assert.equal(w.document.querySelector('#copilot-context .text').textContent, '正在看：工作台');

    w.curMod = 'applications';
    w.chatSetBusinessContext({module:'applications', entity_type:'application', entity_id:'finance', label:'应用 · 费用管理'});
    w.chatRefreshContext();
    assert.equal(w.document.querySelector('#copilot-context .text').textContent, '正在看：应用 · 费用管理');

    w.curMod = 'flowdesign';
    w.document.querySelector('h1').textContent = '待办';
    w.chatRefreshContext();
    assert.equal(w.document.querySelector('#copilot-context .text').textContent, '正在看：待办');
  } finally {
    dom.window.close();
  }
});

it('服务端明确区分产品壳页面上下文与任意屏幕像素', () => {
  const source = readFileSync(new URL('../../src/core/chat.ts', import.meta.url), 'utf8');
  assert.match(source, /不得回答“看不到用户在哪个页面”/);
  assert.match(source, /没有任意读取屏幕像素的能力/);
});
