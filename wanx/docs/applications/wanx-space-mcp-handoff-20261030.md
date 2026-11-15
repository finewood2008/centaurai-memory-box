# WANX 空间 MCP：连接与盒端鉴权问题交接（待开发处理）

日期：2026-10-30（Asia/Singapore）

> 本文和附件是停止实验时的历史交接快照。后续用户授权继续实现，进展见 [实现与验证记录](wanx-space-mcp-implementation-20261030.md)。原始证据 JSON 与参考补丁保持不变，以保留当时失败结果和补丁摘要；不要将后续源码实现与当时的生产状态混为一谈。

## 结论与当前状态

空间 MCP 尚未修复完成。现场确认了两个阻断点：外部 Agent 直连复制出的 NetBird 地址失败；改由本机临时转发后，79 返回 HTTP 401 和 `BOX_PLATFORM_SESSION_EXPIRED`。对照仓库发现 MCP Key 会进入平台会话鉴权，需由开发团队核对生产部署后修复。

用户实际使用 WANX 内置 NetBird，当前 Mac 与 CentaurOS-79 也在同一局域网。

79 的服务端没有被修改、部署或重启。用户要求停止继续实施，由现有开发团队决定并完成正式方案。本次 CodeUp 交付仅包含交接说明、脱敏证据和临时补丁参考；不将本机实验集成为已完成的功能修复。

附件：[脱敏证据](wanx-space-mcp-evidence-20261030.json)、[临时客户端补丁参考](wanx-space-mcp-local-relay-reference-20261030.patch)。

## 用户操作与复现

1. 在万象个人版连接 CentaurOS-79。
2. 打开「空间 → 空间 MCP」，创建/选择接入 `codex mac`。页面显示 Key 有效、等待首次调用。
3. 点击「复制 MCP 配置」。原配置地址为 `http://100.120.61.157:8088/mcp/space`，使用 `Authorization: Bearer <空间接入 Key>`。
4. 在同一台 Mac 的外部 MCP 客户端发起标准 Streamable HTTP 初始化。

最小请求内容如下。请通过安全输入提供现有空间 Key，不要把真实 Key 写进工单、日志、脚本文件或源代码。

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": { "name": "wanx-mcp-diagnostic", "version": "1.0" }
  }
}
```

请求头：`Content-Type: application/json`、`Accept: application/json, text/event-stream`、`Authorization: Bearer <空间接入 Key>`。

预期：完成初始化，发现空间工具，并能读取该接入获准的范围。实际：原地址初始化连接被关闭或请求超时；绕过第一层网络问题后，盒端返回 HTTP 401，响应为：

```json
{"code":"BOX_PLATFORM_SESSION_EXPIRED","detail":"BOX_PLATFORM_SESSION_EXPIRED"}
```

## 故障一：复制地址与外部 Agent 的网络能力不匹配

现场证据：

- WANX 客户端可以通过内置 NetBird 正常连接 CentaurOS-79。
- 本机系统对 `100.120.61.157` 的路由落到 Clash 虚拟网卡 `utun1024`，网关为 `198.18.0.1`。
- WANX 内置 `wanx-netbird` 使用应用自己的用户态网络及带认证的本机 CONNECT 通道；没有给其他程序提供系统级 NetBird 路由。
- 因此，即使配置由 WANX 正常复制出来，外部 Agent 仍不能直接使用这个 `100.x` 地址。此前“TCP 可以连接”不能证明流量已经到达 79。
- 79 的实际局域网地址为 `192.168.0.79`。其 `8088` 在 NetBird 地址上可用，在局域网地址及盒子自身 `127.0.0.1:8088` 上均拒绝连接。内部 `18088/18089` 为既有 loopback 服务，不应为此直接暴露内部端口。

重点源码位置（以下均为仓库相对路径）：

- `apps/personal-client/shell/space-mcp.mjs`：配置地址直接取 `client.snapshot().connection.url`，改为 `/mcp/space`。
- `apps/personal-client/network/index.mjs`、`network/tunnel.mjs`：内置 NetBird 地址解析与应用专用通道。
- `apps/personal-client/platform.mjs`、`client.mjs`：平台客户端与底层网络客户端的封装边界。

开发团队需要确定正式接入方式，而不是继续假设所有外部 Agent 都具备 WANX 的内置网络能力。如果使用本机转发，必须明确仅同机使用、依赖万象保持连接；如果要求独立于万象客户端，则需提供真正可达且符合既有授权边界的服务入口。不要把本次临时转发视为已确认的产品决策。

## 故障二：盒端鉴权返回错误，仓库代码存在平台会话与 MCP Key 混用

现场证据：

- 从 79 的现有受限终端访问 `http://100.120.61.157:8088/api/health` 返回 HTTP 200，`ok: true`。
- 本机临时转发打通后，使用原空间 Key 初始化，收到 HTTP 401 和上面的 `BOX_PLATFORM_SESSION_EXPIRED`。
- 尚未成功到达空间工具调用阶段，因此不能仅凭配置页“Key 有效”就断言 MCP 全链路鉴权已通过。

对照仓库 `server/bridge/wanx_bridge/server.py` 中的 `proxy()`：

```python
protected = path == "/api" or path.startswith("/api/") and path not in _PUBLIC
marker = _credentials(request.headers, request.query_params, required=protected)
session = await _call(auth.authorize, marker) if marker else None
```

