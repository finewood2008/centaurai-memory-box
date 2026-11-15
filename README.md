# 半人马AI记忆盒子客户端

当前开发版本的完整源码快照，整合万象桌面底座与本机记忆服务。

## 目录

- wanx/apps/personal-client：实际桌面客户端、盒子连接、空间文件服务与自动备份。
- wanx/apps/builder、wanx/shared 等：客户端构建所依赖的工作台、SDK 和共享源码。保留万象源码目录结构，以维持现有构建路径。
- memory：记忆引擎、SQLite 存储、本机服务与“我的 AI”界面。上游许可证见 memory/LICENSE。

## 当前功能

本机文件夹与 SQLite 作为工作存储。「我的 AI」区分本机来源采集、空间备份和从备份恢复。空间自动备份默认开启，间隔可在「采集与备份设置」中调整。手动备份使用当前本机库。

### 备份来源与版本

- 「我的 AI」的「当前记忆库」可切换 Codex CLI、Codex Desktop 和旧版混合库。切换会重新打开客户端。CLI 和 Desktop 各自使用一份 SQLite 与采集状态，按会话头的 `originator` 区分。当前支持 `codex-tui`、`codex_exec` 和 `Codex Desktop`。未明确标记的会话仍留在原始记录，旧库和旧快照保留在旧版混合库中。
- 备份来源由 MemoBox 安装和当前记忆库共同确定。安装 ID 由本机随机种子、设备标识和客户端数据目录派生。原始设备标识和目录不写入备份文件名。
- 保留原客户端数据目录及设置的重装继续使用原 ID。全新客户端资料、换机、移动客户端数据目录或复制资料到具有不同设备标识的电脑会产生新 ID。恢复整库不改变写入方 ID。若虚拟机镜像连系统和硬件标识一起复制，首次使用前应给克隆重新生成设备标识。
- 备份保存在盒子个人空间的「半人马AI记忆备份」目录。独立库的文件名使用 `v3`，包含平台、安装 ID、库标识和快照标识。客户端按当前记忆库列出设备和版本，运行时另外校验 SQLite 内部的来源标识。内容未变时复用同一来源的最近快照。已完成的历史快照都保留，盒子空间占用随版本增长。
- 旧命名的备份按原写入标识显示为「旧版备份来源」。旧文件可直接选择恢复，升级后的新备份使用 v2。升级前记录过的自选目录也可读取其中的旧备份。

### 恢复

在「从备份恢复」选择设备及具体快照，核对后确认。客户端验证下载内容和 SQLite 兼容性，本机服务先保存当前库的一致副本，再切换到新库。恢复失败时原库继续使用。成功后可从同一入口恢复上次切换前的本机副本，离线也可操作。恢复得到的路径和工作环境保留为历史信息，使用前需在当前电脑核实。

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

独立备份和恢复已在模拟双设备、故障注入、实际 SQLite 和前端交互测试中验证。真实盒子上此前验证过旧版备份写入及下载恢复。v2 的双设备上传、任选版本恢复和 Windows 设备标识仍待真实盒子和两台客户端联测。
