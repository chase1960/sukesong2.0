#!/usr/bin/env node
import { loadConfig, saveConfig } from './config.ts';
import { SyncClient } from './client.ts';
import { watch, pushSkill, pullAll } from './watcher.ts';
import { ensureGit } from './git.ts';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const cmd = args[0];
const cfg = loadConfig();
const client = new SyncClient(cfg);

async function main() {
  switch (cmd) {
    case 'init': {
      const serverUrl = args[1] || cfg.serverUrl;
      const uploadKey = args[2];
      const downloadKey = args[3];
      saveConfig({ serverUrl, uploadKey, downloadKey });
      console.log('配置已保存到 ~/.shangshu/sync-config.json');
      break;
    }
    case 'push': {
      const skill = args[1];
      if (!skill) throw new Error('缺少 skill 名称');
      await pushSkill(skill, cfg, client);
      break;
    }
    case 'pull': {
      await pullAll(cfg);
      break;
    }
    case 'watch': {
      await watch(cfg);
      break;
    }
    default: {
      console.log('用法: shangshu-sync <init|push|pull|watch>');
      console.log('  init <serverUrl> <uploadKey> [downloadKey]');
      console.log('  push <skill-name>');
      console.log('  pull');
      console.log('  watch');
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
