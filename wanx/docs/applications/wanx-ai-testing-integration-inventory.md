# 万象自动化测试实施附录：现有入口与接入清单

核对日期：2026-11-02。本文是技术方案的实施附录，依据当前工作区源码、包脚本和 workflow 静态核对。只新增本文；没有运行打包、签名、公证、全套测试、外部模型或客户环境操作。现有配网诊断改动未修改。下文“现有”指代码中已存在的能力，不代表本轮已执行通过；“拟建”路径和命令尚不可运行。

## 1. 接入边界

首轮复用现有测试与制品验证，在 `tests/acceptance/` 下拟建独立 TypeScript/Node 验收包。确定性脚本、公开 API 断言和系统 UIA/AX 操作优先执行，AI 只处理探索、视觉定位和需要语义判断的步骤。不要将所有已有测试改写成每步调用模型的 Agent，也不要建设新的业务 SaaS。

个人版、企业版、Studio、dashboard、bridge 和 Octop 后端是不同入口。根 `npm test` 目前只转到个人版，`make all` 目前也不等于全产品验收。依据：[根 package.json](../../package.json):8–25、[Makefile](../../octop/Makefile):201、222–224。

企业版不是个人版的纯皮肤：其打包清单显式排除本地设备安全、恢复文件等模块，并纳入 `studio/**`。用例需声明 edition capability，不能机械地将个人版本地身份用例算为企业版跳过后整体通过。依据：[企业版 package.json](../../apps/team-client/package.json):77–106。

## 2. 当前可以复用的测试入口

以下命令从仓库根目录执行；除明确列出的子目录命令外不改变工作目录。它们是经过源码核实的现有入口，本轮没有执行。依赖安装应分别使用各目录锁文件；Python 始终通过 `uv run`。

| 层/对象 | 现有命令 | 执行性质与注意事项 | 源码依据 |
| --- | --- | --- | --- |
| Octop 默认 ship bar | `rtk proxy make all PYTEST_JOBS=4` | format-all 会写格式；随后后端 lint、mypy、pytest，不包含两版客户端、Studio 和 dashboard Vitest | [Makefile](../../octop/Makefile):201–224 |
| Octop Python 非 live | `rtk proxy uv run pytest -m "not live"` | 根项目测试依赖；包括单元与 HTTP/WebSocket 集成，并非完整桌面黑盒 | [Makefile](../../octop/Makefile):222–224、[golden path](../../octop/tests/integration/test_e2e_golden_path.py):14–25 |
| 个人版 Node | `rtk proxy npm --prefix wanx-client test` | `pretest` 会先组装 Studio；Node glob 为 `tests/*.test.mjs`，不会自动执行 `*.e2e.mjs` | [个人版 package.json](../../apps/personal-client/package.json):20–21 |
| 企业版 Node | `rtk proxy npm --prefix wanx-team-client test` | 独立包与锁文件；没有与个人版相同的 `pretest`，fixture 测试不等于已重建本次发布资源 | [企业版 package.json](../../apps/team-client/package.json):20、31–32 |
| 两版 Go 原生层 | `rtk proxy npm --prefix wanx-client run test:native`；企业版替换目录 | 在各自 `native/` 执行 `go test ./...`；仍需原生操作系统/硬件验收 | [个人版 package.json](../../apps/personal-client/package.json):22、[企业版 package.json](../../apps/team-client/package.json):21 |
| Studio 完整现有入口 | `rtk proxy npm --prefix wanx-studio run check` | Node 测试前自动 build/package，再执行 Studio Python backend 测试；会产生构建资源 | [Studio package.json](../../apps/builder/package.json):12–20 |
| Studio Python 单独入口 | 在 `apps/builder/` 执行 `rtk proxy uv run --project backend pytest backend/tests -q` | 与根 Octop 是不同项目/依赖；适合后端定向回归 | [Studio package.json](../../apps/builder/package.json):14 |
| dashboard 组件与状态 | `rtk proxy npm --prefix dashboard test` | Vitest/Testing Library/jsdom；不能替代真实浏览器渲染或已安装客户端 | [dashboard package.json](../../octop/dashboard/package.json):15–17、62–64、76 |
| dashboard 类型/构建 | `rtk proxy npm --prefix dashboard run build` | `tsc -b && vite build`；生成资源，不表示业务 UI 通过 | [dashboard package.json](../../octop/dashboard/package.json):8 |
| bridge 合同/安全集成 | `rtk proxy uv run pytest -c server/bridge/pyproject.toml server/bridge/tests -q` | 根环境包含完整合同测试依赖；可用根 `npm run test:bridge` 等价调用 | [根 package.json](../../package.json):12、[bridge README](../../server/bridge/README.md):425–435 |
| bridge 独立开发环境 | `rtk proxy uv sync --project wanx-bridge` | 独立包依赖 Python 3.12+ 和本地 `shared/packages/local-data-gate`；独立安装不自动包含根测试夹具及全部业务仓库 | [bridge pyproject.toml](../../server/bridge/pyproject.toml):9–33、[bridge README](../../server/bridge/README.md):435 |

