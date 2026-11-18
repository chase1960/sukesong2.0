/* 静态演示提示条（仅 demo.html 引入）。 */
(function () {
  'use strict';
  var css = ''
    + '#demo-banner{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483000;'
    + 'display:flex;align-items:center;gap:10px;max-width:calc(100vw - 32px);padding:9px 12px 9px 14px;'
    + 'border:1px solid #d7e3db;border-radius:999px;background:rgba(255,255,255,.96);'
    + 'box-shadow:0 8px 24px rgba(23,63,51,.14);color:#33443c;font:13px/1.4 system-ui,-apple-system,"PingFang SC",sans-serif}'
    + '#demo-banner b{color:#173f33;font-weight:600;white-space:nowrap}'
    + '#demo-banner span{color:#5b6b63;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '#demo-banner button{border:0;background:transparent;color:#7b8a82;font-size:16px;line-height:1;cursor:pointer;padding:2px 4px}'
    + '#demo-banner button:hover{color:#173f33}'
    + '@media (max-width:640px){#demo-banner span{display:none}}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  var banner = document.getElementById('demo-banner');
  var close = document.getElementById('demo-banner-close');
  if (close && banner) close.addEventListener('click', function () { banner.remove(); });
})();
