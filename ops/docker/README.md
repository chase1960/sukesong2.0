# 本地 Docker 共用启动模板（Frappe + MariaDB + Redis + Node）

用途：A/B/C 三任务在本地各起一套完整尚书做真实测试。**共用的是模板，隔离的是数据**——
数据库、上传文件、Redis 缓存和队列每任务一套，靠 compose 项目名 + 命名卷前缀分开，
**不是**只换端口或换工作树。停服务保留数据，同时只起一套轮流测（省内存）。

> DevHost 没有 Docker。本模板只在本地验证；DevHost 链路仍走 `devctl preview` +
> `ops/devhost-frappe/start.mjs`，两条路互不替代。本地通过 ≠ DevHost 通过。

## 版本锁

见 [`versions.env`](versions.env)（2026-10-10 在 DevHost 现场实测取值）：
Frappe 15.118.0 @ `6adff0dc`、Python 3.12.3、MariaDB 10.11.19、Redis 7.0.15、
Node 22.13.0、bench 5.31.0。socketio 与 cache 共用一路 Redis（与 DevHost 一致，无第三路）。

## 每任务怎么起（A/B/C 通用）

1. 复制 `.env.example` 为 `.env`，改 **5 个必须各任务不同**的值（已分配见 .env.example 注释）：

   | 任务 | COMPOSE_PROJECT_NAME | NODE_HOST_PORT | FRAPPE_HOST_PORT | SHANGSHU_SRC |
   |---|---|---|---|---|
   | B（Excel 后端测试） | `shangshu-b-xlsx` | 3100 | 3102 | B 自己的工作树 |
   | A（Excel 前后端联调） | `shangshu-a-int` | 3200 | 3202 | A 自己的工作树 |
   | C（邮件完整链） | `shangshu-c-mail` | 3300 | 3302 | C 自己的工作树 |

   另有 `DB_ROOT_PASSWORD`/`ADMIN_PASSWORD`/`TEST_USER_PASSWORD`（口令只放 .env，不进仓库）。

2. 起（首次 build + bench init + 建站约 5～10 分钟）：

   ```bash
   cd ops/docker
   docker compose --env-file versions.env --env-file .env up -d --build
   ```

3. 等就绪：`curl http://127.0.0.1:<NODE_HOST_PORT>/api/platform/session` 有响应即可登录。
   登录：`POST /api/platform/login {"username":"Administrator","password":"<ADMIN_PASSWORD>"}`；
   测试身份 `ss-owner@` / `ss-reader@` / `ss-outsider@`（口令 = `TEST_USER_PASSWORD`）。

4. 测完**保留数据停服**（轮到下一家）：

   ```bash
   docker compose --env-file versions.env --env-file .env stop     # 保数据
   # 彻底清掉本任务环境：down -v（会删数据，慎用）
   ```

5. 改了 `frappe_apps/` 下的应用代码后同步进容器并迁移：

   ```bash
   ./scripts/sync-apps.sh <COMPOSE_PROJECT_NAME> shangshu.localhost
   ```

## 隔离怎么保证（逐类）

| 类别 | 机制 |
|---|---|
| 数据库（MariaDB 数据目录） | 命名卷 `<项目>_mariadb-data`，且 mariadb **不映射宿主端口** |
| 上传文件 / 站点数据 | 命名卷 `<项目>_frappe-bench`（含 sites/…/files） |
| Redis 缓存 | 命名卷 `<项目>_redis-cache-data`，独立容器 |
| Redis 队列 | 命名卷 `<项目>_redis-queue-data`，独立容器 |
| Node 运行数据（_SS_DATA_DIR） | 命名卷 `<项目>_node-data` |
| 代码 | `SHANGSHU_SRC` **只读**挂载（`/srv/shangshu:ro`），容器写不进任何工作树 |
| 显式共享卷 | **一律不用**（compose 里无 external 卷）；卷名全部带项目前缀 |
| 端口 | 只暴露 Node BFF + Frappe web/socketio 三个，且各任务 .env 错开 |

## 完成标准怎么验（B 自己跑）

```bash
./scripts/acceptance.sh shangshu-b-xlsx 3100 <ADMIN_PASSWORD>
```

测试通过 = 空数据启动 → 能登录 → 真实保存一条数据 → down（保留卷）再 up → 数据仍在
→ 卷带项目前缀且无共享卷 → DevHost 与主仓数据目录未被触碰。逐项 ✓/✗ 输出。

## 已知边界

- MariaDB 10.11 高于 Frappe v15 官方验证矩阵（≤10.8）：刻意与 DevHost 现场一致，偏差已记录。
- 首次 `up` 需要网络（bench init 克隆 frappe）；之后离线可起。
- Frappe web 直连端口仅供排查；产品链一律走 Node BFF。
- 模板不覆盖 DevHost 部署链路；合并后的集成验证仍在 DevHost 串行做。
