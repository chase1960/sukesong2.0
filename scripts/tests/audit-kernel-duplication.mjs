#!/usr/bin/env node
/* 内核字段与同义代码审查器（**只发现，不改**）—— 任务 PKG-029-T01
 *
 * 查三件事，输出「候选清单 + 证据（文件:行号）」：
 *   ① 内核 DocType 字段的使用面 —— 哪些字段**全仓零出现**（写了没人读）／
 *      只出现在 DocType 声明里（代码里没人碰）。⚠️ 「没人读」≠「废弃」：
 *      业务事实字段（合同/协议上要有的）哪怕暂时没消费者 ⇒ 判据只标候选，
 *      废弃与否由人按「业务上要不要」拍板。
 *   ② 内核 .py 的死代码 —— 定义了但**全仓无人调用**的函数 / 常量 / 整个模块。
 *   ③ 内核 .py 里**同一个字面量在多处硬编码**（同一个错误文案、同一个上限、
 *      同一个默认路径）—— 改了 A 忘了改 B 就出 bug。
 *
 * 用法：
 *   node scripts/tests/audit-kernel-duplication.mjs             # 人读的清单
 *   node scripts/tests/audit-kernel-duplication.mjs --json      # 机读 JSON
 *   node scripts/tests/audit-kernel-duplication.mjs --field X   # 只看某个字段
 *
 * 退出码：0 = 跑完（**清单非空不是失败** —— 这是发现工具，不是门禁）；2 = 环境错。
 *
 * 人读报告：docs/设计/内核字段与同义代码审查-2026-10-22.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KERNEL_APP = path.join(ROOT, 'frappe_apps/shangshu_core');
const KERNEL_PKG = path.join(KERNEL_APP, 'shangshu_core');
const DOCTYPE_DIR = path.join(KERNEL_PKG, 'shangshu_core', 'doctype');

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const FIELD_FILTER = (() => {
  const i = argv.indexOf('--field');
  return i >= 0 ? argv[i + 1] : null;
})();

/** 扫仓库时要跳过的目录（噪音大、与内核无关）。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build',
  '.mypy_cache', '.pytest_cache', '.claude', 'coverage', '.next',
]);
/** 扫仓库时要跳过的文件（本审查器自己会提到所有字段名 ⇒ 会污染计数）。 */
const SELF_NAMES = new Set([
  'audit-kernel-duplication.mjs', 'audit-kernel-duplication.test.mjs',
]);

/* ---------- 通用遍历 ---------- */

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(full, out);
    } else if (entry.isFile()) {
      if (SELF_NAMES.has(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
}

const REL = (file) => path.relative(ROOT, file);

/** 收集「内核 DocType 声明」之外的全仓文本命中。 */
const CODE_EXT = new Set(['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.html', '.sh']);
const DOC_EXT = new Set(['.md', '.json', '.yml', '.yaml', '.txt']);

/* ---------- ① 内核 DocType 字段使用面 ---------- */

function readKernelDoctypes() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(DOCTYPE_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const jsonPath = path.join(DOCTYPE_DIR, dir, `${dir}.json`);
    if (!fs.existsSync(jsonPath)) continue;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch {
      continue;
    }
    out.push({
      slug: dir,
      name: doc.name,
      module: doc.module,
      autoname: doc.autoname,
      jsonPath,
      fields: (doc.fields || []).map((f) => ({
        fieldname: f.fieldname,
        fieldtype: f.fieldtype,
        label: f.label,
        options: f.options,
        reqd: f.reqd ? 1 : 0,
        read_only: f.read_only ? 1 : 0,
        description: f.description || '',
        default: f.default,
      })),
    });
  }
  return out;
}

/* ---------- 词元索引（一次扫描，全仓复用） ---------- */

/**
 * 把全仓文件扫一遍，建「词元 → 命中」的索引。
 * 之前的写法是「每个词元重扫一遍所有文件」⇒ 303 个字段 × 全仓 = 太慢；
 * 这里改成**先知道要查哪些词元、再扫一遍**⇒ 后面查词元都是 O(1) 查表。
 * 只记标识符样式的词元（`[A-Za-z_][A-Za-z0-9_]*`）—— 字段名/函数名/常量名都是这一类。
 */
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/** @type {Map<string, {counts: Map<string, number>, where: Array<{file: string, line: number}>}>} */
const tokenIndex = new Map();

/** 文件内容缓存（同一文件只读一次）。 */
const textCache = new Map();

function readText(file) {
  if (textCache.has(file)) return textCache.get(file);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  textCache.set(file, text);
  return text;
}

/** 扫全仓，只记录 `wanted` 里的词元（精确计数 ＋ 位置样本）。 */
function indexTokens(files, wanted) {
  for (const file of files) {
    const text = readText(file);
    if (!text) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      IDENT_RE.lastIndex = 0;
      let m;
      while ((m = IDENT_RE.exec(lines[i])) !== null) {
        const token = m[0];
        if (!wanted.has(token)) continue;
        let entry = tokenIndex.get(token);
        if (!entry) {
          entry = { counts: new Map(), where: [] };
          tokenIndex.set(token, entry);
        }
        entry.counts.set(file, (entry.counts.get(file) || 0) + 1);
        if (entry.where.length < 8) entry.where.push({ file, line: i + 1 });
      }
    }
  }
}

