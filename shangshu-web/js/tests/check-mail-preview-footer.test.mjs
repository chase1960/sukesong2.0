// 判据：**邮件页那个页脚，正常状态下是空的**。
//
// **用户原话**（2026-10-24 22:33 站上批注，指着页脚那一句）：「**这个去掉**」。
// 改前那个位置写着：「每次同步收件箱最近 100 封中的最多 20 封，不改变原邮箱已读或删除状态。」
//
// **测试通过 =**（一句话）
// 邮箱**连接一切正常**（已绑定 ＋ 已启用 ＋ 没报错 ＋ 不在读）时，那个 `.preview-footer`
// **一个字都不显示**；而**出错／正在读／没绑定／已暂停**这四种情况**照旧还有话**
// （不许把整个页脚清空 —— 那几种时候人正需要知道出了什么事）；
// 那句同步说明**整个文件里一个字都不剩**。
//
// ⚠️ **断的是「页脚真的显示什么」**：那条文案链**抠出来真跑一遍**（各种状态各跑一次，
//   算出来的**生效值**），**不是** grep 一个字符串 —— 只 grep 的话，
//   把那句话换个说法照样过得去。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const MAIL_SOURCE = new URL('../mail-center.js', import.meta.url);
const source = fs.readFileSync(MAIL_SOURCE, 'utf8');

/** 那句同步说明（改前就在这儿）。 */
const SYNC_NOTE = '每次同步收件箱最近 100 封中的最多 20 封';

/**
 * 把页脚那条文案链**抠出来真跑一遍**：按给定状态算出**页脚真的会显示什么**。
 *
 * @param {{mailboxError?:string, accountError?:string, accountLoading?:boolean, bound?:boolean, enabled?:boolean}} state
 * @returns {string} 页脚上会出现的字（空串＝一个字都不显示）
 */
function footerText(state) {
  const marker = "$('.preview-footer').textContent=";
  const at = source.indexOf(marker);
  assert.ok(at >= 0, '页面里找不到页脚那行文案');
  const from = at + marker.length;
  const to = source.indexOf(';', from);
  assert.ok(to > from, '页脚那行文案不是一段完整的赋值');
  const expr = source.slice(from, to);
  const account = { bound: state.bound !== false, enabled: state.enabled !== false };
  const run = new Function('mailboxError', 'accountError', 'accountLoading', 'account', `return (${expr});`);
  return String(run(state.mailboxError || '', state.accountError || '', !!state.accountLoading, account) ?? '');
}

test('① 邮箱连接一切正常时，页脚一个字都不显示', () => {
  const text = footerText({});
  assert.equal(text, '',
    '连接正常时页脚还写着：' + text + '（用户 2026-10-24 22:33 说了「这个去掉」）');
});

test('② 出错／正在读／没绑定／已暂停 —— 这四种情况页脚照旧还有话', () => {
  assert.match(footerText({ mailboxError: '邮箱连接失败' }), /邮箱连接失败/,
    '邮箱出错了，页脚一个字都不说 —— 那时候人正需要知道出了什么事');
  assert.match(footerText({ accountError: '账号停了' }), /账号停了/,
    '账号出错了，页脚一个字都不说');
  assert.match(footerText({ accountLoading: true }), /正在读取/,
    '正在读邮箱，页脚一个字都不说 —— 人不知道页面上在干嘛');
  assert.match(footerText({ bound: false }), /绑定/,
    '邮箱还没绑定，页脚一个字都不说 —— 人不知道怎么才能用');
  assert.match(footerText({ enabled: false }), /暂停/,
    '收发已暂停，页脚一个字都不说 —— 人以为还能发');
});

test('③ 那句同步说明整个文件里一个字都不剩', () => {
  assert.ok(!source.includes(SYNC_NOTE),
    '「' + SYNC_NOTE + '……」还在（用户 2026-10-24 22:33 说了「这个去掉」）');
});
