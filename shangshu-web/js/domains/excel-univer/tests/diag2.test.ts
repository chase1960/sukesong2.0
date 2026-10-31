import { createRequire } from 'node:module';
import test from 'node:test';
const require_ = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const { JSDOM } = require_('jsdom') as typeof import('jsdom');

test('diag2', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
  const doc = dom.window.document;
  const host = doc.getElementById('host') as HTMLElement;
  let saw = 0;
  host.addEventListener('pointerdown', (e: any) => {
    saw++; console.log('SAW pointerdown, clientX=', e.clientX, 'button=', e.button);
  }, true);
  const win = doc.defaultView as any;
  const ev = new win.Event('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clientX', { value: 50 });
  Object.defineProperty(ev, 'clientY', { value: 10 });
  Object.defineProperty(ev, 'button', { value: 0 });
  doc.dispatchEvent(ev);
  console.log('saw count =', saw);
  // setTimeout 在 jsdom 里能用吗？
  await new Promise(r => win.setTimeout(r, 100));
  console.log('timeout works');
});
