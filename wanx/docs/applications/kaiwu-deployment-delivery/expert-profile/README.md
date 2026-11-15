# 专家应用运行合同

运行 profile：`wanx-expert-app-v1`，revision `1`。本页定义标准发布目录的首个专家后端与共享客户端组合；整体可用状态由部署能力接口与实机验收决定。

## 发布内容

沿用上层 `kaiwu-release-directory-v1`，后端声明为 `kind=expert`、`profileRef={"id":"wanx-expert-app-v1","revision":1}`。第一版接收以下五个 JSON 产物，均需在 `artifacts` 中登记真实 SHA-256、字节数及平台：

| 产物用途 | 角色 | 内部合同 |
| --- | --- | --- |
| 专家后端描述 | `backend` | [backend.schema.json](backend.schema.json) |
| 已编译客户端 payload | `client` | [client-payload.schema.json](client-payload.schema.json) |
| 配置 Schema | `support` | [configuration-artifact.schema.json](configuration-artifact.schema.json) |
| 固定依赖锁 | `support` | [dependency-lock.schema.json](dependency-lock.schema.json) |
| 合成验收说明 | `support` | [verification.schema.json](verification.schema.json) |

所有产物媒体类型为 `application/json`，客户端交付方式为 `install`。部署侧使用已校验 payload 和受信共享宿主装配实际客户端；产物不包含供应方主进程脚本。代码已经编译，入库不调用开物编辑、源码复制或重新编译流程。

原 `applicationId`、`version`、`releaseId` 保留。版本采用无前后缀的 `major.minor.patch`；每个发布 ID 只允许登记一种确定内容。单个文件不超过 4 MiB，全部文件与清单合计不超过 16 MiB。读取会检查 JSON 重复键、摘要、路径、链接和数量，再从私有副本复验；未声明文件、符号链接和硬链接均拒绝。

## 专家后端和依赖锁

```json
{
  "schemaVersion": 1,
  "format": "wanx-expert-backend-v1",
  "template": {
    "resourceId": "example-expert-template",
    "version": "0.0.0+sha.000000000000",
    "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  },
  "mode": "ask"
}
```

上面是字段说明，资源 ID、版本和摘要需从专家模板目录查询结果原样取得。模板使用内容版本 `0.0.0+sha.<摘要前12位>`，例如摘要以 `000000000000` 开头时版本为 `0.0.0+sha.000000000000`；这与应用自身的 `major.minor.patch` 版本不同。示意值不能用于真实部署。`template` 必须与发布清单 `backend.template` 及依赖锁的唯一一项完全一致：

```json
{
  "schemaVersion": 1,
  "dependencies": [
    {
      "kind": "expert-template",
      "resourceId": "example-expert-template",
      "version": "0.0.0+sha.000000000000",
      "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    }
  ]
}
```

第一版只支持 `ask` 文本调用。资源需求必须且仅有一个 `kind=model`、`required=true` 的逻辑项；模型使用盒端已有配置。暂不接收文件、知识、密钥、任意工具或其他专家实例的绑定请求。实际私有专家实例、owner、盒子、dev／prod 与 generation 由部署侧绑定，产物不携带 agentId、令牌或目标环境。

## 客户端 payload

客户端 JSON 的完整字段为 `applicationId/name/version/artifactHash/manifest/bundle/css/runtimeNamespace`。应用 ID、版本必须与发布清单一致，`name` 必须与 `manifest.name` 完全相同。`runtimeNamespace` 标识受信运行通道：原开物为 `studio`，个人工坊为 `workshop`。每个服务实例只接收与自身配置完全一致的值，跨通道入库返回 `DIRECTORY_CLIENT_NAMESPACE_INVALID`。通道由服务端装配确定，不接受请求正文另传 `sourceNamespace` 来选择；不能修改 payload 通道以接管另一入口的部署。

`manifest` 沿用 miniapp manifest：必须有 `schemaVersion/name/entry/capabilities/collections`，`entry=src/app.js`。capabilities 必须包含 `foundation`，可同时包含 `data`，不接收其他能力；存在 collections 时必须声明 `data`。`bundle` 为已经编译、可在受限 iframe 中装载的 `WanxMiniapp` 代码，`css` 可为空。

`artifactHash` 为 payload 删除 `artifactHash` 字段后，按现有部署合同 canonical JSON 规范序列化，再对 UTF-8 字节计算的 SHA-256 小写十六进制，不加 `sha256:` 前缀。产物自身的 `artifacts[].digest` 仍是整个 JSON 文件原始字节的 SHA-256，带 `sha256:` 前缀。两者用途不同，都必须真实计算。

原开物版本谱系的 artifact hash 与此可移交 payload 的 hash 也不同。导出保留原版本的 `source.artifactHash/contentHash/taskId/versionRevision/projectId` 来源记录，同时计算 payload 自己的摘要；不得把导出摘要写回原版本或更改应用版本号。

