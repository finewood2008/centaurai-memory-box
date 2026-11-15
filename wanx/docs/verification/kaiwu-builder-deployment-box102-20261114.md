# 原开物部署验收记录

日期：2026-11-14。最终入口为原开物 `ai.wanx.studio`、`/api/app-studio` 和 `StudioService`。此前个人工坊的实机记录不计入本次原开物端到端验收。

最新结论：原设备托管模型通道、原开物 PM／Runner、正常采用与交付目录导出，以及 102 上专家后端＋配套客户端的 dev／prod 部署均已实测通过。最终采用版本为 v0.1.5，真实问答、双击防重、取消、双环境隔离、关闭后继续执行及重开读回通过。以下按阶段保留历史失败与修复证据；最终项目交付记录见末节，早期“未通过”不代表本轮最终状态。

## 本地实现及检查

- 原开物显式选择专家合同，经正常准备／生成流程冻结；只从已完成并采用的成果导出标准目录，不重新编译。
- 新专家成果的身份包含冻结合同摘要；恢复版本保持合同校验。普通历史成果 hash 保持兼容。
- Studio 与 Workshop 使用独立存储和可信运行通道，盒端持久来源登记拒绝跨入口接管同槽位。
- 企业客户端通过原开物受信连接执行 managed 安装、握手与回执；普通安装、卸载和版本选择不能接管受管槽位。
- 后端聚焦回归：17 个文件，305 passed；包含版本、准备、专家执行、目录交付、权限及工坊兼容。
- Builder 本次路由、UI、运行通道、交付 worker 和原开物 Host 聚焦回归：47 passed。
- 本地数据 gate 实际部署策略回归：9 passed。企业客户端本次 managed 管理及自动恢复入口回归：2 passed。
- Builder TypeScript／Vite 构建与官方打包、企业客户端 renderer 构建通过；装配最新原开物 Host、工作台及共享 runtime。macOS arm64 Electron、原生依赖和签名验证通过。

以上是代码及本地构建结果，不表示盒端应用已通过验收。未将既有全量 Node 检查中的 Starlink 收据／源码摘要基线问题描述为本次已解决。

## 真实入口进度

企业客户端通过自身安装身份正常登录。用户于本轮明确批准仅恢复该身份对 102 的 remote.p2p 与 omnia.use；恢复操作 `9a7dfef7-f5d7-46ee-b422-3985d6a820cf` 已获真实设备 ACK ready（authVersion 486），其他两盒逐项不变，同盒另外 7 份 active grant 仅更新授权协议版本，原有效期和限制保留。恢复后企业客户端已正常连接 102 并打开原开物独立应用。

原账号 Codex runner 原先禁用，已在正常 ACP 设置仅启用原配置，保留命令／参数／环境／信任等字段；原开物环境检查返回 available。真实项目 `a31a3eab431540cc9b26788ab2f28723` 已创建，并从正常界面选定小通模板及文本探测合同。首条 intake 回复未通过结构校验，选定合同后正常重试完成任务简报，foundation/data 能力检查及交接通过。PM 初轮和正常重试均失败，底层为 Codex 到设备模型桥 /responses 返回 HTTP503 MODEL_PROVIDER_UPSTREAM_FAILED，token 使用为 0；未生成可采用成果。Kaiwu 专属默认 gpt-6.1-sol，与已成功的 Intake／专家运行 active model deepseek-flash 不同，不能以普通聊天成功代替 Responses 实测。

原开物真实 PM／Runner 生成、采用及项目导出尚未通过。按用户明确的部署团队边界，主流程另以独立上游合成目录从原开物目录入口完成：不伪造编辑项目的任务／采用记录，不把目录部署结果冒充生成链成功。

后续使用用户新提供的中转站凭据，在本地及 102 直连 `gpt-6.1-sol`，已通过 Responses、SSE、工具续接和实际 Codex app-server 测试。该测试未切换正式设备托管配置，不能替代上述 PM／Runner 验收；详见[中转站验证记录](kaiwu-responses-relay-box102-20261114.md)。

