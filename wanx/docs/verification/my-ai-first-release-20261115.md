# 我的 AI 首版接入：实现与验证记录

日期：2026-11-15（Asia/Singapore）。状态：首版源码与合成测试完成，本机开发界面已启动；各真实客户端闭环尚未验收。未发布、未提交仓库、未安装或卸载真实智能体、未写入用户凭证、未导入导出真实记忆。

## 本轮边界

管理目录只保留六个产品、八个入口。Claude 桌面内部另区分 Chat、Code、Cowork。退出目录的旧来源不会由历史会话重新补入左栏；未删除其应用、配置、读取器或已采记忆。解除接入仍是用户主动操作，与目录过滤分开。

未重置、覆盖或暂存原有未提交修改。备份恢复、独立 Codex 来源库、空间标注的并行修改均保留。公共入口按最新内容增量接入；标注的三处接线已补齐：annotationStore、control 四个方法、personalDataService 的 personalSpace 参数。未修改空间任务拥有的 codex-context-sources.mjs。

## 能力矩阵

表内“实现”表示代码及合成测试，不能替代真实客户端加载和检索证明。

| 入口 | 打开、任务交付 | 配置与检索 | 记忆保存与限制 |
| --- | --- | --- | --- |
| Codex 客户端 | 独立检测；官方链接预填；超长则完整复制并打开 | 复用 Codex CLI 的 MCP 配置和来源身份 | 保留现有采集；桌面触发仍待实机验证 |
| Codex CLI | 显示目标、工作目录、提示词与资料范围；终端 Enter 后启动 | 官方 MCP；与桌面共用一份连接 | 既有 hook/扫描；默认不自动持久化 hook 信任 |
| Claude Code CLI | 独立检测；终端确认后启动 | 独立于桌面 Chat 的 MCP 配置 | 复用现有 hook/扫描 |
| Claude 客户端 | Chat/Code/Cowork 分别使用草稿链接；目录仍由 Claude 确认 | Chat 单独配置；Code 使用 claude_code；Cowork 明确显示资料接口未验证 | Chat 提供显式 memory_save；Code 复用采集；Cowork 不宣称自动保存 |
| Gemini CLI | 独立检测；确认后用交互参数启动 | 官方 settings.json MCP，遵循 GEMINI_CLI_HOME/.gemini | AfterAgent 新轮次落私有队列，由既有扫描入库；不猜测原生历史格式 |
| WorkBuddy | 复制并打开，明确需要手工粘贴 | 导出 stdio JSON，引导添加并信任 Connector；不写猜测路径 | 既有兼容采集与显式保存；实际版本需验收 |
| QwenWork | 复制并打开 | 导出配置，引导 Connector JSON 导入；不猜测国内/国际版配置路径 | 保留兼容采集；不同版本的完整性待验证 |
| DeepSeek Harness | 打开桌面、复制提示词 | 仅写 desktop profile，保留共享层与其他 profile | 复用现有插件/采集；预览版兼容性待验证 |

安装管理仅对本应用拥有的 Codex CLI、Gemini CLI npm 前缀自动执行，固定官方 registry、禁用安装脚本、完成版本验证才报告成功。已存在的 npm/Homebrew/原生安装显示实际渠道，并提供原渠道管理引导。其他产品使用官方安装入口。卸载本应用托管程序不删除记忆和认证数据。所有安装测试使用模拟执行器，未实际安装包。

