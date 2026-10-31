/**
 * 判据：**下拉显示中文、存进去的仍是码**（2026-10-29 用户口径：
 * 截图里 DD／DF／FD、F／V「改成中文哈」）。
 *
 * **测试通过 =**（一句话）
 * 「下拉里**显示**的是中文（内内／内外／外内、巴黎公约／PCT·海牙），
 *   而**选中之后写回去的**是**码**（`DD`／`F`）——
 *   因为算法按码表判，存了中文就『不在码表里 ⇒ 不编』⇒ 白填。」
 */
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require_ = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const { JSDOM } = require_('jsdom') as typeof import('jsdom');

import { openValueDropdown } from '../src/cell-dropdown.ts';

const LABELS = { DD: '内内', DF: '内外', FD: '外内' };

function mount() {
  const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window as any;
  const host = w.document.querySelector('#host') as HTMLElement;
  const picked: string[] = [];
  const handle = openValueDropdown(host, {
    options: ['DD', 'DF', 'FD'],
    optionLabels: LABELS,
    allowCustom: false,
    current: '',
    anchor: { left: 10, top: 10, width: 120, height: 24 },
    onPick: (value: string) => { picked.push(value); },
  });
  return { dom, host, picked, handle, doc: w.document as Document };
}

test('下拉里**显示中文**，选中后**写回码**', () => {
  const { doc, picked, handle } = mount();
  const items = Array.from(doc.querySelectorAll('.excel-value-dropdown-item')) as HTMLElement[];
  const texts = items.map(item => String(item.textContent || '').trim());
  assert.ok(texts.includes('内内'), '下拉里没有显示中文「内内」：%r', texts);
  assert.ok(texts.includes('外内'), '下拉里没有显示中文「外内」：%r', texts);
  // —— **显示的是中文，不是码** ——
  assert.ok(!texts.includes('DD'), '下拉里还显示着码「DD」：%r', texts);
  // —— **但选中写回的是码** ——
  const target = items.find(item => String(item.textContent || '').trim() === '内内');
  assert.ok(target, '找不到「内内」那一项');
  (target as HTMLElement).click();
  assert.deepEqual(picked, ['DD'], '写回的不是码：%r', picked);
  handle.close();
});

test('没给显示名时 ⇒ 照旧显示它自己（审查状态／申请类型那种）', () => {
  const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window as any;
  const host = w.document.querySelector('#host') as HTMLElement;
  const handle = openValueDropdown(host, {
    options: ['受理', '实审'],
    allowCustom: true,
    current: '',
    anchor: { left: 10, top: 10, width: 120, height: 24 },
    onPick: () => undefined,
  });
  const texts = Array.from(w.document.querySelectorAll('.excel-value-dropdown-item'))
    .map(item => String(item.textContent || '').trim());
  assert.ok(texts.includes('受理'), '没有显示名时不该把值藏起来：%r', texts);
  handle.close();
});
