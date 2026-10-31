#!/usr/bin/env bash
# 进销存 + 财务闭环演示数据种子（M7）：走真实 API + 事件总线。
# 用法：BASE=http://127.0.0.1:14605 PASSWORD=admin bash scripts/seed-erp-demo.sh
# 幂等性：重复跑会重复创建（演示环境可接受；正式环境请先手动清空 business__* 表）。
set -euo pipefail
BASE="${BASE:-http://127.0.0.1:3000}"
PASSWORD="${PASSWORD:-admin}"
J='Content-Type: application/json'
CK=$(mktemp)
trap 'rm -f "$CK"' EXIT

login=$(curl -s -c "$CK" -X POST "$BASE/api/login" -H "$J" -d "{\"password\":\"$PASSWORD\"}")
echo "$login" | grep -q '"ok":true' || { echo "登录失败：$login"; exit 1; }
P()  { curl -s -b "$CK" "$@"; }
PJ() { curl -s -b "$CK" -H "$J" "$@"; }

echo "== 1. 客户（幂等：按名称查重）=="
ensure_customer() { # $1=name $2=contact $3=phone $4=address
  local exist=$(P "$BASE/api/customers" | python3 -c "import json,sys; d=json.load(sys.stdin)['list']; print(' '.join([x['id'] for x in d if x['name']=='$1']))")
  if [ -n "$exist" ]; then echo "  ✓ 已存在: $1"; return 0; fi
  PJ -X POST $BASE/api/customers -d "{\"name\":\"$1\",\"contact\":\"$2\",\"phone\":\"$3\",\"address\":\"$4\"}" > /dev/null
  echo "  + 创建: $1"
}
ensure_customer 恒泰贸易 孙立 13800000001 南京江宁
ensure_customer 蓝海制造 周工 13800000002 苏州工业园
ensure_customer 明远咨询 陈总 13800000003 上海浦东
echo "== 2. 产品（幂等：按 SKU 查重）=="
ensure_product() { # $1=sku $2=name $3=spec $4=unit $5=price $6=cost
  local exist=$(P "$BASE/api/products" | python3 -c "import json,sys; d=json.load(sys.stdin)['list']; print(' '.join([x['id'] for x in d if x['sku']=='$1']))")
  if [ -n "$exist" ]; then echo "  ✓ 已存在: $1"; return 0; fi
  PJ -X POST $BASE/api/products -d "{\"sku\":\"$1\",\"name\":\"$2\",\"spec\":\"$3\",\"unit\":\"$4\",\"price\":$5,\"cost\":$6}" > /dev/null
  echo "  + 创建: $1"
}
ensure_product SKU-001 不锈钢连接件 M8 个 2.5 1.8
ensure_product SKU-002 铝型材 4040 米 10 6
ensure_product SKU-003 碳钢棒料 Φ20 根 8 5
ensure_product SKU-004 包装纸箱 5层 个 1.2 0.8

CUST=$(P "$BASE/api/customers" | python3 -c "import json,sys; d=json.load(sys.stdin)['list']; print('|'.join([x['id'] for x in d]))")
PROD=$(P "$BASE/api/products" | python3 -c "import json,sys; d=json.load(sys.stdin)['list']; print('|'.join([x['id'] for x in d]))")
IFS='|' read -r C1 C2 C3 <<< "$CUST"
IFS='|' read -r P1 P2 P3 P4 <<< "$PROD"

