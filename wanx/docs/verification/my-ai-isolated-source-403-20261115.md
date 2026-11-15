# 独立来源库「接入记忆」403 修复

## 原因与行为

当前 Codex Desktop／Codex CLI 独立库通过本机来源扫描采集，native memory-workspace 有意拒绝全局 Hook／Skill／Plugin 与 managed 接入写入。原 UI 未接收当前库能力，仍显示“接入记忆”并请求 POST /api/agent-sources/codex/plugin。

native 错误响应另缺少标准契约要求的 requestId，400/503 的错误代码也与契约不一致，前端因此回退为英文 HTTP 路径提示。

修复保留服务端隔离：

- Summary 将服务端当前 library 透传给采集面板；独立库仅显示当前 Codex 来源和库名，提供本机扫描，隐藏接入组件按钮、待接入 Hook 状态及自动安装组件设置。
- 顶部同步、逐来源、继续和深度扫描均限定当前来源。读取中或未知库关闭扫描和偏好写入；状态失败后成功恢复时重新启用，旧备份错误不会永久卡住面板。
- 旧混合库保留原接入行为。native 补齐 requestId 与标准 invalid_argument／memory_layer_unavailable 错误代码，具体拒绝原因可显示给用户。

## 验证

- 真实内置盘目录 4 个前端交互测试文件：47 项通过。
- 新增 native 隔离／混合库回归：2 项通过，包括绕过按钮直接请求仍拒绝、扫描路由可用、400/403/503 错误契约。
- 前端 TypeScript --noEmit 通过；CRLF 感知 diff whitespace 检查通过；源码前端资源构建成功（/tmp/memobox-403-frontend-build.log）。
- native 完整两文件运行另有 14 项通过、2 项既有模型设置测试返回503，未计为通过；这两项需要本机监听，当前沙箱仍无法正常完成。未扩大权限运行真实配置操作。
- 未安装真实 Hook、Skill、Plugin，未改认证或记忆数据。

## 并行范围与运行状态

修复仅在内置盘，涉及 shell/memory-workspace.mjs、其测试，以及前端 memory-sources-page、wanx-my-ai、wanx-memory-backup 和对应3个交互测试文件。原件留档：/tmp/memobox-before-403-frontend；完整前端补丁和hash：/tmp/my-ai-collection-profile-he7gr07d。ORICO 和空间工作台7文件未触碰。

2026-11-16，空间线程完成验收后，按用户要求加载最新资源并重启。两个开发 app 均已校验 app ID 与内置盘 bootstrap、备份入口 HTML、增量复制资源（保留旧 chunk 便于回滚）、刷新开发签名并通过验证。

实际重启后的窗口 URL 指向内置盘源码；记忆服务、当前库和来源面板加载正常。独立库只显示 Codex Desktop 的本机扫描入口，未显示“接入记忆”或全局 Hook 安装按钮，未出现原403提示。未为验证而重新采集真实会话或修改 Hook。

退出旧主实例时，正常退出流程未能及时结束；核对内置盘 profile 单实例锁、PID、当前用户及 app 路径后，通过 SIGTERM 完成退出，未强杀或手动清理锁。Memory/backend 后台服务与数据库保留。旧实例退出等待问题未在本轮修改，仍应另行排查。
