# 星图升级与 WANX master 集成验证（2026-10-31）

本轮将 WANX master 新增的 6 个提交与星图升级组合，在隔离 checkout 中验证。未合并 master、未部署到 79、未迁移或重导入现有材料。修复仅追加到现有 WANX 审核分支；星图独立仓库代码不变。

## 验证基线

- WANX 升级分支原提交：`e1234b6d3938589a21d62d8337e619d2a9b2d01b`。
- WANX master：`9b1d7665feedd96d566e97b6663ca31428434e95`，共同基线 `689d356e8d7eb5287de2cb91725eae57b90bc13f`。
- 星图独立仓库：`b489ede9ef8d9641b938a47189069e154a4688e0`。
- WANX MR #148；配套星图 MR #6。保持两个 MR 待审核，不自动合并。
- 隔离 checkout 执行 `git merge --no-commit --no-ff origin/master` 后测试，再将本报告与修复追加到原审核分支。未将该临时合并提交到任何分支。

master 新增提交为 `9b1d7665`、`4dd09bce`、`086f03f8`、`45bcbd90`、`152452fc`、`cce36a76`，涉及应用数据 schema 延续、可信 writer 修复、知君 Host 重启数据连续性和空闲隧道。自动合并无文本冲突。

## 发现与修复

1. 内置星图安装升级虽保留旧目录，成功启动时仍会调用普通应用的 prune，删除旧的本地版本。个人版、企业版均修复为：未签名的内置星图启动后保留旧版本；签名应用及其他应用仍采用原有保留/回退策略。新增真实 manager/installer 生命周期测试，覆盖运行中保护、升级、启动、Host 重建、旧文件与合成 profile 字节保留。
2. macOS `/var` → `/private/var` 或符号链接 checkout 下，源码来源检查把共享 Studio/星图路径误判为仓库外，可能漏检共享源码脏状态。两版统一比较 realpath，并新增符号链接仓库回归；正式构建遇到共享源码修改必须拒绝，测试构建的快照哈希必须变化。同步修正打包测试的 Git 顶层路径 mock。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 根目录 `make all`（Ruff、格式、mypy、非 live pytest） | 通过：5187 passed / 31 skipped / 0 failed；Ruff 通过，mypy 701 文件通过 |
| 默认模型桥接 `tests/unit/semantica` | 21 通过 |
| 个人版 data-schema、compatibility、manager、launcher、renderer-upgrade、tunnel、通知与升级来源回归 | 159 通过，2 个真实 Electron 条件测试跳过 |
| 企业版同组回归 | 149 通过，2 个真实 Electron 条件测试跳过 |
| 单独启用真实 Electron 的知君签名应用 v3 Host 重启测试 | 两版各 1 项，共 2 通过 |
| 两版共享数据服务 | 17 通过 |
| 内置星图与新增 Host/HTTP 隧道集成测试 | 9 通过 |
| 企业版生成界面资源后的补充回归 | 288 通过 |
| 修复移回原审核分支后的独立回归 | 27 通过 |
| 两版 `build:studio`、`build:renderer` | 均成功 |

新增 HTTP 测试使用真实 loopback HTTP/CONNECT 隧道、真实通知收集器与合成模型/图谱响应：长请求、空闲后的请求、通知游标恢复、故障去重和恢复后再次故障通知通过。应用安装生命周期使用真实 manager/installer 与合成子进程握手；另有真实 Electron 的知君重启测试。以上不能替代实际 LLM 抽取、92 份材料全量检索或 79 验收。

复现主要客户端检查：

```sh
npm --prefix wanx-client run build:studio
npm --prefix wanx-team-client run build:studio
npm --prefix wanx-client run build:renderer
npm --prefix wanx-team-client run build:renderer
node --test apps/builder/tests/starlink-builtin.test.mjs apps/builder/tests/starlink-host-integration.test.mjs apps/builder/tests/personal-data-service.test.mjs apps/builder/tests/team-data-service.test.mjs
# 以下在两个客户端目录分别运行
node --test --test-concurrency=2 tests/application-compatibility.test.mjs tests/application-data-schema.test.mjs tests/application-selection-data.test.mjs tests/applications-manager-seam.test.mjs tests/application-launcher-seam.test.mjs tests/centaurloop-reinstall.test.mjs tests/renderer-upgrade.test.mjs tests/tunnel.test.mjs tests/upgrade-review-compat.test.mjs tests/upgrade-review-client.test.mjs tests/starlink-notifications.test.mjs
# 在仓库根，指定实际 Electron.app 路径启用 native 测试
WANX_ELECTRON_APP=/absolute/path/Electron.app node --test --test-concurrency=1 --test-name-pattern='real Electron reopens signed shared Zhijun v3' apps/personal-client/tests/upgrade-review-compat.test.mjs apps/team-client/tests/upgrade-review-compat.test.mjs
```

