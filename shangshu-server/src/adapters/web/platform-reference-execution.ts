// 原平台记录助手的租约适配；只中止原AbortController，不另建Agent循环。
type Reference={object_id:string;name:string};
type Dependencies={record:(object_id:string,name:string)=>Promise<any>;run:(payload:Record<string,unknown>)=>Promise<any>};

export async function guardReferenceExecution(reference:Reference,controller:AbortController,deps:Dependencies,intervalMs=2000){
  const record=await deps.record(reference.object_id,reference.name);
  if(!record.object?.execution_actor_field)return undefined;
  const lease=await deps.run({operation:'begin',...reference});
  if(typeof lease.id!=='string'||!lease.id)throw Error('平台未返回有效记录执行租约');
  let closed=false,checking=false;
  const check=async()=>{
    if(closed||controller.signal.aborted)throw controller.signal.reason||Error('原助手已停止');
    try{await deps.run({operation:'check',execution_id:lease.id});}
    catch(error){controller.abort(error);throw error;}
  };
  const timer=setInterval(async()=>{
    if(closed||checking||controller.signal.aborted)return;
    checking=true;try{await check();}catch{/* 原连接中止，工具/确认仍由内核复核。 */}finally{checking=false;}
  },intervalMs);
  timer.unref?.();
  return {executionId:lease.id,check,close:async()=>{
    if(closed)return;closed=true;clearInterval(timer);
    await deps.run({operation:'end',execution_id:lease.id});
  }};
}
