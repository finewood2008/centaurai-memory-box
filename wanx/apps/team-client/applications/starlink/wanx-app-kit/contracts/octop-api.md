# 万象 Octop API

完整服务端入口及各模块文件路径见 [万象 Octop 模块索引](octop-modules/index.json)。各模块 OpenAPI 可单独加载。应用接入所需的接口和权限见下文。

应用通过 Electron 主进程的 `@centaurai/wanx-host-sdk` 使用当前万象账号所连接盒子的 Octop API。SDK 从启动环境读取 Host 会话，Host 负责盒端鉴权。将应用需要的结果通过业务 IPC 返回 renderer。

以下示例可在 Electron 主进程的 ESM 模块（`.mjs`）中使用。

```js
import {fromEnvironment} from '@centaurai/wanx-host-sdk';

const host = fromEnvironment();
if (!host) throw new Error('请从万象打开应用');

host.onSessionInvalidated(() => {
  // 清理当前账号和盒子的应用内缓存，结束对话并提示用户重新打开应用。
});
await host.context();

const response = await host.request('/api/agents?scope=mine');
if (!response.ok) throw new Error(`读取 Agent 失败（HTTP ${response.status}）`);
const agents = await response.json();
```

| 能力 | 主要入口 | SDK |
| --- | --- | --- |
| Agent 与 Thread | `GET /api/agents?scope=mine`、`GET/POST /api/agents/{agent_id}/threads`、`GET /api/agents/{agent_id}/threads/{thread_id}/history` | `host.request` |
| Agent 渠道摘要 | `GET /api/agents/{agent_id}/status` 返回 `channels`，每项包含 `id`、`kind`、`name` | `host.request` |
| 对话事件与人工审批 | `/api/agents/{agent_id}/chat/ws`、`POST /api/agents/{agent_id}/chat/hitl/resume` | `host.openStream`、`host.request` |
| 专家与 Agent 生命周期 | `GET /api/experts`、`POST /api/agents/from-expert/{expert_id}`、`POST /api/agents/{agent_id}/start` 或 `/stop` | `host.request` |
| 模型与多模型对话 | `GET /api/dialogue/models`、`POST /api/dialogue/sessions`、`GET /api/dialogue/sessions/{session_id}/events`（SSE） | `host.request` |
| Agent 记忆 | `/api/agents/{agent_id}/memory/…` | `host.request` |

请求参数和响应见各模块的 OpenAPI。应用合同记录在操作的 `x-wanx-application-contract` 中，权限和验收状态也可在操作上直接查看。类型与能力另见 [类型声明](types.d.ts) 和 [API 目录](api-catalog.v1.json)。各能力的发布验收状态见 [合同状态](contract-status.v1.json)。当前模型、Agent/Thread、专家、多模型对话和记忆均已提供开发合同，发布验收状态为 `ready-for-acceptance`。Octop 知识库检索的合同缺口另见 API 目录。

Octop 服务的完整路由包含账号、用户和 Provider 管理，App Kit 仅列应用可依赖的接口。用户、角色、邀请、账号认证和 Provider 的读取、配置、凭据及测试由万象管理。应用使用 `(await host.context()).user.id` 识别当前用户，从 `GET /api/dialogue/models` 获取当前账号可用于对话的模型。

Octop 还提供专用 Channel 路由。具备渠道权限的客户端通过 `GET /api/agents/{agent_id}/channels` 读取渠道列表及运行状态。渠道详情、创建、修改、删除、测试和扫码绑定可能读取或处理第三方凭据。这些专用路由属于渠道管理，应用读取所拥有 Agent 的渠道摘要时使用上表的 `/status`。渠道摘要的发布验收状态随 Agent 状态接口。

应用若声明了 v3 专家资源依赖，用 `host.resolveResourceBinding('expert', resourceId)` 获取 Host 验证的绑定，或用 `host.requestExpert(resourceId, '/threads')` 发起绑定请求。按 [权限合同](permissions.v1.json) 使用当前用户和应用可访问的资源。

`host.request` 返回标准 `Response`，业务端 HTTP 失败需要检查 `response.ok`。网关错误通过 `Error.code` 抛出。遇到 `HOST_SESSION_EXPIRED`，清理会话并从万象重新打开应用。遇到 `NETWORK_NOT_READY`，等连接恢复后由业务判断是否重试。写请求按各操作的幂等规则处理。退出时调用 `host.close()`。