echo "== 3. 采购（幂等：供应商已有单则复用；收货入库）=="
run_purchase() { # $1=supplier $2=type $3=items_json
  local pu=$(P "$BASE/api/purchases" | python3 -c "import json,sys; d=json.load(sys.stdin)['list']; print(' '.join([x['id'] for x in d if x['supplier']=='$1']))" | tr ' ' '\n' | head -1)
  if [ -z "$pu" ]; then
    pu=$(PJ -X POST $BASE/api/purchases -d "{\"supplier\":\"$1\",\"type\":\"$2\",\"items\":$3}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
    echo "  + 创建采购单: $1"
  else
    echo "  ✓ 复用采购单: $1"
  fi
  [ -z "$pu" ] && { echo "  采购单创建失败: $1"; return 1; }
  local st=$(P "$BASE/api/purchases" | python3 -c "import json,sys; d=json.load(sys.stdin)['list']; print([x['status'] for x in d if x['id']=='$pu'][0])")
  [ "$st" = "草稿" ] && PJ -X POST $BASE/api/purchases/$pu/confirm -d '{}' > /dev/null
  st=$(P "$BASE/api/purchases" | python3 -c "import json,sys; d=json.load(sys.stdin)['list']; print([x['status'] for x in d if x['id']=='$pu'][0])")
  [ "$st" = "已确认" ] && PJ -X POST $BASE/api/purchases/$pu/receive -d '{}' > /dev/null
  st=$(P "$BASE/api/purchases" | python3 -c "import json,sys; d=json.load(sys.stdin)['list']; print([x['status'] for x in d if x['id']=='$pu'][0])")
  [ "$st" = "已收货" ] && PJ -X POST $BASE/api/purchases/$pu/complete -d '{}' > /dev/null
  echo "  采购单 $pu → $(P "$BASE/api/purchases" | python3 -c "import json,sys; d=json.load(sys.stdin)['list']; print([x['status'] for x in d if x['id']=='$pu'][0])")"
}
run_purchase 宁波紧固件 常规 "[{\"product_id\":\"$P1\",\"qty\":3000,\"product_name\":\"不锈钢连接件\",\"sku\":\"SKU-001\",\"price\":1.8}]"
run_purchase 晨光包装 常规 "[{\"product_id\":\"$P4\",\"qty\":500,\"product_name\":\"包装纸箱\",\"sku\":\"SKU-004\",\"price\":0.8}]"

echo "== 4. 订单（幂等：客户已有订单则复用；确认生成应收）=="
run_order() { # $1=customer_id $2=note $3=items_json
  local oid=$(P "$BASE/api/orders" | python3 -c "import json,sys; d=json.load(sys.stdin)['list']; print(' '.join([x['id'] for x in d if x['customer_id']=='$1']))" | tr ' ' '\n' | head -1)
  if [ -z "$oid" ]; then
    oid=$(PJ -X POST $BASE/api/orders -d "{\"customer_id\":\"$1\",\"note\":\"$2\",\"items\":$3}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
    echo "  + 创建订单"
  else
    echo "  ✓ 复用订单"
  fi
  [ -z "$oid" ] && { echo "  订单创建失败"; return 1; }
  local st=$(P "$BASE/api/orders" | python3 -c "import json,sys; d=json.load(sys.stdin)['list']; print([x['status'] for x in d if x['id']=='$oid'][0])")
  [ "$st" = "草稿" ] && PJ -X POST $BASE/api/orders/$oid/confirm -d '{}' > /dev/null
  echo "  订单 $oid → $(P "$BASE/api/orders" | python3 -c "import json,sys; d=json.load(sys.stdin)['list']; print([x['status'] for x in d if x['id']=='$oid'][0])")"
}
run_order $C1 月结客户 "[{\"product_id\":\"$P1\",\"qty\":2000,\"product_name\":\"不锈钢连接件\",\"sku\":\"SKU-001\",\"price\":2.5},{\"product_id\":\"$P4\",\"qty\":200,\"product_name\":\"包装纸箱\",\"sku\":\"SKU-004\",\"price\":1.2}]"
run_order $C2 新客户 "[{\"product_id\":\"$P2\",\"qty\":300,\"product_name\":\"铝型材\",\"sku\":\"SKU-002\",\"price\":10}]"
run_order $C3 "" "[{\"product_id\":\"$P3\",\"qty\":100,\"product_name\":\"碳钢棒料\",\"sku\":\"SKU-003\",\"price\":8}]"
O1=$(P "$BASE/api/orders" | python3 -c "import json,sys; d=json.load(sys.stdin)['list']; print([x['id'] for x in d if x['customer_id']=='$C1'][0])")
O2=$(P "$BASE/api/orders" | python3 -c "import json,sys; d=json.load(sys.stdin)['list']; print([x['id'] for x in d if x['customer_id']=='$C2'][0])")

echo "== 5. 发货出库（恒泰订单）=="
PJ -X POST $BASE/api/orders/$O1/ship -d '{}' > /dev/null

echo "== 6. 回款 / 付款 =="
R1=$(P "$BASE/api/receivables?customer_id=$C1" | python3 -c "import json,sys; print(json.load(sys.stdin)['list'][0]['id'])")
R3=$(P "$BASE/api/receivables?customer_id=$C3" | python3 -c "import json,sys; print(json.load(sys.stdin)['list'][0]['id'])")
PY1=$(P "$BASE/api/payables" | python3 -c "import json,sys; d=json.load(sys.stdin)['list']; print([x['id'] for x in d if x['supplier']=='宁波紧固件'][0])")
PY2=$(P "$BASE/api/payables" | python3 -c "import json,sys; d=json.load(sys.stdin)['list']; print([x['id'] for x in d if x['supplier']=='晨光包装'][0])")
PJ -X POST $BASE/api/receivables/$R1/pay -d '{"amount":5000}' > /dev/null
PJ -X POST $BASE/api/receivables/$R3/pay -d '{"amount":800}' > /dev/null
PJ -X POST $BASE/api/payables/$PY1/pay -d '{"amount":3000}' > /dev/null
PJ -X POST $BASE/api/payables/$PY2/pay -d '{"amount":400}' > /dev/null

echo "== 7. 核对 =="
P "$BASE/api/dashboard/business" | python3 -c "import json,sys; d=json.load(sys.stdin); print('订单',d['order_count'],'| 应收未收',d['receivable_balance'],'| 应付未付',d['payable_balance'],'| 库存SKU',d['inventory_sku'],'| 毛利',d['gross_profit'],'| 事件',d['events_total'],'断裂',d['chain_broken'])"
echo "演示数据完成 ✓（客户3 · 产品4 · 采购2 · 订单3 · 回款2 · 付款2）"
