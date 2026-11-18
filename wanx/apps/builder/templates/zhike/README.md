# 知客 · 万象工坊内置标准模板

模板 ID：template:zhike。应用源码身份：centaurai.wanx.template.zhike，版本 0.12.1。

模板是可直接使用的对话式 AI CRM 起点：对话、客户、沟通记录、极简商机和设置；Channel 状态在对话右侧，连接配置在设置。内置四套完整外观及 13 个标准功能模块，使用现有受控能力桥接。无高级功能分层、专家模块或工坊推广按钮。

## 创建与修改

在工坊已有来源选择器中选择知客，创建独立副本，再通过工坊对话修改字段、页面与流程。保留稳定客户／商机 ID，新业务字段使用应用数据能力关联。模板本身没有演示客户、渠道凭据、本人绑定、模型配置、知识授权或定时任务；这些能力按新应用与当前身份配置。原安装版知客及其客户库不受影响。

源码只含 miniapp.manifest.json 和 src/app.js、src/config.json、src/styles.css。packTemplate / compileArtifact 负责校验、摘要和编译，构建客户端时自动生成内置包。四个文件与已安装知客 0.12.1 的可编辑源码一致；模板应用身份独立。

企业版随开物工作台交付模板，个人版工坊也可用它创建和修改项目。运行 `node apps/builder/tools/build-zhike-template.mjs` 可在 `apps/builder/dist/zhike-template/` 生成可编辑包和预览文件。

## 更新与权限

按项目实际来源应用身份匹配模板更新；知客只能收到知客模板，问答应用继续收到问答模板。模板更新先生成试用版本，采用、安装仍走原流程。复制源码不扩大权限，不导入旧业务数据和凭据。

对话使用 conversation.send/status/cancel 固定操作，沿用 CRM 原话、待确认、查询、模型及任务接口。工坊 native Foundation 和应用领域白名单需同时更新；不更改万象底层 API。
