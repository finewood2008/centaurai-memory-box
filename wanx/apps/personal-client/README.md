# 万象个人版 · CentaurAI-WanX Mini 1.0.0

本目录按《万象项目结构与盒端接入设计》提供独立客户端。P2P 用户态引擎随万象一起分发，由万象管理启动、授权、连接和停止；用户不需要另行安装或启动独立网络客户端。默认管理地址为 `https://p2p.qeeshu.com`。

## 1.0 版本

个人版、企业版与共享后端统一在 `wanx1.0` 分支整合。个人版保留现有账号和数据目录；企业版是 `../team-client/` 中的独立客户端。完整变更见 [1.0 版本说明](../../docs/release/wanx-1.0-release.md)。

## 使用与开发

在 `centuarai-wanx/` 根目录运行：

```sh
# 纯 Web 开发：不需要 Go、内置引擎或系统网络客户端
npm ci --prefix octop/dashboard
npm run dev:web

# 桌面源码开发：Node >= 22.14，Go >= 1.26；macOS 还需 Xcode Command Line Tools
npm ci --prefix apps/builder
npm ci --include=dev --prefix apps/starlink/frontend
npm ci --prefix octop/dashboard
npm ci --prefix apps/personal-client
npm ci --prefix apps/memory
npm run start:mini

# 跨工程测试所需的 Python 环境
uv sync --project octop --frozen
uv sync --project server/bridge --frozen
# 客户端与原生引擎测试
npm run test:client
npm --prefix apps/personal-client run test:native
# 盒端 bridge 与原生 Octop 公共接口合同测试
npm run test:bridge
```

客户端运行目录统一装配到 `build/app/`，开发启动与打包都使用此目录。Builder 集成源码位于 `../builder/integration/`，构建不会再向客户端的 `shell/`、`local-ui/` 等源码目录写入副本。`build/` 可删除后重新构建，不要直接编辑其中的文件。

「星图」面板源码位于 [`../starlink/`](../starlink/README.md)，在主窗口内直接提供建仓、资料导入与自动抽取、图谱、检索和本体管理。`build:studio` 自动构建和装配星图，不依赖外部 Starlink 项目或“打开完整版”。接入边界见[迁移说明](../../docs/applications/starlink-panel-migration.md)。

Builder 与 Dashboard 的依赖供启动前的应用组装和维护页面构建使用；只安装个人版依赖不能完成首次启动。桌面端连接盒子时无需在本机启动 Octop 服务。`npm run start:client` 和 `npm start` 仍是个人版入口。

源码启动首次自动构建当前平台的引擎，后续直接使用已有二进制；修改 Go 代码后显式运行 `npm --prefix apps/personal-client run build:network` 重建。打包后的客户端内含引擎，不需要用户安装 Go。

macOS 源码启动同时构建 Swift 盒子名称读取助手，按源码内容缓存；发布包内置该助手，用户无需 Swift 工具链。Windows x64 构建 WinRT 盒子发现助手，发布包也内置该助手。

