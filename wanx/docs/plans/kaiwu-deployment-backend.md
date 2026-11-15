# 工坊部署后台实施计划

用户已授权开始后端开发。以前端已确认的部署流程和应用开发套件提交 `5022e6a` 的三项 v1 草案为输入。本轮交付工坊内持久部署控制模块，不改业务编辑／审批／回归系统，不以模拟计时器或固定成功值代替真实回执。

## 范围与依赖

- 后端：`apps/builder/backend/wanx_studio/deployment/`，接入现有 Router 和 StudioService 生命周期。
- 传输：Builder 受信工作区的精确路由白名单和部署受理 202 处理。
- 合同：固定来源 Schema 快照与 Python 同义校验；与上游样例交叉验证摘要和条件字段。
- 执行：受信平台 Adapter 提供目标授权、来源查验、放行与回归、预检、候选准备、对账、提交和补偿。未配置时显式不可用，不执行远端操作。
- 复用 master 提交 `2aad04e2` 已交付的通用 Bridge 配置注册，新增服务无需增加 Bridge 业务代码；配置由可信安装器维护，变更后重启 Bridge。客户端环境槽位、实际执行 Adapter 与设备联调仍需接入；不改 Octop 核心、App Kit 或生成资源。

## 执行计划

1. [x] 核查现有工程、授权与生命周期，建立独立 worktree／分支。
2. [x] 实现合同校验与可信 Adapter Interface。
3. [x] 实现 SQLite 持久任务、环境锁与 fencing、事件、不可变终态、事务 outbox。
4. [x] 实现部署协调和重启对账、有限等待、失败恢复及按目标保数据回滚。
5. [x] 挂载 HTTP 请求／查询与进度、回执查询／重投；接入受控 IPC；为共享 local-data-gate 同步企业／个人精确白名单。
6. [x] 运行专项和原有回归并审阅；控制模块按独立提交保存，推送后核对远端 SHA。
7. [ ] 用户已将当前实机目标切换至公司 102 盒子；完成连接与版本核查、部署验证、Adapter 接入和端到端验收。家庭盒子的历史测试保留，不作为 102 的验收结果。

## 验收标准

- 单盒目标固定，release 同 ID 异摘要冲突，幂等同参返回原操作、异参冲突。
- 首次 dev 不强制业务回归；prod 绑定同版本证明，切换前重新查验；管理动作不强制回归。
- HTTP 202 只代表受理；必需后端、客户端及 Channel 分项全部匹配后才成功。
- 页面关闭与服务重启不丢操作；外部副作用先存执行意图，超时／重启先 inspect，不盲目重放。
- 过期执行器不能写控制状态；Adapter 必须检查 fencing token；同环境修改串行。
- 提交前补偿、提交后部分失败、未知提交分别处理；原终态不可重写，恢复为关联新操作。
- 回执与终态同事务保存，投递失败不重复执行；回滚不恢复旧数据库。
- HTTP 隔离不同调用者、禁止公开 recover／任意回调地址、错误不回显凭据。

## 已知平台门槛

当前普通安装只支持递增 SemVer。Bridge 已支持通用注册、状态查询、服务身份校验及 HTTP/SSE 代理，见[接入合同](../bridge/independent-service-registration.md)。注册表启动加载一次，配置改变需重启；服务制品安装、进程生命周期、长期部署授权及 Runtime／Client／Channel／Data Adapter 并未因此自动实现。本轮默认 Adapter 必须关闭执行能力。测试 Adapter 仅用于隔离回归，不是平台已支持或真实盒子验收证据。

## 服务接口与接入

复用工坊可信身份与管理入口。企业路径前缀 `/api/app-studio/deployment`，个人工坊同一 Router 挂载在 `/api/_client/workshop/deployment`。HTTP 受理不代表设备完成。

| 方法与相对路径 | 含义 |
| --- | --- |
| GET `/capabilities` | 是否配置真实执行 Adapter；默认 unavailable |
| POST `/releases` | 登记校验过摘要、且通过可信来源核验的不可变部署包 |
| POST `/operations` | 提交 v1 请求，返回 202 和持久操作；幂等命中返回原操作 |
| GET `/operations`、`/operations/{id}` | 查询本人操作，列表可按完整四元目标过滤 |
| GET `/operations/{id}/events` | `after` 游标、`limit` 分页进度 |
| GET `/operations/{id}/receipt` | 不可变回执及独立投递状态 |
| POST `/operations/{id}/resume` | 唤醒原任务，不修改参数、幂等键或终态 |
| POST `/operations/{id}/receipt/retry` | 仅重投已保存回执 |
| GET `/environments` | 四元目标当前 generation、revision、release、health |

请求体最大 1 MiB，拒绝重复 JSON 键与未知字段。没有 HTTP recover、任意 URL 回调、执行脚本或 Adapter 配置入口。release 按调用者登记；另一位管理者如需操作已有环境，须先通过来源核验登记同一 release。环境互斥按组织、盒子、应用、dev/prod 四元组生效，不按调用者分锁。

