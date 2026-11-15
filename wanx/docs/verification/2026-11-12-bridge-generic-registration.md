# Bridge 通用服务注册验证（2026-11-12）

接入合同见 [盒端独立服务注册](../bridge/independent-service-registration.md)。本次改动限于 `server/bridge/` 和相关文档，未改动 Host SDK、shared 协议或 Octop 核心。

## 本地验证

- Bridge 全量测试：2704 passed / 3 skipped，195.44 秒。保留的警告涉及依赖弃用及既有 OpenAPI 多方法路由。
- 后续补充通用激活、错误密钥和 WebSocket 隔离用例，并将服务代理 OpenAPI operation 按方法分别注册；最终相关测试：54 passed，含新增通用服务测试 21 项。
- 所有本次修改的 Python 文件及 smoke 脚本通过 Ruff；`git diff --check` 通过。
- `server/bridge/deploy/smoke-generic-services.py` 本地通过，实际监听随机回环端口，不依赖 MockTransport。

## 78 盒子

- SSH：`user@192.168.0.78`；正式容器：`centuarai-wanx`。
- Bridge 源码挂载：主机 `/opt/huohua-platform-20261110-platform-browser/bridge` → 容器 `/app/wanx-bridge-next`。
- 更新前确认涉及的五个既有源文件与本地 HEAD 相同；部署只覆盖这五个文件，并新增 `service_health.py`。
- 更新前完整备份源码目录，备份和 SHA-256 清单位于 `/opt/wanx-bridge-backups/generic-services-20261112-1ouaiwfy/`，其中 `deployment.json` 记录安装文件摘要和注册表摘要，`postflight.json` 记录核验结果。
- 重启 `centuarai-wanx` 生效；该容器同时监督 Bridge 和 Octop，操作包含两者的短暂重启。
- 正式注册表 `/data/wanx-bridge/services.json` 更新前后 SHA-256 相同，继续仅登记原有火花服务，未写入测试服务。

| 核验项 | 结果 |
|---|---|
| 公共 `/api/health` | HTTP 200 |
| 未注册 `/api/services/not-installed/v1/health` | HTTP 404，不进入 Octop 默认代理 |
| 无 Host 会话访问火花代理 | HTTP 401 |
| 使用正式注册表探测火花 | `ready`，协议 1 |
| 已部署源码与本地最终六个 Python 文件 | SHA-256 一致 |
| 临时双服务真实 HTTP/SSE | 候选部署前和正式源码部署后均通过 |

双服务 smoke 验证 `smoke.notes`、`smoke.search` 分别使用独立端口和安装密钥，仅通过配置接入；检查状态、POST 请求体、服务/用户身份、凭据过滤、方法限制、路径穿越拒绝、SSE 开关、安装证明、防重放、火花能力拒绝和未知服务拒绝。测试使用单独进程中的合成 Host 授权，未使用正式用户凭据。临时服务器全部退出，容器及主机的临时联调目录已清理；可复跑的 smoke 脚本保留在备份目录。

## 验证边界及回滚

本次完成通用 Bridge 接入基础设施。78 的真实火花仍采用既有 `activation.mode=legacy`；通用 OTA 激活身份/profile/制品匹配由本地测试验证，未在盒子上安装或升级一个新的正式业务服务。后续客户端实测见下节；未提交真实发布任务。

如需回滚：从上述备份的 `wanx_bridge/` 恢复本次覆盖的五个文件（`server.py`、`service_registry.py`、`service_sessions.py`、`service_activation.py`、`huohua.py`），移除本次新增的 `service_health.py`，再重启 `centuarai-wanx` 并核验公共健康和火花状态。注册表及业务数据无需恢复。

这是对 78 现有挂载源码的现场部署，尚未构建或发布正式 OTA 制品；后续镜像/OTA 发行需要包含本次源码变更。

## 火花客户端实际验收

同日在本机正式万象个人版的“我的应用”中执行：界面显示当前盒子 `CentuarAI-AMD-78`、状态“已连接”，点击“半人马AI-火花”的“打开”，成功启动现有火花客户端，未修改或重新打包客户端。

| 操作 | 实际结果 |
|---|---|
| 启动火花 | 工作台窗口正常打开，显示“WANX Bridge 盒端 · 运行中” |
| 发布日历 | 正常展示盒端来源配置及已有待处理内容 |
| 运行概况 | 正常读取账号、目录内容和自动发布状态 |
| 账号管理及刷新 | 返回“账号数据获取成功”；已有视频号账号状态为“异常” |
| 任务中心 | 正常加载，显示执行记录 0 条 |
| 打开盒端浏览器 | 未获取画面，提示“账号浏览器需要恢复，请在账号管理重新登录，并人工核对未确认的发布任务” |

结论：真实客户端启动、连接 78 和基础数据访问通过；现有视频号账号的浏览器恢复未通过，不能据此宣称发布全流程正常。上述页面提示尚不能确定异常根因，未归因于本次注册改造。已关闭本次打开的浏览器查看，客户端停留在任务中心，未重新登录平台账号或触发发布。
