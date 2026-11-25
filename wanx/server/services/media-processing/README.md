# WANX 媒体处理服务

本服务在盒内处理文件和实时转写，并受理使用云端模型的可选 LLM 总结。文件任务使用 SQLite 持久队列和一个处理进程。端口绑定回环，客户端经万象 Bridge 访问。输入由调用者在已有文件授权下读取并上传；服务不接收客户端路径、远程 URL 或未授权 Drive 引用。每次请求同时验证 Bridge 身份和安装方授予该应用实例的能力。输入提交与模型摘要绑定，推理结束后由调用者另行检查家庭资料写权限并归档。[应用合同](../../../apps/personal-client/host-sdk/contracts/homeai-media.v1.json)

应用开发从 [盒端媒体 API v1](../../../apps/personal-client/host-sdk/contracts/media-api.md) 开始，覆盖 OCR、ASR、LLM 总结及模板管理，文档随 App Kit 分发。本页提供盒端安装、授权和验收说明。

## 安装与授权

在专用服务账号下运行，使用权限为 0700 的独立持久目录。建议盒端选 Python 3.11/3.12，系统安装 Tesseract 和部署所需的 `chi_sim`、`eng` 语言数据。基础环境运行 `uv sync --locked --no-dev`；启用 ASR 加 `--extra asr`，启用图文能力加 `--extra vision`。可同时启用两者。

- 将已获许可、离线可分发的完整 CTranslate2 Whisper 模型目录配置为 `WANX_MEDIA_ASR_MODEL`。需有 model.bin、tokenizer.json 及该模型的词表与配置，服务使用 CPU int8。由安装方记录运行时、模型来源、版本、许可及模型文件校验值。一次任务按一小时解码音频限制验收。
- 文件转写默认使用 Faster-Whisper 自带的 Silero VAD 滤除无声区间，输出时间点仍以原录音为基准。没有识别出语音时，任务以 `AUDIO_NO_SPEECH` 结束。
- 可选 LLM 总结使用安装方为设备配置的云端模型，默认经万象托管模型转发。云端总结的安装和验收步骤见下文。
- 可选 Chinese-CLIP 使用 `WANX_MEDIA_CLIP_MODEL` 指向受信只读模型目录，含 model.safetensors 和配套 config、processor、tokenizer。调用方提交家庭词表或中文短句。模型加载限制为本地，不能下发远程模型代码。仅有文本嵌入模型时不会启用图文能力。
- Tesseract 语言默认为 `chi_sim+eng`，可用 `WANX_MEDIA_OCR_LANG` 选已安装语言。选择 Tesseract 的依据是原有知识库 OCR 公共接口只返回纯文本，此服务需要原尺寸上的文字框及置信度。图像 dHash 可独立运行，用于相似候选；文件完整性以 SHA-256 核对。
- 能力发现的 `configured` 表示本机具备相应依赖/配置线索。模型是否能按目标图像质量和延迟完成计算，须用一次真实任务确认。OCR、标签、图文匹配通过不同 grant 分开开放。

受信安装器按现有 Bridge 独立服务注册流程合并 [手工注册示例](registry.example.json)，替换 uid、端口及服务安装证明公钥路径，保留其他服务记录。服务安装证明公钥与验证 **Bridge JWT** 的公钥用途不同。以下命令的参数是专用服务用户可访问的本机路径，使用真实环境的受信 32 字节 Bridge Ed25519 原始公钥。

```sh
uv run --no-sync wanx-media serve --data-dir /var/lib/wanx-media \
  --public-key /etc/wanx-media/bridge.raw --port 19094
```

可信管理方确认用户、空间、盒子、安装实例及可授权能力后发放 grant。服务不通过 HTTP 自动向任何市场应用发放权限。模板中的 BOX、USER、INSTANCE 应换成经安装器核验的值。

