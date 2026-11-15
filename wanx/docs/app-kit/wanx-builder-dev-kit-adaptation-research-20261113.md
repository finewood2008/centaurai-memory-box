# 开物适配 wanx-app-dev-kit 方案研究

日期：2026-11-13

本文只记录基于仓库源码、`wanx-app-dev-kit` 模板和公开合同的适配方案，不代表客户端安装或真实盒子验收已经通过。

## 结论

开物目前有完整的“需求访谈 → PRD → 受控 Codex 构建 → 试用/采用 → 导出”闭环，但生成的是开物私有的 miniapp artifact：源码使用 `miniapp.manifest.json`，运行包使用 `miniapp.runtime.json`，安装清单为协议 1，运行时直接访问 `/api/app-studio`。`wanx-app-dev-kit` 要求的是独立应用工程和协议 3 本地 ZIP，两者不能通过改一个版本号直接兼容。

建议采用“开物继续负责产品和构建编排，dev-kit 成为唯一应用工程/打包合同”的分层方案：

1. PRD 仍保留开物的业务表达和验收章节，但在完成 PRD 时产出一个规范化 `ProjectSpec`。
2. Codex 构建目标从“直接生成 sealed bundle”改为“生成/修改标准 dev-kit 应用工程”。
3. 开物只保存源码快照、构建清单和业务 artifact 元数据；最终 ZIP 使用 dev-kit 的 `check/build/package` 规则生成。
4. 开物内置能力通过 Host SDK 与公开合同调用；开物专用 `/api/app-studio` 只保留为工作台管理面和短期构建控制面。

## 一手合同对照

### 开物当前合同

- 产品状态、PRD 和版本状态保存在 Builder backend 的 project store；PRD 章节包括场景、功能、页面、数据字段、规则、异常、测试、非范围和待讨论问题。[prd.py](../../apps/builder/backend/wanx_studio/prd.py)
- 构建器要求源码入口 `src/app.js` 导出 `mount(root, api)`，源码只能位于 `miniapp.manifest.json` 和 `src/**`，并限制能力为 `data/model/files/knowledge/reports/foundation/dialogue`。[artifact.mjs](../../apps/builder/core/artifact.mjs)、[contracts.py](../../apps/builder/backend/wanx_studio/contracts.py)
- 构建产物由源码编译成 IIFE bundle 和 CSS；安装接口返回 `applicationId/version/artifactHash/manifest/bundle/css`。[service.py](../../apps/builder/backend/wanx_studio/service.py)
- 导出包由 `writeMiniappPackage()` 生成，清单为 `protocolVersion: 1`、入口 `runtime-main.cjs`，并额外写入 `installationSource: "selfmade"`。[package.mjs](../../apps/builder/core/package.mjs)
- 导出流程使用系统 `/usr/bin/zip`，导出前后各读取一次安装 payload，以防用户在保存对话框期间 artifact 变化。[export-package.mjs](../../apps/builder/integration/export-package.mjs)

### dev-kit 当前合同

- 开发输入是 `ProjectSpec v1`：`schemaVersion/slug/applicationId/backend/expert/capabilities`；backend、expert 和能力来源均为无凭据逻辑引用。[project.schema.json](../../../wanx-app-dev-kit/contracts/app-builder/project.schema.json)
- 生成器生成独立工程，并写入 `generation-manifest.json`、固定 SDK tarball、标准 shell、应用清单和可选 `integration/`、`expert/` 草稿。[scaffold.mjs](../../../wanx-app-dev-kit/tools/app-builder/scaffold.mjs)
- 本地应用清单必须是协议 3，入口固定为 `shell/main.cjs`，必须有完整 `compatibility`，不能设置 `releaseAccess`，不能声明当前本地路径不支持的资源依赖。[application-manifest.mjs](../../../wanx-app-dev-kit/templates/standard-host-app/tools/application-manifest.mjs)
- 本地包应由应用目录中的 `npm run check`、`npm run build`、`npm run package` 产生，ZIP 根目录保留清单、入口和生产依赖，并记录 SHA-256；安装、Host 和业务验收分别记录。[acceptance.md](../../../wanx-app-dev-kit/skills/wanx-app-development/references/acceptance.md)、[local-delivery.md](../../../wanx-app-dev-kit/skills/wanx-app-development/references/local-delivery.md)
- 应用运行时由标准 Host SDK 建立当前会话，renderer 通过窄 preload 接口访问能力；不能依赖平台源码、伪造 Host、提供独立浏览器预览。[app-kit.md](../../../wanx-app-dev-kit/skills/wanx-app-development/references/app-kit.md)

