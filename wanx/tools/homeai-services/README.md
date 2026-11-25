# HomeAI 盒端试点服务交付

`manage.py` 面向负责试点镜像的安装方，打包同一源码版本的 `wanx.media` 和 `wanx.homeai`。运行基础为 POSIX、具备 cryptography 的 Python 3.11+、uv 和支持协议 1 独立服务的 Bridge。默认仅监听 127.0.0.1 的 29094/29095，与两个服务的单独开发端口隔离。工作目录属于当前安装账号，权限为 0700。工具不需要家庭资料、市场账号、生产 JWT 或实例 grant。

## 从源码准备到启用

在仓库根目录执行。示例路径属于全新的试点目录，版本号取 stage 实际输出。安装机优先在带有目标架构可用 wheel、构建依赖和 uv 缓存的环境中预演。

```sh
tool=tools/homeai-services/manage.py
pilot=/srv/wanx-homeai-pilot
python3 "$tool" stage --root "$pilot"
python3 "$tool" install --root "$pilot" --release RELEASE_SHA256 \
  --python /opt/python3.11/bin/python3.11 --extra asr
```

stage 按两个项目的锁文件、构建配置、业务 Python 文件和注册模板生成不可变发布目录，相同内容重跑复用。install 默认离线，分别用 `uv sync --locked --no-dev --no-editable` 安装环境；需要图文模型时加 `--extra vision`，需要 HEIC 主图分析时加 `--extra heif`；附加组选项可并用。以 /capabilities 实际是否列出 heic 核对目标架构的本机解码能力。经批准的准备机可用 `--online` 填充匹配 CPU 架构及 Python 版本的缓存，或通过已验证的离线制品渠道交付。两套可执行程序均能启动帮助后才更新 active.json。服务数据、密钥和已激活版本分开存放。

可信安装方需从既有 Bridge 安装取得正确的原始 32 字节 Ed25519 **验证公钥**，确认真实 box ID，核对预留端口。用同一对端口分别在进程管理器启动两个前台进程。下面两个命令应在独立进程内执行，方便按服务查看健康与停止。

```sh
python3 "$tool" serve --root "$pilot" --service media --box BOX_ID \
  --bridge-public-key /etc/wanx/bridge.raw
python3 "$tool" serve --root "$pilot" --service homeai --box BOX_ID \
  --bridge-public-key /etc/wanx/bridge.raw
```

家庭服务的 HOMEAI_MEDIA_LOOPBACK_PORT 随受信安装设置的媒体端口注入，以便按用户明确授予的后台委托处理入库任务。内部 /internal/media/v1 前缀仅供本机使用，注册仅含公开的 /api/services/wanx.media/v1。每个进程检查既有服务锁，使用持久目录 data/media 或 data/homeai。选择其他端口时，所有 serve 与 register 命令使用同一组 `--media-port N --homeai-port M`。本机 GET /readyz 和 /version 只能证明相应进程可用，安装验收还应通过授权 Host 请求跑一份合成素材。家庭资料库对手机或后台收件程序使用的可信外部入口由设备及接入团队提供，服务端口保持回环。

## 合成与撤销注册

在独立测试注册表先演练。register 需 Python 环境具备 cryptography，已安装的两套服务环境均包含它。实例的媒体操作 grant 不会出现在注册表中。工具为每个服务分别生成安装证明密钥对。操作者应是目标注册表及其可读公钥的 Bridge 运行用户；确认运行 UID 并使用实际值。跨系统账号部署须先明确密钥托管与安装器边界。下例 UID 是占位值。

```sh
python3 "$tool" register --root "$pilot" --registry /srv/pilot-bridge/services.json \
  --media-uid 10009 --homeai-uid 10010
```

注册前确认目标为试点 Bridge 的 `WANX_BRIDGE_SERVICE_REGISTRY_FILE`，单独保存原文件和权限。在没有其他部署工具写该文件的窗口运行。合成以完整服务 ID 为单位，保留已有其他服务，拒绝冒用既有 ID、共享 upstream 或覆盖已被人工修改的条目。写入受锁及原子替换保护，重复执行不改服务身份。Bridge 启动时加载注册表，按已有部署流程重启试点 Bridge。减少授权或撤销时同步处理 HomeAI grant 的权限状态；不要把持有安装证明当作资料权限。模板采用独立注册合同允许的手工 legacy 激活；正式 OTA 需另走可信 profile、制品摘要、运行实例测量及发布流程。[平台注册合同](../../docs/bridge/independent-service-registration.md)

### 实时语音试点

