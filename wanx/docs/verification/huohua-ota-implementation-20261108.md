# 火花统一 OTA 实施与验收

本次实现火花独立盒端服务的 SSO Bridge 接入、离线制品、受信安装与回退，以及 Admin 定向管理。按本次确认，local-trust 不在实施范围。102 定向试点已完成；应用市场自动触发安装及生产推广仍按独立上线流程执行。

## 交付顺序与验收标准

| 工作 | 依赖与文件边界 | 验收标准 | 当前状态 |
| --- | --- | --- | --- |
| 固定制品与运行合同 | Spark `tools/workbench`；OS 受信 profile；Admin registry | 干净源码、锁定 wheel 和双浏览器、逐文件哈希、Ubuntu 24.04/26.04 amd64 Python 3.14 离线启动 | 102 实际 Ubuntu 26.04.1 / Python 3.14.4 非 root 离线安装、依赖和双 sandbox 浏览器通过；rc.5/rc.6/rc.7 正式包已构建 |
| 服务维护与数据恢复 | Spark `huohua_workbench` | 停止新领取、既有执行排空、候选提交前封门、失败回退保留新事实与归属 | 完整工作台 251 项通过、2 项跳过；新增恢复与文件安全检查通过 |
| Bridge 准入与授权恢复 | WANX `server/bridge` | 只公开已提交且运行证据匹配的服务；恢复不延长原任务授权；损坏的可选服务状态不拖垮基础 Bridge | Bridge 与 provisioning 完整检查 2484 项通过、3 项跳过 |
| 正式 OTA 管理与执行 | OS updater/helper/Rescue；Admin 后端、SQL、升级中心 | 独立生产信任、审批与设备范围、共享持久占位、精确回退及可重放回执 | Admin 后端 116 项、前端 170 项通过；OS 278 项通过、6 项跳过，跨仓 HTTP 与独立复核通过 |
| 可信 bootstrap | OS profile provision；WANX `tools/provision-huohua-bridge.py` | 低权限账号、固定 unit、只读激活挂载、真实 SSO 容器证据、保持已有安装密钥 | 工具和回归已落地 |
| 真实盒试点 | 可访问的合适系统盒子、独立 Admin 验收环境 | 首装、独立升级、候选写入后失败回退、重启；A 有分配、B 无分配 | 102 首装、独立升级、候选数据写入后的整机重启回退均通过；第二设备未分配场景仅有自动测试覆盖 |

## 已冻结的运行边界

服务为 `huohua.workbench`，签名产品为 `wanx-box-service`，扩展为 `wanx.optional-box-service.v1`，制品类型为 `service-tar`。新部署受信 profile 为 `huohua-python314-ubuntu-x64` v1，digest 为 `6fab32770dbeaa4210be3afa9ee9b585144f3b4a13b53cd1631bb372965e9e50`，Ubuntu 24.04/26.04 x86_64 共用系统 Python 3.14 安装规则；制品 platform 仍必须匹配设备实际系统。旧 `huohua-python312-ubuntu2404-x64` 保留恢复兼容。包不能提供 root 安装脚本、unit 或自选执行路径。

OS 管理 `/opt/wanx/services/huohua.workbench/releases/<sha256>/`、`current`、安装账本和 root 所有的 `activation.json`。业务数据位于 `/var/lib/wanx/services/huohua.workbench/data/`，使用独立低权限账号和固定 `centuaros-huohua-boxd.service`，监听 loopback 8093。安装前必须识别旧部署数据，不能把未知用户数据当作全新空目录认领。

Bridge 的生产注册表默认要求 OTA 激活记录。候选的就绪探针仅供本机升级器验证；公开火花路由还要求已提交的版本、构建、源提交、制品、runtime、profile 和激活代次完全匹配。人工 legacy 部署必须显式声明 `activation.mode=legacy`，不能被报告为已纳入 OTA。

第三方 Cookie 和浏览器 storage 仍使用既有文件格式，依靠服务数据目录权限隔离；本次新增的加密仅覆盖任务恢复凭据，不代表已完成所有第三方会话文件的加密迁移。

用户任务恢复保留已有最多一小时的 `taskExpiresAt`，并受上游凭据到期、已知平台权限版本和归属变化约束。Bridge 与火花分别加密保存各自持有的有限任务状态；火花不保存 Host 会话或上游凭据。超过原授权窗口的排期仍需用户重新授权，本次不新增长期后台授权。任务结果未知时仍按既有策略进入人工复核，不能自动补发。实机没有验证真实社交平台的续发或客户端关闭后的长期授权行为。

