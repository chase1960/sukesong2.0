#!/usr/bin/env python3
"""按**统一日志台账**把走查动过的格子还原成原值（2026-10-30 · PKG-133）。

**为什么要有这个**（真出过）：
    浏览器走查会往客户的表里写测试值（粘贴／打字／下拉），
    走查**结束时要擦掉**。而擦除若靠「值里有没有标记」来认 ⇒
    ① 标记形状判错就**漏清**；
    ② 那一格**原本就有真数据**时（标记盖住了它）就**再也认不出来**
       ⇒ **真数据被抹掉**（r-000001/002/003 的申请号与案号真被抹过）。

    ⇒ **真值只认台账**：内核每次写受管记录都进 `Shangshu Unified Log`，
    里面留着当时写的**值** ⇒ 从那里把原值取回来。

**用法**（在工作树根或任何地方都行）：
    python3 scripts/restore-walk-cells-from-ledger.py --table 7mjs3ppe4u
    python3 scripts/restore-walk-cells-from-ledger.py --table 7mjs3ppe4u --apply

⚠️ **默认只报告、不写**（先看要改什么，再 `--apply`）。
"""
import argparse
import json
import re
import subprocess
import sys

# 走查脚本会写的值前缀（**只认前缀，不猜位数** ⇒ 不会再漏）
WALK_PREFIXES = ('实按', '贴', '粘', '打字验收')

# —— 跟真站说话的方式 ——
BASE = 'http://127.0.0.1:3850'
COOKIE = '/tmp/ss_cookie_20261029.txt'


def curl(args, stdin=None):
    cmd = ['curl', '-s', '-b', COOKIE] + args
    out = subprocess.run(cmd, input=stdin, capture_output=True, text=True)
    return out.stdout


def login():
    body = json.dumps({'username': 'administrator', 'password': 'lingeringtek2026'})
    curl(['-c', COOKIE, '-X', 'POST', BASE + '/api/login',
          '-H', 'content-type: application/json', '--data-binary', '@-'], stdin=body)


def read_rows(table, page_length=60):
    q = json.dumps({'table': table, 'page': 1, 'page_length': page_length}, ensure_ascii=False)
    raw = curl(['--get', BASE + '/api/platform/services/files.sheet_read/invoke',
                '--data-urlencode', 'payload=' + q])
    return json.loads(raw)


def is_walk(value):
    text = str(value or '').strip()
    return text.startswith(WALK_PREFIXES)


