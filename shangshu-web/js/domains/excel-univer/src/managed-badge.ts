/**
 * 受管记录的**常驻标识**（列头角标）。
 *
 * **为什么要有**（PKG-004-T03 第 4 步）：晋升过的列，值**存在受管记录里**
 * （不只是存在这个 Excel 文件里）。界面上要**看得出**「这一列背后是受管记录」——
 * 否则两个人改同一格、另一个人的改动已经落库，**界面上一点提示都没有**。
 *
 * **怎么摆**（2026-10-21 改版，用户：「受管有点丑，美化一下」＋「做一个小徽标吧，svg的」）：
 * 改前是一颗**写着「受管」两个字的文字 chip**（淡紫底＋描边），压在列名上 —— 像贴纸。
 * 改后是**一颗 SVG 小徽标**（锁形，跟仓库现有图标同一套画法：
 * `viewBox="0 0 24 24" fill="none" stroke="currentColor"`），
 * 安静、不抢标题、跟随主题色；**含义靠提示**（title / aria-label）说清。
 *
 * **不压标题**：列头**左端留一个固定小槽**（`MANAGED_BADGE_SLOT`）给徽标，
 * 标题从槽右边开始 ⇒ 徽标矩形与列头文字矩形**不重叠**（判据里有几何断言）。
 * ⚠️ 列名是 Univer 画在**画布**上的，域里量不到它的矩形 ⇒ 契约定成
 *   「**左端固定小槽**」而不是「量出标题再躲开」—— 槽是**留出来**的，不是抢来的。
 *
 * **边界**（不许越界）：
 *  · 角标**不拦点击**（`pointer-events:none`）—— 列头该点还是点得到；
 *  · 角标**只是提示**：不决定「存哪儿」、不让用户选存储位置（契约 §1「工具自动路由」）；
 *  · **普通列没有角标**（不制造「这一列不一样」的错觉）。
 *
 * ⚠️ **样式为什么写在行内**（不是域 CSS）：域产物（11MB 那份）是**构建产物**，
 * 浮层与徽标自己带样式，改完源码由主控按 `npm run build` 重建产物。
 */

/** 徽标的**无障碍名**（徽标本身不写字，这两个字给读屏与提示用）。 */
export const MANAGED_BADGE_TEXT = '受管';

/** 徽标的提示（说人话：这一列的值存在哪儿、为什么要知道）。 */
export const MANAGED_BADGE_TITLE = '这一列的值存在受管记录里 —— 两个人改同一格会互相看得见，改动不会只停在这个文件里';

/** 徽标边长（像素）。小一点，安静一点。 */
export const MANAGED_BADGE_SIZE = 13;

/** 列头**左端留给徽标的固定小槽**（像素）—— 标题从这条槽的右边开始。 */
export const MANAGED_BADGE_SLOT = 20;

/** 徽标的图形（跟仓库现有图标同一套画法：`ic()` 就是这么画的）。 */
export const MANAGED_BADGE_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<rect x="5" y="10.5" width="14" height="9.5" rx="1.8"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>';

/** 列头矩形（宿主坐标）。 */
export interface HeaderRect { left: number; top: number; width: number; height: number }

/** 画角标要用的那一套坐标（跟列头筛选同款：问网格要列头矩形）。 */
export interface ManagedBadgeFrame {
  clip: { left: number; top: number; width: number; height: number };
  headerRect(colIndex: number): HeaderRect | null;
}

export interface ManagedBadgeOptions {
  frame(): ManagedBadgeFrame | null;
  /** 当前表的列（数组下标 = 列在表里的位置）。 */
  columns(): Array<{ id: string; label?: string }>;
  /** 哪些列背后是受管记录（表头名集合）。 */
  managed(): Set<string>;
}

/**
 * 角标摆在列头的哪个位置（**左端的小槽里**、竖直居中）。
 *
 * **纯算式**（好测）：左端 ⇒ 跟右端那颗小漏斗不重叠；
 * 槽宽 `MANAGED_BADGE_SLOT` ⇒ 标题从槽右边开始，徽标**不压字**。
 */
export function placeManagedBadge(rect: HeaderRect): { left: number; top: number; width: number; height: number } {
  return {
    left: Math.round(rect.left + 3),
    top: Math.round(rect.top + Math.max(0, (rect.height - MANAGED_BADGE_SIZE) / 2)),
    width: MANAGED_BADGE_SIZE,
    height: MANAGED_BADGE_SIZE,
  };
}

