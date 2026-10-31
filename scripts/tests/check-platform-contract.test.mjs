import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePluginManifest, validateContract, validateManifests, validateCoreTableAccess, crossDomainTableAccess, doctypeOwners } from '../check-platform-contract.mjs';

test('可选依赖保留声明且与强依赖不能重叠', () => {
  const manifest = parsePluginManifest('id: com.shangshu.a\nversion: 1.0.0\nplatform_api: ">=1.0 <2.0"\ndependencies:\n  - com.shangshu.core@">=0.1"\noptional_dependencies:\n  - com.shangshu.mail@">=0.2 <1.0"\nmigrations: []\n');
  assert.deepEqual(manifest.optional_dependencies, ['com.shangshu.mail@">=0.2 <1.0"']);
  assert.deepEqual(validateManifests([{file:'a.yml', manifest}]), []);
  manifest.dependencies.push(...manifest.optional_dependencies);
  assert.ok(validateManifests([{file:'a.yml', manifest}]).some(item=>item.includes('DEPENDENCY_DUPLICATE')));
});

test('可选依赖禁止非法声明和将核心声明为可选', () => {
  const manifest = {id:'com.shangshu.a', version:'1.0.0', platform_api:'>=1.0 <2.0', dependencies:['com.shangshu.core@">=0.1"'], migrations:[], exports:{}, optional_dependencies:['bad', 'com.shangshu.core@">=0.1"']};
  const errors = validateManifests([{file:'a.yml', manifest}]);
  assert.ok(errors.some(item=>item.includes('DEPENDENCY_INVALID')));
  assert.ok(errors.some(item=>item.includes('OPTIONAL_CORE_FORBIDDEN')));
});


test('读取插件 manifest 的版本、依赖和资源导出', () => {
  const value = parsePluginManifest(`id: com.shangshu.ip\nversion: 1.2.3\nplatform_api: ">=1.0 <2.0"\ndependencies:\n  - com.shangshu.core@">=0.1"\nexports:\n  actions:\n    - ip.case.create\n  tools:\n    - ip.case.create\n  workbench:\n    - ip.pending_cases\nmigrations:\n  - 001_init\n`);
  assert.equal(value.id, 'com.shangshu.ip');
  assert.deepEqual(value.dependencies, ['com.shangshu.core@">=0.1"']);
  assert.deepEqual(value.exports.actions, ['ip.case.create']);
  assert.deepEqual(value.exports.workbench, ['ip.pending_cases']);
});

test('领域不得通过 DocType 绕过公共接口直接操作核心事实',()=>{
  assert.equal(validateCoreTableAccess('frappe.get_doc({"doctype": "Shangshu Node Execution"}).insert()'),true);
  assert.equal(validateCoreTableAccess('frappe.db.set_value("Shangshu Process Instance", name, "status", "Completed")'),true);
  assert.equal(validateCoreTableAccess('complete_node_execution(name, token)'),false);
  assert.equal(validateCoreTableAccess('frappe.get_doc("Shangshu Expense Claim", name)'),false);
});

// ==================== PKG-013-T02：真实跨域直查反例 ====================
// **测试通过 =** 领域 A 直接查/改领域 B 的内部表，门禁**当场抓到**，
// 而不只是抓「直查内核表」。
//
// **为什么必须补**：`validateCoreTableAccess` 的表名单**只从 shangshu_core 收**
// （`check-platform-contract.mjs:126-130`），所以 `shangshu_files` 里
// `frappe.db.get_value("Shangshu Mail Access", …)` **根本不在名单里，拦不到**。
// 这就是契约 T02-③ 说的「不靠 shangshu_core 表名单那个盲区」。
// 跨域只准走公共契约（`shangshu_core.public_api` / 事件总线），直查别人的表
// 就是把耦合藏起来 —— 拆掉链路时它第一个坏。
test('T02-H 表名单要收全所有领域的 doctype，不能只收内核', () => {
  const owners = doctypeOwners();
  assert.ok(owners.size > 0, '至少要能读出 doctype 名单');
  const apps = new Set(owners.values());
  assert.ok(
    apps.has('shangshu_core') && apps.size >= 2,
    `名单必须覆盖多个应用（现在只有：${[...apps].join(',')}），否则跨域直查还是盲区`,
  );
});

