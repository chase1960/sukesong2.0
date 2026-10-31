// 通用元数据表面：list / get / propose。对象、单据、流程同一套，禁止再为每种流程加专用对话工具。
import { registerCapability } from '../core/registry.ts';
import { registerActionHandler } from '../core/confirm.ts';
import { requireActor } from '../core/actor.ts';
import { listMetadataOverview, getMetaRecord, upsertMetaEntry, type MetaKind } from '../core/meta-store.ts';
import { proposeMetadataWrite, resolveMetadataPublish } from '../core/meta-authoring.ts';
import type { Capability } from '../core/types.ts';

const KINDS: MetaKind[] = ['object', 'doctype', 'flow'];

const metadataList: Capability<{ kind?: string }, unknown> = {
  id: 'metadata.list', name: '列出元数据', impl: 'script', effect: 'read',
  roles: ['admin', 'finance', 'manager'],
  async run(input) {
    const overview = listMetadataOverview();
    const kind = String(input?.kind || '').trim();
    if (kind && !KINDS.includes(kind as MetaKind)) throw new Error('kind 须为 object / doctype / flow');
    if (kind === 'object') return { kind, source: overview.source, items: overview.objects };
    if (kind === 'doctype') return { kind, source: overview.source, items: overview.doctypes };
    if (kind === 'flow') return { kind, source: overview.source, items: overview.flows };
    return { source: overview.source, objects: overview.objects, doctypes: overview.doctypes, flows: overview.flows };
  },
};

const metadataGet: Capability<{ kind: string; key: string }, unknown> = {
  id: 'metadata.get', name: '读取元数据定义', impl: 'script', effect: 'read',
  roles: ['admin', 'finance', 'manager'],
  async run(input, ctx) {
    const kind = String(input?.kind || '') as MetaKind;
    const key = String(input?.key || '').trim();
    if (!KINDS.includes(kind) || !key) throw new Error('kind 与 key 必填');
    const rec = await getMetaRecord(ctx.store, kind, key);
    if (!rec) throw new Error(`未找到元数据: ${kind}/${key}`);
    return rec;
  },
};

const metadataPropose: Capability<Record<string, unknown>, unknown> = {
  id: 'metadata.propose', name: '提案发布元数据', impl: 'script', effect: 'propose',
  roles: ['admin'],
  async run(input, ctx) {
    requireActor(ctx.actor);
    return proposeMetadataWrite(ctx.store, {
      kind: String(input?.kind || '') as MetaKind,
      key: String(input?.key || ''),
      payload: (input?.payload && typeof input.payload === 'object' ? input.payload : {}) as Record<string, unknown>,
      expected_revision: input?.expected_revision == null ? undefined : Number(input.expected_revision),
    });
  },
};

export function registerMetadataTools(): void {
  registerCapability(metadataList);
  registerCapability(metadataGet);
  registerCapability(metadataPropose);
  registerActionHandler('metadata.publish', async (payload, ctx) => {
    const kind = payload.kind as MetaKind;
    const key = String(payload.key);
    const body = payload.payload as Record<string, unknown>;
    await upsertMetaEntry(ctx.store, kind, key, body, Number(payload.expected_revision));
  }, {
    revision: 1,
    roles: ['admin'],
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['kind', 'key', 'payload', 'expected_revision'],
      properties: {
        kind: { type: 'string', enum: ['object', 'doctype', 'flow'] },
        key: { type: 'string', minLength: 1 },
        payload: { type: 'object' },
        expected_revision: { type: 'integer', minimum: 0 },
      },
    },
    resolve: resolveMetadataPublish,
    snapshot: async (store, input) => {
      const rec = await getMetaRecord(store, String(input.kind) as MetaKind, String(input.key));
      return { version: rec?.version ?? 0 };
    },
  });
}
