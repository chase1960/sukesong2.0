#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH = 'frappe_apps/shangshu_core/shangshu_core/contracts/platform-api-v1.json';
const PUBLIC_API_PATH = 'frappe_apps/shangshu_core/shangshu_core/public_api/__init__.py';
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const PLATFORM_V1 = /^(?:\^1(?:\.\d+){0,2}|>=1(?:\.\d+){0,2}\s+<2(?:\.0){0,2})$/;
const RESOURCE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;

function unquote(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text;
}

function scalar(value) {
  const text = unquote(value);
  if (text === '[]') return [];
  if (text === '{}') return {};
  return text;
}

export function parsePluginManifest(text) {
  const result = { exports: {}, dependencies: [], optional_dependencies: [], migrations: [] };
  let section = '';
  let subsection = '';
  for (const source of String(text).split(/\r?\n/)) {
    const line = source.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0) {
      subsection = '';
      if (trimmed.endsWith(':')) {
        section = trimmed.slice(0, -1);
        continue;
      }
      const match = trimmed.match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (match) {
        result[match[1]] = scalar(match[2]);
        section = '';
      }
      continue;
    }
    if (indent === 2 && trimmed.endsWith(':')) {
      subsection = trimmed.slice(0, -1);
      if (section === 'exports') result.exports[subsection] ||= [];
      continue;
    }
    if (trimmed.startsWith('- ')) {
      const value = unquote(trimmed.slice(2));
      if (section === 'dependencies') result.dependencies.push(value);
      else if (section === 'optional_dependencies') result.optional_dependencies.push(value);
      else if (section === 'migrations') result.migrations.push(value);
      else if (section === 'exports' && subsection) result.exports[subsection].push(value);
    }
  }
  return result;
}

function walk(path, predicate, result = []) {
  if (!existsSync(path)) return result;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) walk(target, predicate, result);
    else if (predicate(target)) result.push(target);
  }
  return result;
}

export function validateManifests(entries) {
  const errors = [];
  const owners = new Map();
  for (const entry of entries) {
    const { file, manifest } = entry;
    if (!/^com\.shangshu\.[a-z0-9][a-z0-9._-]*$/.test(manifest.id || '')) errors.push(`${file}: MANIFEST_ID_INVALID`);
    if (!SEMVER.test(manifest.version || '')) errors.push(`${file}: MANIFEST_VERSION_NOT_SEMVER`);
    if (!PLATFORM_V1.test(manifest.platform_api || '')) errors.push(`${file}: PLATFORM_API_RANGE_INVALID`);
    if (manifest.id !== 'com.shangshu.core' && !(Array.isArray(manifest.dependencies) && manifest.dependencies.some((item) => String(item).startsWith('com.shangshu.core@')))) errors.push(`${file}: CORE_DEPENDENCY_MISSING`);
    const targets = new Set();
    for (const key of ['dependencies', 'optional_dependencies']) {
      if (!Array.isArray(manifest[key] ?? [])) { errors.push(`${file}: DEPENDENCY_INVALID ${key}`); continue; }
      for (const declaration of manifest[key] || []) {
        const match = String(declaration).match(/^(com\.shangshu\.[a-z0-9][a-z0-9._-]*)@(.+)$/);
        if (!match) { errors.push(`${file}: DEPENDENCY_INVALID ${declaration}`); continue; }
        if (targets.has(match[1])) errors.push(`${file}: DEPENDENCY_DUPLICATE ${match[1]}`);
        targets.add(match[1]);
        if (key === 'optional_dependencies' && match[1] === 'com.shangshu.core') errors.push(`${file}: OPTIONAL_CORE_FORBIDDEN`);
      }
    }
    if (new Set(manifest.migrations).size !== manifest.migrations.length) errors.push(`${file}: MIGRATION_DUPLICATE`);
    const actionIds = new Set(manifest.exports.actions || []);
    for (const tool of manifest.exports.tools || []) if (!actionIds.has(tool)) errors.push(`${file}: TOOL_WITHOUT_ACTION ${tool}`);
    for (const card of manifest.exports.workbench || []) if (!RESOURCE_ID.test(card)) errors.push(`${file}: WORKBENCH_ID_INVALID ${card}`);
    for (const [section, ids] of Object.entries(manifest.exports)) {
      for (const id of ids) {
        const key = `${section}:${id}`;
        if (owners.has(key)) errors.push(`${file}: RESOURCE_OWNER_CONFLICT ${key} (${owners.get(key)})`);
        else owners.set(key, manifest.id);
      }
    }
  }
  return errors;
}

