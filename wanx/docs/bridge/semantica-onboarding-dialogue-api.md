# Starlink 无材料建仓对话接口对接

版本：2026-11-09。范围：Semantica 后端、WANX Bridge Semantica 契约与测试。无需上传文件，不修改 Octop、Semantica Web 或 Starlink 页面，不增加功能启用开关。

## 1. 产品流程

名称建仓 → 创建 onboarding 会话 → GET 当前状态 → POST start 按已有用途生成开场 → 回答、跳过或暂不确定 → 展示范围草稿、类型关系图和下一问 → 继续回答或修改 → 预览 → 明确确认发布 → 进入当前仓。

先分别确认本仓适用行业和适用角色，已有仓级信息不重复询问；除此之外最多引导 5 轮，每轮只问一个问题。信息充分可提前预览，达到上限停止主动追问，仍可主动修改草稿；不会自动发布。服务对象、用途和至少一个实体类型已经明确时可预览；资料来源等尚未确定的内容可保留在未确定项中，经用户核对后发布。

“企业／部门／个人”只表示业务服务对象，不修改用户身份、团队归属、权限或可见范围。当前 Bridge 开放个人知识仓通道，团队建仓仍走宿主已有流程。

## 2. 路径与调用入口

```text
W = /api/semantica/warehouses/{warehouse_id}
C = W/workbench/conversations/{conversation_id}
O = C/onboarding
```

Starlink 通过 Host/Service 调用 WANX Bridge，Renderer 不直接连接 Semantica。`warehouse_id` 使用仓列表或建仓回执的仓标识，不用 `workspace_id` 替代。账号、仓、权限由 Bridge 注入，请求中不得自行传入。

只填写名称建仓复用原接口：读取／保存 `/api/semantica/modeling/onboarding`，再调用 `/api/semantica/modeling/onboarding/{onboarding_id}/warehouse`。允许 `answers={}`、`purpose=""`，仍需真实记录版本和操作号。系统默认本体仍会存在；创建仓本身不调用模型。

创建会话复用：POST `W/workbench/conversations`：

```json
{
  "operation_id": "create-onboarding-chat-01",
  "_native_operation_id": "create-onboarding-chat-01",
  "scenario": "onboarding"
}
```

以下六个方法／路径均显式注册 Bridge OpenAPI，独立本机 Bridge 使用同一契约：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `O?offset=0&limit=20` | 最新范围草稿、引导进度、轮次分页、发布回执 |
| POST | `O/start` | 根据已有用途、背景生成并保存开场理解、问题和参考答案；信息充分时同时形成初步本体 |
| POST | `O/turns` | 根据本轮回答或修改要求生成并保存新版本私有草稿 |
| GET | `O/turns/{turn_id}` | 恢复指定轮次；不重新调用模型 |
| POST | `O/preview` | 持久化绑定草稿版本、摘要和当前本体的发布预览 |
| POST | `O/publish` | 明确确认后原子发布本体与本仓用途，保存幂等回执 |

所有 POST 的 `operation_id` 与 `_native_operation_id` 必须相同，为 1–120 位 ASCII 字母、数字、下划线或短横线。GET 不需要这些字段。这里没有材料纠错租约，不要传 `_native_editor`。

Semantica 直接路径是 `/api/conversations/{conversation_id}/onboarding...`，签名工作台适配器是 `/api/integration/workbench/conversations/{conversation_id}/onboarding...`。Starlink 只使用上表 Bridge 路径。

onboarding 会话使用本节独立轮次接口；不要再为同一句话调用普通 `C/messages`。建仓会话调用普通 messages 或创建材料 intents 会返回 `MODELING_SCENARIO_MISMATCH`。后续上传材料应新建 `scenario=material` 会话，原材料对话协议保持不变。

## 3. 读取开场与当前草稿

GET `O` 的主要字段：

