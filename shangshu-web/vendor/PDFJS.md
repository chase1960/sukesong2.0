# PDF.js 站内阅读依赖

- 官方发布：[Mozilla PDF.js 6.4.299](https://github.com/mozilla/pdf.js/releases/tag/v6.4.299)，Apache-2.0，包内 LICENSE 与字体/WASM各自许可原样保留。
- 来源：`https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz`；SHA512 固定在 `scripts/vendor-pdfjs.mjs`。
- 仅打开 PDF 时动态加载，worker、字体、CMap、WASM均同源；不用CDN，不运行文档脚本、表单或外链，不产生写入。
- 复现：下载上述包后 `node scripts/vendor-pdfjs.mjs /绝对路径/pdfjs-dist-6.4.299.tgz`。更新依赖须同步锁定目录/加载路径/哈希并验浏览器；不覆盖旧版本目录。
