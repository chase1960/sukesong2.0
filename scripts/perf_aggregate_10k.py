"""PKG-018-T05 §8.2：统计性能测量（**不调用 LLM**，确定性）。

量的：1万条受管记录上的 常用单表计数／分组／求和 —— 1 次冷启动 ＋ 20 次热执行 ⇒ P95（目标 ≤2s，**不含模型推理时间**）。

说明：样本是**测量夹具** —— 先用晋升建出真受管对象（10 行），其余 9,990 行**直接批量写进物理表**
（只为了把样本量做够；正式功能不这么造数据）。跑完把物理表与对象清掉。

⚠️ 两个取名坑（踩过，记在这里免得再犯）：
1. 物理**表名** = ``tab`` + DocType 名（DocType 名本身带空格，如 ``SSM 3149…``）⇒
   直接拿 DocType 名去查表会报「表不存在」；拿它去 ``frappe.get_doc()`` 也会炸
   （Frappe 会把带空格的一串当「doctype name」拆）。
2. 物理**列名**是 ``f_<hash>``，不是业务列名（``amount``／``day``／``owner_name``）⇒
   必须走内核那份权威映射：``{字段 id: 物理列名}``（见 ``model_records._aggregate_prepare``）。
"""
import json
import time
import uuid

import frappe

frappe.init(site='shangshu.localhost')
frappe.connect()
frappe.set_user('Administrator')

from shangshu_core import model_records
from shangshu_core.promotion_records import provision_promoted_records

ROWS = 10000
HOT = 20
BATCH = 1500
COLUMNS = [
    {"header": "金额", "promoted": True, "field": "amount", "type": "number", "rules": {"min": 0}},
    {"header": "日期", "promoted": True, "field": "day", "type": "date"},
    {"header": "负责人", "promoted": True, "field": "owner_name", "type": "text"},
]
key = 'perf-' + uuid.uuid4().hex[:8]
table = 'perf-table-' + uuid.uuid4().hex[:8]
rows = [{"row_id": "r-%06d" % i,
         "values": {"amount": (i % 977) * 1.25, "day": "2026-%02d-%02d" % (i % 12 + 1, i % 28 + 1),
                    "owner_name": "负责人%d" % (i % 7)}} for i in range(10)]
provisioned = provision_promoted_records(table=table, title="性能夹具", columns=COLUMNS,
                                        rows=rows, idempotency_key=key)
object_id = provisioned['object_id']
model = frappe.get_doc(model_records.MODEL, object_id)
physical = model.physical_doctype
physical_table = "tab%s" % physical
compiled = json.loads(model.active_json)
# ⚠️ 权威映射（与内核统计口径同一份）：字段 id ⇒ 物理列名
columns = {f["id"]: c["fieldname"] for f, c in zip(compiled["fields"], compiled["doctype"]["fields"])}
amount_col, day_col, owner_col = columns["amount"], columns["day"], columns["owner_name"]
now = frappe.utils.now()
for start in range(10, ROWS, BATCH):
    bulk = []
    for i in range(start, min(start + BATCH, ROWS)):
        bulk.append(('PERF%s%06d' % (key[:6], i), (i % 977) * 1.25,
                     '2026-%02d-%02d' % (i % 12 + 1, i % 28 + 1),
                     '负责人%d' % (i % 7), 'Administrator', now, now))
    # ⚠️ 占位符分两层：外层 % 拼表名/列名/VALUES 段，内层 %s 留给 pymysql。
    values_clause = ','.join(['(%s,%s,%s,%s,%s,%s,%s)'] * len(bulk))
    frappe.db.sql("INSERT INTO `%s` (`name`,`%s`,`%s`,`%s`,`owner`,`creation`,`modified`) "
                  "VALUES %s" % (physical_table, amount_col, day_col, owner_col, values_clause),
                   [item for row in bulk for item in row])
frappe.db.commit()
print('物理表 =', physical_table, '｜样本行数 ⇒', frappe.db.sql("SELECT COUNT(*) FROM `%s`" % physical_table)[0][0])


def measure(label, payload):
    started = time.perf_counter()
    result = model_records.aggregate_records(object_id, **payload)
    elapsed = (time.perf_counter() - started) * 1000
    return elapsed, result


def p95(values):
    ordered = sorted(values)
    rank = max(0, min(len(ordered) - 1, int(round(0.95 * len(ordered))) - 1))
    return ordered[rank]


cases = {
    'count_rows': {"metrics": [{"op": "count_rows"}]},
    'count_distinct': {"metrics": [{"op": "count_distinct", "field": "owner_name"}]},
    'sum': {"metrics": [{"op": "sum", "field": "amount"}]},
    'group_by': {"metrics": [{"op": "count_rows"}], "group_by": "owner_name"},
}
report = {}
for label, payload in cases.items():
    cold_ms, result = measure(label, payload)
    samples = [measure(label, payload)[0] for _ in range(HOT)]
    report[label] = {"cold_ms": round(cold_ms, 1), "hot_p95_ms": round(p95(samples), 1),
                     "hot_max_ms": round(max(samples), 1)}
    value = result.get('metrics')
    print('%-16s 冷 %8.1fms ｜20 次热 P95 %8.1fms（最大 %8.1fms）｜结果 %s'
          % (label, cold_ms, p95(samples), max(samples), json.dumps(value, ensure_ascii=False)[:110]))

print('P95 汇总 ⇒', json.dumps({k: v['hot_p95_ms'] for k, v in report.items()}, ensure_ascii=False))
print('目标 ≤2000ms ⇒', '达标' if all(v['hot_p95_ms'] <= 2000 for v in report.values()) else '未达标')

# 清掉测量夹具（物理表 + 对象 + 应用定义）
try:
    frappe.db.commit()
    frappe.db.sql("DROP TABLE IF EXISTS `%s`" % physical_table)
    frappe.delete_doc('DocType', physical, force=True, ignore_permissions=True)
    frappe.delete_doc(model_records.MODEL, object_id, force=True, ignore_permissions=True)
    frappe.delete_doc('Shangshu Application Definition', provisioned['application_id'], force=True,
                      ignore_permissions=True)
    frappe.db.commit()
    print('测量夹具已清理')
except Exception as error:
    print('清理失败（可忽略）:', str(error)[:120])
frappe.destroy()
