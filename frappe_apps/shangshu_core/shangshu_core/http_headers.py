"""原件名的 HTTP 头怎么写才不出事（ASCII only）。

**为什么要有这个文件**（PKG-024-T01，2026-10-22 实测）：
HTTP 头**只吃 ASCII**。中文原件名直接进 `Content-Disposition` ⇒ 线上是 UTF-8 字节 ⇒
Node 的 HTTP 解析器（`fetch`/undici 与 `node:http` **都一样**）判**整条响应非法**
（`Invalid header value char`）⇒ **字节根本读不回来** ——
浏览器下载与助手看图都中招（实测 30 个真实中文文件名里有 8 个读不回来）。

⇒ 文件名走 **RFC 5987**（`filename*=UTF-8''…`，纯 ASCII）＋ 一个 **ASCII 兜底名**
（`filename="…"`）给不认 RFC 5987 的老客户端。
客户端按 UTF-8 还原：浏览器优先认 `filename*`；
本项目的 BFF（`adapters/web/platform.ts` 的 `attachmentFilename`）**也优先认 `filename*`**。

**纯函数、无框架依赖** —— 这样能脱离 bench 单独测（不靠真站点）。
"""
import re
from urllib.parse import quote

# 兜底名里只留这些字符：字母数字、点、下划线、横线、空格。
# 引号/分号/换行会把 header 拆坏（能被拿来注入别的头）⇒ 一律清掉。
_SAFE_NAME = re.compile(r'[^A-Za-z0-9._\- ]+')


def ascii_fallback_name(filename: str) -> str:
    """给不认 RFC 5987 的老客户端准备的 **ASCII 兜底名**（**保住扩展名**）。"""
    base = str(filename or '').rsplit('/', 1)[-1]
    stem, dot, extension = base.rpartition('.')
    if not dot:                       # 没有扩展名
        stem, extension = base, ''
    safe_stem = _SAFE_NAME.sub('_', stem.encode('ascii', 'ignore').decode('ascii')).strip().lstrip('.').strip()
    safe_extension = _SAFE_NAME.sub('_', extension.encode('ascii', 'ignore').decode('ascii')).strip().lstrip('.').strip()
    # 中文名去掉后主名可能全空 ⇒ 给个通用名（**扩展名要留住**：老客户端靠它认类型）。
    if not safe_stem:
        safe_stem = 'file'
    name = ('%s.%s' % (safe_stem, safe_extension)) if safe_extension else safe_stem
    name = name.strip().lstrip('.').strip() or 'file'
    return name[:120]


def content_disposition(filename: str, disposition: str = 'attachment') -> str:
    """`Content-Disposition` 头值：**全是 ASCII**，且**认得出原名**。

    `filename*` 用 RFC 5987（`filename*=UTF-8''<百分号编码>`）；
    `filename` 给纯 ASCII 兜底名（老客户端只认它）。
    """
    name = str(filename or '') or 'file'
    fallback = ascii_fallback_name(name)
    return '%s; filename="%s"; filename*=UTF-8\'\'%s' % (disposition, fallback, quote(name, safe=''))
