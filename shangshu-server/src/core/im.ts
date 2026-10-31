// 消息核心（2026-08-07）：会话 + 消息 + 未读。
// 写路径：im.send 事件（confirmed）→ handler 落 messages 表（与发票/记账同一事件写总线机制）。
// member_ids / last_read 存 JSON 文本列；未读按每人 last_read 游标计算。
import type { StateStore } from './types.ts';
import { atomic } from './storage/transaction.ts';
import { appendEvent } from './events.ts';
import { createHash } from 'node:crypto';
import {messageProjection,parseIm} from './im-workplace.ts';

export const messageFingerprint=(text:string,replyTo:string,extras?:{mentions:string[];files:any[]})=>createHash('sha256').update(JSON.stringify(extras&&(extras.mentions.length||extras.files.length)?[text,replyTo,extras]:[text,replyTo])).digest('hex');

export interface ImChat {
  id: string; type: 'dm' | 'group'; name: string;
  member_ids: string[]; created_by: string;
  last_read: Record<string, string>; created_at: string;
}

const parse = <T>(s: unknown, d: T): T => {
  try { return s ? JSON.parse(String(s)) : d; } catch { return d; }
};

// 会话列表（当前用户参与的）：未读数 = 游标之后非本人发的消息数
export async function listChats(store: StateStore, me: string): Promise<any[]> {
  const chats = await store.query('im', 'chats');
  const messages = await store.query('im', 'messages');
  const preferences = await store.query('im', 'preferences', { user_id: me });
  return chats
    .filter((c: any) => (parse<string[]>(c.member_ids, [])).includes(me))
    // 本人已归档的私聊不进我的列表；归档只影响本人，对方与消息本体不受影响
    .filter((c: any) => {
      const archived = c.type === 'dm' && parse<Record<string, string>>(c.archived, {})[me];
      return !archived || messages.some(m => m.chat_id === c.id && m.sender_id !== me && String(m.created_at) > archived);
    })
    .map((c: any) => {
      const members = parse<string[]>(c.member_ids, []);
      const msgs = messages
        .filter((m: any) => m.chat_id === c.id)
        .sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)));
      const last = msgs[msgs.length - 1];
      const lastRead = parse<Record<string, string>>(c.last_read, {})[me] || '';
      const unread = msgs.filter((m: any) => !m.recalled && m.sender_id !== me && String(m.created_at) > lastRead).length;
      const pref = preferences.find(p => p.chat_id === c.id);
      return {
        id: c.id, type: c.type, name: c.name, member_ids: members, created_by: c.created_by,
        last_read: lastRead, unread, mention_unread:msgs.filter(m=>!m.recalled&&m.sender_id!==me&&String(m.created_at)>lastRead&&parseIm<string[]>(m.mentions,[]).includes(me)).length,
        pinned: Number(pref?.pinned) === 1, muted: Number(pref?.muted) === 1,
        last_msg: last ? { id:last.id,text:last.recalled?'':last.text||(parseIm<any[]>(last.file_refs,[]).length?'[文件]':''), created_at: last.created_at, sender_id: last.sender_id, recalled: !!last.recalled } : null,
      };
    })
    .sort((a: any, b: any) => Number(b.pinned)-Number(a.pinned) || String(b.last_msg?.created_at ?? '').localeCompare(String(a.last_msg?.created_at ?? '')));
}

// 个人设置与审计同事务；独立本人行，避免把整群成员偏好互相覆盖。
export async function setChatPreferences(store: StateStore, chatId: string, me: string, patch: unknown): Promise<void> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('会话设置无效');
  const entries=Object.entries(patch);
  if (!entries.length || entries.some(([k,v])=>!['pinned','muted'].includes(k)||typeof v!=='boolean')) throw new Error('仅可设置本人的置顶或免打扰');
  await atomic(store, async tx=>{
    const chat=await chatOf(tx,chatId);
    if(!isMember(chat,me))throw new Error('不在该会话中');
    const [existing]=await tx.query('im','preferences',{chat_id:chatId,user_id:me});
    const values=Object.fromEntries(entries.map(([k,v])=>[k,Number(v)]));
    if(existing)await tx.update('im','preferences',existing.id,values);
    else await tx.insert('im','preferences',{chat_id:chatId,user_id:me,...values});
    await appendEvent(tx,{capability:'im.preferences',entity_type:'chat',entity_id:chatId,payload:values,initiator:me,status:'confirmed',reviewer:me});
  });
}

