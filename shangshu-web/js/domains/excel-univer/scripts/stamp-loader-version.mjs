/**
 * **把产物版本号盖回 loader**（2026-10-29，用户反馈：「刷新解不开 —— 你那边必须硬刷新才拿到新包」）。
 *
 * **问题**：表格部件是**懒加载**的，URL 由 `excel-loader.js` 里手写的 `?v=` 决定。
 *   改了源码、重新构建了产物，但 `?v=` 没变 ⇒ **URL 没变** ⇒
 *   浏览器按同一个 URL 取（服务端给的是 `must-revalidate`，但**同一轮会话里的内存缓存**
 *   和「我以为刷新过了」都会让人拿到旧包）⇒ 人只能靠**硬刷新**才看到新东西。
 *
 * **改之前**：版本号是人手写的常量 ⇒ 忘了 bump 就把旧包锁在原地。
 * **改之后**：版本号 = **产物内容哈希**（内容变了 ⇒ URL 必变 ⇒ 刷新就拿到新包）。
 *
 * **怎么看**：构建后看 `excel-loader.js` 里那行 `?v=` ⇒ 它的值等于产物的 sha1 前 10 位；
 *   产物改了再构建 ⇒ 这个值自动变 ⇒ 浏览器地址栏里那条请求的 URL 也跟着变。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundleName = process.argv[2] || 'excel-univer-entry.js';
const bundlePath = path.join(root, bundleName);
const loaderPath = path.join(root, 'excel-loader.js');

if (!fs.existsSync(bundlePath)) {
  console.error('找不到产物：' + bundlePath + '（先构建再盖版本号）');
  process.exit(1);
}
if (!fs.existsSync(loaderPath)) {
  console.error('找不到 loader：' + loaderPath);
  process.exit(1);
}

const digest = createHash('sha1').update(fs.readFileSync(bundlePath)).digest('hex').slice(0, 10);
const source = fs.readFileSync(loaderPath, 'utf8');
const pattern = new RegExp(`(${bundleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?v=)([A-Za-z0-9._-]+)`);
if (!pattern.test(source)) {
  console.error('loader 里找不到「' + bundleName + '?v=…」那一处 —— 没盖上（版本号仍旧是手写的）');
  process.exit(1);
}
const next = source.replace(pattern, (_match, head) => head + digest);
if (next === source) {
  console.log('产物版本号已经是 ' + digest + '（没变，不写盘）');
  process.exit(0);
}
fs.writeFileSync(loaderPath, next, 'utf8');
console.log('产物版本号已盖成内容哈希：' + digest + '（' + bundleName + '）');
