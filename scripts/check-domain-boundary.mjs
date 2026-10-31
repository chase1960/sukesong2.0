#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function matchesPath(file, entry) {
  const normalizedFile = normalizePath(file);
  const normalizedEntry = normalizePath(entry);
  return normalizedEntry.endsWith('/')
    ? normalizedFile.startsWith(normalizedEntry)
    : normalizedFile === normalizedEntry;
}

function matchesAny(file, entries = []) {
  return entries.some((entry) => matchesPath(file, entry));
}

export function classifyPath(policy, file) {
  const paths = policy.paths || {};
  if (matchesAny(file, paths.forbidden)) return 'forbidden';
  if (matchesAny(file, paths.allowed)) return 'allowed';
  if (matchesAny(file, paths.review_required)) return 'review';
  return policy.default_path_classification || 'review';
}

function compileRule(rule) {
  const flags = rule.flags || 'i';
  return {
    ...rule,
    regex: new RegExp(rule.pattern, flags),
    // 求值用：需要逐个命中比对，故另备一份带 g 的副本（matchAll 内部会克隆，不污染原串状态）
    globalRegex: new RegExp(rule.pattern, flags.includes('g') ? flags : `${flags}g`),
  };
}

function appliesToFile(rule, file) {
  if (!rule.extensions?.length) return true;
  return rule.extensions.some((extension) => file.endsWith(extension));
}

