# Windows 知君启动误判：排查与修复验证

## 范围

基于 CodeUp 万象 `origin/master` 的 `f9e25cba`，本地分支 `codex/fix-zhijun-windows-dictionary-20261102`。仅修改个人版与团队版电脑端的应用数据检查，不修改知君业务数据或 WANX 后端接口。本次交付仅为源码修复、测试和验证说明，不发布或替换 Windows 正式安装包。

## Windows 只读证据

已只读检查用户确认的 Windows 设备。实际安装的万象为 1.0.3（文件 ProductVersion 1.0.3.0）。检查范围仅为安装元数据、知君目录条目、格式戳、写入者记录及文件统计信息，未输出对话或角色内容。

- 原知君 profile 内已有 `.data-schema.json`，数据版本为 `1.0.0`；Host 的 v2 写入者记录同样声明 `1.0.0`，二者的 artifact ID、descriptor digest 一致。
- profile 内存在 Chromium 的 `Dictionaries` 目录；实际安装的 ASAR 中 `zhijun-data.mjs` 未将其列为已知运行时元数据。
- 同一个角色文件，通过 Windows Node 24.0.0 的路径 `stat/lstat` 查询得到 `dev=0`，通过打开文件的 `fstat` 查询得到非零卷编号；inode、字节数、时间戳、链接数一致。使用 bigint 查询也保留这一差异。
- 安装包内原版检查器在这份实际 profile 上返回 `{status:"unknown"}`。
- 将两处修正仅应用到检查器的内存副本，仍读取原 profile，得到 `{localDataPresent:true,localDataSchemaVersion:"1.0.0"}`。没有修改 ASAR、格式戳、写入者记录或角色文件。

上述是 Windows 上的只读检查器验证，使用该机 Node 执行安装包中的模块，不等于修正版完整 Electron/Host 已安装并成功打开知君。旧客户端仍包含旧检查器。

## 修改

1. 将 `Dictionaries` 识别为运行时目录。该目录不能作为个人数据格式的证据；非目录、符号链接、未知文件及损坏角色数据仍被拒绝。
2. 在读取角色、格式戳及 Host 写入者记录时，使用短时只读文件句柄获取可比较的完整文件身份。继续比较真实卷编号、inode、字节数、时间戳和链接数，不把 `dev=0` 当作通配值。
3. 保留读取前后的 `lstat` 无链接证据及路径检查，并在读取后用新句柄再次核对路径对应文件，拒绝替换、跨卷变化或读期间修改。
4. 保留旧写入者恢复、版本范围、账户/盒子隔离和未知数据保护；没有以清理或重建目录规避检查。

## 隔离回归

- 修改前，新增三个词典目录场景均重现 `APPLICATION_DATA_COMPATIBILITY_UNKNOWN`。
- 修改后，个人版相关回归：317 passed、0 failed、2 skipped；团队版：313 passed、0 failed、2 skipped。跳过的是未显式启用的 macOS Electron 用例，未记为通过。
- 两版均补充子进程内的 Windows 路径统计模拟，令 `stat/lstat` 的文件卷编号为零，运行角色、格式戳及应用启动/重启测试。明确清除继承的 `NODE_TEST_CONTEXT`，避免嵌套 Node 测试进程未实际执行用例。
- 验证真实文件句柄卷编号不一致时仍拒绝；合法角色、词典及格式记录在启动和 Host 重启后字节不变。
- 现有缺凭证、损坏数据、越界格式、软/硬链接、身份隔离等回归通过。
- `git diff --check` 及新增运行时模块语法检查通过。包清单的 `applications/**` 已覆盖新增文件，无需修改发行版本或签名配置。

日志位于本机 `/tmp/zhijun-windows-personal-regression-20261102.log`、`/tmp/zhijun-windows-team-regression-20261102.log`。全部测试使用临时目录和合成数据，未混入用户的个人理解。

## 后续交付验收

需将此改动纳入 Windows 万象客户端构建，在保留现有 profile 的前提下覆盖升级，再验证应用页打开知君、退出重启后再次打开。此前不应把源码修复或只读检查器验证称为 Windows 安装包已修复。无需删除应用数据，也不要求更换知君专家或重新迁移用户资料。
