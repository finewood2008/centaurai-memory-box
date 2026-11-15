# WANX Bridge 与 `huohua-boxd` 联调合同

本文是万象工程侧的可执行合同，配套方案总览和
[`huohua-service-plan-wanx.md`](./huohua-service-plan-wanx.md)。它只描述
Bridge 的接入边界，不改变火花工程的启动、数据或发布流程。

## 固定边界

| 字段 | 合同值 |
|---|---|
| serviceId | `huohua.workbench` |
| Bridge protocol | `1` |
| service token audience | `wanx-bridge` |
| boxd upstream | `http://127.0.0.1:8093` |
| 用户路由 | `/api/huohua/v1` |
| capability ingress | `POST /api/bridge/v1/capabilities/{capability}` |
| WebSocket | 不新增火花专用转发；现有 Agent chat WS 保持原合同；浏览器复用 `/api/browser-stream/ws` |

Bridge 只从 `WANX_BRIDGE_SERVICE_REGISTRY_FILE` 读取受控注册表。注册表必须是
当前 Bridge 用户所有、权限不超过 `0600` 的 JSON 文件；upstream、路由前缀、健康
检查路径和服务公钥都在启动时校验。未配置或未启用记录时，状态为
`not_installed`，WANX 其他路由不受影响。

## 身份委托

1. boxd 使用安装时生成的 Ed25519 私钥，对固定的
   `serviceId/protocolVersion/nonce` 证明签名。
2. Bridge 在 `/api/bridge/v1/services/huohua.workbench/session` 验签并签发
   5 分钟以内的 Bridge JWT。重放 nonce 会被拒绝；token 必须包含 `aud`、
   `serviceId`、`boxId`、`protocolVersion`、`scope` 和时间声明。
3. 客户端使用现有 Host session 调用 `/api/huohua/v1`。Bridge 从已认证的
   WANX session 生成带 `userId`/`spaceId` 的委托 token 发给 boxd，客户端的
   Authorization、Cookie 和 `x-wanx-*` 身份头不会转发到 boxd。
4. boxd 使用委托 token 调用 capability ingress。Bridge 根据固定 capability
   路径和 scope 调用 Octop 公共 HTTP API；不接受任意 host、upstream、provider
   凭据或用户身份覆盖。

### 任务级授权

长任务不能持有并无限期复用用户委托 token。boxd 以委托 token 创建任务租约：

```text
POST /api/bridge/v1/services/huohua.workbench/tasks
POST /api/bridge/v1/services/huohua.workbench/tasks/{taskId}/renew
POST /api/bridge/v1/services/huohua.workbench/tasks/{taskId}/revoke
DELETE /api/bridge/v1/services/huohua.workbench/tasks/{taskId}
```

创建响应包含短期 `access_token` 和仅用于续期/撤销的 `renewal_token`。access token
默认有效 5 分钟，单次续期最长 5 分钟，任务总生命周期最长 1 小时；续期会轮换
access token、renewal token 和 `jti`，旧 token 立即失效。撤销会删除 Bridge 内存中
绑定的上游凭据，之后浏览器、模型和空间 capability 都返回 `TASK_REVOKED`。
Bridge 重启会使未持久化的任务租约失效，boxd 必须重新建立用户委托和任务。

## capability allowlist

