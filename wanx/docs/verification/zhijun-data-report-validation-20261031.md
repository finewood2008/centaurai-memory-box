# 报告缺陷 B：知君启动兼容性复核

## 结论与范围

本轮核对《万象客户端问题报告-20261031.md》第二条。开发期间拉取到的 CodeUp master `152452fc` 已合入 `cce36a76`（MR #145），包含个人版、团队版的 schema 持久化和可信写入者延续修复。本轮沿用该修复，没有另写重复的生产逻辑；补充两版回归及真实 Electron 启动验证。

这属于万象电脑端应用管理器的修复，不修改 WANX 后端接口，不要求重新签发旧知君包。版本戳由 Host 统一保存，绑定验签后的写入者，而非信任应用自行提交的任意格式声明。

## 核对点

- `.data-access/<appId>.json` 的旧 v1 凭证仍可读取；经验证后记录 v2 数据格式证据，并在实际使用的 profile 保存 `.data-schema.json`。
- 只有同一 profile 下与已验签 artifact ID、descriptor 摘要完全匹配的旧写入者可以回填其格式声明。不能用新候选包的声明证明未知旧数据兼容。
- 保留 import、prepare、select、launch、回滚与身份隔离检查。缺少可信证据、坏凭证、坏戳或损坏的角色文件仍然拒绝。
- 格式版本已知且超出读范围时返回 `APPLICATION_DATA_SCHEMA_INCOMPATIBLE`；不能把不兼容版本伪装成缺信息，也不能覆盖原版本证据。
- 无清空、移动或重建用户数据的操作；采用临时签名密钥和临时数据目录测试，没有修改实际安装包、信任配置或本人 profile。

## 本轮新增验证

两版 `tests/upgrade-review-compat.test.mjs` 补充相同场景：

1. 签名共享知君 v3、版本 1.0.1，现有 Chromium 留存内容及匹配旧 v1 凭证，无 schema 戳：准备、启动、Host 重启后再次启动成功；保存版本及写入者证据，原文件字节不变。
2. 已知 schema 2.0.0 超出目标读范围：准备与启动均拒绝，错误码为明确不兼容，原凭证不被覆盖，不创建子进程。
3. 无凭证的未知数据：拒绝启动，不补戳，原文件保留。
4. 真实 Electron 进程验证签名共享知君 v3 的完整 Host 启动路径，保留 `releaseAccess: account` 的授权检查，以隔离授权夹具提供许可。子进程实际读取预存角色文件；关闭 Host、重新创建 Host 并再次启动，角色文件和留存文件字节不变。

第 4 项使用签名隔离测试程序及合成角色文件，验证真实 Electron 与应用管理器的启动和数据延续；不代表用户真实对话、模型效果或 Windows 安装包已经验收。测试窗口隐藏，不替换用户当前客户端。

## 结果与复验

- 个人版相关回归：414 passed / 0 failed / 3 skipped。
- 团队版相关回归：402 passed / 0 failed / 3 skipped。
- 两版新真实 Electron 用例单独启用：各 1 passed / 0 failed。
- 常规回归跳过了需要显式配置的真实 Electron 和跨仓库 seam；上述新增真实 Electron 场景已另行执行。没有把跳过的旧场景记为通过。
- `git diff --check` 通过。
- 团队版初次因隔离工作树缺少生成的 Studio 适配器、Builder bundle 失败；按当前源码生成测试所需产物后重跑通过。没有修改 Builder 业务源码。
- Python 后端和前端页面没有改动，本轮未运行后端 `make all`、未构建或发布 Windows 安装器。

日志（本机临时验证输出）：`/tmp/zhijun-data-personal-regression-20261031.log`、`/tmp/zhijun-data-team-regression-20261031.log`、`/tmp/zhijun-v3-native-account-20261031.log`、`/tmp/zhijun-v3-native-team-account-20261031.log`。

真实 Electron 复验命令：设置 `WANX_ELECTRON_APP` 为测试机上正常 Electron.app 的绝对路径，再运行 `node --test --test-name-pattern='real Electron reopens signed shared Zhijun v3' apps/personal-client/tests/upgrade-review-compat.test.mjs apps/team-client/tests/upgrade-review-compat.test.mjs`。密钥与数据均由夹具临时生成，不需要发行私钥。

## 尚未完成的交付验证

报告来自 Windows 1.0.2.0。本机仅完成 macOS 隔离代码和 Electron 验证，没有用户 Windows 备份目录，不能据此证明其全部触发条件已经实机复现。源码修复已经在 master，不等于旧安装客户端自动更新；仍需用包含 #145 的新版电脑端在 Windows 上保留原 profile 验收。本轮仅提交补充测试和验证文档，不发布客户端或修改用户实际数据。
