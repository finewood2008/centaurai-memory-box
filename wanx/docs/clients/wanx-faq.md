# 客户端常见问题与问题反馈

实现基线：远端 master `20e0cee3`（2026-11-05）。个人版与团队版均支持。

## 入口和行为

- 登录、注册、找回密码页面提供“常见问题”入口；设置页提供“查看帮助”。
- 强制更新页面也可打开帮助。只有帮助页新增匿名放行，原业务权限与更新要求保留。
- 页面显示接口返回的分类、问题、纯文本答案，支持分类切换、关键词搜索、问题展开和手动刷新。
- 不依赖账号登录、盒子连接、团队管理员角色或网络引擎就绪。电脑仍需能够连接帮助 API。

## 目录和存储边界

以下相对路径分别位于 `apps/personal-client/` 和 `apps/team-client/`，保留两端原有差异：

| 位置 | 职责 |
|---|---|
| `account/index.mjs` | 固定匿名 API、响应校验、ETag 和传输错误 |
| `platform.mjs` | 将 `faq()` 转发到账号模块，不走登录编排 |
| `shell/control.mjs` | 受可信管理窗口主 frame 限制的只读 IPC |
| `local-ui/remote-preload.cjs` | `help.faq` 固定动作及错误码归一化 |
| `local-ui/renderer/help.js` | FAQ 页面状态、筛选、展示和内存缓存 |
| `local-ui/renderer/help.css` | FAQ 功能样式，沿用 WANX Material v1 |
| `local-ui/renderer/renderer.js`、`index.html` | 页面加载、入口与导航 |
| `tests/faq-transport.test.mjs`、`help-view.test.mjs`、`help-navigation.test.mjs` | 传输、页面和入口回归 |

没有新增持久化数据、配置或日志文件。FAQ 的 data/ETag 只存在于管理窗口内存，关闭后自然释放；不使用 localStorage，不访问账号加密库，不写 applications、用户资料、盒子目录或系统文件。

反馈草稿保存在帮助模块内存，幂等键和请求指纹由账号模块的主进程内存持有。刷新 FAQ、搜索、切换分类、收起表单和离开帮助页均保留草稿；退出客户端后不保留。没有新增离线队列、本地暂存、通知或搜索埋点。

不修改 Octop、服务端、shared、Host SDK 或本地身份/存储实现。不修改 Builder 的样式唯一源及生成主题；新增功能样式不会被现有 assemble-client 流程覆盖。

## 后端对接合同

请求固定为 `GET /app-api/faq`。默认 Consumer baseURL 仍为 `https://boss.nexusaos.qitus.cn/prod-api`，因此正式默认请求地址为 `/prod-api/app-api/faq`。沿用现有 `WANX_CONSUMER_URL` 配置，不另建 FAQ 地址配置。

请求不携带 Authorization、账号签名或任意渲染层自定义请求头。主进程固定 URL，preload 仅转发 etag。可信窗口校验保留；匿名不是允许任意网页调用 IPC。

200 响应示例：

```json
{
  "code": 200,
  "success": true,
  "data": {
    "version": "faq-0123456789abcdef0123456789abcdef",
    "updatedAt": null,
    "categories": [
      {
        "id": 1,
        "name": "登录与账号",
        "sortNum": 10,
        "items": [
          { "id": 11, "question": "如何登录？", "answer": "第一步\n第二步", "sortNum": 10 }
        ]
      }
    ]
  }
}
```

- 保留服务端分类和问题数组顺序；客户端不硬编码分类或答案。
- `updatedAt` 为 ISO 时间字符串或 null；本期不向用户显示该时间。
- 空列表使用 `categories: []`，会清除旧内容并显示整理中状态。
- 返回 `ETag: W/"<version>"`；缺头时客户端使用 version 构造同值。
- 再次进入与手动刷新都会发请求，有内存数据和 ETag 时发送 If-None-Match。304 必须为空响应体，客户端在 JSON 解析前识别。
- data 和 ETag 成对保存。没有数据时不发送条件头；意外 304 会无条件重试一次。
- 429 显示稍后重试；404/5xx 显示服务不可用；兼容 HTTP 200 + 数字 code:500 的错误信封。HTML、空 body、JSON null/数组错误都映射为固定提示，不显示远端原始错误文本。
- 刷新失败保留已有内容并标明未同步成功；首次获取失败显示重试，不提供虚构的离线答案。
- 保留已有 2 MiB 响应守卫，已测近 1 MiB 内容。后台仍应执行原方案的内容预算。

后端联调时需要从正式 `/prod-api` 入口验收 200 → If-None-Match → 304，并验证空列表、内容更新、429、503。前端模拟验收不能替代真实服务端/网关验收。

## 问题反馈（冻结方案 v0.6）

