# FAQ 反馈后端独立复核与双客户端联调（2026-11-06）

> 版本说明：本文保留较早阶段的实施/验证记录。2026-11-06 最终整合复验已修复反馈 R1/R2/R3、对齐清理宽限并补齐 FAQ 内容分页；最新结果见 [最终整合验收记录](wanx-faq-feedback-final-20261106.md)。部署执行以 [FAQ 与反馈上线操作指南](../plans/万象FAQ与反馈上线操作指南-20261106.md) 为准。

## 结论

个人版与团队版的反馈主链路已通过真实 HTTPS、当前后端 Router/Service/DAO 和临时 MySQL 8.0 验证。现有后端相关测试独立复跑 106 项通过，管理端生产构建成功。

新增独立联调检查共 26 项：23 项通过、3 项失败。失败对应后台查询参数、列表返回字段和客户端上下文解析三项实际问题，不能将本轮结果标为全绿或完整预发验收通过。未修改后端业务代码，未提交、推送或部署。

## 发现与修复建议

### R1（P2）：管理页分页和时间筛选参数未被后端接收

前端发送 `pageNum/pageSize/startTime/endTime`；`FaqFeedbackPageQueryModel` 没有 camelCase alias，`as_query` 实际注册的是 `page_num/page_size/start_time/end_time`。未知 query 参数被忽略，页面翻页时反复取第一页，修改每页条数和时间范围也无效。

- 证据：请求 `pageNum=1&pageSize=2`，响应 `pageSize=10`；请求 `pageNum=2&pageSize=2`，首条 id 与第一页相同。
- 证据：请求 `startTime=2099-01-01`，仍返回当前 19 条记录；预期为 0。
- 后端位置：`D:/qs/nexusaos-admin/admin-backend/module_nexus/entity/vo/nexus_faq_vo.py:187`。
- 前端位置：`D:/qs/nexusaos-admin/admin-frontend/src/views/nexus/faq/feedback/index.vue:117` 与 `:132`。
- 建议：在反馈分页模型声明对应 alias（在 `@as_query` 装饰前即生效），沿用其他请求的 camelCase 合同；补 HTTP 级分页与日期筛选回归，不只测试直接构造 Python 模型。

### R2（P2）：反馈列表直接返回内部数据库字段

`get_list()` 对整个 `NexusFaqFeedback` ORM 做通用分页，结果直接进入 `ResponseUtil.success` 的 JSONResponse，未通过详情 DTO 做字段裁剪。

- 实际列表行含完整 `sourceIpMac`、`idempotencyKey`、`requestFingerprint`。
- 冻结方案要求列表不返回完整 IP HMAC。正文详情 DTO 已经排除了这些字段，但列表没有复用字段白名单。
- 位置：`D:/qs/nexusaos-admin/admin-backend/module_nexus/dao/nexus_faq_feedback_dao.py:82`；返回入口在 `module_nexus/controller/nexus_faq_controller.py:176`。
- 建议：反馈服务在实际返回前将列表行投影为明确的列表 DTO/字段白名单。仅给路由增加 response_model 不足以过滤已构造的 JSONResponse；无需修改通用 PageUtil。

### R3（P3）：非法客户端上下文没有按约定全部置空

`parse_client_context()` 使用 `str(value)`，会把字典、数字等错误类型转成字符串，未知 edition 也只置空自身，继续保存其他上下文字段。

- 实际用未知 edition、对象类型 currentVersion、数值 platform.os 提交，HTTP 200，但 `clientVersion/buildId/platform` 仍非 NULL。
- 正常两端客户端的七个上下文字段均能正确落库；本问题属于异常输入的合同偏差，不影响正常客户端提交。
- 位置：`D:/qs/nexusaos-admin/admin-backend/module_nexus/service/nexus_faq_feedback_service.py:46`、`:100`。
- 建议：先验证上下文对象、字段类型与 edition；按冻结 AC20 对损坏的上下文整体返回 empty，允许合法上下文中缺失的可选字段为 NULL，不阻断反馈受理。

### 次要参数差异

启动后一次性清理的 `misfire_grace_time` 实际为 60 秒（`config/get_scheduler.py:343`），冻结方案为 3600 秒。正常触发及互斥的现有测试通过，但延迟超过 60 秒时可能漏掉该轮；建议对齐参数并补宽限断言，或明确记录实施偏差。

## 实际验证范围

- 执行真实 FAQ 与反馈 DDL，使用全新随机端口与私有 MySQL 数据目录。
- 由真实 Admin 接口写入分类、问题，确认 aliased 字段非 NULL。
- 两种客户端都使用真实 account/platform/control/preload/help 模块，经 HTTPS 向真实反馈后端提交；不加载账号库，不启动盒子网络。
- 七个客户端上下文字段及服务端问题快照正确落库。
- 无效 Authorization 不改变匿名受理；同键重放、不同体 409、MySQL 并发唯一键、大小写区分均符合预期。
- 前十次受理、第十一次真实 429；两个客户端都保留限流后的草稿。
- Redis 替身注入故障时 POST 503，GET 保持放行；真实重命名反馈表触发 MySQL 缺表 503，两端恢复后复用同一幂等键成功。
- 后端真实 601 提示穿过两种客户端四层链路到达 help，失败草稿保留。
- 未知请求字段/缺幂等键 400；已删除 FAQ 条目仍可提交。
- 后台处理记录测试操作人并拒绝过期 revision；仅反馈权限可查询反馈但内容接口返回 HTTP 200/code403。
- 清理服务在真实 MySQL 中删除 91 天记录、保留 89 天记录；后台删除生效；反馈写入不改变 FAQ ETag/304。

## 验证边界与证据

- B 端登录使用本地测试身份替代，不连接真实管理员、JWT 或角色数据库。
- Redis 使用计数/故障替身，未启动真实 Redis；限流 HTTP 结果与参数已验证，Redis Lua 的实际服务执行另需预发验收。
- `/prod-api`、`/consumer-api` 为 ASGI 挂载模拟前缀，不是实际 nginx 代理。路由清单/配置守卫测试通过，真实网关与生产迁移授权未执行。
- 首轮清理检查因管理接口忽略 camelCase 分页，脚本无法在前十条中定位目标；据此发现 R1。重新使用全新数据库，脚本内部查询改用后端实际接收的 snake_case，仅用于继续验证清理；前端 camelCase 不兼容仍作为独立失败检查保留。
- 原有相关回归：`run-tests.ps1` 内部使用 `uv run --no-project --python D:/adaconda3/python.exe python -m pytest`，106 passed。
- 管理端构建：`npm run build:prod -- --outDir <独立验证目录>`，exit 0；没有部署。
- 证据目录：`D:/Codex/.codex/visualizations/2026/11/06/01a1aec7-9cf6-78f0-acb1-5e988c1eae75/faq-feedback-backend-review/`，含 `backend-tests.log`、`integration-final.log`、`integration-results.json`、构建日志与复现脚本。

联调结束后，临时 HTTPS/MySQL 已停止，临时数据目录及测试密钥已清理；未触碰现有 3306 实例。
