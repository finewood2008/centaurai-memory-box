# Starlink 本体管理 Copilot 接口对接

版本：2026-11-08。交付范围为 Semantica 后端与 WANX Bridge，未修改 Starlink、Semantica Web 或 Octop。默认可用，复用现有本体模型配置和账号管理鉴权。

2026-11-09 Review：修复输出预算6144与底层上限4096不一致，现统一最多4096。轮次响应新增可选 `context_budget`，包含 context_tokens、input_tokens、schema_tokens、reserve_tokens、min_output_tokens、max_output_tokens、available_output_tokens、required_context_tokens、output_token_budget。剩余输出不足1536时失败并保留草稿，不调用模型。当前消息接口不支持前端传入 token 配置；Semantica 的 llm_context_tokens 需要通过既有管理员模型设置调整，模型切换不会自动改写它。配置调整后以新 operation_id 重试，原操作继续恢复原回执。Starlink 不应把 max_tokens 当作上下文长度。

## 1. 页面流程与边界

读取生效本体 → 创建 change 会话 → 绑定生效版本或导入已有本体草稿 → 对话／手工调整同一份私有草稿 → 查看类型差异和材料影响 → 明确确认 → 仅发布规则，或发布后处理选定材料。

“实体”指实体类型，不是具体知识实例。本功能不需要上传材料，不改仓库用途或用户背景。新增、删除、改显示名称／定义、修改标识、调整关系端点、合并实体类型及增删改属性由后端生成增量操作并统一校验；不会重写未涉及的定义。属性遵循项目已有能力：标识、显示名、定义、是否必填；没有新增数据类型系统。

绑定已有 ontology_draft_id 时，将它复制为本会话的私有工作草稿，并持续校验来源指纹；不会原地修改或发布来源草稿。手工编辑必须调用本节 draft 接口，与对话使用同一份工作草稿。若其他入口改动或发布来源草稿，本会话变为 stale，需从最新状态新建会话。发布成功后生成新的生效版本；原来源草稿保留。本体未变化时复用现有生效版本。

## 2. Bridge 路径

```text
W = /api/semantica/warehouses/{warehouse_id}
C = W/workbench/conversations/{conversation_id}
E = C/ontology-edit
```

通过 WANX Host/Service 调用，不从 Renderer 直接访问 Semantica。warehouse_id 使用仓列表回执的仓标识，不能自行注入账号、workspace_id 或权限。当前 Bridge 的个人仓访问边界保持原样。

创建会话：POST `W/workbench/conversations`：

```json
{"operation_id":"create-edit-01","_native_operation_id":"create-edit-01","scenario":"change"}
```

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | E | 读取绑定状态、最新草稿、生成中轮次、发布执行号和历史 |
| POST | E/initialize | 绑定生效本体和可选来源草稿 |
| POST | E/draft | 保存手工编辑到同一份工作草稿 |
| POST | E/turns | 根据修改要求与选中对象生成增量变更并保存私有草稿 |
| GET | E/turns/{turn_id} | 恢复原轮次，不重新调用模型 |
| POST | E/preview | 持久化绑定草稿版本的影响预览 |
| POST | E/execute | 明确确认后发布，并按选定模式处理材料 |

以上 7 条路由已有限注册到 Bridge OpenAPI；没有任意路径代理。所有 POST 要求 operation_id 与 _native_operation_id 相同，为 1–120 位 ASCII 字母、数字、下划线或短横线。无需 _native_editor。生成接口超时预算 285 秒，其余 45 秒；模型生成业务截止时间不超过现有配置与 240 秒。

Semantica 对应路径为 `/api/conversations/{conversation_id}/ontology-edit...`，工作台签名适配器为 `/api/integration/workbench/conversations/{conversation_id}/ontology-edit...`。前端只使用 Bridge 路径。

## 3. 初始化与恢复

GET E 首次返回 initialized=false、status=uninitialized、current_ontology_id。随后 POST E/initialize：

```json
{
  "operation_id":"bind-edit-01",
  "_native_operation_id":"bind-edit-01",
  "base_ontology_id":"<current_ontology_id>",
  "ontology_draft_id":null,
  "name":"合同管理规则"
}
```

