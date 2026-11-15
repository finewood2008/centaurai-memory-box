# FAQ 场景入口与配网帮助侧栏验收记录

日期：2026-11-09。基线：`origin/master=88aee2ecc2db013d87543b42aac44e84d5172890`。分支：`codex/faq-context-entry`。

## 交付行为

个人版和团队版均增加：头像菜单“问题与反馈”、盒子列表“常见问题”、添加盒子及认领码流程的帮助入口、配网步骤“遇到问题？”、连接失败“查看常见问题”。

通用入口展示全部问题；添加及配网匹配“添加盒子、发现与配网”，盒子列表及连接失败匹配“盒子连接与网络恢复”。映射集中在两版 `help.js` 的 `sceneCategories`；只去除分类名首尾空白后精确匹配，使用响应中的实际 ID。分类缺失、空分类或匹配不唯一时展示全部并提示。运营改名后须同步客户端映射，不需要修改后台代码。

配网帮助独立挂在 `document.body`，底层 `#app` 设为 inert，帮助更新不调用底层页面 render。扫描及配网状态继续推进，关闭恢复焦点；侧栏复用帮助搜索和反馈草稿。强制下线、账号变更和进入认证状态时关闭侧栏，保持主线认证提示及清理行为。

完整 FAQ 页面保留来源及滚动位置。现有登录、设置、强制升级帮助入口继续工作。没有修改 Admin、Consumer、数据库、nginx、账号传输或 IPC 合同。

## 自动验证

| 验证 | 结果 |
|---|---|
| `npm run test:client` | 2686 passed，73 skipped，0 failed |
| `npm run test:team-client` | 2538 passed，56 skipped，0 failed |
| 两版 `build:renderer`，团队版先执行 `build:studio` | 通过 |
| 两版场景、导航及认证恢复定向测试 | 35 passed，0 failed |
| 两版隐藏 Electron DOM 验收 | 通过 |
| `git diff --check` | 通过 |
| `make all` | 未能运行：本机没有 make 命令 |

全量测试首次在沙箱内受临时目录的 rename、硬链接及安全存储权限限制失败；在普通本机权限下重跑得到上表通过结果。没有为这些环境失败修改业务代码。

构建首次因 Windows autocrlf 导致 Starlink 输入原始字节与源码回执不一致；将相关检出文件恢复为回执对应的 LF 字节后通过，没有修改回执、跳过哈希检查或引入逻辑差异。构建完成后恢复了这些文件的检出格式，以及构建自动更新的无关模板文件。

完整日志位于工作区根目录 `personal-tests-unrestricted.log`、`team-tests-unrestricted.log`；Electron 证据在 `verification/faq-context/`。这些运行产物不提交。

## Electron 验收边界与复跑

脚本：[help-context-electron.fixture.cjs](../../apps/personal-client/tests/help-context-electron.fixture.cjs)。在仓库根目录用本机 Electron 可执行文件运行：

```text
electron apps/personal-client/tests/help-context-electron.fixture.cjs personal-client
electron apps/personal-client/tests/help-context-electron.fixture.cjs team-client
```

脚本创建隐藏窗口，加载该版实际 renderer 和 CSS；仅模拟账号桥接、FAQ 内容及设备状态，不连接生产服务，不执行真实认领。

覆盖：头像菜单及盒子列表入口、连接失败入口、分类定位、返回来源及滚动位置、配网侧栏、Wi-Fi 表单节点和输入保留、帮助搜索及反馈提交、键盘焦点约束、Escape 恢复焦点、配网完成后侧栏保留、窄窗口布局及 AUTH_CLIENT_REPLACED 强制下线。断言帮助操作没有额外触发设备业务请求，Wi-Fi 测试密码未进入请求内容。

每版输出 `result.json`、`drawer-desktop.png`、`drawer-narrow.png`。截图已检查，使用现有米白/暖棕样式，窄窗口侧栏铺满可用区域。

## 尚待实机验收

真实蓝牙、Wi-Fi、实体盒子扫描/配网及生产 FAQ 连接未在本次验证中执行。需要使用测试盒子，在两版中分别验证扫描中、输入 Wi-Fi、提交配网、等待认领及失败状态查看帮助，确认真实任务继续且没有额外取消/重试。模拟 DOM 验证不能替代硬件验收。

验收时未提交、推送或发布客户端；后续按用户要求单独本地提交供打包，未推送远端。原工作区的已有修改未纳入本分支。
