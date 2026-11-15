# STARLINK 对话整理和知识核对接口对接

> 2026-11-07：已补充4个单页对话修正接口，支持结构化提案、差异、原子应用及恢复。见 [Starlink 单页材料对话与修正接口对接](semantica-conversation-changes-api.md)。下文普通 messages 的修改意图能力保持兼容；新能力通过 change-proposals 调用，不代表一句聊天自动发布。

本文供 STARLINK 前端与桌面 Service 开发使用，接续 [个人知识仓初始化](semantica-onboarding-api.md)。本次在现有 Bridge 桌面入口增加 29 个方法／路径，复用已经注册的分块上传、本体编辑、原文读取和材料核对接口。WANX 代码改动限定在 `wanx_bridge/semantica`，不涉及 Octop。

## 页面范围和实现边界

| Figma 节点 | 页面 | 接口职责 |
|---|---|---|
| [10:4516](https://www.figma.com/design/CkOk7woZtUu2IqMmjJqhaj/Untitled?node-id=10-4516) | 对话整理材料 | 上传及原子绑定、初读、追问、目标确认、恢复会话、展示初始化建议 |
| [10:4752](https://www.figma.com/design/CkOk7woZtUu2IqMmjJqhaj/Untitled?node-id=10-4752) | 核对本体 | 采纳／复用／忽略初始化建议、保存完整规则、差异、发布及所选材料影响预览 |
| [10:5062](https://www.figma.com/design/CkOk7woZtUu2IqMmjJqhaj/Untitled?node-id=10-5062) | 核对材料知识 | 确认抽取计划、查看候选、合入私有草稿、修改及核对来源、明确发布 |

本次仍使用**个人仓**，页面不能显示“工作空间成员可见”作为实际权限。团队接入、跨端逐项审核状态同步，以及纯聊天自动修改规则／事实，不在本次注册中实现。

聊天回复包含建议和修改意图；后端不会根据一句聊天自动保存类型、修改事实或发布。设计稿中“已合并为当事人”“已修改截止时间”等完成态，必须在实际保存接口成功后展示。当前 Agent 没有返回可直接应用的结构化 schema patch 或实体 patch；STARLINK 应打开相应编辑器让用户核对具体内容。如要求完全复现自动生成修改草稿的交互，仍需补充后端能力。

材料草稿目前保存完整事实集合和校验信息，**没有独立持久化的逐条 `pending/confirmed/excluded` 审核状态**。`validation.unreviewed` 是未复核的语义提示数量，不是用户尚未点过“确认”的条目数。当前发布接口会发布完整核对草稿，不会按前端“已确认 6 项”自动过滤。不能只传一个前端计数就执行发布；需要用户核对完整草稿、显式排除不应发布的内容后再提交。不得把保留中的已有知识当作未确认新候选批量删除。若必须保留待核对项、只发布已确认项且跨端恢复，应先补齐对应后端语义。

## 调用入口

沿用 `Renderer → window.semantica.call(action,input) → preload/main/SemanticaService → Host SDK → Bridge`。本次未修改 STARLINK 源码，下面建议的 action 名需要由 STARLINK 实现映射，不能视为已经存在的 SDK 方法。

文中的简写：

| 简写 | 完整 Bridge 路径 |
|---|---|
| W | `/api/semantica/warehouses/{warehouse_id}` |
| B | `W/workbench` |
| C | `B/conversations/{conversation_id}` |
| I | `C/intents/{intent_id}` |
| T | `C/turns/{turn_id}` |
| M | `W/modeling` |
| D | `B/documents/{document_id}/corrections` |

`warehouse_id` 取仓列表 `items[].id` 或建仓回执 `resource_id`，不能用 `workspace_id` 代替。Bridge 从当前登录用户派生 workspace，Semantica 再检查仓、会话和材料归属。请求中不要传 actor、workspace、permissions 等身份或范围字段，包括嵌套字段。团队上下文调用新增入口返回 `403 MODELING_HOST_CREATION_REQUIRED`。

新增接口使用现有 Bridge 会话、`knowledge_bases` 权限和租约校验，返回 `Cache-Control: no-store`，不接受 Origin。请求体最多 128 KiB，POST 为 JSON；同步请求预算通常 45 秒，对话和抽取以 202 接受后轮询业务状态。初始化建议生成继续使用原 285 秒预算。不要在 Renderer 直接请求 Semantica、`/native/*` 或响应里的 `original_url/preview_url`。

当前注册适用于现有桌面会话适配通道。`local-data-gate=required` 的独立白名单和个人仓身份映射尚未扩展，不应宣称本次已覆盖该通道或通过关闭网关来替代接入。

`window.semantica.call` 按现有约定返回已解包业务对象；不要再次访问 `.data/.value`。错误使用 `.code/.publicMessage`。切换账号、Box、知识仓或收到 `HOST_SESSION_EXPIRED` 后，停止轮询、清空私有数据和编辑租约；通过请求 generation 丢弃迟到结果。

## 新增接口清单

参数模型、返回模型、成功状态码和安全错误结构同时在 Bridge `/openapi.json` 中显式注册。返回模型允许服务端增加字段，Bridge 不裁剪业务结果；动态本体和实体 payload 的内容依赖当前仓定义。表中 `R` 为 `{operation_id, _native_operation_id, expected_revision}`，两个 operation 值必须相同；`O` 为其中不含 revision 的两个 operation 字段。操作号是 1–120 位 ASCII 字母、数字、下划线或短横线。

| 方法和路径 | 请求或查询 | 主要返回与用途 |
|---|---|---|
| POST `B/conversations` | O，`scenario:"material"` 可省略 | 201；`resource_id,revision,conversation` |
| GET `B/conversations` | `offset=0,limit=20`，limit≤50 | `items,has_more,next_offset`，恢复历史会话 |
| GET C | `intent_offset=0` | `id,revision,input_generation,source_stamp,latest_turn,intents,limits` |
| GET `C/messages` | `after_sequence=0,limit=50`，limit≤100 | `items,has_more,next_sequence`，增量消息 |
| POST `C/messages` | R，`content` 1–8000 字符 | 202；`turn_id,status,revision,reused` |
| GET `C/turns` | offset、limit≤50 | 历史轮次分页，供重连恢复 |
| GET T | 无 | `status,is_current,input_generation,content_status,reply,error_code` |
| POST `T/cancel` | R | 取消回执 |
| POST `T/retry` | R | 202；新 `turn_id`，按新 ID 轮询 |
| GET `C/intents` | offset、limit≤50 | 附件意图及逐材料状态分页 |
| POST `C/intents` | R，`document_id` 可选 | 201；预留上传位置，或关联仓内已有文档 |
| GET I | 无 | `id,revision,status,document_id,document_version_id,goal,execution,review,outcome` 等 |
| POST `I/analyze` | O，`document_version_id` | 202；初读 `turn_id`，不会抽取／发布 |
| POST `I/goal` | R，`expected_conversation_revision,goal,instructions?,confirmed` | 保存目标，`execution_available` 仍需计划确认 |
| POST `I/cancel` | R | 取消本次处理意图，不删除原文 |
| GET `I/plan` | 无 | `revision,conversation_revision,document_version_id,ontology_id,goal,processing,plan_digest,publication_policy` |
| POST `I/confirm` | R，`expected_conversation_revision,plan_digest,confirmed` | 202；`execution_id,job_id,reused` |
| GET `I/candidates` | offset、limit≤50 | `items,total` 等；私有抽取候选 |
| POST `I/retry` | R | 202；重试失败抽取，仍需当前版本有效 |
| POST `I/review-plan` | body：`_native_operation_id,_native_editor`；query：`draft_id?`,offset、limit≤50 | 只读合并预览；`plan_digest,draft_id,draft_revision,counts,decisions,total,removed_count` |
| POST `I/review` | R，`_native_editor,plan_digest,draft_id?,confirmed,deferred_policy?` | 合入未发布草稿；`draft_id,draft_revision,lease_generation,lease_expires_at`；继续使用原 editor_session |
| GET `M/answer-suggestions/{suggestion_id}/rules` | 无 | `proposal,base_ontology,draft,publication`，恢复初始化规则核对 |
| POST `M/rule-previews` | `operation_id,proposal_id,expected_draft_id?,name,schema,decisions` | `resource_id,schema,base_schema,schema_digest,changes,publish_operation_id` |
| POST `M/rule-previews/{preview_id}/publish` | `operation_id,schema_digest,confirmed` | `ontology_id,version_number,status,changed`；仅发布规则 |
| POST `M/impact-preview` | `base_ontology_id,schema?,ontology_draft_id?,rule_draft_id?,document_ids?,offset?,limit?` | 只读；`preview_token,items,counts,changes,target` |
| POST `M/impact-preview/validate` | 上项加 `preview_token` | 验证规则、材料、发布基线未变化 |
| POST `M/rule-executions` | `operation_id,confirmed,mode,name,preview` | `resource_id,publication,items,status`；发布规则并按选择提交任务 |
| GET `M/rule-executions/{execution_id}` | 无 | 恢复发布与逐材料提交状态 |
| POST `M/rule-executions/{execution_id}/retry` | `operation_id,confirmed` | 重试可重试的失败提交，不再发布一版本规则 |

分页 offset 上限 `9007199254740991`。额外查询参数、重复参数、负值或越界 limit 会被拒绝。`I/review-plan` 特意使用 POST 携带编辑租约；Bridge 不注册该路径 GET，也不接受调用方传任意目标 path 或 HTTP 方法覆盖。

修订号不能互换：创建意图、发送消息、取消／重试问答使用 C.revision；目标确认、取消／重试抽取、合并候选使用 I.revision；保存材料核对草稿使用 draft_revision。目标确认和抽取确认还需独立传 expected_conversation_revision。创建意图回执的 revision 是新意图修订，conversation_revision 才是会话修订；不要把所有操作回执都写入同一个 revision 状态。问答取消／重试不一定增加会话 revision，异步完成后重新读取 C/I。

`M/*` 的写操作只有 `operation_id`，不能带 `_native_operation_id`。两个 impact 接口是只读 POST，不含 operation 字段。`schema` 使用现有 `entity_types/relation_types` 完整定义格式；属性名、关系端点和定义由 Semantica 验证。`rule-previews` 的 `decisions` 最多 12 项，必须覆盖本批建议，每项为：

```json
{"suggestion_id":"suggestion-id","action":"add","target_name":"PARTY","owner_kind":"","owner_name":""}
```

`action` 是 `add/reuse/ignore`；属性建议需填写 `owner_kind:entity|relation`、`owner_name` 与属性 `target_name`。`name` 最长 120 字符，`expected_draft_id` 必须来自最近一次读取，不可覆盖另一页面更新。

## 上传并反复对话

1. 进入页先恢复仓级初始化建议和会话列表。`suggestion-context` 中有效 proposal 对应右侧初始本体建议；由用户回答生成，不能标成文件抽取结果。没有会话时创建一个，不要每次刷新都创建。
2. 用户选文件后，先 POST `C/intents`，使用当前**会话 revision**。取得 `resource_id` 作为 intent_id、读取意图 revision，再使用已有分块上传接口传绑定信息。
3. 完成上传后轮询 GET I 或文档解析任务。`parsing` 变为 `awaiting_goal` 且有 `document_version_id` 后，POST `I/analyze`，然后轮询 T。初读只取有界片段，展示返回 `coverage`；“解析完成”“初步阅读”“抽取完成”“已发布”分开显示。
4. 每次发送消息读取当前 C 的 revision，POST `C/messages`。202 表示已记录该操作，返回 status 也可能已经是 failed（例如模型不可用或上下文超限），此时按 error_code 引导修正，不显示持续生成。仅 queued/running 需要持续轮询 T；初读返回 existing=true 时也按返回的 turn_id/status 恢复。只把 `status=succeeded && is_current=true && content_status=available` 且 generation 与当前会话一致的 reply 当作当前建议。
5. 回复的 `questions` 最多两个、`goal_summary` 是建议。即使 `ready_for_confirmation=true` 也不能自动执行抽取。`modification_intent` 分 entity、type、processing_scope、ambiguous；据此引导对应核对页，不把用户描述当已解析出的实体 ID。
6. 关联已有材料用 `POST C/intents` 携带 document_id，不重复上传。每份材料独立确认目标；最多附件数等限制取 C.limits。当前实现每会话最多 5 份附件、每条消息 8000 个 Unicode 字符、每轮最多 3 次模型请求。执行时限取 limits.timeout_seconds（默认 180 秒），不要在前端硬编码。JavaScript 字符数用 Array.from(text).length，不能用 UTF-16 字符单元数代替。

消息列表中的 user.content 是普通文本，assistant.content 是 **JSON 编码的字符串**，需解析后渲染 answer/questions 等字段；T.reply 已是对象，不要再次 JSON.parse。assistant 的 content_status 非 available 时展示服务端提供的来源失效说明，不继续使用先前缓存内容。完成消息分页后保留 next_sequence 继续增量读取；切仓或来源变化时重新读取会话快照，不能仅追加旧缓存。

已有上传接口不新增别名，全部位于 W 下：

```jsonc
// POST W/imports，完整文件 SHA-256，size_bytes 为原始字节数
{
  "operation_id":"upload-001","filename":"采购合同.docx",
  "external_document_id":"client-document-001","size_bytes":4957304,
  "sha256":"<64位小写十六进制>",
  "conversation_id":"<conversation>","intent_id":"<intent>",
  "expected_intent_revision":1
}
```

响应为 `upload_handle,offset,expires_at,chunk_max_bytes`。每块原始内容不超过 1 MiB：

```jsonc
// PATCH W/imports/{upload_handle}
{"operation_id":"upload-001","offset":0,"content_base64":"<当前块base64>"}
// POST W/imports/{upload_handle}/commit
{"operation_id":"upload-001"}
```

begin、分块、commit 全程使用同一业务 operation_id。重试同块必须相同 offset 和字节，begin 可恢复服务端 offset；按 expires_at 处理暂存过期。commit 当前返回 HTTP 200 和 `{document,job,reused}`，不一定包含 modeling_intent，随后 GET I 确认绑定。文档与意图绑定在 Semantica 同一事务中；禁止先走普通上传再猜测绑定。任务的 HTTP 成功只表示接收，不表示解析已完成。

## 核对并发布本体

初始化建议通过 `GET M/answer-suggestions/{id}/rules` 恢复。前端维护用户核对后的完整 schema 和逐建议 decisions；“保存草稿”调用 `M/rule-previews`，随后从回执 changes/base_schema/schema 展示差异。规则仍为草稿时，当前生效本体不会刷新成草稿。

仅发布规则时，用户确认后 POST `M/rule-previews/{resource_id}/publish`，operation_id 优先使用回执的 publish_operation_id。成功后重读已有 `GET B/ontologies`；依据实际 published 条目显示版本，不在前端固定写“版本 0/1”。

对话中的后续规则修改，使用已有完整规则编辑器和 `B/ontologies` 保存常规草稿，或传完整 schema 做影响预览。初始建议 decisions 只记录初始化 proposal 的建议，不能把普通聊天内容伪造为该 proposal 的 suggestion_id。

“发布后重新抽取所选材料”应先调用 `M/impact-preview`，明确 document_ids（1–20 个）和目标 schema／草稿，再 validate。点击确认后，将同一个完整 preview（含 preview_token）提交 rule-executions，mode 为 `publish_only/current/selected`，其中 current 只允许一个文档。前端保存 execution_id 并轮询回执；`publication.is_current` 和各项 status 分别展示。仅有 `status=completed` 表示所选提交已完成，不代表任务已执行或知识已发布。

**对话上传的材料仍有目标确认边界**。rule-executions 可能返回 `status=partial`、材料 `status=awaiting_goal`：规则已发布，但尚未提交该材料抽取。此时回到会话确认目标和计划，不得自动重试绕过。如果页面要先发布规则再用已整理目标抽取，发布后重新读取 I 和 C、确认当前目标、重新获取计划；旧 plan_digest 已失效。

## 抽取和核对材料知识

用户明确目标后：

```jsonc
// POST I/goal，expected_revision 为意图修订，另一项为会话修订
{"operation_id":"goal-001","_native_operation_id":"goal-001",
 "expected_revision":3,"expected_conversation_revision":5,
 "goal":"核对合同付款条件与违约责任","instructions":"不关注签署地点","confirmed":true}
```

GET `I/plan` 展示本次材料版本、目标、本体版本和模型；用户确认后按该回执提交：

```jsonc
// POST I/confirm
{"operation_id":"extract-001","_native_operation_id":"extract-001",
 "expected_revision":4,"expected_conversation_revision":6,
 "plan_digest":"<计划的64位摘要>","confirmed":true}
```

轮询 I 中 execution/status，完成状态为 `awaiting_review`，GET candidates 展示候选。抽取结束不会发布知识。正文、目标、本体或模型改变时旧计划不能继续用，重新读取、预览和确认。

进入材料核对前需取得文档编辑租约：

```jsonc
// 已有 POST D/sessions
{"operation_id":"editor-001","_native_operation_id":"editor-001"}
// 新增 POST I/review-plan?offset=0&limit=20
{"_native_operation_id":"merge-preview-001",
 "_native_editor":{"session":"<sessions返回的editor_session>","generation":"1"}}
```

首次建立草稿时 generation 字符串为 `"1"`；恢复已有草稿先通过已有 leases/claim 流程取得新的 lease_generation。`_native_editor` 放 JSON 中，不放在 URL 或自定义浏览器头中。

合并计划的 `counts.add/reuse/defer` 分别展示；`removed_count` 必须为 0。翻页 plan_digest 发生变化应回第一页重读。存在 defer 时让用户明确“保留已有内容、冲突候选暂不合入”，才传 deferred_policy：

```jsonc
// POST I/review，draft_id 使用预览值，首次可能为 null
{"operation_id":"merge-001","_native_operation_id":"merge-001",
 "expected_revision":5,"draft_id":null,"plan_digest":"<合并计划摘要>",
 "confirmed":true,"deferred_policy":"keep_existing",
 "_native_editor":{"session":"<editor_session>","generation":"1"}}
```

合并回执返回 draft_id、draft_revision、lease_generation 和 lease_expires_at，**不返回 editor_session**。继续保留此前 D/sessions 得到的 session，仅更新 generation（传输时转为字符串）和过期时间；若用不存在的回执字段覆盖 session，后续保存会因租约无效失败。下列接口已注册，本次不改动其含义：

| 页面操作 | 复用接口 |
|---|---|
| 读取完整规则／草稿列表 | GET `B/ontologies` |
| 新建常规本体草稿／发布 | POST `B/ontologies`、POST `B/ontologies/{id}/publish` |
| 材料及解析进度 | GET `W/documents/{id}`、GET `W/jobs/{id}` |
| 原文块／文本／原件 | GET `W/documents/{id}`、`/text`、`/blob`，使用已有分页与版本校验参数 |
| 编辑会话与恢复 | POST `D/sessions`、GET `D/leases`、POST `D/{draft}/claim` |
| 草稿／条目／关联关系／来源／发布预览 | POST `B/_correction_read`，固定读封装见下例 |
| 修改属性、实体类型、来源，或排除条目 | POST `D/{draft}/save`，`upserts/remove_ids`，携带 revision 和 editor |
| 保持或释放租约 | POST `D/{draft}/heartbeat`、`/release` |
| 明确发布完整草稿 | POST `D/{draft}/submit`，随后读取 publication 和 job |
| 发布失败恢复 | POST `D/{draft}/publication/retry`，依据服务端状态提供重试 |

需要租约的 GET 读取复用固定封装，query 值均为字符串，path 只能是已允许的核对读接口：

```jsonc
// POST B/_correction_read
{"_native_operation_id":"read-items-001",
 "_native_editor":{"session":"<editor_session>","generation":"<lease_generation>"},
 "path":"/api/documents/<document_id>/corrections/<draft_id>/items",
 "query":{"revision":"<draft_revision>","offset":"0","limit":"20"}}
```

单项修改先读取 item，保留其 ID、kind、payload 与服务端证据结构，再提交完整 upsert；不能让 LLM 编造 evidence.excerpt/页码。`source` 返回定位信息可用于原文栏；实际能否分页预览取决于解析结果与已有原文接口，不能把截图中的 PDF 页数写死。已选择条目的聊天应携带可读名称与上下文，但当前对话协议没有选中 item_id 的绑定字段，应在编辑器核对真实对象后保存。

`save` 只保存草稿。发布前使用 `preview` 检查 `ready_for_confirmation`、约束错误及语义提示，让用户核对完整发布内容，再 POST submit。submit 返回 `status=submitted,job_id` 仍不是成功发布；等待 publication/job 明确成功后展示完成。材料发布与本体发布是两个独立步骤。

## STARLINK Service 映射建议

| 建议 action | 输入及映射 |
|---|---|
| conversation-list / conversation-create / conversation-get | warehouseId，分页或 operationId，映射 B/conversations 与 C |
| conversation-messages / conversation-send | conversationId、游标，或 revision、content、operationId |
| conversation-turn / conversation-turns / conversation-turn-cancel / conversation-turn-retry | turnId、分页或 revision |
| conversation-intents / conversation-intent-create / conversation-intent | intentId、documentId 可选、revision |
| conversation-analyze / conversation-goal / conversation-plan / conversation-confirm | 当前文档版本、目标、两个 revision、planDigest 等 |
| conversation-cancel / conversation-retry / conversation-candidates | 当前 intentId、revision 或分页 |
| conversation-review-plan / conversation-review | editor 的 session/generation、draftId、planDigest、revision |
| modeling-rules / modeling-rule-save / modeling-rule-publish | suggestionId、完整 schema/decisions、draftId、schemaDigest |
| modeling-impact / modeling-impact-validate | baseOntologyId、目标 schema／草稿、documentIds、previewToken |
| modeling-rule-execute / modeling-rule-execution / modeling-rule-retry | mode、preview、executionId、operationId |

Service 将 camelCase 转为上表 snake_case，自动令 `_native_operation_id=operation_id`（仅 C/I/T 的业务写），保持用户提交请求的原始字段和稳定操作号。上传继续复用已有文件选择和分块传输 Service，但必须增加 conversationId、intentId、expectedIntentRevision 三个绑定字段；若现有上传 action 丢弃这些字段，不能声称支持对话附件上传。不要将任意 HTTP path 暴露为 Renderer action。

## 并发和恢复

| 场景 | 前端处理 |
|---|---|
| 网络失败或超时，结果未知 | 原路径、原 body、同 operation 重试；先恢复会话／草稿／执行回执，不能自动换号 |
| 新的一次用户修改 | 新 operation，读取新 revision；禁止在旧 operation 下更换字段 |
| MODELING_REVISION_CHANGED / GOAL_CHANGED / PLAN_CHANGED | 刷新 C、I 和计划，重新核对 |
| MODELING_SOURCE_CHANGED / ONTOLOGY_CHANGED / MODEL_CHANGED | 提示版本变化，重新整理并确认 |
| MODELING_TURN_BUSY | 轮询进行中的 turn；用户可取消，不能循环自动发消息 |
| MODELING_CONTEXT_BUDGET | 精简目标／补充说明；会话历史超预算时新建会话，不原样循环重试 |
| LLM_NOT_CONFIGURED / MODEL_UNAVAILABLE / MODEL_AUTH_REQUIRED | 按现有模型配置或授权入口处理，再重新核对计划 |
| MODELING_ATTACHMENT_LIMIT | 展示服务端 limits，引导取消不再使用的意图 |
| MODELING_RULE_DRAFT_CHANGED / RULE_DIGEST_CHANGED / RULE_SOURCE_STALE | 重读规则工作台和当前 proposal，保留本地未保存编辑供用户比较 |
| MODELING_IMPACT_STALE | 重新做影响预览及明确选择，不继续旧 preview_token |
| MODELING_REVIEW_PLAN_CHANGED / REVIEW_BASE_CHANGED | 重取合并预览，重新确认冲突策略 |
| CORRECTION_* 租约或草稿冲突 | 停止写入，按已有 claim/reload 流程恢复，不自动抢占 |
| 404 / MODELING_RESOURCE_NOT_FOUND | 清除不可用资源展示，不回退其他仓 |
| 会话失效或无权限 | 停止轮询并清除私有信息，重新认证 |

新增建模错误只透传经过枚举的 code/status，不透传上游 detail/message。上传沿用原错误分类，可能返回通用 `SEMANTICA_*`；需重读 I/任务获取最新状态。错误映射只能使用安全的固定文案。消息正文、原文、租约不得写入调试日志。

## 开发验收

前端至少验证：从建仓进入当前仓、恢复会话、文件上传响应丢失重试、初读与多轮追问、发布本体后旧计划失效、确认抽取、候选分页、编辑租约恢复、合入草稿不发布、修改与原文定位、显式发布、切仓清理及跨账号不可访问。还需验证上节标明的两个设计差距，不能用静态 UI 完成态代替真实服务状态。

本机接口验收使用真实 Bridge ASGI 路由、Semantica ASGI 服务及隔离 SQLite，模型与图存储为确定性测试适配；覆盖原子上传绑定、完整抽取核对发布、规则草稿与发布、只读影响预览、重试幂等、跨仓和跨账号拒绝。真实万象宿主、真实模型及 STARLINK 页面联调仍待执行。本次无 Octop、SDK 包或生产配置改动。

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
