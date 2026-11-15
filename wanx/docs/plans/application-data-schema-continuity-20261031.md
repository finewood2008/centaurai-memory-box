# 应用本地数据 schema 与可信延续

## 计划与验收

1. 使用真实签名 wanxapp 和 manager 构造旧 profile、匹配写入者凭证、无 schema 戳场景；先确认缺戳和选择版本路径的失败信号。
2. 两版 Host 在应用获得 profile 写入权限前，按已验签 manifest 的 localDataSchema.writeVersion 保存私有、原子 schema 戳。旧包同写入者且缺戳时回填；不从新包推测未知旧数据，不执行或宣称业务数据迁移。
3. 兼容性评估优先采用实际 schema 证据；只有 Host 确认的同一签名写入者可以在缺证据时使用自己的 schema 声明。回滚仍需明确 schema 证据；明确不兼容返回 APPLICATION_DATA_SCHEMA_INCOMPATIBLE，无可信证据返回 APPLICATION_DATA_COMPATIBILITY_UNKNOWN。
4. 核对 import、select、launch、资源准备前后和两版隔离路径；验证拒绝链接、坏戳、写入者冲突和跨账号复用；运行相关客户端回归。

涉及工程仅 centuarai-wanx，覆盖个人版和团队版。不修改已签名包，不删除或移动用户 profile，不修改实际安装应用。

## 代码核对发现

当前 evaluateApplicationCompatibility 已在 trustedDataContinuity 为真时跳过未知 schema 阻断；不能由“收到 UNKNOWN”单独推断为该分支。manager 中 inspect* 数据读取器可能先返回未知；installer.selectCurrent 则尚未传入可信写入者延续。prepareCurrent 自身没有重复兼容性断言。

Host 统一写戳适用于声明 localDataSchema 的签名 wanxapp，早期应用包也可获得同一保护，无需逐个修改应用源码或重新签包。戳记录经授权访问数据的写入者及其格式声明，不声称已完成数据迁移或业务内容校验。

## 已实现

- 个人版和团队版均保存固定 `.data-schema.json`，字段为 `schemaVersion:1`、`applicationId`、`dataSchemaVersion`、`writer:{artifactId,descriptorDigest}`。
- 旧 v1 写入者凭证保持可读；首次成功授权访问 profile 时使用原子 v2 Host 凭证记录 writer、dataSchemaVersion 及 stampPending。先提交权威记录，再投影 profile 戳，最后清 pending。进程中断后只接受精确旧/新戳继续完成，不把任意改动当作可恢复状态。
- 缺戳的旧 v1 状态只允许当前账号/profile 下匹配的已验签写入者推导自己的声明；无可信凭证的未知数据、坏凭证/坏戳和越界 schema 继续拒绝。已有 v2 权威记录可恢复缺失投影。
- 显式格式版本超过目标 readRange 优先返回 APPLICATION_DATA_SCHEMA_INCOMPATIBLE；范围内互相冲突的证据保持 UNKNOWN。回滚不使用缺证据的声明兜底。
- 版本戳保守保留已知 schema 与目标 writeVersion 的较高值；兼容旧包成功启动不等于数据已降级。
- 使用运行时实际选择的 primary、legacy 或 local profile，保留旧目录；独立身份/epoch 不共用凭证。只清理 Host 保留的有界正常临时文件，拒绝链接和异常文件。
- 三个已有数据读取器接受固定的 schema 元数据文件，同时仍拒绝坏 roles 等异常。选择版本路径传递经验签 descriptor 的可信延续判断；import 仍在资源准备前拒绝明确不兼容，launch 在准备后复核。

注意：v2 是 Host 私有元数据格式，不是应用业务数据迁移。旧客户端不具备读取该新格式的能力，不应通过删除凭证或戳来强行回退。

## 验证与交付

已先记录缺戳不被持久化、显式戳被忽略、选择签名版本漏传 continuity 的失败测试，再实现修复。新增用例覆盖首次写戳、匹配凭证回填、未知凭证拒绝、越界 schema、legacy 保留、local 身份隔离、中断恢复、孤儿临时文件、安全拒绝和 schema 不降级。

最终两版相关回归：1089 passed、2 skipped、0 failed（包含 schema、兼容、安装/选择、应用市场、资源、知君/浏览器/半人马环、local profile 和界面）。跳过项为要求显式配置 WANX_ELECTRON_APP 的真实 Electron 测试；尚未在用户 Windows 实机复测。两版 build:renderer 成功，未保留与任务无关的生成 bundle 差异；git diff --check 通过。Python 后端无改动，本次未重跑 make all。

完整客户端测试尝试未全绿：个人版 2443 passed/9 failed/20 skipped，团队版 2459 passed/11 failed/19 skipped。其中各一项文案断言已随新提示更新并纳入最终通过的回归；其余失败包含隔离工作树缺少 server/bridge/.venv 和相邻工程 Python 包的环境问题。另在未修改的原主 checkout 复现备份 LOCAL_BACKUP_DATABASE_SCHEMA_UNSUPPORTED 与团队 LOCAL_ENV_UNSUPPORTED_KEY 断言失败，不能把全部全量失败统称为既有问题。

本机验证输出：`/tmp/wanx-schema-regression-final-20261031.log`、`/tmp/wanx-schema-personal-full-20261031.log`、`/tmp/wanx-schema-team-full-20261031.log`。

开发分支：`codex/fix-app-data-schema-continuity-20261031`。修复通过此分支交付，代码提交不代表已发布；未替换已安装客户端，未操作用户实际 profile。交付需发布新版电脑端客户端，再以原有数据复测知君启动；无需重签每个旧应用包。