## SSO 首次纳管

旧升级器 helper 的文件白名单无法接收本次新增模块。首批盒子须先通过可信 bootstrap 安装相互匹配的 updater、helper、Rescue 支持和 Huohua profile，不能仅提高版本号后推送新包。正式后续任务还需核对实际 profile、Bridge 和恢复证据。

1. 先确认设备身份、系统版本、磁盘、现有火花服务与数据；确认没有需要先迁移的旧部署。
2. 安装 OS 固定 profile，创建服务账号、unit 和目录。
3. 从已安装 SSO Bridge 的签名身份导出可信 PEM 公钥，运行 `tools/provision-huohua-bridge.py --box-id <设备ID> --bridge-url http://127.0.0.1:<Bridge端口> --bridge-public-key <公钥文件>`。工具只写固定身份文件、注册表和服务环境，不重启进程；已有不同身份会被拒绝。
4. 通过 OS 受信部署规则创建 SSO WANX 容器，注入专用注册表、只读激活目录及实际不可变 image ID。基础镜像声明 `io.wanx.bridge.huohua.protocol=1`。
5. 应用 Admin 专用 SQL，配置独立发布与许可信任。登记候选、明确审批 canary 设备范围、分配服务，按实际库存预检并确认固定计划。
6. 按下面场景验收后再考虑 stable 推广。真实社交平台发表不属于 OTA 烟测；使用合成任务与无副作用页面。

## 102 实际盒验证

设备 `centauros-87dbbea31110a0bbf0000fe1`，公司地址 `192.168.0.102`，通过用户指定 97 跳板连接。实际 Ubuntu 26.04.1 LTS / x86_64 / Python 3.14.4，SSO WANX，原有 Semantica、图服务与知君容器正常；未发现旧火花安装。验证不涉及 local-trust。Ubuntu 24.04 共用规则已获自动测试覆盖，但没有在 Ubuntu 24.04 实物机上验证 Python 3.14。

102 用 UID 1000 从新锁准备 45 个 wheel，在新虚拟环境断网安装、执行 pip check、导入实际依赖；Patchright 与 Playwright 均以 `chromium_sandbox=True` 读取合成页面。构建阶段仅临时授权任务目录下四个具体 Chromium 路径的 AppArmor userns，完成后已卸载；固定服务路径的生产 AppArmor 通过可信 provision 安装。Ubuntu 24.04 机器须先具备受信的 `/usr/bin/python3.14` 和 venv/ensurepip；该 profile 不负责在线安装系统解释器。

Bridge 从原不可变镜像叠加已提交源码构建，image ID `sha256:9a4f8bbee74b0f7f5380c444b0e71943160434edef071deaed308eb40a885bbe`。离线、非 root 验证确认 Octop 文件哈希及其他依赖版本保持一致，209 个包依赖检查及 7 项登录合同通过。候选已实际切换到 102，原容器及原数据保留以便回退。Bridge 自身仍使用原 Python 3.12，Python 3.14 统一针对火花服务。

独立 Admin 使用真实 MySQL 8.4、Redis 7.4、HTTPS、密码登录、两名管理员分别登记/推广和设备 key，未修改生产 Admin 数据库。验收入口 `qualification_server.py` 在隔离环境中组合原 Admin app 生命周期与原设备路由；正式部署中这些设备路由在 Consumer 进程，验收没有替换其鉴权、Depends、数据库服务或签名逻辑。inventory、lease、events 均来自固定 systemd updater。审计记录为 `separated-approval`，证明本次实际分离操作，不代表系统强制双人审批。错误 device key、空请求校验及 102 初始未分配时空 claim 已实测；没有第二台未分配物理设备或独立低权限实机账户的验收证据，这些边界目前由自动测试覆盖。

正式 Python 3.14 制品均从 Spark 干净提交 `8a8ddd21b3507bd15947790ea120dde56c35dc11` 构建，实际 platform Ubuntu 26.04 x64：

| 版本 | 字节 | SHA256 |
| --- | ---: | --- |
| 0.1.0-rc.5 | 732818802 | `0fbbd35e1e230e98647ce1cbc23e19fc9327eca781afd58900ed0d4bf191fa53` |
| 0.1.0-rc.6 | 732818803 | `7f87476ece572474f59f701fd2bc4fcd69ae1553c641428d53dd2e03b66cd5ea` |
| 0.1.0-rc.7 | 732818799 | `d723b16f71c2c9b8166347b2ed003c6636bf205b516ce4deebc890811f42a2e5` |

