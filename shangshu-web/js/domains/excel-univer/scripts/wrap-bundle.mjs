/**
 * **把打包产物整份关进一个函数里**（2026-10-29 站上事故的治本修法）。
 *
 * **事故**：站上整页报「表格组件版本不匹配」⇒ 表格组件没挂上。
 * 浏览器真凶：`SyntaxError: Identifier 'ic' has already been declared`
 *  （出在 `js/domains/excel-univer/excel-univer-entry.js`）。
 *
 * **根因**：这份产物是**平铺的顶层脚本** —— 打包器生成的辅助变量（`var ic`／`var BJt`…）
 * 落在**文件最外层** ⇒ **漏进页面的全局作用域**；而页面上的 `js/app.js`
 * 有一个**顶层 `const ic`** ⇒ **撞名** ⇒ 浏览器对「全局词法绑定撞名」
 * 是**整份脚本拒绝执行** ⇒ `window.shangshuMountExcelPage` 根本没挂上。
 * ⚠️ **旧产物为什么没事**：**纯靠运气** —— 压缩名每次构建都会变，
 *   旧那版恰好用了 `TJt`／`kOe`，没撞上 ⇒ **这颗雷一直埋着**。
 *
 * **为什么不在 vite 配置里做**：rollup 的 `intro`／`outro` 会落在产物**自己那个 IIFE 里面**
 * （实测位置 578），**管不到最外层那几个辅助变量** ⇒ 只能在这之后**再包一层**。
 *
 * **改之前**：产物开头就是 `var BJt=Object.defineProperty;…`（顶层声明）。
 * **改之后**：产物开头是 `;(function(){`（顶层一个名字都不声明）。
 * **怎么看**：产物最外层不再有 `var`／`let`／`const` ⇒ 别的脚本再声明同名也不会撞。
 *
 * 判据：`tests/bundle-globals.test.ts`。
 */
import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve(process.argv[2] || 'excel-univer-entry.js');
if (!fs.existsSync(target)) {
  console.error('找不到产物：' + target);
  process.exit(1);
}
const source = fs.readFileSync(target, 'utf8');
const OPEN = ';(function(){';
if (source.startsWith(OPEN)) {
  console.log('产物已经包过一层（不重复包）：' + path.basename(target));
  process.exit(0);
}
fs.writeFileSync(target, OPEN + '\n' + source + '\n})();\n', 'utf8');
console.log('产物已包进函数：' + path.basename(target)
  + '（' + source.length + ' → ' + fs.statSync(target).size + ' 字节）');
