# 开物应用部署交付标准

版本：v0.1，供开物团队与部署团队联调对齐。

开物团队每次交付一个**已经完成构建、内容冻结、能按声明运行的应用版本目录**。部署团队接收该目录，完成入库校验、目标环境配置、后端启动或运行绑定、配套客户端交付、健康验证和结果回传。代码的生成方式、开发工具和开发过程不属于交接内容。

本标准定义交付入口，不代表任意目录都可运行。现有 `wanx-miniapp-v1` 保持原制品链路；新增 `wanx-expert-app-v1` 接收标准目录，支持 SSO 下的文本专家和配套 JSON miniapp 客户端，具体格式与限制见[专家 profile 内部合同](kaiwu-deployment-delivery/expert-profile/README.md)。独立服务运行适配仍待实现。目标未启用或不支持的 profile 必须明确拒绝。

## 一 开物团队要交付什么

| 必交内容 | 具体要求 |
| --- | --- |
| 发布清单 `release.json` | 应用 ID、版本、唯一发布 ID、后端类型和运行 profile、客户端交付方式、产物列表及 SHA-256。 |
| 后端产物 | 专家型提供版本化应用配置及专家模板依赖；源码服务型提供已构建的运行文件和固定依赖；miniapp 提供既有 profile 识别的制品。 |
| 配套客户端产物 | 符合万象客户端安装合同的包，或指定共享客户端运行时可加载的资源；声明实际支持的 OS／架构。 |
| 配置定义 | 配置项的 JSON Schema，区分必填项和默认值；没有配置时提供只接受空对象的 Schema。 |
| 依赖锁 | 固定专家模板、运行库及组件的版本和内容摘要；无额外依赖时交付空依赖清单。 |
| 资源需求 | 声明模型、文件、知识库和密钥的逻辑用途及是否必需。实际实例和配置值由目标环境绑定。 |
| 数据与任务声明 | 数据 schema 版本、升级兼容性、持久数据目录；需要迁移或任务检查点时提供相应运行时合同及产物。 |
| 验收说明 | 最小合成输入、调用方法、预期输出和版本识别方法；提供构建／组件校验结果，结果绑定本次产物摘要。 |

业务代码正确性、构建产物完整性和业务测试由开物团队负责。部署团队不临时推断入口、不修改业务代码，也不在部署时从可变开发目录重新构建。需要构建的源码应先经过开物的构建环节，再形成发布目录。

## 二 发布目录

```text
<releaseId>/
├── release.json
├── backend/
│   └── expert.json          # 专家配置，或 service.zip 等后端运行产物
├── client/
│   └── application.zip      # 实际万象应用包，或共享运行时资源
└── support/
    ├── config.schema.json
    ├── dependencies.lock.json
    ├── verification.json
    └── migration.zip        # 仅需要迁移时提供；任务检查点合同同理
```

文件名可以按 `release.json` 声明调整，`release.json` 固定在目录根。允许交付盒子上的目录，也允许交付保留同样结构的归档；目录路径由受信入库通道传递，不写成制品身份。

每个发布 ID 只对应一份确定内容。交付后禁止继续修改；修改任何产物、入口、依赖或配置定义，都生成新的发布 ID。开发目录和发布目录分开，运行数据与只读代码分开。

清单覆盖所有运行必需文件：后端产物内部有多个文件时，先封装为一个归档并计算归档摘要；不对尚在写入的目录直接求摘要。路径必须相对发布目录，不能越界或通过符号链接指向目录外。所有文件在入库后按声明校验大小和 SHA-256；入库得到的冻结副本才用于执行，后续不跟随原目录变化。

## 三 发布清单字段

完整结构以[交付清单 Schema](kaiwu-deployment-delivery/release-directory.schema.json)为准。`format=kaiwu-release-directory-v1` 是目录入库描述格式，与现有 HTTP 部署包分层；不向现有严格外层合同添加路径、命令等字段。

