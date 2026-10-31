import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setup, settled} from './excel-mount-harness.ts';

function gate() { let resolve!: () => void; const promise = new Promise<void>(r => {resolve = r;}); return {promise, resolve}; }

test('冷启动同步呈现工具栏和空骨架；定义返回后仍等首屏真实值，不提前清除', async () => {
  const h = setup(), metadata = gate(), rows = gate();
  const original = h.context.openTable;
  h.context.openTable = async (...args: any[]) => {
    await metadata.promise;
    const adapter = await original(...args), load = adapter.loadPage;
    adapter.loadPage = async (...page: any[]) => { await rows.promise; return load(...page); };
    return adapter;
  };
  const mounted = h.mountPage();
  try {
    const skeleton = h.host.querySelector<HTMLElement>('[data-open-loading]');
    assert.ok(skeleton && !skeleton.hidden, '第一个读请求尚未完成就应有加载骨架');
    assert.equal(h.host.getAttribute('aria-busy'), 'true');
    assert.equal((h.host.querySelector('.excel-bar') as HTMLElement).hidden, false);
    assert.equal((h.host.querySelector('[data-undo]') as HTMLButtonElement).disabled, true);
    assert.ok(skeleton.querySelector('[data-loading-headers]'));
    assert.ok(skeleton.querySelector('[data-loading-grid]'));
    assert.match(skeleton.textContent || '', /正在加载/);
    assert.doesNotMatch(skeleton.textContent || '', /原值|金额|客户|共\s*\d+\s*行/);
    metadata.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(skeleton.hidden, false, '元数据返回不代表真实数据已装入');
    assert.equal(h.grids.length, 0);
    rows.resolve(); await mounted;
    assert.equal(skeleton.hidden, true);
    assert.equal(h.host.getAttribute('aria-busy'), 'false');
    assert.equal(h.grids[0].lastRows[0].values[0], '原值');
  } finally { metadata.resolve(); rows.resolve(); await mounted.catch(() => {}); h.close(); }
});

test('首屏失败移除骨架，原位显示错误并能重新加载；重试期间不留下旧错误', async () => {
  const h = setup(), original = h.context.openTable;
  let attempts = 0;
  const targets: Array<{key:string;source:string|undefined}> = [];
  h.context.openTable = async (...args: any[]) => {
    targets.push({key:args[0],source:args[2]});
    const adapter = await original(...args);
    if (++attempts === 1) adapter.loadPage = async () => { throw Object.assign(new Error('server error'), {status: 500}); };
    return adapter;
  };
  try {
    await h.mountPageFailure();
    const grid = h.host.querySelector<HTMLElement>('[data-grid]');
    const skeleton = h.host.querySelector<HTMLElement>('[data-open-loading]');
    assert.ok(skeleton?.hidden);
    assert.equal(h.host.getAttribute('aria-busy'), 'false');
    assert.equal(grid?.hidden, true);
    assert.ok(h.toastCalls.length);
    const retry = h.host.querySelector<HTMLButtonElement>('[data-open-retry]');
    assert.ok(retry && !retry.hidden, '开表失败应有读操作重试，不能借用写入重试');
    retry.click();
    assert.equal(skeleton?.hidden, false);
    assert.equal(retry.hidden, true);
    assert.equal(h.host.querySelector('[data-foot]')?.classList.contains('excel-state-error'), false);
    await settled(() => h.grids.length === 1 && h.host.getAttribute('aria-busy') === 'false', []);
    assert.equal(h.host.querySelector('[data-grid]'), grid, '仍使用原网格容器');
    assert.equal(grid?.hidden, false);
    assert.equal(attempts, 2);
    assert.deepEqual(targets,[{key:'one',source:undefined},{key:'one',source:'xlsx'}],
      '首屏失败后重新读取同一张已识别来源的表，不能只补读半条链');
  } finally { h.close(); }
});

test('离开时清除忙碌态；迟到的开表响应不能再创建网格', async () => {
  const h = setup(), deferred = gate(), original = h.context.openTable;
  h.context.openTable = async (...args: any[]) => { await deferred.promise; return original(...args); };
  const controller = new h.context.window.AbortController();
  try {
    h.context.mountProduction(h.host, controller.signal);
    assert.equal(h.host.getAttribute('aria-busy'), 'true');
    controller.abort(); deferred.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.host.getAttribute('aria-busy'), 'false');
    assert.equal((h.host.querySelector('[data-open-loading]') as HTMLElement).hidden, true);
    assert.equal(h.grids.length, 0);
  } finally { controller.abort(); deferred.resolve(); h.close(); }
});

test('加载骨架使用静态网格，减少动态效果设置不会出现闪动', () => {
  const css = readFileSync(new URL('../../../shangshu-web/css/domains/excel-univer/excel-univer.css', import.meta.url), 'utf8');
  assert.ok(/prefers-reduced-motion:\s*reduce[\s\S]{0,180}excel-loading/.test(css));
  assert.ok(/\.excel-loading[^}]*animation:\s*none/.test(css));
});

test('切表后旧首屏迟到不盖掉新表的加载骨架或数据', async () => {
  const h = setup(), oldRows = gate(), newRows = gate(), original = h.context.openTable;
  h.context.openTable = async (key: string) => {
    const adapter = await original(key), load = adapter.loadPage;
    adapter.loadPage = async () => { await (key === 'one' ? oldRows : newRows).promise; return load(); };
    return adapter;
  };
  const controller = new h.context.window.AbortController();
  try {
    h.context.mountProduction(h.host, controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    const second = h.context.testSession.openTableByKey('two', {source: 'xlsx'});
    oldRows.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.host.getAttribute('aria-busy'), 'true');
    assert.equal((h.host.querySelector('[data-open-loading]') as HTMLElement).hidden, false);
    assert.equal(h.grids.length, 0);
    newRows.resolve(); await second;
    assert.equal(h.grids.length, 1);
    assert.equal(h.grids[0].lastRows[0].values[0], '另一表');
    assert.equal(h.host.querySelector('[data-title]')?.textContent, 'two');
    assert.equal(h.host.getAttribute('aria-busy'), 'false');
  } finally { oldRows.resolve(); newRows.resolve(); controller.abort(); h.close(); }
});
