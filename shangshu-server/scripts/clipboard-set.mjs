#!/usr/bin/env node
/* 把一段 HTML（可选再配一段纯文本）写进**真实系统剪贴板**的 text/html 与 text/plain 两个 flavor。

  为什么不用 dispatchEvent 造 paste：
  C5 计划原文 —— 「用真实系统剪贴板（AppleScript/pbcopy）走一遍」。
  `dispatchEvent(new ClipboardEvent('paste'))` 是我们自己塞的数据，
  它证明不了浏览器原生粘贴链（paste 事件里 `clipboardData` 的真实内容、
  用户按 Cmd+V 时走的那条路）是通的。

  为什么不用 pbcopy：
  `pbcopy` 只写 text/plain 一个 flavor。Excel/网页复制是**两个 flavor 都有**，
  我们的粘贴处理优先读 text/html —— 只写纯文本等于根本没测到 HTML 那条路。

  走 JXA（osascript -l JavaScript）的 ObjC 桥直写 NSPasteboard，
  不需要装 pyobjc，也不需要辅助功能权限。

  用法：
    node scripts/clipboard-set.mjs <html文件> [纯文本文件]
    echo '<table>…</table>' | node scripts/clipboard-set.mjs -

  退出码 0 = 两个 flavor 都写上去了（只给 html 时写一个）。 */
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

function arg(i) {
  const v = process.argv[i];
  return v === '-' ? readFileSync(0, 'utf8') : v ? readFileSync(v, 'utf8') : '';
}

const html = arg(2);
const plain = arg(3);
if (!html) {
  console.error('用法: clipboard-set.mjs <html文件|-> [纯文本文件]');
  process.exit(2);
}

const script = `
  ObjC.import("AppKit");
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  const items = $.NSMutableArray.alloc.init;
  const item = $.NSPasteboardItem.alloc.init;
  const set = (s, t) => item.setStringForType($(s), $(t));
  set(${JSON.stringify(html)}, $.NSPasteboardTypeHTML);
  ${plain ? `set(${JSON.stringify(plain)}, $.NSPasteboardTypeString);` : ''}
  items.addObject(item);
  pb.writeObjects(items);
  "ok";
`;

const out = execFileSync('osascript', ['-l', 'JavaScript', '-e', script], {encoding: 'utf8'}).trim();
const flavors = execFileSync('osascript', ['-e', 'clipboard info'], {encoding: 'utf8'}).trim();

const wantHtml = flavors.includes('HTML');
const wantPlain = !plain || flavors.includes('string') || flavors.includes('Unicode');
if (out.trim() !== 'ok' || !wantHtml || !wantPlain) {
  console.error('写剪贴板失败');
  console.error('  osascript 返回:', out);
  console.error('  剪贴板 flavor:', flavors);
  process.exit(1);
}
console.log('剪贴板已就位');
console.log('  flavor:', flavors);
console.log('  html 字节:', Buffer.byteLength(html), plain ? `纯文本字节: ${Buffer.byteLength(plain)}` : '（未写纯文本）');
