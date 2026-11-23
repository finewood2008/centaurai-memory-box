# 已部署专家应用 API

合同 `wanx.expert-app.v1@1.0.0`，features 为 `context`、`expert`、`data`。状态为 `ready-for-acceptance`；盒端真实验收通过后才能登记为正式开放能力。此合同使用固定 HTTP 路由，不依赖开物生成器、项目、运行时 token 或私有桥接接口。

标准应用使用 protocolVersion 3，capabilities 为 `identity.read`、`http.request`，兼容声明为：

```json
{
  "backendProductId": "wanx",
  "backendContracts": [{
    "id": "wanx.expert-app.v1",
    "range": ">=1.0.0 <2.0.0",
    "features": ["context", "expert", "data"]
  }],
  "resourceDependencies": []
}
```

应用通过 Host SDK 的 `host.request` 发送下面两种请求。Host 必须将已验证的受管应用槽位作为请求 audience；后端从当前可信身份、盒子和部署绑定中选择专家及数据范围。请求体、query 或 header 不接受 owner、环境、槽位、agent、服务 URL 或凭据。普通应用、万象 Host、开物管理应用不能使用本合同。没有 HEAD、WebSocket、query 或其他版本的别名。

原生可信通道和已有 SSO 通道均由万象主进程托管应用启动身份。业务应用只调用公开合同，无需获取、保存或传递启动凭据。启用本地强制授权时，SSO 通道不能替代原生授权。

| 方法 | 路由 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/wanx-expert-app/v1/context` | 无 query、无 body | [context schema](schemas/expert-app-context.v1.schema.json) |
| POST | `/api/wanx-expert-app/v1/invoke` | [invoke schema](schemas/expert-app-invoke.v1.schema.json)，精确 `{operation,input}` | [result schema](schemas/expert-app-result.v1.schema.json) |

context 返回应用 base ID、实际 slot ID、盒子、环境、generation、部署 operationId、artifactHash 和标准安装包 packageSha256，以及 backend 兼容合同摘要。`scopeId` 是不可解释的当前执行范围标识；应用不得推导其内容。所有摘要均为 64 位小写十六进制，不带 `sha256:` 前缀。应用每次打开时先读取 context；服务端将该次 Host 启动绑定至此部署代际。后续代际变化返回 `UPDATE_REQUIRED`，必须从万象重新打开应用；应用不能提交或修改启动身份。

| operation | input | 响应 |
| --- | --- | --- |
| `expert.run` | `{operationId,text}`：operationId 为 32 位小写 hex；text 为 1—12000 字的非空白内容 | `{run}` |
| `expert.tasks` | `{}` 或 `{runId}` | `{items,context:{scopeId}}` 或 `{run,context:{scopeId}}` |
| `expert.cancel` | `{runId}` | `{run}` |
| `data.list` | `{collection:"state",offset?,limit?}`；offset 为非负安全整数，limit 为 1—200，默认 100 | `{items,total}` |
| `data.get` | `{collection:"state",id}` | record 或 `null` |
| `data.put` | `{collection:"state",id,value:{json:string},expectedRevision?}` | record |
| `data.delete` | `{collection:"state",id,expectedRevision?}` | `{deleted:true}` |

所有对象拒绝未知字段。record 为 `{json,_id,_revision}`；id 长度 1—128，revision 为非负安全整数。写入和删除默认 expectedRevision 为 0；现存记录必须提供读取到的 revision，否则返回 `RECORD_CHANGED`。value 的 JSON 编码整体不超过 262144 字节。数据按已验证用户、应用和部署环境隔离；请求不能指定其他 collection 或范围。

run 包含 `id,state,text,result,errorCode,createdAt,updatedAt`；时间戳以秒计。state 为 `queued`、`running`、`cancel_requested`、`succeeded`、`failed`、`cancelled` 或 `interrupted`。result、errorCode 可为 null。取消是请求，客户端必须展示返回的实际状态；`cancel_requested` 不代表已取消。

提交前，客户端先持久化 `{scopeId,operationId,text}`，再执行 `expert.run`。结果不确定时沿用同一 operationId 查询或重试，不能自动创建新 operationId。盒子、账号、环境或部署 generation 变化时，先重新获取 context；旧 scope 的待提交请求不得自动重放。关闭窗口不会删除服务器任务，重新打开后通过 `expert.tasks` 读取历史。

错误体为 `{code}`，没有原始异常、凭据或内部路由。常见错误包括 `EXPERT_OPERATION_DENIED`（403）、`EXPERT_INPUT_INVALID`（422）、`EXPERT_CONTEXT_REQUIRED`、`EXPERT_DEPLOYMENT_REQUIRED`、`EXPERT_BINDING_INVALID`、`DEPLOYMENT_RUNTIME_STALE`、`RECORD_CHANGED`、`UPDATE_REQUIRED`（409）。Host 授权过期或连接失效后，应让用户从万象重新连接并打开应用，不能自行获取凭据。
