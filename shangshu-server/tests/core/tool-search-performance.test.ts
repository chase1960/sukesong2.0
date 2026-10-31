// PKG-018-T05 §8.2：性能与上下文体积测量（**不调用 LLM**，确定性）。
//
// 量的三样：
// ① 工具检索：1 次冷启动 ＋ 20 次热查询 ⇒ 热查询 P95（目标 ≤200ms，同机）。
// ② 首次请求里「工具目录/定义」部分的输入体积：原方案（描述里塞全目录）vs 新方案（三个导航能力）⇒ 目标减少 ≥50%。
//    按**字符数**记（没有目标 tokenizer，就不把字符数写成 token）。
// ③ 目录规模 ≥200 条动作（可复用夹具）。
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { buildActionIndex, navigationToolSpecs, searchActions } from '../../src/core/tool-search.ts';

function catalog(count: number) {
  const actions: any[] = [];
  for (let index = 0; index < count; index += 1) {
    actions.push({
      id: `com.shangshu.app.demo.object.${String(index).padStart(4, '0')}.action${index}`,
      version: `1.${index % 3}.0`,
      title: `示例动作 ${index}：受管记录第 ${index} 号操作`,
      purpose: `对第 ${index} 号受管记录做查询/统计/写入，字段有名称、类型、状态与负责人`,
      effect: index % 4 === 0 ? 'write' : 'read',
      confirmation_policy: index % 4 === 0 ? 'required' : 'none',
      executable: true,
      input_schema: { type: 'object', additionalProperties: false, required: ['object_id'],
        properties: { object_id: { type: 'string' }, note: { type: 'string', description: '备注' } } },
    });
  }
  return actions;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))];
}

it('§8.2 工具检索：200 条目录，1 冷 ＋ 20 热，热查询 P95 ≤ 200ms', () => {
  const actions = catalog(200);
  const coldStart = process.hrtime.bigint();
  const index = buildActionIndex(actions);
  const coldMs = Number(process.hrtime.bigint() - coldStart) / 1e6;
  const samples: number[] = [];
  for (let index2 = 0; index2 < 20; index2 += 1) {
    const query = index2 % 3 === 0 ? '统计受管记录' : index2 % 3 === 1 ? '查记录' : 'com.shangshu.app.demo.object.0001.action1';
    const started = process.hrtime.bigint();
    const found = searchActions(index, query);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    assert.ok(found.candidates.length >= 1, '每次都要有候选');
  }
  const p95 = percentile(samples, 95);
  console.log(`[检索] 目录 200 条｜冷启动建索引 ${coldMs.toFixed(1)}ms｜20 次热查询 P95=${p95.toFixed(2)}ms（目标 ≤200ms）`);
  assert.ok(p95 <= 200, `热查询 P95 超标：${p95.toFixed(2)}ms`);
});

it('§8.2 上下文体积：首次请求的「工具目录/定义」部分比原方案至少少 50%', () => {
  const actions = catalog(200);
  // 原方案：常驻工具描述里塞全目录（action_id + title）
  const legacy = actions.map((action: any) => ({ id: String(action.id), title: String(action.title) }));
  const legacyChars = JSON.stringify(legacy).length;
  // 新方案：三个导航能力（搜索 / 读 schema / 调用）
  const navigationChars = JSON.stringify(navigationToolSpecs('按已读取schema提交action_id与payload对象；…')).length;
  const reduced = (1 - navigationChars / legacyChars) * 100;
  console.log(`[体积] 原方案目录 ${legacyChars} 字符 → 新方案导航能力 ${navigationChars} 字符｜减少 ${reduced.toFixed(1)}%（目标 ≥50%，记字符数不是 token）`);
  assert.ok(reduced >= 50, `目录体积减少不足：${reduced.toFixed(1)}%`);
});
