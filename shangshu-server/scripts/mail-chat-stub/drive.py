#!/usr/bin/env python3
"""真对话链路留证的驱动：登录 → POST /api/chat → 查候选 → 拒一条 → 采用一条。

**桩只替「模型出工具调用」那一步**，其余全是真的：
  真实登录 → 真实 /api/chat → 真实 chatCompletionsStream
  → 真实工具执行器 → 真实内核提案（Shangshu Action Proposal）
  → 真实 /api/confirmations（人审、采用、拒绝）

跑法（顺序别错）：
  1) docker cp stub-llm.mjs shangshu-local-c-node-1:/tmp/
     docker exec -d shangshu-local-c-node-1 node /tmp/stub-llm.mjs 11435
  2) docker exec shangshu-local-c-node-1 sh -c \\
       'echo "{\"llm\":{\"provider\":\"ollama\",\"base_url\":\"http://127.0.0.1:11435/v1\",\"api_key\":\"\",\"model\":\"stub\"}}" > /data/node/runtime_config.json'
     docker compose -p shangshu-local-c restart node     # ← 会把桩带掉，重启后**重起桩**
  3) python3 drive.py
  4) 收尾：删 /data/node/runtime_config.json、停桩、清夹具、重启 node

口令从 0600 账号文件读，**不打印**。
"""
import http.cookiejar
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:3830'
ACCOUNT_FILE = '/path/to/workspace'

pw = re.search(r'密码[：:]\s*(\S+)', pathlib.Path(ACCOUNT_FILE).read_text()).group(1)
cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def req(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data,
                               headers={'content-type': 'application/json'})
    try:
        with op.open(r, timeout=60) as x:
            return x.status, x.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


st, _ = req('/api/login', {'username': 'Administrator', 'password': pw})
print('登录', st)
if st != 200:
    sys.exit(1)

st, body = req('/api/chat', {'message': '帮我起草一封给李经理的对账单邮件'})
print('对话', st)
evs = {}
for line in body.splitlines():
    if line.startswith('event:'):
        evs[line[6:].strip()] = evs.get(line[6:].strip(), 0) + 1
print('事件分布:', evs)
assert evs.get('tool'), '没走到工具调用 —— 桩没起或配置没指向它'
assert evs.get('confirm'), '没出待审候选'

st, body = req('/api/confirmations?status=Proposed')
lst = json.loads(body).get('list', [])
print('待审候选', len(lst))
for item in lst:
    print(' -', item.get('id'), item.get('capability'), 'created_via=', item.get('created_via'))
assert all(i.get('created_via') == 'ai-chat' for i in lst), '来源不都是 ai-chat'

# 拒一条 → 零写
st, out = req('/api/confirmations/' + lst[0]['id'], {'decision': 'rejected'})
print('拒绝', st)
st, body = req('/api/confirmations?status=Proposed')
after = json.loads(body).get('list', [])
print('拒绝后待审', len(after), '（应少 1）')
assert len(after) == len(lst) - 1

# 采用一条 → 真落库
st, out = req('/api/confirmations/' + after[0]['id'], {'decision': 'confirmed'})
print('采用', st, out[:160])

print('\n判据对照请看：fde/开发/验收/测试证据-邮件MAIL-08助手写稿-2026-10-13.md 的「四之三」')
print('**收尾别忘**：删配置、停桩、清夹具、重启 node。')
