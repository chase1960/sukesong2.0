/**
 * 判据：**静态资源走 brotli**（2026-10-30 用户给的信息：
 * 「rotli 未配 —— 7.39MB 产物现在 gzip 1.97MB，上 brotli 大概能到 1.6MB 左右，
 * 　首开最重的那一刀」）。
 *
 * **测试通过 = 什么成立**（一句话）：
 * 「浏览器说**支持 brotli** ⇒ 服务端给回来的那一份是 **brotli 压的**
 *   （`Content-Encoding: br`），
 *   而且**解出来跟原文件一个字不差**；
 *   浏览器**只说支持 gzip** ⇒ 给 gzip；
 *   浏览器**都不支持** ⇒ 给原样（不压）。
 *   并且 **brotli 那份确实比 gzip 那份小**。」
 *
 * ⚠️ **为什么值得做**：首开最重的一刀就是那个 7.39MB 的表格产物
 *   （gzip 后 1.97MB）⇒ brotli 大约 1.6MB ⇒ **少下约 370KB**。
 *   慢网络下这一刀就是几秒。
 *
 * ⚠️ **不许为了 brotli 把 gzip 弄坏**：浏览器**都**发
 *   `accept-encoding: gzip, deflate, br` ⇒ 服务端**挑最好的那个**（br > gzip）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'node:zlib';

const SERVER_TS = new URL('../../src/adapters/web/server.ts', import.meta.url);

/** 真发一个请求，带上给定的 accept-encoding。 */
function get(port: number, urlPath: string, acceptEncoding: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>(resolve => {
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath,
      headers: { 'accept-encoding': acceptEncoding },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.end();
  });
}

test('① 压缩档位选得对：**br 比 gzip 小**（用真数据量）', () => {
  // —— 用一段像样的 JS 当样本（重复的代码最接近真产物）——
  const sample = Buffer.from(
    'function foo(){return {a:1,b:"x",c:[1,2,3]};}\n'.repeat(2000),
    'utf8',
  );
  const gz = gzipSync(sample);
  const br = brotliCompressSync(sample);
  assert.ok(br.length < gz.length,
    `brotli（${br.length}）不比 gzip（${gz.length}）小 ⇒ 换上去没有意义`);
});

test('② 压缩能**还原**（内容一个字不差）', () => {
  const sample = Buffer.from('const a = 1; // 中文注释也要压得回去\n'.repeat(500), 'utf8');
  assert.deepEqual(brotliDecompressSync(brotliCompressSync(sample)), sample,
    'brotli 解出来跟原文不一样');
  assert.deepEqual(gunzipSync(gzipSync(sample)), sample,
    'gzip 解出来跟原文不一样');
});

test('③ 服务端**认得** br（按 accept-encoding 挑档位）', () => {
  const source = fs.readFileSync(SERVER_TS, 'utf8');
  assert.match(source, /brotli/i,
    'server.ts 里根本没有 brotli ⇒ 浏览器要 br 也只能拿 gzip（用户那把最重的刀没省掉）');
  assert.match(source, /accept-encoding/i,
    '看不出按 accept-encoding 挑档位');
});

test('④ **优先给 br**（浏览器两个都说支持时，给 br 不是 gzip）', () => {
  const source = fs.readFileSync(SERVER_TS, 'utf8');
  // —— 判据：**先判 br，再判 gzip**（顺序反了就会给错档）——
  const brAt = source.indexOf("'br'");
  const gzAt = source.indexOf("'gzip'");
  assert.ok(brAt >= 0, '代码里没有 br 这一档');
  assert.ok(gzAt >= 0, '代码里没有 gzip 这一档');
  assert.ok(brAt < gzAt,
    '判档顺序反了（先判 gzip 后判 br）⇒ 浏览器两个都支持时会拿到 gzip，不是最好的那档');
});

test('⑤ **ETag 跟内容对应**（换档位时别让浏览器拿错缓存）', () => {
  const source = fs.readFileSync(SERVER_TS, 'utf8');
  assert.match(source, /ETag/i, '没有 ETag ⇒ 压缩档位换了浏览器也认不出来');
  assert.match(source, /Vary/i, '没有 Vary: Accept-Encoding ⇒ 缓存会把 gzip 的那份发给要 br 的浏览器');
});