安装媒体运行时加 `--extra streaming`，需要带时间点的文件转写时同时加 `--extra asr`。启动媒体服务前，把 `WANX_MEDIA_STREAMING_MODEL` 指向已核验的本地模型目录。登记时加 `--media-streaming`，将 WebSocket 升级交给支持实时 ASR 的 Bridge。已有记录需要调整时，在试点维护窗口通过下文的撤销登记流程，再按相同端口和 UID 重新登记。准备完毕后验证 `audio.transcribe.streaming` 的发现和会话创建，再向使用者发放限于该设备、账号和应用实例的媒体授权。[实时语音服务合同](../../server/services/media-processing/README.md#实时语音转写)

## CPU 模型与完整性

- ASR 选择具备目标语言的 CTranslate2 Whisper 模型，包含 model.bin、tokenizer.json、词表与模型配置，确认 CPU int8 及目标音频测试结果。通过服务进程的 `WANX_MEDIA_ASR_MODEL` 指向已封存的绝对目录。
- 在线 Paraformer 模型使用 `--engine streaming` 封存。目录包含 encoder.int8.onnx、decoder.int8.onnx、tokens.txt。
- 实时定稿的中文标点模型使用 `--engine punctuation` 封存。将核验后的 `model.int8.onnx` 放入受信只读目录，用 `WANX_MEDIA_STREAMING_PUNCTUATION_MODEL` 指向绝对文件路径。模型版本和 SHA-256 见[媒体服务说明](../../server/services/media-processing/README.md#实时语音转写)。
- OCR 安装本机 Tesseract 可执行文件及所需 tessdata。默认 `WANX_MEDIA_OCR_LANG=chi_sim+eng`，可用 `tesseract --list-langs` 核对。系统包和语言包分别记录版本与来源；隔离前缀部署可设置 PATH、TESSDATA_PREFIX 和目标系统支持的本地库搜索路径。
- 图文能力按实测架构选择 CPU 版 PyTorch 和兼容 transformers，准备中文 Chinese-CLIP 目录，含 model.safetensors、tokenizer、preprocessor 与配置；选择 `WANX_MEDIA_CLIP_MODEL`。使用仅文本向量包无法生成图像/中文相似度。测试包的模型输入来源、许可证与所支持功能随制品清单交付。
- 下载工作在获授权的联网准备环境进行。固定上游 revision，先核验上游签名或发布摘要及模型许可，再把所有实际文件复制到单独目录（缓存软链接须展开）。在可信准备机生成清单；通过既有签名制品渠道传递清单 SHA-256。部署端以独立可信的清单摘要核对文件名、字节数和每个文件的摘要，验证后只读挂载。内容摘要能发现文件变化，发布者身份仍由既有签名供应链确认。

```sh
python3 "$tool" model-manifest --model-dir /staging/whisper \
  --manifest /staging/whisper.manifest.json --engine asr \
  --source APPROVED_MODEL_REPOSITORY --revision PINNED_REVISION --license APPROVED_LICENSE
python3 "$tool" model-verify --model-dir /opt/models/whisper \
  --manifest /opt/manifests/whisper.json --expected-sha256 APPROVED_MANIFEST_SHA256
```

## 复测、回退与卸载

1. 在安装好的媒体 Python 环境中运行 `python -m wanx_media.acceptance`，带经授权的测试录音、正反中文描述及测试图。报告记录硬件、运行时、模型摘要和逐项结果。同一账号不同实例、不同用户与空间的真实 Bridge 测试见 [Bridge 集成脚本](../../server/services/media-processing/tests/bridge_smoke.py)。CLI 参数及模型契约见[服务说明](../../server/services/media-processing/README.md)。
2. 升级前保留 active.json 与当前注册表，按家庭服务的专用备份命令使用独立介质和恢复密钥备份。媒体临时队列与模型可回滚并独立重建。新版本先以隔离目录实测，记录指纹、OCR、中文 ASR 回听及越权拒绝结果，再切换。旧程序兼容现有数据格式时用之前的 release 和对应 extras 再执行 install 后重启两个服务。格式不兼容时先停写，在独立位置恢复并核对新增资料与撤权。
3. 卸载先撤销本试点发放的实例 grant 并停止相关收件，按说明接收最后一次提交回执。对同一安装根和注册表运行 `unregister --root "$pilot" --registry /srv/pilot-bridge/services.json`。该操作仅移除本安装创建且内容匹配的两个条目，已有其他服务保持原状态。按运维流程重新加载试点 Bridge，分别停止两个服务进程。再执行 `deactivate --root "$pilot"`，工具在本安装管理的服务都已退出后停用启动指针。data、keys、旧版本与备份保留，是否安全擦除由数据所有者与恢复负责人决定。
4. 本工具的回归用例可在 tools/homeai-services 下运行 `python -m unittest -q`。测试只使用临时目录及合成数据。另用同目录的 smoke_install.py 可全程离线暂存、安装并启动两项回环服务，检查跨用户/空间拒绝、原件回读、备份恢复和破坏认证标签后拒绝恢复。传 --python 指定用于两个服务的解释器。