对定向的 Node 用例，runner 应用 `spawn` 的 `cwd` 指向对应客户端，再执行 `node --test tests/<具体文件>`。不要依赖 shell brace/glob 语法在 Windows 和 macOS 表现一致；拟建 runner 用明确文件列表调用现有脚本。

### 2.1 真实 UI 与高价值集成入口

| 现有入口 | 前置条件/运行方法 | 可复用层 | 明确不能代表的结果 |
| --- | --- | --- | --- |
| `registration-electron.test.mjs`、`spaces-electron.test.mjs`、`avatar-electron.test.mjs`、`credit-wallet-electron.test.mjs` | 两版各自 `cwd`，设置 `WANX_TEST_ELECTRON=1` 后用 `node --test` 指定文件 | 实际 Electron renderer、布局、输入；注册例经过真实 preload/IPC | 注册的账号 fetch/store 被替换；钱包 fixture 注入 `window.wanxClient`，不能算实际支付后端/整条 IPC 链通过 |
| `bundled-electron-seam.test.mjs` | 目前仅 darwin；`WANX_ELECTRON_APP` 指向 Electron `.app`，可选 `WANX_PACKAGED_EXECUTABLE` 使用打包 Host | 实际应用安装/启动边界、可见窗口、运行目录隔离、复用与退出、截图/JSON | 临时 fixture 应用不是实际 Studio/星图/客户数据；当前不是 Windows 等价路径 |
| `market-electron-seam.test.mjs` | 目前仅 darwin，设置 `WANX_ELECTRON_APP` | 实际 Electron 应用管理接缝 | 并非最终主客户端从登录到市场完整黑盒 |
| `packaged-application-seam.test.mjs` | `WANX_PACKAGED_EXECUTABLE` 指向当前包中的可执行文件 | 确认打包 Electron 执行 manifest entry，而非错误地再启动 Host；启动失败可观察 | 模拟应用和 box context，不能替实际应用业务旅程 |
| `device-trust-ledger-electron.e2e.mjs` | 在个人版目录显式执行 `rtk proxy node tests/device-trust-ledger-electron.e2e.mjs`，具备交互桌面与正确 Python 路径 | 三个实际 Electron 身份、vault/IPC/UI、临时 HTTPS ledger，包含授权、撤销、备份/恢复等深入场景 | 不启动产品主入口/真实账号；部分 OS writer 控制是 fixture；不自动加入企业版（该模块不随企业版打包） |
| `provisioning-gatt-discovery.test.mjs`、`provisioning-write-lifecycle.test.mjs`、`provisioning-wifi-sdk.test.mjs` | 两版的 Node 测试目录 | 实际 renderer/SDK、AEAD/分片、重放/取消与计时，物理 Bluetooth API 被模拟 | 真实适配器、OS 蓝牙权限、盒端固件及 AP/网络协同 |

依据：[注册入口](../../apps/personal-client/tests/registration-electron.test.mjs):11–24、[注册 fixture](../../apps/personal-client/tests/support/electron-registration.mjs):15–55、[钱包 fixture](../../apps/personal-client/tests/support/electron-wallet.mjs):9–26、[空间入口](../../apps/personal-client/tests/spaces-electron.test.mjs):10、[bundled 接缝](../../apps/personal-client/tests/bundled-electron-seam.test.mjs):14–15、42–56、157、[market 接缝](../../apps/personal-client/tests/market-electron-seam.test.mjs):21–22、[packaged 接缝](../../apps/personal-client/tests/packaged-application-seam.test.mjs):11–38、[三进程验收](../../apps/personal-client/tests/device-trust-ledger-electron.e2e.mjs):1–3、68–83、[BLE discovery](../../apps/personal-client/tests/provisioning-gatt-discovery.test.mjs):13–15、50–57。

每个运行器必须记录“运行了什么以及为什么跳过”，不能仅转发 `node --test` 的 exit code。必选 UI 文件因环境变量未设置而全部 skip，应记为验收未执行，而不是桌面已通过。

