# 火花接入统一 OTA 的实施方案

核对日期：2026-11-08。火花源码为 `centaurAI-spark` 的 `b7652c20098a233959fd0f9d7c7de675eb0064b9`，WANX 基线为 `38eada82`。本文的“已有”以源码实现为准；实施项和验收门槛表示后续工作。

OS 基线为 `codex/home80-retire-legacy-startup` 的 `bd2fc36a`；Admin 已核对恢复后的主仓，`master=67941275`。OS 观察基于该本地分支，Admin 观察基于最新主分支；均不代表现场盒子或线上控制面的部署版本。OS 与 Admin 的外仓链接采用相邻工作区布局。

建议把 `huohua.workbench` 接入可选盒端服务 OTA，独立管理首装、升级和恢复；火花客户端继续走市场应用发行。两份制品分别发布，由 Bridge 服务协议及实际就绪状态建立兼容关系。火花已有独立服务与手动联调打包入口，仍需补齐可重复运行制品、运行身份、任务排空、数据兼容与生产安装规则，才能交给统一升级器执行。

## 接入方式与平台现状

| 对象 | 标识与发行 | 统一管理中的职责 |
| --- | --- | --- |
| 火花客户端 | `centaurai.wanx.huohua-workbench`，协议 3 市场应用 | 分发 UI 和 Host 集成；所选盒服务就绪后开放业务 |
| 火花盒端服务 | `serviceId=huohua.workbench`、`product=wanx-box-service` | 指定设备首装、独立升级、回退及现场库存 |
| WANX Bridge | `wanx-bridge.huohua` 协议合同 | 用户鉴权、受控能力代理、维护与激活门禁 |
| OS 升级器与 Admin | `wanx.optional-box-service.v1` | 签名发行、分配、固定计划、下载/执行许可、事务恢复与回执 |

保持普通 OTA 的固定组件集合及其基线语义，可选服务使用已有独立任务类型。基础 WANX 发行交付 Bridge，升级器发行通过可信迁移交付执行与恢复能力，火花程序使用独立服务发行。这样只给选定盒子安装火花，服务更新也有自己的版本与恢复证据。[可选服务 OTA 合同](../../../centuarai-os/docs/contracts/optional-box-service-ota-v1.md)

### OS 已有隔离执行原型

`box_optional_service_contract.py:192` 要求服务 ID 等于 `test.optional-service`；`box_optional_service_updater.py:305` 的入口要求隔离 VM、测试状态目录和回环控制面。测试 runtime 只允许两个文件、128 KiB 的测试制品。生产 `box_updater.py` 尚未接入该 worker，`box_updater_install.py` 的交付文件及 unit 写路径也未包含火花运行目录。因此当前 `1.9.24` 版本号本身不能证明支持火花安装。[签名准入](../../../centuarai-os/deployment/box_optional_service_contract.py) · [worker 入口](../../../centuarai-os/deployment/box_optional_service_updater.py) · [固定测试规则](../../../centuarai-os/deployment/box_optional_service_runtime.py) · [升级器交付](../../../centuarai-os/deployment/box_updater_install.py)

可复用部分包括签名校验、固定计划、设备锁、开始 ACK、持久恢复和 outbox。但库存中的 Bridge 构建目前硬填 `test-bridge-1`，数据摘要固定为空；生产接入要改成真实 Bridge、安装规则及数据证据。普通 OTA、自更新、Rescue 与可选服务还需共用持久任务占用，不能只共用执行瞬间的文件锁。[可选事务](../../../centuarai-os/deployment/box_optional_service_updater.py) · [普通任务占用](../../../centuarai-os/deployment/box_ota_state.py)

### Admin 主分支仍限定测试通道

`nexus_upgrade_optional_service.py` 已实现发行登记、设备分配、15 分钟库存时效、固定计划、领取、租约和事件；对应 SQL 已在主分支。`require_enabled()` 仍强制 `APP_ENV=test` 和设备白名单，`release_payload()` 只接受 `test.optional-service/qualification`。服务 ID、库存筛选和分配多处写死，前端尚未接入可选服务管理。[服务实现](../../../../nexusaos/nexusaos-admin/admin-backend/module_nexus/service/nexus_upgrade_optional_service.py) · [测试开关与发行准入](../../../../nexusaos/nexusaos-admin/admin-backend/module_nexus/service/nexus_upgrade_optional_service_wire.py) · [数据库迁移](../../../../nexusaos/nexusaos-admin/admin-backend/sql/20261106_upgrade_optional_services.sql)

