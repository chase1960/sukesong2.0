/**
 * 表格右键菜单的**定位判断**与**菜单项**（纯函数，好测）。
 *
 * 为什么不用 Univer 的原生右键菜单：`sheet.ts` 里 `contextMenu: false`
 * —— 原生菜单的命令**没有受管保存路径**（注释原话），
 * 所以关掉了；代价是用户右键没有任何入口，
 * **没法在列中间新建列、在行中间新建行**（用户 2026-10-20 11:35 原话：「右击还是没有办法」）。
 *
 * 这里的判断只用**两个固定偏移**：
 *  · 列头高 `COLUMN_HEADER_HEIGHT`（28px）—— 表头固定在顶部，不随滚动移动
 *  · 行号宽 `ROW_HEADER_WIDTH`（46px）—— 行号固定在左侧，不随滚动移动
 * 这两块是**钉死的**，所以按坐标判断可靠（内容区会滚动，不拿它做判断）。
 *
 * 菜单作用在哪一行/哪一列：**用当前选中**（`getSelection()`）——
 *  ① 列头/行号的点击是 Univer 原生行为（点一下就选中那列/那行），
 *     右键前用户已经选好了；
 *  ② 不用算滚动偏移 ⇒ 不会算错。
 *  （Excel 也是这个心智：先选中，再右键操作。）
 */

export const COLUMN_HEADER_HEIGHT = 28;
export const ROW_HEADER_WIDTH = 46;

/** 右键落在哪一块。 */
export type HitRegion = 'column-header' | 'row-header' | 'cell';

export type GridRect = { x: number; y: number; width: number; height: number };

/**
 * 右键点在哪一块。
 * @param x 鼠标的视口横坐标
 * @param y 鼠标的视口纵坐标
 * @param rect 网格容器的视口矩形
 */
export function hitRegion(x: number, y: number, rect: GridRect): HitRegion | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const left = x - rect.x;
  const top = y - rect.y;
  if (left < 0 || top < 0 || left > rect.width || top > rect.height) return null;
  if (top < COLUMN_HEADER_HEIGHT) return 'column-header';
  if (left < ROW_HEADER_WIDTH) return 'row-header';
  return 'cell';
}

export type MenuItem = {
  id: string;
  label: string;
  /** 破坏性动作（删列/删行）—— 弹之前要先确认。 */
  danger?: boolean;
  /** 动作之间用分隔线隔开。 */
  separatorBefore?: boolean;
};

/**
 * 「字段权限」这一项的菜单 id（列头右键 → 只对**已晋升**的列出现）。
 *
 * ⚠️ **结构权 ≠ 权限管理权**（PKG-117-T01）：这一项**不**受 `canStructure` 管 ——
 * 有结构权没权限权的人不该看见它，有权限权没结构权的人**照样**该看见它。
 */
export const COLUMN_FIELD_PERMISSIONS_ITEM = 'column_field_permissions';

/** 列头菜单的额外条件（谁能看见「字段权限」这一项）。 */
export type MenuOptions = {
  /** 当前账号能不能管理字段权限（`can_manage_field_permissions`）。 */
  canManageFieldPermissions?: boolean;
  /** 右键那一列是不是**已晋升**的列（未晋升的列没有字段权限可设）。 */
  columnPromoted?: boolean;
  /**
   * 这张表**能不能改行高**（行高是存在文件里的 ⇒ 业务表没有这条动作）。
   *
   * ⚠️ **「恢复自动行高」只在能改行高时出现** —— 摆出来点了只会报错。
   */
  canResetRowHeight?: boolean;
};

/**
 * 行号菜单里「**恢复自动行高**」这一项的 id。
 *
 * ⚠️ **为什么行高这一项要写明「影响本表所有人」**：
 *   行高**存在 xlsx 文件里** ⇒ 是**全表共享**的（不是个人视图）
 *   ⇒ 人点之前就得知道**别人也会看到**。
 */
export const ROW_AUTO_HEIGHT_ITEM = 'row_auto_height';

