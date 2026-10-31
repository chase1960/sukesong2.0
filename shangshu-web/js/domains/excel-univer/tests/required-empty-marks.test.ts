/**
 * 判据：**必填列空着 ⇒ 框红 ＋ toast 提醒，但不拦保存**（2026-10-30 用户口径），
 * **而且框要「增量」——翻页后前面页的红框不许消失**（2026-10-30 用户点名的正确性缺陷）。
 *
 * **用户原话**：
 * 「有必填列的表的空行，在行写入保存的时候要 check 必填列是否为空，
 *   如果空了就**把必填列给框起来用红色**，并且在 **toast 提醒**，
 *   但是**不强制不能保存**（因为我一行要一个格子一个格子输入），
 *   然后**每一次刷新都自检一下**必填列有没有被填入，
 *   没有被填入就**用红色继续框和提醒**。」
 * 「**改红框为增量**（这是**正确性缺陷**：**翻页后前面页的红框会消失**）。」
 * 「这个框能不能走 univer 原生，直接一个**半透明的红底**？——**参照列头绿底**。」
 *
 * **测试通过 = 什么成立**（一句话）：
 * 「① **算出**哪些格是『空的必填格』（纯函数，算得准）；
 *   ② 那些格**被画上红底**（Univer 原生、**半透明**、不是一圈粗描边）；
 *   ③ **写保存之后**要 **toast 提醒**（说清缺哪几列）；
 *   ④ **每一次刷新**都**重新自检**（刷新后缺的那些**继续**红框 ＋ 继续提醒），
 *   填上了就**不再**红框也不再提醒；
 *   ⑤ **翻页（装填新一页的行）之后，前面页那些空的必填格**：
 *      **清单里还在**（没被覆盖掉）、**框也还在**（没被摘掉）——
 *      这就是用户说的『**改红框为增量**』；
 *   ⑥ **填上了那一格** ⇒ 只摘那一格；**行没了** ⇒ 那一行的框摘掉；
 *      **换表** ⇒ 旧表的红框不许跟到新表上。」
 *
 * ⚠️ **为什么「算」要抽成纯函数**：
 * 「哪些格是空的必填格」这件事**不碰画布、不碰网络** ⇒ 抽出来就能离线钉准；
 * 画布那一侧（真画红底）用源码级 + 真站浏览器钉。
 *
 * ⚠️ **为什么「累积账」也是纯函数**（`RequiredEmptyLedger`）：
 * 「红框要增量」这件事的**难点在「别覆盖前面的」**——
 * 表格中心是**按页装填**的（每装一页只带着**这一页的行**来）⇒
 * 若直接覆盖清单 ⇒ **翻页就把前面页的空必填格挤掉了**（用户说的那个缺陷）。
 * ⇒ 账本**只进不出**：新一页并进来、填上的就地改、行没了才摘。
 * 纯函数 ⇒ **离线就能钉准**（不用开浏览器）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

import {
  emptyRequiredCells,
  requiredReminderText,
  RequiredEmptyLedger,
  REQUIRED_EMPTY_HIGHLIGHT,
} from '../src/required-marks.ts';

/* ───────────────── ① 算：哪些格是「空的必填格」 ───────────────── */

// —— 必填列的**身份**（表头名 ＋ 字段 id）——
//   ⚠️ **网格那一侧的列 `fieldId` 就是表头名**（`backend.ts` 的 `gridColumn`
//   把 `fieldId` 设成 `column.header`）—— **不是**受管字段 id（`case_direction` 那种）。
//   ⚠️ **踩过**：一开始这里用的是受管字段 id ⇒ 红框**找不到那一列** ⇒ **画不出来**
//   ⇒ 而诊断口却报「框了 N 格」⇒ **假绿**。⇒ 这条钉住「fieldId 必须是表头名」。
const REQUIRED = [
  { label: '业务方向', fieldId: '业务方向' },
  { label: '申请渠道', fieldId: '申请渠道' },
];

