/**
 * 产品壳 → 服务端：「当前上下文」那条**活**通道（内核机制，2026-10-21）。
 *
 * 测试通过 = 什么成立：
 * - 页面报了新上下文 ⇒ 服务端**真的收到**一份（POST api/chat/context，带会话号与上下文）；
 * - **值没真变** ⇒ 不重复报（防洪水）；
 * - 值变了 ⇒ 报新的一份（后到的覆盖先到的，服务端那边只留一份）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { JSDOM } from 'jsdom';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('产品壳把上下文持续推给服务端：值没真变不报、变了才报', async () => {
  const dom = new JSDOM(`
    <main id="main"><div class="main-scroll"><div class="page-hd"><h1>工作台</h1></div></div></main>
    <div id="copilot-context"><span class="text"></span></div>
  `, { runScripts: 'outside-only', url: 'https://shangshu.local/' });
  const w = dom.window as any;
  const pushes: any[] = [];
  Object.assign(w, {
    RENDER: {}, ICONS: { spark: '' }, curMod: 'dash',
    ic: () => '',
    $: (selector: string, root?: any) => (root || w.document).querySelector(selector),
    $$: (selector: string, root?: any) => [...(root || w.document).querySelectorAll(selector)],
    findWorkspaceItem: (id: string) => ({ name: id }),
    api: (path: string, opts: any) => {
      if (path === 'api/chat/context') pushes.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true });
    },
  });
  try {
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-chat.js', import.meta.url), 'utf8'));

    w.chatSetBusinessContext({ module: 'mail', entity_type: 'mail.message', entity_id: 'MAIL-1', label: 'A 信' });
    await wait(600);
    assert.equal(pushes.length, 1, '上下文变了一次就要推一次');
    assert.equal(pushes[0].ui_context.entity_id, 'MAIL-1', '推的要是当前那份上下文');
    assert.ok('conversation_id' in pushes[0], '要带会话号（服务端按会话存一份）');

    // 值没真变 ⇒ 不重复报（防洪水那两道闸之一）。
    w.chatSetBusinessContext({ module: 'mail', entity_type: 'mail.message', entity_id: 'MAIL-1', label: 'A 信' });
    await wait(600);
    assert.equal(pushes.length, 1, '值没真变就不许再报');

    // 值变了 ⇒ 报新的一份。
    w.chatSetBusinessContext({ module: 'mail', entity_type: 'mail.message', entity_id: 'MAIL-2', label: 'B 信' });
    await wait(600);
    assert.equal(pushes.length, 2, '值变了要报');
    assert.equal(pushes[1].ui_context.entity_id, 'MAIL-2');
  } finally {
    dom.window.close();
  }
});
