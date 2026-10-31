import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// 只运行真正的产品协调函数，不模拟后端权限；异步回执/错误为传输边界替身。
const source = new URL('../../../shangshu-web/js/mail-batch.js', import.meta.url);
function coordinator() {
  const scope = {};
  runInNewContext(readFileSync(source, 'utf8'), scope);
  return scope.runMailBatch;
}
const receipt = id => ({name: id, status: 'Trash', record_version: 2});
const denied = () => Object.assign(new Error('当前没有该邮箱的邮件管理权限'), {uncertain: false});
const delayed = value => new Promise(resolve => setTimeout(() => resolve(value), 2));
const plain = value => JSON.parse(JSON.stringify(value));

it('异步三封回收中一封权限失败，继续剩余项并逐项返回真实结果', async () => {
  const calls = [], progress = [];
  let inFlight = 0, maxInFlight = 0;
  const result = await coordinator()({ids: ['a', 'b', 'c'],
    invoke: async id => {
      calls.push(id); maxInFlight = Math.max(maxInFlight, ++inFlight);
      try { await delayed(null); if (id === 'b') throw denied(); return receipt(id); }
      finally { inFlight--; }
    }, onProgress: state => progress.push(plain(state))});
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(plain(result.success).map(x => x.id), ['a', 'c']);
  assert.deepEqual(plain(result.failed), [{id: 'b', reason: '当前没有该邮箱的邮件管理权限'}]);
  assert.deepEqual(plain(result.unknown), []);
  assert.equal(result.allSucceeded, false);
  assert.deepEqual(plain(result.retryIds), ['b']);
  assert.deepEqual(progress.map(x => x.completed), [1, 2, 3]);
  assert.equal(progress[0].allSucceeded, false, '运行中不能先报全部完成');
});

it('网络断开保留结果未知且继续其余，不能误报失败或全成功', async () => {
  const calls = [];
  const result = await coordinator()({ids: ['a', 'b', 'c'], invoke: async id => {
    calls.push(id); await delayed(null);
    if (id === 'b') throw Object.assign(new TypeError('网络断开，请核实后重试'), {uncertain: true});
    return receipt(id);
  }});
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.deepEqual(plain(result.counts), {total: 3, success: 2, failed: 0, unknown: 1});
  assert.deepEqual(plain(result.unknown), [{id: 'b', reason: '网络断开，请核实后重试'}]);
  assert.equal(result.allSucceeded, false);
  assert.deepEqual(plain(result.retryIds), ['b']);
});

it('未标记的异常与不完整/错对象/错状态回执均是未知，不猜测已回收', async () => {
  const result = await coordinator()({ids: ['throw', 'empty', 'other', 'draft', 'version', 'good'],
    invoke: async id => {
      await delayed(null);
      if (id === 'throw') throw new Error('读取回包失败');
      if (id === 'empty') return {};
      if (id === 'other') return receipt('different');
      if (id === 'draft') return {...receipt(id), status: 'Draft'};
      if (id === 'version') return {...receipt(id), record_version: 0};
      return receipt(id);
    }});
  assert.deepEqual(plain(result.counts), {total: 6, success: 1, failed: 0, unknown: 5});
  assert.deepEqual(plain(result.retryIds), ['throw', 'empty', 'other', 'draft', 'version']);
  assert.equal(result.success[0].id, 'good');
});

it('重试仅包含失败/未知项，成功项不重复；调用方保持原动作载荷和幂等键', async () => {
  const payloads = {a: {mail: 'a', expected_version: 1}, b: {mail: 'b', expected_version: 3}, c: {mail: 'c', expected_version: 5}};
  const keys = {a: 'key-a', b: 'key-b', c: 'key-c'}, calls = [];
  let retry = false;
  const invoke = async id => {
    calls.push({id, payload: payloads[id], key: keys[id]}); await delayed(null);
    if (!retry && id === 'b') throw denied();
    if (!retry && id === 'c') throw Object.assign(new Error('回包丢失'), {uncertain: true});
    return receipt(id);
  };
  const run = coordinator();
  const first = await run({ids: ['a', 'b', 'c'], invoke});
  retry = true;
  const next = await run({ids: first.retryIds, invoke});
  assert.deepEqual(calls.map(x => x.id), ['a', 'b', 'c', 'b', 'c']);
  assert.equal(calls[1].payload, calls[3].payload);
  assert.equal(calls[2].key, calls[4].key);
  assert.equal(next.allSucceeded, true);
  assert.deepEqual(plain(next.retryIds), []);
});

it('开始后选择变化不扩大发送范围，重复选中只调用一次', async () => {
  const ids = ['a', 'b', 'a'], calls = [];
  const result = await coordinator()({ids, invoke: async id => {
    calls.push(id); ids.push('later'); await delayed(null); return receipt(id);
  }});
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(result.counts.total, 2);
  assert.equal(result.allSucceeded, true);
});

it('进度回调不能修改协调器内部结果或把已成功的动作改判为未知', async () => {
  const seen = [];
  const result = await coordinator()({ids: ['a', 'b'], invoke: async id => receipt(id),
    onProgress: state => {
      seen.push(state.completed); state.success.length = 0; state.retryIds.push('injected');
      if (state.completed === 1) throw new Error('视图刷新失败');
    }});
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(plain(result.success).map(x => x.id), ['a', 'b']);
  assert.deepEqual(plain(result.retryIds), []);
  assert.equal(result.allSucceeded, true);
  assert.deepEqual(plain(result.progressErrors), [{id: 'a', reason: '视图刷新失败'}]);
});

it('空选择不调用动作，也不提示全部成功', async () => {
  let called = false;
  const result = await coordinator()({ids: [], invoke: async () => {called = true;}});
  assert.equal(called, false);
  assert.deepEqual(plain(result.counts), {total: 0, success: 0, failed: 0, unknown: 0});
  assert.equal(result.allSucceeded, false);
  assert.equal(result.status, 'empty');
});

it('非法ID在任何调用前拒绝，避免前半批已动后才发现坏选择', async () => {
  let calls = 0;
  await assert.rejects(() => coordinator()({ids: ['a', ''], invoke: async id => {calls++; return receipt(id);}}), /邮件编号/);
  assert.equal(calls, 0);
});

it('向现有action注入回执校验，使坏回包重试仍保留原幂等键', async () => {
  const keys = new Map(), calls = [];
  let first = true, serial = 0;
  const invoke = async (id, validate) => {
    if (!keys.has(id)) keys.set(id, `request-${++serial}`);
    calls.push(keys.get(id));
    const result = await delayed(first ? {} : receipt(id));
    // 复用现action的边界顺序：validate成功之后才删除key。
    if (!validate(result)) throw Object.assign(new Error('保存回执不完整，请核实原请求'), {uncertain: true});
    keys.delete(id);
    return result;
  };
  const run = coordinator();
  const failed = await run({ids: ['a'], invoke});
  assert.equal(failed.unknown.length, 1);
  first = false;
  const next = await run({ids: failed.retryIds, invoke});
  assert.equal(next.allSucceeded, true);
  assert.deepEqual(calls, ['request-1', 'request-1']);
  assert.equal(keys.size, 0);
});