| 字段 | 含义 |
|---|---|
| `status` | guiding / ready_for_preview / stale / published |
| `draft.revision` | 私有范围草稿版本；初始为 0，成功生成后递增 |
| `draft.round` | 成功回答轮数；首轮 start、失败和幂等恢复不增加 |
| `draft.base_ontology_id` | 本次建仓对话绑定的生效本体 |
| `draft.purpose_revision` | 绑定的本仓用途版本 |
| `draft.scope` | 结构化业务范围，见下表 |
| `draft.schema` | 完整实体类型、关系类型和属性，可用于绘图 |
| `draft.questions` | 当前待回答问题，包含 question_id、field、text、examples、status、answer、source |
| `draft.question_states` | 全部问题台账，包含已回答、跳过、暂不确定及已替换的问题 |
| `draft.ontology_proposed` | 是否已形成模型提出的本体草稿；只调整范围的轮次保留此标记和已有 schema。false 时 schema 仍是生效规则，不可当作新建议发布 |
| `draft.changes` | 相对上一轮的类型／关系 before/after，删除项 after=null |
| `draft.scope_changes` | 本轮范围字段的 before/after |
| `draft_digest` | 下一轮或预览请求原样回传的摘要 |
| `can_preview` | 是否已满足最低预览条件且无轮次生成中，不表示发布授权 |
| `active_turn_id` | 当前生成中的轮次 ID；空闲为 null，不受 turns 分页影响 |
| `can_start` | 是否可启动首轮；成功生成或已有回答后为 false |
| `guidance_source` | fallback 为基础固定引导，model 为已成功生成的模型引导；不代表当前轮次没有失败 |
| `progress` | round、guidance_rounds、remaining_rounds、max_guidance_rounds=5、questions_per_round=1、scope_level=warehouse、next_priority_field、guidance_complete；兼容字段 suggested_rounds=[0,5]、forced_round_limit=true |
| `seed` | 仅包含 purpose：当前仓库的用途、适用行业、适用角色及业务背景；不包含或继承全局 profile。后续沿用仓级快照，长回答仍完整进入预算检查 |
| `turns` | 最近轮次，倒序分页；items、has_more、next_offset |
| `publication` | 历史确认发布回执；未发布为 null |
| `publication_effective` | 此回执的本体是否仍为当前生效本体 |

范围 `scope`：

| 字段 | 类型／含义 |
|---|---|
| industry / occupation | 字符串：当前知识仓适用行业／业务领域、适用业务角色；不表示账号身份 |
| service_objects | 字符串数组：服务对象 |
| purposes | 字符串数组：用途 |
| material_sources | 字符串数组：计划使用的资料来源；不要求已上传 |
| questions_to_answer | 字符串数组：用户希望知识仓回答的业务问题 |
| excluded_scope | 字符串数组：明确排除范围 |
| uncertain_items | 字符串数组：尚未确定或需后续补充的内容 |

`questions_to_answer` 与助手追问 `draft.questions` 是两回事，不能用后者覆盖前者。初始 revision=0 的 schema 是已有默认／生效规则，不应标记为“AI 已生成”。只填写名称的空仓，首次读取仅给出适用行业的开场样例问题，处理后再确认适用角色；已有用途不会再被当作空白询问。

某字段已有部分回答时，仍可能出现针对其歧义的新追问；不能因字段非空就隐藏追问。用户暂不回答而修改其他内容时，未解决的追问继续保留。纯空白的用途、服务对象、标签或模型答复不作为有效结果。

### 3.1 显式启动 LLM 开场

GET 不调用模型。首次进入且 can_start=true 时，POST `O/start`：

```json
{
  "operation_id": "opening-01",
  "_native_operation_id": "opening-01",
  "expected_revision": 0,
  "draft_digest": "<GET O 返回值>"
}
```

响应复用轮次格式，kind=opening。成功后 draft.revision 增加，draft.round 仍为 0。answer 是用途理解及引导说明；draft.questions 是按用途生成的问题和样例。信息不足时允许只生成问题，ontology_proposed=false，生效本体保留且 can_preview=false；不能把 start 当作用户已回答了一轮。

首轮生成使用与普通轮次相同的持久化、超时、权限、版本和幂等机制。等待中通过 active_turn_id 恢复；成功后不能用新操作号重新 start，改用 turns。失败时保留 fallback 问题，页面明确标注“基础引导”，可用新操作号重试 start，也可直接回答基础问题。刷新页面先读取，不自动重复发起 start。

### 3.2 问题及状态

```json
{
  "question_id": "<服务端生成的稳定 ID>",
  "field": "material_sources",
  "text": "是否包含历史合同？",
  "examples": ["只处理在履行合同", "历史合同也需要"],
  "status": "pending",
  "answer": "",
  "source": "model"
}
```

status：pending=待回答、answered=已回答、skipped=已跳过、uncertain=暂不确定、superseded=已被后续引导替换、deferred=暂缓展示。examples 最多 3 项，仅供参考，点击后应填入输入框，由用户确认发送。不能自动把样例记为事实。field 与 ID 由后端维护，前端原样回传 ID，不自行匹配问题文字。

