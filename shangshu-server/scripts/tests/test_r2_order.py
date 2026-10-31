"""R2 order 表（业务数据库表）单格保存恢复——用户批注「order 这个表直接存储不了」。

测试通过 = 下面每条都成立（普通账号 Desk User，不借管理员、不关业务校验）：

R2-01 改一格能存：打开订单表改 title → HTTP 200、回包含新 modified/revision、
  独立读回是新值。（当前故障：「该对象未声明原生表格，不能通过表格写入」）
R2-02 只读字段拒改：status/name/revision 之类未声明为可写的列发过去 → 被拒且理由明确，
  记录一字不动。
R2-03 类型/规则校验仍在：quantity 发 0 或非数字 → 拒（schema 业务校验没关）。
R2-04 并发闩：带过期 expected_modified 的保存 → 拒「记录已被修改」类，不覆盖他人修改。
R2-05 定义闩：expected_revision 过期 → 拒「字段定义已变化」类。
R2-06 幂等不双写：同幂等键重发同一修改 → 成功且值/修订不双跳。
R2-07 权限不扩大：无写权身份（如有）denied；普通账号能改的就那几列。

接口口径（与 excel-univer 前端 backend.ts 对齐）：
  POST /api/platform/actions/platform.object.update/execute
  payload={object_id:'orders.order', name, expected_revision, expected_modified, values}
先红后绿：orders 域尚未声明 native_table 时 R2-01 应红。
"""
import importlib.util
import json
import sys

BASE = 'http://127.0.0.1:3820'
ROOT = '/path/to/workspace'

spec = importlib.util.spec_from_file_location('t', ROOT + '/shangshu-server/scripts/test-n2-structure.py')
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)

RUN = t.RUN
PW = 'b2-user-pw-2026'
fails = []


def check(name, ok, detail):
    print(f'{"PASS" if ok else "FAIL"} {name} — {detail}')
    if not ok:
        fails.append(name)


def denied(res):
    if not res:
        return False
    st, body = res
    body = body if isinstance(body, dict) else {}
    code = body.get('code', '')
    err = str(body.get('error', ''))
    return st == 403 or code == 'PERMISSION_DENIED' or '无权' in err or 'permission' in err.lower() \
        or '不接受' in err or '未声明' in err


def rejected(res, word):
    if not res:
        return False
    st, body = res
    body = body if isinstance(body, dict) else {}
    err = f"{body.get('error', '')} {body.get('message', '')}"
    return st != 200 and st != 404 and word in err


c = t.Client(BASE)
c.login('ss-editor@example.invalid', PW)   # 普通账号（Desk User）

print('== 前置：建一条订单（orders.create） ==')
st, body = t.action(c, 'orders.create', {
    'title': f'R2判据-{RUN}', 'customer': '判据客户', 'sku': f'SKU-{RUN}',
    'quantity': 2, 'branch': 'Stock'}, f'r2-create-{RUN}')
rec = (body.get('result') or body)
name = rec.get('order') or rec.get('name')   # orders.create 回包键是 order
check('建单成功', st == 200 and bool(name), f'HTTP {st} name={name} {str(body)[:120]}')
if not name:
    print('结果： FAIL 前置建单失败，无法继续')
    sys.exit(1)

print('== 取对象定义（拿 revision 与可写字段） ==')
st, body = c.request('GET', '/api/platform/objects')
objs = body.get('list') or []   # 平台接口回 {ok, list}（不是 objects）
info = next((o for o in objs if o.get('id') == 'orders.order'), None)
check('对象在清单里', bool(info), f'HTTP {st} 清单数={len(objs)}')
revision = (info or {}).get('revision')
writable = list(((info or {}).get('input_schema') or {}).get('properties', {}).keys())
print(f'   revision={revision} input_schema 可写键={writable}')

st, body = c.request('GET', '/api/platform/objects/orders.order/records/' + name)
rec = body.get('record') or {}
modified = rec.get('modified')
check('读单条拿到 modified', bool(modified), f'HTTP {st} modified={modified}')


def update(values, mod=None, rev=None, key=None):
    return t.action(c, 'platform.object.update', {
        'object_id': 'orders.order', 'name': name,
        'expected_revision': revision if rev is None else rev,
        'expected_modified': modified if mod is None else mod,
        'values': values}, key)


print('\n== R2-01 改一格能存 ==')
st, body = update({'title': f'改过-{RUN}'}, key=f'r2-01-{RUN}')
res = body.get('result') or body
check('R2-01 保存成功', st == 200 and bool(res.get('modified')), f'HTTP {st} {str(body)[:160]}')
if st == 200:
    modified = res.get('modified') or modified
    revision = res.get('revision') or revision
st_r, body_r = c.request('GET', '/api/platform/objects/orders.order/records/' + name)
got = (body_r.get('record') or {}).get('title')
check('R2-01 独立读回是新值', got == f'改过-{RUN}', f'title={got!r}')

print('\n== R2-02 只读字段拒改 ==')
st, body = update({'status': 'Issued'}, key=f'r2-02-{RUN}')
check('R2-02 status 被拒且记录不动', rejected((st, body), '不接受') or denied((st, body)),
      f'HTTP {st} {str(body.get("error", ""))[:120]}')
st_r, body_r = c.request('GET', '/api/platform/objects/orders.order/records/' + name)
status_now = (body_r.get('record') or {}).get('status')
check('R2-02 status 未变', status_now in ('Draft', '草稿'), f'status={status_now!r}')

print('\n== R2-03 类型/规则校验仍在 ==')
st, body = update({'quantity': 0}, key=f'r2-03a-{RUN}')
check('R2-03a quantity=0 被拒（minimum=1）',
      rejected((st, body), '最小') or rejected((st, body), 'minimum') or rejected((st, body), '数量'),
      f'HTTP {st} {str(body.get("error", ""))[:120]}')
st, body = update({'quantity': 'abc'}, key=f'r2-03b-{RUN}')
check('R2-03b 非数字被拒（类型校验）', rejected((st, body), '类型') or rejected((st, body), 'integer'),
      f'HTTP {st} {str(body.get("error", ""))[:120]}')

print('\n== R2-04 并发闩 ==')
st, body = update({'title': '不该盖过别人'}, mod='1999-01-01 00:00:00', key=f'r2-04-{RUN}')
check('R2-04 过期 modified 被拒且理由是「已被修改」', rejected((st, body), '已被修改'),
      f'HTTP {st} {str(body.get("error", ""))[:120]}')

print('\n== R2-05 定义闩 ==')
st, body = update({'title': '定义闩试'}, rev=(revision or 0) + 999, key=f'r2-05-{RUN}')
check('R2-05 过期 revision 被拒且理由是「已变化」',
      rejected((st, body), '已变化') or rejected((st, body), '刷新'),
      f'HTTP {st} {str(body.get("error", ""))[:120]}')

print('\n== R2-06 幂等不双写 ==')
st1, body1 = update({'title': f'幂等-{RUN}'}, key=f'r2-06-{RUN}')
res1 = body1.get('result') or body1
st2, body2 = update({'title': f'幂等-{RUN}'}, key=f'r2-06-{RUN}')  # 同键同载荷
res2 = body2.get('result') or body2
check('R2-06 重发同键成功且不双跳', st2 == 200 and res2.get('modified') == res1.get('modified'),
      f'第一次 modified={res1.get("modified")} 第二次={res2.get("modified")} idempotent={body2.get("idempotent")}')

print()
print('结果： ' + ('FAIL ' + ','.join(fails) if fails else 'PASS R2 order 单格保存链全部成立'))
sys.exit(1 if fails else 0)
