import {it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

/**
 * 「Excel 交互是所有数据库交互的默认选项」——**机器可查的版本**（用户 2026-10-22 拍板）。
 *
 * 人读规范：`docs/standards/visual-consistency-rules.md` §7.2。
 *
 * 为什么要有机器检查：这条规矩治的是「域自己又画一套表格」——
 * 而「域自己画表格」是**能长出新表格语言**的那种病（列头、行高、斑马纹、分页各画各的）。
 * 只写在文档里，下一个人照样会画。所以要有检查器：扫域前端里**看起来像数据表格**的页面，
 * 没登记豁免就报出来。
 *
 * 测试通过 = 下面全部成立：
 *  1. 检查器**认得出**「域内画的数据表格」——真的画了表格的域文件会被抓到；
 *  2. **登记了豁免的就不报**（豁免＝登记过理由，不是默认允许）；
 *  3. 检查器**不会误伤**普通页面（列表、卡片、空态不算数据表格）；
 *  4. 规范文件里**写着这条规矩**（人读的那份也得有，别只活在机器里）；
 *  5. 真跑一遍仓库：**新增违反 0 条**（存量不算新增）。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECKER = path.join(ROOT, 'scripts/check-style-rules.mjs');
const SPEC = path.join(ROOT, 'shangshu-web/style-rules.json');
const RULES_DOC = path.join(ROOT, 'docs/standards/visual-consistency-rules.md');

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));

/**
 * 在临时目录里造一个「域内画的数据表格」，跑检查器看它报不报。
 *
 * 临时仓库里**只放 EX-01 这一条规则** —— 其余规则指向真实仓库的参照系文件
 * （workbench.css 等），临时仓库里没有，会报「文件不存在」把测试搅黄。
 * 这里要验的是「EX-01 抓不抓得到自画的数据表格」，不是别的规则。
 */
function checkFixture(files, rules) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'excel-default-'));
  try {
    // 检查器从仓库根读规则；这里用副本指向临时根，让它扫临时目录。
    const root = path.join(dir, 'repo');
    fs.mkdirSync(path.join(root, 'shangshu-web/css/domains'), { recursive: true });
    fs.mkdirSync(path.join(root, 'shangshu-web/css'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs/standards'), { recursive: true });
    const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
    spec.rules = rules ?? spec.rules.filter(r => r.id === 'EX-01');
    fs.writeFileSync(path.join(root, 'shangshu-web/style-rules.json'), JSON.stringify(spec, null, 1));
    fs.writeFileSync(path.join(root, 'shangshu-web/style-rules-baseline.json'), '{}');
    fs.writeFileSync(path.join(root, 'docs/standards/visual-consistency-rules.md'), '# 占位\n');
    fs.copyFileSync(CHECKER, path.join(root, 'scripts/check-style-rules.mjs'));
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    try {
      const out = execFileSync(process.execPath, [path.join(root, 'scripts/check-style-rules.mjs'), '--report'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      return {code: 0, out};
    } catch (error) {
      return {code: error.status ?? 1, out: String(error.stdout || '') + String(error.stderr || '')};
    }
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

/** 一段「域内自画的数据表格」的典型样子：表头 + 行 + 斑马纹。 */
const DATA_TABLE_CSS = `
.dtable { width:100%; border-collapse:collapse; }
.dtable th { font-size:12px; background:var(--bg2); }
.dtable td { font-size:12px; }
.dtable tbody tr:nth-child(even) { background:var(--bg2); }
`;

const PLAIN_PAGE_CSS = `
.some-list { padding:8px; }
.some-list .row { display:flex; gap:8px; }
`;

it('机器检查：域内画的数据表格会被抓到', () => {
  const result = checkFixture({
    'shangshu-web/css/domains/demo/demo.css': DATA_TABLE_CSS,
  });
  assert.notEqual(result.code, 0, '域内画了数据表格，检查器却放过了');
  assert.match(result.out, /EX-01|数据表格|Excel/, `检查器没有说出为什么违规：\n${result.out}`);
});

it('机器检查：登记了豁免的就不报', () => {
  const withExemption = JSON.parse(JSON.stringify(spec));
  const rule = withExemption.rules.find(r => r.id === 'EX-01');
  assert.ok(rule, '规则表里没有 EX-01 这条规则');
  rule.exempt.push('shangshu-web/css/domains/demo/demo.css');
  const result = checkFixture({
    'shangshu-web/css/domains/demo/demo.css': DATA_TABLE_CSS,
  }, withExemption.rules.filter(r => r.id === 'EX-01'));
  assert.equal(result.code, 0, `登记了豁免还是被报：\n${result.out}`);
});

it('机器检查：不误伤普通页面（列表、卡片不是数据表格）', () => {
  const result = checkFixture({
    'shangshu-web/css/domains/demo/demo.css': PLAIN_PAGE_CSS,
  });
  assert.equal(result.code, 0, `普通页面被当成数据表格了：\n${result.out}`);
});

it('人读规范里写着这条规矩（别只活在机器里）', () => {
  const doc = fs.readFileSync(RULES_DOC, 'utf8');
  assert.match(doc, /Excel 交互是所有数据库交互的默认选项|Excel 交互.*默认选项/,
    '规范文件里没有「Excel 交互是所有数据库交互的默认选项」这条');
});

it('真跑一遍仓库：新增违反 0 条', () => {
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [CHECKER], {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  } catch (error) {
    code = error.status ?? 1;
    out = String(error.stdout || '') + String(error.stderr || '');
  }
  assert.equal(code, 0, `检查器报了新增违反：\n${out}`);
});
