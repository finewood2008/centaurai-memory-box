# WANX workspace App Kit

阶段 1 的 App Kit 由 WANX 平台仓库生成，供内部应用以 `workspace` 或 `local-bundle` 模式消费。它不是外部发行包，也不要求应用方读取平台源码。

Host SDK 的唯一源码入口是 `apps/personal-client/host-sdk/`；其中的 `contracts/` 与 SDK 同源、同版本。`wanx-team-client` 和内置应用目录不再维护 SDK 副本，个人版目录只承担平台源码入口。

## 生成

在 WANX 仓库根目录执行：

```sh
npm run build:app-kit -- --version 0.3.0
```

默认输出：

```text
.wanx-app-kit/0.3.0/
├── sdk/@centaurai/wanx-host-sdk/   # 可读源码包内容和类型
├── centaurai-wanx-host-sdk-0.3.0.tgz
├── contracts/                       # OpenAPI、错误、类型和 JSON Schema
└── wanx-app-kit.json
```

`wanx-app-kit.json` 记录 Kit 版本、分发模式、WANX 平台来源提交、source workspace 是否 dirty，以及 SDK 和合同目录各自的版本、文件清单和 SHA-256。

同一版本目录不会覆盖；SDK 或来源发生变化时应递增 Kit 版本，保留每个版本的来源摘要。

dirty workspace Kit 只用于内部开发和验收。生成干净提交后的 Kit，再进入 `local-bundle` 或 `released` 流程。

## 应用消费方式

应用依赖指向 Kit 产出的 tarball：

```json
{
  "dependencies": {
    "@centaurai/wanx-host-sdk": "file:../../centaur-WANX/.wanx-app-kit/0.3.0/centaurai-wanx-host-sdk-0.3.0.tgz"
  }
}
```

应用可以直接依赖 Kit 目录、使用 Kit 产出的 tarball，或将 tarball 放入自己的 `vendor/`；依赖记录和 lockfile 由应用开发方自行决定，WANX 不要求特定文件。Kit 的 `wanx-app-kit.json` 才是产物自身的版本、来源和摘要记录。

## 内置应用组装

`apps/builder/tools/assemble-starlink.mjs` 会从同一个 workspace Kit 读取 SDK 和合同目录。Kit 不存在时，组装脚本会按 SDK 版本生成 `<sdk-version>` Kit；版本、SDK 摘要或合同摘要不匹配会直接失败。组装后的应用同时包含：

- `node_modules/@centaurai/wanx-host-sdk/`：运行时 SDK；
- `vendor/wanx-host-sdk/`：应用包依赖的生成副本，不是源码维护入口；
- `wanx-app-kit/contracts/` 与 `wanx-app-kit/wanx-app-kit.json`：应用使用的合同和来源摘要。

个人版和团队版由同一 Kit 组装，不能从任一 client 的旧目录读取或手工更新 SDK。

Electron Builder 打包 ASAR 时会省略开发用的 `.d.ts` 声明文件，SDK 和合同目录均遵循该规则；其余合同文件（包括 JSON 和 Schema）仍须完整并逐字节通过打包后校验。包内 `wanx-app-kit.json` 保留完整源 Kit 的来源、文件清单和摘要，不是过滤后 ASAR 目录的摘要；组装前仍校验完整源 Kit。

## SDK 与 API 文档

从 Kit 的 `contracts/README.md` 开始。应用安装 `@centaurai/wanx-host-sdk` 后，可按以下指南使用公开入口。

| 能力 | SDK 入口 | 接入指南 |
| --- | --- | --- |
| 万象 Octop | `host.request`、`host.openStream`、`host.requestExpert` | [Octop API](../../apps/personal-client/host-sdk/contracts/octop-api.md) |
| 空间 Drive | `host.drive` | [Drive API](../../apps/personal-client/host-sdk/contracts/drive-api.md) |
| 星图 | `host.request` 与 `X-Xingtu-Key` | [星图 API](../../apps/personal-client/host-sdk/contracts/starlink-api.md) |

各模块 OpenAPI 描述 HTTP 方法、参数和响应。其他合同文件提供能力目录、类型、JSON Schema、权限、错误码和验收状态。

[万象 Octop 模块索引](../../apps/personal-client/host-sdk/contracts/octop-modules/index.json)随 Kit 提供，列出 `contracts/octop-modules/` 中可独立加载的模块 OpenAPI。Octop 路由或应用合同源文件 `apps/personal-client/host-sdk/contracts/api.openapi.json` 更新后，从仓库根目录运行 `uv run --project octop python tools/export-octop-api.py` 刷新快照，再生成 App Kit。使用 `--check` 检查快照是否与源码一致。

星图仓库的只读接口已开放。空间 Drive、模型、Agent/Thread、专家、多模型对话和记忆提供 SDK 接入及开发合同，发布验收状态为 `ready-for-acceptance`。Octop 知识库检索的合同缺口见 `contracts/api-catalog.v1.json`。

App Kit 的 Octop 公开合同覆盖应用业务接口。用户、账号认证和 Model Provider 路由由万象管理。应用使用 Host Context 获取当前会话身份，使用 `GET /api/dialogue/models` 选择可用模型。

## 验证

```sh
npm exec -- node --test tools/tests/app-kit.test.mjs
npm --prefix <application>/app install --ignore-scripts
npm --prefix <application>/app run check
npm --prefix <application>/app run build
```


## 版本与 Schema 标识

同一条 App Kit 发布线使用同一个语义版本：当前 SDK、合同包和 Kit 核心版本均为 `0.3.0`。`workspace`、`local-bundle`、`released` 只记录在清单的 `distribution` 字段。输出目录与 SDK 版本一致。需要保留同版本的不同分发产物时，使用 `--out` 指定不同的父目录。

Schema 的 `$id`（例如 `wanx-dialogue-session/1`）是合同身份，不是 endpoint URL。API 与 Schema 的关系由 `contracts/api-catalog.v1.json` 的 `requestSchema`/`responseSchema` 以及模块 OpenAPI 的 `$ref` 表达；同一 Schema 可以被多个 endpoint 复用。
