# 半人马AI-万象 · CentaurAI-WANX

**WANX 1.0.0**：万象个人版（CentaurAI-WanX Mini）与万象团队版（CentaurAI-WanX Studio）是两个独立客户端，共用同一套 WANX 后端。源码整合分支为 `wanx1.0`，功能、构建与兼容说明见 [1.0 版本说明](docs/release/wanx-1.0-release.md)。

WANX 服务端运行在盒子中，负责账号、配置、Agent、记忆和用户数据。万象个人版与万象团队版分别负责各自客户端的盒子连接和应用运行，Dashboard 提供盒端业务控制台。

当前万象底座与应用市场代码位于 `apps/personal-client/`，通过 Consumer 账号查询已上架应用、检查版本和下载安装 `.wanxapp`，连接盒子后启动应用。在仓库根目录运行 `npm run start:client`；macOS 和 Windows 打包分别使用 `npm run package:client:mac`、`npm run package:client:windows`。macOS 此命令输出应用目录。详细使用见 [客户端说明](apps/personal-client/README.md) 和 [应用市场说明](docs/applications/wanx-application-market.md)。

阶段 1 的 workspace App Kit 由 `npm run build:app-kit -- --version <version>` 生成，包含带来源摘要和 SHA-256 的 Host SDK 产物，供应用通过 Kit 消费。详见 [WANX workspace App Kit](docs/app-kit/wanx-app-kit-workspace.md)。

应用上架必须随发行包提交图标、Logo、真实产品截图、产品介绍海报与资料索引，详见 [应用上架素材规范](docs/applications/wanx-marketplace-submission-assets.md)（当前为交付与人工审核要求）。

旧 `wanx-desktop/` 和 `wanx-admin-desktop/` 已删除。根目录 `npm start`、`npm test`、`npm run package:mac`、`npm run package:windows` 均指向 `apps/personal-client/`。Dashboard 不再提供盒子管理或 `/boxes` 路由；盒子统一在 wanx-client 中管理。

## 工程结构

| 目录 | 内容 |
| --- | --- |
| `apps/personal-client/` | 万象个人版及客户端公共 Host SDK |
| `apps/team-client/` | 万象团队版 |
| `apps/builder/` | Builder 完整应用（原 wanx-studio），包含独立 Python 后端 |
| `server/` | 万象服务端扩展，包括 Bridge 与剪贴板服务 |
| `shared/` | 跨端共享协议、包与 SDK |
| `octop/` | 原始 Octop 工程，包括后端、Dashboard、CLI 与桌面壳 |
| `docs/` | 万象功能、架构、部署、发布与验收文档 |
| `tools/` | 跨工程构建与打包工具 |
| `vendor/` | 构建所需的固定版本私有 SDK 依赖 |

在仓库根目录运行 `npm run start:mini` 启动个人版，运行 `npm run start:studio` 启动团队版。

## 客户端范围与验收

万象客户端包含 WANX UI 的全部功能，并增加标准 SDK 提供的客户端能力。万象 = WANX = 定制 UI 的 Octop。

### WANX 功能完整保留

现有对话、Agent/专家/团队、任务与自动化、知识库、原生记忆与个性化、技能/插件/连接器/消息渠道、工作区文件、模型与服务商、Token 统计、终端与浏览器、远程电脑/手机、ACP、账号/角色/安全设置、备份恢复和管理员功能均属于客户端范围。继续遵守服务端用户角色及权限，不因桌面封装缩减功能。

验收以各功能真实调用、数据流和操作结果为准，页面资源进入安装包只是构建证据。

### SDK 客户端能力

平台账号与客户端身份、登录/刷新/退出、设备目录与授权、盒子发现/配网/认领、SDK P2P、Octop 原生统一身份与关联、设备管理及 SDK 提供的升级/转移/支持/恢复流程，都要逐项核对接入。桌面端采用对应平台已支持的 SDK 入口；涉及移动平台专属实现、盒端固件或独立知君产品合同的部分，记录适用范围和所需适配，不能直接宣布已具备。

SDK 能力整合到万象产品界面。连接盒子后提供完整 WANX 工作空间；账号与设备生命周期同时拥有完整客户端入口。

### 实现与验收依据

上述内容是产品范围，不等于每项能力已经完成真机验收。当前入口、已采用的架构和检查要求见 [客户端说明](docs/clients/wanx-client.md) 与 [wanx-client README](apps/personal-client/README.md)。设备生命周期、跨网络、Windows 和签名公证等交付项仍须分别核对，不以旧客户端的测试数量或模拟窗口验收代替全功能交付。

