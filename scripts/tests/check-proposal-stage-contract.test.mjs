/**
 * **「暂存」这一档的接线面判据**（PKG-118-T01 接线半）。
 *
 * **为什么要有这份判据**：内核那半（`proposal_stage.py`）已经做完并有 10 条判据，
 * 但**接线面**（HTTP 口 / BFF 路由 / 公共 API 面 / 契约文件）还没接 ——
 * 契约里若没有「暂存」这一档，前端与域就**各写各的**：一处叫 `staged`、
 * 一处叫「已存」，人看到的和后端记的对不上。
 * ⇒ 这份判据断的是**接线面四件事**：
 *   ① 契约 `platform-api-v1.json` 里公共面多两个函数 ＋ 两条 HTTP 路径写进去了；
 *   ② 审核项的**状态取值集合**里有 `staged`，回执/目录/单元那三个键（`staged_units`／
 *      `staged_count`／`staged_value`）**都有定义**（不是"实现里有、契约里没写"）；
 *   ③ 契约写清**「暂存 ≠ 采用 ≠ 保存」** ＋ **暂存不绕过整组规则**；
 *   ④ 内核 HTTP 口（`public_api/http.py`）与 BFF 路由（`adapters/web/platform.ts`）
 *      真的接上了 —— 四个入参（`op_id`／`expected_review_revision`／`units`／
 *      `edited_value`）一个不少地透传。
 *
 * **测试通过 =** 上面 ①②③④ 全部成立（每条用例下面一行写明它断的是什么）。
 *
 * 跑法：`node --test scripts/tests/check-proposal-stage-contract.test.mjs`
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORE = path.join(ROOT, 'frappe_apps/shangshu_core/shangshu_core');
const CONTRACT_PATH = path.join(CORE, 'contracts/platform-api-v1.json');
const HTTP_PATH = path.join(CORE, 'public_api/http.py');
const BFF_PATH = path.join(ROOT, 'shangshu-server/src/adapters/web/platform.ts');

const readContract = () => JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
const readHttp = () => fs.readFileSync(HTTP_PATH, 'utf8');
const readBff = () => fs.readFileSync(BFF_PATH, 'utf8');

/** 取一条 Express 路由的整段（从 `router.post('…'` 到下一条 `router.` 之前）。 */
function routeBlock(src, routePath) {
  const at = src.indexOf(`router.post('${routePath}'`);
  if (at < 0) return null;
  const rest = src.slice(at);
  const end = rest.indexOf('\n  router.');
  return end > 0 ? rest.slice(0, end) : rest;
}

/** 取 Python 里某个函数的整段（从 `def 名字(` 到下一个顶层 `def`／装饰器之前）。 */
function functionBlock(src, name) {
  const at = src.indexOf(`def ${name}(`);
  if (at < 0) return '';
  const rest = src.slice(at);
  const end = rest.indexOf('\n@frappe.whitelist');
  const alt = rest.indexOf('\ndef ');
  const stop = [end, alt].filter((value) => value > 0).sort((a, b) => a - b)[0];
  return stop ? rest.slice(0, stop) : rest;
}

it('① 内核契约里：公共面多两个「暂存」函数 ＋ 两条 HTTP 路径写进去了', () => {
  const contract = readContract();
  const review = contract.partial_action_review;
  assert.ok(review, '契约里没有 partial_action_review 这一段');
  assert.ok(review.public_functions.includes('stage_action_proposal_units'),
    '公共面清单里没有 stage_action_proposal_units —— 域与前端拿不到这个口');
  assert.ok(review.public_functions.includes('unstage_action_proposal_units'),
    '公共面清单里没有 unstage_action_proposal_units —— 取消暂存没有出口');
  const http = JSON.stringify(review.http || {});
  assert.match(http, /action-proposals\/:id\/stage-units/,
    '契约里没写暂存那条 HTTP 路径（前端照契约接不到）');
  assert.match(http, /action-proposals\/:id\/unstage-units/,
    '契约里没写取消暂存那条 HTTP 路径');
});

it('② 审核项的状态取值集合里有 staged，且 staged_units／staged_count／staged_value 都有定义', () => {
  const contract = readContract();
  const descriptor = contract.partial_action_review.descriptor || {};
  const statuses = descriptor.unit_status;
  assert.ok(Array.isArray(statuses) && statuses.length > 0,
    '契约里没写审核项状态取值集合（前端只能猜有哪些档）');
  assert.ok(statuses.includes('staged'), '状态取值集合里没有 staged 这一档');
  for (const keep of ['pending', 'accepted', 'rejected']) {
    assert.ok(statuses.includes(keep), `状态取值集合里 ${keep} 不见了（不许顺手改掉别的档）`);
  }
  /* 三个键都要**有定义**（一句话说清它是什么），不是只出现一个名字。 */
  const unitOptional = descriptor.unit_optional || {};
  assert.ok(String(unitOptional.staged_value || '').length > 0,
    '契约里没写 staged_value 是什么（暂存时人改过的那个值）');
  assert.ok((descriptor.state || []).includes('staged_count'),
    '契约的目录键清单里没有 staged_count（前端按它显示「已暂存几项」）');
  const stage = contract.partial_action_review.stage || {};
  assert.ok(String((stage.receipt || {}).staged_units || '').length > 0,
    '契约里没写 staged_units（本次暂存了哪几项）');
  assert.ok(String((stage.receipt || {}).unstaged_units || '').length > 0,
    '契约里没写 unstaged_units（本次取消暂存了哪几项）');
});