问题改写时沿用原 ID，previous_texts 保存旧问法供服务端去重，前端无需根据它做状态判断。已跳过、暂不确定或不再适用的问题不会仅因换了问法被重新激活。问题是否已回答以台账 status 为准，不能通过 scope 字段非空来推断。

## 4. 发送回答或自然语言修改

POST `O/turns`：

```json
{
  "operation_id": "onboarding-turn-01",
  "_native_operation_id": "onboarding-turn-01",
  "expected_revision": 0,
  "draft_digest": "<GET O 返回的 draft_digest>",
  "content": "为企业法务部门整理采购合同，重点查询付款义务，暂不处理员工资料。"
}
```

同一接口也接受：“把采购方和供应方合并为当事人，增加角色属性”“调整履约关系的终点”“排除采购价格分析”。返回的是完整的新范围草稿和变化，不只是文本建议；合并、删除、关系端点及属性必须通过服务端结构校验。

按指定问题回答或跳过时，扩展同一个 turns 请求：

```json
{
  "operation_id": "answer-02",
  "_native_operation_id": "answer-02",
  "expected_revision": 1,
  "draft_digest": "<最新 GET O 返回值>",
  "content": "同时请把采购方和供应方统一为当事人",
  "question_actions": [
    {"question_id": "<当前问题 ID>", "action": "answer", "answer": "只处理在履行合同"}
  ]
}
```

question_actions 最多 2 项，action 支持 answer / skip / uncertain。answer 动作要求非空答案；skip、uncertain 不传 answer。只有动作时 content 可省略或为空；只有自由文本时 question_actions 可省略。content 与所有答案合计最多 8000 字。旧客户端仅传 content 的请求仍兼容。用户可通过已保存的问题 ID 主动补充或修改以前的回答。

问题动作先保存在轮次记录中，模型成功后与新草稿一起生效；生成失败时原草稿、原问题状态不变，失败回执保留原输入和动作。恢复原操作不重复生成；用户选择重新生成时使用新操作号。明确的跳过／暂不确定不能被模型改成“已回答”；这些问题不会继续出现在当前待答列表，但在 question_states 中保留。自由文本回答由模型结合上下文关联到原问题；重要回答建议按 ID 提交。

后续轮次也允许仅继续澄清或调整业务范围，不强制每轮重新生成本体。响应始终返回完整 draft.schema：若本轮模型没有修改本体，保留上一版；若尚无本体建议，ontology_proposed=false、can_preview=false。前端每轮都以服务端返回的完整草稿为准，不因“本轮没有新增类型”清空已有图谱。

每轮最多 8000 字。模型最多输出 16 个实体类型、16 个关系类型，每类型最多 8 个属性；已有本体超出该规模时明确拒绝，使用已有本体编辑流程，不静默裁剪。新路径不沿用旧初始化“每次 1–3 条候选”的限制。生成输出预算按模型剩余上下文计算，最多 4096 token，与适配器及 Bridge 上限一致；不足、截断、非法 JSON、关系引用缺失等会明确失败，不保存半成品。

请求通常等待本轮生成结束。Bridge 为 start、turns 保留 285 秒，其余新接口为 45 秒；业务截止时间不超过现有模型超时和 240 秒。状态与原输入在模型调用前已经持久化，等待期间可以并行 GET `O`，从 active_turn_id 取得轮次，再 GET `O/turns/{resource_id}`。

| 轮次 status | 页面行为 |
|---|---|
| generating | 显示生成中；读取原轮次，不另发同义请求 |
| succeeded | 展示 answer、draft.scope、draft.schema、draft.changes、draft.scope_changes、draft.questions |
| failed | 原草稿保留；按 error_code 显示原因，用户决定重试时用新操作号 |
| stale | 生成期间本体或用途变化，未应用本轮结果；读取状态并重新开始建仓会话 |

指定轮次还返回 `is_current`、`current_revision`、`current_draft_digest`、`progress`、`can_preview`。历史成功结果可能 is_current=false，不能覆盖页面上的最新草稿。进入下一轮前建议重新 GET `O`，使用最新 revision/digest。

每轮成功只写私有草稿，`publication_performed=false`。不会创建具体事实、启动抽取、更新权限或改变生效规则。