本机根目录检查使用已安装的兼容 Python 环境，通过 `uv run --no-project --python ... python -m` 调用；`PYTHONPATH` 指向当前 checkout 的 `src`、`apps/builder/backend` 与隔离解包的 local-data-gate 依赖。没有修改共享虚拟环境。原始完整桌面测试首次运行并非全绿：个人版 2460 通过/10 失败/21 跳过，企业版 2129 通过/20 失败/20 跳过。生成资源和 mock 问题已分别重跑通过；其余个人版 8 项、企业版 9 项外部 ledger/备份夹具因隔离目录缺 Python 环境或 `rtk` 未执行成功。未把这些外部测试宣称为通过，完整桌面套件尚需标准 CI 环境复核。

## 材料、版本与部署边界

- 对现有材料做只读盘点：原件 92/92，历史文本版本 90/90；基线全部字段及原件/版本 SHA-256 无差异，无增删。新版盘点工具新增 `status`、`deleted_at` 字段，比较时按历史基线字段投影，避免工具输出格式变化被误报为材料变动。
- SQLite `integrity_check=ok`，外键错误 0。测试使用临时合成仓库和 profile；没有打开正式材料做写入、重新抽取或重新发布版本。
- 原 MR 的真实模型、检索、图谱及客户端通知验证属于此前证据；本轮没有新增真实模型调用，也没有生产验收。保留原有的 89/90 历史文本检索覆盖边界和两份图片原件说明。
- 79 后续部署必须使用本次追加修复后的 WANX 源码与星图配套版本重新构建，不能沿用旧候选包或固定 9 文件 overlay。个人版/企业版均须包含旧版本保留修复。
- 维护窗口先停止写入并备份一致的数据库/WAL、原件、历史版本、衍生文件、Qdrant、Neo4j、私密配置及旧发行。沿用 79 默认模型与鉴权，禁止带入本机测试地址或凭据。迁移、真实默认模型、检索、图谱、通知与回退验收完成后才可切换。

本机详细日志保存在 `verification/starlink-master-integration-20261031/`（未随源码提交，避免包含环境或业务数据）。本报告是审核记录，不是生产部署批准。

## 后续补齐

上述个人版 8 项、企业版 9 项环境阻塞已于同日补齐。OS 配套修复与两版完整客户端最终零失败结果见 [17 项补齐报告](starlink-ledger-completion-20261031.md)。原始结果保留作为过程记录。

## 2026-11-07：材料对话跨仓集成复核

用户提交的三个开发分支均已合入对应主干。先在隔离工作区固定 Starlink `8e935fdf`、Semantica `39644a10`、WANX `dba77567` 验证，保留原工作区和既有运行服务。以下先记录本机阶段；随后获用户指定目标后的 `.80` 实机验证单独列在后文。

### 已修复的候选问题

1. WANX内置星图回执仍指向旧源码 `5e0d5755`，缺少新材料对话操作。实际旧service在发HTTP前即返回 `SEMANTICA_OPERATION_NOT_ALLOWED`。从producer正式打包流程导入完整新产物后，个人版、团队版的builtin→Host→SDK→loopback HTTP回归通过，保留此前空图修复。
2. producer沿用旧版本号会使已安装同版应用保留旧内容。本轮将producer三份权威元数据升为集成候选 `0.3.6-rc.20261107.integration.1`，提交 `683a1e3b4a74425dc4f7cf8f4606cfdb9f5d9863`，从clean commit重新产包。WANX回执绑定该提交、归档SHA256 `2090b31004e49ced6ffa1ee04e25021b8ae94882969a2a15f0a2b5b693df5024` 和93个逐文件摘要。运行中、用户自选和已签名应用继续沿用原升级保护，不强行覆盖。
3. 团队Host的main-owned工作台转发仍附带synthetic Origin，导致Bridge的service-only接口拒绝。现在仅在已有授权和scope校验成功后，对canonical UUID仓路径的有限方法移除该Origin，与个人版保持一致。浏览器入口不采用该例外；伪造native header、外源请求、编码路径、非UUID仓及DELETE负例仍被原边界拒绝。

更新内容来自producer整包，不手工拼接UI或修改SDK/AppKit生成物。个人/团队完整assemble通过，实际两份ASAR的SHA256均为 `aa34c6858c721a5a38924281be670472ef85ee0ca3a9a65c92d6c866f092ac71`。

### 尚未完成的盒端契约