## 差距矩阵

| 领域 | 开物现在 | dev-kit 要求 | 适配动作 |
| --- | --- | --- | --- |
| 输入模型 | Builder 内部 `solution` + PRD | `ProjectSpec v1` | 增加规范化 ProjectSpec 生成、校验和哈希 |
| PRD 到实现 | Codex 直接生成受限 miniapp 源码 | 先生成标准应用工程，再实现业务 | 将构建 workspace 改成 dev-kit 工程目录 |
| 应用清单 | 协议 1、`runtime-main.cjs`、无 compatibility | 协议 3、`shell/main.cjs`、compatibility | 采用 dev-kit 清单生成器，禁止手写旧清单 |
| 能力声明 | `data/model/files/...` 是 Builder runtime 方法名 | Host 能力是 `identity.read/http.request/...`，业务 API 依据公开合同 | 分离“产品能力”和“Host 能力”，生成 capability mapping |
| 运行地址 | `/api/app-studio` 私有 runtime session | Host SDK + 公开 API/合同 | 应用主进程只调用 Host SDK；Builder 管理接口不作为应用 API |
| 工程来源 | 服务器保存 files/bundle/css | 工程有 ProjectSpec、generation manifest、源码和依赖 | 保存标准工程快照及来源摘要 |
| 打包 | 系统 zip，sealed bundle | 标准 `package.mjs`、独立依赖、构建库存检查 | 复用/同步 dev-kit package 工具，不再使用 `writeMiniappPackage` |
| 安装验证 | Builder 自己提交 installed receipt | 客户端本地应用安装 + Host 业务验收 | 增加 dev-kit 安装路径和独立证据状态 |
| 服务接入 | `foundation/reports` 等 Builder 私有适配 | `backend none/existing/custom`，盒端服务需 Bridge | PRD 中增加 backend/component decision，并生成 integration 记录 |
| 专家依赖 | Builder 的 capability/knowledge 检查 | `expert.enabled` 与公开 Agent/专家合同；本地 ZIP 不自动绑定资源 | 只生成草稿和引用，不把“检查通过”写成已绑定 |

## 目标架构

### 1. 三个边界

**产品边界**：开物管理需求、访谈、PRD、用户确认、缺口决策和版本关系。它可以继续使用现有 `/api/app-studio/projects/*`。

**开发边界**：标准工程目录由 dev-kit 规则管理。Builder backend 负责创建临时 workspace、写入 `project-spec.json`、调用 dev-kit 校验/构建命令、收集输出和事件，不再把 bundle 作为唯一真相。

**运行边界**：成品应用只依赖 `@centaurai/wanx-host-sdk` 和公开合同。Builder runtime 可以继续用于开物自身，但不得被成品应用隐式依赖。

### 2. 建议的数据对象

在现有 project 中增加以下稳定字段：

```json
{
  "devKit": {
    "version": "0.3.0",
    "projectSpec": {},
    "projectSpecHash": "sha256",
    "generationManifest": {},
    "workspacePath": "server-side-only",
    "applicationManifest": {},
    "build": {
      "status": "not-run|passed|failed",
      "packagePath": "server-side-only",
      "sha256": "..."
    }
  }
}
```

路径只用于服务端临时 workspace，不返回给模型、renderer 或交付报告。artifact 仍保留 `solutionHash/taskId/version`，但新增 `projectSpecHash` 和 `packageSha256` 作为安装与回滚的身份依据。

## PRD 生成阶段的调整

### 1. 保留现有业务章节，新增“实现选择”投影

现有 PRD 已经覆盖用户验收所需的大部分信息，不应改成技术问卷。完成 PRD 时由服务端根据业务内容生成一个独立的实现投影：

- `backend`: `none`、`existing` 或 `custom`；如果是 `custom + box`，必须有 `contractRef` 和 `deploymentRef`。
- `expert`: 默认 `enabled: false`；只有需要新专家指令/Skill/工具组合时才为 true。
- `capabilities`: 每个能力有 `id` 和 `sourceRef`，来源只说明合同，不代表授权已完成。
- `collections`: 从 `dataFields` 归一化为小写集合名和字段类型，供应用工程和运行时 schema 使用。
- `hostCapabilities`: 由实现映射产生，例如 `identity.read`、`http.request`，不直接把 Builder 的 `data/model/files` 当作 Host 清单 capability。

