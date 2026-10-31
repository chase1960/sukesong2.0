/* 胶囊式多值输入（公共组件）。
   用途：一组值，每个值一枚胶囊，例如邮件的「主送」「抄送」，也可用于审批人、关注人等。
   用户 2026-10-10 提出：「把邮件部分的抄送和主送『；』操作搞得直观一点，可以用胶囊形式……
   用加号代表增加一个人……如何要溢出截断，记得把这个升级成公共组件。」

   交互（用户 2026-10-11 实测后定的）：
   「加号跟在已填写的胶囊右边，点击加号就在加号左边多一个胶囊（只能填一个，
     如果多的话就再点加号)，要识别其中的邮箱就行……就是一个胶囊一个邮箱」
   → 一排胶囊后面跟一个「+」；点「+」在它左边开**一个**胶囊形填写位，
     填一个人（回车或点别处）收成一枚胶囊、填写位收回；要再来一个人就再点「+」。

   不绑邮件业务，不读网络，不碰存储 —— 只管「一组字符串」的增删与展示。
   自带样式（首次挂载注入 <style>），调用方不必再引 CSS 文件。 */
(function (global) {
  'use strict';

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* 胶囊上**名字和地址都露出来**。
     用户 2026-10-13 批注 3-1：「只看到李四，但是没看到后面的邮件名……
     如果有成型的邮件号就把前面的文字也显示出来」。
     改之前这里只返回名字，地址只写在 title —— 要鼠标悬停才看得到是谁的信箱。
     改之后「李四 <li@x.com>」整串都在胶囊上，裸地址原样。 */
  function displayName(value) {
    return String(value ?? '').trim();
  }

  /* 值洗干净：剥掉外层引号和 mailto: 前缀。
     用户 2026-10-12：粘进来的地址带着 `mailto:`（带引号那支更隐蔽），胶囊上就露着脏值。 */
  function cleanValue(raw) {
    let v = String(raw ?? '').trim();
    if (v.length > 1 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) v = v.slice(1, -1).trim();
    return v.replace(/^mailto:/i, '').trim();
  }

  /* 认人只认两种干净形态（用户 2026-10-13：「只认 1@11.com 和 李四 <1@21.com>」）：
       1@11.com
       李四 <1@21.com>
     认定标准要和保存时的校验**一致**（有 @、有域名点）：先前只要见到 @ 就收，
     于是 `12@q` 被当成合法胶囊收下，等到保存才报错 —— 用户 2026-10-12 要的是
     「不合法的给明确提示」，当场拒比事后拒好。 */
  const LOOKS_LIKE_EMAIL = /^[^\s@<>;,，；]+@[^\s@<>;,，；]+\.[^\s@<>;,，；]+$/;
  /* 人与人之间的分隔：逗号、分号，中英文都算。 */
  const SEP = /[,，;；]/;

  /* 从一段打进去的字里认出**最前面的一个人**，并把没处理的原样还回去。

     一次只收一个 —— 用户 2026-10-13：「一个对话框只能输入一个」。

     为什么要有「还回去」这一截（用户批注 3-1 实测「只看到李四」的根因）：
     旧实现用一条正则从整串里找「名字 <地址>」，而它的名字组 `[^<>]+` **跨不过 `<`** ——
     碰上 `a@b.com, 张三 <zhang@a.com, 李四 <li@b.com>`（中间那个少个 `>`）时，
     「张三 <zhang@a.com, 李四 」这一整段会被当成一对去配，配不齐就整段作废，
     正则往后跳，最后只认出**最后面**的李四；前面的 a@b.com 一声不吭消失了。

     改之后按人与人的分隔符一段段看：收最前面那个能认的，认不出的**点名报出来**，
     剩下的放回填写位等下一次回车 —— 一个写错不连累别人，也不静默丢人。 */
  function takeFirst(raw) {
    const text = String(raw ?? '');
    let i = 0;
    const rejected = [];
    const skipSep = () => { while (i < text.length && (SEP.test(text[i]) || /\s/.test(text[i]))) i++; };
    while (i < text.length) {
      skipSep();
      if (i >= text.length) break;
      /* 下一个人与人的分隔在哪 —— 这一段的「一段」到那为止。 */
      const sepHit = SEP.exec(text.slice(i));
      const stop = sepHit ? i + sepHit.index : text.length;

      const lt = text.indexOf('<', i);
      if (lt >= 0 && lt < stop) {
        /* 这一段的意图是「名字 <地址>」。配不齐就整段算认不出 ——
           **不许**悄悄吞成裸地址（那会把名字丢了还不吭声，用户批注：「只看到李四」）。 */
        const gt = text.indexOf('>', lt + 1);
        if (gt < 0 || gt > stop) {
          rejected.push(text.slice(i, stop).trim());
          i = stop + 1;
          continue;
        }
        const name = text.slice(i, lt).trim().replace(/^["']+|["']+$/g, '');
        const addr = cleanValue(text.slice(lt + 1, gt));
        if (LOOKS_LIKE_EMAIL.test(addr)) {
          return {take: name ? `${name} <${addr}>` : addr, rest: text.slice(gt + 1).trim(), rejected};
        }
        rejected.push(text.slice(i, gt + 1).trim());
        i = gt + 1;
        continue;
      }

      const bare = /^([^\s<>,;；，]+@[^\s<>,;；，]+)/.exec(text.slice(i));
      if (bare) {
        const addr = cleanValue(bare[1].replace(/[.;，,;；]+$/, ''));
        if (LOOKS_LIKE_EMAIL.test(addr)) {
          return {take: addr, rest: text.slice(i + bare[0].length).trim(), rejected};
        }
        rejected.push(bare[1]);
        i += bare[0].length;
        continue;
      }

      rejected.push(text.slice(i, stop).trim());
      i = stop + 1;
    }
    return {take: '', rest: '', rejected};
  }

  /* 去重按邮箱地址比，不按整串比 —— 「张三 <a@x.com>」和「a@x.com」是同一个人。 */
  function addressOf(value) {
    const raw = String(value ?? '');
    const m = /<([^<>]+@[^<>]+)>/.exec(raw) || /([^\s<>,;；，]+@[^\s<>,;；，]+)/.exec(raw);
    return m ? m[1].trim().toLowerCase() : raw.trim().toLowerCase();
  }

  let styleInjected = false;
  function injectStyle(doc) {
    if (styleInjected) return;
    styleInjected = true;
    const style = doc.createElement('style');
    style.id = 'chip-input-style';
    style.textContent = [
      '.chip-input{display:flex;align-items:center;gap:8px;width:100%}',
      /* 一行放不下就截断，不撑高 —— 这是「溢出截断」的那一层。
         胶囊区**按内容走**（flex:0 1 auto），不许写成 flex:1 —— 那会把胶囊区撑满整行，
         把「+」永久顶到最右。用户 2026-10-12：「加号能不能跟着胶囊而不是右对齐？
         就是和胶囊对齐直到胶囊溢出刚好在右侧现在的位置」。
         放不下时 flex-shrink 自然收到只剩右端那点空间，「+」正好落在右端。 */
      '.chip-input-items{flex:0 1 auto;min-width:0;display:flex;align-items:center;gap:6px;flex-wrap:nowrap;overflow:hidden}',
      '.chip-input-chip{display:inline-flex;align-items:center;gap:4px;flex:0 1 auto;min-width:0;',
      'height:26px;padding:0 6px 0 10px;border:1px solid var(--line2, #d0d5dd);border-radius:13px;',
      'background:var(--bg-alt, #f4f5f7);color:var(--fg, #1e232c);font-size:12px;line-height:1}',
      /* 名字太长就省略号；全文挂在 title 上，鼠标悬停能看到 */
      '.chip-input-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.chip-input-x{flex:0 0 auto;width:18px;height:18px;border:0;border-radius:50%;background:transparent;',
      'color:var(--fg3, #8a9099);font-size:14px;line-height:1;cursor:pointer;padding:0}',
      '.chip-input-x:hover{background:var(--line2, #d0d5dd);color:var(--fg, #1e232c)}',
      '.chip-input-more{flex:0 0 auto;height:26px;padding:0 10px;border:1px dashed var(--line2, #d0d5dd);',
      'border-radius:13px;background:transparent;color:var(--fg3, #8a9099);font-size:12px;cursor:pointer}',
      /* 填写位长得也是一枚胶囊 —— 用户点「+」要在加号左边「多一个胶囊」，不是一个大文本框 */
      '.chip-input-field{flex:0 1 auto;min-width:84px;max-width:180px;height:26px;padding:0 10px;',
      'border:1px dashed var(--accent, #16a34a);border-radius:13px;background:var(--control-bg, #fff);',
      'color:inherit;font:inherit;font-size:12px;outline:none;box-sizing:border-box}',
      '.chip-input-field::placeholder{color:var(--fg3, #8a9099)}',
      '.chip-input-add{flex:0 0 auto;width:28px;height:28px;border:1px solid var(--line2, #d0d5dd);',
      'border-radius:50%;background:var(--control-bg, #fff);color:var(--fg2, #5a6169);font-size:17px;',
      'line-height:1;cursor:pointer;padding:0}',
      '.chip-input-add:hover{border-color:var(--accent, #16a34a);color:var(--accent, #16a34a)}',
    ].join('\n');
    (doc.head || doc.documentElement).appendChild(style);
  }

  /**
   * 把一个多值输入挂到 host 上。
   * @param {HTMLElement} host
   * @param {{values?:string[],placeholder?:string,onChange?:Function,onReject?:Function,ariaLabel?:string,visibleLimit?:number,document?:Document}} options
   *   onReject(原文)：填写位里那串字一个人都认不出来时回调（组件不绑业务，怎么说由调用方给）
   * @returns {{getValues:Function,setValues:Function,focus:Function,destroy:Function}}
   */
  global.mountChipInput = function (host, options) {
    const cfg = options || {};
    const doc = cfg.document || (host && host.ownerDocument) || document;
    injectStyle(doc);

    const visibleLimit = Number(cfg.visibleLimit) > 0 ? Math.floor(Number(cfg.visibleLimit)) : 3;
    let values = (Array.isArray(cfg.values) ? cfg.values : [])
      .map(v => String(v ?? '').trim()).filter(Boolean);
    let expanded = false;

    const root = doc.createElement('div');
    root.className = 'chip-input';
    root.setAttribute('role', 'list');
    if (cfg.ariaLabel) root.setAttribute('aria-label', cfg.ariaLabel);
    /* 常驻的只有胶囊区和「+」。填写位不是常驻控件，点「+」才造一个 ——
       用户：「没点加号就该没有输入位」。 */
    root.innerHTML =
      '<div class="chip-input-items" data-chip-items></div>' +
      '<button type="button" class="chip-input-add" data-chip-add title="添加一个人" aria-label="添加">+</button>';
    host.appendChild(root);

    const items = () => root.querySelector('[data-chip-items]');
    const field = () => root.querySelector('[data-chip-field]');
    const addBtn = () => root.querySelector('[data-chip-add]');

    const getValues = () => [...values];
    const emit = () => { if (typeof cfg.onChange === 'function') cfg.onChange(getValues()); };

    /* 开一个填写位（点「+」）。已经有就只聚焦，不叠第二个 ——「只能填一个」。 */
    function openSlot() {
      const box = items();
      let el = field();
      if (!el) {
        el = doc.createElement('input');
        el.className = 'chip-input-field';
        el.type = 'text';
        el.setAttribute('data-chip-field', '');
        el.setAttribute('autocomplete', 'off');
        el.placeholder = cfg.placeholder || '';
        if (cfg.ariaLabel) el.setAttribute('aria-label', cfg.ariaLabel);
        /* 填写位插在胶囊区末尾 —— 正好落在「+」的左边 */
        box.appendChild(el);
        wireField(el);
      }
      el.focus();
      return el;
    }

    function closeSlot() {
      const el = field();
      if (el) el.remove();
    }

    /* 提交填写位：一次只收一个人（用户 2026-10-13：「一个对话框只能输入一个」）。
       认不出来**不许一声不吭地丢掉** —— 用户 2026-10-12 要求「不合法的给明确提示」。
       组件不绑业务、不懂文案，只报「这输入我收不了」，怎么说由调用方给（onReject）。
       剩下没认的**放回填写位**，等下一次回车 —— 一个写错不连累别人，也不静默丢人。
       返回 true = 填写位还开着（里面还有没认完的人）。 */
    function commitSlot() {
      const el = field();
      if (!el) return false;
      const typed = String(el.value || '').trim();
      const {take, rest, rejected} = takeFirst(typed);
      for (const bad of rejected) {
        if (bad && typeof cfg.onReject === 'function') cfg.onReject(bad);
      }
      el.value = rest;
      if (take) {
        if (!values.some(v => addressOf(v) === addressOf(take))) {
          values.push(take);
          emit();
        }
      }
      if (rest) {
        /* 还有人没认完就接着填，别把填写位收回 —— 收回了剩下那些就看不见了。 */
        render();
        const again = field();
        if (again) { again.value = rest; again.focus(); }
        return true;
      }
      closeSlot();
      render();
      return false;
    }

    function render() {
      const box = items();
      const slot = field();
      const over = values.length > visibleLimit;
      const shown = expanded ? values : values.slice(0, visibleLimit);
      let html = shown.map((v, i) => {
        const name = displayName(v);
        return '<span class="chip-input-chip" data-chip title="' + escapeHtml(v) + '">' +
          '<span class="chip-input-text" data-chip-text>' + escapeHtml(name) + '</span>' +
          '<button type="button" class="chip-input-x" data-chip-remove data-chip-i="' + i + '"' +
          ' title="删除' + escapeHtml(name) + '" aria-label="删除 ' + escapeHtml(name) + '">×</button>' +
          '</span>';
      }).join('');
      if (over) {
        html += '<button type="button" class="chip-input-more" data-chip-more>' +
          (expanded ? '收起' : '+' + (values.length - visibleLimit)) + '</button>';
      }
      /* 重画胶囊区会把填写位一起冲掉，先把它的字留下，画完再放回去。 */
      const draft = slot ? slot.value : '';
      box.innerHTML = html;
      box.querySelectorAll('[data-chip-remove]').forEach(btn => {
        btn.onclick = () => {
          values.splice(Number(btn.getAttribute('data-chip-i')), 1);
          emit();
          render();
          addBtn() && addBtn().focus();
        };
      });
      const more = box.querySelector('[data-chip-more]');
      if (more) more.onclick = () => { expanded = !expanded; render(); };
      if (slot) {
        const back = openSlot();
        back.value = draft;
      }
    }

    function wireField(el) {
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          /* 还有人没认完时填写位留着字 —— **不许**把焦点挪到加号上：
             一挪就 blur，blur 又 commit 一次，同一次回车进两枚胶囊。
             （用户 2026-10-13 批注 3-1 的多余人被吞，一半就出在这条链上。） */
          const keptOpen = commitSlot();
          if (!keptOpen) addBtn() && addBtn().focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeSlot();
          addBtn() && addBtn().focus();
        } else if (e.key === 'Backspace' && String(el.value || '') === '') {
          /* 填写位空着时按退格，删掉最后一枚（点 × 删指定那枚是另一条路）。 */
          e.preventDefault();
          if (values.length) {
            values.pop();
            emit();
            render();
          }
        }
      });
      /* 失焦也算填完：有字就收成胶囊，空的就收回填写位。 */
      el.addEventListener('blur', () => {
        // 微延迟，让「点 + 开的那次」不被自己刚聚焦又失焦误伤
        setTimeout(() => { if (el.isConnected && String(el.value || '').trim()) commitSlot(); else if (el.isConnected && !String(el.value || '').trim()) closeSlot(); }, 0);
      });
    }

    addBtn().onclick = () => openSlot();

    render();

    return {
      getValues,
      setValues(next) {
        values = (Array.isArray(next) ? next : []).map(v => String(v ?? '').trim()).filter(Boolean);
        expanded = false;
        emit();
        render();
      },
      /* 要写字就先开填写位再聚焦 —— 点「+」是唯一的入口。 */
      focus() { openSlot(); },
      destroy() { root.remove(); },
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
