# AGENTS.md

WANX 工作区的 AI 协作导航指南。本文件管理整个仓库；Octop 上游工程自己的开发规则在 [`octop/AGENTS.md`](octop/AGENTS.md)，在 `octop/` 内做改动时以那份为准。

## 1. 协作原则

- 先读后写：动手前先确认相关目录的边界和既有约定；不确定就问，不要猜。
- 最小改动：只改与任务直接相关的文件；不顺手重构、不统一风格、不加没有要求的功能。
- 边界敏感：跨目录改动（如客户端 ↔ shared ↔ 服务端）必须先说明影响面。
- 改动后验证：能跑的检查就跑（见 §4），跑不了的明确说明没跑。

## 2. 目录边界

```text
octop/                    原始 Octop 完整工程（dashboard、desktop、docker、docs、
                          fnos、plugins、scripts、src/octop、tests；自带
                          pyproject.toml / uv.lock / Makefile / AGENTS.md）
server/
  bridge/                 万象 Bridge 服务（独立 Python 项目）
  services/super-clipboard/  剪贴板服务（独立服务）
apps/
  personal-client/        万象个人版（原 wanx-client）
    host-sdk/             客户端公共 SDK 与 App Kit 合同的唯一源码入口
      contracts/
  team-client/            万象团队版（原 wanx-team-client；不维护 SDK 副本）
  builder/                Builder 完整应用（原 wanx-studio；backend 是独立
                          Python 项目，不是纯前端）
shared/
  contracts/local-trust/  客户端、Bridge、服务端共同遵守的协议
  packages/local-data-gate/      Octop、Bridge、剪贴板服务共用
  packages/wanx-client-adapter/  Dashboard 和客户端构建共用
  sdk/box-management/     客户端设备管理 SDK
docs/                     万象文档：clients / applications / bridge / app-kit /
                          release / credits / plans / verification / assets
tools/                    跨工程工具（build.mjs、build-app-kit.mjs 等）
```

根级控制文件留在根目录：`.github/`、`.githooks/`、`.cursor/`、根 `.gitignore`、根 `Makefile`（委托到 `octop/` 的 Octop 编排）、根 `package.json`（万象统一入口）、`wanx-release.json`、`README.md`、`CONTEXT.md`。

## 3. 硬性边界

- **Host SDK 唯一入口**：客户端公共 SDK 只能改 `apps/personal-client/host-sdk/`（含 `contracts/`）。团队客户端和内置应用不维护副本。
- **App Kit 是生成产物**：`.wanx-app-kit/` 位于仓库根、被 git 忽略，由根目录 `npm run build:app-kit` 从 host-sdk 生成。不要手改、不要提交、不要把它挪进 `apps/` 或 `shared/`。
- **Builder 是完整应用**：`apps/builder/backend/` 是独立 Python 项目（自己的 `pyproject.toml` / `uv.lock`）。`octop/pyproject.toml` 通过构建钩子（`octop/_build.py`）把 `wanx_studio` 打进 Octop wheel；是否长期拆出属于独立任务，不要顺手改。
- **shared/ 是共享边界**：上述四个 shared 条目被多个工程消费，改动前用 grep 确认所有消费方（客户端、Bridge、剪贴板、Dashboard）。
- **octop/ 保持可对照上游**：万象扩展不要写进 Octop 核心逻辑；万象侧的服务端扩展放 `server/`，客户端逻辑放 `apps/`。

## 4. 常用命令（均在仓库根目录执行）

```sh
npm run start:mini        # 个人客户端
npm run start:studio      # 团队客户端
npm run test:client       # 个人客户端测试
npm run test:team-client  # 团队客户端测试
npm run test:studio       # Builder 检查（apps/builder npm run check）
npm run test:bridge       # Bridge pytest
npm run build             # 生成 SDK 包并构建 Dashboard / Octop wheel 前置
npm run build:app-kit     # 生成 .wanx-app-kit/<version>/
npm run package:client:mac   # 个人客户端打包（:windows 同理）
npm run package:studio:mac   # 团队客户端打包（:windows 同理）

make all                  # Octop ship bar（委托 make -C octop all）
```

Python 各工程独立虚拟环境：`uv run --project <dir>`，项目根为 `octop/`、`server/bridge/`、`server/services/super-clipboard/`、`apps/builder/backend/`、`shared/packages/local-data-gate/`。

## 5. 文档约定

- 万象文档放 `docs/` 并按九类归档，新增文档先选类别；文档互链使用相对路径，移动文档后必须修复引用。
- Octop 上游文档在 `octop/docs/`，不要混放。
- 客户端行为以 `apps/personal-client/README.md` 和 `docs/clients/` 为准；积分体系入口是 `docs/credits/credits.md`。
