# 盒端独立服务的 Bridge 注册

Bridge 从 `WANX_BRIDGE_SERVICE_REGISTRY_FILE` 读取可信安装器维护的 JSON 注册表，启动时加载一次。新增服务通过配置接入，不需要增加 Bridge 业务代码。配置修改后重启 Bridge；服务不能通过网络请求自行注册，也不能在业务请求中指定 upstream。

实现位于 [`service_registry.py`](../../server/bridge/wanx_bridge/service_registry.py)、[`service_health.py`](../../server/bridge/wanx_bridge/service_health.py) 和 [`server.py`](../../server/bridge/wanx_bridge/server.py)。

## 路由与身份

- `serviceId` 最多 128 字符，以小写字母开头，由小写字母、数字及分隔各段的 `.` 或 `-` 构成，例如 `example.notes`。
- 每个服务声明一个路由前缀：`/api/services/<serviceId>/v1`，原样转发到该服务。前缀本身和其子路径均可访问。禁止占用其他服务、Octop 或 Bridge 的命名空间。
- upstream 必须为 `http://127.0.0.1:<1–65535端口>`，服务进程由安装器独立管理。禁止主机名、远程地址、凭据、查询参数和附加路径。
- `methods` 是显式 HTTP 方法白名单。支持 HTTP 和可选 SSE；`sse: false` 时服务返回事件流会被拒绝。WebSocket 暂不支持，不能回退进入 Octop 代理。
- 用户调用代理和状态接口需要现有 Host session。Bridge 根据该会话生成带 `serviceId`、`userId`、`spaceId` 的短期服务 JWT；Host/Octop 原始凭据和 Cookie 不转发，调用方的 `x-wanx-*` 头被移除。
- 通用服务仅获得 `service:read`、`service:write`。服务必须验证 Bridge 签名、issuer、audience、有效期，以及 **serviceId 等于自身身份**，并按用户和空间隔离数据。只有安装证明的令牌没有用户上下文，不能作为用户业务授权。
- 未注册或禁用的服务不能代理；未知 `/api/services/*` 路径不会回退到 Octop。

火花继续使用 `huohua.workbench` 和 `/api/huohua/v1`，保留原有 `workbench:*` 权限。浏览器、平台 capability 和任务租约仍是火花专属合同，通用服务不会自动获得这些能力。剪贴板和 Semantica 现有专用入口不在本次迁移范围。

## 注册表样例

以下为显式手动部署模式，适用于开发联调；正式 OTA 接入应使用下一节的激活约束。

```json
{
  "schemaVersion": 1,
  "services": {
    "example.notes": {
      "enabled": true,
      "upstream": "http://127.0.0.1:19093",
      "uid": 10007,
      "tokenAudience": "wanx-bridge",
      "protocolVersion": 1,
      "minWanxVersion": ">=0.1.0",
      "routes": [{
        "prefix": "/api/services/example.notes/v1",
        "methods": ["GET", "POST"],
        "sse": true,
        "websocket": false
      }],
      "health": {
        "liveness": "/healthz",
        "readiness": "/readyz",
        "version": "/version"
      },
      "servicePublicKeyFile": "/data/wanx-bridge/example-notes.pub",
      "activation": {"mode": "legacy"}
    }
  }
}
```

注册表及公钥文件必须由 Bridge 运行用户拥有且禁止组/其他用户访问（通常为 `0600`），不能是符号链接。公钥为 32 字节原始 Ed25519 公钥；私钥由各服务独立保管，不写入注册表。`uid` 是安装身份元数据，不替代密钥验证。安装器应为不同服务生成独立密钥，并合并已有注册记录，不能覆盖其他服务。

## 激活和健康门禁

通用服务使用 OTA 时必须显式指定可信运行时 profile：

```json
{
  "mode": "ota",
  "path": "/var/lib/wanx/services/example.notes/activation.json",
  "profiles": [{
    "profileId": "example-notes-python312",
    "profileVersion": 1,
    "profileDigest": "<安装器确认的64位小写十六进制摘要>"
  }]
}
```

将此对象放入记录的 `activation` 字段。profile 必须来自可信安装器，不能从服务健康响应自动接受。新服务缺少 profile 会导致注册表校验失败，不会隐式降级到 legacy。火花省略 `activation` 时继续使用原有默认激活路径和已支持的 profile。

激活记录及祖先目录保持现有 root 所有、不可被组/其他用户写入的约束。Bridge 核验激活记录的 `serviceId`、profile、状态，以及运行服务返回的版本、build、源码、制品、运行时摘要和激活代次。只有 `committed` 且与运行实例一致时才能代理；探测中激活记录发生变化也会被拒绝。

Bridge 检查 liveness、readiness、协议版本和最低 WANX 版本。`/readyz` 返回 `{"ready":true}`；`/version` 至少返回 `{"version":"1.0.0","protocolVersion":1}`，OTA 模式还需要返回激活绑定字段。注册表和协议版本目前均为 `1`。各服务分别探测，某服务未就绪不妨碍其他服务接入。

## 通用接口

| 方法/路径 | 授权与用途 |
|---|---|
| `GET /api/bridge/v1/services/<serviceId>/status` | Host session；查询就绪状态，不暴露 upstream 或公钥路径 |
| `POST /api/bridge/v1/services/<serviceId>/session` | 服务安装密钥签名证明；取得无用户上下文的服务令牌 |
| 注册前缀及其子路径 | Host session；按注册方法白名单代理 HTTP/SSE |

安装证明请求包含 `serviceId`、`protocolVersion`、`nonce`、`signature`，可选 `boxId`；签名字节为 `wanx-service-session-v1\n<serviceId>\n<protocolVersion>\n<nonce>`，Ed25519 签名采用 URL-safe Base64。重复 nonce、错误签名、未知或禁用服务会被拒绝。此接口只认证已登记的服务，不会创建注册记录。

## 验证

仓库根执行：

```sh
npm run test:bridge
uv run --project server/bridge python server/bridge/deploy/smoke-generic-services.py
```

smoke 使用两个临时服务、临时公钥/注册表和仅属于测试进程的 Host 身份，真实监听随机回环端口，检查 HTTP/SSE、用户身份、凭据过滤、路由白名单、安装证明、防重放和火花能力隔离。结束时关闭临时监听，不写入正式服务注册表，也不使用正式用户凭据。
