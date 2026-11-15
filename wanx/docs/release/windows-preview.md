# Windows 预览版

当前组合仓库使用根目录 `.github/workflows/windows-preview-release.yml`。手动触发，版本格式为 `客户端版本-windows-preview.序号`；已有 tag 或 Release 会拒绝覆盖。

流程从锁文件安装依赖，编译本机记忆与 API 服务、客户端及原生辅助程序，将运行时生产依赖闭包置于 `resources/local-memory`，逐个按 Electron ABI 重编译 SQLite。打包后使用专用合成资料目录验证 SQLite、服务健康、API 启动和未认证请求拒绝；通过后生成新的 GitHub prerelease。

npm 10／11 会漏装嵌套 Reader 工作区的 SQLite 12。打包工具只补齐锁中指定的缺失包，验证 tarball 完整性，并核对源目录及各暂存副本的实际解析版本；已有目录不会覆盖，清单和锁文件不会改写。打包配置使用独立文件入口，避免 electron-builder 重复合并资源；预览版跳过签名，仍保留图标、元数据和原有包检查。

预览版为 Windows x64 未签名安装包，保留原 appId、协议及数据身份，不接入正式签名自动更新通道。下载文件附 `SHA256SUMS.txt` 和 `verification-windows-preview.json`，记录源提交、版本与检查结果。工作流不需要模型或用户资料凭据。

触发示例：

```sh
gh workflow run windows-preview-release.yml --ref main -f version=1.0.6-windows-preview.2
```

安装客户端锁定的构建依赖后，运行 `node --test tools/release/tests/*.test.mjs`，验证实际 node-gyp／electron-builder 解析及缺失依赖修复。完整构建与运行检查在 Windows runner 执行。只有安装器、校验和及通过启动检查的验证记录齐全时才允许发布。
