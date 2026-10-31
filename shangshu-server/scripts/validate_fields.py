#!/usr/bin/env python3
"""字段交叉校验：检查多份 fields 之间的字段一致性。

stdin:  JSON { fields_by_doc: Record<string, Record<string, any>> }
stdout: JSON { results: Array<{ level: 'error' | 'warn', message: string, field?: string, doc_type?: string }> }

校验类型：
  1. 同名字段一致性（project_name、schedule、warranty_period 等）
  2. 语义流转校验（排期表 quote_amount ↔ 合同 total_amount 等）
  3. 合同内部数值校验（金额、比例、明细）
  4. 必填字段检查
"""
import json
import re
import sys


# ── 同名字段一致性 ─────────────────────────────────────

SHARED_FIELDS = {
    '{project_name}':     {'sources': ['requirements', 'contract'],             'rule': 'exact',   'desc': '项目名称'},
    '{schedule}':         {'sources': ['schedule', 'contract'],                 'rule': 'exact',   'desc': '工期天数'},
    '{warranty_period}':  {'sources': ['requirements', 'contract'],             'rule': 'exact',   'desc': '质保期（月）'},
    '{delivery_form}':    {'sources': ['requirements', 'schedule'],             'rule': 'exact',   'desc': '交付形态'},
    '{第几版}':            {'sources': ['schedule', 'progress_report', 'collaboration'], 'rule': 'exact', 'desc': '需求确认书版本号'},
    '{doc_version}':      {'sources': ['requirements', 'schedule', 'collaboration'], 'rule': 'suggest', 'desc': '文档版本（建议同期一致）'},
    '{issue_date}':       {'sources': ['requirements', 'schedule', 'collaboration'], 'rule': 'suggest', 'desc': '发布日期（建议同期一致）'},
}

# ── 语义流转校验 ───────────────────────────────────────

SEMANTIC_FLOWS = [
    {
        'from_doc': 'schedule',
        'from_field': '{quote_amount}',
        'to_doc': 'contract',
        'to_field': '{total_amount}',
        'desc': '排期表报价 → 合同总价',
        'level': 'error',
    },
    {
        'from_doc': 'schedule',
        'from_field': '{project_duration}',
        'to_doc': 'contract',
        'to_field': '{schedule}',
        'desc': '排期表工期 → 合同工期天数',
        'level': 'warn',
    },
    {
        'from_doc': 'schedule',
        'from_field': '{milestones}',
        'to_doc': 'contract',
        'to_field': '{milestone_1}',
        'desc': '排期表首个里程碑名 → 合同中期款里程碑',
        'level': 'warn',
        'match': 'contains',
    },
]

DOC_TYPE_NAMES = {
    'contract': '合同',
    'receipt': '收据',
    'requirements': '需求确认书',
    'schedule': '排期表',
    'progress_report': '进度报告',
    'collaboration': '协作约定',
}


def _extract_number(s: str):
    """从字符串中提取第一个数字。"""
    if not s:
        return None
    m = re.search(r'[\d,]+(?:\.\d+)?', s.replace('，', '').replace(',', ''))
    if m:
        try:
            return float(m.group())
        except ValueError:
            return None
    return None


# ── 校验函数 ───────────────────────────────────────────

def validate_shared_fields(all_fields: dict) -> list:
    """校验同名字段跨文档一致性。"""
    issues = []
    for field, config in SHARED_FIELDS.items():
        values = {}
        for doc_type in config['sources']:
            if doc_type in all_fields:
                val = all_fields[doc_type].get(field, '').strip()
                if val:
                    values[doc_type] = val
        if len(values) < 2:
            continue
        unique_vals = set(values.values())
        if len(unique_vals) > 1:
            doc_names = {dt: DOC_TYPE_NAMES.get(dt, dt) for dt in values}
            level = 'error' if config['rule'] == 'exact' else 'warn'
            issues.append({
                'level': level,
                'field': field,
                'message': '%s 值不一致' % config['desc'],
                'doc_type': ', '.join(doc_names.values()),
            })
    return issues


def validate_semantic_flows(all_fields: dict) -> list:
    """校验语义流转字段。"""
    issues = []
    for flow in SEMANTIC_FLOWS:
        from_doc = flow['from_doc']
        to_doc = flow['to_doc']
        if from_doc not in all_fields or to_doc not in all_fields:
            continue

        from_val = all_fields[from_doc].get(flow['from_field'], '').strip()
        to_val = all_fields[to_doc].get(flow['to_field'], '').strip()
        if not from_val or not to_val:
            continue

        from_name = DOC_TYPE_NAMES.get(from_doc, from_doc)
        to_name = DOC_TYPE_NAMES.get(to_doc, to_doc)
        match_type = flow.get('match', 'numeric')

        if match_type == 'numeric':
            from_num = _extract_number(from_val)
            to_num = _extract_number(to_val)
            if from_num is not None and to_num is not None:
                if abs(from_num - to_num) > 0.01:
                    issues.append({
                        'level': flow['level'],
                        'field': flow['from_field'],
                        'message': '%s %s (%s) != %s %s (%s)' % (
                            from_name, flow['from_field'], from_val,
                            to_name, flow['to_field'], to_val,
                        ),
                        'doc_type': from_doc,
                    })

        elif match_type == 'contains':
            entries = []
            for line in from_val.split('\n'):
                parts = [p.strip() for p in line.split('|')[1:-1]]
                if len(parts) >= 2:
                    entries.append(parts[1])

            if not entries:
                continue

            def tokenize(s):
                parts = re.split(r'[，。、；：\s\d]+', s)
                tokens = set()
                for p in parts:
                    if len(p) >= 2:
                        tokens.add(p)
                    for i in range(len(p) - 1):
                        tokens.add(p[i:i+2])
                return tokens

            to_tokens = tokenize(to_val)

            matched = False
            for entry in entries:
                entry_tokens = tokenize(entry)
                overlap = to_tokens & entry_tokens
                if len(overlap) >= 1:
                    matched = True
                    break

            if not matched:
                issues.append({
                    'level': flow['level'],
                    'field': flow['from_field'],
                    'message': '合同 %s "%s" 在排期表中未找到匹配' % (flow['to_field'], to_val),
                    'doc_type': to_doc,
                })

    return issues


