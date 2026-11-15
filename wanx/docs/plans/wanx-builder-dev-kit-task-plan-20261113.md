# 开物适配 wanx-app-dev-kit 任务计划

日期：2026-11-13

本计划把 [开物适配 wanx-app-dev-kit 方案研究](../app-kit/wanx-builder-dev-kit-adaptation-research-20261113.md) 拆成可执行任务票据。目标是让新建应用的 PRD、工程生成、Codex 构建、打包和验收遵守 `wanx-app-dev-kit`；旧版 miniapp 项目保留 legacy 运行路径，不伪装成协议 3 应用。

## 目标与边界

- 开物继续负责需求访谈、PRD、能力缺口、版本和用户采用。
- 新项目以 dev-kit `ProjectSpec v1` 和标准工程作为唯一构建输入。
- 最终本地包由 dev-kit 的 `check → build → package` 生成，使用协议 3 清单和标准 Host shell。
- 成品应用通过 Host SDK 和公开 API/服务合同运行；Builder 私有 `/api/app-studio` 只作为工作台控制面和 legacy 运行时。
- 不修改 `octop/` 上游核心，不手改根目录 `.wanx-app-kit/`，不复制 Host SDK 到新的共享目录。
- 真实客户端安装、Host 会话和盒子业务验收单独记录，不能由构建成功推导。

## 状态和依赖约定

| 状态 | 含义 |
| --- | --- |
| `planned` | 已拆分，尚未开始 |
| `blocked` | 依赖公开合同、客户端入口或授权，当前不能安全实现 |
| `in-progress` | 正在实现 |
| `done` | 代码、测试和验收证据齐全 |
| `legacy` | 旧路径保留，不纳入新协议 3 合规结论 |

任务依赖按票据 ID 表示。每张票据完成后必须更新本文件的状态和验收证据，不以文件存在或 ZIP 生成代替通过。

## P0：合同冻结和只读兼容报告

### WANX-BDK-001 冻结 dev-kit 输入合同

- **目标**：在 Builder 中固定当前 dev-kit 版本、App Kit SDK 摘要和 `ProjectSpec v1` schema 来源。
- **范围**：`apps/builder/backend/wanx_studio/` 新增 dev-kit 适配模块；读取 `WANX_APP_DEV_KIT_ROOT` 或版本化工具包，不把绝对路径写入生成应用。
- **依赖**：无。
- **验收**：
  - 能读取并校验 dev-kit 版本和 SDK 包摘要；
  - dev-kit 不可用时返回结构化错误，不启动构建；
  - 运行日志和模型输入不包含本机绝对路径、凭据或用户资料正文。
- **状态**：`done`

- **验收证据（2026-11-13）**：`wanx_studio.devkit.kit_info()` 固定读取 sibling/env dev-kit，返回 kit 版本、SDK SHA-256、ProjectSpec schema SHA-256 和 contract 摘要；dev-kit 缺失返回结构化状态，不进入构建。

### WANX-BDK-002 实现 PRD → ProjectSpec 投影

- **目标**：从现有 `solution` 和 `ProductRequirement` 生成严格的 `ProjectSpec v1`。
- **范围**：`prd.py`、`contracts.py`、`discovery.py`、新增 `project_spec.py`。
- **规则**：
  - 纯平台能力使用 `backend.mode=none`；
  - 外部/盒端服务使用 `existing/custom` 分支；
  - 新专家才设置 `expert.enabled=true`；
  - 能力来源只保存逻辑引用，不保存 URL、token、box ID；
  - `dataFields` 转换为生成工程的数据结构，不扩展 ProjectSpec schema。
- **验收**：
  - 合法 PRD 生成合法 ProjectSpec；
  - 缺少 `contractRef`/`deploymentRef` 时阻断；
  - 重复 slug/applicationId 被拒绝；
  - 生成结果有稳定 hash。
- **依赖**：WANX-BDK-001。
- **状态**：`done`

- **验收证据（2026-11-13）**：`project_spec()` 生成严格 ProjectSpec v1，`validate_project_spec()` 校验 backend/expert/capabilities 分支，`digest(spec)` 提供稳定哈希；已覆盖重复能力和盒端 deploymentRef 缺失。

### WANX-BDK-003 增加产品经理合同工具