## 3. 已有开关与执行环境清单

| 变量/参数 | 当前作用 | 接入规则 |
| --- | --- | --- |
| `WANX_TEST_ELECTRON=1` | 启用多个真实 Electron 测试 | GUI 轨道显式设置，并检查必选用例实际执行数 |
| `WANX_ELECTRON_APP` | macOS Electron `.app`，启用 bundled/market 接缝 | 分清测试运行时与最终待验收 Host；记录其路径的制品身份，不能只记录变量非空 |
| `WANX_PACKAGED_EXECUTABLE` | 最终 Host 可执行文件，启用 packaged seam | 绑定到本次候选包中提取/安装的文件；不要用开发依赖里的 Electron 替代 |
| `WANX_ELECTRON_EVIDENCE_DIR` | bundled seam 的截图和 `results.json` 目录；缺省目录在临时树中 | 每次运行提供独立持久证据目录，避免 cleanup 后丢证据 |
| `WALLET_SCREENSHOT_DIR` | 钱包 fixture 的截图输出目录 | 仅保存合成账号/订单截图；不要采集真实支付码或用户数据 |
| `WANX_REGISTRATION_SCREENSHOT`、`WANX_TEST_AUTH_SCREENSHOT` | 注册/登录 fixture 的可选单张截图路径 | 由 runner 分配位置；不能作为全程视频/步骤轨迹替代 |
| `WANX_LEDGER_TEST_PYTHON` / `WANX_TEST_PYTHON` | 三进程 ledger harness 的 Python 可执行文件 | Windows 显式传绝对 Python 路径；当前缺省写为 `.venv/bin/python`，不能直接假定跨平台可用 |
| `WANX_TEST_PYTHONPATH` | ledger harness 额外模块路径 | 由固定 checkout/dependency 清单生成，不能使用开发者任意全局环境 |
| `WANX_TEST_OS_ROOT`、`WANX_TEST_STARLINK_ROOT` | 备份 fixture 定位兄弟 OS/星图服务源码 | 必须固定 commit 和 schema 组合，缺依赖标基础设施未就绪，不删除断言 |
| `WANX_QUICK_PACKAGE=1` | Windows internal 包只跑聚焦 Node，跳过 Go 全量 | 记录 `focused-passed`，不能升级为完整验收通过 |
| `WANX_SKIP_TESTS=1` | Windows internal 包不执行相应 Node/Go/packaged seam | 发布验收必须拒绝将此报告当成全量测试通过 |
| `WANX_SKIP_INSTALL_SMOKE=1` | Windows internal 包跳过安装烟测并记 `unverified` | 正式候选包的安装必选项必须另行真实执行 |
| `WANX_SMOKE_USER_DATA` | 主进程将非 test-only 构建的 userData 重定向到隔离目录 | 可复用现有隔离入口；runner 仅使用自己创建的绝对目录，禁止指向客户 profile |
| `WANX_CONNECTION_TIMINGS=1` | 额外开启控制台诊断；磁盘日志默认写入 | 收集默认文件即可，不要求客户或测试人员额外改配置；日志并非完整录像 |
| macOS `--local` / `--test` | 跳过 Apple 公证，标记不同分发类别；`--test` 有独立身份/CA/渠道约束 | `--local` 仍要求 Developer ID 签名验证，并不是任意未签名包；两者不能当 formal 发行 |

依据：[图形入口 skip](../../apps/personal-client/tests/registration-electron.test.mjs):13、[bundled 参数](../../apps/personal-client/tests/bundled-electron-seam.test.mjs):14–15、55、[截图输出](../../apps/personal-client/tests/support/electron-wallet.mjs):295–306、[注册截图](../../apps/personal-client/tests/support/electron-registration.mjs):157、246、[Python/路径设置](../../apps/personal-client/tests/ledger-runtime-harness.mjs):10–13、[跨仓库 fixture](../../apps/personal-client/tests/device-trust-ledger-runtime.fixture.py):54–73、[Windows internal 开关](../../apps/personal-client/shell/package-win.mjs):98–100、117–128、281–310、[userData 隔离](../../apps/personal-client/shell/main.mjs):90–94、[timings 配置](../../apps/personal-client/shell/main.mjs):182–184、[Mac 分发/签名](../../apps/personal-client/tools/package-client.mjs):51–69、151–155、165–188。

## 4. macOS 与 Windows 构建/签名/验收的真实接点

### 4.1 macOS

