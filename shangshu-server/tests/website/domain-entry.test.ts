import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {collectDomainEntries} from '../../src/adapters/web/server.ts';

/* 前端领域注册点：域目录自描述入口 + 页面/导航动态注册。
   目标：两个开发者各自规范封装业务域后合并零共享文件冲突。 */

function webDirFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ss-domains-'));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, '..'), {recursive: true});
    writeFileSync(path, content);
  }
  return dir;
}

it('域入口按 order 注入入口页；非法名/缺失文件/无占位均不产生漂移', () => {
  const dir = webDirFixture({
    'js/domains/alpha/domain-entry.json': JSON.stringify({entry: ['a.js'], styles: ['a.css'], order: 10}),
    'js/domains/alpha/a.js': '/* a */',
    'css/domains/alpha/a.css': '/* ac */',
    'js/domains/beta/domain-entry.json': JSON.stringify({entry: ['b.js'], order: 20}),
    'js/domains/beta/b.js': '/* b */',
  });
  try {
    const {js, css} = collectDomainEntries(dir);
    assert.deepEqual(js, ['js/domains/alpha/a.js', 'js/domains/beta/b.js'], '按 order 顺序');
    assert.deepEqual(css, ['css/domains/alpha/a.css']);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

it('越界文件名单项丢弃；声明文件缺失整域跳过；无 entry 的域不影响', () => {
  const dir = webDirFixture({
    // 越界名丢弃、合法名保留（安全过滤逐名进行）
    'js/domains/evil/domain-entry.json': JSON.stringify({entry: ['../../../etc/passwd', 'ok.js']}),
    'js/domains/evil/ok.js': '/* ok */',
    // 声明文件缺失：整域跳过（半加载域会运行时缺依赖，宁可整域不注）
    'js/domains/broken/domain-entry.json': JSON.stringify({entry: ['gone.js']}),
    'js/domains/quiet/note.txt': '无 entry，应忽略',
  });
  try {
    const {js} = collectDomainEntries(dir);
    assert.deepEqual(js, ['js/domains/evil/ok.js'], '越界名丢弃、缺失整域跳过');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

/* 公共组件加载点（2026-10-10）：胶囊输入这类「谁都能用」的组件要放在 js/ 根下，
   但域入口原本只允许域目录内的文件名（禁 ../），公共组件加载不进来。
   补一条 `common` 声明：解析到 js/ 根，安全规则与 entry 相同，且必须排在本域 entry 之前 ——
   本域的代码要用它，它得先就位。 */
it('域入口可声明 common 加载 js/ 根下的公共组件，且排在本域入口之前', () => {
  const dir = webDirFixture({
    'js/chip-input.js': '/* 公共组件 */',
    'js/domains/mail/domain-entry.json': JSON.stringify({entry: ['mail-center.js'], common: ['chip-input.js'], order: 30}),
    'js/domains/mail/mail-center.js': '/* mail */',
  });
  try {
    const {js} = collectDomainEntries(dir);
    assert.deepEqual(js, ['js/chip-input.js', 'js/domains/mail/mail-center.js'], '公共组件应排在本域入口之前');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

it('common 同样拦越界名与缺失文件，不能当后门', () => {
  // ① 越界名逐个丢弃，合法名保留
  const a = webDirFixture({
    'js/chip-input.js': '/* ok */',
    'js/domains/mail/domain-entry.json': JSON.stringify({entry: ['mail.js'], common: ['../../../etc/passwd', 'chip-input.js']}),
    'js/domains/mail/mail.js': '/* mail */',
  });
  try {
    const {js} = collectDomainEntries(a);
    assert.ok(!js.some(f => f.includes('passwd')), '越界路径漏进来了');
    assert.deepEqual(js, ['js/chip-input.js', 'js/domains/mail/mail.js'], '越界名应丢弃、合法公共组件应保留');
  } finally { rmSync(a, {recursive: true, force: true}); }

  // ② 声明的公共文件缺失 → 整域跳过（与 entry 同规则：半加载的域宁可不注）
  const b = webDirFixture({
    'js/domains/mail/domain-entry.json': JSON.stringify({entry: ['mail.js'], common: ['chip-input.js']}),
    'js/domains/mail/mail.js': '/* mail */',
  });
  try {
    const {js} = collectDomainEntries(b);
    assert.deepEqual(js, [], '声明的公共组件缺失时整域应跳过，不该留下会缺依赖的半加载域');
  } finally { rmSync(b, {recursive: true, force: true}); }
});

it('页面注册按 owner 划界：不同域同 ID 整批拒绝，同域可追加', () => {
  const dom = new JSDOM('', {runScripts: 'outside-only'});
  dom.window.eval(readFileSync(new URL('../../../shangshu-web/js/page-registry.js', import.meta.url), 'utf8'));
  const w = dom.window as any;
  try {
    const first = w.shangshuRegisterPages(['x-page'], {owner: 'com.a', name: 'A页'});
    assert.equal(first.ok, true);
    assert.equal(w.shangshuResolvePlatformPage('x-page', 'staff'), 'x-page', '注册即平台可用');
    assert.equal(w.SHANGSHU_PAGE_REGISTRY['x-page'].owner, 'com.a', '快照已重建');
    const clash = w.shangshuRegisterPages(['x-page', 'y-page'], {owner: 'com.b'});
    assert.equal(clash.ok, false);
    assert.equal(w.shangshuPageDefinition('y-page'), null, '整批拒绝不半途注册');
    const sameOwner = w.shangshuRegisterPages(['x-page', 'z-page'], {owner: 'com.a'});
    assert.equal(sameOwner.ok, true, '同 owner 可追加');
    assert.equal(w.shangshuPageDefinition('z-page')?.owner, 'com.a');
    assert.equal(w.shangshuRegisterPages(['w-page'], {}).ok, false, '缺 owner 拒绝');
  } finally { dom.window.close(); }
});

it('侧栏注册即入导航且 domainEntry 默认可见；重复 ID 拒绝不破坏现有分组', () => {
  const dom = new JSDOM('', {runScripts: 'outside-only'});
  const w = dom.window as any;
  // 只取 GROUPS 与注册函数片段（app.js 全量依赖浏览器环境过多）。
  const source = readFileSync(new URL('../../../shangshu-web/js/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('const GROUPS =');
  const end = source.indexOf('let curMod =');
  w.renderChrome = () => {};
  w.eval(source.slice(start, end) + '; window.__groups = GROUPS;');
  try {
    const r = w.shangshuRegisterNav([{id: 'my-page', name: '我的页面', ico: 'grid', sec: '业务域'}]);
    assert.equal(r.ok, true);
    const group = w.__groups.find((g: any) => g.sec === '业务域');
    assert.ok(group, '新分区自动创建');
    assert.equal(group.items[0].id, 'my-page');
    assert.equal(group.items[0].domainEntry, true);
    const dup = w.shangshuRegisterNav([{id: 'my-page', name: '重复'}]);
    assert.equal(dup.ok, false);
    assert.equal(group.items.length, 1, '拒绝后不重复入组');
  } finally { dom.window.close(); }
});

it('领域可向全员账号菜单贡献设置入口，仍受角色和页面准入约束', () => {
  const dom = new JSDOM('', {runScripts: 'outside-only'});
  const w = dom.window as any;
  const source = readFileSync(new URL('../../../shangshu-web/js/app.js', import.meta.url), 'utf8');
  w.renderChrome = () => {};
  w.eval(source.slice(source.indexOf('const GROUPS ='), source.indexOf('let curMod =')) + '; window.__groups=GROUPS;');
  w.currentRole = () => 'staff';
  w.canSee = (item: any) => !item.roles || item.roles.includes('staff');
  w.pageAvailable = (id: string) => id !== 'unavailable-settings';
  w.findWorkspaceItem = (id: string) => w.__groups.flatMap((g: any) => g.items).find((m: any) => m.id === id);
  w.eval('const GROUPS=window.__groups;\n' + source.slice(source.indexOf('function accountMenuModules()'), source.indexOf('function renderUserFoot()')));
  try {
    w.shangshuRegisterNav([
      {id:'personal-settings',name:'我的设置',sidebarHidden:true,accountMenu:true},
      {id:'admin-settings',name:'受限设置',roles:['admin'],sidebarHidden:true,accountMenu:true},
      {id:'unavailable-settings',name:'未启用',sidebarHidden:true,accountMenu:true},
    ]);
    assert.deepEqual(Array.from(w.accountMenuModules(), (m: any) => m.id), ['personal-settings']);
    assert.equal(w.findWorkspaceItem('personal-settings').sidebarHidden, true);
  } finally { dom.window.close(); }
});
