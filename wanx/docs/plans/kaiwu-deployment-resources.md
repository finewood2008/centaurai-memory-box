# 部署复用已有资源与专家后端

本轮根据用户补充，优先复用万象已有模型、文件、知识与专家运行能力。平台实现继续放万象；开发套件只消费公开合同。专家型应用优先采用盒端既有专家执行链，独立进程安装保留为另一种后端类型，不作为所有应用的前提。

## 本轮实施与验收

- [x] 只读核对既有模型、文件、知识授权及专家线程／gateway 的真实调用链。
- [x] 接通 `wanx-miniapp-v1` 的 model/files/knowledge，保持已有 data 行为。
- [x] 模型配置按 `deployment:dev/prod` 隔离。首次联调从普通 production 初始化，首次正式从同版本健康联调初始化；不复制 preview 授权。后续部署保留各环境自己的配置。
- [x] 文件／知识只冻结来源引用，调用时继续由当前用户重新授权，不复制文件内容或平台密钥。
- [x] 明确专家后端的最小绑定与执行接口；已有客户端 Foundation 不能等同于盒端常驻执行。
- [x] 运行部署、模型与文件相关回归，并在 102 检查真实模型响应、文件选择及重启后的读取。
- [x] 修复实机重启暴露的同盒子会话恢复缺口，重新打开工坊并读取真实部署操作。失败写请求不自动重发。
- [x] 审阅任务差异与回归结果；本轮提交及远端 SHA 核验结果随交付报告记录。

验收以真实调用为准：资源能力制品可部署；模型 dev/prod 修改互不影响；文件选择后重开仍可读，撤权后拒绝；旧 generation 不可继续操作；原有纯数据应用升级与离线续办不回归。专家只有在绑定实例、真实执行与结果持久化验证通过后才能声明可部署，不能仅根据接口目录放开。

## 文件与分工

主代理负责 `deployment/miniapp_profile.py`、其测试、方案与 102 集成；资源代理负责 `delivery.py`、`workshop_runtime.py` 与对应测试；专家代理只读核对盒端已有执行与绑定接缝。依赖现有 StudioStore SQLite 事务、PersonalSpace／知识库实时授权、模型目录及现有 SSO 身份，不引入凭据副本。

实机验证追加：专家代理负责 `integration/personal-client/workshop-service.mjs`、`integration/embedded-workspace.mjs` 与对应两套 Node 测试，修复失效链接未淘汰、同 scope 重开仍沿用旧闭包的问题。主代理装配客户端并复验。已有后端资源验证见[102 验收记录](../verification/kaiwu-deployment-resources-box102-20261113.md)。

## 专家后端约束

外层部署包、请求、回执继续沿用既有三项合同。内部后端描述增加专家模板／版本依赖以及冻结绑定摘要；绑定包含 owner、box、应用、环境和 generation，服务端将逻辑绑定解析为私有实例，不接受客户端任意 agentId 或任意路径。优先复用已有私有专家准备与 `/threads`、`chat/ws` 对应盒端执行服务。模型／知识／文件能力由专家已有工具链提供，不重新实现。

SSO 与 local-trust 的能力不能混同；后者现有纯文本限制仍然有效。整套 Foundation 含渠道、CRM、备份等能力，不整体开放到部署应用。

## 专家后端详细实施方案（待实现）

以下是已核对现有代码后的后续实现方案，不代表当前 `wanx-miniapp-v1` 已支持专家部署。本轮先接通 model/files/knowledge；专家绑定、执行桥接及其产品协议尚未实现，不能将专家能力加入部署支持列表。

### 已有可复用接口

| 用途 | 既有实现 | 复用方式与限制 |
| --- | --- | --- |
| 从专家模板准备私有实例 | `octop/src/octop/infra/agents/experts/catalog.py::build_create_spec_from_expert`、`infra/agents/manager.py::AgentManager.create` | 从冻结模板生成 `AgentCreateSpec`，由现有 registry 初始化工作区、配置和运行时；不复制专家框架。REST 包装为 `api/routers/experts.py::create_agent_from_expert`，输入模型为 `FromExpertBody`。 |
| 实例准备与绑定校验范例 | `octop/src/octop/infra/applications/local_resources.py::LocalApplicationResources._expert` | 参考其确定性实例 ID、私有 owner、来源 marker、工作区完整性和幂等准备机制；它属于 local-trust 的签名资源流程，不能直接视作 SSO 部署已经取得授权。 |
| 已准备资源的客户端解析 | `apps/personal-client/host-sdk/index.cjs::resolveResourceBinding`、`requestExpert`；`applications/backend.mjs::getCompatibilityContext` | SDK 已支持 `resourceId → instanceId`，由宿主注入已校验绑定。这里是现有能力，当前 miniapp 部署尚未连接该绑定流程。 |
| 服务端准备一次专家输入 | `octop/src/octop/api/routers/chat/turn.py::prepare_dashboard_turn(server, *, agent_id, user, turn)` | 复用 Agent 可见性、模型、线程和工具上下文校验；`turn` 使用现有 `ChatTurnBody`，应用不能直接提供任意 Agent、工具列表或路径。 |
| 服务端提交与接收结果 | 同文件 `build_dashboard_inbound(...)`；`gateway.ws_hub.register(connection_id, send_fn, user_id=...)`；`gateway.channel_manager.enqueue(WS_CHANNEL_ID, inbound)` | hub 接受普通异步回调，无需真实 WebSocket 或客户端常驻。复用现有 gateway 队列、执行锁和专家 harness。 |
| 历史与取消 | `api/routers/chat/history.py::get_thread_history`；`AgentManager.cancel_stream(agent_id, thread_id)` | 状态来源为当前绑定的线程与历史；取消只能作用于该应用登记的运行，不能停止任意用户线程或卸载整个专家。 |