再次从原开物正常界面提交新 PM 轮次后，仍失败；最小对比已将原因收敛到当前托管凭据的 Responses 协议限制，实际上游为 HTTP403 `WANX_PROTOCOL_NOT_SUPPORTED`，盒端代理统一包装为 HTTP503。详细证据和正常接入路径见本文末节。

102 已通过用户提供的 97 跳板完成后端更新，镜像为 `sha256:fe7c1cc33a6316455944fc0f946f7600c7ad88e1570f2f7f03ea9c3e93d0e09c`，源码树摘要 `dd8bd8696a4efca122e8b3841974e06c491cd9b0e194e18d674fd405ab0639c8`。68 个源码文件在镜像内通过真实 Python 3.12 摘要与模块导入检查；沿用原镜像基础层，构建禁用网络。新容器健康且交付 ready，保留旧容器回滚副本，未改 OTA 账本。两个 root:0644 SSO target 的摘要不变，其他三个容器未重启。旧工坊仍有 3 个项目、7 个成功部署操作、8 条专家运行（7 成功／1 取消）；平台更新完成时的基线快照中，原开物独立存储已初始化，尚无验收项目；随后本轮已创建下述项目与部署记录。

首次平台更新后的来源登记为 0600 文件，SQLite quick_check=ok，保留 6 个 workshop 槽位，当时尚无 Studio 声明；目录部署后已增加下述 2 个 Studio 声明。更新前后工坊计数及状态逐项相同，其他三个容器的 ID／镜像／启动时间／运行状态相同。

平台健康和交付 ready 只证明服务更新可用，不替代应用端到端验收。

验收完成后，经正常退出确认关闭本次企业版调试实例及测试窗口；本地 19337／19338 调试端口均关闭。原有普通个人客户端仍在运行，两个新安装应用及验证数据保留在企业版用户目录。

## 验收清单

- [x] 102 平台更新后健康、交付 ready，原工坊数据及其他容器保持。
- [x] 原开物集成：项目创建、专家选择、能力复检、正常 PM／Runner 生成及后续代码修改通过。
- [x] 原开物集成：通过正常界面采用 v0.1.5 并生成项目交付目录，来源与真实成果逐项一致。
- [x] dev 部署完成真实后端探测、客户端安装、握手及成功回执。
- [x] 同一发布进入 prod，并验证两环境数据和专家运行隔离。
- [x] 真实问答、重复请求幂等、关闭重开读回及取消。
- [x] 受控服务重启后部署回执和业务历史持久读回，未发生重复执行。

## 原开物目录部署主流程实测

上游输入为独立合成测试应用 `example.deployment.kaiwu-text-assistant`／`0.1.0`，发布 `kaiwu-directory-20261114-v1`，通过固定编译器从测试源码实际编译，未更改旧工坊已冻结目录。客户端声明 data/foundation、runtimeNamespace=studio；后端使用真实 general-assistant 模板（界面显示小通）。先在本地真实 Studio Intake 校验，再原子投递到盒端受信收件目录；浏览器只输入 releaseId，正常读取、勾选版本和环境后提交。

- payload artifactHash：`1bbcdc0bbc460edf76aa491091925eca56e7efcb47b1f47cf8f1e1b3b0b2f923`。
- directoryDigest：`sha256:83b4fa03caa2176cfda6eddfb2ed53517bfa9002ca956e50cf3dab153e7704cb`。
- 压缩包 SHA256：`91fd9740b15067e5618f664fe1441c59dba3d5a7cf30072d5e509679b8dec8ef`。

| 环境 | 操作 ID | 受管客户端槽位 | 结果 |
| --- | --- | --- | --- |
| dev | `22598a311ad541df95a1ecd54031b0df` | `ai.wanx.selfmade.91c39e89d7dd8dcd26f720f3c8365127` | committed gen1，后端／客户端 ready，回执 delivered |
| prod | `c51522ed428843f6b1be793e059d1440` | `ai.wanx.selfmade.ca08d3f6f7b16b7f33f5a49c6540bef1` | committed gen1，后端／客户端 ready，回执 delivered |