- 现有统一正式入口为 `apps/personal-client/package-client.sh`，支持 `--edition personal|team|all`、`--arch arm64|x64`、`--formal`。例如在已准备证书、公钥和公证 profile 的 Mac 上执行 `rtk proxy ./apps/personal-client/package-client.sh --edition personal --arch arm64 --formal`；这是发行操作示例，本轮未执行。企业版可用同一入口选择 `team`，每个 arch 独立产物/验收。依据：[统一 shell](../../apps/personal-client/package-client.sh):76–99、105–127。
- `tools/package-client.mjs` 只在 darwin 构建，核对包 ID/版本/架构/内部 buildId，验证 Developer ID 签名，正式包对 ZIP/DMG 公证并装订票据，最终 ZIP 根据已装订应用重建，然后计算最终摘要和 blockmap。依据：[Mac 构建工具](../../apps/personal-client/tools/package-client.mjs):43–49、128–155、165–189。不能先对未公证 ZIP 测出哈希，公证重建后仍沿用旧哈希。
- 既有 `npm run package:mac` 为 `electron-builder --mac --dir` 路径，不能仅从命令成功推断已得到统一正式工具要求的 DMG、ZIP、公证与完整报告。依据：[个人版脚本](../../apps/personal-client/package.json):23、[企业版脚本](../../apps/team-client/package.json):22。
- Studio 的 `npm run package:macos` 另生成 Host-bound `.app`，工具使用 `codesign --sign -` ad-hoc 签名；它不是已公证的整个万象正式发行。依据：[Studio 脚本](../../apps/builder/package.json):19、[Studio Mac 包装](../../apps/builder/tools/package-macos.mjs):7–33。
- 接入时应在 Apple Silicon 与 Intel 的实际目标执行环境分别保留架构、系统版本和权限证据；cross-build 成功不代表该 CPU 已运行。Gatekeeper 首次打开、Keychain、文件选择器、辅助功能/录屏权限、托盘、多窗口、IME 与更新重启属于 Mac 平台旅程，不能只从 Windows 结果外推。

### 4.2 Windows

- 现有正式入口为各版的 `tools/package-client-windows.mjs`，在有签名能力的 win32 构建机执行，CLI 参数包括 `--version --arch --out --trust-file --publisher-name` 及 `--certificate-file` 或 `--certificate-sha1`。证书密码通过现有安全环境提供，不写用例/YAML/报告。它不是仅靠 `npm run package:windows` 就能证明全部正式验证完成。依据：[Windows 正式工具](../../apps/personal-client/tools/package-client-windows.mjs):25–28、55–76、124–127。
- 该工具构建 NSIS，验证安装器和 unpacked `WANX.exe` 的 Authenticode、publisher、包内版本/buildId/安装范围/更新公钥，生成最终 EXE 摘要、blockmap 和 `verification-client.json`。依据：[Windows 正式工具](../../apps/personal-client/tools/package-client-windows.mjs):95–118。
- `shell/package-win.mjs` 是另一条 x64 internal 路径；报告为 `unsigned-internal-only`、`signed:false`。它会执行真实安装烟测（可显式跳过），但报告内 `realAccount/liveBoxP2P/boxSSO/upload/streamingChat` 仍为 `unverified`。依据：[Windows internal 工具](../../apps/personal-client/shell/package-win.mjs):272–310。两版有同名工具，不能将其 `verification-windows.json` 与正式 `verification-client.json` 混用。
- `smoke-win.ps1` 已覆盖 NSIS 安装、中文/空格目录、ACL、DPAPI、自身覆盖安装、再启动、卸载和 userData marker 保留。它使用同一安装器重复安装，不是 N-1/N-2 版本、真实旧账号/应用数据库的迁移验收。依据：[现有安装烟测](../../apps/personal-client/shell/smoke-win.ps1):10–19、24–90。
- Windows 原生文件框、托盘、启动项、普通用户权限、UAC 边界和不同显示缩放应使用相应系统执行器验证。现有 NSIS 配置为 per-user 且不提升权限，测试不得为方便而改为管理员启动并将该结果当作普通用户通过。依据：[个人版 NSIS 配置](../../apps/personal-client/package.json):141–154、[Windows 正式 NSIS](../../apps/personal-client/tools/package-client-windows.mjs):45–51。

### 4.3 共用 afterPack 与正式发行签署

