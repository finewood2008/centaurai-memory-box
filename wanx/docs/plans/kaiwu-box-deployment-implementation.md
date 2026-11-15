# 万象工坊部署实施记录

> 平台部署设计现由万象仓库维护；从应用开发套件迁入。当前代码位置、实际能力与本轮范围以[Builder 部署接入计划](kaiwu-deployment-ui-integration.md)和[后台实施记录](kaiwu-deployment-backend.md)为准。套件公共合同草案及离线工具仍保留；合同源码引用固定到迁移时的套件提交，公开能力指南使用持续更新的分发入口。

用户已确认第一张原型方向并要求按此实现。原型的视觉与流程作为产品依据；正式代码必须以真实任务、可信上下文和实际分项回执驱动，不能保留演示计时器作为执行结果。

## 迁移后的当前状态

截至 2026-11-13，部署后台已合入万象 master，并在公司验证盒完成服务更新和已有 miniapp 链路验收；通用 Bridge 服务注册已由 master 提供。新的完整自动部署执行 Adapter 和项目版本到可信部署上下文仍未接入。正式前端现在归入原 Builder，具体范围见[接入计划](kaiwu-deployment-ui-integration.md)，真实盒子证据见[验收记录](../verification/kaiwu-deployment-box102-20261113.md)。

以下 D0 和后端实施内容保留当时基线及验证历史；其中“通用注册尚未交付”等旧结论已由上述最新状态取代，不作为当前能力判断。

## 当前范围与依赖

D0 交接合同可执行草案已完成。用户随后明确要求“开始正式开发后端”，当前已在平台仓库独立工作树 `centuarai-wanx-deployment`、分支 `feat/kaiwu-deployment-backend` 实现持久部署控制模块。实际平台执行 Adapter 和真实盒子联调仍是后续接入依赖。

现有实现位置已核查：平台仓库 `centuarai-wanx` 的 `apps/builder/ui` 为 React/TypeScript 前端，`apps/builder/backend/wanx_studio` 为独立 Python 后台。当前套件仓库仅承载公共合同、校验工具和样例，不承载平台内部服务。现有客户端安装不能冒充盒端部署闭环。

## 执行计划

1. [x] 读取方案、原型、仓库边界，确认现有工坊代码位置。
2. [x] 三项合同落为版本化 Schema，提供纯校验器、只读 CLI 与无凭据样例。
3. [x] 验证合同之间的版本、目标、摘要和必需分项一致性，补齐负例与脱敏测试。
4. [x] 用户已授权后端；确定平台后台、受控 IPC 和执行 Adapter 边界。
5. [x] D0 草案运行检查并审查 diff，按独立分支提交；平台执行验收仍待实际 Adapter 与设备联调。

## 应用开发套件仓库影响文件

- `contracts/deployment/v1/`：三项合同与共用类型。
- `tools/deployment/`：纯结构／关联校验和摘要规则，只读命令行。
- `examples/deployment/`：规格、制品、请求与回执样例。
- `tests/deployment/`：正反例和合同关联测试。
- 部署合同说明与本实施记录；必要时为根包添加校验命令。
- `tools/package-skill.mjs` 及对应分发检查：仅将已用于应用开发的 app-builder 合同打入 Skill，部署草案留在仓库等待冻结。

不改固定 App Kit、现有 ProjectSpec、应用模板或平台能力已支持状态。

## 验收

- 首次联调不依赖已完成业务回归；正式发布缺少对应证据被拒。
- 公共请求不能提交内部 recover；管理动作不被业务回归字段阻塞。
- 发布包摘要与客户端交付方式不可随目标环境变化，正式复用同一包。
- 成功回执不能遗漏必需组件，离线、未知提交与不匹配版本不能冒充成功。
- 管理操作代次、终态、回执交付状态分别处理。
- Schema／工具不联网、不操作盒子、不输出输入凭据；结构通过不代表来源可信或部署可用。
- 运行专项测试及 `npm run check`，审查最终 diff，验证推送远端 SHA。

运行时和客户端 Adapter 的能力核实、真实盒子联调属于后续平台实现验收，不以合同样例代替。

## 平台代码核实结果

核查基线：`centuarai-wanx` 的 `18cace69`，工作区无未提交改动。以下是内部实施定位，不代表已部署设备能力。