两环境 binding 和实际安装 runtime 都为 studio，SourceRegistry 新增两个 studio 声明，保留旧 workshop 六个；两个专家私有实例不同。真实企业客户端本地应用列表出现联调／正式两项，通过其正常打开入口验证：dev 返回 WANX_EXPERT_KAIWU_DEV_OK，prod 返回 WANX_EXPERT_KAIWU_PROD_OK，历史互不包含另一环境记录。

通过正式客户端正常开发者工具，仅调用公开 miniappHost.invoke 能力接口，以原 operationId 和原文本重复提交，返回原 run `a6b749279736464499cbd26fc0f127c3`，没有重复入队；同 operationId 不同文本明确拒绝 EXPERT_OPERATION_CONFLICT。未读取令牌或调用私有 IPC。

离线任务 `e1551fccf7a642b982d6e7e5212280c0` 在正常界面已受理后关闭窗口（1794624569.309）；关闭后只读观察仍在处理，最终于 1794624670.071 成功，晚于关闭约 101 秒。原生 AI 消息与专家结果同为 14973 字符、finish_reason=stop，单次模型调用；重开正式客户端看到该已完成历史及 WANX_EXPERT_KAIWU_OFFLINE_OK。首次过早关闭发生在请求实际受理前，未产生专家运行，不计入离线成功证据。

联调取消任务 `4a52539282144419b42594a55c4f2b4b` 经真实界面取消，终态 cancelled；保留已产生的部分结果，未显示为成功。

## 受控重启与验收收尾

全部 Studio／Workshop 专家运行、项目任务、编辑、访谈、准备探测及部署操作均无 active 工作后，在 updater 锁及两侧升级 guard 下再次核验，优雅重启同一容器 `6d46430f0b9cf339eb88544f465926c9a1bcc14fa2d8650be14e187dfadbed7f`／原验证镜像，启动时间由 01:39:57Z 变为 02:57:22Z。健康及交付 ready，配置／挂载／目标摘要保持，其他三个容器不变，无强制杀容器和 OTA 账本改写。

重启前后共六条专家运行的 ID、请求 ID、状态、时间、结果标记及长度完全一致，没有新增运行；dev／prod 仍 committed gen1、双端 ready、回执 delivered。真实界面刷新后原开物继续显示正式部署成功，未出现连接失效提示；正常重开正式客户端读回离线结果及原问答，重开联调客户端读回原问答与取消终态，两环境仍互相隔离。旧工坊的 3 个项目、7 次成功部署、8 条专家运行保持原数量及状态。

本次实机重启覆盖终态持久性和无重复执行；运行中强制中断的恢复只有本地回归覆盖，未在盒子注入强制断电／kill。项目 PM／Runner 生成链保留为独立上游阻断项，未伪造采用成果。

## 新一轮原开物生成验证与协议限制

用户确认模型通道可用后，再次通过原万象团队客户端连接 102，打开原开物独立应用中的已有项目 `a31a3eab431540cc9b26788ab2f28723`。首次连接出现短暂 `network_unavailable`，自动重连后恢复，盒端容器始终 healthy；未改网络、身份或授权。

在正常需求输入区补充已确认范围并点击发送，创建新操作 `9334efd6-2fbd-4045-b318-30813f05870c`、新轮次 `0f97d470da7b4ee38c3196aa2381e71d`，没有重放旧失败轮次。冻结模型为 `admin-managed-qeetoken/gpt-6.1-sol`。轮次于 03:52:44.030Z 接纳、03:52:44.368Z 失败，错误 `CODEX_TURN_FAILED`；真实 Codex rollout 对应本地 `/model-providers/qeetoken/v1/responses` 的 HTTP503 `MODEL_PROVIDER_UPSTREAM_FAILED`。该项目仍无生成任务成果、无采用版本，未执行本轮项目导出或成果部署。