// 当前文件所属的包名：frappe_apps/<包>/ 下的文件属于那个包。
// 不在 frappe_apps 下的文件（scripts/、shangshu-server/ 等）没有「所属行业包」，
// 返回 null —— 此时内容规则维持原语义（命中即报），不给任何豁免。
export function owningPackageOf(file) {
  const match = normalizePath(file).match(/^frappe_apps\/(shangshu_[a-z0-9_]+)\//);
  return match ? match[1].toLowerCase() : null;
}

// 文件所属的**领域**（比 owningPackageOf 宽：还认 web 的领域目录）。
// `shangshu-web/js/domains/<x>/` 与 `css/domains/<x>/` 是**领域目录，不算内核**
// —— CLAUDE.md §十原文：「shangshu-web/js/domains/ 和 shangshu-web/css/domains/
// 下的不算内核，是领域目录」。先前这两处落到 default_path_classification，
// 被贴上「属于公共内核或未登记区域」，是**把领域目录误报成内核**（T02-A）。
export function domainOf(file) {
  const normalized = normalizePath(file);
  const pkg = owningPackageOf(normalized);
  // `shangshu_core` 是**内核/公共底座**，不是「别的领域」—— 每份策略都该审它
  // （它在各策略的 review_required 里），把它当 foreign 会把 29 条「需要
  // CORE-CANDIDATE」错记成「不在本策略范围」。归 null = 公共区。
  if (pkg === 'shangshu_core') return null;
  if (pkg) return pkg;
  const web = normalized.match(/^shangshu-web\/(?:js|css)\/domains\/([^/]+)\//);
  return web ? `web:${web[1].toLowerCase()}` : null;
}

// 测试代码不许被当成「偷依赖另一个行业」。同一原则在 check-platform-contract.mjs
// 已有先例（「测试可查数据库断言；生产领域代码只能通过公共接口读写核心事实」）。
// `test-mail-*.py` 里引入 shangshu_mail（注意：这里**故意不写成 import/from 的整串**，
// 否则本文件自己会被 no-foreign-domain-import 按文本命中 —— 实测踩过）是**测试该测的
// 东西**，不是「领域 A 偷依赖领域 B」。**这不是扩 allowlist**：生产领域代码的偷依赖照报
// （判据 T02-B 的反例钉着），只是把规则的作用范围校正到它管的那类文件上。
export function isTestCode(file) {
  const normalized = normalizePath(file);
  const parts = normalized.split('/');
  return parts.includes('tests') || /(^|\/)test-[^/]+$/.test(normalized);
}

// 本策略的领域（`domain` 字段形如 com.shangshu.files → shangshu_files）。
// 用于区分「本域 / 公共区」与「别的已登记域」——一份策略**不该判定**别人的改动。
function policyDomainOf(policy) {
  const id = String(policy.domain || '');
  const short = id.split('.').pop();
  // ⚠️ **连字符要换成下划线**（2026-10-23，PKG-042-T02）：
  // 域 id `com.shangshu.example-domain` ⇒ 包名是 **`example_extension`**（下划线）。
  // 原来直接拼出 `example_extension-domain`（连字符）⇒ **跟真包名对不上**
  // ⇒ 「本域在场」永远判不出来（example 那一整套「越界必须挡」的逻辑一直落空）
  // ⇒ 「域专属规则只判本域的文件」也认不出本域。
  return short ? `shangshu_${short.replace(/-/g, '_')}` : null;
}

// 一次规则命中里真正被引入的 shangshu_* 包名。
// 在命中文本基础上向后吞两种连带写法：
//   1) 点号子模块 —— 命中只到包名（\b 截断），.entities 这类要自己接上；
//   2) 逗号并列  —— 一行里「自包, 外包」「自包子模块, 外包子模块」并列时，
//      藏在逗号后面的外包不能漏。
// 只会多吞包名、不会少报：吞进来的每个非本包名都会判成跨域。
function importedPackagesOf(content, match) {
  const rest = content.slice(match.index + match[0].length);
  const continuation = rest.match(/^(?:\.[A-Za-z_]\w*|\s*,\s*[A-Za-z_][\w.]*)*/)?.[0] || '';
  return [...`${match[0]}${continuation}`.matchAll(/shangshu_[a-z0-9_]+/gi)]
    .map((token) => token[0].toLowerCase());
}

export function inspectChanges(
  policy,
  changes,
  readText = (file) => readFileSync(file, 'utf8'),
  fileExists = existsSync,
) {
  const results = [];
  const contentRules = (policy.content_rules || []).map(compileRule);
  const immutablePaths = policy.immutable_after_base || [];
  const policyDomain = policyDomainOf(policy);

  // **越界的判定需要「本域在场」**（PKG-013-T02）：`paths.forbidden` 说的是
  // 「本域分支不许改这些」。判定它的前提是「这确实是本域的改动」——
  //   · 变更集里有本域的改动、又碰到别域的禁止路径 → **越界，阻断**
  //   · 变更集全是别的域的改动（C 在审自己的 mail 分支）→ 那是**别人家的账**，
  //     本策略不判定，提示「用该域自己的策略审」，不阻断
  // 没有这条区分，一份 files.json 会被拿去审 C 的 mail 改动、记 16 条「禁止」——
  // 那 16 条全是 C 自己的代码，当违规数报就是错账。
  const hasOwnDomainChange = changes.some((change) => {
    const d = domainOf(normalizePath(change.file));
    return Boolean(d && policyDomain && d === policyDomain);
  });

  for (const change of changes) {
    const file = normalizePath(change.file);
    const status = String(change.status || 'M').slice(0, 1).toUpperCase();
    const domain = domainOf(file);
    const isForeign = Boolean(domain && policyDomain && domain !== policyDomain);
    const scope = isForeign ? 'foreign' : 'own';

    // `shangshu-web/{js,css}/domains/` 是**领域目录，不算内核**（CLAUDE.md §十）。
    // 永远不贴「属于公共内核或未登记区域」—— 那是把领域目录误报成内核（T02-A）。
    const isWebDomainDir = /^shangshu-web\/(?:js|css)\/domains\//.test(file);
    if (isWebDomainDir && isForeign) {
      results.push({
        level: 'info',
        code: 'OUT_OF_SCOPE',
        scope,
        domain: domain || '公共区',
        file,
        detail: `属于 ${domain} 的领域目录改动，不由本策略（${policy.domain}）判定；`
          + 'js/css 的 domains/ 目录不算内核',
      });
    } else {
      const classification = classifyPath(policy, file);
      if (classification !== 'allowed') {
        // 别域的禁止路径：本域在场 = 越界（**本策略的违规**，阻断）；
        // 本域不在场 = 别人家的账（提示，不阻断）。scope 跟着走 ——
        // 越界记 scope='own'，否则退出码会把它跳过，「越界必须挡」就落空了。
        const pureForeignPath = classification === 'forbidden' && isForeign && !hasOwnDomainChange;
        const level = pureForeignPath ? 'info' : classification;
        const scopeHere = pureForeignPath ? 'foreign' : 'own';
        results.push({
          level,
          code: classification === 'forbidden' ? 'PATH_FORBIDDEN' : 'CORE_REVIEW_REQUIRED',
          scope: scopeHere,
          domain: domain || '公共区',
          file,
          detail: classification === 'forbidden'
            ? (pureForeignPath
              ? `路径归属 ${domain || '公共区'}，看起来是该域自己的改动，本策略（${policy.domain}）不判定；`
                + `若这确实是本域改动越界到 ${domain}，就是违规 —— 请用 ${domain} 自己的策略或本域分支复核`
              : `本域改动越界到 ${domain || '公共区'}：${policy.domain} 分支禁止修改该路径`)
            : '该路径属于公共内核或未登记区域，需要拆分为 CORE-CANDIDATE',
        });
      }
    }

    if (status !== 'A' && matchesAny(file, immutablePaths)) {
      results.push({
        level: 'forbidden',
        code: 'HISTORICAL_MIGRATION_IMMUTABLE',
        scope: 'own',
        file,
        detail: '已经进入基线的 migration/patch 不允许修改或删除；请追加新迁移',
      });
    }

    if (status === 'D' || !fileExists(file)) continue;
    let content = '';
    try {
      content = readText(file);
    } catch {
      continue;
    }
    const ownPackage = owningPackageOf(file);
    const testCode = isTestCode(file);
    for (const rule of contentRules) {
      if (!appliesToFile(rule, file)) continue;
      // **域专属的规则只判本域的文件**（2026-10-23，PKG-042-T02）。
      //
      // 规则自己写着「**example 域**不得直接读写其他业务域 DocType」「**example 域**只能依赖
      // shangshu_core.public_api」⇒ 它说的就是**本域**的事。
      // 拿本域的策略去判**别的域**的文件 ⇒ 那个域写**自己的**表名
      // （比如邮件域文件里的 `'Shangshu Mail Message'` —— 那是**它自己的**表）
      // 也会被报成「越界」⇒ **那是错账**，不是违规。
      //
      // **不是放水**：别域的问题由**它自己的策略**判（邮件域有 `scripts/domain-policies/mail.json`），
      // 「偷依赖内核内部模块」由 `check-platform-contract.mjs` **全站**判
      // （邮件域 `service.py` 那条 `shangshu_core.attachments` 至今仍被它如实报出来）。
      // 本域的文件该报**照报**（见判据反例）。
      if (rule.scope === 'own_domain' && domainOf(file) !== policyDomain) continue;
      // 测试代码不判「偷依赖另一个行业」（T02-B，原则同 check-platform-contract.mjs
      // 的「测试可查数据库断言」）。**不是扩 allowlist**：生产领域代码照报，见判据反例。
      //
      // 同一条理由再往前走一步：**「偷依赖另一个行业」的前提是「你是一个行业」**。
      // 只有 `frappe_apps/<包>/` 下的领域模块才是行业；脚本、夹具、BFF、测试都不是 ——
      // 判它们只是把注释里的引用和临时夹具算成违规（实测两条：本文件自己的注释被文本命中、
      // `page-timing/n5-real-page-setup.py` 头一行写明是临时夹具）。
      // **不许拿这条当放水**：`frappe_apps/<包>/` 下的真·偷依赖照报，判据反例钉着。
      if (rule.id === 'no-foreign-domain-import' && (testCode || owningPackageOf(file) === null)) continue;
      let violated = false;
      for (const match of content.matchAll(rule.globalRegex)) {
        const imported = importedPackagesOf(content, match);
        // 命中文本里没有 shangshu_* 包名（如破坏性 SQL 规则）→ 维持原语义：命中即报
        if (!imported.length) {
          violated = true;
          break;
        }
        // 有任一包不等于本文件所属的包 → 真·跨行业依赖，报
        if (imported.some((pkg) => pkg !== ownPackage)) {
          violated = true;
          break;
        }
        // 这个命中全是「自己 import 自己」→ 跳过，继续看后面的命中
      }
      if (!violated) continue;
      // 内容规则是**通用**规则（「任何域都不许偷依赖别的域」），不是本策略专属 ——
      // 所以落在别的域的文件**照判**，标 scope='own' 计入违规。只有 `paths` 那层才分域。
      results.push({
        level: rule.level || 'forbidden',
        code: rule.id,
        scope: 'own',
        domain: domain || '公共区',
        file,
        detail: rule.message,
      });
    }
  }
  return results;
}

export function parseNameStatus(output) {
  return String(output || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const status = parts[0];
      return { status, file: normalizePath(parts.at(-1)) };
    });
}

export function mergeChanges(...groups) {
  const byFile = new Map();
  for (const group of groups) {
    for (const change of group) byFile.set(normalizePath(change.file), change);
  }
  return [...byFile.values()].sort((left, right) => left.file.localeCompare(right.file));
}

function readArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

export function gitArguments(args) {
  return ['-c', 'core.quotepath=false', ...args];
}

function loadPolicy(path) {
  if (!path) throw new Error('缺少 --policy <file>');
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`领域策略不存在：${path}`);
  const policy = JSON.parse(readFileSync(absolute, 'utf8'));
  if (!policy.domain || !policy.paths?.allowed?.length) throw new Error('领域策略缺少 domain 或 paths.allowed');
  return policy;
}

