import { it } from 'node:test';
import assert from 'node:assert/strict';
import { rebuildProjection } from '../../src/core/projection.ts';
it('审计回看不能重放业务写命令', async () => {
  const store: any = { query: () => { throw new Error('不应读取或写入业务表'); } };
  await assert.rejects(() => rebuildProjection(store), /已禁用业务命令重放/);
});
