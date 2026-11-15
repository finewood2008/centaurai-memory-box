# STARLINK 首批页面：个人知识仓初始化

> 2026-11-08：新增无材料建仓对话。创建会话可选 `scenario=onboarding`，五个独立接口支持范围草稿、自然语言修改、版本预览和确认发布。见 [Starlink 无材料建仓对话接口对接](semantica-onboarding-dialogue-api.md)。本文原有少量初始建议流程保持兼容，新流程不受每次1–3条候选限制。

## 简化建仓与初始本体建议（2026-11-06）

流程：填写已有信息 → 创建仓 → 生成少量候选 → 修改或排除不合适项 → 预览完整本体 → 用户统一确认发布。生成与预览不发布、不抽取材料。

`background` 接受空字符串，旧请求的非空背景继续兼容。`industry/occupation/material_types/purpose/questions` 沿用已有字段；其中输入 `questions` 是用户“希望回答的问题”，完整保存并作为业务需求送入模型。至少有一项有效信息才能生成；不虚构缺失背景或业务事实。

新初始化仅基于已确认回答和当前本体，不拼入历史 `previous_questions`，不要求先完成澄清。有效候选返回 `status=succeeded`、`valid=true`、`can_review=true`、`result.outcome=ready`；输出 `result.questions` 和 `unresolved_questions` 均为空数组。仅现有本体确实足够时允许带解释的 `no_changes`，此时无候选且 `can_review=false`。空输出、候选全部被依据校验过滤，不能作为无需新增处理。

按可用上下文预算最多请求 1–3 条核心候选，定义最多 120 字符，理由、依据引用、existing_gap、business_need 各最多 80 字符；摘要最多两项，每项正文最多 100 字符。初始化输出预算上限 3072 token；扣除完整输入、本体、输出 Schema 和余量后不足 1024 时返回 `ONTOLOGY_CONTEXT_TOO_SMALL`，不截断输入。超长或超量输出拒绝，不静默裁剪后发布。材料对话和材料本体建议的原有追问及数量策略不变。

本地 OpenAI 文本／结构化模式与 Ollama 均设置本次输出上限。WANX 模型回调 `/internal/starklink/models` 的 infer 请求增加可选 `max_output_tokens`（整数 1–4096）；现有模型权限和任务授权仍执行。Bridge 的 Octop 宿主适配器和独立模型转发器实际采用 `min(本次预算, 所选模型上限, 4096)`，成功时回传实际 `max_output_tokens`。Semantica 要求回执上限不超过申请值，将申请与实际值写入任务指标；旧宿主未确认预算时明确失败，需要更新适配器。未携带预算的其他任务沿用已有行为，无新增配置开关。

截断标记即使伴随完整 JSON 也拒绝。非法 JSON、结构违规或无效预算回执返回 `status=failed`、`can_review=false`、`error_code=ONTOLOGY_INVALID_OUTPUT`；空候选且无可信无需新增结论为 `ONTOLOGY_MODEL_EMPTY_RESULT`。HTTP 200 的生成回执不等于成功。失败保留回答，重试同一操作号读取原回执；重新生成须用新操作号。

沿用现有回答确认、建议生成／读取、规则预览与发布路由；无需新增批量确认接口。Starlink 可默认选中有效候选，提交完整 `schema` 和每条候选的 `decisions`（add/reuse/ignore）；发布仍要求 `confirmed=true`、原有 digest/revision/operation_id、权限及关系端点校验。同名类型的复用、排除依赖由已有规则校验负责。

历史建议、草稿和发布回执不迁移改写，旧操作号继续幂等重放；旧的 needs_clarification 候选仍可核对并发布。历史只有问题且无候选时保留原有恢复行为，新生成不沿用旧问题。成功生成新建议后当前待澄清列表为空；失败不清空历史记录。材料对话的问题、目标确认、账号与仓隔离不受影响。

Starlink 对接只需继续使用已交付的简化表单、默认采用、完整预览和明确发布流程；无需调整接口地址。Semantica 与 WANX 模型适配器应一起更新后重启相应服务；本次代码验证不代表已重启服务或完成真实模型联调。


后续对话整理、核对本体和核对材料知识页面的新增注册与调用顺序见 [对话整理和知识核对接口对接](semantica-conversation-api.md)。下文“本批 8 个接口”和未注册说明均指初始化这一批；当前总入口范围需结合后续文档查看。

本批只覆盖 Figma 文件 `CkOk7woZtUu2IqMmjJqhaj` 的以下页面（2026-11-05 通过桌面 MCP 读取设计上下文和截图）：

