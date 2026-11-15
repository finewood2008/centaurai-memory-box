# Starlink 单页材料对话与修正接口对接

版本：2026-11-07。开发范围：Semantica 后端、WANX Bridge Semantica 模块、接口测试；本次没有实现或修改 Semantica Web、Starlink 页面，也没有修改 Octop。

## 1. 给 Starlink 团队的开发说明

请将材料阅读、目标、本体建议、已有类型关联、事实候选、差异与确认操作放在同一个页面。页面不必再按三个环节反复跳转，但仍要区分“提案”“已保存草稿”“已发布”。

新后端链路是：读取上下文 → 根据本轮文字生成结构化修改提案 → 展示差异 → 用户确认应用 → 刷新草稿。应用不发布规则、不开始抽取、不发布材料知识。最终确认继续使用既有发布、抽取计划接口。

左侧可以展示普通问答与修改提案两个来源的消息。新提案回执保存 `instruction`、`created_at`、`result.summary/questions/operations`，重启后可以恢复。修改请求调用新 `change-proposals` 即可，不要为同一请求再调用一次普通 messages 触发第二轮模型。普通阅读问答继续使用现有 messages/turns；其旧 `modification_intent` 只表示意图，不能显示“已保存”。

建议提供这些操作：

- 上传并解析后：展示解析状态、当前生效本体；生成并展示“本次材料涉及的结构建议”，附阅读范围。
- 对话提出修改后：展示“待确认的修改”，分组列出目标、本体、事实的 before/after。
- `can_apply=true` 时：显示“应用这些修改到草稿”；应用成功才显示“草稿已更新”。
- 已有完整草稿时：显示“预览并确认发布”；校验发布范围和原文依据后再提交。
- 没有抽取结果时：先核对规则和目标，在当前页确认抽取计划；抽取完成再展示具体事实。

## 2. 范围与支持的修改

| 操作 kind | 行为 |
|---|---|
| `goal` | 修改本次材料的目标和补充说明；已抽取的意图会保留，并创建新的处理意图承载新目标 |
| `add_type` | 增加实体或关系类型；关系端点须在完整目标本体中存在 |
| `edit_type` | 修改已有类型的显示名称和定义，不改变其标识 |
| `merge_entity_types` | 合并明确列出的实体类型，保留兼容属性，调整关系端点；有材料草稿时同步重分类其中涉及的实体 |
| `upsert_property` | 增加或修改类型属性；新增属性为选填，不自动填事实值 |
| `edit_item` | 修改明确选中的草稿事实名称、类型或一个属性值；名称和属性值必须有本轮读取的原文逐字依据 |
| `exclude_item` | 排除明确选中的事实；涉及关系依赖时必须明确同时处理关系，不自动连带删除 |

最多选择20个事实条目、每次最多8个模型操作；类型合并展开后最多影响100个事实条目。超范围明确失败，请分批核对。不能以本接口新增任意事实、任意改接关系端点、执行自由 JSON Patch 或调用模型返回的工具/URL。范围不明时返回澄清问题。

合并类型不会合并同名的具体实体。例如采购方与供应方统一分类为“当事人”，不等于把两家公司合并为同一个实体；新增“角色”属性也不等于已经补抽出了角色值。

## 3. Bridge 路径与调用约定

Starlink 使用现有 Host/Service → WANX Bridge 账号通道，不能从 Renderer 直接调用 Semantica。

定义：

```text
W = /api/semantica/warehouses/{warehouse_id}
B = W/workbench
C = B/conversations/{conversation_id}
I = C/intents/{intent_id}
D = B/documents/{document_id}/corrections/{draft_id}
```

`warehouse_id` 使用仓列表的 `id` 或建仓回执 `resource_id`，不要替换成 `workspace_id`。Bridge 注入账号、仓和授权信息，前端不得传 actor、workspace、permissions 等字段。

本次新增4个方法／路径，均显式进入 Bridge OpenAPI：

| 方法及路径 | 作用 | 是否调用模型／写业务草稿 |
|---|---|---|
| POST `I/change-context` | 读取本体、目标、选择条目、上下文摘要与提案索引分页 | 不调用模型，不改业务草稿 |
| POST `I/change-proposals` | 根据本轮文字生成并持久化修改提案 | 调用模型，不改业务草稿 |
| POST `I/change-proposals/{proposal_id}/read` | 恢复结果、检查有效性 | 不调用模型，不改业务草稿 |
| POST `I/change-proposals/{proposal_id}/apply` | 明确确认后原子应用目标、规则及事实修改 | 不调用模型，写待确认草稿或目标 |