两版配置均通过 `afterPack: tools/package-client-native.mjs` 核对原生辅助程序、维护页面和星图资源。其 `canRun` 只有平台与 CPU 同时匹配才执行原生引擎 status；日志明确 cross-build 未运行引擎。签名前的源码 hash 对比与签名后的最终文件 hash 是不同证据，不得互相替代。依据：[个人版 build 配置](../../apps/personal-client/package.json):54–58、[afterPack](../../apps/personal-client/tools/package-client-native.mjs):21–49、71–90。

现有 `tools/sign-client-release.mjs` 在签署 Ed25519 发行前复算最终更新制品的 SHA-256、SHA-512、size，核对 blockmap，绑定版本、edition、buildId、channel、sourceCommit 和兼容表；macOS 系统签名/公证、Windows Authenticode 与该发行签名各有用途。工具不会代替 UI 和旧数据实装测试。依据：[发行签署](../../apps/personal-client/tools/sign-client-release.mjs):18–35、43–59、69–89。

正式构建来源检查涵盖客户端与共享组装源码，拒绝相关脏文件/未跟踪文件；测试包另用 sourceSnapshot 表示评审中的工作区，不能伪称已提交正式来源。当前配网诊断补丁尚在工作区，实施自动化时应使用隔离 checkout 与明确 commit，不在开发者进行中的目录直接打正式包。依据：[来源检查](../../apps/personal-client/tools/package-client-source.mjs):7–24、28–43。

## 5. 候选制品、报告和发布 hook

### 5.1 已有证据可直接读取

| 现有证据 | 应读取的内容 | 实现位置 |
| --- | --- | --- |
| Mac `verification-client.json` | edition、version、appId、arch、buildId/sourceCommit/sourceDirty/channel/securityEpoch/distributionClass，signed/notarized，DMG SHA-256、最终 ZIP SHA-256/SHA-512/size/blockmap，原生 binary hash | [Mac 工具](../../apps/personal-client/tools/package-client.mjs):81–87、180–189 |
| Windows formal `verification-client.json` | 同类构建身份，publisherName、authenticodeVerified、per-user scope，最终 NSIS SHA-256/SHA-512/size/blockmap | [Windows formal 工具](../../apps/personal-client/tools/package-client-windows.mjs):74–76、113–118 |
| `SHA256SUMS.txt` | 该次构建最终制品和 blockmap 的摘要 | [Mac](../../apps/personal-client/tools/package-client.mjs):185、[Windows](../../apps/personal-client/tools/package-client-windows.mjs):117 |
| `app.asar/package.json` | 实际包内 version、wanxEdition、wanxBuild，与报告独立比较 | [只读清单工具](../../apps/personal-client/tools/client-package-manifest.mjs):38–50 |
| Windows internal `verification-windows.json`、`smoke-windows.json` | internal 分发类别、聚焦/跳过标记、安装实际结果及未验证业务项 | [internal 报告](../../apps/personal-client/shell/package-win.mjs):281–314 |
| 星图 source receipt | 当前 canonical 文件列表、文件 hash、应用版本；verifyPackagedStarlink 校验进入最终 ASAR 的内容 | [星图组装](../../apps/builder/tools/assemble-starlink.mjs):27–37、61–79、[receipt](../../apps/builder/integration/starlink-source.json):1 |

拟建验收侧单独生成 `acceptance-manifest.json` 和 `results.json`，不要直接修改已签署发行载荷或让测试报告声称系统签名完成。至少绑定：`runId`、用例版本、工具/模型版本、输入报告 hash、实际安装包 hash、edition/OS/arch/buildId、旧版本基线、盒端/云端/跨仓库版本、必选用例结果、首次与重试结果、skip 原因、证据清单和清理状态。

准入同时核对“被执行的安装包 hash”“构建报告的更新制品 hash”“将推广的发行 artifact hash”完全相同；若测的是 `.app` 解压目录，应同时保存其来源 ZIP/DMG hash、实际应用 buildId 与文件清单，不能把另一次构建的 `.app` 结果关联到候选 ZIP。Mac DMG 手动安装与 ZIP 应用内升级、Windows NSIS 手动安装与应用内升级均应有各自场景结果。

### 5.2 保留既有发行机制

当前发行流程已定义上传不可变制品、签署/关联 draft、测试范围发布、登记实装验收再推广；用户仍主动下载并确认重启安装。候选验收 runner 应向该流程提供可验证证据，不另建可绕过签名或用户确认的发布通道。依据：[发布与更新流程](../release/wanx-client-release-and-update-flow.md):37–116、[更新服务](../../apps/personal-client/updates/client-service.mjs):124–132、[Electron 更新适配](../../apps/personal-client/updates/electron.mjs):133–145。