接口依据：[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Claude 桌面链接](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)、[Gemini CLI](https://geminicli.com/docs/cli/cli-reference/)、[Gemini hooks](https://geminicli.com/docs/hooks/reference/)、[WorkBuddy Connector](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Connector)、[QwenWork Connector](https://docs.qwenwork.ai/zh/desktop/connectors)、[DeepSeek Harness profiles](https://deepseek-harness.github.io/deepseek-harness/en/reference/)。

## 实现记录与接口

- [目录与任务路由](../../apps/personal-client/shell/my-ai-task.mjs)：八个入口分别检测；Codex CLI 映射到 codex 集成；Claude Code 桌面模式映射到 claude_code。保留 codexContext 及原 Codex 路由兼容。
- [启动助手](../../apps/personal-client/shell/my-ai-launch.mjs)：提示词写入 0600 私有 JSON，不插进 shell 命令；固定助手核对后，向仍运行的盒子请求批准。当前账号/盒子、过期、取消、关闭均再次校验。CLI 采用 argv 和 shell:false，模型执行前须用户 Enter。
- [资料授权](../../apps/personal-client/shell/my-ai-access.mjs)：按账号与盒子加密保存 folderId、warehouseId、memoryEnabled；历史记忆读取默认关闭。服务端校验范围并约束实际读取，不能靠省略 task_id 返回较宽默认授权。支持空范围和并发任务；断开、范围修改、账号/盒子切换撤销旧授权。
- [MCP 配置](../../apps/personal-client/shell/my-ai-mcp-config.mjs)：保留原配置、注释和同名冲突保护；引导型客户端只导出可审查的连接配置。空间列表入口仅返回已选择的根目录，文件和子目录用受限搜索获取。
- MCP 增加 memory_save，来源由服务端指定，带绑定后的幂等标识；必须收到已落库 ID 才返回 saved。历史读取关闭不妨碍显式保存。配置、服务就绪、客户端加载、正文读取验证、记忆落库分别显示；列表或空搜索不算检索验证，备份状态复用现有备份组件。
- Gemini 在 Memory 和 backend 两侧注册来源及 hook-only target。AfterAgent 脱敏并原子写本机队列；服务离线不丢弃；重复事件去重，内容相同的独立轮次保留；来源撤权后不得入库。不修改 GEMINI.md 或客户端信任设置。
- [记忆包传输](../../apps/personal-client/shell/my-ai-memory-transfer.mjs)：本机文件对话框选文件，预览只返回不透明 ID、数据表计数；提交重新核对 scope、文件摘要、格式与版本。最多 100 MB，默认 skip，先取得一致 SQLite 快照并保存摘要，再调用既有 bundle 导入。回滚复用原有存储恢复服务，只有确认服务恢复结果才显示完成；网络不确定时保留同一恢复 ID，允许刷新或重试。
- 桌面运行时连接 backend，新增受运行时 token 保护的 GET /api/local-data/bundle、POST /api/local-data/bundle/import；后者转接仅限本机凭证的 POST /api/v1/admin/import。导入不自动重试，普通请求仍保留原大小限制。没有把整库 JSON 送入 64 KB 的任务请求或暴露给 iframe 直传；renderer 必须走文件预览门槛。
- Codex hook 安装不再默认调用持久化信任方法；用户在 Codex 中完成信任。保留显式注入的信任回调用于已有调用方及测试。未对本 dot 的任何保存指令或真实客户端配置执行写入。

## 测试证据

全部新增数据为临时目录中的虚构提示词、空间正文、星图依据、记忆和 SQLite 库。

| 检查 | 结果 |
| --- | --- |
| Node 专项：catalog、launch、install、MCP config、scoped access、memory transfer、workspace routing 共 7 文件 | 35/35 |
| Vitest：Gemini capture/runtime/两侧注册、自动注入、Gemini target、真实 SQLite bundle 管理路由、backend 转接、MyAI/传输交互，共 9 文件 | 66/66 |
| 既有 memory-workspace 的 My AI 五项回归 | 5/5 |
| 既有 editable Agent configurations 回归 | 1/1 |
| Codex hook target 的非 socket 回归，含默认不自动信任 | 9/9；另 2 项依赖真实 socket，明确未计通过 |
| Memory、backend、frontend 的 tsc --noEmit | 全部通过 |
| Memory 引擎与 backend 构建；个人版 wanx-memory 前端构建 | 全部通过；Vite 有既有大 chunk 提示 |
| main/control/memory-workspace 语法；git diff --check（保留 CRLF 约定） | 通过 |

核心验证合计 116 项通过（101 项专项 + 15 项兼容/hook），不包含任何真实客户端闭环。

真实 SQLite 测试通过不监听端口的 HTTP 请求注入验证：本机鉴权、新版本/替换策略拒绝、导出、导入、原始正文保留、重复导入跳过。传输测试另覆盖预览不写库、文件变化/账号变化拒绝、快照失败不导入、回滚移除新记录和重启后回滚记录恢复。

复现主命令（仓库根）：

```sh
node --test wanx/apps/personal-client/tests/my-ai-{install,launch,task-catalog,mcp-config,scoped-access,memory-transfer,workspace-routing}.test.mjs
node --test --test-name-pattern='My AI' wanx/apps/personal-client/tests/memory-workspace.test.mjs
node --test --test-name-pattern='editable Agent configurations' wanx/apps/personal-client/tests/my-ai-access.test.mjs
```

Vitest 在 memory 目录执行的九文件列表：

```sh
./node_modules/.bin/vitest run \
  Memory/tests/gemini-capture.test.ts Memory/tests/agent-source-runtime.test.ts \
  Memory/tests/my-ai-memory-admin.test.ts \
  App/backend/src/services/tests/gemini-target.test.ts \
  App/backend/src/services/tests/builtin-agent-source-registry.test.ts \
  App/backend/src/services/tests/agent-source-auto-inject-service.test.ts \
  App/backend/src/adapters/inbound/local-api/tests/memory-bundle-routes.test.ts \
  App/frontend/desktop/src/pages/memory/tests/wanx-my-ai.interaction.test.tsx \
  App/frontend/desktop/src/pages/memory/tests/wanx-memory-transfer.interaction.test.tsx \
  --reporter=dot --silent=true
```

完整日志保留在本机 /tmp/memobox-my-ai-node-tests.log、/tmp/memobox-my-ai-vitest.log、/tmp/memobox-my-ai-codex-hooks.log 及对应三个 build.log；不含真实记忆或凭证。

## 本地启动与剩余项

用户要求启动后，通过 macOS UI 打开源码关联的“半人马AI-记忆盒子 空间标注开发版”，更新其前端资源后切回“我的 AI”，已观察到新能力说明、历史记忆开关和“记忆包导入导出”入口。应用位于本仓库 release/local-space-annotations/2026-11-15T13-25-03-305Z。未停止备份联测实例，未发布。

当前开发 profile 使用独立 Codex Desktop 记忆库。并行备份任务明确关闭了独立来源库里的统一 MCP 接入；本轮保留该隔离，界面显示具体限制。统一接入适用于旧版混合库；没有擅自切换当前库、导入真实数据或解除隔离。

明确未完成：

1. 八个真实客户端的“工具发现 → 正文检索 → 保存 → 新会话回读”验收，以及真实安装/卸载验证。
2. 真实客户端中新记忆进入盒子备份、选择恢复与回滚的双机验收；由备份任务继续，本轮没有冒充其结果。
3. Claude Chat/Cowork 逐轮自动采集；Cowork 本机 MCP 能力。当前分别提供显式保存或明确不支持。
4. WorkBuddy/QwenWork 的无手工 Connector 配置与可靠桌面提示词预填；DSH 不同预览版本的实际兼容性。
5. 独立来源库中的多产品统一 MCP 接入；当前沿用并行任务的隔离限制。
6. 活跃任务授权期间，同产品其他独立会话读取也需 task_id，或等待授权到期/断开重连；这是防止越界读取的保守实现。
7. 沙箱禁止监听 127.0.0.1，因此既有真实 socket 版 Codex/MCP、两个模型设置测试不能在此环境验收；已用不监听端口的 RPC/HTTP 注入覆盖新增逻辑，未申请提权。

空间标注另见 [空间验证记录](space-annotations-20261115.md)：独立安装星图、独立盒端 MCP 尚未消费标注索引，跨设备标注同步及实机闭环未完成。本轮没有将这些项记为通过。

## 启动排障补记与 GUI 交接

用户随后报告记忆服务与扫描服务离线，以及 macOS 反复提示访问可移除宗卷。窗口打开不代表服务闭环成功；此前本地启动记录仅证明新版界面已显示。

- 发现两份同 bundle ID 的开发 app：`/Applications` 副本与本仓库 `release/local-space-annotations/2026-11-15T13-25-03-305Z` 副本，均沿用 `.local/installed-space-annotations` profile。已退出旧副本并打开仓库副本；两者不能同时按独立实例使用。
- 仓库开发 app 的 Memory wrapper 只 import 源码入口，未触发受 direct-run 判断保护的 `main()`。新增 `tools/local-memory-source-link.mjs` 生成完整源码转发模块并显式调用 main；只应用到仓库开发 app，未改 `/Applications`。该 helper 的临时模块子进程测试通过，且 `codesign --verify --strict` 通过。
- 另修正 native supervisor 与前端两处就绪判断：数据库已就绪时，模型历史错误不能导致连接被清空或再次拉起 worker。未修改服务端 aggregate health.ok 的模型健康语义。native/helper 3 项测试、前端健康交互 27 项与前端 TypeScript 检查通过；前端资源重新构建成功。该次新构建尚未复制到开发 app，亦未为此再重启。
- 经本机 UI 浏览器读取公开 health，旧引擎 `127.0.0.1:51781` 返回 `ok:true/status:ready/storage.ready:true`。这表明上述模型降级判断是已确认的独立缺陷，但**不能据此断言它就是本次界面离线的原因**。当前 app 仍显示“本机记忆服务暂不可用”，backend/bootstrap 链路未验收恢复。
- macOS 可移除宗卷弹窗涉及 ORICO 上的程序源码和 profile。未替用户授权、修改 TCC、提升权限、搬迁记忆库或清除任何数据；重复提示尚未确认消除。

空间标注任务请求接管共享开发 app 后，本任务已停止全部 GUI 操作和 worker 重启。可交接 GUI；本轮没有对旧引擎 PID 执行 kill，也没有重置 lock、profile、认证或记忆库。空间任务若继续更新 `/Applications` 副本，需保留此处源代码修复并重新生成其 local-memory wrappers；本仓库副本与 `/Applications` 仍应只启动一个。
