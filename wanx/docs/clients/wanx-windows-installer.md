# 半人马AI-记忆盒子 Windows 安装体验

标准、正式签名和内部打包共用 `apps/personal-client/shell/installer.nsh` 和 `installer-ui.nsh`。

- **安装位置**显示当前用户的默认目录，可直接继续或浏览更换。目录过长、位于不支持的位置或权限不足时，可以返回重选。
- **安装进度**使用 NSIS 的实际文件进度，并在检查安装目录权限时更新状态。
- **完成**显示首次连接盒子的入口提示，可勾选打开应用。应用安装完成后保留现有账号和用户数据。

安装素材由构建打包，向导使用本地品牌图片及原生控件，支持键盘操作。静默安装和客户端自动更新沿用现有安装入口和权限检查。

## 验证与发行边界

```sh
node --test apps/personal-client/tests/installer-artwork.test.mjs apps/personal-client/tests/client-release-tools.test.mjs
node apps/personal-client/tools/verify-installer-ui.mjs
```

第二条使用 electron-builder 所固定的 NSIS 编译器，检查安装、卸载脚本与图片是否能编译。首次执行会下载有校验和的构建工具。输出是**编译检查用的夹具，不是客户端安装包，不用于分发**。

发行仍使用原 Windows 打包流程。正式版继续要求 Authenticode 签名与发行信任文件；内部未签名包不能冒充正式版。

Windows 实机验收须另行覆盖：首次安装、原版本覆盖升级、无效目录后返回重选、取消安装、静默安装、失败提示、卸载保留数据，以及 100%／150%／200% 缩放与键盘导航。仅通过 NSIS 编译不能视为这些实机验收已通过。