Admin 的验收登记/推广服务在另一个仓库，本文没有读取其现行远端代码、部署状态和分支保护；因此只确定接入边界，不编造新的上传/推广 HTTP API。实施时在固定版本 Admin 上核对现有接口，将新的必选测试证据纳入验收登记，保留人工推广权限。已有说明中的 `signedInstall`、`restartIdentityVerified` 是真实安装结果，不是 AI 的文字结论。依据：[现有流程说明](../release/wanx-client-release-and-update-flow.md):99–109、180–194。

## 6. 当前 CI 与拟接入位置

| 现有 workflow | 实际职责 | 方案应补的接点 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | PR 的 Linux/Windows Python lint/mypy/pytest；live 任务缺少 secrets 会跳过 | 保留；不能将绿灯直接算两版 GUI 已执行 |
| `.github/workflows/wanx-credit-desktop.yml` | 个人版路径触发，macOS/Windows 钱包专项；构建 renderer、合同/IPC 测试、`WANX_TEST_ELECTRON=1`、上传截图/log/platform.json | 复用其 `set -o pipefail`、`if: always()` 证据上传及平台记录；拓展为明确 edition/平台/场景矩阵 |
| `.github/workflows/release.yml` | Octop Python 制品 build→publish→GitHub Release，build 前 `make test` | 不把它误认作 WanX Electron 候选包全旅程门禁 |
| `.github/workflows/octop-desktop.yml` | `desktop/**` 的 Octop 桌面/portable 打包和挂载 release | 是另一条产品打包链，不是已运行万象两版 Electron 验收 |

依据：[CI](../../.github/workflows/ci.yml):16–66、87–129、[钱包专项](../../.github/workflows/wanx-credit-desktop.yml):4–7、20–56、[Python release](../../.github/workflows/release.yml):26–67、[Octop 桌面](../../.github/workflows/octop-desktop.yml):11–14、129–134、174–182。未读取远端 branch protection/rulesets，不判断当前 required checks 的实际设置。

拟建三条 workflow（当前均不存在）：

- `wanx-acceptance-pr.yml`：执行两版常驻 P0 确定性回归、dashboard/Studio/bridge 相关轨道，并保留现有 fast tests；AI 不参与普通步骤，低风险差异可缩小增量集，但常驻 P0 不因文件选择被跳过。
- `wanx-acceptance-nightly.yml`：受控 staging 与 Windows/macOS 交互 runner，包含更长旅程、按预算视觉探索、故障注入和盒子/AP 台架；报告成本与模型不确定，不能将工具异常转成产品通过。
- `wanx-acceptance-release.yml`：只消费已生成的候选包与 hash，执行两版/目标 OS/CPU、N-1/N-2 升级和实际盒端必选项；汇总准入结果，再交给既有发行登记/推广边界，不重新构建出另一个包冒充同一制品。

同一 GUI desktop 会话和同一 BLE/AP/盒子环境应独占租用。代码测试可并行，但不能在同一个桌面同时运行两版或多个视觉 Agent 争抢焦点。矩阵中的 OS 与 CPU 应来自实际运行信息，不能只用构建目标或 runner 名称推断；任何 required 场景缺设备、skip、timeout、清理失败均应阻断对应候选的完整验收。

## 7. 报告、数据路径和 fixture 的接入细节

| 当前路径/机制 | 应复用的部分 | 限制与处理 |
| --- | --- | --- |
| Electron `userData/logs/connection-timings.jsonl` 与 `.previous` | 默认连接、配网、网络阶段证据，已有封闭字段过滤 | 不写完整请求/密码/令牌；有 512 KiB 轮换，步骤失败立即复制两份，避免长探索覆盖关键记录 |
| `userData/account.enc`、`network-resume.enc`、`updates/client-state.json`、`applications/` | 旧数据升级基线、重启恢复和应用版本验证 | 仅合成数据 fixture；密钥/凭据不进入通用截图/附件。不要默认 Mac 与 Windows userData 绝对路径相同 |
| bundled seam 的 `WANX_ELECTRON_EVIDENCE_DIR/results.json` 与截图 | 已有最小窗口/应用结果证据结构 | 在统一报告中保留其原始结果，并标识 fixture 而非真实业务；默认 temp 目录需及时收集 |
| `credit-evidence/contracts.log`、`electron.log`、`platform.json`、`screenshots/` | 现有 Actions 上传模式 | 当前只代表钱包专项，不能将目录存在视为全旅程通过 |
| ledger fixture 临时目录与 screenshot diagnostic 输出 | 真实 HTTPS、签名、独立身份和数据生命周期深入测试 | fixture 会清理身份和恢复材料，仅保留公共截图；runner 应接管证据位置和结束状态，不归档私有 vault/恢复秘密 |
| 临时私有 HTTPS / isolated update feed | 可复用证书、固定 endpoint、Range/blockmap 与更新校验 | test-only feed 明确只监听 loopback 且只接受隔离测试身份；不替代真实 Admin/公网/代理/完整 OS 更新验收 |

