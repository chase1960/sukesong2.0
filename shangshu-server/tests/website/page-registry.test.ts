/* 判据：平台页注册表 ＋ 工作台这一页的呈现。
 *
 * **测试通过 =**（一句话）
 *   「哪些页能进由**显式注册表**说了算（不是『有渲染函数就能进』）；员工工作台只呈现
 *     真实工作入口、**页头上不再挂解释性副标题**，而『流程待办／我发起的流程／常用应用』
 *     这些真入口一个都没少。」 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { JSDOM } from 'jsdom';

it('平台页由显式注册表决定，不再把存在渲染函数等同于可进入', () => {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  const source = readFileSync(new URL('../../../shangshu-web/js/page-registry.js', import.meta.url), 'utf8');
  dom.window.eval(source);
  const resolve = (dom.window as any).shangshuResolvePlatformPage;

  assert.equal(resolve('objects', 'staff'), 'objects');
  assert.equal(resolve('task-mgmt', 'staff'), 'task-mgmt');
  assert.equal(resolve('ai-tools', 'admin'), 'ai-tools');
  assert.equal(resolve('ai-tools', 'staff'), null);
  assert.equal(resolve('accounts', 'admin'), 'accounts');
  assert.equal(resolve('file-center', 'admin'), 'file-center');
  assert.equal(resolve('file-center', 'staff'), 'file-center');
  assert.equal(resolve('mail', 'admin'), 'mail');
  assert.equal(resolve('mail', 'staff'), 'mail');
  assert.equal(resolve('sheets', 'admin'), 'sheets');
  assert.equal(resolve('sheets', 'staff'), 'sheets');
  for (const id of ['file-center', 'mail', 'sheets']) {
    assert.equal(resolve(id, 'guest'), null);
    const source = readFileSync(new URL(`../../../shangshu-web/js/${id === 'mail' ? 'mail-center' : id === 'sheets' ? 'sheet-center' : id}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(source.slice(source.lastIndexOf('RENDER[')), /currentRole\(\) !== 'admin'/);
  }
  for (const role of ['staff', 'manager', 'finance']) assert.equal(resolve('accounts', role), null);
  assert.equal((dom.window as any).shangshuPageDefinition('accounts').owner, 'com.shangshu.core');
  assert.equal(resolve('review', 'staff'), 'objects');
  assert.equal((dom.window as any).shangshuPageDefinition('review').status, 'retired');
  assert.equal((dom.window as any).shangshuPageDefinition('review').platform, false);
  for (const id of ['users', 'workspaces', 'flows', 'tasks', 'orders', 'customers', 'projects', 'production']) {
    assert.equal(resolve(id, 'admin'), null, id);
  }
  dom.window.close();
});

it('页面注册表在 app 路由前加载且路由切换会销毁旧页面根节点', () => {
  const html = readFileSync(new URL('../../../shangshu-web/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../../shangshu-web/js/app.js', import.meta.url), 'utf8');
  assert.ok(html.indexOf('page-registry.js') < html.indexOf('app.js'));
  assert.match(app, /main\.replaceChildren\(\)/);
  assert.match(app, /activePageController\?\.abort\(\)/);
  assert.match(app, /shangshuResolvePlatformPage/);
});

it('员工工作台只呈现真实工作入口，不暴露内核状态或设计权限', () => {
  const dashboard = readFileSync(new URL('../../../shangshu-web/js/real-dashboard.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../../shangshu-web/js/app.js', import.meta.url), 'utf8');
  const task = readFileSync(new URL('../../../shangshu-web/js/real-task.js', import.meta.url), 'utf8');

  /* ⚠️ **2026-10-23 起（提交 ffa581f54 · 用户要求「把每个页面上面那些解释性的文字删一删」·
     PKG-063-T01）**：工作台页头那句解释性副标题「我的事项和常用业务」**已被用户要求删掉**
     ⇒ 原来这条「页头里有这句话」的断言**过期**。
     ⇒ 改成**反向断言**：工作台页头**不许**再挂那行解释（页头里不许有 .sub／<p> 说明段）。
     配套判据（逐条 47 条全站扫）：shangshu-web/js/tests/check-page-heading-subtitle.test.mjs。 */
  assert.doesNotMatch(dashboard, /我的事项和常用业务/,
    '工作台页头还挂着解释性副标题「我的事项和常用业务」—— 用户 2026-10-23 要求删掉页头上的解释');
  const dashHead = /<header class="page-hd[^"]*">([\s\S]*?)<\/header>/.exec(dashboard);
  assert.ok(dashHead, '工作台页头没画出来（找不到 <header class="page-hd…">）');
  assert.doesNotMatch(dashHead[1], /class="sub"|<p[\s>]/,
    '工作台页头里还挂着一段解释文字（.sub 或 <p>）—— 页头上不许再挂解释性副标题');
  assert.match(dashboard, /流程待办/);
  assert.match(dashboard, /我发起的流程/);
  assert.match(dashboard, /常用应用/);
  assert.doesNotMatch(dashboard, /平台内核已经就绪|流程设计仍可使用/);
  assert.match(app, /id: 'flowdesign', name: '待办'/);
  assert.match(app, /currentRole\(\) === 'admin' \? \[findWorkspaceItem\('apps'\)\]/);
  assert.match(app, /canSee\(m\) && pageAvailable\(m.id\)/);
  assert.match(task, /分配给你的任务会显示在这里/);
  assert.match(task, /AI 分析任务/);
  assert.match(task, /不得派发或修改其他人的任务/);
});

it('五个一级入口使用互不重复且符合语义的图标', () => {
  const app = readFileSync(new URL('../../../shangshu-web/js/app.js', import.meta.url), 'utf8');
  const expected = new Map([
    ['dash', 'home'],
    ['applications', 'apps'],
    ['flowdesign', 'inbox'],
    ['task-mgmt', 'tasklist'],
    ['im', 'chat'],
  ]);
  for (const [id, icon] of expected) {
    assert.match(app, new RegExp(`id: '${id}', name: '[^']+', ico: '${icon}'`));
  }
  assert.equal(new Set(expected.values()).size, expected.size);
});

it('侧栏折叠只改变横向呈现，不重排菜单或残留半宽选中块', () => {
  const app = readFileSync(new URL('../../../shangshu-web/js/app.js', import.meta.url), 'utf8');
  const sidebar = readFileSync(new URL('../../../shangshu-web/js/sidebar.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../../shangshu-web/css/deepseek.css', import.meta.url), 'utf8');

  assert.match(css, /#side #side-glass\{left:6px;width:calc\(100% - 12px\)\}/);
  assert.doesNotMatch(app, /g\.style\.width\s*=/);
  assert.doesNotMatch(app, /g\.style\.left\s*=/);
  assert.match(css, /#side\.rail \.side-sec,[\s\S]*visibility:hidden/);
  assert.match(css, /#side\.rail \.workspace-group\{margin-top:20px;padding:0/);
  assert.match(css, /#side\.rail \.side-main \.workspace-group:first-child\{margin-top:16px;padding-top:0\}/);
  assert.match(css, /#side\.rail \.workspace-body\{[^}]*display:flow-root/);
  assert.match(sidebar, /else \{ setCollapsed\(!state\.collapsed\); return; \}/);
});