`LOCAL_DATA_GATE_MODE=required` 的冻结操作集仍未纳入 conversations 及四类 `change-*`。Bridge在 `semantica/local_data_policy.py` 返回 `LOCAL_DATA_ROUTE_DENIED`；Semantica在 `app/integration/local_data.py` 返回 `403 LOCAL_DATA_SCOPE_DENIED`。合法合成EC签名、Broker租约和隔离SQLite的控制读取返回200，新建对话与四个修改接口全部403，业务表计数前后不变。新增的拒绝回归记录现有权限边界，不能作为新功能成功用例。

该缺口需要完整扩展有限operation、个人仓身份与租约合同：Host声明与选择、Bridge的账号/仓权限和body校验、共享签名协议、Semantica的operation解析及异步任务/模型回调授权必须一致。确认apply、重放/幂等、撤权、跨账号/仓、来源版本变化和取消后的发布都须验证。仅加路由或降为legacy不能作为required模式的集成方案；本轮没有扩展该鉴权协议。

Semantica当前SQLite目标为schema **30**，旧文档23属于历史阶段。旧盒必须按现有HMAC备份校验及迁移流程验证，并保留一致的数据、模型资产和回退版本。新材料修改提案复用现有 `modeling_operations`，没有单独新增迁移或启用参数。

### 验证证据与未验范围

| 检查 | 本轮结果 |
| --- | --- |
| Starlink desktop | 327个唯一用例通过，含另行启用的menu/page lifetime |
| Starlink frontend | 66项通过，typecheck及build通过 |
| Electron页面合成流程 | conversation32项、intake21项检查通过 |
| Semantica建模与相关后端 | 491项均有通过证据；原环境3项可选依赖跳过，另在隔离环境补跑通过 |
| WANX Node相关 | 94项通过，无跳过 |
| Bridge相关 | 588项通过，无跳过，包含6项required拒绝边界 |
| 跨仓模型适配预算 | 3项通过，无跳过 |
| 独立安全及契约复核 | Host/Gateway/模型确认29项通过 |

上述集合存在重叠，不相加为唯一测试总数。这一阶段使用真实源码、Host/SDK、HTTP/ASGI、SQLite、签名和打包逻辑，但账号、盒子、材料、模型响应及图谱适配器为合成夹具。当时尚未确定测试盒子，未连接盒子或调用真实模型；不能将这些本机结果或health响应视为盒内验收通过。

这一阶段列出的盒内待验项目，已按用户随后指定的 `192.168.1.80` 继续执行，结果如下。候选及诊断记录位于 `fix/starlink-box-integration-20261107`，未自动合并或替换现有服务。

### 192.168.1.80 实机：独立候选验证（初轮历史记录）

以下保留初轮观测；本地 OS 快照与旧镜像标签的解释，以后续“固定来源与旧结论更正”为准。

目标确认为 `user-M900`，x86_64、CentaurOS 1.2.0。现有 WANX 与 Semantica 均健康；Semantica 实际运行旧源码 `a5c7df7c`、schema 23、`INTEGRATION_MODE=managed`。宿主机及两个现有容器的固定 `required.json` 均不存在。本次候选以 `standalone + legacy` 的显式配置运行，没有更改现有门控或身份配置。

候选使用本盒既有 Linux 镜像作为依赖环境，只读挂载已固定的 Semantica `81c05e83`、WANX `028754fe` 源码和本盒模型资产；独立 SQLite、原件、Qdrant、日志与图数据全部位于本轮 `/var/tmp` 目录。候选端口为回环 `18488–18491`，未切换现有业务入口。源码归档 SHA256 为 `73b26395fe18a4b5f5b9ee596f0d28db4aa6ac2a41b9ae2fd2185c2a534a6ab4`。

实际服务账号通过既有专用凭据重新执行密码登录及 `/api/auth/me`，令牌仅保存在进程内存；使用真实 `DesktopConfig.headers` 派生作用域，未自签用户 JWT 或复制用户令牌。候选 ModelRelay 的异步授权回调指向候选 `18490`，未访问现有 Semantica 数据库。