客户端不携带凭据、本地绝对路径或盒子地址。它通过既有受信 runtime 通道调用部署绑定的专家入口，不自行连接 Agent 或任意网络地址。

## 配置 数据和验收

配置 Schema 固定为空对象：

```json
{"type":"object","properties":{},"additionalProperties":false}
```

发布清单的数据声明固定为：

```json
{"schemaVersion":"1","upgradePolicy":"compatible","taskPolicy":"none","persistentPaths":[]}
```

应用逻辑数据仍可通过声明的 `data` 能力持久化。第一版不执行生产目录拷贝、业务迁移或后台任务重放；后续支持这些能力时需升级对应合同。

验收文件必须提供一条无业务副作用的文本探测：

```json
{
  "schemaVersion": 1,
  "checks": [
    {
      "id": "text-roundtrip",
      "input": {"text": "请仅回复 SYNTHETIC_EXPERT_OK"},
      "expected": {"contains": "SYNTHETIC_EXPERT_OK"}
    }
  ]
}
```

该文件描述如何验证本发布版本，不是已执行通过的证明。实际绑定实例、模型执行、双端连通与激活状态由部署流程观察并形成回执。

## 接入与部署

最终产品验收入口为原开物 `StudioService`，API 前缀 `/api/app-studio`；个人工坊保留现有受信连接与 `/api/workshop` 代理入口。两者共用部署执行逻辑，分别保留 `.wanx-app-studio` 与 `.wanx-workshop` 存储及身份规则。原开物的 SSO 部署管理要求当前仍启用的原生管理员身份，后台执行和业务运行继续从持久身份源重验；不能借用个人工坊身份或将 Studio 标记成 workshop 来放行。

盒端需显式启用本 profile，未启用时目录列表返回 `available=false`，写入返回 `DEPLOYMENT_ADAPTER_UNAVAILABLE`。首版不支持 Local Trust，既有权限 guard 保留。目标盒子和用户从受信上下文取得，浏览器不能传任意地址、owner 或文件路径。配套受管应用只能访问自己的部署槽位及 runtime session；项目编辑、交付目录和部署管理权限不会随客户端安装授予。

### 原开物已采用成果的交付

以下项目接口相对于 `/api/app-studio`，不会重做原编辑器的需求确认、生成和采用流程：

| 方法与相对路径 | 输入／结果 |
| --- | --- |
| `GET /projects/{pid}/deployment/expert` | 查询可用模板、配置修订号和当前已采用成果的来源／阻塞原因。 |
| `PUT /projects/{pid}/deployment/expert` | `{operationId,expectedRevision,template,verification}`；显式选择真实模板及文本验收合同，更新原项目准备流程。 |
| `POST /projects/{pid}/deployment/release` | `{operationId,expectedArtifactHash,expectedVersionRevision}`；仅将已完成且已采用的专家成果导出为标准目录并入库，返回 `release` 与 `source`。 |

选择结果记录为 `deploymentExpert={schemaVersion,profile,revision,template,verification}`，经原准备／生成流程冻结到 `artifact.snapshot.contracts.foundation.expertDeployment`。新增专家成果的 hash 同时绑定该合同，版本恢复也保留它；导出读取采用成果的冻结合同，而非可变的当前选择。旧成果不会被追补合同、自动采用或临时改写。修改选择后应继续原准备、生成与采用流程，再导出新成果。

导出复验原任务完成状态、采用修订、成果完整性、冻结合同、模板引用和客户端能力；仅接收 `foundation` 及可选 `data`。它将已编译字节和五个标准产物写入受信收件目录，再调用同一入库器，不重新编译、不接受浏览器指定路径、不造一个个人工坊项目。导出操作 ID 重试需保持原请求不变；新版本或采用修订变化需刷新后重新提交。

原开物的 `foundation` 开发预检验证固定模板存在、客户端能力兼容，并通过默认模型执行一次真实的依赖连通探测。它不创建或执行部署专家实例，不覆盖实际客户端安装与握手，也不证明业务验收通过。布局预览中未部署的专家调用明确返回 `EXPERT_DEPLOYMENT_REQUIRED`；真实专家问答在 dev 部署联调完成。未选择专家合同的既有原生 foundation 路径不会借用这项预检。

### 标准目录部署接口

以下接口在所属入口内使用，发布目录本身不要求存在编辑项目：

