/** Header-only overlay. The target and version are captured at opening, never read from later selection. */
export interface HeaderRenameTarget {header:string;colIndex:number;contentVersion:number;structureVersion:number;rect:{left:number;top:number;width:number;height:number}}
export function mountHeaderRename(host:HTMLElement,options:{locate(x:number,y:number):HeaderRenameTarget|null;allowed():boolean;headers():string[];newKey():string;save(target:HeaderRenameTarget,value:string,opId:string):Promise<void>;blocked():void}){
  const doc=host.ownerDocument,box=doc.createElement('div');box.className='excel-header-editor';box.hidden=true;
  const input=doc.createElement('input');input.setAttribute('aria-label','原位修改列名');input.autocomplete='off';
  const error=doc.createElement('span');error.setAttribute('role','alert');box.append(input,error);host.append(box);
  let target:HeaderRenameTarget|null=null,busy=false,dead=false;const attempts=new Map<string,string>();
  function close(){if(busy)return;target=null;box.hidden=true;error.textContent='';}
  function open(next:HeaderRenameTarget){if(busy)return;if(!options.allowed()){options.blocked();return;}target={...next,rect:{...next.rect}};input.value=next.header;error.textContent='';box.hidden=false;Object.assign(box.style,{left:next.rect.left+'px',top:next.rect.top+'px',width:Math.max(32,next.rect.width)+'px',height:next.rect.height+'px'});input.focus();input.select();}
  async function commit(){
    if(!target||busy||dead)return;const current=target,value=input.value.trim();
    if(!value){error.textContent='列名不能为空';return;}
    if(value===current.header){close();return;}
    if(options.headers().some((name,index)=>index!==current.colIndex&&name===value)){error.textContent='已有同名列，请换一个名称';return;}
    if(!options.allowed()){options.blocked();error.textContent='当前不可修改列名，请先完成保存或检查权限';return;}
    const fingerprint=JSON.stringify([current.header,current.contentVersion,current.structureVersion,value]);let op=attempts.get(fingerprint);if(!op){op=options.newKey();attempts.set(fingerprint,op);}
    busy=true;input.disabled=true;error.textContent='正在保存列名…';
    try{await options.save(current,value,op);if(!dead){busy=false;close();}}
    catch(cause){if(!dead)error.textContent='列名未确认保存：'+((cause as Error).message||String(cause));}
    finally{busy=false;input.disabled=false;}
  }
  const double=(event:MouseEvent)=>{if(box.contains(event.target as Node))return;const found=options.locate(event.clientX,event.clientY);if(!found)return;event.preventDefault();event.stopImmediatePropagation();open(found);};
  host.addEventListener('dblclick',double,true);
  box.addEventListener('pointerdown',event=>event.stopPropagation());box.addEventListener('dblclick',event=>event.stopPropagation());
  input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();void commit();}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}});
  const outside=(event:Event)=>{if(target&&!box.contains(event.target as Node))close();};doc.addEventListener('pointerdown',outside,true);
  return {open,close,isOpen:()=>!!target,isBusy:()=>busy,dispose(){dead=true;host.removeEventListener('dblclick',double,true);doc.removeEventListener('pointerdown',outside,true);box.remove();}};
}