## 5. 预览并确认发布

POST `O/preview`：

```json
{
  "operation_id": "onboarding-preview-01",
  "_native_operation_id": "onboarding-preview-01",
  "expected_revision": 6,
  "draft_digest": "<最新 draft_digest>",
  "name": "合同管理本体"
}
```

使用实际版本，不要写死为 6。预览返回 `resource_id`、`preview_digest`、`draft_revision`、`draft_digest`、完整 scope/schema、相对当前生效本体的 changes 和剩余 questions。预览不创建可绕过确认发布的本体版本，不调用模型。

展示全部范围、类型关系属性、排除内容和未确定项，由用户明确确认后 POST `O/publish`：

```json
{
  "operation_id": "onboarding-publish-01",
  "_native_operation_id": "onboarding-publish-01",
  "preview_id": "<预览 resource_id>",
  "preview_digest": "<预览 preview_digest>",
  "confirmed": true
}
```

发布返回 `status=published`、`ontology_id`、`version_number`、`changed`、scope/schema、`unresolved_items`、questions，以及 `publication_performed=true`、`extraction_started=false`。同一事务更新本仓用途、资料来源和业务问题，不改用户全局背景、仓归属或权限。本体未变化时复用当前版本，仍保存已确认业务范围和回执。

预览与发布回执增加 question_states；发布回执还包含 unresolved_questions（pending / deferred / skipped / uncertain）。前端可用它展示后续补充入口，不能因当前 questions 为空就认定所有问题已回答。旧预览仍可按原摘要恢复和发布；新增字段为空时按旧回执处理。

发布成功后进入当前仓，读取实际生效规则；不要再展示初始默认规则。保留未确定项的后续补充入口。此会话保留为已发布历史，如需继续修改，创建新的 onboarding 会话（读取当前规则和本仓用途）；较大本体使用既有规则编辑流程。随后需要处理文件时创建 material 会话。

本仓用途同时保留结构化范围，后续建仓会话可完整恢复多项用途、资料来源、业务问题及最多 8 项未确定内容。若其他入口修改了用途，以最新修改为准，不恢复旧范围覆盖新答案。

## 6. 恢复、幂等与冲突

- 刷新页面后读取仓内会话列表，选择 scenario=onboarding 的会话，再 GET `O`，无需重新建仓或生成。
- 响应丢失时，原操作号、原请求体重试；相同请求返回原回执，不重复调用模型、增加草稿版本或发布。同操作号不同内容报冲突。
- 如丢失 turn_id，GET `O` 的 turns 分页可恢复。普通 `C/messages` 列表不包含这些结构化建仓轮次。
- 正在生成时不接受并行新轮次、预览或发布，can_preview=false、active_turn_id 指向原轮次；即使正在查看其他历史分页也可据此恢复。过期 generating 会持久化为 failed。服务重启后不会自动重跑模型，失败重试需新操作号。
- 预览后又进行了成功对话，旧预览不能发布。别处修改生效本体或本仓用途，也会阻止旧草稿发布；已有私有草稿和历史仍可读取，新会话从当前规则开始。
- 已发布回执是历史事实，恢复后用 `publication_effective` 判断是否仍生效；不能仅凭 HTTP 200 或历史 published 状态判断当前规则。
- 切仓／切账号后停止旧轮询，丢弃旧响应；账号、仓及会话归属在读取和重试前重新校验。

主要错误码：`MODELING_ONBOARDING_BUSY`、`MODELING_ONBOARDING_STALE`、`MODELING_ONBOARDING_NOT_READY`、`MODELING_ONBOARDING_TIMEOUT`、`MODELING_ONBOARDING_INVALID_OUTPUT`、`MODELING_ONBOARDING_MODEL_FAILED`、`MODELING_CONTEXT_BUDGET`、`MODELING_OPERATION_CONFLICT`、`MODELING_SCENARIO_MISMATCH`。模型路由还可能返回原有 `MODEL_INVALID_OUTPUT` 或授权错误，不应当作成功。

## 7. 前端联调验收

本次新增错误码：MODELING_ONBOARDING_ALREADY_STARTED（已成功启动，请继续 turns）、MODELING_ONBOARDING_QUESTION_STALE（问题不属于当前会话或重复提交，请读取最新台账）。

