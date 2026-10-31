/**
 * 构建期瘦身：把 Univer 渲染引擎里的 **77 个「连字符断词模式表」**换成空壳。
 *
 * **为什么是它**：产物 excel-univer-entry.js 有 11.96MB，拆开看，
 * 里面的多语言 **locale 词条只有 386KB**（zh-CN 才是真正被引用的那几个），
 * 真正的肥肉是 `@univerjs/engine-render/lib/es/` 里的 77 个断词模式表
 * （hu-DVk7Y_ka.js、nb-DI8u59ch.js、de-1901-*.js…，合计 5.67MB）。
 * 它们被 `engine-render/lib/es/index.js` 的 `PATTERN_LOADERS` 用
 * `import("./xx.js")` **动态**引入 —— 但产物打成 IIFE（普通 <script src>），
 * IIFE 不支持代码分包，rollup 只能把动态 import **全部内联进同一个文件**，
 * 于是 80 种语言的断词字典全进了包。
 *
 * **换掉之后为什么不算改功能**：
 * 1. 断词只在文档段落里 `autoHyphenation === TRUE` 时才启用；
 *    引擎里它默认是 `BooleanNumber.FALSE`，尚书 src 里也从没设过它。
 * 2. 英文（en-us）模式表本来就在 engine-render/index.js 里内联（不走分包），
 *    **原样保留**；中文没有断词模式表（franc 检测出 cmn → unknown → 本来就不断词）。
 * 3. 被换掉的语言**不会报错**：`Hyphen._loadPattern` 仍能注册成功，
 *    只是该语言「不再产生任何连字符断点」= 退化成不断词。
 *
 * **怎么换的**：构建期拦截 `engine-render/lib/es/index.js` 里指向模式表的相对
 * 动态 import，换成一个**同名导出、同样结构**的空模式表模块。
 * **只动构建期，不动 node_modules，不动 src/**。
 *
 * **改之前**：产物 11,956,265 字节（gzip 3,028,414）。
 * **改之后**：产物大幅缩小（见构建日志里的 [univer-slim] 统计）。
 * **怎么看**：构建后看产物字节数；浏览器里表格页照常打开、编辑、公式计算。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** engine-render 的 es 目录（唯一会被拦的来源）。 */
const ENGINE_RENDER_ES_DIR = `${path.sep}@univerjs${path.sep}engine-render${path.sep}lib${path.sep}es${path.sep}`;

/**
 * 断词模式表的三元组形状（见 engine-render 的 `parsePattern`）：
 *   [levelsTableStr, patternJson, exceptions]
 * - levelsTableStr：逗号分隔的层级表，'0' 表示不产生任何断点；
 * - patternJson：JSON 字符串字典，'{}' = 空字典 = 永远匹配不上；
 * - exceptions：手工断词例外表，空数组。
 * 结果：结构合法、能注册成功、但该语言不产生连字符断点（不断词，而不是报错）。
 */
const STUB_PATTERN = '["0", "{}", []]';

/** 模式表文件的标记（源码顶部的一行 region 注释）。 */
const PATTERN_MARKER = 'hyphenation/patterns/';

export function univerSlim(): Plugin {
  const stubs = new Map<string, string>();
  let stubbed = 0;
  let stubbedBytes = 0;

  return {
    name: 'univer-slim',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('./') || !source.endsWith('.js')) return null;
      if (!importer.includes(ENGINE_RENDER_ES_DIR)) return null;

      const abs = path.resolve(path.dirname(importer), source);
      let code: string;
      try {
        code = fs.readFileSync(abs, 'utf8');
      } catch {
        return null;
      }
      // 只认断词模式表；engine-render 里的其它文件一律照旧。
      if (!code.includes(PATTERN_MARKER)) return null;

      // 模式表的导出形状是 `export { Hu };`（也可能 `export { A as B };`）。
      const m = code.match(/export\s*\{\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*\}/);
      if (!m) return null;
      const localName = m[1];
      const exportedName = m[2] ?? m[1];

      const exportClause = exportedName === localName
        ? `export { ${localName} };`
        : `export { ${localName} as ${exportedName} };`;
      const virtualId = `\0univer-hyphen-stub:${abs}`;
      stubs.set(virtualId, `const ${localName} = ${STUB_PATTERN};\n${exportClause}\n`);
      stubbed += 1;
      stubbedBytes += Buffer.byteLength(code, 'utf8');
      return virtualId;
    },
    load(id) {
      return stubs.get(id) ?? null;
    },
    buildEnd() {
      if (stubbed > 0) {
        this.warn(
          `[univer-slim] 已换掉 ${stubbed} 个断词模式表（原始 ${stubbedBytes} 字节）→ 产物瘦身；`
          + '英文 en-us 模式表保留（内联在 engine-render 里，未动）。',
        );
      }
    },
  };
}
