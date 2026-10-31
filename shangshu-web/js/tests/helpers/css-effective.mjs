// 判据公用件：**算出来生效的 CSS 值**（加载顺序 ＋ 特异性 ＝ 浏览器那套）。
//
// 为什么抽出来（仓库约定 §13「公共工具只留一份」）：
//   `page-shell.test.mjs`（页头骨架判据）先手抄了一份；PKG-087 又要两条判据
//   （页头基线／卡片排版）用到同一套算法 ⇒ 抄一份就是三份，算法改一处三份都得跟着改。
//
// ⚠ **为什么不能直接用 `resolver.resolve()`**：那个函数**只按加载顺序**取最后一条命中，
//   **不算特异性** ⇒ 「后加载但更不具体的那条」会赢（浏览器不是这样）⇒
//   这里自己按「特异性高者赢、同特异性里后加载者赢」排一遍。
//
// ⚠ `css-cascade.mjs` 的 `resolveIn` 按**选择器原文**匹配 ⇒ 传进来的候选必须是
//   样式表里**一字不差**的选择器（不是「大概长这样」）。
//
// ⚠ **断的是算出来的值，不是样式表里有没有那句话** —— 这是本仓库判据的一贯口径。

/** 选择器的「粗略特异性」：id ×10000 ＋ 类／属性 ×100 ＋ 标签 ×1。 */
export function specificity(selector) {
  const ids = (selector.match(/#[A-Za-z0-9_-]+/g) || []).length;
  const classes = (selector.match(/\.[A-Za-z0-9_-]+/g) || []).length
    + (selector.match(/[[\]()]/g) || []).length;
  const tags = (selector.match(/(^|[\s>+~])[a-z][a-z0-9-]*/g) || []).length;
  return ids * 10000 + classes * 100 + tags;
}

/**
 * 造一个「算出来生效的值」的函数。
 * `effective(candidates, property, viewport)`：
 *   `candidates` ＝这个元素身上所有可能命中的选择器（它自己的类 ＋ 祖先链上的限定）；
 *   返回 `{ selector, file, order, value }`（命中的那一条）＝ 浏览器真正用的那条；
 *   **一个都没命中** ⇒ 返回 `null`（判据据此说「这条根本没写」）。
 */
export function createEffective(resolver, defaultViewport = 1440) {
  return function effective(candidates, property, viewport = defaultViewport) {
    const hits = [];
    for (const selector of candidates) {
      for (const file of resolver.order) {
        const hit = resolver.resolveIn(file, selector, property, viewport);
        if (!hit) continue;
        hits.push({
          selector,
          file,
          order: resolver.order.indexOf(file),
          value: String(hit.value).trim(),
        });
      }
    }
    if (!hits.length) return null;
    hits.sort((a, b) => specificity(a.selector) - specificity(b.selector) || a.order - b.order);
    return hits[hits.length - 1];
  };
}

/**
 * 算出来的**字重**（数字）。
 * 没写 `font-weight` ⇒ 浏览器按 `normal` 算（＝400）⇒ 这里也当 400。
 */
export function effectiveWeight(effective, candidates, viewport) {
  const hit = effective(candidates, 'font-weight', viewport);
  if (!hit) return 400;
  const value = Number(hit.value);
  return Number.isFinite(value) ? value : 400;
}
