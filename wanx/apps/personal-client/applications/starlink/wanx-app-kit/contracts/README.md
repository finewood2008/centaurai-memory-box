# WANX App Kit 合同目录

本目录是应用开发方可依赖的万象公共合同。应用只读取本目录和 `@centaurai/wanx-host-sdk`，不读取 WANX/Octop 源码。

## 接入指南

| API | SDK 入口 | 文档 |
| --- | --- | --- |
| 万象 Octop | `host.request`、`host.openStream`、`host.requestExpert` | [Octop API](octop-api.md) |
| 空间 Drive | `host.drive` | [Drive API](drive-api.md) |
| 星图 | `host.request` 与 `X-Xingtu-Key` | [星图 API](starlink-api.md) |
| 已部署专家应用 | `host.request`，合同 `wanx.expert-app.v1@1.0.0` | [专家应用 API](expert-app-api.md) |

## 合同文件

- [万象 Octop 模块索引](octop-modules/index.json)列出各模块及文件路径。每份模块 OpenAPI 包含自己的请求、响应与 Schema，可单独加载。WebSocket、MCP 和隐藏路由记录在对应模块的 `x-wanx-supplemental-routes`。
- 常用模块可直接打开 [Agent](octop-modules/agents.openapi.json)、[Channel](octop-modules/channels.openapi.json)、[多模型对话](octop-modules/dialogue.openapi.json)、[记忆](octop-modules/memory.openapi.json)、[空间 Drive](octop-modules/personal-space.openapi.json)和[星图](octop-modules/starlink.openapi.json)。应用可用能力见模块操作的 `x-wanx-permission`、`x-wanx-status` 和 [权限合同](permissions.v1.json)。
- 同一路由的原生参数和响应在 OpenAPI 操作中，应用合同在该操作的 `x-wanx-application-contract` 中。星图开放接口在星图模块中按具体路径定义。
- `api-catalog.v1.json`：模型、Agent/Thread、专家、对话、记忆、知识和星图能力目录；记录每个入口的状态、请求/响应 Schema、权限和禁止范围。
- `permissions.v1.json`：应用权限模型、资源范围和永不授予应用的权限。
- `errors.v1.json`：稳定错误代码、HTTP 映射、可重试性和处理建议。
- `types.d.ts`：应用侧 TypeScript 类型。
- `schemas/`：请求、响应、事件和配置的 JSON Schema。
- `contract-status.v1.json`：合同完成状态与正式开放前的真实盒子验收门槛。

`ready-for-acceptance` 表示公共请求/响应、错误、权限和兼容规则已经写入 Kit，但尚未完成真实盒子验收和版本登记。应用开发方可以据此开发适配层和 Mock；只有状态为 `open` 的能力才能作为生产开放能力依赖。

当前已补齐合同的业务面：

- 当前账号的对话模型目录，入口为 `GET /api/dialogue/models`。
- Agent/Thread、WebSocket 对话流和 HITL 恢复。
- 多模型对话会话、配额、分支、重试、停止和可重连快照流。
- 专家模板读取、从专家创建 Agent、Agent 启停。
- Agent 记忆查询、来源、统计、终端摘要、明确的记忆写入和提炼配置。

星图开放 API 使用数据仓 Key 提供受保护的只读资料。Octop 知识库检索仍为 `contract-only`，缺口见能力目录。应用使用 [权限模型](permissions.v1.json) 中列出的能力。

用户、账号认证和 Model Provider 路由属于万象管理接口。应用通过 Host Context 获取当前会话身份，通过对话模型目录获取可选模型。

记忆 API 的返回内容可能包含用户个人信息。应用必须只在用户明确授权的当前 Agent 范围内展示或持久化，不得把 raw events 上传到第三方服务或跨 Agent 合并。

## 版本与 Schema 标识

同一条 App Kit 发布线使用同一个语义版本：当前 SDK、合同包和 Kit 核心版本均为 `0.3.0`。`workspace`、`local-bundle`、`released` 记录在清单的 `distribution` 字段。输出目录与 SDK 版本一致，例如 `0.3.0`。

Schema 的 `$id` 是合同对象的稳定身份，不是 API endpoint，也不是可请求的 URL。`api-catalog.v1.json` 的 `requestSchema`/`responseSchema` 和模块 OpenAPI 的 `$ref` 建立 endpoint 与 Schema 的映射。例如：

- `POST /api/dialogue/sessions` → `dialogue-question.v1.schema.json`（请求）和 `dialogue-session.v1.schema.json`（响应）。
- `/api/dialogue/sessions/{session_id}/events` → `dialogue-event.v1.schema.json`（SSE 快照事件）。

同一个 Schema 可以被多个 endpoint 复用；endpoint 可以在兼容版本中调整路径，而 Schema `$id` 只在字段语义发生不兼容变化时升主版本。当前 `wanx-<domain>-<resource>/1` 的 `wanx-` 是 WANX 合同命名空间前缀，不表示 URL 前缀。