| 实机检查 | 结果 |
| --- | --- |
| 合成中文材料导入、解析、对话、目标变更提案、确认应用、抽取、审核草稿 | 24 个真实 TCP 接口步骤成功，schema 30 |
| 材料阶段实际默认模型 | `deepseek-flash`，2 次真实调用，3 条候选、1 份 editing 草稿 |
| 提案与应用重放 | 未新增模型调用，应用未提前抽取或发布 |
| 恢复候选后端 | 自动 worker/pipeline 关闭，启动前后 19 张业务表的计数与内容摘要一致 |
| 真实 WANX Bridge → 候选 Semantica | 5 个接口成功，包含新建/读取候选仓中的对话 |
| Bridge 拒绝边界 | 错误 Bearer 401、浏览器 Origin 403、团队上下文 403 |
| 审核并发布既有合成草稿 | 13 个接口步骤成功，publication=published、effective=true |
| 实际独立 Neo4j | 业务图 2 个实体、1 条关系；所有底层节点均在候选 namespace 中 |
| 实际本地 BGE / Qdrant | 512 维索引，fresh/compatible，向量检索命中合成材料 |
| 受保护检索 | 按实际请求执行 1 个敏感检测任务并成功交付；增加 1 次真实模型调用 |
| 事实与检索片段证据读取 | 两类实际 HTTP 请求均 200，绑定当前材料/版本/段落；保护结果均为 masked |
| 材料初读 analyze 与普通 messages 追问 | 10 个接口步骤成功，2 次真实模型调用；回答任职公司正确，两条回复持久保存 |

发布阶段没有替换图谱、向量或模型实现。图引擎使用本盒镜像内既有 Neo4j 软件，在独立空目录和 `18491` 启动；BGE 使用本盒模型资产的只读挂载，Qdrant 在独立候选目录。审核逐字核对合成实体、任职关系及来源区间，仅补充审核说明后提交；发布和建索引本身未新增 LLM 调用。加上材料初读和普通追问，全阶段共 5 次真实模型调用，测试原件的 SHA256 前后相同。

证据追加检查未调用模型或执行任务，19 张业务表摘要前后相同。SQL 中的事实及索引原文均能逐字对应当前来源，HTTP 的材料/版本/段落 ID 一致。交付保护将合成人名识别为敏感内容而返回 masked，未关闭保护；因此未将其描述为“HTTP 原文及未脱敏 locator 均已验证”。

普通对话在新候选会话中关联同一份已发布合成材料，真实 analyze/messages 各执行一轮产品任务，未替换模型响应或修改产品重试预算；各使用一次请求。两轮回复均包含当前版本和合法片段范围，追问返回“林澈在晴川测试公司任职”。重复 operation 复用原 turn，未重复执行；对话前后材料、发布及索引相关九张表内容摘要一致，没有隐式抽取或发布。

上述流程使用真实解析器、模型适配器、ModelRelay、回调和实际供应商响应；材料全部为合成内容。沿用当前自动默认模型及其 revision，未在盒上运行客户端 `/processing/check` 与云模型同意 UI 流程。解析、抽取等任务由验收驱动显式 claim/执行，不能据此宣称自动后台调度已完成验收。真实登录及供应商调用会产生正常认证日志或用量。

本盒未安装本轮候选桌面客户端，未完成真实 Renderer → IPC → Host 的整套点击流程。真实 Bridge 只覆盖表中 5 个接口；材料目标变更、抽取、发布和索引由可信集成 API 驱动，不能将它们写成桌面全链端到端通过。候选源代码覆盖和本机 Host/SDK 测试不替代该项实机缺口。

收尾已移除本轮精确标签下的 8 个临时容器及全部候选目录、独立图数据和临时签名配置，`18488–18491` 全部关闭。原 WANX `088d9835f111`、Semantica `1048e799d6f4` 的容器 ID、镜像、启动时间均保持不变，仍为 healthy，restart count 均为 0。未迁移或写入现有 Semantica 业务材料库。脱敏结果、驱动摘要、OS 兼容性复现、清理及状态对照保存在本机临时证据目录 `starlink-box-integration-20261107`，不提交私密配置或业务数据。

### 初轮旧 OS 快照发现的部署阻断

初轮使用的本地 OS 快照 `bd2fc36a` 与新版 Semantica 的部署契约不一致，不能将该轮旁置候选成功解释为现有盒子可直接原地升级：

1. 新版 `app/config.py` 仅接受 `INTEGRATION_MODE=standalone`。在本盒候选 Linux 容器中，保留现有 `managed` 值即返回 `integration_mode/literal_error`。
2. OS `deployment/app_modules.py:991` 拒绝 standalone 私有 env，`:1085` 又以 Docker 参数强制设置 managed；仅修改 env 无法解决。部署已有镜像也经过同一 runtime 参数生成路径。
3. OS `deployment/docker/semantica.Dockerfile:33` 的构建门禁导入新版已删除的 `app.integration.auth.authenticate`。实际对候选源码执行门禁退出 1；九项检查共同失败于该导入边界，并非证明九种安全行为分别失败。OS 三项隔离测试也确认现有构建与运行约束仍为 managed。

