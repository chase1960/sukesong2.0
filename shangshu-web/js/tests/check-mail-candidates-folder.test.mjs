// 判据：邮件页的「发信候选（待审）」**并进「全部邮件」那个状态下拉**，
//   那个**独立摆出来的区块**（「发信候选 · 待审（0）」）不再单独占地方。
//
// **用户原话**（2026-10-24 22:3x 站上批注）：
//   「你说呢？」＋（指认下拉）「就是这里」。
//
// **测试通过 =**（一句话）
// 「邮件页那个状态下拉里**多一档『发信候选（待审）』**（原来那七档一个都没少、也没改名）；
//   页面上有一个**候选槽位**（`#mail-candidates`）—— 候选卡落在这一档里。」
//
// ⚠️ **断的是「页面上真的有什么」**：下拉那几档是把模板里那个 `<select>` **真解析出来**
//   一档一档数出来的（不是 grep 一个字符串）。
//
// ⚠️ **页脚那一句**（同一批里 **PKG-092-T05** 的那半）**不在这份判据里** ——
//   它自己一份：`check-mail-preview-footer.test.mjs`（断的是**页脚真的会显示什么**，
//   比这一份原来那条「整个文件里不许再有它」更硬）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const MAIL_SOURCE = new URL('../mail-center.js', import.meta.url);
const source = fs.readFileSync(MAIL_SOURCE, 'utf8');

/** 把页面模板里那个 `#mail-box` 下拉**真解析出来**：返回 [{value, label}]。 */
function mailBoxOptions() {
  const at = source.indexOf('id="mail-box"');
  assert.ok(at >= 0, '页面模板里找不到 #mail-box 那个下拉');
  const open = source.lastIndexOf('<select', at);
  const close = source.indexOf('</select>', at);
  assert.ok(open >= 0 && close > open, '页面模板里那个下拉不是一段完整的 <select>');
  const block = source.slice(open, close);
  const options = [];
  const pattern = /<option\s+value="([^"]*)"\s*>([^<]*)<\/option>/g;
  let match;
  while ((match = pattern.exec(block))) options.push({ value: match[1], label: match[2] });
  return options;
}

test('① 状态下拉里**多一档「发信候选（待审）」**（原来那七档一个没少）', () => {
  const options = mailBoxOptions();
  const values = options.map(option => option.value);
  assert.deepEqual(values.slice(0, 7), ['all', 'inbox', 'draft', 'queued', 'sent', 'failed', 'trash'],
    '原来那七档被动过了：' + JSON.stringify(options));
  const candidate = options.find(option => option.value === 'candidates');
  assert.ok(candidate, '下拉里没有「发信候选（待审）」那一档：' + JSON.stringify(options));
  assert.equal(candidate.label, '发信候选（待审）',
    '那一档的名字不对：' + candidate.label + '（人得看得懂那一档是什么）');
});

test('② 页面里有一个**候选槽位**（候选卡落在这一档里，不再单独摆一个区块）', () => {
  assert.ok(source.includes('id="mail-candidates"'),
    '页面里没有候选槽位（#mail-candidates）—— 候选卡没有地方落');
});
