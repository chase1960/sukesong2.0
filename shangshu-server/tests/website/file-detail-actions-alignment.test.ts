import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/**
 * 文件详情弹窗的**底部操作栏**要跟上方内容视觉对齐（FIX-43）——
 * 用户 2026-10-20 12:41 截图后说：「这个有点丑，**也迁移到左侧**」，
 * 随后澄清：「**就是重新上传这几个按钮和上方视觉对齐**」。
 *
 * 改之前：底部那排按钮（重新上传 / 下载 / 移入回收站）是
 * `.file-detail-actions{justify-content:flex-end}` ⇒ **右对齐**，
 * 而上方「文件名称 / 所属目录 / 标签 / 备注」「辅助字段与版本」都是**左对齐** ——
 * 同一栏里两套对齐线，看着就是「歪的」，这是用户说「有点丑」的落点。
 *
 * 改之后：
 *  · 按钮与上方内容**同一条左线**（左对齐）
 *  · **危险动作**（移入回收站 / 恢复文件）**推到最右** ——
 *    既对齐了，又不把「删掉这个文件」和「重新上传」挤在一起（误点风险）
 *  · 按钮之间的间距、尺寸跟上方控件一致
 *
 * 护栏（一个不许少）：
 *  · 「重新上传」「下载」「移入回收站」「恢复文件」四个入口一个不少
 *  · 「下载」还是真链接（`href` ＋ `download`），不是假按钮
 *  · 危险按钮**仍是** `data-recycle` / `data-restore`（行为绑定一个字没改）
 *  · 上传完**不自动打开详情**（用户明确要求保持现状）
 */

const CSS = readFileSync(new URL('../../../shangshu-web/css/file-center.css', import.meta.url), 'utf8');
const DETAIL = readFileSync(new URL('../../../shangshu-web/js/file-detail.js', import.meta.url), 'utf8');
const CENTER = readFileSync(new URL('../../../shangshu-web/js/file-center.js', import.meta.url), 'utf8');

/* 取 `.file-detail-actions` 这一条规则（可能带其它选择器）。
   先剥掉注释，再按 `}` 切块 —— 注释结尾的换行会让「选择器紧跟 {` 的正则失配。 */
function ruleOf(selector: string): string {
  const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const block of clean.split('}')) {
    const braceAt = block.lastIndexOf('{');
    if (braceAt < 0) continue;
    const head = block.slice(0, braceAt);
    const body = block.slice(braceAt + 1);
    if (head.split(',').some(s => s.trim() === `.${selector}`)) out.push(body);
  }
  return out.join('\n');
}

it('底部操作栏左对齐：跟上方内容同一条左线', () => {
  const rule = ruleOf('file-detail-actions');
  assert.ok(rule, '找不到 .file-detail-actions 规则');
  assert.doesNotMatch(rule, /justify-content:\s*flex-end/,
    '底部按钮还是右对齐 —— 跟上方左对齐的内容对不上，就是用户说「有点丑」的那处');
  assert.match(rule, /justify-content:\s*flex-start|justify-content:\s*left/,
    '底部按钮没有明确左对齐');
});

it('危险动作推到最右：删文件的按钮不和「重新上传」挤在一起', () => {
  /* 危险按钮在 markup 里带上一个标记，样式用它推到最右
     （class 与 data-* 的先后顺序不固定，两种都认） */
  const dangerButton = (attr: string) =>
    new RegExp(`<button[^>]*class="[^"]*file-detail-danger[^"]*"[^>]*${attr}|<button[^>]*${attr}[^>]*class="[^"]*file-detail-danger`).test(DETAIL);
  assert.ok(dangerButton('data-recycle'),
    '「移入回收站」按钮没有标成危险动作（没法推到最右）');
  assert.ok(dangerButton('data-restore'),
    '「恢复文件」按钮没有标成危险动作');
  // 危险动作的规则是**后代选择器**（`.file-detail-actions .file-detail-danger`），
  // 跟 `.file-detail-actions` 自己那条不是同一块 —— 要单独取。
  const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const dangerRule = clean.split('}').find(b => {
    const at = b.lastIndexOf('{');
    return at >= 0 && b.slice(0, at).split(',').some(s => s.trim() === '.file-detail-actions .file-detail-danger');
  });
  assert.ok(dangerRule, '样式里没有把危险动作推到最右的规则（.file-detail-actions .file-detail-danger）');
  assert.match(dangerRule, /margin-left:\s*auto/, '危险动作没有靠 auto 推到最右');
});

it('护栏：四个操作入口一个不少，「下载」还是真链接', () => {
  assert.match(DETAIL, /data-reupload[^>]*>重新上传</, '「重新上传」入口不见了');
  assert.match(DETAIL, /data-current-download[^>]*download[^>]*>下载</, '「下载」入口不见了');
  assert.match(DETAIL, /data-recycle[^>]*>移入回收站</, '「移入回收站」入口不见了');
  assert.match(DETAIL, /data-restore[^>]*>恢复文件</, '「恢复文件」入口不见了');
  /* 下载是 <a href download>，不是 <button> */
  assert.match(DETAIL, /<a class="btn" data-current-download href="\$\{href\(shown\)\}" download>/,
    '「下载」不是真链接（href + download）');
});

it('护栏：危险按钮的行为绑定一个字没改', () => {
  assert.match(DETAIL, /\$\('\[data-recycle\]'\)\.onclick/, '「移入回收站」的行为绑定不见了');
  assert.match(DETAIL, /data-recycle[^>]*>/, '「移入回收站」按钮不见了');
  assert.match(DETAIL, /files\.recycle/, '回收站动作不见了');
});

it('护栏：上传完不自动打开详情（用户明确要求保持现状）', () => {
  /* 上传成功后只是回列表，不去开详情 */
  assert.doesNotMatch(CENTER, /openFileCenterDetail\?\(\{[^}]*upload/i,
    '上传完自动打开详情了 —— 用户要求保持现状');
  const uploadDone = CENTER.slice(CENTER.indexOf('realAction(\'files.upload\''), CENTER.indexOf('realAction(\'files.upload\'') + 900);
  assert.doesNotMatch(uploadDone, /openFileCenterDetail/,
    '上传完成后调用了打开详情 —— 用户要求保持现状');
});
