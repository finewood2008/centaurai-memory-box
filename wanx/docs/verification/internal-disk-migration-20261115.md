# 内置盘迁移验证

- 新项目：`/Users/finewood/Projects/Memobox`；ORICO 原副本保留回滚。
- 已迁入全部源码、Git 历史、未提交修改、实际开发 profile 与记忆库，以及 Memory/backend/agent 与个人客户端必需依赖。约 3.7 GiB。
- 历史 QA 副本（原根 `.local`）、旧打包产物及其他可重建依赖缓存仍保留在 ORICO，没有删除。
- 源项目 10,738 个受 Git 管理的 tracked/untracked 文件逐文件一致，无缺失或差异；迁移回执是新增文件。
- 5 个 SQLite 快照通过完整性校验；当前使用的库采用在线备份。停用旧库无 WAL/Journal，使用 immutable 校验并原样复制。密钥字节一致，权限保持 0600/0700，未修改或输出凭证。
- 更新开发 app bootstrap、Memory 模块转发、源码标记、config 与 wanx-storage 路径；新引擎与 backend 使用新本机端口，实际数据库位于内置盘。
- 内置盘开发 app 及 `/Applications/半人马AI-记忆盒子 空间标注开发版.app` 的入口均已指向内置盘，签名校验通过。旧安装入口 bootstrap 的临时回滚副本保留于 `/tmp/memobox-before-internal-migration`。
- 实际窗口已恢复账号、来源列表及本机存储位置；记忆/扫描不可用提示消失。此次内置盘启动未观察到可移除宗卷弹窗。未执行真实采集、Hook 安装或新记忆写入。
- 精确核对旧 profile 的端口、进程 UID 与配置参数后，通过 SIGTERM 正常停止旧 backend 与引擎；未强杀、删锁或修改旧数据库。
- 迁入目录内运行本机 runtime/source-link 测试，3/3 通过。此前前端健康检查回归 27/27，通过 TypeScript 检查和构建。

## 后续工作位置

当前 Codex 会话/侧边栏项目仍绑定旧目录。文件迁移不会自动修改该绑定；后续开发应在内置盘目录打开项目，避免两个副本产生新差异。空间标注等并行线程也应改用内置盘路径；本轮没有改写其他线程或迁移它们的执行上下文。

若用户主动打开 ORICO 上的旧回滚应用、导入外置盘文件或浏览外置盘内容，macOS 仍可能正常申请对应访问权限；这不属于内置盘启动链路。
