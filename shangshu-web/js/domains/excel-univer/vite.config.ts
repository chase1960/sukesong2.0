import { defineConfig } from 'vite';
import { univerSlim } from './vite-univer-slim';

// 工作台的域入口是普通 <script src>（不是 ES module），所以打成 IIFE。
// 产物 excel-univer-entry.js 与本目录同级，由 domain-entry.json 声明注入。
export default defineConfig({
  // 依赖里有读 process.env 的分支；浏览器没有 process，必须在构建期定死。
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.UNIVER_ENV': '"production"',
    global: 'globalThis',
  },
  // IIFE 不能代码分包 ⇒ rollup 会把 engine-render 的 77 个动态 import
  // （80 种语言的连字符断词模式表，5.67MB）全部内联进产物。
  // 构建期把它们换成同名导出的空模式表（不断词，但能注册成功，不报错）。
  plugins: [univerSlim()],
  build: {
    lib: {
      entry: 'src/main.ts',
      name: 'ShangshuExcelUniver',
      formats: ['iife'],
      fileName: () => 'excel-univer-entry.js',
    },
    outDir: '.',
    emptyOutDir: false,
    minify: 'esbuild',
    target: 'es2020',
    cssCodeSplit: false,
  },
});