/**
 * 某个区域该有哪些菜单项。
 *
 * 列头：插在**左侧/右侧**、**字段权限**（只对已晋升的列出现）、删这一列
 * 行号：插在**上方/下方**、**恢复自动行高**（只对能改行高的表出现）、删这一行
 * 数据格：插在上方一行、插在左侧一列（最常用的两个）
 */
export function menuItemsFor(region: HitRegion, options: MenuOptions = {}): MenuItem[] {
  if (region === 'column-header') {
    const items: MenuItem[] = [
      {id: 'column_insert_left', label: '在左侧插入列'},
      {id: 'column_insert_right', label: '在右侧插入列'},
    ];
    if (options.canManageFieldPermissions && options.columnPromoted) {
      items.push({id: COLUMN_FIELD_PERMISSIONS_ITEM, label: '字段权限', separatorBefore: true});
    }
    items.push({id: 'column_delete', label: '删除此列', danger: true, separatorBefore: true});
    return items;
  }
  if (region === 'row-header') {
    const items: MenuItem[] = [
      {id: 'row_insert_above', label: '在上方插入行'},
      {id: 'row_insert_below', label: '在下方插入行'},
    ];
    // —— **恢复自动行高**（2026-10-29 用户口径：「再点一次自动行高」的回头路）——
    //   ⚠️ **行高存在表文件里** ⇒ **影响本表所有人** ⇒ 文案里写明。
    if (options.canResetRowHeight) {
      items.push({id: ROW_AUTO_HEIGHT_ITEM, label: '恢复自动行高（影响本表所有人）', separatorBefore: true});
    }
    items.push({id: 'row_delete', label: '删除此行', danger: true, separatorBefore: true});
    return items;
  }
  return [
    {id: 'row_insert_above', label: '在上方插入行'},
    {id: 'column_insert_left', label: '在左侧插入列', separatorBefore: true},
  ];
}

/**
 * 「在选中行上方 / 下方插入行」——**这条新行插到谁前面**。
 *
 * ⚠️ **为什么单独立一个函数**（2026-10-29 用户口径：「也要能在中间加行」）：
 *   原来右键菜单直接拿 `indexToName.get(那一行)` 当锚点 ——
 *   **那一行没从服务器加载出来时拿到的是空**（翻页、末尾空行都会这样），
 *   而「插在空锚点前面」＝ **插到表的末尾** ⇒
 *   人明明点了「在第 5 行下面插一行」，新行却跑到了**表的最底下**，
 *   而且**一声不响**（没有报错、没有提示）。
 * ⇒ 现在把「插到哪儿」这件事单独算清楚，三种结果只有三种：
 *   · `before` —— 插到**某一行的前面**（那一行有身份）
 *   · `end`    —— 插到**表的末尾**（目标本来就在表外，这是对的）
 *   · `unknown`—— **拿不到那一行的身份** ⇒ 调用方**必须报错**，
 *                  **不许**悄悄退化成 `end`（那正是原来那个毛病）。
 *
 * @param direction 'above' ＝ 插在选中行**上面**；'below' ＝ 插在选中行**下面**
 * @param selectedIndex 选中行的显示序号（0 基；第 1 行数据 = 0）
 * @param totalRows 表里**真实**的行数（末尾之外的空行不算）
 * @param idAt 按显示序号取那一行的固定身份；取不到（没加载）＝ 返回空
 */
export type RowInsertAnchor =
  | { kind: 'before'; beforeRowId: string }
  | { kind: 'end' }
  | { kind: 'unknown' };

export function resolveRowInsertAnchor(options: {
  direction: 'above' | 'below';
  selectedIndex: number;
  totalRows: number;
  idAt: (index: number) => string | undefined;
}): RowInsertAnchor {
  const index = options.direction === 'above' ? options.selectedIndex : options.selectedIndex + 1;
  // 目标在表的末尾之外 ⇒ 插到末尾（这是对的，不是退化）。
  if (index >= options.totalRows) return { kind: 'end' };
  const id = options.idAt(index);
  if (!id) return { kind: 'unknown' };
  return { kind: 'before', beforeRowId: id };
}