## 客户端个人资料与积分入口

头像昵称按万象账号保存在本机，个人资料与快捷面板见 [客户端说明](docs/clients/wanx-client-profile.md)。积分购买、订单恢复、来源分账、赠送、迁移与消费展示已完成开发及隔离联调。Admin 管理支付及投影，QeeToken 保存权威消费余额；生产验收门槛仍未解除。规则、当前状态、客户端流程与上线手册从 [积分文档入口](docs/credits/credits.md) 阅读。

## 本次 GitHub 迁移

本仓库已从旧 DSH 版切换为 Octop 定制版 WANX。旧版提交记录保留，迁移前版本位于 `backup/dsh-before-octop-20261009`。源工程基础提交为 `7d84a99`，同时包含本地现有的 WANX 平台扩展与盒子管理源码。仓库保持私有，包含构建所需的私有 SDK 依赖，不包含本机账号、会话、数据库、日志或安装包。

平台盒子管理由 wanx-client 承担；Octop 原有代码、功能和交付流程保留。当前客户端能力与操作流程以 [wanx-client 说明](apps/personal-client/README.md) 为准。

## 当前客户端

- **盒子连接**：在 wanx-client 登录平台账号、选择已关联的盒子，通过内置网络连接和盒端免登录流程进入服务。切盒释放旧会话和数据流，重新核验权限。
- **原有配置**：继续使用模型、存储、连接器、技能、插件、安全、账号、审计和远程桌面页面，按服务端权限显示。
- **应用中心**：注册产品定义、Agent 模板和所需资源；配置盒子部署与启停；登记安装包版本和推荐版本；开通用户访问；导入、导出清单及生成 SDK 工程。
- **用户隔离**：管理接口仅返回产品与授权元数据。私人实例继续由 WANX 原生模块管理，产品停用不删除用户资料，模板更新不覆盖已有实例。

电脑端通过菜单栏面板和管理窗口提供应用与盒子入口；盒子控制台按需加载盒子自身的 Dashboard。客户端不在电脑上启动 WANX 服务端。

当前入口与依赖说明见 [WANX 客户端说明](docs/clients/wanx-client.md)；待实现的员工运维授权要求见 [身份边界](docs/plans/wanx-admin-v1.md)。

## 构建

### 桌面客户端

源码启动需要 Node.js 22.14+、Go 1.26+；macOS 还需 Xcode Command Line Tools。首次安装或清理旧目录后，在仓库根目录准备 Builder、Dashboard 和所选客户端的依赖：

```sh
npm ci --prefix apps/builder
npm ci --prefix octop/dashboard

# 万象个人版
npm ci --prefix apps/personal-client
npm run start:mini

# 万象团队版：需要时安装并启动
npm ci --prefix apps/team-client
npm run start:studio
```

两版启动前都会从 Builder 源码组装内置应用，并从 Dashboard 构建维护页面，首次还会构建当前平台的网络引擎及系统助手。桌面端直接连接盒子，无需在本机启动 Octop 服务；盒端业务与模型配置由所连接的盒子提供。

### 盒端 Web 控制台

需要在本机开发盒端服务时，另准备 Python 3.12+ 和 uv，在仓库根目录执行：

```sh
uv sync --project octop --frozen
npm ci --prefix octop/dashboard
npm run build --prefix octop/dashboard
uv run --project octop octop run --host 127.0.0.1 --port 8088
```

浏览器访问 `http://127.0.0.1:8088`。需要前端热更新时，保持上述后端运行，另开终端执行：

```sh
npm run dev:web
```

开发页面默认位于 `http://localhost:5173`，API 与 WebSocket 转发到 `127.0.0.1:8088`；后端使用其他端口时，可用 `VITE_API_PORT=18088 npm run dev:web` 指定。

开发检查使用 `make all`、`npm run test:client` 和 `npm run test:team-client`。跨工程测试还需分别准备 `octop/` 与 `server/bridge/` 的 Python 虚拟环境；它们不是桌面客户端正常启动的前置服务。

盒子后端保留现有 Python 包名与 CLI，使用 `uv run --project octop octop run` 启动。`make build-frontend` 构建服务端 Web 控制台。Dashboard 的应用管理 API 和工程导出仍依赖顶层 `vendor/centaurai-wanx-0.1.0-wanx.1-585a760033fa.tgz`，该目录不能删除；适配层源码位于 `shared/packages/wanx-client-adapter/`。wanx-client 使用自己目录下的 `vendor/` 依赖。