为区分代理包装与实际上游错误，使用同一最小合成 Responses body，每条路径各请求一次：

| 路径 | 结果 | 能证明的范围 |
| --- | --- | --- |
| 当前受管投影的 opaque key → 本地 Responses 代理 | HTTP503 `MODEL_PROVIDER_UPSTREAM_FAILED` | 复现当前正式模型通道失败 |
| 正常 device GET 租约，经校验后在盒内使用当前上游凭据与实际 `PublicPinnedTransport` | HTTP403 `WANX_PROTOCOL_NOT_SUPPORTED` | 当前托管凭据／通道明确拒绝 Responses |

租约 GET 通过既有绑定校验，provider configVersion=`4`、credentialGeneration=`1`、profileRevision=`1`、defaultsRevision=`1`；未发送 ACK 或配置写入。上游凭据仅在盒内进程内存使用，未输出、落盘或带出盒子。探针保留 TLS 和目标校验，未创建盒端临时文件。实际运行的 `model_provider_runtime.py` 与当前工作区摘要一致；它对所有上游非 200 都调用默认 503 错误包装，因此此前的 503 不能解释为真实上游服务 503。

已实时核对中转服务仓库 `nexusaos-token-sub2api` 的远端：`master=041d7822bfa0d147770b3182ce92609eb4cf91de`、`release/qeetoken-production=437ffd8849de5ac42cd54aedd9b8f6718834fea3`。在私有隔离 bare 仓库读取最新 master，`backend/internal/handler/wanx_billing_guard.go` 仍仅对 `sk-wanx-` 托管凭据放行 `GET /v1/models`、`POST /v1/chat/completions`，并明确对 `/v1/responses` 返回该 403；对应测试也断言拒绝。新 master 更新与 balance feed 有关，未提供托管 Responses 支持。普通 API Key 的 Responses 成功与此限制可以同时成立。

正常备选接入已按源码链核对：由 Admin 为 102 新增独立 `qeeshu-responses` Provider，使用用户已实测通过的普通 API Key，只将 Kaiwu 默认切为该 Provider／`gpt-6.1-sol`，保留 dialogue／Starlink／active model 和其他盒子。schema3 会合并自定义 Provider，与现有托管 Provider 分别投影；设备租约、Owner、模型范围及本地代理鉴权继续有效，手工默认不会被自动默认覆盖。此方案尚未执行，仍依赖正常 Admin 登录会话。未通过 SQL 写入或伪造凭据替代 Admin 操作。

若坚持使用原 `sk-wanx-` 托管凭据，需要中转服务完成 Responses 协议与计费全链支持并部署；不能仅删除协议拦截。本轮未改该服务，也未修改平台模型配置或重新部署已有目录来冒充生成验收。

## 托管修复上线后的再次复验

上节为修复前记录。随后自有中转仓库完成托管 HTTP Responses 与计费完整性修复，提交 `737c089a`，合入子仓库 `master` 为 `8767dee0188c57999ef6e998824ab0555bfba8ff`，两者源码树相同。发布仓库固定引用修复也已合入；本次实机读取二进制为 `flow-5337488-15-30e3afe6`、commit=`8767dee0`，容器 healthy、restartCount=0。旧 Chat-only 标记不存在，新 Responses 规则及 `WANX_USAGE_INCOMPLETE` 标记存在，证明已运行正确修复版本。

继续使用 102 当前租约及真实 Kaiwu 默认 `gpt-6.1-sol`，未改 Key、分组、模型默认或线上服务配置：

| 实际请求 | 盒端结果 | 对应中转执行与计费 |
| --- | --- | --- |
| 非流式，store=false、max_output_tokens=128，探针自身上限 30 秒 | 30 秒内没有收到 HTTP 响应；不能据此单独判定协议不可用 | `wanx:decdc0ca-29a1-4b38-9b77-480815690574` 约 130.31 秒后转 `review_required`，无结算命令、无扣费事件 |
| SSE，store=false、xhigh、max_output_tokens=2048，探针上限 180 秒 | 约 120.160 秒收到 Bridge HTTP503 `MODEL_PROVIDER_UPSTREAM_FAILED`；未收到 SSE 事件、文本增量或终态标记 | `wanx:be578461-bce8-4388-81c6-528553d8183f` 约 130.46 秒后转 `review_required`，无结算命令或扣费事件 |

