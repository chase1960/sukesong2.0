import {it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * 「**所有进入尚书的文件都进文件中心**」（用户 2026-10-22 15:21 定，并要求**做成内核契约**）。
 *
 * 为什么要有：现在「字节进尚书」是**每个域各自记得调**的散事 ——
 * 邮件域来信附件走 `files.import_attachment`、助手上传走 `files.upload`、
 * 桌面 Host 走 `files.upload`；但**没有一条成文约束**说「只有文件中心能存字节」。
 * ⇒ 已经有两处真的绕过去了（实测查实，见下）。
 *
 * 本判据断的是**内核契约本身**（文件存在 ＋ 内容写对了）与**绕过检测规则**（检查器能抓出绕过）。
 *
 * 测试通过 = 下面全部成立：
 *  1. 内核契约文件存在（`contracts/file-center-v1.json`），且 JSON 合法；
 *  2. 契约里写死了：**唯一入口**（文件域的公开动作）＋ **回执形状** ＋ **谁可以绕过**（谁都不许）；
 *  3. 契约里**点名了 agent 域**：助手对话上传的附件也进文件中心，
 *     agent 域（将来第 7 步拆出来）**只能走文件域的公开动作取件**；
 *  4. 契约里写明了**血缘**（成员可溯源到原包）—— 这是包件交接链路的地基；
 *  5. 契约里的**豁免表**列清了已知的合法例外（不是空白）；
 *  6. 检查器有**绕过检测规则**（能抓出「某域自己存字节」），且规则判据**从契约取**。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT_PATH = path.join(ROOT, 'frappe_apps/shangshu_core/shangshu_core/contracts/file-center-v1.json');
const SPEC_PATH = path.join(ROOT, 'shangshu-web/style-rules.json');
const CHECKER_PATH = path.join(ROOT, 'scripts/check-style-rules.mjs');

it('① 内核契约文件存在且 JSON 合法', () => {
  assert.ok(fs.existsSync(CONTRACT_PATH), `内核契约不存在：${CONTRACT_PATH}`);
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  assert.equal(contract.contract, 'file-center-v1', '契约 id 不对');
});

it('② 契约写死了：唯一入口 ＋ 回执形状 ＋ 谁都不许绕过', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  assert.ok(contract.single_entry, '契约没写「唯一入口」');
  assert.ok(Array.isArray(contract.single_entry.actions) && contract.single_entry.actions.length > 0,
    '唯一入口没列动作');
  assert.match(JSON.stringify(contract.single_entry.actions), /files\.upload/,
    '唯一入口里没有 files.upload（字节进文件中心的那条公开动作）');
  assert.ok(contract.receipt, '契约没写「回执形状」');
  assert.ok(Array.isArray(contract.receipt.required) && contract.receipt.required.length >= 3,
    '回执形状太松 —— 至少要有文件身份、摘要、大小');
  assert.match(JSON.stringify(contract.receipt.required), /sha256/, '回执里没有内容摘要（幂等认件靠它）');
  assert.match(JSON.stringify(contract.receipt.required), /file/, '回执里没有文件身份');
  assert.ok(contract.no_bypass, '契约没写「谁都不许绕过」');
  assert.match(JSON.stringify(contract.no_bypass.rule), /存储|写字节/,
    '绕过规则里没写「不许自己写字节」');
  // 「全站只有一份 ＋ 存在文件中心」这条硬口径（用户 2026-10-22 定）
  assert.ok(contract.no_bypass.one_truth, '契约没写「全站只有一份 ＋ 存在文件中心」');
  assert.match(contract.no_bypass.one_truth, /只有一份/, 'one_truth 没写「只有一份」');
  assert.match(contract.no_bypass.one_truth, /文件中心/, 'one_truth 没提文件中心');
  // 域只做两件事：声明位置 ＋ 拿引用
  assert.ok(Array.isArray(contract.no_bypass.domain_may_only) && contract.no_bypass.domain_may_only.length === 2,
    '「域只做两件事」没写成两条');
  assert.match(JSON.stringify(contract.no_bypass.domain_may_only), /声明/,
    '域该做的第一件事没写「声明路径」');
  assert.match(JSON.stringify(contract.no_bypass.domain_may_only), /受管文件引用/,
    '域该做的第二件事没写「拿受管文件引用」');
});

it('③ 契约点名 agent：助手对话上传的附件也进文件中心，agent 域只能走公开动作取件', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const text = JSON.stringify(contract);
  assert.match(text, /agent/i, '契约里完全没提 agent');
  assert.ok(contract.agent, '契约里没有 agent 那一段');
  // agent 域即便将来独立成域，**取件也只能走文件域的公开动作**。
  assert.match(JSON.stringify(contract.agent), /files\./,
    'agent 那一段没写「只能走文件域的公开动作」');
  assert.match(JSON.stringify(contract.agent), /对话|上传/,
    'agent 那一段没提「对话上传的附件」');
});

it('④ 契约写明了血缘（成员可溯源到原包）', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  assert.ok(contract.lineage, '契约没写血缘');
  assert.match(JSON.stringify(contract.lineage), /container_sha256/,
    '血缘里没有 container_sha256（包件交接链路靠它把成员溯源到原包）');
});

