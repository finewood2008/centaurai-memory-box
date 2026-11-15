# 空间标注工作台：本地交付与验收

2026-11-15。本轮已实现、更新本地开发版，并完成真实 Mac 客户端连接 `CentaurOS-79` 的合成资料验收。没有新增盒端接口或修改盒端代码，没有发布部署。

## 交付位置与迁移交接

当前主项目为 `/Users/finewood/Projects/Memobox`。本任务最初在 `/Volumes/ORICO/Memobox` 开发；得知迁移后，核对了两份仓库相同的 `a6df9bb769d04e7eefd9eea042a9a49c974f9ea0` 基线及 36 个相关文件的摘要。内置盘缺少复制后的 7 个工作台增量文件。先留档目标文件原文，再通过摘要保护和 `git apply --check` 合入精确补丁。ORICO 源码随后冻结；视口与空说明保护的最终修正只写入内置盘。

- [迁移摘要和状态](space-annotation-workbench-migration-20261115.json)
- [7 文件增量补丁](space-annotation-workbench-migration-20261115.patch)
- [实际视口修正](space-annotation-workbench-viewport-20261115.patch)
- [空建议说明的继承保护](space-annotation-workbench-empty-description-20261115.patch)

7 文件的迁移前版本保存在两份项目各自的 `.local/workbench-migration-before-20261115.zip`。两份项目、既有未提交改动、账号与记忆资料均保留。当前 Codex 会话的工作区仍绑定 ORICO；后续开发应打开内置盘项目，避免再同步旧副本覆盖新修正。

已安装入口：`/Applications/半人马AI-记忆盒子 空间标注开发版.app`。最终验收运行的 bundle 位于内置盘项目的 `wanx/apps/personal-client/release/local-space-annotations/2026-11-15T13-25-03-305Z/`。二者资源与严格签名校验均通过，启动入口指向内置盘源码和专用 profile。这是依赖本机项目与运行时的开发版。

## 实现范围

空间工具栏、文件多选和文件夹菜单均可进入工作台，原单项弹窗保留。工作台提供三栏、虚拟列表、分页与整个筛选范围选择、待办队列、连续处理、逐项草稿、字段级批量编辑、完整筛选统计和提交前差异预览。返回空间后恢复浏览位置。实际安装版检查后调整了工作台视口，使底部控件可达。

标签、说明和继承设置沿用现有格式；继承单独展示来源文件夹及路径。只修改标签不会创建空说明来遮住继承。人工字段保持优先，内容变化和并发修改进入复核或冲突。最近一次实际修改可安全撤销；全失败尝试不会覆盖前一批的撤销目标。

新增加密持久化的工作台任务、草稿、建议与账号方案。扫描冻结明确目标集合；每 50 项把标注与回执一同提交。重试使用固定操作号，丢失工作台检查点可通过原子回执恢复。断线暂停、重启后显式继续，取消停止后续块；已经在途的原子块可能完成，其结果仍记录并可撤销。读取并发上限为 2，建议逐项生成。

客户端内容抽取支持文本、文本型 PDF、DOCX、XLSX、PPTX，使用独立 worker 和预算：每项 64 MB、最多 32768 字符、PDF 前 200 页、抽取 30 秒。图片、扫描件和不支持格式明确展示仅名称分析或不可分析，不提供 OCR。模型缺失时，手工、方案和本地规则仍可使用。

AI 接受策略与手工批量设置分开，默认补充标签、填补空说明，可明确保持或替换字段。支持跳过和显式重新生成；生成与跳过均不写人工标注。空建议说明不会建立人工空覆盖。通用推理核心从插件服务提取，独立标注接口使用本机认证，预设解析和凭据留在主进程／本机服务。

主要文件：

- [工作台服务](../../apps/personal-client/shell/space-annotation-workbench.mjs)、[固定 IPC 契约](../../apps/personal-client/shell/annotation-workbench-contract.mjs)、[存储及回执](../../apps/personal-client/shell/space-annotations.mjs)
- [工作台界面](../../apps/personal-client/local-ui/renderer/space-annotation-workbench.js)、[布局](../../apps/personal-client/local-ui/renderer/space-annotation-workbench.css)
- [内容抽取](../../apps/personal-client/shell/annotation-content.mjs)、[主进程模型客户端](../../apps/personal-client/shell/annotation-model-client.mjs)
- [本机标注推理服务](../../../memory/App/backend/src/services/space-annotation-inference-service.ts)、[本机窄接口](../../../memory/App/backend/src/adapters/inbound/local-api/routes/space-annotations.ts)

## 自动化验证