两条请求均已自然结束，没有活动的测试执行。未追加工具续接或 PM 模型请求，不以既有目录部署结果代替本轮生成结果。

精确关联 SSE 的中转 request `db600ac0-cdcb-44b5-9ed1-1a275044f4ce`：请求已进入原生 Responses 处理并选中 account 2；`ops_error_logs.upstream_errors` 为 `kind=request_error`、timeout 类别，没有真实上游 HTTP 状态，upstreamLatencyMs=130438、responseLatencyMs=1。因此日志中的 502 是请求异常包装，不能称为远端服务返回 HTTP502。Bridge 的 120 秒是读取等待／间隔超时，不是完整推理总时限；本次没有修改超时设置。

该账户为 `openai/apikey`、active／可调度，`force_responses` 且声明 Responses 支持；选定上游为 `https://api.tokenclub.pro/v1`，不是自身回环，也未走 Responses→Chat fallback。线上服务器 DNS 成功，但到该主机 443 的无鉴权 TCP 连接超时；尚未进入 TLS 或 GET `/v1/models`，不能将其写成接口返回异常。另一本机对照 TCP 已连接，但 TLS 握手在 5 秒上限内未完成，也没有发送鉴权或模型请求。

有限网络控制对照：tokenclub 当次仅解析出一个 IPv4；服务器到已配置 account 8 上游 `api.deepseek.com:443` 的 TCP 连接约 6ms 成功，说明不能把本次现象归为服务器所有 443 出站均失败。账户 2 的 proxy_id 为空，运行容器没有 HTTP(S)／ALL／NO_PROXY 环境变量；对应传输源码在未指定账户代理时使用 `Transport.Proxy=nil`，不会自动读取系统代理。因此当前证据定位于到 tokenclub 特定目标的直连路径，尚未证明该上游在所有网络均不可用。

当前可确认：修复版本与托管准入已通过；真实模型响应仍未通过，阻断已转为选定上游请求／连通性问题。原开物正常生成、采用及导出仍保持未通过，本轮未提交新 PM 轮次，未创建虚假成果或触发生产中转站重新部署。

## 新增上游后的分组先决检查

用户新增上游后再次只读检查，修复版本 `8767dee0` 仍健康运行。新增上游为账户 ID `9`（名称 `zuzai`、主机 `www.tuzai.icu`），状态 active、可调度、未过期，模型映射命中 `gpt-6.1-sol`；这仅是配置检查，尚未证明真实模型调用可用。该账户创建于 08:40:51Z，当前只关联分组 ID `2`。

102 当前确认的托管 Key ID `77` 属于分组 ID `9`「万象用户组」，该组目前仅关联账户 ID `8`（DeepSeek），其模型映射不匹配 `gpt-6.1-sol`。旧账户 ID `2` 已不在上述两组当前关联中。因此本轮先决条件不成立：新的 GPT 上游尚未进入托管路由，不能用普通 Key 所在分组的配置代替真实开物路径。

账户 ID 与分组 ID 是不同的编号；新账户为 `9` 并不表示它属于分组 `9`。需通过正常管理入口将目标账户关联到「万象用户组」后，才具备继续测试当前 GPT 默认模型的候选条件。本轮未发模型请求、未提交 PM、未改关联／模型／代理／余额或部署配置，生成、采用和导出继续保持未通过。

## 新上游关联后的托管通道复验

