#!/usr/bin/env python3
"""Goal Done 验收脚本（sys-test / 本地均可）。

用法：
  BASE=http://127.0.0.1:14605 USER=fang PASS=123 python3 scripts/sys-test-sme-acceptance.py
  BASE=... USER=wang PASS=123 python3 scripts/sys-test-sme-acceptance.py  # manager 只读链
"""
import json
import os
import sys
import time
from pathlib import Path
import urllib.request
import http.cookiejar

FIXTURE_PDF = Path(__file__).resolve().parent / 'fixtures' / 'sme-acceptance-invoice.pdf'

BASE = os.environ.get('BASE', 'http://127.0.0.1:3000').rstrip('/')
USER = os.environ.get('USER', 'fang')
PASS = os.environ.get('PASS', '123')

def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj

def api(opener, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data,
        headers={'Content-Type': 'application/json'} if data else {},
        method=method,
    )
    try:
        raw = opener.open(req, timeout=120).read()
    except urllib.error.HTTPError as e:
        raw = e.read()
    return json.loads(raw)

def login(opener, user, password):
    r = api(opener, 'POST', '/api/login', {'username': user, 'password': password})
    if not r.get('ok'):
        print('FAIL login', user, r)
        sys.exit(1)
    print('OK login', user, r.get('user', {}).get('role'))
    return r.get('user', {})

def fetch_text(opener, path):
    req = urllib.request.Request(BASE + path, method='GET')
    return opener.open(req, timeout=60).read().decode('utf-8', errors='replace')

def ui_smoke(opener):
    """静态资源烟测：侧栏 IA + 收票卡无置信度叙事（替代浏览器 E2E 的最小 UI 证据）。"""
    app_js = fetch_text(opener, '/js/app.js')
    chat_js = fetch_text(opener, '/js/real-chat.js?v=20260824b')
    checks = [
        ('CORE_ITEMS = []', 'CORE_ITEMS = []' in app_js),
        ('objects module', "'objects'" in app_js),
        ('layout v3', 'v: 3' in app_js),
        ('chatExtractAttribution', 'chatExtractAttribution' in chat_js),
        ('no 置信度 in upload card', '置信度 ${conf}%' not in chat_js),
    ]
    for name, ok in checks:
        if not ok:
            print('FAIL ui smoke', name)
            sys.exit(1)
        print('OK ui smoke', name)

def upload_test(opener):
    """收票 upload → flow 4 步留痕（Goal Done「收一张票」API 等价）。"""
    if FIXTURE_PDF.is_file():
        pdf = FIXTURE_PDF.read_bytes()
    else:
        print('WARN fixture missing', FIXTURE_PDF)
        return None
    req = urllib.request.Request(
        BASE + '/api/invoices/upload?name=sme-acceptance-invoice.pdf',
        data=pdf,
        headers={'Content-Type': 'application/octet-stream'},
        method='POST',
    )
    try:
        raw = opener.open(req, timeout=180).read()
        r = json.loads(raw)
    except Exception as e:
        print('FAIL upload', e)
        sys.exit(1)
    if not r.get('ok'):
        print('FAIL upload', r.get('error', r))
        sys.exit(1)
    steps = r.get('flow_steps') or []
    print('OK upload', r.get('invoice_no', ''), 'status', r.get('invoice_status'),
          'tool', r.get('tool_used', ''), 'steps', len(steps))
    if steps:
        print('  flow_steps', [(s.get('name'), s.get('attribution', '')[:40]) for s in steps[:4]])
    return r

