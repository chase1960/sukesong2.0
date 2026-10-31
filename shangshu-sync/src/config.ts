import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface LocalConfig {
  serverUrl: string;
  uploadKey?: string;
  downloadKey?: string;
  skillsDir: string;
  autoSyncAll: boolean;
  allowlist: string[];
  ignorePatterns: string[];
}

const CONFIG_DIR = join(homedir(), '.shangshu');
const CONFIG_PATH = join(CONFIG_DIR, 'sync-config.json');

export function loadConfig(): LocalConfig {
  if (!existsSync(CONFIG_PATH)) return defaultConfig();
  return { ...defaultConfig(), ...JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) };
}

export function saveConfig(cfg: Partial<LocalConfig>) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const merged = { ...loadConfig(), ...cfg };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
}

function defaultConfig(): LocalConfig {
  return {
    serverUrl: 'http://127.0.0.1:3000',
    skillsDir: join(homedir(), '.claude', 'skills'),
    autoSyncAll: true,
    allowlist: [],
    ignorePatterns: ['.DS_Store', '*.tmp', '.git'],
  };
}