生产接入应增加受审查的火花服务注册、发行审批与推广、撤回、设备分配和库存查询页面，继续保留测试服务及测试信任的隔离。打开环境开关或替换一个常量不足以完成生产接入。OS 和 Admin 共同维护 schema、签名向量及安装规则身份。

### WANX 需要连接 OTA 激活记录

现有 Bridge 已支持固定路由、服务身份、任务租约和三种探针，但注册表在启动时加载一次。状态探测未匹配 OTA 安装账本、目标制品及激活代次；未配置注册记录时的 `not_installed` 是路由视角，不能充当首装所需的现场未安装证明。[注册表](../../server/bridge/wanx_bridge/service_registry.py) · [启动加载](../../server/bridge/wanx_bridge/__main__.py) · [状态探测](../../server/bridge/wanx_bridge/huohua.py)

建议让静态配置预置受信服务、端口和公钥，另由受信安装器写入原子激活记录。Bridge 在运行中核对激活记录、账本和维护状态；只有已提交版本可接收客户业务。候选探测、服务会话建立和排空所需授权校验保留受限本机通路，避免“路由关闭导致候选永远无法就绪”的循环。普通 WANX 升级及回退也须核对已经安装的火花协议。[现有代理](../../server/bridge/wanx_bridge/server.py)

应用的 `backendContracts` 只证明 Bridge 协议能力。当前协议 3 的 `resourceDependencies=[]` 会直接完成资源准备，尚无盒端服务安装合同。首期使用 Admin 定向安装；后续增加版本化的服务依赖准备，须同步平台签名描述、两个客户端及 SDK 唯一入口，不能直接向严格校验的 manifest 塞入未知字段。[准备流程](../../apps/personal-client/applications/backend.mjs) · [兼容字段校验](../../apps/personal-client/applications/compatibility.mjs)

接入回归还应修复并覆盖两处既有合同传递遗漏：`platform.mjs:1157` 的本地连接包装和 `device-trust/data-session.mjs:536` 的子会话续期没有继续传递 `backendContracts`，会影响本地火花连接及其续期。[连接包装](../../apps/personal-client/platform.mjs) · [续期](../../apps/personal-client/device-trust/data-session.mjs)

## 火花当前具备的接入基础

| 能力 | 已有实现 | OTA 仍需补齐 |
| --- | --- | --- |
| 独立运行 | `python -m huohua_workbench.boxd`，`127.0.0.1:8093`，固定 `/api/huohua/v1` | 固定低权限账号、systemd unit、启动门禁、资源预算和实机隔离 |
| 服务身份 | 安装私钥换取 Bridge 服务会话；用户、空间通过短时委托进入服务 | 与受信安装配置、盒子归属代次及 OTA 激活记录绑定 |
| 服务探针 | `/healthz`、`/readyz`、`/version` | 发行构建身份、制品证据、运行依赖及无副作用业务探测 |
| 程序与数据分离 | 独立数据目录、SQLite、按作用域隔离的用户运行目录 | 数据 schema、初始化完成标记、归属证据及候选写入后的回退验收 |
| 任务持久化 | 幂等任务、单实例 `worker.lock`、中断转待核对 | 维护期间阻止新写入与新任务领取、排空已有执行及重启恢复门禁 |
| 打包 | 服务源码、UI、manifest、运行依赖安装脚本和归档 SHA-256 | OTA 签名发行、精确平台、文件清单、冻结依赖和可恢复运行目录 |
| 市场客户端 | 协议 3、`backendContracts=wanx-bridge.huohua`、独立市场构建入口 | 应用与实际服务版本准备合同，兼容性及服务不可用状态验收 |

以上分别见 [boxd 入口](../../../centaurAI-spark/huohua_workbench/boxd.py)、[能力适配器](../../../centaurAI-spark/huohua_workbench/capabilities.py)、[服务生命周期](../../../centaurAI-spark/huohua_workbench/service.py)、[持久任务](../../../centaurAI-spark/huohua_workbench/store.py)及[服务打包器](../../../centaurAI-spark/tools/workbench/package_box.py)。

