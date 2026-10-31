#!/usr/bin/env python3
"""Render the current UI ledger without borrowing historical candidate results."""
import argparse
import collections
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('ledger', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    data = json.loads(args.ledger.read_text())
    cases = data['cases']
    ids = [case['id'] for case in cases]
    expected = {f'UI-{n:03}' for n in range(1, 106)}
    if len(ids) != len(set(ids)) or set(ids) != expected:
        raise SystemExit('Expected exactly UI-001 through UI-105, without duplicates')
    allowed = {'PASS', 'FAIL', 'NOT_RUN', 'BLOCKED'}
    if any(case['status'] not in allowed for case in cases):
        raise SystemExit('Unknown case status')
    missing = [(case['id'], name) for case in cases for name in case.get('evidence', [])
               if not (args.ledger.parent / name).is_file()]
    if missing:
        raise SystemExit(f'Missing evidence files: {missing}')
    counts = dict(collections.Counter(case['status'] for case in cases))
    def clean(value):
        return str(value).replace('|', '\\|').replace('\n', '<br>')
    lines = ['# 现行基线逐项验收总表', '',
             f"产品基线：`{data['productCommit']}`；环境：{data['url']}。", '',
             f"105 项：{counts.get('PASS', 0)} PASS / {counts.get('FAIL', 0)} FAIL / "
             f"{counts.get('NOT_RUN', 0)} NOT_RUN / {counts.get('BLOCKED', 0)} BLOCKED。", '',
             'FAIL 表示已有明确反例，不代表该例全部步骤执行完。NOT_RUN 包含部分已测，具体边界见说明。'
             '本表仅汇总台账，不自动认定证据足以通过；不复用历史候选结果。', '',
             f'[原始台账]({args.ledger.resolve()})', '',
             '| 用例 | 状态 | 当前事实与未完成边界 | 证据 |', '|---|---|---|---|']
    for case in cases:
        evidence = '、'.join(f'[{clean(name)}]({(args.ledger.parent / name).resolve()})'
                            for name in case.get('evidence', [])) or '尚无'
        lines.append(f"| {case['id']} {clean(case['title'])} | {case['status']} | "
                     f"{clean(case.get('notes', ''))} | {evidence} |")
    args.output.write_text('\n'.join(lines) + '\n')
    print(json.dumps({'cases': len(cases), 'counts': counts, 'missing_evidence': 0}, ensure_ascii=False))


if __name__ == '__main__':
    main()
