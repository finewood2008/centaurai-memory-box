# 万象应用市场描述修复交接

日期：2026-10-30。适用范围：万象个人版和万象企业版中的「万象应用」。交接对象：商城后台、客户端、产品与测试团队。

## 修复目标

修正商城中缺失、带测试字样或缺少产品用途说明的应用描述。优先使用现有 Admin 应用资料编辑能力修复数据，再补齐保存和上架校验，避免同类问题再次进入正式目录。

本轮继续使用现有 `description` 字段，不新增公开接口，不在客户端写死产品介绍，不改应用版本、安装包、签名、使用权限或下载规则。只更新商城应用资料时，不需要重新打包应用或客户端。

## 已确认的来源和显示逻辑

```text
Admin 应用资料中的 description
        ↓
GET /app-api/market/apps
        ↓
客户端 market.list → marketItems
        ↓
按 applicationId 关联本机安装记录
        ↓
云端描述覆盖商城页面中的安装包描述
        ↓
我的应用、发现应用、产品一览和应用介绍页
```

两版客户端的目录请求和字段处理一致：

| 场景 | 当前行为 |
| --- | --- |
| 云端返回非空 `description` | 按原文显示，不识别“测试文案”与“正式文案”。 |
| 云端返回空字符串或缺少 `description` | 不显示介绍；不会取安装包描述补齐。 |
| 应用已经安装，但仍位于商城目录 | 商城页面依然使用云端名称和描述；安装记录保留供运行和版本管理使用。 |
| 「本地应用」页面 | 使用本机安装记录中的描述，不走商城描述覆盖。 |
| 网络故障且已有成功目录缓存 | 显示当前账号、当前 Consumer 环境的上次目录，标记离线及缓存时间。 |
| 联网后点击「检查更新」 | 重新请求目录并更新页面；目录成功读取后更新加密缓存。 |

截图中的半人马环没有介绍，知君显示“测试第一个万象应用-知君”。本机半人马环安装包已有“让标准小任务反复运行，有问题时通过私聊问你”的描述，但商城字段会覆盖它。后台应核对目标环境和账号实际收到的目录，修正应用资料，避免通过修改本机安装包掩盖问题。

### 客户端定位

以下链接均指向本仓库；函数名可用于搜索定位，避免后续代码行号变化。

| 文件 | 定位 | 职责 |
| --- | --- | --- |
| [企业版 cloud-catalog.mjs](../../apps/team-client/applications/cloud-catalog.mjs) | `validateCloudCatalog`、`createCloudCatalog().list` | 请求 `/app-api/market/apps`，保留字符串类型的 `description`，保存和读取成功目录缓存。 |
| [企业版 market.mjs](../../apps/team-client/applications/market.mjs) | `list: () => catalog.list()` | 将目录能力提供给客户端。 |
| [企业版 renderer.js](../../apps/team-client/local-ui/renderer/renderer.js) | `refreshMarket`、`withMarketName`、`applicationCard`、`storeFeatures`、`applicationDetailView` | 拉取目录、覆盖商城展示字段，在列表、轮播和详情中显示描述。也可搜索 `app-detail-tagline`。 |
| [企业版 main.mjs](../../apps/team-client/shell/main.mjs) | `createApplicationMarket`、`market-catalog.enc` | 绑定当前账号、Consumer 环境和加密目录缓存。 |
| [个人版 cloud-catalog.mjs](../../apps/personal-client/applications/cloud-catalog.mjs) | 同名函数 | 与企业版相同的目录及缓存逻辑。 |
| [个人版 renderer.js](../../apps/personal-client/local-ui/renderer/renderer.js) | `refreshMarket`、`withMarketName`、`applicationCard` | 个人版对应展示逻辑。 |

客户端默认 Consumer Base URL 为 `https://boss.nexusaos.qitus.cn/prod-api`，可由 `WANX_CONSUMER_URL` 覆盖。修复前先确认实际环境；不要只修改开发环境、文档站或另一个 Admin 实例。

### 后台定位

现有入口为 **Admin → 应用市场 → 对应应用 → 编辑资料**。使用已有应用资料编辑和权限校验流程保存；不要用发布新版本代替编辑资料，也不要反复切换上下架。

