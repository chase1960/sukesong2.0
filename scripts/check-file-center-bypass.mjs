// 机器检查：**除了登记在案的限期豁免，任何域都不许自己放字节**。
//
// **依据**：`frappe_apps/shangshu_core/shangshu_core/contracts/file-center-v1.json`
// 的 `exemptions` —— 契约原文：「**已知的合法例外**（不是默认允许；改动例外要同时改本表与
// **检查器的豁免登记**）」。⇒ 豁免登记在契约里，**由这个检查器执行**。
//
// **为什么要有这个检查器**（2026-10-22 第 3 步收口时查出来的）：
// 契约登记了三处**限期豁免**（邮件域收信附件／邮件域外链图／财务域发票原件），
// 但**没有任何机器规则盯着** ⇒ 今天再有人写一行 `save_file(...)` 也不会被发现
// ⇒ 「所有进尚书的文件都进文件中心」这句话就守不住。
//
// **它断什么**（一句话）：
// 「**域自己放字节**的地方，除了契约登记在案的那几处限期豁免，**一处都不许有**；
//   契约登记的那几处，**必须真的还在那儿**（不许悄悄长出来新的、也不许悄悄把旧的藏起来）。
//
// 用法：
//   node scripts/check-file-center-bypass.mjs            # 扫当前仓
//   node scripts/check-file-center-bypass.mjs --json     # 机器可读输出
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 契约里那三处豁免登记的文件（与 `file-center-v1.json` 的 `exemptions` 对齐）。 */
export const CONTRACT_PATH = 'frappe_apps/shangshu_core/shangshu_core/contracts/file-center-v1.json';

/** 域自己放字节的几种写法（**只认真的落字节**，不认读字节/引用）。 */
export const BYPASS_PATTERNS = [
  {
    id: 'save-file',
    // `frappe.utils.file_manager.save_file(...)` —— 自己落一份原件。
    pattern: /\bsave_file\s*\(/g,
    note: 'frappe.utils.file_manager.save_file —— 域自己存了一份字节',
  },
  {
    id: 'file-doc-content',
    // `frappe.get_doc({'doctype': 'File', …, 'content': …})` —— 自己建 File 行并塞内容。
    pattern: /['"]doctype['"]\s*:\s*['"]File['"][^}]*?['"]content['"]\s*:/gs,
    note: '自己建 File 行并直接塞内容',
  },
  {
    id: 'file-attach-with-content',
    // `frappe.get_doc({'doctype':'File','file_name':…,'is_private':1,'attached_to_doctype':…,'content':…})`
    pattern: /['"]attached_to_doctype['"]\s*:[^}]*?['"]content['"]\s*:/gs,
    note: '自己建 File 行（挂到某条记录上）并直接塞内容',
  },
];

/** 扫一个目录里的 .py 文件（跳过测试与缓存目录 —— 测试要造样本文件，那不算绕过）。 */
export function collectPythonFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['__pycache__', 'tests', 'node_modules', '.git'].includes(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** 读契约里的豁免登记（`exemptions[].where`）。 */
export function readExemptions(root = ROOT) {
  const file = path.join(root, CONTRACT_PATH);
  if (!fs.existsSync(file)) return [];
  const contract = JSON.parse(fs.readFileSync(file, 'utf8'));
  return contract?.exemptions?.entries ?? [];
}

/** 一处豁免登记匹配一个文件（`where` 是路径片段，按**片段包含**匹配）。 */
function matchesExemption(relativePath, exemption) {
  const where = String(exemption?.where || '').trim();
  if (!where) return false;
  const normalized = relativePath.replace(/\\/g, '/');
  if (where.includes('/tests/') || where.endsWith('/tests')) return false;
  // ⚠️ **「已收口」的条目不算例外**（2026-10-22）：收口过的那一处要是又自己放字节，
  // 应当**报出来**（它是新的绕过）⇒ 只有**还成立的例外**才豁免。
  if (String(exemption?.kind || '').includes('已收口')) return false;
  return normalized.includes(where.replace(/^\.\//, ''));
}

/**
 * 扫一遍：哪些域自己放字节、哪些在豁免登记里、哪些是**没登记的绕过**。
 */
export function inspect(root = ROOT) {
  const exemptions = readExemptions(root);
  const appsDir = path.join(root, 'frappe_apps');
  const files = collectPythonFiles(appsDir);
  const hits = [];
  for (const file of files) {
    const relative = path.relative(root, file).replace(/\\/g, '/');
    if (!relative.startsWith('frappe_apps/')) continue;
    const text = fs.readFileSync(file, 'utf8');
    // ⚠️ **扫整篇，不按行扫**：自己建 File 的写法常常**跨行**（dict 换行写）
    // ⇒ 按行扫会漏（外链图那处就是这么漏掉的）。
    for (const rule of BYPASS_PATTERNS) {
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split('\n').length;
        const lineText = text.split('\n')[line - 1] || '';
        const stripped = lineText.trim();
        if (stripped.startsWith('#')) continue;          // 注释里提到不算
        hits.push({
          file: relative,
          line,
          rule: rule.id,
          note: rule.note,
          text: stripped.slice(0, 160),
        });
      }
    }
  }
  const registered = [];
  const unregistered = [];
  for (const hit of hits) {
    const exemption = exemptions.find((item) => matchesExemption(hit.file, item));
    if (exemption) {
      registered.push({ ...hit, exemption: exemption.where, kind: exemption.kind || '登记例外' });
    } else {
      unregistered.push(hit);
    }
  }
  // 契约登记了、但**已经找不到**的豁免（要么收口了、要么路径变了）—— 如实报出来。
  const stale = exemptions
    .filter((item) => String(item.kind || '').includes('限期豁免'))
    .filter((item) => !registered.some((hit) => hit.exemption === item.where))
    .map((item) => item.where);
  return { hits, registered, unregistered, stale, exemptions };
}

// —— 命令行 ——
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = inspect(ROOT);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      registered: result.registered.map((item) => `${item.file}:${item.line} ${item.rule}`),
      unregistered: result.unregistered.map((item) => `${item.file}:${item.line} ${item.rule}`),
      stale: result.stale,
    }, null, 2));
  } else {
    console.log('【登记在案的例外】（契约 file-center-v1.json · exemptions）');
    if (!result.registered.length) console.log('  （一处都没有）');
    for (const item of result.registered) {
      console.log(`  · ${item.file}:${item.line}  ${item.rule}  —— ${item.exemption}（${item.kind}）`);
    }
    if (result.stale.length) {
      console.log('【登记了但已经找不到的限期豁免】（可能已收口，或路径变了）');
      for (const item of result.stale) console.log(`  · ${item}`);
    }
    console.log('【没登记的绕过】（域自己放字节 ⇒ 违反「所有进尚书的文件都进文件中心」）');
    if (!result.unregistered.length) console.log('  （一处都没有）');
    for (const item of result.unregistered) {
      console.log(`  · ${item.file}:${item.line}  ${item.rule} —— ${item.note}`);
      console.log(`      ${item.text}`);
    }
  }
  if (result.unregistered.length) process.exit(1);
}