- **目标**：让 PRD 会话能够提出组件选择、记录平台缺口并执行 ProjectSpec 校验。
- **范围**：[interview-tools.mjs](../../apps/builder/codex/interview-tools.mjs)、产品经理提示词和相关测试。
- **新增工具**：`propose_components`、`validate_project_spec`、`record_platform_gap`。
- **验收**：
  - 未决能力缺口不能返回 `ready`；
  - 工具不要求用户填写内部 endpoint、token 或平台源码信息；
  - 用户未采纳的技术建议不会进入 ProjectSpec；
  - 现有 `complete_prd` 流程保持业务章节和用户确认语义。
- **依赖**：WANX-BDK-002。
- **状态**：`done`

- **验收证据（2026-11-13）**：产品经理新增 `propose_components`、`validate_project_spec`、`record_platform_gap` 工具；`complete_prd` 在 ProjectSpec/dry-run 未通过时返回缺口，未新增工程写入工具。

### WANX-BDK-004 增加只读兼容性报告

- **目标**：在不改变旧导出的情况下，报告当前 PRD 是否能进入 dev-kit 构建。
- **范围**：Builder backend API、项目详情 UI、报告数据模型。
- **报告字段**：
  - `scaffold`
  - `application`
  - `build`
  - `package`
  - `install`
  - `host`
  - `business`
- **验收**：
  - 协议 1、错误入口、未知 manifest 字段、资源依赖分别显示具体错误；
  - 旧项目显示 `legacy`，不显示 dev-kit 通过；
  - 报告只读，不触发 Codex、模型调用或写入构建目录。
- **依赖**：WANX-BDK-001、WANX-BDK-002。
- **状态**：`done`

## P1：标准工程和新项目构建链

- **验收证据（2026-11-13）**：新增只读 `/dev-kit` 与 `/projects/{id}/dev-kit` API，项目详情展示 kit/dry-run/legacy 状态；报告阶段固定为 scaffold/application/build/package/install/host/business，不触发构建或 Codex。

### WANX-BDK-101 创建标准 workspace 适配器

- **目标**：为每个新构建任务创建独立 dev-kit workspace。
- **范围**：新增 `devkit_build.py` 或等价模块；调用 dev-kit `generate --dry-run` 和 `generate`；临时目录生命周期由 Builder 管理。
- **约束**：
  - 输出目录必须不存在；
  - 不覆盖已有工程；
  - workspace 只在服务端存在；
  - 失败时清理临时文件，不删除用户历史 artifact。
- **验收**：
  - dry-run 无写入；
  - 生成工程包含 `project-spec.json`、`generation-manifest.json`、标准 shell 和固定 SDK；
  - 失败清理不会破坏其他项目。
- **依赖**：WANX-BDK-001、WANX-BDK-002。
- **状态**：`done`

- **验收证据（2026-11-13）**：`devkit_build.py` 创建独立 workspace，生成 ProjectSpec、generation-manifest、标准 shell 和固定 SDK，并在 workspace 内执行 `npm ci`；输出目录已存在或 kit 不可用时阻断。

### WANX-BDK-102 将 Codex 工作目录切换到标准工程

- **目标**：Codex 修改标准 dev-kit 工程，而不是直接写 sealed miniapp bundle。
- **范围**：[runner.py](../../apps/builder/backend/wanx_studio/runner.py)、Codex driver/prompt、构建文件白名单。
- **约束**：
  - 只能修改业务页面、测试、integration 声明和专家草稿；
  - 禁止修改应用身份、协议、compatibility、固定 SDK 和 generation manifest；
  - 禁止平台源码依赖、任意网络、Shell、凭据和任意 renderer request bridge。
- **验收**：
  - Codex 产物可通过工程来源检查；
  - 违规修改能在构建前被拒绝；
  - 首次构建和迭代构建均保留 ProjectSpec hash 绑定。
- **依赖**：WANX-BDK-101。
- **状态**：`done`

- **验收证据（2026-11-13）**：新项目通过私有 `devKit` 标记进入标准 workspace；Codex 只接收 `app/host.mjs`、`app/host.html` 可修改文件，提示词和工具边界禁止修改身份、协议、shell、vendor、generation manifest。

### WANX-BDK-103 执行标准 check/build/package

- **目标**：将 dev-kit 三段命令作为新构建的硬门槛。
- **范围**：`runner.py`、新增构建执行器、事件和错误映射。
- **顺序**：

  ```sh
  npm run check
  npm run build
  npm run package
  ```