/** 账本里塞一批行（**分页装填**就是一批一批来）。 */
function seed(ledger: RequiredEmptyLedger, startRow: number, rows: number, empty = true) {
  ledger.merge(
    Array.from({ length: rows }, (_, i) => ({
      rowIndex: startRow + i,
      values: empty
        ? { 业务方向: '', 申请渠道: '' }
        : { 业务方向: 'DD', 申请渠道: 'F' },
    })),
  );
}

test('① 必填列空着 ⇒ 那两格被算出来', () => {
  const marks = emptyRequiredCells(
    [{ rowIndex: 0, values: { 申请编号: 'A', 业务方向: '', 申请渠道: '' } }],
    REQUIRED,
  );
  assert.equal(marks.length, 2, '两个必填列都空着 ⇒ 两个格都要标：%r', marks);
  assert.deepEqual(marks.map((m) => m.fieldId).sort(), ['业务方向', '申请渠道']);
});

test('② 必填列填上了 ⇒ 不标（填齐了就不再红）', () => {
  const marks = emptyRequiredCells(
    [{ rowIndex: 0, values: { 业务方向: 'DD', 申请渠道: 'F' } }],
    REQUIRED,
  );
  assert.equal(marks.length, 0, '填齐了还标 ⇒ 提醒停不下来：%r', marks);
});

test('③ 只有空白的（只有空格）也当空', () => {
  const marks = emptyRequiredCells(
    [{ rowIndex: 0, values: { 业务方向: '   ', 申请渠道: 'F' } }],
    REQUIRED,
  );
  assert.equal(marks.length, 1, '只有空格也算空：%r', marks);
  assert.equal(marks[0].fieldId, '业务方向');
});

test('④ 非必填列空着不标（只标必填的那些）', () => {
  const marks = emptyRequiredCells(
    [{ rowIndex: 0, values: { 申请编号: '', 业务方向: 'DD', 申请渠道: 'F' } }],
    REQUIRED,
  );
  assert.equal(marks.length, 0, '自由列空着不该被标：%r', marks);
});

test('⑤ 多行多列都要算出来（刷新自检要一次算全表）', () => {
  const marks = emptyRequiredCells(
    [
      { rowIndex: 0, values: { 业务方向: '', 申请渠道: '' } },
      { rowIndex: 1, values: { 业务方向: 'DD', 申请渠道: '' } },
      { rowIndex: 2, values: { 业务方向: 'DD', 申请渠道: 'F' } },
    ],
    REQUIRED,
  );
  assert.equal(marks.length, 3, '第 0 行两格 ＋ 第 1 行一格：%r', marks);
});

/* ───────────────── ② 红底：Univer 原生、半透明（参照列头绿底） ───────────────── */

test('⑥ 红底是 Univer 原生的半透明填充（不是一圈粗描边）', () => {
  const style = REQUIRED_EMPTY_HIGHLIGHT;
  // —— 半透明红底（用户原话：「直接一个半透明的红底」「参照列头绿底」）——
  const fill = String(style.fill || '');
  assert.match(fill, /^rgba\(/, '红底不是 rgba 半透明填充：%r', style.fill);
  const alpha = Number(fill.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\)/)?.[1]);
  assert.ok(alpha > 0 && alpha < 1, '红底要半透明（字还得看得见）：%r', style.fill);
  // —— 描边只留极淡的一圈（用户说过不要「一圈刺眼粗描边」）——
  assert.ok(Number(style.strokeWidth) <= 1, '描边太粗了：%r', style.strokeWidth);
  assert.match(String(style.stroke), /rgba\(/, '描边不是半透明：%r', style.stroke);
  // —— 红色（与「必填列头那颗红星」同一族 ⇒ 一眼认得出是同一件事）——
  assert.match(String(style.fill), /220,\s*38,\s*38/, '红底颜色不对：%r', style.fill);
});

/* ───────────────── ③ toast 提醒：说清缺哪几列 ───────────────── */