读取使用固定 POST 是为了携带私有编辑凭据，不接受任意路径或方法覆盖。请求使用当前账号的管理授权，沿用已有 POST 的 `_native_operation_id`。生成和应用还须传相同值的 `operation_id`；操作号1–120位 ASCII 字母、数字、下划线或短横线。

这4条路径在独立本机 Bridge 同样注册。个人仓通道可用；本次不扩展团队仓入口或 `local-data-gate=required` 通道，不通过关闭网关绕过要求。

## 4. 读取上下文

无材料事实草稿时：

```json
{
  "_native_operation_id": "context-01"
}
```

已创建材料核对草稿、需要修改具体事实时：

```json
{
  "_native_operation_id": "context-02",
  "draft_id": "<draft_id>",
  "selected_item_ids": ["<item_id>"],
  "_native_editor": {
    "session": "<editor_session>",
    "generation": "1"
  }
}
```

编辑会话仍由既有 corrections/sessions 签发，按照原契约恢复、续期。不得让前端生成 session 或将其他页面的凭据混用。草稿相关的生成、读取和应用均须携带有效 `_native_editor`，即使读取时 body 没有 draft_id。

重要返回字段：

| 字段 | 前端用途 |
|---|---|
| `context_digest` | 原样用于本次提案生成；绑定材料、会话、目标、规则、草稿和所选条目 |
| `base_ontology_id` | 当前仓生效本体 |
| `ontology_id/schema` | 当前编辑目标结构，可能是尚未发布的规则草稿 |
| `draft_id/draft_revision` | 材料事实草稿及修订 |
| `goal` | 已确认的材料目标 |
| `selected_items/item_count` | 本次选中的具体事实，以及草稿总条目数；不是全部事实分页接口 |
| `coverage` | 初始可用来源的取样范围；模型实际读到的范围以提案 result.coverage 为准 |
| `recent_proposals` | 每页最多10个提案的 id、状态和时间；恢复时再逐个 read 校验当前状态 |
| `proposal_has_more/proposal_next_offset` | 将 next_offset 作为下次 context 的 proposal_offset 继续读取历史；分页参数不传给 generate |

本次新提案应用生成的 `ontology_draft_id` 可以带回下一次 context 和 generate，继续修改同一轮待确认结构。它必须是本账号、本会话及当前材料意图（或返回的 active_intent_id）所属的有效草稿；不要传任意历史本体草稿 ID。若已经取得材料编辑草稿，则使用其当前绑定的本体目标。

## 5. 生成提案并展示差异

POST `I/change-proposals`：

```json
{
  "operation_id": "change-01",
  "_native_operation_id": "change-01",
  "context_digest": "<刚读取的64位摘要>",
  "instruction": "把采购方与供应方统一为当事人类型，新增选填角色属性；保留各公司的具体实体。",
  "draft_id": "<draft_id>",
  "selected_item_ids": [],
  "_native_editor": {"session": "<editor_session>", "generation": "1"}
}
```

无事实草稿时省略 draft_id 和 editor。context 与 generate 的 `draft_id/ontology_draft_id/selected_item_ids` 必须一致。修改具体事实前应在右侧选中条目，传真实 item_id；不能用“它”或名称猜测 ID。

解析后首次生成材料结构建议，也可使用本接口，例如 instruction 为“依据当前材料和目标，提出少量必要的类型、关系或属性；优先复用已有结构”。这样首次建议与后续对话修改共用提案恢复链路。既有 `B/ontology-suggestions/generate` 仍可使用，但不要为同一次操作重复调用两套生成接口。

生成最多一次模型请求，输出预算上限3072 tokens；依据现有上下文配置规划，不截断用户文字、规则或所选事实。材料片段可以减少取样，结果会报告实际范围；预算仍不足时失败，不要求新增启用配置。同步生成 Bridge 等待预算285秒；前端超时应恢复原操作，不自动换新操作号。

提案主要返回：

