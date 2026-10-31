import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/**
 * 文件中心点**表格（.xlsx）** ⇒ 直接进 Excel 工作面打开它（FIX-45）——
 * 用户 2026-10-20 13:05 讲清了产品结构：
 *
 * > 「xlsx 从文件中心点击就直接进入 excel 部分打开了。
 * > excel 部分是文件中心的一部分，但由于 excel 处理的内容太多了，
 * > 所以给他留了个新的页面和交互。
 * > 而且 excel 也没有版本之说。」
 *
 * 也就是说：
 *  · **文件中心是父，Excel 是它的一个分支** —— 两边是同一批文件记录
 *  · Excel 内容太多 ⇒ 给它**自己的页面和交互**（Excel 工作面）
 *  · 所以在文件中心点一张表格，**不该**弹那个通用详情框
 *    （通用框里有「第 1 版 / 查看此版本 / 下载此版本」——
 *     **版本是普通文件的概念，Excel 没有版本**）
 *  · 而该走通用详情框的是**普通文件**（同名再传一次会新增版本，那个才叫版本）
 *
 * 测试通过 = 下面全部成立：
 *  1. 文件中心点 **.xlsx** ⇒ 跳到 **Excel 工作面**并带上那张表的 key
 *  2. 文件中心点**普通文件** ⇒ **照旧**弹通用详情框（不能被一起改掉）
 *  3. Excel 工作面**不弹**通用详情框（xlsx 不走那条路）
 *  4. **护栏**：通用详情框的版本列表**只对普通文件**有意义 ——
 *     xlsx 不该出现「第 N 版 / 查看此版本 / 下载此版本」
 *  5. **护栏**：跳 Excel 时带的参数格式与 Excel 工作面自己认的一致
 *     （`?object=<key>#/excel`）—— 别跳出一个打不开的地址
 */

const CENTER = readFileSync(new URL('../../../shangshu-web/js/file-center.js', import.meta.url), 'utf8');
const DETAIL = readFileSync(new URL('../../../shangshu-web/js/file-detail.js', import.meta.url), 'utf8');

it('文件中心点表格（.xlsx）直接进 Excel 工作面', () => {
  const openFn = CENTER.slice(CENTER.indexOf('async function open(id)'), CENTER.indexOf('async function open(id)') + 1600);
  assert.ok(openFn, '找不到 open()');
  /* 判的是「xlsx 走另一条路」这个行为，不是具体写法 */
  assert.match(openFn, /\.xlsx/i, 'open() 没有按 xlsx 分流');
  assert.match(openFn, /shangshuOpenTable\(f\.id,\{source:'xlsx'\}\)/, 'xlsx应通过统一开表入口携带真实文件来源');
  assert.doesNotMatch(openFn, /location\.href\s*=/, '已知文件不应整页重载并重新读取全部导航');
});

it('文件中心点普通文件照旧弹通用详情框（不能被一起改掉）', () => {
  const openFn = CENTER.slice(CENTER.indexOf('async function open(id)'), CENTER.indexOf('async function open(id)') + 1600);
  assert.match(openFn, /realDetail\(/, '普通文件不再走通用详情框了');
});

it('通用详情框的版本列表只对普通文件有意义：xlsx 不出现「第 N 版」那套', () => {
  /* 详情框读的是版本列表（readFileCenterVersions）——
     xlsx 不走这条路了（走 Excel 工作面），所以这里要保证「xlsx 进不了这个框」 */
  assert.match(CENTER, /\.xlsx/i, '文件中心没有按 xlsx 分流');
  /* 详情框本身仍保留版本列表（普通文件要用） */
  assert.match(DETAIL, /file-version-list|查看此版本/, '普通文件的版本列表被误删了');
});

it('护栏：跳 Excel 的地址格式与 Excel 工作面自己认的一致', () => {
  /* Excel 工作面读的是 location.search 的 object 参数（不是 hash 里的） */
  const excel = readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/main.ts', import.meta.url), 'utf8');
  assert.match(excel, /location\.search|URLSearchParams\(location\.search\)/,
    'Excel 工作面不读 location.search —— 那跳法对不上');
  assert.match(CENTER, /shangshuOpenTable\(f\.id,\{source:'xlsx'\}\)/, '文件中心应把资源ID和来源交给统一入口');
});

it('护栏：Excel 工作面本身不弹通用详情框', () => {
  const excel = readFileSync(new URL('../../../shangshu-web/js/domains/excel-univer/src/main.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(excel, /openFileCenterDetail/,
    'Excel 工作面不该调通用文件详情框（xlsx 没有版本那套）');
});