## 火花发行和运行制品

### 当前服务包与正式 OTA 制品的差异

`tools/workbench/package_box.py:57` 生成 `format=2`、`kind=wanx-optional-box-service` 的源码包，包含 `manifest.json`、`service.json` 和 `install-runtime.sh`；清单固定服务 ID、端口、路由和探针。它没有生成统一 OTA 的签名发行信封、精确目标平台、安装规则摘要、数据策略或逐文件摘要清单。归档 SHA-256 只是包字节校验，不能代替发行身份及运行证据。

打包器的默认版本是 `0.1.0-dev+<git-short-sha>`，`pyproject.toml` 为 `0.1.0`，客户端清单为 `0.10.6`。三者含义不同。应为 `huohua-boxd` 建立单独且明确的服务发行版本，固定源码提交和构建 ID；客户端版本可以独立演进。`BoxdConfig.version` 当前默认 `0.1.0-dev`，且从 `HUOHUA_SERVICE_VERSION` 取值，打包版本不会自动进入运行探针。[服务版本配置](../../../centaurAI-spark/huohua_workbench/boxd.py) · [客户端清单](../../../centaurAI-spark/client/application.manifest.json)

`install-runtime.sh` 当前运行在线 `pip install --upgrade pip`、安装带范围约束的依赖，并下载 Patchright Chromium。虽然源码包附带 `uv.lock`，该脚本没有使用锁文件安装。归档也没有预先包含安装好的 Python 运行环境及浏览器，安装结果仍取决于安装时的网络和依赖解析。[构建与安装脚本](../../../centaurAI-spark/tools/workbench/package_box.py)

正式制品建议由固定 Linux 平台构建，准备冻结的依赖及浏览器载荷，或提供全部受摘要约束的离线依赖集合；由 OS 受信安装规则实施解包和准备，应用包不提供任意特权安装逻辑。Python 约束目前为 `>=3.10,<3.13`，建议首批固定 Python 3.12 和已验收的 Ubuntu 24.04 x64，不能直接复用升级器自己的 Python。[Python 约束](../../../centaurAI-spark/pyproject.toml)

优先采用固定 Python 3.12 加带摘要的离线 wheelhouse 和浏览器载荷，由受信安装器在候选阶段建立隔离运行环境。同时固定构建时间及归档元数据；当前 `builtAt`、gzip 时间及源文件时间会影响字节。运行目录按最终制品摘要寻址，完成后只读，避免直接搬运带绝对路径的开发机 `.venv`。

运行依赖需覆盖完整发布 worker：当前 `runtime-requirements.txt` 未显式列出根项目中的 `loguru`、`qrcode`、`segno`、`tinycss2`；仅检查 `fastapi/flask/httpx/jwt/patchright/xhs` 导入不足以证明 `sau_backend` 及平台上传模块可用。发布和扫码路径同时使用 Playwright 与 Patchright，应分别验证它们实际调用的 Chromium，或明确配置一份兼容且固定的浏览器。当前安装脚本只调用 `patchright install chromium`。[依赖声明](../../../centaurAI-spark/pyproject.toml) · [发布 worker 导入](../../../centaurAI-spark/sau_backend.py) · [登录实现](../../../centaurAI-spark/myUtils/login.py)

### 已复现的干净检出打包问题

在本次火花检出上，以临时 UI 调用 `package_box.build()` 并检查归档，结果为：

```text
conf_py_present: false
conf_example_present: true
installed_runtime_present: false
manifest_present: true
```

原因是 `_files()` 仅收录已有 `conf.py`，不会从 `conf.example.py` 生成；干净检出没有本机忽略的 `conf.py`，而运行 worker 直接 `from conf import BASE_DIR`。正式构建应从受控模板生成无密钥配置，或把配置加载改为固定部署配置；不能把开发者配置作为隐式构建输入。[文件收集](../../../centaurAI-spark/tools/workbench/package_box.py) · [worker 配置导入](../../../centaurAI-spark/sau_backend.py) · [现有包测试](../../../centaurAI-spark/tests/workbench/test_package_box.py)