现有接口文档列出了以下后台模块。后台同事在所属仓库核对实际实现和数据表，不按本文猜测更新路由或直接执行未审核 SQL：

- `admin-backend/module_nexus/controller/nexus_app_market_controller.py`：市场路由。
- `admin-backend/module_nexus/entity/vo/nexus_app_market_vo.py`：请求及响应字段。
- `admin-backend/module_nexus/service/nexus_app_market_service.py`：市场服务。

资料编辑入口及目录合同可同时参考 [应用市场开发与发布](wanx-application-market.md) 和 [云端目录后台交接说明](../plans/wanx-cloud-market-backend-handoff-20261027.md)。

## 产品文案建议

下面五条为本轮建议文案，产品负责人确认后录入。按稳定的 `applicationId` 更新，不能只按显示名称匹配。技术侧的数据核对和校验修复可先进行。

| applicationId | 应用 | 建议 description |
| --- | --- | --- |
| `centaurai.wanx.ai-browser` | 万象AI浏览器 | 在万象盒子上浏览网页，支持手动操作与 AI 协作，完成信息查找和网页任务。 |
| `centaurai.wanx.centaurloop` | 半人马环 | 将每日摘要、定时检查和例行汇总交给 AI，按确认的规则持续执行，需要判断时向你确认。 |
| `centaurai.wanx.dialogue` | 众见 | 围绕同一个问题与多个 AI 模型对话，对照不同观点，继续深入有价值的回答。 |
| `centaurai.wanx.superadvisors` | 个人议事厅 | 围绕重要问题组织多位 AI 专家讨论，汇总不同观点，帮助你形成判断与行动方案。 |
| `centaurai.wanx.zhijun` | 知君 | 面向个人的 AI 对话空间，帮助记录想法、整理信息，积累可回顾的个人记忆与知识。 |

同时检查目标环境的其他已上架应用，使用同样规则补齐。不要把本表当作客户端固定应用名单，也不要因此上架本来未开放的产品。

文案应说明用途和用户价值，建议约 30–60 字，避免技术栈、内部编号和版本号。此长度是编辑建议，不是已存在的 API 字段限制。长篇功能介绍留给后续详情内容设计，不放进本轮短描述。

## 实施顺序和分工

### 第一步 后台修正现有应用资料

负责人：商城后台开发配合产品。

1. 确认目标 Consumer 和 Admin 环境一致，使用有资料编辑权限的账号操作。
2. 导出当前已上架应用的 `applicationId`、`name`、`description`、`listed` 和 `updatedAt`，保留修改前后对照。不要在交接记录中保存 Token、签名私钥或下载凭据。
3. 核对全部描述，优先修复空值、纯空白和测试占位文案，按已确认文案更新。
4. 使用现有资料保存接口更新，确保 `updatedAt` 随资料变化更新。若后台存在目录缓存，同步检查其失效机制。
5. 用实际有权访问应用目录的 Consumer 账号读取 `GET /app-api/market/apps`，确认响应已更新。不要只以 Admin 页面保存成功作为验收。

目录字段示例仅用于说明结构，完整响应仍按现有合同返回：

```json
{
  "items": [
    {
      "applicationId": "centaurai.wanx.centaurloop",
      "name": "半人马环",
      "description": "将每日摘要、定时检查和例行汇总交给 AI，按确认的规则持续执行，需要判断时向你确认。",
      "listed": true
    }
  ]
}
```

调用继续复用 Consumer 登录和现有客户端请求签名。以上示例不是免鉴权请求，也不是替换整个响应的模板。

### 第二步 后台补保存和上架校验

负责人：商城后台开发；Admin 前端同步提示。

- 对 `description` 去掉首尾空白，按现有纯文本字段保存，不填入 HTML。
- 草稿应用可继续留空；对已上架应用的资料保存，以及未上架应用执行上架时，要求描述为非空且非纯空白。
- “测试应用”“占位”“待补充”等内容触发醒目提醒并由资料维护人确认或修正。不要简单禁止所有含“测试”的文字，避免误伤“测试报告”等真实功能描述。
- Admin 前端显示必填和长度提示，服务端也做相应校验，避免通过直接调用保存接口绕过。
- 不因发现历史空描述而自动下架应用。先完成已有资料清理，再启用校验；仅拒绝后续不合格保存或上架操作。
- 校验沿用现有错误响应外壳及权限机制。Consumer 目录地址、请求和响应字段保持不变，不把新的资料要求变成客户端安装或授权门槛。

