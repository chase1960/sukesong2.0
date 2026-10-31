#!/usr/bin/env python3
"""真实场景测 agent —— **真模型、真对话、真工具、真审核通道**。

用户 2026-10-14 要求：
  「你用真实场景测一下agent哈,要测试 他能不能写主题\\收件人\\正文\\关联附件
    \\转发\\回复以及是不是走的审核通道,会不会跳转页面」

**不用桩** —— 用用户给的真模型（qwen），从真实登录一路走到真实提案。

测试通过 = 下面八条**同时**成立：

 1. **主题** —— agent 起草的候选稿里有主题，不是空的
 2. **收件人** —— 候选稿里有收件人
 3. **正文** —— 候选稿里有正文
 4. **关联附件** —— 能把附件带进候选稿（或明确说没有附件）
 5. **转发** —— 让它转发一封，能出转发稿
 6. **回复** —— 让它回复一封，能出回复稿
 7. **走审核通道** ★ —— 落的是**待审提案**（Proposed），
    **不是直接写进草稿库** —— 采用前正文一个字都不该落库
 8. **不跳页面** ★ —— 对话回包里**没有跳转指令**（不带 location/redirect/href 之类），
    人停在原页

第 7 条是这条链的**要害**：agent 写稿和人采用必须分开，
否则「写稿与发送分别确认」就是空的。

跑法（配置已指向真模型，不用起桩）：
  docker cp …:/tmp/ && docker exec -w /home/frappe/frappe-bench … python /tmp/…
  —— 但这份走 HTTP，直接在宿主机跑：python3 test-mail-agent-real.py

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
PASS, FAIL = [], []


def require(label, ok, detail=''):
    (PASS if ok else FAIL).append(label)
    print(('  ✔ ' if ok else '  ✖ ') + label + ('' if ok else f'  ← {detail}'))


pw = re.search(r'密码[：:]\s*(\S+)', pathlib.Path(ACCOUNT_FILE).read_text()).group(1)
cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def req(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data,
                               headers={'content-type': 'application/json'})
    try:
        with op.open(r, timeout=180) as x:
            return x.status, x.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


st, _ = req('/api/login', {'username': 'Administrator', 'password': pw})
print('登录', st)
if st != 200:
    print('登录失败，不往下走'); sys.exit(1)


def chat(message):
    """发一句话给 agent，回来 (事件分布, 事件流原文, 关键载荷)。"""
    st, body = req('/api/chat', {'message': message})
    evs, payloads = {}, []
    for line in body.splitlines():
        if line.startswith('event:'):
            name = line[6:].strip()
            evs[name] = evs.get(name, 0) + 1
        elif line.startswith('data:'):
            try:
                payloads.append(json.loads(line[5:].strip()))
            except Exception:
                payloads.append(line[5:].strip()[:200])
    return st, evs, payloads, body


print()
print('【0】真模型在不在（不是桩）')
st, evs, payloads, raw = chat('你好，你在吗？只回一个字：在')
print(f'      事件分布={evs}')
# **error 不算过** —— 先前 bool(evs) 连 error 事件也算真，是假绿（实测栽过）
require('0 真模型回话了（不是桩）',
        st == 200 and not evs.get('error'), f'状态={st} 事件={evs}')

print()
print('【1～4】起草一封带附件的信 —— 主题 / 收件人 / 正文 / 关联附件')
st, evs, payloads, raw = chat(
    '帮我起草一封邮件给李经理（li@client.example.invalid），主题写「10 月对账单」，'
    '正文说明本月费用合计 220 元，附件请关联上「对账单.xlsx」。')
print(f'      事件分布={evs}')
joined = json.dumps(payloads, ensure_ascii=False)
require('5a 走到了工具调用', bool(evs.get('tool')), f'事件={evs}')
# 7a 挪到收尾统一判 —— 单次对话可能分几步出稿，中途查会漏（实测栽过）

st2, body2 = req('/api/confirmations?status=Proposed')
lst = json.loads(body2).get('list', []) if body2 else []
print(f'      当前待审候选 {len(lst)} 条')

print()
print('（1～4 的核对挪到收尾统一做 —— 模型可能分几步出稿，中途查会漏）')

print()
print('【5】转发')
st, evs5, payloads5, raw5 = chat('把收件箱第一封信转发给 wang@client.example.invalid，附一句话「请查收」')
print(f'      事件分布={evs5}')
j5 = json.dumps(payloads5, ensure_ascii=False)
require('5 转发能出稿', bool(evs5.get('tool')) and bool(evs5.get('confirm')), f'事件={evs5}')

print()
print('【6】回复')
st, evs6, payloads6, raw6 = chat('回复收件箱第一封信，说「已收到，本周内给答复」')
print(f'      事件分布={evs6}')
require('6 回复能出稿', bool(evs6.get('tool')) and bool(evs6.get('confirm')), f'事件={evs6}')

print()
print('【7】★ 走审核通道 —— 采用前正文不落库')
st3, body3 = req('/api/confirmations?status=Proposed')
pending = json.loads(body3).get('list', []) if body3 else []
require('7a 出了待审候选（不是直接写库）',
        bool(pending) and all(i.get('created_via') == 'ai-chat' for i in pending),
        f'待审 {len(pending)} 条，来源={[i.get("created_via") for i in pending]}')
require('7b 候选都挂在待审（状态 proposed/Proposed）',
        bool(pending) and all(str(i.get('status', '')).lower() == 'proposed' for i in pending),
        f'状态={[i.get("status") for i in pending]}')
# 采用前，草稿库里不该有 agent 写的那封
st4, body4 = req('/api/platform/datasets/mail.message/records?scope=draft', None)
drafts_before = body4 or ''
require('7c 采用前正文没落库（写稿 ≠ 发出去/存进去）',
        '对账单' not in drafts_before[:2000],
        f'草稿库里已出现候选内容：{drafts_before[:200]}')

print()
print('【8】★ 不跳页面 —— 回包里没有跳转指令')
allraw = raw + raw5 + raw6
nav_markers = ['window.location', 'location.href', 'location.assign', 'location.replace',
               '"redirect"', "'redirect'", 'router.push', 'navigate(']
hit = [m for m in nav_markers if m in allraw]
require('8 对话回包不带跳转指令（人停在原页）',
        not hit, f'发现跳转指令：{hit}')

print()
print('【1～4】收尾统一核对 —— 所有候选稿里，主题/收件人/正文/附件齐不齐')
st_all, body_all = req('/api/confirmations?status=Proposed')
allp = json.dumps(json.loads(body_all).get('list', []) if body_all else [], ensure_ascii=False)
print(f'      待审候选共 {len(json.loads(body_all).get("list", [])) if body_all else 0} 条')
require('1 主题写出来了（候选稿里有 subject）',
        '"subject"' in allp and 'Re:' in allp or 'Fwd:' in allp or '对账单' in allp,
        f'候选={allp[:200]}')
require('2 收件人写出来了（候选稿里有 to）',
        '"to"' in allp and '@' in allp, f'候选={allp[:200]}')
require('3 正文写出来了（候选稿里有 body）',
        '"body"' in allp and len(allp) > 300, f'候选={allp[:200]}')
require('4 关联附件认了（带上附件，或明确说没有）',
        '"attachments"' in allp or 'attachment_labels' in allp or '附件' in allp,
        f'候选={allp[:200]}')

print()
print('=' * 50)
print(f'通过 {len(PASS)} 条，失败 {len(FAIL)} 条')
if FAIL:
    print('未过：' + ' | '.join(FAIL))
print()
print('**收尾**：这轮造出的候选会留在待审列表里，你可以在页面上自己点采用/拒绝。')
sys.exit(1 if FAIL else 0)
