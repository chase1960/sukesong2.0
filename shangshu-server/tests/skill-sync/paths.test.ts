import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SKILL_DIR, repoPath, keyFilePath } from '../../src/capabilities/skill-sync/paths.ts';

describe('paths', () => {
  it('SKILL_DIR ends with /skills', () => {
    assert.ok(SKILL_DIR.endsWith('skills'), SKILL_DIR);
  });
  it('repoPath uses bare repo convention', () => {
    assert.ok(repoPath('my-skill').endsWith('my-skill.git'));
  });
  it('keyFilePath uses keys.json', () => {
    assert.ok(keyFilePath().endsWith('keys.json'));
  });
});