/**
 * 列头**文字矩形**（标题从左端小槽的右边开始）。
 *
 * 列名画在画布上、域里量不到 ⇒ 这里给的是**契约**：标题区＝列头去掉左端小槽。
 * 判据拿它跟徽标矩形比，保证两者**不重叠**。
 */
export function headerTextRect(rect: HeaderRect): { left: number; top: number; width: number; height: number } {
  const slot = Math.min(MANAGED_BADGE_SLOT, Math.max(0, rect.width - 1));
  return { left: rect.left + slot, top: rect.top, width: Math.max(0, rect.width - slot), height: rect.height };
}

export function mountManagedBadges(host: HTMLElement, options: ManagedBadgeOptions) {
  const doc = host.ownerDocument, win = doc.defaultView!;
  const layer = doc.createElement('div');
  layer.className = 'excel-managed-badge-layer';
  layer.setAttribute('aria-label', '受管列标记');
  /* 浮层自己定位：铺满网格、**不拦点击**（角标只是提示）。 */
  Object.assign(layer.style, {
    position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '13',
  });
  host.appendChild(layer);
  const badges = new Map<string, HTMLElement>();
  let dead = false;
  let frameId: number | null = null;

  function create(column: { id: string; label?: string }) {
    const badge = doc.createElement('span');
    badge.className = 'excel-managed-badge';
    badge.innerHTML = MANAGED_BADGE_SVG;
    badge.title = `「${column.label || column.id}」${MANAGED_BADGE_TITLE}`;
    badge.setAttribute('aria-label', `列「${column.label || column.id}」${MANAGED_BADGE_TITLE}`);
    badge.setAttribute('role', 'img');
    /* 样式克制：只描线、跟随主题色、安静 —— 原来的淡紫底＋描边像贴纸。 */
    Object.assign(badge.style, {
      position: 'absolute', boxSizing: 'border-box', margin: '0',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      color: 'currentColor', opacity: '.55',
      pointerEvents: 'none', userSelect: 'none', overflow: 'hidden',
    });
    layer.appendChild(badge);
    return badge;
  }

  function paint() {
    if (dead) return;
    const frame = options.frame();
    layer.hidden = !frame;
    if (!frame) return;
    const managed = options.managed();
    const wanted = new Set<string>();
    options.columns().forEach((column, index) => {
      if (!managed.has(column.id)) return;
      const rect = frame.headerRect(index);
      if (!rect) return;
      wanted.add(column.id);
      const badge = badges.get(column.id) ?? create(column);
      badges.set(column.id, badge);
      const place = placeManagedBadge(rect);
      Object.assign(badge.style, {
        left: place.left + 'px', top: place.top + 'px',
        width: place.width + 'px', height: place.height + 'px',
      });
    });
    for (const [id, badge] of badges) if (!wanted.has(id)) { badge.remove(); badges.delete(id); }
  }

  const raf = (callback: () => void) => win.requestAnimationFrame
    ? win.requestAnimationFrame(callback) : win.setTimeout(callback, 0);
  function queue() {
    if (!dead && frameId === null) frameId = raf(() => { frameId = null; paint(); });
  }

  queue();
  return {
    refresh: queue,
    paint,
    /**
     * **拖动列的时候把角标藏起来**（2026-10-29 · 用户报「受管列的锁图案会跟着鼠标走」）。
     *
     * ⚠️ **为什么**：拖动时列的**视觉位置在变**（预览），而角标的位置是**算出来**的
     *   （`frame().headerRect(index)`）⇒ 它只在**布局变化**时重画 ⇒ 拖动途中它停在旧位置
     *   ⇒ 看起来「跟着鼠标跑到别的列上去了」。
     * ⇒ **拖动期间藏起来**（那一列本来就是乱的）⇒ **松手、结构定下来之后**再画回来。
     */
    setVisible(visible: boolean) {
      if (dead) return;
      layer.hidden = !visible;
      if (visible) paint();
    },
    dispose() {
      dead = true;
      if (frameId !== null) {
        if (win.cancelAnimationFrame) win.cancelAnimationFrame(frameId); else win.clearTimeout(frameId);
        frameId = null;
      }
      layer.remove();
      badges.clear();
    },
  };
}
