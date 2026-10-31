/**
 * **长按列头 ⇒ 拖动 ⇒ 把那一列挪到某个位置**（2026-10-29 用户口径）。
 *
 * ⚠️ **为什么要有这个**：原来挪一列只有「行列操作」那个弹窗（要**填目标列名**）
 *   ⇒ 要把 24 列挪到前头 ⇒ 23 次开窗填名 ⇒ 人做不动。
 *   ⇒ 这里给一条直观的路：**按住列头 ⇒ 拖 ⇒ 松手**。
 *
 * ⚠️ **跟「双击改列名」不打架**（`header-rename.ts` 走 `dblclick`）：
 *   这里要**按住 ≥ 阈值**才动 ⇒ 单击、双击各走各的。
 *
 * ⚠️ **落点怎么算**：拖到哪一列头上 ⇒ **插到那一列前面**（`before_header` ＝ 那列）。
 *   ⇒ 拖到最后一张列头 ⇒ 插到末尾（`before_header` 空）。
 *   ⇒ 拖回**自己原来那一列** ⇒ **不挪**（没意义、白改一次结构版本）。
 *
 * ⚠️ **这一层只管手势**：**挪列的动作是调用方给的**（`onMove`）⇒
 *   本件**不碰任何数据、不自己发请求**。
 *   ⚠️ **挪列写的是「我的个人视图」（2026-10-29 撤掉那条自造管线）**：
 *   原来这里接的是产品那条 `files.sheet_column_move` ⇒ **物理改写 xlsx 的列**
 *   ⇒ 改的是**全表**（用户原话：「你拖了别人也跟着变」）。
 *   ⇒ 现在走 `files.sheet_view_save`（按人隔离）⇒ **只影响我**，**不碰文件本身**。
 */

/** 按住多久才算「长按」（毫秒）。太短会跟单击/双击撞；太长会让人以为没反应。 */
export const LONG_PRESS_MS = 350;

/**
 * 列头**边上**这么宽的一条带子算「改列宽的手柄」（像素）。
 *
 * ⚠️ **为什么单独算一条带子**（用户 2026-10-29 15:0x 报「不能调列宽」）：
 *   Excel 里**拖列头最边上那几像素**＝改列宽；**按住列头中间**＝选整列/拖动。
 *   Univer 的列宽手柄就长在那个边上 ⇒ 我们的手势必须**让开那一条**。
 *
 * ⚠️ **为什么不能让开太多**：让开太多 ⇒「按住列头中间」也会去改列宽 ⇒ 挪列就没法按了。
 *   ⇒ 这条带子**窄一点**（8px），够抓住手柄就行。
 */
export const WIDTH_HANDLE_ZONE_PX = 8;

/** 拖动时**移动超过这个像素**就算「在拖」⇒ 长按计时作废（那是滚动/误触，不是想拖）。 */
const MOVE_TOLERANCE_PX = 6;

/**
 * 指针离左右边缘这么近（像素）就**自动横向滑动**（把整张表带着走）。
 *
 * ⚠️ **为什么要有**（用户 2026-10-29 15:3x 原话：「我把我司案号拖到最左列，
 *   但它在最右边，就会导致拖不过来」）：列多的时候，最右边那一列**根本拖不到最左边**
 *   —— 鼠标到边就出界了 ⇒ 只能先横向滚过去再拖。
 *   ⇒ 拖到边上 ⇒ **表自己横向滑** ⇒ 一路拖到底。
 */
export const EDGE_SCROLL_ZONE_PX = 64;
/** 两次自动滑动之间至少隔这么久（免得滚太快）。 */
const EDGE_SCROLL_INTERVAL_MS = 120;

/**
 * 把那一列挪到新位置后的**新列序**（纯函数，好测）。
 *
 * @param order 现在的列序（按列名）
 * @param header 正在挪的那一列
 * @param beforeHeader 它要插到哪一列前面（空 ＝ 末尾）
 */
export function reorderByMove(order: string[], header: string, beforeHeader: string): string[] {
  if (!order.includes(header)) return order;
  const rest = order.filter(id => id !== header);
  const at = beforeHeader ? rest.indexOf(beforeHeader) : rest.length;
  if (at < 0) return order;
  return [...rest.slice(0, at), header, ...rest.slice(at)];
}