用户通过正常管理入口将账户 9 关联到分组 9 后，102 使用原托管路径、当前设备凭据和 `gpt-6.1-sol` 完成一次真实 SSE 请求：HTTP200，约 2.457 秒收到首事件与文本增量，2.664 秒完成，收到 `response.completed` 及预期合成标记。请求采用 instructions/input 消息数组、xhigh、store=false、max_output_tokens=2048，没有替换为普通 API Key 直连。实际中转选中账户 9，执行 `wanx:c23d2b0e-c650-4a62-a5e7-5d362fc64480` 已 settled，输入 35／输出 12 tokens、费用 USD0.00133，对应恰好一次 usage_debit（133000 atoms）。本轮未改中转站、上游或分组配置。

随后通过原开物正常输入区发起新整理轮次 `6dba252c06ab4c5a9aed7b1d15cec382`，操作 `feab61cf-ffb7-4055-bf26-d181f7cae820`，模型引用仍为 `admin-managed-qeetoken/gpt-6.1-sol`。该轮在模型调用前暂停，错误 `CAPABILITY_CHECK_REQUIRED`；没有 interview.started／MCP 调用，也没有生成任务或成果。正常重新检查能力后，报告仍只包含 foundation，而需求交接要求 data + foundation；原开物检查路径在 ACP 阶段读取尚为空的 solution.capabilities，恢复访谈守卫仍读取原 intake.required，因集合不一致无法恢复。这是独立的 Builder 准备校验问题，不能据此归因于新上游或协议限制，也不能将单次通道通过记为完整生成验收通过。

准备校验修复在 ACP 阶段用单份探测报告覆盖 intake 规划与当前 PRD 开发所需能力并集，保留各自声明、权限和守卫判断；公开 `capabilityIds` 仍按 GET 公布的当前能力集合校验，不将其改为探测自选列表。历史缺项报告需手动复检，本次不声称自动修复。修复前已在真实调用链得到 `CAPABILITY_CHECK_REQUIRED` 红测，并复现公开 GET→POST 的集合兼容问题；修复后准备、连续会话、PRD、专家交付及 HTTP 接口等 104 项测试通过，独立复跑准备模块 29 项通过且审阅无阻断问题。

该修复已通过 97 跳板在 102 受控更新：候选镜像 `sha256:b80b70a5cb8bc1f3f5f8b294adbd05d91057d4ce37941a30268edef274bce13a`，源码树 `93010192093060e7b8e161d3938840b7f8bdbf28e432ee738409da085baba017`。相对前次镜像的 68 文件清单仅 preparation.py 摘要变化；禁用网络的镜像构建完成摘要与导入校验。首次执行在获取 updater 锁时因短时 UPDATE_IN_PROGRESS 退出，未替换容器；锁正常释放后重试成功，新容器 `9b22032aec2e4fea5fd7d96032fe07710a016f5b278d7f5a3529ccf63ab62450` 健康、交付 ready。保留旧容器回滚副本，切换期间持有 updater 锁与 Studio／Workshop 双升级 guard，完成后正常释放；配置／挂载／SSO targets 及其他三容器核验一致，未停止 updater、绕过锁或改写 OTA 账本。

正常重开原开物后，手动点击能力检查，报告和交接报告均为 data + foundation、两项 passed。随后点击最新暂停消息的「继续处理」，复用原轮次及请求 ID；该轮已进入 running，interview.started=1，真实 MCP read_project=1，当前错误为空，界面出现真实 AI 整理回复。没有直接修改项目库、补写成果或新建重复输入。此时仅证明准备校验恢复及 PM 模型／工具调用开始，尚需以保存完整 PRD 和正常成果导出等终态确认完整链路。

该 PM 轮次随后自然完成：completed、sync=saved、error 为空，存在真实 prdReview；proposal.ready=true、missing=0。实际 MCP 执行 read_project 2 次、update_prd 4 次（前三次来源参数被拒绝，模型自行修正后成功）、propose_contract 1 次、complete_prd 1 次，完整 PRD 已保存并出现正常开发确认入口。来源 ID 供给与校验集合经只读源码核对一致，未放宽 provenance 校验或人工补写方案。此时仍为 0 开发任务／0 成果，PRD 完成不等于 Runner 或部署验收通过。