/** 统计一个 token 在某个文件集合里的出现次数（词边界）。 */
function countToken(files, token) {
  const entry = tokenIndex.get(token);
  if (!entry) return { hits: 0, where: [] };
  const allowed = files instanceof Set ? files : new Set(files);
  let hits = 0;
  const where = [];
  for (const [file, count] of entry.counts) {
    if (!allowed.has(file)) continue;
    hits += count;
  }
  for (const hit of entry.where) {
    if (allowed.has(hit.file) && where.length < 6) where.push(`${REL(hit.file)}:${hit.line}`);
  }
  return { hits, where };
}

/* ---------- ② 内核 .py 死代码 ---------- */

/** 内核 .py 模块（排除 tests/ 与 doctype/ 的空壳）。 */
function kernelModules() {
  const files = walkFiles(KERNEL_PKG);
  return files.filter((f) => f.endsWith('.py')
    && !f.includes(`${path.sep}tests${path.sep}`)
    && !f.includes(`${path.sep}doctype${path.sep}`)
    && !f.endsWith('__init__.py'));
}

/** 抽模块级 def / 常量。 */
function parseDefinitions(file) {
  const text = readText(file);
  if (!text) return { functions: [], constants: [] };
  const lines = text.split('\n');
  const functions = [];
  const constants = [];
  lines.forEach((line, idx) => {
    const def = line.match(/^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (def) {
      // 看定义行**上面**有没有 `@frappe.whitelist` —— 那是 HTTP 入口，
      // 由前端按**函数名**调（`/api/method/...`）⇒ Python 侧按名字 grep 找不到，
      // 不算死代码（否则会把整个 api.py 误判成死代码）。
      let isWhitelist = false;
      for (let back = idx - 1; back >= 0 && back >= idx - 6; back--) {
        const prev = lines[back].trim();
        if (!prev) continue;
        if (prev.startsWith('#')) continue;
        if (prev.startsWith('@')) {
          if (prev.includes('whitelist')) isWhitelist = true;
          break;
        }
        break;
      }
      functions.push({ name: def[1], line: idx + 1, isWhitelist });
      return;
    }
    const cls = line.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(:]/);
    if (cls) {
      functions.push({ name: cls[1], line: idx + 1, isClass: true });
      return;
    }
    // 模块级常量：`NAME = ...`（顶格，无缩进）
    const constMatch = line.match(/^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=\s*(.+)$/);
    if (constMatch) {
      constants.push({ name: constMatch[1], line: idx + 1, value: constMatch[2].slice(0, 120) });
    }
  });
  return { functions, constants };
}

/* ---------- ③ 硬编码字面量 ---------- */

/** 抽 .py 里的字符串字面量（够用即可：单/双引号，跨行拼接忽略）。 */
function extractLiterals(file) {
  const text = readText(file);
  if (!text) return [];
  const out = [];
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    const re = /"([^"\\\n]{8,200})"|'([^'\\\n]{8,200})'/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const value = m[1] !== undefined ? m[1] : m[2];
      if (!value) continue;
      out.push({ value, line: idx + 1 });
    }
  });
  return out;
}

