# 102 客户端持续重连调查

## 现场与验收计划

用户界面显示 102 连续重连 174 次；只执行客户端断开/重新连接后，真实认证链约 1 秒完成，星图原数据可读。盒子 WANX、Semantica、Neo4j 均健康，本次 Semantica OTA 已成功。日志中的网络恢复及旧会话 `network_disabled` 始于北京时间 15:02，早于约 17:21 的 Semantica OTA。

验收要求：

1. 用可独立运行的本地测试重现自动恢复与手动连接的差异；不得通过中断客户网络或重启盒子制造故障。
2. 不取消或扩大账号、设备、网络租约和会话授权边界；关网、退出、切换设备后不得恢复旧会话。
3. 修复有明确失败测试的缺陷；未能与现场关联的缺陷不能写成事故已确认根因。
4. 自动恢复记录有限阶段和固定错误码，不能记录 URL、身份、代理令牌或响应内容。

## 依赖、范围和分工

- 基线 WANX `9e8da7ed`；独立 feature worktree，保留用户正在运行的 dev 客户端与已恢复的 102。
- 主代理：`platform.mjs`、`client.mjs`、计时测试和本记录；负责整合、最终测试及提交推送。
- 平台调查代理：独占 `recovery-platform-regression.test.mjs`；传输调查代理独占可选的 `recovery-transport-regression.test.mjs`。
- 依赖现有 Node 和个人客户端依赖目录的临时链接，不新增依赖。
- 验证个人客户端连接、会话、平台、网络、真实 CONNECT/TLS 和计时隐私测试；独立复核最终 diff。

## 已获得的证据

- 既有 client/network/session/tunnel 定向测试 107 项通过，不能单独证明本次事故原因。
- `node --test apps/personal-client/tests/recovery-platform-regression.test.mjs` 基线稳定失败：网络已经启用时再次调用 `setNetworkEnabled(true)`，仍执行 `cancel()`，使旧会话工厂捕获的代次永久失效；同一 transport/client 被保留，自动恢复重复收到 `NETWORK_CANCELLED`，手动连接新工厂立即恢复。
- 当前 UI 不直接开放重复启用 API，现场日志也未记录该调用。上述是独立可证实缺陷，尚不足以认定本次 174 次恢复就是此路径触发。
- 普通 transport recovery 保留代理对象和端口；现有阶段计时不记录 `checkHealth()` 的失败，因此现场解除后，不能从原日志恢复每次自动重连的准确失败阶段。

## 修复与反证

已修复重复 ON：当前已启用时仍持久化偏好并刷新设备授权，但不废弃原连接的代次。OFF 和 OFF→ON 的取消行为保留。上述红例转绿，平台既有 182 项检查也通过。

`checkHealth()` 新增 `box.healthcheck` 及 `box.recovery.endpoint/health/network/session/gateway` 阶段计时，沿用原有固定错误码白名单、容量限制和日志轮换，不记录身份、地址、代理令牌、业务内容或原始异常。测试证明失败会保留真实阶段及 `NETWORK_CANCELLED`，而非只显示重试次数。

新增真实组合测试只替换 Native SDK/RPC 状态，使用真实 Network、TunnelAgent、Client、平台会话、DashboardGateway 及本机 HTTP CONNECT。覆盖状态暂不可用、peer 撤回再出现、recover 时暂缺 peer、旧会话真实定时到期四种情况。可以复现现场 `box.challenge/network_disabled`，但 peer 恢复后均自动重新授权成功。4 项经 12 轮隔离重复全部通过；因此“旧通道曾退役”本身不能解释持续 174 次重试。

组合测试曾因一次跳过 60 秒、同时合并旧 status Promise 而未采样新状态。已改为生产默认 1 秒轮询并逐秒推进，不扩大等待超时，也不把夹具问题写成生产故障。

## 结论与未解决部分

已确认并修复一个会造成相同症状的客户端 API 缺陷，补齐自动恢复诊断。**本次 174 次重连的最终触发条件仍未证实**：当前 UI 没有直接调用重复 ON，旧日志缺少恢复阶段错误，且故障会话已解除。不能把相关性或相似测试当成这次事故的因果证明。

已向用户询问 15:02 是否有网络/代理切换或睡眠唤醒。需要新版客户端记录同一事件的阶段错误，或取得与原故障绑定的触发证据，才能闭合本次事故根因。没有重新中断已恢复的客户端或盒子，没有部署、合并主干或发布客户版本。

最终 `node --test` 合跑 client、platform-client、session-stability、platform-transport、network、tunnel、gateway、timings 及两个新增 recovery 文件：**337 passed，0 failed**。独立审查未发现权限、取消或诊断泄密阻断。`node --check` 和 `git diff --check` 通过。
