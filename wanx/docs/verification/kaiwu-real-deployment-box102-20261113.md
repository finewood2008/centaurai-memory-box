# 102 真实协调器部署验收（2026-11-13）

## 实际交付范围

个人工坊的 `wanx-miniapp-v1` data-only profile 已接通真实部署：可信项目上下文 → 冻结发布包 → Coordinator 持久任务 → 后端候选与数据计划 → 主进程暂存客户端 → commit → 安装与运行绑定 → 实际原生应用打开 → 成功回执。前端不再只读，实际提交由真实界面点击发起，未伪造安装 ACK、运行证明或成功记录。

该 profile 支持当前盒子的独立 dev/prod 槽位，仅开放 `deploy`。模型、资料、知识库、foundation、dialogue 等能力尚未完成部署资源绑定，明确拒绝 `RUNTIME_INCOMPATIBLE`；企业开物、独立 Python/Node/OCI 服务的完整安装链路及 promote/rollback/运维动作尚未开放。OS 仓库新增的独立服务执行原语没有部署到 102，也没有注入这个 profile。不能把此次结果扩大为所有应用类型已支持。

## 问题与修复

- 原生产装配只有 `UnavailableAdapter`，没有项目版本到可信部署包、目标和决策／数据计划的映射。新增服务端 profile、发布上下文和持久执行授权，复用原 Router/Coordinator。
- 原客户端仅“采用并安装”，既无环境槽位也无 operation-bound 证明。新增 main-only 交付 worker、私有 staging、受管槽位、租约和 generation/fence 检查，prepare 不安装，commit 后真实安装。普通、签名、切换、回滚、卸载路径均不能覆盖受管槽位。
- prepare/profile 记录和 Coordinator 发布登记间的退出窗口可幂等补齐；profile 状态、数据复制、binding 和步骤证明共用 StudioStore SQLite 事务。已有 pending 交付返回 waiting，不假报尚未执行。
- 实机暴露的授权缺陷：`UserRow` 无 `application_id`，旧检查抛异常后被转为 TARGET_DENIED。修复为与原工坊一致的真实用户存在／未停用检查，保留 owner、项目、目标、源版本及 fencing 限制；新增真实 frozen UserRow 回归。
- 实机暴露的成功状态残留：等待客户端后的旧 errorCode 未清除。新成功记录持久清空 errorCode；旧成功记录的公开读模型规范化为 null，不修改历史 DB，失败错误仍保留。

## 102 现场版本与回退

最终镜像 `sha256:3acf4696e2faa70846d8307f48de12945aa49468c5fe5089fb7f4cce4fd63916`，运行容器 `af76c3e39e21649520f759972ae575b7c179969bc754e4e49b0c8d32105ee173`。16 个后端／策略源文件 SHA-256 全部匹配本轮清单。通过平台互斥锁及双 upgrade guard 优雅切换，健康与 delivery ready/serviceReady 通过。旧容器 `centuarai-wanx-before-kaiwu-20261113t065348-c729b6` 保留且不启动双写。未改签名 OTA 安装账本；这是现场验证镜像。

可信目标配置由 root 写入数据卷中的 `deployment-target.json`，权限 0644，仅启用与实际设备身份匹配的 SSO profile，不包含凭据。客户端改为运行当前工作树的新开发版，复用原账户目录与包身份；实际 manager/installer、UI、工坊 worker 和 runtime 都来自本轮实现。原工作树源码未被覆盖。现成不相关客户端运行资源只作为已运行基线保留，未绕过 Starlink 既有来源摘要检查生成新制品。

## 真实操作结果

| 环境 | operationId | 代次 | 结果 |
| --- | --- | --- | --- |
| dev 首次 | `d7a9807800904183bd43c08e7b970cf8` | 0 → 1 | succeeded；backend/client ready，回执 delivered |
| prod 首次 | `d1d3371a6919457dad7763ae2087a9ee` | 0 → 1 | 同一 release/bundle；succeeded，回执 delivered |
| dev 重启续办 | `5fe5de642b5841bcb3c0930ab821fd00` | 1 → 2 | 客户端离线及后端换镜像后原操作继续成功，errorCode=null，回执 delivered |

发布 `miniapp-d0fd838089d69ce033903ff25f3228bf`，bundle `sha256:b3bd9b4413c678d23b7e26b722d78ed3a02615026a943cca5f7b6757549d6252`，版本 `0.1.0`。

dev 槽位 `ai.wanx.selfmade.66e084cf474817f1dc1773e8c880e0a4`，prod 槽位 `ai.wanx.selfmade.4babcf78a57f4cc3ad424cdf9d965b77`。真实客户端分别安装、自动启动，各自打开新的绑定 runtime 后 Coordinator 才成功。

## 数据与恢复实测

首次 dev 从原应用复制 2 条记录；首次 prod 从已通过 dev 复制同样 2 条。随后实际界面分别新增：dev `note-1794552596555-83xh9kpxdn`、prod `note-1794552613304-jvz6q8iivz`，均修订 1。刷新、停止重开后，两槽各 3 条，各自只能看到自己的新增 nonce；原普通应用仍为 2 条，未被覆盖或混入部署数据。

第二代 dev 在真实界面提交后正常退出客户端。服务端真实观察为 `waiting_client / activate / committedGeneration=2`，不报成功；换入最终镜像后同一操作和状态仍保留。恢复客户端并重连后，没有重提请求，原 operation 自动完成，后端／客户端 ready，回执送达。重启后 dev/prod 各 3 条及隔离、原普通应用 2 条再次通过。

## 验证与证据

- Python 部署与权限策略最终 300 passed、262 subtests passed；既有工坊／版本／runtime 56 项兼容测试通过。
- JS 部署 worker／传输／UI 36 项通过；客户端安装／签名包／版本等回归通过；TypeScript 与 Vite 构建通过。
- Python 真实后台产生的 ticket/payload 经 JS parser、摘要及真实 writeMiniappPackage 交叉验证通过。
- OS 独立执行原语 13 项测试通过、独立审阅修复隔离和崩溃恢复问题；没有真实 systemd/102 或 Coordinator 验收，不能称为已上线独立后端能力。
- 原全量 Node 回归的 7 项既有 Channel/模板/Starlink 失败已在前次归并记录中保留，本轮未修改或绕过对应模块，不以专项通过冒称全量通过。

实机完整 operation/receipt、隔离证明、源文件清单、目标窗口截图及控制脚本仅保存在受保护的 `connect-executor` 验证目录，不包含于提交。凭据与私有 Docker 配置不入 Git。

客户端收尾：当前工作树的开发客户端无调试启动，19337 端口关闭，dev/prod 安装保留供使用。原仓库源码未改；后续运行应继续使用当前工作树的新客户端，旧客户端不包含受管安装器。