ontology_draft_id 可省略；仅接受当前仓未发布的本体版本草稿，不接收材料事实草稿 ID 或建仓建议预览 ID。需要衔接这些页面时，应先完成各自流程或明确转为本体版本草稿，不混用标识。

成功后初始 draft.revision=0；GET E 读取最新状态。初始化只能绑定一次，同操作号原请求可恢复；不要通过重复初始化覆盖当前草稿。

| 字段 | 含义 |
|---|---|
| status | uninitialized / editing / stale / published |
| draft | revision、name、schema、questions、changes |
| draft_digest | 当前工作草稿摘要，后续写入与预览原样回传 |
| base_ontology_id / source_draft_id | 绑定的生效规则与来源草稿 |
| active_turn_id | 当前生成轮次，没有则为 null |
| can_preview | 当前是否可生成影响预览，不等于授权发布 |
| history | 私有草稿修改历史，倒序，包含手工保存和对话轮次 |
| execution_id | 已确认发布的执行号，可查询材料入队及重试结果 |
| publication / publication_effective | 历史发布回执及其本体是否仍生效 |

GET E 支持 offset=0、limit=20（最多 50）。历史 is_current=false 或与最新版本不同的响应不能覆盖当前页面。change 会话使用这些独立接口，普通 messages 和材料 intents 不可用于此场景；建仓 onboarding 与材料 material 的专用流程继续独立运行。

## 4. 对话和选中对象

POST E/turns：

```json
{
  "operation_id":"edit-turn-01",
  "_native_operation_id":"edit-turn-01",
  "expected_revision":0,
  "draft_digest":"<GET E 返回值>",
  "instruction":"把所选实体类型改称当事人，增加一个选填的角色属性",
  "selected":[{"kind":"entity","type_kind":"entity","type_name":"PERSON"}]
}
```

selected 最多 20 项，可省略。类型选择：kind 与 type_kind 同为 entity 或 relation；属性选择：kind=property，type_kind 指明归属类型，另传 property_name。type_name、property_name 是标识，不是显示名。选择不存在、重复或不属于本草稿的对象会在模型调用前拒绝。用户说“这个”时前端应带当前选中项，不能由前端猜名字。

每轮最多 8000 字，模型最多返回 20 个操作。完整草稿遵循现有上限：100 个实体类型、200 个关系类型、每类型 50 个属性；不沿用建仓对话的 16/16/8 限制。模型上下文或请求体（现有 128 KiB）不足时明确报错，不静默裁剪定义。输出截断、非法 JSON、非法操作或关系依赖不完整时原草稿保留。

| 轮次 status | 页面行为 |
|---|---|
| generating | 显示等待，可通过 active_turn_id 恢复原轮次 |
| succeeded | 展示 answer、questions、operations 和完整 draft；更新图谱及 changes |
| failed | 显示 error_code/message，保留上版草稿；用户选择重试时用新操作号 |
| stale | 草稿或基线变化，结果未应用；读取最新状态 |

存在澄清问题时 operations 必须为空，不会部分执行复杂要求；该轮仍会保存问题并推进草稿版本。后续回答继续发送 turns。所有成功轮次只更新私有草稿，publication_performed=false、extraction_started=false。

changes 为类型级 before/after，属性变化位于对应类型中；删除项 after=null。前端用完整 draft.schema 更新当前图谱，用 changes 高亮差异。关系引用在整组变更完成后统一校验，删除实体类型不会自动级联删除关系。

## 5. 手工编辑与并发

POST E/draft：

```json
{
  "operation_id":"manual-save-01",
  "_native_operation_id":"manual-save-01",
  "expected_revision":1,
  "draft_digest":"<最新 GET E 返回值>",
  "name":"合同管理规则",
  "schema":{"entity_types":[{"name":"CONTRACT","label":"合同","properties":[]}],"relation_types":[]}
}
```

schema 是用户确认保存的完整定义，不是差量；示例不可原样覆盖真实草稿。服务端严格检查未知字段、名称、属性及引用，不静默丢弃字段。

