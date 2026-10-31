import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { JSDOM } from 'jsdom';

it('能力目录只展示 public_api 实际返回给 Agent 的工具', async () => {
  const dom = new JSDOM('<main id="main"></main>', { runScripts: 'outside-only' });
  const w = dom.window as any;
  const calls: string[] = [];
  Object.assign(w, {
    RENDER: {},
    mainBox: () => w.document.querySelector('#main'),
    $: (s: string, root?: any) => (root || w.document).querySelector(s),
    $$: (s: string, root?: any) => [...(root || w.document).querySelectorAll(s)],
    esc: (value: any) => String(value ?? ''),
    api: async (path: string) => {
      calls.push(path);
      return { ok: true, json: async () => ({ ok: true, list: [{ id: 'platform.object.query', title: '查询业务对象', effect: 'read', confirmation: 'none', input_schema: { properties: { object_id: {} } } }] }) };
    },
  });
  w.eval(readFileSync(new URL('../../../shangshu-web/js/real-ai-tools.js', import.meta.url), 'utf8'));
  await w.RENDER['ai-tools']({ isActive: () => true });
  assert.deepEqual(calls, ['/api/platform/tools']);
  assert.match(w.document.querySelector('#main')?.textContent || '', /查询业务对象/);
  assert.doesNotMatch(w.document.querySelector('#main')?.textContent || '', /迁移期|旧版工具/);
  dom.window.close();
});

it('没有文档类公共工具时上传按钮的 hidden 不会被旧 display 样式覆盖', () => {
  const css = readFileSync(new URL('../../../shangshu-web/css/deepseek.css', import.meta.url), 'utf8');
  assert.match(css, /\.ib-btn\[hidden\]\s*\{\s*display:none!important\s*\}/);
});
