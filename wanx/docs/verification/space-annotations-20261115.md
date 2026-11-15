# Mac 空间标注与检索：客户端第一版验证记录

日期：2026-11-15。工作区：`/Volumes/ORICO/Memobox`。基线：`a6df9bb`。

## 结论与范围

已实现并验证客户端内的合成闭环：**空间文件／文件夹标注 → 内置星图导入与标签召回 → MemoBox Agent 返回真实正文和文档版本**。这不是完整实机验收结论：独立安装的星图、独立盒端 MCP、真实桌面和盒端联测仍有下述缺口。

本轮没有修改盒端代码，没有发布、部署、替换真实资料或清理用户数据。验证仅使用临时目录、虚构账号、虚构文档和模拟盒端接口。

## 并行协调与改动归属

- 开始前核对 `git status`、仓库约定和两个并行任务记录；保留备份恢复与“我的 AI”已有改动，未移植或覆盖 Windows 工作区。
- 空间任务独占 `personal-space.mjs`、新增 `space-annotations.mjs`／`space-annotation-service.mjs`、空间 renderer、`codex-context-sources.mjs` 及相应测试。
- 星图接线修改个人版 Builder integration 源码和条件化的共享 `data-view.js`；团队版没有标注能力时维持原行为。
- `main.mjs`／`control.mjs` 的三处接线由“我的 AI：多智能体记忆与提示词管理”任务增量完成：注入加密标注存储、开放四项 UI 操作、给个人星图服务传入 `personalSpace`。本任务没有整文件重写这些入口。
- `assemble-client.mjs` 补齐团队版复制的新增依赖，避免其复用空间代码后缺少模块。团队版未注入标注存储时返回 `annotationAvailable:false`，UI 不调用未开放的标注 IPC。
- 动手前工作区差异留存于 `/tmp/memobox-space-annotation-baseline/`；没有用该快照回滚其他任务的内容。

## 已实现的行为

### 自动、人工与继承

标注和导入映射保存在主进程注入的 `space-annotations.enc`，使用已有 OS 安全存储，不回退为明文或易失内存。索引按当前账号／本机信任身份、盒子、空间分区；它不授予文件访问权限。

自动标注是明确标识的 `rules-v1` 关键词与文件类型规则，不是大模型语义理解。新上传文件和文件夹自动生成并持久化基础标注；支持的 UTF-8 文本在校验摘要及前后版本后提取内容标签和短说明。内容读取最多 128 KiB，规则分析前 32,768 字符。其他格式只依据名称和类型，不承诺 PDF／Office／图片正文识别。既有文件在列表／元数据访问时补全基础规则标注，也可显式重新自动标注。

人工标签和说明分别覆盖本项的自动字段。空标签数组／空说明代表明确清空本项；继承可单独关闭。文件夹标签沿当前父链继承，说明按本项、最近祖先的顺序选择。每个继承标签保留源文件夹 ID 和人工／自动来源。文件移出原目录后不再继承旧父链。

人工保存使用观察到的 revision 做 CAS；同一 revision 的并发修改只有一个成功，冲突不会静默覆盖。文件内容摘要变化后重新生成自动标注，旧人工标注保留为待复核且暂不参与有效标注；用户明确复核后恢复。父标签变化使用完整有效标注签名检查星图快照新鲜度，不只比较子文件自己的 revision。

### 失败与权限

- 写入失败不发布未持久化的标注；损坏或不可读的加密记录拒绝修改，不覆盖原存储。
- 上传文件成功但自动标注失败时，传输记录持久化 `annotationPending`、原因及重试时间，约 15 秒后再次尝试；重连、重启及“重试标注”均可继续，不重新上传文件字节。清理完成记录不会丢掉这类待办。
- UI 保留失败时的编辑草稿，提示并发冲突、待复核和标注待完成。账号／盒子切换后不显示迟到结果。
- 主进程拒绝文件或连接明确标记为只读的写操作；非个人空间每次写入还重新读取服务端 drive 目录并要求 `writable:true`。个人 API 本身绑定当前账号所有者。UI 的只读标识不是授权依据。
- 未联网时不提交标注编辑，也不将未经当前权限核验的缓存当作可读文件。断线草稿和已保存待办得以保留。

### 搜索与星图

空间列表过滤可匹配名称、标签和说明，另有显式子树搜索，遍历当前可读目录而非只过滤已加载行。子树搜索最多 128 个目录、2,000 项、16 层，结果最多 100 项，截断时明确提示。发布候选前再次检查文件版本与祖先位置。

内置星图从空间导入时记录源文件摘要、标注快照、真实文档和版本。提交已返回文档 ID 而版本尚未就绪时，先单独持久化待绑定回执；新会话搜索／打开材料时重新核验空间权限、摘要与实际文档版本，转为正式映射并原子清理回执。导入成功但索引未完成有独立状态，不伪报成功。