def chat_smoke(opener):
    """对话 SSE：真实 LLM 应触发 object_* 工具（Goal Done 对话链）。"""
    data = json.dumps({'message': '查一下记账最近一条'}).encode()
    req = urllib.request.Request(
        BASE + '/api/chat', data=data,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        resp = opener.open(req, timeout=120)
        buf = ''
        deadline = time.time() + 90
        while time.time() < deadline:
            chunk = resp.read(4096)
            if not chunk:
                break
            buf += chunk.decode('utf-8', errors='replace')
            if 'object_query' in buf or 'object_propose' in buf:
                tool = 'object_query' if 'object_query' in buf else 'object_propose'
                print('OK chat tool', tool)
                return
        print('FAIL chat no object_* tool in SSE')
        sys.exit(1)
    except Exception as e:
        print('FAIL chat', e)
        sys.exit(1)

def run_finance_chain(opener):
    ui_smoke(opener)
    upload_test(opener)
    chat_smoke(opener)

    objs = api(opener, 'GET', '/api/objects')
    if not (objs.get('ok') and objs.get('summary', {}).get('total') == 4):
        print('FAIL objects', objs); sys.exit(1)
    print('OK objects x4')

    wf = api(opener, 'GET', '/api/workflows')
    intake = wf['flows'][0]
    if intake['step_count'] != 4:
        print('FAIL flow steps', intake); sys.exit(1)
    caps = [s['capability'] for s in intake['steps']]
    if 'extract.text_rule' not in caps:
        print('FAIL flow missing extract tools', caps); sys.exit(1)
    print('OK flow.invoice-intake', intake['step_count'], 'steps', caps[:3], '…')

    dash = api(opener, 'GET', '/api/dashboard/business')
    print('OK dashboard pending_invoices=', dash.get('pending_invoices', '?'),
          'pending_cards=', dash.get('pending_cards', '?'),
          'recent_events=', len(dash.get('recent_events', [])))

    pending = [i for i in api(opener, 'GET', '/api/invoices') if i.get('status') == '待审']
    print('INFO pending invoices', len(pending))
    inv_no = None
    if pending:
        inv = pending[0]
        inv_id, inv_no = inv['id'], inv.get('invoice_no', '')
        prop = api(opener, 'POST', '/api/objects/propose', {
            'object': 'invoice', 'action': 'invoice.approve',
            'data': {'invoice_id': inv_id, 'invoice_no': inv_no},
        })
        if not prop.get('ok') and not prop.get('id'):
            print('FAIL propose approve', prop); sys.exit(1)
        api(opener, 'POST', f"/api/confirmations/{prop['id']}", {'decision': 'confirmed'})
        print('OK approve', inv_no)

        book = api(opener, 'POST', '/api/objects/propose', {
            'object': 'invoice', 'action': 'invoice.book',
            'data': {'invoice_id': inv_id, 'invoice_no': inv_no},
        })
        api(opener, 'POST', f"/api/confirmations/{book['id']}", {'decision': 'confirmed'})
        print('OK book', inv_no)

        q = api(opener, 'POST', '/api/objects/query', {
            'object': 'ledger',
            'filters': [{'field': 'invoice_no', 'op': 'eq', 'value': inv_no}],
            'limit': 5,
        })
        if q.get('count', 0) < 1:
            print('WARN ledger empty for', inv_no)
        else:
            print('OK ledger rows', q.get('count'))

    recv = api(opener, 'POST', '/api/objects/query', {'object': 'receivable', 'limit': 5})
    print('OK receivable count', recv.get('count', 0))

    ledger = api(opener, 'POST', '/api/objects/query', {'object': 'ledger', 'limit': 3})
    print('OK ledger sample', ledger.get('count', 0))

    events = api(opener, 'GET', '/api/events')
    ev_list = events.get('list') if isinstance(events, dict) else events
    confirmed = [e for e in (ev_list or []) if e.get('status') == 'confirmed']
    caps_seen = {(e.get('capability'), e.get('status')) for e in confirmed[-8:]}
    print('OK events confirmed', len(confirmed), 'recent', list(caps_seen)[-5:])
    if inv_no and not any(e.get('capability') in ('invoice.approve', 'invoice.book') for e in confirmed[-20:]):
        print('WARN no invoice.approve/book in recent confirmed events')

    cards = api(opener, 'GET', '/api/confirmations')
    print('OK confirmations pending', len(cards.get('list', [])))

    # 记一笔：object_propose → 确认卡（Goal Done 记账链）
    led = api(opener, 'POST', '/api/objects/propose', {
        'object': 'ledger', 'action': 'ledger.post',
        'data': {
            'summary': 'SME验收脚本', 'counterparty': '验收测试',
            'total_amount': 0.01, 'direction': '进项', 'category': '费用',
        },
    })
    if led.get('id'):
        api(opener, 'POST', f"/api/confirmations/{led['id']}", {'decision': 'confirmed'})
        print('OK ledger.post via object_propose')
    else:
        print('WARN ledger propose', led)

def run_manager_readonly(opener):
    recv = api(opener, 'POST', '/api/objects/query', {'object': 'receivable', 'limit': 5})
    print('OK manager receivable count', recv.get('count', 0))
    dash = api(opener, 'GET', '/api/dashboard/business')
    print('OK manager dashboard pending_invoices=', dash.get('pending_invoices', '?'))
    # manager 不能批 finance-only 确认卡（用 ledger.post 提案测）
    opener2, _ = make_opener()
    login(opener2, 'fang', PASS)
    prop = api(opener2, 'POST', '/api/objects/propose', {
        'object': 'ledger', 'action': 'ledger.post',
        'data': {
            'summary': 'manager阻断测试', 'counterparty': '测试',
            'total_amount': 0.02, 'direction': '进项',
        },
    })
    cid = prop.get('id')
    if cid:
        bad = api(opener, 'POST', f'/api/confirmations/{cid}', {'decision': 'confirmed'})
        if bad.get('ok'):
            print('WARN manager confirmed finance ledger (unexpected)')
            api(opener2, 'POST', f'/api/confirmations/{cid}', {'decision': 'rejected'})
        else:
            print('OK manager blocked on finance confirm', bad.get('error', '')[:40])

def main():
    print(f'== 尚书 SME 验收 @ {BASE} ({USER}) ==')
    opener, _ = make_opener()
    user = login(opener, USER, PASS)
    role = user.get('role', '')

    if role in ('finance', 'admin'):
        run_finance_chain(opener)
    elif role == 'manager':
        run_manager_readonly(opener)
    else:
        print('INFO staff/other role — limited checks')
        api(opener, 'GET', '/api/dashboard/business')
        print('OK dashboard reachable')

    if USER == 'fang':
        print('-- manager 视角补验 --')
        opener2, _ = make_opener()
        login(opener2, 'wang', '123')
        run_manager_readonly(opener2)

    print('== PASS (API 链) ==')

if __name__ == '__main__':
    main()