| 字段 | 类型／要求 | 谁提供 |
| --- | --- | --- |
| `schemaVersion`、`format` | 固定 `1` 和 `kaiwu-release-directory-v1`。 | 开物生成。 |
| `applicationId`、`version`、`releaseId` | 稳定应用 ID、合法 SemVer、不可变发布 ID。联调转正式使用同一发布内容。 | 开物生成；部署核对归属与不可变性。 |
| `backend` | `kind` 为 `expert`、`miniapp` 或 `service`，指定 `profileRef` 和 `artifactId`。 | 开物选择部署侧已公布的运行合同。 |
| `client` | `install` 引用可安装包；`load` 另需共享客户端 `runtimeRef`。 | 开物按客户端合同构建。 |
| `artifacts[]` | 每项有唯一 ID、角色、相对路径、媒体类型、摘要、字节数、平台列表。 | 开物生成真实值。 |
| `resources[]` | `key`、`kind`、`required`，用途键在应用内唯一；允许空数组。 | 开物声明需求。 |
| `configurationArtifactId` | 引用角色为 `support` 的配置 Schema 文件。 | 开物提供。 |
| `dependencyLockArtifactId` | 引用角色为 `support` 的依赖锁文件。 | 开物提供。 |
| `data` | 数据版本、`upgradePolicy`、`taskPolicy`、`persistentPaths`。迁移／检查点要求附相应 artifact 引用。 | 开物及其业务运行时负责人提供。 |
| `verificationArtifactId` | 引用角色为 `support` 的验收说明及组件校验结果。 | 开物提供。 |

`artifactId` 引用必须存在并与用途匹配，ID 和路径不能重复；后端引用 `backend` 角色，客户端引用 `client` 角色，其余引用 `support`。Schema 校验只检查结构，入库还必须检查引用关系、文件内容、SemVer 语义、实际客户端包格式与平台兼容性。

`profileRef`／`runtimeRef` 由平台公布，必须能解析为受信运行合同，不能由应用自行定义执行器。依赖锁至少记录每项依赖的类别、稳定 ID、固定版本和内容摘要；专家模板必须与 `backend.template` 完全一致。具体依赖文件和后端配置的内部结构由所选 profile 的版本化合同校验，不接受未约定格式。

部署团队正式接收一种 profile 前，必须同时提供它的后端配置、依赖锁、验收文件及迁移／检查点（如支持）的内部 Schema、完整样例、资源预算默认值与上限、可用版本及能力查询方式。开物据这些已公布合同填入内容；缺少内部合同属于部署接入尚未就绪，不要求开物猜格式。通用目录清单可以先对齐，尚未公布的专家／服务 profile 不能开始正式交付验收。

配置文件本身采用 JSON Schema；无配置的最小内容为 `{"type":"object","properties":{},"additionalProperties":false}`。依赖锁可为空，验收文件仍需有合成输入和预期结果；其序列化结构由相应 profile 的内部 Schema 固定。本标准不替业务运行时另造 AppSpec。

## 四 不同后端分别交付什么

### 专家型后端

提供 `backend.kind=expert`，并声明专家模板的 `resourceId`、固定 `version` 和 `digest`。后端产物包含业务入口、输入输出约定及应用级配置，格式遵循选定的专家 profile。部署侧根据模板为目标应用／环境准备或复用私有实例。

开物不提供某个开发会话里的实际 agentId、不提供平台访问令牌，也不把开发中的内存任务当可复制产物。模型、文件和知识库继续使用平台已有能力；需要继承数据或任务时，提交明确的兼容声明和检查点合同，由部署请求选择来源，再交给运行时执行。

### 独立服务型后端

提供 `backend.kind=service`，后端归档包含启动入口及全部运行必需内容。`process` 明确 Node／Python、精确运行时版本、相对入口和参数数组；版本必须在目标 profile 支持列表内。编译产物与本地依赖须匹配声明的 Linux 架构。锁文件仍需提供；只有锁文件、运行时还需临时联网下载依赖，不满足本期交付要求。

`process.entry` 相对后端 artifact 的解包根目录解析，工作目录也是该解包根；`artifacts[].path` 相对发布目录根解析，两者不可混用。`data.persistentPaths` 相对运行状态根解析，服务型为 `WANX_APP_DATA_DIR`，不接受生产绝对路径。平台托管数据由 profile 给出逻辑声明方式，不把平台数据库存储路径交给应用。

启动由 profile 管理，开物不提供 sudo、Docker socket、systemd unit 或 shell 命令串。服务以前台进程运行，不自行后台化。目标 profile 需约定注入的端口及状态目录；本目录标准要求服务读取 `PORT`、`WANX_APP_DATA_DIR`，只写状态目录，日志写 stdout／stderr，接收终止信号后正常退出。这些能力须由服务 profile 实现后才能接收部署。

`readiness` 声明 GET 路径、启动超时及单次请求超时。就绪接口应返回真实依赖检查结果及 `applicationId/version/releaseId`；进程存在、端口可连或固定返回 200 都不足以证明应用就绪。首版要求 `candidateMode=true`：候选阶段不领取正式任务、不执行定时调度或外部写入，激活方式由运行 profile 约定。

### Miniapp 或共享运行时