// 引用只存消息身份，正文读时投影；撤回/失效后不返回历史快照。
export async function validateReply(store: StateStore, chatId: string, replyTo: string): Promise<void> {
  if(!replyTo)return;
  const [original]=await store.query('im','messages',{id:replyTo});
  if(!original || original.chat_id!==chatId || original.recalled)throw new Error('引用消息不存在、已撤回或不在当前会话');
}

// 私聊：已存在则复用（member_ids 无序比较）；本人曾归档则自动恢复显示，否则新建
export async function getOrCreateDm(store: StateStore, me: string, peer: string): Promise<string> {
  const chats = await store.query('im', 'chats');
  const exist = chats.find((c: any) =>
    c.type === 'dm' && (parse<string[]>(c.member_ids, []).includes(me)) && (parse<string[]>(c.member_ids, [])).includes(peer));
  if (exist) {
    const archived = parse<Record<string, string>>(exist.archived, {});
    if (archived[me]) await store.update('im', 'chats', exist.id, { archived: JSON.stringify({ ...archived, [me]: '' }) });
    return exist.id;
  }
  return store.insert('im', 'chats', {
    type: 'dm', name: '',
    member_ids: JSON.stringify([me, peer]),
    created_by: me,
    last_read: JSON.stringify({}),
    archived: JSON.stringify({}),
    created_at: new Date().toISOString(),
  });
}

export async function createGroup(store: StateStore, me: string, name: string, memberIds: string[]): Promise<string> {
  const members = Array.from(new Set([...memberIds, me]));
  return store.insert('im', 'chats', {
    type: 'group', name: name || '未命名群',
    member_ids: JSON.stringify(members),
    created_by: me,
    last_read: JSON.stringify({}),
    created_at: new Date().toISOString(),
  });
}

// 消息列表（时间正序）。只读：已读游标由 markChatRead 按消息 ID 显式推进，
// 读取本身不再标记，避免拉取期间并发到达的新消息被误标已读。
// 2026-08-28 修复：必须为本会话成员才能读取（此前任意登录用户可按 chat_id 读任意私聊/群，还会污染他人游标）。
export async function listMessages(store: StateStore, chatId: string, me: string): Promise<any[]> {
  const chatRows = await store.query('im', 'chats', { id: chatId });
  if (!chatRows.length) throw new Error('会话不存在');
  const c = chatRows[0];
  if (!isMember(c, me)) throw new Error('不在该会话中，无权读取');
  const rows = await store.query('im', 'messages', { chat_id: chatId });
  return messageProjection(store,c,rows.sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))||a.id.localeCompare(b.id)),me);
}

// 按消息 ID 推进本人已读游标，只前进不后退；重复标记同一消息是幂等操作。
export async function markChatRead(store: StateStore, chatId: string, me: string, messageId: string): Promise<void> {
 await atomic(store,async store=>{
  const c = await chatOf(store, chatId);
  if (!isMember(c, me)) throw new Error('不在该会话中');
  const rows = await store.query('im', 'messages', { id: messageId });
  const m = rows[0];
  if (!m || m.chat_id !== chatId) throw new Error('消息不存在');
  const lr = parse<Record<string, string>>(c.last_read, {});
  const at = String(m.created_at);
  if ((lr[me] || '') >= at) return;
  lr[me] = at;
  await store.update('im', 'chats', chatId, { last_read: JSON.stringify(lr) });
 });
}

/* —— 群管理与消息撤回（2026-08-27）：改名/加人/移人/退群/解散/删私聊/撤回 —— */
async function chatOf(store: StateStore, chatId: string): Promise<any> {
  const rows = await store.query('im', 'chats', { id: chatId });
  if (!rows.length) throw new Error('会话不存在');
  return rows[0];
}
const isMember = (c: any, me: string): boolean => parse<string[]>(c.member_ids, []).includes(me);

export async function renameChat(store: StateStore, chatId: string, name: string, me: string, isAdmin: boolean): Promise<void> {
  const c = await chatOf(store, chatId);
  if (c.type !== 'group') throw new Error('私聊不支持改名');
  if (!isMember(c, me)) throw new Error('不在该群中');
  if (c.created_by !== me && !isAdmin) throw new Error('仅群主或管理员可改名');
  if (!name.trim()) throw new Error('群名不能为空');
  await store.update('im', 'chats', chatId, { name: name.trim() });
}