在可信启动代码以 `StudioService(..., deployment_adapter=adapter)` 注入真实实现；不能从浏览器选择驱动。服务启动扫描持久任务，关闭取消 worker 并保存已有意图，下一进程先 inspect。工作线程不继承提交请求的 ContextVar 身份；Adapter 必须拥有独立、可撤销的长期执行授权。

## Adapter 必须履行的语义

`deployment/adapters.py` 是平台唯一执行接缝。测试实现不进入生产包。实现必须支持：

- `authorize`：真实调用者对组织／设备／应用／环境／操作的授权；`verify_release`：可信产物登记、签名／来源校验。合同摘要校验不能替代来源验证。
- `check`：validating、preflight、commit 时校验冻结版本、上游决策与当前目标；dev 首装不附加业务回归门槛，prod/promote 绑定同版本回归证明，管理动作不套用回归。commit 再检查授权、审批、回归、容量和代际。返回冻结的必需 Channel 清单。
- `inspect`：按 `(operationId, step)` 对账。只有证明未执行才返回 `not_started`；超时／查无证据返回 `unknown`，不能以“未查到”代替未执行证明。返回已完成步骤的真实观察。
- `execute`：幂等执行并检查目标 fencing token。prepare_backend/client/channels 准备隔离候选；prepare_data 处理初始化复制、迁移、密钥与任务移交；verify_candidate 验证候选。数据库、密钥与任务内容只在受信数据面流转，控制 API 仅处理引用。
- 本地持久 commit 决策同时递增部署代际并进入 maintenance，之后 activate 收敛目标环境；verify_active 返回后端、客户端与必需 Channel 的真实版本和就绪状态。不要把“命令已发送”报为 done。
- compensate 只处理提交前候选，恢复旧环境；提交后禁止旧快照覆盖新写入。rollback 使用目标旧代码版本配合当前数据的兼容性校验，不还原旧数据库。manage 执行 restart/stop/uninstall/purge 并返回对应组件观察。
- recover 是可信内部入口，当前支持 deploy/promote/rollback/restart 的关联修复；必须依据原操作、checkpoint、提交状态对账。stop/uninstall/purge 的 recover 回执应表达 stopped/uninstalled/purged，当前 v1 recover 成功仅支持 ready，故这三种动作暂不受理（503 DEPLOYMENT_ACTION_UNAVAILABLE），等待合同补齐后开放；不开放公网 recover。
- `deliver` 只投递受信目的地，以 receiptId 幂等并返回同一 receiptId 确认。失败指数退避，不能再次执行部署。

外部副作用与本地事务不共用事务；持久意图、幂等键、目标 fencing 和 inspect 共同保证重启后可对账，不声称跨设备 exactly-once。真实 Adapter 未交付前，默认接口返回 `DEPLOYMENT_ADAPTER_UNAVAILABLE`，不接受会假成功的部署。

## 验证记录

- 合同模块：与套件固定提交的 JS 摘要和成功／失败 golden 对照，159 项通过。
- 持久任务：进程重开、独立进程竞争、过期 fencing、事务故障、不可变回执、投递重试专项通过。
- 部署专项 279 项在指定家庭盒子的隔离容器中通过（实际 Python 3.12、既有镜像依赖；测试 Adapter 仍为替身）。共享网关 46 项与 349 子测试、Bridge 53 项通过。Node 完整回归 596/597 通过，既有 assistant-channels.test.mjs 的手工 Channel 用例 NOT_FOUND 在未改动的基线 18cace69 上同样失败；本次部署相关 18 项全部通过。工坊 Python 全量 649 项通过（加载当前工作树与既有平台依赖）。Python wheel 构建通过，包含四份 Schema，不含测试替身。
- 后端初次交付时未进行真实盒子部署；后续公司 102 正式更新与简单应用结果见文末。数据库／密钥／运行任务复制的完整端到端验收仍未完成。

## 新增真实设备验收要求

用户要求开发后在指定家庭盒子真实测试至通过。已使用本机既有密钥连通，并完成独立容器中的后台兼容性验证；原万象与 Semantica 容器 ID、启动时间、健康状态不变。配套客户端暂按本机 Mac 独立测试目录准备。具体设备地址和登录配置仅放本地验证资产，不加入产品接口／模板。下一步先只读核对平台版本和管理能力，再用独立测试应用实施；不覆盖既有应用或业务数据。未完成端到端前不宣称整个部署功能验收通过。

实机闭环的剩余阻断：客户端普通安装不具备 dev/prod 槽位；没有可直接连接的通用业务运行时／客户端／数据执行 Adapter。先前“Bridge 服务注册仅支持专用服务”的判断基于旧基线，已由最新 master 的通用注册实现修正，不再列为能力缺口。已向用户确认同事是否已有接口分支，或这些平台改动是否纳入当前部署范围。此范围未明确前，不用专用服务身份或直连端口绕过平台合同。真实双端部署尚未通过，不能标记整体任务完成。


## 公司 102 验证计划（2026-11-13）

用户已授权改在公司 102 部署验证。基线为 `origin/master` 的 `0f70cdda`，其中同时包含通用服务注册 `2aad04e2` 和部署后台 `5b30f0c8`。具体访问凭据与现场快照只保存在本地受保护验证资产。