/**
 * 把重复字面量分档 —— 分档的意义是**别让人在噪音里找信号**。
 * · policy   —— 错误文案 / 限制 / 默认值（改了 A 忘了改 B ⇒ 用户看到两套说法）
 * · id_like  —— 看着像标识符或字段名（多半是各表共用的列名，**通常不是**问题）
 * · other    —— 其它
 */
function classifyLiteral(value) {
  if (/[一-鿿]/.test(value)) return 'policy';
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return 'id_like';
  if (/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(value)) return 'id_like';
  if (/^\d+(\.\d+)?$/.test(value)) return 'policy';
  if (/^[A-Za-z0-9 _\-\/.:%]{0,120}$/.test(value) && /[A-Z]/.test(value) && value.includes(' ')) {
    return 'policy'; // "System Manager" 这种角色名/句子型常量
  }
  return 'other';
}

/* ---------- 主流程 ---------- */

function main() {
  if (!fs.existsSync(DOCTYPE_DIR)) {
    console.error(`找不到内核 DocType 目录：${DOCTYPE_DIR}`);
    process.exit(2);
  }

  const doctypes = readKernelDoctypes();
  const allFiles = walkFiles(ROOT);
  const codeFiles = allFiles.filter((f) => CODE_EXT.has(path.extname(f)));
  const docFiles = allFiles.filter((f) => DOC_EXT.has(path.extname(f))
    && !f.includes(`${path.sep}doctype${path.sep}`));
  const otherDtJson = allFiles.filter((f) => f.includes(`${path.sep}doctype${path.sep}`)
    && f.endsWith('.json'));

  const totalFields = doctypes.reduce((n, d) => n + d.fields.length, 0);

  /* --- 先把「要查哪些词元」定下来，再扫全仓建索引（一次扫描） --- */
  const modules = kernelModules();
  const defsByModule = new Map();
  const wanted = new Set();
  for (const dt of doctypes) {
    for (const field of dt.fields) wanted.add(field.fieldname);
  }
  for (const mod of modules) {
    const defs = parseDefinitions(mod);
    defsByModule.set(mod, defs);
    for (const fn of defs.functions) wanted.add(fn.name);
    for (const c of defs.constants) wanted.add(c.name);
    wanted.add(path.basename(mod, '.py'));
  }
  indexTokens(allFiles, wanted);

  /* --- ① 字段使用面 --- */
  const fieldReport = [];
  for (const dt of doctypes) {
    const otherDtFiles = otherDtJson.filter((f) => f !== dt.jsonPath);
    // **这张表的「作用域文件」** ＝ 代码里提到过这张表（显示名或 slug）的文件。
    // 只有落在这些文件里的字段命中，才算「这张表的字段真被碰过」；
    // 否则 `status`/`source_doctype` 这种通用词在别的表里出现 ⇒ 假命中。
    const scopeFiles = new Set();
    for (const f of codeFiles) {
      const text = readText(f);
      if (!text) continue;
      if (text.includes(dt.name) || text.includes(dt.slug)) scopeFiles.add(f);
    }
    for (const field of dt.fields) {
      const inCode = countToken(codeFiles, field.fieldname);
      const inScope = countToken(scopeFiles, field.fieldname);
      const inDocs = countToken(docFiles, field.fieldname);
      const inOtherDt = countToken(otherDtFiles, field.fieldname);
      fieldReport.push({
        doctype: dt.name,
        doctypeSlug: dt.slug,
        field: field.fieldname,
        type: field.fieldtype,
        label: field.label,
        options: field.options || '',
        reqd: field.reqd,
        read_only: field.read_only,
        description: field.description,
        codeHits: inCode.hits,
        codeWhere: inCode.where,
        // 落在「提到这张表的代码文件」里的命中数 ⇒ 这张表的字段真被碰过的次数
        scopedHits: inScope.hits,
        scopedWhere: inScope.where,
        docHits: inDocs.hits,
        otherDoctypeHits: inOtherDt.hits,
        // 全仓（代码 + 文档 + 其它 DocType 声明）出现次数
        totalHits: inCode.hits + inDocs.hits + inOtherDt.hits,
      });
    }
  }

  const zeroHit = fieldReport.filter((f) => f.totalHits === 0);
  const declOnly = fieldReport.filter((f) => f.codeHits === 0 && f.totalHits > 0);
  // **只在别的表里出现过、这张表自己的作用域里一次都没碰过** ⇒ 最强的「没人用」信号
  const outOfScopeOnly = fieldReport.filter((f) => f.codeHits > 0 && f.scopedHits === 0);
  // 落在这张表作用域里、但只出现在「声明层」的文件 ⇒ 读口没碰
  const codeOnly = fieldReport.filter((f) => f.codeHits > 0);

  /* --- ② 死代码 --- */
  const moduleReport = [];
  for (const mod of modules) {
    const { functions, constants } = defsByModule.get(mod);
    const modText = readText(mod);
    const others = allFiles.filter((f) => f !== mod);
    const deadFunctions = [];
    for (const fn of functions) {
      // HTTP 入口（`@frappe.whitelist`）由前端按名字调 ⇒ 不算死代码。
      if (fn.isWhitelist) continue;
      const inModule = countToken([mod], fn.name).hits;
      const elsewhere = countToken(others, fn.name);
      // 「只有定义那一行」⇒ 全仓无人引用
      if (inModule <= 1 && elsewhere.hits === 0) {
        deadFunctions.push({ name: fn.name, line: fn.line, isClass: !!fn.isClass });
      }
    }
    const deadConstants = [];
    for (const c of constants) {
      const inModule = countToken([mod], c.name).hits;
      const elsewhere = countToken(others, c.name);
      if (inModule <= 1 && elsewhere.hits === 0) {
        deadConstants.push({ name: c.name, line: c.line, value: c.value });
      }
    }
    moduleReport.push({
      module: REL(mod),
      lines: modText.split('\n').length,
      functions: functions.length,
      constants: constants.length,
      deadFunctions,
      deadConstants,
    });
  }

  /* 整个模块无人引用（按模块名找） */
  const deadModules = [];
  for (const mod of modules) {
    const base = path.basename(mod, '.py');
    const pkgDir = path.basename(path.dirname(mod));
    const dotted = `shangshu_core.${base}`;
    const others = allFiles.filter((f) => f !== mod);
    const hits = countToken(others, base).hits;
    const dottedHits = countToken(others, dotted).hits;
    if (hits === 0 && dottedHits === 0) {
      deadModules.push({ module: REL(mod), basename: base, package: pkgDir });
    }
  }

  /* --- ③ 硬编码字面量 --- */
  const literalMap = new Map();
  for (const mod of modules) {
    for (const lit of extractLiterals(mod)) {
      if (!lit.value.trim()) continue;
      const key = lit.value;
      if (!literalMap.has(key)) literalMap.set(key, []);
      literalMap.get(key).push({ file: REL(mod), line: lit.line });
    }
  }
  const duplicateLiterals = [];
  for (const [value, places] of literalMap) {
    const files = new Set(places.map((p) => p.file));
    if (files.size < 2) continue;
    duplicateLiterals.push({ value, files: files.size, places, kind: classifyLiteral(value) });
  }
  duplicateLiterals.sort((a, b) => b.files - a.files || a.value.localeCompare(b.value));

  const result = {
    generatedAt: new Date().toISOString(),
    scope: {
      kernelPackage: REL(KERNEL_PKG),
      doctypeCount: doctypes.length,
      fieldCount: totalFields,
      moduleCount: modules.length,
      codeFileCount: codeFiles.length,
    },
    fields: {
      total: fieldReport.length,
      zeroHit: zeroHit.map((f) => ({ doctype: f.doctype, field: f.field, label: f.label, type: f.type })),
      declarationOnly: declOnly.map((f) => ({
        doctype: f.doctype, field: f.field, label: f.label, type: f.type,
        docHits: f.docHits, otherDoctypeHits: f.otherDoctypeHits,
        where: f.codeWhere,
      })),
      // 只在别的表里出现、这张表作用域里一次没碰 ⇒ 最强信号
      outOfScopeOnly: outOfScopeOnly.map((f) => ({
        doctype: f.doctype, field: f.field, label: f.label, type: f.type,
        codeHits: f.codeHits, codeWhere: f.codeWhere,
      })),
      usedInCode: codeOnly.length,
    },
    deadCode: {
      modules: moduleReport.filter((m) => m.deadFunctions.length || m.deadConstants.length),
      deadModules,
    },
    duplicateLiterals: duplicateLiterals.map((d) => ({
      value: d.value, files: d.files, kind: d.kind, places: d.places.slice(0, 8),
    })),
  };

  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  /* --- 人读输出 --- */
  const L = console.log;
  L('══ 内核字段与同义代码审查（只发现，不改）══');
  L(`范围：${result.scope.kernelPackage}`);
  L(`DocType ${result.scope.doctypeCount} 个 / 字段 ${result.scope.fieldCount} 个 / .py 模块 ${result.scope.moduleCount} 个`);
  L('');

  L(`── ① 字段使用面 ──`);
  L(`全仓零出现（候选「写了没人读」）：${zeroHit.length}`);
  for (const f of zeroHit) L(`   · ${f.doctype}.${f.field}  [${f.type}] ${f.label || ''}`);
  L(`只出现在文档/其它 DocType 声明里，代码里没人碰：${declOnly.length}`);
  for (const f of declOnly) {
    L(`   · ${f.doctype}.${f.field}  [${f.type}] ${f.label || ''}  (doc×${f.docHits} 其它DocType×${f.otherDoctypeHits})`);
  }
  L(`**名字只在别的表里出现过、这张表自己的作用域里一次没碰**：${outOfScopeOnly.length}`);
  for (const f of outOfScopeOnly) {
    L(`   · ${f.doctype}.${f.field}  [${f.type}] ${f.label || ''}  (全仓代码命中 ${f.codeHits} 次，都不在本表作用域)`);
  }
  L(`代码里被用到：${codeOnly.length}`);
  L('');

  L(`── ② 死代码 ──`);
  L(`整模块无人引用：${deadModules.length}`);
  for (const m of deadModules) L(`   · ${m.module}`);
  let fnCount = 0;
  let constCount = 0;
  for (const m of moduleReport) {
    if (!m.deadFunctions.length && !m.deadConstants.length) continue;
    L(`   ${m.module}`);
    for (const f of m.deadFunctions) { fnCount++; L(`      函数 ${f.name}() :${f.line}`); }
    for (const c of m.deadConstants) { constCount++; L(`      常量 ${c.name} :${c.line}`); }
  }
  L(`合计：无人调用的函数 ${fnCount} 个 / 常量 ${constCount} 个`);
  L('');

  L(`── ③ 同一字面量在多处硬编码（跨文件）──`);
  const policyLits = duplicateLiterals.filter((d) => d.kind === 'policy');
  L(`policy 档（错误文案/限制/默认值 —— 改了 A 忘了改 B ⇒ 两套说法）：${policyLits.length}`);
  for (const d of policyLits.slice(0, 40)) {
    L(`   · 「${d.value}」 × ${d.files} 个文件`);
    for (const p of d.places.slice(0, 5)) L(`        ${p.file}:${p.line}`);
  }
  L(`id_like 档（各表共用的列名/标识符 —— 多半不是问题，略）：`
    + `${duplicateLiterals.filter((d) => d.kind === 'id_like').length} 条`);
  L(`other 档：${duplicateLiterals.filter((d) => d.kind === 'other').length} 条`);
}

if (FIELD_FILTER) {
  // --field 模式：只打印这个字段的使用面（人工核对用）
  const doctypes = readKernelDoctypes();
  const allFiles = walkFiles(ROOT);
  const codeFiles = allFiles.filter((f) => CODE_EXT.has(path.extname(f)));
  indexTokens(allFiles, new Set([FIELD_FILTER]));
  for (const dt of doctypes) {
    for (const field of dt.fields) {
      if (field.fieldname !== FIELD_FILTER) continue;
      const c = countToken(codeFiles, field.fieldname);
      console.log(`${dt.name}.${field.fieldname}  [${field.fieldtype}]  代码命中 ${c.hits}`);
      for (const w of c.where) console.log(`   ${w}`);
    }
  }
} else {
  main();
}
