/**
 * 单元格上的**取值下拉**（有值域清单的列）。
 *
 * **为什么要有**（用户 2026-10-24 22:3x 原话：
 * 「示例企业总表里那几个受管字段……最好还是下拉框」「我们还需要再 excel 交互那里也做一个这样的东西」）：
 * 受管列（审查状态／申请类型／是否结案）的取值是**有限的几几种** ⇒ 让它自由填写很奇怪
 * ⇒ 这一列改成**下拉**（选项多时**可搜索**）。
 *
 * **照旧项目那条**（`ip-field-rules.js:258-283/272/338-417`）：
 * · 自绘浮层（**不是原生 `<select>`**）—— 原生 select 的展开方向是浏览器画的，
 *   在弹窗里常常向上弹、盖住内容（`dropdown.ts` 顶部记着这个坑）；
 * · **选项 ≥12 才自动加搜索框**（旧项目那条阈值）；
 * · 选中即写值；点外面／按 Esc 关掉。
 *
 * **「填了清单以外的值」怎么办**（旧项目那条口径）：
 * · `allowCustom` 为真 ⇒ 清单下面留一个「其他（自行填写）」的口，填了别的**保留原文**；
 * · 当前值不在清单里时，它**单独占一行并标成「自定义」** ——
 *   **不推断**成任一标准项（旧项目明写的口径）。
 *
 * **纯函数与界面分开**：`needsSearch`／`filterOptions`／`currentEntry` 不碰 DOM
 * ⇒ 判据能离线核「该出现什么」，不靠肉眼看截图。
 */

/** 选项达到这个数才给搜索框（旧项目那条：选项 ≥12 才自动加搜索框）。 */
export const SEARCH_THRESHOLD = 12;

/** 该不该给搜索框（**算出来的**，不是看界面上有没有）。 */
export function needsSearch(options: string[]): boolean {
  return (options || []).length >= SEARCH_THRESHOLD;
}

/** 搜索后剩下的选项（**逐字包含**，不猜近似、不做拼音/模糊匹配）。 */
export function filterOptions(options: string[], query: string): string[] {
  const text = String(query || '').trim().toLowerCase();
  const all = (options || []).slice();
  if (!text) return all;
  return all.filter(item => String(item).toLowerCase().includes(text));
}

/**
 * 当前值不在清单里 ⇒ 它要**单独占一行**，并**标成自定义**。
 * 返回 null 表示当前值就是清单里的一项（那一项自己打勾就行）。
 */
export function currentEntry(current: string, options: string[]): { value: string; custom: boolean } | null {
  const text = String(current == null ? '' : current);
  if (!text) return null;
  if ((options || []).some(item => item === text)) return null;
  return { value: text, custom: true };
}

export interface ValueDropdownAnchor {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ValueDropdownOptions {
  /** 这一列的标准项清单（**存储值**，不是显示名）。 */
  options: string[];
  /**
   * **显示名**（存储值 ⇒ 给人看的那句话）（2026-10-29 用户口径）。
   *
   * ⚠️ **为什么显示名和存储值要分开**：
   *   案号那两列的值是 `DD`／`DF`／`FD`、`F`／`V` 这种码 ⇒ **人看不懂**
   *   ⇒ **显示**给中文（内内／内外／外内、巴黎公约／PCT·海牙）；
   *   但**存进去的必须是码**（算法按码表判，填了中文就「不在码表里 ⇒ 不编」⇒ 白填）。
   *
   * ⚠️ **没给的项照旧显示它自己**（审查状态／申请类型的值本来就是中文）。
   */
  optionLabels?: Record<string, string>;
  /** 能不能填清单以外的值（**没写 = 能**）。 */
  allowCustom?: boolean;
  /** 「自己填一个」那个口的文案。 */
  customLabel?: string;
  /** 这一格当前的值（不在清单里就当自定义显示）。 */
  current?: string;
  /** 面板摆哪儿（视口坐标；通常是那一格的矩形）。 */
  anchor: ValueDropdownAnchor;
  /** 选中一项（或自己填了一个）时回调。 */
  onPick: (value: string) => void;
  /** 面板关掉时回调（无论是因为选中、点外面还是 Esc）。 */
  onClose?: () => void;
}

export interface ValueDropdownHandle {
  close(): void;
  isOpen(): boolean;
  /** 面板上的搜索框（有搜索框时）—— 给判据/诊断用。 */
  searchInput(): HTMLInputElement | null;
  /** 面板上现在列着的选项（自定义项单独标出来）。 */
  listed(): Array<{ value: string; custom: boolean }>;
}

/**
 * 打开取值下拉。**挂在 `document.body` 上**（浮层用 `fixed` 定位，
 * 不受工作区 `overflow` 裁剪）。
 */
export function openValueDropdown(host: HTMLElement, options: ValueDropdownOptions): ValueDropdownHandle {
  const doc = host.ownerDocument;
  const win = doc.defaultView || window;
  const standard = (options.options || []).slice();
  const allowCustom = options.allowCustom !== false;
  const customLabel = options.customLabel || '其他（自行填写）';
  const current = String(options.current == null ? '' : options.current);
  const custom = currentEntry(current, standard);

  const panel = doc.createElement('div');
  panel.className = 'excel-value-dropdown';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '选择取值');
  panel.dataset.excelValueDropdown = '';

