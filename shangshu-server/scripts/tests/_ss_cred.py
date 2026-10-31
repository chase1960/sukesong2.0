"""测试凭据表 —— **公共件，只留一份**（§13）。

**这张表原先被复制进 15 个测试文件**，大多缺 3840。D 在 `test_g3_paste_package.py`
补 3840 时踩到（§13「公共工具只留一份」欠账），这里收成一份。

**用法**：
```python
from _ss_cred import CRED, pw_of
admin_pw = pw_of(BASE.rsplit(':', 1)[-1])
```

**⚠️ `_pw_of` 只认 `KEY=` / `KEY：` 前缀**（env 文件格式），读 markdown 表格返回 None（栽过）。
所以 3840 指向 env 文件、不是 `Agent-D-测试账号.md`。
"""
import os

# 每个实例的凭据文件路径（按优先级排列，第一个能读到口令的用）。
CRED = {
    # 3850 已从 green 挪给 r967（compose 项目 `shangshu-local-r967`，独立 mariadb/redis 卷）；
    # green 挪到 3852。原指 green 的映射会取到**错的**口令，登录不是同一个人（判据全测错人）。
    # 口令只从 env 文件读，**不硬编码进脚本/测试**（凭据泄漏面最小）。
    '3850': ['/path/to/workspace'],
    '3852': ['/path/to/workspace'],
    '3800': [os.path.expanduser('~/Desktop/尚书重构/开发/本地测试/测试入口.md')],
    '3810': [os.path.expanduser('~/Desktop/尚书重构/开发/本地测试/Agent-A-测试账号.md')],
    '3820': ['/path/to/workspace'
             'ops/docker/.state/environments/shangshu-local-b.env'],
    '3830': ['/path/to/workspace'
             'ops/docker/.state/environments/shangshu-local-c.env'],
    '3840': ['/path/to/workspace'
             'ops/docker/.state/environments/shangshu-local-d.env'],
}


def pw_of(path, keys=('密码', 'password', 'ADMIN_PASSWORD', 'TEST_USER_PASSWORD')):
    """从凭据文件读口令。只认 `KEY=` / `KEY：` 前缀（env 文件格式）。"""
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                for key in keys:
                    for sep in ('=', '：', ':'):
                        if line.startswith(key + sep):
                            return line.split(sep, 1)[1].strip().strip('"\'')
    except OSError:
        pass
    return None


def admin_pw_for(base_url):
    """按 BASE URL 取管理员口令。`http://localhost:3820` → `CRED['3820']`。"""
    port = base_url.rsplit(':', 1)[-1]
    for p in CRED.get(port, []):
        pw = pw_of(p)
        if pw:
            return pw
    return None


def pw_for(base_url, key):
    """按 **KEY 名**取口令，比如普通员工的 `TEST_USER_PASSWORD`。

    ⚠️ **别用 `pw_of` 取非管理员口令** —— 它按默认键序取**第一个命中**，
    env 文件里 `ADMIN_PASSWORD` 排在 `TEST_USER_PASSWORD` 前面，会拿到管理员的。
    两个账号拿到同一个口令，登录不是同一个人，后面整条判据都在测错人（栽过）。
    """
    port = base_url.rsplit(':', 1)[-1]
    for p in CRED.get(port, []):
        pw = pw_of(p, keys=(key,))
        if pw:
            return pw
    return None
