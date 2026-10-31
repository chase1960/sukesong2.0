import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKey, validateKey, listKeys, revokeKey } from '../../src/capabilities/skill-sync/keys.ts';

describe('keys', { concurrency: false }, () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ss-keys-test-'));
    process.env._SS_SKILL_DIR = root;
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('creates and validates upload key', () => {
    const raw = createKey('mine', 'upload');
    assert.ok(raw.length > 20);
    assert.equal(validateKey(raw, 'upload'), true);
    assert.equal(validateKey(raw, 'download'), false);
  });

  it('lists keys without raw value', () => {
    createKey('a', 'upload');
    const keys = listKeys();
    assert.equal(keys.length, 1);
    assert.equal(keys[0].name, 'a');
    assert.ok(!keys[0].keyHash.includes('sk-'));
  });

  it('revokes key', () => {
    createKey('b', 'download');
    const [k] = listKeys();
    revokeKey(k.id);
    assert.equal(listKeys().length, 0);
  });
});