1. 仅填写名称建个人仓，未上传任何文件，进入建仓会话后能看到开场问题。
2. 确认行业和角色后，最多回答 5 轮单题引导，逐轮显示范围与图谱；已有答案持续保留，可提前预览或继续修改。
3. 修改、合并类型，调整关系及属性；本轮差异正确，未确认发布前生效本体不变。
4. “企业／部门／个人”的回答只更新服务对象，仓权限和归属不变。
5. 保留用户希望回答的问题、排除范围和未确定项；最终预览与轮次草稿一致。
6. 预览后继续修改、并发提交、切换账号、更新生效本体时，旧预览被拒绝。
7. 模型失败、截断、断网、响应丢失及重启后恢复原状态，无重复生成或发布。
8. 最终确认后进入仓，显示实际生效类型和关系；新建材料会话使用新的规则与用途。

自动化验证使用真实路由和隔离数据库，模型回包为合成数据。真实模型的引导质量、单题与最多5轮体验和 Starlink 页面交互需部署后联调验收。

## 8. 可直接同步给 Starlink 团队的开发任务

本轮后端与 WANX Bridge 已交付动态建仓引导；前端需调整建仓会话页面，所有调用继续通过 WANX Bridge。接口前缀为 `/api/semantica/warehouses/{warehouse_id}/workbench/conversations/{conversation_id}/onboarding`，下文简称 O。

| 开发事项 | 调用与页面行为 | 验收要点 |
|---|---|---|
| 首次启动 | 建仓并创建 onboarding 会话后 GET O，使用当前 revision/digest 调用 POST O/start | 展示 answer、questions、examples；首轮生成不计为用户回答，不能写死版本号 |
| 回答与跳过 | POST O/turns，支持自由文本和 question_actions；action 为 answer / skip / uncertain | 样例经用户确认才发送；按 ID 操作，改写问题后仍能正确关联 |
| 同屏更新 | 展示 draft.scope、schema、changes 和 question_states | 只调整范围也保留图谱；尚无建议时明确显示“正在明确范围”，不把默认规则当作新建议 |
| 生成与恢复 | generating 时禁用重复发送和发布；GET O 获取 active_turn_id，再 GET O/turns/{id} | 刷新不重复生成；失败保留输入与上版草稿，显示错误原因 |
| 重试与版本 | 响应丢失用原操作号、原请求体恢复；明确失败后用户重试使用新操作号 | 不仅检查 HTTP 200，还需检查 status；后续提交使用最新 revision/digest |
| 核对与发布 | can_preview=true 时允许进入核对；POST O/preview 后明确确认，再 POST O/publish | 有待补充问题不等于禁止核对；成功后进入当前仓并读取实际生效规则，保留 unresolved_questions 入口 |

建议页面左侧对话、右侧本体草稿。轮次 answer、question examples 由后端生成；前端不硬编码问题顺序，不强制凑满 5 轮；行业和适用角色不计入这 5 轮。切仓、切会话后丢弃旧请求响应，历史轮次 is_current=false 时不能覆盖当前草稿。

首次进入可以启动引导；刷新时优先恢复已有轮次，不能看到 can_start=true 就无条件重试失败的 start。fallback 表示基础固定引导，应明确标注；既可由用户重试生成，也可直接回答基础问题。上线联调前需更新并重启 Semantica 和 WANX Bridge，本说明不代表服务已重启或真实模型体验已验收。


## 11. 本轮交付：仓库适用范围与单题引导（可直接发 Starlink）

本次将行业、角色、背景改为当前知识仓的业务适用范围；不作为人的固定职业画像，不控制权限。请同步调整建仓表单和会话页，接口继续通过 WANX Bridge。

### 11.1 建仓入口

- 表单标签改为“适用行业／业务领域”“适用角色”“仓库业务背景”；不再展示“保存我的背景”或自动使用其他仓／全局个人资料。
- 允许只填写仓名，先创建仓，再通过对话补齐范围。前端不要求先完成个人背景问卷。
- 兼容入口仍先 GET `/api/semantica/modeling/onboarding` 取得 id、revision；已有 id 直接使用，不回写个人资料。首次没有 id 时 POST 同路径，提交 `answers={}`、`expected_revision=0` 和新的 operation_id，仅建立空的流程记录。不要清空已有个人记录，也不要从返回的旧 answers 预填新仓。
- 如建仓前已经填写仓级范围，随创建请求的 `warehouse_scope` 一次提交；不再 POST 到全局 onboarding.answers。未填写则省略 warehouse_scope。用途仍用顶层 purpose。

