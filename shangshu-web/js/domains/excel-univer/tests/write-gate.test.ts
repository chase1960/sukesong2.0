/**
 * 判据：**越界写入（加行/加列）准不准** —— 问的是**表自己的结构权**，不是「导出能力探测」。
 *
 * **测试通过 = 什么成立**（一句话）
 * 「在表的末尾下面**打字**或**粘贴** ⇒ 该加的那行**加得出来**（不被一句
 *   『没有结构编辑权限』挡在门口 —— 其实权限是有的）；
 *   而真的**没有**结构权时 ⇒ **明确拒**、并说清为什么；
 *   改**已有格**的值 ⇒ 不看结构权（能改值就能改值）；
 *   业务表越界 ＝ 新增记录 ⇒ 不由这道闸管。」
 *
 * ⚠️ **为什么有这条判据**（用户 2026-10-29 14:5x：「粘贴也要行，输入也要行」）：
 *   原来这道闸读的是 `exportCapabilities.canStructure` —— 那是**导出能力探测**的结果，
 *   `files.versions` **异步**探、失败时**错误被吞掉**（一直是空）⇒
 *   **开表后手一快，越界写入就是死的**，人被一句**说错了原因**的话挡着。
 *   ⇒ 现在只认**表自己的结构权**（`sheet_read` 回的 `my_access.structure`，开表就有）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decideExtendWrite } from '../src/write-gate.ts';

test('文件表越界写入：有结构权 ⇒ 放行（加行/加列照做）', () => {
  const decision = decideExtendWrite({ kind: 'xlsx', outOfBounds: true, canStructure: true });
  assert.equal(decision.allowed, true);
});

test('文件表越界写入：**不知道**有没有结构权 ⇒ 明确拒（fail-closed）', () => {
  const decision = decideExtendWrite({ kind: 'xlsx', outOfBounds: true });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason || '', /结构编辑权限/, '拒的时候要说清为什么');
});

test('文件表越界写入：确实没有结构权 ⇒ 拒，并说清是权限问题', () => {
  const decision = decideExtendWrite({ kind: 'xlsx', outOfBounds: true, canStructure: false });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason || '', /结构编辑权限/);
});

test('改已有格（不越界）⇒ 不看结构权（能改值就能改值）', () => {
  const decision = decideExtendWrite({ kind: 'xlsx', outOfBounds: false });
  assert.equal(decision.allowed, true);
});

test('业务表越界 ＝ 新增记录 ⇒ 不由这道闸管（放行给新增记录那条路）', () => {
  const decision = decideExtendWrite({ kind: 'db', outOfBounds: true });
  assert.equal(decision.allowed, true);
});

test('「导出能力探测」不再当结构闸用（它异步、失败时错误被吞掉 ⇒ 一直是空）', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.equal(
    main.includes('exportCapabilities?.canStructure'),
    false,
    'main.ts 里不该再有「拿导出能力当结构权」的地方（开表后手一快，功能就是死的）',
  );
});