```json
{
  "id": "<proposal_id>",
  "resource_id": "<proposal_id>",
  "status": "prepared",
  "can_apply": true,
  "instruction": "原始修改要求",
  "created_at": "<服务端时间>",
  "context_digest": "<上下文摘要>",
  "proposal_digest": "<提案摘要>",
  "result": {
    "summary": "建议统一类型并保留具体实体",
    "questions": [],
    "operations": [],
    "schema": {"entity_types": [], "relation_types": []},
    "changes": [],
    "type_mapping": {"BUYER": "PARTY", "SELLER": "PARTY"},
    "reextract": {
      "recommended": true,
      "reasons": ["types_merged", "property_changed"],
      "automatic": false,
      "scope": "current_document"
    },
    "validation": {"remaining_error_count": 0, "issues": [], "publication_preview_required": true},
    "coverage": {"sampled_segments": 2, "total_segments": 8, "partial": true, "segments": []}
  }
}
```

以上为字段示意，真实 prepared 回执须有非空 changes。schema 是完整目标结构，不能把示例空数组作为请求发送。changes 包含 `scope=goal/rules/facts` 和 before/after；规则差异有类型标识，事实差异有 item_id。右侧展示 schema、差异和 type_mapping；关系连线取 source_types/target_types，属性归属取所在类型。相似建议不等于确定复用，复用/合并须基于实际提案与用户确认。

| 状态 | 页面行为 |
|---|---|
| `generating` | 显示处理中，用 read 恢复；不允许应用 |
| `needs_clarification` | 展示 questions；用户明确后读取新 context，再用新操作号生成；服务端携带同一上下文内最近三轮连续未完成的追问，不应用部分修改 |
| `prepared` | 展示差异，仅 can_apply=true 可确认应用 |
| `no_changes` | 显示说明，不制造新草稿 |
| `failed` | 显示安全错误与重试入口；同操作号返回原失败，不自动再次调用模型 |
| `stale` | 当前上下文已变，旧提案不能应用；重新读取并生成 |
| `applied` | 显示 application 回执，表示草稿或目标已更新，不表示发布 |

原有草稿的其他校验问题可以继续保留以逐项修正；新修改不能引入新的硬错误。`remaining_error_count` 不是逐条人工审核计数，不能代替最终发布预览。

澄清续答继续使用 `change-proposals`，无需另调 `messages`。`result.clarification_proposal_ids` 列出本轮引用的追问提案，按时间从旧到新排列；无引用时为空数组。只在同一账号、会话、材料意图及 context_digest 内衔接。目标、规则、选择或草稿发生变化后，应重新完整描述要求；已完成的修改请求不会作为未完成追问继续执行。超出三轮的内容需要用户在本轮补充，历史内容不会被自动当成事实证据。

`type_mapping` 指向本轮最终类型，连续合并时不会停留在中间类型。事实补充会保留同一片段原有证据并扩大引用范围；如新旧依据合并超过单段 2000 字符限制，返回 `MODELING_CHANGE_INVALID`，交由条目编辑器核对，不会静默丢弃旧依据。

## 6. 确认应用、继续对话及最终发布

POST `I/change-proposals/{proposal_id}/apply`：

```json
{
  "operation_id": "apply-01",
  "_native_operation_id": "apply-01",
  "proposal_digest": "<生成回执原值>",
  "confirmed": true,
  "_native_editor": {"session": "<editor_session>", "generation": "1"}
}
```

无材料草稿时省略 editor。应用返回 `status=applied`、`draft_id/draft_revision`、`ontology_draft_id`、`active_intent_id`、`goal_receipt/draft_receipt` 和重抽提示。总是 `publication_performed=false`、`extraction_started=false`。