test('T02-I 真实跨域直查反例：files 直查 mail 的表必须被抓到', () => {
  // **这条就是契约 T02-③ 要的「真实跨域直查反例」** —— 不是编的，
  // 是 shangshu_files 里真的可能写出的那种：直取 shangshu_mail 的 DocType。
  const owners = doctypeOwners();
  const mailTable = [...owners.entries()].find(([, app]) => app === 'shangshu_mail')?.[0];
  assert.ok(mailTable, '名单里要有 shangshu_mail 的表，否则这条反例无从验起');

  const hits = crossDomainTableAccess(
    `frappe.db.get_value("${mailTable}", {"name": x}, "user")`,
    'shangshu_files',
    owners,
  );
  assert.deepEqual(
    hits.map((hit) => hit.name),
    [mailTable],
    'files 直查 mail 的表必须报出来',
  );

  // 反例自检①：查**自己**域的表不算违规
  const own = [...owners.entries()].find(([, app]) => app === 'shangshu_files')?.[0];
  if (own) {
    assert.deepEqual(
      crossDomainTableAccess(`frappe.get_doc("${own}", name)`, 'shangshu_files', owners),
      [],
      '查自己域的表不该报',
    );
  }
  // 反例自检②：走公共口不带表名，不报（这条证明不是「一律报」）
  assert.deepEqual(
    crossDomainTableAccess('complete_node_execution(name, token)', 'shangshu_files', owners),
    [],
    '走公共口没有表名，不该报',
  );
  // 反例自检③：**内核不算「别的域」** —— 直取内核表是 PRIVATE_CORE_DOCTYPE_ACCESS 的事，
  // 在「跨域」里再报一次是重复计数，还会把「跨域」这个词冲淡。
  const coreTable = [...owners.entries()].find(([, app]) => app === 'shangshu_core')?.[0];
  assert.ok(coreTable, '名单里要有内核表');
  assert.deepEqual(
    crossDomainTableAccess(`frappe.get_doc("${coreTable}", name)`, 'shangshu_files', owners),
    [],
    '直取内核表不该算「跨域」，那是 PRIVATE_CORE_DOCTYPE_ACCESS 管的',
  );
});

// ==================== T02-J/K：别把「反例」当「违规」 ====================
// **测试通过 =** 门禁只认**真的会摸表的调用位**，下面两种一律不算：
//   J  注释 / 文档串里**引用**了「我们不这么查」的表名 —— 那是教训，不是违规。
//      实物：`shangshu_mail/delivery.py:282-290` 整段在讲「为什么不 frappe.db.exists
//      直查 Shangshu File Center Version，改走 files.imported_of」。
//      我先前把它报成「真违规」还转给了 C —— **报错了，这里钉死**。
//   K  把表名当**参数值**传给公共口 —— 那是数据，不是查询。
//      实物：`delivery.py:442` `'ref': 'Shangshu File Center File'` 传给
//      `/api/platform/file-content`，那个口自带 `can_read_reference` 判定。
// **反例要同时在**：真的 `frappe.db.get_value(别人的表)` 必须照抓 —— 否则这是放水不是收窄。
// 两条硬的照守：**不许关检查、不许加 allowlist**。
test('T02-J 文档串/注释里的「我们不这么查」不算违规', () => {
  const owners = doctypeOwners();
  const mailTable = [...owners.entries()].find(([, app]) => app === 'shangshu_mail')?.[0];
  assert.ok(mailTable, '名单里要有 shangshu_mail 的表');
  const docstring = `
def imported_of(source_files):
    """为什么不 frappe.db.exists("${mailTable}", {'source_file': …}) 这种直查：
    那张表是文件域的内部表，改走 files.imported_of。"""
    return public_api()
`;
  assert.deepEqual(
    crossDomainTableAccess(docstring, 'shangshu_files', owners),
    [],
    '文档串里引用的「反例代码」不该被当成违规',
  );
});

