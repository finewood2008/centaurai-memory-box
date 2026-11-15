# WANX-BDK-404 端到端验收

`apps/builder/tests/bdk404-e2e.test.mjs` 使用生产团队客户端的 `createApplicationSession`、Host SDK 和 Builder `createStudioControl`，连接一个受控的测试盒子适配器，覆盖：

- 标准协议 3 ZIP 安装与安装回执；
- 标准应用 ID 启动入口；
- Host 会话建立与上下文读取；
- 盒子数据写入、刷新读取和服务错误传播；
- 会话撤权后 Host 请求失效；
- legacy miniapp 导出路径由既有 export 测试继续覆盖。

运行：

```sh
node --test apps/builder/tests/bdk404-e2e.test.mjs
```

真实账号、真实盒子和授权令牌未存在于当前工作区，因此本文件记录的是生产客户端运行时的本地验收 seam。接入真实环境时，只需替换测试中的 `createConnection` 和 Builder API 请求适配器，不改变验收断言。

## 外部环境实测（2026-11-13）

已启动打包版团队客户端并连接真实盒子 `CentuarAI-AMD-78`（`192.168.0.78`）。通过“本机安装”入口安装标准 ZIP `bdk404-real-0.1.0.zip`，客户端成功显示本机应用 `bdk404-real-acceptance`。

点击打开时，客户端返回：`请在「应用」中安装已发布版本，再准备盒端资源。` 因此真实 Host 会话和盒端读写尚未开始；当前阻塞点已经从“没有客户端/盒子”收敛为“标准应用尚未完成上架并准备盒端资源”。

## Builder 实际构建复测（2026-11-13）

在同一真实团队客户端中打开 Builder 设置并执行“检查环境”，Codex 状态已从“待检查”变为“环境可用”（`2026/11/13 23:39:53`）。随后创建了用于真实验收的标准 Host 数据台账项目，并在 Builder 中执行能力检查和两次继续处理。

引擎预检均已通过，但实际产品经理回合仍返回 `CODEX_TURN_FAILED`，PRD 没有完成同步，因而没有进入标准协议 3 构建、版本采用、上架或盒端资源准备阶段。当前真实验收阻塞已经收敛为 Codex 实际回合失败；不能把“环境可用”误判为“可生成标准版本”。

## 修复尝试与当前结论（2026-11-14）

已将 Builder 内置 `@openai/codex` 从 `0.160.1` 对齐到受管服务使用的 `0.169.0`，并重新构建团队客户端；在服务端部署前，真实客户端重新连接盒子后，Builder 回合仍在约 15 秒内返回 `CODEX_TURN_FAILED`。同时修复了 `NativeSession` 对 app-server 失败详情的吞码：后续服务若返回稳定错误码，会保留该码并写入受控诊断，不再泄露响应正文或凭据。

已通过 SSH 将 Builder 源码、`wanx_app_studio-1.0.3` Python wheel 和 Linux x64 Codex 0.169.0 部署到真实盒端 `centuarai-wanx` 容器，并保存了部署前完整服务目录备份。部署后重启服务，真实回合已能透传具体错误：`MODEL_PROVIDER_UPSTREAM_FAILED`。

从盒端直接请求模型 Provider 服务得到 HTTP 503：`MODEL_PROVIDERS_UNAVAILABLE`。失败请求链路为 `http://127.0.0.1:18089/model-providers/qeetoken/v1/responses`，其上游配置为 `https://boss.nexusaos.qitus.cn/prod-api`。因此当前阻塞确认在 WANX Provider 上游可用性；不是盒子连接、引擎预检、Builder 本地逻辑或 legacy 导出问题。标准版本、采用、上架、盒端资源和真实 Host 验收待 Provider 恢复或切换可用模型后继续。

真实客户端安装的 `ai.wanx.studio/1.0.3` 仅包含 Builder UI，产品经理回合由 WANX 服务端执行；本地仓库中的 Python/Node Builder worker 不会随客户端进入真实回合。服务端部署后，客户端已从泛化的 `CODEX_TURN_FAILED` 显示为 `MODEL_PROVIDER_UPSTREAM_FAILED`，说明诊断修复已生效。
## Local Codex transfer retest (2026-11-14)

On `CentuarAI-AMD-78` (`192.168.0.78`), a protocol-3 package generated from the local `wanx-app-dev-kit` was imported through `POST /api/app-studio/projects/import-standard`, adopted, accepted, and installed. The sealed application is `dev.wanx.local-codex-acceptance`, version `0.1.0`, artifact `c4feb5b18ab93552a19fcec0e65dcd83d01482c3e6dff9b5d6e3604fef56fda7`, package SHA-256 `35ee54b9b7b4755eebc9938e987969ef760fc09ea3197549dedd4f20315e7342`.

