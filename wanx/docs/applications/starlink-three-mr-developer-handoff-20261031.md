# WANX · 星图升级：三个合并请求开发交接

交接日期：2026-10-31（Asia/Singapore）。用途：开发审核、配套集成与后续 79 维护窗口执行准备。

**状态更新（文档提交时）：CodeUp 已显示 WANX #148、星图 #6、OS #70 为“已合并”；本次文档交付没有执行任何合并或部署。以下基线、验证结果和建议合并顺序保留为合并前交接记录，发布/部署/回滚命令仍为未来执行模板，未在本次执行。**

本次核对 WANX 远端 master 为 `f2d2fd57c0857968ceb152b10ced77033db1f646`（Merge #148），尚不包含交接说明。本文仅推送到既有 `codex/starlink-upgrade-20261031` 分支，通过固定提交链接关联三个 MR；不会因编辑已合并 MR 的说明而自动进入 master。

## 1. 审核入口与版本基线

| 仓库 / 合并请求 | 审核分支 | 已验证代码基线 | 本次核对的 master |
| --- | --- | --- | --- |
| [WANX #148](https://codeup.aliyun.com/667637d76d5f7b05cc5d9ed7/centuarai/centuarai-wanx/change/148) | `codex/starlink-upgrade-20261031` | `6913eb1b42032a73915178b537c60bc4bad2be6f` | `9b1d7665feedd96d566e97b6663ca31428434e95` |
| [星图 #6](https://codeup.aliyun.com/667637d76d5f7b05cc5d9ed7/centuarai/centuarai-wanx-startlink/change/6) | `codex/starlink-upgrade-20261031` | `b489ede9ef8d9641b938a47189069e154a4688e0` | `29d46e7d0612098737ab950a77876c56a2242f73` |
| [OS #70](https://codeup.aliyun.com/667637d76d5f7b05cc5d9ed7/centuarai/centuarai-os/change/70) | `codex/starlink-backup-compat-20261031` | `9be7a3f3721e57ffa04f362327e56363be5ba432` | `bd372e19f26162ac337239ba6deb82f6cd237f80` |

表中固定的是本轮功能与测试代码基线；本交接说明的后续纯文档提交不改变这些测试对象。编写交接时通过远端引用重新核对，以上 SHA 未变化，三个源码工作区干净。前轮三个 `git merge-tree --write-tree` 检查均返回成功、无文本冲突；该结论只覆盖表中提交，合并前仍须刷新目标分支。无文本冲突不等于业务验收完成。

WANX 已在隔离 checkout 验证“升级分支 + master 新增 6 个提交”的组合；**`6913eb1b` 本身并未把这 6 个提交合入其历史**。新增提交为 `9b1d7665`、`4dd09bce`、`086f03f8`、`45bcbd90`、`152452fc`、`cce36a76`。正式构建应固定经过复测的最终合并提交，不能直接把功能分支 HEAD 当作集成后的发行版本。

## 2. 改动分工和依赖关系

| 来源 | 交付内容 | 为什么不能单独交付 |
| --- | --- | --- |
| 星图 #6 | 默认模型严格解析；本体工作台与统一 UI；材料处理、检索/图谱接线；持久失败事件；恢复后通知来源标识处理 | 依赖 WANX 默认模型契约、鉴权转发与客户端通知中心；仅升级星图服务无法让旧客户端获得新通知能力 |
| WANX #148 | 默认模型桥接、受鉴权的本体/失败记录接口；两版通知中心接入与隔离、去重、补收；内置星图统一打包；升级保留旧版本；来源校验及测试环境修复 | 需要匹配的星图服务；内置桌面资源不等于盒端 Python 服务；备份结构兼容另由 OS 提供 |
| OS #70 | 精确支持已审 WANX schema 34 / 星图原生 schema 23 的私有材料契约；撤销状态隔离；恢复历史失败任务不重放新通知 | 必须进入实际运行的宿主备份工作器；只更新 WANX 镜像或本机 OS checkout 不会自动替换它 |

实际调用关系：客户端内置星图 → WANX 鉴权/模型桥接 → 星图服务及其材料、索引、图数据库；失败记录经 WANX 返回客户端通知中心。OS 负责另一条备份/恢复链路，不是聊天模型提供方。

个人版、企业版唯一受版本控制的完整内置星图位于 WANX 的 `apps/team-client/applications/starlink/`，共同使用 `apps/builder/tools/assemble-starlink.mjs`。`apps/builder/integration/starlink-source.json` 固定版本 `0.3.5-rc.20261031` 和资源哈希。星图 MR 合并后不会自动更新这份内置快照；若审核中修改前端，必须同步资源及哈希清单，重新验证两版实际 ASAR。

OS 配置里的模块/源码别名仍叫 `semantica`，**本次 `sources.semantica.repo` 应指向 `centuarai-wanx-startlink` 仓库**。不能保留默认的 `centuarai-semantica` 仓库地址却填入本次 Starlink 提交；本次交付应以 #6 的整合源码为准。

## 3. 合并前建议与后续发布门槛

建议 **星图 #6 → OS #70 → WANX #148 → 固定三仓最终 SHA，重新构建并集成验收**。这是为了先固定服务/结构契约，再固定兼容层和消费者的审核顺序，不是 Git 的跨仓强制依赖。三个 MR 可并行审查，但不能把单个 MR 合并当作整套功能已发布。

1. 星图审核：默认/手动模型优先级、错误事件、原框架本体页面、原件与版本保全。
2. OS 审核：全结构指纹、拒绝未知结构、主体隔离、非空目标保护和恢复通知防重放。接受“明确拒绝”的受限场景，不能靠丢弃本体/发布历史通过测试。
3. WANX 审核：与最新 master 的组合、两版旧版本保留、相同源码组装、默认模型桥接和账号/盒子/仓隔离。
4. 在最终合并结果上执行 CI；任一仓发生新改动都需重定来源与相关测试。记录三仓完整 SHA、镜像 digest、客户端签名版本、模型清单 digest、release ID、上一可回退 release ID。
5. 正式发布和 79 部署另行安排。当前候选不代表 Linux 实盒、签名安装器或生产验收完成。

## 4. 验证结果及证据边界

### 最新补齐结果

| 检查 | 结果 |
| --- | --- |
| 原环境阻塞 17 项 | 全部执行通过；连同同组账号切换保护共 **18 通过 / 0 失败 / 0 跳过** |
| 个人版完整 Node 测试 | **2470 通过 / 0 失败 / 21 条件跳过** |
| 企业版完整 Node 测试 | **2477 通过 / 0 失败 / 20 条件跳过** |
| 测试进程启动失败/提前退出 | 4 通过 |
| 正式打包工具针对性复测 | 20 通过，2 平台条件跳过 |
| OS 当前结构与数据保全 | 49 通过，34 子用例通过 |
| OS 加密、工作队列、擦除、故障恢复 | 49 通过，38 子用例通过 |
| 已审历史 Semantica schema 19 | 21 通过，8 子用例通过；3 个 schema 23 专属用例条件跳过 |
| 原件和历史版本 | 本机 **92 份原件、90 个历史文本版本**逐项核对无差异 |

两版 41 项既有条件跳过不包含原阻塞 17 项。测试组之间存在重叠，不累计为独立用例总数。HTTPS、加密和 SQLite 为真实本机实现，身份/材料为临时合成数据；擦除、容器/服务控制使用 FakeRuntime，未在真盒执行。

### 已有集成与真实使用证据

- 前轮集成的 WANX 根目录 `make all`：5187 通过、31 跳过、0 失败，Ruff 与 mypy（701 文件）通过。最新补测没有改动该后端，也没有再次运行整个根目录套件。
- 默认模型桥接 21 通过；两版 Studio/renderer 构建成功；真实 Electron Host 重启两版各 1 项通过。星图此前选定后端测试 211 通过，桌面/本体前端 33/44 通过，部署工具 4 通过。
- 两版内置星图已有实际 ASAR 内容一致记录；历史 SHA-256 为 `8b3660f1caffebd4fc6e7a28922a537bed64f4bdd0056f0710b6993d93fecb06`。正式重建仍须重新记录实际产物摘要。
- 此前本机真实 WANX 默认模型为 DeepSeek V4 Flash，automatic 模式下合成材料解析、抽取、发布成功，检索命中 1 条，生成 4 实体/3 关系；原材料界面查询返回 10 个片段，个人仓图谱显示 37 实体/31 关系。
- 此前隔离合成仓故障注入后，真实客户端通知中心出现“星图默认模型不可用”和“星图服务暂时不可用”；故障已撤销。当前 17 项补测没有新增真实模型调用。

这些证据来自本机 WANX 1.0.1 旁置测试宿主，不是完整新客户端发行验收。历史文本检索覆盖为 **89/90**，两份图片只保留了原件；不能写成“92 份均可检索”或“92 份已全部重新生成图谱”。79 的材料数量以其维护前清单为准。

### OS 备份限制

OS #70 只扩展已审私有材料契约，保留精确结构检查。组织本体绑定、工作台动态附加表/模型捕获触发器、新本体/校对/发布历史的跨主体映射仍有限制；选中不支持的数据时必须拒绝，不得删除记录、清空工作台或放宽白名单。

“受限私有材料导出/迁入”与“同盒升级灾难恢复”是两件事。此次没有证明现有 92 份材料的完整工作台可跨主体迁移；79 必须准备整个业务持久状态的一致备份。

## 5. 79 部署前需要开发和运维补齐的输入

| 负责人角色 | 必须确认的输入 / 准入证据 |
| --- | --- |
| 发布负责人 | 三仓最终 SHA、Linux 架构/运行依赖、受信镜像 digest、签名客户端、唯一 release ID 与匹配的旧发行 |
| OS 负责人 | 79 是 legacy 还是 protected；实际备份工作器路径/版本；已有安装的受审升级及回退方案，确认 #70 文件实际生效 |
| 运维 | 79 在 fleet 配置中的唯一目标、服务用户和运行方式、真实端口、持久卷、Neo4j namespace、模型目录、足够备份空间、维护窗口 |
| 数据/业务负责人 | 全量业务备份恢复演练、材料/版本清单、抽样查询及图谱证据、容许停机时间和失败退出条件 |
| 客户端负责人 | 个人/企业两版受信安装器，通知面板与账号/盒子/仓隔离验证，旧应用版本保留 |

**宿主升级限制：**OS `deployment/local_trust_install.py` 使用 create-only 写入；已有文件不会被覆盖。OS 官方说明明确：仅应用 OTA 或 `box.sh deploy` 的镜像更新，不替换宿主 Bridge、固定 OS 工作器和相应 unit；当前也没有通用覆盖式升级 CLI。因此 #70 合并不等于 79 上的备份工作器已经升级。需由 OS 负责人按现有安装状态准备并审核具体升级事务，在隔离同构环境演练后核对运行文件摘要。本交接不编造一条“重跑安装器”的升级命令。

本次不包含 legacy→protected 转换、首次制备、所有权转移、full-erase 或重新认领。若现网结构/部署方式不匹配，保持数据与现有安全模式，暂停该部署步骤并另行评审。

## 6. 构建与 79 升级步骤（未来维护窗口执行）

### A. 固定来源并构建候选

1. 在受控构建环境固定三仓经过审核的最终合并 SHA。WANX 必须包含表中 master 的 6 个新增提交和 #148 修复。私有 fleet 配置显式设置 `sources.os/wanx/semantica.repo`；`semantica` 对应本次 Starlink 仓库。
2. 更新共享前端和内置快照后，从完整 WANX 仓库安装锁定依赖、构建两版；个人版目录是生成结果，不独立改源码：

   ```sh
   npm --prefix wanx-client run build:studio
   npm --prefix wanx-team-client run build:studio
   npm --prefix wanx-client run build:renderer
   npm --prefix wanx-team-client run build:renderer
   ./apps/personal-client/package-client.sh --help
   # 正式安装器按仓库既有参数通过 --edition personal / team / all 构建与签名。
   ```

3. OS 发布入口默认支持 Ubuntu 24.04 amd64；79 实际架构/系统尚未在本次确认。准备兼容 Linux runtime、锁定依赖、内部 local-data-gate、BGE/OCR/ASR 模型和现有 Neo4j。不能复制 macOS venv 到 Linux，也不能用聊天默认模型替代 embedding。
4. 以下是 OS 仓库的候选构建模板。所有变量均由发布负责人填写；`OS_SHA/WANX_SHA/STARLINK_SHA` 是最终审核值，不是浮动 `master/HEAD`。`publish` 会构建并上传候选，本次不执行：

   ```sh
   : "${FLEET_CONFIG:?私有配置路径}" "${SITE:?配置中的站点}"
   : "${OS_SHA:?最终OS提交}" "${WANX_SHA:?最终WANX集成提交}"
   : "${STARLINK_SHA:?最终星图提交}" "${NEW_RELEASE:?全新发行ID}"

   ./scripts/box.sh publish --config "$FLEET_CONFIG" --site "$SITE" \
     --module wanx,semantica --check-config
   ./scripts/box.sh publish --config "$FLEET_CONFIG" --site "$SITE" \
     --module wanx,semantica --plan \
     --source-ref "os=$OS_SHA" --source-ref "wanx=$WANX_SHA" \
     --source-ref "semantica=$STARLINK_SHA"

   # 完成构建审核后才能执行；只发布候选，不部署目标：
   ./scripts/box.sh publish --config "$FLEET_CONFIG" --site "$SITE" \
     --module wanx,semantica --version "$NEW_RELEASE" \
     --source-ref "os=$OS_SHA" --source-ref "wanx=$WANX_SHA" \
     --source-ref "semantica=$STARLINK_SHA"
   ```

   `wanx` 不自动包含 `semantica`；上述显式选择仍会加入 `base,docker` 依赖，需审查最终计划。保留 manifest、制品摘要、发行绑定执行器和成功回执。**这一步不替代宿主工作器的受审升级。**不使用会连带部署的 `box.sh release`，也不沿用旧的 9 文件 overlay 或旧 79 tar 包作为完整交付。

### B. 隔离演练及只读预检

1. 用独立数据副本验证候选与回退。不能让旧进程和新进程同时持有同一 SQLite/Qdrant 目录；隔离图 namespace，禁止测试任务写入生产图。
2. 在未来获得部署授权后，运维核对唯一目标并做只读检查；“79”是设备称呼，不是已确认的 IP：

   ```sh
   : "${BOX79_TARGET:?fleet中已核实的79唯一目标}"
   ./scripts/box.sh deploy --config "$FLEET_CONFIG" --site "$SITE" \
     --module wanx,semantica --target "$BOX79_TARGET" \
     --release "$NEW_RELEASE" --check
   ```

3. 在已授权的目标会话运行星图只读预检。目标 Python 使用兼容环境（建议与交付一致的 3.12）；下列路径均为 79 实际路径，不是本机测试路径：

   ```sh
   "$TARGET_PYTHON" "$STARLINK_RELEASE/deploy/box79/preflight.py" \
     --env "$PRIVATE_STARLINK_ENV" --wanx-config "$PRIVATE_WANX_SEMANTICA_JSON" \
     --data-root "$EXISTING_STARLINK_DATA" --models-root "$EXISTING_STARLINK_MODELS" \
     --actor-id "$AUTHORIZED_WANX_USER_ID"
   ```

   预检检查私密 env 权限、身份/token 匹配、数据库完整性、模型文件哈希；带 actor 参数读取默认模型 catalog，不调用推理。旧 WANX 未提供新契约时会失败，记录后先在隔离环境验证兼容后台，再在维护窗口升级后台后复查；不可跳过契约检查。
4. 配置保留真实身份、服务 token、手动模型选择、图 namespace、备份密钥和原数据门控模式。`WANX_MODEL_URL` 是真实 WANX 后台回环根地址，路径契约为 `/internal/starklink/models`；不是厂商 API。保持 managed 调用及 `XINGTU_LOCAL_ONLY=false`，不把 `.env.example` 覆盖到现有配置。不要带入本机端口或测试凭据。

### C. 维护窗口：冻结、备份和切换

1. 停止导入及其他写入入口，排空/妥善暂停任务，记录任务水位；优雅停止相关唯一写入进程。星图模板 SIGINT 等待上限 210 秒，确认 worker/MCP 全部退出。不要用强杀替代一致性确认。
2. 备份同一恢复点的完整业务状态：WANX 业务库与映射、星图 SQLite（处理 WAL/SHM 一致性）、原件、历史版本、derived/previews、Qdrant、上传/转移暂存、备份目录、Neo4j 图、配置、旧代码/镜像及客户端应用版本。保存权限、挂载和模型清单；在独立副本实际恢复验证。不能只复制正在写入的 `app.sqlite3`。
3. 身份/密钥/authority 状态单独受控保全；业务回滚不得回退当前 epoch、撤销状态、安全版本下限或恢复旧授权。持有备份不表示可以把安全状态随业务快照覆盖。
4. 冻结期间生成材料基线；输出必须是不存在的新文件：

   ```sh
   "$TARGET_PYTHON" "$STARLINK_RELEASE/deploy/box79/inventory.py" \
     --data-root "$EXISTING_STARLINK_DATA" --output "$BEFORE_INVENTORY"
   ```

5. 先按已审宿主升级事务更新需要的 OS/Bridge 工作器，保留安全状态，核对 #70 两个 profile 的实际文件摘要及运行服务来源。若没有可执行、已演练的现有安装升级方案，停在此处，不能用删除旧文件后重装代替。
6. 使用同一固定发行，**先 WANX 后台、后星图服务**。以下仅适用于已经确认沿用 fleet 容器管理的 79；若实际是原生 systemd 服务，应保留原用户和路径，由运维依据模板形成对应切换单，不并行启动第二套服务：

   ```sh
   ./scripts/box.sh deploy --config "$FLEET_CONFIG" --site "$SITE" \
     --module wanx --target "$BOX79_TARGET" --release "$NEW_RELEASE"
   # WANX 默认模型契约/鉴权检查成功后：
   ./scripts/box.sh deploy --config "$FLEET_CONFIG" --site "$SITE" \
     --module semantica --target "$BOX79_TARGET" --release "$NEW_RELEASE"
   ```

   保留旧发行和持久卷，复用同一数据/模型/备份目录与图 namespace。已存业务数据而配置缺失时先恢复对应配置，不创建新身份或空仓。数据库迁移按既有路径执行；不自动重抽取全部历史材料、不自动发布本体规则。
7. 部署匹配的受信 WANX 个人/企业客户端及内置星图，核对实际运行版本。运行中的旧应用先正常退出再升级；保留旧版本，不强制覆盖更高、自定义或签名管理的应用版本。
8. 在重新开放业务写入前核对原件/版本：

   ```sh
   "$TARGET_PYTHON" "$STARLINK_RELEASE/deploy/box79/inventory.py" \
     --data-root "$EXISTING_STARLINK_DATA" --output "$AFTER_INVENTORY" \
     --compare "$BEFORE_INVENTORY"
   ./scripts/box.sh status --config "$FLEET_CONFIG" --site "$SITE" \
     --module wanx,semantica --target "$BOX79_TARGET" --json
   ```

   盘点工具核对文件哈希、document/version ID、活动版本和版本元数据，不覆盖图数据库、本体发布历史、WANX 身份等所有状态；这些须结合联合备份和额外只读检查验收。状态 healthy 或 catalog 可用不足以宣告业务成功。

### D. 开放写入前的验收清单

| 场景 | 通过标准 |
| --- | --- |
| 默认模型 | 无手动设置时使用 79 的有效 WANX 默认模型；新任务跟随当前配置；已排队任务保留审计快照；手动设置不被覆盖 |
| 新材料闭环 | 独立验收仓合成材料完成解析、向量索引、抽取、发布；检索可回到原文，图谱实体/关系可追溯材料版本和证据 |
| 历史材料 | 前后原件/版本清单一致，代表性查询命中；本体、知识校对、发布版本在星图框架内，已有版本/规则保留 |
| 错误通知 | 在隔离实例注入模型不可用、推理/处理失败和服务断线；真实客户端通知中心显示错误，恢复后可重试，断线补收且不反复刷屏 |
| 权限与隔离 | 个人/团队、不同账号、不同盒子、不同仓不串数据/通知；恢复历史失败任务不生成新故障重放 |
| 恢复与冷启动 | 独立副本完成联合恢复和版本回退，宿主权限/挂载/启动次序正确；业务与安全状态保全 |

客户端当前约 30 秒轮询，模型目录缓存最多 5 秒，验收应留足观测时间。不要禁用生产默认模型做故障注入。任何材料差异、错误身份、持久目录错挂、默认模型不可用或通知隔离失败，都保持写入冻结并进入回滚决策；全部验收通过后才逐步开放写入。

## 7. 回滚步骤与限制

### 尚未恢复用户写入

1. 保持维护状态，停止新版本写入及后台任务，保留失败日志、回执和当前故障现场副本。
2. 确认旧发行能读取当前业务 schema、模型清单及当前安全格式。若兼容，可切回保留的旧星图服务及匹配后台/客户端；若不兼容，先离线恢复升级前同一恢复点的业务数据库、文件、向量和图，再启动旧程序。禁止让旧程序直接试开不兼容的新库。
3. fleet 路径使用明确旧发行，不使用 `latest`；以下仅恢复程序，**不自动恢复业务快照、宿主工作器或安全状态**：

   ```sh
   : "${ROLLBACK_RELEASE:?已演练且兼容的旧发行}"
   ./scripts/box.sh deploy --config "$FLEET_CONFIG" --site "$SITE" \
     --module wanx --target "$BOX79_TARGET" --release "$ROLLBACK_RELEASE"
   ./scripts/box.sh deploy --config "$FLEET_CONFIG" --site "$SITE" \
     --module semantica --target "$BOX79_TARGET" --release "$ROLLBACK_RELEASE"
   ```

4. OS 工作器按已审宿主回退事务恢复兼容代码/依赖，保留 authority、epoch、撤权与安全下限。旧代码不理解当前安全格式时，保持 protected 停止状态并向前修复，不降级安全模式。恢复匹配客户端，并保留新旧星图版本目录。
5. 若恢复星图业务快照导致事件序号回退，需处理通知来源标识：应用内受支持的恢复路径会更新 `xingtu_notification_state.feed_id`；手工整卷恢复须在离线状态由受审维护步骤生成新 feed ID（仅当该版本具有通知表）。不删除事件、材料或客户端全部通知来修复游标；验证补收与去重。OS 私有工作区迁入则保持目标 feed ID，并抑制本次导入制造的历史失败新事件，两者不可混用。
6. 使用回滚后的新清单与升级前清单比较，复查 SQLite 完整性/外键、图/向量一致性、模型、权限及通知；通过后才开放写入。

### 已经产生新材料、新版本或安全状态变更

1. 再次冻结写入，保存升级后完整业务快照、任务/版本水位和新写入清单。
2. **禁止直接用升级前快照覆盖当前数据。**先在隔离副本评估旧程序兼容性，选择保留当前数据的代码回退，或经验证的增量保全/迁移方案；未验证时继续维护并向前修复。
3. 新增原件、历史版本、本体/校对/发布历史都要保留。OS 私有材料导出存在上述限制，不能作为通用增量搬迁工具。
4. 不回退当前安全状态、不重建身份、不执行擦除或重认领；记录恢复点、保留的增量、最终版本和业务负责人确认结果。

## 8. 开发复测入口与交付回执

在隔离测试 checkout 准备 Python 3.12+、OpenSSL 3、Node 锁定依赖及生成资源，固定 OS/星图源码。不要把以下环境变量带到生产配置：

```sh
export WANX_LEDGER_TEST_PYTHON=/absolute/test-python/bin/python
export WANX_TEST_OS_ROOT=/absolute/centuarai-os
export WANX_TEST_STARLINK_ROOT=/absolute/centuarai-wanx-startlink
export PATH="/absolute/openssl3/bin:$PATH"
# local-data-gate 如未安装，用 WANX_TEST_PYTHONPATH 明确指定源码路径。
node --test apps/builder/tests/ledger-runtime-harness.test.mjs
# 以下分别在 wanx-client 和 wanx-team-client 目录执行：
node --test --test-concurrency=2 tests/*.test.mjs
```

OS 两组回归在 OS 仓库执行；按配套报告设置 WANX src、bridge、bridge/tests、super-clipboard、local-data-gate 和星图的测试依赖路径：

```sh
uv run python -m pytest tests/test_local_trust_semantica_profile.py tests/test_local_trust_wanx_profile.py -q
uv run python -m pytest tests/test_local_trust_backup_crypto.py tests/test_local_trust_operations.py tests/test_local_trust_transfer.py tests/test_local_trust_transfer_faults.py -q
```

最终交付回执应逐项填写：审核人/维护操作者、三个最终 SHA、制品及模型摘要、宿主工作器实际摘要、客户端签名版本、79 确认身份、前后材料清单路径、联合备份及恢复演练结果、业务验收结果、旧发行与回滚恢复点、开放写入时间。秘密、材料正文与完整私密配置不进入 MR 或公开回执。

## 9. 依据与本机证据索引

仓库内路径供同事在对应 MR 中查阅；旧文档的早期状态以最新补齐报告及本文边界为准：

- WANX：`docs/applications/starlink-ledger-completion-20261031.md`（最终补测）；`docs/applications/starlink-master-integration-20261031.md`（6 提交集成）；`docs/applications/starlink-upgrade-handoff-20261031.md`（历史真实模型/检索/通知）；`docs/applications/starlink-builtin-packaging-20261031.md`（双版入口）。
- 星图：`deploy/box79/{README.md,preflight.py,inventory.py}`；`deploy/README-managed.md`；`deploy/compose.managed.yaml`。其中旧固定 9 文件 overlay 的应用步骤不用于本轮完整发行；新盒安装模板也不等于既有 79 已验收。
- OS：`docs/starlink-backup-compat-20261031.md`；`docs/wanx-release-deployment.md`；`docs/fleet-deployment.md`；`docs/local-trust-offline-wifi.md` 的“已有 protected 主机升级”；`deployment/local_trust_install.py`。

本机证据位于操作工作区下的 `verification/starlink-ledger-completion-20261031/` 和 `verification/starlink-master-integration-20261031/`，不在本仓库中；开发同事可先查阅已提交的[最终补测报告](starlink-ledger-completion-20261031.md)和[master 集成报告](starlink-master-integration-20261031.md)，需要原始日志时由维护者审查后提供。关键日志为 `blocked17-final.log`、`wanx-client-full-final.log`、`wanx-team-client-full-final.log`、`os-profiles-final.log`、`os-workers.log`、`os-reviewed19-final.log`，材料盘点为 `materials-after.json`，提交/结果摘要为 `result.json`。这些环境日志未作为源码提交，不应未经审查整目录上传。

本文通过 WANX #148 的审核分支交付，三个配套 MR 关联同一份交接说明。此次文档交付不修改业务代码、不重新执行或扩大既有测试结论，不合并、不构建发布、不执行生产命令。
