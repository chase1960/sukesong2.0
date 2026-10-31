// 判据：**全站前端资源用同一个版本戳** —— 磁盘上只声明一个站点版本号，人排查「我看的是哪一版」时一眼对得上。
//
// **测试通过 =**（一句话）
// 「`index.html` 里**每一个**本地 js/css 引用都带 `?v=`，而且**所有戳是同一个值」
//   ⇒ 磁盘上的站点版本号**全站统一**；谁加了新文件忘了带戳，这条立刻红。」
//
// ⚠️ **这条守的是「源文件一致性」，不是「浏览器会不会拿到旧文件」**（2026-10-25 06:0x 实测订正）：
//   站上真正把资源发给浏览器的是**内容指纹** —— 入口页由服务端按**文件内容 sha1 前 10 位**
//   改写成 `?h=<内容指纹>`（`shangshu-server/src/adapters/web/server.ts` 的 `rewriteIndexAssets`）
//   ⇒ **内容变 ⇒ 地址必变**；手工写的 `?v=` 资源走 `Cache-Control: max-age=0, must-revalidate`
//   ⇒ **浏览器每次都回头问服务器**。
//   ⇒ **实测（站上 3850，2026-10-25）**：拿**旧戳** `?v=20261025-pkg097a` 去请求 `js/review-center.js`
//   与 `css/review-center.css` ⇒ **200 OK ＋ 拿到的就是当前内容** ⇒ **漏跳戳不会让浏览器拿到旧文件**。
//   ⇒ 那几条机制由服务端判据钉着：`shangshu-server/tests/website/static-cache.test.ts`。
//
// ⚠️ **为什么要有这条**（2026-10-22 实踩 —— 但**当时的归因没有实测过交付链路**，别把它当定律）：
//   `index.html` 里原来有 **60 多个手写版本戳**（每个文件一个不同的值）＋ **8 个 js 压根没带戳**。
//   现场出现「**页面能打开（用的是新文件）、但侧栏没有新入口（用的是旧文件）**」
//   ⇒ 当时归因为「忘了换戳」⇒ 统一了全站戳。**这个归因当时没验过**：站上指纹机制**自己也出过一回 bug**
//   （2026-09-22 修的：入口页 HTML 没改、而依赖的资源改了 ⇒ 指纹不刷新 ⇒ 浏览器拿旧文件）。
//   ⇒ **纪律仍然成立**（一个戳管全站；加新文件忘了带戳当场红），但**理由按上面那条真机制写**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const html = fs.readFileSync(path.join(ROOT, 'shangshu-web/index.html'), 'utf8');

/** 本地资源（js/css/字体等）的引用。 */
const refs = [...html.matchAll(/(?:src|href)="((?!https?:|data:|\/\/)[^"]+)"/g)].map(m => m[1]);

test('① 本地资源引用都带版本戳（没有裸路径）', () => {
  const bare = refs.filter(ref => !/\.(js|css|woff2?|ttf|png|jpg|svg)$/i.test(ref) && !ref.includes('?v='));
  assert.deepEqual(bare, [], '这些本地资源没带版本戳 ⇒ 磁盘上声明的站点版本号缺了一条：' + bare.join('、'));
});