需要先统一 OS、Semantica 和 WANX 的身份及部署契约，再验证受管升级、旧数据迁移与回退；不能直接跳过门禁或把改成 standalone 当作完整鉴权迁移。该阻断独立于 required 模式对 conversation/change-* 的拒绝。此次未修改 OS 仓库或现有私有配置，也未尝试实际镜像构建、业务库迁移和原地升级。
## 2026-11-07 续：192.168.1.80 盒内验收阶段记录

用户随后指定 `192.168.1.80` 并授权继续验证、修复发现的问题。以下记录本轮截至北京时间 2026-11-08 的结果，前述“尚未连接盒子”等表述保留为本机阶段的历史范围。正常构建、隔离迁移、个人版实际桌面、required 签名 HTTP 业务闭环与在途撤权、一小时资源采样均已执行。测试使用旁置端口与合成材料，未切换现有业务服务；各项验证的范围分别列明。

### 固定来源与旧结论更正

| 对象 | 本轮来源或已实跑制品 |
| --- | --- |
| OS 当前主干起点 | `e4f8b3781bde7d850771e13e5a181d6db94d7216` |
| Semantica 当前主干起点 | `259f8a98974fdaed8bcee913568b9d43ed75eaa5` |
| WANX 当前主干起点 | `58ac826fed5e5dccc35628aec895f19e05e7a987` |
| 已完成桌面 full-7 的 Starlink producer | `4e31f4aeb0e74f7fa0b8effe91938508d778fe73`，`0.3.6-rc.20261107.integration.2` |
| 最终正式打包的 Starlink producer | `c08cb0fb060c06699349fcf50d3e57f68f33ba0e`，`0.3.6-rc.20261107.integration.3` |
| Semantica 最终实机代码 | `56ef952813c08c606b8207a6c7d36c6b6df59adf` |
| WANX 协议、兼容与内置制品代码 | `cbe7bbfa14adbc169320ead1e506ba42ff2450b6`；本报告另追加提交 |
| 本轮隔离修改分支 | 三个修改仓库均为 `fix/starlink-box-acceptance-20261107`；OS 无源码修改 |

先前关于“OS 强制 managed、新版 standalone 无法通过旧 authenticate 构建校验”的判断来自本地旧 OS 分支 `bd2fc36a`，不能作为当前 OS 主干的结论。`e4f8b37` 已包含 standalone 交付适配及受验证的环境覆盖；本轮以该主干重新执行正常构建，未通过删除校验或仅手改私有 env 绕过交付契约。

旧运行环境的身份也须更正：现场 Semantica 镜像 digest 为 `sha256:4f460c2a41bf21855f379f579da0ddeb61edaaf72d596a606818b0fc74ef9ca8`；此前实机读取的 `app/db.py` 摘要为 `bd378a5d2a4a69c83a67a6b1eab8b8df00e632b6018c5fbd2fd1f40996f75b4e`。旧镜像标注的 Git 源码 `a5c7df7c` 对应仓库文件实际声明 schema **11**，不能据此重建现场 schema **23** 的旧程序。迁移来源须以现场镜像、实际代码摘要和数据库元数据分别确认，不能将镜像标签、Git 提交和实际数据库版本混写成同一证据。

### 正常构建与隔离迁移、回退

OS 正常 Semantica 构建入口已在盒端执行成功，固定源码为上表的 OS、Semantica、WANX 主干快照。生成 amd64 镜像 `sha256:d0817a6847dc6f08b657dcd6f8a320d289a6368a91cfd0fae3780a75b3f602a6`，声明 `integration_runtime_profile=standalone-v1`、`local_data_gate_version=1`、`data_policy=migration-required`。Docker gzip 制品 SHA256 为 `739a07e4cde88b047521e89be47e8940e69f80070ab31bdf5d99c4a288a9f7d5`。这证明该固定快照可走正常构建链路；后续 required 修复的最终制品和物理复核须另行记录，不能以这份镜像代替最终候选验收。

| 检查 | 已有结果与准确范围 |
| --- | --- |
| 真实旧库一致副本 | 使用 SQLite `mode=ro`、`PRAGMA query_only=ON` 和备份 API；读取阶段不导入业务应用、不触发迁移、不复制现场文件树 |
| 合成 schema 23 fixture 升级 | 升至 30，64 张既有业务表内容保留，0 次模型调用 |
| 真实旧库副本升级 | 现场数据库实际 schema 23；仅在隔离副本升级至 30，64 张既有业务表的投影与摘要保留，0 次模型调用 |
| 合成旧环境官方恢复 | 调用旧程序正式 restore 路径成功，恢复 schema 23，旧版公开读取通过；不是仅手工复制 SQLite 文件冒充恢复 |
| 真实副本回退读取 | 旧归档验证通过，恢复后的旧 schema 23 元数据读取通过；范围为 SQLite，不包含完整业务文件和图、向量引擎回退 |