export function validatePublicImports(appRoot, appId) {
  if (appId === 'com.shangshu.core') return [];
  const errors = [];
  const owners = doctypeOwners();
  // appId 形如 com.shangshu.files → 本应用的包名 shangshu_files
  // ⚠️ 域 id 尾段**可以带连字符**（PKG-015-T01 的 com.shangshu.example-domain）⇒ 包名里连字符换成下划线，
  //    否则「自己查自己」会被判成跨域。域 id ≠ 资源 id ≠ 路由，这三套名字不要一起改。
  const owningApp = `shangshu_${String(appId || '').split('.').pop().replace(/-/g, '_')}`;
  for (const file of walk(appRoot, (target) => target.endsWith('.py'))) {
    const text = readFileSync(file, 'utf8');
    const forbidden = /(?:from\s+shangshu_core\.(?!public_api(?:\s|\.|\b))|import\s+shangshu_core\.(?!public_api(?:\s|\.|\b)))/g;
    if (forbidden.test(text)) errors.push(`${relative(ROOT, file)}: PRIVATE_CORE_IMPORT`);
    // 测试可查数据库断言；生产领域代码只能通过公共接口读写核心事实。
    const isTest = relative(appRoot, file).split(/[\\/]/).includes('tests');
    if (!isTest && validateCoreTableAccess(text)) {
      errors.push(`${relative(ROOT,file)}: PRIVATE_CORE_DOCTYPE_ACCESS`);
    }
    // **跨域直查**（PKG-013-T02）：直取**别的应用**的 DocType 就是绕过公共契约。
    // 老口径只收内核名单，领域 A 查领域 B 的表根本拦不到 —— 契约 T02-③ 点名的盲区。
    if (!isTest) {
      for (const hit of crossDomainTableAccess(text, owningApp, owners)) {
        errors.push(`${relative(ROOT,file)}: CROSS_DOMAIN_DOCTYPE_ACCESS ${hit.name}（属 ${hit.app}）`);
      }
    }
  }
  return errors;
}

export function validateCoreTableAccess(source) {
  const names = walk(join(ROOT,'frappe_apps/shangshu_core/shangshu_core/shangshu_core/doctype'), file=>file.endsWith('.json'))
    .map(file=>JSON.parse(readFileSync(file,'utf8')).name).filter(Boolean);
  return names.some(name=>String(source).includes('"'+name+'"') || String(source).includes("'"+name+"'"));
}

