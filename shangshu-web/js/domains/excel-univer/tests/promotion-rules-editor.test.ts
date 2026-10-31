import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require_ = createRequire(new URL('../../../../../shangshu-server/package.json', import.meta.url));
const {JSDOM} = require_('jsdom') as typeof import('jsdom');

import {
  PROMOTION_COLUMN_TYPES, buildPromotionRulesEditor, promotionRuleFor, validatePromotionRules,
} from '../src/promotion-rules-editor.ts';

/**
 * **工程晋升设置**：逐列的**类型与规则**（PKG-126-T04 · 2026-10-27）。
 *
 * **为什么要有**：建表那条路（`files.create` → `files.promotion_define`）里，
 * **每一列的类型是写死的 `type:'text'`**（`db-capabilities.ts:779`），
 * 规则（`rules.min/max/options/allow_custom`）**根本没人能填** ⇒
 * 受管列天生是自由文本：**日期列没有日历、布尔列分不出未填／否、数值列不校验、枚举列给不出下拉**。
 * （PKG-126-T01/T02 那两列的值域是**事后**挂上去的，不是建表时声明的。）
 *
 * **测试通过 = 下面全部成立**：
 *  1. **类型清单与服务端一致** —— 服务端 `promotion_records.py:35` 的 `TYPE_MAP`
 *     只认 `text`／`long_text`／`number`／`date`／`boolean` ⇒ 编辑器**不多给也不少给**
 *     （多给一个，服务端当场拒「晋升列类型不受支持」）；
 *  2. 每一列都能选类型 ＋ 填规则；**没动过的列按「文字」**
 *     （与改之前一致：不选类型 ⇒ 全列都是文字，不替人挑）；
 *  3. **校验与服务端同一口径**（不是前端自创的规矩）：
 *     · 类型不在清单里 ⇒ 当场拒；
 *     · **数值上下限只许给「数字」列**（服务端 `promotion_records.py:80-82`：
 *       「晋升列 %s 的数值上下限不适用于该类型」）；
 *     · **取值清单给了就必须非空**（服务端 `:107-110`：「值域清单必须是非空的列表」）；
 *     · 清单**不写 `allow_custom` 就是不拦**（服务端 `:111-113`：没写＝True）；
 *  4. 读出来的是**声明形状**（`{header, type, rules}`），能直接进
 *     `files.promotion_define` 的 `definition.columns`；
 *  5. 建表那一步真的把这份声明带上了（**不再一律 `type:'text'`**），
 *     而**没给规则的老调用方行为一个字不变**；
 *  6. 页面真的接上了（建表弹窗里有这一块）。
 */

const CAPABILITIES = readFileSync(new URL('../src/db-capabilities.ts', import.meta.url), 'utf8');
const CAPABILITY_UI = readFileSync(new URL('../src/db-capability-ui.ts', import.meta.url), 'utf8');
/** 服务端那份类型表（判据要对着它，不是对着前端自己抄的那份）。 */
const SERVER_TYPES = readFileSync(
  new URL('../../../../../frappe_apps/shangshu_core/shangshu_core/promotion_records.py', import.meta.url),
  'utf8',
);

function dom() {
  const jsdom = new JSDOM('<!doctype html><html><body></body></html>');
  return jsdom.window.document;
}

it('① 类型清单与服务端 TYPE_MAP 一致（不多给也不少给）', () => {
  const serverKeys = Array.from(SERVER_TYPES.matchAll(/^\s*"([a-z_]+)":\s*"[a-z_]+",/gm)).map(m => m[1]);
  const ours = PROMOTION_COLUMN_TYPES.map(item => item.value);
  assert.deepEqual(ours, ['text', 'long_text', 'number', 'date', 'boolean'],
    '前端给的类型与服务端认的不一致（服务端当场拒「晋升列类型不受支持」）');
  for (const key of ours) {
    assert.ok(serverKeys.includes(key), `服务端 TYPE_MAP 里没有 ${key} ⇒ 服务端会拒`);
  }
  assert.ok(!ours.includes('integer'), '服务端 TYPE_MAP 没有 integer（number → decimal）');
});