“64 张保留表”指既有业务表的验证集合，不与 schema 元数据、后续新增表或现场盘点的总表数混为一谈。真实副本的回退属于 SQLite 层验证，尚不能证明数据库、原件、历史版本、衍生文件、Qdrant、Neo4j 及私有配置的完整一致冷备与回退。未将现场业务库原地升级，也未替换现有业务数据来执行迁移测试。

### 实际个人版桌面与真实盒内处理

`desktop-native-full-7` 使用实际 Starlink Electron 窗口、Renderer、IPC、Host 和盒端原生入口，安装版本为 integration.2。用例完成 15 个可见阶段，记录 324 个 HTTP 请求；材料初读 `POST /analyze` 与普通追问 `POST /messages` 均返回 202。这里的 202 是任务受理回执，后续还实际等待回复、审核和发布结果；并非仅检查连接健康或受理成功。

执行阶段为：连接盒子、新建会话、核对来源、材料初读、普通追问、生成修改差异、确认应用、确认抽取计划、查看候选、核对审核差异、发布预览、确认发布生效、查看图谱、检索结果、打开来源。各阶段保存了截图与页面状态，记录中未出现页面错误。实际问答回答任职公司，修改提案应用后仍保留独立的抽取和发布确认。

该轮使用已存在的合成材料，未验文件选择器上传，也未把“关联已有材料”写成桌面空仓建仓和文件上传全部通过。真实默认供应商响应、独立 Neo4j、本地 BGE 与 Qdrant 参与处理；发布后业务图展示 2 个实体、1 条关系，检索返回当前材料片段，向量、关键词及知识关系来源可见，并实际打开保留版本的来源窗口。敏感交付保持脱敏规则，未为通过用例关闭保护。

这次完整桌面执行仍属于旁置 legacy 候选连接，不能证明 required 的本地身份、Broker、持久任务、模型回调及撤权物理全链已通过。额外的模型来源显示复核只使用了 integration.2 的单文件 `sourceapp.js` 临时覆盖，执行 24 个 GET、没有新模型调用；它仅证明该显示修复的局部效果，不是最终整包或新一次全流程验收。

最终 producer `c08cb0fb` 已完整打包 integration.3，归档 SHA256 为 `ad2a6360599c8a19ed11ce7b9e5c87c793c4b82f659731f1a4ef564ae253bee3`。producer desktop 338 项全部通过、0 跳过。WANX 正式来源回执核对 93 个文件，两版完整 assemble 均通过；两版产物中的 Builder 过滤部分 ASAR 摘要均为 `00069db9e76e8a3b2a2340cdb06df7edb710b86948ab8225d1d4748f402d1bfc`，四组 Builder 验证共 34 项通过。

`desktop-source-display-official-9` 从该正式 integration.3 整包安装并运行真实 Electron、Renderer、IPC、Host，以 25 个 GET 完成模型来源显示复核，显示的模型与处理来源正确，没有单文件 overlay，也未请求新的模型推理。这补齐了此前局部覆盖的制品来源边界；该次只读重载复核与 integration.2 的 full-7 完整材料流程仍分别记录，不将它写成 integration.3 的 required 全流程已通过。required 通道未支持的迁入迁出已有明确不可用提示，未伪装成迁移能力已开放。

### 本轮 required 契约修复与测试边界

共享契约已补齐有限的会话、材料意图、初读问答、修改提案、审核纠错、个人仓引导及模型配置入口。真实桌面请求盘点另发现并补齐两个有限 GET：`/warehouses/runtime` 的公开运行元信息读取，以及 `/workbench/knowledge/runs/{run_id}` 的当前仓抽取结果读取。两项均保持只读、无正文、无可选仓查询；资源所属关系继续由后端检查，资源 ID 与编辑凭据不能替代已验证的账号、仓和存活授权。

required 的异步任务采用独立 Semantica task capability，模型请求通过私有 UDS 取得短时、一次性、绑定原始字节及模型快照的 proof；不回退到旧 HMAC、用户 Bearer 或虚构数字账号。派生任务仅允许 parse→index/sensitive、publication→index/sensitive、index→sensitive，深度最多 2。实际 Broker、真实 ECDSA 与共享客户端的跨组件测试已证明原始请求父链保持稳定，父任务及 HTTP 关闭后子任务仍可导出恢复；修改来源摘要、替换父链、已关闭任务及撤权后的恢复均被拒绝。模型提供方 I/O 的物理关闭独立计入证据，后端任务结束不等于模型连接已排空。