本次验证只使用临时目录和合成 HTML，制品随后删除，未安装或启动服务。后续应在无 `conf.py`、无 `.venv`、无浏览器缓存的干净 Linux 环境构建，再以断网运行测试证明依赖闭包完整。

### 建议的服务发行字段

与现有可选服务 OTA schema 对齐，火花流水线至少提供：

- `product=wanx-box-service`、`serviceId=huohua.workbench`、服务版本、构建 ID、源码提交和渠道。
- 精确 OS/架构、`artifact.kind=service-tar`、SHA-256、大小及文件清单。
- `wanx.optional-box-service.v1` 扩展、最低升级器版本、Bridge 与服务协议约束。
- 经 OS 审核的安装规则 ID、版本和摘要；应用代码不自行定义账号、unit 或写入路径。
- 首期 `dataPolicy=backward-compatible`，并提供候选写入后旧版本仍可运行的验收证据。

这部分是接入目标，不是当前 `manifest.json` 已经具备的字段。现有基础设计见 [OS 可选服务 OTA 合同](../../../centuarai-os/docs/contracts/optional-box-service-ota-v1.md)。

## 运行版本与健康证据

`/healthz` 直接返回 `ok`、服务 ID 和配置版本；`/version` 返回配置 manifest。`/readyz` 检查后台任务存活、Bridge 是否配置及最近错误，没有启动懒加载的 SAU 子进程，也没有实际验证 Python 发布模块、Chromium 或平台运行库。因此当前 `ready` 只能作为服务层探针，不能单独证明 OTA 安装完成。[探针实现](../../../centaurAI-spark/huohua_workbench/boxd.py)

建议由受信执行器验证已签名制品与磁盘文件，再核对运行 PID、解释器、发行目录、版本和配置摘要。火花 `/version` 可增加固定构建元数据，但执行器不能只相信服务自报的摘要。候选验证至少包含：

1. 主进程与发布 worker 使用本次发行的 Python，固定端口归属于目标 PID。
2. 完整依赖导入、SQLite 初始化及读写可用，服务持有唯一数据锁。
3. Chromium 在实际低权限账号及 unit 沙箱内启动、打开本地合成页面并退出，保留 OS 隔离和资源限制。
4. Bridge 服务身份建立、HTTP 与 SSE 代理正常，以合成身份进行无副作用业务调用。
5. 在激活记录提交前业务路由关闭；提交后再验证实际开放状态。

当前 `RuntimePool.get()` 才创建每作用域 SAU 子进程，并通过 `/getAccounts` 探测启动；`RuntimePool.close()` 先 terminate，五秒后 kill。OTA 的 systemd 规则还需确认主进程、Flask worker 与 Chromium 子孙进程全部退出，不能只确认 boxd PID 结束。[发布运行池](../../../centaurAI-spark/huohua_workbench/runtime.py)

## 升级前的任务排空

`Workbench.close()` 直接取消扫描与所有 worker，运行中的任务保留 `running`。下次 `Store.recover()` 将其转成 `needs_review`，错过时点的排期也转待核对，避免重复发表。这是已有的安全中断语义，但还不是无损 OTA 排空。[生命周期](../../../centaurAI-spark/huohua_workbench/service.py) · [任务恢复](../../../centaurAI-spark/huohua_workbench/store.py)

建议首期升级采用“等待当前实际执行结束，超时阻塞升级”的策略：

1. 由受信本地维护接口持久绑定 `operationId/attemptGeneration/planDigest`，设置维护门禁。
2. 门禁阻止新业务写入、自动扫描提交和新任务领取；已排队任务保留，不因维护而被取消。
3. 已有发布、AI 解析、扫码、上传及只读复核完成或进入明确可恢复状态，再停止进程。
4. 若超时或仍有平台提交结果不确定的执行，保持原服务或进入受控恢复，禁止把强制终止当作正常排空。
5. 只允许匹配该任务的维护状态释放；重启后先处理未完成升级，避免扫描器抢先开始工作。

升级窗口内错过排期仍应遵守现有“不自动补发”规则，并让用户看到受影响的任务；若希望维护后自动顺延，需要单独定义业务策略。候选与旧版本共用数据和固定端口，只允许一份进程持有数据锁。