主代理在正常完整 PRD 界面审阅方案，同时只读核对同一持久化 solution、collectionSchema 与 specHash=`7e6a8567b90271751e46e89f147779ffc817efbb27eb2fc4ea31b928617a8f70`、impactHash=`e80d739e68e7a10ec091265fd58b28785c2524160c8530a3710e5d3bfe3428c5`。随后通过正常勾选及「确认这份 PRD，开始开发」创建首轮真实构建；未直接调用私有开发接口或补写成果。方案只有单页文本问答、foundation/data、expert_runs 集合，保留未知请求 operationId/text/scopeId，不自动重发。

首轮真实 Runner 任务 `1d330af03bc54217a92c439a01736517`（请求 `db1c8dc7-828e-47ce-a7ac-98c95c6e8e68`）完成，模型仍是托管 gpt-6.1-sol；真实 MCP 完成 read_material、list_sources、write_source、update_plan 和 validate_app，共 7 次 completed。产生 v0.1.0、artifactHash=`edc9aa06473dc392551d37213578c5752d6bf99ae135f4afe99fcd10fa6f0f19`，内容／checkpoint／冻结专家摘要已校验。预览真实返回 EXPERT_DEPLOYMENT_REQUIRED，未伪造专家回复。

对实际生成源码的独立审阅发现客户端问题：foundation.invoke 使用单对象签名而 SDK 要求两参数；data.put value 混入 _id/_revision 且保存后未使用新 revision；提交无 busy 门禁可能生成重复请求。因此没有采用或部署首版；通过正常「直接修改」入口提交修正要求，保持已确认 PRD 与固定专家合同，要求真实修改、校验并保留旧版。编译及生成成功不能替代生成代码语义与部署实测。

首次直接修改在规划阶段未成功保存 finish_edit 的 ready 结果，返回 EDIT_DRAFT_INCOMPLETE；输入完整，尚未创建开发任务。只读确认其为模型把只读规划角色误认为代码执行角色，未据此放宽权限或改后端校验。原地重试后仍未转交，于正常界面停止旧轮次，再由正常队列处理明确阶段说明。后续 edit `90c9f1b0dcac485eb37399bd0668bfbc` 正常 ready，任务 `6f1adcc52b1d4aa39bc89a30bdd47f9f` 生成 v0.1.1，hash=`93679e9aae11158258db58cf2e7d4d808154c159a64d137fca5a3d04b75eccc4`；一次编译错误由模型自行修正，最终校验通过，冻结专家合同摘要仍为 `15e8076022f7da9d4237a38d4edac95ce26c4fa5d5deefd21bc97118f3aa8763`。

实际源码的四项原始 smoke 红测在 v0.1.1 全部转绿，但仍需补未知结果后提交的明确确认门禁，以及查询／取消的互斥和目标快照，故该版也未采用。通过正常直接修改入口提交精确要求后，规划一次 ready，任务 `f1f2f09719984576863ff06fece186a4` 开始真实构建；未手工改写任何产物或采用状态。

## 原开物项目生成交付全链路最终实测

同一项目通过正常修改队列保留 v0.1.0—v0.1.5 六份真实成果，仅最终 v0.1.5 通过审阅后采用。初版 SDK／数据／并发问题及后续未知请求确认、历史选择与跨 scope 边界，均先用实际生成源码复现，再由原开物规划与构建器真实修改；未手工替换封存源码或补写采用状态。最终 13 项隔离行为 smoke 全部通过，覆盖真实 SDK 签名、业务字段与 revision、双击、并发、晚到响应、跨 scope、重开只读、取消状态，以及连续未知结果逐次明确确认。隔离测试用合成 SDK／数据，不冒充盒端实测。

最终源码与封存 files 逐字一致，独立重算 artifact hash 和专家合同 seal 均匹配：