三者为同一应用源码、不同发行版本，用于验证升级机制；不能据此声称测试了跨数据库 schema 迁移。

| 场景 | 实际 operation | 结果 |
| --- | --- | --- |
| 早期 rc.2 首装失败 | `osop_4dd1062fbf5340f48c14e427163ec6de`、`osop_14e7852bba7e4deaab13cba0bb5f4732` | 两次自动 `rolled_back`，恢复 `not_installed`、`platformAvailable=true`；未伪造回执 |
| rc.5 首装 | `osop_8d75947a747540e6af59fd06e539f2cf` | `staged → applying → verifying → succeeded`，sequence 4，activationGeneration 1，outbox 0 |
| rc.6 首次派单被渠道更新阻挡 | `osop_aea8b1cf2ab8415ba74c74499a7b096a` | rc.7 提前推广后，控制面拒绝 rc.6 apply lease；正式取消后收到真实 `failed/PLAN_STALE`，Admin `cancelled`、sequence 2、recoveryVerified=true、outbox 0；rc.5 未被切换 |
| rc.5 → rc.6 顺序升级 | `osop_f7871b4bf3a441ae963b51a95598a166` | `staged → applying → verifying → succeeded`，sequence 4，activationGeneration 2，outbox 0；合成账户、任务、checkpoint 和数据归属全部保留 |
| 候选写入后重启回退 | `osop_857e4ce5512c455f800d9105b2034e12` | 真实 `staged → applying → rolling_back → rolled_back`，sequence 4，recoveryVerified=true、platformAvailable=true、outbox 0；精确恢复 rc.6 / generation 2，baseline 与 candidate 两组合成数据均保留 |

rc.6 成功计划 `osplan_c30a2b9e278b490c9df942692fe0cb92`，planDigest `8110a2da44d4796dd46cbf0470a7f48e409682ec16bd37ce10f44cefa9ee2ffd`。采用相同 rc.6 字节、递增 metadataSequence 5 的新发行，随后才推广 rc.7 metadataSequence 6，没有回退渠道高水位。升级器受信 runtime 已更新为 `1.9.29-bdb66b75799cc324`，Rescue 及 core/base pin/unit 字节全部核验。

rc.5 成功计划 `osplan_ae2cf3fa3ddd4d8f9e5e1fda41cdc6f9`，planDigest `ac87a8d31240736d3f04e5cc564bdb8baa33d5e78722a807203beb48d91f3ce8`。固定服务用户创建的专用合成账户、任务和 publication checkpoint 已读取校验，任务为未来到期且 `needs_review`，不会真实发布到社交平台。数据 instanceId `8add14016dc24f1cb663b41a454d2cf4`、initializationGeneration `a51cccef401f40f6991aa05f5ec32f8e` 保持不变。

重启前 boot ID 为 `37748e12-5994-43b5-af8f-6dcc1844d44a`，重启后为 `a90f64b3-64a4-4bf1-9d21-6fa17f39cd4d`。中断器只观察事务并停止进程，不改写 OTA journal、ledger、activation、current 或回执：在 current 已切 rc.7 且没有 commitReady 时冻结升级器，停止候选进程，用候选代码和固定服务 UID 写入专用合成数据，然后终止升级器并执行 `systemctl reboot`。这是整机正常重启的中断恢复验收，不是拔电试验。

### 实机发现并修复的问题

- 共享 profile：火花统一 Python 3.14，保留旧 3.12 profile 仅用于已有安装恢复；本机 SSO Bridge URL 可使用设备自身 UP 网卡的字面 IPv4，仍拒绝远端/DNS origin。
- Bridge 注册表文件名修正为实际读取的 `service-registry.json`；证据探针明确 `docker exec --user 10003:10003`，避免仅 UID 引起 GID 错误。原进程、启动时间、boot ID、环境和镜像验证保留。
- 受限离线安装增加 `PrivateTmp=yes`，解决 pip 无可写临时目录；不降低网络、用户或文件系统限制。
- 全新 bootstrap 停止不存在 unit 时，只有独立确认 `not-found/inactive/dead/MainPID=0/ControlPID=0` 才接受返回码 5。
- 升级器仅在纳管火花时增加 `CAP_DAC_READ_SEARCH`；实机同进程 `/proc/PID/fd` 对照确认原权限失败、增加后 9 个描述符可读。火花服务本身仍无 capability。
- Spark `/version.activationGeneration` 从环境解析为严格正整数；修复字符串与受信整数回执不匹配。没有放宽升级器版本证据校验。
- 处理渠道替换后的权威拒绝：真实 rc.6 lease 连续返回 409 `RELEASE_UNAVAILABLE`，原 transport 折叠为临时故障而持续 staged。修复仅接受精确 optional-service apply lease 路由上的此 409，设备正常报告失败并释放占用；其他错误仍重试。实际 HTTP transport → worker 回归先红后绿，82 tests / 67 subtests 通过。
- 首次隔离脚本曾停止 RemainAfterExit 的 core/base recovery guard，通过 systemd Requires 影响 NetBird 与基础授权。已恢复原前置状态，并修正流程始终保留这些 resident guard；后续切换和重启前核验其 runtime pin、helper 完整性与 unit 字节。

