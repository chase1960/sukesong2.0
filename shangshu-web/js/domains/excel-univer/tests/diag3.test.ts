import { createRequire } from 'node:module';
import test from 'node:test';
const require_ = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const { JSDOM } = require_('jsdom') as typeof import('jsdom');

test('diag3', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
  const doc = dom.window.document;
  const host = doc.getElementById('host') as HTMLElement;
  const win = doc.defaultView as any;
  let sawHost = 0, sawDoc = 0;
  host.addEventListener('pointerdown', () => { sawHost++; }, true);
  doc.addEventListener('pointerdown', () => { sawDoc++; }, true);
  const ev = new win.Event('pointerdown', { bubbles: true, cancelable: true });
  doc.dispatchEvent(ev);
  console.log('Event 派发 => host:', sawHost, 'doc:', sawDoc);
  // 换成 mousedown 看 jsdom 认不认
  let mh = 0, md = 0;
  host.addEventListener('mousedown', () => { mh++; }, true);
  doc.addEventListener('mousedown', () => { md++; }, true);
  doc.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, clientX: 50 }));
  console.log('MouseEvent 派发 => host:', mh, 'doc:', md);
  // MouseEvent 顶着 pointerdown 的名字
  let ph = 0;
  host.addEventListener('pointerdown', () => { ph++; }, true);
  doc.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 50, button: 0 }));
  console.log('MouseEvent(名字=pointerdown) => host:', ph);
});