依据：[日志/状态路径](../../apps/personal-client/shell/main.mjs):182–200、262、311、374–376、[日志轮换](../../apps/personal-client/shell/timings.mjs):33–61、[bundled 证据](../../apps/personal-client/tests/bundled-electron-seam.test.mjs):55、157、[钱包 workflow 证据](../../.github/workflows/wanx-credit-desktop.yml):41–56、[ledger 清理](../../apps/personal-client/tests/device-trust-ledger-electron.e2e.mjs):72–83、146、[隔离更新 feed](../../apps/personal-client/tools/package-client-test-server.mjs):1、40–60、101–107。

统一目录建议为拟建的 `artifacts/acceptance/<runId>/`，下分每个用例的步骤结果、截图/视频、脱敏 UI/服务端/盒端日志、公开状态核验和清理回执。报告写入异步失败需单独标基础设施错误；缺少决定性证据时不能仅按 UI 成功提示判定。具体保留期限由团队按合成数据、日志敏感性与存储预算设置。

## 8. 跨仓库/依赖矩阵

| 依赖 | 已有事实 | 对自动化环境的要求 |
| --- | --- | --- |
| `wanx-studio` 与内置星图源码 | 两版 `build:studio` 分别调用 `assemble-client.mjs personal/team`；星图 canonical 在企业版 `applications/starlink`，以 source receipt 验证后供两版组装 | 共享输入改变时不能只测个人版或只测文件被直接修改的版本；用本次组装的资源与源 commit 对齐 |
| `wanx-bridge` 与 `shared/packages/local-data-gate` | bridge 独立包显式依赖本地 editable gate；其真实上游合同另依赖根 Octop fixtures | 记录桥接/gate/Octop 版本和环境，区分 standalone wheel smoke 与完整仓库合同 |
| 兄弟 `centuarai-os` / `centuarai-semantica` | 备份 runtime fixture 导入其部署 adapter 和业务数据库源码，支持 `WANX_TEST_OS_ROOT` / `WANX_TEST_STARLINK_ROOT` | 受控 checkout 固定 commit/schema；缺目录不能静默换假实现通过。备份 schema 不兼容应产生真实阻断 |
| clipboard 业务模块 | roundtrip 集成使用 `pytest.importorskip("wanx_clipboard.app")` | 发布必选 clipboard 场景需先安装该固定版本模块并检查未 skip；不能把默认 importorskip 当功能覆盖 |
| consumer/Admin、网络控制面与真实盒端 | 当前源码中的普通 fixture 可替换云端/网关；发行推广另属于 Admin 服务 | staging 版本矩阵独立记录，使用专用测试账号/租户；真实配网/权限/续租验收不得用全部 mock 替代 |
| harness/gateway 等 Python 运行库 | 根 `pyproject.toml` 以发行包依赖 harness/gateway，只有 gate 在本地 uv.sources 中显式映射 | 保留 `uv.lock` 和实际 resolved 版本；不要臆测每个开发机都使用同一兄弟源码 |

依据：[两版组装入口](../../apps/personal-client/package.json):32–33、[企业版组装](../../apps/team-client/package.json):31–32、[共享组装](../../apps/builder/tools/assemble-client.mjs):1、27–29、51–58、[星图 receipt 核验](../../apps/builder/tools/assemble-starlink.mjs):27–37、[bridge 依赖](../../server/bridge/pyproject.toml):9–23、[跨仓库备份 fixture](../../apps/personal-client/tests/device-trust-ledger-runtime.fixture.py):54–73、[clipboard roundtrip](../../server/bridge/tests/test_clipboard_roundtrip.py):15、[根 Python 依赖](../../octop/pyproject.toml):25–28、52–53。

## 9. 建议新增的文件与脚本清单（全部拟建）

以下只列接入职责，尚未创建这些路径、安装依赖或修改 package scripts；名称与主技术方案保持一致后再实施。

