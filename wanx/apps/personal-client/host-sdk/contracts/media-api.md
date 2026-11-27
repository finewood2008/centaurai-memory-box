# 万象盒端媒体 API v1

面向接入万象盒子的应用研发团队。文件语音转写、图片文字识别、实时字幕和 LLM 总结共用服务 `wanx.media`，业务路径前缀为 `/api/services/wanx.media/v1`。应用通过 App Kit 的桌面 Host SDK 访问当前连接的盒子。默认文件转写、图片文字识别和默认实时字幕在盒内推理。会议录音可为单条录音分别选择云端实时字幕和云端精转，LLM 总结由盒端受理，默认使用平台为设备配置的万象托管云端模型。

[机器可读合同与其他媒体能力](homeai-media.v1.json) · [App Kit 合同目录](README.md)

## 1. 接入前准备

| 业务 | 所需能力 | 调用方式 |
| --- | --- | --- |
| 已有录音转文字 | `audio.transcribe` | HTTP 文件作业，返回全文和原录音时间点 |
| 已有录音云端精转 | `audio.transcribe.cloud` | 用户同意上传这条录音后，盒端按语音段向云模型提交音频 |
| 图片或截图读文字 | `image.ocr` | HTTP 文件作业，返回全文、原图尺寸和词框 |
| 麦克风实时字幕 | `audio.transcribe.streaming` | HTTP 申请会话，WebSocket 双向传输 PCM 与字幕 |
| 云端实时字幕 | `audio.transcribe.streaming.cloud` | 用户确认实时上传本次录音后，盒端通过 WebSocket 转发音频并回传字幕 |
| 对转写稿、OCR 文本等生成总结 | `text.summarize` | HTTP 创建云端模型总结任务并轮询结果，支持实例模板 |
| 盒内后台文件处理 | 对应的文件能力及限时委托 | 受信盒内服务使用回环接口 |

1. 从平台团队领取匹配版本的 **App Kit**。桌面应用在清单中声明 `identity.read` 和 `http.request`，通过万象启动，登录后连接目标盒。Host 与 Bridge 均须支持媒体转发。实时 ASR 还要求该盒的媒体注册允许 WebSocket。
2. 应用收到系统麦克风许可后即可本地录音。采集、保存和回听原音独立于盒端转写、实时字幕及总结。
3. 在 Electron 主进程用 `fromEnvironment()` 创建 Host。连接已登录的盒子后，文件转写、实时字幕和总结的前台 HTTP 调用直接用 `host.request()`，省略 `X-Media-Grant`。新版 Host 自动注入应用专属凭据，Bridge 签发当前账号和已绑定空间的身份，媒体服务据此隔离作业和模板。个人版和企业版采用相同接入方式。
4. OCR、图像处理和后台委托沿用显式实例授权。安装方签发 `grantId`、`instance` 和 `grant` 并通过受信渠道交付到应用安全存储。调用这些接口、领取旧作业或管理旧实例模板时，发送原来的 `X-Media-Grant: <grant>`。
5. 先调 `GET /capabilities` 核对目标能力和其 `configured`。模型配置未就绪时仍可本地录音和回听。订阅 `host.onSessionInvalidated`，会话失效时结束字幕连接和盒端上传、轮询，保留本地录音。

默认调用需要同时更新桌面 Host、Bridge 和媒体服务，适用于使用平台登录会话连接的盒子。支持自动凭据的 Host 在 `host.context()` 返回 `hostFeatures.foregroundMedia: true`。旧盒仍可使用显式实例授权。独立 Web、安卓或 iOS 入口沿用各自的接入协议。

## 2. 能力发现

`GET /capabilities`。以下路径均相对于媒体 API 前缀。

```json
{
  "instance": "example-media-app",
  "processingLocation": "box",
  "maxInputBytes": 268435456,
  "chunkBytes": 1048576,
  "resultTtlSeconds": 86400,
  "capabilities": [
    {
      "id": "audio.transcribe",
      "configured": true,
      "state": "configured",
      "formats": ["wav", "flac", "ogg", "mp3", "m4a"],
      "maxDurationSeconds": 3600
    },
    {
      "id": "image.ocr",
      "configured": true,
      "state": "configured",
      "formats": ["jpeg", "png", "webp"],
      "maxPixels": 32000000
    },
    {
      "id": "audio.transcribe.streaming",
      "configured": true,
      "state": "configured",
      "transport": "websocket",
      "audio": {"encoding": "pcm_s16le", "sampleRate": 16000, "channels": 1},
      "maxFrameBytes": 6400,
      "maxDurationSeconds": 3600
    },
    {
      "id": "text.summarize",
      "configured": true,
      "state": "configured",
      "processingLocation": "cloud",
      "formats": ["text/plain;charset=utf-8"],
      "maxInputBytes": 32768
    }
  ]
}
```

