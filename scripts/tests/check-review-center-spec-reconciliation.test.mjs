/**
 * PKG-098-T01 —— **审核中心「逐条对账表」的核验判据**。
 *
 * **这份判据管什么**：把《用例清单》§10 的十八条检查点、《执行计划》「最小可验证交付」
 * 七条、《处理契约》「审核中心：声明、采用与保存状态」十三条，逐条对到**仓里真实存在的
 * 判据**（文件 + 用例名）与**真实存在的代码**。它不许对账表写空话。
 *
 * **测试通过 =**：
 *   ① 对账表在（`docs/reports/r967-20261021-integrated/review-center-spec-reconciliation.md`），
 *      且**三份基准条款的每一行都有对应的一行**（§10 十八条 ＋ 执行计划七条 ＋ 处理契约十三条 ＝ 38 行，
 *      一条不缺、一条不多）；
 *   ② 表里**每一条判据引用都真的存在**：引用的判据文件在仓里，被引用的**用例名**一字不差地
 *      出现在那个文件里（不许写「大概在某处」）；
 *   ③ 每行都有**结论**（有判据／判据弱／无判据），且**结论与引用自相矛盾就不许过**
 *      （判「有判据」必须真的有引用；判「无判据」必须真的没有引用）；
 *   ④ **凡是判「判据弱」的行，都必须在「缺口清单」里被点名**（不许悄悄标个弱就混过去）；
 *   ⑤ （能读到契约文件时）**对账表抄的条名与契约原文一字不差** —— 契约改了，对账表必须跟着改。
 *
 * **为什么要有第 ② 条**：对账表最容易出的错是「引用了一个看着像存在、其实没有的用例名」。
 * 那张表读起来会非常可信，但账是假的。这一条把它钉死在仓里。
 *
 * @see docs/reports/r967-20261021-integrated/review-center-spec-reconciliation.md
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC_REL = 'docs/reports/r967-20261021-integrated/review-center-spec-reconciliation.md';
const DOC = path.join(ROOT, DOC_REL);

/**
 * **三份基准条款的条名**（2026-10-25 从契约原文抄下来的）。
 * 下面另有一条判据会拿契约原文核这份抄件 ⇒ 抄错了会红。
 */
const SECTION_10 = [
  '双栏阅读与外观', '无差异过滤', '允许部分保存', '不允许部分保存', '呼吸文字与采用',
  '双击与编辑', '取消与关闭', '声明与独立性', '分组与依赖', '凭据与定位', '异常与权限',
  '操作连续性', '后续边界', '完整范围不受布局影响', '证据要求', '编辑与权限引用',
  '重核与同一候选', '配置与业务隔离',
];
const EXEC_PLAN = [
  '公共独立性', '部分保存', '整体保存', '呼吸交互', '美观与证据', '声明完整性', '复用与隔离',
];
const PROCESS_CONTRACT = [
  '声明驱动', '采用不等于保存', '允许部分保存', '不允许部分保存', '整体结果', '差异范围',
  '没有变化', '保存前校验', '异常真实可见', '声明的完整范围', '规则来源唯一', '处理结果不混用',
  '配置与故障隔离',
];

/** 对账表里一行该有的编号：§10-01…§10-18、EP-01…EP-07、PC-01…PC-13。 */
const EXPECTED_IDS = [
  ...SECTION_10.map((_, i) => `§10-${String(i + 1).padStart(2, '0')}`),
  ...EXEC_PLAN.map((_, i) => `EP-${String(i + 1).padStart(2, '0')}`),
  ...PROCESS_CONTRACT.map((_, i) => `PC-${String(i + 1).padStart(2, '0')}`),
];

const VERDICTS = ['有判据', '判据弱', '无判据'];

/** 归一化：去掉 markdown 粗体标记与所有空白 ⇒ 比的是「字」，不是排版。 */
function normalize(text) {
  return String(text).replace(/\*\*/g, '').replace(/\s+/g, '');
}

/** 一条判据引用：`路径 :: 用例名`。路径可带反引号。 */
function parseCitation(part) {
  const at = part.indexOf('::');
  if (at < 0) return null;
  const file = part.slice(0, at).trim().replace(/^`|`$/g, '');
  const name = part.slice(at + 2).trim().replace(/^`|`$/g, '');
  if (!file || !name) return null;
  return { file, name };
}

