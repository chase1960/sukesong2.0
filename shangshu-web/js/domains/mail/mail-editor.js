/* 邮件正文安全显示与富文本编辑（邮件局部模块）。
   复用示例企业 real-chat.js 的净化/CID/沙箱预览经验（emailSafeFragment / emailPreviewSrcdoc /
   emailInlinePreviewMap / mountRichEditor），但只取通用部分，不搬 IP 案件、模板或通知书业务模型。
   不复制一套长期通用编辑器：这里只服务邮件正文这一个落点。
   责任：HTML 进 DOM 前净化、受管 CID 解析、沙箱预览、contenteditable 编辑并保留表格与合并格。 */
(function (global) {
  'use strict';

  /* 只认受管 CID 图片；任意外部图片一律不解析、不请求。 */
  const CID_RE = /^cid:[A-Za-z0-9._@+-]{1,200}$/i;
  const SAFE_MIME = ['image/png', 'image/jpeg', 'image/gif'];

  /* Excel/WPS 复制出来的表头色不在单元格上，而是 <style> 里定义 class、表格靠 class 引用。
     <style> 不能进沙箱预览（会被删），所以先把匹配的规则内联到元素 style 上，再删 <style>。
     只处理简单选择器（tag / .class / #id / tag.class），已有内联样式优先不覆盖；
     含 expression/javascript:/url(/@import 的值一律丢弃。 */
  function inlineStyleBlocks(root) {
    const blocks = [...root.querySelectorAll('style')].map(node => node.textContent || '');
    if (!blocks.length) return;
    const rules = [];
    for (const block of blocks) {
      const re = /([^{}]+)\{([^{}]*)\}/g;
      let m;
      while ((m = re.exec(block))) {
        const selector = m[1].trim();
        if (!/^[.#]?[a-zA-Z][\w-]*(\.[\w-]+)*$/.test(selector)) continue;
        const decls = m[2].split(';')
          .map(d => d.trim())
          .filter(d => d && !/(?:expression|javascript:|url\s*\(|@import|behavior\s*:)/i.test(d));
        if (decls.length) rules.push({selector, decls});
      }
    }
    if (!rules.length) return;
    for (const {selector, decls} of rules) {
      const targets = selector.startsWith('.')
        ? root.querySelectorAll(selector)
        : selector.startsWith('#')
          ? root.querySelectorAll(selector)
          : root.querySelectorAll(selector);
      for (const el of targets) {
        const existing = el.getAttribute('style') || '';
        const present = new Set(existing.split(';').map(s => s.split(':')[0]?.trim().toLowerCase()).filter(Boolean));
        const add = decls.filter(d => !present.has(d.split(':')[0]?.trim().toLowerCase()));
        if (add.length) el.setAttribute('style', (existing ? existing.replace(/;\s*$/, '') + ';' : '') + add.join(';'));
      }
    }
  }

  /* 补表格框线 —— 无条件。
     用户原话：「我复制的excel就是没有框线的,但是我希望每一个邮件粘贴的表格是要有框线的(无论怎么样)」。
     所以规则不是「把 border:none 还原掉」，而是**先铺一格可见实线**，
     源里写了正常框线再覆盖上去；`border:none` / `border:0` 这类取消声明直接摘掉。
     合并格、表头底色等一概不碰。 */
  const INVISIBLE_BORDER = /^(?:none|0|0px|0em|0rem|0pt)(?:\s|$)/i;
  const FORCED_BORDER = 'border:1px solid #d0d5dd';
  function ensureTableBorders(root) {
    for (const table of root.querySelectorAll('table')) {
      const tableStyle = table.getAttribute('style') || '';
      if (!/border-collapse/i.test(tableStyle)) {
        table.setAttribute('style', (tableStyle ? tableStyle.replace(/;\s*$/, '') + ';' : '') + 'border-collapse:collapse');
      }
      for (const cell of table.querySelectorAll('td,th')) {
        const decls = (cell.getAttribute('style') || '').split(';').map(s => s.trim()).filter(Boolean);
        // 只摘掉「取消框线」的声明；其余（含 border-color 这类半截声明）原样留着往后覆盖。
        const kept = decls.filter(d => {
          const cut = d.indexOf(':');
          if (cut < 0) return true;
          const prop = d.slice(0, cut).trim().toLowerCase();
          if (!/^border(?:-|$)/.test(prop)) return true;
          return !INVISIBLE_BORDER.test(d.slice(cut + 1).trim());
        });
        const hasPadding = kept.some(d => /^padding/i.test(d.slice(0, d.indexOf(':')).trim()));
        if (!hasPadding) kept.push('padding:6px');
        /* 强制框线放最前，后面的声明可覆盖它（例如源写了 border-color 就只剩颜色被覆盖）。
           ★ BASE967-24（2026-10-17）：**必须幂等** —— req 4 原话「归一化 HTML 幂等，
           消除重复 border 样式膨胀…不可单纯调大长度掩盖重复膨胀」。
           原来这里**无条件前置** FORCED_BORDER：同一格存第 2 次就 2 份、第 5 次 5 份
           （1000 格 × 5 次保存 = 136000 字符；反馈里报的「累计 25000」就是这个）。
           改成：**已经有一模一样的 FORCED_BORDER 就不再前置** ——
           保存 N 次，声明数始终 1 份、style 字符串不再增长；`#d0d5dd` 仍在前、
           源里的 `#ccc` 仍在后（J5 契约不变）。
           判据：`scripts/page-timing/base967-24-border.mjs`（Node 24 零依赖）。 */
        const _normDecl = (d) => d.replace(/\s+/g, '').toLowerCase();
        const _hasForced = kept.some(d => _normDecl(d) === _normDecl(FORCED_BORDER));
        cell.setAttribute('style', (_hasForced ? kept : [FORCED_BORDER, ...kept]).join(';'));
      }
    }
  }

  /* 受管地址：文件库的下载口（链接重接后正文里的引用就是它）。
     形如 `/api/platform/file-content?ref=…&ref_name=…&file=…`，带 can_read_reference
     权限判定 —— 授权范围内的人点得开，撤权后失效。**这是受管资源，不是外链。**
     用户口径：「外链转成受管内链即可放行」—— 放行的就是它，不放宽任意外部请求。 */
  const MANAGED_URL_RE = /^\/api\/platform\/file-content\?/i;

  function isManagedUrl(value) {
    return MANAGED_URL_RE.test(String(value || '').trim());
  }

  /* 从受管地址里取出附件 File id —— 同一份字节可能有两种地址
     （正文里是文件库那条，取字节时可能用邮件归属那条），按 file= 对上即可。 */
  function managedFileId(value) {
    try {
      return new URL(String(value || ''), 'http://localhost/').searchParams.get('file') || '';
    } catch (_) {
      return '';
    }
  }

  /* 剪贴板片段边界（FIX-08 / A20）。
     Excel / Word / 浏览器原生复制会把**整张表**放进 text/html，
     用 HTML 注释 <!--StartFragment--> / <!--EndFragment--> 标出「真正被复制的那一段」。
     这两个是**注释节点**：不处理的话，最后那步序列化写的是
     `node.outerHTML || node.textContent` —— 注释没有 outerHTML，
     按 DOM 规范 textContent 返回注释数据，于是 "StartFragment"/"EndFragment"
     被当成**普通文字**写进正文（用户原话「会出现：StartFragment和end」）。
     服务端 sanitize_html 走 HTMLParser，注释本来就被丢掉；
     污染是在浏览器里就已经变成文字并被存库的。

     这里做两件事：
       ① 有成对的边界标记时，**只取边界之间那段**（真被复制的内容）——
          用 Range.cloneContents，标记在不同层级也对；
       ② 无论有没有边界，**所有注释节点都不进正文**。注释本来就不可见，
          把它当文字写出来本身就是 bug。正文里字面写着「StartFragment」
          的是文本节点，不受影响（不做全局字符串替换）。
     只动注释节点与边界，不碰净化门原有的黑名单与属性规则。 */
  const FRAGMENT_MARK_RE = /^\s*(start|end)fragment\s*$/i;
  const SHOW_COMMENT = 128;   // NodeFilter.SHOW_COMMENT —— 写死数值，少一个全局依赖

  function findFragmentMarks(root) {
    let start = null, end = null;
    const walker = document.createTreeWalker(root, SHOW_COMMENT);
    let node = walker.nextNode();
    while (node) {
      const matched = FRAGMENT_MARK_RE.exec(node.data || '');
      if (matched) {
        if (matched[1].toLowerCase() === 'start' && !start) start = node;
        else if (matched[1].toLowerCase() === 'end' && !end) end = node;
      }
      node = walker.nextNode();
    }
    return {start, end};
  }

  /* 只取边界之间的内容；标记不成对、顺序颠倒或取不到时，原样返回全量。 */
  function extractClipboardFragment(content) {
    const {start, end} = findFragmentMarks(content);
    if (!start || !end || start === end) return content;
    // 顺序必须是 start 在前；否则不裁剪（宁可多留也不要把正文截断）。
    const position = start.compareDocumentPosition(end);
    if (!(position & Node.DOCUMENT_POSITION_FOLLOWING)) return content;
    try {
      const range = document.createRange();
      range.setStartAfter(start);
      range.setEndBefore(end);
      const extracted = range.cloneContents();
      return extracted ? extracted : content;
    } catch (_) {
      return content;   // 跨文档等异常 → 退回全量，不做半截处理
    }
  }

  /* 注释节点一律不进正文：它们在渲染里不可见，写成文字是 bug。 */
  function removeCommentNodes(root) {
    const walker = document.createTreeWalker(root, SHOW_COMMENT);
    const comments = [];
    let node = walker.nextNode();
    while (node) { comments.push(node); node = walker.nextNode(); }
    for (const comment of comments) {
      if (comment.parentNode) comment.parentNode.removeChild(comment);
    }
  }

  /* 进 DOM 前净化：删脚本/事件/外链，保留表格结构与 colspan/rowspan 合并信息。
     合并单元格是正文结构，不能当危险属性剥掉（示例企业旧整表替换逻辑会剥合并，不照搬）。 */
  function safeFragment(value) {
    const template = document.createElement('template');
    template.innerHTML = String(value || '');
    // 剪贴板片段边界先裁：只留真正被复制的那一段（FIX-08）。
    let content = extractClipboardFragment(template.content);
    // 注释节点随后统一清掉：既不让片段标记泄成文字，也不让任何注释进正文。
    removeCommentNodes(content);
    // 顺序要紧：先把 <style> 里的规则内联到元素上，再删 <style>，否则颜色跟着没了。
    inlineStyleBlocks(content);
    /* <form> 只去掉标签、**留住里面的字** —— 表单里的说明文字（退订句、提示语）
       是正文。原来连子树一起 remove()，那句话无提示消失。
       其余危险标签才连内容一起删。 */
    content.querySelectorAll('form').forEach(node => node.replaceWith(...node.childNodes));
    content.querySelectorAll('script,style,iframe,object,embed,video,audio,source,track,base,link,meta')
      .forEach(node => node.remove());
    content.querySelectorAll('*').forEach(node => {
      [...node.attributes].forEach(attribute => {
        const name = String(attribute.name || '').toLowerCase();
        const attributeValue = String(attribute.value || '').trim();
        if (name.startsWith('on') || name === 'srcset' || name === 'contenteditable') {
          node.removeAttribute(attribute.name);
        } else if (name === 'src') {
          // 受管地址**留住** —— 链接重接之后正文里的图引的就是它。
          // 原来只认 src="cid:"，受管地址会被当外链剥掉并标 blocked，
          // 后端接对了、页面上照样是破图（实测撞过）。
          const keep = node.tagName?.toLowerCase() === 'img'
            && (CID_RE.test(attributeValue) || isManagedUrl(attributeValue));
          if (!keep) {
            node.removeAttribute(attribute.name);
            node.setAttribute('data-blocked-src', 'external-resource');
          }
        } else if (name === 'href' && attributeValue && !/^(?:https?:|mailto:|#)/i.test(attributeValue)
                   && !isManagedUrl(attributeValue)) {
          node.removeAttribute(attribute.name);
        } else if (name === 'style' && /(?:expression|javascript:|url\s*\(|@import)/i.test(attributeValue)) {
          node.removeAttribute(attribute.name);
        }
        // colspan/rowspan/align/valign/width/border 等结构与排版属性保留，不在此删除。
      });
    });
    // 最后补框线：上面可能把 <style> 里的框线内联进来，也可能源里就是 border:none，
    // 统一在序列化前收口，粘贴和阅读两条路走同一个门。
    ensureTableBorders(content);
    return [...content.childNodes].map(node => node.outerHTML || node.textContent || '').join('').trim();
  }

  /* 受管内联资源 → data URL 预览映射。
     只从已授权的受管资源取字节，绝不因显示图片放开任意外部请求。

     字节出口是 `/api/platform/file-content?ref=<doctype>&ref_name=<记录名>&file=<文件>` ——
     必须带**记录归属**，内核据此判权；缺归属就回 403「无权读取该记录的附件」。
     （旧的 `/api/platform/files/content` 在平台模式下是 410 LEGACY_SURFACE_DISABLED，
       真实产品页实测过：打它映射表永远空，图就停在 cid: 上显示不出来。） */
  async function inlinePreviewMap(resources, owner) {
    const result = {};
    for (const resource of (Array.isArray(resources) ? resources : [])) {
      const contentId = String(resource?.content_id || '').trim();
      const mime = String(resource?.mime_type || '').toLowerCase();
      if (!contentId || !SAFE_MIME.includes(mime)) continue;
      /* 资源自带字节（样例信、测试夹具）直接用，不必再走文件接口。
         只认 data:image/ 前缀，别让任意字符串冒充图片源。 */
      const inline = String(resource?.data || '');
      if (/^data:image\//i.test(inline)) {
        result[contentId] = inline;
        result[contentId.toLowerCase()] = inline;
        continue;
      }
      /* 默认签名在首封草稿创建前没有 Mail Message 归属。
         上传服务返回的固定版本 source 是其正式文件中心引用；只在缺邮件归属时用它，
         并要求 source.file 与当前图片一致。读取仍走同一个逐次判权的字节接口。 */
      const source=resource.source;
      const resourceOwner=owner?.ref&&owner?.ref_name?owner
        :source?.file===resource.file?{ref:source.ref_doctype,ref_name:source.ref_name}:null;
      const ref=String(resourceOwner?.ref||'').trim(),refName=String(resourceOwner?.ref_name||'').trim();
      /* 没有归属就取不了字节 —— 宁可让图停在占位，也不放宽成无鉴权读取。 */
      if (!ref || !refName || !resource.file) continue;
      try {
        const query = new URLSearchParams({ref, ref_name: refName, file: String(resource.file || '')});
        const response = await fetch(`/api/platform/file-content?${query}`, {
          credentials: 'same-origin', cache: 'no-store',
        });
        if (!response.ok) continue;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 5 * 1024 * 1024) continue;
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        result[contentId] = `data:${mime};base64,${btoa(binary)}`;
        result[contentId.toLowerCase()] = result[contentId];
        /* 再按附件 File id 记一笔 —— 链接重接之后，正文里的引的是
           **受管地址**（`…&file=<File id>`），不是 cid:。
           预览按 file= 参数对上这一笔，才能把字节换回去。 */
        if (resource.file) result[String(resource.file)] = result[contentId];
      } catch (_) { /* 受权资源暂不可读时保留 CID 占位，不放宽外链。 */ }
    }
    return result;
  }

  /* 沙箱预览文档：CSP 禁网禁脚本，只允许 cid:/data: 图片。
     源码只进无权限 iframe，不注入父工作面。 */
  function previewSrcdoc(value, previewMap) {
    const allowed = new Set(Object.values(previewMap || {}));
    const template = document.createElement('template');
    template.innerHTML = String(value || '');
    const content = template.content;
    /* <form> 只去掉标签、**留住里面的字** —— 表单里的说明文字（退订句、提示语）
       是正文。原来连子树一起 remove()，那句话无提示消失。
       其余危险标签才连内容一起删。 */
    content.querySelectorAll('form').forEach(node => node.replaceWith(...node.childNodes));
    content.querySelectorAll('script,style,iframe,object,embed,video,audio,source,track,base,link,meta')
      .forEach(node => node.remove());
    content.querySelectorAll('*').forEach(node => {
      [...node.attributes].forEach(attribute => {
        const name = String(attribute.name || '').toLowerCase();
        let attributeValue = String(attribute.value || '').trim();
        if (name.startsWith('on') || name === 'srcset') {
          node.removeAttribute(attribute.name);
        } else if (name === 'src') {
          if (node.tagName?.toLowerCase() === 'img' && CID_RE.test(attributeValue)) {
            const contentId = attributeValue.slice(4);
            const resolved = previewMap[contentId] || previewMap[contentId.toLowerCase()];
            if (resolved) { node.setAttribute('src', resolved); attributeValue = resolved; }
          } else if (node.tagName?.toLowerCase() === 'img' && isManagedUrl(attributeValue)) {
            /* 链接重接之后正文里是受管地址 —— 按 file= 参数对回已授权字节。
               沙箱 iframe 带不了会话 Cookie，直接引受管地址会 401/403 变破图，
               所以仍走「父页取字节 → 注 data URI」这一条，只是从 cid: 换成受管地址。 */
            const resolved = previewMap[managedFileId(attributeValue)] || previewMap[attributeValue];
            if (resolved) { node.setAttribute('src', resolved); attributeValue = resolved; }
          }
          if (!CID_RE.test(attributeValue) && !allowed.has(attributeValue)) {
            node.removeAttribute(attribute.name);
            node.setAttribute('data-blocked-src', 'external-resource');
          }
        } else if (name === 'href' && attributeValue && !/^(?:https?:|mailto:|#)/i.test(attributeValue)
                   && !isManagedUrl(attributeValue)) {
          node.removeAttribute(attribute.name);
        } else if (name === 'style' && /(?:expression|javascript:|url\s*\(|@import)/i.test(attributeValue)) {
          node.removeAttribute(attribute.name);
        }
      });
    });
    const body = [...content.childNodes].map(node => node.outerHTML || node.textContent || '').join('');
    /* ★ BASE967-24（req 4）：「**宽表用可横向浏览方案，不强行压成不可读**」。
       原来 `table{max-width:100%}` 把宽表**硬压**到 iframe 宽度 —— UI-042 实测：
       「inline width1600px 但 computed max-width100%、呈现宽 655px 且
       body scrollWidth=clientWidth 655，**无法按原宽横向查看**」。
       改成：表格**保持自然宽度**（`width:max-content` + `max-width:none`），
       `body` **横向可滚**（`overflow-x:auto`）—— 宽表按原宽横向看，窄表照旧铺满。
       ⚠️ 长单词仍用 `overflow-wrap:anywhere` 防溢出，但**不压表格**。 */
    const style = 'body{font:14px/1.7 system-ui;margin:12px;overflow-wrap:anywhere;overflow-x:auto}'
      + 'table{border-collapse:collapse;margin:8px 0;max-width:none;width:max-content}'
      + 'td,th{border:1px solid #d0d5dd;padding:4px 8px;font-size:13px}'
      + 'img{max-width:100%}';
    const csp = "default-src 'none'; img-src cid: data:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${style}</style></head><body>${body}</body></html>`;
  }

  /* 编辑时把 cid: 图换成本地 data URL 预览，保留 data-managed-cid 以便存回 cid:。
     保存时 normalizeMarkup 把 data-managed-cid 还原成 src="cid:..."。 */
  async function hydrateEditorImages(editor, resources, owner) {
    const map = await inlinePreviewMap(resources, owner);
    if (!editor?.isConnected) return;
    const missing = [];
    editor.querySelectorAll('img[src^="cid:"]').forEach(image => {
      const cid = String(image.getAttribute('src') || '').slice(4);
      const resolved = map[cid] || map[cid.toLowerCase()];
      /* 取不到字节**不许一声不吭** —— 用户 2026-10-12（C2）：
         「缺失/无权时明确提示，不能静默丢图后发送」。 */
      if (!resolved) { missing.push(cid); return; }
      image.setAttribute('data-managed-cid', `cid:${cid}`);
      image.setAttribute('src', resolved);
    });
    return missing;
  }

  /* 保存前归一：把编辑期的 data-managed-cid 还原成正文里的 cid: 引用，
     再走一次净化，确保写回的仍是安全 HTML。 */
  function normalizeMarkup(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    template.content.querySelectorAll('img[data-managed-cid]').forEach(image => {
      image.setAttribute('src', image.getAttribute('data-managed-cid'));
      image.removeAttribute('data-managed-cid');
    });
    return safeFragment(template.innerHTML);
  }

  /* 纯文本粘贴的二维还原：Excel/WPS 复制的多格内容在 text/plain 里用制表符分列、换行分行。
     有列分隔就还原成 table/tr/td；没有就当普通段落。单元格内容转义，不带入可执行标记。 */
  /* TSV 解析：支持引号包字段、格内换行、双引号转义（""）。
     Excel 的 text/plain 侧就是这种。值一律按**字符串**处理 —— 前导零（007）、
     长编号（202630123456.7）不许被转成数字。 */
  function parseDelimited(text) {
    const s = String(text ?? '');
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === '\t') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
    row.push(field); rows.push(row);
    while (rows.length > 1 && rows[rows.length - 1].every(v => String(v).trim() === '')) rows.pop();
    return rows;
  }

  function plainPasteFragment(text) {
    const raw = String(text ?? '');
    const rows = parseDelimited(raw);
    const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
    // 只有一列就是纯文本（格内换行保留成 <br>），多列才还原成表
    if (columns < 2) {
      return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
    }
    const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cellStyle = 'border:1px solid #d0d5dd;padding:6px';
    const body = rows.map(r => '<tr>' + Array.from({length: columns}, (_, i) =>
      `<td style="${cellStyle}">${esc(r[i] ?? '').replace(/\n/g, '<br>') || '&nbsp;'}</td>`).join('') + '</tr>').join('');
    return `<table style="width:100%;border-collapse:collapse">${body}</table>`;
  }

  /* 把 HTML 片段降成纯文本（「只贴值」用）：表格拆成「单元格 × 制表符 / 行 × 换行」。 */
  function plainTextOf(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    const root = template.content;
    const out = [];
    const walk = node => {
      if (node.nodeType === 3) { out.push(node.nodeValue || ''); return; }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag === 'TABLE') {
        const rows = [...node.querySelectorAll('tr')];
        /* 单元格里的 <br> 是**换行**，不是空白：textContent 会把两行粘成一行
           （BASE967-13 / UI-052「只贴值把中文第一行<br>中文第二行连成一行」）。 */
        const cellText = cell => {
          const clone = cell.cloneNode(true);
          clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
          return (clone.textContent || '').replace(/[ \t]+\n/g, '\n').trim();
        };
        rows.forEach((tr, ri) => {
          const cells = [...tr.children].filter(c => /^(TD|TH)$/.test(c.tagName));
          out.push(cells.map(cellText).join('\t'));
          if (ri < rows.length - 1) out.push('\n');
        });
        return;
      }
      for (const child of node.childNodes) walk(child);
      if (/^(P|DIV|BR|LI|TR)$/.test(tag)) out.push('\n');
    };
    for (const child of root.childNodes) walk(child);
    return out.join('').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* 光标所在那一层的最外层表格。 */
  function outerTableOf(editor, node) {
    let n = node, found = null;
    while (n && n !== editor) {
      if (n.nodeType === 1 && n.tagName === 'TABLE') found = n;
      n = n.parentNode;
    }
    return found;
  }

  /* 在光标处插入 HTML 片段；没有光标就追加到末尾。
     只插入，不整表替换已有内容——旧的整表替换会剥掉 colspan/rowspan，不照搬。

     不许表套表（用户 2026-10-11 实测：「我复制进去就变成表格套表格了」）：
     光标在表格里、而粘的内容本身带表时，新表必须落到**最外层那张表的外面**，
     和原表平级；不能塞进某个单元格里长出第二层表。 */
  function insertHtmlAtCaret(editor, html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const fragment = template.content;
    /* 先把节点记下来再插入 —— 作用域选项要能「退回粘贴前」，靠这份引用把它们摘掉。 */
    const inserted = [...fragment.childNodes];
    const hasTable = Boolean(fragment.querySelector('table'));
    const selection = editor.ownerDocument.defaultView?.getSelection?.();
    let range = null;
    if (selection && selection.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      range = selection.getRangeAt(0);
    }

    if (range && hasTable) {
      const host = outerTableOf(editor, range.commonAncestorContainer);
      if (host) {
        // 新表落到这张表后面 —— 平级，不嵌套
        const last = fragment.lastChild;
        host.parentNode.insertBefore(fragment, host.nextSibling);
        if (last && selection) {
          const after = editor.ownerDocument.createRange();
          after.setStartAfter(last);
          after.collapse(true);
          selection.removeAllRanges();
          selection.addRange(after);
        }
        return inserted;
      }
    }

    if (range) {
      range.deleteContents();
      const last = fragment.lastChild;
      range.insertNode(fragment);
      if (last) {
        range.setStartAfter(last);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } else {
      editor.appendChild(fragment);
    }
    return inserted;
  }

  /* 光标**所在**的那一张表。严格：光标不在表里就是 null ——
     不用 editor.querySelector('table') 兜底，否则「没有明确目标」永远有目标，
     「没有明确目标不能替换」这条就验不了。 */
  function caretTable(editor) {
    const sel = editor.ownerDocument.defaultView?.getSelection?.();
    if (!sel || !sel.rangeCount) return null;
    let node = sel.getRangeAt(0).commonAncestorContainer;
    while (node && node !== editor) {
      if (node.nodeType === 1 && node.tagName === 'TABLE') return node;
      node = node.parentNode;
    }
    return null;
  }

  /* 粘贴作用域选项条（N2-C3）：
     「可见选择"插入新表/替换选中整表/纯文本"；默认不暗中覆盖已有整表；没有明确目标不能替换」。
     默认＝插入新表（不碰任何旧表）；Esc 或「取消」退回粘贴前。 */
  let liveScope = null;
  function showPasteScope(wrap, handlers) {
    if (liveScope) liveScope.remove();
    const doc = wrap.ownerDocument;
    const box = doc.createElement('div');
    box.className = 'paste-scope';
    box.setAttribute('data-paste-scope', '');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', '粘贴方式');
    box.innerHTML =
      '<span class="paste-scope-note">粘贴方式：</span>' +
      '<button type="button" data-paste-scope-insert>插入新表</button>' +
      '<button type="button" data-paste-scope-replace>替换选中整表</button>' +
      '<button type="button" data-paste-scope-plain>只贴值</button>' +
      '<button type="button" data-paste-scope-cancel>取消</button>';
    const style = doc.querySelector('#paste-scope-style') || (() => {
      const st = doc.createElement('style');
      st.id = 'paste-scope-style';
      st.textContent = [
        '.paste-scope{display:inline-flex;align-items:center;gap:6px;margin:6px 0;padding:4px 8px;',
        'border:1px solid var(--line2,#d0d5dd);border-radius:8px;background:var(--control-bg,#fff);',
        'font-size:12px;flex-wrap:wrap}',
        '.paste-scope-note{color:var(--fg3,#8a9099)}',
        '.paste-scope button{height:24px;padding:0 8px;border:1px solid var(--line2,#d0d5dd);',
        'border-radius:6px;background:transparent;color:var(--fg,#1e232c);font-size:12px;cursor:pointer}',
        '.paste-scope button:hover{border-color:var(--accent,#16a34a);color:var(--accent,#16a34a)}',
      ].join('\n');
      (doc.head || doc.documentElement).appendChild(st);
      return st;
    })();
    void style;
    wrap.appendChild(box);
    liveScope = box;
    const close = () => { box.remove(); if (liveScope === box) liveScope = null; };
    box.querySelector('[data-paste-scope-insert]').onclick = () => { handlers.onInsert?.(); close(); };
    box.querySelector('[data-paste-scope-replace]').onclick = () => { handlers.onReplace?.(); close(); };
    box.querySelector('[data-paste-scope-plain]').onclick = () => { handlers.onPlain?.(); close(); };
    box.querySelector('[data-paste-scope-cancel]').onclick = () => { handlers.onCancel?.(); close(); };
    box.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); handlers.onCancel?.(); close(); }
    });
    return box;
  }

  /* ---- MAIL-03 表格编辑能力 ----
     正文表不套 Excel 的唯一表头/行ID限制：允许两表同结构、多行表头、空表头。 */
  function currentTable(editor) {
    const sel = editor.ownerDocument.defaultView?.getSelection?.();
    if (sel && sel.rangeCount) {
      let node = sel.getRangeAt(0).commonAncestorContainer;
      while (node && node !== editor) {
        if (node.nodeType === 1 && node.tagName === 'TABLE') return node;
        node = node.parentNode;
      }
    }
    return editor.querySelector('table');
  }

  function currentCell(editor) {
    const sel = editor.ownerDocument.defaultView?.getSelection?.();
    if (sel && sel.rangeCount) {
      let node = sel.getRangeAt(0).commonAncestorContainer;
      while (node && node !== editor) {
        if (node.nodeType === 1 && /^(TD|TH)$/.test(node.tagName)) return node;
        node = node.parentNode;
      }
    }
    return editor.querySelector('td,th');
  }

  function insertTable(editor, rows, cols) {
    const r = Math.max(1, Math.min(50, Number(rows) || 2));
    const c = Math.max(1, Math.min(20, Number(cols) || 2));
    const cell = '<td style="border:1px solid #d0d5dd;padding:6px;min-width:56px">&nbsp;</td>';
    const html = `<table style="width:100%;border-collapse:collapse"><tbody>${
      Array.from({length: r}, () => `<tr>${cell.repeat(c)}</tr>`).join('')}</tbody></table>`;
    insertHtmlAtCaret(editor, html);
  }

  function insertRow(editor, after = true) {
    const table = currentTable(editor);
    if (!table) return false;
    const cell = currentCell(editor);
    const row = cell ? cell.closest('tr') : table.querySelector('tr');
    const cols = row ? row.cells.length : 1;
    const template = '<td style="border:1px solid #d0d5dd;padding:6px;min-width:56px">&nbsp;</td>';
    const tr = table.ownerDocument.createElement('tr');
    tr.innerHTML = template.repeat(Math.max(1, cols));
    if (row && after) row.insertAdjacentElement('afterend', tr);
    else if (row) row.insertAdjacentElement('beforebegin', tr);
    else table.querySelector('tbody')?.appendChild(tr) || table.appendChild(tr);
    return true;
  }

  function deleteRow(editor) {
    const cell = currentCell(editor);
    const row = cell?.closest('tr');
    if (!row) return false;
    const table = row.closest('table');
    if (!table) return false;
    /* 删行要修好跨行格：跨住本行的上层格只减 rowspan；
       锚在本行且自身跨多行的，要把整块下移到下一行，否则表会缺一列。 */
    const {info} = visualGrid(table);
    const rows = [...table.querySelectorAll('tr')];
    const index = rows.indexOf(row);
    for (const [c2, meta] of info) {
      const covers = meta.row <= index && index < meta.row + meta.rs;
      if (!covers) continue;
      if (meta.row < index) {
        const next = meta.rs - 1;
        if (next <= 1) c2.removeAttribute('rowspan');
        else c2.setAttribute('rowspan', String(next));
      } else if (meta.rs > 1) {
        // 锚在本行：整块下移到下一行的同一视觉列
        const below = rows[index + 1];
        if (below) {
          let anchor = null;
          for (const node of below.children) {
            if (!/^(TD|TH)$/.test(node.tagName)) continue;
            const m = info.get(node);
            if (m && m.col >= meta.col) { anchor = node; break; }
          }
          if (anchor) below.insertBefore(c2, anchor); else below.appendChild(c2);
          const next = meta.rs - 1;
          if (next <= 1) c2.removeAttribute('rowspan');
          else c2.setAttribute('rowspan', String(next));
        }
      }
    }
    row.remove();
    if (!table.querySelector('tr')) table.remove();
    return true;
  }

  function insertColumn(editor, after = true) {
    const table = currentTable(editor);
    const cell = currentCell(editor);
    if (!table) return false;
    const {info} = visualGrid(table);
    const meta = cell ? info.get(cell) : null;
    const col = meta ? meta.col : 0;
    insertVisualColumn(table, after ? col + 1 : col);
    return true;
  }

  function deleteColumn(editor) {
    const table = currentTable(editor);
    const cell = currentCell(editor);
    if (!table || !cell) return false;
    const {info} = visualGrid(table);
    const meta = info.get(cell);
    if (!meta) return false;
    deleteVisualColumn(table, meta.col);
    if (!table.querySelector('td,th')) table.remove();
    return true;
  }

  /* ---- 视觉网格（N2-C2）----
     合并格存在时，`row.cells` 的 DOM 下标**不是**视觉列 —— 计划原文：
     「不把DOM第几个cells当视觉列」。先把 colspan/rowspan 展开成 r×c 占位，再按视觉坐标操作。 */
  function visualGrid(table) {
    const grid = [];
    const info = new Map();
    const rows = [...table.querySelectorAll('tr')];
    rows.forEach((tr, r) => {
      grid[r] = grid[r] || [];
      let c = 0;
      for (const cell of tr.children) {
        if (!/^(TD|TH)$/.test(cell.tagName)) continue;
        while (grid[r][c] !== undefined) c++;
        const cs = Number(cell.getAttribute('colspan')) || 1;
        const rs = Number(cell.getAttribute('rowspan')) || 1;
        for (let dr = 0; dr < rs; dr++) {
          for (let dc = 0; dc < cs; dc++) {
            const rr = r + dr;
            grid[rr] = grid[rr] || [];
            grid[rr][c + dc] = cell;   // 存归属格，不存哨兵 —— 后面要问「这格是谁跨的」
          }
        }
        info.set(cell, {row: r, col: c, cs, rs});
        c += cs;
      }
    });
    return {grid, info};
  }

  function newCell(doc, style) {
    const td = doc.createElement('td');
    td.setAttribute('style', style || 'border:1px solid #d0d5dd;padding:6px;min-width:56px');
    td.innerHTML = '&nbsp;';
    return td;
  }

  /** 删「第 K 视觉列」：跨过这一列的格子只减 colspan，不整格消失。 */
  function deleteVisualColumn(table, K) {
    const {info} = visualGrid(table);
    for (const [cell, meta] of info) {
      if (K < meta.col || K >= meta.col + meta.cs) continue;
      if (meta.cs <= 1) {
        cell.remove();
      } else {
        const next = meta.cs - 1;
        if (next <= 1) cell.removeAttribute('colspan');
        else cell.setAttribute('colspan', String(next));
      }
    }
  }

  /** 在「第 atCol 视觉列」这个位置插一列（新列成为 atCol）。 */
  function insertVisualColumn(table, atCol) {
    const {info} = visualGrid(table);
    // 1) 横向跨住插入点的格子：colspan+1（这一行就不再补格）
    const covered = new Set();
    for (const [cell, meta] of info) {
      if (meta.col < atCol && atCol < meta.col + meta.cs) {
        cell.setAttribute('colspan', String(meta.cs + 1));
        covered.add(cell.closest('tr'));
      }
    }
    // 2) 其余每个视觉行补一个空格，插在「本行第一个 col>=atCol 的起始格」之前
    for (const tr of table.querySelectorAll('tr')) {
      if (covered.has(tr)) continue;
      let anchor = null;
      for (const node of tr.children) {
        if (!/^(TD|TH)$/.test(node.tagName)) continue;
        const meta = info.get(node);
        if (meta && meta.col >= atCol) { anchor = node; break; }
      }
      const td = newCell(tr.ownerDocument);
      if (anchor) tr.insertBefore(td, anchor); else tr.appendChild(td);
    }
  }

  /* 合并：按**真实矩形选区**。选区触及的格子必须刚好填满一个矩形，
     多一格少一格、或矩形里有被外部跨住的空洞，都算非法 —— 拒绝且原表一字不变。 */
  function cellsTouchedBySelection(editor) {
    const sel = editor.ownerDocument.defaultView?.getSelection?.();
    if (!sel || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    const table = currentTable(editor);
    if (!table) return [];
    const {info} = visualGrid(table);
    const out = [];
    for (const [cell] of info) {
      let hit = false;
      try { hit = range.intersectsNode(cell); } catch (_) { hit = false; }
      if (hit) out.push(cell);
    }
    return out;
  }

  /* 两角格的包围盒扩成**实心矩形**的格子集合；矩形里有被外部格跨住的洞就返回 null。
     DOM Range 表达不了「非连续的格子集合」（从 a 拖到 e 会把中间的 c 也圈进来），
     所以矩形要靠角格算出来，而不是靠 range 的节点列表。 */
  function rectCellsOf(table, a, b) {
    const {grid, info} = visualGrid(table);
    const ma = info.get(a), mb = info.get(b);
    if (!ma || !mb) return null;
    const r1 = Math.min(ma.row, mb.row), r2 = Math.max(ma.row + ma.rs - 1, mb.row + mb.rs - 1);
    const c1 = Math.min(ma.col, mb.col), c2 = Math.max(ma.col + ma.cs - 1, mb.col + mb.cs - 1);
    const out = [];
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const slot = (grid[r] || [])[c];
        if (!slot) return null;
        const m = info.get(slot);
        // 归属格的起点在矩形外 → 是外部格伸进来占住的，这不是实心矩形选区
        if (!m || m.row < r1 || m.row > r2 || m.col < c1 || m.col > c2) return null;
        if (!out.includes(slot)) out.push(slot);
      }
    }
    return out.length >= 2 ? out : null;
  }

  function mergeCellNodes(table, cells) {
    if (!table || !Array.isArray(cells) || cells.length < 2) return false;
    const {grid, info} = visualGrid(table);
    const metas = cells.map(c => info.get(c)).filter(Boolean);
    if (metas.length < 2 || metas.length !== cells.length) return false;
    const r1 = Math.min(...metas.map(m => m.row));
    const c1 = Math.min(...metas.map(m => m.col));
    const r2 = Math.max(...metas.map(m => m.row + m.rs - 1));
    const c2 = Math.max(...metas.map(m => m.col + m.cs - 1));
    const inRect = new Set();
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const slot = (grid[r] || [])[c];
        if (!slot) return false;                              // 缺格 → 非矩形
        const m = info.get(slot);
        if (!m || m.row < r1 || m.row > r2 || m.col < c1 || m.col > c2) return false;  // 外部格伸进来 → 非矩形
        inRect.add(slot);
      }
    }
    if (inRect.size !== new Set(cells).size) return false;   // 多选或少选 → 非矩形
    const ordered = [...inRect].sort((a, b) => (info.get(a).row - info.get(b).row) || (info.get(a).col - info.get(b).col));
    const anchor = ordered[0];
    const content = ordered.map(x => x.innerHTML.trim()).filter(Boolean).join('<br>');
    anchor.innerHTML = content || '&nbsp;';
    const width = c2 - c1 + 1, height = r2 - r1 + 1;
    if (width > 1) anchor.setAttribute('colspan', String(width)); else anchor.removeAttribute('colspan');
    if (height > 1) anchor.setAttribute('rowspan', String(height)); else anchor.removeAttribute('rowspan');
    for (const cell of inRect) if (cell !== anchor) cell.remove();
    return true;
  }

  /** 合并单元格。给了 (fromIndex,toIndex) 就用那两格；
      给了 dragCorners=[按下格,松开格] 就用拖拽矩形（真实选区）；
      都没有就退回当前 selection 触及的格子。 */
  function mergeCells(editor, fromIndex, toIndex, dragCorners) {
    const table = currentTable(editor) || editor.querySelector('table');
    if (!table) return false;
    let cells = null;
    if (typeof fromIndex === 'number' && typeof toIndex === 'number') {
      const all = table.querySelectorAll('td,th');
      const a = all[fromIndex], b = all[toIndex];
      if (!a || !b || a === b) return false;
      cells = rectCellsOf(table, a, b);
    } else if (Array.isArray(dragCorners) && dragCorners[0] && dragCorners[1]
        && dragCorners[0] !== dragCorners[1]) {
      cells = rectCellsOf(table, dragCorners[0], dragCorners[1]);
    } else {
      cells = cellsTouchedBySelection(editor);
    }
    return mergeCellNodes(table, cells || []);
  }

  /* 拆分单元格：把 colspan/rowspan 还原成一个个独立单元格，
     补出的格子落在**正确的行列**，表重新填满成矩形。 */
  function splitCell(editor, target) {
    const cell = target || currentCell(editor);
    if (!cell) return false;
    const table = cell.closest('table');
    if (!table) return false;
    const {info} = visualGrid(table);
    const meta = info.get(cell);
    if (!meta) return false;
    const {row: r, col: c, cs, rs} = meta;
    if (cs <= 1 && rs <= 1) return false;
    const rows = [...table.querySelectorAll('tr')];
    const style = cell.getAttribute('style') || 'border:1px solid #d0d5dd;padding:6px';
    for (let dr = 0; dr < rs; dr++) {
      const tr = rows[r + dr];
      if (!tr) continue;
      let anchor = null;
      for (const node of tr.children) {
        if (!/^(TD|TH)$/.test(node.tagName) || node === cell) continue;
        const m = info.get(node);
        if (m && m.col >= c) { anchor = node; break; }
      }
      for (let dc = 0; dc < cs; dc++) {
        const td = newCell(tr.ownerDocument, style);
        td.innerHTML = (dr === 0 && dc === 0) ? (cell.innerHTML || '&nbsp;') : '&nbsp;';
        if (anchor) tr.insertBefore(td, anchor); else tr.appendChild(td);
      }
    }
    cell.remove();
    return true;
  }

  /* ---- N3-A 插图进正文 ----
     用户 2026-10-11 验收反馈：「拖进来也不行，显示不出来」。
     查实：这条路径**压根不存在** —— 没有拖放、没有选图入口、净化器只认 cid: 图，
     拖进来的 blob:/data: 图会被 safeFragment 直接剥掉。

     规矩：插进去的是**受管资源**，正文只留 `src="cid:…"` 引用，**字节绝不写进正文**。
     「字节怎么落库」由宿主（写信窗）定，编辑器只插引用 —— 所以上传走 cfg.uploadImage。 */

  /** 走平台把图存成受管文件，返回 {content_id, mime_type, name, file}。 */
  async function uploadManagedImage(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const b64 = btoa(binary);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    const call = async (id, payload) => {
      const r = await fetch('/api/platform/actions/' + id + '/execute', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({payload, confirmed: true, idempotency_key: id + '-' + sha.slice(0, 16)}),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(id + ' ' + r.status + ' ' + text.slice(0, 160));
      return JSON.parse(text).result;
    };
    const up = await call('files.upload', {file_name: file.name || '插图.png', content_base64: b64, file_sha256: sha, attribution: {level: 'personal'}});
    const versions = await (await fetch('/api/platform/services/files.versions/invoke', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({payload: {file: up.file}}),
    })).json();
    const list = (versions.result || versions).versions || [];
    const hit = list.find(v => v.version_no === up.version);
    if (!hit || !hit.frappe_file) throw new Error('上传后拿不到固定版本的受管文件引用');
    return {
      content_id: (file.name || 'img').replace(/[^a-zA-Z0-9._-]/g, '') + '-' + sha.slice(0, 12) + '@shangshu.local',
      mime_type: file.type || 'image/png',
      name: file.name || '插图.png',
      file: hit.frappe_file,
      ...(hit.source?{source:hit.source}:{}),
    };
  }

  /** 在光标处插一个**节点**（不走 HTML 字符串净化门）。 */
  function insertNodeAtCaret(editor, node) {
    const sel = editor.ownerDocument.defaultView?.getSelection?.();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (range && editor.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      editor.appendChild(node);
    }
    return node;
  }

  function fileToDataURL(file) {
    return new Promise(res => {
      if (!file || typeof FileReader === 'undefined') return res('');
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => res('');
      fr.readAsDataURL(file);
    });
  }

  function isImageFile(file) {
    if (!file) return false;
    if (String(file.type || '').toLowerCase().startsWith('image/')) return true;
    // 有些系统拖进来 type 是空的，看后缀兜底
    return /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(file.name || ''));
  }

  /** 把一批文件插进正文：只收图片，非图片**整批拒绝**（一个都不插，正文一字不动）。 */
  async function insertImages(editor, files, cfg, resources, ctx) {
    const list = [...(files || [])];
    if (!list.length) return {ok: false, reason: '没有文件'};
    const bad = list.filter(f => !isImageFile(f));
    if (bad.length) {
      return {ok: false, reason: '不是图片：' + bad.map(f => f.name || f.type || '未知').join('、')};
    }
    const upload = cfg.uploadImage || uploadManagedImage;
    const inserted = [];
    for (const file of list) {
      const item = await upload(file);
      if (!item || !item.content_id) continue;
      const key = String(item.content_id).replace(/^<|>$/g, '');
      /* 显示用的字节**上传时已经在手上**，直接拿来显示 —— 不必再绕一圈取回。
         存进正文的仍然只是 cid: 引用（normalizeMarkup 会把 data-managed-cid 还原成 cid:）。 */
      const display = item.data && /^data:image\//i.test(String(item.data))
        ? String(item.data) : await fileToDataURL(file);
      const img = editor.ownerDocument.createElement('img');
      // data-managed-cid 必须**带 cid: 前缀**，与 hydrateEditorImages 的约定一致 ——
      // normalizeMarkup 会把它原样当 src 还原，不带前缀就会被 safeFragment 当外链拦掉。
      img.setAttribute('data-managed-cid', 'cid:' + key);
      img.setAttribute('src', display || ('cid:' + key));
      img.setAttribute('alt', item.name || '');
      img.style.maxWidth = '100%';
      /* 必须插**节点**，不能插 outerHTML 字符串：
         字符串要过 safeFragment，而它只认 src="cid:"，会把 data-managed-cid 与
         显示用的 data: 源一起剥掉（实测：存出来是 data-blocked-src="external-resource"）。
         这个元素是我们自己用已验证的图片文件构造的，没有不可信 HTML 要净化。 */
      insertNodeAtCaret(editor, img);
      const record = {content_id: key, mime_type: item.mime_type || 'image/png',
                      name: item.name || '插图.png', file: item.file,...(item.source?{source:item.source}:{})};
      resources.set(key, record);
      inserted.push(record);
    }
    return inserted.length ? {ok: true, inserted} : {ok: false, reason: '图没插进去'};
  }

  /** 单张图显示：受管资源 → data URL。 */
  function hydrateOneImage(img, key, item, owner) {
    const done = (url) => { if (url) img.setAttribute('src', url); };
    if (item && /^data:image\//i.test(String(item.data || ''))) { done(item.data); return Promise.resolve(); }
    if (!owner || !owner.ref || !owner.ref_name) return Promise.resolve();
    const qs = new URLSearchParams({ref: owner.ref, ref_name: owner.ref_name, file: item.file || ''});
    return fetch('/api/platform/file-content?' + qs)
      .then(r => r.ok ? r.blob() : null)
      .then(blob => blob ? new Promise(res => {
        const fr = new FileReader();
        fr.onload = () => { done(String(fr.result)); res(); };
        fr.onerror = () => res();
        fr.readAsDataURL(blob);
      }) : null)
      .catch(() => null);
  }

  function setTableWidth(editor, value) {
    const table = currentTable(editor) || editor.querySelector('table');
    if (!table) return false;
    table.style.width = /^\d+(\.\d+)?%$/.test(String(value)) || /^\d+(\.\d+)?px$/.test(String(value))
      ? String(value) : '100%';
    return true;
  }

  /* 工具栏：字体/字号/颜色/列表/链接/插表（MAIL-03）。 */
  const toolIcons = {
    undo:'<path d="M9 5 4 10l5 5M4 10h9a6 6 0 0 1 0 12"/>',
    list:'<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    link:'<path d="m10 13 4-4M8 15l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 9l2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
    image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
    table:'<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M3 14h18M9 4v16M15 4v16"/>',
    row:'<path d="M3 4h18v7H3zM3 16h12M3 20h12M19 15v7M16 18.5h6"/>',
    col:'<path d="M3 4h7v16H3zM15 4v8M19 4v8M15 18h7M18.5 15v7"/>',
    minus:'<path d="M4 12h16"/><rect x="3" y="4" width="18" height="16" rx="1"/>',
    merge:'<path d="M9 4H3v16h6M15 4h6v16h-6M3 12h7m-3-3 3 3-3 3M21 12h-7m3-3-3 3 3 3"/>',
    split:'<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M12 4v16M9 12H4m3-3-3 3 3 3M15 12h5m-3-3 3 3-3 3"/>'
  };
  const toolSvg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${toolIcons[name] || toolIcons.table}</svg>`;
  const toolTitles = {'data-editor-table':'插入表格','data-editor-row-add':'在下方增行','data-editor-row-del':'删本行','data-editor-col-add':'在右侧增列','data-editor-col-del':'删本列','data-editor-cell-merge':'合并选中的两个单元格','data-editor-cell-split':'拆分单元格'};
  const toolButton = (attr,label,icon,context=false) => {
    const title=toolTitles[attr]||label;
    return `<button type="button" ${attr} ${context?'data-table-context disabled':''} data-action-title="${title}" aria-label="${label}" title="${context?'先将光标放入表格，再'+title:title}">${toolSvg(icon)}<span>${label}</span></button>`;
  };

  function toolbarHtml() {
    return `<div class="mail-editor-toolbar" role="toolbar" aria-label="邮件格式工具栏">
      <div class="mail-editor-tool-group mail-editor-history" role="group" aria-label="正文撤回">${toolButton('data-editor-undo','撤回','undo')}<span data-editor-undo-count class="mail-editor-history-count" role="status" aria-live="polite">0/3</span></div>
      <div class="mail-editor-tool-group" role="group" aria-label="字体"><span class="mail-editor-group-label">字体</span>
      <select data-cmd="fontName" title="字体" aria-label="字体"><option value="SimSun">宋体</option><option value="Microsoft YaHei">微软雅黑</option><option value="Arial">Arial</option><option value="Times New Roman">Times New Roman</option></select>
      <select data-cmd="fontSize" title="字号" aria-label="字号"><option value="2">11</option><option value="3" selected>12</option><option value="4">14</option><option value="5">16</option><option value="6">18</option></select></div>
      <div class="mail-editor-tool-group" role="group" aria-label="文字样式"><button type="button" data-command="bold" title="加粗" aria-label="加粗"><b>B</b></button><button type="button" data-command="italic" title="斜体" aria-label="斜体"><i>I</i></button><button type="button" data-command="underline" title="下划线" aria-label="下划线"><u>U</u></button><input type="color" data-editor-color value="#1e232c" title="文字颜色" aria-label="文字颜色"></div>
      <div class="mail-editor-tool-group" role="group" aria-label="段落">${toolButton('data-command="insertUnorderedList"','列表','list')}</div>
      <div class="mail-editor-tool-group" role="group" aria-label="插入">${toolButton('data-editor-link','链接','link')}${toolButton('data-editor-image','图片','image')}${toolButton('data-editor-table','表格','table')}</div>
      <div class="mail-editor-tool-group mail-editor-table-tools" role="group" aria-label="表格操作"><span class="mail-editor-group-label" data-table-context-note>先将光标放入表格</span>
      ${toolButton('data-editor-row-add','增行','row',true)}${toolButton('data-editor-row-del','删行','minus',true)}${toolButton('data-editor-col-add','增列','col',true)}${toolButton('data-editor-col-del','删列','minus',true)}${toolButton('data-editor-cell-merge','合并','merge',true)}${toolButton('data-editor-cell-split','拆分','split',true)}
      <select data-editor-table-width data-table-context disabled title="先将光标放入表格，再调整宽度" aria-label="表格宽度"><option value="100%">全宽</option><option value="75%">75%</option><option value="50%">50%</option></select></div>
    </div>`;
  }

  /* contenteditable 正文编辑器：保留表格结构与合并格，直接改单元格/正文。
     不套 Excel 的唯一表头/行ID限制——正文表可以有合并格、多行表头。 */
  function mountEditor(host, options) {
    const cfg = options || {};
    const doc = cfg.document || document;
    const wrap = doc.createElement('div');
    wrap.className = 'mail-editor-wrap';
    let toolbar = null;
    if (!cfg.locked && cfg.toolbar !== false) {
      toolbar = doc.createElement('div');
      toolbar.innerHTML = toolbarHtml();
      wrap.appendChild(toolbar.firstElementChild);
      // 重要：工具栏节点已经搬进 wrap，必须继续指向 wrap 里的活节点；
      // 否则后面 bar.querySelectorAll('button') 在搬空的 div 上找控件，一个都找不到，
      // 按钮全是死的（用户实测「点插表没反应」）。
      toolbar = wrap.querySelector('.mail-editor-toolbar');
    }
    const editor = doc.createElement('div');
    editor.id = 'c-editor';
    editor.className = 'mail-body-editor';
    editor.setAttribute('contenteditable', String(!cfg.locked));
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-label', cfg.ariaLabel || '正文');
    editor.setAttribute('aria-multiline', 'true');
    const raw = String(cfg.value ?? '');
    // HTML 正文进编辑器前先净化；纯文本转义后换行变 <br>。
    editor.innerHTML = /<\/?[a-z][^>]*>/i.test(raw) ? safeFragment(raw) : raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
    /* 受管内联图必须在编辑面上真的显示出来 —— 这就是所见即所得。
       挂载后异步取字节换 data URL；hydrateEditorImages 会保留 data-managed-cid，
       存回正文时 normalizeMarkup 再还原成 cid: 引用，字节不会写进正文。 */
    /* N3-A：受管内联资源表 = 宿主给的初始资源 + 本会话新插的。
       宿主要拿它随保存送出去，所以对外暴露 getInlineResources()。 */
    const resources = new Map();
    /* 资源表**构造**白名单（BASE967-03 / UI044 根因）：只收已知字段 ——
       schema 4 字段（content_id/mime_type/name/file）+ source（来源归属）
       + data（显示字节）。任意未知字段不许进表：宿主从**不过滤**的
       getInlineResources() 取值外传（签名编辑口 mail-center.js:361），
       表里不干净就从那里漏。保存载荷那道口另有 getInlineResourcesForSave。 */
    const pickResource = (item) => {
      if (!item || !item.content_id) return null;
      return {content_id: String(item.content_id).replace(/^<|>$/g, ''),
              mime_type: item.mime_type || 'image/png',
              name: item.name || 'inline.img',
              file: item.file || '',
              ...(item.source ? {source: item.source} : {}),
              ...(item.data ? {data: item.data} : {})};
    };
    (Array.isArray(cfg.resources) ? cfg.resources : []).forEach(item => {
      const record = pickResource(item);
      if (record) resources.set(record.content_id, record);
    });
    const pendingImages = hydrateEditorImages(editor, cfg.resources, cfg.resourceOwner)
      .then(missing => {
        if (missing && missing.length && typeof cfg.onNotice === 'function') {
          cfg.onNotice(`引用的图取不到（可能已删除或无权读取）：${missing.join('、')}。请补图后再发送，不要发一封破图的信`);
        }
        return missing;
      })
      .catch(() => []);
    wrap.appendChild(editor);
    host.appendChild(wrap);
    const commit = () => cfg.onChange?.(normalizeMarkup(editor.innerHTML));

    /* ---- 正文撤销/重做（N2-C6 起；C3 按用户 2026-10-12 拍板收口）----
       用户原话：「当前草稿正文最近三步，仅本次打开期间；自动保存不清栈，刷新/关闭清空；
                   Assistant 操作不占本人步数；包含正文表格及内联图片引用，
                   不影响主题、收抄件人和普通附件栏。」

       为什么必须自建：粘贴走 preventDefault() + 自建插入（否则剪贴板 HTML 会绕过净化门），
       浏览器原生撤销栈因此是断的 —— 用原生 Ctrl+Z 撤粘贴退不回去。

       作用域只在正文编辑区内部：不动主题、收件人、附件栏。
       这与「编辑撤回」（已发邮件的撤回/改稿）无关，那是后续工作包。

       步子的定义：一次成功的正文修改 = 一步。连续打字合并成一步（打字不该逐键成步）；
       一次粘贴 / 一次插图 / 一次表格结构操作各是一步。

       谁做的：每一步记 actor。**预算只数本人（user）的步** ——
       Assistant / 自动化改正文不占本人步数（用户 2026-10-12 拍板）。
       撤回自身、复制、读取、失败、无变化也不是步。

       栈深：只留**最近三步本人修改**，加上它们前面那一格作地板。
       所以连改四次只能撤三次，第四次撤不动 —— 更早的状态已经出窗了。 */
    const MAX_USER_STEPS = 3;
    /* 图片引用随正文快照撤回；只删活跃引用会让撤回后的旧签名图片丢失。 */
    const snapshotResources=()=>[...resources.values()].map(item=>({...item,...(item.source?{source:{...item.source}}:{})}));
    /* ── 双轨撤回的底座（BASE967-35，2026-10-19 窄设计）───────────────────
       口径：无关内容可撤回本人改动、**助手别的段的成果保留**；同段冲突拒覆盖。
       段 = 编辑面**顶层节点**（一个段落/表格/图片各算一段；表格内的格改动算整表一段）。
       每条历史记两样：
         owners[i]  第 i 段最后是谁改的（init/user/assistant）
         touched    这一步改过或新加的段内容（按内容认，不按行号 —— 行号会漂）
       对齐用 LCS（相同内容配对），插入/删除不把后面整段错位。
       边界（如实写明）：段内细粒度（表格某格、同一段里的分句）不在这一层区分，
       同一段里助手与本人混改即按「同段冲突」拒覆盖 —— 这是口径要求的保守行为。 */
    const segmentOf = node => node.nodeType === 3 ? (node.nodeValue || '') : (node.outerHTML || '');
    function segmentsOf(html) {
      const tpl = document.createElement('template');
      tpl.innerHTML = String(html || '');
      return [...tpl.content.childNodes].map(segmentOf);
    }
    function alignSegments(prevArr, curArr) {
      const n = prevArr.length, m = curArr.length;
      const anchors = [];
      if (n && m) {
        const dp = Array.from({length: n + 1}, () => new Array(m + 1).fill(0));
        for (let i = n - 1; i >= 0; i--)
          for (let j = m - 1; j >= 0; j--)
            dp[i][j] = prevArr[i] === curArr[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        let i = 0, j = 0;
        while (i < n && j < m) {
          if (prevArr[i] === curArr[j]) { anchors.push([i, j]); i++; j++; }
          else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
          else j++;
        }
      }
      const prevOfExact = new Map();          // 内容**完全相同**的配对 —— 归属只认这个
      for (const [p, c] of anchors) prevOfExact.set(c, p);
      const prevOfGapped = new Map(prevOfExact);
      /* 缺口按位置配对：**改动过的段**在 LCS 里配不上（内容不同了），但它在旧状态
         里是有位置的 —— 撤回要靠它把这段还原回改动前的内容。
         ⚠ 只给「内容还原」用，**不能拿去算归属**：配对上的段内容已经变了，
         算成「沿用旧归属」会把助手的改写说成本人的（第一版就栽在这：
         助手的段继承了本人的 owner，于是该拒的没拒）。 */
      let pi = 0, cj = 0;
      for (const [p, c] of [...anchors, [n, m]]) {
        const gapPrev = [], gapCur = [];
        for (let k = pi; k < p; k++) gapPrev.push(k);
        for (let k = cj; k < c; k++) gapCur.push(k);
        const len = Math.min(gapPrev.length, gapCur.length);
        for (let k = 0; k < len; k++) prevOfGapped.set(gapCur[k], gapPrev[k]);
        pi = p + 1; cj = c + 1;
      }
      return {prevOfExact, prevOfGapped};
    }
    /* 一步之后的状态：owners 逐段归属 + touched 本步改过/新加的段 + removed 本步删掉的段。 */
    function stepMeta(prevEntry, curHtml, actor) {
      const prevArr = segmentsOf(prevEntry.html);
      const curArr = segmentsOf(curHtml);
      const {prevOfExact, prevOfGapped} = alignSegments(prevArr, curArr);
      const prevOwners = prevEntry.owners || [];
      const covered = new Set([...prevOfGapped.values()]);
      return {
        owners: curArr.map((_, j) => prevOfExact.has(j) ? (prevOwners[prevOfExact.get(j)] || 'init') : actor),
        touched: curArr.filter((_, j) => { const p = prevOfExact.get(j); return p === undefined || prevArr[p] !== curArr[j]; }),
        /* 删掉的段要记 —— 否则「清空」那一步没有 touched，撤回会说「没有可撤回的本人修改」
           （签名弹窗清空后撤不回来就是这么来的）。 */
        removed: prevArr.filter((_, p) => !covered.has(p)),
      };
    }
    const initialHtml = editor.innerHTML;
    const history = [{html: initialHtml, actor: 'init',resources:snapshotResources(),
                      owners: segmentsOf(initialHtml).map(() => 'init'), touched: []}];
    let historyIndex = 0;
    let lastPushWasTyping = false;
    let lastPushAt = 0;

    function refreshToolbar() {
      if (!toolbar) return;
      const button = toolbar.querySelector('[data-editor-undo]');
      const steps = history.slice(1, historyIndex + 1).filter(item => item.actor === 'user').length;
      button.disabled = historyIndex <= 0;
      button.title = historyIndex > 0 ? `撤回正文修改；最近${Math.min(3, steps)}步本人操作，仅本次打开有效（⌘/Ctrl+Z）` : '本次打开尚无可撤回的正文修改';
      toolbar.querySelector('[data-editor-undo-count]').textContent = `${Math.min(3, steps)}/3`;
      const selection = doc.defaultView?.getSelection?.();
      let node = selection?.rangeCount ? selection.getRangeAt(0).startContainer : null;
      let cell = null;
      while (node && node !== editor) { if (node.nodeType === 1 && /^(TD|TH)$/.test(node.tagName) && editor.contains(node)) { cell=node; break; } node=node.parentNode; }
      const contextual = !!cell;
      toolbar.querySelectorAll('[data-table-context]').forEach(control => {
        control.disabled = !contextual;
        if (control.hasAttribute('data-editor-cell-split') && contextual) control.disabled = !((cell.rowSpan || 1)>1 || (cell.colSpan || 1)>1);
        const label = control.getAttribute('data-action-title')||control.getAttribute('aria-label');
        control.title = !contextual ? `先将光标放入表格，再${label}` : control.disabled ? '当前单元格没有合并，无需拆分' : label;
      });
      toolbar.querySelector('[data-table-context-note]').textContent = contextual ? '表格' : '先将光标放入表格';
      /* 「表格操作」那一组**按需出现**（FIX-23，2026-10-20 @browser-use 走查）：
         正文里根本没有表格时，那 7 个控件（增行/删行/增列/删列/合并/拆分 + 宽度）
         **全是点不动的**（禁用的），却在工具条上**占着整整一行** ——
         活站量：那一行 41px，工具条总高 94px，占 **44%**，全是灰按钮，白占地方。
         正文里**有**表格就照旧显示（哪怕光标不在表格里：禁用态 + 「先将光标放入表格」
         这句提示要留着，用户才知道这个功能存在、该把光标放进去）。
         用**行内 display** 不用 hidden 属性：`.mail-editor-tool-group` 上有
         `display:inline-flex`（作者样式压过浏览器默认的 `[hidden]{display:none}`），
         而邮件页 / 签名弹窗 / 审阅弹窗三处容器的 `[hidden]` 规则也不统一 ——
         行内样式在哪都生效。 */
      const tableTools = toolbar.querySelector('.mail-editor-table-tools');
      if (tableTools) tableTools.style.display = editor.querySelector('table') ? '' : 'none';
    }
    const onSelection = () => { if(!wrap.isConnected)doc.removeEventListener('selectionchange',onSelection);else refreshToolbar(); };
    doc.addEventListener('selectionchange', onSelection);
    editor.addEventListener('mouseup', onSelection);
    editor.addEventListener('keyup', onSelection);

    /* 撤回/前进只换正文，资源引用要跟着一起退：
       撤回一次插图，getInlineResources() 里那条也该消失 —— 引用与正文同次保存。
       只是不再引用，**不删共享原件**（不发删除请求）。 */
    function pruneResources() {
      const html = editor.innerHTML;
      for (const key of [...resources.keys()]) {
        const stillReferenced = html.includes(`cid:${key}`);
        if (!stillReferenced) resources.delete(key);
      }
    }

    /* 丢掉出窗的老格：只保留最近 MAX_USER_STEPS 步**本人**修改 + 它们前面一格作地板。
       夹在中间的 Assistant 格照样留着（要能顺着撤回去），但不占预算。 */
    function trimHistory() {
      let userSteps = 0;
      let floor = -1;
      for (let i = history.length - 1; i > 0; i--) {
        if (history[i].actor !== 'user') continue;
        userSteps++;
        if (userSteps === MAX_USER_STEPS) { floor = i; break; }
      }
      if (floor > 1) {
        const drop = floor - 1;
        history.splice(0, drop);
        historyIndex = Math.max(0, historyIndex - drop);
      }
    }

    function pushHistory(fromTyping, actor = 'user') {
      pruneResources();   // 正文已经变了：引用没了的资源跟着退（不删共享原件）
      const html = editor.innerHTML;
      const currentResources=snapshotResources();
      if (fromTyping && lastPushWasTyping && Date.now() - lastPushAt < 800 && history.length) {
        /* 连续打字合并成一步 —— 归属按**这一步的起点**（上一条之前那条）算，
           不按合并过程中的中间态，否则 owners 会把打字途中的段落算成别人的。 */
        history[historyIndex] = {html, actor,resources:currentResources,
                                 ...stepMeta(history[historyIndex - 1] || history[historyIndex], html, actor)};
        lastPushAt = Date.now();
        refreshToolbar();
        return;
      }
      if (html === history[historyIndex].html&&JSON.stringify(currentResources)===JSON.stringify(history[historyIndex].resources)) return;
      history.splice(historyIndex + 1);
      history.push({html, actor,resources:currentResources, ...stepMeta(history[history.length - 1], html, actor)});
      historyIndex = history.length - 1;
      trimHistory();
      lastPushWasTyping = Boolean(fromTyping);
      lastPushAt = Date.now();
      refreshToolbar();
    }
    function applyHistory() {
      editor.innerHTML = history[historyIndex].html;
      resources.clear();
      for(const item of history[historyIndex].resources||[]){const record=pickResource(item);if(record)resources.set(record.content_id,record);}
      pruneResources();
      cfg.onChange?.(normalizeMarkup(editor.innerHTML));
      void hydrateEditorImages(editor,[...resources.values()],cfg.resourceOwner);
      refreshToolbar();
    }
    /* 双轨撤回（BASE967-35）：撤**本人**最近那一步，且**只撤本人动过的段**——
       助手在别的段的成果留着；本人动过的段若后来被助手动过（同段冲突），
       **拒覆盖**并说清为什么。
       回执字段与 D（对话侧）对齐（f41cfa54 / 89f83fd2）：
         {ok:true, undo_state:'withdrawn',        undone:N, kept:0}      已撤回
         {ok:true, undo_state:'partial',          undone:N, kept:M}      部分撤回
         {ok:true, undo_state:'rejected_conflict', undone:0, reason}     未撤回（同段有助手改动）
         {ok:false}                                                          没有可撤回的本人修改
       ⚠ rejected_conflict **也是 ok:true** —— 它是产品语义，不是出错（D 渲染层按三态文案）。
       `undo()` 仍是布尔口：真的撤掉了才 true。细节看 `undoDetailed()`。 */
    function lastUserStep() {
      for (let i = historyIndex; i > 0; i--) if (history[i].actor === 'user') return i;
      return 0;
    }
    function undoDetailed() {
      const j = lastUserStep();
      if (j <= 0) return {ok: false, reason: '没有可撤回的本人修改'};
      const step = history[j], target = history[j - 1], current = history[historyIndex];
      const prevArr = segmentsOf(target.html), curArr = segmentsOf(current.html);
      const {prevOfGapped} = alignSegments(prevArr, curArr);
      const curOfGapped = new Map();
      for (const [c, p] of prevOfGapped) curOfGapped.set(p, c);
      const owners = current.owners || curArr.map(() => 'init');
      /* 助手在**本人那一步之后**新写出来的段（内容不在目标状态里）——用来判
         「本人那段被助手整段重写」：本人段已不在，助手的成果却在这片区域 → 同段冲突。 */
      const targetSet = new Set(prevArr);
      const assistantNew = curArr.filter((seg, idx) => owners[idx] === 'assistant' && !targetSet.has(seg));
      const undone = [], conflict = [];
      for (const seg of step.touched || []) {
        const idx = curArr.indexOf(seg);       // 按**内容**认段（行号会漂，内容不会）
        if (idx < 0) {                         // 这段内容后来没了 —— 若助手在这片区域写过东西，撤不了
          if (assistantNew.length) conflict.push(idx);
          continue;
        }
        if (owners[idx] === 'user') undone.push(idx);
        else conflict.push(idx);               // 这段归助手 → 同段冲突，撤不了
      }
      /* 本人这一步**删掉的**段：撤回去要把它放回来。它被助手又写回来过（同段）也撤不了。 */
      const restore = [];
      for (const seg of step.removed || []) {
        const p = prevArr.indexOf(seg);
        if (p < 0) continue;
        const c = curOfGapped.get(p);
        if (c === undefined) { if (assistantNew.length) conflict.push(p); restore.push(seg); continue; }
        if (owners[c] !== 'assistant') restore.push(seg);
        else conflict.push(c);
      }
      if (conflict.length)
        return {ok: true, undo_state: 'rejected_conflict', undone: 0,
                reason: '这段有助手的改动，你撤不了', conflictSegments: conflict.length};
      if (!undone.length && !restore.length) return {ok: false, reason: '没有可撤回的本人修改'};
      /* 合并：按**旧状态的位置**重建 —— 本人改过/删掉的段回到这一步之前，
         其余段原样留着（助手的成果因此保留）。 */
      const drop = new Set(undone);
      const restoreSet = new Set(restore);
      const merged = [];
      /* 合并后**每一段的归属** —— `kept` 要按它数（见下面那段注释）。 */
      const mergedOwners = [];
      const targetOwners = target.owners || [];
      const paired = new Set(prevOfGapped.keys());
      prevArr.forEach((prevSeg, p) => {
        const c = curOfGapped.get(p);
        if (c === undefined) {                                     // 本人删掉的 → 放回来
          merged.push(prevSeg); mergedOwners.push(targetOwners[p] || 'init'); return;
        }
        if (!drop.has(c)) {                                        // 别人的成果/没动的 → 留着
          merged.push(curArr[c]); mergedOwners.push(owners[c] || 'init');
        } else {                                                   // 本人改过的 → 回到这步之前
          merged.push(prevSeg); mergedOwners.push(targetOwners[p] || 'init');
        }
      });
      curArr.forEach((seg, c) => {                               // 本人之后新增的段（没配上）
        if (!paired.has(c) && !drop.has(c) && !restoreSet.has(seg)) {
          merged.push(seg); mergedOwners.push(owners[c] || 'init');
        }
      });
      /* **kept ＝ 合并后归属为助手的段数**（产品口径：C 2026-10-19 收紧，
         用户 2026-10-22 20:55 复核确认「不用拍，这是纯 bug 修复」）。

         ⚠️ 原来这里算的是「**还剩多少段**」（curArr.length − undone − removed）
         ⇒ 两个错：① 把**从没被谁动过**的段（'init'）也报成「助手改动」；
         ② 把本该「已撤回」的情况说成「部分撤回」。
         例子（用户给的）：正文 3 段，2 段是用户刚改的（能撤），第 3 段是老内容（从没动过）——
           原来：kept ＝ 3 − 2 − 0 ＝ 1 ⇒ 回执「部分撤回，撤 2 留 1」；
           现在：kept ＝ 0（没有助手段）⇒ 回执「已撤回」。
         正确算法需要的信息**本来就有**（每段归属 owners），只是原来没用它。 */
      const keptAssistant = mergedOwners.filter(owner => owner === 'assistant').length;
      const receipt = {ok: true, undo_state: keptAssistant > 0 ? 'partial' : 'withdrawn',
                       undone: undone.length + restore.length, kept: Math.max(keptAssistant, 0)};
      const html = merged.join('');
      if (html === target.html) {
        /* 完全回到那一步之前 = 老行为：**只回退指针**，那一步及之后的格留在栈里，
           redo（Ctrl/⌘+Shift+Z）才走得回去（第一版直接 splice 掉了，redo 就没了）。 */
        historyIndex = j - 1;
      } else {
        /* 助手的成果要留着 → 合并态放回本人那一步的**位置**，上面的格也留着（redo 能走），
           actor 记 'undo'：不占本人的三步预算，后续撤时也不把它当成本人的一步。 */
        history.splice(j, 1, {html, actor: 'undo', resources: snapshotResources(),
                              ...stepMeta(target, html, 'undo')});
        historyIndex = j;
      }
      lastPushWasTyping = false;
      applyHistory();
      return receipt;
    }
    function undoHistory() {
      const receipt = undoDetailed();
      cfg.onUndoResult?.(receipt);
      /* 布尔口 = 「真的撤掉了没有」；回执里的 rejected_conflict 是 ok:true（D 的产品语义）——
         两者不矛盾：内容一个字没动，所以布尔口 false，但回执要如实说「未撤回」。 */
      if (receipt.undo_state === 'rejected_conflict') { notifyUndoRefused(receipt); return false; }
      if (!receipt.ok) return false;
      return true;
    }
    /* 拒覆盖要说给人听 —— 文案一处，撤回口和键盘口共用。 */
    function notifyUndoRefused(receipt) {
      const message = receipt.reason || '这段撤不了';
      if (typeof cfg.onNotice === 'function') cfg.onNotice(message);
      else if (doc.defaultView && typeof doc.defaultView.alert === 'function') doc.defaultView.alert(message);
    }
    function redoHistory() {
      if (historyIndex >= history.length - 1) return false;
      historyIndex++;
      lastPushWasTyping = false;
      applyHistory();
      return true;
    }
    /* 每个「动作」提交一步：粘贴、表格结构操作、工具栏命令。
       一次粘贴 = 一步撤销（与 N2-C3「一次粘贴只产生一个动作」咬合）。 */
    function commitStep() {
      commit();
      pushHistory(false);
    }

    /* 粘贴必须在进 DOM 前接管并净化：
       浏览器原生粘贴会把剪贴板 HTML 原样塞进 DOM，那样 script/事件/外链就绕过净化门了，
       事后靠输出净化补救不了已经执行过的危险标记。 */
    if (!cfg.locked) {
      editor.addEventListener('paste', event => {
        const dt = event.clipboardData;
        if (!dt) return;
        const html = dt.getData ? dt.getData('text/html') : '';
        const plain = dt.getData ? dt.getData('text/plain') : '';
        if (!html && !plain) return;
        event.preventDefault();
        const safe = html ? safeFragment(html) : plainPasteFragment(plain);
        const isTable = /<table/i.test(safe);
        const hadTable = Boolean(editor.querySelector('table'));
        const target = caretTable(editor);          // 「选中的那张表」，光标不在表里就是 null
        const inserted = insertHtmlAtCaret(editor, safe) || [];
        commitStep();

        /* N2-C3：粘的是表、且文里已有表时，给可见的三种方式。
           默认已经按「插入新表」落好（不覆盖任何旧表），这里只让人改主意。 */
        if (isTable && hadTable) {
          const revert = () => { inserted.forEach(n => n.remove && n.remove()); };
          showPasteScope(wrap, {
            onInsert: () => { /* 默认就是插入新表，什么都不用做 */ },
            onReplace: () => {
              revert();
              if (!target || !target.isConnected) {
                // 没有明确目标 → 拒绝，退回粘贴前
                commitStep();
                return;
              }
              const tpl = doc.createElement('template');
              tpl.innerHTML = safe;
              target.replaceWith(tpl.content);
              commitStep();
            },
            onPlain: () => {
              revert();
              insertHtmlAtCaret(editor, `<p>${String(plainTextOf(html || plain) || '')
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`);
              commitStep();
            },
            onCancel: () => { revert(); commitStep(); },
          });
        }
      });
    }

    /* N3-A 拖图进正文。必须接管 drop —— 浏览器默认会把文件拖成 blob: 图，
       而 safeFragment 只认 cid: 图，下次一净化就被剥掉（用户实测「拖进来也不行」）。
       非图片整批拒绝：正文一个字都不动。 */
    editor.addEventListener('dragover', event => {
      const dt = event.dataTransfer;
      if (dt && [...(dt.types || [])].includes('Files')) {
        event.preventDefault();
        dt.dropEffect = 'copy';
      }
    });
    editor.addEventListener('drop', event => {
      const dt = event.dataTransfer;
      const files = dt && dt.files ? [...dt.files] : [];
      if (!files.length) return;
      event.preventDefault();          // 不许浏览器走默认（否则拖成 blob: 图）
      void insertImages(editor, files, cfg, resources, {})
        .then(result => {
          if (!result.ok) {
            cfg.onNotice?.(result.reason || '图没插进去');
            return;
          }
          commitStep();
          cfg.onImagesInserted?.(result.inserted);
        })
        .catch(error => cfg.onNotice?.('插图失败：' + (error && error.message || error)));
    });

    editor.addEventListener('input', () => { commit(); pushHistory(true); });
    /* 撤销/重做：只拦正文编辑区，不外溢到主题、收件人、附件栏。 */
    editor.addEventListener('keydown', event => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const k = String(event.key || '').toLowerCase();
      if (k === 'z' && !event.shiftKey) { event.preventDefault(); undoHistory(); }
      else if ((k === 'z' && event.shiftKey) || k === 'y') { event.preventDefault(); redoHistory(); }
    });

    /* 工具栏接线：execCommand 走浏览器原生，表格操作走上面的结构化函数。 */
    let lastRange = null;
    const remember = () => {
      const sel = editor.ownerDocument.defaultView?.getSelection?.();
      if (sel && sel.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        lastRange = sel.getRangeAt(0).cloneRange();
      }
    };
    editor.addEventListener('keyup', remember);
    editor.addEventListener('mouseup', remember);

    /* 真实矩形选区 = 鼠标从一格**拖到**另一格。
       DOM Range 表达不了「非连续的格子集合」：从 a 拖到 e 会把中间的 c 一起圈进 range，
       包围盒就从 2×2 变成 2×3。所以自己记「按下格 / 松开格」两个角，矩形按这两角算。 */
    let dragAnchor = null, dragFocus = null;
    const cellOf = (event) => {
      const el = event.target && event.target.closest ? event.target : null;
      return el && el.closest('td,th') && editor.contains(el.closest('td,th'))
        ? el.closest('td,th') : null;
    };
    editor.addEventListener('mousedown', (event) => {
      const cell = cellOf(event);
      if (cell) { dragAnchor = cell; dragFocus = null; }
    });
    editor.addEventListener('mouseup', (event) => {
      const cell = cellOf(event);
      if (cell && dragAnchor && cell !== dragAnchor) dragFocus = cell;
    });
    const restore = () => {
      const sel = editor.ownerDocument.defaultView?.getSelection?.();
      /* 选区已经落在编辑器里就别动它 —— focus() 会把光标弹回开头，
         于是「点表格按钮」会操作到第一格去（实测：删第 2 视觉列却删掉了第 1 列）。 */
      if (sel && sel.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
      editor.focus();
      if (!lastRange) return;
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(lastRange);
    };
    const exec = (cmd, value) => {
      restore();
      editor.ownerDocument.execCommand?.(cmd, false, value);
      commitStep();
    };
    if (toolbar) {
      const bar = toolbar;
      bar.querySelector('[data-editor-undo]').onclick = () => { undoHistory(); editor.focus(); };
      bar.querySelectorAll('button,select,input').forEach(el => el.addEventListener('mousedown', remember));
      bar.querySelectorAll('[data-command]').forEach(btn => {
        btn.onclick = () => exec(btn.getAttribute('data-command'));
      });
      bar.querySelectorAll('[data-cmd]').forEach(sel => {
        sel.onchange = () => { exec(sel.getAttribute('data-cmd'), sel.value); sel.blur(); };
      });
      const color = bar.querySelector('[data-editor-color]');
      if (color) color.oninput = () => exec('foreColor', color.value);
      const imageBtn = bar.querySelector('[data-editor-image]');
      if (imageBtn) imageBtn.onclick = () => {
        const input = doc.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/gif,image/webp';
        input.multiple = true;
        input.onchange = () => {
          const files = [...(input.files || [])];
          if (!files.length) return;
          restore();
          void insertImages(editor, files, cfg, resources, {})
            .then(result => {
              if (!result.ok) { cfg.onNotice?.(result.reason || '图没插进去'); return; }
              commitStep();
              cfg.onImagesInserted?.(result.inserted);
            })
            .catch(error => cfg.onNotice?.('插图失败：' + (error && error.message || error)));
        };
        input.click();
      };
      const link = bar.querySelector('[data-editor-link]');
      if (link) link.onclick = () => {
        const url = (editor.ownerDocument.defaultView?.prompt?.('链接地址', 'https://') || '').trim();
        if (url && /^(https?:|mailto:)/i.test(url)) exec('createLink', url);
      };
      const tableBtn = bar.querySelector('[data-editor-table]');
      if (tableBtn) tableBtn.onclick = () => { restore(); insertTable(editor, 2, 2); commitStep(); };
      const bind = (attr, fn) => {
        const el = bar.querySelector(`[${attr}]`);
        if (el) el.onclick = () => { restore(); fn(); commitStep(); };
      };
      bind('data-editor-row-add', () => insertRow(editor, true));
      bind('data-editor-row-del', () => deleteRow(editor));
      bind('data-editor-col-add', () => insertColumn(editor, true));
      bind('data-editor-col-del', () => deleteColumn(editor));
      bind('data-editor-cell-merge', () => {
        /* 合并按**真实矩形选区**：优先用拖拽的两角（按下格→松开格）。
           选区不构成实心矩形就拒绝，原表一字不变。
           没有拖拽选区时，退回「光标格 + 右邻格」这个最小矩形。 */
        const table = currentTable(editor);
        if (table && dragAnchor && dragFocus && dragAnchor !== dragFocus) {
          const rect = rectCellsOf(table, dragAnchor, dragFocus);
          if (rect) mergeCellNodes(table, rect);   // 矩形里有洞 → rect 是 null，拒绝且原表不动
          return;
        }
        const touched = cellsTouchedBySelection(editor);
        if (table && touched.length >= 2) {
          const rect = rectCellsOf(table, touched[0], touched[touched.length - 1]);
          if (rect) { mergeCellNodes(table, rect); return; }
          return;
        }
        const a = currentCell(editor);
        if (!a) return;
        const cells = Array.from((a.closest('table') || editor).querySelectorAll('td,th'));
        const i = cells.indexOf(a);
        if (i >= 0 && cells[i + 1]) mergeCells(editor, i, i + 1);
      });
      bind('data-editor-cell-split', () => splitCell(editor, currentCell(editor)));
      const widthSel = bar.querySelector('[data-editor-table-width]');
      if (widthSel) widthSel.onchange = () => { setTableWidth(editor, widthSel.value); commitStep(); };
    }

    refreshToolbar();
    return {
      editor,
      insertTable: (rows, cols) => { restore(); insertTable(editor, rows, cols); commitStep(); },
      insertRow: () => { restore(); const ok = insertRow(editor, true); commitStep(); return ok; },
      deleteRow: () => { restore(); const ok = deleteRow(editor); commitStep(); return ok; },
      insertColumn: () => { restore(); const ok = insertColumn(editor, true); commitStep(); return ok; },
      deleteColumn: () => { restore(); const ok = deleteColumn(editor); commitStep(); return ok; },
      mergeCells: (i, j) => { restore(); const ok = mergeCells(editor, i, j, [dragAnchor, dragFocus]); commitStep(); return ok; },
      mergeCellList: (cells) => { restore(); const ok = mergeCellNodes(currentTable(editor), cells || []); commitStep(); return ok; },
      rectCellsOf: (a, b) => rectCellsOf(currentTable(editor), a, b),
      splitCell: (target) => { restore(); const ok = splitCell(editor, target); commitStep(); return ok; },
      setTableWidth: (v) => { restore(); const ok = setTableWidth(editor, v); commitStep(); return ok; },
      sync(value) {
        const raw = String(value ?? '');
        editor.innerHTML = /<\/?[a-z][^>]*>/i.test(raw) ? safeFragment(raw) : raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
        history.length = 0;
        pruneResources();
        history.push({html: editor.innerHTML, actor: 'init',resources:snapshotResources()});
        historyIndex = 0;
        lastPushWasTyping = false;
        refreshToolbar();
        return hydrateEditorImages(editor, [...resources.values()], cfg.resourceOwner);
      },
      /* 非本人改正文（Assistant 代写 / 自动化写入）。
         用户 2026-10-12：「Assistant 操作不占本人步数」——
         它会改正文、能被撤回（不然代写错了撤不掉），但**不占本人的三步预算**。
         actor 传 'assistant' / 'automation'；**不传就默认当 assistant**，
         因为这个入口本来就是给非本人用的 —— 要记成自己的步请用粘贴/输入那条路。 */
      applyEdit(html, opts) {
        const raw = String(html ?? '');
        for(const item of Array.isArray(opts?.resources)?opts.resources:[]){const record=pickResource(item);if(record)resources.set(record.content_id,record);}
        editor.innerHTML = /<\/?[a-z][^>]*>/i.test(raw) ? safeFragment(raw) : raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
        /* 必须 commit：宿主保存链读的是隐藏 textarea `#c-body`，
           它只由 onChange 更新。不 commit 的话代写的正文**存不出去**
           （实测：applyEdit 之后 collect() 拿到的还是旧正文）。 */
        commit();
        pushHistory(false, (opts && opts.actor) || 'assistant');
        return hydrateEditorImages(editor, [...resources.values()], cfg.resourceOwner);
      },
      getHtml: () => normalizeMarkup(editor.innerHTML),
      /* 宿主取受管内联资源（初始 + 本会话新插）—— **完整版，含 `source`**。

         `source` 是「默认签名图在首封草稿创建前的临时归属」（上传服务返回的固定版本引用），
         宿主下次打开要靠它取回图片（`mail-editor-insert-image` 那条判据明确要求
         「未建稿签名需要保留上传服务给的正式归属，才能在下次打开取回图片」）。
         **所以这里不许过滤掉 `source`。** */
      getInlineResources: () => [...resources.values()],

      /* ★ 2026-10-17 req 1（C01 第 1 条 / BASE967-03 / UI044 根因）：**保存载荷专用口** ——
         只给 schema 白名单 4 个字段（content_id / mime_type / name / file）。

         为什么单独一个口、不直接过滤 getInlineResources()：
           · `getInlineResources()` 宿主要拿 `source` 取图片 —— 过滤会打断（实测：插入图的
             判据与签名判据当场红）
           · 但**保存载荷**发出去 `source`/任意未知字段就是前后端 schema 不一致 ——
             后端 `domain.py` 的 INLINE_RESOURCE 是 `additionalProperties:False`
             （只认那 4 个），于是「前端发得出 / 后端收不下」，普通新草稿被拒（UI044）。

         用户口径：「**修复必须保留图片来源授权与固定版本约束，不通过放宽任意属性规避**」——
         `source` 保住（上面那个口），schema 不动，这里只在**发出去**那一步过滤。

         缺 `content_id` 的丢掉，跟 `service.py:371` 的 `if item.get('content_id')` 口径一致 ——
         两边都丢，不许一边丢一边留。 */
      getInlineResourcesForSave: () => [...resources.values()]
        .filter(r => r && r.content_id)
        .map(r => ({
          content_id: r.content_id,
          mime_type: r.mime_type,
          name: r.name,
          file: r.file,
        })),
      undo: undoHistory,
      /* 双轨撤回的详细回执（给 D 的非二值形状）：
         {ok:true, undoneSegments:n, keptAssistantSegments:m} /
         {ok:false, refused:true, reason:'这段有助手的改动，你撤不了', conflictSegments:n} /
         {ok:false, reason:'没有可撤回的本人修改'} */
      undoDetailed: undoDetailed,
      redo: redoHistory,
      /* BASE967-35 / UI050：审核导航会重新 openCompose/mountEditor ——
         用户 req 5「Assistant 采用不清本人撤回栈」，刷新/关闭才清。
         宿主在**重开同一草稿**（审核导航）时用这两个口把历史带过新实例。 */
      getHistoryState: () => ({
        history: history.map(e => ({html: e.html, actor: e.actor,
                                    resources: (e.resources || []).map(r => ({...r}))})),
        historyIndex,
      }),
      setHistoryState(state) {
        if (!state || !Array.isArray(state.history) || !state.history.length) return false;
        history.splice(0, history.length,
          ...state.history.map(e => ({html: String(e.html || ''), actor: e.actor || 'user',
                                      resources: (e.resources || []).map(r => ({...r}))})));
        historyIndex = Math.min(Math.max(0, Number(state.historyIndex) || 0), history.length - 1);
        /* 重开的种子正文可能跟栈顶不一样（带着助手建议进来）——补一格 assistant，
           本人步数不涨（Assistant 不占本人步数），撤回仍回得到本人的步。 */
        const current = normalizeMarkup(editor.innerHTML);
        if (current !== history[historyIndex].html) {
          history.push({html: current, actor: 'assistant', resources: snapshotResources()});
          historyIndex = history.length - 1;
        }
        refreshToolbar();
        return true;
      },
      /* 工具栏状态（撤回/重做按钮可用性 + x/3 计数）由**编辑器自己**是唯一权威。
         审核界面「冻结/解冻」会批量改按钮 disabled；解冻时按挂载时的旧快照恢复，
         会把后来才变成可用的撤回按钮重新冻住（BASE967-35）。恢复后调这个刷一遍。 */
      refreshToolbar: () => refreshToolbar(),
      /* 等受管内联图解析完 —— 测试与「保存前必须已显示」的场合用。 */
      imagesReady: () => pendingImages,
      destroy: () => { doc.removeEventListener('selectionchange', onSelection); wrap.remove(); },
    };
  }

  global.mailEditor = {
    CID_RE, safeFragment, inlinePreviewMap, previewSrcdoc,
    hydrateEditorImages, normalizeMarkup, mountEditor,
  };
})(typeof window !== 'undefined' ? window : globalThis);
