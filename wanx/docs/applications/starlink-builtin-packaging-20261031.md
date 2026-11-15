# WANX 内置星图同步与双版本打包

本机验证候选，功能分支 `codex/starlink-upgrade-20261031`，未合并、未部署。WANX 基线为 `689d356e8d7eb5287de2cb91725eae57b90bc13f`。本轮代码变更属于 `centuarai-wanx` 仓库，尚未修改或发布任何生产实例。

## 内容与来源

两版内置星图当前版本为 `0.3.5-rc.20261101`，应用 ID 保持 `centaurai.wanx.semantica`。使用此前已经验证的星图候选包作为基线，包含本体原生工作台、统一 UI、WANX 默认模型及失败通知相关前端能力。来源 ZIP 的 SHA-256：

`26be0aa193cc841abc9a432a0738734f9c0f9c4ba681439d75697f74622b24a4`

2026-11-01 交付修正：已有材料的空图提示已按当前仓的材料与处理状态区分，内置应用版本从 `0.3.5-rc.20261031` 递增到 `0.3.5-rc.20261101`，以便已有安装被识别为可升级。该修正需随新版桌面客户端交付；盒端 OTA 不替换原生应用资产。此轮仅补齐源码、清单与组装验证，未构建或发布 Host 客户端。相同或更高版本、签名应用、手工回退选择及正在运行的编辑器仍保留原安装。

为保留仓库现有布局，唯一受版本控制的完整应用源码仍位于 `apps/team-client/applications/starlink/`。该路径只是存储位置；个人版、企业版都通过 `apps/builder/tools/assemble-starlink.mjs` 组装这份内容。个人版目录是可重新生成的输出，不应单独修改。

`apps/builder/integration/starlink-source.json` 固定版本、来源和 75 个文件的哈希。两版都复制同一 SDK 和锁定版本的 ws。更新来源时必须同时更新完整应用和清单，不能只改版本号或保留旧工作台静态资源。

## 统一入口

从完整 WANX 仓库工作，不使用单独导出的客户端子目录。先按仓库现有流程安装 `wanx-studio` 与需要构建的客户端依赖：分别在对应目录执行 `npm ci`。共享组装器自身不执行联网安装。

仅组装星图：

```bash
npm --prefix wanx-client run build:starlink
npm --prefix wanx-team-client run build:starlink
```

组装客户端全部共享模块：

```bash
npm --prefix wanx-client run build:studio
npm --prefix wanx-team-client run build:studio
```

整机客户端沿用已有统一入口：

```bash
./apps/personal-client/package-client.sh --help
./apps/personal-client/package-client.sh --edition personal <现有打包参数>
./apps/personal-client/package-client.sh --edition team <现有打包参数>
./apps/personal-client/package-client.sh --edition all <现有打包参数>
```

个人版直接 Windows 打包、npm 的 macOS/Windows 打包也会先组装最新共享内容。个人版 renderer 构建本就调用 `build:studio`，macOS 与内部 Windows 打包继续经此入口组装。两版 `afterPack` 均检查实际 `app.asar` 内的星图文件、工作台、SDK 与 ws；缺失、旧文件、额外残留或哈希不一致会失败。

正式打包的干净源码检查与本地构建指纹已经覆盖共享 Studio 源码和内置星图，防止个人版遗漏企业版目录里的共享变更。本次功能分支不能宣称为正式发行；不要绕过干净源码检查。此次仅制作并验证星图 ASAR 内容，没有生成签名、公证的完整客户端安装器。

## 已安装版本和材料

两版打开星图使用同一版本判断：缺失则安装；旧的可比较普通版本在未运行时升级；相同、更高、自定义、待用户选择和受签名发行管理的版本保留。已运行的编辑器会继续使用原版本，关闭后下次打开才尝试升级。升级沿用已有版本化安装器，保留旧版本目录；不会主动删除应用材料或历史版本。

打包统一阶段没有重启或更改本机已安装客户端，也没有写入材料数据库。随后完成旁置测试客户端实测，见 [最新交付记录](starlink-upgrade-handoff-20261031.md)。原件与当前副本均复核：92 份原件、90 个历史文本版本，哈希/版本/元数据差异为 0，SQLite 完整性正常，外键错误为 0。两份 PNG 原件仍保留；这不意味着 92 份都已有可检索文本。

## 验证与 79 交付关系

- 个人版和企业版共享资源均实际组装成功。
- 两版星图 ASAR 完全一致，SHA-256 均为 `8b3660f1caffebd4fc6e7a28922a537bed64f4bdd0056f0710b6993d93fecb06`。
- 覆盖旧版升级、更高版本保留、运行中编辑器保护、签名版本保留、实际安装器保留旧版本，以及缺文件/陈旧工作台拒绝打包。
- 打包统一阶段没有重新向真实模型发起调用；随后的真实调用与原生通知实测见最新交付记录。此前默认模型、检索、图谱、失败通知的结果见已有 79 候选验证记录；本轮验证同步和打包，不冒充 79 生产验收。

此前 `starlink-box79-0.3.5-rc.20261031.tar.gz` 保留不动，其中旧的 9 文件 WANX overlay **不包含本轮完整同步**。本轮配套的 `wanx-starlink-builtin-sync-20261031` 源码补丁包含此前 WANX 默认模型/通知修改及当前内置应用、构建与测试修改，供同一 WANX 基线的隔离源码副本审查和构建。使用它时不要再叠加旧 overlay。

星图盒端服务仍由星图候选包提供；WANX 内置桌面应用不等于盒端 Python 服务。生产升级仍需按原 79 部署说明准备服务、WANX 后台和受信客户端，并验证实际连接和通知。本轮没有执行这些生产操作。