现有 Builder Foundation 的 `expert.run/tasks/cancel` 确实通过 `/threads` 和 `/chat/ws` 执行，但任务状态在客户端目录，且 `expert.run` 接收用户传入的专家 ID。因此仅作为调用链参考，不直接充当盒端后端。

### 模板依赖、私有实例与部署绑定

后端描述需要引用可验证的专家模板或专家资源，以及对应版本／内容摘要。发布时冻结依赖与允许的业务入口；运行时不得从可编辑应用数据中读取或替换权限绑定。既有模型、文件和知识库授权按平台当前策略重新校验，不将密钥写入制品，也不因专家被部署而新增工具授权。

服务端生成私有实例 ID，以 owner、盒子、应用和 dev/prod 环境隔离实例。每次发布的绑定进一步记录 generation、制品摘要、模板依赖摘要和实例 ID。相同依赖可以复用经校验的当前环境实例；模板发生变化时准备独立候选实例，避免在正式切换前修改正在服务的旧实例。准备和恢复都必须校验实例 owner、非共享状态、平台归属及来源 marker；不匹配时拒绝，不能接管同名实例。

三项合同的外层结构保持不变。上述信息放在版本化的内部后端描述和受信绑定记录中；如需新增内部字段或引用类型，必须同步 schema、严格校验器、摘要计算、客户端读取逻辑及兼容测试，不能只在 JSON 上附加未校验字段。内部绑定摘要应进入部署冻结依赖，实际实例 ID 不由 renderer 传入。

### 受限 runtime 操作与生命周期

后续产品协议应限定为 `run/status/cancel` 三类操作，准确命名、输入与错误码在实现前统一，不在本轮临时形成另一套公开专家协议。

1. `run` 接收逻辑绑定、业务输入及幂等标识。请求内先校验真实 owner、运行会话、部署 generation 和 capability；服务端解析该应用的专家实例，生成独立线程与 session key。不要调用会重置用户 dashboard 当前会话的线程创建包装；可复用 `ThreadRegistry.create_thread` 创建独立线程，再交给 `prepare_dashboard_turn` 校验。
2. 在现有 store 登记归属于该绑定的运行记录，注册 hub 回调，再经既有 gateway enqueue。回调将必要的运行状态和最终结果持久化，保留对应线程 ID；不建立另一套专家执行队列或直接拼接任意 HTTP 路径。
3. `status` 只能读取该 owner、应用、环境与运行记录允许访问的结果，结合既有线程历史和 active 状态判断。不能只根据内存有无回调声称成功。`cancel` 先校验相同归属，再调用现有线程取消能力；对于尚未开始或结果未知的运行应返回准确状态，不虚称已停止。
4. SSO 请求结束后，已经接纳的执行继续由盒端 gateway 负责；用户关闭应用或断开连接不应撤销运行。回调使用服务端冻结的有限绑定信息，不持有客户端 token，不依赖已经 reset 的请求 ContextVar。资源访问仍须遵守实时授权；部署替换、用户停用等变化应按照明确的运行保留／取消策略处理，并在返回结果前重新核对归属。
5. 盒端重启后，以持久化运行记录和现有线程历史恢复查询。既有 gateway 内存队列没有跨重启自动重放保证：未能证明完成的调用标记为中断或结果未知，不自动重新执行，避免重复文件写入、消息发送等副作用。新请求必须有明确的用户触发和幂等行为。

`mount_workshop` 的身份依赖会在请求结束时 reset `workshop._actor` 和 `LocalStudioAuthority._actor`。后台回调不能继续调用依赖这些 ContextVar 的管理接口来冒充当前请求。SSO 可采用已校验绑定和当前用户启用状态的窄后台身份；local-trust 必须另行复用有生命周期的任务 lease，并保留 `LocalDataInbound` 的 live guard。现有 local-trust 输入禁止命令、附件、MCP、显式技能、其他 Agent 与知识库参数，并强制 ask 模式；这套限制不能通过内部调用绕过。

### 后续实现与验收边界

后续增加一个工坊专家后端桥接模块，由 `mount_workshop` 注入已有 server/registry/gateway；部署 profile 负责候选准备与绑定冻结，runtime 只分发确定的三类操作。只有在下列验证通过后，才放开专家部署 capability：私有实例幂等准备；真实模型与专家执行结果；dev/prod、owner 和无关 Agent 隔离；旧 generation 不可发起新调用；关闭客户端后盒端继续运行；重启后结果可查询且未知运行不重放；取消与幂等重试无重复副作用。以上桥接、内部描述版本扩展和端到端验证目前均待实现。