function changesFromGit(base) {
  const git = (args) => execFileSync('git', gitArguments(args), { encoding: 'utf8' });
  const committed = parseNameStatus(git(['diff', '--name-status', '--find-renames', `${base}...HEAD`]));
  const staged = parseNameStatus(git(['diff', '--cached', '--name-status', '--find-renames']));
  const unstaged = parseNameStatus(git(['diff', '--name-status', '--find-renames']));
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => ({ status: 'A', file: normalizePath(file) }));
  return mergeChanges(committed, staged, unstaged, untracked);
}

/**
 * **本域全量**（2026-10-24 · PKG-084-T01）：把「本域自己的全部文件」当变更集查一遍。
 *
 * **为什么要有这个口子**：那个闸按**差集**算（`git diff <base>...HEAD`）⇒
 * 在**基线线上**（当前分支就是那把尺子）它查到的是 **0 个文件**
 * ⇒ 「绿」但**什么都没查** —— 那不是「守住了」，是「没看」。
 * ⇒ 这个口子让它**永远有料**：本域目录里的每个文件都过一遍内容规则
 * （偷依赖别的域／直查别的域的表／破坏性 SQL／直 import 内核私有模块）。
 *
 * 状态怎么记：相对 base **改过**的照实（改过／删过），**没改过**的记 'A'
 * —— 'A' 在这里的意思是「相对 base 没动过」，
 * 这样「进了基线的 migration 不许改」那条**不会因为「我把全树都当变更」而误报**。
 */
