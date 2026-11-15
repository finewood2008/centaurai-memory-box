# 万象 FAQ 前后端本地联调验证（2026-11-06）

> 版本说明：本文保留较早阶段的实施/验证记录。2026-11-06 最终整合复验已修复反馈 R1/R2/R3、对齐清理宽限并补齐 FAQ 内容分页；最新结果见 [最终整合验收记录](wanx-faq-feedback-final-20261106.md)。部署执行以 [FAQ 与反馈上线操作指南](../plans/万象FAQ与反馈上线操作指南-20261106.md) 为准。

结论：当前后台 FAQ 实现与个人版、团队版客户端可以走通。已通过实际管理接口写入独立 MySQL，再通过两端实际客户端调用链读取、展示、协商缓存、刷新更新和错误恢复。没有发现阻断接入的字段或协议不一致。此前发现的公开更新时间统计范围问题已修复，修复后 57 项后端测试及 30 个 MySQL/双客户端联调检查点全部通过，见第 7 节。

第 1–6 节保留首次联调快照；第 7 节为用户要求修复后的最新状态。

## 1. 本次实际使用的代码

- 后台：`D:/qs/nexusaos-admin/`，master 基线 `6fdd578` 加本地未提交 FAQ 实现。旧的 `.worktrees/admin-latest-20261105/` 没有 FAQ，未用它代替当前实现。
- 客户端：`D:/qs/new_wanx/.worktrees/wanx-faq-client-20261106/`，基线 `20e0cee3`，分支 `codex/wanx-faq-client-20261106`，包含本轮之前完成的 FAQ 修改。
- 用户提供的进度书里“P5 客户端未开始”已经过时，不能作为当前客户端状态；原文档未被本次验证改写。
- 本次没有修改后台产品文件或客户端产品代码，只新增本报告和独立验证资产。

## 2. 验证环境与明确边界

使用本机已安装的 MySQL **8.0.46**，以 `--no-defaults`、独立 datadir、随机端口启动一次性实例。执行后台原始 `20261105_faq.sql`，建立三张实际表。未连接已有 3306 实例，未读取业务 `.env`、`my.ini` 或生产数据。

实际加载后台 `faqAdminController`、`consumerFaqController`、Service、DAO，所有数据写入和读取均经过原始代码及 MySQL。没有用固定 JSON 冒充公开接口。

使用带 `127.0.0.1` SAN 的临时证书启动 HTTPS；Node 仅在验证进程设置 `NODE_EXTRA_CA_CERTS`。未关闭 TLS 检查，未向系统安装证书，未修改正式 Consumer 地址。

客户端链路执行了真实源码：

```text
真实 renderer/help.js
  → 开发用本机桥接
  → 实际 remote-preload.cjs（VM 中执行）
  → 实际 shell/control.mjs
  → 实际 platform.mjs
  → 实际 account/index.mjs + fetch
  → 本地 HTTPS /prod-api/app-api/faq
  → 实际 consumerFaqController / Service / DAO
  → 独立 MySQL
```

以下部分仍属测试替身，不应解释为已完成上线验收：

- 管理接口使用仅限本次实例的测试身份，替代真实后台登录/JWT 查询；原权限检查依赖仍会执行。**没有验证真实后台登录与菜单授权。**
- Electron 的 invoke 调度由开发桥接模拟，保留原 preload、控制层和错误包装逻辑。**没有运行原生 Electron 完整安装包。**
- `/prod-api` 和 `/consumer-api` 使用本地 ASGI mount 模拟网关剥离前缀。**没有验证线上 nginx 配置。**签入及生成映射的守卫测试另行通过。
- 429 由测试 Redis 限流返回值触发，执行真实 controller 的 429 分支。**没有启动真实 Redis 或再次证明 Lua 原子性。**
- 503 不是伪造响应：在本次独立库中临时重命名 FAQ 条目表，使真实查询报缺表异常；验证结束后恢复表名和正常读取。

## 3. 已通过结果

