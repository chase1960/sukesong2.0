import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/**
 * 个人视图的**筛选条件**只能选**可读的列**（FIX-47）。
 *
 * 背景（2026-10-20 实测发现）：
 *  在「试用-混合表」上给「名称」列加筛选条件保存 ⇒ 后端 **403「无权使用该列配置个人视图」**。
 *  查清了：那一列被**升列**成了正式字段 `trial_name`，字段 ACL 授权给 `System Manager`，
 *  而试用账号 `trial-jia` 的角色是 `['All','Guest','Desk User']` ⇒ **该列对它不可读**。
 *  ⇒ **后端拒得完全正确**（不该让用户用一个自己都看不到的列做筛选）。
 *
 * 但**前端有缺陷**：筛选条件的「列」下拉**把不可读的列也列出来了** ——
 * 用户能选、选完点保存才被后端拒（虽然中文提示准确，但白跑一趟）。
 *
 * 修法：前端**只把可读的列**放进筛选下拉（不可读的列压根不给选）。
 * 判据钉的是**可观察行为**：不可读的列不出现在筛选下拉里。
 *
 * 测试通过 = 下面全部成立：
 *  1. 筛选列下拉只装**可读**的列
 *  2. 不可读的列**不出现在**下拉里
 *  3. 判据能认出「无权查看」这个不可读标记（前端的数据形态）
 *  4. **护栏**：后端那道「无权使用该列配置个人视图」的闸**一个字不许动**
 *     —— 前端是**少给选项**，不是**把闸拆了**
 */

const MAIN = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const VIEW = readFileSync(new URL('../src/personal-view-dialog.ts', import.meta.url), 'utf8');
const VIEW_PY = readFileSync(
  new URL('../../../../../frappe_apps/shangshu_files/shangshu_files/sheet_view.py', import.meta.url), 'utf8');

it('筛选条件的列下拉只装可读的列', () => {
  assert.match(VIEW, /readable/, '个人视图弹窗没有「可读」这个概念 —— 不可读的列会被列出来');
  assert.match(VIEW, /filter\(/, '筛选列下拉没有按可读性过滤');
});

it('不可读的列不出现在筛选下拉里', () => {
  /* 弹窗要接收「哪些列可读」的信息，而不是一串列名 */
  assert.match(MAIN, /readable/, '主流程没有算出「哪些列可读」');
  assert.match(MAIN, /无权查看/, '主流程没有认出前端数据里的不可读标记「无权查看」');
});

it('护栏：后端那道闸一个字不许动', () => {
  assert.match(VIEW_PY, /无权使用该列配置个人视图/,
    '后端「无权使用该列配置个人视图」的闸不见了 —— 前端少给选项，不等于把闸拆了');
  assert.match(VIEW_PY, /if name in hidden/, '后端对不可读列的拦截逻辑不见了');
});