| 方法与相对路径 | 输入／结果 |
| --- | --- |
| `GET /deployment/expert-templates` | 获取 `items[].resourceId/version/digest`，交付清单、后端描述及依赖锁须使用同一完整引用。 |
| `GET /deployment/directory-releases` | 查询能力及当前用户已入库发布。 |
| `POST /deployment/directory-releases/{releaseId}/ingest` | 空对象 `{}`；校验受信收件目录并冻结，返回目录摘要。 |
| `GET /deployment/directory-releases/{releaseId}/context` | 读取真实目标、dev／prod 和当前 generation。 |
| `POST /deployment/directory-releases/{releaseId}/prepare` | `{directoryDigest,environment,operationId}`；环境为 `dev`／`prod`，operationId 为 32 位小写十六进制。 |
| `POST /deployment/directory-releases/{releaseId}/submit` | `{preparationId,idempotencyKey}`；返回 202，继续读取既有 operation 和 receipt 接口。 |

`releaseId` 使用 1–128 位字母、数字、点、下划线或短横线，以字母或数字开头。以上入口不接受 query 参数。提交结果未知时保留同一个 preparation 和 idempotencyKey，不能生成另一组请求重试。正式环境只接收同一发布已完成开发环境验收的版本。

收件目录位于盒端 `OCTOP_HOME/deployment-inbox/<sha256(owner)>/<releaseId>/`，包含 `release.json` 和声明的五个产物。owner 为部署服务已认证身份，交付方不自行构造身份。原开物采用成果使用上述服务端导出接口落盘；其他来源可由受信交付流程提供同标准目录，不提供任意路径读取或通用上传接口。目录及文件应仅由受信服务用户或 root 管理，禁止其他用户写入；部署侧按实际文件校验并复制到自己的不可变存储，之后删除源目录不影响已经登记的发布。

客户端可从“部署交付目录”进入，输入发布 ID 后入库并部署，无需创建或伪造编辑项目。部署成功需要候选专家实际完成上述文本验证、客户端真实安装，并通过现有 `foundation.invoke` 连通专家入口；安装回执本身不足以判定成功。

### 跨入口的槽位归属

盒端根目录唯一的 `.wanx-deployment-sources.sqlite`（SourceRegistry）按真实 owner 与规范化目标记录首次部署来源；目标包含组织、盒子、应用和 dev／prod，沿用原槽位算法。启动先从两个 Store 的历史 binding／preparation 登记归属，再开放部署能力。同源可重复准备，失败补偿不会释放来源；跨源操作同一目标返回 `DEPLOYMENT_SOURCE_CONFLICT`，不能通过另一入口的独立 generation 覆盖。若历史数据已存在双源归属，该目标保持冲突并拒绝接管。

prepare、执行检查、激活和 runtime 都核对归属；不修改 `organizationId`、不迁移既有业务数据、不自动接管旧工坊槽位。个人工坊的旧 miniapp、model/files/knowledge 与原生 foundation 支持范围保持；原开物本次仅接入专家 profile。

部署主验收从原开物的标准目录入口完成，不限定上游代码的生成方式。目录输入、受信运行通道、双端真实执行和结果回执均须独立验证；此前个人工坊的实机结果不能替代原开物结果。项目内选择、生成、采用及导出属于补充集成链路，应分别记录，不能以目录部署成功代替生成／采用成功。本次已从原开物入口完成独立合成目录的 dev／prod 双端部署和真实调用，项目生成链仍有上游模型通道阻断，范围及证据见[独立验收记录](../../../verification/kaiwu-builder-deployment-box102-20261114.md)。

## 客户端专家调用

客户端声明 `foundation` 后，通过 `api.foundation.invoke(operation,input)` 使用下列有限入口。专家实例由当前部署隐式确定，接口不接收 agentId。

| operation | input | 结果 |
| --- | --- | --- |
| `expert.run` | `{operationId,text}`，文本 1–12000 字符 | `{run}`；相同请求标识与文本返回已有运行，不重复入队。 |
| `expert.tasks` | `{}` 或 `{runId}` | `{items,context:{scopeId}}` 或单条 `{run,context:{scopeId}}`。 |
| `expert.cancel` | `{runId}` | `{run}`，显示实际取消状态。 |

运行状态为 `queued/running/cancel_requested/succeeded/failed/cancelled/interrupted`，公共记录包含 `id/state/text/result/errorCode/createdAt/updatedAt`。时间为 Unix 秒，result 和 errorCode 可为空。单次执行上限 300 秒；超时或盒端重启不能证明结果的任务标记中断，不自动重放。客户端关闭不撤销已接纳任务，重开从盒端读取历史。配套模板先持久化 request 标识和 scopeId，再发送业务输入；跨 dev／prod 复制的数据不能作为新请求重新发送。

profile 的初始资源预算为 256 MiB 内存声明和 `16 MiB + 4 × 产物总字节数` 存储估算，预检仍检查真实可用空间；这不是独立进程的操作系统内存配额。首版不启动任意 Node／Python 服务，不运行工具、调度或外部写入任务。
