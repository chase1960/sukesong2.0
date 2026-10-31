# 正式页面计时（S1-3）

无界面 Chrome 走 CDP 驱动**正式页面**（不是 jsdom、不是桩），
量「点下去到界面有反馈」这一段。**不拉起任何本机图形应用。**

## 为什么要自己写 CDP 客户端

仓库里没有 playwright/puppeteer；`chrome-devtools` MCP 这台连不上。
Node 自带 WebSocket，直接走 CDP 协议即可，不引第三方依赖。

**坑**：Chrome 154 在这台机器上把 DevTools 绑在 **IPv6 `[::1]:9222`**，
不是 IPv4 `127.0.0.1` —— curl 打 127.0.0.1 会撞到别的服务回 404。

## 怎么跑

```bash
# 1) 起无界面 Chrome（注意 --user-data-dir 必须是非默认目录）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --remote-debugging-port=9222 --remote-allow-origins='*' \
  --user-data-dir=/tmp/cdp-profile-s1 about:blank &

# 2) 跑（口令从 0600 账号文件读，不打印）
node shangshu-server/scripts/page-timing/s1-3-page-timing.mjs
```

## 判据

测试通过 = 在正式页面上点发送，从点击到「已排队」提示 **≤1 秒**，
按钮恢复 **≤1 秒**；0 附件与 10MB 附件分别报、冷/热分开、附件上传耗时另列。

## 实测（2026-10-13，agent-c 3830）

| | 冷跑 | 热跑（3 次中位） | 判据 | 结果 |
|---|---|---|---|---|
| 点「发送」→ 核对弹层 | 7 ms | 2 ms | ≤1000 ms | PASS |
| 点「确认」→「已排队」提示 | 85 ms | 272 ms | ≤1000 ms | PASS |
| 按钮恢复可用 | 85 ms | 272 ms | ≤1000 ms | PASS |
| 10MB 附件挑选并挂上 | — | — | 另列 | **NOT_RUN** |

10MB 附件那档 **NOT_RUN**：测具驱动不动文件选择器（`Runtime.evaluate` 挂住）。
**不拿 API 层的数冒充页面数** —— API 层 5MB 附件那档见
`scripts/test-mail-speed-real-network.py`（点发送→已排队 15ms、服务商接受 2032ms）。

## 测具自己踩过的坑（如实记，都是测具的不是产品的）

1. **旧提示污染计时** —— 上一封的 toast 还挂着，轮询立刻撞上，计出 2ms 假数。
   每轮开始前 `#toast-zone` 清空。
2. **写死等待** —— `sleep(400)` 等写信窗，偶尔没开出来。改成轮询。
3. **`Promise.race` 不 catch** —— 败方的 CDP 超时变成 unhandled rejection，进程直接退。
4. **重复登录** —— 同一 Chrome 会话留着登录态，`#un` 找不到。改成「需要才登」。
