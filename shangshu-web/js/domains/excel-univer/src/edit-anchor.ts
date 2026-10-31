import type {CandidateOverlayFrame} from './candidate-overlay';

/** Anchor the native editor to its original cell, without committing or recreating it. */
export function mountEditAnchor(host:HTMLElement,frame:()=>CandidateOverlayFrame|null){
  let target:{row:number;col:number}|null=null,editor:HTMLElement|null=null,dead=false;
  function clear(){if(editor){for(const key of ['left','top','clip-path'])editor.style.removeProperty(key);editor=null;}}
  function update(){
    if(dead||!target)return;
    const current=host.querySelector<HTMLElement>('[data-u-comp="editor"].univer-absolute');
    const view=frame(),cell=view?.rect(target.row,target.col);
    if(!current||!view||!cell)return;
    if(editor&&editor!==current)clear();editor=current;
    const parent=(editor.offsetParent as HTMLElement|null)?.getBoundingClientRect()??host.getBoundingClientRect();
    const base=host.getBoundingClientRect();
    const left=base.left+cell.left-parent.left,top=base.top+cell.top-parent.top;
    const size=editor.getBoundingClientRect();
    const outside=cell.left+cell.width<=view.clip.left||cell.left>=view.clip.left+view.clip.width||cell.top+cell.height<=view.clip.top||cell.top>=view.clip.top+view.clip.height;
    const clip=outside?'inset(100%)':`inset(${Math.max(0,view.clip.top-cell.top)}px ${Math.max(0,cell.left+size.width-view.clip.left-view.clip.width)}px ${Math.max(0,cell.top+size.height-view.clip.top-view.clip.height)}px ${Math.max(0,view.clip.left-cell.left)}px)`;
    for(const [key,value] of [['left',left+'px'],['top',top+'px'],['clip-path',clip]]){
      if(editor.style.getPropertyValue(key)!==value||editor.style.getPropertyPriority(key)!=='important')editor.style.setProperty(key,value,'important');
    }
  }
  const Observer=host.ownerDocument.defaultView!.MutationObserver;
  const observer=new Observer(()=>update());
  observer.observe(host,{subtree:true,childList:true,attributes:true,attributeFilter:['style']});
  return {setTarget(row:number,col:number){target={row,col};update();},end(){target=null;clear();},update,dispose(){dead=true;observer.disconnect();target=null;clear();}};
}
