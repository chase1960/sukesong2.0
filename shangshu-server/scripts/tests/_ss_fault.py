"""故障断点的**装 / 卸** —— 测试侧唯一一份（§13 公共工具只留一份）。

**断点法是产品里本来就有的**（`shangshu_files/sheet.py` 的 `_fault(point)`），
不是我们为测试加的后门：

  · 钩子读 `SS_FAULT_FILE` 环境变量，读不到就退回站点配置 `ss_fault_file`
  · **两个都没设时钩子完全关闭** —— 产品默认路径一个字节都碰不到
  · 设了也只是「文件里写着某个点名」时才炸；文件不存在 / 内容不对，照常放行

**点名**（现在有的）：
  · `file-write` —— 落盘前（`sheet._save_version` 开头）
  · `op-record`  —— 写操作台账时（`sheet._record_op`）

**怎么用**（主机跑测试、断点文件在容器里，所以要 `docker exec`）：

    from _ss_fault import arm, clear, compose_of
    compose = compose_of('http://127.0.0.1:3840')
    arm(compose, 'file-write')      # 装上：走到那个点就炸
    ...                             # 打接口
    clear(compose)                  # 卸掉，恢复常态

⚠️ **`clear` 必须在 finally 里调** —— 断点留在容器里，之后每一次落盘都会炸，
下一轮测试会红在莫名其妙的地方。`test-excel-b2.py` 里有一份**更早的内联实现**，
是历史遗留；**以本模块为准**，合并它待办（不在这轮做）。
"""
import os
import subprocess

# 容器里断点文件的路径。必须跟站点配置 `ss_fault_file` 一字不差。
FAULT_PATH = '/tmp/ss-fault-point'


def compose_of(base):
    """从 SS_BASE 反推 docker compose 项目名（`http://127.0.0.1:3840` → `shangshu-local-d`）。

    **不猜**：端口映射在 `开发/本地测试` 的环境表里是固定的，3810/3820/3830/3840
    各对应一条线。认不出就抛，不退回一个「大概对」的项目名 —— 那会把断点装到
    **别人的实例**上（共享工作区，装错了比不装坏）。
    """
    port = str(base).rsplit(':', 1)[-1].strip().strip('/')
    known = {'3850': 'shangshu-local-r967', '3852': 'shangshu-local-green', '3840': 'shangshu-local-d', '3830': 'shangshu-local-c',
             '3820': 'shangshu-local-b', '3810': 'shangshu-local-a'}
    name = known.get(port)
    if not name:
        raise ValueError('认不出这个端口对应哪个 compose 项目：%r —— 不猜，'
                         '怕把断点装到别人的实例上' % base)
    return name


def _frappe_container(compose):
    return '%s-frappe-1' % compose


def _exec(compose, script):
    return subprocess.run(
        ['docker', 'exec', '-w', '/home/frappe/frappe-bench', _frappe_container(compose),
         'bash', '-c', script],
        capture_output=True, text=True, timeout=60)


def arm(compose, point):
    """装断点：写点名进断点文件。回 ``(成功, 说明)``。

    **装完必须自己核一眼**（`cat` 回来对得上）—— 光看命令退出码 0 不够，
    写进去了但路径不对会「以为装上了、其实没炸」，那是**空过长得跟过一模一样**。
    """
    r = _exec(compose, 'printf %s > %s && cat %s' % (point, FAULT_PATH, FAULT_PATH))
    got = (r.stdout or '').strip()
    ok = r.returncode == 0 and got == point
    return ok, 'rc=%s 写进去=%r（要 %r）' % (r.returncode, got, point)


def clear(compose):
    """卸断点。回 ``(成功, 说明)``。**测试收尾必须调**（放 finally）。"""
    r = _exec(compose, 'rm -f %s && ls %s 2>&1 | head -1' % (FAULT_PATH, FAULT_PATH))
    out = (r.stdout or '').strip()
    ok = r.returncode == 0 and 'No such file' in out
    return ok, 'rc=%s 残留检查=%r' % (r.returncode, out[:80])