// 每个 DocType 归属哪个应用：`frappe_apps/<app>/…/doctype/<x>/<x>.json` 的 `name`。
// **收全所有应用**，不只内核 —— 只收内核会漏掉「领域 A 直查领域 B 的表」，
// 那正是契约 T02-③ 点名的盲区（`validateCoreTableAccess` 老口径只有内核名单）。
export function doctypeOwners(root = ROOT) {
  const owners = new Map();
  for (const file of walk(join(root, 'frappe_apps'), (target) => target.endsWith('.json'))) {
    const normalized = file.replaceAll('\\', '/');
    if (!normalized.includes('/doctype/')) continue;
    const app = normalized.match(/frappe_apps\/(shangshu_[a-z0-9_]+)\//)?.[1];
    if (!app) continue;
    let name = '';
    try {
      name = JSON.parse(readFileSync(file, 'utf8')).name || '';
    } catch {
      continue;
    }
    if (name && !owners.has(name)) owners.set(name, app.toLowerCase());
  }
  return owners;
}

// 注释 / 三引号文档串的**惰性区**：这些位置里的代码是**说明文字**，不是要跑的代码。
// 为什么必须排除：`shangshu_mail/delivery.py:282-290` 整段文档串在讲
// 「为什么**不** `frappe.db.exists('Shangshu File Center Version', …)` 直查、改走
// `files.imported_of`」——那是**教训**。把它报成违规，等于惩罚正确做法，
// 而且会让人下次干脆不写注释。判据 T02-J 钉这条。
// 只遮**注释**与 **`'''`/`"""` 文档串**，不遮普通字符串 —— 否则 `{"doctype": "X"}`
// 这种正常的表名声明也会被一起遮掉。
function pyInertMask(code) {
  const text = String(code ?? '');
  const mask = new Array(text.length).fill(false);
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') mask[i++] = true;
      continue;
    }
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      const quote = text.slice(i, i + 3);
      const end = text.indexOf(quote, i + 3);
      const stop = end === -1 ? text.length : end + 3;
      while (i < stop) mask[i++] = true;
      continue;
    }
    // 普通字符串：跳过内容（表名声明就在普通字符串里，不遮）
    if (c === '"' || c === "'") {
      i += 1;
      while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return mask;
}