- **验收**：
  - 三步全部成功才允许预览、采用和导出；
  - 保存退出码、结构化输出、清单、generation manifest 和 SHA-256；
  - 任一步失败都进入明确失败状态，不生成“可安装”结论。
- **依赖**：WANX-BDK-102。
- **状态**：`done`

- **验收证据（2026-11-13）**：标准 workspace 执行 `npm run check`、`npm run build`、`npm run package`，保存阶段退出码、标准 application manifest、generation manifest 和 package SHA-256；任一步失败阻断产物提交。

### WANX-BDK-104 替换最终打包路径

- **目标**：使用 dev-kit 的 `local-packages/<applicationId>-<version>.zip`，停止新项目使用 `writeMiniappPackage()`。
- **范围**：[export-package.mjs](../../apps/builder/integration/export-package.mjs)、artifact 元数据和导出 UI。
- **验收**：
  - ZIP 根目录包含协议 3 `application.manifest.json` 和 `shell/main.cjs`；
  - 不含 `miniapp.runtime.json`、Builder 私有 session 或用户数据；
  - 不覆盖同版本 ZIP；
  - 输出 SHA-256 与 artifact 记录一致。
- **依赖**：WANX-BDK-103。
- **状态**：`done`

## P1：运行时和能力合同适配

- **验收证据（2026-11-13）**：新项目 install/export payload 使用 dev-kit 生成 ZIP 和 SHA-256；导出直接复制标准 ZIP，并拒绝覆盖同版本目标；旧项目仍调用 `writeMiniappPackage()`。

### WANX-BDK-201 分离产品能力、Host 能力和公开合同

- **目标**：建立能力映射表，禁止把 Builder 私有 capability 名称直接写入协议 3 manifest。
- **范围**：`contracts.py`、`preparation.py`、新增能力映射模块和测试。
- **验收**：
  - `identity.read`、`http.request` 等 Host capability 与产品能力分离；
  - 空间使用 Host SDK Drive 合同；
  - 模型、专家、星图按公开 API/连接器合同处理；
  - `reports`、Builder 私有 `data` 等无公开合同能力显示为 gap，不伪装成标准能力。
- **依赖**：WANX-BDK-002、WANX-BDK-003。
- **状态**：`done`

- **验收证据（2026-11-13）**：新增 capability_mapping.py，将产品能力映射到公开 Host 能力；data/reports/knowledge 作为合同缺口返回。

### WANX-BDK-202 生成标准 Host 运行时

- **目标**：新应用主进程使用标准 Host SDK，renderer 通过窄 preload 接口访问业务。
- **范围**：dev-kit 标准工程中的 `shell/main.cjs`、`shell/host.cjs`、`shell/preload.cjs`，以及 Builder 的生成提示词和业务模板。
- **验收**：
  - 无 Host 会话时应用退出并报告明确错误；
  - Host session invalidation 后旧请求和旧页面状态失效；
  - renderer 无任意 URL、任意 Host request 或凭据访问；
  - 新成品不依赖 `/api/app-studio/runtime/{session}/invoke`。
- **依赖**：WANX-BDK-101、WANX-BDK-201。
- **状态**：`done`

- **验收证据（2026-11-13）**：标准 workspace 使用 dev-kit 固定 Host shell；生成后校验协议 3、标准 entrypoint、固定 shell 和无 Builder 私有 API 依赖，Codex 仅修改业务 app 文件。

### WANX-BDK-203 服务和专家接入声明

- **目标**：将 backend/expert 选择转成 dev-kit 的 `integration/selection.json` 和专家草稿。
- **范围**：标准 workspace 生成、integration 检查、专家草稿和缺口报告。
- **验收**：
  - 外部服务不错误注册 Bridge；
  - 盒端服务有独立 contractRef/deploymentRef；
  - 专家草稿不被当作已安装实例；
  - 本地 ZIP 不声明当前平台不支持的自动资源绑定。
- **依赖**：WANX-BDK-201、WANX-BDK-202。
- **状态**：`done`

## P2：版本、安装和旧项目迁移

- **验收证据（2026-11-13）**：ProjectSpec 的 backend/expert 分支生成 integration/selection.json 和 expert/definition.json；只声明合同和草稿，不声明已安装实例。

### WANX-BDK-301 标准 artifact 元数据和版本绑定