/** 判据引用之间用**全角竖线**分隔（用例名里有半角分号，不能拿分号分隔）。 */
function splitCitations(cell) {
  if (cell === '无' || cell === '—' || cell === '') return [];
  return cell.split('｜').map(part => part.trim()).filter(Boolean).map(parseCitation).filter(Boolean);
}

function readDoc() {
  if (!existsSync(DOC)) {
    return null;
  }
  return readFileSync(DOC, 'utf8');
}

/** 抽出对账表的行：[编号, 条款, 判据, 结论, 说明]。 */
function parseRows(source) {
  const rows = [];
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length !== 5) continue;
    if (!/^(§10|EP|PC)-\d{2}$/.test(cells[0])) continue;
    rows.push(cells);
  }
  return rows;
}

test('① 对账表在，且三份基准条款的每一行都有对应的一行（38 行一条不缺、顺序也不乱）', () => {
  const source = readDoc();
  assert.ok(source, `对账表还没写：${DOC_REL} 不存在`);
  const rows = parseRows(source);
  const ids = rows.map(row => row[0]);
  assert.deepEqual(ids, EXPECTED_IDS,
    `对账表的行跟基准条款对不上（少、多了、还是顺序乱了）\n期望：${EXPECTED_IDS.join(' ')}\n实际：${ids.join(' ')}`);
  assert.equal(new Set(ids).size, ids.length, '对账表里有重号');

  /* 每行的「条款」那一格必须写着契约里的那个条名（不许自己改写成另一个说法）。 */
  const names = [
    ...SECTION_10, ...EXEC_PLAN, ...PROCESS_CONTRACT,
  ];
  const drifted = rows
    .map((row, i) => [row[0], row[1], names[i]])
    .filter(([, written, expected]) => !normalize(written).includes(normalize(expected)))
    .map(([id, written, expected]) => `${id}: 这一行写的是「${written}」，契约里那条叫「${expected}」`);
  assert.deepEqual(drifted, [], drifted.join('\n'));
});

