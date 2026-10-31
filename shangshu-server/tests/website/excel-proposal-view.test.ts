import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposalCells, proposalValueText, editedProposalValue } from '../../../shangshu-web/js/domains/excel-univer/src/proposal-view.ts';
test('proposal location uses stable row identity and header, never visual position', () => {
  assert.deepEqual(proposalCells({payload:{cells:[{row_id:'r001',header:'金额',value:{type:'number',value:9}},{row_id:'r009',header:'决定',value:{type:'text',value:'同意'}}]}}),[
    {rowId:'r001',header:'金额',value:{type:'number',value:9}},{rowId:'r009',header:'决定',value:{type:'text',value:'同意'}}]);
  assert.deepEqual(proposalCells({payload:{row_index:1,column:1,value:'wrong'}}),[]);
});
test('typed proposed values display actual text; untouched type is retained', () => {
  const p={payload:{cells:[{row_id:'r1',header:'编号',value:{type:'text',value:'00123'}}]}};
  assert.equal(proposalValueText(p.payload.cells[0].value),'00123');
  assert.equal(editedProposalValue(p,'00123'),undefined);
  assert.deepEqual(editedProposalValue(p,'00456'),{type:'text',value:'00456'});
  const n={payload:{value:{type:'number',value:12.5}}};
  assert.equal(editedProposalValue(n,'12.5'),undefined);
  assert.deepEqual(editedProposalValue(n,'99.5'),{type:'number',value:99.5});
});
test('bad numeric suggestions and ambiguous multi-cell edits cannot turn into a write', () => {
  for(const text of ['bad','00123','1234567890123456789','']) assert.throws(()=>editedProposalValue({payload:{value:{type:'number',value:1}}},text));
  assert.throws(()=>editedProposalValue({payload:{cells:[{value:'1'},{value:'2'}]}},'3'),/不是单值/);
});
