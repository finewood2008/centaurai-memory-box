# Windows 预览版

当前组合仓库使用根目录 `.github/workflows/windows-preview-release.yml`。手动触发，版本格式为 `客户端版本-windows-preview.序号`；已有 tag 或 Release 会拒绝覆盖。

流程从锁文件安装依赖，编译本机记忆与 API 服务、客户端及原生辅助程序，将运行时生产依赖闭包置于 `resources/local-memory`，逐个按 Electron ABI 重编译 SQLite。打包后使用专用合成资料目录验证 SQLite、服务健康、API 启动和未认证请求拒绝；通过后生成新的 GitHub prerelease。

预览版为 Windows x64 未签名安装包，保留原 appId、协议及数据身份，不接入正式签名自动更新通道。下载文件附 `SHA256SUMS.txt` 和 `verification-windows-preview.json`，记录源提交、版本与检查结果。工作流不需要模型或用户资料凭据。

触发示例：

```sh
gh workflow run windows-preview-release.yml --ref main -f version=1.0.6-windows-preview.2
```

本地结构测试：`node --test tools/release/tests/*.test.mjs`。完整构建与运行检查在 Windows runner 执行。
