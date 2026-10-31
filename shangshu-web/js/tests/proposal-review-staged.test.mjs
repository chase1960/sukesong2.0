// 判据：**聊天里那张「修改审核」卡**要认得「暂存」这一档（PKG-118-T01 · 公共壳补第三处入口）。
//
// **测试通过 =**（一句话）
// 「一项候选在表格里暂存过（内核给 `status:'staged'` ＋ `staged_value`）⇒
//   聊天那张卡上 **① 状态标签写中文「已暂存」**（不是露出英文 `staged`）；
//   **② 那一项显示的是 `staged_value`**（暂存时人改过的那个值 —— 不是没改过的 `unit.value`，
//   那正是内核 `proposal_review.py` 明写「少了它前端会显示假值」的那个键）；
//   **③ 那一项也有「保存此项」按钮**（暂存过的项在聊天卡里**能采用**，不能卡死）。」
//
// ⚠️ **为什么补这一条**：暂存是**后端的一份状态**（契约 §staged_tier「跨入口共享一份」）。
//   表格工作面（域内浮层）与审核中心弹窗（公共壳）都认得了；
//   聊天里这张卡（`shangshu-web/js/proposal-review.js`，`index.html` 全站加载）
//   **还不认** ⇒ 同一份暂存状态在聊天里显示成**另一个值** ＋ 一个**英文标签**。
//   路径：`real-chat.js` 对 `review_supported` 的提案走这张卡。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SOURCE = fs.readFileSync(new URL('../proposal-review.js', import.meta.url), 'utf8');

test('① 状态标签映射里有「已暂存」这一档（不许露出英文 `staged`）', () => {
  const map = SOURCE.match(/\{[^{}]*accepted:[^{}]*pending:[^{}]*\}/);
  assert.ok(map, '找不到审核项状态标签的那张映射表');
  assert.match(map[0], /staged:\s*'已暂存'/,
    '状态标签映射里没有「已暂存」这一档 ⇒ 暂存过的项在聊天卡上会露出英文 `staged`：' + map[0]);
});

test('② 暂存过的项显示的是 `staged_value`（不是没改过的 `unit.value` 那个假值）', () => {
  assert.match(SOURCE, /staged_value/,
    '聊天卡没有读 `staged_value` ⇒ 暂存时人改过的值在聊天里看不见（显示的是没改过的候选）');
  /* 取值那一行必须**先看暂存值**再看原候选。 */
  const pick = SOURCE.match(/unit\.staged_value[^;\n]*unit\.value/);
  assert.ok(pick,
    '取值那一行不是「先 `staged_value`、后 `unit.value`」的次序 ⇒ 暂存项会显示成没改过的候选');
});

test('③ 暂存过的项也能「保存此项」（采用按钮对它也出现）', () => {
  assert.match(SOURCE, /unit\.status\s*===\s*'pending'\s*\|\|[\s\S]{0,40}unit\.status\s*===\s*'staged'/,
    '「保存此项」按钮只给 `pending` ⇒ 暂存过的项在聊天卡里**永远采用不了**（只能去表格那侧或审核中心）');
});
