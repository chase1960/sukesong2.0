import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { keyFilePath } from './paths.ts';
import type { SyncKey } from './types.ts';

function load(): SyncKey[] {
  const p = keyFilePath();
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf-8')); }
  catch { return []; }
}

function save(keys: SyncKey[]) {
  writeFileSync(keyFilePath(), JSON.stringify(keys, null, 2));
}

function hash(k: string) { return createHash('sha256').update(k).digest('hex'); }

export function createKey(name: string, role: 'upload' | 'download'): string {
  const raw = `sk-${role.slice(0, 1)}-${randomUUID().replace(/-/g, '')}`;
  const keys = load();
  keys.push({ id: randomUUID(), name, keyHash: hash(raw), role, createdAt: new Date().toISOString() });
  save(keys);
  return raw;
}

export function validateKey(key: string, role: 'upload' | 'download'): boolean {
  return load().some(k => k.role === role && k.keyHash === hash(key));
}

export function listKeys(): SyncKey[] {
  return load();
}

export function revokeKey(id: string) {
  save(load().filter(k => k.id !== id));
}
