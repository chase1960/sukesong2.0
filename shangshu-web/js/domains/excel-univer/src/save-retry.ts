/** One original attempt and at most two retries, always using the caller's same operation. */
export async function retrySave<T>(operation:()=>Promise<T>,active:()=>boolean=()=>true):Promise<T>{
  let error:unknown;
  for(let attempt=0;attempt<3;attempt++){
    if(!active())throw new Error('操作已结束');
    try{return await operation();}catch(e){error=e;}
  }
  throw error;
}
