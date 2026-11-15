# 半人马AI · 私人记忆盒子

此分支以半人马AI的横排布局提供「我的 AI」「记忆」「星图」「空间」「盒子」。记忆、跨 Agent 来源和本地模型设置沿用上游实现；旧知识库、应用连接、频道及插件市场不在本机版提供。保留既有记忆数据格式和协议标识。

- 桌面主题与页面样式：`App/frontend/desktop/src/theme/`
- 记忆查看器主题：`Memory/viewer/src/styles/`
- 标志与瓷白浮雕：`App/frontend/desktop/src/assets/brand/`
- 系统窗口图标：`App/shell/desktop/build/`

安装依赖后，运行 `npm run dev:desktop` 启动桌面版。本地版可直接启动，无需配置旧云服务或协议链接。桌面渲染可用 `npm run build -w @memmy/frontend-desktop` 构建，独立查看器可用 `npm run viewer:build -w @memmy/memory` 构建。

本机预览截图保存在 `previews/`。上游项目的版权和 MIT 许可见 [LICENSE](LICENSE)。

启动时使用万象手机号登录流程。有效会话会自动恢复，退出账号后回到登录页。「我的 AI」使用本机工作台，包含任务、项目与历史会话。右上角「配置中心」提供万象个人资料、积分、盒子管理、桌面偏好与两处模型设置。「工作台模型」由本机工作台使用。「万象盒端模型」读取当前盒子的模型目录，个人默认模型保存在盒端，盒主可进入模型供应商管理。「空间」和「星图」使用已连接盒子的权限与资料。

先在含有嵌入接口的万象源码中安装个人客户端依赖并生成原生助手与页面（见万象个人客户端 README）。用 `CENTAUR_WANX_ROOT` 指定 `apps/personal-client` 的绝对路径；也可在当前客户端数据目录放置 `wanx-foundation.json`，内容为 `{"root":"<万象个人客户端绝对路径>"}`。万象的本机状态保存在该目录下的 `wanx-foundation/`，与独立客户端分开；远端盒子和账号仍使用原有数据与权限。安装包目前需要独立提供此底座，不会自动复制源机路径或旧客户端凭据。
