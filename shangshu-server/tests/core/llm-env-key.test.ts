import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('LLM 环境密钥', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ss-llm-env-'));
    process.env._SS_DATA_DIR = dir;
    process.env.SHANGSHU_LLM_API_KEY = 'env-test-key';
  });

  it('首次启动时应用于默认中转配置和中转来源', async () => {
    const { loadConfig, saveConfig } = await import('../../src/core/config.ts');
    const cfg = loadConfig();
    assert.equal(cfg.llm.api_key, 'env-test-key');
    assert.equal(cfg.llm_sources?.[0].api_key, 'env-test-key');
    saveConfig(cfg);
    const persisted = JSON.parse(readFileSync(join(dir, 'runtime_config.json'), 'utf8'));
    assert.equal(persisted.llm.api_key, '');
    assert.equal(persisted.llm_sources[0].api_key, '');
  });

  it('运行配置选用其他模型时不覆盖活动密钥，但只更新匹配的中转来源', async () => {
    writeFileSync(join(dir, 'runtime_config.json'), JSON.stringify({
      llm: { provider: 'deepseek', base_url: 'https://example.test/v1', model: 'other', api_key: 'other-key' },
      llm_sources: [
        { id: 'gpt6sol-relay', api_key: 'old-relay-key' },
        { id: 'custom', api_key: 'custom-key' },
      ],
    }));
    const { loadConfig } = await import('../../src/core/config.ts');
    const cfg = loadConfig();
    assert.equal(cfg.llm.api_key, 'other-key');
    assert.equal(cfg.llm_sources?.[0].api_key, 'env-test-key');
    assert.equal(cfg.llm_sources?.[1].api_key, 'custom-key');
  });

  it('空环境变量不覆盖本地配置', async () => {
    process.env.SHANGSHU_LLM_API_KEY = '   ';
    writeFileSync(join(dir, 'runtime_config.json'), JSON.stringify({ llm: { api_key: 'local-key' } }));
    const { loadConfig } = await import('../../src/core/config.ts');
    assert.equal(loadConfig().llm.api_key, 'local-key');
  });
});