test('⑦ 提醒说清缺哪几列（人话，不说「校验失败」）', () => {
  const text = requiredReminderText(['业务方向', '申请渠道']);
  assert.ok(text.includes('业务方向'), '提醒里没有说清缺哪列：%r', text);
  assert.ok(text.includes('申请渠道'), '提醒里没有说清缺哪列：%r', text);
  assert.ok(/必填/.test(text), '提醒里没说是「必填」：%r', text);
  // —— **只留一句**（2026-10-30 用户口径：「toast 那里必填项解释也过多了，
  //   就保留『xxx 必填项未填』」）⇒ 不解释「可以先存，填完再补」那套 ——
  assert.equal(text, '业务方向、申请渠道必填项未填', '提醒文案不是「xxx必填项未填」：%r', text);
});

test('⑧ 一个都不缺 ⇒ 没有提醒（不吵人）', () => {
  assert.equal(requiredReminderText([]), '');
});

/* ───────────────── ④ 增量：翻页后前面页的红框不许消失 ───────────────── */

test('⑨ 装填新一页 ⇒ 前面页的空必填格**还在**清单里（这就是「增量」）', () => {
  const ledger = new RequiredEmptyLedger();
  seed(ledger, 0, 3);        // 第 1 页：第 0..2 行
  seed(ledger, 100, 2);      // 第 2 页：第 100..101 行（表格中心按页装填）
  const marks = ledger.marks(REQUIRED);
  const rows = new Set(marks.map((m) => m.rowIndex));
  assert.ok(rows.has(0), '第 1 页的空必填格被覆盖掉了（用户说的那个缺陷）：%r', [...rows]);
  assert.ok(rows.has(2), '第 1 页最后一行不见了：%r', [...rows]);
  assert.ok(rows.has(100), '第 2 页的空必填格没进来：%r', [...rows]);
  assert.equal(marks.length, 10, '3 行 ＋ 2 行，每行两格：%r', marks.length);
});

test('⑩ 填上那一格 ⇒ 只摘那一格，别人的框还在', () => {
  const ledger = new RequiredEmptyLedger();
  seed(ledger, 0, 2);
  seed(ledger, 100, 1);
  // —— 第 0 行被填上了（只填了「业务方向」）——
  ledger.merge([{ rowIndex: 0, values: { 业务方向: 'DD', 申请渠道: '' } }]);
  const marks = ledger.marks(REQUIRED);
  const row0 = marks.filter((m) => m.rowIndex === 0);
  assert.equal(row0.length, 1, '填了一格还框两格：%r', row0);
  assert.equal(row0[0].fieldId, '申请渠道', '摘错了格子：%r', row0);
  assert.ok(marks.some((m) => m.rowIndex === 1), '别人的框被误摘了：%r', marks);
  assert.ok(marks.some((m) => m.rowIndex === 100), '别页的框被误摘了：%r', marks);
});

test('⑪ 行没了 ⇒ 那一行的框摘掉（别留下孤儿框）', () => {
  const ledger = new RequiredEmptyLedger();
  seed(ledger, 0, 2);
  seed(ledger, 100, 1);
  ledger.remove(0);
  const marks = ledger.marks(REQUIRED);
  assert.ok(!marks.some((m) => m.rowIndex === 0), '行没了框还在：%r', marks);
  assert.ok(marks.some((m) => m.rowIndex === 1), '别的行被误摘了：%r', marks);
});

test('⑫ 换表 ⇒ 旧表的红框不许跟到新表上', () => {
  const ledger = new RequiredEmptyLedger();
  seed(ledger, 0, 2);
  ledger.clear();
  assert.equal(ledger.marks(REQUIRED).length, 0, '换表了旧框还在：%r', ledger.marks(REQUIRED));
});

/* ───────────────── ⑤ 接线：主控与网格 ───────────────── */