it('② 没动过的列按「文字」；动了的列按人选的来', () => {
  const doc = dom();
  const editor = buildPromotionRulesEditor(doc, ['申请日', '是否结案']);
  const rules = editor.read();
  assert.equal(rules.length, 2, '读出来的列数不对');
  assert.equal(rules[0].header, '申请日');
  assert.equal(rules[0].type, 'text', '没动过的列不该被挑成别的类型');
  assert.equal(rules[0].rules, undefined, '没填规则就不该带 rules 键');

  const dateSelect = editor.element.querySelector('[data-column="申请日"] select[data-role="type"]') as HTMLSelectElement;
  assert.ok(dateSelect, '没有选类型的下拉');
  dateSelect.value = 'date';
  const again = editor.read();
  assert.equal(again[0].type, 'date', '选了日期还是读成文字');
});

it('③ 校验与服务端同一口径：类型非法／上下限给错类型／空清单 ⇒ 当场拒', () => {
  const headers = ['申请日', '金额', '状态'];
  // 类型不在清单里。
  assert.throws(() => validatePromotionRules([{header: '申请日', type: 'int', rules: {}}], headers),
    /类型/, '类型不在清单里没有当场拒');
  // 数值上下限只许给数字列（服务端 `_constraints` 那条）。
  assert.throws(() => validatePromotionRules([{header: '申请日', type: 'date', rules: {min: 1}}], headers),
    /上下限/, '日期列给了数值上下限没有当场拒');
  assert.doesNotThrow(() => validatePromotionRules([{header: '金额', type: 'number', rules: {min: 1, max: 9}}], headers),
    '数字列的上下限被拒了');
  // 取值清单给了就必须非空（服务端 `_value_domain` 那条）。
  assert.throws(() => validatePromotionRules([{header: '状态', type: 'text', rules: {options: []}}], headers),
    /清单/, '空清单没有当场拒');
  // 列名对不上。
  assert.throws(() => validatePromotionRules([{header: '不存在的列', type: 'text', rules: {}}], headers),
    /列/, '多出来的列没有当场拒');
});

it('③b 清单**不写 allow_custom** 就是不拦；写了 false 才是硬拦', () => {
  const headers = ['状态'];
  const rules = promotionRuleFor('状态', 'text', {options: ['受理', '实审']});
  assert.equal(rules.rules?.allow_custom, undefined,
    '没写 allow_custom 却替他写了（服务端「没写＝不拦」）');
  const strict = promotionRuleFor('状态', 'text', {options: ['受理'], allow_custom: false});
  assert.equal(strict.rules?.allow_custom, false, '显式 false 没能带出去');
});

it('④ 读出来的是**声明形状**（能直接进 definition.columns）', () => {
  const doc = dom();
  const editor = buildPromotionRulesEditor(doc, ['金额', '状态']);
  const type = editor.element.querySelector('[data-column="金额"] select[data-role="type"]') as HTMLSelectElement;
  type.value = 'number';
  type.dispatchEvent(new type.ownerDocument.defaultView!.Event('change'));
  const min = editor.element.querySelector('[data-column="金额"] input[data-role="min"]') as HTMLInputElement;
  min.value = '1';
  const max = editor.element.querySelector('[data-column="金额"] input[data-role="max"]') as HTMLInputElement;
  max.value = '99';
  const status = editor.element.querySelector('[data-column="状态"] select[data-role="type"]') as HTMLSelectElement;
  status.value = 'text';
  const options = editor.element.querySelector('[data-column="状态"] textarea[data-role="options"]') as HTMLTextAreaElement;
  options.value = '受理\n实审';

  const rules = editor.read();
  const amount = rules.find(rule => rule.header === '金额');
  assert.equal(amount?.type, 'number');
  assert.equal(amount?.rules?.min, 1, '下限没读成数字');
  assert.equal(amount?.rules?.max, 99);
  const state = rules.find(rule => rule.header === '状态');
  assert.deepEqual(state?.rules?.options, ['受理', '实审'], '清单没按行拆开');
});

