import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inventory,execute,root,classifyTestResult,classifyLoadFailure,selectTests} from '../run-baseline-tests.mjs';

test('inventory includes omitted mjs and Python tests, but never auto-runs live-site scripts',()=>{
  const entries=inventory();
  assert.equal(entries.find(x=>x.file.endsWith('/platform-csrf.test.mjs')).group,'server');
  assert.equal(entries.find(x=>x.file==='scripts/tests/test_partial_review.py').group,'python');
  assert.equal(entries.find(x=>x.file.endsWith('/test_d_promotion_chain.py')).group,'manual');
  const installed=entries.find(x=>x.file==='scripts/tests/test_model_capabilities.py');
  assert.equal(installed.group,'manual');
  assert.match(installed.reason,/installed Frappe runtime/);
  assert.equal(new Set(entries.map(x=>x.file)).size,entries.length);
});
test('failure and a stuck child do not become green; a following file still runs',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-contract-'));
  try{
    const options={cwd:root,env:process.env,log:join(dir,'test.log'),timeoutMs:150};
    assert.equal((await execute(process.execPath,['-e','process.exit(3)'],options)).status,'FAIL');
    assert.equal((await execute(process.execPath,['-e','setInterval(()=>{},1000)'],options)).status,'TIMEOUT');
    assert.equal((await execute(process.execPath,['-e','process.exit(0)'],{...options,timeoutMs:2000})).status,'PASS');
    assert.equal((await execute('/nonexistent/shangshu-test-runtime',[],options)).status,'BLOCKED');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Node test deadline is TIMEOUT, ordinary failures and successful output are not relabelled',()=>{
  const failed={status:'FAIL',code:1};
  assert.equal(classifyTestResult(failed,"  failureType: 'testTimeoutFailure'\n").status,'TIMEOUT');
  assert.equal(classifyTestResult(failed,"  failureType: 'testCodeFailure'\n").status,'FAIL');
  assert.equal(classifyTestResult(failed,'error: timeout mentioned in assertion').status,'FAIL');
  assert.equal(classifyTestResult({status:'PASS'},"  failureType: 'testTimeoutFailure'\n").status,'PASS');
});

// 2026-10-24 12:3x（PKG-085）：「**没跑成**」与「**测挂了**」不是一回事 ——
// 第一次全量跑批（428 文件）里，有 8 个文件是**模块解析在装载期就炸了**
// （Excel 域的依赖在那棵工作树上没接上）⇒ **一条用例都没跑**，
// 可报告把它们记成了 FAIL ⇒ 读报告的人以为「27 条判据坏了」，
// 实际是「27 条里有 8 条**根本没跑**」。
//
// 测试通过 = 装载失败单独记成 LOAD_FAILED（并带上原因），
// 真的跑了用例才记 FAIL；**两种都仍然让整趟跑批算失败**
// （不许因为「不是判据红」就放行）。
test('「没跑成」（装载失败）与「测挂了」分开记，但都仍然算跑批失败',()=>{
  const failed={status:'FAIL',code:1};
  // ① 模块／包找不到 ⇒ 装载失败（一条用例都没跑）
  const missing=classifyLoadFailure(failed,"Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'typescript' imported from ...\n");
  assert.equal(missing.status,'LOAD_FAILED','模块没找到是「没跑成」，不是「测挂了」');
  assert.match(missing.reason,/Cannot find package/,'要写清楚为什么没跑成');
  // ② 导出名对不上 ⇒ 也是装载失败
  const exportMiss=classifyLoadFailure(failed,"SyntaxError: The requested module '../src/open-failure.ts' does not provide an export named 'describeOpenFailure'\n");
  assert.equal(exportMiss.status,'LOAD_FAILED','导出名对不上是「没跑成」');
  // ③ 真的跑了用例并挂了 ⇒ 仍然是 FAIL（不许被改写成「没跑成」）
  const ran=classifyLoadFailure(failed,"✖ ordinary paste saves\n  AssertionError: expected\nℹ pass 0\nℹ fail 1\n");
  assert.equal(ran.status,'FAIL','用例真的跑了并挂了 ⇒ 还是判据红');
  // ④ 通过的不许被改写
  assert.equal(classifyLoadFailure({status:'PASS'},"Cannot find package 'x'\n").status,'PASS');
  // ⑤ 两种都仍然让整趟跑批算失败（不许因为「不是判据红」就放行）
  for(const r of [missing,exportMiss,ran]) assert.notEqual(r.status,'PASS');
});

// R967-F03：每个角色一条快速命令（计划 §五 F-3「禁止每次改一行都全量」）。
// 测试通过 = 多个 --only 取**并集**（任一子串命中即入选）；一个都不传时行为与现在完全一致；
// 选中为空时**抛错、不给假绿**（沿 runner 既有的 refusing an empty green run）。
test('multiple --only filters select the union, none keeps behaviour, empty refuses green',()=>{
  const all=[
    {file:'scripts/tests/test_sheet_font_styles.py',group:'python'},
    {file:'scripts/tests/test_mail_signatures.py',group:'python'},
    {file:'scripts/tests/test_sheet_row_heights.py',group:'python'},
    {file:'shangshu-server/tests/website/chat-inline-review.test.ts',group:'server'},
    {file:'shangshu-web/js/domains/excel-univer/tests/grid-batch.test.mjs',group:'excel'},
  ];
  const files=r=>r.map(x=>x.file);

  // 并集：任一子串命中就入选 —— 一条命令能圈住一个角色的一组文件
  assert.deepEqual(
    files(selectTests(all,['python','server','excel'],['sheet_','chat-'])),
    ['scripts/tests/test_sheet_font_styles.py',
     'scripts/tests/test_sheet_row_heights.py',
     'shangshu-server/tests/website/chat-inline-review.test.ts']);

  // 重复的 --only 不重复计入
  assert.deepEqual(
    files(selectTests(all,['python'],['sheet_','sheet_'])),
    ['scripts/tests/test_sheet_font_styles.py','scripts/tests/test_sheet_row_heights.py']);

  // 一个 --only 都不传：行为与现在完全一致（组内全选）
  assert.deepEqual(files(selectTests(all,['excel'],[])),
    ['shangshu-web/js/domains/excel-univer/tests/grid-batch.test.mjs']);
  assert.equal(selectTests(all,['python','server','excel'],[]).length,5);

  // 组过滤仍然生效：--only 命中但组不在范围内 → 选中为空 → 拒绝（不许漏进别的组）
  assert.throws(()=>selectTests(all,['python'],['chat-']),/empty green|No matching/i);
  assert.deepEqual(files(selectTests(all,['python','server'],['chat-'])),
    ['shangshu-server/tests/website/chat-inline-review.test.ts']);

  // 选中为空 → 抛错，不许变成「跑了 0 条所以全绿」
  assert.throws(()=>selectTests(all,['python'],['does-not-match-anything']),/empty green|No matching/i);
});
