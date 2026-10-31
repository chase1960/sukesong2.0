import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../recruitment.js', import.meta.url), 'utf8');
const actStart = source.indexOf('  async function act(button, fn) {');
const actEnd = source.indexOf('\n  }', actStart) + 4;
const actSource = source.slice(actStart, actEnd);

function loadAct() {
  const state = { error: '', notice: '' };
  const order = [];
  const button = {
    textContent: '确认',
    classList: {
      values: new Set(),
      add(value) { this.values.add(value); },
      remove(value) { this.values.delete(value); },
      contains(value) { return this.values.has(value); },
    },
  };
  const render = () => order.push({ type: 'render', ...state });
  const refreshAll = async () => {
    order.push({ type: 'refresh' });
    state.error = '';
  };
  const act = new Function('state', 'render', 'refreshAll', `return (${actSource})`)(state, render, refreshAll);
  return { act, button, order, state };
}

test('successful action refreshes first and keeps its success notice visible', async () => {
  const { act, button, order, state } = loadAct();

  await act(button, async () => {
    state.notice = '已激活：HR 确认已记录，审计链可查。';
  });

  assert.deepEqual(order.map(item => item.type), ['refresh', 'render']);
  assert.equal(order.at(-1).notice, '已激活：HR 确认已记录，审计链可查。');
  assert.equal(order.at(-1).error, '');
  assert.equal(button.classList.contains('busy'), false);
});

test('failed action clears stale notice and renders the error after refresh', async () => {
  const { act, button, order, state } = loadAct();
  state.notice = '旧成功提示';

  await act(button, async () => {
    throw new Error('服务暂不可用');
  });

  assert.deepEqual(order.map(item => item.type), ['refresh', 'render']);
  assert.equal(order.at(-1).notice, '');
  assert.equal(order.at(-1).error, '服务暂不可用');
  assert.equal(button.classList.contains('busy'), false);
});
