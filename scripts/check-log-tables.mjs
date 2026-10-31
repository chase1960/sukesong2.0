#!/usr/bin/env node
/* 统一日志库检查器 —— 「什么算日志表」的判据**只从内核契约取**
   （`frappe_apps/shangshu_core/shangshu_core/contracts/unified-log-v1.json`）。
   检查器里**不许**另写一套字段清单或豁免名单。

   用法：
     node scripts/check-log-tables.mjs          # 跑检查：有违反退出码 1
     node scripts/check-log-tables.mjs --report # 同上，并把全部命中逐条列出来

   退出码：0 = 通过；1 = 有违反；2 = 用法/环境错。

   判据（全部来自契约）：
   · `common_fields.required` —— 一张日志表该有的字段名（统一日志表的九个通用字段）。
     **命中其中 3 个及以上**的表 ⇒ 它是「日志性质的表」。
   · `exempt_tables.tables` —— 已知的旧日志表（由统一日志库接管）⇒ 豁免。
   · 统一日志表本身（字段名与 `common_fields.required` 一一对应）⇒ 唯一允许的那张。

   人读规范：docs/standards/unified-log-library.md
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH = path.join(
  ROOT, 'frappe_apps/shangshu_core/shangshu_core/contracts/unified-log-v1.json');
const APPS_DIR = path.join(ROOT, 'frappe_apps');

const argv = process.argv.slice(2);
const REPORT = argv.includes('--report');

/** 命中几个契约字段名就算「日志性质的表」。
 *  （契约没写这个数 —— 取 3 是为了既能认出旧日志表的形状（行为人＋业务对象＋记录名），
 *    又不至于把「也有 actor_user」的业务表误判成日志表。） */
const LOG_FIELD_HIT = 3;

function fail(message) {
  console.error(message);
  process.exit(2);
}

if (!fs.existsSync(CONTRACT_PATH)) fail(`找不到内核契约：${CONTRACT_PATH}`);
let contract;
try {
  contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
} catch (error) {
  fail(`内核契约读不出来：${error.message}`);
}

/* ---------- 判据：从契约取 ---------- */
const requiredFields = (contract.common_fields?.required || []).map(field => field.name);
if (!requiredFields.length) fail('契约里没有 common_fields.required —— 检查器没有判据可用');
const exemptTables = new Set(contract.exempt_tables?.tables || []);
const unifiedTable = 'Shangshu Unified Log';

/* ---------- 扫各域的受管对象定义（DocType 定义文件） ---------- */
function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}

const definitions = [];
for (const file of walk(APPS_DIR)) {
  if (!file.includes(`${path.sep}doctype${path.sep}`)) continue;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  if (!doc || doc.doctype !== 'DocType' || !Array.isArray(doc.fields)) continue;
  definitions.push({ file: path.relative(ROOT, file), name: doc.name, fields: doc.fields });
}

const violations = [];
const hits = [];

for (const def of definitions) {
  const names = new Set(def.fields.map(field => field.fieldname));
  const matched = requiredFields.filter(name => names.has(name));
  const isUnified = def.name === unifiedTable;
  const isExempt = exemptTables.has(def.name);
  if (!isUnified && !isExempt && matched.length >= LOG_FIELD_HIT) {
    violations.push({
      id: 'new-log-table',
      where: `${def.file}（${def.name}）`,
      message: `这张表命中契约日志字段 ${matched.length} 个（${matched.join('、')}）`
        + ' ⇒ 它是「日志性质的表」；要么改用统一日志库，要么登记进契约的 exempt_tables.tables。',
    });
  }
  if (matched.length >= LOG_FIELD_HIT || isUnified || isExempt) {
    hits.push({ name: def.name, matched, exempt: isExempt, unified: isUnified });
  }
}

/* ---------- 统一日志表本身：字段必须与契约一致 ---------- */
const unified = definitions.find(def => def.name === unifiedTable);
if (!unified) {
  violations.push({
    id: 'missing-unified-log-table',
    where: unifiedTable,
    message: '统一日志表不在受管对象定义里 —— 统一日志库没有落地的表。',
  });
} else {
  const names = new Set(unified.fields.map(field => field.fieldname));
  const missing = requiredFields.filter(name => !names.has(name));
  if (missing.length) {
    violations.push({
      id: 'unified-log-table-mismatch',
      where: `${unified.file}（${unified.name}）`,
      message: `统一日志表缺契约要求的通用字段：${missing.join('、')}`,
    });
  }
}

/* ---------- 豁免的旧表：表结构得留着（历史行还要查得到） ---------- */
const missingExempt = [];
for (const table of exemptTables) {
  if (!definitions.some(def => def.name === table)) missingExempt.push(table);
}
if (missingExempt.length) {
  violations.push({
    id: 'missing-exempt-table',
    where: missingExempt.join('、'),
    message: '契约登记为旧日志表的表不见了 —— 历史行还要查得到，表结构得留着。',
  });
}

const line = '─'.repeat(72);
console.log(line);
console.log(`统一日志库检查 · 契约 ${contract.contract} v${contract.version}`);
console.log(`判据来源：${path.relative(ROOT, CONTRACT_PATH)}`
  + `（日志字段 ${requiredFields.length} 个，命中 ≥${LOG_FIELD_HIT} 个即算日志性质；豁免 ${exemptTables.size} 张）`);
console.log(line);
console.log(`扫描受管对象定义 ${definitions.length} 张 ｜ 命中日志形状 ${hits.length} 张 ｜ 违反 ${violations.length} 条`);
if (REPORT && hits.length) {
  console.log('\n【命中日志形状的表】');
  for (const hit of hits) {
    const tag = hit.unified ? '（统一日志表）' : hit.exempt ? '（豁免：旧日志表）' : '';
    console.log(`  · ${hit.name}${tag} —— 命中：${hit.matched.join('、') || '无'}`);
  }
}
if (violations.length) {
  console.log('\n【违反 —— 必须修】');
  for (const violation of violations) console.log(`  ✗ [${violation.id}] ${violation.where} → ${violation.message}`);
} else {
  console.log('\n✔ 没有违反：没有域另开日志表。');
}
console.log(line);
process.exit(violations.length ? 1 : 0);