it('③ 契约写清「暂存 ≠ 采用 ≠ 保存」，且暂存不绕过整组规则', () => {
  const contract = readContract();
  const stage = contract.partial_action_review.stage || {};
  const semantics = stage.semantics || {};
  const text = JSON.stringify(semantics);
  /* ⚠️ `platform-api-v1.json` 这份契约正文是**英文**（与文件里其它段一致）
   * ⇒ 这里按英文口径判，不按中文。 */
  assert.match(text, /formal value/, '契约没写「暂存只标记、不写正式值」');
  assert.match(text, /≠|not the same/, '契约没把「暂存 ≠ 采用 ≠ 保存」写成一句可判的话');
  assert.match(text, /whole[- ](group|set)/, '契约没写「暂存不绕过整组规则」');
  assert.match(text, /check_review_group|still runs|still rejects/,
    '契约没写整组闸在提交那一侧照旧跑（暂存只是标记）');
  assert.match(text, /never write a formal value/, '契约没写「暂存/取消暂存一个正式值都不写」');
});

it('④ 内核 HTTP 口接上了：两个白名单 POST 口，转发到内核那一个门', () => {
  const src = readHttp();
  assert.match(src, /@frappe\.whitelist\(methods=\["POST"\]\)\s*\ndef action_proposal_stage_units\(/,
    '内核 HTTP 层没有 action_proposal_stage_units 这个 POST 口');
  assert.match(src, /@frappe\.whitelist\(methods=\["POST"\]\)\s*\ndef action_proposal_unstage_units\(/,
    '内核 HTTP 层没有 action_proposal_unstage_units 这个 POST 口');
  /* 上一层只认 `proposal_review` 一个门 ⇒ HTTP 口必须从那儿转发。 */
  const stageBlock = functionBlock(src, 'action_proposal_stage_units');
  assert.match(stageBlock, /from shangshu_core\.proposal_review import[\s\S]*stage_action_proposal_units/,
    '暂存口没有从 proposal_review 转发（上层只认那一个门）');
  const unstageBlock = functionBlock(src, 'action_proposal_unstage_units');
  assert.match(unstageBlock, /from shangshu_core\.proposal_review import[\s\S]*unstage_action_proposal_units/,
    '取消暂存口没有从 proposal_review 转发');
  /* `units`／`edited_value` 传字符串时要 parse（照现有那两条的写法）。 */
  assert.match(stageBlock, /isinstance\(units, str\)/,
    '暂存口没有把字符串形式的 units 解析成 JSON 数组');
  assert.match(stageBlock, /isinstance\(edited_value, str\)/,
    '暂存口没有把字符串形式的 edited_value 解析成 JSON');
  assert.match(unstageBlock, /isinstance\(units, str\)/,
    '取消暂存口没有把字符串形式的 units 解析成 JSON 数组');
});

it('⑤ BFF 两条路由接上了：四个入参一个不少地透传，落到内核那一个门', () => {
  const src = readBff();
  assert.match(src, /actionProposalStageUnits:\s*'shangshu_core\.public_api\.http\.action_proposal_stage_units'/,
    'BFF 的方法表里没有暂存那条内核口');
  assert.match(src, /actionProposalUnstageUnits:\s*'shangshu_core\.public_api\.http\.action_proposal_unstage_units'/,
    'BFF 的方法表里没有取消暂存那条内核口');

  const stage = routeBlock(src, '/api/platform/action-proposals/:id/stage-units');
  assert.ok(stage, 'BFF 没有 POST /api/platform/action-proposals/:id/stage-units 这条路由');
  assert.match(stage, /METHOD\.actionProposalStageUnits/, '暂存路由没有落到内核那一个门');
  for (const field of ['proposal_id', 'op_id', 'expected_review_revision', 'units', 'edited_value']) {
    assert.ok(stage.includes(field), `暂存路由没有透传 ${field}`);
  }

  const unstage = routeBlock(src, '/api/platform/action-proposals/:id/unstage-units');
  assert.ok(unstage, 'BFF 没有 POST /api/platform/action-proposals/:id/unstage-units 这条路由');
  assert.match(unstage, /METHOD\.actionProposalUnstageUnits/, '取消暂存路由没有落到内核那一个门');
  for (const field of ['proposal_id', 'op_id', 'expected_review_revision', 'units']) {
    assert.ok(unstage.includes(field), `取消暂存路由没有透传 ${field}`);
  }
});