顶层 `processingLocation: "box"` 表示任务服务在当前盒子运行。云端精转和总结能力项的 `processingLocation: "cloud"` 表示实际推理在云端。

用设备实际返回的限制。当前通用文件上限为 256 MiB。单图上限 3200 万像素，安装兼容 HEVC 解码器后才可能额外返回 `heic`、`heif` 和 `heif.maxPrimaryFrames: 1`。文件 ASR 支持的容器以 `formats` 为准，解码时长最长 3600 秒。OCR 和本地文件 ASR 使用 `options: {}`，模型、OCR 语言包和 ASR 识别策略由盒端配置。应用选择已获授权且可读取的文件，上传原始字节。

## 3. 文件 ASR 与图片 OCR

### 作业接口

| 方法和相对路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /jobs` | JSON `{requestId, capability, size, sha256, options}` | 200，作业回执 |
| `PUT /jobs/{id}/input?offset=N` | `application/octet-stream`，原始字节 | 200，`{"offset":N}`，累计已确认字节 |
| `POST /jobs/{id}/submit` | 空请求体 | 200，作业回执 |
| `GET /jobs/{id}` | 无 | 200，作业回执 |
| `GET /jobs/{id}/result` | 无 | 200，结果封套 |
| `POST /jobs/{id}/retry` | 空请求体 | 200，作业回执 |
| `DELETE /jobs/{id}` | 无 | 200，取消后的作业回执并清除该作业的输入和临时结果 |

`requestId` 是调用方生成并持久化的 1–128 字符标识。同一凭据内，相同 `requestId` 和相同 `capability`、`size`、`sha256`、`options` 返回原作业。任一值变化会返回 `REQUEST_CONFLICT`。`size` 为原件字节数，`sha256` 为整份原件的 64 位小写十六进制摘要。

```json
{
  "id": "37de1e89da9445cba7a022da40fb7e23",
  "state": "uploading",
  "capability": "audio.transcribe",
  "offset": 0,
  "size": 346528,
  "expiresAt": 1795520700.25,
  "attempts": 0,
  "error": null,
  "cacheHit": false
}
```

`expiresAt` 为 Unix 秒，可能含小数。`error` 为错误码字符串或 `null`，先以 `state` 判断是否结束。`cacheHit` 为共用回执字段，OCR 和文件 ASR 的重放依靠 `requestId` 幂等。

### 上传、轮询和归档

1. 从 `offset` 开始顺序上传。除最后一块外，每块恰好为发现接口给出的 `chunkBytes`，当前为 1 MiB。上传中断或回执丢失后，通过 `GET /jobs/{id}` 取确认偏移再继续。作业仍处于 `uploading` 时，在原块起点重发完全相同的字节也可恢复回执。
2. `offset === size` 后调用 `submit`。盒端校验完整 SHA-256 后入队。已排队、执行中或已完成的作业可安全重发 `submit`。
3. 轮询直到 `done`。`uploading → queued → running → done` 为正常流程。`failed` 可针对可恢复原因调用 `retry`，最多累计三次执行，已处于 `queued` 的重试请求可重放。`cancelled`、`expired`、`revoked` 应结束当前操作。其中过期可直接返回 HTTP 410，已清理或不可见时可直接返回 404，撤权后请求可能先返回 403。
4. 读取结果时复核 `jobId`、`capability` 和 `inputSha256`，再写入应用获权的空间。成功及失败结果从完成时起保留约 24 小时，待上传和排队的初始有效期为创建后 24 小时。失败保留暂存输入供重试，成功后清除暂存输入。凭据提前过期或撤回会影响当前访问，重复读取也以有效期为准。
5. 队列与磁盘按盒共享。当前最多 128 个活跃预留、总申报输入最多 2 GiB，尚未过期的失败作业也占预留。收到 429 按 `Retry-After` 或退避等待，收到 507 先释放盒端空间。

### 文件 ASR 结果

```json
{
  "jobId": "37de1e89da9445cba7a022da40fb7e23",
  "capability": "audio.transcribe",
  "inputSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "result": {
    "model": "whisper",
    "modelSha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "language": "zh",
    "segments": [
      {"id": "0", "startMs": 9580, "endMs": 13380, "text": "周六上午九点整理家庭照片"}
    ],
    "text": "周六上午九点整理家庭照片"
  }
}
```

`language` 是模型识别的语种，`segments[].id` 是该次结果内的字符串段标识。`startMs`、`endMs` 为相对原录音起点的毫秒数。盒端文件 VAD 过滤无声区间后仍映射回原音时间轴。`text` 是所有有效段按顺序用换行拼接的全文。无有效语音时作业为 `failed`，`error` 为 `AUDIO_NO_SPEECH`。纪要、发言人命名、人工修订和待办由应用管理。

### 云端精转

先检查能力列表中 `audio.transcribe.cloud` 的 `configured` 为 `true`，再提示用户本条录音的音频将经万象中转站（QeeToken）发送到阿里云百炼。用户确认后，使用该能力创建文件作业，传入 `options: {"cloudConsent":true}`，按同一文件上传协议提交与轮询。云端精转和本地转写需要各自的 `requestId`。较早的服务只提供本地转写；应用可在能力缺失时说明云端精转尚未开通。

结果包含实际模型、全文和语音段。段落起止时间由盒端在原音上切分获得，适合点击回听。实时字幕和说话人分割继续使用各自的盒端接口。

### 会后发言归属校正

能力发现中的 `audio.transcribe.speakerDiarization` 为 `true` 时，可以沿用 `audio.transcribe` 的授权提交独立作业。创建作业时使用 `options: {"mode":"diarize"}`，可再传入 `expectedSpeakers`（1 至 12 的整数），人数作为识别提示。作业处理整份原音，单份录音上限以 `maxDiarizationDurationSeconds` 为准。应用可保留已有逐字稿并直接在原音时间轴上叠加结果。

```json
{
  "speakerTurns": [
    {"startMs": 240, "endMs": 1800, "speakerIds": ["speaker-1"]},
    {"startMs": 1800, "endMs": 2150, "speakerIds": ["speaker-1", "speaker-2"]},
    {"startMs": 3100, "endMs": 3420, "speakerIds": []}
  ],
  "durationMs": 4100
}
```

多个 ID 表示同一时间段内的重叠发言，空数组表示归属不明。匿名 ID 在单次整场结果内有效。改变人数或重新估计时提交新 `requestId`。原作业失败可用现有 `/retry` 重试。应用在新结果确认前可继续使用已有文字和原音。

### OCR 结果

外层 `jobId`、`capability`、`inputSha256` 与文件 ASR 相同，OCR 的 `capability` 为 `image.ocr`。以下是 `result` 对象示例。

```json
{
  "model": "tesseract 5.5.0/chi_sim+eng",
  "width": 1920,
  "height": 1080,
  "exifOrientation": 1,
  "text": "报名截止",
  "words": [
    {"text": "报名截止", "box": [120, 200, 136, 34], "confidence": 0.96}
  ]
}
```

`width`、`height` 是未应用 EXIF 方向的原始栅格尺寸，`box` 为同一坐标系的 `[left, top, width, height]`，左上角为原点，单位为像素。原图如果在界面中旋转或缩放，词框也要做对应的变换。`confidence` 为引擎词框置信度除以 100，适合辅助人工核对。无词图可正常返回空 `text` 与 `words`。输入摘要始终来自原始上传容器，图像解码和展示变换均不改变它。`image.ocr` 接收图片，PDF 需要由应用在有权读取文件的前提下逐页生成图片，并自行关联页号及原件。

## 4. 实时 ASR WebSocket

本地和云端共用桌面 Host 与盒端之间的 WebSocket 协议。请在开始录音前选择推理位置，默认本地。云端需要先发现已配置的 `audio.transcribe.streaming.cloud` 能力，向用户说明本次录音的音频将实时经万象中转站（QeeToken）发送到阿里云百炼，并取得本次同意。实时字幕与会后精转各自授权，允许分别选择。

1. 用 HTTP `POST /asr/sessions` 创建会话，由桌面 Host 提供默认凭据。本地会话使用空请求体。云端会话使用 JSON `{"capability":"audio.transcribe.streaming.cloud","cloudConsent":true}`；发送音频前确认回执的 `capability` 与请求一致且 `processingLocation` 为 `cloud`。成功为 201，返回 `id`、`streamPath`、`ticket`、`ticketExpiresAt`、`audio`、`maxFrameBytes`、`idleTimeoutSeconds`、`maxDurationSeconds`。一次性票据最长有效 30 秒，也受授权期限约束。票据和连接路径按原样使用。
2. 同一 Host 会话中调用 `host.openStream(streamPath, {protocols: ['wanx.asr.v1', 'wanx.asr.ticket.' + ticket]})`。按此顺序设置两个子协议，服务端协商 `wanx.asr.v1`。凭据仅通过对应的 HTTP 头或 WebSocket 子协议传递，连接路径不带查询参数。为套接字立即注册事件，收到 `ready` 后再发送音频。
3. 按采集速率发送 16 kHz、单声道、带符号 16 位小端的裸 PCM。帧为非空偶数字节，最多 6400 字节，推荐 100 ms 即 3200 字节。发送速率为每秒 32000 字节，允许短时突发但应持续按采集节奏。每盒只允许一路活跃实时会话，15 秒无音频触发空闲关闭，单会话最长 3600 秒。
4. 录制结束时发送文本 JSON `{"type":"end"}`，等待剩余 `final` 和 `end` 回执。连接断开后重新申请会话和票据，应用可以保存本地已采集原音。

| 服务端文本事件 | 客户端处理 |
| --- | --- |
| `{"type":"ready"}` | 开始发送 PCM |
| `{"type":"partial","segmentId":0,"text":"周六"}` | 按段 ID 替换临时字幕，空文本清除该草稿 |
| `{"type":"final","segmentId":0,"text":"周六上午开会。"}` | 提交该段文字，盒端配置标点模型时可带标点 |
| `{"type":"speaker","segmentId":0,"speakerIds":["speaker-1"]}` | 可选，按段 ID 更新发言归属，空数组为归属不明 |
| `{"type":"end","durationMs":3200}` | 流接收完成，时长以盒端收到的 PCM 字节为准，随后正常关闭 |
| `{"type":"error","code":"STREAM_IDLE_TIMEOUT"}` | 停止本轮发送，提示或按原因建立新会话 |

云端会话中，QeeToken 转发的临时结果对应 `partial`，整句定稿对应同一 `segmentId` 的 `final`。云端实时字幕仅提供文字，整场说话人校正仍可在会后单独运行。实时字幕事件无逐段时间戳。检测到实时分人能力时，发言人标签在文字之后可增量到达，匿名 ID 只在同一实时会话内有效，断开后由应用保留先前的草稿。媒体服务实时会话不持久化原音和字幕。需要回听、可归档稿或逐段时间点时，由应用在采集时保存授权原音，结束后走 `audio.transcribe` 文件作业。判断流程完成以收到 `end` 为准。

## 5. LLM 总结与模板

### 创建总结任务

`POST /summaries` 接收 UTF-8 JSON 并返回 HTTP 202 及标准作业回执。桌面 Host 默认提供 `text.summarize`。用户主动生成总结时，先告知转写文本会发往云端，再提交请求。使用 `GET /capabilities` 确认该能力已配置，再提交一份合成文本验证云端推理。

```json
{
  "requestId": "meeting-20261123-summary-v1",
  "text": "本次会议决定周六上午九点整理家庭照片。小林负责带相机，周五前确认时间。"
}
```

- `text` 为已经获准用于云端总结的 ASR 转写稿、OCR 文本或其他纯文本，最多 32768 个 UTF-8 字节。该文本和所选模板的指令经设备配置的模型通道发送至云端。超过模型上下文的长稿可先按业务语义分段。模型输出上限为 1024 tokens。
- `templateId` 可省略，也可传 `null`，两者均使用本实例的当前默认模板。实例初始默认是内置「通用总结」`builtin-default`，也可以显式传它。传指定模板 ID 时会核对归属。
- 新作业的中文总结默认使用简体中文。模板可以明确指定繁体中文或其他语言，作业按提交时的设置重试。
- 提交时即入队并保存所用模板的版本和指令。重复提交同一授权下相同 `requestId`、文本和模板选择，返回已有作业。更新、删除或切换模板只影响新的请求标识，已有作业重试沿用提交时的模板。
- 总结与文件识别共用盒端异步队列。作业沿用 `GET /jobs/{id}`、`GET /jobs/{id}/result`、`POST /jobs/{id}/retry` 和 `DELETE /jobs/{id}`。应用轮询到 `done` 后读取结果。

```json
{
  "jobId": "37de1e89da9445cba7a022da40fb7e23",
  "capability": "text.summarize",
  "inputSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "result": {
    "model": "cloud-summary-model",
    "templateId": "builtin-default",
    "templateRevision": 1,
    "text": "决定：周六上午九点整理家庭照片。行动项：小林带相机，周五前确认时间。"
  }
}
```

`inputSha256` 对原请求 `text` 的 UTF-8 字节计算，示例值为占位。`result.model` 是部署所选的云端模型标识。`result.text` 是模型生成的文本，可供用户核对后归档或进一步提炼待办。渲染为 HTML 或 Markdown 时，应按应用对外部内容的规则处理。

### 模板管理

同一份 `text.summarize` 授权可管理本实例的模板。模板按盒子、账号、空间和应用实例隔离。同一实例换发授权后可继续使用既有模板。作业及其结果仍按签发的授权隔离。

| 方法及相对路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `GET /summary-templates` | 无 | 200，`{templates, defaultTemplateId}`，含内置模板 |
| `POST /summary-templates` | `{name, instructions}` | 201，新模板 |
| `GET /summary-templates/{id}` | 无 | 200，单个模板 |
| `PUT /summary-templates/{id}` | `{name, instructions, expectedRevision}` | 200，更新后的模板 |
| `DELETE /summary-templates/{id}?expectedRevision=N` | URL 中提供当前版本 | 200，`{"deleted":true}` |
| `GET /summary-templates/default` | 无 | 200，当前默认模板 |
| `PUT /summary-templates/default` | `{templateId}`，传 `null` 恢复内置默认 | 200，切换后的默认模板 |

```json
{
  "id": "08fff28a1a5b448a892c4821b7ef5f23",
  "name": "会议纪要",
  "instructions": "输出会议结论、行动项和待确认问题。原文没有提供负责人或截止时间时写待确认。",
  "revision": 1,
  "isBuiltin": false
}
```

`name` 和 `instructions` 去除首尾空白后分别为 1–100 和 1–4000 字符。每个作用域最多保存 100 个自定义模板。修改后版本递增，更新与删除须使用上一次读取的 `revision`。内置模板只可读取、选为默认或用于总结。删除当前自定义默认模板后，系统恢复「通用总结」。

总结默认经万象托管模型转发。平台维护方也可为设备显式配置 HTTPS 直连云端模型。应用提交文本和所选模板，模型标识和云端调用凭据由盒端维护方管理。

从本地总结迁移到云端时，已生成的结果仍可按作业权限读取。原先排队或失败的本地总结作业需要由调用方确认文本可传云后，以新的 `requestId` 提交。

## 6. Electron 主进程示例

以下示例在同一个 Electron 主进程模块中使用。前台录音能力直接调用 `connectMedia()`。OCR 或旧作业使用安装方交付的 `grant` 和已登记的 `expectedInstance`。

```js
const { fromEnvironment } = require('@centaurai/wanx-host-sdk');
const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { setTimeout: sleep } = require('node:timers/promises');