Web 默认 `http://localhost:5173`，现有 Vite 将 `/api` 和 API WebSocket 转发到 `127.0.0.1:8088`。本机开发后端使用 `uv run --project octop octop run --host 127.0.0.1 --port 8088`，先执行上面的 `uv sync` 准备环境；前端热更新在另一个终端运行 `npm run dev:web`。使用 `VITE_API_PORT=18088 npm run dev:web` 可更换开发后端端口。此入口不导入或启动内置网络；完整 Web 构建和服务步骤见[根 README](../../README.md#盒端-web-控制台)。

桌面客户端登录或恢复账号后自动连接万象网络，未登录时不启动网络引擎。界面不提供网络总开关，也不再读取旧版 `p2p-preference.json` 中的关闭设置；旧文件无需删除。盒子列表保留连接状态，异常时可点击“刷新设备”重试。

1. 使用万象账号密码登录。服务端校验账号与当前客户端身份后自动签发一次性入网凭据，客户端完成注册或恢复；不需要独立网络授权。
2. 登录后独立加载「我的盒子」，网络连接中或暂不可用时也显示已关联盒子。网络自动连接时，为本人盒子的当前客户端准备缺失权限并等待盒端确认；缺少节点映射、授权待同步及无权限分别提示。在列表选择可打开的盒子。地址和权限来自平台，不手工填写 P2P IP，也不展示网络候选节点。
3. 客户端取得盒端签名挑战，向平台申请短时访问票据，再通过 P2P 兑换盒端会话。连接成功后，可在管理窗口的“设置 → 管理与切换盒子”中点击“打开盒子控制台”，无需再输入盒端密码。
4. 「本机 / 开发连接」中的本机或 HTTPS 直连独立于万象网络，不因云端网络暂不可用而禁用。纯 Web 开发继续使用 `npm run dev:web`。
5. 退出万象账号会关闭当前盒子会话并申请撤销网络授权；退出应用保留加密账号会话，便于下次恢复。应用只允许一个实例使用同一网络身份。

万象账号服务默认 `https://boss.nexusaos.qitus.cn/prod-api`，部署时可通过 `WANX_CONSUMER_URL` 指定 HTTPS 服务地址。网络管理地址默认 `https://p2p.qeeshu.com`。管理 API 凭据只配置在服务端，不能分发给客户端。

## 录音文件导入

在「配件 → 随身录音智能体」选择原文件。单个文件最多 16 GiB，按 4 MiB 分块写入本机。导入中断后，重新选择同一原文件可从已保存的位置继续。客户端核对完整文件后归档原音，转写失败时仍可回听。

本机用 FFmpeg 准备录音的处理片段。音频工具不可用时，客户端仍保存原音，工具就绪后可重试。文字转写根据盒端能力逐段处理，合并后的时间戳用于定位原音。支持长录音的盒端可对最长 8 小时的录音做说话人校正，在不同处理段中为同一发言人保留同一个标签。[媒体处理服务](../../server/services/media-processing/README.md#录音的说话人分割)

## 桌面入口与登录启动

客户端标准导航为 **应用 / AI对话 / 空间 / 盒子**。「AI对话」复用众见的模型与会话接口，每轮选择一个模型。切换到另一个模型会开启新对话，保留输入草稿；原对话保留在历史中。同一模型内可连续对话；已取消同题多答。原众见入口统一进入此 Tab。界面直接在客户端渲染，适配小窗口，不另开应用窗口。

切换模型后发送使用现有创建会话接口，同一模型续聊使用原续聊接口，不依赖 `capabilities.model_switch` 或 `FollowUp.models`。本次无需更改或升级盒端接口。详见 [AI 对话接入说明](../../docs/applications/wanx-mini-ai-dialogue-20261022.md)。

AI 浏览器继续作为独立应用，在应用页或托盘快捷面板中打开，不嵌入客户端主窗口。原有盒子用户浏览器资料、登录状态、线程及学习草稿保留。

本次提交的功能范围、素材与验证记录见 [个人版 AI 对话分支说明](../../docs/applications/wanx-mini-ai-conversation-release-20261022.md)。

0.1.2 变更、验证结果及 Windows 验收步骤见 [分支说明](../../docs/clients/wanx-client-0.1.2-tray-startup.md)。

macOS 菜单栏与 Windows 系统托盘均以快捷面板作为日常入口：单击图标打开或收起面板，直接查看盒子状态、打开已安装应用；点击「设置」或「浏览应用商店」再进入管理窗口。点击其他位置收起面板，关闭管理窗口继续后台运行。Windows 弹窗适配顶部、底部和侧边任务栏以及多屏工作区。

安装版 macOS 和 Windows 首次启动默认开启「登录电脑时启动」，登录时只在后台运行，不自动弹出管理窗口。用户在应用或系统设置中关闭后，后续启动保留选择。Windows 注册实际安装程序路径与静默启动参数；普通 Electron 源码调试进程不会注册为登录项。

## 账号、设备与权限

平台复用现有 Consumer 账号、AppClient、Owner/Grant 和成员授权。新网络控制面校验这些事实，登记当前客户端 peer，并维护该客户端到已授权盒子 TCP 8088 的精确策略。不会把所有账号加入同一共享访问组，网络节点列表也不代表盒子归属。

账号私钥和刷新凭据使用操作系统加密存储；账号切换隔离网络身份。入网码、平台票据和 bridge 短期会话留在主进程，Dashboard 仅取得当前临时网关的随机会话标识。原生 Octop JWT 由盒端 bridge 私有持有。盒端签名挑战一次性消费，短租约续签持续核验权限。正常续签保留 SSE/WS，授权到期或变更后关闭旧会话；原生 Octop JWT 到期时仍按原有行为重连。

盒端功能位于独立 [`server/bridge/`](../../server/bridge/README.md)，通过 Octop 公共 HTTP/OIDC 接口建立业务身份。本功能不需要修改 `octop/src/octop`。公开 P2P 端口由 bridge 接管，原始服务与内部 OIDC 仅监听 loopback；不能把旧的原始业务端口继续对外公开。

**源码接入不代表生产环境已部署。** 启用前需要平台数据库迁移、网络服务配置、可信盒子 peer 登记、盒端签名公钥登记及 SSO 密钥配置，参见 [自动入网与盒端免登录部署验收](../../docs/bridge/wanx-auto-p2p-deployment.md)。缺少这些配置时会明确失败，不退回要求普通用户登录网络后台。

## 结构与传输边界

```text
apps/personal-client/
├── platform.mjs        账号登录、自动入网、授权目录与续租编排
├── account/            Consumer 签名请求、账号身份与系统加密存储
├── client.mjs          连接生命周期、取消、盒子切换
├── network/            内置进程管理、NDJSON 控制、专用 CONNECT Agent
├── native/             Go P2P 用户态引擎、设备授权、受限隧道服务
├── shell/              Electron、受限 IPC、独立临时浏览器会话
├── local-ui/           应用首页、菜单栏面板、账号与盒子设置
├── octop/              盒端会话兑换、健康检查与 HTTP/SSE/WebSocket 代理
├── tools/              引擎编译、首次源码启动检查
└── tests/              网络、生命周期、代理、授权及窗口回归
```

`local-ui/renderer/discovery-selection.js` 管理设备发现与选择，提供 `start / choose / reset / dispose`；通过回调交付展示快照、提示和选中的候选。扫描与重选在点击调用栈内同步触发蓝牙 chooser，12 秒扫描超时仍由现有 transport/picker 处理；非空结果保留 2 分钟，重选失败不续期，到期会取消仍在进行的重选。`reset` 清理选择并隔离迟到结果，`dispose` 额外解除 Discovery 订阅，不关闭共享 GATT transport。页面、Wi-Fi 表单及 `wanxSetup` 配网编排仍由 renderer 和现有主进程实现负责；返回设置只清理选择，显式取消才调用配网取消。

`createNetwork()` 提供 `snapshot / subscribe / setEnabled / refresh / resolveEndpoint / login / enroll / close`。默认 disabled，不启动子进程。内置引擎使用应用自己的配置目录、peer 私钥和随机网络端口，不读取或控制系统网络客户端 服务。

启用后每 1 秒通过本地 IPC 读取引擎状态，状态不变时不通知界面，关闭后停止轮询。这会将原来最多约 15 秒的状态显示滞后缩短到约 1 秒，不增加平台接口请求频率。该时间不包含切换 Wi-Fi/手机热点后的隧道重建、网络检测和重试耗时，不能视为跨网络连接的总恢复时间。源码修改后须重新启动客户端；已安装版本需要更新客户端包，单独更新盒子不会生效。

P2P 模式所有拨号都经内置引擎：包括 `/api/health`、普通请求、上传下载、SSE 和 WebSocket。JS 通过仅回环监听、随机令牌保护的 CONNECT 通道连接 Go 引擎；Go 核对目标当前 peer 后调用 `embed.DialContext`。失败不会回退系统 TCP。真实目标的 Host、Origin 和 HTTPS 证书校验保持不变，隧道令牌不发送给盒子或渲染页面。

Dashboard 按需在独立临时 Electron session 中打开，不随连接自动弹出；重复点击会聚焦已有窗口。盒子页面无 Node、preload 或控制 IPC。关闭 Dashboard 只清理其窗口和浏览器会话，不断开盒子或影响应用；切换、断开盒子及退出登录会关闭旧 Dashboard。Dashboard 继续来自盒子自身，原有业务页面与 API 不修改。

## 桌面图标与菜单

应用首页通过在线市场 API 查询候选、授权下载并验证签名安装包。应用包可复用万象运行时（`launchMode: "shared"`，默认），也可自带完整 Electron（`launchMode: "bundled"`，需声明系统/架构并接入 SDK 的 Electron 生命周期 helper）。同一应用只展示一个当前版本，安装更高 SemVer 版本后在下次打开时完成旧进程回收并切换；历史版本无法比较时先选择当前版本。停止和退出会等待应用主进程退出，超时强制终止，回收失败会明确报错。完整包的入口是包内可执行程序；`.dmg`、`.msi` 或安装向导 `.exe` 不能直接导入。本地 ZIP／目录安装保留为默认关闭的开发 IPC 入口，正常页面不展示。包结构与接入示例见 [WANX Host 应用接入](../../docs/applications/wanx-host-app-integration.md)。

Host 和共享运行时应用启动经过 `shell/entry.mjs`：普通启动进入 Host；市场 `--wanx-managed-app` 子进程先验签，开发包 `--wanx-application` 子进程校验本地记录，两者都只加载已安装清单指定的 JS 入口，在 Host 单实例锁和网络初始化之前分流。开发启动会额外传入万象的 `build/app/` 运行目录，打包版直接复用可执行文件，不能依赖只适用于默认 Electron 启动器的 `--app` 参数。独立运行时应用直接启动包内可执行程序，通过 SDK helper 对接相同的启动协议。两种应用均使用独立 Chromium 数据目录，窗口完成首次页面加载后才向父进程报告启动成功；提前退出、加载失败或 30 秒未就绪会撤销该启动会话，并在首页提示重试。业务 API、Host SDK 的传输接口和 Web/LAN 模式不变。

发布前可设置 `WANX_PACKAGED_EXECUTABLE` 为打包程序的可执行文件路径，运行 `node --test tests/packaged-application-seam.test.mjs`。该 seam 使用临时用户目录，验证真实打包进程进入 manifest 入口，以及应用异常时返回失败，不会读取真实盒子或账号。

正式桌面应用名称为“万象”（macOS 为 `万象.app`），界面品牌为“半人马AI-万象”，英文为“CentaurAI-WanX”。应用包及窗口内保留现有橙蓝半人马原图；窗口和快捷面板的 Logo 是“关于万象”按钮，打开系统关于弹窗。macOS 菜单栏使用原图轮廓的单色模板图标，保留透明背景，提供 22 像素及 44 像素 Retina 资源，由系统适配明暗外观；Windows 托盘保留彩色多尺寸图标。资源位于 `resources/`，macOS 执行 `npm run build:icons` 从 `local-ui/renderer/assets/centaurai-mark.png` 生成。桌面名称调整不改变包名、应用 ID、账号目录或加密存储身份。

macOS 的日常入口为菜单栏快捷面板（宽 400 像素、最高 560 像素）：左击开关，右击提供设置、关于和退出；点击外部或 Escape 收起。宿主不占 Dock，具体应用继续使用正常窗口和 Dock。面板优先显示我的应用，盒子一行仅显示当前名称和状态，底部进入应用商店。管理窗口约 860×640，顶部为“应用商店／设置”；低频的盒子管理和切换归入设置，登录和蓝牙配网仍只在这个持久窗口完成。关闭仅隐藏，保留输入和任务。Windows 保留窗口入口和托盘交互。

打开应用时，已连接盒子会直接启动或唤起原应用；没有连接时先选择并确认盒子。上次成功连接仅按账号和服务环境记录设备 ID，作为预选项，绝不代替授权或用户确认。配网完成仍需确认连接并打开。取消、退出登录或手动切盒后，迟到结果不能继续打开应用；切盒不会把已有应用静默转向新盒子。

主进程统一广播连接、已安装应用和按应用区分的操作状态。安装、更新、卸载、回退和版本选择完成后两窗同步；安装无需盒子连接，隐藏窗口继续执行。快捷面板使用独立 preload 和窄 IPC 白名单，不提供账号写入、市场变更、手动连接/断开/刷新盒子或蓝牙接口；未连接时仍可通过专门的请求、确认和取消接口完成“连接并打开应用”。配网仍校验管理窗口的 webContents、主 frame 和完整本地 URL。

macOS 扫描期间通过 CoreBluetooth、Windows x64 通过 WinRT 只读公开 Device Info，使用同一个外设的精确标识对接 SDK 候选。发现列表按完整 Registry ID 查询平台库存的设备名称，也可显示当前账号中的名称或盒端提供的非通用名称；名称不可得时明确显示“未获取到盒子名称”，不将库存编号、设备 ID 或蓝牙广播代码作为名称。设备编号和广播名仅作核对用的辅助信息，不按后缀或列表顺序猜测身份。Windows 扫描约 32 秒，单台 GATT 读取最多 25 秒、最多 3 台并发；macOS 单设备连接最多等待 5 秒，连接成功后独立给予服务发现与名称读取 3 秒，未读到身份的设备在队列末尾最多重试一次，整次扫描受约 30 秒总时限约束。名称和认领状态随读取结果更新，设备准备好后即可选择，无需等待整轮扫描结束。助手不写入配置，取消后断开；公开信息仅用于显示，选中后仍走原有受验证的配网身份流程。

扫描列表取得完整设备身份后，还通过已登录的只读接口 `/app-api/v1/device-discovery?ids=...` 查询名称与认领状态，每批最多 16 台。库存名称不依赖当前账号是否已经认领盒子；卡片分别显示“已认领”“未认领”或“认领状态待确认”。当前账号明确具有 owner/member 角色的设备也可显示“已认领”。平台缺少接口、离线、身份不完整或记录不明确时保留本地名称及未知状态，不把“当前账号查不到盒子”当成未认领。每轮扫描刷新，退出或切换账号后旧查询结果失效。接口只返回 `deviceId/deviceName/claimStatus`，不会公开主人信息；状态用于展示，不授予认领权限。此功能需要同时更新平台 Admin 和万象客户端；旧客户端或旧平台保持原有配网行为。

公开身份允许展示尚未登记或配对窗口已关闭的盒子，但不能据此进入配网。界面和宿主在确认身份时检查登记状态及配对窗口，分别提示完成平台登记或重新开启配网模式；这些检查不会替代 SDK 的后续身份、协议和会话校验。配网错误使用单独文案，不再回退成应用市场错误。

身份验证后，配网页自动扫描盒子附近的 Wi-Fi，按信号强度提供选择，并按网络安全类型显示密码输入。刷新保留已选网络及输入；隐藏网络可手工添加。不支持的安全类型不会当作开放网络连接。扫描来自盒端无线网卡，经过现有 V2 加密蓝牙会话返回，结果仅存于内存，不写入日志或配网恢复记录。盒端在后台扫描，列表分页传输，避免超过蓝牙帧上限或阻塞配网；旧盒端不支持时会提示扫描失败，可更新盒端配网组件或使用手工输入。此功能需同时更新盒端 discovery 组件和客户端，客户端源码更新后需重新启动。

已关联盒子的主人可直接从盒子卡片点击“配置网络”，盒子离线或万象网络暂不可用时也可进入。此入口通过蓝牙完成“发现盒子 → 验证身份和主人权限 → 配置 Wi-Fi”，保留归属和数据，不提交认领或要求认领码；电脑仍需联网验证主人权限。从卡片进入时固定完整设备 ID，扫描展示信息只用于辅助选择，主进程收到盒端身份后必须核对目标，再继续身份验证；误选其他盒子会停止，失败或取消后可重新扫描同一目标。此能力沿用现有 Owner Wi-Fi 协议及盒端支持，本机服务和普通成员不提供主人配网入口。

认领码统一放在“添加盒子”向导：已联网盒子输入认领码后确认绑定；未联网且有码时，先输入码验证配网权限，再发现并确认盒子、连接 Wi-Fi，最后明确确认绑定；没有码时继续使用原有蓝牙身份验证、配网和认领。有码配网使用独立 `console-wifi` 签名许可，只允许本次会话修改 Wi-Fi，不消费码、不创建主人关系，也不提交 BLE 认领证明。配网及最终兑换均固定完整设备 ID；取消、返回或账号/客户端变化会清理内存中的码。兑换成功后等待 bootstrap 的真实设备授权状态，只有当前账号、客户端和目标设备均具备连接权限才显示就绪；返回设备列表时刷新目录。认领码输入不会写入日志或恢复记录。

未联网有码分支需要同步升级 Admin（`device-console-claims/wifi-attestation`、`wifi-authorize`）、CentaurOS discovery 配网组件以及万象客户端，并启用平台已有认领码功能。仅更新客户端不能使线上旧服务支持这一分支。已认领盒子的“配置网络”入口继续使用原 Owner Wi-Fi 协议。配网密码默认隐藏，输入框内可切换显示；当前界面隐藏所有权转移入口，后端能力不变。

配网 SDK 的本地补丁允许公开 `display_name` 使用 1–64 个 UTF-16 单元的名称，拒绝控制字符和不完整代理字符；仍兼容旧的 `CentaurAI Box`。补丁通过 `node tools/patch-provisioning-display-name.mjs` 从校验过的 vendor 原包重建，输出独立版本并由锁文件固定。Device Info 的原始字节保持不变，继续参与握手哈希校验；设备身份、证书、字段集合、规范 JSON 和 512 字节上限保持原有约束。更新 SDK 后需重新启动客户端，单纯重新扫描不会替换主进程已加载的 SDK。

手动打开显示面板；“登录电脑时启动”默认不登记，只有打包 Mac 应用中用户主动开启时才写系统设置，并重新读取系统结果。由登录项启动时静默运行，开发预览不会登记登录项。设置中的“退出当前账号”结束账号会话并断开盒子，宿主继续运行；系统应用菜单或托盘右键菜单中的“退出万象”会先说明所承载的应用和盒子连接将关闭，再等待应用及网络清理，并保留加密账号会话供下次恢复。关闭面板或管理窗口保留底座运行。

`Cmd/Ctrl+1` 打开日常入口，`Cmd/Ctrl+,` 打开设置，`Cmd/Ctrl+Shift+D` 打开当前盒子的控制台。配网向导期间保留当前步骤。编辑、缩放、全屏和窗口操作使用系统菜单能力。

`npm start` 在 macOS 创建并缓存独立的 `release/dev/万象.app` 开发运行包，更新名称、图标后进行本地 ad-hoc 签名。源码仍直接从当前项目加载，Electron 依赖原包不会被修改。Dock 悬浮名称、菜单和安装包均显示“万象”；`package.name`、既有账号、安装目录及系统加密存储身份保持不变。直接运行 `electron .` 会绕过这一步。非 macOS 开发启动保持原有运行方式。

## 构建与分发

Windows 安装向导提供安装位置、实际进度和完成三个步骤。标准、正式签名及内部打包入口共用安装脚本。维护与验收步骤见 [Windows 安装体验](../../docs/clients/wanx-windows-installer.md)。

应用市场的包格式、版本比较、签名与后台发布流程见 [WANX 应用市场开发与发布](../../docs/applications/wanx-application-market.md)。

应用提交方还必须随安装包交付图标、Logo、真实产品截图、1–3 张产品介绍海报及资料索引；具体规格与人工审核标准见 [应用上架素材规范](../../docs/applications/wanx-marketplace-submission-assets.md)。当前六款内置介绍页使用产品海报，不再展示本机采集的界面截图。

```sh
# 当前平台，或一次构建 macOS/Windows 两种架构
npm --prefix apps/personal-client run build:network
npm --prefix apps/personal-client run build:network:all
# macOS 名称读取助手，默认当前架构；可追加 darwin-arm64 darwin-x64
npm --prefix apps/personal-client run build:discovery

# 在相应平台按当前 Node 架构打包
npm --prefix apps/personal-client run package:mac
npm --prefix apps/personal-client run package:windows
```

引擎输出到忽略版本控制的 `native/bin/`；electron-builder 按目标平台/架构把对应引擎复制到应用的 `resources/network/`。构建同时收集模块版本与许可证文件。没有发布签名证书时，本机验证产物不等同于已签名、公证的正式安装包。

客户端打包通过 `afterPack` 强制检查交付目录中的网络引擎和发现助手：缺失、空文件、执行权限不正确或与本次构建输入不一致都会停止打包；同平台同架构还会执行无账号的引擎状态检查。带品牌的 Electron 运行包即使返回 `isPackaged=false`，从 `Resources/app` 加载时也使用 `resources/network`。更新须交付完整应用及匹配的网络组件，避免只覆盖源码。详细规则与回归命令见[网络组件打包与更新校验](../../docs/clients/wanx-native-packaging-20261019.md)。

macOS 正式客户端请从仓库根目录运行独立入口（市场应用使用 `apps/personal-client/package-app.sh`）：

```sh
./package-client.sh --edition personal --arch arm64 --formal
# 仅本机验证签名、版本和 DMG 完整性，不提交 Apple 公证：
./package-client.sh --edition personal --arch arm64 --local
# 企业版正式包：
./package-client.sh --edition team --arch arm64 --formal
# 依次打个人版和企业版正式包：
./package-client.sh --edition all --arch arm64 --formal
```

统一入口支持 `--edition personal|team|all`，省略时仍打个人版。`apps/personal-client/package-client.sh` 与 `apps/team-client/package-client.sh` 仍保留为版别入口。企业版默认输出到 `apps/team-client/release/client/<版本>/`；`all` 依次调用两个版本的构建脚本，任一失败即停止。使用 `--out <目录>` 时，单版直接使用该目录，`all` 分别写入 `<目录>/personal/` 和 `<目录>/team/`，目标目录必须尚不存在。个人版、企业版默认更新渠道分别为 `stable`、`stable-studio`；`all` 不接受共用的 `--channel`，需要自定义渠道时请分别打包。首次打包先按[源码开发步骤](#使用与开发)安装各工程依赖。两版脚本都会自动构建所需的 Builder 资源。

个人版打包会装入记忆界面和独立运行时。构建机的 Node、Electron 和安装的原生依赖必须与目标系统及架构一致。发布 arm64 和 x64 时分别构建。正式打包会通过成品的 Electron 验证 SQLite、向量扩展和本地记忆服务，并将结果写进 `verification-client.json` 的 `memoryRuntime`。

脚本生成当前版别的 DMG、更新 ZIP、`.blockmap`、`SHA256SUMS.txt` 和 `verification-client.json`，默认输出到 `apps/personal-client/release/client/<版本>/` 下的新目录。macOS 和 Windows 正式打包默认读取所选客户端 `package.json` 的 `version`。可选 `--version` 只覆盖本次安装包元数据与验证报告，不改源码 `package.json`；`--arch` 可选 `arm64` 或 `x64`。

`--formal` 复用完整正式流程：Developer ID 签名、DMG 与 ZIP 的 Apple 公证、应用及 DMG 票据装订和校验。默认公证 profile 为环境变量 `WANX_NOTARY_PROFILE` 或 `WANX-NOTARY`，默认发行公钥为 `~/.config/wanx-release/wanx-client-trust.json`；显式 `--notary-profile`、`--trust-file` 优先。首次使用需通过 `xcrun notarytool store-credentials WANX-NOTARY --team-id <Team ID>` 交互配置 Apple ID 和 App 专用密码。本机证书及公钥位置见[根 README 的打包资料](../../README.md#macos-正式客户端打包资料)。

`--formal` 不能与 `--local` 或 `--test` 同用。配置无效、公证失败都会停止，不降级为本地包。`--local` 产物不能作为正式公证包分发；不传 `--formal` 时兼容原来的显式公证与公钥参数用法。正式构建前须提交客户端改动，确保源码干净。Windows 正式签名入口见[客户端升级与发行说明](../../docs/clients/wanx-client-updates.md)。

网络引擎依赖基线为 `0.80.0`、Electron `37.10.3`；具体第三方模块与许可证随构建产物保留。WANX 基线 `6563103` / Octop `1.0.2b4`。不会读取 Octop 数据库、导入 Python 私有模块，或依赖即将退役的 `nexusaos-app`。旧 `wanx-desktop/`、`wanx-admin-desktop/` 已删除；Dashboard 作为盒端控制台保留，盒子管理统一在本客户端完成。

## 验证边界

客户端测试覆盖账号签名和加密存储、自动入网恢复、目录授权、盒端会话兑换、取消与切换竞态、硬租约截止、HTTP/SSE/WS 代理及 UI/IPC 边界。平台和独立 bridge 另有真实签名、重放、权限版本、过期与长连接续租集成测试。`npm run test:bridge` 使用 `server/bridge/` 的独立 Python 环境验证真实 Octop 公共接口，不代表 bridge 发布包依赖 Octop。执行记录见 [设计方案验收记录](../../docs/plans/wanx-account-auto-p2p-plan.md)，旧版内嵌认证的测试数字不能替代本轮 bridge 验收。

本地测试使用隔离账号、模拟管理服务和本地盒端服务；尚需按部署文档使用实际账号和盒子验证跨公网直连/relay、绑定关系、策略撤销及完整登录流程。Windows 安装包运行、正式签名和公证另需发布环境验证。

### 启动耗时诊断

客户端默认将诊断写入 Electron `userData/logs/connection-timings.jsonl`；macOS 源码运行通常位于 `~/Library/Application Support/centuarai-wanx-client/logs/`。文件达到 512 KiB 后轮换为 `.previous`，只保留当前与上一份日志。`WANX_CONNECTION_TIMINGS=1 npm --prefix apps/personal-client start`（仓库根目录）额外开启控制台输出。

日志包含步骤、完成/失败状态、耗时，以及白名单内的错误码和 HTTP 错误状态码。`network.state` / `platform.state` 仅在状态变化时记录阶段和原因，可区分引擎退出、超时、授权拒绝与租约到期，并观察后续恢复；未知错误统一记为 `UNKNOWN_ERROR`。不写入请求地址、参数、账号、设备标识、令牌、响应正文或错误消息/堆栈。`client.initialize` 包括账号恢复、权限准备、平台会话恢复及引擎启动，不代表点击盒子后的业务页面加载耗时。

配网诊断也默认开启，无需修改盒子或设置环境变量。`setup.transport` 的 `completed` 仅表示传输返回；`setup.protocol` 记录 Wi-Fi 提交和任务查询响应的 AEAD 认证结果，`authenticated` 不代表后续响应格式校验或配网成功。其 `responseStatus` 和封闭枚举 `deviceErrorCode` 可区分设备返回的 `protocol_error`、网络失败及本地授权拒绝；`setup.flow` 记录客户端阶段和最终错误码。因此看到 `PROTOCOL_CHANGED` 时，应结合相邻的这两类记录排查，不能直接认定需升级盒端。复现后尽快收集该日志及 `.previous`，避免轮换覆盖；日志不包含 Wi-Fi 名称、密码、密钥或解密正文。

`box.connect` 记录一次连接操作的总耗时；操作期间的日志带随机 `connectionId`，用于区分并发连接，不关联账号或设备身份。`box.directory` 表示实际等待目录刷新，`box.endpoint`、`box.health`、`box.session`、`box.gateway` 分别表示端点解析、健康检查、会话授权和本地代理创建，`box.cleanup` 表示连接层清理。`box.session` 包含已有的 challenge、grant、exchange 子步骤，嵌套或并行耗时不能相加；操作返回后，后台续期不再带这次连接 ID。

`account.grant.headers` 记录发起授权 HTTP 请求到收到响应头的时间，`account.grant.body` 记录读取响应体时间；`account.grant.refresh` 表示该请求在等待账号续期，续期自身分为 `account.refresh.http` 与 `account.refresh.persist`（含存储队列等待），401 后的第二次授权请求另记 `account.grant.retry`。因此 `box.grant` 不是纯服务端执行时间。Admin 开启 `WANX_CONNECTION_TIMINGS=1` 后，`account.grant.response` 会记录服务端随机 UUID `requestId` 和 `serverDurationMs`，可与服务端 `wanx_network_timing` 对齐；服务端计时包含路由依赖，不包含请求抵达路由前的代理及事件循环排队。

已有有效网络租约时，新建连接优先使用当前会话内已验证的设备地址，仍向平台申请新的 SSO 授权。重复选择已经健康连接的同一盒子，且当前身份、授权版本、地址及未过期 token 都一致时，直接保留该连接，不重新授权或延长租约，并记录 `box.reuse`；统计新建连接的延迟时须排除这些幂等选择。首次缺少地址或已知地址发生可达性故障时会刷新目录；后者对同一设备最多重试一次。显式断开、权限拒绝、租约到期、退出或切换账号后不能用旧连接或缓存授权降级连接。

`setup.transport` 记录蓝牙连接、身份读取和配网协议请求的结果、耗时、尝试次数及本地请求关联 ID。失败时可区分 Renderer 返回、IPC 截止时间、取消和页面生命周期清理；GATT 连接失败另外保留固定阶段（连接、服务发现、特征发现、开启通知）和标准异常名称。协议日志仅保存白名单消息类型，不记录帧内容、SSID、密码或配对令牌。蓝牙 SDK 超时或断开后立即结束请求，迟到的原生写入回调不会继续发送剩余分片，也不会自动重放配网或认领写入。

临时入网、续期或引擎故障会自动重试，等待间隔从 5 秒逐步增加，最长 60 秒，成功后复位。退出登录、客户端关闭、授权拒绝和硬租约到期会停止对应重试；重新建立连接必须重新取得有效平台授权。修改客户端源码后需重启万象生效。

已连接的盒子每 30 秒检查一次真实 `/api/health`（经原连接通道，单次超时 8 秒，不依赖 Admin 的在线状态）。检查失败后立即进行第 1 次自动恢复，之后每次等待 30 秒，最多 3 次；检查与恢复串行执行。短时中断保留原会话和应用连接，底层网络进程重建导致通道失效时，通过原认证流程重建盒端会话。恢复成功后重新开始检测；3 次均失败则断开并提示手动重连，不自动循环下一轮。界面显示重连次数并可点击“停止重连”。主动断开、切换盒子、退出账号、关闭客户端或权限失效会取消恢复，迟到结果不会恢复旧连接。这里的 3 次是选中盒子的恢复预算，不改变内置网络引擎自身的后台恢复策略，也不会重放未完成的业务请求。

应用提交方还必须随安装包交付图标、Logo、真实产品截图、1–3 张产品介绍海报及资料索引；具体规格与人工审核标准见 [应用上架素材规范](../../docs/applications/wanx-marketplace-submission-assets.md)。当前六款内置介绍页使用产品海报，不再展示本机采集的界面截图。
## 私人记忆盒子接入

「我的 AI」的 CLI 任务支持 Windows 与 macOS。Windows 使用独立 PowerShell 窗口展示提示词、工作目录和资料范围，按 Enter 后重新核验当前账号与盒子授权，再启动 CLI；关闭或取消不会执行任务。支持已安装的原生可执行程序，以及 Codex、Gemini、Claude Code 的标准 npm 安装入口。修改启动器后需退出客户端，再运行 `npm run start:mini` 重新组装；运行中的网络引擎会占用 `build/app` 文件，关闭窗口可能只隐藏客户端，应从应用菜单退出。

Windows 终端通过系统 ShellExecute 打开，核对助手写入就绪回执后，页面才显示「终端已准备任务」。窗口未就绪会报错，不会把创建后台进程当作任务已打开。记忆使用万象模型时，Octop 必须注册 `/api/wanx/memory-model` 及 `/complete`；日志返回 404 表示盒端接口尚未加载，需更新并重启对应 Octop 服务。

Windows 核对窗口显式设置控制台输入、输出及 PowerShell 管道为 UTF-8。Electron 在真实控制台中可能仍将标准输入指向 NUL；核对助手会重新打开自身控制台的 `CONIN$`、`CONOUT$`，确认后关闭核对读取器，使用独立输入句柄启动 CLI，避免抢走 CLI 后续按键。npm 安装的 CLI 使用入口旁或 PATH 中的 `node.exe` 执行已验证的包入口；未找到 Node 时提示修复安装。核对助手完成就绪回执后才创建确认输入，输入关闭会清理任务并提示未启动；真实管道和文件输入保留原有语义。Electron 核对进程通过 `Start-Process -NoNewWindow -Wait` 保持终端连接并等待退出。

`WANX_TEST_CONSOLE=1 node --test apps/personal-client/tests/my-ai-launch.test.mjs` 在 Windows 下额外验证隐藏的真实控制台：只向测试控制台注入按键，检查核对、原生及 npm CLI 连续交互、取消；不启动真实 Agent。PowerShell 可先执行 `$env:WANX_TEST_CONSOLE='1'` 再运行测试。该测试需要 .NET Framework C# 编译器及创建控制台权限，使用 Job Object 在结束时清理全部测试子进程。

`wanx-memobox` 的星图部分由盒端原生 Semantica MCP `/mcp/starlink` 提供。客户端通过现有盒子网络通道执行 MCP 初始化、工具发现和调用，按盒端实际清单暴露 `xingtu_*` 工具及其原始参数和结果，包括仓库、材料、图谱、检索、证据及推理工具。对外不再注册 `starlink_warehouses/search/evidence`；侧栏等客户端内部检索保留既有业务接口。空间与记忆工具保持原入口。

`space_read` 读取授权范围内的原文件，并复用隔离提取器处理 HTML/HTM、XML、TSV、PDF、DOCX、XLSX、PPTX。HTML 不执行脚本或加载链接，扫描 PDF 不提供 OCR。文件读取前后校验位置、版本、大小和摘要；解析结束后再次检查任务授权。文档及较大文本支持至 64 MiB，提取正文最多 32,768 字符；返回 `extractedFormat`、`contentTruncated`，每页最多 12,000 字符，通过 `nextStart` 继续读取。128 KiB 以内原有纯文本格式保留直接读取方式。`space_search` 除原有文本扫描外，单次最多提取 4 份不超过 4 MiB 的文档，每份限定 5 秒；超限或提取失败时仍可按文件名匹配，并报告跳过数量。

每个原生星图工具额外接受路由参数 `task_id`、`warehouseId`，转发前移除这两个字段。任务 ID 绑定本次选定的仓库；未指定任务时使用已保存的仓库选择。一次授权全部个人资料且存在多个仓库时，须从工具参数的 `warehouseId.enum` 选择目标仓库。原生 `xingtu_evidence` 使用 `evidence_id`；推理工具的嵌套参数遵循盒端发布的 schema。

原生 MCP 使用内部创建的仓库 Key，仅包含 `documents/evidence/graph/search/reasoning` 权限，有效期一天；同一进程复用各仓库 Key，只保存在主进程内存，不写入外部 Agent 配置或交给页面。退出客户端时撤销；账号、盒子或会话切换后丢弃旧连接并尝试撤销，断网或旧会话失效无法撤销时由到期时间兜底。盒端须支持原生 MCP 和仓库 Key 接口，失败不会降级为旧星图业务接口。源码更新后先退出并重新启动万象，再重新打开外部 Agent，让其加载新的工具清单。

新建调试资料目录使用独立记忆库。概览加载完成但数量全部为 0 时，可在「我的 AI → 采集与备份设置」选择本机来源并执行采集，或在「从备份恢复」恢复已有快照；自动采集按当前设置执行。

Codex 等智能体通过 MCP 连接本机记忆盒子客户端。客户端读取本机记忆，并通过已授权的 P2P 连接查询盒端空间和星图。「测试连接」检查本机 MCP 服务，可以在盒子离线时测试已配置的连接。「等待智能体加载」表示本机 MCP 配置已保存，正在等待智能体加载工具。资料检索还需要当前账号和授权盒子的有效会话。

万象个人版登录后默认打开「记忆」。启动本机的半人马AI私人记忆盒子后，万象会使用它的记忆服务和数据库。「设置 → 记忆」可配置模型、来源扫描及用量预算，并管理本机记忆数据。

源码版启动时会检查本机记忆服务。缺失的进程由客户端拉起。「重新连接记忆服务」会重新检查进程，等服务就绪后继续读取原记忆库。

默认启动使用仓库内的 `apps/memory`，首次先执行 `npm ci --prefix apps/memory`，之后直接从仓库根目录运行 `npm run start:mini`。启动流程构建记忆前端、Memory 与 backend，并将适配 Electron 的服务准备到 `build/local-memory`；后续按源码摘要复用缓存，`build:studio` 重建应用目录后也会恢复记忆界面。`WANX_MEMORY_BOX_ROOT` 仅用于覆盖为另一份源码。若设置 `MEMMY_RUNTIME_CONFIG_PATH`，客户端会连接指定的外部管理服务，不再准备第二套本机后端。


Windows x64 个人版随包携带 FFmpeg 和 FFprobe，安装版从 resources/audio-tools 调用。构建脚本 tools/package-audio-tools.mjs 按 tools/audio-tools-win-x64.json 固定的版本和 SHA-256 准备组件，首次获取后复用本机缓存。源码 Windows 正式包、预览包及内部包入口共用该准备步骤，打包台也执行同一步骤。组件缺失、摘要不匹配、架构不符或缺少 libopus 会停止构建。随包 LICENSE.txt、COPYING.GPLv3、SOURCE.json 和 BUILD.txt 记录许可证、来源及构建参数。