手工保存与对话提交使用相同 revision/digest。生成中允许手工保存，保存成功会立即将旧生成轮次标为 stale、解除其预览阻塞；迟到的模型结果不会覆盖新草稿。前端收到旧请求返回时应再次核对 is_current/current_revision，不能恢复旧图谱。并行模型生成会返回 BUSY。

手工保存回执同样返回 is_current、current_revision、current_draft_digest。旧保存请求的幂等恢复仍保留原 draft，但会标明 is_current=false，并返回最新版本号；此时应 GET E，不将历史回执覆盖到当前页面。

## 6. 影响预览、发布与重新抽取

POST E/preview：

```json
{
  "operation_id":"edit-preview-01",
  "_native_operation_id":"edit-preview-01",
  "expected_revision":2,
  "draft_digest":"<最新 GET E 返回值>",
  "document_ids":null,
  "offset":0,
  "limit":20
}
```

返回 resource_id、preview_digest、draft 和 impact。impact 复用现有类型差异、材料影响确定性、人工修订保护和活动任务提示。document_ids=null 时按材料分页分析；最多指定 20 份材料，指定时 offset 必须为 0。若要处理所选材料，必须针对明确的 document_ids 重新预览，不能用一页展示结果隐式代表整个仓。

用户核对后 POST E/execute：

```json
{
  "operation_id":"confirm-edit-01",
  "_native_operation_id":"confirm-edit-01",
  "preview_id":"<预览 resource_id>",
  "preview_digest":"<预览 preview_digest>",
  "confirmed":true,
  "mode":"publish_only"
}
```

mode：publish_only 仅发布规则；current 发布并处理预览中明确选择的一份材料；selected 发布并处理预览中明确选择的 1–20 份材料。发布前会在事务中复核草稿版本、来源、本体基线及材料影响令牌。预览后手工编辑或继续对话会阻止旧预览发布。取消确认不会发布。

此接口复用现有 rule-executions 回执：resource_id 为执行号，publication 为实际生效版本，items 为逐材料状态。发布与执行记录先持久化，再提交材料任务；部分提交失败不会重复发布。completed 表示规则发布／任务提交阶段完成，不代表选中材料已完成抽取或知识发布；继续查看 items 中 job_status、knowledge_status。

恢复与重试复用已经注册的接口：

- GET `W/modeling/rule-executions/{execution_id}`：读取发布与逐材料执行状态。
- POST `W/modeling/rule-executions/{execution_id}/retry`：明确确认重试失败的材料提交，沿用该接口已有 Operation 请求结构（operation_id、confirmed，不增加 _native_operation_id）。

本体发布不更改本仓用途、建仓回答或用户背景。已有人工核对结果保持保护，新抽取结果进入既有候选核对流程，不自动覆盖事实。

## 7. 幂等、权限和验收

响应丢失：原操作号、原请求体恢复；不能先读取新版本再拼接旧操作号。明确 failed 后用户重试使用新操作号。execute 重放恢复同一执行，不重复生成版本或提交同一任务。所有读取和重放先校验实际账号、当前仓及会话归属。

业务错误：MODELING_ONTOLOGY_EDIT_STALE、MODELING_ONTOLOGY_EDIT_BUSY、MODELING_ONTOLOGY_EDIT_TIMEOUT、MODELING_ONTOLOGY_EDIT_INVALID_OUTPUT、MODELING_ONTOLOGY_EDIT_MODEL_FAILED、MODELING_CONTEXT_BUDGET，以及既有影响预览、操作冲突、材料忙与确认错误码。HTTP 200 后仍需检查业务 status。

前端验收：无材料对话改类型／属性／关系；已有草稿导入；手工与对话交替编辑；合并和删除依赖；超过 16 个类型仍可编辑；模型失败和刷新恢复；手工保存不被迟到响应覆盖；旧预览不能发布；仅发布不启动抽取；选定材料不扩大范围、不重复提交；切仓切账号拒绝旧响应。

部署需要更新并重启 Semantica 和 WANX Bridge。自动化验证使用隔离数据库与合成模型回包；真实 LLM 指令理解质量及 Starlink 页面交互需联调验收。
