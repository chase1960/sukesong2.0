/**
 * 判据：**挪列只改「我的个人视图」**（2026-10-29 撤掉那条自造管线）。
 *
 * **测试通过 =**（一句话）
 * 「把一列挪到别处 ⇒ **只**写个人视图（`files.sheet_view_save`）；
 *   **整条链上**（表格层 → 后端桥 → 适配器）**没有任何一处**还能发出
 *   『改文件结构』的挪列请求（`files.sheet_column_move` 那种带
 *   `header`/`before_header` 的载荷）；
 *   界面上那一项**明说只影响我**。」
 *
 * ⚠️ **为什么钉这一条**（用户 2026-10-29 原话）：
 *   「挪列改个人视图（**现在改的是全表的，你拖了别人也跟着变**）⇒ 撤掉那条自造管线」。
 *   ⇒ 拖列的手势层当时另接了一条结构写路 ⇒ 物理改写 xlsx 的列 ⇒ 全表 everybody sees。
 *   ⇒ 现在那条路**从前端撤掉**：挪列只剩个人视图那一条。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const backend = read('../src/backend.ts');
const adapter = read('../src/adapter.ts');
const main = read('../src/main.ts');
const dialog = read('../src/structure-dialog.ts');
const drag = read('../src/column-drag.ts');

test('① 表格层**不再**有「挪列改文件结构」这条路', () => {
  // —— 契约里没有这一项（类型上就不许传）。
  const contract = backend.match(/structureAction\(kind:[^)]*\)/);
  assert.ok(contract, '表格层的结构动作契约不见了');
  assert.doesNotMatch(contract[0], /column_move/,
    '结构动作契约里还有「挪列」⇒ 那条改全表的路没撤干净：' + contract[0]);
  // —— 适配器里的载荷拼装也不许再按「挪列」拼 `header`/`before_header`。
  //    ⚠️ 只查**代码**（注释里可以写「原来有过这条路」，那是给人看的历史说明）。
  assert.doesNotMatch(adapter, /kind:\s*'[^']*column_move/,
    '适配器的动作种类里还有 column_move ⇒ 还能发出改文件结构的挪列请求');
  assert.doesNotMatch(adapter, /args\.kind\s*===\s*'column_move'/,
    '适配器还在按「挪列」分支拼载荷 ⇒ 还能发出改文件结构的挪列请求');
  assert.doesNotMatch(adapter, /before_header:\s*args\.before\b/,
    '适配器还在按「挪列」拼 before_header 载荷');
});

test('② 拖列那条手势**只**通往个人视图', () => {
  const mount = main.match(/mountColumnDrag\(el\.grid,\{[\s\S]*?\n {4}\}\)/);
  assert.ok(mount, '找不到拖列的接线');
  assert.match(mount[0], /onMove:\(header,before\)=>moveColumnInPersonalView\(header,before\)/,
    '拖列的落点没有通往个人视图保存：' + mount[0].slice(0, 400));
  assert.doesNotMatch(mount[0], /structureAction/,
    '拖列那条手势还接着改文件结构的动作');
});

test('③ 界面上那一项**明说只影响我**', () => {
  assert.match(dialog, /column_move','调整我的列顺序（只影响我）'/,
    '「行列操作」里那一项的文案没说清只影响自己');
  assert.doesNotMatch(dialog, /column_move','移动选中列'/,
    '旧的「移动选中列」文案还在（人会以为改的是全表）');
});

test('④ 手势层的说明不许再提「产品那条改结构的动作」', () => {
  assert.doesNotMatch(drag, /由调用方调/,
    '手势层头注释还在说「产品那条 files.sheet_column_move 由调用方调」（早就没人调了）');
  assert.match(drag, /只影响我/,
    '手势层头注释没写清「只影响我」');
});
