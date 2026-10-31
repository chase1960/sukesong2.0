import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALIGN_LABELS,
  fontStyleToUniver,
  validateFontPatch,
  validateFontState,
  type CellFontStyle,
} from '../src/font-style';

/**
 * FIX-18：扩展单元格格式（填充色 / 斜体 / 下划线 / 对齐 / 清除格式）。
 * 判据（对用户看得见的现象）：
 *  ① 界面能提出这几种格式请求，合法值都放行；
 *  ② 非法值（错的颜色、错的对齐档位、混着提的清除格式）**当场挡住并给中文提示**，
 *     不把坏请求发给后端；
 *  ③ 回执里出现这几种属性时，校验不误判（后端回什么，前端都认）；
 *  ④ 这些样式翻译到网格引擎后，界面**真的看得出来**：
 *     底色、斜体、下划线、水平/垂直对齐都对得上。
 */
test('填充色/斜体/下划线/对齐的合法请求都放行', () => {
  const patch = validateFontPatch({
    fill_color: '#FFEE00', italic: true, underline: false,
    horizontal_align: 'center', vertical_align: 'top',
  });
  assert.equal(patch.fill_color, '#FFEE00');
  assert.equal(patch.italic, true);
  assert.equal(patch.underline, false);
  assert.equal(patch.horizontal_align, 'center');
  assert.equal(patch.vertical_align, 'top');
});

test('「无填充」用 none 表达（清掉底色）', () => {
  assert.equal(validateFontPatch({ fill_color: 'none' }).fill_color, 'none');
});

test('非法填充色当场挡住并给中文提示', () => {
  assert.throws(() => validateFontPatch({ fill_color: 'red' } as never), /填充色/);
  assert.throws(() => validateFontPatch({ fill_color: '#FFF' } as never), /填充色/);
});

test('非法对齐档位当场挡住', () => {
  assert.throws(() => validateFontPatch({ horizontal_align: 'middle' } as never), /水平对齐/);
  assert.throws(() => validateFontPatch({ vertical_align: 'left' } as never), /垂直对齐/);
});

test('清除格式不能与其他设置同时提（后端整包拒）', () => {
  assert.throws(() => validateFontPatch({ clear_format: true, italic: true }), /清除格式/);
  assert.equal(validateFontPatch({ clear_format: true }).clear_format, true);
});

test('斜体/下划线必须是布尔', () => {
  assert.throws(() => validateFontPatch({ italic: 'yes' } as never), /斜体/);
  assert.throws(() => validateFontPatch({ underline: 1 } as never), /下划线/);
});

test('回执里出现扩展属性时校验不误判', () => {
  const style: CellFontStyle = {
    font_size: 11, font_color: '#374151', bold: false, italic: true, underline: false,
    fill_color: '#FFEE00', horizontal_align: 'center', vertical_align: 'top',
    number_format: 'General', wrap_text: false,
  };
  assert.equal(validateFontState(style).italic, true);
  assert.throws(() => validateFontState({ ...style, fill_color: 'x' } as never), /填充色/);
  assert.throws(() => validateFontState({ ...style, horizontal_align: 'middle' } as never), /水平对齐/);
});

test('这些样式在网格里真的看得出来', () => {
  const univer = fontStyleToUniver({
    italic: true, underline: true, fill_color: '#FFEE00',
    horizontal_align: 'center', vertical_align: 'center',
  });
  assert.equal(univer.it, 1, '斜体');
  assert.deepEqual(univer.ul, { s: 1, c: 1 }, '下划线跟着字色');
  assert.deepEqual(univer.bg, { rgb: '#FFEE00' }, '底色');
  assert.equal(univer.ht, 'center', '水平居中');
  assert.equal(univer.vt, 'middle', '垂直居中（引擎叫 middle，xlsx 叫 center）');
});

test('清掉底色/对齐时给引擎的是 null（不是留着旧值）', () => {
  const univer = fontStyleToUniver({ fill_color: null, horizontal_align: null, vertical_align: null });
  assert.equal(univer.bg, null);
  assert.equal(univer.ht, null);
  assert.equal(univer.vt, null);
});

test('对齐选项表覆盖水平与垂直各四档', () => {
  const horizontal = ALIGN_LABELS.filter(item => item.key === 'horizontal_align').map(item => item.value);
  const vertical = ALIGN_LABELS.filter(item => item.key === 'vertical_align').map(item => item.value);
  assert.deepEqual(horizontal, ['left', 'center', 'right', 'none']);
  assert.deepEqual(vertical, ['top', 'center', 'bottom', 'none']);
});
