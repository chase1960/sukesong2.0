// 判据：**内核公开面必须把域需要的那几个名字正式导出**，
// 且**平台 API 版本三处一致**。
//
// **测试通过 =**
// ① `shangshu_core/public_api/__init__.py` 的 `__all__` 里同时有：
//    `get_managed_object_model`（读受管对象模型：归属应用 ＋ 当前修订 ＋ 生效修订）
//    ／`token_hash`／`validate_device_action`（设备通道的纯规则）
//    ／`bind_record_attachments`／`execute_registered_action`／`ensure_identity_for_user`；
// ② 契约 JSON `api_version`、`contracts.py` 的 `API_VERSION`、
//    `shangshu-plugin.yml` 的 `public_api:` **三处一字不差**。
//
// **为什么要有这条**（2026-10-24 · PKG-082-T01）：
// 域要跨域拿东西，**只能走 `shangshu_core.public_api`** —— 但今天这四个名字
// **导进了公开面却没列进 `__all__`**（`token_hash`／`validate_device_action`），
// 于是域干脆**直接 import 内核私有模块**（`shangshu_core.device_channel`／
// `shangshu_core.attachments`／`shangshu_core.actions`／`shangshu_core.identity_admin`）
// ⇒ 被 `check-platform-contract.mjs` 判成 `PRIVATE_CORE_IMPORT`（**5 项红**）。
// ⇒ 「公开面到底正式导出了什么」必须**有机器在守**，不然下一次又悄悄变回直 import。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORE = path.join(ROOT, 'frappe_apps/shangshu_core/shangshu_core');

test('公开面正式导出域需要的那几个名字（域不许再 import 内核私有模块）', () => {
  const src = fs.readFileSync(path.join(CORE, 'public_api/__init__.py'), 'utf8');
  const head = src.split('__all__ = [')[1];
  assert.ok(head, 'public_api 里找不到 __all__ 清单');
  const all = head.split(']')[0];
  for (const name of [
    'get_managed_object_model',
    'token_hash',
    'validate_device_action',
    'bind_record_attachments',
    'execute_registered_action',
    'ensure_identity_for_user',
  ]) {
    assert.ok(all.includes('"' + name + '"'), '公开面 __all__ 里必须正式导出 ' + name);
  }
});

test('平台 API 版本三处一致（契约 JSON／contracts.py／shangshu-plugin.yml）', () => {
  const json = JSON.parse(fs.readFileSync(path.join(CORE, 'contracts/platform-api-v1.json'), 'utf8'));
  const contracts = fs.readFileSync(path.join(CORE, 'contracts.py'), 'utf8');
  const plugin = fs.readFileSync(path.join(ROOT, 'frappe_apps/shangshu_core/shangshu-plugin.yml'), 'utf8');
  const fromJson = json.api_version;
  const fromPy = /API_VERSION\s*=\s*"([^"]+)"/.exec(contracts)?.[1];
  const fromYml = /public_api:\s*([0-9.]+)/.exec(plugin)?.[1];
  assert.ok(fromJson, '契约 JSON 里没有 api_version');
  assert.equal(fromPy, fromJson, 'contracts.py 与契约 JSON 的平台 API 版本不一致');
  assert.equal(fromYml, fromJson, 'shangshu-plugin.yml 与契约 JSON 的平台 API 版本不一致');
});

/**
 * **「主体范围声明的形状校验」两个口在公共 API 面里**（PKG-117-T01 · 导出半）。
 *
 * **测试通过 =** `normalize_scope` 与 `normalize_access`
 * 都在 `shangshu_core/public_api/__init__.py` 的 `__all__` 里
 * ⇒ 域要判「这份主体范围声明形状合不合法」时**有正式口可调**，
 * 不必再借 `subject_allows` 绕道触发同一份校验。
 */
test('主体范围形状校验的两个口在公共 API 面里（域不必再绕道触发）', () => {
  const src = fs.readFileSync(path.join(CORE, 'public_api/__init__.py'), 'utf8');
  const head = src.split('__all__ = [')[1];
  assert.ok(head, 'public_api 里找不到 __all__ 清单');
  const all = head.split(']')[0];
  for (const name of ['normalize_scope', 'normalize_access']) {
    assert.ok(all.includes('"' + name + '"'), '公开面 __all__ 里必须正式导出 ' + name);
  }
});

/**
 * **域侧不再绕道**：文件域自己判形状时**直调**内核公开面导出的那两个口。
 *
 * **测试通过 =** `shangshu_files/access_scope.py`
 * ① 从 `shangshu_core.public_api` import `normalize_scope`（或 `normalize_access`）；
 * ② **不再**出现 `subject_allows(''` —— 那是「借判定口触发形状校验」的绕道写法，
 *    依赖「`subject_allows` 会先做形状校验且对空 user 不抛别的错」这个**实现细节**。
 */
test('文件域直调公开面的形状校验口（不再借 subject_allows 绕道触发）', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'frappe_apps/shangshu_files/shangshu_files/access_scope.py'), 'utf8');
  assert.ok(
    /from\s+shangshu_core\.public_api\s+import[\s\S]*normalize_(?:scope|access)/.test(src),
    '文件域必须从 shangshu_core.public_api 直调 normalize_scope／normalize_access');
  assert.ok(!src.includes("subject_allows(''"),
    "文件域不许再借 subject_allows('') 触发形状校验（那是绕道）");
});

/**
 * **「暂存」这一档的两个口在公共 API 面里**（PKG-118-T01 接线半）。
 *
 * **测试通过 =** `stage_action_proposal_units` 与 `unstage_action_proposal_units`
 * 都在 `shangshu_core/public_api/__init__.py` 的 `__all__` 里
 * （⇒ 域与前端**只能走公共面**调这两个口，不必直 import 内核私有模块）。
 */
test('「暂存」这一档的两个口在公共 API 面里（域不许直 import 内核私有模块）', () => {
  const src = fs.readFileSync(path.join(CORE, 'public_api/__init__.py'), 'utf8');
  const head = src.split('__all__ = [')[1];
  assert.ok(head, 'public_api 里找不到 __all__ 清单');
  const all = head.split(']')[0];
  for (const name of ['stage_action_proposal_units', 'unstage_action_proposal_units']) {
    assert.ok(all.includes('"' + name + '"'), '公开面 __all__ 里必须正式导出 ' + name);
  }
});
