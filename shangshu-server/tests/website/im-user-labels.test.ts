import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { JSDOM } from 'jsdom';

it('消息群成员与头像使用当前账号姓名，不回退到协作键', () => {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  const w = dom.window as any;
  Object.assign(w, {
    RENDER: {},
    esc: (s: string) => s.replaceAll('<','&lt;').replaceAll('>','&gt;'),
    currentUserInfo: { username: 'finance', display_name: '财务会计', role: 'finance' },
  });
  try {
    w.eval(readFileSync(new URL('../../../shangshu-web/js/real-im.js', import.meta.url), 'utf8') +
      "\nimUsers=[{username:'staff',display_name:'尚小员',role:'staff'}];");
    assert.equal(w.imUserName('finance'), '财务会计');
    assert.equal(w.imUserName('staff'), '尚小员');
    assert.match(w.imAvatarHtml({type:'group',member_ids:['staff','finance']}), /财/);
  } finally { dom.window.close(); }
});
