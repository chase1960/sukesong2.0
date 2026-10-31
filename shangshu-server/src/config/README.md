# 部署配置（config/）

两套部署配置，切换 = 换配置 + 换三个可换缝的实现：

| 文件 | 用途 |
|---|---|
| `route2.json`（路线2） | 飞书基底：多维表格当库、agently/lark-cli 当集成、飞书云空间存文件 |
| `route4.json`（路线4） | 私有栈：Postgres + pgvector 当库、本地/S3 存文件、本地模型可选 |

> 当前运行配置走 `shangshu-server/data/runtime_config.json`（系统配置页读写、运行时热切 provider）。
> 本目录用于沉淀**部署级**的固定配置模板（与运行时配置互补）。两个 json 模板待路线2/4 正式部署时补。
