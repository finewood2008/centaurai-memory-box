# 个人版客户端 OTA 兼容性契约

2026-11-04：确认并修复系统内核版本精确匹配和逐应用版本白名单造成的误阻断。范围是个人版 Windows x64、macOS x64/arm64；盒端 Ubuntu 与团队版客户端源码不在本次修改范围。修复代码不代表新安装包已发布或新系统已完成真实验收。

## 系统匹配

OS 和 CPU 架构始终精确匹配。签名 payload 可以声明 `clientOsPolicy`；每个架构仍是独立制品和发行。字段缺失的旧发行继续使用 `supportedOsVersions` 精确匹配。

| 签名策略 | 严格字段与约束 |
| --- | --- |
| macOS | `{kind: "macos-product-majors", majors: [...]}`，1–64 个升序、唯一的整数大版本，范围 1–999 |
| Windows | `{kind: "windows-build-ranges", ranges: [{family, minBuild, maxBuild}, ...]}`，1–32 个按构建号升序、不重叠的闭区间；family 为 windows10/windows11；Win10 构建 10240–19045，Win11 构建至少 22000；构建上限 2147483647 |

这些是契约的数值边界，不是产品已经验收的支持矩阵。发行人必须根据实际验收填写狭窄的列表/区间，不提供默认全系统策略，不接受 `*`。不能因某架构声明了新 macOS，就让另一架构自动适用。

运行时 `osVersion` 仍保留 Node `os.release()`。Mac 新增 `osProductVersion`，来自 Electron `process.getSystemVersion()`，解析产品版本 major[.minor[.patch]]，不使用 Darwin 内核号猜测产品大版本。Windows 新增原生整数 `windowsProductType`：1 桌面，2 域控制器，3 Server，0 探测失败。通过限时、固定 PowerShell/CIM 查询读取 ProductType 和 BuildNumber，并核对后者与内核构建号一致；版本格式为 10.0.build[.patch]，仅 build 参与区间匹配。

新策略与新事实同时存在时使用新匹配。事实存在但格式无效、类型未知或不支持时拒绝，不能回落精确列表绕过；无新事实的旧客户端保留旧规则。新版 Windows 客户端明确报告 Server/未知类型时，即使旧发行精确列表命中也拒绝。字段只在对应客户端请求中允许，不能加入盒端请求或签名 platform。

候选查询和业务请求的 `X-Wanx-Client` 使用同一平台事实；Admin 与客户端本地验签后复核使用相同约束。两仓库保存完全相同的 88 组 OS 契约样例，修改契约时必须同步并验证。

## 应用兼容性

可选签名字段 `applicationCompatibilityPolicy` 只支持严格对象 `{mode: "host-protocol-backward-compatible"}`，要求发行 hostProtocol=1、dataPolicy=backward-compatible，并且与当前 Host 协议相同。未知模式或额外字段拒绝。没有该字段的发行保留原逐应用 `compatibleApplications` 白名单规则。

新策略下，应用独立升级、新安装且未被发行表点名的应用、没有活动版本的待选/待准备应用，不因其版本号或名单状态阻断 Host OTA。已选择的现代应用仍须有有效兼容声明，Host 协议必须满足其 hostProtocolRange；协议 1 旧应用沿用既有 Host 1 支持规则。现代兼容元数据缺失/畸形、协议要求冲突时阻断并显示具体应用和已装版本。不会仅因旧包 clientRange 与客户端版本不同而阻断。

本策略不迁移应用数据。应用安装、选择、启动、回滚时现有的本地数据 schema、后端契约、权限和资源检查仍生效；不实现新的破坏性 Host 协议或数据迁移模式。下载前重新查询；安装前先锁定应用维护，再重新查询并比较含协议/兼容元数据的安装基线，变化时返回 PLAN_STALE。

`compatibleApplications` 继续保留并签入，供旧客户端解释，不能简单删除或置空后宣称旧版已兼容。新旧策略、OS/架构和制品都属于测试版/stable 验收内容指纹，策略变化不能复用之前的验收。

## 发行和 1.0.4 过渡

1. 先发布支持新旧请求的 Admin 后端与前端；无需 SQL 迁移。发行详情只读展示签名策略，不提供编辑已签名元数据的入口。
2. 从含修复的干净提交构建高于 1.0.4 的个人版客户端（例如用打包参数指定 1.0.5），分别准备 Windows x64、Mac x64、Mac arm64 的系统签名和公证制品。仓库版本本次不自动递增，不生成正式安装包。
3. 在受控 support.json 中保留实际验收的 supportedOsVersions、compatibleApplications，并按真实矩阵增加上述可选策略。sign-client-release.mjs 的 API 和 --support CLI 都签入它们，验签后用客户端同一匹配器模拟已声明边界；模拟不是实机验收。
4. 按既有测试渠道 → 首装/旧版升级/业务验收 → stable 的流程重新签发并推广。新 releaseId、递增 metadataSequence；不改已推广 JSON 或数据库负载。
5. 已安装 1.0.4 不认识新策略的语义，仍执行本地精确 OS 和全量应用白名单。只有被过渡发行旧字段覆盖的已验收组合能 OTA 到新版；未覆盖的组合使用经过验证的手动安装路径。只改 Admin 不能绕过旧客户端。手动升级的数据/账号保留需实机验收，不以单元测试冒充证据。

## 为什么 macOS OTA 使用 ZIP

当前适配器使用 electron-updater MacUpdater，底层是 Squirrel.Mac。它使用 ZIP 中的 .app 完成原位更新；DMG 是供用户挂载、拖拽安装的磁盘映像。保留同次构建的签名/公证 DMG（手动安装）、签名/公证 ZIP（OTA）及 ZIP blockmap（差分下载）。ZIP 并不表示放弃系统签名、公证或完整文件摘要检查。Windows OTA 继续使用 NSIS EXE 与 blockmap。

参考：[electron-builder v26 自动更新](https://www.electron.build/v26/docs/features/auto-update/)、[Electron 系统产品版本](https://www.electronjs.org/docs/latest/api/process)、[Windows ProductType](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-operatingsystem)。

## 验证范围

自动化覆盖严格策略校验、跨语言 OS 样例、Server 排除、旧发行/旧请求、强制更新上下文、签名篡改、应用独立发行、真实协议冲突、安装前状态变化和测试版/stable 内容差异。真实 Win10/Win11、Mac Intel/Apple 芯片的安装、公证、升级和旧数据验收仍由发行测试完成；此次不修改生产信任根或既有发行。

验证记录（2026-11-04）：客户端相关245项通过、1项Windows实签测试按平台跳过；Admin专项331项通过；前端组件7项及页面102项通过，生产构建通过。更广Admin升级回归1317项通过、22项跳过、4项失败；4项均在未修改主干复现（旧证书错误枚举断言、SQLite夹具缺证书表）。实际Electron37.10.3成功分离Darwin25.5.0与产品26.5.2；测试密钥的Mac/Windows发行通过JS签发→Python验签匹配。没有将这些测试结果记为正式跨系统安装验收。