### 自动化与浏览器

| 项目 | 结果 |
|---|---|
| 后台 FAQ/入口/路由守卫，进度书列出的 9 个测试文件 | **53 passed / 0 failed** |
| 跨端真实 HTTP / MySQL 集成检查 | **24 个检查点通过 / 0 个阻断失败** |
| 个人版实际浏览器页面 | 从实际 API 显示内容；后台改写后刷新显示新答案；再刷新为 304 |
| 团队版实际浏览器页面 | 显示同一份后台更新后的内容 |

53 项复跑使用 `uv run --no-project --python D:/adaconda3/python.exe python -X utf8 -m pytest`，显式加载 `pytest_asyncio.plugin`，关闭无关全局 pytest 插件自动发现；数据库等依赖覆盖沿用各测试自己的 fixture。

初次环境尝试缺依赖和遇到 Windows 默认 GBK 读取文档失败，均在隔离依赖目录和进程 UTF-8 设置中处理，未改测试断言或业务代码。最终结果为上述 53 项全绿。

### 集成场景

1. 原始迁移在 MySQL 成功建立三张表，空数据被两端客户端接受。
2. 通过实际后台分类/条目 POST 接口写入数据。
3. 通过原客户端全部内部层和 HTTPS 获取内容；草稿和隐藏分类的条目不出现在客户端。
4. 两端完成 200 → 记录响应 ETag → 下次实际带 If-None-Match → HTTP 304 → 保留旧内容。
5. C 端携带无效 Bearer 仍为 200，与匿名 ETag 相同；客户端正常请求不携带 Authorization 或账号签名。
6. 管理接口 PUT 修改答案，两端收到新 200 和新 ETag；纯文本中的脚本被转义。
7. 条目下架、分类下架均从公开内容消失；重新上架后可重新获取。
8. 429 经原 preload 的 Electron 错误包装归一化后成为 FAQ_RATE_LIMITED，页面保留内容并提示。
9. 真实 MySQL 缺表产生 HTTP 503，客户端显示 FAQ_UNAVAILABLE；表恢复后正常刷新。
10. 管理接口 DELETE 删除所有内容后，两端清掉旧副本，显示整理中。
11. 使用实际管理接口写入最终测试问答，在两端浏览器中核对可见文本。

自动化客户端传输记录中包含 HTTP 200×14、304×4、429×4、503×4。浏览器验证另外记录了“原 ETag 条件请求返回新 200 → 新 ETag 条件请求返回 304”。

## 4. 已复现的后端问题：公开更新时间未限定公开分类

严重度：P2，**不阻断客户端阅读**，但违背方案的空列表与缓存语义。

位置：后台 `admin-backend/module_nexus/dao/nexus_faq_dao.py:83`、`:92`，以及调用它们的 `service/nexus_faq_service.py:51`。

`public_items()` 和 `max_public_update_time()` 的条目查询只过滤条目自身 `is_active=true`，没有限定所属分类也上架。最终组装分类时不会输出隐藏分类，因此未泄漏答案；但时间统计仍包含这些不可见条目。

本次通过实际管理 API 的复现：

1. 分类上架、条目上架。
2. 下架分类，保留条目的上架状态。
3. GET `/app-api/faq` 返回：

```json
{
  "version": "faq-b0bd96efa4effeb90316360df4285668",
  "updatedAt": "2026-11-06T12:23:50",
  "categories": []
}
```

空列表的 updatedAt 按方案应为 null。随后等待时间跨秒，仅修改隐藏分类内条目的答案，公开 categories 仍为空，但 version 变成 `faq-bda7998e5366115019cfea089722a70a`。

建议后端同步处理：条目公开查询及公开更新时间聚合都关联分类，并要求分类、条目同时上架；没有公开分类时 updatedAt 返回 null。补两个回归用例：“下架全部分类后空集时间为 null”和“编辑隐藏分类中的条目不改变公开 ETag”。不要仅在客户端隐藏时间字段来掩盖该问题。