最终证据导出于盒子 `/var/lib/centuaros/huohua-validation-20261108/exports/final-post-reboot`，manifest SHA256 `4d95a25956134274d9746d2f0feb9ae40768eaf40f02189ca4de83b47fe742a1`。包括 6 次真实操作、API 事件/库存/目录、只读一致性 SQL 中的计划/审批，以及两个隔离 schema 的 single-transaction dump；分别采集前后核对终态指纹和设备 journal 未变。数据库快照含敏感数据，仅保存在 root 私有目录。

### 验收后的最终状态

102 已恢复原生产环境：updater `1.9.28-b88a7d7ce3621212` 及原配置、信任、helper、状态、unit 和启用状态均通过 23 个文件基线哈希及实际进程证明；core/base 恢复 runtime pin 和 unit 模板一致，NetBird 正常。生产 API `https://boss.nexusaos.qitus.cn/prod-api` 通过系统信任的 TLS 1.3 握手；这证明生产端点可达，不表示执行过生产 Admin rollout。

原 WANX 容器 `0c194d91073ddfecfe8f0e12d1b78d8ec16ec8e7a80112299e2b389383c150f8`、镜像 `sha256:226fc80fcf680fa847a1521facba683fb8701a197520cf9dad6a1cac6aeed8d2` 已恢复，完整配置、8 个挂载、SSO 身份文件和原数据目录身份核对通过。Docker 重启将空 DNS 配置从 null 变为 []，仅按其相同语义比对，其他差异未忽略。WANX、Semantica 和知君三个运行容器均 healthy。

验收火花 unit 已停止并禁用，候选 Bridge 已停止且不自动重启。火花 data、身份、release、ledger 和两组合成数据全部保留；新增实验 OTA 配置及公钥信任文件已归档退出固定路径，任务 CA 已从证书路径、链接及系统信任 bundle 中移除。生产固定路径恢复后，验收 updater/helper/state/unit 留存于任务根的 `validation-final/`。独立 Admin/MySQL/Redis/HTTPS 容器已关闭，数据库卷保留；关闭回执 SHA256 为 `e95cbf37702fb237758306e6f08f7c36ae72b971b883c415dfd3ed3f10999d6b`。

实际日志、状态和回执在盒子 `/var/lib/centuaros/huohua-validation-20261108/`。实验私钥、设备 key、CA、浏览器和制品不提交源码库。本次完成实现与真实盒验证，未变更生产 Admin 数据库，也未把验收用独立根推广成生产信任。正式启用仍需部署配套 Admin/Consumer、SQL、独立生产根，完成可信 bootstrap 和 Bridge 更新；原 1.9.28 不能视为已经具备这套火花管理能力。

源代码验证基线：Spark `8a8ddd21b3507bd15947790ea120dde56c35dc11`，WANX Bridge `23f770e4c00e653f5bcde4e3261f926429d4307c`，OS `144b18f2dc9752302fac6a5369a1c167fd4db2bf`，Admin `235a315deebbcaa754cff9ee9f85a70660cdcbed`。四仓使用 `codex/huohua-ota-production-20261108` 分支，未自动合并 master。

## 历史构建环境证据

2026-11-08 的 Linux 构建验证运行于本机 Docker 的 amd64 仿真容器，基础镜像 Ubuntu 24.04，Python 3.12.3。锁定载荷含 45 个 wheel、1246 个文件，共 1,497,990,162 字节。断开容器网络后，在新的虚拟环境使用 `--no-index --require-hashes` 安装成功，`pip check` 与 OpenCV 导入通过，Patchright 和 Playwright 均从最终载荷路径启动 Chromium 145.0.7632.6 并读取合成页面标题。