const base = '/api/services/wanx.media/v1';

async function connectMedia(grant, expectedInstance, onInvalidated = () => {}) {
  const host = fromEnvironment();
  if (!host) throw new Error('请从万象打开应用并连接盒子');
  host.onSessionInvalidated(onInvalidated);
  async function call(path, { method = 'GET', body, signal } = {}) {
    const headers = grant ? { 'X-Media-Grant': grant } : {};
    if (Buffer.isBuffer(body)) headers['Content-Type'] = 'application/octet-stream';
    const response = await host.request(base + path, { method, headers, body, signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const code = data?.code ?? 'HTTP_' + response.status;
      throw Object.assign(new Error(code), {
        code,
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
      });
    }
    return data;
  }
  try {
    const context = await host.context();
    if (context.connection !== 'ready') throw new Error('NETWORK_NOT_READY');
    const capabilities = await call('/capabilities');
    if (expectedInstance && capabilities.instance !== expectedInstance) throw new Error('MEDIA_INSTANCE_MISMATCH');
    return { host, call, capabilities };
  } catch (error) {
    host.close();
    throw error;
  }
}

// 小样本接入示例。大文件用文件流计算摘要和按偏移读取。
async function runFileJob(media, capability, filePath, requestId, signal) {
  const { call, capabilities } = media;
  if (!['audio.transcribe', 'image.ocr'].includes(capability) ||
      !capabilities.capabilities.some(item => item.id === capability && item.configured)) {
    throw new Error('所需媒体能力未就绪');
  }
  const { chunkBytes, maxInputBytes } = capabilities;
  const bytes = await readFile(filePath, { signal });
  if (!bytes.length || bytes.length > maxInputBytes) throw new Error('文件大小超出范围');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let job = await call('/jobs', {
    method: 'POST',
    body: { requestId, capability, size: bytes.length, sha256, options: {} },
    signal,
  });
  const path = '/jobs/' + encodeURIComponent(job.id);
  if (job.state === 'uploading') {
    for (let offset = job.offset; offset < bytes.length;) {
      const chunk = bytes.subarray(offset, offset + chunkBytes);
      const ack = await call(path + '/input?offset=' + offset, {
        method: 'PUT', body: chunk, signal,
      });
      if (ack.offset !== offset + chunk.length) throw new Error('上传回执偏移不符');
      offset = ack.offset;
    }
    job = await call(path + '/submit', { method: 'POST', signal });
  }
  while (job.state === 'queued' || job.state === 'running') {
    await sleep(1200, undefined, { signal });
    job = await call(path, { signal });
  }
  if (job.state !== 'done') {
    throw Object.assign(new Error(job.error ?? job.state), { jobId: job.id, state: job.state });
  }
  const receipt = await call(path + '/result', { signal });
  if (receipt.jobId !== job.id || receipt.capability !== capability ||
      receipt.inputSha256 !== sha256) throw new Error('媒体结果与原件不匹配');
  return receipt.result;
}
```

给 `runFileJob` 传入业务侧已保存的 `requestId` 和 `AbortSignal`。网络恢复后用同一个请求标识和同一份文件重新调用即可从已确认偏移恢复。分别传入 `audio.transcribe` 和 `image.ocr` 即可共用上述上传流程。

实时样例输入是一段已经转换成裸 PCM 的测试样本。正式录音把麦克风采集、重采样和帧队列接在同一协议上。应用结束时调用 `media.host.close()`。

```js
async function streamPcmFixture(media, pcmBytes, onCaption) {
  const { host, call, capabilities } = media;
  if (!capabilities.capabilities.some(item =>
      item.id === 'audio.transcribe.streaming' && item.configured)) {
    throw new Error('实时转写未就绪');
  }
  const lease = await call('/asr/sessions', { method: 'POST' });
  const ws = await host.openStream(lease.streamPath, {
    protocols: ['wanx.asr.v1', 'wanx.asr.ticket.' + lease.ticket],
  });
  const stop = new AbortController();
  try {
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const ended = new Promise((resolve, reject) => {
      ws.on('message', (data, binary) => {
        if (binary) return;
        try {
          const event = JSON.parse(Buffer.from(data).toString('utf8'));
          if (event.type === 'ready') {
            if (ws.protocol !== 'wanx.asr.v1') throw new Error('实时协议协商失败');
            ready();
          } else if (event.type === 'partial' || event.type === 'final') {
            onCaption(event);
          } else if (event.type === 'end') {
            resolve(event.durationMs);
          } else if (event.type === 'error') {
            reject(new Error(event.code));
          }
        } catch (error) {
          reject(error);
        }
      });
      ws.once('error', reject);
      ws.once('close', code => reject(new Error('实时流关闭 ' + code)));
    });
    await Promise.race([started, ended.then(() => {
      throw new Error('实时流在就绪前结束');
    })]);
    const sending = (async () => {
      for (let offset = 0; offset < pcmBytes.length; offset += 3200) {
        const frame = pcmBytes.subarray(offset, offset + 3200);
        if (frame.length % 2 || frame.length > lease.maxFrameBytes) {
          throw new Error('PCM 帧格式错误');
        }
        await new Promise((resolve, reject) => {
          ws.send(frame, { binary: true }, error => error ? reject(error) : resolve());
        });
        await sleep(frame.length / 32, undefined, { signal: stop.signal });
      }
      ws.send(JSON.stringify({ type: 'end' }));
    })();
    await Promise.race([sending, ended]);
    return await ended;
  } finally {
    stop.abort();
    ws.terminate();
  }
}
```

## 7. 错误与恢复

媒体业务错误通常返回 `{"code":"..."}`。Bridge 错误可能同时带同名的 `detail` 字符串，字段校验错误的 `detail` 可为数组。Host 或网络错误也可能作为带 `code` 的异常抛出。文件识别本身失败时，正常返回 HTTP 200 的作业回执，在 `state: failed` 时查看字符串 `error`。

| 情况 | 典型信号 | 应用处理 |
| --- | --- | --- |
| Host 会话失效或网络未就绪 | `HOST_SESSION_EXPIRED`、`NETWORK_NOT_READY` | 停止旧会话操作，从万象恢复连接或重新启动 |
| 授权缺失、失效或不匹配 | 401 `MEDIA_AUTH_REQUIRED`、403 `GRANT_REQUIRED`、`CAPABILITY_DENIED` | 核对当前盒子、空间、账号、实例和能力，必要时由安装方换发 |
| 盒端未能确认前台调用范围 | 403 `FOREGROUND_CONTEXT_REQUIRED` | 核对 Bridge 和媒体服务版本，使用万象当前已登录会话 |
| 作业不可见或过期 | 404 `JOB_NOT_FOUND`、410 `JOB_EXPIRED` | 停止查询旧作业，需要重新处理时用新的请求标识 |
| 续传或状态冲突 | 409 `OFFSET_OR_SIZE_CONFLICT`、`REQUEST_CONFLICT`、`UPLOAD_INCOMPLETE`、`RESULT_NOT_READY`、`RETRY_NOT_ALLOWED` | 重新查询作业回执，按实际偏移或状态恢复 |
| 分块、输入或摘要不合法 | 413 `CHUNK_TOO_LARGE`，422 `FULL_CHUNK_REQUIRED`、`DIGEST_MISMATCH`、`INVALID_OPTIONS` 或字段校验错误 | 修正块长、原文件、摘要或请求字段后再提交 |
| 暂时繁忙或盒端未就绪 | 429 `QUEUE_CAPACITY`、`STREAM_BUSY`、`ASR_HANDOFF_BUSY`，503 `MODEL_UNAVAILABLE` | 退避或等会话结束，模型缺失由安装方检查；同时可检查发现接口 |
| 服务未部署或当前版本不兼容 | 404 `SERVICE_NOT_INSTALLED`、409 `SERVICE_INCOMPATIBLE` | 向盒端维护方核对注册和 Bridge 版本 |
| 盒端磁盘容量不足 | 507 `DISK_CAPACITY` | 释放盒端空间后提交 |
| 原件未能解码或缺少有效语音 | 任务 `error` 为 `UNSUPPORTED_AUDIO_FORMAT`、`AUDIO_DURATION_LIMIT`、`AUDIO_NO_SPEECH` 或 `IMAGE_PIXEL_LIMIT` 等 | 依据错误提示检查原件、选择适配格式或重新录音 |
| OCR 引擎执行失败 | 任务 `error: OCR_ENGINE_UNAVAILABLE` | 核对 Tesseract、本地语言包和样图，再使用作业重试 |
| 总结输入或模型不可用 | 422 `SUMMARY_INVALID_INPUT`，503 `SUMMARY_MODEL_UNAVAILABLE` | 修正文本，或让维护方检查云端通道、模型及专用凭据配置 |
| 本地总结旧作业需要重新提交 | HTTP 409 或作业 `error` 为 `SUMMARY_CLOUD_RESUBMIT_REQUIRED` | 确认文本可传云后，以新的 `requestId` 提交 |
| 模板不存在、版本冲突或达到上限 | 404 `SUMMARY_TEMPLATE_NOT_FOUND`，409 `SUMMARY_TEMPLATE_REVISION_CONFLICT`、`SUMMARY_TEMPLATE_IMMUTABLE`，429 `SUMMARY_TEMPLATE_LIMIT` | 重新读取模板、选择可编辑模板，或清理当前实例的自定义模板 |
| 总结模型调用失败 | 作业 `error` 为 `SUMMARY_TIMEOUT`、`SUMMARY_UPSTREAM_FAILED`、`SUMMARY_INVALID_OUTPUT` 或 `SUMMARY_RESULT_LIMIT` | 检查托管转发或云端服务状态及模型上下文限制，明确为可恢复错误时使用作业重试 |
| 云端直连地址校验失败 | 作业 `error` 为 `SUMMARY_CLOUD_DESTINATION_DENIED` | 让维护方检查所配置的云端服务域名及其 DNS 解析 |

实时故障可能在 WebSocket 升级前被拒绝，或在连接后以 `error` 事件和关闭码返回。`STREAM_GRANT_REVOKED` 需要恢复授权。`STREAM_IDLE_TIMEOUT`、`STREAM_DURATION_LIMIT` 需要新会话。`INVALID_AUDIO_FRAME`、`AUDIO_FRAME_TOO_LARGE`、`AUDIO_RATE_LIMIT` 和 `INVALID_STREAM_MESSAGE` 需要修正采集、帧大小、发送速率或控制消息。`MODEL_UNAVAILABLE`、`STREAM_INFERENCE_FAILED` 由盒端维护方核查。典型 WebSocket 关闭码为 1008 协议或限额、1009 帧过大、1011 模型或上游异常。

## 8. 授权撤销与盒内后台委托

本节接口使用安装方签发的显式授权。

| 调用 | 请求和响应 |
| --- | --- |
| `DELETE /grant/self` | 吊销当前应用持有的媒体授权，返回 `{"revoked":true}` |
| `POST /delegations` | 使用原 Host 和媒体授权，JSON `{"capabilities":["audio.transcribe"],"ttlSeconds":3600}`。返回 `id`、`token`、`boxId`、`userId`、`spaceId`、`instance`、`capabilities`、`expiresAt`、`audience` |
| `GET /delegations` | 查当前父授权的有效委托，返回 `{"delegations":[...]}`，列表不含 `token` |
| `DELETE /delegations/{id}` | 由父授权撤销自己的委托，返回 `{"revoked":true}` |

委托只供已接入并获用户授权的同盒后台服务。能力须为父授权的子集，允许项是 `image.fingerprint`、`image.embedding`、`image.labels`、`image.ocr`、`text.embedding` 和 `audio.transcribe`，实时字幕仅用前台授权。家庭照片检索用同盒的 `text.embedding` 编码已登录用户提交的搜索词，按空间授权和相同模型摘要匹配照片向量。`ttlSeconds` 为 1–604800，且实际到期时间取父授权剩余时间和该期限的较小值。`token` 仅在签发回执中返回，通过受信的同盒渠道交付。

已获委托的盒内服务使用 `X-Media-Delegation` 访问媒体服务的回环前缀 `/internal/media/v1`，调用 `GET /context`、`GET /capabilities`、前述文件作业接口，或以 `DELETE /delegation/self` 自行撤销。当前 `audience` 为 `wanx.homeai`，其他盒内应用服务接入须与平台维护方确认。该前缀只提供给盒内受信服务。父授权到期或撤销会使子委托和未归档的作业失效。应用在上传前和归档前仍须确认原件与目标空间权限。

## 9. 联调验收

- 分别用一张中文截图、带明确时间点的短录音和 10 秒实时音频，核对发现状态、SHA-256、OCR 原图框、文件时间点及 WebSocket `end` 回执。
- 用同一份合成文本分别测试省略模板、显式指定模板和更新当前默认模板。对照返回的云端模型标识、模板 ID 和版本，并用同一个请求标识检查重放。
- 模拟中途断网，确认同一文件作业可回到已确认偏移。模拟实时断线，确认重新申请票据和本地录音数据按预期恢复。
- 给两个独立实例分别签发权限，确认另一实例无法领取前一实例的结果。验收环境撤回授权，确认正在处理的前台或后台任务能看到相应错误。
- 排期时以盒端实际能力为准。候选 OCR 和 ASR 引擎、设备管理开关及其他扩展接口由平台单独确认进入发布范围。