// 群内任何成员都可拉人（与主流 IM 一致）；成员有效性由路由层按 users 表校验
export async function addMembers(store: StateStore, chatId: string, ids: string[], me: string): Promise<void> {
  const c = await chatOf(store, chatId);
  if (c.type !== 'group') throw new Error('私聊不支持加人，请新建群聊');
  if (!isMember(c, me)) throw new Error('不在该群中');
  if (!ids.length) throw new Error('未选择成员');
  const next = Array.from(new Set([...parse<string[]>(c.member_ids, []), ...ids]));
  await store.update('im', 'chats', chatId, { member_ids: JSON.stringify(next) });
}

export async function removeMember(store: StateStore, chatId: string, targetId: string, me: string, isAdmin: boolean): Promise<void> {
  const c = await chatOf(store, chatId);
  if (c.type !== 'group') throw new Error('私聊不支持移除成员');
  if (c.created_by !== me && !isAdmin) throw new Error('仅群主或管理员可移除成员');
  if (targetId === c.created_by) throw new Error('不能移除群主（群主可自行退群）');
  const next = parse<string[]>(c.member_ids, []).filter((x) => x !== targetId);
  await store.update('im', 'chats', chatId, { member_ids: JSON.stringify(next) });
}

async function deleteChatAndMessages(store: StateStore, chatId: string): Promise<void> {
  const msgs = await store.query('im', 'messages', { chat_id: chatId });
  for (const m of msgs) await store.delete('im', 'messages', m.id);
  await store.delete('im', 'chats', chatId);
}

// 退群：群主退群则移交最早加入的成员；退到无人时连消息一起删除
export async function leaveChat(store: StateStore, chatId: string, me: string): Promise<void> {
  const c = await chatOf(store, chatId);
  if (c.type !== 'group') throw new Error('私聊请使用删除会话');
  if (!isMember(c, me)) throw new Error('不在该群中');
  const next = parse<string[]>(c.member_ids, []).filter((x) => x !== me);
  if (!next.length) { await deleteChatAndMessages(store, chatId); return; }
  const patch: any = { member_ids: JSON.stringify(next) };
  if (c.created_by === me) patch.created_by = next[0];
  await store.update('im', 'chats', chatId, patch);
}

export async function disbandChat(store: StateStore, chatId: string, me: string, isAdmin: boolean): Promise<void> {
  const c = await chatOf(store, chatId);
  if (c.type !== 'group') throw new Error('群聊才能解散；私聊请用删除会话');
  if (c.created_by !== me && !isAdmin) throw new Error('仅群主或管理员可解散群聊');
  await deleteChatAndMessages(store, chatId);
}

// 私聊删除会话（2026-09-16 契约修订）：只把会话移出本人的列表（archived per member），
// 消息与对方视图完整保留；重新发起私聊自动恢复。“清空双方记录/解散”是群聊语义，另立入口。
export async function deleteDmChat(store: StateStore, chatId: string, me: string, _isAdmin: boolean): Promise<void> {
  const c = await chatOf(store, chatId);
  if (c.type !== 'dm') throw new Error('群聊请用退群/解散');
  if (!isMember(c, me)) throw new Error('不在该会话中');
  const archived = parse<Record<string, string>>(c.archived, {});
  archived[me] = new Date().toISOString();
  await store.update('im', 'chats', chatId, { archived: JSON.stringify(archived) });
}

export const RECALL_WINDOW_MS = 2 * 60 * 1000;
export async function recallMessage(store: StateStore, chatId: string, msgId: string, me: string): Promise<void> {
  const rows = await store.query('im', 'messages', { id: msgId });
  const m = rows[0];
  if (!m || m.chat_id !== chatId) throw new Error('消息不存在');
  // 必须仍是会话成员（被移出群/退群后不得再撤回）
  const c = await chatOf(store, chatId);
  if (!isMember(c, me)) throw new Error('不在该会话中，无法撤回');
  if (m.sender_id !== me) throw new Error('只能撤回自己的消息');
  const ts = new Date(m.created_at).getTime();
  if (!Number.isFinite(ts)) throw new Error('消息时间异常，无法撤回');
  if (Date.now() - ts > RECALL_WINDOW_MS) throw new Error('发送超过 2 分钟，无法撤回');
  await store.update('im', 'messages', msgId, { recalled: true, text: '' });
}