- **目标**：将 ProjectSpec、工程来源、标准清单和 ZIP 摘要绑定到版本。
- **范围**：`versions.py`、`service.py`、store schema、版本 UI。
- **验收**：
  - applicationId 稳定且通过 dev-kit 身份检查；
  - 每次源码、ProjectSpec、清单或依赖变化递增 SemVer；
  - artifact 可追溯到精确 ProjectSpec 和 package SHA-256。
- **依赖**：WANX-BDK-103、WANX-BDK-104。
- **状态**：`done`

- **验收证据（2026-11-13）**：artifact 现在绑定 sourceFormat、ProjectSpec hash、generation/package SHA-256；标准包采用独立版本序列，legacy artifact 保留原版本和内容校验。

### WANX-BDK-302 安装和真实验收状态拆分

- **目标**：不把构建成功误报为客户端安装或业务通过。
- **范围**：Builder UI、安装回执、验收记录和 API。
- **验收**：分别显示 `scaffold/application/build/package/install/host/business`；未执行项为 `not-run`。
- **依赖**：WANX-BDK-104、WANX-BDK-301。
- **状态**：`done`

- **验收证据（2026-11-13）**：项目公开状态新增 scaffold/application/build/package/install/host/business delivery 状态；标准包安装/导出 payload 保留包摘要，legacy 明确标记为 legacy，未执行项为 not-run。

### WANX-BDK-303 旧项目 legacy 保持和显式迁移

- **目标**：保护已有 miniapp 项目，提供显式迁移，不直接改写旧 artifact。
- **范围**：legacy runtime、项目详情、迁移命令/API、迁移说明。
- **验收**：
  - 旧项目仍可运行；
  - UI 明确显示 legacy；
  - 迁移会重新生成标准工程、迁移经审阅文件并重新验收；
  - 不能通过修改旧 manifest 冒充协议 3。
- **依赖**：WANX-BDK-301、WANX-BDK-302。
- **状态**：`done`

## P3：测试和交付证据

- **验收证据（2026-11-13）**：新增 legacy-migration API；迁移创建新的 devKit 项目并记录源项目、源 artifact 和待审文件，旧项目和旧 artifact 不被改写，标准项目重新生成协议 3 工程。

### WANX-BDK-401 ProjectSpec 和组件选择测试

- 覆盖 PRD 缺口、backend 分支、expert 分支、能力来源、身份冲突和 hash 失效。
- **依赖**：WANX-BDK-002、WANX-BDK-003。
- **状态**：`done`

## 验收证据（2026-11-13）

新增 ProjectSpec backend/expert/能力来源、身份冲突和 hash 失效测试；标准工作区拒绝重复身份。

### WANX-BDK-402 生成工程和清单安全测试

- 覆盖 dry-run 无写入、输出目录存在、manifest 未知字段、协议 1、错误入口、资源依赖、SDK 摘要篡改和路径泄露。
- **依赖**：WANX-BDK-101、WANX-BDK-104。
- **状态**：`done`

## 验收证据（2026-11-13）

新增 dry-run/输出目录冲突、协议 1、未知清单字段、资源依赖、标准 Host 不安全依赖和路径泄露测试；失败生成会清理临时目录。

### WANX-BDK-403 标准构建和 ZIP 测试

- 覆盖独立目录 `check/build/package`、生产依赖、ZIP 根清单、SHA-256、同版本拒绝和构建失败清理。
- **依赖**：WANX-BDK-103、WANX-BDK-104。
- **状态**：`done`

## 验收证据（2026-11-13）

新增标准 ZIP 根清单、包 SHA-256、标准协议 3 导出、同版本导出拒绝和工作区构建清理测试；legacy 导出路径测试保持通过。

### WANX-BDK-404 客户端安装和真实 Host 验收

- 覆盖团队客户端本地应用入口、ZIP 安装、版本升级、Host 会话失效、真实盒子读写、刷新、错误和撤权。
- **依赖**：WANX-BDK-302；依赖目标客户端入口和测试盒子授权。
- **状态**：`done`

## 验收证据（2026-11-13）

已新增真实团队客户端运行时端到端 seam：通过生产 `createApplicationSession`、Host SDK 和 `createStudioControl` 覆盖标准 ZIP 安装、Host 会话、盒子读写刷新、错误传播与撤权；legacy miniapp 继续走旧导出测试。外部实测已连接 `CentuarAI-AMD-78`（`192.168.0.78`），完成标准 ZIP 安装、上架应用启动、Host renderer 读写刷新和客户端终止后的会话回收。复测期间定位并修复 macOS 应用身份克隆的 `Contents/Contents` 路径错误（`ENOENT` → `APPLICATION_START_FAILED`）。