载荷清单 SHA256：`68be4b41c1ea65e1b0696a6ec2f9c30d60876c01766a5bda1fa69b25c2f0824a`。原始日志与 `verification.json` 位于本机任务产物目录，不包含于源码仓库。此结果是 Linux 离线载荷验证，不能替代真实盒或固定 systemd unit 验收。初次浏览器烟测使用构建工具默认启动参数；追加生产 `chromium_sandbox=True` 探针在默认 Docker 安全策略下报 `No usable sandbox`。随后新建断网、非 root、无 SYS_ADMIN 且只放开 seccomp 的任务容器，执行真实 `synthetic_probe`，依赖与两套 sandbox 浏览器均通过，定位到默认构建容器的 seccomp 限制。受信 OS profile 另加入仅匹配固定制品浏览器路径的 AppArmor userns 规则，保留浏览器 sandbox；本段为历史构建结果；102 的新 Python 3.14 同配置探针现已通过，见实机章节。

历史验收盒 home80（192.168.1.80）在 SSH 密钥交换前断开，尚不能读取当前系统和业务状态。备用构建盒 192.168.0.101 实测 Ubuntu 26.04.1、Python 3.14.4，磁盘剩余约 2.3 GiB，当时不满足旧 Python 3.12 profile，且剩余空间不足。发现的 Admin 实例为生产服务，未将其当作独立预发环境或向其派发任务。

## 实机验收记录要求

每次记录设备、发行与制品摘要、profile、operation/attempt/plan 绑定、安装前后实际库存、关键回执、业务事实与恢复结果。完整推广矩阵还应覆盖 prepare 超时、开始 ACK 丢失、终态回执丢失重放、普通 OTA/自更新/Rescue 并发互斥，以及原任务授权窗口内关闭客户端后的重启恢复。此次实机已测首次安装成功与失败恢复未安装、升级成功、候选写入后精确回退及切换和提交之间整机重启；其他场景有自动测试并不等于全部已在物理盒实测。

未安装火花、候选故障、任务状态损坏时，基础 WANX 仍须可用；未分配设备与已转移归属设备不能领取任务。只有实际通过的场景才能写入正式推广验收记录。


## 本次回归结果

| 范围 | 结果 | 边界 |
| --- | --- | --- |
| WANX Bridge 与身份 provisioning | 原 2484 passed，3 skipped；新增 activation 38、provisioning 27 passed | 包含激活门禁、任务状态恢复、权限版本、写盘失败与基础服务隔离；不是镜像实机验收 |
| Spark 工作台 | 原 251 passed，2 skipped；Python 3.14 后 291 passed，2 skipped；CLI 22 passed；代次修复组 39 passed | 2 项需已安装原生 WANX 浏览器；后续新增 offline 释放检查 9 passed、任务凭据文件安全组 15 passed、真实长文件名打包组 20 passed |
| OS 升级相关组 | 原 278 passed，6 skipped，166 subtests；权限修复组 226 passed；拒绝处理组 82 tests / 67 subtests | 6 项为显式 Docker Engine opt-in；独立 Linux Huohua 组 17 passed |
| Admin 后端 | 116 passed，0 skipped；本次 production/runtime 组 31 passed，0 skipped | 含配套 OS worker HTTP/开始 ACK 丢失恢复、审批撤权、同版本不同旧制品、撤回源发行 |
| Admin 前端 | 170 passed，生产 build 通过 | 新火花管理页签及原升级中心检查 |

以上表格为自动回归；真实 MySQL、systemd/AppArmor 与 Admin 派单证据见 102 实机章节。物理断电、MySQL 并发压力及正式生产控制面 rollout 未据此宣称通过。


## 历史 Python 3.12 候选制品

`huohua-boxd-0.1.0-rc.1.tar.gz` 已从 Spark 提交 `06fbf862b69d54fb885b0fa57d0dc9e5a6e3d9d2` 构建，大小 732,795,313 字节。SHA256 为 `eb87885762c46e2766a8f0e8c5dd87d68532ed100c7383f2571ee202204c3b72`，profileDigest 为 `2ed938432d04035fff396c7e70e845442f0bb9abce5246d9479842bda3255069`。

OS 提交 `a96b012c0dc3b4897ac5c635709f0d67386bbf94` 的实际 `archive_index` 已接受该制品，1393 个文件的内容摘要逐一匹配。真实长 wheel 文件名仅在归档中缩为其原有兼容标签，字节和哈希未变，短名 wheel 已在断网 Linux 中实际安装验证。原始载荷清单保持不变。

制品和 `artifact-verification.json` 位于构建机 `/Users/longxiping/.codex/tmp/huohua-ota-runtime-20261108/`，未提交二进制到源码库。该包尚未经过真实盒定向试点，也未在生产 Admin 登记或派发。