def validate_contract_amounts(contract_fields: dict) -> list:
    """校验合同金额一致性。"""
    issues = []

    def parse_amount(s):
        try:
            return float(s.replace(',', '').replace('，', ''))
        except (ValueError, AttributeError):
            return None

    total = parse_amount(contract_fields.get('{total_amount}', ''))
    deposit = parse_amount(contract_fields.get('{deposit_amount}', ''))
    mid = parse_amount(contract_fields.get('{mid_amount}', ''))
    final = parse_amount(contract_fields.get('{final_amount}', ''))

    if total and deposit and mid and final:
        sum_parts = deposit + mid + final
        if abs(sum_parts - total) > 0.01:
            issues.append({
                'level': 'error',
                'field': '付款金额',
                'message': '三期金额之和 (%.2f) != 合同总价 (%.2f)' % (sum_parts, total),
                'doc_type': 'contract',
            })

    unit_price = parse_amount(contract_fields.get('{unit_price}', ''))
    quantity = parse_amount(contract_fields.get('{quantity}', ''))
    item_total = parse_amount(contract_fields.get('{item_total}', ''))

    if unit_price and quantity and item_total:
        expected = unit_price * quantity
        if abs(expected - item_total) > 0.01:
            issues.append({
                'level': 'error',
                'field': '明细金额',
                'message': '单价(%s)x数量(%s)=%.2f != 小计(%s)' % (
                    contract_fields.get('{unit_price}'),
                    contract_fields.get('{quantity}'),
                    expected,
                    contract_fields.get('{item_total}'),
                ),
                'doc_type': 'contract',
            })

    return issues


def validate_contract_percentages(contract_fields: dict) -> list:
    """校验合同付款百分比之和为100%。"""
    issues = []

    def parse_pct(s):
        try:
            return float(s.replace('%', '').replace('％', ''))
        except (ValueError, AttributeError):
            return None

    deposit_pct = parse_pct(contract_fields.get('{deposit_percent}', ''))
    mid_pct = parse_pct(contract_fields.get('{mid_percent}', ''))
    final_pct = parse_pct(contract_fields.get('{final_percent}', ''))

    if deposit_pct is not None and mid_pct is not None and final_pct is not None:
        total_pct = deposit_pct + mid_pct + final_pct
        if abs(total_pct - 100) > 0.01:
            issues.append({
                'level': 'error',
                'field': '付款比例',
                'message': '三期比例之和 %.1f%% != 100%%' % total_pct,
                'doc_type': 'contract',
            })

    return issues


def validate_empty_fields(all_fields: dict) -> list:
    """检查必填字段是否为空。"""
    issues = []

    contract_required = [
        '{party_a_name}', '{project_name}', '{total_amount}',
        '{signing_date}', '{signing_place}', '{schedule}',
    ]
    if 'contract' in all_fields:
        for field in contract_required:
            val = all_fields['contract'].get(field, '').strip()
            if not val:
                issues.append({
                    'level': 'warn',
                    'field': field,
                    'message': '合同 %s 为空' % field,
                    'doc_type': 'contract',
                })

    req_required = [
        '{project_name}', '{doc_version}', '{issue_date}', '{doc_scope}',
    ]
    if 'requirements' in all_fields:
        for field in req_required:
            val = all_fields['requirements'].get(field, '').strip()
            if not val:
                issues.append({
                    'level': 'warn',
                    'field': field,
                    'message': '需求确认书 %s 为空' % field,
                    'doc_type': 'requirements',
                })

    return issues


def run_validation(fields_by_doc: dict) -> list:
    """运行全部校验，返回 issues 列表。"""
    if not fields_by_doc:
        return [{'level': 'error', 'field': '-', 'message': '未提供任何 fields 数据'}]

    all_issues = []
    all_issues.extend(validate_shared_fields(fields_by_doc))
    all_issues.extend(validate_semantic_flows(fields_by_doc))
    all_issues.extend(validate_empty_fields(fields_by_doc))

    if 'contract' in fields_by_doc:
        all_issues.extend(validate_contract_amounts(fields_by_doc['contract']))
        all_issues.extend(validate_contract_percentages(fields_by_doc['contract']))

    return all_issues


def main():
    input_data = json.loads(sys.stdin.read())
    fields_by_doc = input_data['fields_by_doc']
    issues = run_validation(fields_by_doc)
    print(json.dumps({'results': issues}, ensure_ascii=False))


if __name__ == '__main__':
    main()