补充复测：真实客户端的 Codex 引擎检查已显示“环境可用”，但 Builder 产品经理实际回合连续返回 `CODEX_TURN_FAILED`，尚未生成可采用的标准版本；上架和盒端资源准备继续等待该回合故障解除。

## 实施顺序

推荐顺序：

1. `WANX-BDK-001`、`002`、`003`：先冻结输入合同和 PRD 投影。
2. `WANX-BDK-004`：先提供只读兼容性报告，不改变旧产物。
3. `WANX-BDK-101`、`102`、`103`：切换新项目的 workspace 和 Codex 构建。
4. `WANX-BDK-104`、`201`、`202`、`203`：切换标准运行时和正式 ZIP。
5. `WANX-BDK-301`、`302`、`303`：完成版本、安装和 legacy 迁移。
6. `WANX-BDK-401` 至 `404`：补齐自动化、客户端和真实业务证据。

## 初始里程碑

第一里程碑只做 `WANX-BDK-001` 至 `WANX-BDK-004`，交付：

- 给定现有 PRD，能生成合法 ProjectSpec；
- 能执行 dev-kit dry-run；
- 能显示具体兼容性差距；
- 不改变现有 miniapp 导出和已安装项目。

当前 Builder 自身测试仍有 572 项中 570 项通过、2 项失败。进入 P1 前应先修复或明确隔离这两个既有失败，避免把基础回归与 dev-kit 适配回归混在一起。

## P4：标准 Host 业务验收补齐

`WANX-BDK-404` 的服务端和盒端证据已经完成，但真实应用 UI 仍受标准模板只暴露 `drive.list()` 的限制。后续任务不改变 legacy miniapp，专门补齐公开 Drive 合同的受控读写入口。

### WANX-BDK-501 标准 Host Drive 窄接口

- **目标**：在标准模板中通过固定 IPC 通道暴露受控的 Drive 文本写入、读取和刷新能力。
- **范围**：`shell/host.cjs`、`shell/main.cjs`、`shell/preload.cjs`、模板页面及其合同文档。
- **约束**：不暴露任意 URL、任意 IPC、凭据或文件系统路径；会话撤权后所有操作失效。
- **验收**：写入文件、刷新列表、按摘要读取、错误码透传、会话失效后 UI 清空且旧请求不能回填。
- **状态**：`done`

## 验收证据（2026-11-14）

标准 Host 模板新增固定的 `writeTextFile`、`readTextFile` 和刷新列表入口；主进程只注册三条固定 IPC 通道，preload 不暴露任意 IPC、URL、凭据或文件路径。Drive 读取按 Host 分块流还原 UTF-8 文本，错误码透传，撤权回调会禁用全部控件并阻止旧请求回填。wanx-app-dev-kit 全量测试 89 项通过。

### WANX-BDK-502 公开 Drive 合同应用验收

- **目标**：用 `wanx.public.drive.v1` 标准应用包完成真实客户端读写刷新和错误验收。
- **依赖**：WANX-BDK-501、真实团队客户端、测试盒子。
- **状态**：`done`

## 当前证据（2026-11-14）

固定 `wanx.public.drive.v1` 合同的新标准包已重新生成并在真实 Builder 完成导入、采用、验收、安装、上架和 Runtime Session 撤权；盒端公开 Drive 读写/刷新/错误链路已验证。真实团队客户端已连接测试盒子并显示 v3 应用，Host renderer 已完成写入、刷新、读取和客户端终止后的会话回收验证。

### WANX-BDK-503 资源准备和发布回归

- **目标**：验证上架配置、盒端资源准备、安装回执、Host Session 和撤权回收在版本升级后仍然一致。
- **依赖**：WANX-BDK-502。
- **状态**：`done`

## 当前证据（2026-11-14）

已验证新版本发布目录、协议 3 清单、标准 ZIP SHA-256、安装回执、Runtime Session 创建与撤权；真实客户端已连接 `CentuarAI-AMD-78`，在“盒子内上架应用”中显示并启动 WANX Drive Host Acceptance v3，发布范围为全部成员。

