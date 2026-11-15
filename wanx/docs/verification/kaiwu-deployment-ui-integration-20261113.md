# Builder 部署前端归并验收（2026-11-13）

## 结果与范围

正式前端位于万象 `apps/builder/ui/deployment/`，开物和个人工坊从原工作区共用“部署”入口，也可从“部署已采用版本”进入。项目、已采纳版本、主题、账号及请求通道复用 Builder；没有另起产品壳或登录系统。

页面读取真实部署能力、本人最近 100 条操作中的当前应用记录、任务详情、事件和结果回执。继续原任务及回执重投单独处理。接收任务不表示执行完成，回执重投返回 200 但仍 pending 时不显示送达；未知状态或读取错误不会放行继续任务。切换账号／项目／操作后的晚到响应不能覆盖当前页面。

项目版本到可信发布包、可部署盒子及配置的查询尚未接入，生产执行 Adapter 仍不可用，因此发起部署保持禁用。此次完成前端归属调整及真实状态管理接入，不代表新的自动双端部署闭环完成，也没有更新 102 的镜像或当前用户客户端安装包。

## 迁移核对

- 从应用开发套件提交 `38628494284fab901c4059dfec0c0b0420353afc` 迁入 17 个原型文件，位置为 `docs/assets/prototypes/kaiwu-box-deployment/`。除 README 新增归档说明外，16 个文件 SHA-256 与原文件一致。
- 原型仍使用模拟数据，明确作为设计归档，不参与 Builder 产品构建；正式模块没有引用原型目录。
- `kaiwu-box-deployment-plan.md`、`kaiwu-box-deployment-prd-alignment.md`、`kaiwu-box-deployment-implementation.md` 的正式内容迁入万象 `docs/plans/`，修复引用并更新仓库归属；套件保留迁移指引。
- 套件公共合同、离线校验器、样例、维护验收便签及固定 SDK 未改。合同 Schema 与万象既有快照来源和跨语言一致性规则保持原样。
- 原型生成缓存与验证截图不提交；套件原目录的本地缓存保留并忽略。

## 验证

| 检查 | 结果 |
| --- | --- |
| Builder TypeScript 与 Vite 构建 | 通过；保留已有体积提示，不影响构建 |
| 部署 UI 专项 | 13 项通过，覆盖跨 scope 晚响应、跨操作事件、游标、未知状态、权限错误、202 继续任务、200 待投递回执及并发重投 |
| 工作区恢复／布局／直接编辑／部署传输 | 23 项通过；构建完成不抢走部署页，未保存输入仍需确认 |
| 本地浏览器 | 18 项通过，0 页面错误；开物与工坊、项目切换、只读导航、加载／403／503、1440／900／390 宽度和手动深色主题 |
| 套件 `npm run check` | 107 项通过，34 组部署合同样例有效；最终文档链接检查通过 |
| 归档原型构建与 Sites 静态托管测试 | 构建通过，4 项通过；未发布到 Sites |
| Builder 全量 `npm test` | 608 项中 601 通过、7 失败；未将全量回归标记为通过 |

浏览器测试使用真实 PersonalWorkshop 在临时目录编译生成的项目 fixture，并拦截全部 API、阻止外联，仅验证本地 UI 集成。它不是 102 实机前端验收。发现的窄屏聊天输入框覆盖问题已修复并复验；手选暗色主题使用 Builder 的 `data-theme`。测试服务已关闭。脚本、截图、日志在被忽略的 `.codex-tmp/kaiwu-ui-migration/` 和本地构建日志中。

## 全量回归的既有阻断

首次全量检查的环境问题已处理：补齐当前工作树客户端依赖，Builder 使用实体 `npm ci`，避免跨工作树依赖软链接被 DSH 沙箱拒绝。DSH 测试随后通过；没有放松沙箱规则。

最终 7 项失败分别为：

- `assistant-channels.test.mjs` 的手工 Channel 凭据用例，前期已在未改动基线 `18cace69` 复现。
- `knowledge-template.test.mjs` 与 `zhike-template.test.mjs` 各 1 项：模板源码 LF 与 catalog 内嵌字符串 CRLF 的既有摘要差异。相关源码、catalog 和测试与 `origin/master` 一致。
- Starlink 4 项（builtin 2 项、团队 Host 集成 1 项、model-confirmation 文件加载失败）：缺少当前工作树生成资源。按正式组装工具补齐时被 `STARLINK_SOURCE_HASH_MISMATCH:shared/conversation-change-contract.mjs` 拒绝；源文件、来源清单和工具与 `origin/master` 一致。只读核对共 61 个源文件摘要不符，60 个与换行转换相关，`ui/onboarding-ontology-view.mjs` 另有内容差异。没有修改清单、关闭校验或复制旧制品掩盖失败。

以上问题独立于本次部署前端修改，保留在完整回归结果中，需在对应平台模块另行修复。此次未改后端，因此未重复运行 Python 全量回归。
