import assert from 'node:assert/strict';
import test from 'node:test';

import { testOutputFailed } from '../verify-kernel-baseline.mjs';


test('Frappe 即使退出码为零也能识别测试失败摘要', () => {
  assert.equal(testOutputFailed('Ran 2 tests\nOK'), false);
  assert.equal(testOutputFailed('Ran 2 tests\nFAILED (failures=1)'), true);
  assert.equal(testOutputFailed('Traceback (most recent call last):\nboom'), true);
  assert.equal(testOutputFailed('Testing is disabled for the site!'), true);
});
