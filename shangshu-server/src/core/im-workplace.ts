// 通用IM兼容事实：收藏是指针，文件是原公共来源引用，不复制文件或权限。
import type {StateStore,QueryOpts} from './types.ts';
import {atomic} from './storage/transaction.ts';
import {appendEvent} from './events.ts';
export const parseIm=<T>(value:unknown,fallback:T):T=>{try{return value?JSON.parse(String(value)):fallback;}catch{return fallback;}};
export type FileReference={ref_name:string;file:string};
export type MessageExtras={mentions:string[];files:FileReference[]};
export function normalizeMessageExtras(value:any):MessageExtras{
 const mentions=value?.mentions??[],files=value?.files??[];
 if(!Array.isArray(mentions)||mentions.length>50||mentions.some(x=>typeof x!=='string'||!x||x.length>140)||new Set(mentions).size!==mentions.length)throw Error('请选择有效的会话成员');
 if(!Array.isArray(files)||files.length>5||files.some(x=>!x||typeof x!=='object'||Object.keys(x).some(k=>!['ref_name','file'].includes(k))||['ref_name','file'].some(k=>typeof x[k]!=='string'||!x[k]||x[k].length>140||/[\x00-\x1f]/.test(x[k]))))throw Error('仅支持最多5个文件中心固定版本引用');
 if(new Set(files.map(x=>x.file)).size!==files.length)throw Error('不能重复添加同一文件');
 return {mentions:[...mentions].sort(),files:files.map(x=>({ref_name:x.ref_name,file:x.file}))};
}
export async function memberChat(store:StateStore,chatId:string,me:string){const [c]=await store.query('im','chats',{id:chatId});if(!c||!parseIm<string[]>(c.member_ids,[]).includes(me))throw Error('会话不存在或无权访问');return c;}
export async function validateMessageExtras(store:StateStore,chatId:string,extras:MessageExtras){const [c]=await store.query('im','chats',{id:chatId});if(!c||extras.mentions.some(id=>!parseIm<string[]>(c.member_ids,[]).includes(id)))throw Error('@成员已不在当前会话，请重新选择');}
export async function messageProjection(store:StateStore,chat:any,rows:any[],me:string){
 const members=parseIm<string[]>(chat.member_ids,[]),read=parseIm<Record<string,string>>(chat.last_read,{});
 const favorites=await store.query('im','favorites',{user_id:me,chat_id:chat.id});
 const quoted=new Map<string,any>();
 for(const id of new Set(rows.filter(m=>!m.recalled&&m.reply_to).map(m=>m.reply_to))){const [m]=await store.query('im','messages',{id});if(m?.chat_id===chat.id)quoted.set(id,m);}
 return rows.map(m=>{
   const source=quoted.get(m.reply_to),own=m.sender_id===me;
   return {id:m.id,sender_id:m.sender_id,text:m.recalled?'':m.text||'',created_at:m.created_at,recalled:!!m.recalled,
    reply:!m.recalled&&m.reply_to?{id:m.reply_to,sender_id:source?.sender_id||'',text:source&&!source.recalled?String(source.text||'').slice(0,500):'',recalled:!source||!!source.recalled}:null,
    mentions:m.recalled?[]:parseIm<string[]>(m.mentions,[]),files:m.recalled?[]:parseIm<FileReference[]>(m.file_refs,[]),forwarded:!m.recalled&&!!m.forwarded,
    favorite:favorites.some(f=>f.message_id===m.id),
    ...(own&&!m.recalled?{read_by:members.filter(id=>id!==me&&String(read[id]||'')>=String(m.created_at)),recipient_count:members.filter(id=>id!==me).length}:{}),
   };
 });
}
export async function messagePage(store:StateStore,chatId:string,me:string,raw:any){
 const chat=await memberChat(store,chatId,me),limit=Number(raw.limit??80);
 if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('每页消息数须为1至100');
 if([raw.before,raw.after,raw.around].filter(Boolean).length>1)throw Error('消息定位参数不能混用');
 const filter:Record<string,any>={chat_id:chatId},conditions:NonNullable<QueryOpts['conditions']>=[];
 if(raw.mentioned==='1')conditions.push({key:'mentions',op:'includes',value:JSON.stringify(me)});
 if(raw.sender){if(typeof raw.sender!=='string'||raw.sender.length>140)throw Error('成员筛选无效');filter.sender_id=raw.sender;}
 if(raw.q){if(typeof raw.q!=='string'||raw.q.length>200)throw Error('搜索限200字');conditions.push({key:'text',op:'contains',value:raw.q});}
 for(const [name,op] of [['from','gte'],['to','lt']] as const)if(raw[name]){const d=new Date(raw[name]);if(!Number.isFinite(d.getTime()))throw Error('日期筛选无效');conditions.push({key:'created_at',op,value:d.toISOString()});}
 const anchorId=raw.before||raw.after||raw.around;
 let anchor:any;
 if(anchorId){[anchor]=await store.query('im','messages',{id:String(anchorId)});if(!anchor||anchor.chat_id!==chatId)throw Error('原消息不存在或不在当前会话');}
 const query=(direction:'before'|'after',n:number)=>store.query('im','messages',filter,{sort:{key:'created_at',dir:direction==='before'?'desc':'asc'},stable:true,limit:n,conditions,...(anchor?{cursor:{value:String(anchor.created_at),id:anchor.id,direction}}:{})});
 if(raw.around){const before=await query('before',Math.floor(limit/2)+1),after=await query('after',Math.floor(limit/2)+1);return {list:await messageProjection(store,chat,[...before.slice(0,Math.floor(limit/2)).reverse(),anchor,...after.slice(0,Math.floor(limit/2))],me),has_more:before.length>Math.floor(limit/2),has_newer:after.length>Math.floor(limit/2),window:true};}
 const direction=raw.after?'after':'before',rows=await query(direction,limit+1),selected=rows.slice(0,limit);if(direction==='before')selected.reverse();
 return {list:await messageProjection(store,chat,selected,me),has_more:rows.length>limit,window:true};
}
export async function setFavorite(store:StateStore,chatId:string,messageId:string,me:string,value:boolean){
 await atomic(store,async tx=>{
  const existing=await tx.query('im','favorites',{user_id:me,chat_id:chatId,message_id:messageId});
  if(value){await memberChat(tx,chatId,me);const [m]=await tx.query('im','messages',{id:messageId});if(!m||m.chat_id!==chatId||m.recalled)throw Error('消息已撤回或不可用');if(!existing.length)await tx.insert('im','favorites',{user_id:me,chat_id:chatId,message_id:messageId,created_at:new Date().toISOString()});}
  else for(const row of existing)await tx.delete('im','favorites',row.id);
  await appendEvent(tx,{capability:'im.favorite',entity_type:'message',entity_id:messageId,payload:{favorite:value},initiator:me,status:'confirmed',reviewer:me});
 });
}
export async function listFavorites(store:StateStore,me:string){
 const saved=await store.query('im','favorites',{user_id:me},{sort:{key:'created_at',dir:'desc'}}),result:any[]=[];
 for(const f of saved){let c;try{c=await memberChat(store,f.chat_id,me);}catch{continue;}const [m]=await store.query('im','messages',{id:f.message_id});if(!m||m.chat_id!==c.id)continue;result.push({...((await messageProjection(store,c,[m],me))[0]),chat_id:c.id,chat_name:c.name});}
 return result;
}
