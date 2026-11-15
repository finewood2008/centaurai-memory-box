# 万象空间：PDF 与 Office 文档预览

本次范围：个人版、企业版空间中的 PDF、PPT/PPTX、DOC/DOCX。Excel 暂不包含在本次预览实现中。

## 用户体验

双击文件，或右键选择「预览」，打开大尺寸只读预览。提供全屏、关闭、失败重试和下载原文件。

PDF 使用客户端 Chromium 的 PDF 阅读器，提供其原生翻页、缩放、搜索等功能。Office 文件由盒端生成 PDF 后进入同一个阅读器；仅展示静态页面，动画、视频、特殊字体与原软件可能有差异。预览中的文件不修改原稿，也不作为新的业务文件写入空间列表。

加载与转换展示不确定进度动画，不伪造百分比。关闭窗口停止客户端轮询；盒端已开始的转换可继续完成并缓存。后台状态刷新保留当前阅读器，避免翻页位置被重置。账号、盒子或连接上下文变化后丢弃旧请求结果并清理页面中的 Blob URL。

## 实现

- `src/octop/infra/personal_space/previews.py`：隔离转换、版本缓存、任务合并、容量限制。
- `src/octop/api/routers/space_previews.py`：客户端私有鉴权适配。
- `../../apps/personal-client/shell/personal-space.mjs`：按原文件版本提交、查询、分片取回及摘要校验。
- `../../apps/personal-client/local-ui/renderer/personal-space.js`：统一的预览窗口。
- `../../apps/builder/integration/team-client/space-document-preview.css`：两版共用样式；组装工具同步到客户端。

新增私有接口前缀 `/api/_client/space-previews`，不出现在公开 OpenAPI 中。已有公开 REST 和 MCP 接口保持不变。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/{file_id}?version=N&drive=连接ID` | 启动或复用转换；`drive` 仅 Agent 专属盘需要 |
| GET | `/{file_id}?version=N&drive=连接ID` | 读取 processing/ready 状态 |
| GET | `/{file_id}/content?version=N&offset=0&length=4194304&drive=连接ID` | 读取经过权限校验的预览分片 |

普通空间沿用现有文件权限，包括已有的资源作用域；Agent 专属盘沿用 `SpaceMcp.drive_files` 的成员、盘与目录边界。准备、状态和分片请求都重新校验原文件。预览缓存没有公开地址，也不使用分享令牌。旧文件版本、回收站文件和其他账号的文件均不能通过缓存绕过检查。

缓存按存储域、文件 ID、版本、原文件摘要和格式区分。每个存储域在新的转换完成后清理超过 7 天、或总量超过 512 MiB 的旧 PDF 缓存；不会删除原文件。字体缓存独立保存。最多同时执行 2 次转换，活动与排队任务合计最多 4 个，同一版本的重复打开复用任务；失败后再次打开或点击重试可重建任务。服务重启后通过重新打开恢复未完成的转换，不宣称原后台任务仍在运行。

Office 原文件、转换后 PDF 和客户端直接打开的 PDF 上限均为 64 MiB；原有图片、文本预览上限仍为 16 MiB。转换超时为 120 秒，客户端轮询上限为 150 秒。

## 盒端依赖

Linux：安装 `libreoffice-writer libreoffice-impress fonts-noto-cjk bubblewrap`。两份 Dockerfile 已加入这些组件。实际运行环境还须允许 bubblewrap 建立无特权隔离环境；仅安装包不代表容器运行策略已经兼容。应在目标盒子做真实转换验收，不采用关闭隔离或 privileged 容器作为兜底。

macOS：支持 `/Applications/LibreOffice.app` 与 `~/Applications/LibreOffice.app`。可由服务管理员设置 `WANX_PREVIEW_SOFFICE`，指向实际 soffice 可执行文件；Mac 上不使用 Homebrew 的 shell wrapper。Windows 客户端仍调用所连接盒子的转换服务，不要求电脑安装 Office。

Linux 转换使用独立文件系统与网络命名空间；Mac 使用独立临时 profile、限定文件访问的 sandbox-exec，并仅允许转换进程在自己的短路径 Unix socket 目录内通信，不允许 IP 网络访问。禁用文档宏，原材料被复制到私有临时目录后转换，完成或失败均清理临时文件。没有隔离环境时返回明确错误，不降级为无限制运行。

Mac 的短 socket 路径是为兼容 LibreOffice 的 SingleOfficeIPC 与 Unix socket 路径长度限制；不依赖全局 `/tmp` 的写权限。字体配置显式包含系统字体，避免命令成功但中文字形缺失。

参考：[LibreOffice 命令行参数](https://help.libreoffice.org/latest/en-GB/text/shared/guide/start_parameters.html)、[LibreOffice pipe 实现](https://github.com/LibreOffice/core/blob/master/sal/osl/unx/pipe.cxx)、[Electron WebPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences)。

## 验证

自动化包括跨账号访问拒绝、删除原文件后的缓存拒绝、版本隔离、重复转换合并、失败重试、摘要校验、关闭预览与账号切换后的旧结果丢弃，以及后台刷新保留阅读器。

常规测试不要求本机安装转换器。真实转换 HTTP 测试需要显式指定本轮合成 DOCX/PPTX 文件和转换器：

```sh
WANX_PREVIEW_SOFFICE=/path/to/soffice \
WANX_PREVIEW_FIXTURES=/path/to/synthetic-fixtures \
uv run pytest tests/integration/test_space_document_previews.py -q
```

目录中使用 `preview-test.docx`（2 页）和 `preview-test.pptx`（3 页）。真实文件必须渲染核对中文、页数与排版；生成非空 PDF 不等于预览通过。Mac、Linux 盒端和 Windows 客户端的实测结果分别记录，不能互相代替。
