import {test} from 'node:test';
import assert from 'node:assert/strict';
import {enrichProcessOrigin} from '../../src/adapters/web/platform-provenance.ts';
const origin={actor_user:'alice',action_id:'start',request_id:'R1',proposal_id:'P1',label:'ai-chat'};
const value={id:'P2',created_via:'automation',source_provenance:{status:'linked',trusted:true,kind:'process',initiator:origin}};
test('actual core trace and immutable journal match is required for Assistant initiation',async()=>{
 const result=await enrichProcessOrigin(value,async()=>({status:'linked',trace:{...origin}}));
 assert.equal(result.source_provenance.initiator.kind,'assistant');assert.equal(result.source_provenance.initiator.trusted,true);
 for(const mismatch of [{actor_user:'bob'},{request_id:'other'},{action_id:'other'},{proposal_id:'other'}]){
  const wrong=await enrichProcessOrigin(value,async()=>({status:'linked',trace:{...origin,...mismatch}}));assert.equal(wrong.source_provenance.initiator.trusted,false);
 }
});
test('legacy source labels and missing journal do not fabricate trusted trigger',async()=>{
 let called=false;const legacy={created_via:'ai-chat'};
 assert.deepEqual(await enrichProcessOrigin(legacy,async()=>{called=true;}),legacy);assert.equal(called,false);
 const missing=await enrichProcessOrigin(value,async()=>({status:'not_linked'}));assert.equal(missing.source_provenance.initiator.kind,'action');assert.equal(missing.source_provenance.initiator.trusted,false);
});
test('revoked source audit permissions return no actor, request, proposal or context',async()=>{
 const denied=await enrichProcessOrigin(value,async()=>{throw Error('secret details');});
 assert.deepEqual(denied.source_provenance.initiator,{kind:'unavailable',trusted:false});assert.doesNotMatch(JSON.stringify(denied),/secret details|alice|R1|P1/);
});