export interface ColumnDragTarget {
  colIndex: number;
  rect: { left: number; top: number; width: number; height: number };
}

export interface ColumnDragOptions {
  /** 鼠标在某点 ⇒ 命中哪个列头（**没命中返回 null**）。 */
  locate(x: number, y: number): ColumnDragTarget | null;
  /** 某列的列头矩形（画拖动影子用）。 */
  headerAt(colIndex: number): ColumnDragTarget | null;
  /** 当前这一张表的列名（按列序）。 */
  headers(): string[];
  /** 现在许不许挪（保存中／没写权 ⇒ 不许）。 */
  canDrag?(): boolean;
  /** 挪列（调用方去调产品的动作）。 */
  onMove(header: string, before: string): Promise<unknown>;
  /**
   * **落点变了就说一声**（上层据此在画布上**先挪给用户看**）。
   * @param header 正在挪的那一列
   * @param before 它要插到哪一列前面（空 ＝ 末尾）
   */
  onPreview?(header: string, before: string): void;
  /** **拖被取消了**（按 Esc）⇒ 上层把画布上的预览挪回原位。 */
  onCancel?(): void;
  /**
   * **拖到左右边缘 ⇒ 自动横向滑动**（用户 2026-10-29 15:3x：
   * 「我把我司案号拖到最左列，但它在最右边，就会导致拖不过来」）。
   *
   * @param direction -1 ＝ 往左滑；1 ＝ 往右滑
   * @param hoveredIndex 指针现在指着的那一列（序号）
   */
  onEdgeScroll?(direction: -1 | 1, hoveredIndex: number): void;
  /** 每次挪列给一个操作编号（幂等/撤回用）。 */
  newKey(): string;
  /** **开始拖了**（调用方可以先把会动的提示藏起来）。 */
  onDragStart?(): void;
  /** **拖完了**（调用方把提示画回来）。 */
  onDragEnd?(): void;
  /** 长按阈值（判据里要能调）。 */
  longPressMs?: number;
}

export interface ColumnDragHandle {
  /** 现在是不是在拖。 */
  isDragging(): boolean;
  /** 当前拖动落在哪一列前面（-1 ＝ 末尾；没在拖 ＝ -2）。 */
  dropBefore(): number;
  /** 主动取消（Esc／外部调用）。 */
  cancel(): void;
  dispose(): void;
}