| capability | 固定路径 | 方法/权限 |
|---|---|---|
| `dialogue.models` | `/api/dialogue/models` | `GET`, `workbench:read` |
| `providers.resolved` | `/api/providers/resolved` | `GET`, `workbench:read` |
| `providers.active-model` | `/api/providers/active-model` | `GET`, `workbench:read` |
| `dialogue.sessions` | `/api/dialogue/sessions/**` | 读请求 `workbench:read`，写请求 `workbench:write` |
| `agents` | `/api/agents/**` | 读请求 `workbench:read`，写请求 `workbench:write`；拒绝 `/chat/ws` |
| `personal-space.overview` | `/api/personal-space/overview` | `GET`, `workbench:read` |
| `personal-space.files` | `/api/personal-space/files/**` | 读请求 `workbench:read`，写请求 `workbench:write` |
| `personal-space.folders` | `/api/personal-space/folders/**` | `workbench:write` |
| `personal-space.uploads` | `/api/personal-space/uploads` | `POST`, `workbench:write` |
| `personal-space.trash` | `/api/personal-space/trash/**` | `workbench:write` |
| `browser.env` | `/api/browser/env-status` | `GET`, `workbench:browser` |
| `browser.sessions` | `/api/browser/harness-sessions` | `GET`, `workbench:browser` |
| `browser.control` | `/api/browser/control-capabilities` | `GET`, `workbench:browser` |
| `browser.handoff` | `/api/browser/sessions/{sessionId}/handoff` | `POST`, `workbench:browser` |
| `browser.shutdown` | `/api/browser/shutdown` | `POST`, `workbench:browser` |
| `browser.model-access` | `/api/browser/model-access` | `POST`, `workbench:browser` |
| `browser.install` | `/api/browser/install` | `POST`/SSE, `workbench:browser` |
| `browser.record` | `/api/browser/record-replay/**` | `GET`/`POST`, `workbench:browser` |
| `browser.learning` | `/api/browser/learning/**` | `GET`/`POST`, `workbench:browser` |
| `browser.uninstall` | `/api/browser/uninstall` | `POST`/SSE, `workbench:browser` |

请求体和查询只允许合同字段；嵌套的 provider token、API key、Cookie、upstream
地址、服务凭据和不同的 user/space/owner 会被拒绝。HTTP 与 `text/event-stream`
响应都经过 Bridge 转发，单次请求体上限为 2 MiB。

浏览器控制 WebSocket 复用现有 WANX `/api/browser-stream/ws`，只接受带
`workbench:browser` 的委托或任务 token，并把 Bridge 绑定的 WANX upstream token
注入到 Octop；不允许 boxd 自己提交 Octop 用户 Cookie、Authorization 或第三方
凭据。验证码和第三方登录仍由浏览器会话及现有人工介入流程完成，不能由火花伪造。

## 状态和版本门禁

Bridge 的状态接口为
`GET /api/bridge/v1/services/huohua.workbench/status`，需要现有 Host session，
只返回状态、版本和错误码：

| 状态 | 含义 | Bridge 行为 |
|---|---|---|
| `not_installed` | 没有启用注册记录 | 404 `SERVICE_NOT_INSTALLED` |
| `starting` | 回环服务或 readiness 尚未就绪 | 503 `SERVICE_STARTING` |
| `ready` | liveness、readiness、协议和最低 WANX 版本通过 | 允许代理 |
| `degraded` | 健康检查返回非致命错误 | 503 `SERVICE_DEGRADED` |
| `incompatible` | 协议或最低 WANX 版本不匹配 | 409 `SERVICE_INCOMPATIBLE` |
| `failed` | 服务健康检查返回致命错误 | 503 `SERVICE_UNAVAILABLE` |

当前注册表 schema 和协议版本都是 `1`。`minWanxVersion` 采用 `>=x.y.z` 形式；
服务 `/version` 返回的 `protocolVersion` 必须与注册记录一致。

## 测试盒 smoke test

在 Bridge 所在盒端设置：

```sh
export WANX_BRIDGE_SERVICE_REGISTRY_FILE=/data/wanx-bridge/services.json
```

注册表样例见 [`server/bridge/deploy/huohua-services.example.json`](../../../server/bridge/deploy/huohua-services.example.json)。
Bridge 重启后配置生效；Bridge 不会扫描网络或自动启动 boxd。可用现有 WANX
Host session 检查状态：

```sh
curl --fail \
  -H "Authorization: Bearer <host-session>" \
  http://127.0.0.1:<bridge-port>/api/bridge/v1/services/huohua.workbench/status
```

服务包应只监听 `127.0.0.1:8093`，并独立返回 `/healthz`、`/readyz`、`/version`。
Bridge 测试覆盖签名、重放、过期、scope、路径、HTTP/SSE、错误隔离和 Host 凭据
不外泄：

```sh
npm run test:bridge
```
