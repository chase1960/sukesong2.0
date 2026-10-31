import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePlatformMode } from '../../src/core/platform-mode.ts';


test('没有 Frappe 配置时只允许显式或兼容 legacy 模式', () => {
  assert.equal(resolvePlatformMode({} as NodeJS.ProcessEnv), 'legacy');
  assert.equal(resolvePlatformMode({ SHANGSHU_PLATFORM_MODE: 'legacy' } as NodeJS.ProcessEnv), 'legacy');
});

test('检测到 Frappe 地址但没有显式模式时 fail closed', () => {
  assert.throws(
    () => resolvePlatformMode({ FRAPPE_UPSTREAM: 'http://127.0.0.1:8000' } as NodeJS.ProcessEnv),
    /未显式设置 SHANGSHU_PLATFORM_MODE=frappe/,
  );
});

test('Frappe 模式缺少内核地址时拒绝启动且不回退身份', () => {
  assert.throws(
    () => resolvePlatformMode({ SHANGSHU_PLATFORM_MODE: 'frappe' } as NodeJS.ProcessEnv),
    /必须配置 FRAPPE_UPSTREAM/,
  );
  assert.equal(resolvePlatformMode({ SHANGSHU_PLATFORM_MODE: 'frappe', FRAPPE_UPSTREAM: 'http://127.0.0.1:8000' } as NodeJS.ProcessEnv), 'frappe');
});

test('未知平台模式直接拒绝', () => {
  assert.throws(() => resolvePlatformMode({ SHANGSHU_PLATFORM_MODE: 'auto' } as NodeJS.ProcessEnv), /仅支持 legacy 或 frappe/);
});