### 2. 产品经理工具增加 dev-kit 合同工具

建议在 [interview-tools.mjs](../../apps/builder/codex/interview-tools.mjs) 增加：

- `propose_components`: 从 PRD 推导 backend/expert/capabilities，说明业务理由和合同来源。
- `validate_project_spec`: 只读校验 ProjectSpec，返回结构错误、身份冲突和未确认的组件选择。
- `record_platform_gap`: 记录公开合同缺口，不把缺口自动变成实现承诺。
- `complete_prd`: 只有 PRD 完整、组件选择明确、数据结构准备好且缺口有用户决定时才返回 ready。

工具输出不得要求用户填写 URL、token、box ID 或内部 endpoint；这些属于连接或授权阶段。

### 3. 确认门槛

用户确认 PRD 时，同时冻结：

1. PRD hash；
2. ProjectSpec hash；
3. dev-kit 版本和 SDK tarball 摘要；
4. capability/component 决策；
5. 公开合同缺口及用户选择（manual/defer/block）。

任何 PRD、能力、连接或 dev-kit 版本变化，都必须使旧确认失效，不能直接启动旧构建。

## 构建阶段的调整

### 阶段 A：建立标准 workspace

Builder 为每个任务创建全新临时目录，执行等价流程：

```sh
npm run generate -- --spec project-spec.json --out <workspace> --dry-run
npm run generate -- --spec project-spec.json --out <workspace>
cd <workspace>
npm ci --ignore-scripts
npm run check
```

已有应用迭代不能重新覆盖整个工程。第一次构建使用生成器；后续构建复用该 workspace 的工程身份，并只迁移/修改允许的业务文件。

### 阶段 B：Codex 生成业务实现

Codex 的工作目录是标准工程目录，约束改为：

- 只能修改业务源码、测试、integration 声明和专家草稿；不能修改 `application.manifest.json` 的身份、协议和 compatibility；
- 不引入平台源码路径、内部模块、任意网络、Shell 或凭据；
- 使用 `@centaurai/wanx-host-sdk`，主进程调用 SDK，renderer 通过窄 preload；
- 业务服务按 `integration/selection.json` 实现，外部服务不注册 Bridge，盒端服务按 Bridge 合同单独开发；
- 专家草稿不等于自动绑定，不能写入当前本地 ZIP 不支持的 `resourceDependencies`。

### 阶段 C：标准构建和打包

Codex 完成后按顺序执行：

```sh
npm run check
npm run build
npm run package
```

Builder 采集：`check`、`build`、`package` 的退出码和结构化输出；读取清单、generation manifest、ZIP SHA-256 和文件清单；将这些写入 artifact 元数据。只有三步都通过，才允许进入试用/采用。

`package` 应由 dev-kit 的标准工具生成 ZIP，而不是 [export-package.mjs](../../apps/builder/integration/export-package.mjs) 当前的系统 `zip` + `writeMiniappPackage()` 路径。

## 运行时和服务适配

### Host SDK 适配层

建议新增 `apps/builder/integration/dev-kit-runtime/`，职责是：

- 从标准应用的主进程调用 `fromEnvironment()`、`context()`、`drive` 或公开 API；
- 给 renderer 暴露业务窄接口；
- 统一处理 session invalidation、超时、错误 envelope 和重试；
- 将 Builder 的产品能力映射到公开合同，而不是将 `/api/app-studio/runtime/{session}/invoke` 暴露给成品应用。

现有 `apps/builder/shell/runtime-main.cjs` 可以保留为旧 artifact 的兼容运行时，但新标准产物应生成 `shell/main.cjs`。旧应用不能在升级时隐式转换，必须保留旧安装路径或执行一次显式迁移。

### 能力映射

| PRD/产品能力 | 标准应用实现 |
| --- | --- |
| 当前用户身份 | `identity.read` / Host Context |
| 空间文件 | `host.drive`，按公开 Drive 合同 |
| 模型/对话/专家 | Host `request` / `requestExpert`，按对应合同和权限 |
| 外部服务 | 应用自己的 service client；凭据不进入 ProjectSpec |
| 盒端独立服务 | 独立服务 + Bridge 注册 + `/api/services/<serviceId>/v1` |
| Builder 私有 `data` | 迁移为应用自己的数据合同或独立服务，不能假设 dev-kit 自动提供同名接口 |
| Builder `reports` | 需要公开合同；若无合同必须在 PRD 中记录 capability gap，不得伪装成标准 Host 能力 |

