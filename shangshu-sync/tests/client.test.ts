import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SyncClient } from '../src/client.ts';

describe('client', () => {
  it('uses upload key in headers', () => {
    const c = new SyncClient({ serverUrl: 'http://x', uploadKey: 'u1', skillsDir: '/tmp', autoSyncAll: true, allowlist: [], ignorePatterns: [] });
    assert.equal((c as any).cfg.uploadKey, 'u1');
  });
});
