# 半人马AI记忆盒子 Windows 预览版交付

已于 2026-11-15T21:50:36Z 发布 [v1.0.6-windows-preview.2](https://github.com/finewood2008/centaurai-memory-box/releases/tag/v1.0.6-windows-preview.2)。安装包为 Windows x64 未签名预览版，不启用正式签名自动更新。

- [安装器](https://github.com/finewood2008/centaurai-memory-box/releases/download/v1.0.6-windows-preview.2/CentaurAI-MemoBox-1.0.6-windows-preview.2-windows-x64.exe)：434,166,846 字节（约 414 MiB）。
- 二进制来源提交：`e8c2ec0916b2b5cd96fe4137cef8af4fd7ce01d6`；Release 标签已核对指向该提交。
- 安装器 SHA-256：`f46c71edd75ba36fc05e606360fbd71256560469e0fde500a33970ecdf15d768`。
- `SHA256SUMS.txt` 与 `verification-windows-preview.json` 已附于 Release；安装器和验证文件的校验值均与 GitHub 资产摘要匹配。
- [完整 Windows 构建与验证记录](https://github.com/finewood2008/centaurai-memory-box/actions/runs/43764028016)。

## 本轮交付范围

标注工作台移除 AI 助手、模型选择及生成建议入口，默认采用文件列表与编辑器两栏；多选直接进入批量编辑。标签和说明保留默认追加／填空语义，文件夹继承和来源保留，范围、方案、继承调整及历史建议置于次级入口。修正单项勾选与保存目标、批量快捷键及任务切换的残留操作状态。

“我的 AI”对话面板减少常驻说明，将历史记忆检索开关改为与参考星图、空间文件一致的按钮。当前展示板块统一半人马AI品牌，保留角落的 powered by wanx；协议、应用身份和数据路径保持兼容。

候选纳入已完成的本机混合记忆采集：统一本机记忆库、来源图标、升级快照和回滚、旧服务接管及账号／设备独立备份。混合采集闭包 19 项已核对完整。尚未完成的默认模型、标注模型模块及其接线没有纳入；未改盒端接口、部署盒端服务、合并其他设备备份或覆盖真实资料。

## 验证结果

| Windows 门禁 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| 暂存、打包配置、真实复制与锁定依赖修复 | 19 | 0 | 0 |
| 品牌路径与第三方代码保护 | 5 | 0 | 0 |
| 手工标注与 MCP 合同 | 103 | 0 | 1 |
| 混合采集及设备备份 | 24 | 0 | 0 |
| 来源升级与回滚 | 9 | 0 | 0 |
| 我的 AI 交互 | 23 | 0 | 0 |
| 合计 | 183 | 0 | 1 |

跳过项为需显式启用并安装 Codex CLI 的真实可执行程序测试。Mac 本地已显式启用该测试，相应候选门禁 104 项通过；不能将此结果表述为 Windows CLI 实测。

前端类型检查、服务及客户端构建、Windows 网络／发现辅助程序和原有 afterPack 检查通过。打包后的 Electron 37.10.3 实际加载 3 份 SQLite 原生模块（12.11.1 两份、13.0.3 一份），ABI 为 136，内存数据库查询成功。已用独立合成配置启动包内 worker 与记忆服务，验证 API bootstrap、存储就绪、来源列表及未认证请求拒绝，结束后关闭专用服务。

Mac 开发版 `/Applications/半人马AI记忆盒子 开发版.app` 已实际重启，在专用 `Annotation Workbench QA 20261115` 目录（12 项）观察到两栏与多选批量编辑。相关综合标注测试 106 项通过，含 1,000 项虚拟列表。此次 UI 观察没有保存实际标注，不替代真实桌面“保存→重启回读→检索召回”的完整验收。

较早的全量旧测试套件仍有缺少 TLS/Python 环境及已在 HEAD 复现的旧 DOM／路由断言失败，详见本轮范围记录；未声明全仓测试全部通过。Windows GUI 安装、真实盒子登录／备份恢复、Space→星图→Agent 实际资料闭环和跨设备标注同步没有在本轮验证。

## 发布流程修复

新增根目录手动 Windows 工作流。修复 registry 主机替换误改本地 SDK archive、Windows 品牌路径匹配、node-gyp Electron target 参数及 electron-builder 重复合并资源。npm 10／11 漏装嵌套工作区的 Reader SQLite 12，现只用锁定 tarball 和 sha512 补齐缺失包，并硬性核对源目录与暂存副本解析版本。electron-builder 默认跳过资源树顶层 node_modules，现使用独立映射并以真实复制测试覆盖。发布前必须有安装器、校验文件及成功的包内运行记录，失败产物不会发布。

## 工作区交接

实际源码目录为 `/Users/finewood/Projects/Memobox`；发布在 `/tmp/memobox-release-candidate-20261116` 独立组装并推送 GitHub。ORICO 旧副本未覆盖、未删除。主项目的 HEAD／分支引用和暂存区没有被本任务 reset、merge 或 rebase；核对时 HEAD 仍为 `488e97ed402eebad031df9c2cfce63117782fbb1`、暂存区为空。已提交的自有修复仅在逐文件哈希匹配后同步回主项目。

原有未完成模型改动仍保留于主工作区，后续需要结合已发布提交协调主分支，不应把当前脏工作区整体覆盖到发布副本。当前 ORICO 未挂载，Builder 的部分依赖与 npm 缓存仍有指向该卷的外链；本任务未改写这些共享依赖。本地补充证据保留于 `/tmp/memobox-release-scope-20261116` 和 `/tmp/memobox-release-primary-sync-20261116`。
