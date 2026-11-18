# 星图 API

在星图选择目标数据仓，在「接口开放」创建该仓的访问 Key。万象应用通过 Electron 主进程的 `HostClient.request` 调用 `/api/semantica/open/v1` 下的接口，并在 `X-Xingtu-Key` 请求头传入 Key。Host 会话确定当前账号和盒子连接，Key 确定数据仓和读取权限。

以下示例可在 Electron 主进程的 ESM 模块（`.mjs`）中使用。

```js
import {fromEnvironment} from '@centaurai/wanx-host-sdk';

async function searchStarlink(host, warehouseKey, query) {
  const response = await host.request('/api/semantica/open/v1/search', {
    method: 'POST',
    headers: {'X-Xingtu-Key': warehouseKey},
    body: {query, limit: 5},
    timeoutMs: 95_000,
  });
  if (!response.ok) throw new Error(`星图检索失败（HTTP ${response.status}）`);
  return (await response.json()).items;
}

const host = fromEnvironment();
if (!host) throw new Error('请从万象打开应用');
await host.context();
// 调用 searchStarlink(host, warehouseKey, query)，其中 warehouseKey 由用户提供。
```

| 方法 | 路径（相对 Host API 基础路径） | 参数与返回 | Key 权限 |
| --- | --- | --- | --- |
| GET | `/warehouse` | 返回 Key 对应的数据仓概况。 | `documents` |
| GET | `/documents` | `limit` 为 1–200，`offset` 从 0 开始。返回材料元信息。 | `documents` |
| GET | `/graph` | `limit` 为 1–500，可选 `entity_id`。返回 `nodes`、`edges` 和关系来源 `evidence`。 | `graph` |
| POST | `/search` | JSON 正文的 `query` 为 1–2000 字符，`limit` 为 1–50，可选 `document_ids`、`entity_types`。`items` 提供 `text`、`document_id`、`document_version_id`、`locator`、`channels` 等引用信息。 | `search` |
| GET | `/evidence/{id}` | 根据星图返回的证据 ID 读取摘录和定位信息。ID 为 1–128 位字母、数字、下划线或连字符。 | `evidence` |

可用字段和参数的机器可读入口见 [星图 OpenAPI](octop-modules/starlink.openapi.json)。返回内容受星图的数据保护与交付规则约束。尚未完成检测的片段可能暂缓交付。

独立 HTTP 集成使用星图「接口开放」展示的实际服务地址，路径前缀为 `/api/open/v1`，请求头为 `Authorization: Bearer <仓库 Key>`。星图服务随版本提供完整网页文档 `/api/open/v1/docs` 和 OpenAPI `/api/open/v1/openapi.json`。若服务地址指向盒子回环地址，从该盒子访问或使用 WANX Host。

## 推理资料

使用带有 `reasoning` 权限的仓库 Key。所有操作使用 `POST /reasoning/{operation}` 和 `{"arguments": {...}}` 正文。

| 操作 | 常用 arguments 字段 | 用途 |
| --- | --- | --- |
| `discover` | `query`、`limit` | 查找方法 |
| `prepare` | `skill_id`、`idempotency_key`、`document_ids`、`detect`、`delivery_mode` | 固定方法与材料版本 |
| `reference` | `preparation_id`、`skill_id`、`reference_id`、`detect`、`delivery_mode` | 读取方法引用 |
| `scope` | `preparation_id` | 查看固定范围 |
| `search` | `preparation_id`、`query`、`limit` | 在固定范围内检索 |
| `evidence` | `preparation_id`、`evidence_id` | 读取证据 |
| `read-document` | `preparation_id`、`document_id`、`detect` | 分页读取材料正文 |
| `coverage` | `preparation_id` | 查看覆盖情况 |

例如，调用 `prepare` 时可传入以下正文，将示例 ID 替换为本仓返回的值。同一准备请求重试时复用 `idempotency_key`。

```json
{
  "arguments": {
    "skill_id": "skill-id",
    "idempotency_key": "same-key-for-the-same-request",
    "document_ids": ["document-id"],
    "detect": false,
    "delivery_mode": "masked"
  }
}
```

后续读取携带返回的 `preparation_id`。方法、材料或权限变化后重新准备。开启 `detect` 可触发当前对象的检测，仓库已确认的在线检测模型可能处理未经脱敏的文本并产生用量。各操作的完整字段和响应以所连接星图版本的 OpenAPI 为准。

长时间运行的检索或推理资料请求可通过 `timeoutMs` 设置等待响应头的时限，并通过 `signal` 取消应用侧等待。

## 错误与会话

仓库 Key 可到期或撤销，由星图逐次验证。Host 调用遇到 HTTP 403 时检查 Key 的状态、授权和数据仓。独立 HTTP 遇到 401 时检查 Key 是否有效。409 表示内容变化或尚未就绪，刷新材料状态后再决定是否重试。422 表示输入或参数不符合该接口要求，先修正请求。Host 会话结束时停止本次应用访问，并清理本次会话的星图结果。将 Key 保留在可信主进程或服务端，避免写入 URL、日志或 renderer。