it('⑤ 豁免表列清了已知的合法例外（不是空白）', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  assert.ok(contract.exemptions, '契约没有豁免段');
  assert.ok(Array.isArray(contract.exemptions.entries) && contract.exemptions.entries.length > 0,
    '豁免表是空的 —— 那就等于「没人知道哪些是合法的」');
  for (const entry of contract.exemptions.entries) {
    assert.ok(entry.where && entry.why, `豁免条目缺 where 或 why：${JSON.stringify(entry)}`);
  }
});

it('⑤b 豁免是**限期**的：注明要收掉、什么时候收、怎么收（用户 2026-10-22 定）', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  // 每一条**真实存在的绕过**都要写清：怎么收 ＋ 什么时候收 ＋ 收完怎么验
  for (const entry of contract.exemptions.entries) {
    if (!entry.kind || !entry.kind.includes('限期')) continue;
    assert.ok(entry.to_collect, `限期豁免「${entry.where}」没写怎么收（to_collect）`);
    assert.ok(entry.to_collect_when, `限期豁免「${entry.where}」没写什么时候收（to_collect_when）`);
    assert.ok(entry.to_collect_acceptance, `限期豁免「${entry.where}」没写收完怎么验（to_collect_acceptance）`);
  }
  // 过渡期四条措施
  const tm = contract.transitional_management;
  assert.ok(tm, '契约没有「过渡期怎么管」这一段');
  assert.equal(tm.four_measures.length, 4, '过渡期措施不是四条');
  assert.match(JSON.stringify(tm.four_measures), /不许再新增/, '过渡期没写「不许再新增同类绕过」');
  // 「不许再新增」这条硬线本身要在契约里
  assert.ok(contract.no_bypass.no_new_bypass, 'no_bypass 里没写「不许再新增同类绕过」');
});

it('⑤c 豁免要写明「为什么不算违反」—— 不是光写「豁免」', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const entries = contract.exemptions.entries;
  // 每一处豁免都要说清：字节到底存了几份？
  for (const entry of entries) {
    if (entry.where.startsWith('shangshu_mail/')) {
      assert.ok(entry.why_not_a_violation,
        `邮件域那处豁免没写「为什么不算违反」：${entry.where}`);
      assert.match(entry.why_not_a_violation, /一份|复制|认领/,
        `邮件域那处豁免没说清字节到底存了几份：${entry.where}`);
    }
  }
  // 真正待修的那两处，必须留在「已知违反」里，不许悄悄消失。
  assert.ok(contract.exemptions.known_violations_to_fix.length >= 2,
    '已知违反清单空了 —— 绕过问题不许被豁免吃掉');
  for (const item of contract.exemptions.known_violations_to_fix) {
    assert.ok(item.fix_direction, `已知违反没写修法：${item.where}`);
  }
});

it('⑥ 检查器有绕过检测规则，且判据从契约取', () => {
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  const rule = spec.rules.find(r => r.type === 'fileCenterBypass' || /bypass/i.test(r.id));
  assert.ok(rule, '规则表里没有「绕过文件中心」这条检查');
  assert.match(JSON.stringify(rule), /file-center-v1/,
    '检查规则没有指向内核契约（判据必须从契约取，不许另写一套）');
  const checker = fs.readFileSync(CHECKER_PATH, 'utf8');
  assert.match(checker, /fileCenterBypass/, '检查器里没有实现这条规则');
});

it('⑦ 每个域在文件中心有自己的一块路径，域注册时声明（用户 15:52 原话）', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  assert.ok(contract.domain_paths, '契约里没有「域路径」这一段');
  const paths = contract.domain_paths;
  assert.match(paths.rule, /注册/, '域路径规则里没提「注册时声明」');
  assert.ok(Array.isArray(paths.who_declares) && paths.who_declares.length > 0,
    '没列出哪些域声明了哪条路径');
  // 内核（助手）也要有一块 —— 助手不是业务域，但对话上传的附件要有去处。
  assert.ok(paths.who_declares.some(d => d.domain === 'com.shangshu.core'),
    '内核（助手）没有声明路径 —— 对话上传的附件就没地方放');
  assert.ok(paths.who_declares.some(d => d.domain === 'com.shangshu.device-client'),
    'Host 域没有声明路径');
  assert.ok(paths.who_declares.some(d => d.domain === 'com.shangshu.mail'),
    '邮件域没有声明路径');
  // 每条路径都要有目录形状（带域 id 前缀 ⇒ 域之间不撞）
  for (const entry of paths.who_declares) {
    if (entry.domain === 'com.shangshu.files') continue;   // 文件中心自己是根
    assert.ok(entry.path && entry.path.includes(entry.domain),
      `${entry.domain} 的路径没带自己的域 id（会跟别的域撞）：${entry.path}`);
  }
  // **路径 ≠ 归属**（用户 2026-10-22 定）：域在自己那块里不能自己塞东西/列清单/判权限
  assert.ok(paths.path_is_not_ownership, '契约里没写「路径 ≠ 归属」');
  assert.match(paths.path_is_not_ownership, /归文件中心管/,
    '「路径 ≠ 归属」没写清「字节、编号、权限、版本、审计归文件中心管」');
});