// 真的会摸表的调用位。**裸 `text.includes(表名)` 不算** —— 那会把注释、文档、
// 甚至「把表名当参数值传给公共口」全算成违规（`delivery.py:442` 的 `'ref': …`
// 就是传参，那个口自带 `can_read_reference` 判定，不是查表）。判据 T02-K。
const TABLE_ACCESS_CALL = /frappe\.(?:db\.)?(?:get_doc|get_all|get_list|get_value|exists|set_value|delete_doc|get_cached_doc|new_doc|get_meta)\s*\(\s*["']([^"']+)["']/g;
const DOCTYPE_KEY = /["']doctype["']\s*:\s*["']([^"']+)["']/g;

// 跨域直查：**真的去摸**别的应用的 DocType，就是绕过公共契约直取人家的账。
// 跨域只准走 `shangshu_core.public_api` / 事件总线。
// 回命中清单（表名 + 归属应用），空 = 干净。
export function crossDomainTableAccess(source, owningApp, owners = doctypeOwners()) {
  const text = String(source ?? '');
  const own = String(owningApp || '').toLowerCase();
  const inert = pyInertMask(text);
  // 只收集**真的被摸**的表名 —— 注释/文档串里的不算
  const touched = new Set();
  for (const regex of [TABLE_ACCESS_CALL, DOCTYPE_KEY]) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      if (inert[match.index]) continue;  // 在注释或文档串里 = 说明文字，不是代码
      touched.add(match[1]);
    }
  }
  const hits = [];
  for (const [name, app] of owners) {
    // **内核不算「别的域」**（同 check-domain-boundary 的 T02-E）：它是公共底座，
    // 直取内核表另有 `PRIVATE_CORE_DOCTYPE_ACCESS` 在管，在这里再报一次是重复计数、
    // 也会把「跨域」这个词冲淡。跨域专指**领域 A 直取领域 B**。
    if (app === own || app === 'shangshu_core') continue;
    if (touched.has(name)) hits.push({ name, app });
  }
  return hits;
}

function previousContract(base) {
  try {
    const text = execFileSync('git', ['show', `${base}:${CONTRACT_PATH}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function validateContract(current, previous, exportedNames) {
  const errors = [];
  if (!SEMVER.test(current.api_version || '')) errors.push('CONTRACT_VERSION_NOT_SEMVER');
  if (current.entrypoint !== 'shangshu_core.public_api') errors.push('CONTRACT_ENTRYPOINT_INVALID');
  const workbench = current.workbench_contract || {};
  if (!SEMVER.test(workbench.version || '')) errors.push('WORKBENCH_CONTRACT_VERSION_NOT_SEMVER');
  if (workbench.schema !== 'contracts/workbench-contribution-v1.schema.json') errors.push('WORKBENCH_CONTRACT_SCHEMA_INVALID');
  if (!Array.isArray(workbench.supported_kinds) || !workbench.supported_kinds.includes('metric')) errors.push('WORKBENCH_METRIC_KIND_MISSING');
  if (workbench.layout_mode !== 'plugin_defaults_only') errors.push('WORKBENCH_LAYOUT_MODE_MUST_BE_TRUTHFUL');
  for (const [resource, operations] of Object.entries(current.resources || {})) {
    if (!Array.isArray(operations) || !operations.length) errors.push(`CONTRACT_RESOURCE_EMPTY ${resource}`);
    for (const operation of operations) if (!exportedNames.has(operation)) errors.push(`CONTRACT_EXPORT_MISSING ${operation}`);
  }
  if (previous && String(previous.api_version).split('.')[0] === String(current.api_version).split('.')[0]) {
    for (const [resource, operations] of Object.entries(previous.resources || {})) {
      const next = new Set(current.resources?.[resource] || []);
      for (const operation of operations) if (!next.has(operation)) errors.push(`BREAKING_CONTRACT_REMOVAL ${resource}.${operation}`);
    }
    for (const section of previous.resource_sections || []) if (!(current.resource_sections || []).includes(section)) errors.push(`BREAKING_SECTION_REMOVAL ${section}`);
  }
  return errors;
}

export function run(argv = process.argv.slice(2)) {
  const baseFlag = argv.indexOf('--base');
  const base = baseFlag >= 0 ? argv[baseFlag + 1] : 'origin/fast';
  const manifests = walk(join(ROOT, 'frappe_apps'), (file) => basename(file) === 'shangshu-plugin.yml')
    .map((file) => ({ file: relative(ROOT, file), root: dirname(file), manifest: parsePluginManifest(readFileSync(file, 'utf8')) }));
  const errors = validateManifests(manifests);
  for (const entry of manifests) errors.push(...validatePublicImports(entry.root, entry.manifest.id));
  const contract = JSON.parse(readFileSync(join(ROOT, CONTRACT_PATH), 'utf8'));
  const workbenchSchemaPath = join(ROOT, 'frappe_apps/shangshu_core/shangshu_core', contract.workbench_contract?.schema || '');
  if (!existsSync(workbenchSchemaPath)) errors.push('WORKBENCH_SCHEMA_MISSING');
  else {
    try {
      const schema = JSON.parse(readFileSync(workbenchSchemaPath, 'utf8'));
      if (schema?.properties?.workbench_api?.const !== contract.workbench_contract?.version) errors.push('WORKBENCH_SCHEMA_VERSION_MISMATCH');
    } catch {
      errors.push('WORKBENCH_SCHEMA_INVALID_JSON');
    }
  }
  const publicApi = readFileSync(join(ROOT, PUBLIC_API_PATH), 'utf8');
  const allBlock = publicApi.match(/__all__\s*=\s*\[([\s\S]*?)\]/)?.[1] || '';
  const exported = new Set([...allBlock.matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']/g)].map((match) => match[1]));
  errors.push(...validateContract(contract, previousContract(base), exported));
  if (errors.length) {
    for (const error of errors) console.error(`[platform-contract] ${error}`);
    console.error(`[platform-contract] 未通过：${errors.length} 项`);
    return 1;
  }
  console.log(`[platform-contract] 通过：${manifests.length} 个 manifest，public_api ${contract.api_version}，未发现私有内核依赖或破坏性删除`);
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) process.exitCode = run();
