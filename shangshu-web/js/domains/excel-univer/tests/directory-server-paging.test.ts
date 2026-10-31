import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// jsdom 装在 shangshu-server 下（域内目录没有 node_modules）—— 按绝对路径引。
// ⚠️ 域内判据要**从 shangshu-server 目录跑**（那里有 tsx）。
import {createRequire} from 'node:module';
const require_ = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const {JSDOM} = require_('jsdom') as typeof import('jsdom');

/**
 * Excel 清单页：**页码决定实际读取范围**（2026-10-28 · PKG-132 · 审查报告 R11）。
 *
 * 背景：以前清单页是「**把文件循环读到 500 条** → **浏览器里切片** → 翻页只重画不重读」。
 * ⇒ 页码根本不决定网络读取范围（10.2 门槛：「页码决定实际读取范围」
 * ／「不能先抓全部表/全部行后浏览器筛」）。
 * ⇒ 现在：**页码与归属层级都交给服务端**，翻页/改筛选**重新读**。
 *
 * 测试通过 = 下面全部成立：
 *  1. **翻页会重新读**：点「下一页」⇒ `load` 被再次调用，且**带上了新的页码**
 *  2. **归属筛选会重新读**：改归属 ⇒ `load` 被再次调用，且**带上了归属层级**
 *  3. **本地不再切片**：读回来的 entries **原样呈现**（不会被本地再切一刀）
 *  4. **页数按服务端总数算**：total=45、每页 20 ⇒ 3 页（不是按手头几条算）
 *  5. **护栏**：搜索、重画、增量更新、打开动作 —— 行为一条不许变
 */

import {mountDirectory} from '../src/directory.ts';

const DIR = readFileSync(new URL('../src/directory.ts', import.meta.url), 'utf8');

type Call = { term: string; page: number; attributionLevel: string };

function mountDirectoryInto(host: HTMLElement, dom: JSDOM, calls: Call[], total = 45) {
  const entries = [
    { key: 'a', title: '甲表', kind: 'xlsx', ownership: '个人', updatedAt: '2026-10-19 10:00', permission: '可编辑', canStructure: true, canAssign: true },
    { key: 'b', title: '乙表', kind: 'xlsx', ownership: '部门', updatedAt: '2026-10-19 11:00', permission: '可编辑', canStructure: true, canAssign: false },
  ];
  return mountDirectory(host, {
    load: (async (term: string, page: number, attributionLevel: string) => {
      calls.push({ term, page, attributionLevel });
      return { entries, total, truncated: false };
    }) as any,
    open: () => {}, upload: () => {}, create: () => {},
  });
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

it('翻页会重新读，并把新页码交给服务端', async () => {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host') as HTMLElement;
  const calls: Call[] = [];
  mountDirectoryInto(host, dom, calls);
  await flush();
  assert.equal(calls.length, 1, '打开清单页应该读一次');
  assert.equal(calls[0].page, 1, '第一次读的是第 1 页');

  const next = host.querySelector('[data-picker-next]') as HTMLButtonElement;
  assert.ok(next, '没有「下一页」');
  next.click();
  await flush();
  assert.equal(calls.length, 2, '点「下一页」**没有重新读** ⇒ 页码不决定网络读取范围');
  assert.equal(calls[1].page, 2, '第二次读带的不是第 2 页');
});

it('归属筛选会重新读，并把归属层级交给服务端', async () => {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host') as HTMLElement;
  const calls: Call[] = [];
  mountDirectoryInto(host, dom, calls);
  await flush();

  const filter = host.querySelector('[data-attribution-filter]') as HTMLSelectElement;
  assert.ok(filter, '没有归属筛选');
  filter.value = 'department';
  filter.dispatchEvent(new dom.window.Event('change'));
  await flush();
  assert.equal(calls.length, 2, '改归属筛选**没有重新读**');
  assert.equal(calls[1].attributionLevel, 'department', '归属层级没交给服务端');
  assert.equal(calls[1].page, 1, '改筛选后页码要回到第 1 页');
});

it('读回来的就是这一页：本地**不按页码**再切', () => {
  // ⚠️ 「最多一页」的安全上限要留着（loader 可能给回全量），
  //   但**不许按页码做本地切片** —— 页码已由服务端决定读取范围。
  assert.ok(!/slice\(\(state\.page-1\)\s*\*\s*pageSize/.test(DIR),
    '清单页还在**按页码本地切片** ⇒ 页码没有决定网络读取范围');
  // 「最多一页」的安全上限要留着（loader 可能给回多于一页）。
  assert.ok(/filtered\.slice\(0,pageSize\)/.test(DIR), '缺少「最多一页」的安全上限');
  assert.ok(!/result\.entries\.filter\(/.test(DIR), '清单页还在**本地筛归属** ⇒ 筛选只对手头那批生效');
});

it('页数按服务端给的总数算', async () => {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host') as HTMLElement;
  const calls: Call[] = [];
  mountDirectoryInto(host, dom, calls, 45);
  await flush();
  const info = host.querySelector('[data-page-info]') as HTMLElement;
  assert.ok(info, '没有页码信息位');
  assert.match(info.textContent || '', /第 1 \/ 3 页/, '页数没按服务端总数算（45 条 / 每页 20 ⇒ 3 页）');
  assert.match(info.textContent || '', /45/, '页码信息里没有服务端给的总数');
});

it('护栏：搜索重置页码并重新读', async () => {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector('#host') as HTMLElement;
  const calls: Call[] = [];
  mountDirectoryInto(host, dom, calls);
  await flush();
  const search = host.querySelector('[data-picker-search]') as HTMLInputElement;
  assert.ok(search, '没有搜索框');
  search.value = '甲';
  search.dispatchEvent(new dom.window.Event('input'));
  await new Promise(resolve => setTimeout(resolve, 320));
  assert.ok(calls.length >= 2, '搜索没有重新读');
  assert.equal(calls[calls.length - 1].term, '甲', '搜索词没交给服务端');
  assert.equal(calls[calls.length - 1].page, 1, '搜索后页码要回到第 1 页');
});