默认完整 ship bar 曾发现 6 项本轮引入的旧客户端兼容回归：新共享路由优先匹配后，legacy 纠错传输被提前套用 required 的完整 DTO 校验。修复限定在旧 `SemanticaClient` 的有限纠错传输分流，业务 revision 校验仍归 Semantica，required 严格合同未放宽。原模块从 6 failed / 32 passed 变为 38 passed；另有 required 编辑命令缺少 revision 仍须拒绝的回归。

| 验证组 | 已记录结果 |
| --- | --- |
| 共享传输、bootstrap 与任务客户端回归 | 23 项通过；包含合法流程和 selector、operation、编辑租约、确认、分页、恢复与撤权负例 |
| 独立模型 proof 与仓映射协议回归 | 13 项通过；包含真实 ES256、类型/密钥/到期、原始 UTF-8 字节及快照绑定 |
| 共享包整组 | 36 项通过；与前两组为同一集合，不另计新增用例 |
| 共享客户端与实际 Broker 跨组件恢复 | 3 项通过；运行实际 LocalDataSessions 和授权执行器，仅固定内核 peer 传输适配 |
| 旧 scoped 纠错客户端完整模块 | 38 项通过，包含上述 6 项兼容修复与既有作用域、错误脱敏检查 |
| Bridge 先行全量回归 | 2416 passed、3 skipped；该次全量早于最后的物理模型关闭和共享 DAG 补充 |
| Bridge 后续受影响的模型、UDS Relay 与物理关闭验证 | 30 项通过，包含独立模型关闭证据及有限派生任务；与全量及下列 TLS 组分别记录 |
| Bridge 实际 TLS Gateway 有限入口组 | 9 项通过，覆盖 runtime 与 knowledge run 读取；执行实际 Gateway、native gate 及 Unix Broker |
| Host 授权及 HTTP 通道组 | 80 项通过、0 跳过；使用实际两版 Host 实现及固定 TLS 夹具，不是物理盒 Renderer 结果 |
| producer desktop 最终候选 | 338 项通过、0 跳过 |
| 最终内置制品的四组 Builder 验证 | 34 项通过；正式回执、93 文件及两版 assemble 另有摘要核对 |
| Octop 默认 `make all` 隔离快照 | exit 0；Ruff/format 1408 文件、mypy 697 文件通过；pytest 5344 passed / 34 skipped / 0 failed / 0 error，整体耗时 617.33 秒 |

该次默认完整 ship bar 在隔离源码快照和同锁依赖齐备的环境执行 `make all RUN='uv run --no-sync' PYTEST_JOBS=4`，没有同步改写共享虚拟环境。快照与来源核对记录保留任务文件摘要；格式工具仅产生已识别的既有测试文件格式差异，未改写任务产品文件。producer 最终归档、内置回执与 assemble 验证另行记录，不以完整 ship bar 的快照结果代替后续制品核对。

这些集合存在重叠，不相加为唯一测试总数；单元/夹具中的签名、Broker 和合成 provider 测试，也不替代 required 的真实盒内 provider 与撤权测量。`/warehouses/transfers` 虽在 legacy 初始化中出现，迁移回执、导入导出和归档 blob 尚未纳入本轮 required 对外契约；保持明确拒绝，未通过泛开放迁移家族消除请求错误。

### 最终 required 实机结果

实机发现模型 check 返回 `422 MODEL_INVALID_REQUEST`：Semantica 将完整 catalog/profile DTO 发给只接受 `{id,revision}` 的严格 Relay。修复统一放在 required 的序列化边界，在正文编码及签名前投影 check 和 infer 的 selection，本地完整配置与任务快照保留，legacy 传输不变。新增实际 ASGI/service 出线回归由失败变为通过，相关后端 71 项通过；实际 B serializer→严格 D listener→签名 UDS Broker 的 check/infer 两项跨组件验证通过，直接发送旧完整 DTO 仍被拒绝。

以最终 Semantica `56ef9528` 和 WANX 共享包从 OS 正常入口重新构建 amd64 镜像 `sha256:7e2d3341ee4e5ae1e8daa5b186c327a4065fd57b356c73bcd048d928ccd44e16`，Docker gzip 制品 SHA256 为 `5aa640967964db1b0701a583e8d15ba608ef91afceee9dec23ad863d815191ba`。镜像保留 standalone、migration-required、local gate 和 graph runtime 能力；实机 backend 使用原始 ENTRYPOINT/CMD 启动真实 worker。