export function mountColumnDrag(host: HTMLElement, options: ColumnDragOptions): ColumnDragHandle {
  const doc = host.ownerDocument;
  const win = doc.defaultView || window;
  const longPressMs = options.longPressMs ?? LONG_PRESS_MS;

  // —— 拖动时画的那个影子（跟着鼠标走）＋ 落点指示 ——
  const ghost = doc.createElement('div');
  ghost.className = 'excel-column-drag-ghost';
  ghost.hidden = true;
  const marker = doc.createElement('div');
  marker.className = 'excel-column-drop-marker';
  marker.hidden = true;
  host.append(ghost, marker);

  let timer: any = null;
  let dragging = false;
  let cancelled = false;
  let pressed: ColumnDragTarget | null = null;
  let pressX = 0;
  let pressY = 0;
  let dropBefore = -2;   // -1 ＝ 末尾；-2 ＝ 没在拖
  let dead = false;
  /** **提示（角标）是不是被我们藏起来了**（按下时藏、松手时画回）。 */
  let hinted = false;

  function clearTimer() {
    if (timer !== null) { win.clearTimeout(timer); timer = null; }
  }

  function hideIndicators() {
    ghost.hidden = true;
    marker.hidden = true;
  }

  /**
   * 这次按下是不是**按在「改列宽的手柄」上**（列头最边上那几条像素）。
   *
   * ⚠️ **为什么必须分出来**（用户 2026-10-29 15:0x 报「不能调列宽」）：
   *   下面 `onDown` 为了挡住 Univer 的原生拖列，会**掐断整个列头带子**上的按下
   *   ⇒ 而**改列宽的手柄就长在列头的边上** ⇒ 那一带也被掐 ⇒ **列宽永远拖不动**。
   *   ⇒ 手柄那一带**放行**（让 Univer 去做改列宽），其余照旧掐断。
   *
   * ⚠️ **命中的是「右边那一列」**：按在 A/B 的边界上时，命中的是 **B 的左边**
   *   （＝ A 的右边 ＝ 那个手柄）⇒ 所以**左边那一圈也要算手柄**。
   */
  function onWidthHandle(clientX: number, found: ColumnDragTarget): boolean {
    const hostRect = host.getBoundingClientRect();
    const localX = clientX - hostRect.left;      // 列头矩形是**宿主坐标**，按下的点是视口坐标
    const left = found.rect.left;
    const right = left + found.rect.width;
    if (localX <= left + WIDTH_HANDLE_ZONE_PX) return true;      // 上一列的右边＝本列左边＝手柄
    if (localX >= right - WIDTH_HANDLE_ZONE_PX) return true;      // 本列的右边＝手柄
    return false;
  }

  function onDown(event: PointerEvent) {
    if (dead || dragging || event.button !== 0) return;
    if (options.canDrag && !options.canDrag()) return;
    const found = options.locate(event.clientX, event.clientY);
    if (!found) return;
    // ⚠️ **按在改列宽的手柄上 ⇒ 放行**（不掐断、不起长按计时）
    //   ⇒ Univer 收得到这个按下 ⇒ **列宽拖得动**。
    if (onWidthHandle(event.clientX, found)) return;
    pressed = found;
    pressX = event.clientX;
    pressY = event.clientY;
    cancelled = false;
    // —— **按在列头上就把会动的提示藏起来**（2026-10-29 · 用户报「锁图标会跟着鼠标走」）——
    //   ⚠️ **不等长按成立**：Univer **自己也会拖列**（一按就启动它的预览）
    //   ⇒ 等长按成立才藏的话，**Univer 的预览早就在跑了、角标早乱跑了**。
    //   ⇒ **一按就藏**（不管最后是谁在拖）⇒ 拖动期间看不见那些会动的角标。
    //   ⇒ **松手时画回来**（那时列序已经定了，位置是对的）。
    hinted = true;
    options.onDragStart?.();
    // —— **不让 Univer 的原生拖列启动**（2026-10-29）——
    //   Univer 拖列**只改画布、不落库**（刷新就恢复）⇒ 它跟我们要的「挪列要存下来」是两件事；
    //   而且**它一拖，画布的列序就跟表定义序对不上** ⇒ 受管角标（按定义序定位的）就跟着错位
    //   （用户看到的「锁图案跟着鼠标走到别的位置」就是这个）。
    //   ⇒ **只在「按在列头上」的时候**把它挡在 canvas 之外 ⇒ 列头这一块**只有我们这一套**：
    //   长按 ⇒ 我们的拖动（落库）；双击 ⇒ 改列名（不依赖 pointerdown 的传播）。
    //   ⚠️ **只挡列头**：按在**格子**上（没命中列头）⇒ 事件照常到 canvas
    //   ⇒ **选格子、双击改列名都不受影响**。
    //   ⚠️ **代价**：点列头「选整列」这个 Univer 自带的小功能没了 —— 我们产品不用它
    //   （选区是按单元格来的），少一个没人用的功能比两个拖动打架划算。
    event.stopImmediatePropagation();
    clearTimer();
    timer = win.setTimeout(() => {
      timer = null;
      // —— **到点了还没动 ⇒ 进拖动态** ——
      // —— 已经在拖了（人按住就拖 ⇒ 提前接管了）⇒ 计时器这一下什么都不用做。
      if (dead || cancelled || dragging || !pressed) return;
      dragging = true;
      dropBefore = -1;
      showGhost(pressed, pressX, pressY);
      updateMarker(pressX, pressY);
    }, longPressMs);
  }

  function showGhost(target: ColumnDragTarget, clientX: number, clientY: number) {
    const rect = target.rect;
    ghost.hidden = false;
    ghost.textContent = (options.headers()[target.colIndex] || '');
    // ⚠️ **指针给的是「页面坐标」，残影是按「宿主坐标」摆的**（它是宿主的子元素）
    //   ⇒ **不减掉宿主在页面里的位置，残影就永远偏一段**（偏到格子中间去了 ——
    //   用户 2026-10-29 15:0x 报的「为什么是这个样子的」就是它）。
    const hostRect = host.getBoundingClientRect();
    Object.assign(ghost.style, {
      left: (clientX - hostRect.left - rect.width / 2) + 'px',
      top: (clientY - hostRect.top - rect.height / 2) + 'px',
      width: Math.max(32, rect.width) + 'px',
      height: rect.height + 'px',
    });
  }

  /**
   * 落点算成「**插到第几列前面**」。
   *
   * ⚠️ **左半边 / 右半边分**（Excel 的手感 —— 用户 2026-10-29 15:0x：
   *   「以前那种挪动就很自然」）：· 指针在那一列的**左半边** ⇒ 插到**它前面**；
   *   · 指针在那一列的**右半边** ⇒ 插到**它后面**；· 拖过所有列 ⇒ 落到**末尾**。
   *   以前只有一条规则（一律插到那一列前面）⇒ 往右拖时列却跑到了左边 ⇒ 看着别扭。
   */
  function updateMarker(x: number, y: number) {
    // ⚠️ **y 必须用指针的真实位置**（列头在画布顶部那一条带子上，y≈200）——
    //   早先这里写死 0／10 ⇒ `locate` 永远命中不了 ⇒ **落点永远算不出来**
    //   ⇒ 每一次拖动都变成「挪到末尾」⇒ 「挪走了却挪不回来」。
    const found = options.locate(x, y);
    const headers = options.headers();
    if (!found) { marker.hidden = true; dropBefore = -1; return; }
    const index = found.colIndex;
    // —— 拖回**自己原来那一列** ⇒ 不挪（落点＝自己 ⇒ 没有变化）——
    if (pressed && index === pressed.colIndex) {
      marker.hidden = true;
      dropBefore = -2;
      return;
    }
    // —— **左半边 ⇒ 插它前面；右半边 ⇒ 插它后面**（Excel 的规则）——
    const hostRect = host.getBoundingClientRect();
    const localX = x - hostRect.left;      // 指针换算成宿主坐标（列头矩形也是宿主坐标）
    const center = found.rect.left + found.rect.width / 2;
    const after = localX > center;
    const insertIndex = after ? index + 1 : index;
    dropBefore = insertIndex;
    marker.hidden = false;
    Object.assign(marker.style, {
      left: (after ? found.rect.left + found.rect.width : found.rect.left) + 'px',
      top: found.rect.top + 'px',
      width: '2px',
      height: found.rect.height + 'px',
    });
    // —— **落点变了就说一声**（上层据此在画布上**先挪给用户看**）——
    const header = pressed ? (headers[pressed.colIndex] || '') : '';
    const beforeHeader = insertIndex < headers.length ? (headers[insertIndex] || '') : '';
    options.onPreview?.(header, beforeHeader);
  }

  function onMove(event: PointerEvent) {
    if (dead) return;
    lastPointerY = event.clientY;
    if (!dragging) {
      // —— 还没进拖动态 ——
      if (!pressed) return;
      // 小抖动（手没稳）⇒ 继续等长按。
      const shifted = Math.abs(event.clientX - pressX) > MOVE_TOLERANCE_PX
        || Math.abs(event.clientY - pressY) > MOVE_TOLERANCE_PX;
      if (!shifted) return;
      // —— **人已经拖起来了 ⇒ 立刻接管** ——
      //   ⚠️ 原来这里是「**长按计时作废**」⇒ 人**按住列头马上拖**（最自然、最常见的动作）
      //   反而拖不动 —— 必须是「按住**不动** 350 毫秒、然后再拖」才认
      //   （用户 2026-10-29 15:0x 原话：「挪列我这边还不行」）。
      //   ⇒ 现在：**一动就接管**；「按住不动 350 毫秒」是**另一条**进拖动态的路（两条都留）。
      dragging = true;
      dropBefore = -1;
      showGhost(pressed, pressX, pressY);
      updateMarker(event.clientX, event.clientY);
    }
    event.preventDefault();
    // ⚠️ **长按接管之后，事件不许再往 canvas 传** ——
    //   Univer **自己也会拖列**（`_dragHeaderMove` 订阅 `onPointerMove$`）⇒
    //   两套拖动同时跑 ⇒ Univer 的预览跟着鼠标走、跟我的影子叠在一起
    //   （用户看到的「锁图标跟着鼠标走到别的位置」就是它）⇒ **接管了就断掉它**。
    event.stopImmediatePropagation();
    if (pressed) showGhost(pressed, event.clientX, event.clientY);
    updateMarker(event.clientX, event.clientY);
    edgeScroll(event.clientX);
  }

  /** 指针靠近左右边缘 ⇒ **表自己横向滑**（列多时才拖得过去）。 */
  function edgeScroll(clientX: number) {
    if (!options.onEdgeScroll) return;
    const rect = host.getBoundingClientRect();
    if (!rect.width) return;
    let direction: -1 | 1 = 0 as -1 | 1;
    if (clientX - rect.left <= EDGE_SCROLL_ZONE_PX) direction = -1;
    else if (rect.right - clientX <= EDGE_SCROLL_ZONE_PX) direction = 1;
    if (!direction) return;
    const now = Date.now();
    if (now - lastEdgeScroll < EDGE_SCROLL_INTERVAL_MS) return;
    lastEdgeScroll = now;
    const found = options.locate(clientX, lastPointerY);
    options.onEdgeScroll(direction, found ? found.colIndex : 0);
  }
  let lastEdgeScroll = 0;
  let lastPointerY = 0;

  async function onUp(event: PointerEvent) {
    if (dead) return;
    clearTimer();
    // —— **按过列头 ⇒ 松手时把提示画回来**（哪怕最终是 Univer 在拖、不是我们）——
    //   ⚠️ 用 `hinted` 记（不靠 `pressed` —— 指针一动 `pressed` 就被清了）。
    if (hinted) { hinted = false; options.onDragEnd?.(); }
    if (!dragging) {
      // —— **没进拖动态就松手**（点了一下列头）⇒ 什么也没发生 ⇒
      //   **也要把预览状态清掉**（不然页面一直以为「有未保存修改」⇒
      //   后面粘贴／打字／下拉**全被拒** ⇒ 整张表像坏了。
      //   （真事故：2026-10-29 15:2x 用户挪完列之后整张表写不进去了。）
      options.onCancel?.();
      pressed = null; return;
    }
    // —— 接管期间，事件也不许再往 canvas 传（Univer 的原生拖列到此为止）。 ——
    event.preventDefault();
    event.stopImmediatePropagation();
    dragging = false;
    hideIndicators();
    const target = pressed;
    const before = dropBefore;
    pressed = null;
    dropBefore = -2;
    if (!target || before === -2) {
      // —— 落点＝自己 ⇒ 不挪 ⇒ 预览作废 ⇒ **状态必须复位**（否则整张表被冻住）。
      options.onCancel?.();
      return;
    }
    const headers = options.headers();
    const header = headers[target.colIndex];
    if (!header) return;
    const beforeHeader = before === -1 ? '' : (headers[before] || '');
    if (beforeHeader === header) return;
    try {
      await options.onMove(header, beforeHeader);
    } catch {
      /* —— 挪不动就把影子收掉；错由调用方那边提示（这里不另弹一次）。 —— */
    }
  }

  function onKey(event: KeyboardEvent) {
    if (event.key !== 'Escape' || (!dragging && !hinted)) return;
    event.preventDefault();
    cancelled = true;
    // —— **取消了 ⇒ 上层把画布上的预览挪回原位** ——
    options.onCancel?.();
    clearTimer();
    dragging = false;
    hideIndicators();
    if (hinted) { hinted = false; options.onDragEnd?.(); }
    pressed = null;
    dropBefore = -2;
  }

  host.addEventListener('pointerdown', onDown as EventListener, true);
  doc.addEventListener('pointermove', onMove as EventListener, true);
  doc.addEventListener('pointerup', onUp as unknown as EventListener, true);
  doc.addEventListener('keydown', onKey as EventListener, true);

  return {
    isDragging: () => dragging,
    dropBefore: () => dropBefore,
    cancel() {
      cancelled = true;
      options.onCancel?.();
      clearTimer();
      dragging = false;
      hideIndicators();
      if (hinted) { hinted = false; options.onDragEnd?.(); }
      pressed = null;
      dropBefore = -2;
    },
    dispose() {
      dead = true;
      clearTimer();
      dragging = false;
      hideIndicators();
      if (hinted) { hinted = false; options.onDragEnd?.(); }
      host.removeEventListener('pointerdown', onDown as EventListener, true);
      doc.removeEventListener('pointermove', onMove as EventListener, true);
      doc.removeEventListener('pointerup', onUp as unknown as EventListener, true);
      doc.removeEventListener('keydown', onKey as EventListener, true);
      ghost.remove();
      marker.remove();
    },
  };
}