验收顺序和依赖：

1. [x] 确认 SSH 身份、实际设备、已安装源码／镜像、既有容器健康与数据挂载；建立更新前快照。已使用受保护的现有账号配置直接连接，不需要跳板；已记录现有服务基线。
2. 先在独立目录／容器验证候选。使用 `server/bridge/deploy/smoke-generic-services.py` 验证两个真实回环服务的配置注册、HTTP/SSE、身份隔离和健康门禁；该脚本使用合成 Host 身份，结果只能证明注册基础设施。
3. 通过真实工坊身份核对部署 API 可达性、目标授权及回执查询。缺少真实 Adapter 必须继续报告不可用，不能把 503 的正确拒绝作为部署成功。
4. 接通真实执行 Adapter 后，再以独立测试应用验收后端安装、客户端安装／加载、版本激活、连通、重启恢复和失败回执；涉及数据库／密钥／任务复制时使用合成数据验证其真实结果。
5. 对比更新前后的非目标服务与数据状态，记录实测命令、返回、版本和限制；没有真实两端成功回执时不勾选端到端验收。

当前正式装配仍使用 `UnavailableAdapter`（企业 `wanx.py` 和个人 `PersonalWorkshop` 均未注入实际驱动）。这项事实独立于动态注册是否存在，不能通过把部署协调器的测试替身装进生产来消除。

验证中修正：通用服务 smoke 显式将 Semantica／platform-browser 配置根设置到同一个临时目录，避免非 root 验证时读取默认 `/data/.octop`。生产服务配置不变；相关回归在无业务挂载的临时 `/data` 中运行。

公司 102 第一阶段结果（正式更新前）：最新 master 候选代码已上传独立目录，使用现有万象镜像依赖在隔离容器内通过后台 279 项、Bridge 54 项及真实双服务 HTTP/SSE smoke。原正式镜像尚不包含通用注册和部署后台，本轮未替换它。详见[公司 102 验证记录](../verification/kaiwu-deployment-box102-20261113.md)。随后用户已明确采用简单验证应用，见下一节；生产 Adapter 仍未接入，整体双端验收未完成。


## 102 正式更新与简单应用验证（用户已明确授权）

本轮目标：将本次万象／工坊后端更新到 102，并创建一个带数据持久化的简单应用验证实际效果，不再停留于隔离测试。测试应用采用独立身份、目录和合成数据；运行依赖继续使用盒子已有环境。

计划与验收：

1. [x] 复核正式容器、启动配置、数据挂载及当前源码；保存完整私有回退资料并检查更新差异。
2. [x] 构建仅包含本次后台和通用注册改动的候选，检查实际依赖和生产启动；候选通过后切换正式服务，验证健康与原有业务入口。失败则恢复原容器。
3. [x] 创建最小记事／计数应用：真实数据写入、读取、版本和健康检查，配套客户端通过现有 PersonalWorkshop 与 miniapp data 合同调用；独立服务通用注册另行验证，不使用任意直连业务端口。
4. [x] 通过真实调用验证写入、刷新读取及服务重启后保留；验证新工坊部署 API 的实际响应。只有真正注入执行器并得到双端真实回执，才能报告自动部署链路成功。
5. [x] 核对非目标服务、回退点和持久化，更新验收记录、审阅差异、提交推送并校验远端 SHA。

预期影响：Builder Python 后台、Bridge 通用注册模块、shared native policy 的安装版本及本次验收资产。Runtime／Client Adapter 若需接线，先确定与已有安装器、权限和配置合同的接口，保持新功能默认拒绝未知来源和目标。业务验证应用与真实地址不进入通用 App Kit／模板／Skill。

正式更新已完成：新万象容器 `fb0413b50790`，镜像 `2fdf51c7f101`，健康和 delivery `ready/serviceReady` 均通过；已安装的 20 个更新源文件与候选摘要一致。两个部署 capabilities 路由真实认证返回 200、匿名返回 401；当前均报告 `DEPLOYMENT_ADAPTER_UNAVAILABLE`。后端管理员独立预览应用已完成真实编译、采纳及数据写入／读回，真实云用户客户端另建项目完成安装和界面写入，后端重启、客户端重连并重开后同一记录仍在。具体项目／制品／记录和自动重连未验证的限制见验收文档。

## 前端归属与接入

正式部署前端已归入本仓库 `apps/builder/ui/deployment/`，开物与个人工坊复用同一工作台与受信请求通道。当前接入真实能力、操作、事件与回执；项目已采纳版本到可信发布包／目标／配置的查询以及实际执行 Adapter 仍需接入，因此暂不开放新的部署提交。详见[前端接入计划](kaiwu-deployment-ui-integration.md)。

## 后续真实执行接通

此前“缺少发布上下文／默认不可用”的阶段已对个人工坊 data-only miniapp 补齐，102 真实 dev/prod 和重启续办通过；首次提交可用范围与当前限制以[真实部署验收](../verification/kaiwu-real-deployment-box102-20261113.md)为准。企业／其它资源能力／独立代码执行未完成时继续拒绝，不扩大已有验收范围。