### 第三步 客户端复核展示和刷新

负责人：个人版、企业版客户端开发。

当前客户端已支持云端描述刷新，本轮先按现有行为验收。若刷新未生效，依次排查实际环境、目录响应、离线提示、缓存时间以及账号切换；只有发现具体问题时才补客户端代码。

- 「万象应用」统一使用云端 `description`，包括已安装卡片、发现卡片、产品一览和介绍页。
- 缺失字段仍省略显示，不回退到本地固定营销文案。资料完整性在后台解决。
- 「本地应用」保留安装包描述，不把商城修改写入安装记录或覆盖本地包。
- 云端联网读取成功后更新同账号缓存；断网允许显示旧目录，但必须显示离线和缓存时间。恢复网络刷新后显示新描述。
- 不通过清空全部客户端数据、重装应用或编辑已签名清单来刷新文案。

## 验收清单

负责人：测试配合后台及客户端开发。

| 编号 | 操作 | 预期结果 |
| --- | --- | --- |
| A1 | 用目标 Consumer 账号读取目录 | 五个应用的 ID、名称和描述与确认稿一致；全部已上架应用无遗漏的空描述和测试占位。 |
| A2 | 在 Admin 修改一条描述并保存，再读取目录 | 返回新文案，`updatedAt` 更新；应用 ID、上架状态及其他资料保持原值。 |
| A3 | 个人版和企业版点击「检查更新」 | 两版均显示新描述，无需更新客户端或重新安装应用。 |
| A4 | 检查已安装卡片、发现卡片、产品一览及介绍页 | 对同一个应用显示一致的云端描述；在隔离测试环境覆盖未安装状态，不卸载用户应用做测试。 |
| A5 | 把已安装包描述与云端描述设为不同测试值 | 商城页面使用云端值；本地应用页继续使用安装记录值。 |
| A6 | 保存成功的新目录后断网，再恢复网络并刷新 | 离线显示该账号最后成功的目录及缓存时间；恢复刷新后显示最新资料。 |
| A7 | 切换 Consumer 账号或环境 | 不展示上一账号、上一环境的目录缓存。 |
| A8 | 在隔离环境以空字符串或纯空白保存已上架资料，并直接调用已有保存接口 | 前后端均拒绝不合格保存；原有效资料不被清空。未上架草稿留空仍按约定允许。 |
| A9 | 对空描述草稿执行上架 | 服务端拒绝，Admin 给出明确的描述必填提示。 |
| A10 | 比较修复前后的版本及制品信息 | 现有版本、artifactId、签名、安装和更新准入不因改文案发生变化。 |

后台应增加保存、上架及目录响应测试；客户端已有相关测试可作为回归入口：

- [个人版目录测试](../../apps/personal-client/tests/cloud-catalog.test.mjs)、[企业版目录测试](../../apps/team-client/tests/cloud-catalog.test.mjs)。
- [个人版界面测试](../../apps/personal-client/tests/renderer-seam.test.mjs)、[企业版界面测试](../../apps/team-client/tests/renderer-seam.test.mjs)。
- 重点搜索测试名称 `cloud app detail uses returned metadata`、`cloud names override installed names`、`offline directory is clearly marked`。

在各客户端依赖及生成资源已准备好的开发环境中，从仓库根目录运行：

```sh
node --test apps/personal-client/tests/cloud-catalog.test.mjs apps/personal-client/tests/renderer-seam.test.mjs
node --test apps/team-client/tests/cloud-catalog.test.mjs apps/team-client/tests/renderer-seam.test.mjs
```

这些测试只能验证客户端逻辑，不能替代真实 Consumer 响应、Admin 保存校验和两版界面实测。

## 完成交付

提交修复时附上目标环境、应用资料修改前后对照、产品确认文案、后台测试结果，以及两版客户端刷新后的截图。真实账号相关信息脱敏。

只有 Consumer 目录返回正确、两版客户端显示正确、空描述保存和上架校验通过，才算本项修复完成。此交接文档不表示云端数据、后台校验或客户端代码已经修复。