还有一项恢复约束：用户委托、任务 token 与身份映射目前在 `BridgeCapabilityClient` 内存中；`close()` 会撤销任务并清空映射。进程重启后没有用户访问时，`authorized()` 不会恢复过去授权，worker 暂缓排队任务，等待用户重新建立授权。因此“OTA 后无需重新打开客户端也能继续无人值守排期”需要另行实现安全的可恢复授权机制并验收，不能保存 Host token 或把安装服务 token 当作用户权限。[委托生命周期](../../../centaurAI-spark/huohua_workbench/capabilities.py) · [授权检查](../../../centaurAI-spark/huohua_workbench/boxd.py)

## 数据兼容与保留

当前独立服务数据包括：

```text
HUOHUA_DATA_DIR/
  workbench.sqlite
  worker.lock
  users/<scoped-owner>/
    db/database.db
    cookiesFile/
    videoFile/
    runtime.log
    publication-state/
    browser-sessions/
```

`scoped-owner` 根据 `boxId + userId + spaceId` 计算，数据库记录相应作用域；没有把盒子 `ownershipEpoch` 纳入该键。`workbench.sqlite` 使用 WAL、事务和 FULL 同步，但只有建表和实例 ID，没有显式盒端 schema 版本、迁移日志或初始化完成代次。客户端清单中的 `localDataSchema` 描述客户端应用本地数据，不能证明这些服务数据可回退。[作用域键](../../../centaurAI-spark/huohua_workbench/capabilities.py) · [建表](../../../centaurAI-spark/huohua_workbench/store.py) · [SAU 初始化](../../../centaurAI-spark/db/createTable.py)

首次纳管应补齐数据归属、schema 和可重入初始化证据。首期只接纳可向后兼容的发行：在新版本实际写入任务、账号、索引和发布检查点后，用旧版本重新打开并继续读写；恢复旧程序不能用恢复旧数据库覆盖新产生的任务和回执。SQLite 备份须遵守 WAL 一致性，视频快照和账号会话也需要同步的保留策略。

第三方 Cookie 和浏览器 storage 目前存在本地 JSON 文件中，使用目录/文件权限及受限接口隔离，未实现计划中提出的独立密钥加密。OTA 文档不能把这项设计写成已交付能力。生产安装规则需明确秘密文件权限、加密密钥保留、卸载保留和归属变化隔离，且这些对象不进入发行包或日志。[登录会话落盘](../../../centaurAI-spark/myUtils/login.py) · [会话指纹](../../../centaurAI-spark/huohua_workbench/publication.py)

旧 `attached` 部署的数据位于 `<WANX_HOME>/.huohua-workbench`，独立 `boxd` 使用 `HUOHUA_DATA_DIR`，旧数值 owner 与新作用域键也不同。旧部署不能直接上报为可选服务的 `not_installed` 后新建空数据；应先识别为需纳管/迁移的现场，显式核对服务、任务、Cookie、快照与数据归属。新安装也不能自动认领旧用户数据。[独立部署说明](../../../centaurAI-spark/docs/workbench/huohua-independent-service/huohua-boxd-manual-deployment.md) · [旧数据布局](../../../centaurAI-spark/docs/workbench/deployment.md)

## 客户端与服务的发行边界

火花当前客户端 `applicationId=centaurai.wanx.huohua-workbench`，使用 `wanx-bridge.huohua` 的 HTTP/SSE 合同，并允许查询 Bridge 服务状态。市场构建 `client/build-market.mjs` 会同时固定包与 manifest 的版本；普通本地构建仍存在 `package.json=0.10.0`、manifest `0.10.6` 的版本差异。[市场构建](../../../centaurAI-spark/client/build-market.mjs) · [本地构建](../../../centaurAI-spark/client/build.mjs) · [客户端传输](../../../centaurAI-spark/client/runtime.mjs)

清单的 `clientRange` 仍为 `>=0.1.4 <1.0.0`，但 WANX 当前实现把它保留为签名元数据，不以客户端版本号直接 gate 应用；不能据此判定火花在 WANX 1.x 上必然被拒绝。实际准入应核对 Host 协议、Backend 合同和服务准备结果。[WANX 兼容性实现](../../apps/personal-client/applications/compatibility.mjs)