- 正常内容、搜索无结果、空内容和加载失败时都有“没找到答案？告诉我们”入口；每条答案可通过“仍没解决？反馈问题”关联该问题，表单中可以移除关联。
- 正文必填，服务端契约上限为 2000 个 Unicode 码点；联系方式选填、最多 128 个码点。表单沿用 HTML maxlength 约束，emoji 输入可能更严格。允许正文普通换行，提示不要填写密码、密钥或验证码。
- 固定调用 `POST /app-api/faq/feedback`，沿用 `WANX_CONSUMER_URL`。请求体只有 `content`、`contact`、`categoryId`、`itemId`，不接受账号、标题快照、自定义地址或版本事实。
- 无论是否登录，都不加载凭据、不刷新令牌、不携带 Authorization 或账号签名，不依赖盒子、团队管理员权限或网络引擎。
- 主进程通过 `Idempotency-Key` 提交 UUID。超时、网络失败、429、503 或无法确认响应时，未修改的正文与联系方式等使用同一键重试；内容变化或确认成功后使用新键，409/601 结束旧键。并发相同提交在主进程合并，不重复发请求。
- 主进程从现有 `getClientUpdateContext()` 选取字段组装可选 `X-Wanx-Client`：edition、currentVersion、buildId、channel、platform 等。缺少身份上下文时仍可提交。普通认证请求的既有头部保持原契约。
- 只有明确的 `code:200`、`success:true`、`data.received:true` 和布尔 `duplicate` 才确认成功。200/code:601、400、409、413、429、503 及 HTML/空响应分别显示对应提示，失败保留草稿。客户端不另加每分钟计数器；10/min/IP 是后端限流契约。
- 601 提示以结构化 `{ok:false, code, userMessage}` 穿过 control 与 preload；仅输入校验错误可携带提示，去控制字符并限 200 字，渲染按纯文本转义。其他错误不显示远端原文。
- 提交中禁止重复发起，仍可继续编辑。旧提交成功只清除与提交快照相同的草稿，新输入保留；打开反馈聚焦正文，重绘保留输入值、焦点与光标。
- 沿用 `account → platform → shell/control → remote-preload → help` 分层，IPC 仅允许可信管理窗口主 frame。两端分别实现，不改 shared、Host SDK、Octop 或存储核心。

本轮按用户要求只验客户端与模拟接口，不连接真实后端、不验证后台 CRUD/数据库/清理任务/真实网关。完整记录见 [反馈客户端实施验证](../verification/wanx-faq-feedback-client-20261106.md)。

## 本地预览

```sh
# 在仓库根目录运行；只监听本机回环地址
node tools/faq-preview.mjs
```

打开 `http://127.0.0.1:4387/`。底部工具条明确标为“界面预览 · 模拟数据”，可切换两端、登录/设置/升级入口与正常/空内容/网络失败/限流/服务不可用状态。

预览使用真实 renderer/index、help.js、功能样式和本地素材；只在开发工具中注入模拟 Host 和 API。不修改正式客户端环境，不读取账号，不连接盒子，不把示例 FAQ 打入客户端安装包。该工具未绑定真实后端。

## 验证

- 两端 `build:studio` 构建通过；团队版 `build:renderer` 构建通过。
- FAQ 专项：两端共 52 项通过，包括近 1 MiB 内容、取消、登录/未登录都不附带凭据、IPC 错误包装、可信 frame、空态、筛选、刷新竞态和两道升级守卫。
- 最终全量回归：个人版 2599 passed / 73 skipped / 0 failed；团队版 2462 passed / 56 skipped / 0 failed。52 项 FAQ 专项已包含在各端的全量测试中。
- 首轮个人版曾有一项既有身份存储写入失败；该文件单独复核 9 项通过，独立全量重跑也通过，没有修改身份或存储代码。
- 本次验证日志、临时测试文件和截图另行归档在开发工作区外，不属于客户端运行时存储或安装内容。
- 浏览器实际检查：两端页面、登录入口、搜索与展开/收起、空内容、限流保留缓存。
- 没有执行 Octop 的 `make all`：本次只修改客户端；该命令包含格式化核心工程的步骤，不用于改动无关核心文件。
- 未执行安装包签名/安装、原生 Electron 实机全链路或真实后端联调。

反馈扩展后的本轮验证：个人版 2629 passed / 73 skipped / 0 failed；团队版 2492 passed / 56 skipped / 0 failed。FAQ 与反馈专项共 112 项通过，其中反馈新增 60 项，均已包含在全量回归中；双端 renderer 与 Studio 组装构建通过。

完整回归命令（先完成两端原有构建）：

```sh
npm --prefix apps/personal-client --ignore-scripts test
npm --prefix apps/team-client --ignore-scripts test
```

这里的 ignore-scripts 仅跳过已完成的 pretest 资源重建；test 本身仍运行全部 `tests/*.test.mjs`。