| 拟建路径/修改点 | 首轮最小职责 | 可复用来源/验收方式 |
| --- | --- | --- |
| `tests/acceptance/package.json`、锁文件、TypeScript 配置 | 独立测试依赖与固定版本、CLI 入口 | 不污染产品 Electron/SDK 锁文件；Windows/Mac 都能加载 runner |
| `tests/acceptance/scenarios/` | 版本化用例、edition/platform/capability、前置状态、断言、风险、预算、清理 | 先移交需求预期，再接已有测试；明确成功/业务失败/环境失败 |
| `tests/acceptance/src/journeys/` | Playwright/API/原生驱动的受审查业务 handler，显式复用既有测试 | 从真实入口操作，公开 API/文件状态作独立核验；用已知故障证明会红 |
| `tests/acceptance/specs/` | 执行系统自身、Adapter 契约、Gate/预算/资源恢复的正反测试 | 缺测、假绿、迟到动作、预算未知、清理失败等必须按合同拒绝 |
| `tests/acceptance/src/runner/` | 用例调度、进程/超时/取消、退出码、首轮与重试记录 | 适配现有 Node/pytest/Vitest，拒绝 required 全 skip |
| `tests/acceptance/src/platform/` | Electron、Windows UIA、macOS AX 的平台接口与能力探测 | 同样业务场景可共用意图，平台行为单独验证；不关闭应用安全边界 |
| `tests/acceptance/src/environment/` | staging 账号、数据、旧 profile、盒子/AP 租用及恢复 | 只触及本次运行可丢弃资源；清理失败隔离资源，禁止复用污染环境 |
| `tests/acceptance/src/assertions/` | 公开业务结果与权限否定断言 | UI 操作与独立核验分开；不调用内部方法替 UI 执行关键步骤 |
| `tests/acceptance/src/evidence/` | 统一事件、manifest、日志/截图/视频、artifact hash、脱敏 | 关联现有 verification-client.json 与实际安装包；缺证据不可假绿 |
| `tests/acceptance/src/ai/` | Midscene/探索 Agent 受限适配、AI 生成草稿 | 普通动作先脚本，超出授权步骤/资源立即停止；不自动改成功条件 |
| `tests/acceptance/src/budget/` | 单步骤/用例/运行 token、费用、调用数和重试上限 | 达到预算记 `budget_exhausted`，不是产品成功；记录首次结果 |
| `tests/acceptance/src/policy/` | 必选场景、证据完整性、签名/版本匹配、发布准入 | 对不适用/未知/skip 有明确规则；只消费当前 artifact 身份 |
| `tests/acceptance/scripts/` | preflight、运行、收集、汇总与准入的薄 CLI | 生成低 token 的结构化摘要，详细证据可按失败用例展开 |
| 根 `package.json` 中拟新增 `test:acceptance:*` | PR / nightly / release / preflight / report 的统一入口 | 当前根脚本没有这些命令，不可在文档中将它们写成已可运行 |
| `.github/workflows/wanx-acceptance-pr.yml` | 关键确定性回归、两版/前后端适配 | 失败 job 正常红灯，保留证据；外部 fork 不接触私有账号/硬件凭据 |
| `.github/workflows/wanx-acceptance-nightly.yml` | 跨平台探索、故障与硬件台架 | 按 desktop/盒子互斥，预算与基础设施失败独立汇总 |
| `.github/workflows/wanx-acceptance-release.yml` | 按候选包 hash 验收并形成准入报告 | 不重打包替换待发布 artifact，不自动执行正式推广 |

## 10. 本附录的完成标准与实施顺序

1. 已核对可复用命令和源码；在实施第一阶段为每条入口增加机器可读层级、真实依赖、skip 原因和产物身份，不把白盒接缝改名为黑盒。
2. 先接两版 Windows/macOS 登录→连接测试盒→打开空星图/Studio，以及一条 N-1 真实格式数据升级；不同版别的可用能力明确纳入同一用例契约。
3. 之后补原生对话框/托盘/IME、权限拒绝与撤销、跨平台断网恢复、真实配网台架；不可用的 required 环境如实阻断，不通过换 mock 或切管理员权限制造通过。
4. 最后将同一最终制品的证据接入既有发行验收，达到正式包签名、公证/Authenticode、来源、旧版本基线、必选旅程和清理均可核验；AI 探索作为额外发现能力，不成为测试判定的唯一来源。

本轮验证仅为：重新读取上述关键文件与脚本、检查附录相对链接是否存在、文档差异检查。没有新建测试系统或执行上述命令。工具 PoC、跨平台安装/升级、真实 AI 运行成本和盒端实机结果均留待实施验证。