test('T02-K 表名当参数值传给公共口不算违规', () => {
  const owners = doctypeOwners();
  const fileTable = [...owners.entries()].find(([, app]) => app === 'shangshu_files')?.[0];
  assert.ok(fileTable, '名单里要有 shangshu_files 的表');
  const asParam = `
return '/api/platform/file-content?' + urlencode({
    'ref': '${fileTable}',
    'ref_name': str(file_center_id or ''),
})
`;
  assert.deepEqual(
    crossDomainTableAccess(asParam, 'shangshu_mail', owners),
    [],
    '表名是参数值不是查询，不该报',
  );
  // 反例：同一张表，真去查就必须抓
  assert.deepEqual(
    crossDomainTableAccess(`frappe.db.get_value("${fileTable}", name, "x")`, 'shangshu_mail', owners)
      .map((h) => h.name),
    [fileTable],
    '真去查这张表必须仍然抓 —— 否则 T02-J/K 是放水不是收窄',
  );
});

test('读取 manifest 顶层空数组时保持数组类型', () => {
  const value = parsePluginManifest('id: com.shangshu.core\nversion: 1.0.0\nplatform_api: ">=1.0 <2.0"\ndependencies: []\nmigrations: []\n');
  assert.deepEqual(value.dependencies, []);
  assert.deepEqual(value.migrations, []);
});

test('manifest 阻止无 Action 的 Tool 与重复资源 owner', () => {
  const common = { version: '1.0.0', platform_api: '>=1.0 <2.0', dependencies: ['com.shangshu.core@">=0.1"'], migrations: [], exports: { actions: [], tools: ['shared.tool'] } };
  const errors = validateManifests([
    { file: 'a.yml', manifest: { ...common, id: 'com.shangshu.a' } },
    { file: 'b.yml', manifest: { ...common, id: 'com.shangshu.b', exports: { actions: ['same.action'], tools: [], services: ['same.service'] } } },
    { file: 'c.yml', manifest: { ...common, id: 'com.shangshu.c', exports: { actions: ['same.action'], tools: [], services: ['same.service'] } } },
  ]);
  assert.ok(errors.some((item) => item.includes('TOOL_WITHOUT_ACTION')));
  assert.ok(errors.some((item) => item.includes('RESOURCE_OWNER_CONFLICT actions:same.action')));
});

test('manifest 阻止没有命名空间的工作台组件 ID', () => {
  const errors = validateManifests([{ file: 'bad.yml', manifest: {
    id: 'com.shangshu.bad', version: '1.0.0', platform_api: '>=1.0 <2.0',
    dependencies: ['com.shangshu.core@">=0.1"'], migrations: [],
    exports: { actions: [], tools: [], workbench: ['pending'] },
  } }]);
  assert.ok(errors.some((item) => item.includes('WORKBENCH_ID_INVALID pending')));
});

test('同一 major 的公共契约禁止删除操作', () => {
  const previous = { api_version: '1.0.0', resources: { action: ['execute', 'propose'] }, resource_sections: ['actions', 'tools'] };
  const current = { api_version: '1.1.0', entrypoint: 'shangshu_core.public_api', workbench_contract: { version: '1.0.0', schema: 'contracts/workbench-contribution-v1.schema.json', supported_kinds: ['metric'], layout_mode: 'plugin_defaults_only' }, resources: { action: ['execute'] }, resource_sections: ['actions', 'tools'] };
  const errors = validateContract(current, previous, new Set(['execute']));
  assert.ok(errors.includes('BREAKING_CONTRACT_REMOVAL action.propose'));
});

test('工作台契约必须声明真实版本、schema、支持类型和当前布局能力', () => {
  const current = { api_version: '1.0.0', entrypoint: 'shangshu_core.public_api', workbench_contract: { version: 'x', schema: 'wrong.json', supported_kinds: [], layout_mode: 'editable' }, resources: {}, resource_sections: ['workbench'] };
  const errors = validateContract(current, null, new Set());
  assert.ok(errors.includes('WORKBENCH_CONTRACT_VERSION_NOT_SEMVER'));
  assert.ok(errors.includes('WORKBENCH_CONTRACT_SCHEMA_INVALID'));
  assert.ok(errors.includes('WORKBENCH_METRIC_KIND_MISSING'));
  assert.ok(errors.includes('WORKBENCH_LAYOUT_MODE_MUST_BE_TRUTHFUL'));
});
