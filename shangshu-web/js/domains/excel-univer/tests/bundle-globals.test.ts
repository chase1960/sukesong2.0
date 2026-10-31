/**
 * 判据：**打包产物不许把压缩名漏进页面全局作用域**（2026-10-29 站上事故的治本判据）。
 *
 * **事故经过**：站上整页报「**表格组件版本不匹配，请重试**」⇒ 表格组件整份没挂上。
 * 浏览器控制台真凶：`SyntaxError: Identifier 'ic' has already been declared`
 *  （出在 `js/domains/excel-univer/excel-univer-entry.js`）。
 *
 * **根因**（不是权限、不是后端、不是缓存、不是版本号）：
 *   · Excel 域的产物是**平铺的顶层脚本** —— 打包器生成的辅助变量（`var ic`／`var BJt`…）
 *     落在**文件最外层** ⇒ **漏进页面的全局作用域**；
 *   · 页面上的 `js/app.js` 有一个**顶层 `const ic`**（画图标那个）⇒ **撞名**；
 *   · 浏览器对「全局词法绑定（let/const）撞名」是**整份脚本拒绝执行**
 *     ⇒ `window.shangshuMountExcelPage` 根本没挂上 ⇒ loader 只能报「版本不匹配」。
 * ⚠️ **旧产物为什么没事**：**纯靠运气** —— 压缩名每次构建都会变，
 *   旧那版恰好用了 `TJt`／`kOe`／`MJt`，没撞上 ⇒ **这颗雷一直埋着**。
 *
 * **测试通过 = 什么成立**（两条都要成立）：
 *   ① 把产物丢进一个**空全局**里跑一遍 ⇒ 跑完**全局只多出白名单里那几个名字**
 *      （这个域对外承诺的那几个 ＋ 依赖库自己明确写进 globalThis 的那几个）
 *      ⇒ **一个压缩名都不许漏出去**；
 *   ② 产物多出来的那些名字，**不许和 `app.js` 顶层用过的词法名字重名**
 *      （重名 ⇒ 浏览器**整份脚本拒绝执行** ⇒ 表格组件挂不上）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOMAIN = path.resolve(HERE, '..');
const BUNDLE = path.join(DOMAIN, 'excel-univer-entry.js');
const APP_JS = path.resolve(DOMAIN, '..', '..', 'app.js');

/**
 * 这个域**故意**对外暴露的名字（写进 `globalThis` 的）。
 * 依赖库自己写的（React 那套 `REDI_*`、`requestIdleCallback` 等）也在里面 ——
 * 它们是**产物自己**写进全局的，不属于「压缩名漏出去」。
 */
const ALLOWED_GLOBALS = [
  'shangshuMountExcelPage',      // 这个域的挂载入口（loader 找的就是它）
  'mountResourceAttribution',    // 公共归属组件的挂载入口
  'REDI_GLOBAL_LOCK',
  'REDI_CONTEXT_LOCK',
  'requestIdleCallback',
  'cancelIdleCallback',
  'queueMicrotask',
];

/** 在一个**空全局**里跑产物 ⇒ 它往全局塞了哪些名字。 */
function globalsCreatedBy(source: string): string[] {
  const context = vm.createContext({});
  vm.runInContext(source, context, { timeout: 30000 });
  return Object.keys(context).filter(name => name !== 'globalThis' && name !== 'global');
}

/** `app.js` 顶层用过的词法名字（手写文件 ⇒ 顶层声明都在行首）。 */
function appJsTopLevelNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const line of source.split('\n')) {
    const match = /^(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

test('① 产物不许把压缩名漏进全局：跑一遍只多出白名单里那几个', () => {
  assert.ok(fs.existsSync(BUNDLE), '产物不存在：' + BUNDLE);
  const created = globalsCreatedBy(fs.readFileSync(BUNDLE, 'utf8'));
  const unexpected = created.filter(name => !ALLOWED_GLOBALS.includes(name));
  assert.deepEqual(unexpected, [],
    '产物往页面全局里漏了这些名字（压缩名 ⇒ 和别的脚本撞上就整份拒绝执行）：'
    + unexpected.join('、'));
  assert.ok(created.includes('shangshuMountExcelPage'),
    '产物没挂上挂载入口（loader 靠它挂表格组件）');
});

test('② 产物多出来的名字不许和 app.js 顶层用过的词法名字重名', () => {
  const appNames = appJsTopLevelNames(fs.readFileSync(APP_JS, 'utf8'));
  assert.ok(appNames.has('ic'),
    'app.js 顶层那个 `ic` 没了（这条判据的前提变了 ⇒ 要一起改判据并写明契约变化）');
  const created = globalsCreatedBy(fs.readFileSync(BUNDLE, 'utf8'));
  const clash = created.filter(name => appNames.has(name));
  assert.deepEqual(clash, [],
    '产物和 app.js 抢了这些全局名字（浏览器会因此**整份拒绝执行**产物）：'
    + clash.join('、'));
});