| 节点 | 页面 | 本批服务能力 |
|---|---|---|
| [19:248](https://www.figma.com/design/CkOk7woZtUu2IqMmjJqhaj/Untitled?node-id=19-248) | 首次进入 · 开始工作 | 判断是否已有个人仓、恢复个人引导；示例选择由页面填入表单 |
| [13:550](https://www.figma.com/design/CkOk7woZtUu2IqMmjJqhaj/Untitled?node-id=13-550) | 初始化 · 填写背景与用途 | 行业、职业、背景、主要资料、用途／问题及引导状态 |
| [13:714](https://www.figma.com/design/CkOk7woZtUu2IqMmjJqhaj/Untitled?node-id=13-714) | 初始化 · 命名并创建知识仓 | 命名、核对、确认创建，衔接创建后的初始建议生成和恢复 |

用户已确认本次先接个人知识仓，团队流程后续补齐。页面中的“法务部工作空间／仅工作空间成员可见”不能直接作为本批接口的权限说明；个人仓应展示当前账号私有语义。导航中的对话、核对本体、材料知识以及第三步的规则修改／发布不属于本批注册范围。

## 入口和鉴权

下表均省略 `/api/semantica` 前缀，使用现有 Bridge 桌面会话（`Authorization: Bearer <bridge session>`）。复用每次请求的 WANX 身份、`knowledge_bases` 权限、租约检查和断线取消；无需新增启用参数。上游为现有桌面适配的 Semantica 地址配置。

仅 `X-Wanx-Data-Context: personal` 或未提供此头时可调用新增接口。团队上下文返回 `403 MODELING_HOST_CREATION_REQUIRED`，不会转成个人仓。实例级 `/native/*`、公开 Knowledge Key 入口和 local-data-gate required 通道均未扩大范围；后者的独立白名单及个人多仓身份映射需要另行接入，不能通过关闭网关来规避。

Windows 本机联调也可使用 `Starlink → 本地 Host → Octop :18088 → Semantica :8090`。
`host_modeling.py` 将本批 8 个接口挂载到既有宿主路由，只接受回环来源和个人上下文，
通过注入的 Octop 原生登录及 `knowledge_bases` 权限依赖校验，并在长请求期间重新校验账号。
复用下述请求契约、操作号、仓身份映射和建议预算；不生成平台会话、不修改 Octop 业务。
更新后需完整重启 Octop。本机路径不要求平台设备密钥，也不启动独立平台 Bridge；
Semantica 使用 standalone、回环监听及 `WANX_MODEL_URL=http://127.0.0.1:18088`。
此适配仅覆盖本批初始化接口，后续对话接口不因此自动接入宿主通道。

新增路由在 `/openapi.json` 中逐项注册，带摘要、路径参数和内联请求模型。GET 无请求体及业务查询参数；POST 必须为 JSON，最多 128 KiB。请求不能携带 Origin 或自行指定身份／workspace。所有结果 `Cache-Control: no-store`。

## 本批 8 个方法／路径

| 方法 | Bridge 路径 | Semantica 目标（省略 `/api/integration`） |
|---|---|---|
| GET | `/modeling/onboarding` | `/modeling/onboarding` |
| POST | `/modeling/onboarding` | `/modeling/onboarding` |
| GET | `/modeling/warehouses` | `/modeling/warehouses` |
| POST | `/modeling/onboarding/{onboarding_id}/warehouse` | 同路径 |
| GET | `/warehouses/{warehouse_id}/modeling/suggestion-context` | `/modeling/warehouses/{workspace}/suggestion-context` |
| POST | `/warehouses/{warehouse_id}/modeling/answer-confirmations` | `/modeling/warehouses/{workspace}/answer-confirmations` |
| POST | `/warehouses/{warehouse_id}/modeling/answer-suggestions` | `/modeling/warehouses/{workspace}/answer-suggestions` |
| GET | `/warehouses/{warehouse_id}/modeling/answer-suggestions/{suggestion_id}` | `/modeling/warehouses/{workspace}/answer-suggestions/{suggestion_id}` |

`warehouse_id` 必须使用列表 `items[].id` 或创建回执 `resource_id`／`warehouse.id`；不要使用 `workspace_id`。Bridge 按现有 UUIDv5 算法派生当前账号的目标 workspace，替换上游路径，并由 Semantica 校验实际仓归属。建仓前用个人根 scope；创建回执本身不是目标仓授权。

旧注册项及其参数、鉴权、错误分类不变。这里没有新增 `/modeling/*` 泛化放行，也没有新增会话、上传、规则预览／发布、影响分析、重新抽取、Key 或团队管理接口。

## 页面调用顺序

1. 首次进入读取 `/modeling/warehouses` 与 `/modeling/onboarding`。仓列表返回 `{items:[...]}`；引导返回 `id/revision/status/answers/created_workspace_id`。空引导 `revision=0`。样例为前端静态填充值，不调用模型、不建仓。
2. “下一步：命名并确认”只切换前端步骤，可以保留未提交表单；“取消／上一步”不应自动创建资源。需要恢复草稿时可显式保存引导，不能把 `status=completed` 当成已创建仓。
3. “创建知识仓”点击后，先保存本次已核对的答案，取得 `resource_id` 和 `revision`，再使用它们创建仓。必须等建仓成功后才开始建议流程。保存和创建使用不同操作号，并在发请求前持久保存待重试的路径和完整请求体。
4. 创建成功后刷新仓列表、选中回执的 `warehouse.id`，读取该仓 `suggestion-context`。它返回 `answers/onboarding_revision/purpose_revision/base_ontology_id/latest_confirmation_id/confirmation/proposal`。界面恢复时若已有有效确认和建议，可直接展示；不得刷新即反复生成。
5. 对用户刚核对的答案调用 `answer-confirmations`；传 `expected_revision=purpose_revision`、`onboarding_revision` 以及 `expected_confirmation_id=latest_confirmation_id`。只采用当前用户确认的内容；若上下文已变化，先重新核对。确认回执的 `resource_id` 用作 `confirmation_id`。
6. 调用 `answer-suggestions`，最多等待 285 秒（授权上下文预算 300 秒）。它是同步生成接口，业务响应含 `id/status/valid/result` 或失败信息；HTTP 200 不代表业务成功。只在 `status=succeeded && valid=true` 时展示有效建议。超时先用 `suggestion-context` 的 `proposal` 和读取建议接口恢复，不要另造操作号重复推理。
7. 建议仅为候选结构。本批不自动保存规则草稿、不发布、不上传或抽取材料。采用／编辑／发布本体待下一批页面注册。选择稍后设置可使用已有默认规则；建议失败不撤销已创建的仓。

## 请求示例

下面操作号仅为示意，客户端每次新意图生成新的 UUID；同一次网络重试必须保持原操作号和原始 JSON 字段。

保存引导：

```json
{
  "operation_id": "save-answers-001",
  "expected_revision": 0,
  "status": "in_progress",
  "answers": {
    "industry": "制造业",
    "occupation": "企业法务",
    "background": "负责采购合同审核与履约风险管理",
    "material_types": "采购合同、补充协议",
    "purpose": "查询签约主体、履约义务和违约责任",
    "questions": "",
    "warehouse_name": "采购合同管理",
    "flow_mode": "create",
    "flow_step": "confirm",
    "creation_operation": "create-warehouse-001"
  }
}
```

创建仓：`POST /modeling/onboarding/{保存回执的resource_id}/warehouse`

```json
{"operation_id":"create-warehouse-001","expected_revision":1,"name":"采购合同管理","purpose":"查询签约主体、履约义务和违约责任"}
```

确认回答：

```json
{
  "operation_id":"confirm-answers-001",
  "expected_revision":1,
  "onboarding_revision":2,
  "expected_confirmation_id":null,
  "answers":{
    "industry":"制造业","occupation":"企业法务",
    "background":"负责采购合同审核与履约风险管理",
    "purpose":"查询签约主体、履约义务和违约责任",
    "material_types":"采购合同、补充协议","questions":""
  }
}
```

生成建议：

```json
{"operation_id":"generate-suggestions-001","confirmation_id":"<确认回执resource_id>","base_ontology_id":"<suggestion-context中的base_ontology_id>"}
```

操作号为 1–120 个 ASCII 字母、数字、下划线或连字符；草稿中的 `answers.creation_operation` 可为空，非空时必须满足相同限制，避免恢复草稿后无法提交建仓。版本必须为非负整数，不能用布尔值。行业／职业各 200 字，背景／主要资料／问题各 8000 字，用途 16000 字。Bridge 保留省略的可选字段，不补默认值改变上游幂等摘要。

## 校验与恢复

- 名称提示可用已读取的仓列表做 NFKC 标准化、去首尾空格、小写比较，但创建接口的原子检查才是最终结论。`409 WAREHOUSE_NAME_CONFLICT` 时保留表单，提示改名；修改内容作为新意图使用新操作号。不存在单独的名称检查接口，本批未虚构此接口。
- 同操作号同请求重放返回原回执（`reused=true`），不会重复创建仓。`MODELING_OPERATION_CONFLICT` 表示同一操作号对应不同内容，不能自动改号重试。
- `MODELING_REVISION_CHANGED`／`MODELING_ANSWERS_STALE`／`MODELING_SUGGESTION_STALE`：重新读取当前数据并交用户核对；不能静默覆盖。
- `MODELING_SUGGESTION_BUSY`：读取上下文恢复正在生成的建议。失败、无模型或超时保留仓和回答，可稍后重试。
- 新入口保留注册的 `MODELING_*` 错误码和 HTTP 状态，丢弃上游原始 detail/message。客户端按 code 映射本地文案，不显示原始模型诊断。已有 `WAREHOUSE_*`、`MODEL_*` 分类沿用原约定。
- 设计仓名为 2–30 字，当前服务为 1–60 字；前端可采用设计的更窄范围，不能宣称服务端已改为 30 字。设计“版本 0”是默认规则的产品称呼，展示时使用服务返回的真实版本。
- 行业和职业在设计上标必填；当前服务仍允许空值以兼容历史引导，本次不修改旧业务语义。前端在本流程确认前执行必填检查。

## 团队仓代码核查

Semantica 已有团队仓能力，但不等于本次三页团队流程已完成：

| 能力 | 现状与依据（Semantica 仓库） |
|---|---|
| 团队仓标识与隔离 | `app/services/warehouses.py` 的 `owner_of/workspace_for` 支持团队所有者与明确团队仓 ID；`app/integration/local_data.py` 的 `team_workspace/verified_scope` 使用盒子、归属版本与仓 ID 隔离 |
| 团队授权后的仓创建与材料共享 | `tests/test_team_local_data.py` 验证明确资源授权下的建仓、成员读取及跨仓／个人访问拒绝；团队权限和资源授权仍由宿主负责 |
| 团队仓中的本体建议／规则 | `tests/test_modeling_onboarding.py` 的团队场景验证建议、私有草稿、发布、其他成员及只读授权拒绝；背景和角色保留在个人确认快照中 |
| 三页引导直接新建团队仓 | **未支持**。`app/services/modeling_bootstrap.py:create_warehouse` 对团队 scope 返回 `MODELING_HOST_CREATION_REQUIRED`，须衔接宿主团队资源创建／授权，再保存用途和确认快照 |
| local-data-gate required 的建模入口 | 当前服务的 `WORKBENCH_OPERATIONS` 和 Bridge `local_data_policy` 没有 onboarding/modeling 白名单。后续必须两端同步注册并完成实际网关验收，不能仅开放 Bridge 路径 |

本次不修改 Octop，不扩展团队或 required 网关权限，不将私有回答变为团队资料。

## 验证与剩余边界

专项测试位于 `server/bridge/tests/test_semantica_modeling_registration.py`；Semantica 的 `tests/test_wanx_onboarding_registration.py` 使用实际 Bridge 路由、Semantica ASGI 和临时 SQLite，模型输出使用合成结果。真实平台登录、生产模型及 STARLINK 页面尚需宿主联调，不能由本机测试替代。

新增接口支持 Bridge 挂载在 ASGI URL 前缀下；上游始终使用注册路径，不携带外层前缀。回复前重新检查账号及应用身份；两次检查间身份改变时拒绝交付原身份结果。写入若已完成不会被撤销，客户端须恢复原身份后按原操作号查验／重放，不应认为 403 表示服务端未执行。

跨项目验收需要同时具备 Semantica、Bridge 和匹配版本的 `centuarai_local_data_gate.starlink_workbench` 依赖。缺少相邻源码或依赖时该项明确跳过，不能计为通过。常规 Semantica 单仓回归不因此导入失败。Bridge 专项测试已放入 `server/bridge/tests/`，仓库根目录的 `npm run test:bridge` 会收集这些测试。

从 `server/bridge` 目录执行（使用已有环境，设置项目源码及 tests 的 Python 搜索路径）：

```powershell
$env:PYTHONPATH="$PWD;$PWD\tests;$PWD\..\..\shared\packages\local-data-gate"
uv run --no-sync pytest tests/test_semantica_desktop_contract.py tests/test_semantica_workbench.py tests/test_semantica_native.py tests/test_semantica_modeling_registration.py -q
```

全仓 `make all` 包含 Octop 和 Dashboard 的自动格式化，本次按用户指定范围仅执行本模块 Ruff 检查与相关回归，避免改动 Octop。