def ledger_values(table):
    """从统一日志台账里取这张表**写过**的值（按时间先后，后写覆盖先写）。

    ⚠️ 台账在**容器里的数据库**里 ⇒ 这里通过容器里的 frappe 读。
    """
    script = r'''
import frappe, json, re, sys
table = sys.argv[1]
frappe.init(site="shangshu.localhost"); frappe.connect()
rows = frappe.db.sql(
    "select occurred_at, detail_json from `tabShangshu Unified Log` "
    "where detail_json like %s order by occurred_at asc", ("%%" + table + "%%",), as_dict=True)
out = []
for r in rows:
    try: detail = json.loads(r["detail_json"] or "{}")
    except Exception: detail = {}
    text = json.dumps(detail, ensure_ascii=False)
    for m in re.finditer(r'"(3IN2\d+DD1F|20\d{12,20})"', text):
        out.append({"at": str(r["occurred_at"]), "value": m.group(1)})
print(json.dumps(out, ensure_ascii=False))
'''
    cmd = ['docker', 'exec', 'shangshu-local-r967-frappe-1', 'sh', '-lc',
           'cd /home/frappe/frappe-bench/sites && ../env/bin/python -c ' +
           '"' + script.replace('"', '\\"').replace('\n', '\\n') + '" ' + table]
    raw = subprocess.run(cmd, capture_output=True, text=True).stdout.strip()
    start = raw.find('[')
    if start < 0:
        return []
    return json.loads(raw[start:])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--table', required=True)
    ap.add_argument('--apply', action='store_true', help='真的写回去（默认只报告）')
    args = ap.parse_args()

    login()
    data = read_rows(args.table)
    rows = data.get('rows') or []

    walk_cells = []
    for row in rows:
        for header, cell in (row.get('values') or {}).items():
            if is_walk(cell.get('value')):
                walk_cells.append({'row_id': row['row_id'], 'header': header,
                                   'walked': cell.get('value')})

    # —— 台账里的值（按时间先后）⇒ 用来认「这一格原本该是什么」——
    values = ledger_values(args.table)
    ledger = [v['value'] for v in values]

    print(f'表 {args.table}：共 {data.get("total_rows")} 行；'
          f'走查标记 {len(walk_cells)} 处')
    for cell in walk_cells:
        print(f'  · {cell["row_id"]}.{cell["header"]} = {cell["walked"]!r}（走查写的）')
    print(f'台账里出现过的值：{sorted(set(ledger))}')

    if not walk_cells:
        print('没有走查痕迹 ⇒ 不用动')
        return 0

    # —— 还原：优先用台账里**同一个 row_id** 的值；找不到就不猜 ——
    #   ⚠️ 台账的 detail 里带 row_id 时才认；否则**如实说「认不出」**（不瞎填）。
    script = r'''
import frappe, json, re, sys
table = sys.argv[1]
frappe.init(site="shangshu.localhost"); frappe.connect()
rows = frappe.db.sql(
    "select occurred_at, detail_json from `tabShangshu Unified Log` "
    "where detail_json like %s order by occurred_at asc", ("%%" + table + "%%",), as_dict=True)
out = []
for r in rows:
    try: detail = json.loads(r["detail_json"] or "{}")
    except Exception: continue
    text = json.dumps(detail, ensure_ascii=False)
    row_ids = set(re.findall(r'"row_id"\s*:\s*"(r-\d+)"', text))
    vals = re.findall(r'"(3IN2\d+DD1F|20\d{12,20})"', text)
    if row_ids and vals:
        out.append({"at": str(r["occurred_at"]), "row_ids": sorted(row_ids),
                    "values": sorted(set(vals))})
print(json.dumps(out, ensure_ascii=False))
'''
    cmd = ['docker', 'exec', 'shangshu-local-r967-frappe-1', 'sh', '-lc',
           'cd /home/frappe/frappe-bench/sites && ../env/bin/python -c ' +
           '"' + script.replace('"', '\\"').replace('\n', '\\n') + '" ' + args.table]
    raw = subprocess.run(cmd, capture_output=True, text=True).stdout.strip()
    start = raw.find('[')
    entries = json.loads(raw[start:]) if start >= 0 else []

    restore = []
    for cell in walk_cells:
        want = None
        for entry in entries:                      # 时间先后 ⇒ 最后一个匹配的是「最后的值」
            if cell['row_id'] in entry['row_ids']:
                for value in entry['values']:
                    if value not in (cell['walked'],):
                        want = value
        if want is None:
            print(f'  ! {cell["row_id"]}.{cell["header"]}：台账里认不出原值 ⇒ **不猜**，'
                  f'这一格只能写空（或人工核）')
            continue
        restore.append({'row_id': cell['row_id'], 'header': cell['header'], 'value': want})
        print(f'  ⇒ {cell["row_id"]}.{cell["header"]} 还原成 {want!r}')

    if not restore:
        print('没有能确定的还原项')
        return 1
    if not args.apply:
        print('\n（只是报告；加 --apply 才真的写回去）')
        return 0

    t = read_rows(args.table, 1)
    payload = {'table': args.table, 'sheet': t.get('sheet'),
               'expected_content_version': t.get('content_version'),
               'expected_structure_version': t.get('structure_version'),
               'cells': [{'row_id': c['row_id'], 'header': c['header'],
                          'value': {'type': 'text', 'value': c['value']}} for c in restore]}
    body = json.dumps({'payload': payload, 'confirmed': True, 'source': 'user',
                       'idempotency_key': 'restore-from-ledger-%d' % int(time.time() * 1000)},
                      ensure_ascii=False)
    raw = curl(['-X', 'POST', BASE + '/api/platform/actions/files.sheet_cells_write/execute',
                '-H', 'content-type: application/json', '--data-binary', '@-'], stdin=body)
    print('写回回包：', raw[:220])
    return 0


if __name__ == '__main__':
    sys.exit(main())