```sh
uv run --no-sync wanx-media grant --data-dir /var/lib/wanx-media \
  --box BOX --user USER --space personal --instance INSTANCE \
  --allow audio.transcribe --allow image.fingerprint \
  --output /secure/instance-grant.json
uv run --no-sync wanx-media revoke --data-dir /var/lib/wanx-media --id GRANT_ID
```

凭据只写入新建的 0600 文件，通过受信主进程/系统安全存储交付，不进入清单、源码、查询字符串或日志。有效期默认 24 小时，安装方可按持续作业授权缩短，最长 30 天。同一账号的不同实例使用各自的 grant；重新签发是新的隔离范围。若成员退出、应用移除或资料处理授权变化，授权管理方应撤销 grant 或取消关联作业。当前通用 Bridge JWT 证明用户/空间和服务，未原生签发应用实例标识；grant 的安全分发及其与平台撤权事件的联动是上线依赖。任务提交的仅是该作用域内获授权的副本，不授予永久资料访问权。

## 作业与运行边界

通过 `/api/services/wanx.media/v1` 提交，`GET /capabilities` 仅列本实例获准的能力。按稳定的 requestId 申请作业、按服务端偏移续传、提交后轮询 terminal state，最后领取一次可重复读取的临时结果。最多 128 个未释放输入预留、总申报输入不超过 2 GiB。SQLite 持久化每块数据及偏移；服务重启回收临时文件，未耗尽重试次数的运行中任务重新排队。单进程文件锁防止同库多 worker 重复计算。在执行和发布结果时重新检查授权与取消状态。撤权、取消或过期删除临时输入和结果，已独立归档/导出的资料依其归档域管理。运维按输入暂存、SQLite 文件和执行临时文件一起核算磁盘。安装方应在持久卷和临时目录应用一致的备份、加密和物理介质策略。

设备采集、字幕展示、家庭资料归档、索引、纪要和通知由消费方负责。正式 OTA 须另交付目标镜像的签名、激活信息及官方准入证据。安装权限、模型许可、低配置盒型的吞吐、中文识字质量和录音时间戳准确率分别验收。[Bridge 注册合同](../../../docs/bridge/independent-service-registration.md)

## CentaurOS 可选服务 OTA

首个验收 profile 是 Ubuntu 26.04 x64 / CPython 3.14 的 `wanx-media-python314-ubuntu2604-x64`，签名发行要求升级器至少为 `1.9.52`。先发布包含媒体 HTTP 和实时 WebSocket 路由的 WANX 镜像及受信主机配置，设备库存出现匹配的 Bridge 和媒体 profile 后，再在 Admin 创建 `wanx.media` 的定向 canary 任务。媒体服务支持独立发行，家庭资料中心和客户端沿用各自的交付渠道。

用 [离线制品构建工具](../../../tools/homeai-services/build_media_ota.py) 的 `wheel-plan` 列出冻结提交所需的 Linux wheel，再用 `build` 封装源码、锁定 wheel、Whisper / Paraformer / 标点模型与 Tesseract 中英运行时。工具输出制品摘要和签名发行所需的构建信息。通过已配置的可选服务发行与执行许可签名身份下发，Admin 中以设备 ID 指定 101。

受信安装规则将媒体注册表通过 `WANX_BRIDGE_MEDIA_SERVICE_REGISTRY_FILE` 只读挂载到 Bridge。Bridge 在 `activation.json` 已提交且运行版本、构建、源码、制品摘要、运行时摘要及激活代次匹配时放行。注册冲突或证据损坏时，媒体接口关闭，Bridge 继续提供其他服务。设备本地的模型就绪与云端总结授权分别检查。

开始升级已纳管服务时，更新器创建运行身份文件同目录的 `drain`。服务停止接新请求、实时字幕和新队列作业，原有作业完成后由本机 `GET /internal/ota/v1/drain` 报告空闲。持久队列留在数据目录，成功切换或回滚后继续处理。手工 `legacy` 部署需要另做有证据的数据接管。

