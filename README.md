# 半人马AI记忆盒子客户端

当前开发版本的完整源码快照，整合万象桌面底座与本机记忆服务。

## 目录

- wanx/apps/personal-client：实际桌面客户端、盒子连接、空间文件服务与自动备份。
- wanx/apps/builder、wanx/shared 等：客户端构建所依赖的工作台、SDK 和共享源码。保留万象源码目录结构，以维持现有构建路径。
- memory：记忆引擎、SQLite 存储、本机服务与“我的 AI”界面。上游许可证见 memory/LICENSE。

## 当前功能

本机文件夹与 SQLite 作为工作存储；空间自动备份默认打开。客户端自动在盒子空间内定位“半人马AI记忆备份”目录，不要求用户选择路径。自动同步设置可调整备份间隔。记忆同步区域采用紧凑布局；空间页面移除盒子空间/本机切换。新电脑发现既有备份时暂停自动覆盖，提供恢复入口。

## 从源码启动

先安装 Node.js >=22.14、Go >=1.26，以及平台原生构建工具。以下命令从仓库根目录执行（PowerShell）：

```powershell
npm ci --prefix memory
npm ci --prefix memory/App/memmy-agent
npm --prefix memory run build -w @memmy/memory
npm --prefix memory run build -w @memmy/backend
npm ci --prefix wanx/apps/builder
npm ci --prefix wanx/octop/dashboard
npm ci --prefix wanx/apps/personal-client
$env:WANX_MEMORY_BOX_ROOT = (Resolve-Path ./memory).Path
npm --prefix wanx run start:mini
```

原生助手与前端资源由现有 prestart 构建步骤生成。详细平台说明见 wanx/apps/personal-client/README.md；记忆引擎说明见 memory/README.md。这里保存的是源码，不包含开发机 node_modules、编译产物、安装包、用户数据库、登录凭据或盒子备份。

## 验证记录与限制

「我的 AI」连接 Codex 已完成真实盒子只读验收。记忆、星图和空间均通过原生 MCP 在省略 `task_id` 时读到非空正文。详见[验收记录](wanx/docs/verification/my-ai-codex-mcp-20261115.md)。

提交前在原开发环境完成自动备份相关后端回归、前端交互测试、TypeScript 检查及 Vite 构建。真实盒子已成功写入备份；通过官方空间下载及同一记忆引擎恢复验证过记忆内容。一键恢复入口的完整真实网络流程仍需继续验收。本快照尚未在全新电脑上重新安装全部依赖并构建，不视为正式安装包发布。
