/**
 * Excel 域的下拉菜单（自绘）。
 *
 * 为什么不用原生 `<select>`：
 * 原生 select 的展开浮层是**浏览器画的**，位置由 Chrome 自己算 ——
 * 在 `<dialog>` 里它常常**向上弹**，盖住上面整片内容（用户 2026-10-20 11:18 反馈：
 * 「还是向上」）。那个方向**用 CSS 改不动**，原生 select 也不给方向开关。
 *
 * 自绘的好处：浮层就是普通 DOM，**`top:100%` ⇒ 永远在触发器下方**，方向自己说了算。
 *
 * 公共壳（`ui.dialog`、公共按钮、公共 toast）**一个字没动** ——
 * 公共壳里本来就没有下拉菜单组件，这里是 Excel 域自己的小控件。
 *
 * 行为（与 Excel 一致）：
 *  · 点触发器 → 浮层在**下方**展开；再点一次 → 收起
 *  · 选一项 → 触发器上显示新值、浮层收起
 *  · 点外面 / 按 Esc → 收起
 *  · ↑↓ 移动、Enter 选中、Home/End 跳到头尾（键盘可用）
 *  · 已选项打勾（`✓`），当前项高亮
 */

export interface DropdownOption {
  value: string;
  label: string;
  /** 选项前面的小色块（填充色那一栏用）。 */
  swatch?: string;
}

export interface DropdownHandle {
  /** 触发器所在的容器（`.excel-dropdown`）。 */
  root: HTMLElement;
  /** 触发器按钮。 */
  trigger: HTMLButtonElement;
  /** 当前值。 */
  value(): string;
  /** 设值（不触发回调）。 */
  set(value: string): void;
  /** 展开 / 收起。 */
  open(): void;
  close(): void;
  /** 浮层是否展开着。 */
  isOpen(): boolean;
}

let openDropdowns = 0;

/**
 * 当前有没有下拉正展开着。
 *
 * 公共弹窗（`tool-workspace.js`）在 document **捕获阶段**监听 Esc，命中就关掉整个弹窗。
 * 下拉展开时，用户按 Esc 的预期是「**关掉眼前这层**」（下拉），不是连弹窗一起关。
 * ⇒ 弹窗的 `onEscape` 钩子要问这个函数：有下拉开着就**不关弹窗**。
 */
export function hasOpenDropdown(): boolean {
  return openDropdowns > 0;
}

/** 关掉当前所有展开着的下拉（点外面 / Esc 时调）。 */
export function closeDropdowns(): void {
  for (const item of document.querySelectorAll<HTMLElement>('.excel-dropdown.is-open')) {
    item.classList.remove('is-open');
    const menu = item.querySelector<HTMLElement>('.excel-dropdown-menu');
    if (menu) { menu.hidden = true; menu.style.top = ''; menu.style.bottom = ''; menu.style.left = ''; }
    const trigger = item.querySelector<HTMLButtonElement>('.excel-dropdown-trigger');
    trigger?.setAttribute('aria-expanded', 'false');
    /* 清掉这个实例挂在 DOM 上的 Esc 捕获器（见 open() 里的说明） */
    const guard=(item as HTMLElement & {_excelEscGuard?:((e:KeyboardEvent)=>void)})._excelEscGuard;
    if(guard){document.removeEventListener('keydown',guard,true);delete (item as any)._excelEscGuard;}
  }
  openDropdowns = 0;
}

/**
 * 造一个下拉菜单。
 * @param options 档位
 * @param current  当前值（不在 options 里也可以，会补进去）
 * @param onPick   选中某项时回调
 */
