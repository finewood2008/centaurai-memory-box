# 星图剩余 17 项测试补齐（2026-10-31）

原来受环境缺失阻塞的个人版 8 项、企业版 9 项全部执行通过；同组账号切换保护另 1 项也通过，共 18 passed / 0 failed / 0 skipped。两版完整客户端测试最终均无失败。本次只提交审核分支，不合并、不部署，不操作生产材料。

## 修改与配套来源

WANX 在 master `9b1d7665` 加星图升级 `93c47921` 的隔离组合上验证。本轮 WANX 只改测试基础设施与报告：

- 企业版直接启动指定 Python，不再硬依赖 `rtk`；两版统一支持 `WANX_LEDGER_TEST_PYTHON`，兼容旧 `WANX_TEST_PYTHON`，保留显式依赖路径并使用平台路径分隔符。
- 通过 `WANX_TEST_OS_ROOT`、`WANX_TEST_STARLINK_ROOT` 指定固定源码；WANX 原生数据 fixture 始终导入当前 checkout，而非假设目录必须叫 `centuarai-wanx`。
- Python 启动失败/提前退出立即返回明确测试错误，新增 4 个防超时回归；补齐两版正式打包测试的 `git rev-parse --show-toplevel` mock。

OS 配套修复位于独立分支 `codex/starlink-backup-compat-20261031`，提交 `9be7a3f3721e57ffa04f362327e56363be5ba432`，基于 `bd372e19f26162ac337239ba6deb82f6cd237f80`。它精确识别 WANX schema 34、共享链接撤销记录的结构以及星图 schema 23 的已审查私有材料契约；不导入身份、权限或撤销状态，恢复历史失败任务不重放通知。详细范围见 OS 的 `docs/starlink-backup-compat-20261031.md`。

星图源码仍为 `b489ede9ef8d9641b938a47189069e154a4688e0`；本轮没有为补测试修改星图业务代码。

## 结果

| 检查 | 最终结果 |
| --- | --- |
| 原阻塞场景及同组账号切换保护 | 18 通过，0 失败，0 跳过 |
| 个人版完整 Node 测试 | 2491 总数：2470 通过，0 失败，21 条件跳过 |
| 企业版完整 Node 测试 | 2497 总数：2477 通过，0 失败，20 条件跳过 |
| 启动失败/提前退出回归 | 4 通过 |
| 正式打包工具针对性复测 | 20 通过，2 平台条件跳过 |
| OS 当前结构与保全回归 | 49 通过，34 子用例通过 |
| OS 加密、工作队列、擦除及故障恢复 | 49 通过，38 子用例通过 |
| 已审查历史 Semantica schema 19 | 21 通过，8 子用例通过；3 个 schema 23 专属场景跳过 |
| 现有材料只读盘点 | 原件 92/92、历史文本版本 90/90，与前次盘点完全一致 |

完整测试的 41 项条件跳过仍按原有平台/可选运行条件处理，不包含这 17 项。本轮未重跑未变化的 WANX 根目录后端；前轮同一后端源码的 `make all` 为 5187 通过/31 跳过，Ruff、mypy（701 文件）通过。各组有覆盖重叠，不相加为独立测试总数。

初次补环境后暴露 OS 结构识别问题；完整客户端初次复测又发现两版各 5 个正式打包 mock 未适配来源检查。均修复后重跑，最终结果以上表为准，保留初始失败日志供追溯。

## 复现

准备 Python 3.12+ 及当前 WANX/bridge 依赖、OpenSSL 3、两版 Node 依赖与已生成 renderer/Studio 资源。所有路径使用独立测试 checkout，不连接真实盒子。

```sh
export WANX_LEDGER_TEST_PYTHON=/absolute/python-environment/bin/python
export WANX_TEST_OS_ROOT=/absolute/centuarai-os
export WANX_TEST_STARLINK_ROOT=/absolute/centuarai-wanx-startlink
export PATH="/absolute/openssl3/bin:$PATH"
# 如 local-data-gate 未安装，可通过 WANX_TEST_PYTHONPATH 指定其源码目录。
node --test apps/builder/tests/ledger-runtime-harness.test.mjs
# 在 wanx-client、wanx-team-client 目录分别运行：
node --test --test-concurrency=2 tests/*.test.mjs
```

OS 回归命令（使用 uv；PYTHONPATH 包含固定 WANX src、bridge、bridge/tests、super-clipboard、local-data-gate、星图源码及 OS）：

```sh
uv run python -m pytest tests/test_local_trust_semantica_profile.py tests/test_local_trust_wanx_profile.py -q
uv run python -m pytest tests/test_local_trust_backup_crypto.py tests/test_local_trust_operations.py tests/test_local_trust_transfer.py tests/test_local_trust_transfer_faults.py -q
```

历史结构使用 Semantica `8eba6de476631acdca818cd2608990040f37bb07` 的只读源码快照。相同 schema 版本号不代表同一结构；未审查的 Starlink 老分叉及实际工作台附加结构仍拒绝，不通过更改数据或放宽指纹来制造成功。

## 保全与 79 边界

真实 HTTPS/加密/SQLite 测试全部使用临时合成身份和数据，擦除的系统控制仍使用 FakeRuntime，仅作用于临时根目录。没有新增真实模型调用、真实设备擦除或 79 部署。

OS 修复保持既有私有材料导出边界。新本体、校对、发布历史或组织绑定需要单独的主体映射契约；选中相关数据时继续明确拒绝，不能丢弃记录后宣称恢复成功。现有 92 份材料只做了哈希与版本盘点，未把其完整工作台跨主体迁移计作通过。

79 后续需共同审核并构建 OS、WANX、星图三个来源，不能只更新 WANX 测试代码。维护窗口先做整个持久化数据的一致备份（含 WAL、原件、版本、向量/图数据库、私密配置和旧发行），不能用受限的私有工作区导出替代灾难恢复备份；再完成独立的签名、架构、真实默认模型/检索/图谱/通知及回退验收。

详细日志位于本机 `verification/starlink-ledger-completion-20261031/`，不将临时身份、运行数据或环境日志提交到仓库。
