import {createHash} from 'node:crypto';
import type { StateStore } from './types.ts';

/** Conversation evidence is frozen at the turn; later messages never rewrite it. */
export function snapshotChatContext(history: Array<{role: string; content?: unknown}>, trigger: string) {
  return {
    before: history.filter(row => row.role === 'user').slice(-4).map(row => String(row.content || '')),
    trigger,
    after: [] as string[],
    after_status: 'not_available_at_trigger',
    captured_at: new Date().toISOString(),
  };
}

export async function saveChatAuditContext(store: StateStore, actor: string, conversation: string,
  turn: string, proposalIds: string[], snapshot: ReturnType<typeof snapshotChatContext>) {
  if (!actor || !(conversation === actor || conversation.startsWith(actor + ':'))) return;
  requireAuditStore(store);
  for (const proposal of new Set(proposalIds.filter(Boolean))) {
    const id=createHash('sha256').update(JSON.stringify([actor,conversation,turn,proposal])).digest('hex');
    const record={id,actor_key:actor,conversation_id:conversation,turn_id:turn,proposal_id:proposal,context_json:JSON.stringify(snapshot)};
    try {await store.insert('execution','chat_audit_sources',record);}catch(error){
      const existing=await store.query('execution','chat_audit_sources',{id});
      if(existing.length!==1||Object.entries(record).some(([k,v])=>existing[0][k]!==v))throw error;
    }
  }
}

/** Authorization runs before even counting sources; actor keys come only from Frappe. */
export async function readChatAuditContext(user: string, proposal: string, dependencies: {
  authorize: (user: string) => Promise<{collaboration_key: string}>;
  store: StateStore;
  proposal?: (user:string,proposal:string)=>Promise<unknown>;
  includeUserMessageWindow?: boolean;
}) {
  const identity = await dependencies.authorize(user);
  if (!identity.collaboration_key) throw new Error('日志身份没有可信会话归属');
  requireAuditStore(dependencies.store);
  const rows = await dependencies.store.query('execution', 'chat_audit_sources', {
    actor_key: identity.collaboration_key, proposal_id: proposal,
  },{limit:2});
  // No inferred neighbours or client-provided context for historical rows.
  if (rows.length !== 1) return {status: rows.length ? 'ambiguous' : 'not_linked'};
  const row = rows[0];
  if (row.actor_key !== identity.collaboration_key || row.proposal_id !== proposal) return {status: 'not_linked'};
  const context = JSON.parse(String(row.context_json));
  const events=await dependencies.store.query('execution','chat_audit_events',{actor_key:identity.collaboration_key,turn_id:row.turn_id,conversation_id:row.conversation_id},dependencies.includeUserMessageWindow?{limit:201}:undefined);
  const decision=dependencies.proposal?await dependencies.proposal(user,proposal):null;
  return {status: 'linked', proposal_id: proposal, conversation_id: row.conversation_id,
    turn_id: row.turn_id, ...(dependencies.includeUserMessageWindow ? {user_message_window:await readUserMessageWindow(dependencies.store,identity.collaboration_key,String(row.conversation_id),String(row.turn_id))} : {}), context, events:(dependencies.includeUserMessageWindow?events.slice(0,200):events).map(event=>JSON.parse(String(event.event_json))),events_has_more:dependencies.includeUserMessageWindow===true&&events.length>200,decision};
}

export function requireAuditStore(store:StateStore){
  if(store.guarantees?.appendOnlyAudit!==true)throw Error('当前存储不能保证审计事实不可变，不能执行需要留痕的助手操作');
}
export async function appendChatAuditEvent(store:StateStore,actor:string,conversation:string,turn:string,event:Record<string,unknown>){
  if(!actor)return;
  requireAuditStore(store);
  if(!(conversation===actor||conversation.startsWith(actor+':')))throw Error('审计会话与当前身份不一致');
  await store.insert('execution','chat_audit_events',{actor_key:actor,conversation_id:conversation,turn_id:turn,...(event.kind==='tool_request'?{request_id:event.request_id}:{}),event_json:JSON.stringify({...event,recorded_at:new Date().toISOString()})});
}

