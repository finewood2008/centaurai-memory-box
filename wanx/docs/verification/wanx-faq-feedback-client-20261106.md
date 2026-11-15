# 万象 FAQ 反馈客户端实施与验证（2026-11-06）

> 版本说明：本文保留较早阶段的实施/验证记录。2026-11-06 最终整合复验已修复反馈 R1/R2/R3、对齐清理宽限并补齐 FAQ 内容分页；最新结果见 [最终整合验收记录](wanx-faq-feedback-final-20261106.md)。部署执行以 [FAQ 与反馈上线操作指南](../plans/万象FAQ与反馈上线操作指南-20261106.md) 为准。

## 范围与基线

- 用户已冻结《万象FAQ反馈功能设计草案-20261106.md》v0.6，并授权实施客户端。后续明确要求：真实后端尚未完成，本轮不覆盖后端测试。
- 工作树：`D:/qs/new_wanx/.worktrees/wanx-faq-client-20261106`，分支 `codex/wanx-faq-client-20261106`。
- 远端 master 已重新 fetch，仍为 `20e0cee3`，本地基线未落后。个人版、团队版的差异分别保留。
- 修改前备份现有 26 个 FAQ 未提交文件；本轮在其上扩展，没有提交或推送 Git。
- 冻结时设计快照的 SHA-256：`400601abf1f9f0dfb116499cae33c53d7c64e45b2754843c3d83dbfb31e4aee4`。后续状态栏更新不改变冻结的接口与产品决策。

## 实现

两端都沿用 `account → platform → shell/control → remote-preload → renderer/help`。

| 层 | 行为 |
|---|---|
| account | 固定匿名 POST、字段/长度校验、主进程版本事实、内存幂等键、并发合并、严格成功确认、错误映射 |
| platform | 直接转发反馈，不初始化网络引擎或启动登录编排 |
| control | 保留可信窗口主 frame 校验；反馈返回结构化结果，不依赖 Error 自定义属性跨 IPC |
| preload | 固定动作、仅转交四个业务字段、错误码归一化及有界校验提示 |
| help | 全状态入口、可选关联问题、可选联系方式、草稿保留、提交防重、成功快照比较、转义显示 |
| renderer | 接入已有 click/input/submit 事件，反馈输入重绘时恢复焦点和光标 |

没有新增运行时文件、存储目录、数据库、本地队列、搜索埋点或通知；没有修改账号存储、身份、网络、Octop、shared、Host SDK 或后端代码。

## 自动验证

| 验证 | 命令 | 结果 |
|---|---|---|
| 个人版构建 | `npm --prefix apps/personal-client run build:renderer`（包含 build:studio） | 成功 |
| 团队版组装 | `npm --prefix apps/team-client run build:studio` | 成功 |
| 团队版 renderer | `npm --prefix apps/team-client run build:renderer` | 成功 |
| 个人版全量 | `npm --prefix apps/personal-client --ignore-scripts test` | 2629 passed / 73 skipped / 0 failed |
| 团队版全量 | `npm --prefix apps/team-client --ignore-scripts test` | 2492 passed / 56 skipped / 0 failed |
| FAQ/反馈专项 | `node --test`，两端各自的 faq-transport、faq-feedback、help-view、help-feedback、help-navigation | 112 passed / 0 failed |
| 样式守卫 | `node --test apps/personal-client/tests/material-theme.test.mjs` | 2 passed |
| 差异检查 | `git diff --check` | 通过 |

全量命令的 ignore-scripts 只跳过已经完成的 pretest 构建，测试本身未跳过。初轮受限运行遇到临时加密文件写入和回环通信限制后停止，改用独立临时目录在本机重跑，以上为完整重跑结果。

构建产生的 45 个无关变动已还原：43 个仅换行差异，另 2 个 Builder 生成模板仅嵌入文本换行及其派生 hash 变化。还原前逐文件核对内容并存档，未保留到本次改动中。最终专项与样式守卫在还原后再次通过。

未运行 Octop 的 `make all`：本次无 Octop 改动，该命令会格式化无关核心工程。不进行真实后端、数据库、定时清理、生产网关或安装包签名/安装验证。

## 本地页面检查

使用真实 renderer/help 和客户端样式，配套 `tools/faq-preview.mjs` 的仅回环模拟接口；页面明确标注“界面预览 · 模拟数据”。

已检查个人版与团队版：

- 从答案关联问题并打开反馈，正文自动获得焦点。
- 服务端模拟 601 文案可见，提交失败不清草稿。
- 延迟成功时禁止重复提交；期间继续编辑的新草稿在旧提交成功后保留。
- FAQ 获取失败时反馈区仍可操作；模拟 429 显示固定提示并保留内容。
- 搜索无结果时仍可打开表单，搜索词仅在占位提示中，不写入正文。
- 600px 小窗口下反馈区域位于可视宽度内，字段与按钮可用。

浏览器内交互检查完成。随后尝试导出原生窗口截图时，Computer Use 因无法可靠确认当前浏览器地址停止，未继续操作原生界面；未导出本地截图文件。

## 预览与交接

```powershell
$env:WANX_FAQ_PREVIEW_PORT='4391'
node tools/faq-preview.mjs
```

本地预览：`http://127.0.0.1:4391/`。工具条可切换个人版/团队版、FAQ 状态和反馈状态（成功、延迟、确认丢失、601、409、429、503）。模拟数据只在预览进程内存，不连接真实后端，也不纳入安装包。

验证日志与原改动备份：`D:/Codex/.codex/visualizations/2026/11/06/01a1aec7-9cf6-78f0-acb1-5e988c1eae75/faq-feedback-client/`。

真实接口完成后，再验两端实际提交/重试及正式入口部署；本轮没有将模拟验证作为真实后端联调通过。
