# 空间 MCP 网络入口与鉴权修复

日期：2026-10-30（Asia/Shanghai）。基线：`46d468b`。

## 范围与验收计划

本轮在用户要求继续完成后，集成历史交接中的空间本地转发方案，并修复盒端 MCP Key 被送入平台会话鉴权的问题。历史证据和参考补丁保持原样；它们记录的是修复前状态。

| 工作 | 涉及文件 | 验证要求 |
| --- | --- | --- |
| 独立 MCP 鉴权转发 | `server/bridge/wanx_bridge/server.py` 及网关测试 | 精确 MCP 路径保留原 Key；平台 API 鉴权不变；未知路径不放开 |
| 内置 NetBird 空间入口 | 两版客户端 `client.mjs`、`platform.mjs`、`shell/space-*.mjs`、接入管理界面及测试 | 原 Key 传输、SSE、取消、切换隔离、重连复用；端口冲突不阻断管理列表；显式重建入口 |
| 完整协议回归 | `tests/integration/test_space_mcp*.py` | 官方 SDK 经过网关初始化、发现和读写；错误/撤销凭据与越权请求仍被拒绝 |
| 工程验证 | 后端 `make all`、网关测试、两版客户端测试 | 记录命令、结果及未覆盖的环境 |

客户端与盒端修复均需发布才能解决内置 NetBird 场景。只更新客户端仍会遇到旧盒端的 401；只更新盒端不会让外部 Agent 获得内置 NetBird 路由。

## 接入方式与边界

同机外部 Agent → 当前电脑的空间 MCP 转发入口 → 万象内置 NetBird 通道 → 盒端网关 → 空间 MCP 验证器与存储。

本地转发要求万象保持运行并连接对应盒子，只监听 `127.0.0.1`。转发不附加桌面登录权限，空间 Key 仍由盒端检查。直接可达的盒子入口继续支持独立于桌面客户端的调用。星图保持直连方式，本轮只修复其盒端 Key 转发，不增加星图本地转发。

端口冲突时保留管理功能，并由用户选择释放端口或重新生成本地入口。重新生成后须更新外部 Agent 配置；不会改变空间 Key、授权或数据。

## 验证结果

已验证的完整本地调用链使用真实 TCP、两版客户端的实际 Node 转发模块、盒端网关、真实空间验证器和隔离存储。测试中的网络连接指向本地临时网关；它不模拟生产 NetBird 组网，用户态隧道由客户端网络测试另行覆盖。

| 命令（工程根目录，另有标注除外） | 结果 |
| --- | --- |
| `uv run pytest tests/integration/test_space_mcp_gateway.py -q --show-capture=no --disable-warnings` | 2 通过，无跳过；分别覆盖个人版、团队版 |
| `uv run pytest tests/integration/test_space_mcp.py tests/unit/test_space_mcp_runtime.py tests/unit/test_space_mcp_drives.py -q` | 9 通过、1 跳过；旧独立 JavaScript SDK 用例因缺少其依赖而跳过，本轮两版 Node 转发集成用例实际执行 |
| `PYTHONPATH=wanx-bridge uv run pytest -c server/bridge/pyproject.toml server/bridge/tests -q --tb=short --disable-warnings` | 1785 通过、1 跳过 |
| `node --test wanx-{client,team-client}/tests/{client,platform-client,space-mcp-relay,space-mcp,space-mcp-ui,space-mcp-preload,space-links,panel-security}.test.mjs`（bash/zsh 展开） | 573 通过，无失败或跳过 |
| `npm test`（`apps/personal-client/`） | 2448 项：2427 通过、20 跳过、1 项既有失败，见下文 |
| `npm run build:studio`、`npm test`（`apps/team-client/`，最终复跑） | 构建成功；2466 项：2445 通过、19 跳过、2 项既有失败，见下文 |
| `make all PYTEST_JOBS=4` | 通过：格式、lint、mypy 均通过；后端 5185 通过、31 跳过 |

回归先在原始网关实现上确认 SDK 初始化返回 401，再在修复后验证初始化、工具/资源/提示发现、`space_access`、写入读回、同操作幂等重试、版本更新、旧版本冲突、凭据隔离与撤销后 401。客户端端口冲突及恢复也先以失败测试锁定，覆盖在途流中止、旧端口隔离、重启复用和管理列表可访问。

个人版全量的失败是 `device-trust-backup-https.test.mjs` 的设备备份场景：相邻工程 `centuarai-os/deployment/local_trust_wanx_profile.py` 拒绝数据库 schema，报 `LOCAL_BACKUP_DATABASE_SCHEMA_UNSUPPORTED`。该测试及其直接备份依赖相对 HEAD 无修改，单独运行同样复现。本轮未修改相邻工程来掩盖此失败。

团队版也存在上述备份失败，另一项为未修改的 `local-environment.test.mjs`：对 `https://localhost?redirect=production`，预期 `LOCAL_ENV_REQUIRES_LOCAL_HTTPS`，实际 `LOCAL_ENV_UNSUPPORTED_KEY`；单独运行仍复现。团队版原本期待 NetBird 返回盒子直连地址的测试已随新行为更新，覆盖续会话后 loopback 地址不变，相关测试 13 项通过。个人版全量完成后新增的端口复用测试已包含于 573 项定向回归，团队最终全量包含全部新增测试。

网关 `ruff check` 和 diff 空白检查通过。`server.py` 的 `ruff format --check` 在 HEAD 基线也因既有函数内 import 后缺空行失败，本轮未扩大为无关格式修改。

本轮源码实现、相关回归与独立代码复核完成。后端 `make all` 通过；客户端全量保留上述已核对的既有失败，不能宣称所有工程检查全部通过。未以本地测试替代生产验收。

本机原始验证输出位置（不含生产凭据，不随源码提交）：

- `/tmp/wanx-mcp-make-all-20261030.log`
- `/tmp/wanx-mcp-client-targeted.log`
- `/tmp/wanx-personal-mcp-tests.log`
- `/tmp/wanx-team-mcp-tests-final.log`
- `/tmp/wanx-mcp-unrelated-backup-baseline.log`
- `/tmp/wanx-team-mcp-unrelated-local-environment.log`

这些 `/tmp` 路径仅供本次执行环境复核，可能被系统清理；可复现命令与结果以本页记录为准。

## 部署与现场验收

本轮未部署或重启 CentaurOS-79，未替换当前电脑上已安装的应用。发布时需同时确认客户端构建与盒端网关版本。

现场须使用 UI 新复制的配置，在同机官方 MCP 客户端完成初始化、工具发现、获准目录读取和隔离测试文件的写入读回；再检查撤权、断连与重连。还需分别在同局域网、异地内置 NetBird 和 Windows 环境复测。未完成这些步骤前，不能标记生产问题已验收解决。
