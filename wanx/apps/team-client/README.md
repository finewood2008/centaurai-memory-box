# 万象企业版 · CentaurAI-WanX Studio 1.0.3

企业版与个人版是独立客户端，共用仓库中的 WANX 后端、认证、多租户、模型、空间和应用服务。分支：`wanx1.0`。完整功能与兼容边界见 [1.0 版本说明](../../docs/release/wanx-1.0-release.md)。

管理员可构建应用、管理星图数据仓、邀请成员、验收并内部上架。普通成员使用自己的身份访问获准应用、AI 对话、空间和盒子；客户端与服务器共同校验权限。

## 账号与盒子访问

企业版仅使用云账号登录和盒端现有用户权限，不再提供本地身份验证、解锁或设备审批入口。旧安装的 `userData/identity-security.json` 与本地身份文件会原样保留，客户端不读取这些文件，也不能通过旧设置重新启用本地身份验证。

云端逐电脑审批由 Admin 的 `WANX_CLIENT_APPROVAL_REQUIRED` 独立控制，新服务端默认 `false`：已获盒子权限的账号换电脑登录后，刷新设备会自动同步该电脑的万象访问权限，盒端确认后可连接。此行为需要先部署配套 Admin 更新；旧服务器仍会拒绝缺少独立授权的新电脑。云端设为 `true` 时仍需逐电脑审批。账号、盒子权限和停用/撤权限制继续生效。

客户端不会解除盒端强制执行的访问策略。已启用本地身份强制策略的盒子需要管理员按盒端发布方案迁移，云账号没有的盒子权限仍会被拒绝。

## 开发

源码启动需要 Node.js 22.14+、Go 1.26+；macOS 还需 Xcode Command Line Tools。在仓库根目录执行：

```sh
npm ci --prefix apps/builder
npm ci --prefix octop/dashboard
npm ci --prefix apps/team-client
npm run start:studio
```

启动前自动从 `../builder/` 生成 Builder、星图和受信桥，并从 Dashboard 构建维护页面，生成目录已加入忽略。首次启动还会构建当前平台的网络引擎和系统助手，后续复用已有网络引擎，系统助手按源码摘要缓存。桌面端连接盒子，无需在本机启动 Octop 服务。个人版入口为 `../personal-client/`。两个客户端具有独立安装标识和配置目录，企业版的更新渠道为 `stable-studio`。

连接诊断默认写入 `userData/logs/connection-timings.jsonl`（macOS 企业版目录为 `~/Library/Application Support/wanx-studio-team-client/`）。`box.connect` 是单次连接总耗时，同次连接用随机 `connectionId` 关联；各阶段及有效租约内沿用地址、实时鉴权、旧地址刷新一次的规则见[连接耗时诊断](../personal-client/README.md#启动耗时诊断)。两个客户端的连接源码独立维护，优化和回归测试须同步验证。

## 构建与检查

```sh
npm --prefix apps/team-client run build:studio
npm --prefix apps/team-client run build:renderer
npm run test:team-client
```

以上命令均从仓库根目录执行；跨工程测试还需分别准备 `octop/` 与 `server/bridge/` 的 Python 虚拟环境。

macOS 应用目录：`npm run package:studio:mac`；Windows 安装包：`npm run package:studio:windows`。macOS 正式签名、公证入口统一为：

```sh
./package-client.sh --edition team --arch arm64 --formal
```

Intel Mac 使用 `--arch x64`；同时打两版使用 `--edition all`，两种架构分别构建。现有 `apps/team-client/package-client.sh` 和 `apps/personal-client/package-client.sh --edition team` 入口仍可使用。Windows 正式发行使用 `apps/team-client/tools/package-client-windows.mjs`；两端继续执行签名、公证及更新信任的对应校验。正式入口默认读取本目录 `package.json` 的 `version`；可选 `--version` 只覆盖本次产物。发版时同步本目录 `package-lock.json`，保持版本一致。构建资源从源码生成，安装包和运行数据不提交。

需要 `--formal` 简写时使用根入口；团队版原脚本沿用显式 `--notary-profile`、`--trust-file` 参数。

星图仓库 Key 与空间 MCP 授权分别由受信服务管理，不写入应用源码。已配置的团队数据与个人数据分开；未获准仓库、账号停用与跨团队请求应被拒绝。