| 位置 | 已确认事实 | 接入要求 |
| --- | --- | --- |
| `apps/builder/ui/main.tsx`、`ui/api.ts` | 已有工坊与开物工作区、可信会话请求和版本选择。 | 将部署作为独立模块接入，使用已确认原型布局；不替换同事的编辑与构建流程。 |
| `apps/builder/backend/wanx_studio/api.py` | Router 支持企业与个人工坊的不同挂载前缀。 | 部署入口沿用受信身份，不能接受页面自报 owner 或管理权限。 |
| `apps/builder/backend/wanx_studio/store.py` | SQLite WAL、事务和幂等模式可参考；已有开发任务重启后标为 interrupted。 | 部署任务另建持久日志与对账机制，不能直接借用开发 Runner 并宣称可恢复。 |
| `apps/builder/integration/workspace-policy.mjs` | 独立窗口与嵌入式工坊共用路径白名单。 | 按精确路径与 HTTP 方法开放部署请求，保留现有拒绝边界。 |
| `apps/builder/integration/embedded-workspace.mjs` | 当前只接受 HTTP 200。 | 部署受理使用 202 时针对该路径处理，不能将受理误报失败或部署成功。 |
| `apps/builder/integration/personal-client/workshop-service.mjs` | 将工坊请求重写至个人工坊前缀，安装依赖当前客户端会话。 | 保留身份隔离；安装会话不承担后台部署长期管理凭据。 |
| `apps/personal-client/applications/installer.mjs` | 普通安装要求更高 SemVer；市场回退不等于任意发布版本激活。 | 单独确认受信环境槽位与按摘要激活 Adapter，不修改版本号绕过限制。 |
| `server/bridge/wanx_bridge/service_registry.py` | 当前注册仍限定固定服务。 | 通用盒端服务注册与路由尚需平台交付，禁止用直连端口代替。 |

正式开发使用独立 feature branch／worktree，保留平台当前分支；客户端打包汇总产物不直接修改。后台协调器已落地；Runtime／Client／Channel／Data Adapter 的实际 owner 和验收环境仍须落实，之后执行真实单盒闭环。

## D0 本轮验证记录

- 三项主合同与共用 Schema、纯校验器、只读 CLI、样例和错误路径已实现。
- 内置 34 组校验通过，21 项专项测试通过；全仓 `npm run check` 共 111 项通过。
- 独立审阅反例已修复：CLI 原型属性命令不得回显输入，已提交结果绑定请求代次和环境修订，管理动作不改变激活代次，恢复不得自引用，双端与必需入口不能被漏报。
- 已验证源 Skill 仍可脱离仓库运行；未冻结部署草案不会被打入应用开发 Skill。
- 平台仓库本轮只读核实，未修改工坊前端、后台、客户端或盒端服务；尚无真实部署闭环验收。

## 后端实施进展

平台实现和接入说明见 `centuarai-wanx` 仓库的 `docs/plans/kaiwu-deployment-backend.md`。该阶段包括 Python 合同同义校验、SQLite 持久任务与事务回执、环境互斥与 fencing、部署协调／重启对账／有界补偿／关联恢复、认证 API、IPC 白名单及 202 受理。

生产默认 Adapter 显式不可用；测试替身不代表真实盒端能力。真实 Runtime／Client／Channel／Data、长期管理授权和客户端环境槽位仍需平台接通，前端原型还没有切换到真实部署执行。

已识别合同后续完善点：v1 `recover` 成功目前固定要求组件 `ready`，不能准确表达 stop/uninstall/purge 的关联恢复。平台暂不受理这三种管理动作，返回 `DEPLOYMENT_ACTION_UNAVAILABLE`；当前提供 deploy/promote/rollback/restart 的控制逻辑。后续先补齐恢复结果合同及跨语言样例，再开放动作，避免降级后无恢复出口。本轮不擅自修改已对齐的三项合同草案。

用户追加要求：后端完成后，须在指定家庭盒子真实测试至通过。该要求纳入最终验收；已用既有密钥连接指定盒子，在隔离容器中通过 279 项后台测试，原业务容器保持健康；这不是双端真实部署验收。配套客户端暂按本机 Mac 独立测试目录准备。未经实机执行与两端连通验证，不将本地回归或合同样例列为最终验收通过。

后台控制模块已提交到平台分支 `feat/kaiwu-deployment-backend`，提交 `5b30f0c8`。工坊 Python 全量 649 项通过；共享网关 46 项与 349 子测试、Bridge 53 项通过；Node 596/597 通过，唯一失败在原基线同样可复现（assistant-channels 的手工 Channel 用例）。实际执行 Adapter、通用 Bridge 服务注册及客户端环境槽位仍未交付，已请求确认同事接口分支或扩展平台实施范围；整体真实部署验收保持未完成。