it('④b **没声明清单的列不给下拉** ⇒ 声明里不许出现 options 键', () => {
  // 上一窗补的缺口（2026-10-28 凌晨主控补上）：行为本来就对，
  // 但**没有一条断言钉住它** ⇒ 以后有人改坏了不会红。
  //
  // **为什么这一条重要**：服务端口径是「`rules.options` **非空**才算值域」
  // （`promotion_records._value_domain`：空清单当场拒；不写这个键＝没有值域）
  // ⇒ 前端若给「是否结案」这种**没声明清单**的列也带上 `options`，
  //   要么服务端拒、要么服务端给它开出一个**不该有的下拉**。
  const doc = dom();
  const editor = buildPromotionRulesEditor(doc, ['金额', '是否结案']);
  const amount = editor.element.querySelector('[data-column="金额"] select[data-role="type"]') as HTMLSelectElement;
  amount.value = 'number';
  amount.dispatchEvent(new amount.ownerDocument.defaultView!.Event('change'));
  const options = editor.element.querySelector('[data-column="是否结案"] textarea[data-role="options"]') as HTMLTextAreaElement;
  options.value = '';                      // **没给清单**
  const closed = editor.element.querySelector('[data-column="是否结案"] input[data-role="allow-custom"]') as HTMLInputElement;
  if (closed) closed.checked = true;      // 勾着＝不拦＝**不写 allow_custom**

  const rules = editor.read();
  const row = rules.find(rule => rule.header === '是否结案');
  assert.ok(row, '「是否结案」这一列没读出来');
  assert.ok(!row.rules || !('options' in row.rules),
    '没声明清单的列，声明里不该出现 options 键（否则服务端会给它开下拉）');
  assert.ok(!row.rules?.options?.length, '没声明清单的列不该带出任何选项');
  // 勾着「允许填写清单以外的值」⇒ 也不该写 allow_custom（服务端口径：没写＝不拦）
  assert.ok(!row.rules || !('allow_custom' in row.rules),
    '没勾「取消勾选」就不该写 allow_custom');
  // 对照组：**给了**清单的列，options 一定要在
  const given = editor.element.querySelector('[data-column="金额"] textarea[data-role="options"]') as HTMLTextAreaElement;
  given.value = '受理\n实审';
  const withList = editor.read().find(rule => rule.header === '金额');
  assert.deepEqual(withList?.rules?.options, ['受理', '实审'], '给了清单的列，options 反而没写进去');
});

it('⑤ 建表那一步带上了这份声明；**没给规则的老调用方一个字不变**', () => {
  // 不再一律 text。
  assert.ok(!/type:\s*'text',\s*\n\s*promoted:\s*true/.test(CAPABILITIES),
    '建表那一步还是一律 type:text（逐列类型没带上）');
  assert.match(CAPABILITIES, /columnRules|PromotionColumnRule/, '建表那一步没接逐列声明');
  // 没给声明时仍然落到「文字」（老行为不变）。
  assert.match(CAPABILITIES, /type:\s*rule\s*&&\s*rule\.type\s*\?\s*rule\.type\s*:\s*'text'/,
    '没给逐列声明时没有回落到「文字」');
  // 规则也要跟着声明带上去（服务端认 `rules`）。
  assert.match(CAPABILITIES, /rules/, '逐列规则没随声明带上去');
});

it('⑥ 页面真的接上了：建表弹窗里有「类型与规则」这一块', () => {
  assert.match(CAPABILITY_UI, /buildPromotionRulesEditor/, '建表弹窗没挂逐列类型/规则编辑器');
  assert.match(CAPABILITY_UI, /validatePromotionRules/, '建表弹窗提交前没校验逐列声明');
  assert.match(CAPABILITY_UI, /columnRules/, '建表弹窗没把声明带上去');
});
