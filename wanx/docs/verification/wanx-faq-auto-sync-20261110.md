# FAQ 自动同步与反馈限额交付记录

日期：2026-11-10。客户端分支 `codex/faq-auto-sync`，基线 `8392cc1b`（包含已交付的场景入口）；后端分支 `codex/faq-feedback-quota`，基线 `018815f9`。

## 客户端行为

个人版和团队版均移除“刷新内容”按钮及手动刷新动作。主进程启动时读取公开 FAQ 磁盘缓存并异步进行一次 ETag 检查，随后每 24 小时检查。休眠跨过检查时间，恢复时补查一次；并发检查合并，不补发历史周期。关闭主窗口到托盘不算重启，完全退出后重新启动才会触发新的启动检查。

首次无缓存显示加载状态；已有缓存立即展示。打开帮助、切换分类、搜索、展开问题只读取主进程缓存，不强制访问网络。304 更新成功检查时间，内容变化时替换缓存并通知已打开的帮助视图；保留有效分类、搜索、展开项和反馈草稿，配网侧栏不重建底层 Wi-Fi 表单。

检查失败保留旧内容，按 1、5、30 分钟及之后每小时重试。反馈 POST 不自动重试。缓存格式/大小校验失败则重新获取；原子写盘失败仍保留内存数据。

缓存及诊断日志在 `app.getPath('userData')/faq-cache/`：`faq-<scope>.json` 和 `faq-<scope>.jsonl`。scope 按 edition（personal/team）和配置的服务 base URL 隔离。缓存只含公开内容、ETag、成功检查时间及本机内容更新时间；不保存反馈草稿或联系方式。诊断日志只记版本、时间和失败类型，约 256 KiB 滚动，不打印正文、联系方式、凭据或明文 IP。

## 反馈限额合同

同一出口 IP 的两次获准 POST 至少间隔 60 秒，每个北京时间自然日最多 30 次进入提交接口的请求尝试。格式错误、重复幂等键、数据库失败及冷却期内的拒绝都消耗每日次数，计数到 30 后封顶；被网关提前拦截或根本未到达接口的流量不由应用计数。

Redis 单条 Lua 原子执行，使用 Redis TIME、同 hash tag 的日计数键及独立冷却键。日计数在北京时间次日零点过期，冷却期间拒绝不续期；跨零点仍保留尚未结束的 60 秒冷却。两种限制并存时返回等待更久的一项。

429 保留 `FAQ_FEEDBACK_RATE_LIMITED`，响应增加 `data.limitScope`（minute/day）、`data.retryAfterSeconds`，与 `Retry-After` 一致。客户端经 account/control/preload 传递等待信息，缺字段时兼容旧服务端按 60 秒处理。请求进行中及等待期间禁用提交按钮，每日超限保留草稿并提示明日再试。Redis、HMAC 密钥或可信客户端 IP 不可用时继续 503，不放开写入。

后台管理页面、数据库表结构、nginx 路由、FAQ 读侧 60/min/IP 策略均未修改。数据库幂等约束继续防重复落库，但重试同样经过限额。公司共享出口会共享每日 30 次。

## 运维核对步骤

1. 后台保存并上架新 FAQ 后，从客户端实际使用的公网入口确认内容及版本。
2. 完全退出测试客户端后重开，等待启动检查完成。
3. 在可读取该客户端缓存文件的机器上运行只读脚本：

```text
node tools/verify-faq-sync.mjs --cache-file "<客户端 userData>/faq-cache/faq-<scope>.json" --edition personal
node tools/verify-faq-sync.mjs --cache-file "<客户端 userData>/faq-cache/faq-<scope>.json" --edition team
```

默认查询 `https://boss.nexusaos.qitus.cn/prod-api/app-api/faq`，其他环境使用 `--url <完整 HTTPS FAQ 地址>`。脚本比较服务端与缓存版本，校验环境/版本类型 scope，仅输出版本和时间；匹配退出 0，不匹配退出 1。只验证服务端时可不传 `--cache-file`。该脚本只发 GET，不提交反馈。

版本相同只证明被验证的客户端已经同步，不能证明所有在线用户均同步；其他客户端按启动或 24 小时周期更新。

## 验证证据

- 两版 `build:renderer` 均通过；团队版先执行 `build:studio`。
- `npm run test:client`：2699 passed、73 skipped、0 failed。
- `npm run test:team-client`：2551 passed、56 skipped、0 failed。
- 最后追加的只读运维脚本测试：3 passed；缓存真实重载与 account/platform 链路：14 passed；反馈提示及 IPC 兼容测试：34 passed。
- 两版隐藏 Electron 验收通过，确认没有刷新按钮、自动更新事件可用、原 Wi-Fi 表单节点/输入保持、反馈提交及强制下线处理正常。
- 后端全部 FAQ/Consumer/迁移守卫及实际 Lua 分支测试：98 passed。Lua 测试依赖在 `admin-backend/tests/requirements-faq.txt`，不加入生产依赖。
- 后端覆盖 59/60 秒、自然分钟交界、30 次封顶、北京时间零点、跨日冷却、格式错误、数据库失败、幂等重试、共享 Redis 的并发请求、不同 IP、Redis 故障及旧 GET 限流。
- Consumer 测试夹具改用真实空配置文件，兼容 Windows Path.is_file 校验；本机测试依赖在隔离目录，未修改应用运行依赖版本。
- `make all` 无法执行：本机未安装 make。真实 Redis 集群、实体盒子及线上同步未实测；Lua 分支测试使用真实 Lua 引擎与可控 Redis 命令边界，不能替代线上 Redis 集成验收。

客户端完整日志在工作区根 `personal-tests-final.log`、`team-tests-final.log`、`electron-tests.log` 等；后端日志在后端工作区 `faq-backend-all.log`。运行日志及截图不提交。

## 发布顺序与状态

先部署 Consumer 所用的后端代码，所有实例共用原有 HMAC 密钥与 Redis；确认 429 原因/等待字段及次日 TTL 后，再发布两版客户端。首次部署新计数键从策略生效时开始累计，不追溯此前当天请求。无需迁移数据库或更新 Admin 页面；也不默认变更 nginx。

验收时尚未提交、推送或部署；后续按用户要求提交并推送到功能分支，不自动合并主线或部署。部署后的真实网络、可信代理和共享出口行为仍需预发验收。


## Admin 最新基线复核

2026-11-10 再次同步 Admin origin/master=018815f9，后端功能分支已包含新增的 11 个主线提交。FAQ 原补丁完整保留，98 项 FAQ 回归在最新基线上重新通过。客户端本轮没有新增代码变动。

扩展检查发现上游 Linux 相关测试在 Windows 的 os.geteuid/os.pread 限制：154 项相邻接口/存储/救援测试通过，7 个救援夹具报错，构建机首个用例平台报错。它们不涉及本次 FAQ 文件，需在 Linux CI 验证。详见后端 docs/operations/faq-sync-feedback-quota-20261110.md。
