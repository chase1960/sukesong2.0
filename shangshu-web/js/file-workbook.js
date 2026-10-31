/* 自由文件单元格，不使用业务字段定义；保存由文件工作区统一执行。 */
window.mountFileWorkbook = function({host,data,editable,onChange=()=>{},notify=()=>{},promptName=async()=>null,confirmDelete=async()=>false}){
  const copy=value=>JSON.parse(JSON.stringify(value)),escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let book=copy(data),ops=[],base=JSON.stringify(book.sheets),undo=[],redo=[],active=0,point={r:0,c:0},anchor={r:0,c:0},disabled=false,disposed=false,page=0,editing=null;
  const controller=new AbortController(),sheet=()=>book.sheets[active],writable=()=>editable&&!disabled&&!disposed;
  const letter=index=>{let result='';for(let n=index+1;n;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result;return result;};
  const range=()=>({top:Math.min(point.r,anchor.r),bottom:Math.max(point.r,anchor.r),left:Math.min(point.c,anchor.c),right:Math.max(point.c,anchor.c)});
  const text=cell=>cell==null?'':cell.t==='b'?(cell.v?'TRUE':'FALSE'):String(cell.v);
  function name(value){if(!value?.trim()||value.length>31||/[\\/*?:\[\]\x00-\x1f]/.test(value)||book.sheets.some(s=>s.title.toLowerCase()===value.toLowerCase()))throw Error('工作表名称无效或重名（最多31字）');return value;}
  function cell(value,prior){
    if(value.length>32767||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))throw Error('单元格文字过长或含非法字符');
    if(value==='')return null;
    if(prior?.t==='d'){if(!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?)?$/.test(value)||Number.isNaN(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value.slice(0,10))throw Error('原日期单元格使用有效YYYY-MM-DD');return {t:'d',v:value};}
    if(prior?.t==='b'&&/^(true|false)$/i.test(value))return {t:'b',v:value.toLowerCase()==='true'};
    // 前导零和长编号保持文字；新输入的=表达式也只是文字，不执行公式。
    if(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)&&value.replace(/[-.]/g,'').length<=15&&Number.isFinite(Number(value)))return {t:'n',v:Number(value)};
    return {t:'s',v:value};
  }
  function check(){
    if(book.sheets.length>10||book.sheets.reduce((n,s)=>n+s.rows*s.columns,0)>100000||ops.length>200||book.sheets.some(s=>s.rows>1000||s.columns>100))throw Error('上限10张工作表、1000行、100列、10万格或200次结构操作，请先保存或拆分');
  }
  function commit(change){
    if(!writable())return;
    const before={book:copy(book),ops:copy(ops),active,point:{...point},anchor:{...anchor}};
    try{change();check();}catch(error){book=before.book;ops=before.ops;active=before.active;point=before.point;anchor=before.anchor;throw error;}
    if(JSON.stringify(book.sheets)===JSON.stringify(before.book.sheets))return;
    undo.push(before);if(undo.length>30)undo.shift();redo=[];render();onChange();
  }
  function grow(rows,columns){
    const s=sheet();if(rows>1000||columns>100)throw Error('粘贴超过1000行或100列上限');
    if(columns>s.columns){const count=columns-s.columns;ops.push({kind:'insert_column',key:s.key,index:s.columns+1,count});s.cells.forEach(row=>row.push(...Array(count).fill(null)));s.columns=columns;}
    if(rows>s.rows){const count=rows-s.rows;ops.push({kind:'insert_row',key:s.key,index:s.rows+1,count});for(let i=0;i<count;i++)s.cells.push(Array(s.columns).fill(null));s.rows=rows;}
  }
  function setCell(r,c,value){if(!writable())return;commit(()=>{if(r<0||c<0)throw Error('单元格坐标无效');grow(r+1,c+1);sheet().cells[r][c]=cell(String(value),sheet().cells[r][c]);});}
  function paste(value){
    if(!writable())return;
    if(value.length>200000)throw Error('粘贴内容过长，请拆分');
    const lines=readClipboard(value);
    if(lines.length*Math.max(...lines.map(row=>row.length))>10000)throw Error('单次粘贴最多1万格');
    // 全部值先转换，任一错误不留下部分修改。
    const converted=lines.map((row,r)=>row.map((v,c)=>cell(v,sheet().cells[point.r+r]?.[point.c+c])));
    commit(()=>{grow(point.r+lines.length,point.c+Math.max(...lines.map(row=>row.length)));converted.forEach((row,r)=>row.forEach((v,c)=>{sheet().cells[point.r+r][point.c+c]=v;}));});
  }
  function addSheet(title){if(!writable())return;name(title);commit(()=>{const key='new'+crypto.randomUUID().replaceAll('-','');book.sheets.push({key,title,rows:20,columns:12,cells:Array.from({length:20},()=>Array(12).fill(null))});ops.push({kind:'add_sheet',key,title});active=book.sheets.length-1;point=anchor={r:0,c:0};page=0;});}
  function action(kind){
    if(!writable())return;
    if(kind==='undo'||kind==='redo'){
      if(!finish())return;const source=kind==='undo'?undo:redo,target=kind==='undo'?redo:undo,entry=source.pop();if(!entry)return;
      target.push({book:copy(book),ops:copy(ops),active,point:{...point},anchor:{...anchor}});({book,ops,active,point,anchor}=entry);page=Math.floor(point.r/60);render();onChange();return;
    }
    commit(()=>{
      const s=sheet();if(kind==='delete_sheet'){if(book.sheets.length===1)throw Error('至少保留一个工作表');ops.push({kind,key:s.key});book.sheets.splice(active,1);active=Math.max(0,active-1);point=anchor={r:0,c:0};page=0;return;}
      if(kind==='clear'){const selected=range();for(let r=selected.top;r<=selected.bottom;r++)for(let c=selected.left;c<=selected.right;c++)s.cells[r][c]=null;return;}
      const rowAxis=kind.endsWith('row'),insert=kind.startsWith('insert'),selected=range(),index=rowAxis?selected.top:selected.left,count=insert?1:rowAxis?selected.bottom-selected.top+1:selected.right-selected.left+1;
      if(!['insert_row','delete_row','insert_column','delete_column'].includes(kind))throw Error('未知表格操作');
      if(!insert&&(rowAxis?s.rows:s.columns)<=count)throw Error('至少保留一行和一列');
      ops.push({kind,key:s.key,index:index+1,count});
      if(rowAxis){s.cells.splice(index,insert?0:count,...(insert?[Array(s.columns).fill(null)]:[]));s.rows+=insert?1:-count;}
      else{s.cells.forEach(row=>row.splice(index,insert?0:count,...(insert?[null]:[])));s.columns+=insert?1:-count;}
      point={r:Math.min(point.r,s.rows-1),c:Math.min(point.c,s.columns-1)};anchor={...point};page=Math.floor(point.r/60);
    });
  }
  function select(r,c,extend=false){if(!finish())return;point={r:Math.max(0,Math.min(sheet().rows-1,r)),c:Math.max(0,Math.min(sheet().columns-1,c))};if(!extend)anchor={...point};const next=Math.floor(point.r/60);if(next!==page){page=next;render();}else highlight();const target=host.querySelector(`[data-cell="${point.r}:${point.c}"]`);target?.focus({preventScroll:true});target?.scrollIntoView?.({block:'nearest',inline:'nearest'});}
  function highlight(){
    const selected=range();host.querySelectorAll('[data-cell]').forEach(td=>{const [r,c]=td.dataset.cell.split(':').map(Number);td.classList.toggle('is-selected',r>=selected.top&&r<=selected.bottom&&c>=selected.left&&c<=selected.right);td.classList.toggle('is-current',r===point.r&&c===point.c);td.tabIndex=r===point.r&&c===point.c?0:-1;});
    host.querySelector('[data-grid-address]').textContent=letter(point.c)+(point.r+1);host.querySelector('[data-grid-value]').textContent=text(sheet().cells[point.r][point.c]);
  }
  function edit(td,initial){
    if(!writable()||!td)return;const [r,c]=td.dataset.cell.split(':').map(Number);if(!finish())return;td=host.querySelector(`[data-cell="${r}:${c}"]`);point=anchor={r,c};highlight();
    const input=document.createElement('span');input.setAttribute('contenteditable','true');input.setAttribute('role','textbox');input.setAttribute('aria-label',letter(c)+(r+1));input.spellcheck=false;input.textContent=initial??text(sheet().cells[r][c]);
    td.textContent='';td.append(input);editing={input,r,c,old:text(sheet().cells[r][c])};input.focus();
    const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(input);if(initial!==undefined)range.collapse(false);selection.removeAllRanges();selection.addRange(range);
    const insertText=value=>{
      const selection=window.getSelection();if(!selection.rangeCount)return;const range=selection.getRangeAt(0);
      if(!input.contains(range.commonAncestorContainer))return;range.deleteContents();const node=document.createTextNode(value);range.insertNode(node);range.setStartAfter(node);range.collapse(true);selection.removeAllRanges();selection.addRange(range);onChange();
    };
    input.onblur=()=>finish();
    input.onkeydown=event=>{if(event.isComposing)return;if(['Enter','Tab','Escape'].includes(event.key))event.stopPropagation();if(event.key==='Enter'&&event.altKey){event.preventDefault();insertText('\n');return;}if(event.key==='Escape'){event.preventDefault();editing=null;render();select(r,c);}else if(['Enter','Tab'].includes(event.key)){event.preventDefault();if(finish())select(r+(event.key==='Enter'?(event.shiftKey?-1:1):0),c+(event.key==='Tab'?(event.shiftKey?-1:1):0));}};
    input.onpaste=event=>{event.preventDefault();event.stopPropagation();insertText(event.clipboardData.getData('text/plain'));};
    input.oninput=()=>{
      host.querySelector('[data-grid-action="undo"]').disabled=!writable()||(!undo.length&&input.textContent===editing?.old);
      onChange();
    };
  }
  function finish(){
    if(!editing)return true;const {input,r,c,old}=editing,value=input.textContent;editing=null;
    try{if(value!==old)setCell(r,c,value);else render();return true;}catch(error){editing={input,r,c,old};notify(error.message);return false;}
  }
  function render(){
    if(disposed)return;
    const oldScroll=host.querySelector('.file-grid-scroll'),scrollLeft=oldScroll?.scrollLeft||0,scrollTop=oldScroll?.scrollTop||0;
    const s=sheet(),start=page*60,end=Math.min(start+60,s.rows);
    const button=(key,label)=>`<button type="button" class="btn btn-ghost" data-grid-action="${key}" ${!writable()?'disabled':''}>${label}</button>`;
    host.classList.add('file-workbook');
    host.innerHTML=`<div class="file-workbook-tools">${button('undo','撤销')}${button('redo','重做')}<span class="file-grid-divider"></span>${button('insert_row','插入行')}${button('insert_column','插入列')}<details><summary class="btn btn-ghost">更多</summary><div class="file-grid-menu">${button('delete_row','删除所选行')}${button('delete_column','删除所选列')}${button('clear','清空所选值')}<button class="btn btn-ghost" data-grid-rename ${!writable()?'disabled':''}>重命名工作表</button><button class="btn btn-ghost" data-grid-remove ${!writable()?'disabled':''}>删除工作表</button></div></details><span>${editable?'双击编辑 · Shift选择区域':'只读'} · ${s.rows}行 × ${s.columns}列</span></div><div class="file-grid-formula"><b data-grid-address></b><span data-grid-value></span></div><div class="file-grid-scroll"><table class="file-grid-table" aria-label="${escape(s.title)}"><thead><tr><th></th>${Array.from({length:s.columns},(_,c)=>`<th scope="col" data-grid-col="${c}">${letter(c)}</th>`).join('')}</tr></thead><tbody>${s.cells.slice(start,end).map((row,index)=>{const r=index+start;return `<tr><th scope="row" data-grid-row="${r}">${r+1}</th>${row.map((value,c)=>`<td tabindex="-1" data-cell="${r}:${c}" ${value?.t==='n'?'class="is-number"':''}>${escape(text(value))}</td>`).join('')}</tr>`;}).join('')}</tbody></table></div><footer class="file-grid-footer"><nav aria-label="工作表">${book.sheets.map((s,i)=>`<button data-grid-sheet="${i}" ${i===active?'aria-current="page"':''}>${escape(s.title)}</button>`).join('')}<button data-grid-add ${!writable()?'disabled':''} aria-label="新建工作表">＋</button></nav><div><button class="btn btn-ghost" data-grid-prev ${page===0?'disabled':''}>上一段</button><span>第${start+1}–${end}行</span><button class="btn btn-ghost" data-grid-next ${end>=s.rows?'disabled':''}>下一段</button></div></footer>`;
    host.querySelector('[data-grid-action="undo"]').disabled=!writable()||!undo.length;host.querySelector('[data-grid-action="redo"]').disabled=!writable()||!redo.length;
    host.querySelectorAll('[data-grid-action]').forEach(b=>b.onclick=()=>{if(finish())try{action(b.dataset.gridAction);}catch(e){notify(e.message);}});
    host.querySelectorAll('[data-cell]').forEach(td=>{const [r,c]=td.dataset.cell.split(':').map(Number);td.onclick=e=>select(r,c,e.shiftKey);td.ondblclick=()=>edit(host.querySelector(`[data-cell="${r}:${c}"]`));});
    host.querySelectorAll('[data-grid-col]').forEach(th=>th.onclick=()=>{if(!finish())return;point={r:s.rows-1,c:Number(th.dataset.gridCol)};anchor={r:0,c:point.c};highlight();host.querySelector(`[data-cell="${page*60}:${point.c}"]`)?.focus({preventScroll:true});});
    host.querySelectorAll('[data-grid-row]').forEach(th=>th.onclick=()=>{if(!finish())return;point={r:Number(th.dataset.gridRow),c:s.columns-1};anchor={r:point.r,c:0};highlight();host.querySelector(`[data-cell="${point.r}:0"]`)?.focus({preventScroll:true});});
    host.querySelectorAll('[data-grid-sheet]').forEach(b=>b.onclick=()=>{if(!finish())return;active=Number(b.dataset.gridSheet);point=anchor={r:0,c:0};page=0;render();});
    host.querySelector('[data-grid-add]').onclick=async()=>{if(!finish())return;const title=await promptName('新建工作表','工作表'+(book.sheets.length+1));if(title&&writable())try{addSheet(title);}catch(e){notify(e.message);}};
    host.querySelector('[data-grid-rename]').onclick=async()=>{if(!finish())return;const key=s.key,title=await promptName('重命名工作表',s.title);if(title&&writable()&&sheet().key===key&&title!==s.title)try{name(title);commit(()=>{sheet().title=title;ops.push({kind:'rename_sheet',key,title});});}catch(e){notify(e.message);}};
    host.querySelector('[data-grid-remove]').onclick=async()=>{if(!finish())return;const key=s.key;if(await confirmDelete('删除工作表“'+s.title+'”及全部单元格？保存后才写入文件新版本。')&&writable()&&sheet().key===key)try{action('delete_sheet');}catch(e){notify(e.message);}};
    host.querySelector('[data-grid-prev]').onclick=()=>{if(finish()){page--;render();}};host.querySelector('[data-grid-next]').onclick=()=>{if(finish()){page++;render();}};highlight();
    const scroll=host.querySelector('.file-grid-scroll');scroll.scrollLeft=scrollLeft;scroll.scrollTop=scrollTop;
  }
  host.addEventListener('keydown',event=>{
    if(editing||!event.target.closest('[data-cell]'))return;
    if((event.ctrlKey||event.metaKey)&&['z','y'].includes(event.key.toLowerCase())){event.preventDefault();action(event.key.toLowerCase()==='y'||event.shiftKey?'redo':'undo');return;}
    const offsets={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1],Tab:[0,event.shiftKey?-1:1],Enter:[event.shiftKey?-1:1,0]};
    if(offsets[event.key]){event.preventDefault();select(point.r+offsets[event.key][0],point.c+offsets[event.key][1],event.shiftKey&&event.key.startsWith('Arrow'));return;}
    if(event.key==='F2'||event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();edit(event.target.closest('[data-cell]'),event.key==='F2'?undefined:event.key);}
    if(['Delete','Backspace'].includes(event.key)){event.preventDefault();action('clear');}
  },{signal:controller.signal});
  function readClipboard(value){
    const rows=[[]];let field='',quoted=false,closed=false;
    for(let i=0;i<value.length;i++){const char=value[i];if(quoted){if(char==='"'){if(value[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=char;continue;}
      if(char==='"'&&!field&&!closed){quoted=true;continue;}
      if(char==='\t'||char==='\n'||char==='\r'){rows.at(-1).push(field);field='';closed=false;if(char==='\r'&&value[i+1]==='\n')i++;if(char!=='\t'&&i!==value.length-1)rows.push([]);continue;}
      if(closed)throw Error('粘贴引号结构无效');field+=char;
    }
    if(quoted)throw Error('粘贴引号未闭合');if(field||!/[\r\n]$/.test(value))rows.at(-1).push(field);return rows;
  }
  host.addEventListener('copy',event=>{if(editing||!event.target.closest('[data-cell]'))return;const selected=range(),lines=sheet().cells.slice(selected.top,selected.bottom+1).map(row=>row.slice(selected.left,selected.right+1).map(value=>{const v=text(value);return /[\t\r\n"]/.test(v)?'"'+v.replaceAll('"','""')+'"':v;}).join('\t'));event.clipboardData.setData('text/plain',lines.join('\n'));event.preventDefault();},{signal:controller.signal});
  host.addEventListener('paste',event=>{if(editing||!event.target.closest('[data-cell]')||!writable())return;event.preventDefault();try{paste(event.clipboardData.getData('text/plain'));}catch(e){notify(e.message);}},{signal:controller.signal});
  render();
  return {action,addSheet,setCell,paste,finish,snapshot(){if(!finish())throw Error('当前单元格输入无效，草稿已保留');return {workbook:copy(book),operations:copy(ops)};},isDirty:()=>!!editing&&editing.input.textContent!==editing.old||JSON.stringify(book.sheets)!==base,
    markSaved(){finish();book.sheets.forEach((s,index)=>s.key='s'+index);base=JSON.stringify(book.sheets);ops=[];undo=[];redo=[];render();},setDisabled(value){if(disabled===value)return;if(!finish())return;disabled=value;render();},dispose(){disposed=true;controller.abort();}};
};
