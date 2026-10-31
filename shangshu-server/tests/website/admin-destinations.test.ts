import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {Script} from 'node:vm';

/* 管理后台那几页的**页签条**（2026-10-21 开放性改版的一处）。
 *
 * 改前：管理后台那页有一排「账号管理 / AI 工具 / 导航设置 / 跨应用数据 / 系统设置」，
 *       但那是**纯文字**、看不出当前在哪；而且**只有那一页有** ——
 *       从「账号管理」页想回「管理后台」，得先回应用列表再点进去。
 * 改后：六页（管理后台 / 账号管理 / AI 工具 / 导航设置 / 跨应用数据 / 系统设置）
 *       **共用同一份页签条**（公共壳 app.js 一份实现），当前页标 `aria-current="page"`。
 *
 * 这组判据要成立 =：
 * 1. 公共壳**一份**实现（app.js 里的 shangshuAdminDestinations），六页共用；
 * 2. 六页**每一页**都画这条页签条；
 * 3. 每一页都把**自己**标成当前（aria-current="page"，且只有一个）。 */

const WEB = new URL('../../../shangshu-web/', import.meta.url);
const js = (rel: string) => readFileSync(new URL(rel, WEB), 'utf8');

const ADMIN_PAGES = [
  { file: 'js/real-apps.js', route: 'apps', label: '管理后台' },
  { file: 'js/real-users.js', route: 'accounts', label: '账号管理' },
  { file: 'js/real-ai-tools.js', route: 'ai-tools', label: 'AI 工具' },
  { file: 'js/real-config.js', route: 'config', label: '系统设置' },
  { file: 'js/real-config.js', route: 'modules', label: '导航设置' },
  { file: 'js/real-objects.js', route: 'objects', label: '跨应用数据' },
];

it('公共壳一份实现：清单归管理后台那页，画法归公共壳', () => {
  const shell = js('js/app.js');
  assert.match(shell, /shangshuRenderAdminDestinations\s*=/, 'app.js 里没有「把页签条画进页面」的口子');
  assert.match(shell, /shangshuBindAdminDestinations\s*=/, 'app.js 里没有绑跳转的口子');
  const owner = js('js/real-apps.js');
  assert.match(owner, /ADMIN_DESTINATIONS\s*=/, '管理后台那页没有页签条清单');
  assert.match(owner, /accounts'\s*,\s*'账号管理'/, '管理后台那页的清单里没有「账号管理」');
  assert.match(owner, /aria-current="page"/, '页签条没有标当前页');
});

it('六页每一页都画这条页签条', () => {
  for (const page of ADMIN_PAGES) {
    const source = js(page.file);
    assert.match(source, /data-admin-destinations/, `${page.label}（${page.file}）没画页签条`);
    assert.match(source, /shangshuRenderAdminDestinations/, `${page.label}（${page.file}）没把页签条画出来`);
  }
});

it('每一页都把自己标成当前（且只标一个）', () => {
  const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost/#/apps', runScripts: 'outside-only' });
  const w = dom.window as any;
  new Script('const RENDER = {}; window.RENDER = RENDER;').runInContext(dom.getInternalVMContext());
  /* app.js 加载后会去取数 ⇒ 给个空回执，别让它在测试结束后还在飞。 */
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  w.eval(js('js/app.js'));
  /* 页签条清单归管理后台那页 ⇒ 这里把那一页的清单也挂上。 */
  w.eval(js('js/real-apps.js'));
  for (const page of ADMIN_PAGES) {
    const strip = w.shangshuAdminDestinations(page.route);
    const holder = w.document.createElement('div');
    holder.innerHTML = strip;
    const current = [...holder.querySelectorAll('[aria-current="page"]')];
    assert.equal(current.length, 1, `${page.label}：标成当前的有 ${current.length} 个`);
    assert.equal(current[0].textContent?.trim(), page.label, `${page.label}：标成当前的不是它自己`);
    assert.ok(holder.querySelectorAll('[data-route]').length >= 6, `${page.label}：页签条没画全六页`);
  }
  dom.window.close();
});