标签命中只产生候选。检索仍通过当前星图仓库接口读取真实文档正文，保留文档 ID、版本和 locator；标签不会冒充正文，也不伪造 evidence ID。材料详情显示导入快照、当前标注和需核对状态。正文变化后的旧映射不会用于标签召回，需重新导入对应新内容。

MemoBox 的 `space_search` 消费标签和说明，返回真实文件正文片段及来源；`starlink_search` 消费独立的文档引用结果。已有目录、文本大小和数量上限仍生效，并不承诺无限量全文检索。

## 验证

相关测试和回归的最终计数、源码摘要见 [结构化结果](space-annotations-20261115.json)。测试命令：

```sh
node --test \
  wanx/apps/personal-client/tests/{space-annotations,space-annotation-service,space-annotations-ui,codex-context-sources,starlink-space-annotations,personal-space,personal-space-folders,personal-space-batch,personal-space-recovery,personal-space-refresh,personal-space-renderer,personal-space-upload-limits,space-drive-routing}.test.mjs \
  wanx/apps/builder/tests/{personal-data-service,team-data-view}.test.mjs
```

覆盖持久化重启、人工覆盖和清空、继承与来源、大于 30 个继承标签的导入快照、同 revision 并发、磁盘写失败、损坏记录、账号／盒子／空间隔离、只读写入拒绝、文件移动撤权、请求期间内容／权限变化、自动标注独立重试、异步导入回执恢复和页面交互。

两条跨模块测试实际运行 `createPersonalSpace`、`SemanticaService`、`createPersonalDataService`、`createCodexContextSources`，通过模拟 API 传输合成文件字节，验证仅在父文件夹标签中出现的检索词能返回原文；另验证 processing 导入在重启后取得真实版本、完成映射并由 Agent 召回。**这些使用生产客户端模块，但盒端传输为 mock，不是实机网络通过证据。**

主进程／renderer 语法检查及本任务文件 `git diff --check` 通过。按现有 esbuild 配置从源码局部重新生成个人版 `personal-data-service.mjs` 和 `data-view.js`；没有运行完整打包或重启正在使用的真实客户端。

## 尚未完成与后续接口边界

1. **独立安装的星图尚未消费该索引。** 它通过 `applications/manager.mjs` → `app-host/session.mjs` 的独立应用会话直接代理 API，旁路内置个人星图服务；其 UI 只读取原生 `items`。后续可在个人星图 Host 请求通路复用同一标注核验逻辑，并用该应用原会话读取正文，仍无需改盒端。此处不能据内置测试宣称完成。
2. **独立盒端 Space／Starlink MCP 尚未消费客户端本机索引。** 已接入的是 MemoBox 的本机上下文 MCP。不能用这次测试代表所有第三方 Agent 的独立盒端 MCP 接入已验证。
3. **没有真实桌面 → 真实盒端 → 实际 Agent 新会话的端到端通过证据。** 后续应在隔离测试空间用合成资料完成 UI 标注、导入、按标签检索、独立 Agent 回读和撤权联测。
4. **标注库目前保存在本机，未实现 Mac／Windows 间共享或冲突合并。** 跨设备一致索引需要另行设计客户端侧的同步回执；本轮不改独立备份恢复语义。
5. **提交响应丢失且尚未观察到文档 ID 的导入**仍依赖既有上传幂等恢复；本轮持久化的是已观察到文档 ID 的回执。多个独立进程直接改同一标注文件的文件锁语义也未验证；本轮并发证据为主进程内序列化与 CAS。

本轮交付为可审查的本地源码和上述合成验证，不将未验证部分计为完整闭环完成。

## 安装后现场修复：预加载接口漏接

实际安装使用时，“标签与说明”显示暂不可用。原因是 `local-ui/remote-preload.cjs` 没有在固定动作列表中开放四项新标注操作，请求在到达主进程前就返回 `UNKNOWN_CLIENT_ACTION`。此前 renderer 测试直接模拟 `wanxClient.action`，未覆盖真实预加载层。

已仅新增 `annotation`、`set-annotation`、`auto-annotate`、`search-annotations` 四项明确动作，保留其他未知动作和非法 sender 的拒绝。新增 `space-annotations-preload.test.mjs`，运行真实 preload → `registerControlActions` → 空间操作的六项测试；与标注界面、服务测试联合运行 **26/26 通过**。

修复同步到 Applications 安装副本与本地开发副本，重新签名校验并重启。通过实际桌面连接原盒子后，重新打开用户截图中的“私人记忆库”：标签输入框、说明输入框、继承选项及保存按钮均正常显示。现场只核验表单读取，没有保存或改动真实资料的标注。这补充了真实桌面的标注读取证据，尚不等同于完整实机导入和 Agent 召回验收。