## macOS 正式客户端打包资料

以下为 2026-10-28 在当前打包 Mac 上核验的资料。路径中的 `~` 指当前用户 `/Users/longxiping`；换机后须重新导入签名身份并配置公证凭据。

| 项目 | 配置或位置 |
| --- | --- |
| Apple 签名身份 | `Developer ID Application: Zhuhai Qeeshu Technology Co., Ltd. (GLHM545ZLS)` |
| Apple Team ID | `GLHM545ZLS` |
| 证书有效期（UTC） | 2026-03-10 01:41:56 至 2031-03-11 01:41:55 |
| 证书与配套私钥 | 本机登录钥匙串 `~/Library/Keychains/login.keychain-db`；「钥匙串访问 → 登录 → 我的证书」搜索 `Zhuhai Qeeshu` |
| 签名身份 SHA-1 | `4623A2F91CCCBA32FA1357312EC9B523AFD8C6DD` |
| 客户端发行公钥信任文件 | `~/.config/wanx-release/wanx-client-trust.json` |
| 发行 key ID | `release-20261015` |
| 发行公钥 SHA-256（SPKI DER） | `54756023f21c7395981681a438909d6b4eff5e57b09296e0431274729b319aff` |
| 配套 Ed25519 发行私钥（2026-10-29 已核验） | `/Users/longxiping/Public/workspace/qs/ai/centuarai/centuarai-os/.private/ota-signing/release-20261015.pem`；仅在本机签署时使用，不上传 Admin |
| 已配置的 Apple 公证 profile | `WANX-NOTARY`（2026-10-28 已通过 Apple 公证历史查询验证） |

本机已安装有效 Developer ID Application 签名身份，包含配套私钥，可直接用于签名，无需重新申请证书或导出 `.p12`。钥匙串数据库不是可直接交给另一台电脑的证书文件。不要将私钥、`.p12` 或 Apple App 专用密码提交到仓库。

发行公钥信任文件用于验证万象升级发行清单，与 Apple 应用签名证书、公证凭据和 Admin 升级许可密钥分别管理。Admin 的 `WANX_UPGRADE_RELEASE_PUBLIC_KEYS` 必须配置相同 key ID 和公钥；2026-10-29 已修复主 Admin 缺失此配置导致的 `SIGNATURE_INVALID`，同一份团队版 1.0.2 发行 JSON 已在线上运行环境通过验签和上传制品关联字段检查。2026-10-29 已确认上述发行私钥为 Ed25519，导出公钥指纹与信任文件及团队版 1.0.2 构建报告一致，本地测试消息签名/验签通过；文件权限为 `600`，所在 OS 仓库已忽略该文件。`~/.config/wanx-release/release-private.pem` 是另一把密钥，与此客户端信任根不匹配，不可替用。此处只记录路径，不保存私钥内容。信任文件的 `windowsPublisherNames` 当前为空，不影响 macOS 打包；Windows 正式打包前必须填入 Certum 证书的准确发布者名称。

主 Admin 发行公钥的持久配置源为 `/etc/nexusaos-admin-docker/admin.env`。配置变化须通过 Admin-only 发布生成新快照生效，不能只修改容器环境或旧快照。本次配置发布为 `client-release-trust-20261029-1`，沿用原镜像；备份位于 `/opt/nexusaos-admin-docker/config-backups/client-release-trust-20261029-1/`。只部署公钥，发行私钥仍留在本机。本次未关联或推广客户端发行。

### Apple 公证凭据

当前 Mac 已配置 `WANX-NOTARY`，2026-10-28 使用该 profile 查询 Apple 公证历史成功，可复用。历史记录中已有 `QeeClaw` 应用公证通过记录。旧应用配置 `/Users/longxiping/Public/workspace/qs/ai/qs-nexus-aos/scripts/.env.release` 的凭据已验证失败（HTTP 401），不要继续使用。

