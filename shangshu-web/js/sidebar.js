/* ==========================================================================
   侧栏布局控制器（2026-08-15 重构 · 参考 DeepSeek Harness 布局设计）
   —— 折叠 + 宽度偏好的单一状态源，折叠归「布局层」拥有，渲染层只消费。

   状态模型（参考 DSH layout store）：
     collapsed       用户折叠偏好（宽视口生效，持久化）
     width           宽度偏好 px（clamp [MIN,MAX]，持久化）
     narrow          视口 < AUTO_COLLAPSE(1024)
     narrowExpanded  窄视口手动展开覆盖（瞬态，不持久化）
   实际折叠态 = narrow ? !narrowExpanded : collapsed
   订阅 onChange 收到快照 { collapsed: 实际折叠态, width }，渲染层只读它。

   语义：wide（--side-w 宽度）/ rail（56px 图标列），CSS 用 #side.rail。
   ========================================================================== */
(function () {
  var LS_COLLAPSED = 'shangshu.sidebar.collapsed';
  var LS_WIDTH = 'shangshu.sidebar.width';
  // 侧栏字标去掉英文后基准宽度下调（232 → 196，MIN 200 → 176）。
  // WIDTH_GEN 是宽度基准的代次：老浏览器里存着按旧字标拖出来的宽度（≥200），
  // 不清掉的话用户看不到收窄效果，故换代次时丢弃一次旧偏好、回到新基准。
  var LS_WIDTH_GEN = 'shangshu.sidebar.width.gen';
  var WIDTH_GEN = '2';
  var MIN = 176, MAX = 420, DEFAULT = 196, RAIL = 56;
  var AUTO_COLLAPSE = 1024;

  function clamp(px) {
    px = Number(px);
    if (!isFinite(px)) return DEFAULT;
    return Math.min(MAX, Math.max(MIN, px));
  }

  var state = {
    collapsed: false,
    width: DEFAULT,
    narrow: false,
    narrowExpanded: false,
  };
  try {
    state.collapsed = localStorage.getItem(LS_COLLAPSED) === '1';
    if (localStorage.getItem(LS_WIDTH_GEN) === WIDTH_GEN) {
      var w = Number(localStorage.getItem(LS_WIDTH));
      if (isFinite(w) && w > 0) state.width = clamp(w);
    } else {
      localStorage.setItem(LS_WIDTH_GEN, WIDTH_GEN);
      localStorage.setItem(LS_WIDTH, String(DEFAULT));
    }
  } catch (e) { /* 忽略 */ }

  var listeners = new Set();

  function effective() { return state.narrow ? !state.narrowExpanded : state.collapsed; }
  function snapshot() { return { collapsed: effective(), width: state.width }; }
  function persist() {
    try {
      localStorage.setItem(LS_COLLAPSED, state.collapsed ? '1' : '0');
      localStorage.setItem(LS_WIDTH, String(state.width));
      localStorage.setItem(LS_WIDTH_GEN, WIDTH_GEN);
    } catch (e) { /* 忽略 */ }
  }
  function notify() {
    var s = snapshot();
    listeners.forEach(function (fn) { try { fn(s); } catch (e) { /* 忽略 */ } });
  }

  function setCollapsed(v) {
    if (state.collapsed === v) return;
    state.collapsed = v; persist(); notify();
  }
  function setWidth(px) {
    var w = clamp(px);
    if (state.width === w) return;
    state.width = w; persist(); notify();
  }

  window.sidebarLayout = {
    MIN: MIN, MAX: MAX, DEFAULT: DEFAULT, RAIL: RAIL, AUTO_COLLAPSE: AUTO_COLLAPSE,
    get collapsed() { return effective(); },
    get width() { return state.width; },
    // 视口变化时调用：更新 narrow 标志；进出窄视口时窄视口覆盖复位
    onViewport: function (vw) {
      var nowNarrow = vw < AUTO_COLLAPSE;
      if (nowNarrow === state.narrow) return;
      state.narrow = nowNarrow;
      if (!nowNarrow) state.narrowExpanded = false;   // 回到宽视口，清窄视口覆盖，恢复用户偏好
      notify();
    },
    toggle: function () {
      if (state.narrow) state.narrowExpanded = !state.narrowExpanded;
      else { setCollapsed(!state.collapsed); return; }
      notify();
    },
    expand: function () { setCollapsed(false); },
    collapse: function () { setCollapsed(true); },
    setWidth: setWidth,
    onChange: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
  };

  /* —— rail 态悬停名牌：折叠后只剩图标，悬停时在栏右侧浮出模块名。
     仅桌面（≥769）且 #side 处于 rail 态时出现；移动端抽屉是完整宽形态，不需要。 —— */
  var tip = null;
  function tipEl() {
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'side-rail-tip';
      tip.setAttribute('aria-hidden', 'true');
      document.body.appendChild(tip);
    }
    return tip;
  }
  function hideTip() { if (tip) tip.classList.remove('show'); }
  function railActive() {
    if (window.innerWidth <= 768) return false;
    var side = document.getElementById('side');
    return !!(side && side.classList.contains('rail'));
  }
  document.addEventListener('pointerover', function (e) {
    var item = e.target && e.target.closest ? e.target.closest('.side-item') : null;
    if (!item || !railActive()) { hideTip(); return; }
    var name = item.getAttribute('data-name');
    if (!name) { hideTip(); return; }
    var el = tipEl();
    el.textContent = name;
    var r = item.getBoundingClientRect();
    el.style.top = Math.round(r.top + r.height / 2) + 'px';
    el.classList.add('show');
  });
  document.addEventListener('pointerout', function (e) {
    var item = e.target && e.target.closest ? e.target.closest('.side-item') : null;
    if (item) hideTip();
  });
  // 滚动 / 折叠切换时名牌立即消失，避免飘在错误位置
  document.addEventListener('scroll', hideTip, true);
  if (window.sidebarLayout && sidebarLayout.onChange) {
    sidebarLayout.onChange(function () { hideTip(); });
  }
})();
