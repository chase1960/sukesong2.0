// 判据：**邮件页切到「发信候选（待审）」那一档 ⇒ 候选队列要真拉到数据**（2026-10-30 真站撞出来的）。
//
// **测试通过 = 什么成立**（一句话）
// 「① 槽位**默认藏着**（`hidden`）⇒ 那一趟**不拉**（省掉白花开销）；
//   ② 用户在邮件页的下拉里**切到「发信候选（待审）」那一档** ⇒ 槽位**露出来**
//   ⇒ **队列拉到数据**（那一档**不是空的**）；
//   ③ 拉到了 ⇒ **只写一格**（不整行铺）——省得那一档被人当成邮件列表。」
//
// ⚠️ **为什么要有这一份**：2026-10-30 真站实测撞出来的**真回归** ——
//   · 邮件页的候选槽位是 `<div id="mail-candidates" hidden>` ⇒ **默认藏着**
//     （用户没切到那一档时，它整块藏着，不许在别的档里冒出来）；
//   · 域的 `MutationObserver` 只观察 `childList` ⇒ **切档时 `hidden` 属性变了、
//     但没有新节点** ⇒ **不触发** ⇒ 队列**不拉**；
//   · 于是「那一档拉到的数据」只能靠**开机那趟**先拉一次 ⇒ 而开机那趟
//     **槽位还藏着** ⇒ 被「不在屏上就不拉」那道闸挡住 ⇒ **切出来是空的**。
//
// ⇒ **两处一起改**（缺一不可）：
//   · **闸保留**：槽位**藏着**时**不拉**（那一趟的数据现在没人看 ⇒ 省掉）；
//   · **Observer 要看得见 `hidden` 属性变化** ⇒ 切档时**触发** ⇒ **拉到数据**。
//
// ⚠️ **不许退回「开机就拉」**：那是白花开销（表格页根本用不着邮件的待审清单）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const QUEUE = new URL('../domains/mail/mail-review-queue.js', import.meta.url);
const MAIL_CENTER = new URL('../mail-center.js', import.meta.url);
const queue = fs.readFileSync(QUEUE, 'utf8');
const center = fs.readFileSync(MAIL_CENTER, 'utf8');

test('① 槽位**默认藏着**（不切档就不露出来）', () => {
  assert.match(center, /id="mail-candidates"[^>]*\bhidden\b/,
    '邮件页的候选槽位不是**默认藏着**的 ⇒ 「不在屏上就不拉」那道闸就判不出来');
  assert.match(center, /slot\.hidden\s*=\s*!candidatesOn/,
    '槽位的显隐没有跟着「发信候选（待审）」那一档走 ⇒ 切档了也不露');
  assert.match(center, /candidatesOn\s*=\s*box\s*===\s*'candidates'/,
    '没有「发信候选（待审）」那一档的开关 ⇒ 判据没法验');
});

test('② 域的 Observer **看得见 `hidden` 属性变化**（切档时才会拉）', () => {
  assert.match(queue, /attributes:\s*true/,
    'Observer 没观察属性 ⇒ 切档时 `hidden` 变了它**不知道** ⇒ 队列不拉（那一档是空的）');
  assert.match(queue, /attributeFilter:\s*\[\s*['"]hidden['"]\s*\]/,
    '观察属性没收窄到 `hidden` ⇒ 任何属性变化都醒 ⇒ 白白重读');
  /* —— 属性观察时，records 里的 target 是**那个被改属性的元素** ——
     ⇒ 「动到邮件页」那道过滤要认得出它。 —— */
  assert.match(queue, /root\.contains\(target\)/,
    '「动到邮件页」那道过滤认不出属性变化的 target ⇒ 切档时仍被滤掉');
});

test('③ 闸保留：槽位**藏着**时不拉（有内容了才拉）', () => {
  assert.match(queue, /getClientRects\(\)\s*\.length\s*===\s*0/,
    '那道「不在屏上就不拉」的闸不见了 ⇒ 开机那趟又会白拉一次');
  /* —— 闸要在**拉之前**判（不是拉完才看） ——
     ⚠️ **找那次真正的请求**（`fetchJson(`）—— `action-proposals` 这个字样
     在**注释里**也有一处 ⇒ 拿它定位会指到注释上。 —— */
  const loadAt = queue.indexOf('async function load(');
  assert.ok(loadAt > 0, '找不到 load()');
  const body = queue.slice(loadAt, loadAt + 2200);
  const gateAt = body.indexOf('getClientRects');
  const fetchAt = body.indexOf('fetchJson(');
  assert.ok(gateAt >= 0 && fetchAt >= 0, 'load() 里没有那道闸或没有那次请求');
  assert.ok(gateAt < fetchAt, '那道闸排在请求**后面** ⇒ 白拉已经发生了');
});