换机或凭据失效时，登录 [Apple 账户管理](https://account.apple.com/) 的「登录与安全 → App 专用密码」生成新密码；此入口不在 Apple 开发者网站。然后在本机终端交互输入 Apple ID 和 App 专用密码，保存到钥匙串，不将密码写进命令、README 或聊天。这里不能使用 Apple 账户登录密码或验证码：

```sh
xcrun notarytool store-credentials WANX-NOTARY --team-id GLHM545ZLS
```

打包前检查签名身份及公证访问：

```sh
security find-identity -v -p codesigning
xcrun notarytool history --keychain-profile WANX-NOTARY
```

### 正式打包命令

先按上述桌面客户端步骤安装依赖，再从仓库根目录执行。macOS 和 Windows 默认均读取所选客户端 `package.json` 的 `version`；发行前同步对应 `package-lock.json` 的顶层及根包版本。根目录 `package.json` 是工作区元数据，不覆盖客户端版本。

```sh
# 个人版，Apple Silicon
./package-client.sh --edition personal --arch arm64 --formal
# 团队版，Intel Mac
./package-client.sh --edition team --arch x64 --formal
# 两版依次构建
./package-client.sh --edition all --arch arm64 --formal
```

根入口支持 `--edition personal|team|all`，省略时为个人版；`--arch` 支持 `arm64`、`x64`。现有 `apps/personal-client/package-client.sh` 与 `apps/team-client/package-client.sh` 入口仍保留，不需要恢复旧 `wanx-client/` 目录。

可选的 `--version <SemVer>` 仅覆盖本次产物和验证报告，不改写源码版本；省略即可使用 `package.json`。Windows 正式签名入口为 `apps/personal-client/tools/package-client-windows.mjs`（团队版替换目录为 `apps/team-client`），同样支持省略 `--version`，证书与发行信任参数仍需提供。

`--formal` 自动执行签名、Apple 公证、票据装订及校验：公证 profile 使用 `WANX_NOTARY_PROFILE` 环境变量，未设置时使用 `WANX-NOTARY`；发行公钥默认读取 `~/.config/wanx-release/wanx-client-trust.json`。可通过 `--notary-profile` 和 `--trust-file` 显式覆盖。凭据或公钥缺失、无效，或公证失败时终止，不降级为本地包。

本地验证使用 `--local`，不能与 `--formal` 同用；隔离测试参数 `--test` 也不能与 `--formal` 同用。不传 `--formal` 时保留原行为，旧的显式公证与公钥参数仍然有效。团队版使用 `--edition team`；同时构建两版使用 `--edition all`，各版自动使用对应渠道。Intel Mac 使用 `--arch x64`。`--security-epoch` 默认是 `0`；已有发行策略指定其他安全代次时，应显式传入对应值，不因重新打包而随意递增。

客户端源码子树须已提交且干净。默认产物位于对应客户端目录的 `release/client/<版本>/macos-<架构>-<构建标识>/`，包括签名、公证的 DMG、更新 ZIP、`.blockmap`、`SHA256SUMS` 和 `verification-client.json`。以打包退出码及签名、公证、票据装订和校验结果判定成功；构建本身不会上传或推广发行。上传后的签名、验收、推广，以及登录后自动检查、用户下载和确认安装流程，见 [客户端发布与更新流程](docs/release/wanx-client-release-and-update-flow.md)。签名命令及底层约束见 [客户端升级与发行说明](docs/clients/wanx-client-updates.md)。

## SDK 重建与验证

需要重建 Dashboard SDK 时，按 [固定版本与重建步骤](docs/clients/wanx-client.md#重建-dashboard-sdk) 准备 `standard-sdk/`，再运行根目录 `npm run build`。该命令会生成 SDK 包、更新 Dashboard 依赖并构建 Web 控制台；根目录 `npm test` 检查当前 wanx-client。

客户端的网络、盒端免登录部署与真机验收要求见 [自动入网部署说明](docs/bridge/wanx-auto-p2p-deployment.md)。功能范围、隔离约束及检查命令见 [客户端说明](docs/clients/wanx-client.md)。构建和合成测试不代表真实盒子、公网连接、Windows 运行或签名公证已经验收。

## 产品与第三方许可

WANX 产品扩展、SDK 及生成应用是公司私有产品，不以 MIT 对外许可。基础框架与第三方组件保留原有版权、许可和通知，参见 [基础框架许可证](octop/LICENSE)、[基础框架参考说明](octop/README.md) 及各组件内的第三方声明。第三方许可不因产品定位改变而删除或替换。

本次应用商店改版、图标海报与上架规范交付范围及回退说明见 [商店改版分支交付说明](docs/applications/wanx-store-handoff.md)。

后续“应用／积分”命名、页面尺寸统一、卡片整面点击、卸载后介绍保留及快捷面板“盒子”入口的修改见 [客户端界面与快捷面板交付说明](docs/clients/wanx-client-ui-panel-handoff.md)。