本次仅记录复现，没有改动后台正在开发的源码。

## 5. 证据与复现资产

本机独立验证目录：

`D:/Codex/.codex/visualizations/2026/11/06/01a1aec7-9cf6-78f0-acb1-5e988c1eae75/wanx-faq-integration/`

- `backend_fixture.py`：启动一次性 MySQL、执行原始迁移、暴露真实 FAQ 路由及仅限测试的故障控制。
- `integration.mjs`：两端实际源码联调、24 检查点及浏览器展示桥接。
- `integration-results.json`：检查点、两项同根问题现象、两端请求状态记录。
- `http-wire.json`：后端实际收到的请求路径、If-None-Match、HTTP 状态和 ETag。
- `backend-tests-utf8.log`：53 项最终通过日志。
- `live-personal.jpg`、`live-team.jpg`：实际接口与数据库内容的页面截图。

验证资产不是产品运行时文件，不进入客户端安装包。测试结束后停止本次 Node 桥接、HTTPS 服务和 MySQL，并移除其 datadir；保留代码、日志和截图。

## 6. 尚需正式联调的范围

后台真实登录/JWT/角色菜单 → 管理页面操作；正式 consumer 进程完整生命周期；生产数据库迁移；真实 Redis；线上 nginx `/prod-api` 和 `/consumer-api` 配置；原生 Electron 安装包。上述项目未被本次结果替代。

首次联调时的建议是先修正第 4 节问题再上线；该问题后续已修复，见第 7 节。前后端 API 合同无需兼容修改，正式环境验收仍按原方案执行。

## 7. 后续修复与验证（2026-11-06，已完成）

第 4 节问题已修复，不再是未决项。第 6 节所述正式环境验收范围仍然适用。

### 修改范围

仅修改后台以下三个文件，保留原有未提交 FAQ 实现，没有提交或推送：

- `admin-backend/module_nexus/dao/nexus_faq_dao.py`：`public_items()` 和 `max_public_update_time()` 的条目查询关联分类，要求分类与条目同时上架。
- `admin-backend/tests/module_nexus/test_nexus_faq_service.py`：新增公开条目排除隐藏分类及草稿的回归用例。
- `consumer-backend/tests/test_faq_contract.py`：新增空集时间以及有/无公开内容时编辑隐藏条目不改变公开数据、ETag 和 304 的回归用例。

没有修改接口格式、数据库结构、客户端、核心工程或文件存储规则。

### 修复证据

1. 新增的四个回归用例在旧实现上 **4 failed**，确认可复现问题。
2. 应用最小 DAO 修复后，原 53 项加新增 4 项，**57 passed / 0 failed**。
3. 重新创建独立 MySQL 8.0.46，执行原始迁移，通过真实管理 HTTP 接口写入测试内容；两套实际客户端调用链完成 **30 个检查点 / 0 failed / 0 findings**。
4. 全部分类隐藏但子条目仍上架时：`categories=[]`、`updatedAt=null`。
5. 分别在公开内容为空及非空时，跨秒编辑隐藏条目：公开数据和 ETag 不变，个人版和团队版均收到 **304**。
6. 编辑公开答案仍改变 ETag 并返回 **200**；原有上下架、删除、429、503 与恢复验证继续通过。

复跑命令与完整证据归档在首次验证目录的 `cache-fix/` 子目录：

- `run-tests.ps1` / `backend-fixed-tests.log`：执行 `uv run ... python -X utf8 -m pytest`，57 项通过。
- `regressions-before.log`：修复前 4 个失败的断言证据。
- `integration.mjs` / `mysql-client-regressions.log` / `integration-results.json`：30 个真实 MySQL/两端客户端检查点。
- `fix.diff`：相对修复前本地文件的精确差异，包含 DAO 和两个测试文件；未把已有未提交改动混作本次修复。
- 临时 MySQL/HTTPS 实例在复测后关闭并删除 datadir，清理结果见 `stopped.json`。