POST `/api/semantica/modeling/onboarding/{onboarding_id}/warehouse`：

```json
{
  "operation_id": "create-contract-warehouse-01",
  "expected_revision": 1,
  "name": "采购合同知识仓",
  "purpose": "查询合同义务与违约责任",
  "warehouse_scope": {
    "industry": "企业法务",
    "occupation": "采购合同审核人员",
    "background": "本仓用于采购合同审查",
    "material_types": "采购合同、补充协议",
    "questions": "哪些合同存在逾期付款风险？"
  }
}
```

版本和操作号使用实际值；行业、角色各最多200字，其余 warehouse_scope 字段各最多8000字。warehouse_scope 不支持账号、权限、仓标识等字段。新建仓不自动继承旧 onboarding.answers 中的任何信息；旧建仓操作的幂等回执仍能恢复。

### 11.2 引导交互

1. 沿用 GET O → POST O/start → POST O/turns。每次只展示 `draft.questions[0]`，数组为空时不自行编造下一问；不能把 question_states 全部渲染成当前待答问题。
2. 行业、角色逐一确认，允许回答／跳过／暂不确定。样例是参考，只有用户提交才是答案；名称中沿用 industry、occupation，但含义是仓库适用范围。
3. 后续问题由 LLM 根据已有用途和回答调整，通常覆盖服务对象、用途、材料来源、希望回答的业务问题及范围／本体边界；不是必须问满的固定问卷。每轮一个主题，不把多个问题拼在一条消息里。
4. 发送问题动作时提交当前 question_id，每次一个。后端仍兼容旧请求最多2个动作以恢复历史操作；这不代表前端可展示两个问题。answer 文本用于总结，问题只从 draft.questions 渲染。
5. 用 `progress.guidance_rounds` 显示已完成的普通引导轮数，`remaining_rounds` 显示剩余；行业／角色不计入。成功处理当前普通问题才加1，失败、读取、start 和幂等重试不加；用户在待答普通问题下发送修改也算该次交互一轮。无待答问题后的主动修改不再增加计数。draft.round 仍记录全部成功用户对话轮次，不能用它当5轮进度。
6. 达到5轮后不再主动提问，保留“继续修改”和“核对并发布”。`guidance_complete=true` 只表示没有当前追问，是否可以核对以 `can_preview` 为准；不能由计数推断已经生成本体。未满足条件时展示已有缺失项，允许用户主动补充，不自动发起第6轮问卷。
7. `question_states.status=deferred` 表示本轮未展示或到达上限后留待补充，不能标为已回答。这些项保留到预览及发布的 unresolved_questions，后续可主动补充。旧草稿恢复时保留已用轮数，仅展示一个当前问题。
8. 右侧继续以完整 draft.scope/schema 更新草稿图谱；发布仍必须 preview → 明确确认 → publish。达到轮数上限不会自动发布，也不影响材料会话原有追问。

### 11.3 仓内建议及兼容边界

`GET W/modeling/suggestion-context` 新增 `scope_level=warehouse`，只从本仓范围读取新建议的输入。`POST W/modeling/answer-confirmations` 仍沿用原结构；answers 中的 industry、occupation、background 现在保存为本仓业务范围，沿用 expected_revision 和 expected_confirmation_id 并发保护。onboarding_revision 为兼容字段继续回传，新确认不再因全局个人背景修改而失效；旧确认保留原有版本校验。

历史全局背景与旧私有回执未删除，旧全局保存端点仅供旧客户端兼容；新建仓流程不再使用它保存行业、角色和背景。新提交的仓级业务范围可被有当前仓权限的使用者读取，私有对话和生成回执仍按原身份隔离。不要把私人履历自动搬到仓级字段。

上线前同时更新并重启 Semantica 与 WANX Bridge。前端验收：空仓单独询问行业和角色；普通引导最多5轮且每轮一问；跳过不重复问；刷新和重试不增加轮数；切仓不带入旧范围；5轮后仍可修改、预览和确认发布。

### 11.4 本轮验证

- 建仓对话与回答建议测试83项通过，覆盖单题、普通引导5轮上限、行业角色不计数、跨仓隔离、全局资料不继承、旧草稿恢复与失败重试。
- 材料对话、建模规则、影响分析、Copilot 等相关回归191项通过（与上项有重叠）。建仓创建接口及签名流程也通过回归。
- Bridge 419项契约测试验证完成：最终整组418项通过，1项遇到授权租约过期；该项独立复测通过。Ruff 检查通过。
- 真实 Bridge 路由对 Semantica 隔离实例的3项跨系统自动化通过，未跳过；模型回包使用测试数据。未启动真实 LLM 或验收 Starlink 页面，也未替用户重启服务。