export interface AuditTrace {
  status: string;
  actor_user?: string;
  request_id?: string;
  action_id?: string;
  proposal_id?: string;
  operation_id?: string;
  [key:string]:unknown;
}
/** Recover a missing link from two independently persisted facts. Never replay a tool. */
export async function readChatAuditTrace(user:string, lookup:{operation_id?:string;request_id?:string}, dependencies:{
  authorize:(user:string)=>Promise<{collaboration_key:string}>;
  trace:(user:string,lookup:{operation_id?:string;request_id?:string})=>Promise<AuditTrace>;
  proposal:(user:string,proposal:string)=>Promise<unknown>;
  store:StateStore;
  includeUserMessageWindow?: boolean;
}){
  const identity=await dependencies.authorize(user);
  if(!identity.collaboration_key)throw Error('日志身份没有可信会话归属');
  requireAuditStore(dependencies.store);
  const trace=await dependencies.trace(user,lookup);
  if(trace.status!=='linked')return {status:'not_linked'};
  if(trace.actor_user!==user||!trace.request_id||!trace.action_id)throw Error('内核日志关联身份不匹配');
  if(lookup.request_id&&lookup.request_id!==trace.request_id)throw Error('内核请求关联不匹配');
  if(lookup.operation_id&&lookup.operation_id!==trace.operation_id)throw Error('内核审计关联不匹配');
  const requests=await dependencies.store.query('execution','chat_audit_events',{actor_key:identity.collaboration_key,request_id:trace.request_id},{limit:2});
  if(requests.length!==1)return {status:requests.length?'ambiguous':'not_linked'};
  const row=requests[0],request=JSON.parse(String(row.event_json));
  const conversation=String(row.conversation_id),turn=String(row.turn_id);
  if(row.actor_key!==identity.collaboration_key||request.kind!=='tool_request'||request.request_id!==trace.request_id||
     !(conversation===identity.collaboration_key||conversation.startsWith(identity.collaboration_key+':')))throw Error('本地请求关联身份不匹配');
  // resolved_action_id只来自可信执行器写入的事件事实；模型arguments不能提供它。
  let action=request.resolved_action_id;
  if(typeof action!=='string'||!action.length){
    action=request.action_id;
    if(request.tool==='platform_action_call') {try{action=JSON.parse(request.arguments).action_id;}catch{return {status:'not_linked'};}}
  }
  if(action!==trace.action_id||!request.context||typeof request.context.trigger!=='string')return {status:'not_linked'};
  if(trace.proposal_id){
    // Query permission again in the normal read path; deterministic insert makes concurrent recovery idempotent.
    await dependencies.proposal(user,trace.proposal_id);
    await saveChatAuditContext(dependencies.store,identity.collaboration_key,conversation,turn,[trace.proposal_id],request.context);
    return {...await readChatAuditContext(user,trace.proposal_id,dependencies),trace};
  }
  const events=await dependencies.store.query('execution','chat_audit_events',{actor_key:identity.collaboration_key,conversation_id:conversation,turn_id:turn},dependencies.includeUserMessageWindow?{limit:201}:undefined);
  return {status:'linked',conversation_id:conversation,turn_id:turn,...(dependencies.includeUserMessageWindow ? {user_message_window:await readUserMessageWindow(dependencies.store,identity.collaboration_key,conversation,turn)} : {}),context:request.context,events:(dependencies.includeUserMessageWindow?events.slice(0,200):events).map(event=>JSON.parse(String(event.event_json))),events_has_more:dependencies.includeUserMessageWindow===true&&events.length>200,trace};
}

/** 四条用户消息为单位；原聊天事实只读，工具过程来自原追加审计事件。 */
export async function readUserMessageWindow(store: StateStore, actor: string, conversation: string, turn: string) {
  requireAuditStore(store);
  if (!actor || !(conversation === actor || conversation.startsWith(actor + ':'))) throw Error('会话归属不匹配');
  const filter = {conversation_id:conversation, role:'user'};
  const anchors = await store.query('execution','chat_messages',{...filter,turn_id:turn},{limit:2});
  // 旧消息没有可信轮次关联，或聊天已删除：不按相近时间猜锚点。
  if(anchors.length!==1)return {status:'not_available',reason:'anchor_message_missing'};
  const anchor=anchors[0];
  const side=async(direction:'before'|'after')=>store.query('execution','chat_messages',filter,{
    sort:{key:'created_at',dir:direction==='before'?'desc':'asc'},stable:true,limit:5,
    cursor:{value:String(anchor.created_at),id:String(anchor.id),direction},
  });
  const [before,after]=await Promise.all([side('before'),side('after')]);
  const selected=[...before.slice(0,4).reverse(),anchor,...after.slice(0,4)];
  const messages=[];
  let budget=256*1024;
  for(const message of selected){
    const events=message.turn_id && budget>0?await store.query('execution','chat_audit_events',{
      actor_key:actor,conversation_id:conversation,turn_id:message.turn_id,
    },{limit:201}):[];
    const calls=[];
    for(const row of events.slice(0,200)){
      // 触发上下文已由消息窗口提供，不在每次内部调用里重复携带四条消息。
      const {context:_context,...event}=JSON.parse(String(row.event_json));
      const encoded=JSON.stringify(event);
      if(encoded.length>budget){
        calls.push({kind:event.kind,request_id:event.request_id,truncated:true,excerpt:encoded.slice(0,budget)});
        budget=0;break;
      }
      budget-=encoded.length;calls.push(event);
    }
    const content=String(message.content || '');
    messages.push({id:message.id,turn_id:message.turn_id,content:content.slice(0,16000),content_truncated:content.length>16000,created_at:message.created_at,
      internal_calls:calls,internal_calls_has_more:events.length>200 || budget===0,
      internal_calls_status:budget===0?'budget_exceeded':message.turn_id?'available':'not_linked'});
  }
  return {status:'linked',snapshot_kind:'current_chat_window',read_at:new Date().toISOString(),
    anchor:anchor.id,messages,before_count:Math.min(before.length,4),after_count:Math.min(after.length,4),
    before_has_more:before.length>4,after_has_more:after.length>4};
}