建议第一阶段由 Admin 定向给盒子安装服务，服务就绪后发布/激活火花市场客户端；先闭环服务 OTA，再增加应用安装触发服务准备。客户端显示未安装、安装中、不兼容或维护状态即可，不能自行下载服务包、执行 Python 或选择任意盒端版本。卸载客户端应用只解除其关联，服务停用和业务数据删除单独授权。

## 跨仓实施顺序与验收

| 阶段 | 影响仓库与入口 | 依赖及验收结果 |
| --- | --- | --- |
| 1 冻结真实服务合同 | 火花 `package_box.py/boxd.py`；OS 与 Admin 的可选服务 schema、向量 | 固定真实 serviceId、服务版本、平台、profile 身份、离线依赖、数据兼容和维护接口；干净 Linux 可离线启动 |
| 2 完成服务与接入 | 火花 `service/store/runtime/capabilities`；WANX `service_registry/huohua/server` | 完成排空、重启授权、实际版本证据、持久数据及激活门禁；手动联调安装、升级和候选写入后回退 |
| 3 完成生产 OTA 执行 | OS `box_optional_service_*`、`box_updater*`、`box_ota_state`、恢复入口；Admin optional service、controller、SQL、前端 | 真实 profile、生产任务分派/信任、持久互斥、自更新/Rescue 兼容、审批推广、分配与实际库存；测试服务继续隔离 |
| 4 存量盒纳管和定向试点 | 基础 WANX 发行、升级器发行、火花服务发行 | 先通过可信路径交付 Bridge/升级器/profile；确认现场能力后给 A 派火花任务，B 无分配保持未安装 |
| 5 应用触发安装 | Admin 市场签名合同、WANX 两客户端与 Host SDK、火花 manifest/UI | 定向试点稳定后实现选盒、权限、服务依赖准备和应用原子激活；共享服务版本冲突时保留原可用版本 |

阶段 2 与阶段 3 可在阶段 1 合同明确后并行，客户试点需要两者均通过。首批目标应是“一台受控盒子首装、一次独立升级、一次失败回退”，再扩展多盒灰度。最低升级器版本填写首次交付并验证真实能力的版本，同时核验实际 profile 和恢复能力；不把本机源码版本当作全量盒子支持证明。

建议生产运行目录采用 `/opt/wanx/services/huohua.workbench/releases/<sha256>/`，由升级器管理 `current`；数据、会话和密钥保存在 `/var/lib/wanx/services/huohua.workbench/` 下独立命名空间。固定 `centuaros-huohua-boxd.service` 和低权限账号由 OS 受信规则交付；服务包无权修改 unit。上述路径及规则是拟实施目标，需与升级器沙箱、磁盘预算和旧盒迁移一起验收。[运行形态设计](../../../centuarai-os/docs/optional-box-service-ota-design.md)

正常升级依次执行：领取固定计划与签名发行 → 验签下载和私有暂存 → 设备锁内复测基线并取得执行许可 → 持久化开始事件及 ACK → 火花维护排空 → 停旧进程并切换候选 → 核对进程、数据及 Bridge 探针 → 提交安装账本和激活记录 → 开路由并补报终态。首装失败要证明恢复未安装；升级失败要证明精确旧版重新就绪。回执丢失只重放原回执，不重复安装或发表。

| 验收场景 | 必须证明的结果 |
| --- | --- |
| A 有分配、B 无分配、C 已转移归属 | 只有 A 获得可执行任务；过期库存、撤权、错误签名/profile/平台均被阻塞 |
| 安装或升级后关闭客户端并重启盒子 | 服务身份、用户授权、排期恢复符合权限和现有不自动补发策略，无重复发表 |
| 发布执行中触发升级及超时 | 先停止新领取；结果不确定或无法排空时阻塞升级，旧服务保持可恢复 |
| 候选已经写入任务和账号后回退 | 旧版继续读写，保留新回执、Cookie、视频及归属，不恢复旧库覆盖新事实 |
| 下载、开始 ACK、切换、激活、终态各阶段断网或断电 | 重启按原持久事务恢复；首装回退与升级回退各有真实证据 |
| 普通 OTA、自更新、Rescue 与火花任务并发 | 同盒保持唯一持久任务占用，旧恢复程序不会绕过未知事务 |
| 候选故障或未安装火花 | 基础 WANX 仍可用；客户路由不暴露未提交候选，安装包不含用户会话 |