## 12. 本轮 Review 修复与 token 配置说明（2026-11-09）

- 修复建仓对话与本体 Copilot 请求6144输出 tokens，但真实适配器及 Bridge 只接受4096的冲突。两处预算统一使用适配器上限；回归覆盖真实适配器校验，避免仅模拟上层模型而漏检。
- 本轮模型提出的 pending 问题优先于历史 deferred 问题；用户主动回答 deferred 问题或改变范围时，可以明确解决／替换它，避免旧问题重复展示。
- 明确通过 question_actions 提交的行业、角色短答案由服务端保存，不因模型遗漏字段而丢失。超过200字的原回答仍保存在台账，模型需要提供非空摘要；不得把空值当作已成功保存。

### 12.1 Starlink 当前不能通过消息指定上下文长度

`POST O/start`、`POST O/turns` 和 Copilot turns 不接受 `llm_context_tokens`、`context_tokens`、`max_tokens` 或 `max_output_tokens`；额外字段会返回422。已注册的 `/api/semantica/processing`、`/processing/check` 支持模型选择及既有思考模式，但尚无 token 上下文配置字段。切换成支持长上下文的模型也不会自动覆盖 Semantica 的配置值。

当前真正控制预算的是 Semantica 的 `llm_context_tokens`（默认4096，配置范围2048–131072）。管理员可通过现有模型设置调整；本机 `/api/settings/llm` 的读取和保存接口不在 Starlink 的 Bridge 放行列表中，不能直接让前端绕过 Bridge 调用。环境变量为 `LLM_CONTEXT_TOKENS`，但已经保存的 `data_dir/llm-connection.json` 会覆盖环境默认值，应通过现有配置服务更新，避免只改环境变量后误以为生效。

设为16384或32768可扩大预算，但必须先确认所选模型和服务端实际支持；这里的数字不代表自动扩展模型能力。本轮没有修改部署配置或扩大提供方限制。若后续需要 Starlink 可配，应扩展仓级 processing/check→save 契约，绑定仓权限、配置版本及模型实际能力；不要把消息中的 max_tokens 当作上下文配置。

### 12.2 预算诊断回执

建仓和 Copilot 轮次增加可选 `context_budget`，由既有 POST turns/start 及 GET turns/{id} 透传，无新增路由。

| 字段 | 含义 |
| --- | --- |
| context_tokens | 本轮实际读取的 Semantica 上下文配置 |
| input_tokens | 指令、仓库资料、本体、台账和对话历史的估算输入量 |
| schema_tokens | 结构化输出 JSON Schema 的估算量 |
| reserve_tokens | 固定预留128 |
| min_output_tokens | 最低可用输出预算1536 |
| max_output_tokens | 本路径输出上限4096 |
| available_output_tokens | 上下文减输入、Schema、预留，可为负值 |
| required_context_tokens | 本轮输入+Schema+预留+1536的估算最低上下文 |
| output_token_budget | 本轮计算出的输出预算，失败时可能为0；不表示实际消耗 |

计算：`available = context_tokens - input_tokens - schema_tokens - 128`；不足1536时返回 `status=failed`、`error_code=MODELING_CONTEXT_BUDGET`，不调用模型、不消耗引导轮数、不修改草稿。有足够空间时按 `min(4096, available)` 请求输出。估算保守，不是提供商精确 tokenizer 计费数；模型仍可能有更小的输出限制。

默认4096不足以容纳当前完整建仓指令、Schema、数据和1536输出预留，空仓也可能在模型调用前失败。Starlink 应展示当前 context_tokens、required_context_tokens，并提示检查模型设置；保持原输入，读取回执恢复。配置调整后用**新 operation_id**重试，继续使用未变化的 revision/digest；重放原操作返回原失败回执，不会重新生成。不能静默丢弃历史或降低1536门槛来掩盖容量不足。

本轮修复验证：建仓及 Copilot 71项，适配器／处理模型／配置66项，Bridge 对话注册220项，跨系统3项（未跳过）通过。真实 LLM 和 Starlink 页面体验仍需联调，未修改部署中的上下文配置或重启服务。