私有 authority 在盒内新建真实 SQLite，执行 provision、根端 claim、use 端 approve、v2 迁移及 owner policy 激活。私钥仅在盒内 scratch 生成和使用，不读取线上 authority。实际 TLS Gateway、Unix Broker、fresh Octop、独立 ModelRelay、Semantica 分别运行；Semantica UID11004，Octop/Relay UID10003，内核 SO_PEERCRED 对 UID0 冒称 Semantica 返回403。fresh Octop 的真实本地主体映射 `/api/auth/me` 返回200。该候选使用新的 box/principal 和测试信任根；模型目录及供应商沿实际盒子既有投影和设备租约独立鉴权，不伪造供应商或取消租约校验。

真实签名 HTTP 用例已完成：私有仓与模型检查/保存→发布合成窄本体→上传→正常后台 parse→会话初读→生成/读取/应用 goal 修改提案→确认计划与后台抽取→审核合并→核对来源窗口→明确发布→实际 Neo4j 图→本地 BGE/Qdrant 索引→保护检索→不可变原文范围核对。抽取返回3条候选，发布得到2个实体、1条关系，检索命中1条且来源匹配合成正文。各阶段在任务终态后关闭会话，后续建立新有效会话并读取当前修订；保存的检查点只含资源/业务请求，不恢复过期会话或任务票据。这是签名 HTTP 与真实 worker 的物理验证，客户端 applicationId 为 `wanx-host`，不能改写为 integration.3 Renderer 在 required 通道的完整桌面验证。

随后在另一个合成会话中，先观察到真实供应商 `_generate` 对当前 job 的在途入口，再用真实签名 ledger 撤销 use binding。签名物理回执为 effective：9个目标操作全部关闭，pending=0、unknown=0；本地供应商调用及响应/socket finalizers 已排空，原会话读取返回403。只读 SQLite 复核：对应 job 为 failed / `MODEL_TASK_REVOKED`、turn failed、该会话助手回复0条，数据库 integrity_check=ok。它证明本盒不再接受结果或继续相关副作用；不推断外部供应商已收到请求后的远端计算或计费一定停止。

### 一小时资源观察与交付边界

旁置桌面候选自 UTC 15:25:11 至16:25:11采集720点，每5秒一轮，状态 completed。全段平均9.12%单个逻辑核；真实桌面工作窗口均值19.94%、峰值80.27%单核。流程结束后的43分钟均值8.74%单核，约为12核整机容量的0.73%；完成任务11、模型调用记录8及 SQLite data_version=20 全程保持不变。独立 Relay 成功调用账本仅在实际操作窗口新增，空闲段没有新增记录。内存从流程后约847MiB回落至约738MiB，未见持续上升。

5个新进程实测正常健康检查各耗约0.253–0.272 CPU秒，现有10秒周期解释约2.6%单核后台开销；驻留线程20秒采样合计约5%，与空队列 worker 轮询相符。线程职责对应依据启动顺序推断，未冒充已做函数级剖析。SQLite data_version 变化只代表观测到的提交版本变化，不是 SQL/事务次数；采样 JSON 的持续重写也产生磁盘写入，不能把总 I/O 当成业务写入。一小时采样针对旁置 legacy 桌面候选，最终 required 候选另有功能/撤权验证，未将两者资源结果混写。

本轮没有验证桌面系统文件选择器、integration.3 Renderer 的完整 required 交互、真实现存 principal 的原位迁移，或包含 Neo4j/Qdrant/附件/私有配置的完整一致冷备回退。它们不由上述 SQLite、HTTP 或局部桌面证据替代。现有线上服务保持原镜像、容器ID、启动时间、重启次数及挂载，正式升级仍须按 migration-required 准备维护窗口与完整备份。

收尾已按本轮精确标签删除18个临时容器，删除3个候选镜像标签及3个本轮基础镜像别名，回收约5.98GiB。私有 scratch、测试私钥、真实库副本、归档及远端构建制品均已删除，剩余本轮容器0；本机18788验收转发已关闭，借用的依赖符号链接已移除且依赖目标未改动。最终对照确认原 Semantica `1048e799d6f4`、WANX `088d9835f111` 仍为原镜像、原启动时间、重启次数0、healthy，固定 required policy 仍与基线一致。本轮没有把候选容器切换为线上服务。

脱敏证据位于本机 `starlink-box-acceptance-20261107` 目录，包括构建/迁移、桌面 full-7、official-9、`runtime-evidence.json`、`resource-samples.json`、`resource-analysis.json`、`resource-healthcheck-profile.json`、`cleanup.json`、`live-continuity.json`、Bridge/Host 回归及 `octop-final-make-all-result.json`。报告不提交凭据、令牌、任务票据或数据库副本。