  let search: HTMLInputElement | null = null;
  if (needsSearch(standard)) {
    search = doc.createElement('input');
    search.type = 'search';
    search.className = 'excel-value-dropdown-search';
    search.placeholder = '搜索取值…';
    search.setAttribute('aria-label', '搜索取值');
    panel.appendChild(search);
  }

  const list = doc.createElement('div');
  list.className = 'excel-value-dropdown-list';
  list.setAttribute('role', 'listbox');
  panel.appendChild(list);

  const editor = doc.createElement('div');
  editor.className = 'excel-value-dropdown-editor';
  editor.hidden = true;
  const editorInput = doc.createElement('input');
  editorInput.type = 'text';
  editorInput.className = 'excel-value-dropdown-input';
  editorInput.setAttribute('aria-label', '填写取值');
  const editorOk = doc.createElement('button');
  editorOk.type = 'button';
  editorOk.className = 'excel-value-dropdown-ok';
  editorOk.textContent = '确定';
  editor.append(editorInput, editorOk);
  panel.appendChild(editor);

  doc.body.appendChild(panel);

  let dead = false;

  function place(): void {
    const anchor = options.anchor;
    const width = Math.max(anchor.width || 0, 240);
    const height = panel.offsetHeight || 0;
    const below = win.innerHeight - (anchor.top + (anchor.height || 0));
    const above = anchor.top;
    const top = below < height + 12 && above > below
      ? Math.max(8, anchor.top - height - 4)
      : anchor.top + (anchor.height || 0) + 4;
    const left = anchor.left + width > win.innerWidth - 8
      ? Math.max(8, win.innerWidth - width - 8)
      : anchor.left;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.minWidth = `${width}px`;
  }

  function close(): void {
    if (dead) return;
    dead = true;
    panel.remove();
    doc.removeEventListener('pointerdown', onOutside, true);
    doc.removeEventListener('keydown', onKey, true);
    if (options.onClose) options.onClose();
  }

  function pick(value: string): void {
    close();
    options.onPick(value);
  }

  function render(): void {
    const query = search ? search.value : '';
    const visible = filterOptions(standard, query);
    list.textContent = '';
    // 当前值不在清单里 ⇒ **单独占一行并标成自定义**（保留原文，不推断成标准项）。
    if (custom && (!query || custom.value.toLowerCase().includes(query.trim().toLowerCase()))) {
      list.appendChild(item(custom.value, true, true));
    }
    for (const value of visible) {
      list.appendChild(item(value, value === current, false));
    }
    if (!visible.length && !(custom && !query)) {
      const empty = doc.createElement('div');
      empty.className = 'excel-value-dropdown-empty';
      empty.textContent = '没有匹配的取值';
      list.appendChild(empty);
    }
    if (allowCustom) {
      const own = doc.createElement('button');
      own.type = 'button';
      own.className = 'excel-value-dropdown-item is-own';
      own.dataset.value = customLabel;
      own.textContent = customLabel;
      own.onclick = event => {
        event.stopPropagation();
        editor.hidden = false;
        list.hidden = true;
        if (search) search.hidden = true;
        editorInput.value = '';
        editorInput.focus();
      };
      list.appendChild(own);
    }
  }

  function item(value: string, isCurrent: boolean, isCustom: boolean): HTMLButtonElement {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'excel-value-dropdown-item' + (isCustom ? ' is-custom' : '');
    button.dataset.value = value;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(isCurrent));
    const text = doc.createElement('span');
    // —— **显示名**（2026-10-29 用户口径：DD 显示「内内」）⇒
    //   **显示**用中文、**写回**仍是码（`data-value` 与 `pick()` 都是码）——
    //   算法按码表判，存中文就「不在码表里 ⇒ 不编」。
    const label = isCustom ? '' : String((options.optionLabels || {})[value] || '');
    text.textContent = isCustom ? `${value}（自定义）` : (label || value);
    if (label) button.title = value;
    button.appendChild(text);
    if (isCurrent) {
      const check = doc.createElement('span');
      check.className = 'excel-value-dropdown-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      button.appendChild(check);
    }
    button.onclick = event => {
      event.stopPropagation();
      pick(value);
    };
    return button;
  }

  function submitCustom(): void {
    const text = editorInput.value.trim();
    if (!text) { editorInput.focus(); return; }
    pick(text);
  }
  editorOk.onclick = event => {
    event.stopPropagation();
    submitCustom();
  };
  editorInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); submitCustom(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });

  if (search) {
    search.addEventListener('input', render);
    search.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === 'Enter') {
        event.preventDefault();
        const first = list.querySelector('.excel-value-dropdown-item') as HTMLButtonElement | null;
        if (first) first.click();
      }
    });
  }

  function onOutside(event: Event): void {
    if (panel.contains(event.target as Node)) return;
    close();
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || dead) return;
    event.preventDefault();
    // 捕获阶段先拦下 Esc ⇒ 只关下拉，**不连带关掉外层弹窗**。
    event.stopImmediatePropagation();
    close();
  }
  doc.addEventListener('pointerdown', onOutside, true);
  doc.addEventListener('keydown', onKey, true);
  panel.addEventListener('pointerdown', event => event.stopPropagation());

  render();
  place();
  place();
  if (search) search.focus();

  return {
    close,
    isOpen: () => !dead,
    searchInput: () => search,
    listed: () => Array.from(list.querySelectorAll('.excel-value-dropdown-item')).map(node => ({
      value: String((node as HTMLElement).dataset.value || ''),
      custom: (node as HTMLElement).classList.contains('is-custom'),
    })),
  };
}
