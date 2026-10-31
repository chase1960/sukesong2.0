import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('website 配置段', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ss-cfg-'));
    process.env._SS_DATA_DIR = dir;
  });

  it('website 配置段', async () => {
    // 默认指向线上官网，密钥为空
    {
      const { loadConfig } = await import('../../src/core/config.ts');
      const cfg = loadConfig();
      assert.equal(cfg.website.base_url, 'https://www.lingeringtek.cn');
      assert.equal(cfg.website.api_key, '');
      assert.equal(cfg.website.panel_path, 'panel-a7x9');
    }

    // 旧配置文件无 website 段时由默认值补齐
    {
      writeFileSync(join(dir, 'runtime_config.json'), JSON.stringify({ store: { provider: 'local' } }));
      const { loadConfig } = await import('../../src/core/config.ts');
      assert.equal(loadConfig().website.base_url, 'https://www.lingeringtek.cn');
    }

    // maskConfig 脱敏 api_key 与 panel_key
    {
      const { loadConfig, saveConfig, maskConfig } = await import('../../src/core/config.ts');
      const cfg = loadConfig();
      cfg.website.api_key = 'yk_secret_123456';
      cfg.website.panel_key = 'yk_gate_abcdef';
      saveConfig(cfg);
      const m = maskConfig(loadConfig());
      assert.ok(m.website.api_key.includes('••••'));
      assert.ok(m.website.panel_key.includes('••••'));
      assert.equal(loadConfig().website.api_key, 'yk_secret_123456'); // 真值不受影响
    }
  });
});
