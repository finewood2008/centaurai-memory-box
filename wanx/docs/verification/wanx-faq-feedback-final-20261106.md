# FAQ 与反馈最终整合验收记录

日期：2026-11-06。范围：Admin/Consumer FAQ 与反馈、个人版与团队版客户端、本地提交和上线交接。本文取代较早报告中的“3 项待修”“客户端待整合”等当前状态判断，较早报告保留为历史证据。

## 整合与修复

- WANX 分支 `codex/wanx-faq-client-20261106` 已快进合入本次 fetch 的 `origin/master=829cfed3`，包含星联模型确认、刷新及 Workshop 提示修复；FAQ/反馈恢复后无文本冲突。
- Admin 分支 `codex/admin-faq-integrated-20261106` 保留 FAQ 提交 `aebb47a`，通过合并提交 `df880e7` 纳入本次 fetch 的 `origin/master=82a9674`（Consumer authority/idle 查询优化）；反馈变更恢复后无文本冲突。
- 复验 R1：反馈分页/日期 camelCase 参数正确；R2：列表不返回完整 IP HMAC、幂等键和指纹；R3：损坏客户端信息整体降级为空；启动清理宽限已对齐 3600 秒。
- 本次另外补齐同一 FAQ 内容页分类、条目的 camelCase 查询别名，真实 HTTP 回归验证分页、`isActive` 与 `categoryId` 筛选，未改通用分页工具或核心模块。
- 两端客户端沿用 account → platform → shell/control → preload → renderer/help；没有改 Octop、共享 SDK 或存储核心，没有增加磁盘草稿与离线队列。
- 构建后对照 HEAD 确认并备份、还原 45 个无关生成/换行副作用文件；模板 JSON 校验仅嵌入换行和派生 sourceHash 差异。最终暂存范围仅本功能与交接文档。

## 本地验证结果

| 检查 | 结果 |
|---|---|
| Admin/Consumer FAQ 相关 pytest | **113 passed**，2 项既有弃用警告 |
| 双端真实客户端模块 → HTTPS → 当前 Router/Service/DAO → 全新 MySQL 8.0 | **26 passed / 0 failed** |
| 五份真实 SQL、授权过程与重复执行 | **8 个检查通过** |
| 个人版客户端全量 Node 测试 | **2629 passed / 73 skipped / 0 failed / 0 cancelled** |
| 团队版客户端全量 Node 测试 | **2492 passed / 56 skipped / 0 failed / 0 cancelled** |
| Admin 管理前端生产构建 | 通过，输出到隔离证据目录 |
| 两端 renderer、Builder 装配 | 通过 |
| 新合入上游的 Windows 可运行子集 | 21 passed、35 skipped、6 deselected；其余见限制 |
| `git diff --check` 与暂存审查 | 通过；不包含依赖、运行密钥、临时库或日志 |

客户端先完成实际构建再运行测试，`--ignore-scripts` 仅跳过已经执行过的 pretest 装配：

```powershell
npm --prefix apps/personal-client run build:renderer
npm --prefix apps/team-client run build:studio
npm --prefix apps/team-client run build:renderer
npm --prefix apps/team-client --ignore-scripts test
# 个人版使用独立、短路径 TEMP/TMP 后全量复验：
cd apps/personal-client
node --test --test-concurrency=2 --test-timeout=120000 tests/*.test.mjs
```

首轮个人版曾停在既有设备信任测试，重试出现 `LOCAL_IDENTITY_STORAGE_UNAVAILABLE` 和残留句柄超时；该文件独立运行 29 passed/1 skipped。改用系统短路径临时目录并降低并发后，整套测试通过，未修改设备信任实现或测试来消除结果。

后台在 Python 3.12、隔离依赖、`APP_ENV=test`、`NEXUSAOS_ENV_FILE=nul` 下通过 `uv run --no-project --python ... python -X utf8 -m pytest` 运行，FAQ 目标为全部 `admin-backend/tests/module_nexus/test_nexus_faq*.py` 加 Consumer FAQ 合同、反馈、ingress、routes、ownership、ingress contract、certificate ingress 七个文件。pytest-asyncio 显式加载。未执行面向 Octop 核心的 `make all`，本次不修改 Octop。

## 真实联调和迁移检查范围

联调覆盖两端真实 account/platform/control/preload/help 模块，验证匿名提交、客户端版本事实、服务端问题快照、同键重放/冲突、并发唯一性、ascii_bin 大小写、10/min、429、601 中文跨 IPC、真实缺表 503 与同键恢复、旧问题关联、处理人和乐观锁、查询权限、90 天保留期、物理删除以及 FAQ ETag 隔离。三项先前失败检查本轮均成功。

迁移另用全新临时 MySQL，以当前真实 `SysMenu` ORM 建立空菜单表，仅种一条“业务管理”目录，实际执行：

1. `20261105_faq.sql`、`20261106_faq_feedback.sql`。
2. `20261106_faq_feedback_grant.sql`，然后显式 `CALL ...('<临时账号>','127.0.0.1')`。
3. `20261105_faq_menu.sql`、`20261106_faq_feedback_menu.sql`。
4. 五份脚本再次执行，确认无重复菜单、锁行仍仅 id=1、七项菜单权限不变。
5. 以临时 Consumer 最小权限账号真实 INSERT/SELECT，确认 UPDATE/DELETE 均被 MySQL 1142 拒绝。

两轮临时 MySQL 均使用随机回环端口和全新私有目录，未访问已有 3306；服务已关闭、数据目录已删除，HTTPS 临时私钥和控制凭据已移除。

## 限制与交接

本地管理身份为测试身份，Redis 及故障边界为替身，网关前缀由 ASGI 挂载；不是实际账号、真实 Redis 或 nginx 的完整预发。上游扩展测试中，缺省未装 fixture 的首次尝试已纠正；Linux/Docker/nginx、`os.geteuid/chown/O_NOFOLLOW` 等检查在当前 Windows 不满足前提，需在既有 Linux CI/预发验证。未宣称后台全仓测试或生产部署已完成。

两个仓库仅在本地集成分支提交，未推送、未合入远端 master、未触发流水线、未执行远程迁移。真实账号、实际 Redis/nginx、服务容器、正式签名安装包仍按 [上线操作指南](../plans/万象FAQ与反馈上线操作指南-20261106.md) 完成。Admin 仓库同文副本位于 `docs/operations/万象FAQ与反馈上线操作指南-20261106.md`。

本机详细证据目录：`D:/Codex/.codex/visualizations/2026/11/06/01a1aec7-9cf6-78f0-acb1-5e988c1eae75/faq-final-acceptance/`。主要日志：`backend-tests.log`、`integration.log`、`migrations.log`、`personal-full-final.log`、`team-full.log`、`admin-ui-build.log`、`client-build.log` 和 `upstream-windows.log`。这些临时验证产物不提交到业务仓库。