101 验收记录应包含实际制品 SHA-256、操作编号、盒端成功或回滚回执，并用经授权的 PC 应用分别验证文件 ASR 时间戳、WebSocket 增量和定稿、中英 OCR 和合成文本的云端总结。断开云端连接后复测本地 ASR。应用、媒体服务和升级器各自的日志用于定位失败阶段。

## 云端 LLM 总结

安装方为设备选定万象托管云端模型，并为调用总结接口的应用实例授予 `--allow text.summarize`。需要使用独立云端模型服务时，安装方可以为设备显式配置 HTTPS 直连。

| 参数 | 万象托管云端模型（默认接入方式） | HTTPS 直连 |
| --- | --- | --- |
| `WANX_MEDIA_SUMMARY_MANAGED_PROVIDER` | 万象已为该设备下发的模型供应商标识 | 不设置 |
| `WANX_MEDIA_SUMMARY_CLOUD_BASE_URL` | 不设置，固定经本机 Bridge 的专用回环端口 `18089` 转发 | 受信的公网 HTTPS 云端模型服务基础地址，端口为 `443`，路径为 `/v1` |
| `WANX_MEDIA_SUMMARY_CLOUD_MODEL` | 万象为该设备配置的云端模型标识 | 该云端服务授权提供的模型标识 |
| `WANX_MEDIA_SUMMARY_CLOUD_KEY_FILE` | 保存万象托管转发凭据的文件绝对路径 | 保存专用云端调用令牌的文件绝对路径 |

托管模式的回环端口用于调用 Bridge 转发，实际推理在云端完成。托管凭据使用平台为设备提供的万象转发令牌。HTTPS 直连调用 OpenAI 兼容的 `/v1/chat/completions`。

令牌文件使用常规文件，权限为 `0400` 或 `0600`，仅授予媒体服务读取权限。使用 systemd 时可通过 `LoadCredential=summary-cloud-key:/受保护路径/调用令牌` 加载专用令牌，并将 `WANX_MEDIA_SUMMARY_CLOUD_KEY_FILE` 指向 `%d/summary-cloud-key`。平台安装方负责供应和轮换凭据。应用通过实例授权提交已获准用于云端总结的文本和模板选择，云端模型接收该文本及所选模板的指令。OCR 和 ASR 在盒内推理。

能力项 `text.summarize` 的 `processingLocation` 为 `cloud`。具备完整云端配置时，`configured` 表示可以发起请求，验收仍需使用合成文本确认云端服务实际返回总结。云端配置未就绪时，新总结请求返回 HTTP 503 `SUMMARY_MODEL_UNAVAILABLE`。

切换时停用旧版总结专用的本地模型服务。旧版已生成的结果仍可按作业权限读取。旧版排队或失败的本地总结作业通过 `SUMMARY_CLOUD_RESUBMIT_REQUIRED` 提示调用方确认文本可传云并用新的 `requestId` 提交。

## 实时语音转写

运行 `uv sync --locked --no-dev --extra streaming` 安装可选运行时。将 [sherpa-onnx 在线 Paraformer 中英模型](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-paraformer/paraformer-models.html)的 `encoder.int8.onnx`、`decoder.int8.onnx` 和 `tokens.txt` 放入盒端受信只读目录，设置 `WANX_MEDIA_STREAMING_MODEL` 后重启媒体服务。运行时用 CPU 解码，识别到语音后约 0.9 秒停顿可以触发定稿。Bridge 与媒体服务需同步支持本契约，且注册项 `websocket` 设为 `true`。将 `--allow audio.transcribe.streaming` 加到需要实时字幕的应用实例授权中。能力发现只向已获该项授权的实例返回其配置状态。

