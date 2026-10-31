// 种子：往 data/inbox 丢几张占位「发票」图（有效 PNG，纯色块），方便空跑看流程。
// 真实发票由用户自行往 inbox 放；mock OCR 会按文件内容派生不同字段。
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INBOX = join(__dirname, '..', 'data', 'inbox');

// 极小 PNG 编码器（RGB 纯色块），无第三方依赖。
function png(width: number, height: number, r: number, g: number, b: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, 'ascii');
    const len = u32(data.length);
    const crc = u32(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])]); // 8-bit RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const idat = deflateSync(raw);
  const iend = Buffer.alloc(0);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', iend)]);
}
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const samples = [
  { name: '永鑫钢铁_增值税专票.png', rgb: [180, 60, 60] },
  { name: '蓝海制造_电子普票.png', rgb: [60, 110, 180] },
  { name: '明远咨询_普票.png', rgb: [70, 140, 90] },
];

if (!existsSync(INBOX)) mkdirSync(INBOX, { recursive: true });
let n = 0;
for (const s of samples) {
  const p = join(INBOX, s.name);
  if (existsSync(p)) continue; // 不覆盖（避免每次 seed 都重复收）
  writeFileSync(p, png(240, 160, s.rgb[0], s.rgb[1], s.rgb[2]));
  n++;
}
// 用文件内容哈希确认 PNG 有效
const probe = createHash('md5').update(png(2, 2, 1, 2, 3)).digest('hex');
console.log(`✓ 已放入 ${n} 张占位发票到 ${INBOX}（png 自检 ${probe.slice(0, 8)}）`);
console.log('  现在启动后端 + ocr-service，再到任务面板点「立即运行」即可看到待审入库。');