test('② 表里每一条判据引用都真的存在（文件在仓里 ＋ 用例名一字不差地出现在那个文件里）', () => {
  const source = readDoc();
  assert.ok(source, `对账表还没写：${DOC_REL} 不存在`);
  const rows = parseRows(source);
  const problems = [];
  for (const [id, , cell] of rows) {
    for (const citation of splitCitations(cell)) {
      const file = path.join(ROOT, citation.file);
      if (!existsSync(file)) {
        problems.push(`${id}: 判据文件不存在 —— ${citation.file}`);
        continue;
      }
      const content = normalize(readFileSync(file, 'utf8'));
      if (!content.includes(normalize(citation.name))) {
        problems.push(`${id}: ${citation.file} 里找不到这个用例名 —— ${citation.name}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('③ 每行都有结论，且结论与引用自相矛盾就不许过', () => {
  const source = readDoc();
  assert.ok(source, `对账表还没写：${DOC_REL} 不存在`);
  const problems = [];
  for (const [id, , cell, verdict] of parseRows(source)) {
    if (!VERDICTS.includes(verdict)) {
      problems.push(`${id}: 结论不是${VERDICTS.join('／')}之一 —— ${verdict}`);
      continue;
    }
    const citations = splitCitations(cell);
    if (verdict === '有判据' && citations.length === 0) {
      problems.push(`${id}: 判「有判据」却一条判据都没引`);
    }
    if (verdict === '判据弱' && citations.length === 0) {
      problems.push(`${id}: 判「判据弱」却一条判据都没引（弱也得说清哪一半有）`);
    }
    if (verdict === '无判据' && citations.length > 0) {
      problems.push(`${id}: 判「无判据」却引了 ${citations.length} 条判据`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('④ 凡是判「判据弱」的行，都必须在「缺口清单」里被点名', () => {
  const source = readDoc();
  assert.ok(source, `对账表还没写：${DOC_REL} 不存在`);
  assert.ok(/^##\s*缺口清单/m.test(source), '对账表里没有「## 缺口清单」这一节');
  const gapSection = source.slice(source.search(/^##\s*缺口清单/m));
  const problems = [];
  for (const [id, , , verdict] of parseRows(source)) {
    if (verdict !== '判据弱') continue;
    if (!gapSection.includes(id)) {
      problems.push(`${id}: 判「判据弱」，但「缺口清单」里没有点名这一行`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('⑥ 表头写的三个计数，跟表里实际的结论数一致', () => {
  const source = readDoc();
  assert.ok(source, `对账表还没写：${DOC_REL} 不存在`);
  const rows = parseRows(source);
  const counted = { 有判据: 0, 判据弱: 0, 无判据: 0 };
  for (const row of rows) {
    if (counted[row[3]] === undefined) continue;
    counted[row[3]] += 1;
  }
  const declared = /<!--\s*counts:\s*有判据=(\d+)\s+判据弱=(\d+)\s+无判据=(\d+)\s*-->/.exec(source);
  assert.ok(declared, '对账表里没有写计数那行（<!-- counts: 有判据=N 判据弱=N 无判据=N -->）');
  assert.equal(Number(declared[1]), counted['有判据'],
    `表里「有判据」实际 ${counted['有判据']} 条，表头写的是 ${declared[1]}`);
  assert.equal(Number(declared[2]), counted['判据弱'],
    `表里「判据弱」实际 ${counted['判据弱']} 条，表头写的是 ${declared[2]}`);
  assert.equal(Number(declared[3]), counted['无判据'],
    `表里「无判据」实际 ${counted['无判据']} 条，表头写的是 ${declared[3]}`);
});

test('⑤ 对账表抄的条名与契约原文一字不差（契约改了，对账表必须跟着改）', (t) => {
  const fdeRoot = (() => {
    let dir = ROOT;
    for (let i = 0; i < 6; i += 1) {
      if (existsSync(path.join(dir, 'fde', '设计', '契约', '用例清单.md'))) return path.join(dir, 'fde');
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  })();
  if (!fdeRoot) {
    t.skip('这台机器上读不到仓外的 fde/ 契约目录 ⇒ 跳过「抄件与原文对得上」这一查');
    return;
  }

  /** 三份基准条款各在哪：两份契约在 `设计/契约/`，执行计划在 `开发/计划/`。 */
  const read = name => readFileSync(path.join(fdeRoot, name), 'utf8');

  /** 取一节的内容：从标题行到**下一个同级或更高级标题**为止（不封口会把后面的节也算进来）。 */
  function section(source, heading, level) {
    const at = source.indexOf(heading);
    assert.ok(at > 0, `文件里找不到「${heading}」这一节`);
    const rest = source.slice(at + heading.length);
    const lines = rest.split('\n');
    const collected = [];
    for (const line of lines) {
      const match = /^(#{1,6})\s/.exec(line);
      if (match && match[1].length <= level) break;
      collected.push(line);
    }
    return collected;
  }

  /* ①《用例清单》§10 那张表的检查点名。 */
  const spec = read(path.join('设计', '契约', '用例清单.md'));
  const specNames = [];
  for (const line of section(spec, '### 10. 交付验收与对抗性检查', 3)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length < 3) continue;
    if (cells[0] === '检查点' || /^-+$/.test(cells[0])) continue;
    specNames.push(cells[0]);
  }
  assert.deepEqual(specNames, SECTION_10,
    '《用例清单》§10 的检查点跟对账表抄的那份对不上（契约改了？抄件过期了？）');

  /* ②《执行计划》「最小可验证交付」那七条。 */
  const plan = read(path.join('开发', '计划', '执行计划.md'));
  const planNames = [];
  for (const line of section(plan, '### 最小可验证交付', 3)) {
    const match = /^- \*\*([^*]+)\*\*/.exec(line.trim());
    if (!match) continue;
    planNames.push(match[1].replace(/[：:]\s*$/, ''));
  }
  assert.deepEqual(planNames, EXEC_PLAN,
    '《执行计划》「最小可验证交付」那七条跟对账表抄的那份对不上');

  /* ③《处理契约》「审核中心：声明、采用与保存状态」那十三条。 */
  const contract = read(path.join('设计', '契约', '处理契约与状态转换.md'));
  const contractNames = [];
  for (const line of section(contract, '## 审核中心：声明、采用与保存状态', 2)) {
    const match = /^\d+\. \*\*([^*]+)\*\*/.exec(line.trim());
    if (!match) continue;
    contractNames.push(match[1].replace(/[。.]\s*$/, ''));
  }
  assert.deepEqual(contractNames, PROCESS_CONTRACT,
    '《处理契约》「审核中心」那十三条跟对账表抄的那份对不上');
});
