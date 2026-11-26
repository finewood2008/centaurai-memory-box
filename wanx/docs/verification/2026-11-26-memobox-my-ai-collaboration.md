# 记忆盒子「我的 AI」协作试点

试点基于 Codeup `Memobox` 的 `c02300a9`。协作界面与单智能体共用应用中的「我的 AI」入口。离线原型和 Mac 验收版使用虚构片段和模拟模型。

## 客户端试点配置

启动个人客户端时设置 `MEMOBOX_COLLAB_PILOT=1`。每家服务需要具备结构化输出能力的有效模型 ID 和官方 API 凭据，由试点运行环境传给客户端主进程。

| 接收方 | 模型 ID | API 凭据 |
| --- | --- | --- |
| Anthropic | `MEMOBOX_COLLAB_CLAUDE_MODEL` | `MEMOBOX_COLLAB_CLAUDE_KEY` |
| Google | `MEMOBOX_COLLAB_GEMINI_MODEL` | `MEMOBOX_COLLAB_GEMINI_KEY` |
| OpenAI | `MEMOBOX_COLLAB_GPT_MODEL` | `MEMOBOX_COLLAB_GPT_KEY` |

进入「我的 AI → 协作任务」。选择资料范围并预览后，勾选本次允许外发的原文片段。星图预览使用已解析的文档和片段做关键词匹配。协作期间，本机会在各阶段检查已批准片段的版本和可读性。模型状态、结果和出处保存于当前账号与盒子的本机记录。

## 验证

- `node --test apps/personal-client/tests/my-ai-collaboration.test.mjs` 验证授权范围、模型适配、引用、复审、超时和恢复。
- 打包或验证界面前，在 `apps/memory/App/frontend/desktop` 构建 `wanx-memory` Vite 模式。Mac 验收程序使用这个构建及 `apps/personal-client/tests/support/electron-my-ai-collaboration.mjs`。
- 从仓库根运行 `node docs/assets/prototypes/my-ai-collaboration/build.mjs <输出路径>.html` 生成离线原型。
- 配好三个模型后运行 `node apps/personal-client/tools/evaluate-my-ai-collaboration.mjs --live`。三组虚构案例会以相同的任务和证据，比较 Claude 单次直接作答与完整协作流程。JSON 输出记录耗时、用量、关键事实覆盖、能由规则检查的引用和原始报告。发布评审时逐条复核规则无法判定的引用及关键事实。

真实三方 API 和配对评估等待试点凭据。Windows 客户端的原生终端和桌面流程另行验收。

## 1.5.6 模型来源切换

macOS 的「我的 AI」在任务输入区上方提供模型来源卡片。Codex 桌面版可自动写入盒子云模型配置，点击「原订阅」恢复切换前的设置。Codex 桌面与独立启动的 Codex CLI 共用默认配置。云模型入口仅列出盒子授权的托管云模型，验收范围为文字问答。多智能体研究仍需单独启用试点。

Mac 验收使用实际 Codex 配置，桌面包自带的引擎读到了所选模型。盒子返回了与所选模型一致的流式回执。切回后原模型配置和登录文件的 SHA-256 与切换前一致。Codex 桌面原窗口中的两次手动发问仍待确认。
