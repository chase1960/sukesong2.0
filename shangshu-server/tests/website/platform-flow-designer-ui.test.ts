import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

class FakeLogicFlow {
  static latest:FakeLogicFlow;
  nodes:any[]=[]; edges:any[]=[]; handlers:Record<string,Function>={};
  history={undoAble:()=>true,redoAble:()=>true};
  constructor(_options:any){FakeLogicFlow.latest=this;}
  register(){} setTheme(){} fitView(){} zoom(){} resize(){} destroy(){}
  render(data:any){this.nodes=structuredClone(data.nodes||[]);this.edges=structuredClone(data.edges||[]);}
  getGraphData(){return {nodes:structuredClone(this.nodes),edges:structuredClone(this.edges)};}
  getPointByClient(){return {canvasOverlayPosition:{x:360,y:180}};}
  on(name:string,handler:Function){this.handlers[name]=handler;}
  emit(name:string,data:any){this.handlers[name]?.(data);}
  addNode(node:any){this.nodes.push(structuredClone(node));this.emit('node:add',{data:node});return node;}
  getNodeDataById(id:string){return this.nodes.find(node=>String(node.id)===id);}
  getEdgeDataById(id:string){return this.edges.find(edge=>String(edge.id)===id);}
  setProperties(id:string,patch:any){const item=this.getNodeDataById(id)||this.getEdgeDataById(id);item.properties={...(item.properties||{}),...structuredClone(patch)};}
  updateText(id:string,value:string){const item=this.getNodeDataById(id)||this.getEdgeDataById(id);item.text={value};}
  selectElementById(){} undo(){} redo(){}
  deleteElement(id:string){this.nodes=this.nodes.filter(node=>node.id!==id);this.edges=this.edges.filter(edge=>edge.id!==id&&edge.sourceNodeId!==id&&edge.targetNodeId!==id);}
  getNodeIncomingEdge(id:string){return this.edges.filter(edge=>edge.targetNodeId===id);}
  getNodeOutgoingEdge(id:string){return this.edges.filter(edge=>edge.sourceNodeId===id);}
}

it('Graph 画布可新增、拖动、连线并把条件保存为可追溯结构',()=>{
  const dom=new JSDOM('<div id="host"></div>',{runScripts:'outside-only'});
  const w=dom.window as any;
  const n='com.shangshu.finance.node.';
  Object.assign(w,{
    Core:{default:FakeLogicFlow,LogicFlow:FakeLogicFlow,RectNode:class{},RectNodeModel:class{}},LogicFlow:FakeLogicFlow,
    esc:(value:any)=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    confirm:()=>true,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:Function)=>{fn();return 1;},structuredClone,
  });
  const graph={
    schema_version:2,
    data_sources:[{id:'expense_claim',title:'费用报销单',scope:'business_object',fields:[{path:'amount',label:'报销金额',data_type:'number'}]}],
    nodes:[{id:n+'start',type:'human_task',title:'提交',start:true},{id:n+'condition',type:'condition',title:'判断金额'},{id:n+'end',type:'human_task',title:'完成',terminal:true}],
    edges:[{id:'e-start',source:n+'start',target:n+'condition'},{id:'e-pass',source:n+'condition',target:n+'end',is_default:true,label:'其他情况'}],
  };
  try{
    w.eval(readFileSync(new URL('../../../shangshu-web/js/platform-flow-designer.js',import.meta.url),'utf8'));
    const api=w.mountPlatformGraphDesigner({container:w.document.querySelector('#host'),graph,definitionId:'com.shangshu.finance.expense_approval',context:{actions:[],roles:['System Manager','Expense Approver']}});
    assert.equal(w.document.querySelectorAll('[data-add-node]').length,7);
    assert.equal(w.document.querySelector('.pfd-shell')?.classList.contains('no-inspector'),true);
    w.document.querySelector('[data-add-node="human_task"]').click();
    assert.equal(api.getGraph().nodes.length,4);
    assert.equal(w.document.querySelector('.pfd-shell')?.classList.contains('no-inspector'),false);

    const title=w.document.querySelector('[data-node-title]') as HTMLInputElement;
    title.value='金额复核';title.dispatchEvent(new w.Event('input'));
    assert.equal(api.getGraph().nodes.at(-1).title,'金额复核','输入后立即进入画布状态，不依赖失焦');
    assert.equal(w.document.querySelector('.pfd-selection-title b')?.textContent,'金额复核');

    const lf=FakeLogicFlow.latest;
    const added=lf.nodes.at(-1);
    added.x=512;added.y=288;lf.emit('node:drop',{data:added});
    assert.equal(api.getGraph().nodes.at(-1).position.x,512);
    assert.equal(api.getGraph().nodes.at(-1).position.y,288);

    const edge={id:'e-amount',type:'polyline',sourceNodeId:n+'condition',targetNodeId:added.id,properties:{_edge:{id:'e-amount',source:n+'condition',target:added.id}}};
    lf.edges.push(edge);lf.emit('edge:add',{data:edge});lf.emit('edge:click',{data:edge});
    const source=w.document.querySelector('[data-edge-source]') as HTMLSelectElement;
    source.value='expense_claim::amount';source.dispatchEvent(new w.Event('change'));
    const operator=w.document.querySelector('[data-edge-operator]') as HTMLSelectElement;
    operator.value='gte';operator.dispatchEvent(new w.Event('change'));
    const value=w.document.querySelector('[data-edge-value]') as HTMLInputElement;
    value.value='5000';value.dispatchEvent(new w.Event('input'));
    const saved=api.getGraph().edges.find((item:any)=>item.id==='e-amount');
    assert.equal(saved.condition.source.object_id,'expense_claim');
    assert.equal(saved.condition.source.field_path,'amount');
    assert.equal(saved.condition.operator,'gte');
    assert.equal(saved.condition.value,5000);
  }finally{dom.window.close();}
});
