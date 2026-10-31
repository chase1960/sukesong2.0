#!/usr/bin/env node
/* 尚书 Web 视觉一致性检查器
   —— 规则从参照系（文件中心 / Excel 清单页 / 工作台）反推，不是另造一套设计系统。
   —— 人读规范：docs/standards/visual-consistency-rules.md
   —— 机器可读规范：shangshu-web/style-rules.json

   用法：
     node scripts/check-style-rules.mjs                # 跑检查：有「新增违反」退出码 1
     node scripts/check-style-rules.mjs --report       # 同上，并把已登记的存量违反也列出来
     node scripts/check-style-rules.mjs --write-baseline  # 把当前存量违反登记进基线（只登记，不修）
     node scripts/check-style-rules.mjs --no-baseline   # 不认基线：任何违反都算新增

   退出码：0 = 通过（无新增违反）；1 = 有新增违反；2 = 用法/环境错。

   ⚠️ 基线（style-rules-baseline.json）不是「假通过」的挡箭牌：
      `--report` 会把**每一条**存量违反连同文件与行号打出来；
      基线只用来区分「已登记的存量」与「本次新引入的」。
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 公共层叠解析器（与判据 `shangshu-web/js/tests/page-shell.test.mjs` 同一套）——
   页面骨架的「算出来的生效值」靠它。
   ⚠️ 有些**判据夹具**只复制检查器本身、不带这个库 ⇒ 那时**跳过**页面骨架复核（不是判违规）。 */
let createResolver = null, px = null, sides = null;
try {
  ({ createResolver, px, sides } = await import('./lib/css-cascade.mjs'));
} catch {
  createResolver = null;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_PATH = path.join(ROOT, 'shangshu-web/style-rules.json');
const BASELINE_PATH = path.join(ROOT, 'shangshu-web/style-rules-baseline.json');

const argv = process.argv.slice(2);
const has = flag => argv.includes(flag);
const REPORT = has('--report');
const WRITE_BASELINE = has('--write-baseline');
const NO_BASELINE = has('--no-baseline');

/* ---------- CSS 解析（够用即可：规则 + 声明 + at-rule 上下文） ---------- */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
}
function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') n++;
  return n;
}
function parseDecls(inner) {
  const decls = [];
  let depth = 0, buf = '';
  const flush = () => {
    const raw = buf.trim();
    buf = '';
    if (!raw) return;
    const at = raw.indexOf(':');
    if (at < 0) return;
    const prop = raw.slice(0, at).trim().toLowerCase();
    /* !important 是优先级标记，不是值的一部分 —— 比对时剥掉（但仍按同一条规则算）。 */
    const value = raw.slice(at + 1).trim().replace(/\s+/g, ' ').replace(/\s*!important\s*$/i, '');
    if (prop) decls.push({ prop, value });
  };
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ';' && depth === 0) { flush(); continue; }
    buf += ch;
  }
  flush();
  return decls;
}
function parseRules(text, start, atRules, out, base) {
  let i = start;
  while (i < text.length) {
    const brace = text.indexOf('{', i);
    if (brace < 0) break;
    const prelude = text.slice(i, brace).replace(/\s+/g, ' ').trim();
    let depth = 1, j = brace + 1;
    while (j < text.length && depth) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    const inner = text.slice(brace + 1, j - 1);
    if (prelude.startsWith('@')) {
      if (inner.includes('{')) parseRules(inner, 0, atRules.concat([prelude]), out, base);
      else out.push({ selector: prelude, decls: parseDecls(inner), atRules, line: lineOf(base, brace) });
    } else {
      out.push({ selector: prelude, decls: parseDecls(inner), atRules, line: lineOf(base, brace) });
    }
    i = j;
  }
}
function parseFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const text = stripComments(raw);
  const rules = [];
  parseRules(text, 0, [], rules, raw);
  return rules;
}
function selectorParts(selector) {
  return selector.split(',').map(part => part.trim());
}
/** 取该文件里、该选择器、**不在任何 at-rule 内**（即基础层）的最后一个声明值 */
function baseValue(rules, selector, property) {
  let value = null, line = null;
  for (const rule of rules) {
    if (rule.atRules.length) continue;
    if (!selectorParts(rule.selector).includes(selector)) continue;
    for (const decl of rule.decls) {
      if (decl.prop === property) { value = decl.value; line = rule.line; }
    }
  }
  return { value, line };
}
function walk(dir, filter, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, acc);
    else if (filter(full)) acc.push(full);
  }
  return acc;
}

