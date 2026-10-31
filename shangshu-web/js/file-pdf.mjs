/* 只读PDF：原件已由调用方授权获取；所有解析资源同源、按需加载。 */
export function mountPdf(surface,{url,name,current=()=>true,loadLibrary=()=>import('../vendor/pdfjs-6.4.299/pdf.min.mjs')}){
  const document=surface.ownerDocument,win=document.defaultView;
  /* 工具条收成**一行**的公共控件：上一页｜页码｜下一页｜缩放｜查找(默认收起)｜独立打开。
     ⚠ 查找能力不许删，只是收进次要入口；独立打开也不许独占一整行。
     状态位（加载/绘制/密码/打不开）在工具条下方一行小字，**有话才占高**。
     「第 X / Y 页 · 只读原件」不再整行重复 —— 页码已经在工具条上。 */
  surface.innerHTML='<div class="file-pdf-reader">'+
  '<div class="file-pdf-toolbar" role="group" aria-label="PDF阅读">'+
  '<button class="btn" data-pdf-prev disabled>上一页</button>'+
  '<span class="file-pdf-page"><input data-pdf-page type="number" min="1" value="1" aria-label="PDF页码" disabled><span data-pdf-count></span></span>'+
  '<button class="btn" data-pdf-next disabled>下一页</button>'+
  '<select data-pdf-zoom aria-label="PDF缩放" disabled><option value="fit">适应宽度</option><option value="50">50%</option><option value="100">100%</option><option value="150">150%</option><option value="200">200%</option></select>'+
  '<details class="file-pdf-more"><summary>更多</summary><div class="file-pdf-more-body">'+
  '<details class="file-pdf-searchbox"><summary>查找文字</summary>'+
  '<form class="file-pdf-search"><input data-pdf-query aria-label="查找PDF文字" placeholder="查找文档文字" maxlength="100" disabled><button class="btn" type="submit" disabled>查找</button></form>'+
  '</details>'+
  '<a class="file-pdf-open btn" data-pdf-open target="_blank" rel="noopener">独立打开</a>'+
  '</div></details>'+
  '</div>'+
  '<p data-pdf-status role="status"></p>'+
  '<div data-pdf-results></div>'+
  /* —— **加载态＝骨架**（契约 `loading-state-v1.json`）：阅读器还在路上 ⇒ **不写看得见的字**，
   *   正文那一块摆一块**会呼吸的灰条页**（形状照最终那一页：抬头 ＋ 几行 ＋ 一块面）。
   *   ⚠️ 状态位留空（`:empty` 不占高）；读屏的信号在骨架那个容器上（`aria-busy`，不写字）。
   *   ⚠️ 页画好了 ⇒ 同一个容器里换掉骨架（`viewport.replaceChildren(canvas)` ⇒ 不跳版）。 */
  '<div class="file-pdf-viewport"><div class="platform-skeleton platform-skeleton-panel" data-skeleton="pdf-page" aria-busy="true" style="min-height:100%">'
  +'<span class="platform-skeleton-bar platform-skeleton-panel-title"></span>'
  +'<span class="platform-skeleton-bar platform-skeleton-panel-line"></span>'
  +'<span class="platform-skeleton-bar platform-skeleton-panel-line short"></span>'
  +'<span class="platform-skeleton-bar platform-skeleton-panel-block"></span>'
  +'</div></div>'+
  /* ⚠️ **「本页文字」那块去掉了**（用户 2026-10-28 09:38：「第四去掉本页文字」）
     —— 文字抽取的代码留着（以后要用不用重写），但**页面上不再摆它**。 */
  '</div>';
  const $=s=>surface.querySelector(s),viewport=$('.file-pdf-viewport'),status=$('[data-pdf-status]'),results=$('[data-pdf-results]');
  $('[data-pdf-open]').href=url;
  let disposed=false,doc=null,loading=null,renderTask=null,pageNo=1,renderId=0,searchId=0,searching=false;
  const active=()=>!disposed&&current();
  function textOf(content){
    const items=content.items.filter(i=>typeof i.str==='string');
    if(!items.every(i=>Array.isArray(i.transform)&&i.transform.length===6))return items.map(i=>i.str).join(' ').slice(0,200000);
    // PDF会按字体分批绘制；内容流的先后不等于一行的阅读顺序。
    const sorted=[...items].sort((a,b)=>b.transform[5]-a.transform[5]||a.transform[4]-b.transform[4]);
    const lines=[];
    for(const item of sorted){const y=item.transform[5],last=lines.at(-1);if(last&&Math.abs(y-last.y)<2)last.items.push(item);else lines.push({y,items:[item]});}
    return lines.map(line=>line.items.sort((a,b)=>a.transform[4]-b.transform[4]).map(i=>i.str).join('').replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g,'$1')).join('\n').slice(0,200000);
  }
  function controls(){
    const unavailable=!doc||!active();
    $('[data-pdf-prev]').disabled=unavailable||pageNo===1;
    $('[data-pdf-next]').disabled=unavailable||pageNo===doc.numPages;
    $('[data-pdf-page]').disabled=unavailable;$('[data-pdf-zoom]').disabled=unavailable;
    $('[data-pdf-query]').disabled=unavailable;$('.file-pdf-search button').disabled=unavailable||searching;
  }
  function dispose(){if(disposed)return;disposed=true;renderId++;searchId++;renderTask?.cancel();loading?.destroy()?.catch(()=>{});}
  async function render(){
    const sequence=++renderId;renderTask?.cancel();renderTask=null;
    if(!active()||!doc)return;
    const selected=pageNo;controls();$('[data-pdf-page]').value=selected;status.textContent='正在绘制第 '+selected+' 页…';
    try{
      const page=await doc.getPage(selected);if(!active()||sequence!==renderId)return;
      const base=page.getViewport({scale:1}),zoom=$('[data-pdf-zoom]').value;
      const scale=zoom==='fit'?Math.min(2,Math.max(.1,((viewport.clientWidth||600)-24)/base.width)):Number(zoom)/100;
      const view=page.getViewport({scale});
      // 不分配异常尺寸画布，也不同时渲染整份PDF。
      if(!Number.isFinite(view.width*view.height)||view.width<1||view.height<1||view.width>16384||view.height>16384||view.width*view.height>16000000)throw Error('页面尺寸超过阅读限制');
      const ratio=Math.min(win.devicePixelRatio||1,2,Math.sqrt(16000000/(view.width*view.height)));
      const canvas=document.createElement('canvas');canvas.setAttribute('aria-label',name+' · 第 '+selected+' 页');
      canvas.width=Math.ceil(view.width*ratio);canvas.height=Math.ceil(view.height*ratio);canvas.style.width=Math.ceil(view.width)+'px';canvas.style.height=Math.ceil(view.height)+'px';
      viewport.replaceChildren(canvas);
      renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport:view,transform:ratio!==1?[ratio,0,0,ratio,0,0]:null});
      await renderTask.promise;if(!active()||sequence!==renderId)return;renderTask=null;
      // 页码**已经在工具条上**（`[2] / 3`）⇒ 状态位**不再重复**那一行。
      // ⚠️ **契约变化（2026-10-28 凌晨 · PKG-132）**：这里原来会再写一遍「第 X / Y 页」，
      //    与工具条里的页码**重复**（用户 20:2x 原话：「无重复『第1/1页·只读原件』整行」）。
      //    ⇒ 现在**画完一页后状态位让位给正文**（`:empty` 不占高），
      //    **页码/总页数只在工具条上出现一次**。
      //    ⇒ 配套把旧判据 `shangshu-server/tests/website/file-pdf.test.ts` 那条
      //    「状态位要显示『第 2 / 3 页』」改成「工具条显示页码、状态位不重复」。
      status.textContent='';
      /* ⚠️ **本页文字那块已从界面上去掉**（2026-10-28 09:38）⇒ 连**抽取**也不做了
         （留着它只会白抽一遍没人看的文字）。 */
    }catch(error){if(active()&&sequence===renderId&&error.name!=='RenderingCancelledException'){status.textContent='此页无法显示，请降低缩放或下载原件核对。';viewport.textContent='PDF页面渲染失败';}}
  }
  $('[data-pdf-prev]').onclick=()=>{if(pageNo>1){pageNo--;render();}};
  $('[data-pdf-next]').onclick=()=>{if(doc&&pageNo<doc.numPages){pageNo++;render();}};
  $('[data-pdf-page]').onchange=()=>{const value=Number($('[data-pdf-page]').value);if(doc&&Number.isInteger(value)&&value>=1&&value<=doc.numPages){pageNo=value;render();}else $('[data-pdf-page]').value=pageNo;};
  $('[data-pdf-zoom]').onchange=()=>render();
  $('.file-pdf-search').onsubmit=async event=>{
    event.preventDefault();if(!doc||searching||!active())return;
    const query=$('[data-pdf-query]').value.replace(/\s+/g,'').toLocaleLowerCase(),sequence=++searchId;results.textContent='';if(!query)return;
    searching=true;controls();results.textContent='正在查找文字…';let hits=0,scanned=0;
    try{
      const fragment=document.createDocumentFragment(),limit=Math.min(doc.numPages,200);
      for(let n=1;n<=limit;n++){
        const page=await doc.getPage(n),content=await page.getTextContent();if(!active()||sequence!==searchId)return;
        const text=textOf(content).replace(/\s+/g,''),index=text.toLocaleLowerCase().indexOf(query);scanned=n;
        if(index>=0){const button=document.createElement('button');button.type='button';button.className='file-pdf-hit';button.dataset.pdfHit=String(n);button.textContent='第 '+n+' 页 · '+text.slice(Math.max(0,index-35),index+query.length+80);button.onclick=()=>{pageNo=n;render();};fragment.append(button);hits++;if(hits>=50)break;}
      }
      if(!active())return;results.replaceChildren(fragment);
      const summary=document.createElement('p');summary.textContent=(hits?'找到 '+hits+' 个匹配页面':'未找到可提取的匹配文字；扫描件不等于已做OCR')+(scanned<doc.numPages?'（仅检索前 '+scanned+' 页，超出范围请下载查找）':'');results.prepend(summary);
    }catch{if(active())results.textContent='文字查找失败；可继续翻页或下载原件。';}
    finally{searching=false;if(active())controls();}
  };
  (async()=>{
    try{
      const pdf=await loadLibrary();if(!active())return;
      const assets='/vendor/pdfjs-6.4.299/';pdf.GlobalWorkerOptions.workerSrc=assets+'pdf.worker.min.mjs';
      loading=pdf.getDocument({url,cMapUrl:assets+'cmaps/',cMapPacked:true,standardFontDataUrl:assets+'standard_fonts/',wasmUrl:assets+'wasm/',isEvalSupported:false,enableXfa:false,stopAtErrors:true,maxImageSize:16000000});
      loading.onPassword=()=>{if(active()){status.textContent='此PDF需要密码，请下载原件在本机打开。';viewport.replaceChildren();}loading.destroy()?.catch(()=>{});};
      doc=await loading.promise;if(!active())return;
      if(!Number.isInteger(doc.numPages)||doc.numPages<1)throw Error('没有有效页面');
      $('[data-pdf-count]').textContent='/ '+doc.numPages;$('[data-pdf-page]').max=doc.numPages;
      controls();await render();
    }catch{if(active()){status.textContent='无法打开PDF（可能损坏、加密或阅读器加载失败），请独立打开或下载原件。';viewport.replaceChildren();doc=null;controls();}}
  })();
  return dispose;
}
