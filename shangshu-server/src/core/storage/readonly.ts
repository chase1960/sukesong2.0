import type {StateStore} from '../types.ts';
// read/extract 能力拿到只读门面；不能用标签把写操作伪装为可重试查询。
export function readonlyStore(store:StateStore):StateStore {
  const denied=async():Promise<never>=>{throw new Error('只读能力禁止修改状态');};
  return {query:(...args)=>store.query(...args),insert:denied,update:denied,delete:denied,compareAndSet:denied,
    guarantees:{transactions:false,conditionalUpdate:false,stableIds:store.guarantees?.stableIds || false}};
}