function ownTreeChanges(policy, base) {
  const git = (args) => execFileSync('git', gitArguments(args), { encoding: 'utf8' });
  const tracked = git(['ls-files']).split(/\r?\n/).filter(Boolean).map(normalizePath);
  const prefixes = (policy.paths.allowed || []).filter((entry) => entry.endsWith('/'));
  const own = tracked.filter((file) => prefixes.some((prefix) => file.startsWith(prefix)));
  const changed = new Map(changesFromGit(base).map((change) => [change.file, change]));
  return own.map((file) => changed.get(file) || { status: 'A', file });
}

function printReport(policy, changes, results, base, fullTree = false) {
  console.log(`[domain-boundary] ${policy.domain}：检查 ${changes.length} 个变更文件`
    + (fullTree
      ? '（**本域全量**：本域目录里的每个文件都过一遍内容规则）'
      : (base ? `（base ${base} 起的**合计**）` : '')));
  // **查了 0 个文件 ≠ 守住了**（2026-10-24 · PKG-084-T01）：
  // 差集口径下，在基线线上（当前分支就是尺子）这个闸查到的是 0 个文件
  // ⇒ 「绿」但**什么都没看**。这句提醒不许被当成通过。
  if (!changes.length) {
    console.log('[domain-boundary] ⚠ 查了 0 个文件 ⇒ 这次**什么都没查**（不算守住；'
      + '要真查本域，用 --full-tree）');
  }
  // **合计不是单笔违规**（PKG-013-T02）：集成分支上几条线的改动混在同一份 diff 里，
  // 一份 files.json 会把别人家的 mail 改动算成「本域越界」。所以报头必须写清
  // 这是 base 起的合计 —— 拿它当「这一笔提交的违规数」就是错账。
  const foreign = results.filter((item) => item.scope === 'foreign');
  const own = results.filter((item) => item.scope !== 'foreign');
  if (!own.length && !foreign.length) {
    console.log('[domain-boundary] 通过：所有变更均在领域边界内');
    return;
  }
  for (const result of own) {
    const label = result.level === 'forbidden' ? '禁止' : '需要审核';
    console.error(`\n[${label}] ${result.code}\n  文件：${result.file}\n  原因：${result.detail}`);
  }
  const forbidden = own.filter((item) => item.level === 'forbidden').length;
  const review = own.filter((item) => item.level === 'review').length;
  // **分开报**（PKG-013-T02）：「别的模块」不算本策略的违规，单列计数。
  // 拿总数当违规数，就是把配置误报当真实缺陷 —— 契约明令不许。
  if (foreign.length) {
    const byDomain = new Map();
    for (const item of foreign) {
      const key = item.domain || '其他';
      byDomain.set(key, (byDomain.get(key) || 0) + 1);
    }
    const parts = [...byDomain.entries()].map(([name, count]) => `${name} ${count} 项`).join('、');
    console.log(`\n[domain-boundary] 不在本策略范围 ${foreign.length} 项（不计违规，本策略不判定）：${parts}`);
  }
  if (own.length) {
    console.error(`\n[domain-boundary] 未通过：本域禁止 ${forbidden} 项，需要内核审核 ${review} 项`
      + (foreign.length ? `（另有不在本策略范围 ${foreign.length} 项，上面单列，不计入这两个数）` : ''));
  } else {
    console.log(`\n[domain-boundary] 通过：本域无违规（${foreign.length} 项属别的模块，不计违规）`);
  }
}

export function run(argv = process.argv.slice(2)) {
  const args = readArguments(argv);
  const policy = loadPolicy(args.policy);
  const base = args.base || policy.base_branch;
  if (!base) throw new Error('缺少 --base，且策略没有 base_branch');
  // **--full-tree**（PKG-084-T01）：查本域**全部**文件，不只查「相对尺子的这批改动」。
  // 差集口径在基线线上查到 0 个文件 ⇒ 那是「没看」，不是「守住」。
  const fullTree = Boolean(args['full-tree']);
  const changes = fullTree ? ownTreeChanges(policy, base) : changesFromGit(base);
  const results = inspectChanges(policy, changes);
  printReport(policy, changes, results, base, fullTree);
  // **退出码只看本域违规** —— 别的模块的改动不阻断本策略（它们由各自域的策略审）。
  const own = results.filter((item) => item.scope !== 'foreign');
  if (own.some((item) => item.level === 'forbidden')) return 1;
  if (own.some((item) => item.level === 'review')) return 2;
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`[domain-boundary] 检查失败：${error.message}`);
    process.exitCode = 1;
  }
}