- 应用：`ai.wanx.selfmade.4730cc7b5cb4424b9d75be259938304e`，v0.1.5。
- 制作任务：`c6cf647646bf4d5ca774620b940a7a0d`；artifactHash：`887d57ae3051d4ca2f83d2f205b2bd592c617ea578c991edca20496604af71dd`。
- 专家合同摘要：`15e8076022f7da9d4237a38d4edac95ce26c4fa5d5deefd21bc97118f3aa8763`；始终为原 general-assistant 固定模板与文本探测合同。
- 正常 UI 采用后生成发布：`kaiwu-d7ee4c89ef3977228efd7cd0720d54d6be87bdc619a2b45e`。
- 目录摘要：`sha256:0dd9d4159ff3519df0680e7ac051a6a0b9f68576b920f9e59bad6d9feced4ca0`。

交付 source 中的项目、采用成果、task、contentHash、versionRevision=13 与实际采用记录一致；入库 bundle／CSS／manifest／version 与该成果逐项相等，后端模板和 verification 与冻结合同相等。生成目录没有重新编译，没有借用此前独立合成目录来代替项目导出。

正常 UI 核对同一盒子 `centuaros-87dbea31110a0bbf0000fe1`，分别确认 dev、prod 部署：

| 环境 | 部署操作 | 实际安装槽位 | 最终结果 |
| --- | --- | --- | --- |
| dev | `37d18bf1639e493db29d17767e62f494` | `ai.wanx.selfmade.35bda95c7e887265bea154054906703c` | succeeded／committed gen1，后端和客户端 v0.1.5 ready，成功回执 delivered |
| prod | `4d19550dbc3e4d6d8a7efe2700005c5d` | `ai.wanx.selfmade.71bdbc609ea064edf7cdb5d8b7505c4f` | succeeded／committed gen1，后端和客户端 v0.1.5 ready，成功回执 delivered |

两槽位实际 binding／runtimeReady／expertClientReady 均通过，来源为 studio，使用两个不同私有专家实例。通过万象企业客户端的本地应用正常打开真实 managed 安装目录，完成以下验证：

- dev 双击提交操作 `2196ac747555c138d60d05b53d00e551`，只产生 run `2f66983f5f3a41eeb28526392385e1fa`；真实终态 succeeded，回复包含 `WANX_KAIWU_PROJECT_DEV_OK`。刷新后读回同一历史。
- dev 取消 run `61d9d68d71a6474197c1db4f59ea56ac`，界面先显示 cancel_requested，继续查询后显示 cancelled，未当成成功回复。
- dev 离线 run `6d14e5bbd28d4f45a8212b7df81479a8` 已受理后退出客户端；退出后读时钟为 10:14:39Z。该运行于 10:15:30.261Z 成功，晚于退出 51.261 秒，结果 5654 字符且包含 `WANX_KAIWU_PROJECT_OFFLINE_OK`。终态之后再从万象正常重开，实际界面读回该结果、原问答和取消历史，没有重放。
- prod run `ac70f430748145ceb30c4d92b6956b78` succeeded，回复包含 `WANX_KAIWU_PROJECT_PROD_OK`。刷新及退出重开后读回；prod 没有 dev／offline 标记，dev 没有 prod 标记。首次打开 prod 时也未读到已有 dev 历史。

最后只读核对：两部署与回执持续成功；新应用共 6 条运行（2 条准备探测成功，4 条界面请求为 3 成功／1 取消），无重复、active=0。Studio／Workshop 的项目任务、修改、访谈、探测及专家任务均无 active；SourceRegistry 为 studio 4／workshop 6，旧工坊 3 项目／7 部署／8 运行逐项保持，其他三服务 ID／image／startedAt／运行状态不变，WANX 健康。此前独立目录的受控重启记录继续有效，本轮生成成果未追加断电或强杀测试。未知响应、连续确认、并发与跨 scope 的故障分支由上述隔离 smoke 覆盖，不表述为盒端故障注入。

因此当前验收范围内，原开物正常生成、修改、采用、项目导出、专家后端＋客户端双环境部署和实际使用均通过。在线 QeeToken 未由代理重新部署或修改上游／分组；仅进行了授权的实际模型调用、只读核对及 102 的 Builder 修复更新。
