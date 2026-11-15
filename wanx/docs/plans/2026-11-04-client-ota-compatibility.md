# 客户端 OTA 兼容性修复计划

依据测试团队报告逐项复现；报告为问题证据，不作为自动扩大生产支持矩阵或发布授权。

## 验收与边界

- 只改客户端 OTA（Windows x64、macOS x64/arm64），盒端 Ubuntu 精确规则不变。
- 新签名 OS 策略严格校验，与新运行时事实配合；旧请求/旧发行保持精确规则。未知事实与策略失败关闭。
- 仅 Host 协议不变且数据向后兼容的显式签名应用策略取消全量版本白名单；应用安装/启动的数据和后端兼容守卫保留。
- 签名、摘要、版别、架构、安全代次、渠道、晋级内容一致性及安装前复核仍生效。
- 不修改已推广发行或默认支持矩阵，不生成正式签名/安装包，不宣称跨系统真实升级验收完成。

## 工作流与所有权

1. 核对与复现：真实 clientBlockers / Admin.match_platform 已复现 OS 与应用误阻断。
2. 冻结契约：主代理持有 JS policy/helper、contracts 与签名工具及发行文档；客户端 agent 持有 identity/client-service 及对应测试；Admin backend agent 持有 service/policy及测试；UI agent 持有只读展示及测试。使用独立 codex 工作树，保留原分支已有工作。
3. 实现和回归：OS 边界、Server、未知事实、旧客户端、新旧策略、应用独立升级、协议冲突、安装前状态变化、签名篡改与晋级内容差异。
4. 集成验证：JS OTA/签名/应用兼容相关测试、Admin OTA/rollout回归、跨语言 OS 样例、前端定向测试与生产构建；按改动范围验证，记录环境限制。

## 签名与请求契约

签名 payload 可选 clientOsPolicy，严格对象：Windows kind=windows-build-ranges + ranges[{family:windows10|windows11,minBuild,maxBuild}]；macOS kind=macos-product-majors + majors[]。范围与列表均非空、有界、升序、不重叠/不重复；Windows10 构建10240–19045，Windows11构建>=22000，最大2147483647；Mac产品大版本1–999。

请求 platform 仍必须有 os/arch/osVersion。仅客户端 Darwin 可带 osProductVersion（字符串）；仅客户端 Win32 可带 windowsProductType（原生整数0/1/2/3，0未知，1桌面，2域控制器，3Server）。Mac新客户端探测失败发送unknown，Windows失败发送0；不能缺字段回退旧匹配。Windows版本解析10.0.build[.patch]，补丁不参与build范围。Mac解析major[.minor[.patch]]。

新事实字段存在且发行有新policy时走新规则；字段缺失的旧客户端按旧精确规则。新policy无效时不得回退。os/arch始终精确匹配。

可选 applicationCompatibilityPolicy 严格为 {mode:host-protocol-backward-compatible}；只允许客户端、hostProtocol=1、dataPolicy=backward-compatible。compatibleApplications保留供旧客户端解释。无新策略保持旧白名单，新策略校验实际选定应用Host协议；待选/待准备应用无活动版本时不因缺少版本阻断。协议1旧应用继续现有协议1支持；未知/畸形现代兼容元数据阻断并指出应用。

## 状态

- [x] 已复现问题并核对旧版1.0.4限制。
- [x] 跨端实现与回归。
- [x] 最终验证与交接。

## 最终验证

- 客户端相关集成：245 passed，1 skipped（仅 Windows 真实 Authenticode 用例因当前 Mac 跳过）。
- Admin 契约/强制更新/rollout/旧盒端平台专项：331 passed，包含双端同一88组OS样例。
- 更广 Admin 客户端/升级回归：1317 passed、22 skipped、4 failed。四项均在干净 origin/master 1feb933 独立复现：证书错误枚举断言旧值；其余三个SQLite夹具缺设备证书表。未扩展修改这些既有问题。
- 前端只读组件7项、页面相关102项通过，build:prod通过；真实组件桌面与390px移动预览已检查。
- 临时测试密钥签发的 macOS/Windows 新策略发行，经实际JS签名工具、Python Admin release_payload验签和匹配通过。
- 当前Mac的真实Electron37.10.3探测：Darwin25.5.0、macOS26.5.2；未以此宣称Windows或其他Mac版本已完成实机安装验收。
- 所有改动diffcheck通过。没有执行整仓Python make all；本次万象产品改动仅客户端JS/发行工具，未改Octop Python。
- 未生成正式安装包、修改已签名发行、执行SQL或部署生产服务。
