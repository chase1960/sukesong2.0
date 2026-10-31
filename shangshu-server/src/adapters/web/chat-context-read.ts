/**
 * 内容段的**服务端核对读口**（2026-10-21）。
 *
 * 前端报上来的内容是「**当前这个用户屏幕上已经有的**」——但收到时还要**按当前身份再核一遍**：
 * 换身份、撤权、对象已删、无权的那一列 —— 核不过就**丢弃内容**，一个字都不进提示词。
 *
 * 这里**不判权限**：读口自己判（平台模式走平台的记录/服务/动作读口，
 * 那里按当前会话做权限与字段 ACL；旧模式走内核的对象读权与行级范围）。
 * 本文件只负责「按出处把内容读回来」与「把读到的字符串交给内核逐条核对」。
 */
import type { Request } from 'express';
import type { ContextRefReadResult, ContextRefReader, ChatUiContentRef } from '../../core/chat-context.ts';
import { collectStringValues } from '../../core/chat-context.ts';
import { readPlatformRecord, readPlatformService, readPlatformAction } from './platform.ts';
import { getObjectType } from '../../core/objects.ts';
import { authorize, currentActor } from '../../core/actor.ts';
import { getRuntimeStore } from '../../core/store.ts';

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

/** 平台模式：按出处重读（记录 / 只读服务 / 只读动作）。 */
function platformReader(req: Request): ContextRefReader {
  return async (ref: ChatUiContentRef): Promise<ContextRefReadResult> => {
    try {
      if (ref.via === 'service') {
        if (!ref.service_id) return { ok: false, reason: '出处没有服务编号' };
        const result = await readPlatformService(req, ref.service_id, ref.payload || {});
        return { ok: true, values: collectStringValues(result) };
      }
      if (ref.via === 'action') {
        if (!ref.action_id) return { ok: false, reason: '出处没有动作编号' };
        const result = await readPlatformAction(req, ref.action_id, ref.payload || {});
        return { ok: true, values: collectStringValues(result) };
      }
      if (!ref.entity_type || !ref.entity_id) return { ok: false, reason: '出处没有对象类型或记录编号' };
      const record = await readPlatformRecord(req, ref.entity_type, ref.entity_id);
      return { ok: true, values: collectStringValues(record) };
    } catch (error) {
      // 平台的 403/404 就是「当前身份读不到 / 对象没了」——不当异常吞掉，要说清。
      return { ok: false, reason: reasonOf(error) };
    }
  };
}

/** 旧模式：按对象读权核一条记录（行级范围也照旧口径）。 */
function legacyReader(): ContextRefReader {
  return async (ref: ChatUiContentRef): Promise<ContextRefReadResult> => {
    if (ref.via === 'service' || ref.via === 'action') {
      return { ok: false, reason: '当前接入方式不支持按服务或动作核对这段内容' };
    }
    const objectId = String(ref.entity_type || '');
    const name = String(ref.entity_id || '');
    if (!objectId || !name) return { ok: false, reason: '出处没有对象类型或记录编号' };
    const objectType = getObjectType(objectId);
    if (!objectType) return { ok: false, reason: `当前没有可读的对象类型「${objectId}」` };
    const actor = currentActor();
    try { authorize(objectType.readRoles || ['admin', 'finance', 'manager'], actor); }
    catch (error) { return { ok: false, reason: reasonOf(error) }; }
    const rows = await getRuntimeStore().query(objectType.layer, objectType.table);
    const row = rows.find((item: any) => String(item?.id ?? '') === name);
    if (!row) return { ok: false, reason: '这条记录已不存在，或不在你的可见范围内' };
    if (actor?.role === 'staff' && objectType.rowOwnerField
      && String((row as any)[objectType.rowOwnerField] ?? '') !== String(actor.id)) {
      return { ok: false, reason: '这条记录不在你的可见范围内' };
    }
    return { ok: true, values: collectStringValues(row) };
  };
}

/**
 * 造一个核对读口。
 *
 * `platformMode === 'frappe'` 走平台读口（权限与字段 ACL 由平台判）；
 * 否则走旧模式的对象读权。**两条都不因为「是前端报上来的」而免检。**
 */
export function createContextRefReader(req: Request, platformMode: string): ContextRefReader {
  return platformMode === 'frappe' ? platformReader(req) : legacyReader();
}