/* ---------- 跑检查 ---------- */
const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
const baseline = NO_BASELINE || !fs.existsSync(BASELINE_PATH) ? {} : JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
const violations = [];

/** 读一份内核契约（判据必须从契约取，不许在检查器里另写一套）。 */
function loadContract(name) {
  if (!name) return null;
  const contractPath = path.join(ROOT, 'frappe_apps/shangshu_core/shangshu_core/contracts', name);
  if (!fs.existsSync(contractPath)) return null;
  try { return JSON.parse(fs.readFileSync(contractPath, 'utf8')); } catch { return null; }
}

function report(rule, fingerprint, message, where, extra) {
  violations.push({ id: rule.id, group: rule.group, note: rule.note || '', fingerprint, message, where, ...(extra || {}) });
}

for (const rule of spec.rules) {
  if (rule.type === 'value') {
    const file = path.join(ROOT, rule.file);
    if (!fs.existsSync(file)) { report(rule, `${rule.file}|missing`, `文件不存在：${rule.file}`, rule.file); continue; }
    const rules = parseFile(file);
    const { value, line } = baseValue(rules, rule.selector, rule.property);
    const where = `${rule.file}:${line ?? '?'}  ${rule.selector} { ${rule.property} }`;
    if (value === null) {
      report(rule, `${rule.file}|${rule.selector}|${rule.property}`,
        `缺少声明（期望 ${rule.expect}）`, where);
    } else if (value !== rule.expect) {
      report(rule, `${rule.file}|${rule.selector}|${rule.property}`,
        `值不符：现为 ${value}，期望 ${rule.expect}`, where);
    }
  } else if (rule.type === 'notNone') {
    const file = path.join(ROOT, rule.file);
    if (!fs.existsSync(file)) { report(rule, `${rule.file}|missing`, `文件不存在：${rule.file}`, rule.file); continue; }
    const rules = parseFile(file);
    const { value, line } = baseValue(rules, rule.selector, rule.property);
    const where = `${rule.file}:${line ?? '?'}  ${rule.selector} { ${rule.property} }`;
    if (value === 'none') report(rule, `${rule.file}|${rule.selector}|${rule.property}`, `被置为 none（${rule.note}）`, where);
  } else if (rule.type === 'mediaValue') {
    /* 媒体查询里的值（窄屏那一档）。基础层没声明、只有 @media 里有的，也要能查。 */
    const file = path.join(ROOT, rule.file);
    if (!fs.existsSync(file)) { report(rule, `${rule.file}|missing`, `文件不存在：${rule.file}`, rule.file); continue; }
    const rules = parseFile(file);
    let value = null, line = null;
    for (const ruleItem of rules) {
      if (!ruleItem.atRules.includes(rule.media)) continue;
      if (!selectorParts(ruleItem.selector).includes(rule.selector)) continue;
      for (const decl of ruleItem.decls) {
        if (decl.prop === rule.property) { value = decl.value; line = ruleItem.line; }
      }
    }
    const where = `${rule.file}:${line ?? '?'}  ${rule.media} { ${rule.selector} { ${rule.property} } }`;
    if (value === null) {
      report(rule, `${rule.file}|${rule.media}|${rule.selector}|${rule.property}`,
        `媒体查询里缺少声明（期望 ${rule.expect}）`, where);
    } else if (value !== rule.expect) {
      report(rule, `${rule.file}|${rule.media}|${rule.selector}|${rule.property}`,
        `值不符：现为 ${value}，期望 ${rule.expect}`, where);
    }
  } else if (rule.type === 'uniqueToken') {
    const files = walk(path.join(ROOT, 'shangshu-web/css'), f => f.endsWith('.css'));
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const re = new RegExp(`(^|[;{\\s])${rule.token}\\s*:`, 'g');
      if (!re.test(text)) continue;
      const rel = path.relative(ROOT, file);
      if (!rule.allowedFiles.includes(rel)) {
        report(rule, `${rel}|${rule.token}`, `令牌 ${rule.token} 在 ${rel} 也有定义（只允许 ${rule.allowedFiles.join('、')}）`, `${rel}`);
      }
    }
  } else if (rule.type === 'sourceContains') {
    const file = path.join(ROOT, rule.file);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    for (const needle of rule.contains) {
      if (!text.includes(needle)) {
        report(rule, `${rule.file}|${needle}`, `源码里找不到 ${needle}（${rule.note}）`, rule.file);
      }
    }
  } else if (rule.type === 'sourceMaxCount') {
    const file = path.join(ROOT, rule.file);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const count = (text.match(new RegExp(rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (count > rule.max) {
      report(rule, `${rule.file}|${rule.pattern}`, `出现 ${count} 次（最多 ${rule.max} 次）`, rule.file);
    }
  } else if (rule.type === 'noHardcodedColors') {
    /* 按「文件 + 字面量」聚合：位置（行号）写进消息，基线指纹不含行号（免得改别的行就误报新增）。 */
    const hits = new Map();
    for (const rel of rule.paths) {
      const dir = path.join(ROOT, rel);
      if (!fs.existsSync(dir)) continue;
      for (const file of walk(dir, f => f.endsWith('.css'))) {
        const text = fs.readFileSync(file, 'utf8');
        const relFile = path.relative(ROOT, file);
        text.split('\n').forEach((lineText, index) => {
          const found = lineText.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g);
          if (!found) return;
          for (const literal of found) {
            const key = `${relFile}|${literal}`;
            if (!hits.has(key)) hits.set(key, { relFile, literal, lines: [] });
            hits.get(key).lines.push(index + 1);
          }
        });
      }
    }
    for (const [key, info] of hits) {
      report(rule, key, `硬编码颜色 ${info.literal}（第 ${info.lines.join('、')} 行）`, `${info.relFile}`);
    }
  } else if (rule.type === 'classAllowlist') {
    for (const rel of rule.paths) {
      const dir = path.join(ROOT, rel);
      if (!fs.existsSync(dir)) continue;
      const files = walk(dir, f => /\.(css|js|ts)$/.test(f));
      for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        const relFile = path.relative(ROOT, file);
        const found = new Set();
        const re = /\bbtn-[a-z0-9-]+/g;
        let m;
        while ((m = re.exec(text))) found.add(m[0]);
        for (const token of found) {
          if (!rule.allowlist.includes(token)) {
            report(rule, `${relFile}|${token}`, `自造按钮类 ${token}（白名单：${rule.allowlist.join('、')}）`, relFile);
          }
        }
      }
    }
  } else if (rule.type === 'fileCenterBypass') {    /* 「所有进入尚书的文件都进文件中心」（用户 2026-10-22 15:21 拍板，**内核契约**）。
       治的病：**别的域自己存字节** ⇒ 文件中心成了「一半的文件」——
       绕过去拿到的 `File` 行没有受管身份、没有归属、没有血缘、审计查不到。
       判据：**从内核契约取**（`rule.contract` 指向契约文件）——
       契约里写了「谁自己存字节的特征」与「豁免表」，检查器不许另写一套。 */
    const contract = loadContract(rule.contract);
    if (!contract) {
      report(rule, rule.contract, `读不到内核契约：${rule.contract}（判据必须从契约取）`, rule.contract);
    } else {
      const patterns = (contract.detect && contract.detect.patterns) || [];
      const exemptPaths = (contract.exemptions && contract.exemptions.entries || []).map(e => e.where);
      const excludePaths = (contract.detect && contract.detect.exclude_paths) || [];
      const skipDirs = (contract.detect && contract.detect.skip_dirs) || [];
      const scanPaths = (contract.detect && contract.detect.paths) || rule.paths;
      /* —— 解耦检查：文件中心不许硬编码别的域 id ——
         「每个域声明自己的路径」要能一劳永逸，前提是**谁都不许知道谁**：
         文件中心一旦硬编码了域清单，加一个域就得改它的代码 ⇒ 白搭。 */
      const decouplePatterns = (contract.detect && contract.detect.decoupling_patterns) || [];
      const decoupleScope = (contract.detect && contract.detect.decoupling_scope) || ['frappe_apps/shangshu_files'];
      /* 只扫 **python 源码** —— `shangshu-plugin.yml` 里的 `dependencies` 是**正常的域依赖声明**
         （文件域依赖内核、邮件域），那不是耦合；耦合是**代码里按域 id 分支**。 */
      for (const rel of decoupleScope) {
        const dir = path.join(ROOT, rel);
        if (!fs.existsSync(dir)) continue;
        for (const file of walk(dir, f => f.endsWith('.py'))) {
          const relFile = path.relative(ROOT, file);
          if (skipDirs.some(ex => relFile.includes(ex))) continue;
          const lines = fs.readFileSync(file, 'utf8').split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^\s*#/.test(line)) continue;
            for (const pattern of decouplePatterns) {
              const re = new RegExp(pattern.source, pattern.flags);
              if (!re.test(line)) continue;
              report(rule, `${relFile}|${pattern.label}`,
                `${pattern.label}（第 ${i + 1} 行）——文件中心只认「域声明了什么路径」，不许知道那是哪个域；加新域不该改文件中心的代码`,
                `${relFile}:${i + 1}`);
            }
          }
        }
      }
      /* 豁免匹配：契约里写的 `where` 可能是
         ① 相对仓库根的路径（`frappe_apps/shangshu_files`）；
         ② 相对扫描根的路径（`shangshu_mail/shangshu_mail/delivery.py`）；
         ③ 目录片段（`/tests/`）。
         ⇒ 三种都认：前缀匹配、路径尾段匹配、含 `/` 结尾的片段匹配。 */
      const isExempt = relFile => exemptPaths.some(ex => {
        if (ex.endsWith('/')) return relFile.includes(ex);
        if (relFile === ex || relFile.startsWith(ex + '/')) return true;
        /* 相对扫描根的写法：仓库路径的尾段与它对齐也算。 */
        const tail = relFile.split('/').slice(-ex.split('/').length).join('/');
        return tail === ex;
      });
      for (const rel of scanPaths) {
        const dir = path.join(ROOT, rel);
        if (!fs.existsSync(dir)) continue;
        for (const file of walk(dir, f => f.endsWith('.py'))) {
          const relFile = path.relative(ROOT, file);
          if (excludePaths.some(ex => relFile.startsWith(ex))) continue;
          if (skipDirs.some(ex => relFile.includes(ex))) continue;
          const exempt = isExempt(relFile);
          const text = fs.readFileSync(file, 'utf8');
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^\s*#/.test(line)) continue;                 // 注释不算
            for (const pattern of patterns) {
              const re = new RegExp(pattern.source, pattern.flags);
              if (!re.test(line)) continue;
              report(rule, `${relFile}|${pattern.label}`,
                `${pattern.label}（第 ${i + 1} 行）——字节进尚书只有文件中心这一条路；改走 files.upload / files.import_attachment`
                + (exempt ? '　【已豁免：见契约 exemptions.known_violations_to_fix】' : ''),
                `${relFile}:${i + 1}`, exempt ? {exempt: true} : null);
            }
          }
        }
      }
    }
  } else if (rule.type === 'pageShell') {
    /* 「页面骨架」**逐族复核**（PKG-045-T02）：每一族页头条算出来的高度／间距／标题，
       都必须与参照系**同一个数** —— 不许某页单开一条。
       台账在规范里（`pageShells`，机器可读）⇒ 检查器**不许另写一套**族清单。
       算生效值用**公共层叠解析器**（与判据 `page-shell.test.mjs` 同一套）。 */
    const shells = spec.pageShells;
    if (!createResolver) {
      /* 没有公共层叠解析器（判据夹具）⇒ 跳过这一项，不算违规。 */
    } else if (!shells || !Array.isArray(shells.families) || !shells.families.length) {
      report(rule, 'pageShells|missing', '规范里没有页面骨架台账（pageShells.families）', 'shangshu-web/style-rules.json');
    } else {
      const resolver = createResolver(ROOT);
      const standard = shells.standard || {};
      /* 选择器粗略特异性：id ×10000 ＋ 类 ×100 ＋ 标签 ×1（与判据同一算法）。 */
      const specificity = (selector) => {
        const ids = (selector.match(/#[A-Za-z0-9_-]+/g) || []).length;
        const classes = (selector.match(/\.[A-Za-z0-9_-]+/g) || []).length + (selector.match(/[[\]()]/g) || []).length;
        const tags = (selector.match(/(^|[\s>+~])[a-z][a-z0-9-]*/g) || []).length;
        return ids * 10000 + classes * 100 + tags;
      };
      /** 某族页头条真正生效的属性值（加载顺序 ＋ 特异性，与浏览器一致）。 */
      const effective = (candidates, property) => {
        const hits = [];
        for (const selector of candidates) {
          for (const file of resolver.order) {
            const hit = resolver.resolveIn(file, selector, property, 1440);
            if (!hit) continue;
            hits.push({ selector, order: resolver.order.indexOf(file), value: hit.value, file });
          }
        }
        if (!hits.length) return null;
        hits.sort((a, b) => specificity(a.selector) - specificity(b.selector) || a.order - b.order);
        return hits[hits.length - 1];
      };
      /** 生效高度：写死 height 的取 height；`height:auto` 的取 min-height（内容更长时自己撑开）。 */
      const effectiveHeight = (candidates) => {
        const height = effective(candidates, 'height');
        if (height) {
          const value = px(height.value);
          if (value !== null) return value;
          if (height.value !== 'auto') return null;
        }
        const minHeight = effective(candidates, 'min-height');
        return minHeight ? px(minHeight.value) : null;
      };
      for (const family of shells.families) {
        const where = `pageShell:${family.id}`;
        const height = effectiveHeight(family.box || []);
        if (height === null) {
          report(rule, `${where}|height`, `页头条没有高度声明（骨架要求 ${standard.height}）`, where);
        } else if (standard.height && height !== px(standard.height)) {
          report(rule, `${where}|height`, `页头条高度是 ${height}px —— 应与参照系同一个数（${standard.height}）`, where);
        }
        const gap = effective(family.box || [], 'gap');
        if (!gap) {
          report(rule, `${where}|gap`, `页头条没有间距声明（骨架要求 ${standard.gap}）`, where);
        } else if (standard.gap && px(gap.value) !== px(standard.gap)) {
          report(rule, `${where}|gap`, `页头条元素间距是 ${gap.value} —— 应与参照系同一个数（${standard.gap}）`, where);
        }
        const size = effective(family.title || [], 'font-size');
        if (!size) {
          report(rule, `${where}|font-size`, `标题没有字号声明（骨架要求 ${standard.titleSize}）`, where);
        } else if (standard.titleSize && px(size.value) !== px(standard.titleSize)) {
          report(rule, `${where}|font-size`, `标题字号是 ${size.value} —— 应与参照系同一个数（${standard.titleSize}）`, where);
        }
        const weight = effective(family.title || [], 'font-weight');
        if (!weight) {
          report(rule, `${where}|font-weight`, `标题没有字重声明（骨架要求 ${standard.titleWeight}）`, where);
        } else if (standard.titleWeight && weight.value !== standard.titleWeight) {
          report(rule, `${where}|font-weight`, `标题字重是 ${weight.value} —— 应与参照系同一个数（${standard.titleWeight}）`, where);
        }
      }
    }
  } else if (rule.type === 'loadingSkeleton') {
    /* 「加载骨架＝直接用真页面的结构，在数据到达之前用灰底块占位」
       （用户 2026-10-28 定；**业务域同样适用** ⇒ 扫 `shangshu-web/js` 全部，含 `js/domains/**`）。
       治的病：① 那个 180px 的大空块（`.platform-loading`）＋一行「正在读取…」当加载态；
               ② 骨架**自造一套外壳**（自己起一套类，跟真页面对不上 ⇒ padding／版式必歪）。
       判据：① 源码里出现那个大空块类名 ⇒ 报出来；
             ② 带 `data-skeleton` 的片段里出现的类名，**除灰底块词汇**（类名含 skeleton）外，
                必须在该文件的**真实渲染代码**（不含 data-skeleton 的地方）里也出现过。 */
    for (const rel of rule.paths) {
      const dir = path.join(ROOT, rel);
      if (!fs.existsSync(dir)) continue;
      for (const file of walk(dir, f => f.endsWith('.js'))) {
        const relFile = path.relative(ROOT, file);
        if (rule.exempt.includes(relFile)) continue;
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
          if (rule.bigEmptyBlock && line.includes(rule.bigEmptyBlock)) {
            report(rule, relFile,
              `加载态还在用那个大空块（${rule.bigEmptyBlock}）—— 加载骨架＝直接用真页面的结构（灰底块占位），不留 180px 的空盒子`,
              `${relFile}:${index + 1}`);
          }
        });
        /* 「骨架要可查」：这个文件用了骨架词汇 ⇒ 骨架占位**必须**带 `data-skeleton` 标记
           （没有标记就查不到、改不到、盯不住）。 */
        const usesVocabulary = lines.some(line => /class="[^"]*\bskeleton[-_a-z0-9]*/i.test(line));
        if (usesVocabulary && !lines.some(line => line.includes('data-skeleton'))) {
          report(rule, relFile,
            '这个文件用了骨架词汇，却没有一处 `data-skeleton` 标记 ⇒ 骨架查不到、盯不住',
            relFile);
        }
      }
    }
  } else if (rule.type === 'excelDefault') {
    /* 「Excel 交互是所有数据库交互的默认选项」（用户 2026-10-22 拍板）。
       治的病：**域自己又画一套数据表格** —— 那是最容易长出新表格语言的地方
       （列头、行高、斑马纹、分页各画各的）。
       判据：域前端 CSS 里出现「数据表格」的形状（选择器里点了 `th`／`td` 标签且带声明）
       ⇒ 报出来，除非该文件登记了豁免。 */
    /* 「点了 th/td 标签」：选择器里出现独立的 th/td 词元
       （`.dtable th` 算；`.dtable th:hover` 算；`.dtable` 本身不算；`.thread` 不算）。 */
    const tableShaped = /(?:^|[\s,>+~])(?:th|td)(?![\w-])/;
    for (const rel of rule.paths) {
      const dir = path.join(ROOT, rel);
      if (!fs.existsSync(dir)) continue;
      for (const file of walk(dir, f => f.endsWith('.css'))) {
        const relFile = path.relative(ROOT, file);
        if (rule.exempt.includes(relFile)) continue;
        const rules = parseFile(file);
        const hit = rules.find(r => tableShaped.test(r.selector) && r.decls.length);
        if (!hit) continue;
        report(rule, relFile,
          `域内自画了数据表格（${hit.selector}，第 ${hit.line} 行）——数据库交互默认走 Excel 工作面；确实要自己画，登记豁免并写明理由`,
          `${relFile}:${hit.line}`);
      }
    }
  }
}

