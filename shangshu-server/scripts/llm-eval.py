# -*- coding: utf-8 -*-
"""LLM 工作流量化评测：走真实 /api/chat（SSE），按已知真值打分。
用途：评估本地/云端模型能否胜任尚书对话工作流（查询→取数→回答、写确认卡）。
不改提示词、不改代码——测的就是当前系统在目标模型下的真实表现。

用法：
  python3 shangshu-server/scripts/llm-eval.py <base_url> <user> <password>
  例：python3 shangshu-server/scripts/llm-eval.py https://shangshu-sys-test.dev.lingeringtek.cn jiangzhenyu 123

用例真值（sys-test 当前数据，换环境先核对）：
  待审发票 = 3 张；应收未收 = 7,240.00
"""
import json, sys, time, urllib.request, http.cookiejar

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:3000"
USER = sys.argv[2] if len(sys.argv) > 2 else "admin"
PASS = sys.argv[3] if len(sys.argv) > 3 else "admin"

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
req = urllib.request.Request(BASE + "/api/login", json.dumps({"username": USER, "password": PASS}).encode(), {"Content-Type": "application/json"})
opener.open(req, timeout=30)

def chat(message, timeout=300):
    t0 = time.time()
    req = urllib.request.Request(BASE + "/api/chat", json.dumps({"message": message}).encode(), {"Content-Type": "application/json"})
    tools, text, confirm = [], [], None
    ev = ''
    with opener.open(req, timeout=timeout) as res:
        for line in res:
            line = line.decode().rstrip("\n")
            if line.startswith("event:"):
                ev = line[6:].strip()        # SSE 事件名（confirm 卡走 event: confirm 头）
                continue
            if not line.startswith("data:"): continue
            try: d = json.loads(line[5:].strip())
            except: continue
            if ev == "confirm": confirm = d  # 确认卡：看 event 头
            if d.get("name"): tools.append(d["name"])
            if "delta" in d: text.append(str(d["delta"]))
            if d.get("type") == "confirm": confirm = d   # 兜底：部分路径在 data 里带 type
    return {"tools": tools, "text": "".join(text), "confirm": confirm, "sec": round(time.time() - t0, 1)}

def j_count3(r): return "3" in r["text"] and "object_query" in r["tools"]   # 必须真的查过数
def j_7240(r): return ("7,240" in r["text"] or "7240" in r["text"]) and "object_query" in "".join(r["tools"])
def j_confirm(r): return r["confirm"] is not None

NONCE = str(int(time.time()))
CASES = [
    ("Q1 待审发票数 x3", "查一下现在有几张待审发票", j_count3, 3),
    ("Q2 应收未收总额", "应收未收一共还剩多少钱", j_7240, 1),
    # Q3 带随机数：避免与上次跑的同内容提案去重导致「未重复提交」而不发 confirm 事件
    ("Q3 记账确认卡", f"帮我记一笔账：评测测试 {NONCE}，1 元，对方评测供应商", j_confirm, 1),
]

print(f"===== 工作流评测 @ {BASE} =====")
allr = []
for name, q, judge, reps in CASES:
    for i in range(reps):
        r = chat(q)
        try: ok = judge(r)
        except Exception as e: ok = f"ERR {e}"
        tag = f"{name}" + (f" #{i+1}" if reps > 1 else "")
        allr.append(ok is True)
        print(f"{tag}: {'PASS' if ok is True else 'FAIL'} | {r['sec']}s | tools={r['tools']}")
        print(f"   答案: {r['text'][:160].replace(chr(10), ' ')}")
print(f"-- 通过 {sum(1 for x in allr if x)}/{len(allr)}")