## 版本、安装和验收

### 版本关系

- `applicationId` 永久稳定；首次生成使用独立反向域名标识，不能使用 `ai.wanx.selfmade.*` 作为长期兼容方案，除非它被正式纳入 dev-kit 保留身份合同。
- 每次源码、ProjectSpec、清单或依赖变化递增 SemVer。
- dev-kit 版本变化时不能只改 Builder 的 `package.json`；要重新生成/迁移工程并保存新的 SDK 摘要。

### 安装状态拆分

Builder UI 应分别展示：

1. `scaffold`: ProjectSpec/generation manifest 结构通过；
2. `application`: 应用源码和配置 check 通过；
3. `build`: dist 构建通过；
4. `package`: ZIP 和 SHA-256 生成；
5. `install`: 客户端选择 ZIP 并确认安装；
6. `host`: 真实 Host 会话启动；
7. `business`: 真实盒子上的读/写/刷新/错误行为通过。

前四项不能推导出后三项。dev-kit 的验收合同明确要求把未执行项目标为 not-run。

### 真实安装验收

必须在团队客户端执行“应用 → 本地应用 → 安装本地应用”，再连接目标盒子验证业务。至少留存：应用版本、ZIP SHA-256、客户端/盒端版本、具体读写操作、回执与回读结果。若目标客户端没有入口或资源授权合同未开放，保留源码和 ZIP，并将对应项标为阻塞。

## 迁移策略

建议分三期，避免一次性破坏现有开物项目：

### 第一期：合同层和只读报告

- 在 Builder 中引入 dev-kit 版本、ProjectSpec schema、manifest validator 和 package validator。
- 对现有 PRD 生成 ProjectSpec dry-run 报告，不改变旧导出。
- 增加“标准应用兼容性”状态页，明确列出 protocol、entrypoint、compatibility、backend/expert/capability 差异。

### 第二期：新项目走标准工程

- 新建项目默认走 dev-kit scaffold workspace。
- Codex 只修改标准工程。
- `check/build/package` 成功后才允许采用。
- 旧项目继续使用 legacy artifact runtime，但不能声明已符合 dev-kit。

### 第三期：迭代、团队发布和旧项目迁移

- 迭代任务基于标准工程和 generation manifest 做差异检查。
- 团队发布、安装回执和更新检查统一使用协议 3 manifest。
- 提供显式“迁移为标准应用”操作：重新生成工程、迁移经过审阅的业务文件和测试、重新验收；不直接改写旧 artifact 的 manifest 以绕过校验。

## 验收用例

最小可交付验证集：

1. PRD 完整但 capability gap 未决：不能生成 ProjectSpec ready。
2. ProjectSpec dry-run：无写入；重复 slug/applicationId 被拒绝。
3. 标准工程生成：`generation-manifest` 与 SDK 0.3.0 摘要一致。
4. Codex 修改：不能修改应用身份、协议、compatibility 或引入平台内部 import。
5. manifest validator：协议 1、错误入口、未知字段、资源依赖均拒绝。
6. `check/build/package`：独立目录成功，ZIP 含标准入口和生产依赖，输出 SHA-256。
7. 客户端安装：选择 ZIP、确认安装、打开应用；版本升级拒绝同版本/降级。
8. 真实业务：在目标盒子上验证读取、写入、刷新、错误和权限撤销；记录回执与回读。
9. 旧项目：仍可用 legacy runtime，且 UI/报告明确标注 legacy，不误报 dev-kit 通过。

## 主要风险

- Builder 现有 `data/model/files/knowledge/reports` 运行时与 dev-kit 公开 Host 能力不是一一对应；必须先确认每个业务能力的公开合同，不能做名称替换。
- `reports`、应用级数据隔离和团队发布若没有公开合同，适配只能记录为缺口，不能把 Builder 私有 API 暴露为标准应用能力。
- 直接把 sealed bundle 塞进标准 ZIP 会绕过 dev-kit 的工程来源和依赖检查，因此不建议只改 `application.manifest.json`。
- dev-kit 当前本地 ZIP 不支持自动准备专家/技能包资源；PRD 可以生成专家草稿，但交付报告必须区分“草稿存在”和“资源已绑定”。
- 真实客户端 GUI、盒子、授权和 Bridge 状态必须独立验收；Builder 自己的单元测试不能替代这些证据。