提供 `backend.kind=miniapp`，交付选定 profile 接受的制品；部署侧执行加载和环境绑定，不另起一个通用 Node／Python 服务。当前 `wanx-miniapp-v1` 的真实制品由现有工坊采用版本准备接口生成。本目录标准不会使任意源码目录自动变成 miniapp 制品。

## 五 配置与环境信息怎么交接

发布目录包含资源需求和配置定义，保持环境无关。目标盒子、dev／prod、配置值、模型选择、文件授权、secretRef、数据来源和任务恢复选择放在部署请求关联的环境绑定中。文件正文、生产数据库、模型密钥和登录凭据不放入发布目录；复制同盒子已有资源时复用受信引用和现有访问链路。

开物调用部署入口时选择发布版本和目标环境，传递调用幂等标识；实际目标身份和操作授权从受信会话取得。部署侧读取当前 generation，并将目标、资源绑定和数据计划冻结为一次明确请求。平台已有发布／回归模块提供的允许决定和报告，由部署侧核对后引用；开物不拼造尚未登记的 `decisionRef`、`bindingSetRef` 或健康合同 ID 来通过校验。本期不新增人工审批页面。

## 六 三项合同如何衔接

| 合同 | 来源与用途 |
| --- | --- |
| `DeploymentBundle` 部署包 | 受信入库适配器从冻结目录生成或登记，计算摘要、锁定依赖、登记路径对应的真实 `sourceRef`，生成来源证明引用。 |
| `DeploymentRequest` 部署请求 | 部署准备接口将发布引用、受信目标、当前 generation、幂等标识及已解析的环境／校验引用组装成请求。开物页面发起操作即可。 |
| `ActivationReceipt` 结果回执 | 部署侧返回实际版本、目标、后端与客户端分项结果及失败原因。开物据此显示部署结果，不将“请求已接收”当成“已运行”。 |

既有三项合同 Schema 继续使用 [bundle](../../apps/builder/backend/wanx_studio/deployment/schemas/bundle.schema.json)、[request](../../apps/builder/backend/wanx_studio/deployment/schemas/request.schema.json)、[receipt](../../apps/builder/backend/wanx_studio/deployment/schemas/receipt.schema.json)。目录清单不能原样 POST 给这些接口；目录接入器需要补齐真实引用和 profile 转换，开发前应与三项合同一起验证。

内部 `support` 角色由适配器映射为外层 `assets` 或登记为 profile 专用引用，不原样写入外层角色枚举。外层必需的资源预算由 profile 的默认／上限及本次制品、快照和候选开销计算并冻结，不要求开物另造一个预算引用。

部署请求与发布清单分开保存，目标环境变化不修改发布内容。关闭页面不撤销已接纳的任务，重试使用原幂等标识；遇到结果不确定时先查询原操作，不生成另一个部署请求。升级默认保留目标环境数据，迁移和运行任务恢复只能调用声明且已支持的业务合同，不能盲目重放任务。

## 七 什么时候接收和判定成功

入库接收前检查清单版本、引用完整性、真实文件摘要、构建完整性及已登记 profile；部署预检再核对目标实际运行时、资源、空间和客户端兼容性。缺产物、可变目录、摘要不符、运行合同未支持、依赖或绑定缺失时，返回明确阻断原因，不猜测启动方式。

首次联调要求组件校验和可执行验收说明，不要求先有联调运行后才能产生的业务回归报告。正式部署要求同一发布版本先通过联调，并取得上游真实回归结果和允许发布的决定。

整体成功必须同时证明后端实际版本就绪、配套客户端安装或加载成功、双端实际连通；专家型还需验证绑定实例和受限业务入口真实可调用。验收说明至少包含一条不产生业务副作用的合成输入、预期结果、持久数据读回方法（有数据时）及故障定位入口。部署侧验证运行事实，开物团队负责业务效果验收。

## 八 给开物团队的填写样例

- [专家型发布清单](kaiwu-deployment-delivery/expert.release.example.json)
- [独立服务型发布清单](kaiwu-deployment-delivery/service.release.example.json)
- [机器可校验的清单结构](kaiwu-deployment-delivery/release-directory.schema.json)

以上两个清单是**不可部署的填写模板**：`example-*` profile／资源、零摘要、字节数和运行时版本均为示意值，未附实际双端产物。开物必须替换为真实已支持的合同、构建输出和摘要；结构校验通过不等于可部署。后端内部配置、依赖锁和验收文件还需由对应 profile 的 schema 校验。可用的专家目录入口、模板查询及收件目录约束以专家 profile 内部合同为准。
