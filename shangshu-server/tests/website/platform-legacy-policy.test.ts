import assert from 'node:assert/strict';
import test from 'node:test';

import { isPlatformLegacyPathAllowed, platformLegacyGuard } from '../../src/adapters/web/platform-legacy-policy.ts';

test('平台模式只保留协作、AI 和集成配置兼容面', () => {
  for (const path of [
    '/session', '/chat', '/chat/history', '/confirmations/APROP-1', '/config',
    '/im/chats', '/tasks', '/tasks/TASK-1', '/posts', '/people', '/instance/health',
  ]) assert.equal(isPlatformLegacyPathAllowed(path), true, path);
});

test('旧身份、ERP、流程、调度、工具和工作区默认拒绝', () => {
  for (const path of [
    '/users', '/workspaces', '/customers', '/products', '/orders', '/purchases',
    '/inventory', '/invoices', '/ledger', '/receivables', '/payables', '/workflows',
    '/triggers', '/ai-tools', '/events', '/alerts', '/website/submissions',
  ]) {
    assert.equal(isPlatformLegacyPathAllowed(path), false, path);
    assert.deepEqual(platformLegacyGuard(path), {
      allowed: false,
      code: 'LEGACY_SURFACE_DISABLED',
      message: '该旧版能力未接入统一平台内核，已在平台模式停用',
    });
  }
});