虽然 `/mcp/space` 不属于 `protected` 的 API 路径，只要请求携带 Bearer，仍会进入平台 `auth.authorize()`。空间 MCP 的独立 Key 不应被当作平台会话 marker；而且当前通用转发会替换/过滤 Authorization，需要一起检查 Key 的保真传输。

预期鉴权归属：

- 空间 MCP Key → `src/octop/api/space_mcp.py` 的 `SpaceTokenVerifier`，继续校验真实用户、接入状态、过期和授权范围。
- 平台会话令牌 → 现有平台 API 鉴权，规则保持不变。
- 星图使用自己的仓库 Key，需检查独立 MCP 入口是否有同类问题，不能混用凭证。

建议团队检查精确 MCP 路径的独立转发及鉴权流程，保留调用者原 Key，不附加桌面登录 JWT，不放开整个 `/mcp/*` 或其他业务 API。这里只是修复方向，盒端补丁尚未实施。

注意：以上网关分析与实际错误一致，但未读取 79 生产容器中该文件的 SHA，也未确认它与当前仓库逐字一致。请先核对实际部署版本和入口链路，再应用补丁。

## 已做的临时修改和交付边界

- 已在本机个人版安装临时修复：按账号和盒子提供固定的 loopback MCP 转发入口，当前为 `http://127.0.0.1:59930/mcp/space`；使用内置 NetBird 传输，保留调用者的 MCP Key，不附加平台权限。
- 已补齐底层客户端与平台客户端之间的转发封装。该本机入口现在可以到达 79，但仍被上述盒端鉴权问题拒绝；它不是一个已经可用的 MCP 接入。
- 当前本机个人版仍保留这份临时修改，尚未回退。账号、空间、原 Key 和应用安装记录未清理；安装记录校验未变。
- 团队/企业版（`wanx-team-client`）仅有对应源码改动和自动化回归，没有安装本次修复。
- 相关自动化回归：个人版 306 项、团队/企业版源码 334 项，共 640 项通过。覆盖平台封装、网络、MCP 转发、SSE、原 Key 传输、浏览器 Origin/Host 限制、账号/盒子切换及端口复用。
- 本机修复包检查确认其余 1558 个包内文件内容保持一致，签名检查通过。
- 额外尝试的完整客户端套件未通过：隔离工作树缺少 Python `.venv` 及部分生成资源，不能把定向回归称为全量回归通过。未执行完整后端 `make all`。
- 官方 Python MCP SDK 1.28.1 的真实初始化已执行；目前止于 HTTP 401。工具发现、目录读取及任何真实写入均未通过，不应标为验收成功。
- 临时修复未作为功能代码集成或发布；本次只提交交接材料和补丁参考，由开发团队评审是否采用。

源码基线：`3d16814b38b6edd3135454992852c6c6c260b2de`。79 页面报告运行标识：`build-adaa7c673af648bc94d193e7f62f9b50`，未将其等同于上述 Git 提交。

交接分支：`codex/wanx-space-mcp-handoff-20261030`，基于提交时最新的 CodeUp `master`（`a653a5f670ffd33a75f4b6d570057e1d04d1d3ff`）。本分支不直接修改客户端或服务端运行代码。

临时实验基线为前述 `3d16814`。参考补丁只包含客户端、客户端测试和共用界面源文件的差异，不包含盒端修复，也不作为正式网络架构决策。合入前需按团队当前源码评审；不得将 640 项本地定向回归当成生产验收。

本机个人版仍运行临时实验包；本地保留排查前程序包备份及两次安装回执。备份标识为 `20261030T033524Z`；原始 ASAR SHA-256 为 `e8838e86e770daa38663827938c268c45494a2e4732102c91a1b6faf8d94fd60`，临时包摘要见附件证据。回退前应核对当前安装包没有后续更新，只替换程序包，不覆盖账号、应用或空间数据目录。机器专属绝对路径、安装包、凭据及原始运行日志未上传。

## 建议开发拆分

| 待办 | 建议负责范围 | 必须交付的结果 |
| --- | --- | --- |
| MCP 配置可达性 | 客户端 / 网络接入 | 明确同机及跨网络接入方式；UI 复制的配置能在其声明支持的外部 Agent 环境中使用。 |
| MCP 独立鉴权 | 盒端入口网关 / 空间服务 | 核对 79 部署文件，确保空间 Key 到达空间 MCP 验证器，且不替代或扩大平台 API 权限。 |
| 联调与回归 | 两端共同验收 | 按下面清单完成官方 SDK 发现、读写、撤权与隔离验证，回填实际构建版本和结果。 |

## 建议验收条件

1. 同机外部 Agent 能使用 UI 复制的配置接入；分别覆盖同局域网和异地 NetBird 场景，写清是否依赖万象客户端。
2. 使用官方 MCP SDK 完成 initialize、tools/list、resources/list、prompts/list、space_access 和获准目录读取。
3. 在独立测试接入内验证新建、读回、同操作重试和带版本更新；不修改用户已有业务文件。
4. 错误、过期、暂停、撤销 Key 和账号停用被拒绝；跨账号、跨盘及只读写入被拒绝。
5. 空间 Key、星图仓库 Key、平台会话不能互换；修复后受保护的平台 API 仍要求平台鉴权。
6. 如果采用本机转发，验证切换账号/盒子时中断在途请求、旧端口不指向新盒子、重启重连后的端口恢复和 Origin/Host 边界。
7. 覆盖初始化通知、HTTP 错误、SSE、取消/断连和恢复；日志与工单不记录 Key。
