# 接通真实应用部署

用户要求解决未就绪，完成实际部署并在 102 验证，不以按钮可点或状态读取代替执行。

## 已复现

私有 `connect-executor/probe.py` 通过正常管理员登录，断言工坊 deployment/capabilities.available 为 true；实机返回 false / DEPLOYMENT_ADAPTER_UNAVAILABLE，确定性失败。修复后使用同一检查，并增加真实操作、客户端安装、运行与数据验收。

## 实施顺序与分工

1. [x] 复现不可用并核对生产装配、可信发布上下文、客户端环境槽位和盒端独立安装器。
2. [x] 首个真实共享运行时源码应用 profile：从本项目已采纳制品生成不可变 packaged-app 发布包和目标；持久管理授权、独立 dev/prod 绑定、后台真实激活及重启 inspect；注入 Coordinator。
3. [x] 主进程客户端交付：operation/step/fence/slot 绑定票据，先持久 staging 并检查摘要，提交后真实安装／激活；磁盘摘要核验和客户端确认，离线保持 waiting_client；不借旧 installed 单槽伪造完成。
4. [x] 正式 UI 获取可信部署上下文并发起真实部署，202 后追踪原操作，结果以分项观察及不可变回执为准。
5. [ ] 为独立代码后端补通用盒端受信安装 profile，复用平台互斥与隔离执行，禁止 Docker socket、伪装火花或裸同 UID 进程读取平台凭据。
6. [x] 范围对应的集成回归及 102 真实成功／失败／重启持久化验证；审阅、提交、推送。

## 验收门槛

实际客户端安装并核对版本／摘要，真实 runtime 打开和数据读写通过后才可完成组件。dev/prod 与旧普通安装数据隔离，提交前不替换激活版本，重试幂等且拒绝过期 fence；客户端断开不报成功。共享运行时 profile 的通过不能代表任意独立 Python／Node／OCI 服务已交付。

## 影响与依赖

万象 Builder 后台 deployment 模块、实际装配、受信 IPC、客户端安装及 runtime binding、部署 UI；独立盒端安装涉及 OS 仓库的新窄协议执行器。公开合同草案保留既有语义，需扩展时先同步跨语言校验，不修改签名信任根或既有安装白名单来绕过限制。

102 的个人工坊链路已真实成功，含 dev/prod 隔离、首次复制、离线等待及后端重启续办；见[数据部署验收](../verification/kaiwu-real-deployment-box102-20261113.md)。后续已接通 model/files/knowledge 的环境绑定，模型／文件的实机结果见[资源验收](../verification/kaiwu-deployment-resources-box102-20261113.md)。根据用户补充，下一类后端优先采用现有专家执行链，方案见[资源与专家后端](kaiwu-deployment-resources.md)。独立代码后端仅交付 OS 执行原语，尚未接入 Coordinator/候选健康/完整迁移；专家后端与企业开物亦未开放。