The admin deployment was enabled with `studio_team` audience `all`; the published application catalog and `/apps/{appId}/install` payload both resolve successfully. A production runtime session was created from the published application and revoked successfully. The runtime endpoint was corrected to return the standard package fields instead of assuming legacy `bundle`/`css` fields.

The remaining business-level Host read/write/refresh assertion still requires launching the real team-client application against this published package. The server-side publication, package delivery, runtime-session creation, and revocation checks are now green; the earlier upstream model 503 remains independent of this application delivery path.

## Public Drive contract retest (2026-11-14)

为避免把不存在的 `data` Host 合同写进标准包，重新生成了基于固定 WANX Drive 合同的版本：

- App ID：`dev.wanx.local-codex-drive-acceptance`
- Contract：`wanx.public.drive.v1`，`>=1.0.0 <2.0.0`
- Features：`read`、`write`、`refresh`
- Host capabilities：`identity.read`、`files.upload`、`http.request`
- Artifact：`5c3c63c97a9fe08c00730f7091ab04c12b316d4ca631d9062e9e58c063117cf3`
- Package SHA-256：`b9261ee6348608fd86113349a5b543280eedcf7bb4c52e5290c3ad2c0dbc99ce`

该版本已在真实 Builder 导入、采用、验收、上架并提交安装回执；发布应用可返回协议 3 清单和标准 ZIP。盒端 Drive 资源已实际完成：创建应用目录、上传 `acceptance.txt`、刷新目录列表、按摘要读取内容；读取不存在的文件返回 `404 SPACE_NOT_FOUND`。对应的生产 Runtime Session 已创建并撤权成功。

标准 Host 模板现已补齐固定的写入、读取和刷新按钮，并通过主进程/预加载窄接口调用公开 Drive 合同；错误码透传且撤权后控件禁用、旧请求结果丢弃。wanx-app-dev-kit 全量 89 项测试通过。服务端合同、上架、盒端资源和底层读写错误链路已验证；下一步是用新模板重新生成版本，在真实团队客户端完成 UI 级 Host 写入、刷新、读取、错误和撤权验收。

## 身份作用域修复与真实客户端上架（2026-11-14）

为同一外部 WANX 账号的两个内部身份补充 owner 归一化：本地密码管理员为 `wanx:1`，当前 SSO 管理员为 `wanx:2`，Builder 与 Host 访问统一按 `wanx:1` 授权。团队客户端同时兼容标准包的 `dev.wanx.*` 应用 ID，并按归一化账号判断发布者。

真实客户端重启并重新连接 `CentuarAI-AMD-78` 后，“我的项目”显示 7 个项目，包含 `WANX Drive Host Acceptance v3`；“公司应用”显示“已上架 · 发布 v0.3.0 · 全部成员”；“本地应用 → 盒子内上架应用”显示 v3，点击“打开”已创建真实应用运行进程。

## BDK-502/503 标准模板版本复验（2026-11-14）

使用更新后的标准模板重新生成并打包了 `dev.wanx.local-codex-drive-v3`：

- 版本：`0.3.0`
- artifact：`861a0bfa84fa00d57ffcd2d893363fbdba764495f3ce8a95d343fe972142a107`
- package SHA-256：`307c5849b4287ed600e5038634f1ba3f129ba543720e4b07898fa483dc0d858e`
- 合同：`wanx.public.drive.v1`，声明 `read/write/refresh`

该版本已在真实 WANX Builder 完成导入、采用、验收、安装回执和 `studio_team` 上架。发布目录与安装接口返回协议 3 清单，包摘要校验通过；生产 Runtime Session 创建和撤权均通过。盒端 Drive 合同继续完成应用目录、写入、刷新、读取和不存在文件错误验证。

真实团队客户端已解锁并成功连接 `CentuarAI-AMD-78`（`192.168.0.78`）。服务端同一 WANX 账号下存在本地密码管理员身份 `wanx:1` 和 SSO 管理员身份 `wanx:2`；v3 由 `wanx:1` 导入，客户端当前会话是 `wanx:2`，因此刷新后只显示 `wanx:2` 的 2 个旧项目，未显示 v3。这里是内部身份作用域差异，不是两个外部账号。服务端发布、安装、Runtime 和盒端合同证据均已完成；需要在同一 SSO 身份下重新导入/绑定 v3，或让客户端会话切换到 `wanx:1`，再继续 UI 点击验收。