- 应用成功后更新草稿修订，再读取 context、原文及事实分页刷新右侧，显示“已保存到草稿”。
- 保存目标时如返回不同 active_intent_id，后续目标和处理计划使用新意图；旧抽取结果保留为历史。
- 新类型、定义、属性或目标变化会提示可能需要重抽；只调整显示名称或已有事实通常不要求重抽。提示不是已经执行，也不能证明其他材料不受影响。
- 无事实草稿时，用户在同页确认发布 `ontology_draft_id` 后，再读取当前目标与抽取计划；若规则变化令原目标确认失效，重新确认目标。使用实际当前生效本体确认抽取。
- 有事实草稿且关联了规则草稿时，可使用既有 `D/preview`（经 `_correction_read`）预览，再明确调用 `D/apply` 统一提交规则与本篇知识发布；仍须等待 publication/job 成功。
- 首次抽取的草稿同样适用统一发布。系统识别本草稿所选规则的确认发布，不会把自身引起的旧本体替换误判为冲突；其他规则版本抢先发布、来源变化或抽取取消仍会阻止提交／后台发布。
- 单纯材料事实修改可继续使用原 `D/submit`。发布提交失败、来源变化、人工保护、编辑租约及恢复按现有契约处理。
- 如用户选择重新抽取，先确认规则及处理范围，恢复／创建当前材料意图、确认目标，再读取 `I/plan` 并明确调用 `I/confirm`；抽取结果仍需合入草稿核对，不能覆盖人工结果。

不要把“应用提案”和“发布知识”共用一个含糊的按钮。两者可以在同页分别完成，无需导航到新页面。

## 7. 恢复、冲突与权限

POST read 的 body 为 `{"_native_operation_id":"read-01"}`，若提案关联材料草稿，附 `_native_editor`。通过 context.recent_proposals 分页找回历史记录；本地也保存 proposal_id 和原生成/应用请求，保留原操作号及 body。每份材料意图有独立提案历史；切换到 active_intent_id 后，保留旧意图的历史入口。

生成和应用按账号、会话、意图与操作号隔离。重复操作号不同请求体返回冲突；重复应用同一请求不会再创建版本或修改事实。数据库写入失败时，目标、规则、事实及应用回执一起回滚。

| 错误 | 处理 |
|---|---|
| `MODELING_CHANGE_STALE` | 刷新目标、规则、草稿和 context；重新生成，不自动应用旧差异 |
| `MODELING_CHANGE_BUSY` | 等待已有处理完成或恢复原提案 |
| `MODELING_CHANGE_INVALID` | 操作目标、依赖或原文依据不成立；缩小/明确要求或进入现有编辑器核对 |
| `MODELING_CHANGE_CONTEXT_TOO_LARGE` | 缩小选择或按现有配置调整模型上下文；不要截断用户输入 |
| `MODELING_CHANGE_INVALID_OUTPUT` | 模型 JSON/结构不合法；失败不会写草稿 |
| `MODEL_INVALID_OUTPUT` | 模型转发报告截断或预算回执无效；不可当作成功 |
| `MODELING_CHANGE_TIMEOUT` / `MODELING_CHANGE_MODEL_FAILED` | 先读原回执，用户明确重试时才换生成操作号 |
| `CORRECTION_*` | 按既有租约/修订流程恢复；不得共享或猜测编辑凭据 |
| `MODELING_RESOURCE_NOT_FOUND` / 403 | 停止读取并清除无权访问的数据，不回退到其他账号或仓 |

用户切仓、切账号后停止轮询并丢弃旧响应。所有业务成功均以服务端状态为准，HTTP200本身不能作为成功判断。当前功能不实现逐条 pending/confirmed/excluded 的跨端审核台账，也不支持把前端勾选数量直接提交成部分发布。

## 8. 联调验收

1. 上传一份合成合同，解析后在原页面看到当前本体和材料结构提案，取样范围明确。
2. 输入类型合并和新增角色属性要求，右侧展示差异、保留已有关系端点；确认后仅草稿更新。
3. 继续对话修改刚保存的规则草稿，刷新页面后可以恢复原提案与应用回执。
4. 完成抽取并合入材料草稿，选择一项事实，通过对话修改有原文支持的属性；修改与来源对应。
5. 没有依据的金额或日期修改不能进入草稿；排除实体而留下悬空关系时拒绝应用。
6. 在原页面预览并确认发布，等待发布成功后显示生效版本；新属性缺值时不能声称已补抽。
7. 模型输出非法、超时、断网、响应丢失及服务重启时不重复生成/应用；规则或草稿被其他页面修改后拒绝旧提案。
8. 使用另一账号、另一仓、错误租约均无法读取或修改原私有提案和事实草稿。

本地自动化使用真实 Bridge/Semantica 路由及隔离 SQLite，模型响应为合成数据；真实 LLM 和 Starlink 页面联调需部署后单独验收。
