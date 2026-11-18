# 万象内置星图

个人客户端的「星图」面板源码。迁自 `centuarai-wanx-startlink`，以建仓、资料导入与自动抽取、知识图谱、材料检索、本体类型与关系管理为范围。抽取模型配置、任务状态及材料核对作为这些流程的依赖保留。

## 源码与运行

- `ui/`：建仓、资料、图谱、检索界面及工作台容器。
- `frontend/`：React 本体与材料知识编辑工作台，含图谱组件和来源核对。
- `shared/`：星图内部动作合同、参数和发布校验。
- `shell/`：材料上传、检索、本体等服务调用，复用 Bridge 路由。
- `integration/`：个人客户端 Host 适配、受限面板桥和布局。
- `tools/assemble-panel.mjs`：将界面和前端构建装配到客户端 `build/app/local-ui/starlink/`，服务适配打包到 `shell/starlink-panel-service.mjs`。

不依赖原项目的绝对路径，不启动独立 Electron 应用。Host SDK 直接使用 `../personal-client/host-sdk/`；未复制独立应用的 SDK 或用户状态。账号、盒子与权限由万象提供，业务请求仍通过 Bridge 到独立 Semantica。

原个人版数据服务仍支持 AI 检索等现有消费方，团队版的简化面板与独立应用快照保持原构建入口。个人版星图面板使用本目录，后续修改请勿编辑旧面板或 `build/` 产物。

## 构建与检查

仓库根执行：

```sh
npm ci --prefix apps/starlink/frontend
npm run test:starlink
npm run build:starlink
```

正常个人客户端构建会自动执行星图前端构建与面板装配：

```sh
npm --prefix apps/personal-client run build:studio
```

依赖既有万象 Bridge 的初始化、会话、材料、本体与工作台接口。`local-data-gate=required` 等模式继续使用服务端现有权限限制，不因内嵌而自动开放尚未支持的流程。

迁移范围、验证和限制见 [接入说明](../../docs/applications/starlink-panel-migration.md)。