本次已运行 OS 合同向量测试 3 项、可选服务 wire 测试 8 项，合计 11 项通过。其中 `test_release_expiry_and_opt_in_service` 明确验证带有效测试签名的火花发行仍被当前执行器拒绝。该结果证明当前测试合同与准入边界，不代表 Linux/systemd、真实 Admin 双盒或火花发布业务已经完成生产验收。[合同测试](../../../centuarai-os/tests/contracts/test_optional_box_service_ota_contract.py) · [准入测试](../../../centuarai-os/tests/test_box_optional_service_wire.py)

## 火花端建议改动与验证

| 优先级 | 文件或模块 | 交付及完成条件 |
| --- | --- | --- |
| P0 | `tools/workbench/package_box.py`、构建流水线 | 干净 Linux 构建，无隐式 `conf.py`；固定依赖和浏览器；签名发行及文件清单可核验 |
| P0 | `boxd.py`、`runtime.py` | 运行身份、完整探针、发布 worker 与浏览器烟测；错误版本及依赖缺失不会报告安装成功 |
| P0 | `service.py`、`store.py`、本地维护模块 | 持久维护门禁、停止新领取、排空和恢复；升级期间不会重复发表 |
| P0 | `store.py`、数据元数据 | schema/初始化/归属证据，候选写入后旧程序可继续运行 |
| P0 | `capabilities.py` | 重启后无人值守授权的明确恢复策略；撤权、过期和 Bridge 重启仍拒绝越权 |
| P1 | 秘密及会话存储 | Cookie/storage 的加密与权限、保留、迁移及归属隔离验证 |
| P1 | `client/build-market.mjs`、manifest、UI | 客户端和服务版本分别发布；服务依赖未满足时有明确准备状态 |

火花现有测试可继续复用 `test_boxd.py`、`test_capabilities.py`、`test_package_box.py`、`test_durable_jobs.py`、`test_publish_now.py`、`test_publication_recovery.py` 和 `test_box_lifecycle.py`。新增验收应围绕真实缺口：干净构建、精确依赖、浏览器启动、排空并发、候选写入后回退、重启授权、半初始化恢复和旧部署纳管。真实平台发表属于单独的受控业务验收，OTA smoke test 使用合成页面及无副作用接口。

## 源码定位索引

下列行号对应本次核对的火花提交：

| 位置 | 主要证据 |
| --- | --- |
| `tools/workbench/package_box.py:20` | 运行依赖集合 |
| `tools/workbench/package_box.py:44` | 仅收集现有配置文件 |
| `tools/workbench/package_box.py:64` | 当前服务包 manifest |
| `tools/workbench/package_box.py:102` | 在线安装运行环境与浏览器 |
| `huohua_workbench/boxd.py:30` | 环境变量配置、版本、数据目录 |
| `huohua_workbench/boxd.py:172` | 委托身份、作用域和任务授权 |
| `huohua_workbench/boxd.py:193` | 服务启动和停止 |
| `huohua_workbench/boxd.py:210` | 三种探针 |
| `huohua_workbench/service.py:34` | 单实例锁和启动恢复 |
| `huohua_workbench/service.py:50` | 直接取消后台任务 |
| `huohua_workbench/runtime.py:31` | 懒加载发布子进程 |
| `huohua_workbench/runtime.py:75` | 子进程停止策略 |
| `huohua_workbench/store.py:23` | SQLite 初始化和当前元数据 |
| `huohua_workbench/store.py:341` | 中断、错过排期的恢复策略 |
| `huohua_workbench/capabilities.py:67` | box/user/space 作用域键 |
| `huohua_workbench/capabilities.py:216` | 关闭后撤销并清空内存授权 |
| `huohua_workbench/capabilities.py:252` | 排队执行依赖内存用户委托 |
| `myUtils/login.py:97` | 浏览器 storage_state 落盘 |
| `client/build-market.mjs:25` | 市场构建统一包与清单版本 |
