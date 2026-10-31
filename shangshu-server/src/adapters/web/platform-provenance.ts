/** Core proves the process/node; Node proves Assistant initiation against its journal. */
export async function enrichProcessOrigin(value:any, verify:(origin:any)=>Promise<any>):Promise<any>{
  if(!value||typeof value!=='object')return value;
  if(Array.isArray(value))return Promise.all(value.map(item=>enrichProcessOrigin(item,verify)));
  const provenance=value.source_provenance;
  if(!provenance||provenance.status!=='linked'||provenance.trusted!==true||!provenance.initiator)return value;
  const origin=provenance.initiator;
  // Never accept an already asserted Assistant flag from an upstream caller.
  let initiator:any={...origin,kind:'action',trusted:false};
  if(typeof origin.actor_user==='string'&&typeof origin.request_id==='string'&&typeof origin.action_id==='string'){
    try{
      const result=await verify(origin);
      if(result?.status==='linked'&&result.trace?.actor_user===origin.actor_user&&
          result.trace?.request_id===origin.request_id&&result.trace?.action_id===origin.action_id&&
          (!origin.proposal_id||result.trace?.proposal_id===origin.proposal_id)){
        initiator={...origin,kind:'assistant',trusted:true};
      }
    }catch{initiator={kind:'unavailable',trusted:false};}
  }
  return {...value,source_provenance:{...provenance,initiator}};
}
