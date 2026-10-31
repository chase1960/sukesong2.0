import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

it('窄屏内联切表条清除旧弹层层级，不盖住全局导航', () => {
  const css = readFileSync(new URL('../../../shangshu-web/css/deepseek.css', import.meta.url), 'utf8');
  const rule = css.match(/@container\(max-width:620px\).*?\.objects-page \.dataset-panel\{([^}]+)\}/)?.[1];
  assert.ok(rule);
  assert.match(rule, /z-index:auto/);
});