test('② 全站只用一个戳（磁盘上只声明一个站点版本号）', () => {
  const stamps = new Set();
  const missing = [];
  for (const ref of refs) {
    const hit = /\?v=([^"&\s]+)/.exec(ref);
    if (!hit) { if (!/\.(js|css)$/i.test(ref)) continue; missing.push(ref); continue; }
    stamps.add(hit[1]);
  }
  assert.deepEqual(missing, [], '这些 js/css 没带版本戳：' + missing.join('、'));
  assert.equal(stamps.size, 1,
    '前端资源用了 ' + stamps.size + ' 个不同的版本戳（' + [...stamps].join('、') + '）'
    + ' ⇒ 磁盘上声明的站点版本号**全站不统一**（人排查「我看的是哪一版」时对不上）。**全站只用一个戳**。');
});

test('③ 戳不是空值、也不是占位', () => {
  for (const stamp of new Set([...html.matchAll(/\?v=([^"&\s]+)/g)].map(m => m[1]))) {
    assert.match(stamp, /^[0-9A-Za-z][0-9A-Za-z._-]*$/, '版本戳不合法：' + stamp);
  }
});

// —— PKG-100（2026-10-25）：上面三条只管「戳长什么样」，**没管「改了壳有没有跳戳」** ——
//
// **为什么要有这两条**（2026-10-25 实踩）：
//   PKG-099 改了公共壳 `js/review-center.js`（三个真缺口的实现）⇒ **但全站戳没跳**
//   （还停在 `20261025-pkg097a`）⇒ **磁盘上声明的站点版本号落后于实际改到哪一包**
//   （和 ① 那条记的是同一种病，但这次更隐蔽：① 的病是「个别引用漏了戳」，
//   这次的病是「**戳整体没跳**」⇒ 现有判据一条都拦不住）。
//
// ⚠️ **别把它读成「漏跳戳 ⇒ 浏览器拿到旧文件」**（2026-10-25 06:0x 实测订正）：
//   **站上真正发资源给浏览器的是内容指纹**（`?h=<文件内容 sha1 前 10 位>`）⇒ 内容变 ⇒ 地址必变；
//   手工 `?v=` 走 `must-revalidate` ⇒ **实测拿旧戳请求，200 OK ＋ 拿到的就是当前内容**
//   ⇒ **漏跳戳不会让浏览器拿到旧文件**（机制由 `shangshu-server/tests/website/static-cache.test.ts` 钉着）。
//   ⇒ 这两条守的是**源文件层面的版本号一致性**。
//
// **测试通过 =**（一句话）
//   「公共壳页面里带 `?v=` 的那些资源，最近一笔改动它们的提交所属的**包号 ≤ 当前戳的包号**
//     ⇒ 改了公共壳却没跳戳这件事，当场红。」
//
// ⚠️ **为什么用 git 去查**：戳本身记不出「它是哪次改动跳的」⇒ 唯一的真来源是**提交历史**。
//   基线跑批本来就在 git 仓里跑（`run-baseline-tests.mjs` 用 `git ls-files` 列清单）⇒ 不额外依赖。
//
// ⚠️ **「包号 ≤」而不是「＝」**：包号是流水号，一包可以改好几次壳（每次都跳）。
//   戳可以**领先**（先跳了戳、后面那笔改的是域文件）⇒ 只在**戳落后**时才红。

/** 公共壳页面：`shangshu-web/` 顶层的 html（域目录下的不算）。 */
const shellPages = fs.readdirSync(path.join(ROOT, 'shangshu-web')).filter(name => name.endsWith('.html'));

/** 所有公共壳页面里带 `?v=` 的本地资源引用。 */
function stampedRefs() {
  const refs = [];
  for (const page of shellPages) {
    const pageHtml = fs.readFileSync(path.join(ROOT, 'shangshu-web', page), 'utf8');
    for (const m of pageHtml.matchAll(/(?:src|href)="((?!https?:|data:|\/\/)[^"?]+)\?v=([^"&]+)"/g)) {
      refs.push({ page, file: 'shangshu-web/' + m[1], stamp: m[2] });
    }
  }
  return refs;
}

/** 从提交标题里取包号（`PKG-099-T02` ⇒ 99）；没有就是 null。 */
function packageOf(subject) {
  const nums = [...subject.matchAll(/PKG-(\d+)/gi)].map(m => Number(m[1]));
  return nums.length ? Math.max(...nums) : null;
}

/** 从戳里取包号（`20261025-pkg097a` ⇒ 97）。 */
function stampPackage(stamp) {
  const hit = /pkg(\d+)/i.exec(stamp);
  return hit ? Number(hit[1]) : null;
}

test('④ 公共壳页面用的都是同一个戳（预览页也算进来，不许自己用一个）', () => {
  const refs = stampedRefs();
  assert.ok(refs.length > 0, '公共壳页面里一个带戳的资源都没有 ⇒ 查不出全站用的是哪个戳');
  const stamps = new Map();
  for (const ref of refs) stamps.set(ref.stamp, (stamps.get(ref.stamp) || 0) + 1);
  assert.equal(stamps.size, 1,
    '公共壳页面用了 ' + stamps.size + ' 个不同的版本戳（'
    + [...stamps].map(([s, n]) => s + '×' + n).join('、')
    + '）⇒ 磁盘上声明的站点版本号**全站不统一**。**全站只用一个戳**。');
});

test('⑤ 碰过带戳资源的提交，它的包号 ≤ 当前戳的包号（改了壳没跳戳，当场红）', () => {
  const refs = stampedRefs();
  const files = [...new Set(refs.map(r => r.file))];
  const stamps = [...new Set(refs.map(r => r.stamp))];
  assert.equal(stamps.length, 1, '这里按「只有一个戳」算，先把 ④ 那条过了再来');
  const stamp = stamps[0];
  const stampPkg = stampPackage(stamp);
  assert.ok(stampPkg !== null, '戳里认不出包号（要像 `20261025-pkg097a` 这样带 `pkgNNN`）：' + stamp);

  let log;
  try {
    log = execFileSync('git', ['log', '-1', '--format=%H%x09%s', '--', ...files],
      { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (error) {
    assert.fail('读不到 git 历史（这条判据要在 git 仓里跑）：' + error.message);
  }
  if (!log) return; // 仓里还没有碰过这些资源的提交 —— 没有可比的东西，不红。

  const [sha, subject] = log.split('\t');
  const lastPkg = packageOf(subject);
  assert.ok(lastPkg !== null,
    `最近一笔碰过带戳资源的提交 \`${sha.slice(0, 9)}\` 标题里没有 PKG 包号`
    + `（${subject}）⇒ 查不出它属于哪一包 ⇒ 按提交约定，提交信息必须带任务号。`);

  assert.ok(stampPkg >= lastPkg,
    `全站戳是 \`${stamp}\`（包号 ${stampPkg}），但最近一笔碰过带戳资源的提交是 `
    + `\`${sha.slice(0, 9)}\`（${subject}，包号 ${lastPkg}）`
    + ` ⇒ **改了公共壳资源却没跳全站戳** ⇒ 磁盘上声明的站点版本号落后了`
    + ` ⇒ 把戳跳到 pkg${String(lastPkg).padStart(3, '0')} 或更新。`
    + '\n（⚠️ 这条守的是**源文件层面的版本号一致性**，**不是**「浏览器会拿到旧文件」：'
    + '站上真正发资源给浏览器的是**内容指纹**（`?h=<文件内容 sha1 前 10 位>`）⇒ 内容变 ⇒ 地址必变；'
    + '手工 `?v=` 走 `must-revalidate` ⇒ **实测拿旧戳请求，200 OK ＋ 拿到的就是当前内容**'
    + '⇒ **漏跳戳不会让浏览器拿到旧文件**。那几条机制在 '
    + '`shangshu-server/tests/website/static-cache.test.ts`。）');
});