/* ---------- 基线对照 ---------- */
const grandfathered = [];
const fresh = [];
for (const v of violations) {
  /* 「已豁免」的（契约 exemptions 里登记过的）**不算新增违规** —— 它们是已知的、
     契约里写明「待修」的历史问题；但它们**始终列出来**（--report 能看见），
     不许被悄悄藏掉。 */
  if (v.exempt) { grandfathered.push(v); continue; }
  const known = (baseline[v.id] || []).includes(v.fingerprint);
  (known ? grandfathered : fresh).push(v);
}

if (WRITE_BASELINE) {
  const next = {};
  for (const v of violations) (next[v.id] ||= []).push(v.fingerprint);
  for (const id of Object.keys(next)) next[id] = [...new Set(next[id])].sort();
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 1) + '\n');
  console.log(`已登记基线：${BASELINE_PATH}（${violations.length} 条）`);
}

const line = '─'.repeat(72);
console.log(line);
console.log(`尚书 Web 视觉一致性检查 · 规范 ${spec.version} · ${spec.updatedAt}`);
console.log(line);
console.log(`检查项 ${spec.rules.length} 条 ｜ 违反 ${violations.length} 条（其中新增 ${fresh.length} 条 / 已登记存量 ${grandfathered.length} 条）`);
if (REPORT && grandfathered.length) {
  console.log('\n【已登记的存量违反（基线内）——位置逐条列出，可用 --report 之外的 --write-baseline 更新基线】');
  for (const v of grandfathered) console.log(`  · [${v.id}] ${v.where} → ${v.message}`);
}
if (fresh.length) {
  console.log('\n【新增违反 —— 必须修】');
  for (const v of fresh) console.log(`  ✗ [${v.id}] ${v.where} → ${v.message}`);
} else {
  console.log('\n✔ 没有新增违反。');
}
if (spec.exceptions?.length) {
  console.log('\n【已登记的例外（规范允许不一样）】');
  for (const e of spec.exceptions) console.log(`  · ${e.where}：${e.value} —— ${e.why}`);
}
console.log(line);
process.exit(fresh.length ? 1 : 0);