export function createDropdown(
  options: DropdownOption[],
  current: string | null | undefined,
  onPick: (value: string) => void,
): DropdownHandle {
  const list = options.slice();
  if (current != null && !list.some(o => o.value === current)) {
    /* 当前值不在常用档位里：补进去（不能被悄悄改成别的值） */
    list.unshift({value: current, label: current});
  }
  let value = current ?? list[0]?.value ?? '';
  /** 展开期间的 Esc 捕获器（只收起下拉，不关弹窗）。 */
  let escGuard:((event:KeyboardEvent)=>void)|null=null;

  const root = document.createElement('div');
  root.className = 'excel-dropdown';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'excel-dropdown-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const triggerText = document.createElement('span');
  triggerText.className = 'excel-dropdown-value';
  const triggerIcon = document.createElement('span');
  triggerIcon.className = 'excel-dropdown-caret';
  triggerIcon.setAttribute('aria-hidden', 'true');
  triggerIcon.textContent = '▾';
  trigger.append(triggerText, triggerIcon);

  const menu = document.createElement('div');
  menu.className = 'excel-dropdown-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  /* 浮层用 **fixed** 定位到视口（不是 absolute）：
     弹窗的 main 是 `overflow:auto`，绝对定位的浮层会被它**裁掉**下半截。
     fixed 不受任何祖先 overflow 影响 —— 位置由 JS 按触发器的视口坐标算。 */

  const items: HTMLButtonElement[] = [];
  for (const option of list) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'excel-dropdown-item';
    item.setAttribute('role', 'option');
    item.dataset.value = option.value;
    if (option.swatch) {
      const swatch = document.createElement('span');
      swatch.className = 'excel-dropdown-swatch';
      swatch.style.background = option.swatch;
      swatch.setAttribute('aria-hidden', 'true');
      item.append(swatch);
    }
    const text = document.createElement('span');
    text.textContent = option.label;
    item.append(text);
    /* 选中的那项打勾 —— 勾是**只给当前项加的**元素，
       不是每项都放一个再藏起来（放一堆再藏，读屏仍会读出「✓」）。 */
    const check = document.createElement('span');
    check.className = 'excel-dropdown-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '✓';
    item.append(check);
    item.onclick = () => {
      value = option.value;
      sync();
      close();
      onPick(option.value);
    };
    items.push(item);
    menu.append(item);
  }

  function sync(): void {
    const picked = list.find(o => o.value === value);
    triggerText.textContent = picked?.label ?? String(value);
    for (const item of items) {
      const on = item.dataset.value === value;
      item.setAttribute('aria-selected', String(on));
      item.classList.toggle('is-current', on);
      /* 勾只给当前项 —— 其余项**不写这个字**，读屏就不会读出多余的「✓」 */
      const check = item.querySelector('.excel-dropdown-check');
      if (check) check.textContent = on ? '✓' : '';
    }
  }

  /** 把浮层摆到触发器正下方（视口坐标）。 */
  function place(): void {
    const rect = trigger.getBoundingClientRect();
    const height = menu.offsetHeight || 0;
    /* 默认在下方；**下方不够就翻到上方**（这时也是「贴着触发器」，
       不会像原生 select 那样浮到一半、盖住别的内容） */
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    if (below < height + 12 && above > below) {
      menu.style.top = 'auto';
      menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
      menu.classList.add('is-up');
    } else {
      menu.style.bottom = 'auto';
      menu.style.top = `${rect.bottom + 4}px`;
      menu.classList.remove('is-up');
    }
    /* 横向：贴着触发器左边；右边放不下就右对齐。
       宽度**跟触发器一样**（fixed 定位下 `min-width:100%` 会变成相对视口，
       那样浮层会拉满整个屏幕 —— 必须显式给宽度）。 */
    const width = Math.max(rect.width, menu.offsetWidth || 0);
    menu.style.width = `${width}px`;
    const left = rect.left + width > window.innerWidth - 8
      ? Math.max(8, window.innerWidth - width - 8)
      : rect.left;
    menu.style.left = `${left}px`;
  }

  function open(): void {
    closeDropdowns();
    menu.hidden = false;
    root.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    place();
    place();   // 量两次：第一次量出内容宽度，第二次按内容宽度定最终宽度
    openDropdowns += 1;
    /* ⚠️ Esc 的关键：公共弹窗（`tool-workspace.js`）在 **document 冒泡阶段**
       监听 Esc，命中就 `stopImmediatePropagation()` ＋ **关掉整个弹窗**。
       所以下拉展开时必须**在捕获阶段**先拦下 Esc —— 只收起下拉，弹窗留着。
       （用户操作时按 Esc 的预期是「关掉眼前这层」，不是连弹窗一起关。） */
    if(!escGuard){
      escGuard=(event:KeyboardEvent)=>{
        if(event.key!=='Escape'||!root.classList.contains('is-open'))return;
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      };
      document.addEventListener('keydown',escGuard,true);   // 捕获阶段
      (root as HTMLElement & {_excelEscGuard?:((e:KeyboardEvent)=>void)})._excelEscGuard=escGuard;
    }
  }
  function close(): void {
    menu.hidden = true;
    root.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    openDropdowns = Math.max(0, openDropdowns - 1);
    if(escGuard){document.removeEventListener('keydown',escGuard,true);escGuard=null;}
    delete (root as any)._excelEscGuard;
  }

  trigger.onclick = event => {
    event.stopPropagation();
    if (root.classList.contains('is-open')) close();
    else open();
  };
  /* 点菜单内部不触发「点外面关掉」 */
  menu.onclick = event => event.stopPropagation();
  /* 键盘：↑↓ 移动、Enter 选中、Esc 收起 */
  trigger.onkeydown = event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!root.classList.contains('is-open')) { open(); return; }
      const index = items.findIndex(item => item.classList.contains('is-current'));
      const next = event.key === 'ArrowDown'
        ? Math.min(items.length - 1, index + 1)
        : Math.max(0, index - 1);
      items[next]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!root.classList.contains('is-open')) open();
    } else if (event.key === 'Escape') {
      close();
    }
  };
  menu.onkeydown = event => {
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); items[Math.min(items.length - 1, index + 1)]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); items[Math.max(0, index - 1)]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); items[items.length - 1]?.focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus(); }
  };

  root.append(trigger, menu);
  sync();
  return {
    root, trigger,
    value: () => value,
    set: (next: string) => { value = next; sync(); },
    open, close,
    isOpen: () => root.classList.contains('is-open'),
  };
}