最终 **226 项通过**，无失败、跳过或取消：

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 客户端标注、工作台、内容、桥接、空间及星图兼容测试 | 166/166 | [日志](space-annotation-workbench-20261115/client-tests.log) |
| 插件推理兼容、本机标注服务与认证路由 | 59/59 | [日志](space-annotation-workbench-20261115/model-tests.log) |
| 真正跨 Electron 进程的 preload → IPC → 主进程 → 加密存储 | 1/1 | [日志](space-annotation-workbench-20261115/electron-tests.log) |

客户端集合包含 24 项工作台集成验证：1,000 项、跨页与全范围选择、混合值、字段保持、撤销、断线、重启、只读、账号／盒子切换、并发版本、内容变化、祖先移动、重复提交、丢检查点恢复、旧草稿冲突、AI 跳过及重新生成。有效 PDF/Office 二进制样本单独验证内容抽取。

[真实 Electron 测试](../../apps/personal-client/tests/annotation-workbench-electron.test.mjs) 使用两个独立 OS 进程和隐藏窗口，renderer 自身通过生产 preload 调用固定 IPC，完成 1,000 项扫描与保存、21 条原子回执、外来 renderer 拒绝、重启草稿／标签回读、检索、预览和撤销。其盒连接和 AES 密钥为合成夹具；真实盒子与本机加密另由下方安装版验收覆盖。

复现真实 Electron 测试：

```sh
cd wanx/apps/personal-client
WANX_TEST_ELECTRON=1 node --test tests/annotation-workbench-electron.test.mjs
node --test tests/annotation-workbench-integration.test.mjs
```

完整本机 backend 构建与类型检查通过。迁移后的复验曾发现 Builder 缺少已声明的 `semver@7.8.5`；补入已有同版本 npm 依赖后，内置盘完整客户端集合通过，未修改锁文件。

## 实际安装版操作记录

全部通过 CUA 操作真实客户端，最终页面 URL 为内置盘 `local-ui/renderer/index.html`。只操作新建合成资料目录。

| 步骤 | 实际结果 |
| --- | --- |
| 连接 `CentaurOS-79`，进入 `Annotation Workbench QA 20261115` | 已连接；独立目录 |
| 上传 12 份 TXT、MD、CSV、JSON、PDF、DOCX、XLSX、PPTX、PNG、扫描 PDF、ZIP、BIN | 12 项完成，11.3 KB |
| 进入工作台，选择整个筛选范围 | 12 项；自动类型标签仍显示待标注 12 |
| 新增 `WB-QA-20261115`，预览后确认保存 | 实际变更 12；已确认 12，失败 0；说明及继承保持 |
| 使用“本地规则（无需模型）”生成建议 | 12 份待审核，原人工标注保持 |
| 查看 DOCX、扫描 PDF | DOCX 显示合成正文；扫描件显示“仅分析名称／首版不提供 OCR” |
| 跳过扫描件建议 | 不改原标签与说明 |
| 接受 DOCX 的说明建议 | 预览显示仅改 1 项说明；人工标签保留 |
| 撤销刚接受的说明批次 | DOCX 说明恢复为空；12 项人工标签仍保留 |
| 保存方案“合成工作台验收” | 标签与填写要求持久化 |
| 退出客户端，重新启动并连接同一盒子 | 标注、撤销状态、待审核建议与方案回读成功 |
| 搜索 `WB-QA-20261115`，再执行“搜索子文件夹” | 真正内置检索已检查并召回 12 项 |
| 打开召回的 `01-synthetic-project.txt` | 显示 `SYNTHETIC QA ONLY - NO REAL DATA` 与合成正文 |
| 重启后选择已保存方案 | 恢复标签 `WB-QA-20261115` 及填写要求 |
| 跳过剩余建议，保留最终演示页面 | 待标注 0、有建议 0、已确认 12、失败 0 |

实际 profile 的 `space-annotations.enc` 与 `space-annotation-workbench.enc` 均存在；原始文件不包含明文合成标签。只记录文件摘要和大小，未解密账号或真实资料。合成资料原件与摘要见客户端 `.local/workbench-qa-20261115/files.manifest.json`；[可重复生成脚本](../../apps/personal-client/tools/create-annotation-workbench-fixtures.mjs) 已保留。

本机空间另保留 `Annotation Workbench Synthetic QA 20261115` 的 12 份合成资料，供本机演示；没有覆盖或清理既有资料。

## 边界与后续

本轮实际安装版的“进入工作台 → 合成资料 → 批量保存 → 重启回读 → 内置检索召回”已通过，包含真实盒子。当前没有配置 AI 模型，真实外部模型调用未验收；本地规则、无模型手工流程及模拟模型异常已验证。

Space → 内置星图 → Agent 的标注继承和待导入回执兼容链路通过合成服务集成测试。真实模型驱动的 Agent 对话尚未验收。独立星图、独立盒端 MCP、跨设备标注同步按已批准计划保留为后续范围。
