import { join } from 'node:path';
import { DATA_DIR } from '../../core/config.ts';

export const SKILL_DIR = join(DATA_DIR, 'skills');
export const KEY_FILE = join(DATA_DIR, 'skill-sync-keys.json');
export const SYNC_CONFIG_FILE = join(DATA_DIR, 'skill-sync-config.json');

export function repoPath(skillName: string) {
  const base = process.env._SS_SKILL_DIR || SKILL_DIR;
  return join(base, `${skillName}.git`);
}
export function keyFilePath() {
  const base = process.env._SS_SKILL_DIR || DATA_DIR;
  return join(base, 'skill-sync-keys.json');
}
