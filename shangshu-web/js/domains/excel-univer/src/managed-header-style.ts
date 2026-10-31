/**
 * **受管列的列头样式**（2026-10-29 · 用户口径）。
 *
 * ⚠️ **为什么改成「列头自己的样式」而不是那个 svg 浮层**（用户 2026-10-29 原话
 *   「受管列就不要 svg 了，直接把列头加粗变成灰色就行了」＋「backgroundColor 也行」
 *   ＋「**变绿色嘛**」＋「**白字绿底**」）：
 *   · 原来那层浮层（`managed-badge.ts`）的位置是**算出来的**（按列索引去问网格要列头矩形）
 *     ⇒ **拖列 / 横向滚动 / 换表**时就跟画布对不上
 *     ⇒ 用户看到「**受管列的锁图案跟着鼠标走到别的位置**」（2026-10-29 站上实测）。
 *   · 列头文字是 **Univer 画在画布上**的 ⇒ 给它**样式**（颜色／字号／底色）
 *     ⇒ **跟着列走** ⇒ **不会再跑**。
 *
 * ⚠️ **最终口径：白字绿底**（＝产品的 `--green` 底 ＋ 白字，
 *   与「主按钮／选中态」**同一套** ⇒ 一眼认得出，也不像错误提示）。
 *
 * ⚠️ **为什么不是真「加粗」**：Univer 的列头样式**没有粗细字段**
 *   （`IHeaderStyleCfg`：fontFamily／fontColor／fontSize／borderColor／textAlign／
 *   textBaseline／backgroundColor／size）⇒ 用「**字号更大**」做出「更重」的观感，
 *   **不新造一个 Univer 不支持的粗体**（宁可少一个效果，也不编一个假的）。
 */

/** 受管列的**字色**（＝白字，与产品的「绿底按钮」同一套）。 */
export const MANAGED_HEADER_FONT_COLOR = '#FFFFFF';

/** 受管列的**字号**（比普通列大一号 ⇒ 看起来更重）。 */
export const MANAGED_HEADER_FONT_SIZE = 13;

/** 受管列的**底色**（＝产品的 `--green` 主绿）。 */
export const MANAGED_HEADER_BACKGROUND = '#10B981';

/**
 * **必填列的列头标记**（2026-10-29 用户口径：
 * 「把案号所需要的列列成必填，不允许空着」⇒ 那一列的**列头上要有看得见的标记**）。
 *
 * ⚠️ **为什么是「末尾一颗星」**（而不是「（必填）」那种长文案）：
 *   列头画在画布上、**宽度就那么点**（默认 88px）⇒ 长文案会被**裁掉**（Univer 按格宽裁剪）
 *   ⇒ 标记必须是**短**的。一颗星是表单里「必填」的通用记号。
 */
export const REQUIRED_HEADER_MARK = '*';

/**
 * **必填列的字色**（红）—— 跟「受管列的白字绿底」**分得开**。
 *
 * ⚠️ **为什么不用「加粗」**：Univer 的列头样式**没有粗细字段**
 *   （`IHeaderStyleCfg` 没有 fontWeight）⇒ 用**红字**做出「不一样」的观感，
 *   **不新造一个 Univer 不支持的粗体**（宁可少一个效果，也不编一个假的）。
 */
export const REQUIRED_HEADER_FONT_COLOR = '#DC2626';

/** 列头的基准样式（跟普通列一样的那一套）。 */
export interface HeaderBaseStyle {
  fontFamily: string;
  fontColor: string;
  fontSize: number;
  backgroundColor: string;
  borderColor: string;
  textBaseline: string;
}

/** 逐列的列头配置：普通列给**纯文字**，受管列／必填列给**带样式的对象**。 */
export type ColumnHeaderConfig = Record<number, string | {
  text: string;
  fontColor: string;
  fontSize: number;
  backgroundColor: string;
}>;

/**
 * **必填列的列头文字**：末尾加一颗星。
 *
 * ⚠️ **空表头名不加**（末尾那些空白列没有表头名 ⇒ 加了星反而莫名其妙）。
 */
export function requiredHeaderText(label: string): string {
  const text = String(label ?? '');
  if (!text) return text;
  if (text.endsWith(REQUIRED_HEADER_MARK)) return text;
  return `${text} ${REQUIRED_HEADER_MARK}`;
}

/**
 * 算每一列的列头配置。
 *
 * @param labels 这一张表的列头（按列序）
 * @param managed 哪些列是**受管列**（按**表头名**判定）
 * @param base   普通列的基准样式
 * @param required 哪些列是**必填列**（按**表头名**判定；不给 = 没有必填列）
 *
 * ⚠️ **必填与受管是两件事**（2026-10-29 用户口径）：
 *   · **受管** ＝ 这一列已晋升（绿底白字）—— 说「这列归系统管」；
 *   · **必填** ＝ 这一列不许空着（列头末尾一颗星）—— 说「这列必须填」。
 *   案号那两列（案号方向／申请途径）**两样都是** ⇒ 受管的绿底白字**照旧**，
 *   必填标记**加在文字末尾**（星是白字 ⇒ 在绿底上跟整列文字一样清楚）。
 */
export function columnHeaderCfg(
  labels: string[],
  managed: Set<string>,
  base: HeaderBaseStyle,
  required?: Set<string>,
): ColumnHeaderConfig {
  const cfg: ColumnHeaderConfig = {};
  (labels || []).forEach((text, index) => {
    const isManaged = Boolean(managed && managed.has(text));
    const isRequired = Boolean(required && required.has(text));
    if (!isManaged && !isRequired) {
      cfg[index] = text;                      // —— 普通列：照旧（纯文字）——
      return;
    }
    if (isManaged) {
      cfg[index] = {                          // —— 受管列：变绿 ＋ 更大 ——
        text: isRequired ? requiredHeaderText(text) : text,
        fontColor: MANAGED_HEADER_FONT_COLOR,
        fontSize: MANAGED_HEADER_FONT_SIZE,
        backgroundColor: MANAGED_HEADER_BACKGROUND,
      };
      return;
    }
    cfg[index] = {                            // —— 必填、但不是受管列：红字 ＋ 末尾那颗星 ——
      text: requiredHeaderText(text),
      fontColor: REQUIRED_HEADER_FONT_COLOR,
      fontSize: base.fontSize,
      backgroundColor: base.backgroundColor,
    };
  });
  return cfg;
}
