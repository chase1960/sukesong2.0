# 统一基线测试入口

产品代码基准为9673f540；本次仅整合测试代码，不将产品修复混进测试准备。

## 顺序及范围

1. `npm run test:baseline -- --list`：输出自动组及明确未执行的真实站点/浏览器脚本、辅助文件。
2. `npm run test:baseline -- --out /绝对路径/本轮新证据目录`：串行执行本地组，逐文件留日志，失败继续；目录必须不存在，禁止覆盖上一轮证据。
3. 在独立green站运行已审查的真实Frappe/API测试，指定本轮站点、身份和合成夹具；不运行未经核对的历史地址脚本。
4. 按根FDE `测试证据-半月计划逐步交互测试-2026-10-15.md` 的105例执行内置浏览器测试。DOM单测不能代替真实浏览器验收。

## 自动组

| --groups | 范围 | 环境 |
|---|---|---|
| server | shangshu-server/tests 下 .test.ts/.test.mjs/.test.js/.test.cjs | Node22.13及server依赖；部分测试还需Excel的React依赖 |
| gates | scripts/tests下门禁单元测试 | Node及tsx；检查器自身通过不等于产品门禁通过 |
| python | scripts/tests/test_*.py | Python3、openpyxl、cryptography等既有测试依赖 |
| excel | Univer目录下 *.test.ts/*.test.mjs | server的tsx与Excel依赖 |
| navigation | 现有3条页面定位回归 | Node |

默认全部本地组。`npm --prefix shangshu-server test`复用同一执行器，仅选server组。
可以用 `--groups server,gates,excel,navigation` 与 `--groups python` 分别在Node22容器和Python环境执行；报告保留各自范围，不把一份子组报告称为全量。`--only 字符串`用于定向重跑，只匹配文件路径，零匹配直接失败。

## 结果口径

- 单文件默认60秒，可用 `--timeout 秒数`调整；超时终止该文件进程组并继续。超时是TIMEOUT，不能当通过或静默跳过。
- 每文件独立临时`_SS_DATA_DIR`，不继承调用者的开发数据目录。通过后清理该临时目录，失败保留；不会删除开发库或green数据。
- 每文件日志和持续更新的results.json包含源码SHA、修改摘要哈希、测试文件哈希、运行时、退出码、耗时、Node测试计数及skip数。途中中断可看到已经完成的文件；没有结果的文件不算执行。
- PASS表示该文件正常退出；FAIL/TIMEOUT/BLOCKED均使总进程非零退出。BLOCKED只用于无法启动运行时等明确执行错误；其他失败由报告审查区分产品、夹具或依赖根因，不能凭错误文本自动判“非产品问题”。
- 运行期间源码变化会标sourceChangedDuringRun并以非零退出，不能把两份代码的结果合成一个绿灯。
- deferred中列明所有未纳入自动组的站点脚本/浏览器脚本/辅助文件。它不是待执行测试数量，也不是自动豁免清单。
- 实际平台契约门禁另跑 `npm run check:platform-contract`；行业边界检查必须使用适用policy，缺policy记未执行，不制造放宽的policy。

## 旧断言维护原则

保留已有测试，按最终批准口径逐条修夹具/过时交互，记录旧预期、新依据和变动。不可删除权限、零写入、事务、正式值读回等断言；不因现实现状改变预期。重复用例先标覆盖关系，不能只按文件名删除。当前旧chat-confirmation-presenter套件仍需核其旧按钮/来源卡断言，遇到失败或超时如实留档，不阻塞其他文件收集结果。

本轮首先形成统一红基线，再集中分配产品修复；不在完整验收过程中边改产品边累计通过。


## 真实站点测试的整合边界

真实站点测试暂不并入无参数的默认命令。接入前必须核对目标地址、合成夹具、所需身份及故障注入范围，禁止历史脚本默认连接其他Agent环境。每次单独记录产品基线、测试变更、选定case、退出状态及原始日志。

已复测的晋升组：`shangshu-server/scripts/tests/test_d_promotion_chain.py --cases da,dc,dd`；需通过环境配置明确SS_ROOT、SS_BASE、SS_D_USER和SS_D_PW，凭据从本地环境文件读取，不写进命令示例或证据。2026-10-16 green3850实跑45条通过。db/rt不在这条命令范围内，不能宣称故障恢复验证完成。

文件最新工作内容必须从`files.versions.current.source.file`下载；`versions`中的历史快照只用于历史版本断言。两种用途不得混用。所有修正保留旧失败及新复测两份证据。

## 安装态模块的统一入口

`scripts/run-frappe-baseline.py`逐模块执行仓库`frappe_apps/*/*/tests/test_*.py`，只接受专用`baseline-auto-*.localhost`站点；调用者必须显式指定容器、站点和全新证据目录。站点需事先安装目标基线应用并启用`allow_tests`。执行器不自动安装旧应用，不复用浏览器验收站。示例：

```sh
python3 scripts/run-frappe-baseline.py \
  --container shangshu-local-green-frappe-1 \
  --site baseline-auto-20261016.localhost \
  --out /绝对路径/全新站点测试证据目录
```

每模块独立进程、日志、文件哈希与耗时；默认90秒超时。使用`--module 完整模块名`选择性复测，不能把子集报告叫全量。`--skip-test-records`避免框架自动生成泛用DocType夹具，测试自身准备仍执行；缺失夹具按错误保留。站点测试会调整模块启停及提交合成数据，因此只能在隔离库运行。

**bench退出0不代表通过**：检测`FAILED`、`Ran N tests`和`OK`；禁用测试、零测试、全跳过均记NOT_RUN。容器命令超时后立即停止后续模块，保留TIMEOUT，须检查容器内进程是否仍活着，不能盲重启。3项执行器测试覆盖这些错误绿灯反例。

2026-10-16新建独立`baseline-auto-20261016.localhost`，复用冻结代码与数据库服务，隔离数据库、站点配置和文件；默认站点仍`shangshu.localhost`，无额外端口。21个已安装模块实际运行149项，模块结果10 PASS/11 FAIL；未安装的旧flow两模块NOT_RUN。证据`967-site-suite-01/results.json`及各模块日志。该轮不替代原183个本地文件结果，也不替代浏览器105项结果。新增执行器单测后，本地测试清单比原轮多1个文件，原始183文件报告不追改。