/* ——————— 鼠标位置的弹出菜单（右键菜单用） ——————— */

export type PopupMenuItem = {
  id: string;
  label: string;
  danger?: boolean;
  separatorBefore?: boolean;
};

/**
 * 在鼠标位置弹一个菜单（右键菜单）。
 * 与下拉共用「浮层用 fixed 定位 ＋ 点外面/Esc 关掉」那套，
 * 但位置是**鼠标那点**，不是触发器下面。
 */
export function openPopupMenu(
  x: number, y: number,
  items: PopupMenuItem[],
  onPick: (id: string) => void,
): void {
  closeDropdowns();
  const doc = document;
  const menu = doc.createElement('div');
  menu.className = 'excel-dropdown-menu excel-popup-menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item.separatorBefore) {
      const sep = doc.createElement('div');
      sep.className = 'excel-dropdown-separator';
      menu.appendChild(sep);
    }
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'excel-dropdown-item' + (item.danger ? ' is-danger' : '');
    button.setAttribute('role', 'menuitem');
    button.dataset.itemId = item.id;
    button.textContent = item.label;
    button.onclick = () => { close(); onPick(item.id); };
    menu.appendChild(button);
  }
  doc.body.appendChild(menu);
  /* 量出实际尺寸后再摆位置：默认贴着鼠标，右/下放不下就往左/上收。 */
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = x + width > window.innerWidth - 8 ? Math.max(8, x - width) : x;
  const top = y + height > window.innerHeight - 8 ? Math.max(8, y - height) : y;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.width = `${width}px`;

  const close = () => {
    menu.remove();
    doc.removeEventListener('click', onOutside, true);
    doc.removeEventListener('keydown', onKey, true);
  };
  const onOutside = (event: Event) => {
    if (!menu.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
  };
  /* 捕获阶段：Esc 要先于公共弹窗的处理（公共弹窗在捕获阶段监听 Esc） */
  doc.addEventListener('click', onOutside, true);
  doc.addEventListener('keydown', onKey, true);
}