可在同一个运行时选装 [Sherpa ONNX 中英 CT-Transformer INT8 (2024-04-12)](https://k2-fsa.github.io/sherpa/onnx/punctuation/pretrained_models.html#sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8)。将 `WANX_MEDIA_STREAMING_PUNCTUATION_MODEL` 指向已核验的绝对只读文件路径 `model.int8.onnx`。当前校验的模型 SHA-256 为 `65a3fb9f5ad7bfb96bf69e0dc4481df97f6ee60513c1d94ce981ba6effd524b1`。该模型只为 `final` 增补中文标点。词、数字或空格会被改写时，或模型文件无法校验及加载时，继续返回识别原文。`partial` 直接返回识别器输出。

1. 应用通过已登录的 Host 和 `X-Media-Grant` 调用 `POST /asr/sessions`。响应为 HTTP 201，包含相对路径 `streamPath` 和有效期至多 30 秒的一次性 `ticket`。
2. 在同一受信 Bridge 连接上打开 WebSocket。按顺序发送子协议 `wanx.asr.v1`、`wanx.asr.ticket.<ticket>`。桌面应用使用 Host SDK 的 `openStream(streamPath, { protocols })`。票据只用于握手，服务端只协商 `wanx.asr.v1`。
3. 收到 `ready` 后，用二进制帧发送 16 kHz、单声道、16 位小端 PCM。推荐每 100 毫秒发送 3200 字节，单帧上限 6400 字节。按采集速率发送。录音文件继续使用 `/jobs`。
4. 按 `segmentId` 用 `partial` 替换当前草稿，收到 `final` 后提交定稿。发出 `{"type":"end"}` 后，读取剩余定稿和 `end`。后者包含收到的音频时长 `durationMs`，字幕事件不携带分段时间戳。
5. 单盒允许一路活跃会话，连续 15 秒没有音频会结束，最长一小时。断线后创建新会话，应用可保存先前收到的定稿。实时服务不落盘原始音频或字幕。模型缺失返回 HTTP 503，忙时返回 429。授权撤回后关闭会话，前台授权独立于后台文件委托。

API 前缀为 `/api/services/wanx.media/v1`。使用受信的 TLS 或已认证的盒子隧道传输真实录音。接入方可从 [Host SDK 契约](../../../apps/personal-client/host-sdk/contracts/homeai-media.v1.json)读取传输参数。

## 本地验证

运行 `uv run --locked pytest -q`。测试使用临时库及临时 Bridge 密钥，覆盖隔离、断点、幂等、冲突、取消、重启、撤销、过期、真实图片作业与本机 OCR 的像素框。部署模型后，应追加一份带人工时间标注的中文样音、一组同景/异景的照片及中文查询；核对模型摘要、返回位置、授权隔离和实际耗时。

### 设备验收与注册集成

测试机运行以下命令可生成 JSON 报告。默认临时目录、随机回环端口与临时签名域，不读生产凭据。传入有权用于测试的中文样音及其中的短句；无真实样音时省略两个参数，报告单列 ASR 未测。若有 Chinese-CLIP 模型，增加一张有人工标注的照片、正反两条查询和 `--require-vision` 验证得分排序。各能力记录模型、耗时、最大子进程 RSS；具备预期文字时添加 `--expect-ocr` 复核该原图的识字结果。机器报告不保存音频、图片、输入文本或访问凭据。

```sh
python -m wanx_media.acceptance --output /tmp/media-acceptance.json \
  --audio /fixtures/mandarin.wav --expect-text "经标注的短句"
```

`tests/bridge_smoke.py` 在本仓 Bridge 的独立测试环境中运行，使用真实 Bridge 实现、临时注册表、独立安装/签发密钥、模拟已登录的 Host 身份与实际回环 HTTP。它检查注册文件通过 Bridge 解析、服务 ready、签发的用户身份可提交并领取真实结果、同账号第二实例无法领取以及撤权。测试环境需安装本服务和 Bridge 依赖（包含 Pillow）；将本服务目录与仓库的 `server/bridge` 加入 PYTHONPATH 后运行该脚本。此项与正式安装器、OTA 和生产 Host 入口分开验收。

### 无人值守索引与本人授权的转写

前台已授权的账号可通过 Host + 实例 grant 调用 `POST /delegations`，显式指定能力及有效秒数。可选能力为 `image.fingerprint`、`image.embedding`、`image.labels`、`image.ocr` 和 `audio.transcribe`；后台文件转写需本人单独勾选。每次签发只包含选择项，最长七天并受原授权有效期约束。服务返回一次性展示的随机凭据，主进程只向同盒受信的家庭服务传递。家庭服务先用 `GET /internal/media/v1/context` 核对 boxId、userId、spaceId、instance、能力及到期时间，每个输入及最终归档还要由家庭服务验证原件和写入位置的业务权限。

后台用 `X-Media-Delegation` 在回环专用前缀调用相同的文件上传、提交和领取流程，每个委托独立拥有其作业。该前缀不能注册给 Bridge 或由反向代理发布。原实例可用 `GET /delegations` 查当前委托元数据、`DELETE /delegations/{id}` 撤回一个委托，也可用 `DELETE /grant/self` 撤回整个实例权限。后台亦可自行调用 `DELETE /internal/media/v1/delegation/self` 停止一个委托。原权限到期或撤销即阻断所有子凭据；排队、处理中或已完成的未归档结果随之失效。已经由家庭服务归档的资料继续按归档位置的授权管理。

计算查询向量使用 `text.embedding`，上传至多 1024 字节、去除两端空白后 1–128 字符的 UTF-8 文本。它与图像向量必须具有相同模型摘要、维度和归一化约定才可比较。家庭库先按权限和硬筛选条件缩小候选，再按点积排序。

### 查询时延与 HEIC

Linux 上连续文本查询在一个受监督的 CPU 子进程复用文本编码器。空闲 45 秒、切换其他能力、模型文件版本变化或撤权取消进行中的查询时释放；监督进程检测到 RSS 超过 1536 MiB 即停止该推理。模型部署应原子切换受信只读目录。相同 grant 下 5 分钟内完全相同的查询，经逐次授权、上传摘要与模型部署标识重新核验后，可复用仍有效的原始查询结果。作业回执 `cacheHit` 标记是否复用。模型版本、授权或输入不同均不复用结果，已取消的原结果不作为新查询来源。实际大库端到端 P95 还取决于候选过滤、向量检索及盒端负载。

可选 `--extra heif` 安装 pillow-heif。仅检测到 libheif 的 HEVC 解码器时，图像能力发现才列出 heic、heif 和 libheif 版本。解码限制为一个主图帧和 3200 万像素，关闭缩略图、辅助图及深度图解码，保留 libheif 安全上限。原件内容摘要对上传的 HEIC 字节计算；OCR 坐标采用解码主图的像素坐标。多帧 HEIF、超过上限及动态照片的伴随视频仍可由资料库原样保管，不代表可用当前图片分析。验收脚本提供 `--heic-image` 验文件原始 SHA、指纹与真实图文模型，`--ocr-image` 可独立指定测试通知原图。

### 录音实例长期授权

可信安装方可使用 `wanx-media retain-recording-grant`，传入 `--data-dir`、`--id` 和既有授权的 `--box`、`--user`、`--space`、`--instance`，将仍有效的录音实例授权设为「直到撤销」。该授权必须恰好包含 `audio.transcribe` 和 `audio.transcribe.streaming`。原凭据可继续使用。能力查询中的 `grantExpiresAt` 为 `null` 时表示无到期日。管理员可用原有 `revoke` 命令撤销。流会话票据、委托凭据和作业结果继续遵循各自的有效期。

当前录音实例明确同意把转录文本和总结要求交给配置的云模型后，可信安装方可用 `wanx-media enable-recording-summary` 和同一组绑定参数增开 `text.summarize`。原授权的期限、凭据与转写权限保持有效。