test('⑬ 网格这一侧有「标空的必填格」这个口，且它画的是红底', () => {
  const source = fs.readFileSync(new URL('../src/sheet.ts', import.meta.url), 'utf8');
  assert.ok(/setRequiredEmptyMarks\s*\(/.test(source),
    '网格没有 setRequiredEmptyMarks 这个口（框红要画在网格那一侧）');
  // 它得**真的用**那个红底样式（不是只记个标记）。
  assert.ok(/REQUIRED_EMPTY_HIGHLIGHT/.test(source),
    'setRequiredEmptyMarks 没有用红底样式');
});

test('⑭ 网格这一侧是**增量**：不许「每次全量摘掉重画」', () => {
  const source = fs.readFileSync(new URL('../src/sheet.ts', import.meta.url), 'utf8');
  const layer = fs.readFileSync(new URL('../src/shape-layer.ts', import.meta.url), 'utf8');
  // —— 逐格效果都走**形状层**（成批 ＋ 没变不动）——
  assert.ok(/createShapeLayer/.test(source), '网格没有用「形状层」');
  assert.ok(/shapeLayer\.setGroup\('required-empty'/.test(source), '必填空的红底没走形状层');
  // —— **不许**每次开画都把上一次的框全摘掉 ——
  assert.ok(!/requiredEmptyMarks\.splice\(0\)/.test(source),
    '网格每次都把上一次的框全摘掉（那就是「翻页后前面页的框消失」的根因）');
  // —— 形状层里：批量口（一次重画画一整批）＋「变没变」的判断（不重算）——
  assert.ok(/highlightRanges/.test(layer),
    '形状层没用 Univer 的批量高亮口（一格一次重画 ⇒ 几十格就把主线程占住几秒）');
  assert.ok(/sameKeys/.test(layer), '形状层没有「变没变」的判断（每次都重算）');
});

test('⑮ 主控：用「累积账」而不是覆盖（翻页才不丢前面页）', () => {
  const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.ok(/RequiredEmptyLedger/.test(source), '主控没用「累积账」⇒ 翻页会覆盖掉前面页的清单');
  // —— fieldId 必须是**表头名**（网格那一侧的形状）——
  //   网格的列 `fieldId` **就是表头名**（`backend.ts` 的 gridColumn）——
  //   用受管字段 id（case_direction）⇒ 找不到那一列 ⇒ **红框画不出来**。
  assert.ok(/fieldId:\s*String\(col\.header\)/.test(source),
    '红框用的 fieldId 不是表头名（会画不到格子上，而诊断口却会说「框了」—— 假绿）');
});

test('⑯ 主控：写保存之后要提醒 ＋ 刷新之后要自检', () => {
  const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  // —— 写保存之后：提醒 ——
  assert.ok(/requiredReminderText/.test(source), '主控没用「提醒文案」那个函数');
  assert.ok(/RequiredEmptyLedger|emptyRequiredCells/.test(source), '主控没算「空的必填格」');
  // —— 刷新之后：自检（重算 ＋ 重画）——
  assert.ok(/setRequiredEmptyMarks\s*\(/.test(source),
    '主控没把「空的必填格」交给网格（刷新后就不会继续红框）');
});

test('⑱ 必填列清单：**并行取 ＋ 提前存住先顶上**（装饰不挡「打开到能编辑」）', () => {
  const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  // —— **并行**：不等读表完就去拉清单（xlsx 表的 key 就是文件 id）——
  assert.ok(/earlyPromotion/.test(source),
    '清单请求要等读表完才发起（⇒ 星号与红底白等几百毫秒）');
  // —— **提前存住**：上一轮存下来的那份**先顶上**，新的到了再替换 ——
  assert.ok(/promotionDefinitionCache/.test(source), '清单没有存住（每次开表都从零开始）');
  assert.ok(/promotionDefinitionCache\.get/.test(source), '缓存没被用上（存了不用等于没存）');
  assert.ok(/applyPromotionDefinition/.test(source), '清单没有「用上」的口（存了也画不出来）');
});

test('⑰ 判据自己钉住「不拦保存」那条（服务端那一侧）', () => {
  // 服务端那条判据在文件域：必填列空着**不拒**（只提醒）。
  const path = new URL(
    '../../../../../frappe_apps/shangshu_files/shangshu_files/promotion.py',
    import.meta.url,
  );
  const source = fs.readFileSync(path, 'utf8');
  const body = source.slice(source.indexOf('def _check_rules'));
  assert.ok(!/_reject\(header,\s*'不能为空'/.test(body.slice(0, 2500)),
    '文件域还在用「不能为空」拒必填列（那就把一格一格输入的路堵死了）');
});
